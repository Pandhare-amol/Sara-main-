/**
 * Direct Gemini REST client for standalone Sara Mobile.
 *
 * This is the phone's own brain connection: no Sara server sits in between, so
 * the request shapes, the streaming parser and the error mapping have to be
 * right here. Everything is injectable (`fetchImpl`, `baseUrl`) so the tests can
 * prove the wire format without a key or a network.
 *
 * What is deliberately NOT here: retry storms, background polling, or a second
 * copy of the desktop's tool loop. One request at a time, and a failure is
 * reported as a failure.
 */

export const DEFAULT_MODEL = "gemini-3.5-flash";
export const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

export interface ChatTurn {
  role: "user" | "model";
  text: string;
}

export interface RequestOptions {
  key: string;
  model?: string;
  /** Injected in tests; defaults to the platform fetch. */
  fetchImpl?: typeof fetch;
  /** Injected in tests; defaults to Google's endpoint. */
  baseUrl?: string;
  signal?: AbortSignal;
}

export class GeminiError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  readonly code: string;

  constructor(message: string, status: number, code: string, retryable: boolean) {
    super(message);
    this.name = "GeminiError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
}

interface GeminiCandidate {
  content?: { parts?: GeminiPart[] };
  finishReason?: string;
}

interface GeminiEnvelope {
  candidates?: GeminiCandidate[];
  promptFeedback?: { blockReason?: string };
  error?: { message?: string; status?: string; code?: number };
}

/** Readable text out of one response envelope, or "" when it has none yet. */
export function textFromEnvelope(json: GeminiEnvelope | null | undefined): string {
  const parts = json?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return "";
  return parts.map((part) => (typeof part?.text === "string" ? part.text : "")).join("");
}

/** Blocked-by-safety and other non-error stops surface as a reason, not silence. */
export function blockReason(json: GeminiEnvelope | null | undefined): string | null {
  const reason = json?.promptFeedback?.blockReason;
  if (typeof reason === "string" && reason) return reason;
  const finish = json?.candidates?.[0]?.finishReason;
  if (finish === "SAFETY" || finish === "PROHIBITED_CONTENT") return finish;
  return null;
}

export function mapHttpError(status: number, body: string): GeminiError {
  const parsed = safeJson(body);
  const detail = parsed?.error?.message || body.slice(0, 300);
  const apiState = String(parsed?.error?.status ?? "");

  if (status === 400 && /API key not valid|API_KEY_INVALID|invalid key/i.test(detail)) {
    return new GeminiError("Google rejected that API key. Check it in Settings → AI key.", status, "INVALID_KEY", false);
  }
  if (status === 401 || status === 403) {
    return new GeminiError(
      apiState === "PERMISSION_DENIED"
        ? "This key is not allowed to use that model. Enable it in Google AI Studio, or pick another model."
        : "Google refused the request. The key may be wrong or restricted.",
      status,
      "FORBIDDEN",
      false,
    );
  }
  if (status === 404) {
    return new GeminiError("That model is not available for this key. Pick another model in Settings.", status, "NO_MODEL", false);
  }
  if (status === 429) {
    return new GeminiError("Google's free limit for this key is used up right now. Wait a minute and try again.", status, "RATE_LIMIT", true);
  }
  if (status >= 500) {
    return new GeminiError("Google's service is having trouble. Try again in a moment.", status, "UPSTREAM", true);
  }
  return new GeminiError(detail || `The request failed (${status}).`, status, "HTTP_ERROR", false);
}

function safeJson(text: string): GeminiEnvelope | null {
  try {
    return JSON.parse(text) as GeminiEnvelope;
  } catch {
    return null;
  }
}

function endpoint(options: RequestOptions, model: string, method: string): string {
  const base = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  return `${base}/models/${encodeURIComponent(model)}:${method}?key=${encodeURIComponent(options.key)}`;
}

async function failure(response: Response): Promise<GeminiError> {
  let body = "";
  try {
    body = await response.text();
  } catch {
    body = "";
  }
  return mapHttpError(response.status, body);
}

export interface ChatRequest extends RequestOptions {
  system: string;
  history: ChatTurn[];
  message: string;
  image?: { mimeType: string; data: string };
  temperature?: number;
  maxOutputTokens?: number;
}

/** One-shot (non-streaming) generation — used by vision and transcription. */
export async function generate(request: ChatRequest): Promise<string> {
  const model = request.model || DEFAULT_MODEL;
  const doFetch = request.fetchImpl ?? fetch;
  const body = {
    systemInstruction: { parts: [{ text: request.system }] },
    contents: [
      ...request.history.map((turn) => ({ role: turn.role, parts: [{ text: turn.text }] })),
      {
        role: "user",
        parts: [
          { text: request.message },
          ...(request.image ? [{ inlineData: { mimeType: request.image.mimeType, data: request.image.data } }] : []),
        ],
      },
    ],
    generationConfig: {
      temperature: request.temperature ?? 0.8,
      maxOutputTokens: request.maxOutputTokens ?? 2048,
    },
  };

  let response: Response;
  try {
    response = await doFetch(endpoint(request, model, "generateContent"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: request.signal,
    });
  } catch (error) {
    throw networkError(error);
  }
  if (!response.ok) throw await failure(response);

  const json = safeJson(await response.text());
  const blocked = blockReason(json);
  if (blocked) throw new GeminiError(`Google stopped that answer (${blocked.toLowerCase().replace(/_/g, " ")}).`, 200, "BLOCKED", false);
  const text = textFromEnvelope(json);
  if (!text) throw new GeminiError("The model returned an empty answer. Try rephrasing.", 200, "EMPTY", true);
  return text;
}

