/**
 * Direct Gemini REST client for standalone Sara Mobile.
 *
 * This is the phone's own brain connection: no Sara server sits in between, so
 * the request shapes, the streaming parser and the error mapping have to be
 * right here. Everything is injectable (`fetchImpl`, `baseUrl`) so the tests can
 * prove the wire format without a key or a network.
 *
 * Two deliberate hardening choices, both learned from phones in the field:
 *
 *  - the key travels in the `x-goog-api-key` header (URLs end up in logs, crash
 *    reports and screenshots), with an automatic fallback to `?key=` only when
 *    Google answers 401/403 for the header;
 *  - a failed transport is retried exactly once, and a broken stream falls back
 *    to a plain non-streaming answer, because a mobile network dropping one
 *    request should not look like "Sara is broken".
 *
 * What is deliberately NOT here: retry storms, background polling, or a second
 * copy of the desktop's tool loop. One request at a time, and a failure is
 * reported as a failure — with the underlying cause attached.
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
  /** The raw cause, shown in Self-check so a failure can be diagnosed. */
  readonly detail: string;

  constructor(message: string, status: number, code: string, retryable: boolean, detail = "") {
    super(message);
    this.name = "GeminiError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.detail = detail;
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
    return new GeminiError("Google rejected that API key. Check it in Settings → AI key.", status, "INVALID_KEY", false, detail);
  }
  if (status === 401 || status === 403) {
    return new GeminiError(
      apiState === "PERMISSION_DENIED"
        ? "This key is not allowed to use that model. Enable it in Google AI Studio, or pick another model."
        : "Google refused the request. The key may be wrong or restricted.",
      status,
      "FORBIDDEN",
      false,
      detail,
    );
  }
  if (status === 404) {
    return new GeminiError("That model is not available for this key. Pick another model in Settings.", status, "NO_MODEL", false, detail);
  }
  if (status === 429) {
    return new GeminiError("Google's limit for this key is used up right now. Wait a minute and try again.", status, "RATE_LIMIT", true, detail);
  }
  if (status >= 500) {
    return new GeminiError("Google's service is having trouble. Try again in a moment.", status, "UPSTREAM", true, detail);
  }
  return new GeminiError(detail || `The request failed (${status}).`, status, "HTTP_ERROR", false, detail);
}

function safeJson(text: string): GeminiEnvelope | null {
  try {
    return JSON.parse(text) as GeminiEnvelope;
  } catch {
    return null;
  }
}

