/**
 * Mobile-only display preferences. These do not replace the backend's app
 * settings; they describe how this device renders Sara (battery, motion,
 * avatar on/off) and stay in localStorage.
 */
import { useEffect, useState } from "react";

export interface MobilePrefs {
  /** Freeze ambient animation and the character's idle loop. */
  reducedMotion: boolean;
  /** Show the 3D character. Off = lightweight hologram emblem only. */
  avatarEnabled: boolean;
  /** Keep the mic open when Sara starts (still requires a tap on Android). */
  autoStartVoice: boolean;
  /** Wake word detection (browser Web Speech API; not available in every browser). */
  wakeWord: boolean;
  /** What stands on the stage: the 3D character, or a video the user uploaded. */
  stageMode: "character" | "video";
  /** Play the uploaded clip's own audio (off = muted, so her voice stays clear). */
  videoSound: boolean;
  /** How the uploaded clip fills the stage. */
  videoFit: "cover" | "contain";
}

export const DEFAULT_MOBILE_PREFS: MobilePrefs = {
  reducedMotion: false,
  avatarEnabled: true,
  autoStartVoice: false,
  wakeWord: false,
  stageMode: "video",
  videoSound: false,
  videoFit: "cover",
};

const KEY = "sara.mobile.prefs.v1";

function read(): MobilePrefs {
  if (typeof window === "undefined") return { ...DEFAULT_MOBILE_PREFS };
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) {
      const prefersReduced = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
      return { ...DEFAULT_MOBILE_PREFS, reducedMotion: prefersReduced };
    }
    const parsed = JSON.parse(raw) as Partial<MobilePrefs>;
    const merged = { ...DEFAULT_MOBILE_PREFS, ...parsed };
    // A stored value from an older build (or hand-edited localStorage) must not
    // be able to put the stage into a state the UI cannot render.
    return {
      ...merged,
      stageMode: merged.stageMode === "character" ? "character" : "video",
      videoFit: merged.videoFit === "contain" ? "contain" : "cover",
      videoSound: merged.videoSound === true,
    };
  } catch {
    return { ...DEFAULT_MOBILE_PREFS };
  }
}

export function useMobilePrefs(): [MobilePrefs, (patch: Partial<MobilePrefs>) => void] {
  const [prefs, setPrefs] = useState<MobilePrefs>(read);
  const update = (patch: Partial<MobilePrefs>) => {
    setPrefs((current) => {
      const next = { ...current, ...patch };
      try {
        window.localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  };
  return [prefs, update];
}

/** True when the OS asks for reduced motion (used before prefs load). */
export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
  } catch {
    return false;
  }
}

/**
 * Tracks the Android on-screen keyboard via the Visual Viewport API so the
 * composer can stay visible without the layout jumping.
 */
export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () => {
      const next = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
      setInset(next > 80 ? next : 0);
    };
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    update();
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
    };
  }, []);
  return inset;
}
