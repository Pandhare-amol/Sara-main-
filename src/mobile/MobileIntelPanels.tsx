/**
 * Mobile panels for the composed intelligence endpoints.
 *
 * Each panel is a thin view over one endpoint (`/api/mobile/*`) so the phone
 * never has to fan out to six requests to answer "what needs me today".
 * Everything that cannot be done from a phone is labelled, not hidden.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  Bell, Camera, CheckCircle2, CircleAlert, CircleDot, Clock, Loader2, OctagonX, RefreshCw,
  Send, ShieldCheck, Sparkles, TriangleAlert, XCircle,
} from "lucide-react";
import {
  api, type AppSettings, type CallRecordView, type CallSettingsView, type CapabilityCatalogue, type DiagnosticState,
  type InboundMessageView, type MobileAutomations, type MobileBriefing, type MobileDiagnostics, type OperationView,
  type PersonaSettings,
  type ProviderView, type RealitySettings, type SendOutcomeView,
} from "../lib/appApi";
import { getServerConfig } from "../lib/serverConfig";
import {
  bridgeAvailable, getCallBridgeStatus, readCallDevice, saveCallDevice, startCallBridge, stopCallBridge,
  type CallBridgeStatus,
} from "./callBridge";
import { formatBytes, prepareImage, type PreparedImage } from "./image";
import { Sheet } from "./MobilePanels";

/* ------------------------------------------------------------------ briefing */

function when(inMinutes: number): string {
  if (inMinutes <= 0) return "due now";
  if (inMinutes < 60) return `in ${inMinutes} min`;
  if (inMinutes < 60 * 24) return `in ${Math.round(inMinutes / 60)} h`;
  return `in ${Math.round(inMinutes / (60 * 24))} d`;
}

function Card({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "warn" | "ok" }) {
  const styles = tone === "warn"
    ? "border-amber-400/20 bg-amber-500/[0.06]"
    : tone === "ok"
      ? "border-emerald-400/20 bg-emerald-500/[0.05]"
      : "border-white/8 bg-white/[0.03]";
  return <div className={`rounded-2xl border px-3.5 py-3 ${styles}`}>{children}</div>;
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <h3 className="mt-5 mb-2 font-mono text-[10px] uppercase tracking-[0.22em] text-white/35 first:mt-0">{children}</h3>;
}

function Stat({ value, label }: { value: number | string; label: string }) {
  return (
    <div className="flex-1 rounded-xl border border-white/8 bg-white/[0.02] px-2 py-2 text-center">
      <div className="font-display text-lg leading-none text-white/85">{value}</div>
      <div className="mt-1 font-mono text-[9px] uppercase tracking-wider text-white/30">{label}</div>
    </div>
  );
}

function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 py-10 text-center">
      <CircleAlert size={20} className="text-rose-300/70" />
      <p className="max-w-xs text-xs leading-relaxed text-white/45">{message}</p>
      <button type="button" onClick={onRetry} className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-[11px] text-white/70">
        Try again
      </button>
    </div>
  );
}

