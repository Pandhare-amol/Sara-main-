# Sara Mobile — web app, Android app, and remote access

Sara is now usable from a phone, as an **additional interface to the same Sara**.
Nothing about the desktop app, the character engine, the Gemini Live pipeline,
the memory store or the tool router was replaced: the phone talks to the same
backend, the same `/live` WebSocket and the same `/api/*` routes.

```
                    ┌──────────────────────────────┐
                    │   Sara server (your PC)      │
   desktop ────────►│  server.ts                   │
   (Electron)       │   • Express REST  /api/*     │
                    │   • WS /live  (Gemini Live)  │
                    │   • WS /events (task HUD)    │
   phone web ──────►│   • cognition + memory       │
   (browser)        │   • ToolRouter ──► Windows   │
                    │        desktop agent (:8765) │
   Android APK ────►│                              │
   (Capacitor)      └──────────────────────────────┘
```

## What was added

| Area | Files | Notes |
| --- | --- | --- |
| Remote access layer | `server_remoteAccess.ts`, `server.ts` | Opt-in token auth, CORS allow-list, loopback bypass, desktop-only gating, health endpoint |
| Phone shell | `src/mobile/*` | `MobileApp`, `MobileStage`, panels, session hook, native shell, prefs |
| Backend config | `src/lib/serverConfig.ts` | `apiUrl`, `wsUrl`, `assetUrl`, `authHeaders`, `saraFetch`, timeouts |
| Connect UI | `src/components/ServerConnectionPanel.tsx` | Validates `/api/health` before saving |
| Conversation log | `src/lib/conversationLog.ts` | Device-only last 120 turns (not a memory system) |
| Web/PWA + deploy | `index.html`, `public/*`, `vercel.json`, `netlify.toml` | Manifest, icons, SPA rewrites, security headers |
| Android | `android/`, `capacitor.config.ts`, `scripts/android-assets.sh` | Capacitor 7 project, icons, splash, permissions |
| Cloud APK | `.github/workflows/android-apk.yml` | Debug APK artifact, optional signed release |

The existing UI was kept intact. Every `fetch("/api/…")` in the renderer now
goes through `saraFetch`, which is a no-op on same-origin desktop and adds the
backend URL + token when a remote server is configured. The desktop build,
Electron shell and character studio are unchanged.

## Which UI do I get?

- **Desktop (Electron / `npm run dev`)** — the original full UI.
- **Phone in a browser, or the Android app** — the focused mobile shell
  (avatar, one microphone button, text composer, compact menu).
- Force either with `?ui=mobile` or `?ui=desktop`; the choice is remembered.

Narrow screens with a coarse pointer get the mobile shell automatically.
Rotate to landscape or resize and it keeps working; `?ui=desktop` still gives the
full dashboard on a tablet.

## Running it

```bash
npm install
npm run dev            # backend + Vite on http://localhost:3000
```

Open `http://localhost:3000` on the PC as before.

### Phone on the same Wi-Fi (no tunnel)

Local-only mode binds to `127.0.0.1`, so a phone cannot reach it. Use one of the
options below instead; a plain `http://192.168.x.x:3000` will not work in the
Android app because cleartext HTTP is blocked (and browser microphone access is
restricted on non-secure origins).

### Phone over HTTPS (recommended)

1. Generate a token and start the server in remote mode:

   ```bash
   export SARA_REMOTE_ACCESS=1
   export SARA_ACCESS_TOKEN="$(openssl rand -hex 32)"     # keep this
   export SARA_ALLOWED_ORIGINS="https://your-app.vercel.app"
   npm run dev
   ```

2. Expose port 3000 over HTTPS. Either a tunnel:

   ```bash
   cloudflared tunnel --url http://localhost:3000
   # → https://random-name.trycloudflare.com
   ```

   or a reverse proxy (nginx) that terminates TLS and forwards WebSocket
   upgrades to `127.0.0.1:3000` (`/api`, `/live`, `/events`).

3. Open the web app on the phone → **Connect to Sara** → enter
   `https://random-name.trycloudflare.com` and the token → **Test connection**.

4. Optionally install it to the home screen (Chrome → *Add to Home screen*), or
   use the APK (see [ANDROID.md](./ANDROID.md)).

> The token is a shared secret for one server. Rotate it by restarting the
> server with a new value; every device must reconnect.

