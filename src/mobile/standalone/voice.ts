/**
 * Voice on the phone, without a server.
 *
 * Input:  microphone → MediaRecorder → base64 → Gemini (transcription).
 * Output: the phone's own speech engine (`speechSynthesis`).
 *
 * Both are probed before they are offered. If a phone has no speech engine the
 * app says so and stays text-only instead of silently playing nothing.
 */

export interface VoiceNote {
  base64: string;
  mimeType: string;
  durationMs: number;
}

export function micAvailable(): boolean {
  return Boolean(navigator.mediaDevices?.getUserMedia) && typeof MediaRecorder !== "undefined";
}

export function speechOutputAvailable(): boolean {
  return typeof window !== "undefined" && typeof window.speechSynthesis !== "undefined" && typeof SpeechSynthesisUtterance !== "undefined";
}

/** The recorder's preferred container on this device, or "" when none is usable. */
export function pickAudioMime(): string {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") return "";
  for (const type of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"]) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return "";
}

export interface Recorder {
  /** Resolves with the recording; rejects with a readable message. */
  stop(): Promise<VoiceNote>;
  /** Throws the recording away. */
  cancel(): void;
  /** Auto-stops after this many ms. */
  readonly limitMs: number;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("The recording could not be read."));
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(blob);
  });
}

export async function startRecording(limitMs = 60_000): Promise<Recorder> {
  if (!micAvailable()) throw new Error("This device has no microphone recorder available to the app.");
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true }).catch((error: unknown) => {
    const name = (error as { name?: string })?.name;
    if (name === "NotAllowedError" || name === "SecurityError") {
      throw new Error("Microphone permission was denied. Allow it in Android settings for Sara Mobile, or type instead.");
    }
    throw new Error("The microphone could not be opened. Another app may be using it.");
  });

  const mimeType = pickAudioMime();
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks: Blob[] = [];
  const startedAt = Date.now();
  let stopTimer: number | null = null;
  let settled: ((note: VoiceNote) => void) | null = null;
  let failed: ((error: Error) => void) | null = null;

  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) chunks.push(event.data);
  };
  recorder.onerror = () => {
    stream.getTracks().forEach((track) => track.stop());
    failed?.(new Error("The recording failed. Try again."));
  };
  recorder.onstop = async () => {
    stream.getTracks().forEach((track) => track.stop());
    try {
      const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || "audio/webm" });
      if (blob.size < 1200) {
        failed?.(new Error("That was too short to hear. Hold the button and speak a full sentence."));
        return;
      }
      const base64 = await blobToBase64(blob);
      settled?.({
        base64,
        // Gemini accepts the container type; strip codec parameters it rejects.
        mimeType: (recorder.mimeType || mimeType || "audio/webm").split(";")[0],
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      failed?.(error instanceof Error ? error : new Error(String(error)));
    }
  };

  recorder.start();

  return {
    limitMs,
    stop: () =>
      new Promise<VoiceNote>((resolve, reject) => {
        settled = resolve;
        failed = reject;
        if (stopTimer !== null) window.clearTimeout(stopTimer);
        if (recorder.state !== "inactive") recorder.stop();
        else reject(new Error("The recording already stopped."));
      }),
    cancel: () => {
      settled = null;
      failed = null;
      if (stopTimer !== null) window.clearTimeout(stopTimer);
      if (recorder.state !== "inactive") recorder.stop();
      stream.getTracks().forEach((track) => track.stop());
    },
  };
}

/* ------------------------------------------------------------------ speaking */

let activeUtterance: SpeechSynthesisUtterance | null = null;

export interface SpeakOptions {
  rate?: number;
  pitch?: number;
  /** Best-effort: pick a voice whose name or language hints at the user's language. */
  language?: string;
  onStart?: () => void;
  onEnd?: () => void;
}

/**
 * Speaks `text`. Resolves when speech finished (or immediately when the device
 * has no speech engine — the caller is told via the return value, not silence).
 */
export function speak(text: string, options: SpeakOptions = {}): Promise<boolean> {
  return new Promise((resolve) => {
    if (!speechOutputAvailable()) {
      resolve(false);
      return;
    }
    const clean = String(text ?? "").trim();
    if (!clean) {
      resolve(true);
      return;
    }
    stopSpeaking();

    const utterance = new SpeechSynthesisUtterance(clean);
    utterance.rate = options.rate ?? 1;
    utterance.pitch = options.pitch ?? 1.15;
    const language = options.language ?? navigator.language ?? "en-US";
    utterance.lang = language;

    try {
      const voices = window.speechSynthesis.getVoices();
      const match = voices.find((voice) => voice.lang?.toLowerCase() === language.toLowerCase()) ?? voices.find((voice) => voice.lang?.startsWith("en"));
      if (match) utterance.voice = match;
    } catch {
      /* voices may not be ready; the default engine voice is fine */
    }

    activeUtterance = utterance;
    utterance.onstart = () => options.onStart?.();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      if (activeUtterance === utterance) activeUtterance = null;
      options.onEnd?.();
      resolve(true);
    };
    utterance.onend = finish;
    utterance.onerror = finish;

    window.speechSynthesis.speak(utterance);
    // Some Android WebViews never fire `onend`; do not hang the UI forever.
    const guard = Math.min(180_000, 4_000 + clean.length * 90);
    window.setTimeout(finish, guard);
  });
}

export function stopSpeaking(): void {
  if (!speechOutputAvailable()) return;
  try {
    activeUtterance = null;
    window.speechSynthesis.cancel();
  } catch {
    /* nothing to cancel */
  }
}

/** Facts the app verified, for the system prompt. Never guesses. */
export function voiceFacts(): string[] {
  const facts: string[] = [];
  facts.push(micAvailable() ? "voice input: available (the user records a note which is transcribed)" : "voice input: unavailable on this device");
  facts.push(speechOutputAvailable() ? "speech output: available (replies can be read aloud)" : "speech output: unavailable — replies are text only");
  return facts;
}
