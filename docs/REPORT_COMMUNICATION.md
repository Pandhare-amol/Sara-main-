# Communication report — calls, identity, policy, verification

Evidence-based. Everything marked PASS ran in this workspace or on a GitHub
runner on **2026-10-23**. Anything that did not run is under *Remaining
limitations*; nothing is listed as working because it looks finished.

## FILES MODIFIED

```
communication/types.ts            call states, peer, policy context, records, device commands
communication/callPolicy.ts       pure incoming-call decision matrix
communication/identity.ts         phone normalisation, contact → peer, name matching
communication/callManager.ts      state machine, approvals, messages, summaries, commands, stop
communication/routes.ts           /api/calls/* with device-token auth
settings/appSettings.ts           calls policy block (+ normalisation/clamping)
permissions/types.ts              PHONE_CALL capability
permissions/engine.ts             PHONE_CALL default = ask
agent/audit.ts                    call / message audit kinds
shared/appEvents.ts               call.changed / call.message events
memory/contacts.ts                phones, relationship, organisation, priority, findByPhone
runtime/myraaRuntime.ts           CallManager instance, routes, presence, emergency-stop hook
android/.../SaraCallsPlugin.java  telephony bridge (new)
android/.../MainActivity.java     plugin registration
android/.../AndroidManifest.xml   READ_PHONE_STATE / READ_PHONE_NUMBERS / CALL_PHONE / ANSWER_PHONE_CALLS
src/mobile/MobileIntelPanels.tsx  Calls panel
src/mobile/callBridge.ts          JS side of the native bridge
src/mobile/MobileApp.tsx          menu entry
src/mobile/MobilePanels.tsx       sheet id
src/components/SettingsPanel.tsx  Settings → Calls
src/lib/appApi.ts                 call types + endpoints
tests/communication.test.ts       21 unit tests
tests/communicationHttp.test.ts   9 HTTP tests
docs/COMMUNICATION.md             operator documentation
scripts/*smoke*                   call stubs + phone-shell checks
package.json                      test:calls, wired into `npm test`
```

## CALL SYSTEM

| Item | State | Evidence |
| --- | --- | --- |
| Incoming call detection | **PASS (code + live server)** | `POST /api/calls/events` accepted a ringing event from the built `dist/server.cjs`; record reached `RINGING` |
| Outgoing calls | **PASS (queued, verified by device ack)** | `POST /api/calls/outgoing` returns a preview; after `confirmed:true` a `place_call` command is queued with a 2-minute expiry. Never dialled without confirmation |
| Caller identification | **PASS** | `+91 98765 43210` matched the contact `Rahul` live; unknown numbers stay `unknown:true`; ties resolve to nobody |
| Policy / auto-answer | **PASS** | never answers unknown numbers; `ask` → ConfirmationBroker request (`Answer call from Rahul?`) observed live |
| Conversation | **FAIL (not possible)** | Android reserves in-call audio for the system dialer; an ordinary app cannot hear or speak into a GSM call. Not simulated |
| Call summary | **PASS (limited)** | Built only from reported transcript turns and taken messages; with no transcript it says so under `notes` |
| Call message taking | **PASS** | `POST /api/calls/:id/message` stored + notified; appears in the summary |
| Emergency stop | **PASS (live)** | Stop ended the live call, dropped the queued `answer_call`, left only an `end_call` command |
| Android bridge | **COMPILES** | `SaraCallsPlugin.java` builds in CI (run 39893232623, job *Build APK* — success). Not executed on a device here |

## MESSAGING

Not implemented in this change. No WhatsApp/Telegram/Discord connector exists
yet; `SEND_MESSAGE` remains wired to the existing desktop app-automation path
(unchanged). This is stated plainly rather than covered by a stub.

## PC CONTROL

| Area | State | Note |
| --- | --- | --- |
| Mouse, keyboard, files, clipboard, system | **UNCHANGED, previously verified** | Existing `ActionExecutor` + desktop agent; this change did not alter them |
| Application discovery / YouTube control | **NOT IMPLEMENTED** | Still pending; no fake version was added |

## BROWSER

Unchanged from the previous release (`REAL_BROWSER` / automation browser split
already exists). YouTube control is not implemented.

## CAMERA

Phone camera capture and single-photo vision shipped in the previous change
(`POST /api/mobile/vision`, 409 without a key). Continuous camera monitoring is
still desktop-only.

## AUTONOMOUS EXECUTION

Unchanged: planning, `WAIT/ASK_USER/SUGGEST/ACT`, verification and recovery are
the existing agent loop. New tools did not bypass the executor or policy.

## SAFETY

| Item | Evidence |
| --- | --- |
| Policy | `PHONE_CALL` capability, default **ask**; unknown callers never auto-answered (tested) |
| Permissions | Device endpoints require `SARA_CALL_DEVICE_TOKEN`; 503 when unset, 401 when wrong, 401 without header (all three tested) |
| Confirmation | Incoming call approvals reuse `ConfirmationBroker` and the existing UI/voice paths |
| Audit | `call` / `message` entries for every transition, decision, message and device ack |
| Emergency stop | Ends calls, clears queued commands, cancels pending approvals (tested + live) |
| Secrets | Device token never reaches the browser bundle (`check:bundle-secrets` PASS, 13 files) |

## PERFORMANCE

Not measured in this change. No claims.

## TESTS

