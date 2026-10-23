/**
 * The API key for standalone Sara Mobile.
 *
 * There is no server in this app, so the key has to live on the phone. That is
 * a real trade-off and the UI says it plainly:
 *
 *  - it is stored in this app's own storage, in plain text, and never leaves the
 *    device except in the request header sent to Google;
 *  - it is never written into the bundle, a log, a crash report or an analytic;
 *  - Forget key removes it.
 *
 * Anyone who can unlock the phone can read the app's storage, so a phone-only
 * app cannot keep a secret from the phone's owner. That is why this build is
 * separate from the desktop app, where the key stays on the PC.
 */

const KEY_STORAGE = "sara.mobile.gemini-key.v1";

export interface KeyInfo {
  present: boolean;
  /** `…` + last four characters, for "is this the key I pasted?" checks. */
  hint: string;
  /** Where the key came from, so the UI can explain what "remove" will do. */
  source: "device" | "none";
}

/** Google AI Studio keys are ~39 chars; keep the check loose but not useless. */
export function looksLikeApiKey(value: string): boolean {
  const key = String(value ?? "").trim();
  if (key.length < 20 || key.length > 200) return false;
  if (/\s/.test(key)) return false;
  return /^[A-Za-z0-9._-]+$/.test(key);
}

export function maskKey(key: string): string {
  const value = String(key ?? "").trim();
  if (!value) return "";
  if (value.length <= 8) return "•".repeat(value.length);
  return `${"•".repeat(Math.min(12, value.length - 4))}${value.slice(-4)}`;
}

export function readKey(): string {
  try {
    return String(window.localStorage.getItem(KEY_STORAGE) ?? "").trim();
  } catch {
    return "";
  }
}

export function describeKey(key = readKey()): KeyInfo {
  if (!key) return { present: false, hint: "", source: "none" };
  return { present: true, hint: maskKey(key), source: "device" };
}

/** Returns an error message, or null when the key was stored. */
export function saveKey(raw: string): string | null {
  const key = String(raw ?? "").trim();
  if (!looksLikeApiKey(key)) {
    return "That does not look like a Google AI Studio key. Copy the whole key (it is long and has no spaces).";
  }
  try {
    window.localStorage.setItem(KEY_STORAGE, key);
    return null;
  } catch {
    return "This browser refused to store the key. Private mode blocks app storage — use the installed app.";
  }
}

export function forgetKey(): void {
  try {
    window.localStorage.removeItem(KEY_STORAGE);
  } catch {
    /* nothing to do: the key is already gone with the storage */
  }
}
