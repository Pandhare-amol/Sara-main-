/**
 * Phone views of things that live on the PC.
 *
 * The phone is a client of the computer running Sara, so "PC features" here mean
 * real remote access to that machine — not a local imitation. Each panel either
 * talks to the real endpoint or states exactly what the PC needs to enable.
 */
import { useState, type ReactNode } from "react";
import { Camera, CircleAlert, Loader2, Monitor, Sparkles, TriangleAlert } from "lucide-react";
import { api } from "../lib/appApi";
import { Sheet } from "./MobilePanels";

function Card({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "warn" | "ok" }) {
  const styles =
    tone === "warn"
      ? "border-amber-400/20 bg-amber-500/[0.06]"
      : tone === "ok"
        ? "border-emerald-400/20 bg-emerald-500/[0.05]"
        : "border-white/8 bg-white/[0.02]";
  return <div className={`rounded-xl border px-3 py-2 ${styles}`}>{children}</div>;
}

interface Shot {
  image_base64: string;
  image_mime: string;
  width: number;
  height: number;
  active_window: string | null;
  source: string;
}

/** Explains a remote-access refusal in the terms the operator can act on. */
function explain(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/SARA_DESKTOP_ONLY|only available on the computer/i.test(message)) {
    return "This is switched off for remote devices on the PC. Start Sara on the computer with SARA_REMOTE_ALLOW_DESKTOP=1 to let the phone see its screen.";
  }
  if (/desktop agent|not detected|offline|not connected/i.test(message)) {
    return "The Windows desktop agent is not connected on the PC, so there is no screen to capture. Start Sara on the computer and wait for the agent badge to go green.";
  }
  if (/Failed to fetch|NetworkError|fetch failed/i.test(message)) {
    return "The phone could not reach the PC. Check the address in Connection and that both are on the same network.";
  }
  return message;
}

export function PcScreenPanel({ onClose }: { onClose: () => void }) {
  const [shot, setShot] = useState<Shot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [answer, setAnswer] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);

  async function capture() {
    setBusy(true);
    setError(null);
    setAnswer(null);
    try {
      const result = await api.capturePcScreen(1280);
      if (!result?.image_base64) throw new Error("The PC returned no image.");
      setShot(result);
    } catch (err) {
      setShot(null);
      setError(explain(err));
    } finally {
      setBusy(false);
    }
  }

  async function ask() {
    if (!shot) return;
    setAsking(true);
    setError(null);
    try {
      const result = await api.vision(shot.image_base64, shot.image_mime || "image/jpeg", "What is on this screen right now? Point out anything that needs my attention.");
      setAnswer(result.answer);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAsking(false);
    }
  }

  return (
    <Sheet
      title="PC screen"
      subtitle="A live look at the computer running Sara. One frame per tap — nothing is recorded or kept."
      onClose={onClose}
    >
      <div className="space-y-3">
        <button
          type="button"
          onClick={() => void capture()}
          disabled={busy}
          className="flex w-full items-center justify-center gap-2 rounded-xl border border-cyan-300/30 bg-cyan-400/10 px-3 py-2.5 text-xs text-cyan-100 disabled:opacity-40"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Monitor size={14} />}
          {busy ? "Capturing…" : shot ? "Capture again" : "Capture the PC screen"}
        </button>

        {error && (
          <Card tone="warn">
            <div className="flex items-start gap-2">
              <TriangleAlert size={13} className="mt-0.5 shrink-0 text-amber-300" />
              <p className="text-[11px] leading-relaxed text-amber-100/85">{error}</p>
            </div>
          </Card>
        )}

        {shot ? (
          <>
            <div className="overflow-hidden rounded-2xl border border-white/10 bg-black/50">
              <img
                src={`data:${shot.image_mime || "image/jpeg"};base64,${shot.image_base64}`}
                alt="The PC screen as captured"
                className="max-h-[46vh] w-full object-contain"
              />
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 font-mono text-[9px] uppercase tracking-wider text-white/30">
                <span>{shot.width}×{shot.height}</span>
                <span>{shot.source}</span>
                {shot.active_window && <span className="truncate">focus: {shot.active_window}</span>}
              </div>
            </div>

            <button
              type="button"
              onClick={() => void ask()}
              disabled={asking}
              className="flex w-full items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-[11px] text-white/70 disabled:opacity-40"
            >
              {asking ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
              {asking ? "Looking…" : "Ask her what needs my attention"}
            </button>

            {answer && (
              <Card tone="ok">
                <p className="whitespace-pre-wrap text-[11px] leading-relaxed text-emerald-50/90">{answer}</p>
              </Card>
            )}
          </>
        ) : (
          !busy && (
            <p className="text-[11px] leading-relaxed text-white/40">
              This captures the PC's own screen through the Windows agent. If the phone is remote, the PC must allow remote desktop tools
              (<span className="font-mono text-white/60">SARA_REMOTE_ALLOW_DESKTOP=1</span>) — otherwise you will get the exact reason here
              instead of a blank image.
            </p>
          )
        )}

        <Card>
          <div className="flex items-start gap-2">
            <CircleAlert size={13} className="mt-0.5 shrink-0 text-white/35" />
            <p className="text-[10px] leading-relaxed text-white/35">
              The screenshot is sent back once and displayed; it is not written to the phone's storage. Asking her about it uses one image
              request against your Gemini key.
            </p>
          </div>
        </Card>
      </div>
    </Sheet>
  );
}

