/**
 * Sheets for the standalone app.
 *
 * Every panel reads the phone's own stores. Nothing here calls a Sara server —
 * there is none in this build — and nothing pretends a PC feature exists.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  CheckCircle2, CircleAlert, CircleDot, ExternalLink, Film, KeyRound, Loader2, Mic, Smartphone, Trash2, Volume2, VolumeX, X,
} from "lucide-react";
import type { MobilePrefs } from "../mobilePrefs";
import { formatBytes, prepareImage, type PreparedImage } from "../image";
import { PERSONA_PROFILES } from "../../../server_persona";
import type { PersonaProfileId } from "../../lib/appApi";
import { describeKey, forgetKey, maskKey, readKey, saveKey, type KeyInfo } from "./deviceKey";
import { listModels, probeConnection, type ProbeResult } from "./gemini";
import {
  ACCENTS, BACKDROPS, FONT_SCALES, clearAllData,
  addMemory, clearMemories, deleteMemory, deleteReminder, listMemories, listReminders, listMessages, clearMessages,
  loadSettings, saveSettings, setReminderDone, resetSettings, type StandaloneMessage, type StandaloneMemory,
  type StandaloneReminder, type StandaloneSettings,
} from "./store";
import { initSpeech, micAvailable, openSpeechSettings, speakTest, speechOutputAvailable } from "./voice";

/* --------------------------------------------------------------------- shell */

export function Sheet({ title, subtitle, onClose, children, actions }: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  actions?: ReactNode;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
        className="mx-auto flex max-h-[88dvh] w-full max-w-xl flex-col rounded-t-3xl border border-white/10 bg-[#080a12]/95 shadow-[0_-20px_60px_rgba(0,0,0,0.7)]"
      >
        <div className="flex items-start gap-3 border-b border-white/5 px-5 pb-3 pt-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-medium text-white/85">{title}</h2>
            {subtitle && <p className="mt-0.5 text-[10px] leading-relaxed text-white/35">{subtitle}</p>}
          </div>
          {actions}
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-lg p-1.5 text-white/40 hover:text-white">
            <X size={16} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
      </div>
    </div>
  );
}

function Card({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "warn" | "ok" }) {
  const styles =
    tone === "warn" ? "border-amber-400/20 bg-amber-500/[0.06]" : tone === "ok" ? "border-emerald-400/20 bg-emerald-500/[0.05]" : "border-white/8 bg-white/[0.02]";
  return <div className={`rounded-xl border px-3 py-2 ${styles}`}>{children}</div>;
}

function Row({ label, detail, children }: { label: string; detail?: string; children?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-xl border border-white/8 bg-white/[0.02] px-3 py-2.5">
      <div className="min-w-0">
        <p className="text-xs text-white/85">{label}</p>
        {detail && <p className="mt-0.5 text-[10px] leading-relaxed text-white/40">{detail}</p>}
      </div>
      {children}
    </div>
  );
}

