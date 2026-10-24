/**
 * Small bridge between the voice helpers and the rest of the standalone app.
 *
 * Keeping it separate means the UI imports one module (record, speak, probe)
 * and the Gemini client stays out of the component tree.
 */
import { transcribe } from "./gemini";
import type { VoiceNote } from "./voice";

export {
  forgetSpeechStatus,
  hasNativeVoice,
  initSpeech,
  micAvailable,
  openSpeechSettings,
  speak,
  speakTest,
  speechOutputAvailable,
  startRecording,
  stopSpeaking,
  voiceFacts,
  type SpeechStatus,
  type Recorder,
  type VoiceNote,
} from "./voice";

/** Audio note → text, using the same key and model as the conversation. */
export async function transcribeNote(options: {
  key: string;
  model?: string;
  audio: VoiceNote;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  signal?: AbortSignal;
}): Promise<string> {
  return transcribe({
    key: options.key,
    model: options.model,
    audio: { mimeType: options.audio.mimeType, data: options.audio.base64 },
    fetchImpl: options.fetchImpl,
    baseUrl: options.baseUrl,
    signal: options.signal,
  });
}
