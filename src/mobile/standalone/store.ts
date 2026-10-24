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

export type AccentId = "cyan" | "violet" | "rose" | "emerald" | "amber";
export type FontScale = "s" | "m" | "l" | "xl";
export type BackdropId = "deep" | "ink" | "graphite";

export interface AppearanceSettings {
  accent: AccentId;
  fontScale: FontScale;
  backdrop: BackdropId;
  /** Show the time next to each message. */
  timestamps: boolean;
  /** Show the glowing emblem when no companion video is set. */
  emblem: boolean;
}

export interface SpeechSettings {
  /** Which engine to use: whatever the phone has, Android's, or the WebView's. */
  engine: "auto" | "native" | "web";
  voiceName: string;
  rate: number;
  pitch: number;
  volume: number;
  /** Answers longer than this are cut for speech (they stay complete on screen). */
  maxChars: number;
}

export interface StandaloneSettings {
  persona: PersonaSettings;
  reality: RealitySettings;
  model: string;
  /** Read replies aloud. */
  speakReplies: boolean;
  /** Stream answers as they arrive; off means one finished answer. */
  streaming: boolean;
  temperature: number;
  maxOutputTokens: number;
  /** Extra standing instructions, added to her system prompt verbatim. */
  customInstructions: string;
  /** What she calls you. */
  nickname: string;
  /** How many past turns are sent with each message. */
  historyTurns: number;
  appearance: AppearanceSettings;
  speech: SpeechSettings;
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

export const DEFAULT_APPEARANCE: AppearanceSettings = {
  accent: "cyan",
  fontScale: "m",
  backdrop: "deep",
  timestamps: false,
  emblem: true,
};

export const DEFAULT_SPEECH: SpeechSettings = {
  engine: "auto",
  voiceName: "",
  rate: 1,
  pitch: 1.1,
  volume: 1,
  maxChars: 900,
};

export const DEFAULT_SETTINGS: StandaloneSettings = {
  persona: DEFAULT_PERSONA,
  reality: DEFAULT_REALITY,
  model: DEFAULT_MODEL,
  speakReplies: true,
  streaming: true,
  temperature: 0.8,
  maxOutputTokens: 2048,
  customInstructions: "",
  nickname: "",
  historyTurns: 12,
  appearance: DEFAULT_APPEARANCE,
  speech: DEFAULT_SPEECH,
};

/** The colours the interface can be tinted with. Kept as hex so one value tints everything. */
export const ACCENTS: Record<AccentId, { label: string; hex: string; soft: string; deep: string }> = {
  cyan: { label: "Cyan", hex: "#22d3ee", soft: "rgba(34,211,238,0.16)", deep: "#0e7490" },
  violet: { label: "Violet", hex: "#a78bfa", soft: "rgba(167,139,250,0.16)", deep: "#6d28d9" },
  rose: { label: "Rose", hex: "#fb7185", soft: "rgba(251,113,133,0.16)", deep: "#be123c" },
  emerald: { label: "Emerald", hex: "#34d399", soft: "rgba(52,211,153,0.16)", deep: "#047857" },
  amber: { label: "Amber", hex: "#fbbf24", soft: "rgba(251,191,36,0.16)", deep: "#b45309" },
};

export const FONT_SCALES: Record<FontScale, { label: string; zoom: number }> = {
  s: { label: "Small", zoom: 0.92 },
  m: { label: "Normal", zoom: 1 },
  l: { label: "Large", zoom: 1.1 },
  xl: { label: "Largest", zoom: 1.2 },
};

export const BACKDROPS: Record<BackdropId, { label: string; base: string; glow: string }> = {
  deep: { label: "Midnight", base: "#03040a", glow: "rgba(79,70,229,0.20)" },
  ink: { label: "Ink", base: "#000000", glow: "rgba(56,189,248,0.12)" },
  graphite: { label: "Graphite", base: "#12141a", glow: "rgba(148,163,184,0.15)" },
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

/** Removes the newest message of that role — used when a send failed. */
export function removeLastMessage(role: "user" | "sara"): boolean {
  const items = listMessages();
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index].role === role) {
      items.splice(index, 1);
      writeJson(KEYS.messages, items);
      return true;
    }
  }
  return false;
}