function baseOf(options: RequestOptions): string {
  return (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

/**
 * One POST with the key in the header, retried once on a transport failure and
 * once against `?key=` if Google says the header credential was not accepted.
 */
async function postJson(options: RequestOptions, path: string, body: unknown, query = ""): Promise<Response> {
  const doFetch = options.fetchImpl ?? fetch;
  const base = baseOf(options);
  const payload = JSON.stringify(body);
  const suffix = query ? (query.startsWith("&") ? query : `&${query}`) : "";

  const attempt = (mode: "header" | "query"): Promise<Response> => {
    const plain = suffix.replace(/^&/, "");
    const url =
      mode === "query"
        ? `${base}${path}?key=${encodeURIComponent(options.key)}${suffix}`
        : plain
          ? `${base}${path}?${plain}`
          : `${base}${path}`;
    const headers: Record<string, string> =
      mode === "header"
        ? { "Content-Type": "application/json", "x-goog-api-key": options.key }
        : { "Content-Type": "application/json" };
    return doFetch(url, { method: "POST", headers, body: payload, signal: options.signal });
  };

  let lastError: unknown = null;
  for (let round = 0; round < 2; round += 1) {
    try {
      const response = await attempt("header");
      if (response.status === 401 || response.status === 403) {
        const text = await readText(response);
        if (/api key|api_key|unregistered|credential|invalid argument/i.test(text)) {
          // Some proxies strip custom headers; the query form still works.
          return attempt("query");
        }
        return new Response(text, { status: response.status, statusText: response.statusText });
      }
      return response;
    } catch (error) {
      lastError = error;
      if (options.signal?.aborted) throw networkError(error);
      if (round === 0) await sleep(350);
    }
  }
  throw networkError(lastError);
}

async function failure(response: Response): Promise<GeminiError> {
  return mapHttpError(response.status, await readText(response));
}

export interface ChatRequest extends RequestOptions {
  system: string;
  history: ChatTurn[];
  message: string;
  image?: { mimeType: string; data: string };
  temperature?: number;
  maxOutputTokens?: number;
}

function requestBody(request: ChatRequest) {
  return {
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
      temperature: clamp(request.temperature ?? 0.8, 0, 2),
      maxOutputTokens: Math.round(clamp(request.maxOutputTokens ?? 2048, 64, 8192)),
    },
  };
}

function clamp(value: number, min: number, max: number): number {
  const number = Number.isFinite(value) ? value : min;
  return Math.min(max, Math.max(min, number));
}

/** One-shot (non-streaming) generation — used by vision, transcription and the streaming fallback. */
export async function generate(request: ChatRequest): Promise<string> {
  const model = request.model || DEFAULT_MODEL;
  const response = await postJson(request, `/models/${encodeURIComponent(model)}:generateContent`, requestBody(request));
  if (!response.ok) throw await failure(response);

  const json = safeJson(await readText(response));
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
  /**
   * When the stream breaks before any text arrived, answer with a normal
   * (non-streaming) request instead. Default true — a phone on a weak network
   * should still get her reply.
   */
  fallbackToPlain?: boolean;
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
  const response = await postJson(
    request,
    `/models/${encodeURIComponent(model)}:streamGenerateContent`,
    requestBody(request),
    "alt=sse",
  );
  if (!response.ok) throw await failure(response);

  // A WebView without streams (or a size-zero body) still gets a real answer.
  if (!response.body || typeof response.body.getReader !== "function") {
    if (request.fallbackToPlain === false) {
      throw new GeminiError("This browser cannot stream responses. Update Android System WebView.", 0, "NO_STREAM", false);
    }
    const text = await generate({ ...request, maxOutputTokens: request.maxOutputTokens });
    request.onDelta(text);
    request.onDone?.(text);
    return text;
  }

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

  let broke: GeminiError | null = null;
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
    // Anything the model or Google said is final: it is a real answer about the
    // request, not a dropped connection, so it must not be retried as one.
    if (error instanceof GeminiError) throw error;
    {
      const aborted = (error as { name?: string })?.name === "AbortError";
      if (aborted) {
        throw new GeminiError("That answer was cancelled.", 0, "ABORTED", false);
      }
      broke = new GeminiError(
        "The connection to Google dropped mid-answer.",
        0,
        "STREAM_BROKEN",
        true,
        String((error as { message?: string })?.message ?? error),
      );
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }

  if (broke) {
    // Nothing arrived yet → retry the whole thing without streaming.
    if (!full.trim() && request.fallbackToPlain !== false) {
      const text = await generate({ ...request, maxOutputTokens: request.maxOutputTokens });
      request.onDelta(text);
      request.onDone?.(text);
      return text;
    }
    throw broke;
  }

  if (!full.trim()) {
    if (request.fallbackToPlain !== false) {
      const text = await generate({ ...request, maxOutputTokens: request.maxOutputTokens });
      request.onDelta(text);
      request.onDone?.(text);
      return text;
    }
    throw new GeminiError("The model returned an empty answer. Try rephrasing.", 200, "EMPTY", true);
  }
  request.onDone?.(full);
  return full;
}

export function networkError(error: unknown): GeminiError {
  if (error instanceof GeminiError) return error;
  const aborted = (error as { name?: string })?.name === "AbortError";
  if (aborted) return new GeminiError("That request was cancelled.", 0, "ABORTED", false);
  const raw = String((error as { message?: string })?.message ?? error ?? "");
  return new GeminiError(
    "The phone could not reach Google. Open Self-check → Test connection to see what failed.",
    0,
    "OFFLINE",
    true,
    raw,
  );
}

/* ------------------------------------------------------------------- models */

export interface ModelInfo {
  /** Without the `models/` prefix, ready to use in a request. */
  id: string;
  displayName: string;
  methods: string[];
}

export interface ModelsResult {
  models: ModelInfo[];
  /** Raw status code when the list could not be read; 0 means transport failure. */
  status: number;
  detail: string;
}

/**
 * The model ids this key is actually allowed to use.
 *
 * This exists because Google renames and retires models; asking for a model the
 * key cannot use is the single most common "she stopped working" cause, and the
 * phone should be able to correct it instead of guessing.
 */
export async function listModels(options: RequestOptions): Promise<ModelsResult> {
  const doFetch = options.fetchImpl ?? fetch;
  const base = baseOf(options);
  const attempt = (mode: "header" | "query") => {
    const url = mode === "query" ? `${base}/models?pageSize=200&key=${encodeURIComponent(options.key)}` : `${base}/models?pageSize=200`;
    const headers: Record<string, string> = mode === "header" ? { "x-goog-api-key": options.key } : {};
    return doFetch(url, { method: "GET", headers, signal: options.signal });
  };

  let response: Response;
  try {
    response = await attempt("header");
    if (response.status === 401 || response.status === 403) {
      const text = await readText(response);
      if (/api key|api_key|unregistered|credential/i.test(text)) response = await attempt("query");
      else return { models: [], status: response.status, detail: text.slice(0, 300) };
    }
  } catch (error) {
    const network = networkError(error);
    return { models: [], status: 0, detail: network.detail || network.message };
  }

  const text = await readText(response);
  if (!response.ok) {
    const mapped = mapHttpError(response.status, text);
    return { models: [], status: response.status, detail: mapped.detail || mapped.message };
  }

  const parsed = safeJson(text) as { models?: Array<{ name?: string; displayName?: string; supportedGenerationMethods?: string[] }> } | null;
  const rows = Array.isArray(parsed?.models) ? parsed.models : [];
  const models: ModelInfo[] = rows
    .filter((row) => typeof row?.name === "string")
    .map((row) => ({
      id: String(row.name).replace(/^models\//, ""),
      displayName: String(row.displayName ?? "").trim() || String(row.name).replace(/^models\//, ""),
      methods: Array.isArray(row.supportedGenerationMethods) ? row.supportedGenerationMethods.map(String) : [],
    }))
    .filter((row) => row.methods.length === 0 || row.methods.includes("generateContent"))
    .sort((a, b) => a.id.localeCompare(b.id));

  return { models, status: response.status, detail: "" };
}

/* -------------------------------------------------------------- diagnostics */

export interface ProbeStep {
  id: string;
  label: string;
  state: "ok" | "warn" | "no";
  detail: string;
}

export interface ProbeResult {
  ok: boolean;
  steps: ProbeStep[];
  /** Model ids the key can use (empty when the list could not be read). */
  models: ModelInfo[];
  /** Whether the configured model is in that list. `null` when unknown. */
  modelKnown: boolean | null;
}

/**
 * A staged check of the exact hop that fails, rather than "something broke".
 *
 * `live: true` also asks the model a throwaway question, which is the only
 * thing that proves the whole chain works — it costs one tiny request.
 */
export async function probeConnection(
  options: RequestOptions & { model?: string; online?: boolean; live?: boolean },
): Promise<ProbeResult> {
  const steps: ProbeStep[] = [];
  const online = options.online ?? (typeof navigator === "undefined" ? true : navigator.onLine !== false);
  steps.push({
    id: "network",
    label: "Phone network",
    state: online ? "ok" : "no",
    detail: online ? "Android reports a network connection." : "Android reports no network connection.",
  });

  const started = Date.now();
  const listing = await listModels(options);
  const elapsed = Date.now() - started;

  if (listing.status === 0) {
    steps.push({
      id: "reach",
      label: "Reach Google",
      state: "no",
      detail: `The request never completed after ${elapsed} ms. Underlying error: ${listing.detail || "no detail reported"}`,
    });
    return { ok: false, steps, models: [], modelKnown: null };
  }
  steps.push({
    id: "reach",
    label: "Reach Google",
    state: "ok",
    detail: `Answered in ${elapsed} ms (HTTP ${listing.status}).`,
  });

  if (listing.status === 400 || listing.status === 401 || listing.status === 403) {
    steps.push({
      id: "key",
      label: "API key",
      state: "no",
      detail: `Google rejected the key: ${listing.detail || `HTTP ${listing.status}`}`,
    });
    return { ok: false, steps, models: [], modelKnown: null };
  }
  if (listing.status >= 400) {
    steps.push({
      id: "key",
      label: "API key",
      state: "warn",
      detail: `Google answered HTTP ${listing.status}: ${listing.detail || "no detail"}`,
    });
    return { ok: false, steps, models: [], modelKnown: null };
  }

  steps.push({
    id: "key",
    label: "API key",
    state: "ok",
    detail: listing.models.length
      ? `Accepted. This key can use ${listing.models.length} model${listing.models.length === 1 ? "" : "s"}.`
      : "Accepted, but Google listed no model that supports text generation for it.",
  });

  const wanted = options.model || DEFAULT_MODEL;
  const known = listing.models.length ? listing.models.some((model) => model.id === wanted) : null;
  steps.push({
    id: "model",
    label: "Model",
    state: known === false ? "warn" : known === null ? "warn" : "ok",
    detail:
      known === false
        ? `${wanted} is not in this key's list. Available: ${listing.models.slice(0, 6).map((model) => model.id).join(", ")}${listing.models.length > 6 ? "…" : ""}`
        : known === null
          ? `${wanted} — the key's model list was empty, so this could not be confirmed.`
          : `${wanted} is available to this key.`,
  });

  if (!options.live) {
    return { ok: listing.status < 400, steps, models: listing.models, modelKnown: known };
  }

  // The only step that proves an answer really comes back.
  const live = Date.now();
  try {
    const answer = await generate({
      ...options,
      model: wanted,
      system: "You are a connectivity check. Answer with one short word.",
      history: [],
      message: "Say ok.",
      temperature: 0,
      maxOutputTokens: 64,
    });
    steps.push({
      id: "answer",
      label: "Answer from the model",
      state: answer.trim() ? "ok" : "warn",
      detail: answer.trim()
        ? `The model replied in ${Date.now() - live} ms. Chat will work.`
        : "The model returned an empty answer.",
    });
    return { ok: Boolean(answer.trim()), steps, models: listing.models, modelKnown: known };
  } catch (error) {
    const mapped = error instanceof GeminiError ? error : networkError(error);
    steps.push({
      id: "answer",
      label: "Answer from the model",
      state: "no",
      detail: `${mapped.message}${mapped.detail ? ` (${mapped.detail})` : ""}`,
    });
    return { ok: false, steps, models: listing.models, modelKnown: known };
  }
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
