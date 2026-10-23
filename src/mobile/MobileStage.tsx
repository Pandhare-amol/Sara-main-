/**
 * The phone stage: Sara's existing character renderer plus the holographic
 * atmosphere from the desktop UI, sized for portrait and landscape phones.
 *
 * Nothing about the character itself changes here — same engine, same assets,
 * same imported model. On a device without an imported model (models are
 * licensed per user and are not bundled) the stage shows a quiet emblem instead
 * of a broken import prompt, because importing requires the desktop file picker.
 *
 * A user-uploaded video can take the stage instead. When it does, the 3D
 * renderer is not mounted at all: one source of animation, not two competing
 * for the GPU.
 */
import { useEffect, useState } from "react";
import type { LiveState } from "../lib/audio";
import type { MyraaAudioSession } from "../lib/audio";
import { MyraaCoreVisualizer, type MyraaEmotion } from "../components/MyraaCoreVisualizer";
import { StageVideo } from "./StageVideo";

const ACCENTS: Record<string, { primary: string; secondary: string }> = {
  violet: { primary: "#a855f7", secondary: "#d946ef" },
  crimson: { primary: "#f43f5e", secondary: "#ea580c" },
  emerald: { primary: "#10b981", secondary: "#14b8a6" },
  celestial: { primary: "#22d3ee", secondary: "#4f46e5" },
  gold: { primary: "#f59e0b", secondary: "#eab308" },
  rose: { primary: "#ec4899", secondary: "#f43f5e" },
  charcoal: { primary: "#94a3b8", secondary: "#64748b" },
};

export function accentFor(theme: string): { primary: string; secondary: string } {
  return ACCENTS[theme] ?? ACCENTS.celestial;
}

export interface StageClip {
  url: string;
  poster: string | null;
  muted: boolean;
  fit: "cover" | "contain";
  /** Reduced motion holds the clip on its poster until the user taps play. */
  paused: boolean;
}

interface Props {
  session: MyraaAudioSession | null;
  state: LiveState;
  theme: string;
  emotion: MyraaEmotion;
  characterState: "idle" | "thinking" | "talking";
  reducedMotion: boolean;
  avatarEnabled: boolean;
  /** The user's own video, when one is stored and selected. */
  clip?: StageClip | null;
  onClipError?: (message: string) => void;
  onOpenLook?: () => void;
}

export function MobileStage({
  session, state, theme, emotion, characterState, reducedMotion, avatarEnabled, clip, onClipError, onOpenLook,
}: Props) {
  const accent = accentFor(theme);
  const [characterFailed, setCharacterFailed] = useState(false);
  const active = state !== "disconnected";

  // A failed WebGL context (some low-end Android GPUs) must not leave a blank
  // screen: we swap to the emblem after the first failure and remember it for
  // this session.
  useEffect(() => {
    const onLost = (event: Event) => {
      if ((event.target as HTMLElement)?.tagName === "CANVAS") setCharacterFailed(true);
    };
    window.addEventListener("webglcontextlost", onLost, true);
    return () => window.removeEventListener("webglcontextlost", onLost, true);
  }, []);

  return (
    <div className="sara-stage relative flex-1 w-full overflow-hidden">
      {/* Holographic floor rings, always present behind the character. */}
      <div className="pointer-events-none absolute inset-0 flex items-end justify-center pb-[8%]">
        <div
          className={`sara-holo-ring ${reducedMotion ? "" : "sara-holo-ring--spin"}`}
          style={{ borderColor: `${accent.primary}55`, boxShadow: `0 0 40px ${accent.primary}33 inset` }}
        />
        <div
          className="sara-holo-ring sara-holo-ring--inner"
          style={{ borderColor: `${accent.secondary}33` }}
        />
        <div
          className="absolute bottom-[8%] h-24 w-2/3 rounded-[100%] blur-2xl transition-opacity duration-700"
          style={{ background: `radial-gradient(ellipse at center, ${accent.primary}44, transparent 70%)`, opacity: active ? 0.9 : 0.45 }}
        />
      </div>

      {clip ? (
        <>
          <StageVideo
            url={clip.url}
            poster={clip.poster}
            muted={clip.muted}
            fit={clip.fit}
            paused={clip.paused}
            onError={(message) => onClipError?.(message)}
          />
          {/* Keeps captions readable over a bright clip. */}
          <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,rgba(3,4,10,0.55)_0%,rgba(3,4,10,0.08)_35%,rgba(3,4,10,0.12)_65%,rgba(3,4,10,0.6)_100%)]" />
          <div className="pointer-events-none absolute inset-0 flex items-end justify-center pb-[9%]">
            <div
              className={`h-24 w-2/3 rounded-[100%] blur-2xl transition-opacity duration-700 ${characterState === "talking" && !reducedMotion ? "animate-pulse" : ""}`}
              style={{ background: `radial-gradient(ellipse at center, ${accent.primary}33, transparent 70%)`, opacity: 0.6 }}
            />
          </div>
          {onOpenLook && (
            <button
              type="button"
              onClick={onOpenLook}
              aria-label="Change companion look"
              className="absolute right-3 top-2 rounded-full border border-white/10 bg-black/40 px-2.5 py-1 font-mono text-[9px] uppercase tracking-wider text-white/45 backdrop-blur"
            >
              my video
            </button>
          )}
        </>
      ) : avatarEnabled && !characterFailed ? (
        <div className="absolute inset-0">
          <MyraaCoreVisualizer
            session={session}
            state={state}
            themeColor={theme}
            activeEmotion={emotion}
            characterState={characterState}
            characterId={undefined}
            reflectionStrength={0.8}
            reducedMotion={reducedMotion}
            touch
            quietEmptyState
          />
        </div>
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
          <div
            className={`sara-emblem ${reducedMotion ? "" : "sara-emblem--breathe"}`}
            style={{ background: `radial-gradient(circle at 35% 30%, ${accent.primary}, ${accent.secondary}22 70%)` }}
          />
          <span className="font-mono text-[10px] uppercase tracking-[0.35em] text-white/35">
            {characterFailed ? "Avatar paused (GPU)" : "Avatar off"}
          </span>
        </div>
      )}

      {/* Quiet hint when the character is not present, without blocking the stage. */}
      {!clip && avatarEnabled && !characterFailed && (
        <div className="pointer-events-none absolute inset-x-0 bottom-2 flex justify-center">
          <span className="rounded-full bg-black/25 px-3 py-1 font-mono text-[9px] uppercase tracking-[0.25em] text-white/25 backdrop-blur-sm">
            {active ? "presence link active" : "tap the mic to wake her"}
          </span>
        </div>
      )}
    </div>
  );
}