## Security model

| Rule | Where |
| --- | --- |
| Remote mode is **off** unless `SARA_REMOTE_ACCESS=1` | `loadRemoteAccessConfig` |
| Remote mode **refuses to start** without a token ≥ 24 chars | same |
| Tokens compared in constant time over SHA-256 digests | `tokenMatches` |
| Origin allow-list, explicit CORS (no `*`) | `createRemoteAccessGuard` |
| Requests from the PC itself bypass the token (loopback TCP peer, not a header) | `isLoopbackPeer` |
| `/api/logs`, `/api/proxy`, `/api/screen-vision`, character import, companion, debug: **desktop only** for remote clients unless `SARA_REMOTE_ALLOW_DESKTOP=1` | `DESKTOP_ONLY_PATHS` |
| PC-driving voice tools (`startTask`, `sendChatMessage`, `companionAction`, …) refused for remote sessions unless opted in | `REMOTE_BLOCKED_LIVE_TOOLS` |
| Gemini key never leaves the server; no `VITE_*` secret | `check-bundle-secrets` in CI |
| APK blocks cleartext HTTP | `network_security_config.xml` |
| The Android app never runs the Node backend or the desktop agent | architecture |

The Gemini API key is still entered on the computer (or through the phone's
key screen, which posts it once to the server and stores nothing locally).

## Feature matrix (phone)

| Feature | State | Notes |
| --- | --- | --- |
| Voice conversation (Gemini Live) | ✅ works | Same `/live` bridge; mic needs a tap (browser/Android rule) |
| Text conversation | ✅ works | Works with the mic denied; Sara's audio still plays |
| Barge-in / stop speaking | ✅ works | Stop button calls the existing interruption path |
| Conversation history | ✅ device log | Last 120 turns per device; server memory is separate |
| Memory (view/add/delete) | ✅ works | `/api/memories` (shared with desktop) |
| Missions + approvals | ✅ works | `/api/tasks`, `/api/confirmations`, `/events` |
| Connection & diagnostics | ✅ works | `/api/health`, `/api/agent-health` |
| Theme change by voice | ✅ works | `changeBackground` tool |
| Avatar (imported MMD model) | ✅ if imported | Streamed from the PC; the public build bundles no model (licence) |
| PC automation from the phone | ⚠️ opt-in | `SARA_REMOTE_ALLOW_DESKTOP=1`; risky actions still ask for approval |
| Screen sharing / vision | ❌ desktop only | Marked unsupported on the phone |
| Camera vision (single photo) | ✅ works | `POST /api/mobile/vision`; downscaled on the phone, needs a Gemini key |
| Wake phrase | ⚠️ browser-dependent | Web Speech API; Android may stop it in background |
| Character import / studio | ❌ desktop only | Needs the local file picker and model files |
| Offline mode | ⚠️ graceful failure | Clear "server unreachable" state; no offline AI |
| Today / briefing | ✅ works | `GET /api/mobile/briefing` — one composed view of tasks, reminders, approvals, goals |
| Automations history | ✅ works | `GET /api/mobile/automations` — real schedules + audit log |
| Self-check | ✅ works | `GET /api/mobile/diagnostics` — live probes, `unknown` where unproven |
| Personality / reality mode | ✅ works | Persona + Reality Mode below |
| Emergency stop from the phone | ✅ works | `POST /api/mobile/stop` (arms first; also denies pending approvals) |
| Call reporting / answering | ⚠️ partial, by platform | Android app reports call state and places approved calls; Sara cannot speak into a cellular call — see [COMMUNICATION.md](./COMMUNICATION.md) |
| Messages (WhatsApp Cloud API) | ⚠️ needs provider credentials | Draft → approve → send, verified by the provider's message id; webhook inbound. See [CAPABILITIES_AND_MESSAGING.md](./CAPABILITIES_AND_MESSAGING.md) |
| Capability list | ✅ works | Self-check → "What this setup can do"; the model is given the same list |
| Call policy, messages, summaries | ✅ works | `Settings → Calls`, `Calls → Policy` on the phone; summaries use only reported material |

## Personality and Reality Mode

Two independent settings, stored with the other server settings
(`settings/appSettings.ts`) and edited from **Personality** and **Reality mode**
in the desktop settings panel, or **How she talks** on the phone.