export function BriefingPanel({ onClose, onOpenMissions }: { onClose: () => void; onOpenMissions: () => void }) {
  const [data, setData] = useState<MobileBriefing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.briefing());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Sheet
      title="Today"
      subtitle="Composed from your tasks, reminders, goals and memory — the same stores the desktop uses."
      onClose={onClose}
      actions={
        <button type="button" onClick={() => void load()} aria-label="Refresh briefing" className="mt-1 rounded-lg p-1.5 text-white/45 hover:text-white">
          <RefreshCw size={15} className={loading ? "animate-spin" : ""} />
        </button>
      }
    >
      {loading && !data && (
        <div className="flex justify-center py-12">
          <Loader2 size={18} className="animate-spin text-white/40" />
        </div>
      )}
      {error && !data && <LoadError message={error} onRetry={() => void load()} />}

      {data && (
        <div className="space-y-4">
          <div>
            <p className="text-sm leading-relaxed text-white/85">{data.greeting}</p>
            <p className="mt-1 font-mono text-[10px] uppercase tracking-wider text-white/25">
              {data.mode.persona} · {data.mode.context} · reality {data.mode.reality}
            </p>
          </div>

          <div className="flex gap-2">
            <Stat value={data.counts.activeTasks} label="working" />
            <Stat value={data.counts.needsYou} label="need you" />
            <Stat value={data.counts.remindersToday} label="today" />
            <Stat value={data.counts.openGoals} label="goals" />
          </div>

          {data.confirmations.length > 0 && (
            <>
              <SectionTitle>Waiting for your approval</SectionTitle>
              <div className="space-y-2">
                {data.confirmations.map((item) => (
                  <div key={item.id}>
                    <Card tone="warn">
                      <p className="text-xs font-medium text-amber-100">{item.title}</p>
                      <p className="mt-0.5 text-[11px] leading-relaxed text-amber-100/60">{item.description}</p>
                    </Card>
                  </div>
                ))}
              </div>
              <button type="button" onClick={onOpenMissions} className="w-full rounded-xl border border-white/10 bg-white/5 py-2 text-[11px] text-white/70">
                Review in missions
              </button>
            </>
          )}

          {data.nextReminders.length > 0 && (
            <>
              <SectionTitle>Coming up</SectionTitle>
              <div className="space-y-2">
                {data.nextReminders.map((item) => (
                  <div key={item.id} className="flex items-center gap-2.5 rounded-xl border border-white/8 bg-white/[0.02] px-3 py-2">
                    <Bell size={13} className="shrink-0 text-cyan-300/70" />
                    <span className="min-w-0 flex-1 truncate text-xs text-white/80">{item.label}</span>
                    <span className="shrink-0 font-mono text-[10px] text-white/35">{when(item.inMinutes)}</span>
                  </div>
                ))}
              </div>
            </>
          )}

          {data.activeTasks.length > 0 && (
            <>
              <SectionTitle>In progress</SectionTitle>
              <div className="space-y-2">
                {data.activeTasks.map((task) => (
                  <div key={task.id}>
                  <Card>
                    <div className="flex items-start gap-2">
                      {task.state === "waiting_user" ? (
                        <TriangleAlert size={13} className="mt-0.5 shrink-0 text-amber-300" />
                      ) : (
                        <CircleDot size={13} className="mt-0.5 shrink-0 animate-pulse text-cyan-300" />
                      )}
                      <div className="min-w-0">
                        <p className="text-xs leading-relaxed text-white/80">{task.goal}</p>
                        <p className="mt-0.5 font-mono text-[10px] uppercase tracking-wider text-white/30">{task.state.replace(/_/g, " ")}</p>
                        {task.waitingQuestion && <p className="mt-1 text-[11px] leading-relaxed text-amber-100/70">{task.waitingQuestion}</p>}
                      </div>
                    </div>
                  </Card>
                  </div>
                ))}
              </div>
            </>
          )}

          {data.goals.length > 0 && (
            <>
              <SectionTitle>Goals</SectionTitle>
              <div className="space-y-2">
                {data.goals.map((goal) => (
                  <div key={goal.id} className="rounded-xl border border-white/8 bg-white/[0.02] px-3 py-2">
                    <div className="flex items-center justify-between gap-3">
                      <span className="truncate text-xs text-white/80">{goal.title}</span>
                      <span className="shrink-0 font-mono text-[10px] text-white/35">{goal.progress === null ? "—" : `${goal.progress}%`}</span>
                    </div>
                    {goal.nextAction && <p className="mt-1 truncate text-[11px] text-white/35">Next: {goal.nextAction}</p>}
                  </div>
                ))}
              </div>
            </>
          )}

          {data.counts.memories > 0 && (
            <p className="pt-1 font-mono text-[10px] uppercase tracking-wider text-white/25">{data.counts.memories} memories in context</p>
          )}

          {data.notes.length > 0 && (
            <div className="rounded-xl border border-white/8 bg-white/[0.02] px-3 py-2">
              {data.notes.map((note) => (
                <p key={note} className="text-[11px] leading-relaxed text-white/40">
                  {note}
                </p>
              ))}
            </div>
          )}
          <p className="pb-1 font-mono text-[9px] uppercase tracking-wider text-white/20">sources: {data.sources.join(" · ")}</p>
        </div>
      )}
    </Sheet>
  );
}

/* --------------------------------------------------------------- diagnostics */

const STATE_ICON: Record<DiagnosticState, typeof CheckCircle2> = {
  ok: CheckCircle2,
  attention: CircleAlert,
  offline: XCircle,
  unknown: Clock,
};

const STATE_TONE: Record<DiagnosticState, string> = {
  ok: "text-emerald-300/80",
  attention: "text-amber-300/80",
  offline: "text-rose-300/80",
  unknown: "text-white/35",
};

export function DiagnosticsPanel({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<MobileDiagnostics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.diagnostics());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Sheet
      title="Self-check"
      subtitle="Live probes, not cached claims. Anything unproven is marked unknown."
      onClose={onClose}
      actions={
        <button type="button" onClick={() => void load()} aria-label="Re-run checks" className="mt-1 rounded-lg p-1.5 text-white/45 hover:text-white">
          <RefreshCw size={15} className={loading ? "animate-spin" : ""} />
        </button>
      }
    >
      {loading && !data && (
        <div className="flex justify-center py-12">
          <Loader2 size={18} className="animate-spin text-white/40" />
        </div>
      )}
      {error && !data && <LoadError message={error} onRetry={() => void load()} />}
      {data && (
        <div className="space-y-2">
          {data.items.map((item) => {
            const Icon = STATE_ICON[item.state] ?? Clock;
            return (
              <div key={item.id} className="rounded-xl border border-white/8 bg-white/[0.02] px-3 py-2.5">
                <div className="flex items-start gap-2.5">
                  <Icon size={14} className={`mt-0.5 shrink-0 ${STATE_TONE[item.state]}`} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-xs text-white/85">{item.label}</span>
                      <span className={`shrink-0 font-mono text-[9px] uppercase tracking-wider ${STATE_TONE[item.state]}`}>{item.state}</span>
                    </div>
                    <p className="mt-0.5 text-[11px] leading-relaxed text-white/40">{item.detail}</p>
                    {item.action && <p className="mt-1 text-[11px] leading-relaxed text-cyan-200/60">{item.action}</p>}
                  </div>
                </div>
              </div>
            );
          })}
          <SectionTitle>What this setup can do</SectionTitle>
          <CapabilityList />
        </div>
      )}
    </Sheet>
  );
}

/* --------------------------------------------------------------- automations */

