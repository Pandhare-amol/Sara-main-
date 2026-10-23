/**
 * Sara Mobile's own storage.
 *
 * This app is separate from PC Sara, so it keeps its own memory, reminders,
 * conversation and settings on the phone. Nothing here reads or writes the
 * desktop's files, and the desktop never sees these.
 *
 * Everything is bounded: a phone that runs out of storage is a phone that
 * crashes, so each list has a hard cap and the oldest entries fall off.
 */
import type { PersonaSettings, RealitySettings } from "../../lib/appApi";
import { DEFAULT_MODEL } from "./gemini";

export interface StandaloneMemory {
  id: string;
  text: string;
  createdAt: string;
}

export interface StandaloneReminder {
  id: string;
  text: string;
  /** ISO time, or null for "someday". */
  dueAt: string | null;
  done: boolean;
  createdAt: string;
}

export interface StandaloneMessage {
  id: string;
  role: "user" | "sara";
  text: string;
  at: string;
  /** True when the turn included a photo (the photo itself is not stored). */
  withImage?: boolean;
  /** True when the turn came from voice. */
  spoken?: boolean;
}

export interface StandaloneSettings {
  persona: PersonaSettings;
  reality: RealitySettings;
  model: string;
  /** Read replies aloud. */
  speakReplies: boolean;
}

export const MEMORY_LIMIT = 300;
export const MESSAGE_LIMIT = 200;
export const REMINDER_LIMIT = 200;

export const DEFAULT_PERSONA: PersonaSettings = {
  profile: "companion",
  context: "both",
  warmth: 72,
  humor: 48,
  formality: 22,
  directness: 58,
  empathy: 70,
  energy: 52,
  curiosity: 62,
};

export const DEFAULT_REALITY: RealitySettings = { mode: "standard", challengeAssumptions: true };

export const DEFAULT_SETTINGS: StandaloneSettings = {
  persona: DEFAULT_PERSONA,
  reality: DEFAULT_REALITY,
  model: DEFAULT_MODEL,
  speakReplies: true,
};

const KEYS = {
  memory: "sara.mobile.memory.v1",
  messages: "sara.mobile.messages.v1",
  reminders: "sara.mobile.reminders.v1",
  settings: "sara.mobile.settings.v1",
};

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return (parsed ?? fallback) as T;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): boolean {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    // Storage full or blocked. The caller surfaces this instead of pretending.
    return false;
  }
}

export function newId(prefix: string): string {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${random}`;
}

/* ------------------------------------------------------------------- memory */

export function listMemories(): StandaloneMemory[] {
  const items = readJson<StandaloneMemory[]>(KEYS.memory, []);
  return Array.isArray(items) ? items.filter((item) => item && typeof item.text === "string") : [];
}

/** Newest first, capped. Returns the stored record. */
export function addMemory(text: string): StandaloneMemory | null {
  const clean = String(text ?? "").trim();
  if (!clean) return null;
  const record: StandaloneMemory = { id: newId("mem"), text: clean.slice(0, 500), createdAt: new Date().toISOString() };
  const next = [record, ...listMemories()].slice(0, MEMORY_LIMIT);
  return writeJson(KEYS.memory, next) ? record : null;
}

export function deleteMemory(id: string): boolean {
  const next = listMemories().filter((item) => item.id !== id);
  return writeJson(KEYS.memory, next);
}

/** Substring match over words — small, predictable, no embeddings on a phone. */
export function searchMemories(query: string, limit = 8): StandaloneMemory[] {
  const words = String(query ?? "")
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 2);
  if (words.length === 0) return [];
  return listMemories()
    .map((item) => ({ item, score: words.filter((word) => item.text.toLowerCase().includes(word)).length }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.item);
}

export function clearMemories(): void {
  writeJson(KEYS.memory, []);
}

/* --------------------------------------------------------------- reminders */

export function listReminders(): StandaloneReminder[] {
  const items = readJson<StandaloneReminder[]>(KEYS.reminders, []);
  if (!Array.isArray(items)) return [];
  return items
    .filter((item) => item && typeof item.text === "string")
    .sort((a, b) => {
      if (a.done !== b.done) return a.done ? 1 : -1;
      const at = a.dueAt ? Date.parse(a.dueAt) : Number.MAX_SAFE_INTEGER;
      const bt = b.dueAt ? Date.parse(b.dueAt) : Number.MAX_SAFE_INTEGER;
      return at - bt;
    });
}

export function addReminder(text: string, dueAt: string | null): StandaloneReminder | null {
  const clean = String(text ?? "").trim();
  if (!clean) return null;
  const record: StandaloneReminder = {
    id: newId("rem"),
    text: clean.slice(0, 300),
    dueAt: dueAt && !Number.isNaN(Date.parse(dueAt)) ? dueAt : null,
    done: false,
    createdAt: new Date().toISOString(),
  };
  const next = [record, ...listReminders()].slice(0, REMINDER_LIMIT);
  return writeJson(KEYS.reminders, next) ? record : null;
}

export function setReminderDone(id: string, done: boolean): void {
  writeJson(
    KEYS.reminders,
    listReminders().map((item) => (item.id === id ? { ...item, done } : item)),
  );
}

export function deleteReminder(id: string): void {
  writeJson(
    KEYS.reminders,
    listReminders().filter((item) => item.id !== id),
  );
}

/** Reminders whose time has passed and that are still open. */
export function dueReminders(now = Date.now()): StandaloneReminder[] {
  return listReminders().filter((item) => !item.done && item.dueAt !== null && Date.parse(item.dueAt) <= now);
}

/* ------------------------------------------------------------ conversation */

export function listMessages(): StandaloneMessage[] {
  const items = readJson<StandaloneMessage[]>(KEYS.messages, []);
  return Array.isArray(items) ? items.filter((item) => item && typeof item.text === "string") : [];
}

export function appendMessage(message: Omit<StandaloneMessage, "id" | "at">): StandaloneMessage {
  const record: StandaloneMessage = { ...message, id: newId("msg"), at: new Date().toISOString() };
  writeJson(KEYS.messages, [...listMessages(), record].slice(-MESSAGE_LIMIT));
  return record;
}

export function clearMessages(): void {
  writeJson(KEYS.messages, []);
}

/* ---------------------------------------------------------------- settings */

export function loadSettings(): StandaloneSettings {
  const stored = readJson<Partial<StandaloneSettings>>(KEYS.settings, {});
  return {
    persona: { ...DEFAULT_PERSONA, ...(stored.persona ?? {}) },
    reality: { ...DEFAULT_REALITY, ...(stored.reality ?? {}) },
    model: typeof stored.model === "string" && stored.model ? stored.model : DEFAULT_MODEL,
    speakReplies: stored.speakReplies !== false,
  };
}

export function saveSettings(patch: Partial<StandaloneSettings>): StandaloneSettings {
  const next: StandaloneSettings = { ...loadSettings(), ...patch };
  writeJson(KEYS.settings, next);
  return next;
}