/** Character Studio is a 3D editor; the phone states that instead of faking it. */
export function StudioUnavailablePanel({ onClose }: { onClose: () => void }) {
  return (
    <Sheet title="Character Studio" subtitle="Where your model lives" onClose={onClose}>
      <div className="space-y-3">
        <Card tone="warn">
          <div className="flex items-start gap-2">
            <Camera size={13} className="mt-0.5 shrink-0 text-amber-300" />
            <p className="text-[11px] leading-relaxed text-amber-100/85">
              The studio (import .pmx models, pose, fingers, cloth physics) is a desktop 3D editor and is not available on the phone. Your
              model still renders here — it streams from the PC, so anything you import there shows up on the phone automatically.
            </p>
          </div>
        </Card>
        <p className="text-[11px] leading-relaxed text-white/45">
          What you can change from here: <span className="text-white/70">Settings → Character &amp; companion</span> for graphics quality,
          realism, cloth and eye-follow, and <span className="text-white/70">Companion look</span> to use your own video instead of the 3D model.
        </p>
      </div>
    </Sheet>
  );
}

/**
 * Settings live on the server. If the phone cannot read them yet, say why —
 * never render a half-populated settings screen that looks like Sara lost her
 * configuration.
 */
export function SettingsUnavailablePanel({
  connected,
  onRetry,
  onClose,
}: {
  connected: boolean;
  onRetry: () => void;
  onClose: () => void;
}) {
  return (
    <Sheet title="Settings" subtitle="Sara's settings are stored on the computer running her." onClose={onClose}>
      <div className="space-y-3">
        <Card tone="warn">
          <div className="flex items-start gap-2">
            <TriangleAlert size={13} className="mt-0.5 shrink-0 text-amber-300" />
            <p className="text-[11px] leading-relaxed text-amber-100/85">
              {connected
                ? "The server answered but did not return its full settings. It may be an older build — update Sara on the PC, then retry."
                : "Sara's server is not reachable from this phone yet, so there are no settings to show. Open Connection, enter the PC's address and access token, then retry."}
            </p>
          </div>
        </Card>
        <button
          type="button"
          onClick={onRetry}
          className="w-full rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-[11px] text-white/70"
        >
          Retry
        </button>
        <p className="text-[10px] leading-relaxed text-white/30">
          Device-only preferences (reduced motion, avatar, wake phrase, this phone's conversation log) are in <span className="text-white/55">This device</span>.
        </p>
      </div>
    </Sheet>
  );
}
