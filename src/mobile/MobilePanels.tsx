/**
 * Bottom-sheet panels for the mobile shell.
 *
 * Everything here talks to the existing backend endpoints — memory
 * (/api/memories), missions (/api/tasks, /api/confirmations, /events) and
 * diagnostics (/api/health, /api/agent-health). Features that only work on the
 * desktop are labelled as such instead of being faked.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  Activity, Brain, Check, ChevronLeft, CircleAlert, Cpu, History, Loader2, Plus, RefreshCw,
  Settings as SettingsIcon, ShieldQuestion, Trash2, TriangleAlert, Wifi, WifiOff, X, Smartphone,
} from "lucide-react";
import { api, type ConfirmationRequest, type TaskView } from "../lib/appApi";
import type { AppEventsState } from "../lib/useAppEvents";
import { listConversation, subscribeConversation, clearConversation, type ConversationEntry } from "../lib/conversationLog";
import { getServerConfig, isNativeApp, saraFetch, saraJson } from "../lib/serverConfig";
import type { Memory, MemoryCategory } from "../lib/memoryTypes";
import { ServerConnectionPanel } from "../components/ServerConnectionPanel";
import type { MobilePrefs } from "./mobilePrefs";

export type MobileSheet =
  | "history" | "missions" | "memory" | "device" | "settings" | "help"
  | "briefing" | "automations" | "vision" | "persona" | "stop" | "selfcheck"
  | null;

const TASK_LABEL: Record<TaskView["state"], string> = {
  queued: "Queued",
  planning: "Planning",
  running: "Working",
  paused: "Paused",
  waiting_user: "Needs your answer",
  waiting_confirmation: "Needs your approval",
  user_takeover: "You have control",
  recovering: "Recovering",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  interrupted: "Interrupted",
};

export function Sheet({
  title,
  subtitle,
  onClose,
  children,
  actions,
}: {
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
        className="sara-sheet mx-auto flex max-h-[88dvh] w-full max-w-xl flex-col rounded-t-3xl border border-white/10 bg-[#080a12]/95 shadow-[0_-20px_60px_rgba(0,0,0,0.7)]"
      >
        <div className="flex items-start gap-3 border-b border-white/5 px-5 pb-3 pt-3">
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="mt-1 rounded-lg p-1.5 text-white/50 transition hover:bg-white/5 hover:text-white"
          >
            <ChevronLeft size={18} />
          </button>
          <div className="flex-1">
            <h2 className="font-display text-base font-semibold tracking-wide text-white">{title}</h2>
            {subtitle && <p className="mt-0.5 text-[11px] leading-relaxed text-white/40">{subtitle}</p>}
          </div>
          {actions}
        </div>
        <div className="sara-sheet-body flex-1 overflow-y-auto overscroll-contain px-5 py-4">{children}</div>
      </div>
    </div>
  );
}

function Empty({ icon: Icon, text }: { icon: typeof Brain; text: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-12 text-center">
      <Icon size={22} className="text-white/25" />
      <p className="max-w-xs text-xs leading-relaxed text-white/40">{text}</p>
    </div>
  );
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-white/5 py-2.5 last:border-0">
      <span className="text-[11px] uppercase tracking-wider text-white/35">{label}</span>
      <span className="max-w-[60%] break-words text-right text-xs text-white/75">{value}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ history */

