/**
 * Mobile session controller.
 *
 * This is a thin UI adapter over the *existing* `MyraaAudioSession` and the
 * *existing* backend (`/live` WebSocket, `/api/*`). It is not a second brain:
 * the same Sara backend, memory store and tools answer here. It only adds:
 *  - a device-side transcript (src/lib/conversationLog.ts),
 *  - microphone permission state that the mobile UI can explain,
 *  - text-only connection, so the phone still works when the mic is denied.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { MyraaAudioSession, type LiveState } from "../lib/audio";
import { appendConversation } from "../lib/conversationLog";

export type MicStatus = "unknown" | "granted" | "denied" | "unsupported";

export interface MobileSessionApi {
  state: LiveState;
  session: MyraaAudioSession | null;
  userCaption: string;
  saraCaption: string;
  error: string | null;
  micStatus: MicStatus;
  clearError: () => void;
  startVoice: () => Promise<void>;
  startText: () => Promise<void>;
  disconnect: () => void;
  toggle: () => Promise<void>;
  sendText: (text: string) => Promise<void>;
  stopSpeaking: () => void;
}

export function useMobileSession(onTheme?: (color: string) => void): MobileSessionApi {
  const [state, setState] = useState<LiveState>("disconnected");
  const [session, setSession] = useState<MyraaAudioSession | null>(null);
  const [userCaption, setUserCaption] = useState("");
  const [saraCaption, setSaraCaption] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [micStatus, setMicStatus] = useState<MicStatus>("unknown");

  const sessionRef = useRef<MyraaAudioSession | null>(null);
  const modelDraftRef = useRef("");
  const commitTimerRef = useRef<number | null>(null);
  const themeRef = useRef(onTheme);
  themeRef.current = onTheme;

  // Permission is queried, never prompted, on mount.
  useEffect(() => {
    let cancelled = false;
    if (!navigator.mediaDevices?.getUserMedia) {
      setMicStatus("unsupported");
      return;
    }
    const permissions = (navigator as unknown as { permissions?: Permissions }).permissions;
    if (!permissions?.query) return;
    permissions
      .query({ name: "microphone" as PermissionName })
      .then((status) => {
        if (cancelled) return;
        const map = () => setMicStatus(status.state === "granted" ? "granted" : status.state === "denied" ? "denied" : "unknown");
        map();
        status.onchange = map;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      // Reloading the page clears listeners anyway.
    };
  }, []);

  useEffect(() => {
    const flushSara = () => {
      const draft = modelDraftRef.current.trim();
      if (!draft) return;
      modelDraftRef.current = "";
      appendConversation("sara", draft);
    };

    const instance = new MyraaAudioSession({
      onStateChange: (next) => {
        setState(next);
        if (next === "disconnected") {
          flushSara();
          setSaraCaption("");
          setUserCaption("");
        }
      },
      onTranscription: (role, text) => {
        if (role === "user") {
          setUserCaption(text);
          setSaraCaption("");
          appendConversation("user", text);
          return;
        }
        modelDraftRef.current = `${modelDraftRef.current}${text}`;
        setSaraCaption(modelDraftRef.current);
        if (commitTimerRef.current) window.clearTimeout(commitTimerRef.current);
        // Commit shortly after speech settles, even if turnComplete is missed.
        commitTimerRef.current = window.setTimeout(flushSara, 1_500);
      },
      onToolCall: (name, args, callback) => {
        if (name === "changeBackground") {
          const color = String(args?.color ?? "").toLowerCase();
          const valid = ["violet", "crimson", "emerald", "celestial", "gold", "rose", "charcoal"];
          if (valid.includes(color)) {
            themeRef.current?.(color);
            callback({ result: `Shifted atmosphere to ${color}.` });
          } else {
            callback({ error: `Unsupported colour '${color}'.` });
          }
          return;
        }
        callback({ error: `Tool ${name} is not available in the phone interface.` });
      },
      onError: (message) => {
        setError(message);
        if (/permission|notallowed|denied|microphone/i.test(message)) setMicStatus("denied");
      },
      onTurnComplete: () => {
        if (commitTimerRef.current) window.clearTimeout(commitTimerRef.current);
        flushSara();
      },
      onMemorySync: () => {
        /* The memory screen re-reads /api/memories on open. */
      },
    });
    sessionRef.current = instance;
    setSession(instance);
    return () => {
      if (commitTimerRef.current) window.clearTimeout(commitTimerRef.current);
      instance.disconnect();
      if (sessionRef.current === instance) sessionRef.current = null;
    };
  }, []);

  const startVoice = useCallback(async () => {
    setError(null);
    const instance = sessionRef.current;
    if (!instance) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      setMicStatus("unsupported");
      setError("This browser does not expose a microphone. Use the text box instead.");
      return;
    }
    await instance.connect(true);
  }, []);

  const startText = useCallback(async () => {
    setError(null);
    await sessionRef.current?.connect(false);
  }, []);

  const disconnect = useCallback(() => {
    sessionRef.current?.disconnect();
  }, []);

  const toggle = useCallback(async () => {
    const instance = sessionRef.current;
    if (!instance) return;
    if (instance.getState() === "disconnected") {
      if (micStatus === "denied" || micStatus === "unsupported") await startText();
      else await startVoice();
    } else {
      instance.disconnect();
    }
  }, [micStatus, startText, startVoice]);

  const sendText = useCallback(async (text: string) => {
    const clean = text.trim();
    if (!clean) return;
    const instance = sessionRef.current;
    if (!instance) return;
    setError(null);
    appendConversation("user", clean);
    if (instance.getState() === "disconnected") await instance.connect(false);
    instance.sendText(clean);
  }, []);

  const stopSpeaking = useCallback(() => {
    sessionRef.current?.stopSpeaking();
  }, []);

  return {
    state,
    session,
    userCaption,
    saraCaption,
    error,
    micStatus,
    clearError: () => setError(null),
    startVoice,
    startText,
    disconnect,
    toggle,
    sendText,
    stopSpeaking,
  };
}
