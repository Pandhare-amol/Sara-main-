# Calls and communications

Sara's call integration, and an honest account of what each part can actually do.

## Why calls enter through the phone

A Windows process cannot read or control a cellular call. Android gives the
telephony API to ordinary apps only in a limited form, and reserves in-call
audio for the system dialer. So the design is:

```
Android app (SaraCalls plugin)
  ├─ observes call state broadcasts
  ├─ POSTs events  ─────────────────┐
  └─ polls commands ◄───────────────┤
                                    │  authenticated with
Sara server                         │  SARA_CALL_DEVICE_TOKEN
  ├─ CallManager (state + history)  │
  ├─ callPolicy (may Sara answer?)  │
  ├─ ConfirmationBroker (ask you)   │
  ├─ AuditLog                       │
  └─ UI (desktop + phone panels)  ◄─┘
```

Nothing in this chain pretends: a call is `CONNECTED` only when the phone
reported it, and an outgoing call is `queued` until the phone acknowledges the
command.

## Enable it

Server (`secrets/.env` or the environment):

```bash
SARA_CALL_DEVICE_TOKEN=<a long random string, at least 24 characters>
```

Phone: **Calls → This phone → Device token**, paste the same value, then
**Save & start**. The phone asks for the phone permission.

The server refuses call events with `503` when no token is configured and `401`
when the token does not match — it does not fall back to accepting them.

## Policy

Every rule is per caller group, set in **Settings → Calls** on the desktop or
**Calls → Policy** on the phone:

| Setting | Values | Meaning |
| --- | --- | --- |
| `enabled` | on/off | accept call events at all |
| `answerFamily` / `answerBusinessContacts` / `answerKnownContacts` | never / ask / auto | what Sara may do for that group |
| `answerUnknownCall` | on/off | when on, Sara **asks** about unknown numbers; she never answers them herself |
| `answerDuringMeetings`, `answerDuringFocus` | on/off | whether an allowed caller is still answered in a quiet moment |
| `screenCalls` | on/off | Sara answers, asks who is calling and why, before connecting you |
| `takeMessage`, `notifyOnMissed` | on/off | message capture and missed-call notices |
| `maxCallMinutes` | 1–60 | upper bound Sara may hold a call |

`auto` never bypasses the risk layer: answering a call is the `PHONE_CALL`
capability, whose default decision is **ask**.

## What is implemented and verified

- Contact identification by phone number (`ContactBook.findByPhone`), with
  ties resolving to nobody instead of a guess.
- The policy matrix above (pure function, 21 unit tests + 9 HTTP tests).
- Call state machine: `RINGING → CONNECTED → ENDED`, plus `MISSED`, `REJECTED`,
  `FAILED`, `HELD`, `ACTIVE`; late events cannot revive a finished call.
- Approvals reuse `ConfirmationBroker`, so the existing approval UI and voice
  “yes/no” work unchanged.
- Message taking, stored and notified.
- Structured call summaries built **only** from reported transcript turns and
  messages; missing material is listed under `notes`.
- Outgoing calls: contact → number resolution, an explicit preview, then a
  `place_call` command. Ambiguous contacts return candidates, unknown contacts
  are refused; nothing is dialled before `confirmed: true`.
- Device command queue with expiry (a queued call cannot dial minutes later).
- Emergency stop ends live calls, drops queued commands and cancels pending
  approvals.
- Audit entries for every transition, decision and device acknowledgement.
- Android `SaraCalls` plugin (Java) that registers telephony call-state
  broadcasts, posts events and executes permitted commands. It is compiled by
  the GitHub Actions APK workflow.

## What is *not* possible, and why

- **Sara speaking into a cellular call.** Android reserves in-call audio; an
  ordinary app cannot inject TTS into a GSM call and cannot hear the caller.
  The "call conversation engine" from the roadmap is therefore not implemented
  rather than simulated. It becomes possible with a VoIP/SIP integration, which
  is a different subsystem.
- **Automatic answering.** `TelecomManager.acceptRingingCall()` needs
  `ANSWER_PHONE_CALLS`, which most devices grant only to the system dialer or
  the default dialer role. The plugin calls it, catches the failure and reports
  `FAILED` — it does not claim success.
- **Hanging up.** Same restriction (`endCall()` needs the same role/Android 9+).
- **Background call detection.** The current plugin listens while the app is
  running. A foreground service with `phoneCall|microphone` types would be
  needed for 24/7 detection; that is not implemented yet.
- **Caller number.** Android may withhold `EXTRA_INCOMING_NUMBER` without call
  log access; when it does, the call is recorded as an unknown number and the
  policy treats it as one.

## API

| Endpoint | Caller | Purpose |
| --- | --- | --- |
| `POST /api/calls/events` | phone (device token) | ringing / connected / held / ended / missed / transcript |
| `GET /api/calls/devices/:id/commands` | phone (device token) | actions to perform |
| `POST /api/calls/devices/:id/commands/:commandId/ack` | phone (device token) | report what actually happened |
| `GET /api/calls` | UI | active + recent calls |
| `GET /api/calls/:id` | UI | call, summary, messages |
| `POST /api/calls/:id/answer` · `/reject` · `/end` · `/message` | UI | user decisions |
| `POST /api/calls/outgoing` | UI | preview, then queue a confirmed call |
| `GET`/`POST /api/calls/policy` | UI | read / update the policy |

## Tests

```bash
npm run test:calls     # 30 tests: policy, identity, state machine, HTTP auth, stop
npm run test:ui        # phone shell check for the Calls panel
```
