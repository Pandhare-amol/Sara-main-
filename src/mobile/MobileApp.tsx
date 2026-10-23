/**
 * Sara mobile shell.
 *
 * A focused phone interface for the same Sara: avatar first, one voice button,
 * a text fallback, and a compact menu for the features that genuinely work over
 * the network. It reuses the existing character engine, audio session, backend,
 * memory and mission engine — it is an additional interface, not a new brain.
 */
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  Activity, Brain, CalendarClock, Camera, History, Loader2, Menu, MessageCircleHeart, Mic, MicOff,
  OctagonX, Phone, Send, Settings as SettingsIcon, ShieldQuestion, Square, Wifi, WifiOff, X,
} from "lucide-react";
import { useAppEvents } from "../lib/useAppEvents";
import { detectEmotionFromText } from "../lib/emotion";
import { getServerConfig, isNativeApp, saraJson } from "../lib/serverConfig";
import { useMobileSession } from "./useMobileSession";
import { useMobilePrefs, useKeyboardInset } from "./mobilePrefs";
import { MobileStage, accentFor } from "./MobileStage";
import { DevicePanel, HelpPanel, HistoryPanel, MemoryPanel, MissionsPanel, SettingsPanel, type MobileSheet } from "./MobilePanels";
import { AutomationsPanel, BriefingPanel, CallsPanel, DiagnosticsPanel, PersonaPanel, StopPanel, VisionPanel } from "./MobileIntelPanels";
import { installNativeShell, setNativeBackHandler } from "./native";

const THEME_STORAGE = "sara.mobile.theme.v1";

const STATE_LABEL: Record<string, string> = {
  disconnected: "Idle",
  connecting: "Connecting",
  listening: "Listening",
  speaking: "Speaking",
};

function readTheme(): string {
  try {
    return window.localStorage.getItem(THEME_STORAGE) || "celestial";
  } catch {
    return "celestial";
  }
}