export function clearMessages(): void {
  writeJson(KEYS.messages, []);
}

/* ---------------------------------------------------------------- settings */

function num(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/**
 * Reads the settings, filling in anything a previous version of the app did not
 * store. Nothing throws: a half-written value must never stop the app opening.
 */
export function loadSettings(): StandaloneSettings {
  const stored = readJson<Partial<StandaloneSettings> & { appearance?: Partial<AppearanceSettings>; speech?: Partial<SpeechSettings> }>(
    KEYS.settings,
    {},
  );
  return {
    persona: { ...DEFAULT_PERSONA, ...(stored.persona ?? {}) },
    reality: { ...DEFAULT_REALITY, ...(stored.reality ?? {}) },
    model: typeof stored.model === "string" && stored.model ? stored.model : DEFAULT_MODEL,
    speakReplies: stored.speakReplies !== false,
    streaming: stored.streaming !== false,
    temperature: num(stored.temperature, DEFAULT_SETTINGS.temperature, 0, 2),
    maxOutputTokens: num(stored.maxOutputTokens, DEFAULT_SETTINGS.maxOutputTokens, 128, 8192),
    customInstructions: typeof stored.customInstructions === "string" ? stored.customInstructions.slice(0, 2000) : "",
    nickname: typeof stored.nickname === "string" ? stored.nickname.slice(0, 40) : "",
    historyTurns: num(stored.historyTurns, DEFAULT_SETTINGS.historyTurns, 0, 40),
    appearance: {
      accent: pick(stored.appearance?.accent, ["cyan", "violet", "rose", "emerald", "amber"], DEFAULT_APPEARANCE.accent),
      fontScale: pick(stored.appearance?.fontScale, ["s", "m", "l", "xl"], DEFAULT_APPEARANCE.fontScale),
      backdrop: pick(stored.appearance?.backdrop, ["deep", "ink", "graphite"], DEFAULT_APPEARANCE.backdrop),
      timestamps: stored.appearance?.timestamps === true,
      emblem: stored.appearance?.emblem !== false,
    },
    speech: {
      engine: pick(stored.speech?.engine, ["auto", "native", "web"], DEFAULT_SPEECH.engine),
      voiceName: typeof stored.speech?.voiceName === "string" ? stored.speech.voiceName : "",
      rate: num(stored.speech?.rate, DEFAULT_SPEECH.rate, 0.5, 2),
      pitch: num(stored.speech?.pitch, DEFAULT_SPEECH.pitch, 0.5, 2),
      volume: num(stored.speech?.volume, DEFAULT_SPEECH.volume, 0, 1),
      maxChars: num(stored.speech?.maxChars, DEFAULT_SPEECH.maxChars, 120, 4000),
    },
  };
}

export function saveSettings(patch: Partial<StandaloneSettings>): StandaloneSettings {
  const current = loadSettings();
  const next: StandaloneSettings = {
    ...current,
    ...patch,
    appearance: { ...current.appearance, ...(patch.appearance ?? {}) },
    speech: { ...current.speech, ...(patch.speech ?? {}) },
    persona: { ...current.persona, ...(patch.persona ?? {}) },
    reality: { ...current.reality, ...(patch.reality ?? {}) },
  };
  writeJson(KEYS.settings, next);
  return next;
}

export function resetSettings(): StandaloneSettings {
  writeJson(KEYS.settings, DEFAULT_SETTINGS);
  return loadSettings();
}

/** Everything this app stored, as one object — for the user's own backup. */
export function exportData(): { settings: StandaloneSettings; messages: StandaloneMessage[]; memory: StandaloneMemory[]; reminders: StandaloneReminder[] } {
  return { settings: loadSettings(), messages: listMessages(), memory: listMemories(), reminders: listReminders() };
}

/** Wipes every key this app owns. The key itself is removed by the caller. */
export function clearAllData(): void {
  for (const key of Object.values(KEYS)) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      /* storage blocked: nothing to clear */
    }
  }
}