**Personality** changes delivery only. A profile (Companion, Friend, Mentor,
Professional, Executive, Emergency) preloads seven 0–100 dials — warmth, humour,
formality, directness, empathy, energy, curiosity — plus a context
(personal / professional / both). The fragment is appended to the live system
instruction, so the same rules apply to voice, text and the phone. It is
explicitly told that it cannot change facts, correctness, permissions or skip a
confirmation; the test suite asserts that wording.

**Reality Mode** is about honesty:

| Mode | Behaviour |
| --- | --- |
| `off` | Natural answers; no labelling taxonomy. Invented facts are still forbidden. |
| `standard` (default) | FACT / ASSUMPTION / PREDICTION / RECOMMENDATION / UNKNOWN labels where it matters; "what I know" vs "what I infer". |
| `strict` | The standard set plus counter-evidence for its own recommendation, premise correction, and CONFIDENCE (high/medium/low). |

`challengeAssumptions` (default on) additionally requires naming an unverified
assumption at least once. In every mode the model is told that a failed tool is
never reported as done, and that emotional inference is an estimate, not a
diagnosis.

Switching profiles automatically from inferred mood is **not implemented**. She
uses the profile you chose; the docs and the settings screen say so rather than
implying an adaptive engine that does not exist.

Reality Mode labels Sara's language. It is not a fact-checking service: a "FACT"
means "known to me", not "verified against the world just now". The docs and the
UI both say so.

## Mobile API (composition layer)

Four endpoints, mounted from `server_mobileApi.ts` by `server.ts`. They read the
existing stores — no new database, no second memory, no parallel policy — and
every response carries `sources` and honest `notes`.

| Endpoint | Returns | Notes |
| --- | --- | --- |
| `GET /api/mobile/briefing` | Counts, reminders due today, tasks needing you, approvals, open goals, PC status | `pc.availableFromThisDevice` is false when the agent is unreachable or remote PC control is off |
| `GET /api/mobile/diagnostics` | Key, models, agent, memory, scheduler, remote access, reality mode | States are `ok` / `attention` / `offline` / `unknown` |
| `GET /api/mobile/automations` | Scheduled reminders and timers, repeating count, skills, recent audit | Includes the note that long-running watchers are **not** implemented |
| `POST /api/mobile/vision` | Answer, model id, latency, reality mode | JPEG/PNG/WebP, ~4 MB cap, 12/minute, 45 s abort, 409 when no key |
| `POST /api/mobile/stop` | Stopped task count, denied approvals | Same `emergencyStop` as the desktop shortcut, then denies pending confirmations so nothing resumes on a stale approval |

The phone UI (`src/mobile/MobileIntelPanels.tsx`) adds **Today**,
**Automations**, **Look at this**, **How she talks**, **Self-check** and
**Stop everything** to the existing menu. Photos are downscaled to 1280 px JPEG
on the device before upload.

## Tests

```bash
npm run test:remote-access   # security boundary for phone access
npm run test:mobile          # URL/token resolution, conversation log
npm run test:persona         # persona/reality prompts + /api/mobile/* wire behaviour (33 tests)
npm run test:ui              # jsdom smoke tests: phone shell (36 checks) + desktop shell (6)
npm run build:web && npm run check:bundle-secrets
```

Results, including what could not be verified here, are in
[MOBILE_TEST_REPORT.md](./MOBILE_TEST_REPORT.md).

## Reduced motion and low-end phones

Settings (phone) → **Reduced motion**, **Show avatar**. `prefers-reduced-motion`
is honoured on first run. With the avatar off, the stage shows a lightweight
emblem; particles stop; no animation loop runs. The OS keyboard is tracked with
`visualViewport` so the composer stays visible, and the Android activity uses
`adjustResize`.

## Static hosting (Vercel / Netlify)

`vercel.json` and `netlify.toml` are included. Build command `npm run build:web`,
output `dist`, SPA rewrite, cache and security headers.

The static site is only the **UI**. It must be pointed at a reachable Sara
backend (Connect screen, `VITE_SARA_API_BASE` at build time, or
`public/runtime-config.js` on the host). The Node backend, cognition and desktop
agent cannot run on a static host — see [DEPLOYMENT.md](./DEPLOYMENT.md).
