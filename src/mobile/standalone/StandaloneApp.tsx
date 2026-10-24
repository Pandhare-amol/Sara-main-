/**
 * Sara Mobile — the standalone phone app.
 *
 * This shell is deliberately separate from the desktop/mobile-client app: it has
 * no server, no `/api/*` calls, no desktop bridge and no shared storage with PC
 * Sara. It runs the conversation itself, against the user's own key, and keeps
 * everything on the device.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { Camera, Film, KeyRound, Menu, Mic, Send, Settings as SettingsIcon, ShieldQuestion, Square, Volume2, X } from "lucide-react";
import { useMobilePrefs, useKeyboardInset } from "../mobilePrefs";
import { StageVideo } from "../StageVideo";
import { clearVideo, loadVideoBlob, loadVideoMeta, saveVideoFile, videoStorageAvailable, type VideoAsset } from "../videoStage";
import { describeKey, readKey, type KeyInfo } from "./deviceKey";
import { GeminiError } from "./gemini";
import { lookAtPhoto, runTurn } from "./engine";
import {
  ACCENTS, BACKDROPS, FONT_SCALES,
  appendMessage, clearAllData, clearMessages, dueReminders, listMemories, listMessages, listReminders, loadSettings, removeLastMessage,
  resetSettings, saveSettings, setReminderDone,
  type StandaloneMemory, type StandaloneMessage, type StandaloneReminder, type StandaloneSettings,
} from "./store";
import { forgetKey } from "./deviceKey";
import { initSpeech, micAvailable, speak, speechOutputAvailable, startRecording, stopSpeaking, transcribeNote, voiceFacts } from "./voiceBridge";
import {
  CompanionSheet, ConversationPanel, KeyBanner, KeyPanel, LimitsPanel, MemoryPanelS, RemindersPanel, SelfCheckPanel,
  SettingsPanelS, Sheet, VisionPanelS, VideoPicker,
} from "./panels";
import type { PreparedImage } from "../image";

type SheetId = "conversation" | "memory" | "reminders" | "settings" | "selfcheck" | "limits" | "look" | "vision" | "key" | null;

export function StandaloneApp() {
  const [prefs, updatePrefs] = useMobilePrefs();
  const [settings, setSettings] = useState<StandaloneSettings>(() => loadSettings());
  const [keyInfo, setKeyInfo] = useState<KeyInfo>(() => describeKey(readKey()));
  const [messages, setMessages] = useState<StandaloneMessage[]>(() => listMessages());
  const [memories, setMemories] = useState<StandaloneMemory[]>(() => listMemories());
  const [reminders, setReminders] = useState<StandaloneReminder[]>(() => listReminders());
  const [sheet, setSheet] = useState<SheetId>(null);
  const [showMenu, setShowMenu] = useState(false);
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [clipAsset, setClipAsset] = useState<VideoAsset | null>(null);
  const [clipUrl, setClipUrl] = useState<string | null>(null);
  const clipUrlRef = useRef<string | null>(null);
  const [clipBusy, setClipBusy] = useState(false);
  const [clipFailed, setClipFailed] = useState(false);

  const recorderRef = useRef<Awaited<ReturnType<typeof startRecording>> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const keyboardInset = useKeyboardInset();

  const refreshStore = useCallback(() => {
    setMessages(listMessages());
    setMemories(listMemories());
    setReminders(listReminders());
    setSettings(loadSettings());
  }, []);

  const refreshKey = useCallback(() => setKeyInfo(describeKey(readKey())), []);

  /* Speech: ask the phone once per launch what engine it really has. */
  const [speechKind, setSpeechKind] = useState<string>("checking");
  useEffect(() => {
    let cancelled = false;
    void initSpeech().then((status) => {
      if (!cancelled) setSpeechKind(status.kind);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const speechOptions = useMemo(
    () => ({
      rate: settings.speech.rate,
      pitch: settings.speech.pitch,
      volume: settings.speech.volume,
      voiceName: settings.speech.voiceName || undefined,
      maxChars: settings.speech.maxChars,
    }),
    [settings.speech],
  );

  /* ------------------------------------------------------------ companion clip */

  useEffect(() => {
    let cancelled = false;
    let created: string | null = null;
    (async () => {
      const meta = await loadVideoMeta();
      if (cancelled) return;
      setClipAsset(meta);
      if (!meta) return;
      const blob = await loadVideoBlob();
      if (cancelled || !blob) return;
      created = URL.createObjectURL(blob);
      clipUrlRef.current = created;
      setClipUrl(created);
    })();
    return () => {
      cancelled = true;
      if (created) URL.revokeObjectURL(created);
      if (clipUrlRef.current === created) clipUrlRef.current = null;
    };
  }, []);

  async function uploadClip(file: File) {
    setClipBusy(true);
    try {
      const asset = await saveVideoFile(file);
      const blob = await loadVideoBlob();
      const previous = clipUrlRef.current;
      const next = blob ? URL.createObjectURL(blob) : null;
      clipUrlRef.current = next;
      setClipUrl(next);
      setClipAsset(asset);
      setClipFailed(false);
      if (previous) URL.revokeObjectURL(previous);
    } finally {
      setClipBusy(false);
    }
  }

  async function removeClip() {
    setClipBusy(true);
    try {
      await clearVideo();
      const previous = clipUrlRef.current;
      clipUrlRef.current = null;
      setClipUrl(null);
      setClipAsset(null);
      if (previous) URL.revokeObjectURL(previous);
    } finally {
      setClipBusy(false);
    }
  }

  /* ---------------------------------------------------------------- reminders */

  useEffect(() => {
    const check = () => {
      const due = dueReminders();
      if (due.length === 0) return;
      setNotice(`Reminder: ${due.map((item) => item.text).join(" · ")}`);
      due.forEach((item) => setReminderDone(item.id, true));
      setReminders(listReminders());
      if (settings.speakReplies && speechOutputAvailable()) void speak(`Reminder: ${due.map((item) => item.text).join(". ")}`, { maxChars: 400 });
    };
    check();
    const timer = window.setInterval(check, 30_000);
    return () => window.clearInterval(timer);
  }, [settings.speakReplies]);

  /* --------------------------------------------------------------- a turn */

  const requireKey = useCallback((): string | null => {
    const key = readKey();
    if (!key) {
      setError("Sara needs your AI key before she can answer. Tap “Add your AI key”.");
      setSheet("key");
      return null;
    }
    return key;
  }, []);

  const finishTurn = useCallback(
    (text: string) => {
      if (!settings.speakReplies || !speechOutputAvailable()) return;
      void speak(text, speechOptions);
    },
    [settings.speakReplies, speechOptions],
  );

  async function send(text: string, spoken = false) {
    const clean = String(text ?? "").trim();
    if (!clean || busy) return;
    const key = requireKey();
    if (!key) return;

    setError(null);
    setNotice(null);
    setBusy(true);
    setDraft("");
    const optimistic = appendMessage({ role: "user", text: clean, spoken });
    setMessages(listMessages());

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const result = await runTurn(clean, {
        key,
        model: settings.model,
        signal: controller.signal,
        onDelta: (delta) => setStreaming((current) => `${current ?? ""}${delta}`),
      });
      setStreaming(null);
      refreshStore();
      const answer = result.handled ? result.handled.message : result.answer;
      if (answer) finishTurn(answer);
      if (result.handled?.kind === "remind" && !result.handled.saved) setError(result.handled.message);
      void optimistic;
    } catch (err) {
      setStreaming(null);
      // The turn did not happen: take the message back out of the log and put it
      // back in the box, so "try again" sends it once, not twice.
      removeLastMessage("user");
      setMessages(listMessages());
      setDraft(clean);
      const message =
        err instanceof GeminiError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Something went wrong on this phone.";
      setError(message);
      if (err instanceof GeminiError && err.code === "INVALID_KEY") setSheet("key");
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    await send(draft);
  }

  /* ------------------------------------------------------------------ voice */

  async function startTalk() {
    if (recording) return;
    setError(null);
    if (!requireKey()) return;
    try {
      recorderRef.current = await startRecording(60_000);
      setRecording(true);
      stopSpeaking();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function stopTalk() {
    const recorder = recorderRef.current;
    if (!recorder) return;
    recorderRef.current = null;
    setRecording(false);
    setBusy(true);
    try {
      const note = await recorder.stop();
      const key = readKey();
      if (!key) return;
      const text = await transcribeNote({ key, model: settings.model, audio: note });
      setBusy(false);
      if (text) await send(text, true);
    } catch (err) {
      setBusy(false);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function cancelTalk() {
    recorderRef.current?.cancel();
    recorderRef.current = null;
    setRecording(false);
  }

  async function stopEverything() {
    cancelTalk();
    abortRef.current?.abort();
    stopSpeaking();
    setBusy(false);
    setStreaming(null);
    setNotice("Stopped. Nothing is running.");
  }

  /* ------------------------------------------------------------------- photo */

  async function askAboutPhoto(image: PreparedImage, question: string): Promise<string> {
    const key = requireKey();
    if (!key) throw new Error("Add your AI key first.");
    const answer = await lookAtPhoto({ mimeType: image.mimeType, data: image.dataBase64 }, question, { key, model: settings.model });
    refreshStore();
    finishTurn(answer);
    return answer;
  }

  /* ------------------------------------------------------------------- view */

  const lastSara = useMemo(() => [...messages].reverse().find((message) => message.role === "sara"), [messages]);
  const clip = clipUrl && !clipFailed
    ? { url: clipUrl, poster: clipAsset?.poster ?? null, muted: !prefs.videoSound, fit: prefs.videoFit, paused: prefs.reducedMotion }
    : null;
  const micReady = micAvailable();
  const accent = ACCENTS[settings.appearance.accent] ?? ACCENTS.cyan;
  const backdrop = BACKDROPS[settings.appearance.backdrop] ?? BACKDROPS.deep;
  const zoom = FONT_SCALES[settings.appearance.fontScale]?.zoom ?? 1;

  useEffect(() => {
    // `scrollTo` is missing in some older WebViews; setting scrollTop works
    // everywhere and cannot throw inside an effect.
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages.length, streaming]);

  return (
    <div
      className="relative flex w-full flex-col overflow-hidden text-white"
      style={{
        // `zoom` scales the whole interface; the height is divided by it so the
        // app still fits the screen exactly at every text size.
        zoom,
        height: `${(100 / zoom).toFixed(3)}dvh`,
        background: backdrop.base,
        paddingBottom: keyboardInset,
      } as CSSProperties}
    >
      <div className="pointer-events-none absolute -left-24 -top-24 h-72 w-72 rounded-full blur-[100px]" style={{ background: backdrop.glow }} />
      <div className="pointer-events-none absolute -bottom-32 -right-24 h-80 w-80 rounded-full blur-[110px]" style={{ background: accent.soft }} />

      <header className="relative z-30 flex items-center gap-3 px-5 pb-1 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <span className="font-display text-[13px] font-semibold uppercase tracking-[0.42em] text-white/70">Sara</span>
        <span className="rounded-full border border-white/10 px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-wider text-white/35">mobile</span>
        <div className="ml-auto flex items-center gap-1.5">
          {busy && <span className="font-mono text-[9px] uppercase tracking-wider" style={{ color: accent.hex, opacity: 0.7 }}>{recording ? "listening" : "thinking"}</span>}
          <button type="button" aria-label="Companion look" onClick={() => setSheet("look")} className="rounded-xl border border-white/10 bg-white/[0.04] p-2 text-white/60">
            <Film size={17} />
          </button>
          <button
            type="button"
            aria-label={showMenu ? "Close menu" : "Open menu"}
            aria-expanded={showMenu}
            onClick={() => setShowMenu((open) => !open)}
            className="rounded-xl border border-white/10 bg-white/[0.04] p-2 text-white/60"
          >
            {showMenu ? <X size={17} /> : <Menu size={17} />}
          </button>
        </div>
      </header>

      {showMenu && (
        <div className="absolute inset-0 z-40" onClick={() => setShowMenu(false)}>
          <div className="absolute inset-0 bg-black/50 backdrop-blur-[2px]" />
          <nav
            onClick={(event) => event.stopPropagation()}
            aria-label="Sara menu"
            className="absolute right-4 top-[calc(env(safe-area-inset-top)+3.4rem)] w-[min(19rem,calc(100vw-2rem))] rounded-2xl border border-white/10 bg-[#0a0d17]/95 p-2 shadow-[0_25px_60px_rgba(0,0,0,0.6)]"
          >
            {([
              ["conversation", MessagesIcon, "Conversation"],
              ["memory", ShieldQuestion, "Memory"],
              ["reminders", SendIcon, "Reminders"],
              ["vision", Camera, "Look at this"],
              ["selfcheck", ShieldQuestion, "Self-check"],
              ["limits", ShieldQuestion, "What this app does"],
              ["settings", SettingsIcon, "Settings"],
              ["key", KeyRound, "AI key"],
            ] as const).map(([id, Icon, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => {
                  setShowMenu(false);
                  setSheet(id);
                }}
                className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-[13px] text-white/75 hover:bg-white/5"
              >
                <Icon size={15} className="text-white/40" />
                {label}
              </button>
            ))}
            <button
              type="button"
              onClick={() => {
                setShowMenu(false);
                void stopEverything();
              }}
              className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-[13px] text-rose-200/80 hover:bg-rose-500/10"
            >
              <Square size={15} className="text-rose-300/60" />
              Stop everything
            </button>
          </nav>
        </div>
      )}

      {!keyInfo.present && (
        <div className="relative z-20 px-5 pb-1">
          <KeyBanner onOpen={() => setSheet("key")} />
        </div>
      )}

      {notice && (
        <div className="relative z-30 mx-5 mb-1 flex items-start gap-2 rounded-xl border border-emerald-400/20 bg-emerald-500/[0.08] px-3 py-2">
          <span className="min-w-0 flex-1 text-[11px] leading-relaxed text-emerald-100/85">{notice}</span>
          <button type="button" aria-label="Dismiss notice" onClick={() => setNotice(null)} className="text-emerald-200/60"><X size={12} /></button>
        </div>
      )}

      {error && (
        <div className="relative z-30 mx-5 mb-1 rounded-xl border border-rose-400/25 bg-rose-500/[0.08] px-3 py-2">
          <div className="flex items-start gap-2">
            <span className="min-w-0 flex-1 text-[11px] leading-relaxed text-rose-100/90">{error}</span>
            <button type="button" aria-label="Dismiss error" onClick={() => setError(null)} className="text-rose-200/60"><X size={12} /></button>
          </div>
          <div className="mt-1.5 flex gap-2">
            {draft.trim() && (
              <button
                type="button"
                onClick={() => void send(draft)}
                className="rounded-lg border border-rose-300/25 bg-rose-400/10 px-2.5 py-1 text-[10px] text-rose-100/85"
              >
                Try again
              </button>
            )}
            <button
              type="button"
              onClick={() => setSheet("selfcheck")}
              className="rounded-lg border border-white/12 bg-white/[0.04] px-2.5 py-1 text-[10px] text-white/70"
            >
              Test connection
            </button>
          </div>
        </div>
      )}

      {/* Stage: the user's clip, or a quiet emblem. No 3D model ships in this app. */}
      <div className="relative w-full flex-1 overflow-hidden">
        <div className="pointer-events-none absolute inset-0 flex items-end justify-center pb-[8%]">
          <div className="h-40 w-40 rounded-full border shadow-[0_0_60px_rgba(34,211,238,0.12)_inset]" style={{ borderColor: accent.soft }} />
        </div>
        {clip ? (
          <>
            <StageVideo
              url={clip.url}
              poster={clip.poster}
              muted={clip.muted}
              fit={clip.fit}
              paused={clip.paused}
              onError={(message) => {
                setClipFailed(true);
                setError(`${message} Showing the emblem instead.`);
              }}
            />
            <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,rgba(3,4,10,0.5)_0%,rgba(3,4,10,0.05)_40%,rgba(3,4,10,0.65)_100%)]" />
          </>
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
            {settings.appearance.emblem && (
              <div
                className="h-24 w-24 rounded-full shadow-[0_0_50px_rgba(34,211,238,0.28)]"
                style={{ backgroundImage: `radial-gradient(circle at 35% 30%, ${accent.hex}, ${accent.deep} 45%, transparent 72%)` }}
              />
            )}
            <span className="font-mono text-[9px] uppercase tracking-[0.3em] text-white/30">on this phone</span>
          </div>
        )}

        {/* Latest exchange, readable without opening the sheet. */}
        <div ref={scrollRef} className="absolute inset-x-0 bottom-0 max-h-[52%] overflow-y-auto px-5 pb-2">
          {streaming ? (
            <p className="whitespace-pre-wrap rounded-2xl border bg-black/45 px-3 py-2 text-[12px] leading-relaxed text-white/85 backdrop-blur-sm" style={{ borderColor: `${accent.hex}26` }}>{streaming}</p>
          ) : lastSara ? (
            <div>
              <p className="whitespace-pre-wrap rounded-2xl border bg-black/40 px-3 py-2 text-[12px] leading-relaxed text-white/85 backdrop-blur-sm" style={{ borderColor: `${accent.hex}26` }}>{lastSara.text}</p>
              {settings.appearance.timestamps && (
                <p className="mt-1 text-right font-mono text-[9px] text-white/25">
                  {new Date(lastSara.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
                </p>
              )}
            </div>
          ) : (
            <p className="text-center text-[11px] leading-relaxed text-white/30">
              {keyInfo.present ? "Ask her anything — or hold the microphone." : "Paste your AI key, then ask her anything."}
            </p>
          )}
        </div>
      </div>

      {settings.speakReplies && speechOutputAvailable() && (
        <div className="relative z-20 flex justify-center pb-1">
          <span className="flex items-center gap-1 rounded-full bg-black/30 px-2 py-0.5 font-mono text-[8px] uppercase tracking-wider text-white/25">
            <Volume2 size={9} /> {speechKind === "native" ? "replies use the phone's voice" : "replies are spoken"}
          </span>
        </div>
      )}

      {/* Composer */}
      <div className="relative z-30 border-t border-white/5 bg-[#05070d]/80 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2 backdrop-blur">
        <form onSubmit={(event) => void submit(event)} className="flex items-end gap-2">
          <button
            type="button"
            aria-label={recording ? "Stop recording" : "Hold to talk"}
            aria-pressed={recording}
            disabled={!micReady}
            onPointerDown={() => void startTalk()}
            onPointerUp={() => void stopTalk()}
            onPointerLeave={() => recording && void stopTalk()}
            onContextMenu={(event) => event.preventDefault()}
            className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border transition ${
              recording ? "border-rose-400/50 bg-rose-500/20 text-rose-100" : "border-white/10 bg-white/[0.04] text-white/60"
            } disabled:opacity-30`}
          >
            <Mic size={17} />
          </button>
          <button type="button" aria-label="Look at this" onClick={() => setSheet("vision")} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04] text-white/60">
            <Camera size={17} />
          </button>
          <input
            value={draft}
            aria-label="Message Sara"
            onChange={(event) => setDraft(event.target.value)}
            placeholder={recording ? "Listening…" : keyInfo.present ? "Message Sara…" : "Add your key first…"}
            enterKeyHint="send"
            className="min-w-0 flex-1 rounded-xl border border-white/10 bg-black/40 px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-400/50"
          />
          <button
            type="submit"
            aria-label="Send"
            disabled={!draft.trim() || busy}
            style={{ borderColor: `${accent.hex}4d`, background: accent.soft, color: accent.hex }}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border disabled:opacity-30"
          >
            <Send size={16} />
          </button>
        </form>
        {recording && (
          <p className="mt-1 text-center font-mono text-[9px] uppercase tracking-wider text-rose-200/70">recording · release to send</p>
        )}
      </div>

      {/* Sheets */}
      {sheet === "conversation" && (
        <ConversationPanel
          messages={messages}
          onClose={() => setSheet(null)}
          onClear={() => {
            clearMessages();
            refreshStore();
            setSheet(null);
          }}
        />
      )}
      {sheet === "memory" && <MemoryPanelS memories={memories} onChanged={refreshStore} onClose={() => setSheet(null)} />}
      {sheet === "reminders" && <RemindersPanel reminders={reminders} onChanged={refreshStore} onClose={() => setSheet(null)} />}
      {sheet === "settings" && (
        <SettingsPanelS
          settings={settings}
          prefs={prefs}
          onChange={(patch) => setSettings(saveSettings(patch))}
          onChangePrefs={updatePrefs}
          onOpenKey={() => setSheet("key")}
          onClose={() => setSheet(null)}
          onEraseEverything={() => {
            clearAllData();
            forgetKey();
            resetSettings();
            setSettings(loadSettings());
            setMessages(listMessages());
            setMemories(listMemories());
            setReminders(listReminders());
            refreshKey();
            setNotice("Everything stored on this phone has been erased.");
          }}
        />
      )}
      {sheet === "selfcheck" && (
        <SelfCheckPanel
          keyInfo={keyInfo}
          settings={settings}
          onOpenKey={() => setSheet("key")}
          onOpenSettings={() => setSheet("settings")}
          onModelChange={(model) => setSettings(saveSettings({ model }))}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet === "limits" && <LimitsPanel onClose={() => setSheet(null)} />}
      {sheet === "key" && (
        <KeyPanel
          keyInfo={keyInfo}
          onChanged={() => {
            refreshKey();
            refreshStore();
          }}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet === "vision" && <VisionPanelS onAsk={askAboutPhoto} onClose={() => setSheet(null)} />}
      {sheet === "look" && (
        <CompanionSheet onClose={() => setSheet(null)}>
          <VideoPicker
            asset={clipAsset}
            busy={clipBusy}
            onUpload={uploadClip}
            onRemove={removeClip}
            fit={prefs.videoFit}
            onFit={(fit) => updatePrefs({ videoFit: fit })}
            sound={prefs.videoSound}
            onSound={(sound) => updatePrefs({ videoSound: sound })}
            storageOk={videoStorageAvailable()}
          />
        </CompanionSheet>
      )}
    </div>
  );
}

/* Local helpers kept at the bottom to keep the component body readable. */

const MessagesIcon = ({ size, className }: { size?: number; className?: string }) => <Menu size={size} className={className} />;
const SendIcon = ({ size, className }: { size?: number; className?: string }) => <Send size={size} className={className} />;

export { voiceFacts };