function Toggle({ on, onChange, label }: { on: boolean; onChange: (next: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className={`relative h-5 w-9 shrink-0 rounded-full transition ${on ? "bg-cyan-400/70" : "bg-white/15"}`}
    >
      <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${on ? "left-[1.15rem]" : "left-0.5"}`} />
    </button>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <h3 className="mb-2 mt-5 font-mono text-[10px] uppercase tracking-[0.22em] text-white/35 first:mt-0">{children}</h3>;
}

/* ----------------------------------------------------------------------- key */

export function KeyPanel({ keyInfo, onChanged, onClose }: { keyInfo: KeyInfo; onChanged: () => void; onClose: () => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  return (
    <Sheet
      title="AI key"
      subtitle="Sara Mobile runs entirely on this phone. Google's AI needs a key, and there is no server here to keep it — so it lives on this device only."
      onClose={onClose}
    >
      <div className="space-y-3">
        {error && <Card tone="warn"><p className="text-[11px] leading-relaxed text-amber-100/85">{error}</p></Card>}
        {notice && <Card tone="ok"><p className="text-[11px] leading-relaxed text-emerald-100/85">{notice}</p></Card>}

        {keyInfo.present ? (
          <Card>
            <p className="text-[11px] text-white/70">A key is stored on this phone: <span className="font-mono text-white/90">{keyInfo.hint}</span></p>
          </Card>
        ) : (
          <Card tone="warn">
            <p className="text-[11px] leading-relaxed text-amber-100/85">No key yet. Sara can open the app, but every reply will fail until you add one.</p>
          </Card>
        )}

        <label className="block">
          <span className="mb-1.5 block text-[10px] uppercase tracking-wider text-white/40">{keyInfo.present ? "Replace with a new key" : "Paste your key"}</span>
          <input
            type="password"
            aria-label="Gemini API key"
            autoComplete="off"
            spellCheck={false}
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
              setError(null);
            }}
            placeholder="AIza…"
            className="w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2.5 font-mono text-xs text-white outline-none focus:border-cyan-400/50"
          />
        </label>

        <button
          type="button"
          disabled={!value.trim()}
          onClick={() => {
            const problem = saveKey(value);
            if (problem) {
              setError(problem);
              return;
            }
            setValue("");
            setNotice("Saved on this phone. Ask me something.");
            onChanged();
          }}
          className="w-full rounded-xl border border-cyan-300/30 bg-cyan-400/10 px-3 py-2.5 text-xs text-cyan-100 disabled:opacity-40"
        >
          Save key on this phone
        </button>

        <div className="flex items-center gap-2 text-[10px] text-white/35">
          <ExternalLink size={11} />
          <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer" className="underline">
            Get a free key in Google AI Studio
          </a>
        </div>

        {keyInfo.present && (
          <button
            type="button"
            onClick={() => {
              forgetKey();
              setNotice("Key removed from this phone.");
              onChanged();
            }}
            className="flex w-full items-center justify-center gap-2 rounded-xl border border-white/10 px-3 py-2 text-[11px] text-rose-200/80"
          >
            <Trash2 size={12} /> Forget the key
          </button>
        )}

        <p className="pb-1 text-[10px] leading-relaxed text-white/25">
          The key is stored in this app's own storage, in plain text, because the app has no vault to unlock. Anyone who can unlock your phone
          and open app data can read it. Nothing is sent anywhere except Google's API. Requests go directly from this phone to Google.
        </p>
      </div>
    </Sheet>
  );
}

/* -------------------------------------------------------------- conversation */

export function ConversationPanel({ messages, onClose, onClear }: {
  messages: StandaloneMessage[];
  onClose: () => void;
  onClear: () => void;
}) {
  return (
    <Sheet
      title="Conversation"
      subtitle="Stored on this phone. Nothing here is synced to a computer or a cloud account."
      onClose={onClose}
      actions={
        <button type="button" onClick={onClear} aria-label="Clear conversation" className="rounded-lg p-1.5 text-white/40 hover:text-rose-200">
          <Trash2 size={14} />
        </button>
      }
    >
      {messages.length === 0 ? (
        <p className="text-[11px] leading-relaxed text-white/35">Nothing yet. Ask her something below.</p>
      ) : (
        <div className="space-y-2">
          {messages.map((message) => (
            <div key={message.id} className={`rounded-xl border px-3 py-2 ${message.role === "sara" ? "border-cyan-300/15 bg-cyan-400/[0.04]" : "border-white/8 bg-white/[0.02]"}`}>
              <p className="mb-0.5 font-mono text-[9px] uppercase tracking-wider text-white/25">
                {message.role === "sara" ? "Sara" : "You"} · {new Date(message.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                {message.withImage ? " · photo" : ""}
                {message.spoken ? " · voice" : ""}
              </p>
              <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-white/80">{message.text}</p>
            </div>
          ))}
        </div>
      )}
    </Sheet>
  );
}

/* ------------------------------------------------------------------- memory */

export function MemoryPanelS({ memories, onChanged, onClose }: { memories: StandaloneMemory[]; onChanged: () => void; onClose: () => void }) {
  const [draft, setDraft] = useState("");
  return (
    <Sheet
      title="Memory"
      subtitle="Notes you asked Sara to keep. They are added to her context on this phone and nowhere else."
      onClose={onClose}
      actions={
        memories.length > 0 ? (
          <button
            type="button"
            aria-label="Clear all memories"
            onClick={() => {
              clearMemories();
              onChanged();
            }}
            className="rounded-lg p-1.5 text-white/40 hover:text-rose-200"
          >
            <Trash2 size={14} />
          </button>
        ) : undefined
      }
    >
      <div className="space-y-3">
        <div className="flex gap-2">
          <input
            value={draft}
            aria-label="New memory"
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Something to remember…"
            className="min-w-0 flex-1 rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-xs text-white outline-none focus:border-cyan-400/50"
          />
          <button
            type="button"
            disabled={!draft.trim()}
            onClick={() => {
              addMemory(draft);
              setDraft("");
              onChanged();
            }}
            className="rounded-xl border border-cyan-300/30 bg-cyan-400/10 px-3 py-2 text-[11px] text-cyan-100 disabled:opacity-40"
          >
            Save
          </button>
        </div>

        {memories.length === 0 ? (
          <p className="text-[11px] leading-relaxed text-white/35">Nothing stored yet. You can also type “remember that …” in the chat.</p>
        ) : (
          memories.map((memory) => (
            <div key={memory.id} className="flex items-start gap-2 rounded-xl border border-white/8 bg-white/[0.02] px-3 py-2">
              <p className="min-w-0 flex-1 text-[11px] leading-relaxed text-white/75">{memory.text}</p>
              <button
                type="button"
                aria-label={`Delete memory: ${memory.text}`}
                onClick={() => {
                  deleteMemory(memory.id);
                  onChanged();
                }}
                className="shrink-0 rounded p-1 text-white/30 hover:text-rose-200"
              >
                <X size={12} />
              </button>
            </div>
          ))
        )}
      </div>
    </Sheet>
  );
}

/* ---------------------------------------------------------------- reminders */

export function RemindersPanel({ reminders, onChanged, onClose }: {
  reminders: StandaloneReminder[];
  onChanged: () => void;
  onClose: () => void;
}) {
  return (
    <Sheet title="Reminders" subtitle="Saved on this phone. The app checks them while it is open — Android may delay one if the app is closed." onClose={onClose}>
      {reminders.length === 0 ? (
        <p className="text-[11px] leading-relaxed text-white/35">No reminders. Try “remind me to call the bank at 18:30”.</p>
      ) : (
        <div className="space-y-2">
          {reminders.map((reminder) => (
            <div key={reminder.id} className="flex items-start gap-2 rounded-xl border border-white/8 bg-white/[0.02] px-3 py-2">
              <button
                type="button"
                aria-label={reminder.done ? `Reopen: ${reminder.text}` : `Done: ${reminder.text}`}
                onClick={() => {
                  setReminderDone(reminder.id, !reminder.done);
                  onChanged();
                }}
                className="mt-0.5 shrink-0 text-white/40 hover:text-emerald-200"
              >
                {reminder.done ? <CheckCircle2 size={14} className="text-emerald-300/70" /> : <CircleDot size={14} />}
              </button>
              <div className="min-w-0 flex-1">
                <p className={`text-[11px] leading-relaxed ${reminder.done ? "text-white/35 line-through" : "text-white/80"}`}>{reminder.text}</p>
                <p className="mt-0.5 font-mono text-[9px] uppercase tracking-wider text-white/25">
                  {reminder.dueAt ? new Date(reminder.dueAt).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" }) : "no time set"}
                </p>
              </div>
              <button
                type="button"
                aria-label={`Delete reminder: ${reminder.text}`}
                onClick={() => {
                  deleteReminder(reminder.id);
                  onChanged();
                }}
                className="shrink-0 rounded p-1 text-white/30 hover:text-rose-200"
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
    </Sheet>
  );
}

/* ------------------------------------------------------------------ settings */

const MODELS: Array<[string, string]> = [
  ["gemini-3.5-flash", "Flash — balanced (default)"],
  ["gemini-3.5-flash-lite", "Flash Lite — fastest, cheapest"],
  ["gemini-3.8-flash", "Flash 3.8 — strongest Flash"],
  ["gemini-3.1-pro-preview", "Pro — slowest, deepest"],
];

function Slider({ label, value, min, max, step, format, onChange }: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format?: (value: number) => string;
  onChange: (next: number) => void;
}) {
  return (
    <div className="rounded-xl border border-white/8 bg-white/[0.02] px-3 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-white/85">{label}</p>
        <span className="shrink-0 font-mono text-[10px] text-white/45">{format ? format(value) : String(value)}</span>
      </div>
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="mt-2 w-full accent-cyan-300"
      />
    </div>
  );
}

function Choice({ active, label, detail, onClick }: { active: boolean; label: string; detail?: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex w-full items-start gap-2.5 rounded-xl border px-3 py-2 text-left ${
        active ? "border-cyan-300/40 bg-cyan-400/10" : "border-white/8 bg-white/[0.02]"
      }`}
    >
      {active ? <CheckCircle2 size={13} className="mt-0.5 shrink-0 text-cyan-200" /> : <CircleDot size={13} className="mt-0.5 shrink-0 text-white/25" />}
      <span>
        <span className="block text-[11px] text-white/85">{label}</span>
        {detail && <span className="mt-0.5 block text-[9px] leading-relaxed text-white/35">{detail}</span>}
      </span>
    </button>
  );
}