| Suite | Result |
| --- | --- |
| `npm run lint` (tsc --noEmit) | **PASS**, 0 errors |
| `npm run test:calls` | **PASS**, 30/30 (21 unit + 9 HTTP) |
| `npm run test:agent` | **PASS**, 46 pass / 0 fail / 1 skip (DPAPI) |
| `npm run test:characters` | **PASS**, 8 pass / 1 skip |
| `npm run test:remote-access` | **PASS**, 13/13 |
| `npm run test:mobile` | **PASS**, 6/6 |
| `npm run test:persona` | **PASS**, 33/33 |
| `npm run test:ui` | **PASS**, phone 42/42, desktop 6/6 |
| `npm run build:web` | **PASS** |
| `npm run check:bundle-secrets` | **PASS**, 13 files |
| CI run [39893232623](https://github.com/Pandhare-amol/Sara-main-/actions/runs/39893232623) | **SUCCESS** — web build/types/tests, debug APK built (5,371,400 bytes) |

Live checks against `node dist/server.cjs` (port 3022, `SARA_CALL_DEVICE_TOKEN`
set): events 401 without token → 200 with token → unknown caller → policy
"integration off" → enable policy → contact match → `ask_user` → confirmation
created → UI answer → `answer_call` command queued → message stored → stop ends
call and clears the queue.

## REMAINING LIMITATIONS (observed)

1. Sara cannot speak into or hear a cellular call; Android reserves in-call audio.
2. `acceptRingingCall()` / `endCall()` require the system-dialer role; the plugin
   reports refusal instead of claiming success.
3. The Android plugin listens only while the app is running (no foreground service).
4. Caller numbers may be withheld without call-log access; such calls are unknown.
5. No messaging connectors (WhatsApp/Telegram/Discord/Slack) yet.
6. No application-discovery or YouTube controller yet.
7. The Android plugin was compiled in CI but **not** run on a physical phone here.

---

# Addendum — capability registry and messaging (same day)

## FILES ADDED

```
capabilities/registry.ts              live capability catalogue + model instruction block
capabilities/routes.ts                GET /api/capabilities, POST /api/capabilities/report
communication/messaging/types.ts      provider interface + outcome vocabulary
communication/messaging/whatsappCloud.ts   official Meta Graph API sender
communication/messaging/hub.ts        approval, duplicate protection, inbox, classification
communication/messaging/routes.ts     status/messages/summary/outbox/send + signed webhook
shared/deviceAuth.ts                  one device guard, used by calls and capabilities
src/mobile/MobileIntelPanels.tsx      Messages panel + capability list
tests/capabilities.test.ts            8 tests
tests/messaging.test.ts               15 tests
docs/CAPABILITIES_AND_MESSAGING.md    operator documentation
```

## CAPABILITIES

| Item | State | Evidence |
| --- | --- | --- |
| Live catalogue on the server | **PASS** | live `dist/server.cjs`: `available: ["memory","phone.calls"]` with every unconfigured area marked UNAVAILABLE |
| Phone reports its own capabilities | **PASS** | `POST /api/capabilities/report` → 200, then `GET` shows the device and `phone.call.place = AVAILABLE`, `phone.call.speak_audio = NOT_SUPPORTED` |
| Model only sees what is available | **PASS (code)** | the live instruction now appends `capabilitySummary(...)`; unit-tested to say "Available: none." when nothing is usable |
| Token required for reports | **PASS** | 401 without the header (tested) |
| Android side | **COMPILES** | the plugin posts a permission-accurate report on start |

## MESSAGING

| Item | State | Evidence |
| --- | --- | --- |
| WhatsApp Cloud API send | **PASS (stub-verified)** | success returns `SENT` + Meta message id; recipient normalised to `+919876543210` |
| 2xx without an id | **PASS** | reported `UNCERTAIN`, never `SENT` |
| Provider error mapping | **PASS** | `WHATSAPP_131030`, `retryable: false`, Meta's message kept |
| Unconfigured provider | **PASS (live)** | `POST /api/messaging/send` → 409 `NOT_SUPPORTED` with the exact missing variables |
| Approval before send | **PASS** | first call returns `REQUIRES_APPROVAL` + confirmation id, nothing is sent |
| Duplicate protection | **PASS** | identical draft inside 90 s refused, provider called once |
| Webhook signature | **PASS** | unsigned POST → 401, signed POST → message stored; no app secret → 503 |
| Inbound classification | **PASS** | deterministic reasons stored with each message |
| Desktop WhatsApp path | **UNCHANGED** | the existing agent path was not modified |

## TESTS (this addendum)

| Suite | Result |
| --- | --- |
| `npm run test:capabilities` | **PASS**, 23/23 (8 registry + 15 messaging) |
| `npm run test:ui` | **PASS**, phone 50/50, desktop 6/6 |
| `npm run test:agent` / `test:calls` | 46/0/1 · 30/30 |
| `test:characters` / `test:remote-access` / `test:mobile` / `test:persona` | 8/1 · 13/13 · 6/6 · 33/33 |
| lint · build:web · check:bundle-secrets | PASS · PASS · 12 files clean |

## REMAINING LIMITATIONS (this addendum)

1. WhatsApp sending needs a Meta Business account and a verified sender number;
   without credentials the connector is honestly `NOT_SUPPORTED`.
2. Inbound messages require a public HTTPS webhook URL and the app secret.
3. No Telegram/Discord/Slack/email connectors yet — adding one means implementing
   the same small provider interface, nothing else.
4. The capability report from the phone covers calls only, because that is what
   the Android plugin implements today.
5. No physical-device run of the updated plugin; the APK build is the evidence.
