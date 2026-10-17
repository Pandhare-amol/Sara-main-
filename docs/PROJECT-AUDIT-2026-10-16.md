# Sara 1.5.2 project audit

**Audit date:** 2026-10-16  
**Scope:** architecture, build, automated tests, local-network security, Electron boundaries, dependency audit, and missing release checks.

## 1. What this project is

Sara is a Windows-first 3D AI desktop companion. It combines four main runtime layers:

1. **Electron shell (`electron/`)** — launches and supervises the backend, owns the privileged desktop windows, tray, native capture, notifications, and companion window.
2. **React/three.js renderer (`src/`)** — voice/chat UI, onboarding/settings/task HUD, character import/studio, and the PMX/MMD character renderer.
3. **Node backend (`server.ts`, `runtime/`, `agent/`, `models/`, `cognition/`)** — local REST/WebSocket server, Gemini Live bridge, model routing, memory, permissions, task execution, presence, and cognition.
4. **Python desktop agent (`desktop_agent/`)** — Windows UI Automation, input, files, applications, screenshots/OCR, system controls, and Explorer integration over a loopback FastAPI service.

The expected packaged flow is:

```text
Electron renderer
  -> Node server on 127.0.0.1:<dynamic port>
     -> Gemini/cloud model providers
     -> frozen Python desktop agent on 127.0.0.1:8765
        -> Windows APIs / UI Automation
```

Persistent user data is kept outside the installation under Electron's `MYRAA` user-data directory. Gemini credentials use Windows DPAPI. User-supplied character models are staged in the per-user character library rather than redistributed.

## 2. Important defects found and fixed

| Severity | Finding | Resolution |
|---|---|---|
| Critical | The obsolete `/api/web-proxy` served arbitrary remote HTML and scripts under Sara's trusted localhost origin while stripping CSP/frame protections. A proxied hostile page could therefore access same-origin private APIs. | Removed the HTML proxy, scraper proxy, and unused YouTube proxy routes. Added a regression check and real 404 handling for unknown `/api/*` routes. |
| High | Electron's privileged main window had no `will-navigate` guard, popup handling could allow local popups, and media permission was not tied to the requesting origin. | Restricted privileged windows, IPC capture/file-picker calls, microphone, and display capture to Sara's exact origin. External HTTP(S) links open only in the real browser. Enabled explicit renderer sandboxing. |
| High | REST and WebSocket origin checks accepted any localhost port. A different local website could connect to Sara's `/live` or `/events` socket. | Browser origin must now match the request Host including port. Cross-port and `null` origins are rejected. |
| High | Outbound API health/adapter requests followed redirects without DNS/private-address validation on every hop. Several response-size checks happened only after the entire body was buffered. | Centralized safe redirect handling, DNS validation, reserved/private IP rejection, and bounded streaming response reads. Applied it to the API catalogue, provider checks, adapters, and page fetcher. |
| High | Initial `npm audit` reported **1 critical, 12 high, 13 moderate, and 1 low** vulnerability. | Updated lockfile dependencies within supported semver ranges. Current result is **0 critical, 0 high, 8 moderate**; the remaining advisories are in `electron-builder` and its build-time dependency chain. |
| Medium | Confirmation expiry used an unreferenced timer. The promise could remain unresolved as the process/test runner exited. Already-aborted signals were also missed. | Kept the expiry timer referenced, handled pre-aborted signals, removed abort listeners after resolution, and added regression coverage. |
| Medium | `MYRAA_ENABLE_COGNITION=false` still started the autonomous-mind timer. | Disabled cognition now leaves the autonomous mind stopped; covered by a test and production smoke check. |
| Medium | SIGINT/SIGTERM installed a handler but did not close the HTTP/WebSocket server, so `Ctrl+C` could leave the backend alive indefinitely. | Added bounded graceful shutdown, socket termination, state persistence, and a five-second forced-exit fallback. |
| Medium | The Python desktop agent enabled CORS for localhost:3000 even though only the Node backend should call it. | Removed browser CORS exposure and retained the loopback Node bridge as the only supported caller. |
| Low | Unknown API URLs returned the SPA HTML with HTTP 200. | Added a JSON 404 handler before the SPA fallback. |
| Low | Production server builds emitted four `import.meta`/CommonJS warnings. | Reworked module resolution and the TGA CLI guard; production build is warning-free. |
| Low | `npm run clean` used Unix `rm` even though this is a Windows project. | Replaced it with a cross-platform Node cleanup command. |
| Low | The default `npm test` omitted cognition, API-hub, screen-vision, real-browser, and live-test suites. | Added `test:node`/`test:live`; `npm test` now runs the complete automated suite. |
| Low | TypeScript's implicit include picked up generated `dist` JavaScript and could fail while a clean/build occurred. | Added explicit TypeScript include/exclude rules. |
| Low | The main application chunk crossed the configured 800 kB warning threshold after dependency updates. | Split React, Motion, and icon code into cached chunks; the main minified chunk is now about 694 kB. |
| Low | Python agent health reported version 1.0.0 while the application is 1.5.2. | Synchronized the agent version to 1.5.2. |
| Missing | There was no CI workflow. | Added a Windows GitHub Actions job for Node/Python dependency installation, the full test suite, and a production build. |

