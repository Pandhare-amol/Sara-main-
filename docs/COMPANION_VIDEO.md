# Companion video (your own clip as Sara's stage)

On the phone you can upload a video and have that clip stand on the stage
instead of the 3D character. It is remembered, so it is still there the next
time the app starts.

Everything here is client-side. The clip never leaves the device.

## Using it

1. Open the phone app.
2. Tap the film icon in the header (or **menu → Companion look**).
3. **Upload a video** and pick a clip (MP4 / WebM / MOV, up to 200 MB; above
   60 MB you get a storage/battery warning).
4. The clip is decoded and its first frame is captured before it is accepted.
   If the device cannot decode it you get a message rather than a black stage.
5. It plays muted, looping, full-screen behind her captions. Her voice is
   unaffected.

The panel also lets you:

| Control | Effect |
| --- | --- |
| **Replace with another video** | swaps the clip, revoking the old blob URL |
| **Remove** (trash) | deletes the clip from the device and returns to the 3D character |
| **My video / 3D character** | switch the stage without deleting the clip |
| **Fill the screen / Show the whole frame** | `object-fit: cover` vs `contain` |
| **Play the video's sound** | off by default; with it on, some browsers wait for a tap before starting |

## Behaviour details

- **Autoplay**: attempted muted (the only mode browsers allow without a gesture).
  If it is refused, the stage shows **Tap to play** — never a silent frozen frame.
- **Background**: the clip pauses when the app goes to the background
  (`visibilitychange`) and resumes on return.
- **Reduced motion**: when the phone's reduced-motion preference is on, the clip
  holds on its poster frame and offers **Play my video**.
- **GPU/battery**: while your video is showing, the 3D renderer is **not
  mounted** — one animation source, not two competing for the GPU.
- **Failure**: a decode/playback error puts her back on the 3D stage and says so
  in a notice.

## Where the file lives

| Item | Storage |
| --- | --- |
| The video blob | IndexedDB (`sara.mobile.stage`, object store `companion`, key `blob`) |
| Metadata (name, length, resolution, size, poster) | IndexedDB key `meta`, mirrored into `localStorage` (`sara.mobile.stage.video.v1`) for a fast first paint |
| Stage preference (video vs 3D, sound, framing) | `localStorage` (`sara.mobile.prefs.v1`) |

The metadata mirror is only a cache; the IndexedDB record is authoritative. If
IndexedDB is unavailable (some private modes, locked-down webviews) the panel
says so and refuses to pretend the clip was saved.

Nothing is sent to the server, so the video is not in the desktop app, not in a
backup of the server data folder, and not on any other device.

## Validation rules

- Empty files are refused.
- Files that are neither `video/*` nor a known video extension are refused.
- Above `MAX_VIDEO_BYTES` (200 MB) the file is refused with its size named.
- Above `LARGE_VIDEO_BYTES` (60 MB) it is accepted with a warning.
- A file must produce a frame (or metadata) on this device before it is stored;
  otherwise the message suggests an MP4 (H.264) clip.

## Tests

| File | Covers |
| --- | --- |
| `tests/videoStage.test.ts` (15) | validation, formatting, save/replace/remove in a real IndexedDB implementation (`fake-indexeddb`), the blob round-trip, and the no-storage refusal |
| `tests/stageVideo.test.tsx` (5) | play is requested, blocked autoplay shows tap-to-play, paused/reduced-motion pauses, decode error is reported upward, sound toggle is honoured |
| `scripts/smoke-mobile-entry.tsx` | the panel opens from the menu, offers a video picker, keeps the clip on the device and states the storage limitation |

## Limits (not claimed as working)

- A real phone was not used. Playback was verified in jsdom with a stubbed media
  element, which proves the control flow, not the codec.
- Very large clips are stored as-is; there is no transcoding or compression on
  the device.
- The clip is per device and per browser profile. It does not sync, and
  uninstalling the app or clearing site data deletes it.
- The desktop window keeps the 3D character; this setting is phone-only.