const PERSONA_TRAITS: Array<[keyof StandaloneSettings["persona"], string, number]> = [
  ["warmth", "Warmth", 0],
  ["humor", "Humour", 0],
  ["formality", "Formality", 0],
  ["directness", "Directness", 0],
  ["empathy", "Empathy", 0],
  ["energy", "Energy", 0],
  ["curiosity", "Curiosity", 0],
];

/**
 * "Customize" — every knob the phone app really has.
 *
 * Each control here is wired to something that changes behaviour or
 * appearance; there are no decorative options.
 */
export function SettingsPanelS({ settings, prefs, onChange, onChangePrefs, onOpenKey, onClose, onEraseEverything }: {
  settings: StandaloneSettings;
  prefs: MobilePrefs;
  onChange: (patch: Partial<StandaloneSettings>) => void;
  onChangePrefs: (patch: Partial<MobilePrefs>) => void;
  onOpenKey: () => void;
  onClose: () => void;
  onEraseEverything: () => void;
}) {
  const [discovered, setDiscovered] = useState<Array<{ id: string; label: string }>>([]);
  const [modelNote, setModelNote] = useState<string | null>(null);
  const [modelBusy, setModelBusy] = useState(false);
  const [speechNote, setSpeechNote] = useState<string | null>(null);
  const [voices, setVoices] = useState<string[]>([]);
  const [confirmErase, setConfirmErase] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void initSpeech().then((status) => {
      if (!cancelled) setVoices(status.voices);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function discoverModels() {
    const key = readKey();
    if (!key) {
      setModelNote("Add your AI key first — the list comes from Google.");
      return;
    }
    setModelBusy(true);
    setModelNote(null);
    const result = await listModels({ key });
    setModelBusy(false);
    if (!result.models.length) {
      setModelNote(
        result.status
          ? `Google answered HTTP ${result.status}: ${result.detail || "no detail"}.`
          : `The phone could not reach Google: ${result.detail || "no detail"}.`,
      );
      return;
    }
    setDiscovered(result.models.map((model) => ({ id: model.id, label: model.displayName })));
    const hasCurrent = result.models.some((model) => model.id === settings.model);
    setModelNote(
      hasCurrent
        ? `${result.models.length} models available. ${settings.model} is one of them.`
        : `${result.models.length} models available. ${settings.model} is not among them — pick one above.`,
    );
  }

  async function testVoice() {
    setSpeechNote("Speaking…");
    const spoke = await speakTest({
      rate: settings.speech.rate,
      pitch: settings.speech.pitch,
      volume: settings.speech.volume,
      voiceName: settings.speech.voiceName || undefined,
    });
    setSpeechNote(spoke ? "Played through the phone's speech engine." : "The phone has no speech engine. Open the speech settings below and install one.");
  }

  const modelOptions = useMemo(() => {
    const map = new Map<string, string>(MODELS.map(([id, label]) => [id, label]));
    for (const model of discovered) map.set(model.id, model.label);
    if (!map.has(settings.model)) map.set(settings.model, settings.model);
    return Array.from(map.entries());
  }, [discovered, settings.model]);

  return (
    <Sheet title="Customize" subtitle="Everything here is stored on this phone. Sara Mobile has her own settings, separate from the PC app." onClose={onClose}>
      <SectionTitle>Her brain</SectionTitle>
      <div className="space-y-2">
        <Row label="AI key" detail="Stored on this device only.">
          <button type="button" onClick={onOpenKey} className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-white/75">
            Manage
          </button>
        </Row>
        <Row label="Model">
          <select
            aria-label="Model"
            value={settings.model}
            onChange={(event) => onChange({ model: event.target.value })}
            className="max-w-[11rem] rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-[11px] text-white outline-none"
          >
            {modelOptions.map(([id, label]) => (
              <option key={id} value={id}>{label}</option>
            ))}
          </select>
        </Row>
        <button
          type="button"
          onClick={() => void discoverModels()}
          disabled={modelBusy}
          className="w-full rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-[11px] text-white/70 disabled:opacity-50"
        >
          {modelBusy ? "Asking Google…" : "Use only the models my key allows"}
        </button>
        {modelNote && <p className="px-1 text-[10px] leading-relaxed text-white/45">{modelNote}</p>}
        <Slider label="Creativity" value={settings.temperature} min={0} max={1.5} step={0.05} format={(value) => value.toFixed(2)} onChange={(temperature) => onChange({ temperature })} />
        <Slider label="Longest answer" value={settings.maxOutputTokens} min={256} max={8192} step={256} format={(value) => `${value} tokens`} onChange={(maxOutputTokens) => onChange({ maxOutputTokens })} />
        <Row label="Stream the answer as it is written" detail={settings.streaming ? "Words appear while she types." : "Off: one finished answer, easier on a slow connection."}>
          <Toggle label="Stream replies" on={settings.streaming} onChange={(streaming) => onChange({ streaming })} />
        </Row>
        <Slider label="Remembered turns sent" value={settings.historyTurns} min={0} max={40} step={2} format={(value) => `${value} turns`} onChange={(historyTurns) => onChange({ historyTurns })} />
      </div>

      <SectionTitle>Her voice</SectionTitle>
      <div className="space-y-2">
        <Row label="Read replies aloud" detail={speechOutputAvailable() ? "Uses the engine chosen below." : "No speech engine reported yet — check below."}>
          <Toggle label="Read replies aloud" on={settings.speakReplies} onChange={(speakReplies) => onChange({ speakReplies })} />
        </Row>
        <div className="space-y-2">
          <Choice active={settings.speech.engine === "auto"} label="Automatic" detail="Android's engine when it exists, otherwise the WebView's." onClick={() => onChange({ speech: { ...settings.speech, engine: "auto" } })} />
          <Choice active={settings.speech.engine === "native"} label="Android speech engine" detail="Uses Google Text-to-Speech or whichever engine the phone has." onClick={() => onChange({ speech: { ...settings.speech, engine: "native" } })} />
          <Choice active={settings.speech.engine === "web"} label="WebView speech" detail="The browser engine; often silent on Android." onClick={() => onChange({ speech: { ...settings.speech, engine: "web" } })} />
        </div>
        {voices.length > 0 && (
          <Row label="Voice">
            <select
              aria-label="Speech voice"
              value={settings.speech.voiceName}
              onChange={(event) => onChange({ speech: { ...settings.speech, voiceName: event.target.value } })}
              className="max-w-[11rem] rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-[11px] text-white outline-none"
            >
              <option value="">Phone default</option>
              {voices.map((voice) => (
                <option key={voice} value={voice}>{voice}</option>
              ))}
            </select>
          </Row>
        )}
        <Slider label="Speaking speed" value={settings.speech.rate} min={0.5} max={2} step={0.05} format={(value) => `${value.toFixed(2)}×`} onChange={(rate) => onChange({ speech: { ...settings.speech, rate } })} />
        <Slider label="Pitch" value={settings.speech.pitch} min={0.5} max={2} step={0.05} format={(value) => value.toFixed(2)} onChange={(pitch) => onChange({ speech: { ...settings.speech, pitch } })} />
        <Slider label="Volume" value={settings.speech.volume} min={0} max={1} step={0.05} format={(value) => `${Math.round(value * 100)}%`} onChange={(volume) => onChange({ speech: { ...settings.speech, volume } })} />
        <Slider label="Read at most" value={settings.speech.maxChars} min={120} max={4000} step={60} format={(value) => `${value} characters`} onChange={(maxChars) => onChange({ speech: { ...settings.speech, maxChars } })} />
        <div className="grid grid-cols-2 gap-2">
          <button type="button" onClick={() => void testVoice()} className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-[11px] text-white/75">
            Test the voice
          </button>
          <button
            type="button"
            onClick={() => void openSpeechSettings().then(setSpeechNote)}
            className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-[11px] text-white/75"
          >
            Android speech settings
          </button>
        </div>
        {speechNote && <p className="px-1 text-[10px] leading-relaxed text-white/45">{speechNote}</p>}
      </div>

      <SectionTitle>How she talks</SectionTitle>
      <div className="grid grid-cols-2 gap-2">
        {(Object.keys(PERSONA_PROFILES) as PersonaProfileId[]).map((id) => {
          const profile = PERSONA_PROFILES[id];
          const active = settings.persona.profile === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => onChange({ persona: { ...settings.persona, profile: id, ...profile.preset } })}
              className={`rounded-xl border px-3 py-2 text-left transition ${active ? "border-cyan-300/40 bg-cyan-400/10" : "border-white/8 bg-white/[0.02]"}`}
            >
              <span className="block text-[11px] text-white/85">{profile.label}</span>
              <span className="mt-0.5 block text-[9px] leading-relaxed text-white/35">{profile.description}</span>
            </button>
          );
        })}
      </div>
      <div className="mt-2 space-y-2">
        {PERSONA_TRAITS.map(([trait, label]) => (
          <div key={trait}>
            <Slider
              label={label}
              value={Number(settings.persona[trait] ?? 50)}
              min={0}
              max={100}
              step={2}
              format={(value) => `${value}%`}
              onChange={(value) => onChange({ persona: { ...settings.persona, [trait]: value } })}
            />
          </div>
        ))}
      </div>

      <SectionTitle>Reality mode</SectionTitle>
      <div className="space-y-2">
        {(([
          ["off", "Off", "Answers normally, no labels."],
          ["standard", "Standard", "Separates facts from guesses when it matters."],
          ["strict", "Strict", "Facts, assumptions, predictions, unknowns, confidence."],
        ] as Array<[StandaloneSettings["reality"]["mode"], string, string]>) ).map(([id, label, detail]) => (
          <div key={id}>
            <Choice active={settings.reality.mode === id} label={label} detail={detail} onClick={() => onChange({ reality: { ...settings.reality, mode: id } })} />
          </div>
        ))}
      </div>

      <SectionTitle>You</SectionTitle>
      <div className="space-y-2">
        <div className="rounded-xl border border-white/8 bg-white/[0.02] px-3 py-2.5">
          <p className="text-xs text-white/85">What she calls you</p>
          <input
            aria-label="Your name"
            value={settings.nickname}
            placeholder="Your name (optional)"
            onChange={(event) => onChange({ nickname: event.target.value })}
            className="mt-2 w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-[12px] text-white outline-none"
          />
        </div>
        <div className="rounded-xl border border-white/8 bg-white/[0.02] px-3 py-2.5">
          <p className="text-xs text-white/85">Your own instructions to her</p>
          <p className="mt-0.5 text-[10px] leading-relaxed text-white/40">Added to every conversation, word for word.</p>
          <textarea
            aria-label="Custom instructions"
            value={settings.customInstructions}
            rows={4}
            placeholder="For example: answer in Marathi, keep replies under three sentences, call me by my nickname…"
            onChange={(event) => onChange({ customInstructions: event.target.value })}
            className="mt-2 w-full resize-y rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-[12px] leading-relaxed text-white outline-none"
          />
        </div>
      </div>

      <SectionTitle>Look</SectionTitle>
      <div className="space-y-2">
        <div className="rounded-xl border border-white/8 bg-white/[0.02] px-3 py-2.5">
          <p className="text-xs text-white/85">Colour</p>
          <div className="mt-2 flex gap-2">
            {(Object.keys(ACCENTS) as Array<keyof typeof ACCENTS>).map((id) => (
              <button
                key={id}
                type="button"
                aria-label={`Colour ${ACCENTS[id].label}`}
                aria-pressed={settings.appearance.accent === id}
                onClick={() => onChange({ appearance: { ...settings.appearance, accent: id } })}
                style={{ backgroundColor: ACCENTS[id].hex }}
                className={`h-8 w-8 rounded-full border-2 ${settings.appearance.accent === id ? "border-white/80" : "border-transparent"}`}
              />
            ))}
          </div>
        </div>
        <div className="rounded-xl border border-white/8 bg-white/[0.02] px-3 py-2.5">
          <p className="text-xs text-white/85">Text size</p>
          <div className="mt-2 grid grid-cols-4 gap-2">
            {(Object.keys(FONT_SCALES) as Array<keyof typeof FONT_SCALES>).map((id) => (
              <button
                key={id}
                type="button"
                aria-pressed={settings.appearance.fontScale === id}
                onClick={() => onChange({ appearance: { ...settings.appearance, fontScale: id } })}
                className={`rounded-lg border px-2 py-1.5 text-[10px] ${
                  settings.appearance.fontScale === id ? "border-cyan-300/40 bg-cyan-400/10 text-white" : "border-white/10 text-white/60"
                }`}
              >
                {FONT_SCALES[id].label}
              </button>
            ))}
          </div>
        </div>
        <Row label="Background">
          <select
            aria-label="Background"
            value={settings.appearance.backdrop}
            onChange={(event) => onChange({ appearance: { ...settings.appearance, backdrop: event.target.value as StandaloneSettings["appearance"]["backdrop"] } })}
            className="rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-[11px] text-white outline-none"
          >
            {(Object.keys(BACKDROPS) as Array<keyof typeof BACKDROPS>).map((id) => (
              <option key={id} value={id}>{BACKDROPS[id].label}</option>
            ))}
          </select>
        </Row>
        <Row label="Show times next to messages">
          <Toggle label="Timestamps" on={settings.appearance.timestamps} onChange={(timestamps) => onChange({ appearance: { ...settings.appearance, timestamps } })} />
        </Row>
        <Row label="Show the glowing emblem" detail="Used when no companion video is set.">
          <Toggle label="Emblem" on={settings.appearance.emblem} onChange={(emblem) => onChange({ appearance: { ...settings.appearance, emblem } })} />
        </Row>
        <Row label="Reduced motion" detail="Freeze ambient animation and looping video.">
          <Toggle label="Reduced motion" on={prefs.reducedMotion} onChange={(next) => onChangePrefs({ reducedMotion: next })} />
        </Row>
        <Row label="Play the companion video's sound" detail="Off keeps her voice clear.">
          <Toggle label="Video sound" on={prefs.videoSound} onChange={(next) => onChangePrefs({ videoSound: next })} />
        </Row>
      </div>

      <SectionTitle>Your data</SectionTitle>
      <div className="space-y-2 pb-2">
        <button
          type="button"
          onClick={() => {
            clearMessages();
            onClose();
          }}
          className="w-full rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-[11px] text-white/70"
        >
          Clear the conversation
        </button>
        <button
          type="button"
          onClick={() => {
            clearMemories();
            onClose();
          }}
          className="w-full rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-[11px] text-white/70"
        >
          Forget everything she remembers
        </button>
        <button
          type="button"
          onClick={() => {
            resetSettings();
            onClose();
          }}
          className="w-full rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-[11px] text-white/70"
        >
          Reset these settings
        </button>
        <button
          type="button"
          onClick={() => {
            if (!confirmErase) {
              setConfirmErase(true);
              return;
            }
            onEraseEverything();
            onClose();
          }}
          className="w-full rounded-xl border border-rose-400/25 bg-rose-500/[0.08] px-3 py-2 text-[11px] text-rose-200/80"
        >
          {confirmErase ? "Tap again to erase the key, memory, reminders and conversation" : "Erase everything on this phone"}
        </button>
        <p className="px-1 text-[10px] leading-relaxed text-white/25">
          These settings live on this phone. The PC app has its own separate settings, memory and key — changing one never changes the other.
        </p>
      </div>
    </Sheet>
  );
}

