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
  ShieldCheck, Sparkles, TriangleAlert, XCircle,
} from "lucide-react";
import { api, type AppSettings, type DiagnosticState, type MobileAutomations, type MobileBriefing, type MobileDiagnostics, type PersonaSettings, type RealitySettings } from "../lib/appApi";
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