export function HistoryPanel({ onClose }: { onClose: () => void }) {
  const [entries, setEntries] = useState<ConversationEntry[]>(() => listConversation());
  useEffect(() => subscribeConversation(setEntries), []);

  return (
    <Sheet
      title="Conversation"
      subtitle="Kept on this device. Sara's long-term memory lives on her server."
      onClose={onClose}
      actions={
        entries.length > 0 ? (
          <button
            type="button"
            onClick={() => clearConversation()}
            className="mt-0.5 rounded-lg border border-white/10 px-2.5 py-1.5 text-[10px] uppercase tracking-wider text-white/45 transition hover:text-rose-300"
          >
            Clear
          </button>
        ) : undefined
      }
    >
      {entries.length === 0 ? (
        <Empty icon={History} text="No conversation on this device yet. Tap the microphone or type a message to start." />
      ) : (
        <ul className="space-y-3">
          {entries
            .slice()
            .reverse()
            .map((entry) => (
              <li key={entry.id} className={entry.role === "user" ? "flex justify-end" : "flex justify-start"}>
                <div
                  className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-[13px] leading-relaxed ${
                    entry.role === "user"
                      ? "bg-indigo-500/15 text-indigo-100 ring-1 ring-indigo-400/20"
                      : "bg-white/[0.04] text-white/80 ring-1 ring-white/10"
                  }`}
                >
                  <div className="mb-1 font-mono text-[9px] uppercase tracking-widest text-white/30">
                    {entry.role === "user" ? "You" : "Sara"} ·{" "}
                    {new Date(entry.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </div>
                  {entry.text}
                </div>
              </li>
            ))}
        </ul>
      )}
    </Sheet>
  );
}

/* ----------------------------------------------------------------- missions */

export function MissionsPanel({
  events,
  onClose,
  onOpenDevice,
}: {
  events: AppEventsState;
  onClose: () => void;
  onOpenDevice: () => void;
}) {
  const tasks = Object.values(events.tasks).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Sheet
      title="Missions"
      subtitle="Tasks Sara is running on the computer, with approvals."
      onClose={onClose}
      actions={
        <span className={`mt-1 inline-flex items-center gap-1.5 text-[10px] uppercase tracking-wider ${events.connected ? "text-emerald-300/80" : "text-amber-300/80"}`}>
          {events.connected ? <Wifi size={12} /> : <WifiOff size={12} />}
          {events.connected ? "live" : "offline"}
        </span>
      }
    >
      {error && (
        <p className="mb-3 flex items-start gap-2 rounded-xl bg-rose-500/10 px-3 py-2 text-[11px] text-rose-200 ring-1 ring-rose-500/20">
          <TriangleAlert size={13} className="mt-0.5 shrink-0" /> {error}
        </p>
      )}

      {events.confirmations.length > 0 && (
        <div className="mb-4 space-y-2">
          <h3 className="font-mono text-[10px] uppercase tracking-widest text-amber-300/80">Waiting for you</h3>
          {events.confirmations.map((request: ConfirmationRequest) => (
            <div key={request.id} className="rounded-2xl border border-amber-400/25 bg-amber-500/5 p-3.5">
              <div className="text-xs font-medium text-amber-100">{request.title}</div>
              <p className="mt-1 text-[11px] leading-relaxed text-white/55">{request.description}</p>
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  disabled={busy === request.id}
                  onClick={() => void run(request.id, () => api.resolveConfirmation(request.id, true))}
                  className="flex-1 rounded-lg bg-emerald-500/15 px-3 py-2 text-[11px] font-semibold text-emerald-200 ring-1 ring-emerald-400/25 disabled:opacity-40"
                >
                  Approve
                </button>
                <button
                  type="button"
                  disabled={busy === request.id}
                  onClick={() => void run(request.id, () => api.resolveConfirmation(request.id, false))}
                  className="flex-1 rounded-lg bg-white/5 px-3 py-2 text-[11px] font-semibold text-white/60 ring-1 ring-white/10 disabled:opacity-40"
                >
                  Deny
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {tasks.length === 0 ? (
        <Empty icon={Activity} text="No missions yet. Ask Sara to do something on your PC, or start one from the microphone." />
      ) : (
        <ul className="space-y-3">
          {tasks.map((task) => {
            const terminal = ["completed", "failed", "cancelled", "interrupted"].includes(task.state);
            return (
              <li key={task.id} className="rounded-2xl border border-white/10 bg-white/[0.03] p-3.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-[13px] font-medium text-white">{task.goal}</div>
                    <div className="mt-0.5 font-mono text-[9px] uppercase tracking-widest text-white/35">
                      {TASK_LABEL[task.state]} · {new Date(task.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </div>
                  </div>
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-[9px] uppercase tracking-wider ${
                      task.state === "failed"
                        ? "bg-rose-500/15 text-rose-200"
                        : terminal
                          ? "bg-white/5 text-white/45"
                          : "bg-emerald-500/15 text-emerald-200"
                    }`}
                  >
                    {TASK_LABEL[task.state]}
                  </span>
                </div>
                {task.currentStatus && <p className="mt-2 text-[11px] leading-relaxed text-white/50">{task.currentStatus}</p>}
                {task.result && <p className="mt-2 text-[11px] leading-relaxed text-white/70">{task.result}</p>}
                {task.error && <p className="mt-2 text-[11px] leading-relaxed text-rose-300">{task.error}</p>}

                {task.pendingQuestion && (
                  <p className="mt-2 rounded-lg bg-indigo-500/10 px-2.5 py-2 text-[11px] text-indigo-100">
                    Sara asks: {task.pendingQuestion.text}
                  </p>
                )}

                {!terminal && (
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {task.state === "paused" ? (
                      <TaskButton onClick={() => void run(task.id, () => api.taskAction(task.id, "resume"))} disabled={busy === task.id} label="Resume" />
                    ) : (
                      <TaskButton onClick={() => void run(task.id, () => api.taskAction(task.id, "pause"))} disabled={busy === task.id} label="Pause" />
                    )}
                    <TaskButton onClick={() => void run(task.id, () => api.taskAction(task.id, "stop"))} disabled={busy === task.id} label="Stop" danger />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <button
        type="button"
        onClick={onOpenDevice}
        className="mt-4 w-full rounded-xl border border-white/10 px-3 py-2.5 text-[11px] text-white/45 transition hover:text-white"
      >
        PC actions need the computer running Sara — check the connection
      </button>
    </Sheet>
  );
}

function TaskButton({ label, onClick, disabled, danger }: { label: string; onClick: () => void; disabled?: boolean; danger?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-lg px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider ring-1 transition disabled:opacity-40 ${
        danger ? "bg-rose-500/10 text-rose-200 ring-rose-400/20" : "bg-white/5 text-white/60 ring-white/10"
      }`}
    >
      {label}
    </button>
  );
}

/* ------------------------------------------------------------------- memory */

const CATEGORY_TINT: Record<MemoryCategory, string> = {
  identity: "text-amber-300 bg-amber-500/10",
  preference: "text-pink-300 bg-pink-500/10",
  goal: "text-emerald-300 bg-emerald-500/10",
  project: "text-sky-300 bg-sky-500/10",
  relationship: "text-violet-300 bg-violet-500/10",
  emotional: "text-rose-300 bg-rose-500/10",
  behavior: "text-cyan-300 bg-cyan-500/10",
};

export function MemoryPanel({ onClose }: { onClose: () => void }) {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [category, setCategory] = useState<MemoryCategory>("preference");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await saraFetch("/api/memories");
      if (!response.ok) throw new Error(`Server returned ${response.status}.`);
      const data = (await response.json()) as Memory[];
      setMemories(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const add = async () => {
    if (!text.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await saraJson<Memory>("/api/memories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category, text: text.trim() }),
      });
      setMemories((current) => [...current, saved]);
      setText("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    try {
      const response = await saraFetch(`/api/memories/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!response.ok) throw new Error(`Server returned ${response.status}.`);
      setMemories((current) => current.filter((item) => item.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Sheet
      title="Memory"
      subtitle="Sara's shared long-term memory, stored on her server."
      onClose={onClose}
      actions={
        <button type="button" onClick={() => void load()} aria-label="Refresh memories" className="mt-0.5 rounded-lg p-1.5 text-white/40 hover:text-white">
          <RefreshCw size={15} />
        </button>
      }
    >
      {error && (
        <p className="mb-3 flex items-start gap-2 rounded-xl bg-rose-500/10 px-3 py-2 text-[11px] text-rose-200 ring-1 ring-rose-500/20">
          <CircleAlert size={13} className="mt-0.5 shrink-0" /> {error}
        </p>
      )}

      <div className="mb-4 rounded-2xl border border-white/10 bg-white/[0.03] p-3">
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={2}
          placeholder="Teach Sara something…"
          aria-label="New memory"
          className="w-full resize-none rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-xs text-white outline-none placeholder:text-white/25 focus:border-indigo-400/50"
        />
        <div className="mt-2 flex items-center gap-2">
          <select
            value={category}
            onChange={(event) => setCategory(event.target.value as MemoryCategory)}
            aria-label="Memory category"
            className="flex-1 rounded-lg border border-white/10 bg-black/30 px-2 py-1.5 text-[11px] text-white/70 outline-none"
          >
            {(Object.keys(CATEGORY_TINT) as MemoryCategory[]).map((key) => (
              <option key={key} value={key}>
                {key}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void add()}
            disabled={saving || !text.trim()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-500/20 px-3 py-1.5 text-[11px] font-medium text-indigo-100 ring-1 ring-indigo-400/25 disabled:opacity-40"
          >
            {saving ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />} Remember
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-10 text-xs text-white/40">
          <Loader2 size={14} className="animate-spin" /> Loading memories…
        </div>
      ) : memories.length === 0 ? (
        <Empty icon={Brain} text="Sara has not saved any memories yet. They build up as you talk." />
      ) : (
        <ul className="space-y-2">
          {memories
            .slice()
            .reverse()
            .map((memory) => (
              <li key={memory.id} className="group flex items-start gap-2 rounded-xl border border-white/5 bg-white/[0.02] p-2.5">
                <span className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-wider ${CATEGORY_TINT[memory.category] ?? "text-white/40 bg-white/5"}`}>
                  {memory.category}
                </span>
                <p className="flex-1 text-[12px] leading-relaxed text-white/70">{memory.text}</p>
                <button
                  type="button"
                  onClick={() => void remove(memory.id)}
                  aria-label="Delete memory"
                  className="shrink-0 rounded p-1 text-white/20 transition hover:text-rose-300"
                >
                  <Trash2 size={13} />
                </button>
              </li>
            ))}
        </ul>
      )}
    </Sheet>
  );
}

/* ----------------------------------------------------------------- settings */

export function SettingsPanel({
  prefs,
  onChange,
  onClose,
}: {
  prefs: MobilePrefs;
  onChange: (patch: Partial<MobilePrefs>) => void;
  onClose: () => void;
}) {
  return (
    <Sheet title="Settings" subtitle="This device. Sara's own settings stay on her server." onClose={onClose}>
      <div className="space-y-2">
        <Toggle label="Reduced motion" hint="Freeze ambient particles and idle animation." value={prefs.reducedMotion} onChange={(value) => onChange({ reducedMotion: value })} />
        <Toggle label="Show avatar" hint="Turn off to save battery and memory on low-end phones." value={prefs.avatarEnabled} onChange={(value) => onChange({ avatarEnabled: value })} />
        <Toggle label="Auto-start voice" hint="Open the microphone as soon as the mic is tapped." value={prefs.autoStartVoice} onChange={(value) => onChange({ autoStartVoice: value })} />
        <Toggle
          label="Wake phrase in browser"
          hint="Uses the browser speech engine. Not available in every Android browser."
          value={prefs.wakeWord}
          onChange={(value) => onChange({ wakeWord: value })}
        />
      </div>

      <h3 className="mb-2 mt-6 font-mono text-[10px] uppercase tracking-widest text-white/35">Conversation log</h3>
      <button
        type="button"
        onClick={() => clearConversation()}
        className="w-full rounded-xl border border-white/10 px-3 py-2.5 text-left text-xs text-white/60 transition hover:border-rose-400/30 hover:text-rose-200"
      >
        Clear this device's conversation history
      </button>

      <h3 className="mb-2 mt-6 font-mono text-[10px] uppercase tracking-widest text-white/35">Connection</h3>
      <ServerConnectionPanel embedded onConnected={onClose} />
    </Sheet>
  );
}

function Toggle({ label, hint, value, onChange }: { label: string; hint: string; value: boolean; onChange: (value: boolean) => void }) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-xl border border-white/5 bg-white/[0.02] px-3 py-2.5">
      <div className="min-w-0">
        <div className="text-xs font-medium text-white/80">{label}</div>
        <p className="mt-0.5 text-[10px] leading-relaxed text-white/35">{hint}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={value}
        aria-label={label}
        onClick={() => onChange(!value)}
        className={`mt-0.5 h-5 w-9 shrink-0 rounded-full p-0.5 transition-colors ${value ? "bg-cyan-500" : "bg-white/10"}`}
      >
        <span className={`block h-4 w-4 rounded-full bg-white shadow transition-transform ${value ? "translate-x-4" : ""}`} />
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------- device */

interface HealthInfo {
  ok?: boolean;
  version?: string;
  remoteAccess?: boolean;
  capabilities?: { remoteDesktopControl?: boolean };
}

export function DevicePanel({ onClose }: { onClose: () => void }) {
  const config = getServerConfig();
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [agent, setAgent] = useState<{ online: boolean; tool_count?: number } | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    setHealthError(null);
    try {
      setHealth(await saraJson<HealthInfo>("/api/health", { timeoutMs: 8_000 }));
    } catch (err) {
      setHealth(null);
      setHealthError(err instanceof Error ? err.message : String(err));
    }
    try {
      setAgent(await saraJson<{ online: boolean; tool_count?: number }>("/api/agent-health", { timeoutMs: 8_000 }));
    } catch {
      setAgent({ online: false });
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <Sheet
      title="Connection"
      subtitle="Sara's server, and the Windows PC that can act for her."
      onClose={onClose}
      actions={
        <button type="button" onClick={() => void refresh()} aria-label="Refresh" className="mt-0.5 rounded-lg p-1.5 text-white/40 hover:text-white">
          <RefreshCw size={15} />
        </button>
      }
    >
      {loading && (
        <div className="mb-3 flex items-center gap-2 text-xs text-white/40">
          <Loader2 size={13} className="animate-spin" /> Checking…
        </div>
      )}

      <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-3.5">
        <div className="flex items-center gap-2">
          <span className={`h-1.5 w-1.5 rounded-full ${health?.ok ? "bg-emerald-400" : "bg-rose-400"}`} />
          <span className="text-xs font-medium text-white/80">Sara server</span>
          <span className="ml-auto font-mono text-[10px] uppercase tracking-wider text-white/35">
            {health?.ok ? "online" : healthError ? "unreachable" : "checking"}
          </span>
        </div>
        <div className="mt-3">
          <Row label="Address" value={config.apiBase || (isNativeApp() ? "not set" : "same origin (local)")} />
          <Row label="Version" value={health?.version ?? "—"} />
          <Row label="Token" value={config.token ? "configured on this device" : "not used"} />
          <Row label="Remote mode" value={health?.remoteAccess ? "enabled" : "local only"} />
        </div>
        {healthError && <p className="mt-2 text-[11px] leading-relaxed text-rose-300">{healthError}</p>}
      </div>

      <div className="mt-3 rounded-2xl border border-white/10 bg-white/[0.03] p-3.5">
        <div className="flex items-center gap-2">
          <span className={`h-1.5 w-1.5 rounded-full ${agent?.online ? "bg-emerald-400" : "bg-amber-400"}`} />
          <span className="text-xs font-medium text-white/80">Windows desktop agent</span>
          <span className="ml-auto font-mono text-[10px] uppercase tracking-wider text-white/35">
            {agent === null ? "checking" : agent.online ? "online" : "offline"}
          </span>
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-white/40">
          {agent?.online
            ? `${agent.tool_count ?? "?"} PC tools are available to Sara on the computer.`
            : "The PC agent is not reachable from Sara's server. Start Sara on the computer, or check that the desktop agent is running."}
        </p>
        <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-amber-200/70">
          <ShieldQuestion size={12} className="mt-0.5 shrink-0" />
          {health?.capabilities?.remoteDesktopControl
            ? "This server allows remote devices to drive the PC. Risky actions still ask for approval."
            : "This server does not allow remote devices to drive the PC. You can talk to Sara and manage memory, but PC actions must be started on the computer."}
        </p>
      </div>

      <h3 className="mb-2 mt-6 font-mono text-[10px] uppercase tracking-widest text-white/35">Change server</h3>
      <ServerConnectionPanel embedded onConnected={() => void refresh()} />
    </Sheet>
  );
}

/* --------------------------------------------------------------------- help */

export function HelpPanel({ onClose, state, events }: { onClose: () => void; state: string; events: AppEventsState }) {
  const config = getServerConfig();
  const [copied, setCopied] = useState(false);
  const diagnostics = [
    `Sara ${typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev"}`,
    `UI: mobile shell`,
    `Platform: ${isNativeApp() ? "Android app" : "browser"}`,
    `Server: ${config.apiBase || window.location.origin}`,
    `Health: ${events.connected ? "events live" : "events offline"}`,
    `Voice state: ${state}`,
    `UA: ${navigator.userAgent}`,
  ].join("\n");

  return (
    <Sheet title="Help & diagnostics" subtitle="What works on this device, and what to do when it does not." onClose={onClose}>
      <div className="space-y-2.5">
        <HelpItem icon={Smartphone} title="Talking to Sara">
          Tap the microphone to open a voice session. Sara needs a tap first — browsers and Android never allow the
          microphone to start on its own. If the mic is blocked, type a message instead; her voice still plays.
        </HelpItem>
        <HelpItem icon={Cpu} title="PC control">
          Actions on your computer (apps, files, messages) require the Windows PC that runs Sara to be on and reachable.
          This phone never runs the desktop agent.
        </HelpItem>
        <HelpItem icon={TriangleAlert} title="Camera vision">
          Take a photo from <b>Look at this</b>. The picture is downscaled on the phone and sent to your Sara server,
          which needs a Gemini key. Without a key the request is refused instead of guessed. Continuous camera
          watching (Sara seeing on her own) still runs only in the desktop app.
        </HelpItem>
        <HelpItem icon={Wifi} title="Wake phrase">
          Optional and browser-dependent. Android may stop background speech recognition when the screen is off; the
          microphone button is always the reliable way to start.
        </HelpItem>
      </div>

      <h3 className="mb-2 mt-6 font-mono text-[10px] uppercase tracking-widest text-white/35">Diagnostics</h3>
      <pre className="max-h-40 overflow-auto rounded-xl border border-white/5 bg-black/30 p-3 text-[10px] leading-relaxed text-white/50">
        {diagnostics}
      </pre>
      <button
        type="button"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(diagnostics);
            setCopied(true);
            setTimeout(() => setCopied(false), 1800);
          } catch {
            setCopied(false);
          }
        }}
        className="mt-2 inline-flex items-center gap-1.5 text-[11px] text-white/40 underline transition hover:text-white"
      >
        {copied ? <Check size={12} /> : null}
        {copied ? "Copied" : "Copy diagnostics"}
      </button>

      <h3 className="mb-2 mt-6 font-mono text-[10px] uppercase tracking-widest text-white/35">Legend</h3>
      <ul className="space-y-1 text-[11px] text-white/45">
        <li><span className="text-cyan-300">Listening</span> — the microphone is open</li>
        <li><span className="text-violet-300">Speaking</span> — Sara's voice is playing</li>
        <li><span className="text-amber-300">Thinking</span> — she received your message</li>
        <li><span className="text-white/30">Idle</span> — no live session</li>
      </ul>
    </Sheet>
  );
}

function HelpItem({ icon: Icon, title, children }: { icon: typeof Wifi; title: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2.5 rounded-xl border border-white/5 bg-white/[0.02] p-3">
      <Icon size={14} className="mt-0.5 shrink-0 text-cyan-300/70" />
      <div>
        <div className="text-[11px] font-medium text-white/75">{title}</div>
        <p className="mt-0.5 text-[11px] leading-relaxed text-white/40">{children}</p>
      </div>
    </div>
  );
}

export const SHEET_TITLES: Record<Exclude<MobileSheet, null>, string> = {
  history: "Conversation",
  missions: "Missions",
  memory: "Memory",
  device: "Connection",
  settings: "Settings",
  help: "Help & diagnostics",
  briefing: "Today",
  automations: "Automations",
  vision: "Look at this",
  persona: "How she talks",
  stop: "Stop everything",
  selfcheck: "Self-check",
};

export const SHEET_ICONS = { history: History, missions: Activity, memory: Brain, device: Wifi, settings: SettingsIcon, help: ShieldQuestion, close: X };
