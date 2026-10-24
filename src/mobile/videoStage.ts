/**
 * User-chosen companion video for the phone stage.
 *
 * The video is the user's own file, so it never leaves the device: the blob is
 * stored in IndexedDB and only a small metadata record is mirrored into
 * localStorage for an instant first paint. Nothing here touches the server.
 *
 * Two rules shape this module:
 *  - we never claim a file is usable before the device has actually decoded it
 *    (the first frame is read before we accept it);
 *  - unsupported or unreadable files are rejected with a plain explanation
 *    instead of silently showing a black stage.
 */

const DB_NAME = "sara.mobile.stage";
const DB_VERSION = 1;
const STORE = "companion";
const META_KEY = "meta";
const BLOB_KEY = "blob";
const META_STORAGE_KEY = "sara.mobile.stage.video.v1";

/** Hard limit: refuse anything this large instead of filling the phone's storage. */
export const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
/** Soft limit: accepted, with a warning about storage and battery. */
export const LARGE_VIDEO_BYTES = 60 * 1024 * 1024;

const KNOWN_VIDEO_TYPES = [
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "video/x-m4v",
  "video/ogg",
  "video/mpeg",
  "video/3gpp",
];

const KNOWN_VIDEO_EXTENSIONS = ["mp4", "m4v", "webm", "mov", "ogv", "ogg", "mpeg", "mpg", "3gp"];

export interface VideoFileLike {
  name: string;
  type: string;
  size: number;
}

export interface VideoAsset {
  /** Stable id derived from the file, so a re-upload of the same clip is detectable. */
  id: string;
  name: string;
  mime: string;
  size: number;
  addedAt: string;
  /** Seconds, `null` when the device could not report a finite duration. */
  durationSec: number | null;
  width: number | null;
  height: number | null;
  /** First-frame JPEG as a data URL, used as the poster before the blob decodes. */
  poster: string | null;
}

/**
 * Result of the pure checks. A plain `ok` flag is used instead of a literal
 * union because this repo compiles with `strictNullChecks: false`, where a
 * boolean-literal union stops narrowing.
 */
export interface VideoValidation {
  ok: boolean;
  warning?: string;
  error?: string;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

/**
 * Pure validation: type, emptiness and size. Decoding is checked separately by
 * `readVideoMetadata`, which needs a real `<video>` element.
 */
export function validateVideoFile(file: VideoFileLike): VideoValidation {
  if (!file || !file.name) return { ok: false, error: "No file was selected." };
  if (!file.size) return { ok: false, error: "That file is empty." };
  if (file.size > MAX_VIDEO_BYTES) {
    return {
      ok: false,
      error: `That video is ${formatSize(file.size)}. The limit is ${formatSize(MAX_VIDEO_BYTES)} — pick a shorter clip or compress it first.`,
    };
  }

  const type = (file.type || "").toLowerCase();
  const extension = extensionOf(file.name);
  const looksLikeVideo = type.startsWith("video/") || KNOWN_VIDEO_EXTENSIONS.includes(extension);
  if (!looksLikeVideo) {
    return { ok: false, error: "That is not a video. Choose an MP4, WebM or MOV file." };
  }
  if (type && !type.startsWith("video/")) {
    return { ok: false, error: `That file is a ${type}, not a video.` };
  }

  const warning =
    file.size > LARGE_VIDEO_BYTES
      ? `That clip is ${formatSize(file.size)}. It is kept on this phone only, but it will use that much storage and more battery while it loops.`
      : null;
  return { ok: true, warning: warning ?? undefined };
}

/** Seconds → `m:ss` (or `h:mm:ss`). `null` renders as "unknown length". */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return "unknown length";
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** One-line description of the stored clip, e.g. `sara.mp4 · 0:12 · 1080p · 4.2 MB`. */
export function describeVideo(asset: VideoAsset): string {
  const parts = [asset.name, formatDuration(asset.durationSec)];
  if (asset.width && asset.height) parts.push(`${asset.width}×${asset.height}`);
  parts.push(formatSize(asset.size));
  return parts.join(" · ");
}

/** True when this browser/webview can persist the clip at all. */
export function videoStorageAvailable(): boolean {
  return typeof indexedDB !== "undefined" && indexedDB !== null;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!videoStorageAvailable()) {
      reject(new Error("This browser cannot store a video on the device."));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("The video store could not be opened."));
    request.onblocked = () => reject(new Error("The video store is blocked by another tab."));
  });
}

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const request = run(transaction.objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("The video store rejected the request."));
    });
  } finally {
    db.close();
  }
}