/* ------------------------------------------------------------------ self check */

export function SelfCheckPanel({ keyInfo, settings, onOpenKey, onOpenSettings, onModelChange, onClose }: {
  keyInfo: KeyInfo;
  settings: StandaloneSettings;
  onOpenKey: () => void;
  onOpenSettings: () => void;
  onModelChange: (model: string) => void;
  onClose: () => void;
}) {
  const [storage, setStorage] = useState<"unknown" | "ok" | "blocked">("unknown");
  const [speech, setSpeech] = useState<Awaited<ReturnType<typeof initSpeech>> | null>(null);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [probeBusy, setProbeBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    try {
      const probeKey = "sara.mobile.probe";
      window.localStorage.setItem(probeKey, "1");
      window.localStorage.removeItem(probeKey);
      setStorage("ok");
    } catch {
      setStorage("blocked");
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void initSpeech().then((status) => {
      if (!cancelled) setSpeech(status);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const runProbe = useCallback(
    async (live: boolean) => {
      const key = readKey();
      if (!key) {
        setNote("Add your AI key first, then test again.");
        return;
      }
      setProbeBusy(true);
      setNote(null);
      try {
        setProbe(await probeConnection({ key, model: settings.model, live }));
      } catch (error) {
        setNote(error instanceof Error ? error.message : String(error));
      } finally {
        setProbeBusy(false);
      }
    },
    [settings.model],
  );

  useEffect(() => {
    void runProbe(false);
  }, [runProbe]);

  const deviceRows: Array<{ label: string; state: "ok" | "warn" | "no"; detail: string; action?: { label: string; run: () => void } }> = [
    {
      label: "AI key",
      state: keyInfo.present ? "ok" : "no",
      detail: keyInfo.present ? `Stored on this phone (${keyInfo.hint}).` : "No key yet — every reply will fail.",
      action: keyInfo.present ? undefined : { label: "Add", run: onOpenKey },
    },
    { label: "Model", state: "ok", detail: settings.model },
    {
      label: "Speech output",
      state: speech ? (speech.kind === "none" ? "no" : speech.kind === "web" ? "warn" : "ok") : "warn",
      detail: !speech
        ? "Checking the phone's speech engine…"
        : speech.kind === "native"
          ? `Android's engine is ready (${speech.engine}).`
          : speech.kind === "web"
            ? "Only the WebView's speech synthesis is available — it is often silent on Android. Install a Text-to-speech engine for a real voice."
            : speech.detail,
      action: speech && speech.kind !== "native" ? { label: "Fix", run: onOpenSettings } : undefined,
    },
    { label: "Microphone", state: micAvailable() ? "ok" : "no", detail: micAvailable() ? "Recording is available; permission is asked on first use." : "No recorder available in this webview." },
    { label: "Camera", state: navigator.mediaDevices ? "ok" : "warn", detail: navigator.mediaDevices ? "Photos are downscaled on the phone before sending." : "No camera API reported." },
    { label: "Local storage", state: storage === "blocked" ? "no" : storage === "ok" ? "ok" : "warn", detail: storage === "blocked" ? "Storage is blocked: memory, reminders and your key cannot persist." : "Memory, reminders and settings persist on this phone." },
    { label: "Computer control", state: "no", detail: "Not part of this app: no access to a PC, files or messaging apps." },
  ];

  const icons = (state: "ok" | "warn" | "no") =>
    state === "ok" ? <CheckCircle2 size={13} className="mt-0.5 shrink-0 text-emerald-300/80" /> : state === "warn" ? (
      <CircleAlert size={13} className="mt-0.5 shrink-0 text-amber-300/80" />
    ) : (
      <CircleAlert size={13} className="mt-0.5 shrink-0 text-rose-300/70" />
    );

  return (
    <Sheet title="Self-check" subtitle="What this phone checked just now — not what the app hopes is true." onClose={onClose}>
      <SectionTitle>This phone</SectionTitle>
      <div className="space-y-2">
        {deviceRows.map((row) => (
          <div key={row.label} className="flex items-start gap-2 rounded-xl border border-white/8 bg-white/[0.02] px-3 py-2">
            {icons(row.state)}
            <div className="min-w-0 flex-1">
              <p className="text-[11px] text-white/80">{row.label}</p>
              <p className="mt-0.5 text-[10px] leading-relaxed text-white/40">{row.detail}</p>
            </div>
            {row.action && (
              <button type="button" onClick={row.action.run} className="shrink-0 rounded-lg border border-white/10 px-2 py-1 text-[10px] text-white/70">
                {row.action.label}
              </button>
            )}
          </div>
        ))}
      </div>

      <SectionTitle>The connection to Google</SectionTitle>
      <div className="space-y-2">
        {probe?.steps?.map((step) => (
          <div key={step.id} className="flex items-start gap-2 rounded-xl border border-white/8 bg-white/[0.02] px-3 py-2">
            {icons(step.state)}
            <div className="min-w-0 flex-1">
              <p className="text-[11px] text-white/80">{step.label}</p>
              <p className="mt-0.5 break-words text-[10px] leading-relaxed text-white/40">{step.detail}</p>
            </div>
          </div>
        ))}
        {probeBusy && <p className="px-1 text-[10px] text-white/40">Checking…</p>}
        {!probe && !probeBusy && <p className="px-1 text-[10px] text-white/40">Add a key, then run the test.</p>}
        {note && <p className="px-1 text-[10px] text-rose-200/70">{note}</p>}
        {probe?.modelKnown === false && probe.models.length > 0 && (
          <button
            type="button"
            onClick={() => onModelChange(probe.models[0].id)}
            className="w-full rounded-xl border border-amber-400/25 bg-amber-500/[0.08] px-3 py-2 text-[11px] text-amber-100/85"
          >
            Use {probe.models[0].id} instead
          </button>
        )}
        <button
          type="button"
          disabled={probeBusy}
          onClick={() => void runProbe(true)}
          className="w-full rounded-xl border border-cyan-300/25 bg-cyan-400/10 px-3 py-2 text-[11px] text-cyan-100/85 disabled:opacity-50"
        >
          {probeBusy ? "Testing…" : "Test connection now (asks the model one question)"}
        </button>
        <p className="px-1 text-[10px] leading-relaxed text-white/25">
          This test uses your key exactly as a conversation would, so a failure here means a chat would fail the same way.
        </p>
      </div>
    </Sheet>
  );
}

/* ---------------------------------------------------------------------- limits */

export function LimitsPanel({ onClose }: { onClose: () => void }) {
  return (
    <Sheet title="What this app does" subtitle="Sara Mobile is a separate app. It runs on this phone and does not connect to your computer." onClose={onClose}>
      <div className="space-y-3">
        <Card tone="ok">
          <p className="mb-1 text-[11px] text-emerald-100/90">Works here, on this phone</p>
          <ul className="space-y-1 text-[11px] leading-relaxed text-emerald-50/75">
            <li>· Chat with streaming answers</li>
            <li>· Voice: record a note, get a spoken reply</li>
            <li>· Camera: show her one photo and ask about it</li>
            <li>· Memory and reminders stored on the device</li>
            <li>· Personality, reality mode, model and your own video companion</li>
          </ul>
        </Card>
        <Card>
          <p className="mb-1 text-[11px] text-white/80">Needs the computer app</p>
          <ul className="space-y-1 text-[11px] leading-relaxed text-white/50">
            <li>· Opening apps, moving files, mouse and keyboard</li>
            <li>· Seeing the PC screen, browser automation, desktop agent</li>
            <li>· WhatsApp / Telegram / Slack sending (provider setup)</li>
            <li>· Phone calls answered by Sara and meeting transcription</li>
            <li>· Long multi-step tasks, schedules and approvals</li>
          </ul>
        </Card>
        <p className="text-[10px] leading-relaxed text-white/30">
          Those are not hidden or faked here: this build has no server and no access to your PC. The desktop app keeps them.
        </p>
      </div>
    </Sheet>
  );
}

/* ----------------------------------------------------------------- companion */

export function CompanionSheet({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  return (
    <Sheet title="Companion look" subtitle="Your own clip can stand in for the 3D character. It stays on this phone." onClose={onClose}>
      {children}
    </Sheet>
  );
}

/* ------------------------------------------------------------------- vision */

export function VisionPanelS({ onAsk, onClose }: {
  onAsk: (image: PreparedImage, question: string) => Promise<string>;
  onClose: () => void;
}) {
  const cameraRef = useRef<HTMLInputElement | null>(null);
  const galleryRef = useRef<HTMLInputElement | null>(null);
  const [image, setImage] = useState<PreparedImage | null>(null);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onFile(file: File | undefined) {
    if (!file) return;
    setError(null);
    setAnswer(null);
    try {
      setImage(await prepareImage(file));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function ask() {
    if (!image) return;
    setBusy(true);
    setError(null);
    try {
      setAnswer(await onAsk(image, question));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet title="Look at this" subtitle="One photo, sent once from this phone to Google. Nothing is stored by this screen." onClose={onClose}>
      <div className="space-y-3">
        <input ref={cameraRef} type="file" accept="image/*" capture="environment" aria-label="Take a photo" className="hidden" onChange={(event) => void onFile(event.target.files?.[0])} />
        <input ref={galleryRef} type="file" accept="image/jpeg,image/png,image/webp" aria-label="Choose a photo" className="hidden" onChange={(event) => void onFile(event.target.files?.[0])} />

        <div className="grid grid-cols-2 gap-2">
          <button type="button" onClick={() => cameraRef.current?.click()} className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-[11px] text-white/70">
            Take a photo
          </button>
          <button type="button" onClick={() => galleryRef.current?.click()} className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-[11px] text-white/70">
            From gallery
          </button>
        </div>

        {image && (
          <div className="overflow-hidden rounded-2xl border border-white/10 bg-black/40">
            <img src={image.dataUrl} alt="Selected photo" className="max-h-56 w-full object-contain" />
            <p className="px-3 py-1 font-mono text-[9px] uppercase tracking-wider text-white/30">
              {image.width}×{image.height} · {formatBytes(image.bytes)}
            </p>
          </div>
        )}

        <input
          value={question}
          aria-label="Question about the photo"
          onChange={(event) => setQuestion(event.target.value)}
          placeholder="What is this?"
          className="w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-xs text-white outline-none focus:border-cyan-400/50"
        />

        <button type="button" onClick={() => void ask()} disabled={!image || busy} className="w-full rounded-xl border border-cyan-300/30 bg-cyan-400/10 px-3 py-2.5 text-xs text-cyan-100 disabled:opacity-40">
          {busy ? "Looking…" : "Ask Sara"}
        </button>

        {error && <Card tone="warn"><p className="text-[11px] leading-relaxed text-amber-100/85">{error}</p></Card>}
        {answer && <Card tone="ok"><p className="whitespace-pre-wrap text-[11px] leading-relaxed text-emerald-50/90">{answer}</p></Card>}
      </div>
    </Sheet>
  );
}

/* --------------------------------------------------------------------- video */

export function VideoPicker({ asset, busy, onUpload, onRemove, fit, onFit, sound, onSound, storageOk }: {
  asset: { name: string; poster: string | null } | null;
  busy: boolean;
  onUpload: (file: File) => Promise<void>;
  onRemove: () => Promise<void>;
  fit: "cover" | "contain";
  onFit: (next: "cover" | "contain") => void;
  sound: boolean;
  onSound: (next: boolean) => void;
  storageOk: boolean;
}) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="space-y-3">
      <input
        ref={fileRef}
        type="file"
        accept="video/*"
        aria-label="Choose companion video"
        className="hidden"
        onChange={async (event) => {
          const file = event.target.files?.[0];
          setError(null);
          if (!file) return;
          try {
            await onUpload(file);
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          }
        }}
      />

      {!storageOk && (
        <Card tone="warn"><p className="text-[11px] leading-relaxed text-amber-100/85">This webview cannot keep a video between launches, so a clip cannot be saved here.</p></Card>
      )}
      {error && <Card tone="warn"><p className="text-[11px] leading-relaxed text-amber-100/85">{error}</p></Card>}

      {asset ? (
        <div className="overflow-hidden rounded-2xl border border-white/10 bg-black/40">
          {asset.poster ? <img src={asset.poster} alt="First frame of your clip" className="max-h-52 w-full object-cover" /> : <div className="flex h-24 items-center justify-center text-white/25"><Film size={20} /></div>}
          <div className="flex items-center justify-between gap-2 px-3 py-2">
            <span className="truncate text-[10px] text-white/50">{asset.name}</span>
            <button type="button" aria-label="Remove companion video" onClick={() => void onRemove()} className="rounded p-1 text-white/40 hover:text-rose-200">
              <Trash2 size={13} />
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          disabled={busy || !storageOk}
          onClick={() => fileRef.current?.click()}
          className="flex w-full flex-col items-center gap-1.5 rounded-2xl border border-dashed border-white/15 px-4 py-7 text-white/55 disabled:opacity-40"
        >
          {busy ? <Loader2 size={16} className="animate-spin" /> : <Film size={16} />}
          <span className="text-[11px]">{busy ? "Reading the video…" : "Upload a video"}</span>
          <span className="text-[9px] text-white/30">MP4 / WebM / MOV · stays on this phone</span>
        </button>
      )}

      {asset && (
        <>
          <button type="button" onClick={() => fileRef.current?.click()} disabled={busy} className="w-full rounded-xl border border-white/10 px-3 py-2 text-[11px] text-white/65 disabled:opacity-40">
            Replace video
          </button>
          <div className="grid grid-cols-2 gap-2">
            {(["cover", "contain"] as const).map((id) => (
              <button
                key={id}
                type="button"
                onClick={() => onFit(id)}
                className={`rounded-xl border px-3 py-2 text-[10px] ${fit === id ? "border-cyan-300/40 bg-cyan-400/10 text-cyan-100" : "border-white/8 bg-white/[0.02] text-white/60"}`}
              >
                {id === "cover" ? "Fill the screen" : "Whole frame"}
              </button>
            ))}
          </div>
          <Row label="Video sound" detail="Off keeps her voice clear.">
            {sound ? <Volume2 size={14} className="text-white/60" /> : <VolumeX size={14} className="text-white/30" />}
            <Toggle label="Video sound" on={sound} onChange={onSound} />
          </Row>
        </>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- key banner */

export function KeyBanner({ onOpen }: { onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen} className="flex w-full items-center gap-2 rounded-xl border border-amber-400/25 bg-amber-500/[0.07] px-3 py-2 text-left">
      <KeyRound size={13} className="shrink-0 text-amber-300" />
      <span className="min-w-0 flex-1">
        <span className="block text-[11px] text-amber-100/90">Add your AI key to start</span>
        <span className="block text-[9px] text-amber-100/50">Stored on this phone only — no server in this app.</span>
      </span>
      <Smartphone size={13} className="shrink-0 text-amber-200/40" />
    </button>
  );
}

export function MicHint({ available }: { available: boolean }) {
  return (
    <p className="flex items-center justify-center gap-1.5 text-[9px] uppercase tracking-wider text-white/25">
      <Mic size={10} />
      {available ? "hold to talk" : "voice not available — type instead"}
    </p>
  );
}

export { maskKey, describeKey, listMessages, listMemories, listReminders, loadSettings, saveSettings, clearMessages };
