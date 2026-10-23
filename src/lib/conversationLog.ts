/**
 * Device-side conversation log for the mobile shell.
 *
 * This is NOT a second memory system. Sara's real long-term memory lives in the
 * backend (`/api/memories`, cognition memory). This module only keeps the last
 * few turns so the phone can show a readable history across reloads, because
 * the live Gemini session itself does not replay an old transcript after a
 * reconnect. It never leaves the device and can be cleared from Settings.
 */

export type ConversationRole = "user" | "sara";

export interface ConversationEntry {
  id: string;
  role: ConversationRole;
  text: string;
  at: number;
}

const STORAGE_KEY = "sara.conversation.v1";
const MAX_ENTRIES = 120;

type Listener = (entries: ConversationEntry[]) => void;

let entries: ConversationEntry[] | null = null;
const listeners = new Set<Listener>();

function read(): ConversationEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is ConversationEntry =>
        Boolean(item && typeof item.text === "string" && (item.role === "user" || item.role === "sara")))
      .map((item) => ({
        id: String(item.id || cryptoId()),
        role: item.role,
        text: item.text.slice(0, 8000),
        at: Number(item.at) || Date.now(),
      }))
      .slice(-MAX_ENTRIES);
  } catch {
    return [];
  }
}

function cryptoId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }
}

function persist(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries ?? []));
  } catch {
    /* private mode or quota — history becomes session-only */
  }
}

function emit(): void {
  const snapshot = [...(entries ?? [])];
  listeners.forEach((listener) => listener(snapshot));
}

export function listConversation(): ConversationEntry[] {
  if (entries === null) entries = read();
  return [...entries];
}

export function subscribeConversation(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function appendConversation(role: ConversationRole, text: string, at = Date.now()): ConversationEntry | null {
  const clean = text.trim();
  if (!clean) return null;
  if (entries === null) entries = read();
  const last = entries[entries.length - 1];
  // Streamed transcription can arrive in fragments; merge with the previous
  // entry of the same role within a short window instead of spamming the log.
  if (last && last.role === role && at - last.at < 4_000) {
    last.text = clean;
    last.at = at;
  } else {
    entries.push({ id: cryptoId(), role, text: clean, at });
  }
  entries = entries.slice(-MAX_ENTRIES);
  persist();
  emit();
  return entries[entries.length - 1] ?? null;
}

export function clearConversation(): void {
  entries = [];
  persist();
  emit();
}

/** Present the first N characters of the last message, for the home screen. */
export function latestMessage(role?: ConversationRole): ConversationEntry | null {
  const all = listConversation();
  for (let i = all.length - 1; i >= 0; i -= 1) {
    if (!role || all[i].role === role) return all[i];
  }
  return null;
}
