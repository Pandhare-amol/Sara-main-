/**
 * "Her look" — choose what stands on the stage on this phone.
 *
 * The 3D character is the default. If you upload a clip, that clip becomes the
 * companion: it loops full-screen behind her captions, muted by default so her
 * voice is what you hear. The file is decoded before it is accepted and stored
 * only on this device (IndexedDB) — it is never uploaded to the Sara server.
 */
import { useRef, useState, type ReactNode } from "react";
import { CheckCircle2, CircleDot, Film, Loader2, Trash2, TriangleAlert, Upload } from "lucide-react";
import type { MobilePrefs } from "./mobilePrefs";
import { describeVideo, formatSize, videoStorageAvailable, type VideoAsset } from "./videoStage";
import { Sheet } from "./MobilePanels";

function SectionTitle({ children }: { children: ReactNode }) {
  return <h3 className="mt-5 mb-2 font-mono text-[10px] uppercase tracking-[0.22em] text-white/35 first:mt-0">{children}</h3>;
}

function Option({
  active,
  title,
  detail,
  disabled,
  onClick,
}: {
  active: boolean;
  title: string;
  detail: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`flex w-full items-start gap-2.5 rounded-xl border px-3 py-2.5 text-left transition disabled:opacity-40 ${
        active ? "border-cyan-300/40 bg-cyan-400/10" : "border-white/8 bg-white/[0.02]"
      }`}
    >
      {active ? <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-cyan-200" /> : <CircleDot size={14} className="mt-0.5 shrink-0 text-white/25" />}
      <span className="min-w-0">
        <span className="block text-xs text-white/85">{title}</span>
        <span className="mt-0.5 block text-[10px] leading-relaxed text-white/40">{detail}</span>
      </span>
    </button>
  );
}

interface Props {
  asset: VideoAsset | null;
  prefs: MobilePrefs;
  busy: boolean;
  onUpload: (file: File) => Promise<void>;
  onRemove: () => Promise<void>;
  onChangePrefs: (patch: Partial<MobilePrefs>) => void;
  onClose: () => void;
}

