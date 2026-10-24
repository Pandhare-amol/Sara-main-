/**
 * Voice on the phone, without a server.
 *
 * Input:  microphone → MediaRecorder → base64 → Gemini (transcription).
 * Output: Android's own TextToSpeech engine (through the SaraVoice plugin),
 *         with the WebView's `speechSynthesis` as the fallback.
 *
 * Why the native path exists: an Android WebView very often ships **no** speech
 * engine at all — `window.speechSynthesis` is either missing or has zero voices —
 * which is exactly the "No speech engine — replies stay text" state. Installing
 * "Google Play services" does not fix that from inside a web app: the fix is to
 * call Android's `TextToSpeech`, which uses whichever engine the phone has
 * (Google Text-to-Speech, Samsung, eSpeak…), including on phones with no Google
 * account at all.
 *
 * Everything is probed before it is offered. If a phone has no engine the app
 * says so, and offers the Android screen where one can be installed.
 */

export interface VoiceNote {
  base64: string;
  mimeType: string;
  durationMs: number;
}

/* --------------------------------------------------------------- native bridge */

interface NativeVoicePlugin {
  info(): Promise<{ ready?: boolean; engine?: string; defaultLanguage?: string; voices?: Array<{ name?: string; lang?: string }>; error?: string }>;
  speak(options: { text: string; rate?: number; pitch?: number; volume?: number; voiceName?: string; language?: string }): Promise<{ ok?: boolean; engine?: string; message?: string }>;
  stop(): Promise<void>;
  openSettings(): Promise<{ opened?: boolean; message?: string }>;
}

/** The Capacitor bridge, when this bundle is running inside the Android app. */
function nativeVoice(): NativeVoicePlugin | null {
  const capacitor = (globalThis as { Capacitor?: { Plugins?: Record<string, unknown> } }).Capacitor;
  const plugin = capacitor?.Plugins?.SaraVoice as NativeVoicePlugin | undefined;
  return plugin && typeof plugin.speak === "function" ? plugin : null;
}

export function hasNativeVoice(): boolean {
  return nativeVoice() !== null;
}

export interface SpeechStatus {
  kind: "native" | "web" | "none";
  /** Engine package name on Android, or "WebView speech synthesis". */
  engine: string;
  detail: string;
  voices: string[];
}

let cachedStatus: SpeechStatus | null = null;

/**
 * Asks the platform what it really has. Safe to call repeatedly; the result is
 * cached until `forgetSpeechStatus()` (used after opening the system settings).
 */
export async function initSpeech(): Promise<SpeechStatus> {
  if (cachedStatus) return cachedStatus;

  const bridge = nativeVoice();
  if (bridge) {
    try {
      // Android builds its TextToSpeech object asynchronously; give it a moment
      // instead of concluding "no engine" on the first frame.
      let info = await bridge.info();
      for (let attempt = 0; attempt < 6 && !info?.ready && !info?.error; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        info = await bridge.info();
      }
      if (info?.ready) {
        cachedStatus = {
          kind: "native",
          engine: info.engine || "Android TextToSpeech",
          detail: "Android's speech engine is ready.",
          voices: (info.voices ?? []).map((voice) => voice.name || voice.lang || "").filter(Boolean).slice(0, 60),
        };
        return cachedStatus;
      }
      cachedStatus = {
        kind: webSpeechAvailable() ? "web" : "none",
        engine: info?.engine || "",
        detail: info?.error || "Android reported no usable speech engine on this phone.",
        voices: [],
      };
      return cachedStatus;
    } catch (error) {
      // Fall through to the WebView engine below.
      void error;
    }
  }

  if (webSpeechAvailable()) {
    cachedStatus = {
      kind: "web",
      engine: "WebView speech synthesis",
      detail: "Using the WebView's built-in speech synthesis.",
      voices: webVoices().map((voice) => voice.name),
    };
    return cachedStatus;
  }

  cachedStatus = {
    kind: "none",
    engine: "",
    detail: "No speech engine on this phone. Install one from Android settings → Text-to-speech output.",
    voices: [],
  };
  return cachedStatus;
}

export function forgetSpeechStatus(): void {
  cachedStatus = null;
}

/** True when either path can actually speak — checked without awaiting. */
export function speechOutputAvailable(): boolean {
  if (cachedStatus) return cachedStatus.kind !== "none";
  return hasNativeVoice() || webSpeechAvailable();
}

function webSpeechAvailable(): boolean {
  return typeof window !== "undefined" && typeof window.speechSynthesis !== "undefined" && typeof SpeechSynthesisUtterance !== "undefined";
}

function webVoices(): SpeechSynthesisVoice[] {
  if (!webSpeechAvailable()) return [];
  try {
    return window.speechSynthesis.getVoices() ?? [];
  } catch {
    return [];
  }
}

