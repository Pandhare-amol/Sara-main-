/**
 * Companion-video rules and its on-device store.
 *
 * What is checked here: which files are acceptable, how a stored clip is
 * described, that a saved clip really survives (stored blob + metadata, replaced
 * and removed cleanly), and that a browser without local storage says so.
 *
 * What is NOT checked here: decoding and playback. Those need a real `<video>`
 * element and a GPU, so they are covered by the production build and the browser
 * smoke suite — this file makes no claim that a given phone can play a file.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

/** Minimal browser shims, installed before the module is imported. */
class MemoryStorage {
  private data = new Map<string, string>();
  getItem(key: string) {
    return this.data.has(key) ? (this.data.get(key) as string) : null;
  }
  setItem(key: string, value: string) {
    this.data.set(key, String(value));
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
  clear() {
    this.data.clear();
  }
  keys() {
    return [...this.data.keys()];
  }
}

const storage = new MemoryStorage();
(globalThis as unknown as { window: unknown }).window = { localStorage: storage };

const { indexedDB } = await import("fake-indexeddb");
(globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = indexedDB;

type VideoStageModule = typeof import("../src/mobile/videoStage");
type VideoAsset = import("../src/mobile/videoStage").VideoAsset;

const stage: VideoStageModule = await import("../src/mobile/videoStage");
const {
  LARGE_VIDEO_BYTES, MAX_VIDEO_BYTES, clearVideo, describeVideo, formatDuration, formatSize,
  loadVideoBlob, loadVideoMeta, saveVideoFile, validateVideoFile, videoStorageAvailable,
} = stage;

const fakeDecode = async () => ({ durationSec: 12.5, width: 1080, height: 1920, poster: "data:image/jpeg;base64,AAAA" });

function clipFile(name: string, bytes: string, type = "video/mp4"): File {
  return new File([bytes], name, { type, lastModified: 1_700_000_000_000 });
}

const asset = (overrides: Partial<VideoAsset> = {}): VideoAsset => ({
  id: "clip.mp4:1000:0",
  name: "clip.mp4",
  mime: "video/mp4",
  size: 1_048_576,
  addedAt: "2026-10-23T04:00:00.000Z",
  durationSec: 12,
  width: 1080,
  height: 1920,
  poster: null,
  ...overrides,
});

/* ---------------------------------------------------------------- validation */

test("a phone video file is accepted", () => {
  const result = validateVideoFile({ name: "sara-idle.mp4", type: "video/mp4", size: 4_000_000 });
  assert.equal(result.ok, true);
  assert.equal(result.warning, undefined, "a normal clip does not nag");
});

test("an image is rejected with a readable message", () => {
  const result = validateVideoFile({ name: "photo.jpg", type: "image/jpeg", size: 200_000 });
  assert.equal(result.ok, false);
  assert.match(String(result.error), /not a video/i);
});

test("an empty file is rejected", () => {
  const result = validateVideoFile({ name: "clip.mp4", type: "video/mp4", size: 0 });
  assert.equal(result.ok, false);
  assert.match(String(result.error), /empty/i);
});

test("a file over the hard limit is rejected and names the size", () => {
  const result = validateVideoFile({ name: "movie.mp4", type: "video/mp4", size: MAX_VIDEO_BYTES + 1 });
  assert.equal(result.ok, false);
  assert.match(String(result.error), /200\.0 MB/);
});

test("a large but allowed clip is accepted with a storage warning", () => {
  const result = validateVideoFile({ name: "long.mp4", type: "video/mp4", size: LARGE_VIDEO_BYTES + 1024 });
  assert.equal(result.ok, true);
  assert.match(String(result.warning), /storage/i);
});

test("a video extension with no mime type is still accepted", () => {
  // Some Android pickers hand back an empty `type`.
  const result = validateVideoFile({ name: "clip.mov", type: "", size: 1_000 });
  assert.equal(result.ok, true);
});

test("a non-video mime type on a video extension is refused", () => {
  const result = validateVideoFile({ name: "fake.mp4", type: "application/zip", size: 1_000 });
  assert.equal(result.ok, false);
  assert.match(String(result.error), /not a video/i);
});

/* --------------------------------------------------------------- formatting */

test("durations are written the way a person reads them", () => {
  assert.equal(formatDuration(null), "unknown length");
  assert.equal(formatDuration(Number.NaN), "unknown length");
  assert.equal(formatDuration(0), "0:00");
  assert.equal(formatDuration(7), "0:07");
  assert.equal(formatDuration(65), "1:05");
  assert.equal(formatDuration(3_725), "1:02:05");
});

test("sizes are written the way a person reads them", () => {
  assert.equal(formatSize(512), "512 B");
  assert.equal(formatSize(4_096), "4 KB");
  assert.equal(formatSize(5 * 1024 * 1024), "5.0 MB");
});

test("the stored clip is described with name, length, resolution and size", () => {
  assert.equal(describeVideo(asset()), "clip.mp4 · 0:12 · 1080×1920 · 1.0 MB");
});

/* ------------------------------------------------------------ on-device store */

test("a saved clip really is stored, with its blob intact", async () => {
  await clearVideo();
  const saved = await saveVideoFile(clipFile("sara.mp4", "first-frame-bytes"), fakeDecode);

  assert.equal(saved.name, "sara.mp4");
  assert.equal(saved.size, "first-frame-bytes".length);
  assert.equal(saved.durationSec, 12.5);
  assert.equal(saved.width, 1080);
  assert.match(String(saved.poster), /^data:image\/jpeg/);

  const meta = await loadVideoMeta();
  assert.equal(meta?.id, saved.id);
  assert.equal(meta?.name, "sara.mp4");

  const blob = await loadVideoBlob();
  assert.ok(blob, "the blob is readable after saving");
  assert.equal(await blob.text(), "first-frame-bytes");

  // The metadata mirror is what makes the stage paint before the blob decodes.
  assert.ok(storage.getItem("sara.mobile.stage.video.v1"), "metadata mirrored for a fast first paint");
});

test("uploading a second clip replaces the first instead of stacking", async () => {
  await clearVideo();
  await saveVideoFile(clipFile("first.mp4", "aaaa"), fakeDecode);
  await saveVideoFile(clipFile("second.mp4", "bbbb"), fakeDecode);

  const meta = await loadVideoMeta();
  const blob = await loadVideoBlob();
  assert.equal(meta?.name, "second.mp4");
  assert.equal(await blob!.text(), "bbbb");
});

test("removing the clip clears the blob, the metadata and the mirror", async () => {
  await clearVideo();
  await saveVideoFile(clipFile("gone.mp4", "xxxx"), fakeDecode);
  await clearVideo();

  assert.equal(await loadVideoMeta(), null);
  assert.equal(await loadVideoBlob(), null);
  assert.equal(storage.getItem("sara.mobile.stage.video.v1"), null);
});

test("a rejected file stores nothing", async () => {
  await clearVideo();
  await assert.rejects(
    () => saveVideoFile(clipFile("not-a-video.png", "zzzz", "image/png"), fakeDecode),
    /not a video/i,
  );
  assert.equal(await loadVideoMeta(), null);
  assert.equal(await loadVideoBlob(), null);
});

/* ---------------------------------------------------------- unsupported device */

test("a device without local storage is refused instead of pretending", async () => {
  const realIndexedDb = globalThis.indexedDB;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any).indexedDB;
    assert.equal(videoStorageAvailable(), false);
    await assert.rejects(() => saveVideoFile(clipFile("clip.mp4", "data"), fakeDecode), /cannot keep a video/i);
    await clearVideo(); // must not throw
  } finally {
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = realIndexedDb;
  }
});