export interface StreamRequest extends ChatRequest {
  onDelta: (text: string) => void;
  /** Called with the full text once the stream ends cleanly. */
  onDone?: (text: string) => void;
}

/**
 * Streaming chat over server-sent events.
 *
 * Returns the complete answer. Throws before any text arrives when the request
 * itself fails; if the stream breaks midway the partial text is thrown away and
 * the caller is told, because half an answer presented as whole is a lie.
 */
export async function streamChat(request: StreamRequest): Promise<string> {
  const model = request.model || DEFAULT_MODEL;
  const doFetch = request.fetchImpl ?? fetch;
  const body = {
    systemInstruction: { parts: [{ text: request.system }] },
    contents: [
      ...request.history.map((turn) => ({ role: turn.role, parts: [{ text: turn.text }] })),
      {
        role: "user",
        parts: [
          { text: request.message },
          ...(request.image ? [{ inlineData: { mimeType: request.image.mimeType, data: request.image.data } }] : []),
        ],
      },
    ],
    generationConfig: {
      temperature: request.temperature ?? 0.8,
      maxOutputTokens: request.maxOutputTokens ?? 2048,
    },
  };

  let response: Response;
  try {
    response = await doFetch(`${endpoint(request, model, "streamGenerateContent")}&alt=sse`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: request.signal,
    });
  } catch (error) {
    throw networkError(error);
  }
  if (!response.ok) throw await failure(response);
  if (!response.body) throw new GeminiError("This browser cannot stream responses. Update Android System WebView.", 0, "NO_STREAM", false);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";

  const handleEvent = (payload: string) => {
    const json = safeJson(payload);
    if (!json) return;
    if (json.error) {
      throw new GeminiError(
        json.error.message || "The model stopped with an error.",
        200,
        String(json.error.status ?? "STREAM_ERROR"),
        false,
      );
    }
    const blocked = blockReason(json);
    if (blocked) throw new GeminiError(`Google stopped that answer (${blocked.toLowerCase().replace(/_/g, " ")}).`, 200, "BLOCKED", false);
    const delta = textFromEnvelope(json);
    if (!delta) return;
    full += delta;
    request.onDelta(delta);
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let split = buffer.indexOf("\n\n");
      while (split !== -1) {
        const rawEvent = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        for (const line of rawEvent.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trim();
          if (payload && payload !== "[DONE]") handleEvent(payload);
        }
        split = buffer.indexOf("\n\n");
      }
    }
    // A final event without a trailing blank line.
    const tail = buffer.trim();
    if (tail.startsWith("data:")) {
      const payload = tail.slice(5).trim();
      if (payload && payload !== "[DONE]") handleEvent(payload);
    }
  } catch (error) {
    if (error instanceof GeminiError) throw error;
    const aborted = (error as { name?: string })?.name === "AbortError";
    throw new GeminiError(
      aborted ? "That answer was cancelled." : "The connection to Google dropped mid-answer. Ask again.",
      0,
      aborted ? "ABORTED" : "STREAM_BROKEN",
      !aborted,
    );
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }

  if (!full.trim()) throw new GeminiError("The model returned an empty answer. Try rephrasing.", 200, "EMPTY", true);
  request.onDone?.(full);
  return full;
}

function networkError(error: unknown): GeminiError {
  if (error instanceof GeminiError) return error;
  const aborted = (error as { name?: string })?.name === "AbortError";
  return new GeminiError(
    aborted ? "That request was cancelled." : "The phone could not reach Google. Check your connection and try again.",
    0,
    aborted ? "ABORTED" : "OFFLINE",
    !aborted,
  );
}

/** Voice note → text. Audio goes inline; no file ever leaves the device. */
export async function transcribe(
  request: RequestOptions & { audio: { mimeType: string; data: string }; hint?: string },
): Promise<string> {
  const text = await generate({
    ...request,
    system:
      "You transcribe short voice notes for a personal assistant. Reply with the spoken words only — no commentary, no quotes, " +
      "no speaker labels. Keep the language the person spoke. If the audio is silent or unintelligible, reply with exactly: [unclear].",
    history: [],
    message: request.hint || "Transcribe this voice note.",
    image: request.audio,
    temperature: 0,
    maxOutputTokens: 512,
  });
  const cleaned = text.trim();
  if (!cleaned || /^\[unclear\]$/i.test(cleaned)) {
    throw new GeminiError("I could not make out that recording. Try again a little closer to the microphone.", 200, "UNCLEAR_AUDIO", false);
  }
  return cleaned;
}