/** Opens Android's Text-to-speech settings so a missing engine can be installed. */
export async function openSpeechSettings(): Promise<string> {
  const bridge = nativeVoice();
  if (!bridge) return "Open Android Settings → System → Languages & input → Text-to-speech output on the phone.";
  try {
    const result = await bridge.openSettings();
    forgetSpeechStatus();
    return result?.opened === false ? result?.message || "Android did not open the speech settings." : "Android's speech settings are open. Pick or install an engine, then test again.";
  } catch (error) {
    return error instanceof Error ? error.message : "Android did not open the speech settings.";
  }
}

/* ------------------------------------------------------------------- input */

export function micAvailable(): boolean {
  return Boolean(navigator.mediaDevices?.getUserMedia) && typeof MediaRecorder !== "undefined";
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

  const stop = () =>
    new Promise<VoiceNote>((resolve, reject) => {
      settled = resolve;
      failed = reject;
      if (stopTimer !== null) window.clearTimeout(stopTimer);
      if (recorder.state !== "inactive") recorder.stop();
      else reject(new Error("The recording already stopped."));
    });

  return {
    limitMs,
    stop,
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
  volume?: number;
  /** Exact voice name from the phone's engine list. */
  voiceName?: string;
  /** Best-effort: pick a voice whose name or language hints at the user's language. */
  language?: string;
  /** Long answers are cut here so one reply cannot talk for ten minutes. */
  maxChars?: number;
  onStart?: () => void;
  onEnd?: () => void;
}

function trimForSpeech(text: string, maxChars: number): string {
  const clean = String(text ?? "").trim();
  if (!maxChars || clean.length <= maxChars) return clean;
  const cut = clean.slice(0, maxChars);
  const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return stop > 40 ? cut.slice(0, stop + 1) : `${cut.trimEnd()}…`;
}

/**
 * Speaks `text`. Resolves false when the phone has no speech engine — the
 * caller is told, never left with silence that looks like a bug.
 */
export async function speak(text: string, options: SpeakOptions = {}): Promise<boolean> {
  const clean = trimForSpeech(text, options.maxChars ?? 1200);
  if (!clean) return true;

  const bridge = nativeVoice();
  if (bridge) {
    try {
      options.onStart?.();
      const result = await bridge.speak({
        text: clean,
        rate: options.rate ?? 1,
        pitch: options.pitch ?? 1.1,
        volume: options.volume ?? 1,
        voiceName: options.voiceName,
        language: options.language ?? navigator.language ?? "en-US",
      });
      options.onEnd?.();
      if (result?.ok !== false) return true;
      if (!webSpeechAvailable()) {
        cachedStatus = { kind: "none", engine: "", detail: result?.message || "The phone's speech engine refused to speak.", voices: [] };
        return false;
      }
      // Native refused; try the WebView engine before giving up.
    } catch {
      options.onEnd?.();
      if (!webSpeechAvailable()) return false;
    }
  }

  return speakWithWebView(clean, options);
}

function speakWithWebView(clean: string, options: SpeakOptions): Promise<boolean> {
  return new Promise((resolve) => {
    if (!webSpeechAvailable()) {
      resolve(false);
      return;
    }
    stopSpeaking();

    const utterance = new SpeechSynthesisUtterance(clean);
    utterance.rate = Math.min(2, Math.max(0.5, options.rate ?? 1));
    utterance.pitch = Math.min(2, Math.max(0, options.pitch ?? 1.15));
    utterance.volume = Math.min(1, Math.max(0, options.volume ?? 1));
    const language = options.language ?? navigator.language ?? "en-US";
    utterance.lang = language;

    try {
      const voices = webVoices();
      const exact = options.voiceName ? voices.find((voice) => voice.name === options.voiceName) : undefined;
      const match =
        exact ??
        voices.find((voice) => voice.lang?.toLowerCase() === language.toLowerCase()) ??
        voices.find((voice) => voice.lang?.startsWith("en"));
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
  const bridge = nativeVoice();
  if (bridge) {
    void bridge.stop().catch(() => undefined);
  }
  if (!webSpeechAvailable()) return;
  try {
    activeUtterance = null;
    window.speechSynthesis.cancel();
  } catch {
    /* nothing to cancel */
  }
}

/** Speaks a fixed sentence so the user can hear the chosen voice and speed. */
export async function speakTest(options: SpeakOptions = {}): Promise<boolean> {
  return speak("Hi, I am Sara. This is how I sound on your phone.", { maxChars: 200, ...options });
}

/** Facts the app verified, for the system prompt. Never guesses. */
export function voiceFacts(): string[] {
  const facts: string[] = [];
  facts.push(micAvailable() ? "voice input: available (the user records a note which is transcribed)" : "voice input: unavailable on this device");
  const status = cachedStatus;
  if (status?.kind === "native") facts.push(`speech output: available through Android's engine (${status.engine})`);
  else if (status?.kind === "web") facts.push("speech output: available (WebView speech synthesis)");
  else if (status?.kind === "none") facts.push("speech output: unavailable — replies are text only");
  else facts.push("speech output: not yet checked on this launch");
  return facts;
}