export function MobileApp() {
  const events = useAppEvents(true);
  const [theme, setTheme] = useState<string>(readTheme);
  const session = useMobileSession((color) => {
    setTheme(color);
    try {
      window.localStorage.setItem(THEME_STORAGE, color);
    } catch {
      /* ignore */
    }
  });
  const [prefs, updatePrefs] = useMobilePrefs();
  const keyboardInset = useKeyboardInset();
  const [sheet, setSheet] = useState<MobileSheet>(null);
  const [showMenu, setShowMenu] = useState(false);
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [serverOnline, setServerOnline] = useState<boolean | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const accent = accentFor(theme);

  // Native chrome: status bar colours and the Android back button.
  useEffect(() => installNativeShell(), []);
  useEffect(() => {
    setNativeBackHandler(() => {
      if (sheet) {
        setSheet(null);
        return true;
      }
      if (showMenu) {
        setShowMenu(false);
        return true;
      }
      return false;
    });
    return () => setNativeBackHandler(null);
  }, [sheet, showMenu]);

  useEffect(() => {
    document.documentElement.dataset.saraTheme = theme;
  }, [theme]);

  // Health is checked once on mount and whenever the connection changes —
  // never polled on a timer (battery).
  useEffect(() => {
    let cancelled = false;
    const check = () => {
      saraJson<{ ok?: boolean }>("/api/health", { timeoutMs: 8_000 })
        .then((data) => !cancelled && setServerOnline(Boolean(data.ok)))
        .catch(() => !cancelled && setServerOnline(false));
    };
    check();
    const onOnline = () => check();
    window.addEventListener("online", onOnline);
    return () => {
      cancelled = true;
      window.removeEventListener("online", onOnline);
    };
  }, [session.state]);

  const activeTask = useMemo(
    () => Object.values(events.tasks).find((task) => !["completed", "failed", "cancelled", "interrupted"].includes(task.state)),
    [events.tasks],
  );

  const caption = session.saraCaption || session.userCaption;
  const emotion = useMemo(() => (caption ? detectEmotionFromText(caption) : "idle"), [caption]);
  const characterState = session.state === "speaking" ? "talking" : session.state === "connecting" || (session.userCaption && !session.saraCaption) ? "thinking" : "idle";
  const micBlocked = session.micStatus === "denied" || session.micStatus === "unsupported";

  async function submit(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setDraft("");
    try {
      await session.sendText(text);
    } finally {
      setSending(false);
    }
  }

  async function onMic() {
    setShowMenu(false);
    if (session.state !== "disconnected") {
      session.stopSpeaking();
      session.disconnect();
      return;
    }
    if (micBlocked) {
      await session.startText();
      inputRef.current?.focus();
      return;
    }
    await session.startVoice();
  }

  return (
    <div
      className="sara-mobile relative flex h-[100dvh] w-full flex-col overflow-hidden bg-[#03040a] text-white"
      style={{ ["--sara-accent" as string]: accent.primary, ["--sara-accent-2" as string]: accent.secondary }}
    >
      {/* Ambient room light. Pure CSS, no per-frame cost. */}
      <div className="pointer-events-none absolute -left-24 -top-24 h-72 w-72 rounded-full bg-indigo-700/20 blur-[100px]" />
      <div className="pointer-events-none absolute -bottom-32 -right-24 h-80 w-80 rounded-full bg-cyan-600/15 blur-[110px]" />
      <div className="pointer-events-none absolute inset-0 opacity-[0.18] sara-grid" />

      <header className="relative z-30 flex items-center gap-3 px-5 pb-1 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <div className="flex items-baseline gap-2">
          <span className="font-display text-[13px] font-semibold uppercase tracking-[0.42em] text-white/70">Sara</span>
          <span
            className={`h-1.5 w-1.5 rounded-full transition-colors ${
              session.state === "listening" || session.state === "speaking"
                ? "bg-cyan-400 shadow-[0_0_8px_rgba(34,211,238,0.8)]"
                : serverOnline === false
                  ? "bg-rose-400"
                  : "bg-white/20"
            }`}
          />
        </div>

        <div className="ml-auto flex items-center gap-1.5">
          <span className="hidden min-[380px]:inline-flex items-center gap-1 rounded-full border border-white/5 bg-white/[0.03] px-2 py-1 font-mono text-[9px] uppercase tracking-wider text-white/35">
            {serverOnline === false ? <WifiOff size={10} /> : <Wifi size={10} />}
            {serverOnline === false ? "offline" : "online"}
          </span>
          <button
            type="button"
            onClick={() => setShowMenu((open) => !open)}
            aria-label={showMenu ? "Close menu" : "Open menu"}
            aria-expanded={showMenu}
            className="rounded-xl border border-white/10 bg-white/[0.04] p-2 text-white/60 transition active:scale-95"
          >
            {showMenu ? <X size={18} /> : <Menu size={18} />}
          </button>
        </div>
      </header>

      {activeTask && (
        <button
          type="button"
          onClick={() => setSheet("missions")}
          className="relative z-20 mx-5 mt-1 flex items-center gap-2 self-start rounded-full border border-amber-400/20 bg-amber-500/5 px-2.5 py-1 text-left"
        >
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-300" />
          <span className="max-w-[70vw] truncate font-mono text-[10px] uppercase tracking-wider text-amber-200/80">
            {activeTask.goal}
          </span>
        </button>
      )}

      {notice && (
        <div className="relative z-30 mx-5 mb-1 flex items-start gap-2 rounded-xl border border-emerald-400/20 bg-emerald-500/[0.08] px-3 py-2">
          <span className="min-w-0 flex-1 text-[11px] leading-relaxed text-emerald-100/85">{notice}</span>
          <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss notice" className="text-emerald-200/60">
            <X size={12} />
          </button>
        </div>
      )}

      <MobileStage
        session={session.session}
        state={session.state}
        theme={theme}
        emotion={emotion}
        characterState={characterState}
        reducedMotion={prefs.reducedMotion}
        avatarEnabled={prefs.avatarEnabled}
      />

      {/* Captions / state */}
      <div className="relative z-20 min-h-[72px] px-5 pb-2" aria-live="polite">
        <div className="flex items-center justify-center gap-2">
          <span className="font-mono text-[9px] uppercase tracking-[0.3em] text-white/30">
            {STATE_LABEL[session.state] ?? session.state}
          </span>
          {session.state === "connecting" && <Loader2 size={10} className="animate-spin text-white/30" />}
        </div>
        <p
          key={caption ? "caption" : "hint"}
          className={`mt-1.5 line-clamp-3 text-center text-[13px] leading-relaxed ${
            session.userCaption && !session.saraCaption ? "text-cyan-200/80" : "text-white/85"
          }`}
        >
          {caption ||
            (session.state === "listening"
              ? "I'm listening."
              : session.state === "disconnected"
                ? "Tap the microphone and say hello."
                : "")}
        </p>
        {session.error && (
          <div className="mx-auto mt-2 flex max-w-md items-start gap-2 rounded-xl border border-rose-500/20 bg-rose-950/40 px-3 py-2 text-left">
            <ShieldQuestion size={13} className="mt-0.5 shrink-0 text-rose-300" />
            <div className="min-w-0 flex-1">
              <p className="text-[11px] leading-relaxed text-rose-100">{session.error}</p>
              {micBlocked && (
                <button
                  type="button"
                  onClick={() => inputRef.current?.focus()}
                  className="mt-1 text-[10px] uppercase tracking-wider text-rose-300 underline"
                >
                  Use text instead
                </button>
              )}
            </div>
            <button type="button" onClick={session.clearError} aria-label="Dismiss error" className="text-rose-300/70">
              <X size={12} />
            </button>
          </div>
        )}
      </div>

      {/* Composer + controls */}
      <footer
        className="relative z-30 border-t border-white/5 bg-[#05070f]/85 px-4 pt-3 backdrop-blur-xl"
        style={{ paddingBottom: `calc(${keyboardInset}px + max(0.75rem, env(safe-area-inset-bottom)))` }}
      >
        <form onSubmit={submit} className="flex items-center gap-2 rounded-2xl border border-white/10 bg-black/40 px-2 py-1.5">
          <input
            ref={inputRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onFocus={() => setShowMenu(false)}
            enterKeyHint="send"
            autoComplete="off"
            aria-label="Message Sara"
            placeholder={serverOnline === false ? "Sara's server is offline" : "Type to Sara…"}
            className="min-w-0 flex-1 bg-transparent px-2 py-2 text-[13px] text-white outline-none placeholder:text-white/25"
          />
          <button
            type="submit"
            disabled={!draft.trim() || sending}
            aria-label="Send message"
            className="rounded-xl bg-white/10 p-2 text-white/80 transition active:scale-95 disabled:opacity-30"
          >
            {sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
          </button>
        </form>

        <div className="mt-2.5 flex items-center justify-center gap-4 pb-1">
          <button
            type="button"
            onClick={() => setSheet("history")}
            aria-label="Open conversation history"
            className="rounded-xl p-2 text-white/35 transition active:scale-95 hover:text-white/70"
          >
            <History size={18} />
          </button>

          <button
            type="button"
            onClick={() => void onMic()}
            aria-label={session.state === "disconnected" ? "Start voice session" : "End voice session"}
            aria-pressed={session.state !== "disconnected"}
            className={`relative flex h-16 w-16 items-center justify-center rounded-full transition-all duration-300 active:scale-95 ${
              session.state === "listening"
                ? "bg-cyan-400/15 text-cyan-200 ring-2 ring-cyan-300/70 shadow-[0_0_36px_rgba(34,211,238,0.35)]"
                : session.state === "speaking"
                  ? "bg-violet-500/20 text-violet-100 ring-2 ring-violet-400/60 shadow-[0_0_36px_rgba(167,139,250,0.3)]"
                  : session.state === "connecting"
                    ? "bg-white/5 text-white/60 ring-1 ring-white/20"
                    : micBlocked
                      ? "bg-white/[0.04] text-white/50 ring-1 ring-white/15"
                      : "bg-white/[0.06] text-white ring-1 ring-white/20"
            }`}
          >
            {session.state === "connecting" ? (
              <Loader2 size={26} className="animate-spin" />
            ) : micBlocked ? (
              <MicOff size={26} />
            ) : (
              <Mic size={26} />
            )}
            {session.state === "listening" && (
              <span className="pointer-events-none absolute inset-0 animate-ping rounded-full border border-cyan-300/30" />
            )}
          </button>

          {session.state === "speaking" ? (
            <button
              type="button"
              onClick={() => session.stopSpeaking()}
              aria-label="Stop Sara speaking"
              className="rounded-xl p-2 text-white/55 transition active:scale-95 hover:text-white"
            >
              <Square size={18} />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setSheet("missions")}
              aria-label="Open missions"
              className="relative rounded-xl p-2 text-white/35 transition active:scale-95 hover:text-white/70"
            >
              <Activity size={18} />
              {activeTask && <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-amber-300" />}
            </button>
          )}
        </div>

        {micBlocked && (
          <p className="pb-0.5 text-center text-[10px] leading-relaxed text-white/35">
            {session.micStatus === "unsupported"
              ? "This browser has no microphone API. Text still works, and Sara's voice plays."
              : "Microphone blocked. Allow it in the browser/Android settings, or type instead."}
          </p>
        )}
      </footer>

      {/* Compact menu */}
      {showMenu && (
        <div className="absolute inset-0 z-40" onClick={() => setShowMenu(false)}>
          <div className="absolute inset-0 bg-black/50 backdrop-blur-[2px]" />
          <nav
            onClick={(event) => event.stopPropagation()}
            className="sara-menu absolute right-4 top-[calc(env(safe-area-inset-top)+3.4rem)] w-[min(19rem,calc(100vw-2rem))] rounded-2xl border border-white/10 bg-[#0a0d17]/95 p-2 shadow-[0_25px_60px_rgba(0,0,0,0.6)]"
            aria-label="Sara menu"
          >
            {([
              ["briefing", CalendarClock, "Today"],
              ["history", History, "Conversation"],
              ["missions", Activity, "Missions"],
              ["automations", Activity, "Automations"],
              ["memory", Brain, "Memory"],
              ["calls", Phone, "Calls"],
              ["vision", Camera, "Look at this"],
              ["persona", MessageCircleHeart, "How she talks"],
              ["device", Wifi, "Connection"],
              ["settings", SettingsIcon, "Settings"],
              ["selfcheck", ShieldQuestion, "Self-check"],
              ["help", ShieldQuestion, "Help & diagnostics"],
            ] as const).map(([key, Icon, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => {
                  setSheet(key);
                  setShowMenu(false);
                }}
                className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-[13px] text-white/70 transition hover:bg-white/5 hover:text-white"
              >
                <Icon size={16} className="text-white/40" />
                {label}
                {key === "missions" && activeTask && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-amber-300" />}
              </button>
            ))}
            <div className="my-1 h-px bg-white/5" />
            <button
              type="button"
              onClick={() => {
                setSheet("stop");
                setShowMenu(false);
              }}
              className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-[13px] text-rose-200/80 transition hover:bg-rose-500/10"
            >
              <OctagonX size={16} className="text-rose-300/60" />
              Stop everything
            </button>
            {!isNativeApp() && getServerConfig().apiBase && (
              <p className="px-3 pb-1 pt-2 text-[10px] leading-relaxed text-white/25">
                Connected to {getServerConfig().apiBase}
              </p>
            )}
          </nav>
        </div>
      )}

      {sheet === "history" && <HistoryPanel onClose={() => setSheet(null)} />}
      {sheet === "missions" && (
        <MissionsPanel events={events} onClose={() => setSheet(null)} onOpenDevice={() => setSheet("device")} />
      )}
      {sheet === "memory" && <MemoryPanel onClose={() => setSheet(null)} />}
      {sheet === "device" && <DevicePanel onClose={() => setSheet(null)} />}
      {sheet === "settings" && <SettingsPanel prefs={prefs} onChange={updatePrefs} onClose={() => setSheet(null)} />}
      {sheet === "help" && <HelpPanel onClose={() => setSheet(null)} state={session.state} events={events} />}
      {sheet === "briefing" && <BriefingPanel onClose={() => setSheet(null)} onOpenMissions={() => setSheet("missions")} />}
      {sheet === "automations" && <AutomationsPanel onClose={() => setSheet(null)} />}
      {sheet === "vision" && <VisionPanel onClose={() => setSheet(null)} />}
      {sheet === "persona" && <PersonaPanel onClose={() => setSheet(null)} />}
      {sheet === "stop" && <StopPanel onClose={() => setSheet(null)} onStopped={setNotice} />}
      {sheet === "selfcheck" && <DiagnosticsPanel onClose={() => setSheet(null)} />}
      {sheet === "calls" && <CallsPanel onClose={() => setSheet(null)} />}
    </div>
  );
}