export function AutomationsPanel({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<MobileAutomations | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.automations());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Sheet
      title="Automations"
      subtitle="Reminders Sara runs for you, plus recent activity from the audit log."
      onClose={onClose}
      actions={
        <button type="button" onClick={() => void load()} aria-label="Refresh automations" className="mt-1 rounded-lg p-1.5 text-white/45 hover:text-white">
          <RefreshCw size={15} className={loading ? "animate-spin" : ""} />
        </button>
      }
    >
      {loading && !data && (
        <div className="flex justify-center py-12">
          <Loader2 size={18} className="animate-spin text-white/40" />
        </div>
      )}
      {error && !data && <LoadError message={error} onRetry={() => void load()} />}
      {data && (
        <div className="space-y-3">
          <SectionTitle>Scheduled ({data.repeating} repeating)</SectionTitle>
          {data.scheduled.length === 0 ? (
            <p className="text-[11px] leading-relaxed text-white/35">Nothing scheduled yet. Ask Sara to remind you about something on the desktop, or in a chat message.</p>
          ) : (
            <div className="space-y-2">
              {data.scheduled.map((item) => (
                <div key={item.id} className="flex items-center gap-2.5 rounded-xl border border-white/8 bg-white/[0.02] px-3 py-2">
                  <Clock size={13} className="shrink-0 text-cyan-300/70" />
                  <span className="min-w-0 flex-1 truncate text-xs text-white/80">{item.label}</span>
                  <span className="shrink-0 font-mono text-[10px] text-white/35">{item.repeat}</span>
                </div>
              ))}
            </div>
          )}

          {data.skills.length > 0 && (
            <>
              <SectionTitle>Skills</SectionTitle>
              <div className="flex flex-wrap gap-1.5">
                {data.skills.map((skill) => (
                  <span key={skill.id} className="rounded-full border border-violet-400/20 bg-violet-500/[0.08] px-2.5 py-1 text-[11px] text-violet-100/80">
                    {skill.name}
                  </span>
                ))}
              </div>
            </>
          )}

          <SectionTitle>Recent activity</SectionTitle>
          {data.activity.length === 0 ? (
            <p className="text-[11px] text-white/35">No recorded actions yet.</p>
          ) : (
            <div className="space-y-1.5">
              {data.activity.map((entry, index) => (
                <div key={`${entry.at}-${index}`} className="flex items-start gap-2.5 border-b border-white/5 py-1.5 last:border-0">
                  <span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-white/25" />
                  <div className="min-w-0 flex-1">
                    <p className="text-[11px] leading-relaxed text-white/70">{entry.summary}</p>
                    <p className="font-mono text-[9px] uppercase tracking-wider text-white/25">
                      {entry.kind} · {new Date(entry.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}

          {data.notes.length > 0 && (
            <div className="rounded-xl border border-white/8 bg-white/[0.02] px-3 py-2">
              {data.notes.map((note) => (
                <p key={note} className="text-[11px] leading-relaxed text-white/40">
                  {note}
                </p>
              ))}
            </div>
          )}
        </div>
      )}
    </Sheet>
  );
}

/* -------------------------------------------------------------------- vision */

export function VisionPanel({ onClose }: { onClose: () => void }) {
  const [image, setImage] = useState<PreparedImage | null>(null);
  const [question, setQuestion] = useState("What am I looking at?");
  const [answer, setAnswer] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const cameraRef = useRef<HTMLInputElement | null>(null);
  const galleryRef = useRef<HTMLInputElement | null>(null);

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
    if (!image || busy) return;
    setBusy(true);
    setError(null);
    setAnswer(null);
    try {
      const result = await api.vision(image.dataBase64, image.mimeType, question.trim() || "What am I looking at?");
      setAnswer(result.answer);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet title="Look at this" subtitle="Photos are downscaled on the phone, sent to your Sara server, and analysed by the model you configured. Nothing is stored by this screen." onClose={onClose}>
      <div className="space-y-3">
        <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => void onFile(e.target.files?.[0])} />
        <input ref={galleryRef} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={(e) => void onFile(e.target.files?.[0])} />

        {image ? (
          <div className="overflow-hidden rounded-2xl border border-white/10">
            <img src={image.dataUrl} alt="Captured" className="max-h-64 w-full object-contain bg-black/40" />
            <div className="flex items-center justify-between px-3 py-1.5 font-mono text-[9px] uppercase tracking-wider text-white/30">
              <span>
                {image.width}×{image.height}
              </span>
              <span>{formatBytes(image.bytes)}</span>
            </div>
          </div>
        ) : (
          <div className="flex gap-2">
            <button type="button" onClick={() => cameraRef.current?.click()} className="flex flex-1 items-center justify-center gap-2 rounded-xl border border-cyan-400/20 bg-cyan-500/[0.08] py-3 text-xs text-cyan-100">
              <Camera size={15} /> Camera
            </button>
            <button type="button" onClick={() => galleryRef.current?.click()} className="flex-1 rounded-xl border border-white/10 bg-white/5 py-3 text-xs text-white/70">
              Photo library
            </button>
          </div>
        )}

        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          aria-label="Question about the image"
          placeholder="Ask about the image…"
          className="w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2.5 text-[13px] text-white outline-none placeholder:text-white/25"
        />

        <button
          type="button"
          disabled={!image || busy}
          onClick={() => void ask()}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-white/10 py-2.5 text-xs text-white/85 disabled:opacity-30"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
          {busy ? "Looking…" : "Ask Sara"}
        </button>

        {image && (
          <button type="button" onClick={() => { setImage(null); setAnswer(null); setError(null); }} className="w-full text-center text-[11px] text-white/35">
            Remove photo
          </button>
        )}

        {error && (
          <Card tone="warn">
            <p className="text-[11px] leading-relaxed text-amber-100/85">{error}</p>
          </Card>
        )}

        {answer && (
          <Card>
            <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-white/85">{answer}</p>
          </Card>
        )}

        <p className="pb-1 text-[10px] leading-relaxed text-white/25">
          Vision needs a Gemini key configured on the server. If none is set the request is refused rather than answered from guesswork.
        </p>
      </div>
    </Sheet>
  );
}

/* ------------------------------------------------------------------ persona */

const PROFILES: Array<[PersonaSettings["profile"], string]> = [
  ["companion", "Companion"],
  ["friend", "Friend"],
  ["mentor", "Mentor"],
  ["professional", "Professional"],
  ["executive", "Executive"],
  ["emergency", "Emergency"],
];

export function PersonaPanel({ onClose }: { onClose: () => void }) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setSettings(await api.appSettings());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(patch: Parameters<typeof api.updateAppSettings>[0]) {
    setSaving(true);
    setError(null);
    try {
      setSettings(await api.updateAppSettings(patch));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet title="How she talks" subtitle="Tone and honesty settings. These change her delivery — never her permissions." onClose={onClose}>
      {!settings && !error && (
        <div className="flex justify-center py-12">
          <Loader2 size={18} className="animate-spin text-white/40" />
        </div>
      )}
      {error && <Card tone="warn"><p className="text-[11px] leading-relaxed text-amber-100/85">{error}</p></Card>}
      {settings && (
        <div className="space-y-4">
          <div>
            <SectionTitle>Profile</SectionTitle>
            <div className="grid grid-cols-2 gap-2">
              {PROFILES.map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  disabled={saving}
                  onClick={() => void save({ persona: { profile: id } })}
                  className={`rounded-xl border px-3 py-2.5 text-left text-xs transition ${
                    settings.persona.profile === id
                      ? "border-cyan-300/40 bg-cyan-400/10 text-cyan-100"
                      : "border-white/8 bg-white/[0.02] text-white/60"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <SectionTitle>Reality mode</SectionTitle>
            <div className="space-y-2">
              {([
                ["off", "Off", "Answers normally, no labels."],
                ["standard", "Standard", "Separates facts from guesses when it matters."],
                ["strict", "Strict", "Facts, assumptions, predictions, unknowns, confidence."],
              ] as Array<[RealitySettings["mode"], string, string]>).map(([id, label, detail]) => (
                <button
                  key={id}
                  type="button"
                  disabled={saving}
                  onClick={() => void save({ reality: { mode: id } })}
                  className={`flex w-full items-start gap-2.5 rounded-xl border px-3 py-2.5 text-left transition ${
                    settings.reality.mode === id ? "border-cyan-300/40 bg-cyan-400/10" : "border-white/8 bg-white/[0.02]"
                  }`}
                >
                  {settings.reality.mode === id ? <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-cyan-200" /> : <CircleDot size={14} className="mt-0.5 shrink-0 text-white/25" />}
                  <div>
                    <p className={`text-xs ${settings.reality.mode === id ? "text-cyan-100" : "text-white/70"}`}>{label}</p>
                    <p className="mt-0.5 text-[11px] leading-relaxed text-white/35">{detail}</p>
                  </div>
                </button>
              ))}
            </div>
          </div>

          <button
            type="button"
            disabled={saving}
            onClick={() => void save({ reality: { challengeAssumptions: !settings.reality.challengeAssumptions } })}
            className="flex w-full items-center justify-between rounded-xl border border-white/8 bg-white/[0.02] px-3 py-2.5"
          >
            <span className="text-left">
              <span className="block text-xs text-white/80">Challenge my assumptions</span>
              <span className="mt-0.5 block text-[11px] leading-relaxed text-white/35">Correct a wrong premise before answering it.</span>
            </span>
            <span className={`h-5 w-9 shrink-0 rounded-full p-0.5 transition ${settings.reality.challengeAssumptions ? "bg-cyan-400/70" : "bg-white/10"}`}>
              <span className={`block h-4 w-4 rounded-full bg-white transition-transform ${settings.reality.challengeAssumptions ? "translate-x-4" : ""}`} />
            </span>
          </button>

          <p className="text-[10px] leading-relaxed text-white/25">
            Fine-grained tone sliders (warmth, humour, formality…) live in the desktop settings under Personality.
          </p>
        </div>
      )}
    </Sheet>
  );
}

/* --------------------------------------------------------------------- stop */

export function StopPanel({ onClose, onStopped }: { onClose: () => void; onStopped: (message: string) => void }) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function stop() {
    setBusy(true);
    setError(null);
    try {
      const result = await api.stopEverything();
      onStopped(`Stopped ${result.stoppedTasks} task${result.stoppedTasks === 1 ? "" : "s"} and cleared ${result.deniedConfirmations} pending approval${result.deniedConfirmations === 1 ? "" : "s"}.`);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet title="Stop everything" subtitle="Ends every running task on the PC and rejects any approval that is still waiting." onClose={onClose}>
      <div className="space-y-3">
        <Card tone="warn">
          <div className="flex items-start gap-2.5">
            <OctagonX size={16} className="mt-0.5 shrink-0 text-amber-300" />
            <p className="text-[11px] leading-relaxed text-amber-100/80">
              This cannot be undone mid-task. Finished steps stay in history; a task that is stopped has to be started again.
            </p>
          </div>
        </Card>

        {error && <Card tone="warn"><p className="text-[11px] leading-relaxed text-amber-100/85">{error}</p></Card>}

        {armed ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void stop()}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-rose-500/20 py-3 text-sm font-medium text-rose-100 ring-1 ring-rose-400/40 disabled:opacity-50"
          >
            {busy ? <Loader2 size={16} className="animate-spin" /> : <OctagonX size={16} />}
            {busy ? "Stopping…" : "Yes, stop everything"}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setArmed(true)}
            className="flex w-full items-center justify-center gap-2 rounded-xl border border-rose-400/30 bg-rose-500/10 py-3 text-sm text-rose-100"
          >
            <OctagonX size={16} /> Arm stop
          </button>
        )}

        <div className="flex items-center gap-1.5 pt-1 text-[10px] text-white/25">
          <ShieldCheck size={11} /> Uses the same emergency stop as the desktop shortcut.
        </div>
      </div>
    </Sheet>
  );
}

/* -------------------------------------------------------------------- calls */

const CALL_TONE: Record<string, string> = {
  RINGING: "text-amber-200/90",
  CONNECTED: "text-emerald-200/90",
  ACTIVE: "text-emerald-200/90",
  HELD: "text-cyan-200/80",
  ENDED: "text-white/40",
  MISSED: "text-rose-200/80",
  REJECTED: "text-rose-200/70",
  FAILED: "text-rose-200/80",
  UNKNOWN: "text-white/40",
};

function callerLabel(call: CallRecordView): string {
  return call.peer.name || call.peer.number || "Unknown number";
}

export function CallsPanel({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState<{ active: CallRecordView[]; recent: CallRecordView[] } | null>(null);
  const [policy, setPolicy] = useState<CallSettingsView | null>(null);
  const [tokenConfigured, setTokenConfigured] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [messageFor, setMessageFor] = useState<string | null>(null);
  const [messageText, setMessageText] = useState("");
  const [bridge, setBridge] = useState<CallBridgeStatus | null>(null);
  const [deviceToken, setDeviceToken] = useState(readCallDevice().token);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [list, settings] = await Promise.all([api.calls(), api.callPolicy()]);
      setState(list);
      setPolicy(settings.calls);
      setTokenConfigured(settings.deviceTokenConfigured);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const savePolicy = (patch: Partial<CallSettingsView>) =>
    void act(async () => {
      const next = await api.updateCallPolicy(patch);
      setPolicy(next.calls);
    });

  const all = [...(state?.active ?? []), ...(state?.recent ?? []).filter((call) => !state?.active.some((a) => a.id === call.id))];

  return (
    <Sheet title="Calls" subtitle="Sara only answers when your policy allows it. Unknown numbers are never answered automatically." onClose={onClose}>
      <div className="space-y-4">
        {error && <Card tone="warn"><p className="text-[11px] leading-relaxed text-amber-100/85">{error}</p></Card>}

        {(state?.active ?? []).length > 0 && (
          <div>
            <SectionTitle>Live</SectionTitle>
            <div className="space-y-2">
              {state!.active.map((call) => (
                <div key={call.id}>
                  <Card tone={call.state === "RINGING" ? "warn" : "ok"}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-xs font-medium text-white/90">{callerLabel(call)}</p>
                        <p className={`mt-0.5 font-mono text-[9px] uppercase tracking-wider ${CALL_TONE[call.state] ?? "text-white/40"}`}>
                          {call.state.toLowerCase()} · {call.peer.relationship}
                        </p>
                        {call.decision && <p className="mt-1 text-[11px] leading-relaxed text-white/45">{call.decision.reason}</p>}
                      </div>
                      <span className="shrink-0 font-mono text-[9px] text-white/25">{new Date(call.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                    </div>
                    <div className="mt-2 flex gap-2">
                      {call.state === "RINGING" ? (
                        <>
                          <button type="button" disabled={busy} onClick={() => void act(() => api.answerCall(call.id))}
                            className="flex-1 rounded-lg bg-emerald-500/20 py-1.5 text-[11px] text-emerald-100 ring-1 ring-emerald-400/30 disabled:opacity-40">
                            Answer
                          </button>
                          <button type="button" disabled={busy} onClick={() => void act(() => api.rejectCall(call.id))}
                            className="flex-1 rounded-lg bg-rose-500/15 py-1.5 text-[11px] text-rose-100 ring-1 ring-rose-400/30 disabled:opacity-40">
                            Decline
                          </button>
                        </>
                      ) : (
                        <button type="button" disabled={busy} onClick={() => void act(() => api.endCall(call.id))}
                          className="flex-1 rounded-lg bg-rose-500/15 py-1.5 text-[11px] text-rose-100 ring-1 ring-rose-400/30 disabled:opacity-40">
                          End call
                        </button>
                      )}
                      <button type="button" onClick={() => { setMessageFor(call.id); setMessageText(""); }}
                        className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-[11px] text-white/70">
                        Take message
                      </button>
                    </div>
                    {messageFor === call.id && (
                      <div className="mt-2 flex gap-2">
                        <input value={messageText} onChange={(event) => setMessageText(event.target.value)} placeholder="What did they say?"
                          aria-label="Call message"
                          className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-[11px] text-white outline-none placeholder:text-white/25" />
                        <button type="button" disabled={!messageText.trim()}
                          onClick={() => void act(async () => { await api.saveCallMessage(call.id, messageText.trim()); setMessageFor(null); })}
                          className="rounded-lg bg-white/10 px-3 py-1.5 text-[11px] text-white/80 disabled:opacity-30">
                          Save
                        </button>
                      </div>
                    )}
                  </Card>
                </div>
              ))}
            </div>
          </div>
        )}

        <div>
          <SectionTitle>Policy</SectionTitle>
          {!policy ? (
            <div className="flex justify-center py-6"><Loader2 size={16} className="animate-spin text-white/30" /></div>
          ) : (
            <div className="space-y-2">
              <button type="button" disabled={busy} onClick={() => savePolicy({ enabled: !policy.enabled })}
                className="flex w-full items-center justify-between rounded-xl border border-white/8 bg-white/[0.02] px-3 py-2.5 text-left">
                <span>
                  <span className="block text-xs text-white/80">Phone integration</span>
                  <span className="mt-0.5 block text-[11px] text-white/35">
                    {policy.enabled ? "Sara receives call events from your phone." : "Off — no call events are accepted."}
                  </span>
                </span>
                <span className={`h-5 w-9 shrink-0 rounded-full p-0.5 transition ${policy.enabled ? "bg-cyan-400/70" : "bg-white/10"}`}>
                  <span className={`block h-4 w-4 rounded-full bg-white transition-transform ${policy.enabled ? "translate-x-4" : ""}`} />
                </span>
              </button>

              {([
                ["answerFamily", "Family"],
                ["answerBusinessContacts", "Business contacts"],
                ["answerKnownContacts", "Other known contacts"],
              ] as Array<[keyof CallSettingsView, string]>).map(([key, label]) => (
                <div key={key} className="flex items-center justify-between rounded-xl border border-white/8 bg-white/[0.02] px-3 py-2">
                  <span className="text-[11px] text-white/70">{label}</span>
                  <div className="flex overflow-hidden rounded-lg border border-white/10">
                    {(["never", "ask", "auto"] as const).map((mode) => (
                      <button key={mode} type="button" disabled={busy} onClick={() => savePolicy({ [key]: mode } as Partial<CallSettingsView>)}
                        aria-pressed={policy[key] === mode}
                        className={`px-2 py-1 text-[10px] uppercase tracking-wider ${policy[key] === mode ? "bg-cyan-400/20 text-cyan-100" : "text-white/40"}`}>
                        {mode}
                      </button>
                    ))}
                  </div>
                </div>
              ))}

              <button type="button" disabled={busy} onClick={() => savePolicy({ answerUnknownCall: !policy.answerUnknownCall })}
                className="flex w-full items-center justify-between rounded-xl border border-white/8 bg-white/[0.02] px-3 py-2.5 text-left">
                <span>
                  <span className="block text-xs text-white/80">Ask me about unknown callers</span>
                  <span className="mt-0.5 block text-[11px] leading-relaxed text-white/35">
                    Sara still never answers an unknown number on her own — she can only ask you.
                  </span>
                </span>
                <span className={`h-5 w-9 shrink-0 rounded-full p-0.5 ${policy.answerUnknownCall ? "bg-cyan-400/70" : "bg-white/10"}`}>
                  <span className={`block h-4 w-4 rounded-full bg-white transition-transform ${policy.answerUnknownCall ? "translate-x-4" : ""}`} />
                </span>
              </button>

              <button type="button" disabled={busy} onClick={() => savePolicy({ screenCalls: !policy.screenCalls })}
                className="flex w-full items-center justify-between rounded-xl border border-white/8 bg-white/[0.02] px-3 py-2.5 text-left">
                <span>
                  <span className="block text-xs text-white/80">Screen calls before connecting</span>
                  <span className="mt-0.5 block text-[11px] leading-relaxed text-white/35">Sara answers, asks who is calling and why.</span>
                </span>
                <span className={`h-5 w-9 shrink-0 rounded-full p-0.5 ${policy.screenCalls ? "bg-cyan-400/70" : "bg-white/10"}`}>
                  <span className={`block h-4 w-4 rounded-full bg-white transition-transform ${policy.screenCalls ? "translate-x-4" : ""}`} />
                </span>
              </button>
            </div>
          )}
        </div>

        <div>
          <SectionTitle>This phone</SectionTitle>
          <Card>
            {bridgeAvailable() ? (
              <div className="space-y-2">
                <p className="text-[11px] leading-relaxed text-white/55">
                  {bridge?.listening
                    ? `Reporting call state as ${bridge.deviceId ?? "this device"}.`
                    : bridge?.error || "Call reporting is not running."}
                </p>
                <input value={deviceToken} onChange={(event) => setDeviceToken(event.target.value)}
                  placeholder="Device token" aria-label="Device token"
                  className="w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-[11px] text-white outline-none placeholder:text-white/25" />
                <div className="flex gap-2">
                  <button type="button"
                    onClick={() => void act(async () => {
                      saveCallDevice({ token: deviceToken });
                      const base = getServerConfig().apiBase || window.location.origin;
                      setBridge(await startCallBridge(base));
                    })}
                    className="flex-1 rounded-lg bg-white/10 py-1.5 text-[11px] text-white/80">
                    Save &amp; start
                  </button>
                  <button type="button"
                    onClick={() => void act(async () => { await stopCallBridge(); setBridge(await getCallBridgeStatus()); })}
                    className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-[11px] text-white/60">
                    Stop
                  </button>
                </div>
              </div>
            ) : (
              <p className="text-[11px] leading-relaxed text-white/45">
                Call state comes from the Android app. A browser cannot read your phone's calls, so nothing is reported here.
                {!tokenConfigured && " The server also has no SARA_CALL_DEVICE_TOKEN set."}
              </p>
            )}
          </Card>
        </div>

        <div>
          <SectionTitle>Recent</SectionTitle>
          {all.length === 0 ? (
            <p className="text-[11px] leading-relaxed text-white/35">No calls recorded yet.</p>
          ) : (
            <div className="space-y-1.5">
              {all.filter((call) => ["ENDED", "MISSED", "REJECTED", "FAILED"].includes(call.state)).slice(0, 10).map((call) => (
                <div key={call.id} className="flex items-center gap-2 border-b border-white/5 py-1.5 last:border-0">
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${call.state === "MISSED" ? "bg-rose-400/70" : call.state === "ENDED" ? "bg-emerald-400/50" : "bg-white/20"}`} />
                  <span className="min-w-0 flex-1 truncate text-[11px] text-white/70">{callerLabel(call)}</span>
                  <span className="shrink-0 font-mono text-[9px] uppercase tracking-wider text-white/30">{call.state.toLowerCase()}</span>
                  <span className="shrink-0 font-mono text-[9px] text-white/25">
                    {new Date(call.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <p className="pb-1 text-[10px] leading-relaxed text-white/25">
          Android does not let a normal app speak into a cellular call, so Sara cannot hold a conversation on a GSM call.
          Answering and hanging up need the system dialer role; when it is unavailable the app reports that instead of pretending.
        </p>
      </div>
    </Sheet>
  );
}

/* ----------------------------------------------------------------- messages */

/**
 * Unified inbox + send flow.
 *
 * Every send goes through the server's approval path: the first tap prepares a
 * draft and shows exactly what would be sent; only the confirmed call sends.
 * The status shown is the provider's own verdict (SENT / UNCERTAIN / FAILED).
 */
export function MessagesPanel({ onClose }: { onClose: () => void }) {
  const [messages, setMessages] = useState<InboundMessageView[]>([]);
  const [providers, setProviders] = useState<ProviderView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [to, setTo] = useState("");
  const [text, setText] = useState("");
  const [outcome, setOutcome] = useState<SendOutcomeView | null>(null);
  const [sending, setSending] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [inbox, status] = await Promise.all([api.messages("limit=30"), api.messagingStatus()]);
      setMessages(inbox.messages);
      setProviders(status.providers);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const ready = providers.find((provider) => provider.status.ok);
  const send = async (confirmed: boolean) => {
    setSending(true);
    setError(null);
    try {
      const result = await api.sendMessage({ provider: ready?.id || "whatsapp", to: to.trim(), text: text.trim(), confirmed });
      setOutcome(result);
      if (result.status === "SENT") {
        setText("");
        await load();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  return (
    <Sheet title="Messages" subtitle="Only official provider APIs. Nothing is scraped, and nothing is sent without your approval." onClose={onClose}>
      <div className="space-y-4">
        {error && <Card tone="warn"><p className="text-[11px] leading-relaxed text-amber-100/85">{error}</p></Card>}

        <div>
          <SectionTitle>Connectors</SectionTitle>
          <div className="space-y-2">
            {providers.map((provider) => (
              <div key={provider.id} className="flex items-start gap-2.5 rounded-xl border border-white/8 bg-white/[0.02] px-3 py-2">
                <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${provider.status.ok ? "bg-emerald-400/80" : "bg-white/20"}`} />
                <div className="min-w-0">
                  <p className="text-xs text-white/80">{provider.label}</p>
                  <p className="mt-0.5 text-[11px] leading-relaxed text-white/35">{provider.status.detail}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div>
          <SectionTitle>Send</SectionTitle>
          <div className="space-y-2">
            <input value={to} onChange={(event) => setTo(event.target.value)} placeholder="Number (with country code)" aria-label="Recipient"
              className="w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-[12px] text-white outline-none placeholder:text-white/25" />
            <textarea value={text} onChange={(event) => setText(event.target.value)} rows={3} placeholder="Message" aria-label="Message text"
              className="w-full resize-none rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-[12px] text-white outline-none placeholder:text-white/25" />
            <button type="button" disabled={!text.trim() || !to.trim() || sending || !ready}
              onClick={() => void send(false)}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-white/10 py-2.5 text-xs text-white/85 disabled:opacity-30">
              {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
              Prepare message
            </button>
            {!ready && <p className="text-[10px] leading-relaxed text-white/30">No messaging provider is configured on the server, so nothing can be sent yet.</p>}
          </div>

          {outcome && (
            <div className="mt-2">
              <Card tone={outcome.status === "SENT" ? "ok" : outcome.status === "REQUIRES_APPROVAL" ? "warn" : "warn"}>
                <p className="text-[11px] font-medium text-white/85">{outcome.status}</p>
                <p className="mt-1 text-[11px] leading-relaxed text-white/55">{outcome.detail}</p>
                {outcome.status === "REQUIRES_APPROVAL" && (
                  <div className="mt-2 flex gap-2">
                    <button type="button" disabled={sending} onClick={() => void send(true)}
                      className="flex-1 rounded-lg bg-emerald-500/20 py-1.5 text-[11px] text-emerald-100 ring-1 ring-emerald-400/30">
                      Send it
                    </button>
                    <button type="button" onClick={() => setOutcome(null)}
                      className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-[11px] text-white/60">
                      Cancel
                    </button>
                  </div>
                )}
                {outcome.status === "UNCERTAIN" && (
                  <p className="mt-1 text-[10px] leading-relaxed text-amber-100/60">
                    The provider did not confirm, so Sara will not claim it was delivered.
                  </p>
                )}
              </Card>
            </div>
          )}
        </div>

        <div>
          <SectionTitle>Inbox</SectionTitle>
          {loading && messages.length === 0 ? (
            <div className="flex justify-center py-8"><Loader2 size={16} className="animate-spin text-white/30" /></div>
          ) : messages.length === 0 ? (
            <p className="text-[11px] leading-relaxed text-white/35">
              No messages stored. Inbound WhatsApp messages appear here after the Cloud API webhook is configured.
            </p>
          ) : (
            <div className="space-y-2">
              {messages.map((message) => (
                <div key={`${message.provider}-${message.id}`} className="rounded-xl border border-white/8 bg-white/[0.02] px-3 py-2">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-xs text-white/85">{message.fromName || message.fromId}</span>
                    <span className={`shrink-0 font-mono text-[9px] uppercase tracking-wider ${message.importance === "high" ? "text-amber-300/80" : "text-white/25"}`}>
                      {message.importance}
                    </span>
                  </div>
                  <p className="mt-1 line-clamp-3 text-[11px] leading-relaxed text-white/60">{message.text}</p>
                  <p className="mt-1 font-mono text-[9px] text-white/20">{message.reason} · {new Date(message.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Sheet>
  );
}

/** Capability list for the Self-check panel: what can actually run here. */
export function CapabilityList() {
  const [data, setData] = useState<CapabilityCatalogue | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.capabilities()
      .then((catalogue) => !cancelled && setData(catalogue))
      .catch((err: unknown) => !cancelled && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <p className="text-[11px] text-rose-200/70">{error}</p>;
  if (!data) return <div className="flex justify-center py-4"><Loader2 size={14} className="animate-spin text-white/30" /></div>;

  return (
    <div className="space-y-1.5">
      {data.capabilities.map((capability) => (
        <div key={capability.id} className="flex items-start gap-2 border-b border-white/5 py-1.5 last:border-0">
          <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${
            capability.status === "AVAILABLE" ? "bg-emerald-400/80"
              : capability.status === "NEEDS_PERMISSION" ? "bg-amber-300/80"
                : "bg-white/20"
          }`} />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[11px] text-white/75">{capability.label}</span>
              <span className="shrink-0 font-mono text-[9px] uppercase tracking-wider text-white/30">{capability.status.toLowerCase().replace(/_/g, " ")}</span>
            </div>
            <p className="mt-0.5 text-[10px] leading-relaxed text-white/35">{capability.detail}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ activity */

const OP_TONE: Record<string, string> = {
  SUCCESS: "text-emerald-200/85",
  FAILED: "text-rose-200/85",
  UNCERTAIN: "text-amber-200/85",
  CANCELLED: "text-white/40",
  RUNNING: "text-cyan-200/85",
  NEEDS_APPROVAL: "text-amber-200/85",
};

/**
 * Receipts. Each row is one action the executor actually ran, with its honest
 * status — SUCCESS without a verification note means "executed, not
 * independently checked", which is exactly what is shown.
 */
export function ActivityPanel({ onClose }: { onClose: () => void }) {
  const [operations, setOperations] = useState<OperationView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setOperations((await api.operations(40)).operations);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const undo = async (id: string) => {
    setBusyId(id);
    setError(null);
    setNotice(null);
    try {
      const result = await api.undoOperation(id);
      setNotice(result.ok ? `Undone: ${result.label}` : `Could not undo: ${result.result?.error || result.label}`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Sheet
      title="Activity"
      subtitle="Every action with the outcome the executor actually reported — not an optimistic summary."
      onClose={onClose}
      actions={
        <button type="button" onClick={() => void load()} aria-label="Refresh activity" className="mt-1 rounded-lg p-1.5 text-white/45 hover:text-white">
          <RefreshCw size={15} className={loading ? "animate-spin" : ""} />
        </button>
      }
    >
      <div className="space-y-3">
        {error && <Card tone="warn"><p className="text-[11px] leading-relaxed text-amber-100/85">{error}</p></Card>}
        {notice && <Card tone="ok"><p className="text-[11px] leading-relaxed text-emerald-100/85">{notice}</p></Card>}

        {loading && operations.length === 0 ? (
          <div className="flex justify-center py-10"><Loader2 size={16} className="animate-spin text-white/30" /></div>
        ) : operations.length === 0 ? (
          <p className="text-[11px] leading-relaxed text-white/35">
            Nothing has run yet. When Sara uses your PC or changes something, the receipt appears here.
          </p>
        ) : (
          <div className="space-y-2">
            {operations.map((operation) => (
              <div key={operation.id} className="rounded-xl border border-white/8 bg-white/[0.02] px-3 py-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-[11px] text-white/80">{operation.summary || operation.tool}</p>
                    <p className="mt-0.5 font-mono text-[9px] uppercase tracking-wider text-white/25">
                      {operation.tool} · {new Date(operation.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      {operation.durationMs !== null ? ` · ${operation.durationMs} ms` : ""}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <span className={`block font-mono text-[9px] uppercase tracking-wider ${OP_TONE[operation.status] ?? "text-white/40"}`}>
                      {operation.status}
                    </span>
                    <span className="mt-0.5 block font-mono text-[8px] uppercase tracking-wider text-white/20">
                      {operation.status === "SUCCESS" ? (operation.verified ? "verified" : "unverified") : "—"}
                    </span>
                  </div>
                </div>

                {operation.verification && <p className="mt-1 text-[10px] leading-relaxed text-white/35">{operation.verification}</p>}
                {operation.error && <p className="mt-1 text-[10px] leading-relaxed text-rose-200/60">{operation.error}</p>}

                {operation.undo && operation.undoState === "available" && (
                  <button type="button" disabled={busyId === operation.id} onClick={() => void undo(operation.id)}
                    className="mt-1.5 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-[10px] text-white/70 disabled:opacity-40">
                    {busyId === operation.id ? "Undoing…" : operation.undo.destructive ? `Undo (${operation.undo.label})` : "Undo"}
                  </button>
                )}
                {operation.undoState === "done" && <p className="mt-1 font-mono text-[9px] uppercase tracking-wider text-emerald-200/50">undone</p>}
                {operation.undoState === "failed" && <p className="mt-1 font-mono text-[9px] uppercase tracking-wider text-rose-200/60">undo failed</p>}
              </div>
            ))}
          </div>
        )}

        <p className="pb-1 text-[10px] leading-relaxed text-white/25">
          A move is not offered for undo: when the destination is a folder, the final path depends on the desktop agent, and guessing it could
          move the wrong file back. Renames, copies and created files are reversible.
        </p>
      </div>
    </Sheet>
  );
}
