/**
 * The user's own clip, played as Sara's stage on the phone.
 *
 * Deliberate behaviour:
 *  - muted by default, so her voice is always the thing you hear;
 *  - autoplay is attempted, but if the browser refuses (sound on, or a strict
 *    power-saving webview) we show a tap-to-play control instead of pretending
 *    it is running;
 *  - paused while the app is in the background, and while reduced motion is on;
 *  - `playsInline` so iOS/Android do not hijack it into a fullscreen player.
 */
import { useEffect, useRef, useState } from "react";
import { Loader2, Play } from "lucide-react";

/** If the device never reports a decodable frame, stop showing a spinner. */
const READY_TIMEOUT_MS = 5_000;

interface Props {
  url: string;
  poster: string | null;
  muted: boolean;
  fit: "cover" | "contain";
  paused: boolean;
  onError: (message: string) => void;
  onReady?: () => void;
}

export function StageVideo({ url, poster, muted, fit, paused, onError, onReady }: Props) {
  const ref = useRef<HTMLVideoElement | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [loading, setLoading] = useState(true);

  // Load/replace the source.
  useEffect(() => {
    setBlocked(false);
    setLoading(true);
    const timer = window.setTimeout(() => setLoading(false), READY_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [url]);

  // Play/pause is driven by props, visibility, and what the browser allows.
  useEffect(() => {
    const video = ref.current;
    if (!video) return;

    const apply = () => {
      if (paused || document.hidden) {
        video.pause();
        return;
      }
      const attempt = video.play();
      if (attempt && typeof attempt.then === "function") {
        attempt.then(() => setBlocked(false)).catch(() => setBlocked(true));
      }
    };

    apply();
    document.addEventListener("visibilitychange", apply);
    return () => {
      document.removeEventListener("visibilitychange", apply);
      video.pause();
    };
  }, [paused, url, muted]);

  return (
    <div className="absolute inset-0">
      <video
        ref={ref}
        src={url}
        poster={poster ?? undefined}
        loop
        muted={muted}
        playsInline
        preload="auto"
        onLoadedData={() => {
          setLoading(false);
          setBlocked(false);
          onReady?.();
        }}
        onCanPlay={() => setLoading(false)}
        onPlaying={() => {
          setLoading(false);
          setBlocked(false);
        }}
        onError={() => {
          setLoading(false);
          onError("That video could not be played on this device. Try an MP4 (H.264) clip.");
        }}
        onPlay={() => setBlocked(false)}
        className="pointer-events-none absolute inset-0 h-full w-full bg-black"
        style={{ objectFit: fit }}
      />

      {loading && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <Loader2 size={18} className="animate-spin text-white/40" />
        </div>
      )}

      {(blocked || paused) && !loading && (
        <button
          type="button"
          onClick={() => {
            setBlocked(false);
            void ref.current?.play().catch(() => setBlocked(true));
          }}
          aria-label={paused ? "Play companion video" : "Tap to play"}
          className="absolute bottom-10 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full border border-white/15 bg-black/55 px-3 py-1.5 text-[10px] uppercase tracking-wider text-white/70 backdrop-blur"
        >
          <Play size={11} />
          {paused ? "Play my video" : "Tap to play"}
        </button>
      )}
    </div>
  );
}
