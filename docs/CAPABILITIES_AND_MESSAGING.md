# Capabilities and messaging

Two subsystems that keep Sara honest about what she can do and what she may send.

## Capability registry (`capabilities/`)

The registry answers one question for the UI and for Gemini: **what can actually
run right now?**

```
server config + runtime state   → /api/capabilities
Windows desktop agent           → live /health probe (cached 5 s)
phone                           → POST /api/capabilities/report (device token)
```

Each entry carries `status`, `risk`, `permissions`, `detail` and — importantly —
`verification`: how a success is proven. Statuses are:

| Status | Meaning |
| --- | --- |
| `AVAILABLE` | the capability can run now |
| `NEEDS_PERMISSION` | the platform capability exists but the user has not granted it |
| `UNAVAILABLE` | the owner (server/PC) is offline or unconfigured |
| `NOT_SUPPORTED` | the platform does not permit it at all |
| `UNKNOWN` | nothing has reported it yet |

The live system instruction now ends with a short block generated from this
registry (`capabilitySummary`), listing what is available and what is not, and
telling the model not to attempt or simulate anything outside the list. When the
PC agent is offline, "open Chrome on my PC" is not presented as possible.

The Android app reports its own capabilities on start, including an explicit
`phone.call.speak_audio = NOT_SUPPORTED` — Android reserves in-call audio for the
system dialer, and the report says so instead of leaving a hopeful omission.

## Messaging (`communication/messaging/`)

One interface, provider adapters, no scraping.

```
send(draft) → provider configured? → user approved? → duplicate? → provider.send()
                                                                       ↓
                                                        SENT / FAILED / UNCERTAIN
```

- **WhatsApp Cloud API** (`whatsappCloud.ts`) — the official Meta Graph API. It
  requires `WHATSAPP_TOKEN` and `WHATSAPP_PHONE_NUMBER_ID`. Inbound messages
  arrive through the webhook (`GET` verification + HMAC-signed `POST`), which
  refuses to accept payloads when `WHATSAPP_APP_SECRET` is missing.
- **Verification** — a send is `SENT` only when Meta returns a message id. A 2xx
  without an id is `UNCERTAIN`; an API error keeps Meta's code and a
  `retryable` verdict.
- **Approval** — the first request always returns `REQUIRES_APPROVAL` with the
  exact draft and creates a normal Sara confirmation (`SEND_MESSAGE`). Only the
  confirmed call sends.
- **Duplicate protection** — the same (provider, recipient, text) inside 90 s is
  refused rather than sent twice.
- **Inbound classification** — deterministic and explainable: urgency/deadline
  words, direct requests, money/security terms, or automated senders. The reason
  is stored next to the message; the model is not asked to guess importance.
- **Outbox** — every attempt is kept (redacted preview, status, provider id) and
  written to the audit log.

The desktop WhatsApp path in the agent (open chat → type → send with approval)
is untouched. The hub is for provider APIs, not a replacement for it.

## API

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `GET /api/capabilities` | session | full catalogue + available tool ids + device list |
| `POST /api/capabilities/report` | device token | phone declares its capabilities |
| `GET /api/messaging/status` | session | provider configuration |
| `GET /api/messaging/messages` | session | stored inbound messages (`q`, `provider`, `unread=1`) |
| `GET /api/messaging/summary` | session | unread/important counts + highlights |
| `GET /api/messaging/outbox` | session | recent send attempts and outcomes |
| `POST /api/messaging/send` | session | draft (202) or confirmed send (200/409) |
| `GET`/`POST /api/messaging/whatsapp/webhook` | Meta handshake / HMAC | inbound delivery |

## UI

- Phone: **Messages** (connectors, draft → approve → send, inbox with importance)
  and **Self-check → What this setup can do** (the capability list with statuses).
- Desktop: nothing new to configure for capabilities; messaging is configured by
  environment variables only, because the token must never reach the browser.

## Tests

```bash
npm run test:capabilities   # 23 tests: registry honesty + WhatsApp + hub + webhook
```

The WhatsApp provider is exercised against a local HTTP stub that imitates the
Graph API: success with an id, a 2xx without an id, and a rejected send.
