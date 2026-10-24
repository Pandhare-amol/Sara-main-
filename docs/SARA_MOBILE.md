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

## When something does not work

Tap **menu → Self-check**. It now runs the same path a message takes and names
the step that failed instead of saying "something broke":

| Step | What it proves |
| --- | --- |
| Phone network | Android reports a connection |
| Reach Google | the request completed, with a round-trip time |
| API key | Google accepted the key, and how many models it can use |
| Model | the chosen model is in that list — with a fix button if it is not |
| Answer from the model | a real (tiny) question was answered |

The button runs the last step too; it costs one small request. Failures carry the
raw reason (for example `net::ERR_NAME_NOT_RESOLVED`, or `HTTP 403: API key not
valid`), which is what makes a fix possible.

Two transport details that matter in the field:

- the key is sent in the `x-goog-api-key` header, not in the URL, so it cannot
  leak through logs or screenshots; if a proxy strips the header, the app retries
  once with `?key=`;
- a dropped connection is retried once, and a stream that breaks before any text
  arrives is answered with one plain request instead — a weak network no longer
  looks like "Sara is broken".

If a send fails, the message is put back in the box (not duplicated in the log)
and the banner offers **Try again** and **Test connection**.

## Her voice: why "no speech engine" happened

The phone's WebView usually has **no speech synthesis at all** — no
`window.speechSynthesis`, or one with zero voices. That is what produced
"No speech engine — replies stay text".

Installing Google Play services does not fix it, and Play services cannot be
"added" to a web app: it is a system component, and most phones already have it.
The real fix, which this build ships, is a small native bridge
(`SaraVoicePlugin.java` in `android-mobile/`) that speaks through **Android's own
TextToSpeech** — Google Text-to-Speech, Samsung's engine, eSpeak, whatever the
phone has, including on phones with no Google account at all.

- The app now reports the engine it is really using, by name.
- If none is installed, **Customize → Android speech settings** opens the exact
  system screen where one can be installed, and the app says so instead of
  failing silently.
- `SaraVoicePlugin` also declares the TTS service in `<queries>` — without that,
  Android 11+ hides every speech engine from the app.
- The WebView engine is still there as a fallback, and you can force either one
  in Customize → Her voice.

## Customize everything

**menu → Settings** is now a full customization surface. Every control changes
real behaviour:

- **Her brain** — AI key, model (plus *"use only the models my key allows"*, which
  asks Google and lists them), creativity, longest answer, streaming on/off,
  how many remembered turns are sent.
- **Her voice** — read aloud on/off, engine (automatic / Android / WebView), the
  phone's voice list, speed, pitch, volume, how much of a long answer is read,
  *Test the voice*, and the Android speech settings shortcut.
- **How she talks** — six persona profiles, seven trait sliders, three reality
  modes.
- **You** — what she calls you, and your own standing instructions, added word for
  word to every conversation.
- **Look** — five accent colours, three backgrounds, four text sizes, message
  timestamps, the emblem, reduced motion, video sound.
- **Your data** — clear the conversation, forget every memory, reset the settings,
  or erase the key and everything else (asked twice, never silently).

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
- The native speech bridge is compiled into the APK and asserted by CI, but it has
  not been heard on a physical phone here — that check needs your device.
- Speech output still needs *some* engine installed on the phone. If there is
  none, the app opens the settings screen that installs one.
- Reminders are checked while the app is open (every 30 s). An exact-time alarm
  with the app closed would need Android's alarm APIs — not implemented.
- No background listening, no wake word, no continuous voice session (a
  standalone WebView app has no server to hold the audio stream).
