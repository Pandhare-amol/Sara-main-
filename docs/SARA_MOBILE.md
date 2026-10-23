# Sara Mobile — the standalone app

Sara Mobile is a **separate app** (`ai.sara.mobile`) that runs on the phone. It
does not connect to the PC app, does not read PC Sara's memory or settings, and
does not need a server running anywhere.

There are now two phone builds in this repository, and they are independent:

| | **Sara Mobile** (this app) | **Sara** (`ai.sara.companion`) |
| --- | --- | --- |
| Where the brain runs | on the phone, straight to Google | on your PC (Sara server) |
| Needs a computer | no | yes (`npm run phone`) |
| AI key lives | on the phone | on the PC |
| Memory, reminders, settings | this phone only | the PC's data folder |
| PC control / WhatsApp / screen capture | not included | included |
| Install | `apk-mobile-latest` release | `apk-latest` release |

Both can be installed side by side.

---

## Install and first run

1. On the phone open
   **https://github.com/Pandhare-amol/Sara-main-/releases/tag/mobile-apk-latest**
   and download `sara-mobile-<commit>.apk`.
2. Tap it → allow installing from that source → **Install**.
3. Open **Sara Mobile**. A banner reads *Add your AI key to start*.
4. Tap it, paste a key from
   [Google AI Studio](https://aistudio.google.com/apikey), **Save key on this
   phone**, tap **Close**.
5. Ask her something. That is the whole setup — no address, no token, no PC.

## What it does

| Feature | How it works |
| --- | --- |
| Chat | Streaming answers over Server-Sent Events from Google's REST API |
| Voice | Hold the mic → the note is transcribed by Gemini → she answers → the phone's own speech engine reads it |
| Camera | One photo, downscaled on the device, sent once, answered; never stored |
| Memory | “remember that …” or the Memory sheet; stored locally and added to her context |
| Reminders | “remind me to … in 20 minutes / at 18:30 / tomorrow” — parsed on the device, no model needed |
| Personality | The same six profiles and reality modes as the desktop app (`server_persona.ts` is shared, not copied) |
| Model | Flash, Flash Lite, Flash 3.8 or Pro, whichever your key can use |
| Companion look | Your own video can take the stage, stored on the phone |

Everything is backed by real code paths — there is no mock and no “demo mode”.

## What it deliberately does not do

The app states these in **menu → What this app does** rather than hiding them:

- controlling the PC (apps, files, mouse, keyboard, browser),
- WhatsApp / Telegram / Slack sending,
- answering phone calls, meeting transcription,
- long multi-step tasks, schedules and approvals.

They belong to the PC app, which still has them. A phone-only app has no computer
to act on, and pretending otherwise would be a lie in the UI.

## Where things live on the device

| Item | Storage |
| --- | --- |
| AI key | `localStorage` → `sara.mobile.gemini-key.v1` (plain text, app-private) |
| Memory | `sara.mobile.memory.v1` (max 300 entries) |
| Conversation | `sara.mobile.messages.v1` (max 200 turns) |
| Reminders | `sara.mobile.reminders.v1` (max 200) |
| Settings (persona, reality, model) | `sara.mobile.settings.v1` |
| Companion video | IndexedDB `sara.mobile.stage` |

Clearing the app's data in Android settings removes all of it.

## The key trade-off, stated plainly

The desktop app keeps the key on the PC; this app cannot, because there is no
server. So the key sits in the app's storage, readable by anyone who can unlock
the phone and reach app data. It is never written into the bundle, never logged,
and is only ever sent to `generativelanguage.googleapis.com`.

If that is not acceptable, use the client app with `npm run phone` instead — that
is exactly why both exist.

## Architecture

```
mobile.html → src/mobileStandalone.tsx → src/mobile/standalone/StandaloneApp.tsx
                                            ├── engine.ts      turns, commands, prompts
                                            ├── gemini.ts      REST + SSE + error mapping
                                            ├── store.ts       memory / reminders / chat / settings
                                            ├── deviceKey.ts   key storage
                                            ├── voice.ts       recorder + speech
                                            └── panels.tsx     sheets
```

Shared with the desktop app (imported, not duplicated): `server_persona.ts`,
`src/mobile/image.ts`, `src/mobile/mobilePrefs.ts`, `src/mobile/videoStage.ts`,
`src/mobile/StageVideo.tsx`.

The build enforces separation: `scripts/prepare-mobile-web.mjs` fails if the
standalone bundle contains `/api/`, `saraFetch`, `wsUrl(` or the server-config
storage key. Today it contains none of them.

## Build it yourself

```bash
npm run build:mobile    # dist-mobile (guard: no server dependencies)
npm run mobile:sync     # copies the assets into android-mobile/
cd android-mobile && ./gradlew assembleDebug
```

CI does this in the `Build Sara Mobile APK (standalone)` job and publishes the
APK to the `mobile-apk-latest` release.

## Known limits

- Not run on a physical phone in this workspace. The APK is built and its
  identity verified by CI; the app's screens were exercised in a jsdom smoke run.
- A real Google key was not available here, so **live model answers were not
  verified end to end** — the request/stream/error handling is covered by tests
  against a stub.
- Speech output uses the phone's engine; some Android builds ship none. The app
  checks and says so instead of failing silently.
- Reminders are checked while the app is open (every 30 s). An exact-time alarm
  with the app closed would need Android's alarm APIs — not implemented.
- No background listening, no wake word, no continuous voice session (a
  standalone WebView app has no server to hold the audio stream).