export function CompanionLookPanel({ asset, prefs, busy, onUpload, onRemove, onChangePrefs, onClose }: Props) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const storageOk = videoStorageAvailable();
  const videoMode = prefs.stageMode === "video";

  async function choose(file: File | undefined) {
    if (!file) return;
    setError(null);
    setNotice(null);
    try {
      await onUpload(file);
      setNotice("Saved on this phone. She now stands in your clip.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function remove() {
    setError(null);
    setNotice(null);
    try {
      await onRemove();
      setNotice("Video removed. The 3D character is back.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <Sheet
      title="Companion look"
      subtitle="What stands on the stage on this phone. Your clip stays on the device — it is never uploaded to Sara's server."
      onClose={onClose}
    >
      <div className="space-y-3">
        <input
          ref={fileRef}
          type="file"
          accept="video/*"
          aria-label="Choose companion video"
          className="hidden"
          onChange={(event) => void choose(event.target.files?.[0])}
        />

        {error && (
          <div className="flex items-start gap-2 rounded-xl border border-amber-400/20 bg-amber-500/[0.06] px-3 py-2">
            <TriangleAlert size={13} className="mt-0.5 shrink-0 text-amber-300" />
            <p className="text-[11px] leading-relaxed text-amber-100/85">{error}</p>
          </div>
        )}
        {notice && (
          <div className="rounded-xl border border-emerald-400/20 bg-emerald-500/[0.06] px-3 py-2">
            <p className="text-[11px] leading-relaxed text-emerald-100/85">{notice}</p>
          </div>
        )}

        {!storageOk && (
          <div className="rounded-xl border border-amber-400/20 bg-amber-500/[0.06] px-3 py-2">
            <p className="text-[11px] leading-relaxed text-amber-100/85">
              This browser does not allow local video storage, so a clip cannot be kept between launches. The built Android app supports it.
            </p>
          </div>
        )}

        {asset ? (
          <div className="overflow-hidden rounded-2xl border border-white/10 bg-black/40">
            {asset.poster ? (
              <img src={asset.poster} alt="First frame of your clip" className="max-h-56 w-full object-cover" />
            ) : (
              <div className="flex h-28 items-center justify-center text-white/25"><Film size={22} /></div>
            )}
            <div className="flex items-center justify-between gap-2 px-3 py-2">
              <span className="min-w-0 truncate text-[10px] leading-relaxed text-white/50">{describeVideo(asset)}</span>
              <button
                type="button"
                onClick={() => void remove()}
                disabled={busy}
                aria-label="Remove companion video"
                className="shrink-0 rounded-lg border border-white/10 p-1.5 text-white/50 transition hover:text-rose-200 disabled:opacity-40"
              >
                <Trash2 size={13} />
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={busy || !storageOk}
            className="flex w-full flex-col items-center gap-2 rounded-2xl border border-dashed border-white/15 bg-white/[0.02] px-4 py-8 text-white/60 transition active:scale-[0.99] disabled:opacity-40"
          >
            {busy ? <Loader2 size={18} className="animate-spin" /> : <Upload size={18} />}
            <span className="text-xs">{busy ? "Reading the video…" : "Upload a video"}</span>
            <span className="text-[10px] leading-relaxed text-white/35">MP4, WebM or MOV · up to {formatSize(60 * 1024 * 1024)} recommended</span>
          </button>
        )}

        {asset && (
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={busy}
            className="flex w-full items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-[11px] text-white/65 disabled:opacity-40"
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
            {busy ? "Reading the video…" : "Replace with another video"}
          </button>
        )}

        <div>
          <SectionTitle>What shows on the stage</SectionTitle>
          <div className="space-y-2">
            <Option
              active={videoMode && Boolean(asset)}
              disabled={!asset}
              title="My video"
              detail={asset ? "Your clip loops as the companion, behind her captions." : "Upload a clip first."}
              onClick={() => onChangePrefs({ stageMode: "video" })}
            />
            <Option
              active={!videoMode || !asset}
              title="3D character"
              detail="The original Sara model. Her animation reacts to what she is doing."
              onClick={() => onChangePrefs({ stageMode: "character" })}
            />
          </div>
        </div>

        {asset && videoMode && (
          <>
            <div>
              <SectionTitle>Framing</SectionTitle>
              <div className="grid grid-cols-2 gap-2">
                {([
                  ["cover", "Fill the screen", "Crops the edges of a tall or wide clip."],
                  ["contain", "Show the whole frame", "Letterboxes the clip instead of cropping."],
                ] as const).map(([id, label, detail]) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => onChangePrefs({ videoFit: id })}
                    className={`rounded-xl border px-3 py-2 text-left transition ${
                      prefs.videoFit === id ? "border-cyan-300/40 bg-cyan-400/10 text-cyan-100" : "border-white/8 bg-white/[0.02] text-white/60"
                    }`}
                  >
                    <span className="block text-[11px]">{label}</span>
                    <span className="mt-0.5 block text-[9px] leading-relaxed text-white/35">{detail}</span>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <SectionTitle>Sound</SectionTitle>
              <button
                type="button"
                onClick={() => onChangePrefs({ videoSound: !prefs.videoSound })}
                className="flex w-full items-center justify-between gap-3 rounded-xl border border-white/8 bg-white/[0.02] px-3 py-2.5 text-left"
              >
                <span className="min-w-0">
                  <span className="block text-xs text-white/85">Play the video&apos;s sound</span>
                  <span className="mt-0.5 block text-[10px] leading-relaxed text-white/40">
                    Off by default so her voice is clear. With sound on, some browsers will wait for a tap before starting.
                  </span>
                </span>
                <span
                  className={`relative h-5 w-9 shrink-0 rounded-full transition ${prefs.videoSound ? "bg-cyan-400/70" : "bg-white/15"}`}
                  aria-hidden
                >
                  <span
                    className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${prefs.videoSound ? "left-[1.15rem]" : "left-0.5"}`}
                  />
                </span>
              </button>
            </div>
          </>
        )}

        <p className="pb-1 text-[10px] leading-relaxed text-white/25">
          The clip loops and pauses when the app is in the background. With reduced motion on, it stays on the poster frame until you tap play,
          and the 3D character is not loaded at all while your video is showing — that keeps the GPU and battery cost down.
        </p>
      </div>
    </Sheet>
  );
}
