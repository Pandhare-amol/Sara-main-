# Sara Mobile — test report

Everything below was executed in this workspace or on GitHub-hosted runners on
**2026-10-23**. Nothing here is a projection: where a test could not run, it is
listed as SKIPPED with the reason.

| # | Check | Result | Evidence |
| --- | --- | --- | --- |
| 1 | TypeScript (`npm run lint`, includes server, renderer, Capacitor config) | **PASS** | `tsc --noEmit`, 0 errors |
| 2 | Existing agent/unit suites (`npm run test:agent`) | **PASS** | 46 pass, 0 fail, 1 skip (DPAPI is Windows-only) |
| 3 | Character asset/registry tests (`npm run test:characters`) | **PASS** | all pass, 1 skip |
| 4 | Remote-access security tests (`npm run test:remote-access`) | **PASS** | 13/13 |
| 5 | Mobile helper tests (`npm run test:mobile`) | **PASS** | 6/6 (URL/token resolution, conversation log, emotion cue) |
| 6 | UI smoke tests (`npm run test:ui`, jsdom) | **PASS** | phone shell 15/15 (all panels), desktop shell 6/6 |
| 7 | Production web build (`npm run build:web`) | **PASS** | `dist/` 13 files; desktop `App` + `MobileApp` + `three` split into separate chunks (phone never downloads the studio) |
| 8 | No secrets in the browser bundle (`npm run check:bundle-secrets`) | **PASS** | scanned 13 built files, no keys/tokens/private keys |
| 9 | Backend remote-access integration (real server, curl) | **PASS** | see table below |
| 10 | Capacitor sync (`npx cap sync android`) | **PASS** | 2 plugins, `assets/public/index.html` copied |
| 11 | CI: web build, types, unit + UI tests (`android-apk.yml` → web-checks) | **PASS** | run [39890004715](https://github.com/Pandhare-amol/Sara-main-/actions/runs/39890004715) |
| 12 | CI: Android SDK, Gradle debug build, APK verification + upload | **PASS** | same run, job *Build APK* |
| 13 | Real APK artifact exists | **PASS** | `sara-debug-apk`, 5,350,727 bytes, sha256 `7e11d5c50d68fc9c1c7b3dfc409dc4567040e7171491a6da656704bf2b158ca8` |
| 14 | APK contains manifest, DEX and bundled web assets | **PASS** | verified on the runner: `AndroidManifest.xml`, `classes.dex`, `assets/public/index.html` |
| 15 | APK bundles local assets (no dev-server URL, cleartext disabled) | **PASS** | `capacitor.config.json` checked for absence of `url` and presence of `"cleartext": false` |
| 16 | Desktop app regression | **PASS (render)** | jsdom smoke mounts the original UI; types + production build unchanged. No pixel/GPU check was possible here. |
| 17 | Python desktop-agent tests (`npm run test:python`) | **SKIPPED** | needs Windows + `desktop_agent/requirements.txt` (pywin32, pyautogui, pycaw…). They are untouched by this work. |
| 18 | Signed release APK | **SKIPPED** | no signing secrets configured; the workflow produces a debug APK and says so instead of faking a release. |
| 19 | Vercel/Netlify deployment | **SKIPPED** | no hosting credentials in this environment. Build + SPA rewrite config is committed and CI-verified. |
| 20 | Live Gemini conversation (voice/text) | **SKIPPED** | requires the user's own API key and a microphone. The pipeline itself is unchanged; the phone reuses it. |
| 21 | Install/run on a physical Android device | **SKIPPED** | no device or emulator here. Only the cloud compilation and APK content check were performed — this is not claimed as device testing. |
| 22 | Camera vision on the phone | **NOT IMPLEMENTED** | deliberately not simulated; the Help screen says so. |

## Backend integration details (item 9)

Real `node dist/server.cjs` with `SARA_REMOTE_ACCESS=1`, a token and one allowed
origin:

| Request | Result |
| --- | --- |
| `GET /api/health` (no token) | 200 `{ok, name:"Sara", version, remoteAccess:true}` |
| `GET /api/config` (no token) | 401 `SARA_AUTH_REQUIRED` |
| `GET /api/config` (`Authorization: Bearer …`) | 200, no key leaked |
| `GET /api/memories` (no token) | 401 |
| `GET /api/memories` (token) | 200 |
| `GET /api/health?access_token=…` (asset/WS style) | 200 |
| `GET /` and `/manifest.webmanifest` (no token) | 200 (SPA shell is public) |
| `GET /user-characters/...` (no token) | 401 (model files stay protected) |
| `GET` with `Origin: https://evil.example.com` | 403 |
| `OPTIONS` preflight from the allowed origin | 204 + explicit CORS headers |
| `GET /api/logs/startup.log` (token, remote desktop off) | 403 `SARA_DESKTOP_ONLY` |
| Local (desktop) requests while remote mode is on | unchanged, no token needed (loopback peer) |

## Two defects found and fixed by the new tests

1. **Remote mode would have broken the desktop app.** The first version of the
   guard required a token whenever an `Origin` header was present, and the
   Electron window sends `http://localhost:3000`. Fixed by keying the local
   bypass on the TCP peer address (`isLoopbackPeer`), not on spoofable headers.
2. **The Help & diagnostics panel crashed** where Vite's `__APP_VERSION__`
   define was absent. Found by the jsdom UI smoke test, now guarded.

A third, pre-existing issue was fixed so CI can be strict: the confirmation
broker test awaited an *unref'd* 20 ms timer, so Node's test runner cancelled it
once the event loop drained. The test now holds the loop open (production
behaviour unchanged).

## How to reproduce

```bash
npm ci
npm run lint
npm run test:agent && npm run test:characters
npm run test:remote-access && npm run test:mobile && npm run test:ui
npm run build:web && npm run check:bundle-secrets

# backend behaviour
SARA_REMOTE_ACCESS=1 SARA_ACCESS_TOKEN=$(openssl rand -hex 32) npm start
curl -s localhost:3000/api/health

# Android (cloud, no Android Studio)
gh workflow run android-apk.yml --ref main
```
