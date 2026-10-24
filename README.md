# Sara 1.5.2 — source code mayra 

Sara is a 3D AI companion for Windows: she talks with you by voice (Google Gemini Live),
can see your screen when you allow it, controls apps and files on your PC, and lives on your
desktop as a character you can drag onto windows.

This pack is the full source. If you just want to use Sara, install the setup .exe instead.

## What is NOT included (on purpose)

- **No API key.** You use your own free Gemini key from https://aistudio.google.com.
- **No 3D character model.** The models used while developing Sara have licences that forbid
  redistribution. Import your own MMD model (.pmx, or a .zip / folder containing one) in the app:
  the first screen offers **Import my character**, or use Settings → Character → Character Studio.
  Only use models whose licence allows your use.
- No personal data, logs, memories or settings.

## Requirements

- Windows 10 or 11 (64-bit)
- Node.js 20 or newer (https://nodejs.org)
- Python 3.11 (only to run or rebuild the desktop agent from source)

## Run it in development

```
npm install
pip install -r desktop_agent/requirements.txt
npm run dev
```

Open http://localhost:3000 in Chrome. The first screen asks for your Gemini API key
(stored encrypted with Windows DPAPI in your user data folder, never in the project).

Desktop app (Electron, with the desktop companion):

```
npm run app
```

Optional: copy `.env.example` to `.env` for development settings. Do not put a real key in a file
you share.

## Build the installer

1. Build the desktop agent (PyInstaller):
   ```
   pip install pyinstaller
   pyinstaller desktop_agent.spec --distpath agent_dist --workpath agent_build
   ```
2. Build the public installer (no bundled character):
   ```
   npm run dist:public
   ```
   Output: `release-public/Sara-Setup-<version>.exe`

`npm run dist` (electron-builder.yml) expects a character in `assets/characters/`, which is not
included; use `dist:public`.

## Two ways to have Sara on your phone

| | **Sara Mobile** — standalone | **Sara** — client of your PC |
| --- | --- | --- |
| Release | [apk-mobile-latest](https://github.com/Pandhare-amol/Sara-main-/releases/tag/mobile-apk-latest) | [apk-latest](https://github.com/Pandhare-amol/Sara-main-/releases/tag/apk-latest) |
| Package | `ai.sara.mobile` | `ai.sara.companion` |
| Brain | on the phone (your AI key, direct to Google) | on the PC (`npm run phone`) |
| Needs the PC on | no | yes |
| Shares memory or settings with the PC | no | yes (it is the same Sara) |
| PC control, WhatsApp, screen capture | not included | included |

Both install side by side. **Sara Mobile** is the one to use when the laptop is
off; read [docs/SARA_MOBILE.md](docs/SARA_MOBILE.md) for install steps, what it
does, what it honestly cannot do, and where its data lives.

## Sara as a client of your PC (web + Android)

The phone is another client of the **same** backend, memory, tools and policy —
not a second Sara. Every PC feature is reachable there or says why it is not
([docs/MOBILE_PARITY.md](docs/MOBILE_PARITY.md)).

### Install the Android APK (fastest way to try it)

1. On the PC: `npm install` then **`npm run phone`**. It prints an access token
   and one or more `http://192.168.x.x:3000` addresses.
2. On the phone: open
   **[the rolling test release](https://github.com/Pandhare-amol/Sara-main-/releases/tag/apk-latest)**
   and install `sara-debug-<commit>.apk` (allow the unknown source).
3. In the app's **Connection** screen paste the address and the token →
   *Test connection* → *Save & connect*.
4. If the PC has no Gemini key yet, Sara asks for it once (validated on the PC).

Full walkthrough, what to check, and troubleshooting:
**[docs/APK_TESTING.md](docs/APK_TESTING.md)**. The debug APK allows plain
`http://` on your own network; release builds stay HTTPS-only.

### Other ways to run the phone UI

- **Mobile web app** — open the deployed site (or `http://localhost:3000` on a
  narrow screen, or append `?ui=mobile`).
- **Build the APK yourself** — the same Capacitor project is compiled by GitHub
  Actions (`.github/workflows/android-apk.yml`); no Android Studio needed.

To expose the server yourself instead of `npm run phone`:

```bash
export SARA_REMOTE_ACCESS=1
export SARA_ACCESS_TOKEN="$(openssl rand -hex 32)"
export SARA_ALLOWED_ORIGINS="https://your-web-app.vercel.app"
npm run dev
# then expose http://localhost:3000 with cloudflared/nginx (HTTPS + WebSockets)
```

More: [docs/MOBILE.md](docs/MOBILE.md) · [docs/APK_TESTING.md](docs/APK_TESTING.md) ·
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) · [docs/MOBILE_TEST_REPORT.md](docs/MOBILE_TEST_REPORT.md).

Phone limitations are stated in the app itself: continuous screen streaming and
the 3D Character Studio stay on the desktop, character import happens on the PC
(the model then streams to the phone), and PC automation from a phone is opt-in
(`SARA_REMOTE_ALLOW_DESKTOP=1`). One-shot **PC screen** capture and camera vision
work from the phone.

## Project map

| Folder | What it is |
|---|---|
| `src/` | React UI, the 3D character engine (three.js, MMD/PMX), desktop companion renderer |
| `electron/` | Desktop shell: windows, tray, desktop companion brain, crash recovery |
| `server.ts`, `runtime/` | Local backend (Express + WebSocket), Gemini Live bridge |
| `agent/` | PC-control agent: planner, actions, WhatsApp/chat helpers, safety checks |
| `desktop_agent/` | Python tool server (UI Automation, input, files, apps) |
| `models/` | Model router (Gemini and others) |
| `voice/` | Live voice tools |
| `settings/`, `permissions/`, `secrets/` | Settings, permission engine, DPAPI key store |
| `character_import/` | PMX importer and capability report |
| `cognition/`, `memory/`, `presence/` | Memory, initiative and presence |
| `src/mobile/`, `server_remoteAccess.ts` | Phone shell and the opt-in remote-access layer |
| `server_persona.ts`, `settings/appSettings.ts` | Personality profiles/dials and Reality Mode (fact vs assumption labelling) |
| `server_mobileApi.ts` | `/api/mobile/*` composition layer: briefing, diagnostics, automations, vision, stop |
| `communication/` | Call manager, answering policy, caller identity and the authenticated device bridge |
| `android/.../SaraCallsPlugin.java` | Android call-state events and approved call actions |
| `capabilities/` | Live capability registry: what can run now on the server, the PC and this phone |
| `communication/messaging/` | Provider-addressed messaging (official WhatsApp Cloud API) with approval and verification |
| `android/`, `capacitor.config.ts` | Capacitor Android project (built in CI) |
| `scripts/android-assets.sh` | Regenerates launcher icons and splash screens |
| `public/`, `vercel.json`, `netlify.toml` | PWA assets and static deployment config |

## Tests

```bash
npm run lint
npm run test:agent
npm run test:characters
npm run test:remote-access
npm run test:mobile
npm run check:bundle-secrets   # after `npm run build:web`
```

`npm test` also runs the Python desktop-agent tests, which need Windows and
`desktop_agent/requirements.txt`.

## Graphics quality

Settings → Character → Graphics quality: Auto, High, Medium, Optimized, Potato PC.
Auto steps down by itself if the character crashes on a weak GPU.

## Safety

- The API key never reaches the web page; all Gemini calls go through the local backend.
- High-risk actions (sending messages, deleting, installing, purchases) ask for confirmation.
- Text from websites, documents and the screen is treated as untrusted data.
- Stop everything any time with the emergency shortcut (default Ctrl+Alt+Shift+S).