## 3. Validation performed

### Automated checks

- `npm run lint` — passed.
- `npm run test:node` — all enabled Node tests passed; hardware/key-dependent live tests and unavailable character archives skip intentionally.
- Python unit tests in an isolated environment — **32 run, 3 Windows-only skips, 0 failures**.
- `npm run build` — passed with no esbuild warnings and no oversized-chunk warning.
- `node --check` on Electron main/companion files — passed.
- `git diff --check` — passed.

### Production backend smoke checks

A production bundle was started on a temporary loopback port and verified:

- same-origin `/api/config` -> HTTP 200;
- cross-port browser origin -> HTTP 403;
- removed `/api/web-proxy` -> HTTP 404;
- disabled cognition -> `enabled=false`, `mindRunning=false`;
- SIGTERM -> clean process exit.

### Dependency audit

Current `npm audit` result:

```text
critical: 0
high:     0
moderate: 8
low:      0
```

The eight remaining moderate findings are confined to the installer/build chain (`electron-builder`, `app-builder-lib`, `global-agent`, and related transitive packages). The registry currently offers no newer safe `electron-builder` release in the declared line; the suggested remediation is a downgrade, so it was not forced without a Windows installer regression run.

## 4. Remaining gaps and risks

### Release-blocking checks still needed on Windows

1. Build the frozen Python agent with PyInstaller and verify its packaged tool count.
2. Run `npm run dist:public` and install both NSIS and portable artifacts on a clean Windows 10/11 VM.
3. Verify DPAPI save/reload/migration under two Windows users.
4. Exercise real microphone, Gemini Live, barge-in, native display capture, and screen-vision fallback with a user-owned API key.
5. Exercise the actual Windows UI Automation flows for messaging, Explorer selection, app launch, emergency stop, and power confirmations.
6. Import representative licensed PMX/ZIP models and run the character runtime report; the repository intentionally contains no distributable model fixtures.

### Security hardening still recommended

- Add a per-launch authentication secret between the Node backend and the Python agent. Loopback plus removed CORS prevents normal cross-site browser access, but the agent currently trusts arbitrary local processes.
- Consider pinning outbound connections to the DNS result used by URL validation. Every hop is now checked, but ordinary `fetch` performs its own DNS resolution, leaving a narrow DNS-rebinding time-of-check/time-of-use window.
- Add CSP/security headers for the local renderer and automated tests for them.
- Add code signing and installer signature verification to the release process.

### Maintainability/documentation gaps

- `server.ts` remains a very large multi-responsibility module. Split bootstrapping, local request policy, REST routes, Gemini Live handling, and process supervision into testable modules.
- Product naming still alternates between **Sara** and **MYRAA**, and `docs/FINAL-UPDATE-REPORT.md` describes version 1.4.2 while the package is 1.5.2.
- The repository has no root `LICENSE`, `SECURITY.md`, or contribution guide. Add the correct legal documents before public distribution; the audit does not assume which license the owner intends.
- Add an automated backend integration test that starts the production server and checks host/origin policy, API 404 behavior, WebSocket rejection, and graceful shutdown (these were smoke-tested manually in this audit).
- Add representative non-redistributable test fixtures through CI secrets/artifacts or create a tiny original synthetic PMX fixture that can legally be committed.

## 5. Overall assessment

The project has substantial implemented functionality and meaningful unit coverage across task safety, model routing, cognition, character mapping, presence, screen vision, and the API hub. The most serious problems were at trust boundaries rather than in the core feature logic: a legacy same-origin web proxy, permissive Electron navigation/media handling, cross-port localhost origins, and incomplete outbound URL validation. Those paths are now hardened and covered by regression checks.

The source build and local automated suites are healthy. A public release should still be treated as **Windows-validation pending** until the frozen agent, installer, DPAPI, real Gemini Live session, microphone/display capture, and actual desktop automation are tested from clean Windows machines.