function readCachedMeta(): VideoAsset | null {
  try {
    const raw = window.localStorage.getItem(META_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as VideoAsset;
    return parsed && typeof parsed.id === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function writeCachedMeta(asset: VideoAsset | null): void {
  try {
    if (asset) window.localStorage.setItem(META_STORAGE_KEY, JSON.stringify(asset));
    else window.localStorage.removeItem(META_STORAGE_KEY);
  } catch {
    /* storage full or disabled — the IndexedDB copy is still authoritative */
  }
}

/** Metadata only: cheap enough to call during first render. */
export async function loadVideoMeta(): Promise<VideoAsset | null> {
  const cached = readCachedMeta();
  if (!videoStorageAvailable()) return cached;
  try {
    const stored = await withStore<VideoAsset | undefined>("readonly", (store) => store.get(META_KEY));
    if (stored) {
      writeCachedMeta(stored);
      return stored;
    }
    return cached;
  } catch {
    return cached;
  }
}

export async function loadVideoBlob(): Promise<Blob | null> {
  if (!videoStorageAvailable()) return null;
  try {
    const blob = await withStore<Blob | undefined>("readonly", (store) => store.get(BLOB_KEY));
    return blob instanceof Blob ? blob : null;
  } catch {
    return null;
  }
}

export interface VideoMetadata {
  durationSec: number | null;
  width: number | null;
  height: number | null;
  poster: string | null;
}

/**
 * Decode the clip far enough to know it really plays on this device, and grab a
 * poster frame. Resolves with `null`-ish fields rather than throwing when the
 * device is cagey about metadata (some Android webviews report nothing until
 * the first frame renders).
 */
export function readVideoMetadata(url: string): Promise<VideoMetadata> {
  return new Promise((resolve, reject) => {
    if (typeof document === "undefined") {
      resolve({ durationSec: null, width: null, height: null, poster: null });
      return;
    }
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    video.playsInline = true;
    let settled = false;
    const finish = (value: VideoMetadata) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(message));
    };
    const cleanup = () => {
      video.removeAttribute("src");
      video.load();
    };
    const capture = () => {
      let poster: string | null = null;
      try {
        const canvas = document.createElement("canvas");
        const width = video.videoWidth;
        const height = video.videoHeight;
        if (width && height) {
          const scale = Math.min(1, 640 / Math.max(width, height));
          canvas.width = Math.max(1, Math.round(width * scale));
          canvas.height = Math.max(1, Math.round(height * scale));
          const context = canvas.getContext("2d");
          if (context) {
            context.drawImage(video, 0, 0, canvas.width, canvas.height);
            poster = canvas.toDataURL("image/jpeg", 0.72);
          }
        }
      } catch {
        poster = null; // tainted canvas or no 2D context — the poster is optional
      }
      finish({
        durationSec: Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null,
        width: video.videoWidth || null,
        height: video.videoHeight || null,
        poster,
      });
    };

    video.addEventListener("error", () => fail("This device cannot decode that video. Try an MP4 (H.264) clip."));
    video.addEventListener("loadeddata", capture, { once: true });
    video.addEventListener("loadedmetadata", () => {
      // Some webviews fire metadata but never `loadeddata` for unsupported
      // codecs. Give the frame a moment, then accept metadata without a poster.
      window.setTimeout(() => {
        if (settled) return;
        finish({
          durationSec: Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null,
          width: video.videoWidth || null,
          height: video.videoHeight || null,
          poster: null,
        });
      }, 1_500);
    });
    video.src = url;
    video.load();
  });
}

/**
 * Validate, decode, then persist. Rejects with a readable message.
 *
 * `readMetadata` is injectable so the persistence path can be tested without a
 * `<video>` element; production always uses the real decoder.
 */
export async function saveVideoFile(
  file: File,
  readMetadata: (url: string) => Promise<VideoMetadata> = readVideoMetadata,
): Promise<VideoAsset> {
  const validation = validateVideoFile(file);
  if (!validation.ok) throw new Error(validation.error || "That file cannot be used as a video.");
  if (!videoStorageAvailable()) {
    throw new Error("This browser cannot keep a video on the device. Use the app build, or a browser that allows local storage.");
  }

  const url = URL.createObjectURL(file);
  let metadata: VideoMetadata;
  try {
    metadata = await readMetadata(url);
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error instanceof Error ? error : new Error(String(error));
  }
  URL.revokeObjectURL(url);

  const asset: VideoAsset = {
    id: `${file.name}:${file.size}:${file.lastModified ?? 0}`,
    name: file.name,
    mime: file.type || "video/mp4",
    size: file.size,
    addedAt: new Date().toISOString(),
    durationSec: metadata.durationSec,
    width: metadata.width,
    height: metadata.height,
    poster: metadata.poster,
  };

  await withStore("readwrite", (store) => store.put(file, BLOB_KEY));
  await withStore("readwrite", (store) => store.put(asset, META_KEY));
  writeCachedMeta(asset);
  return asset;
}

/** Remove the clip from the device. Safe to call when nothing is stored. */
export async function clearVideo(): Promise<void> {
  writeCachedMeta(null);
  if (!videoStorageAvailable()) return;
  await withStore("readwrite", (store) => store.delete(BLOB_KEY));
  await withStore("readwrite", (store) => store.delete(META_KEY));
}
