# PC → phone feature parity

Sara on Android is the same Sara: the phone is another client of the computer
running her, so the phone never has a second brain, a second memory, or a
second policy. Nothing below is a phone imitation of a PC feature — it either
calls the same server endpoint or says exactly why it cannot.

Legend: **✅ same** · **⚠️ needs the PC** · **❌ not on the phone (stated in the app)**

| PC feature | On the phone | Where |
| --- | --- | --- |
| Text conversation | ✅ same session, same memory | composer at the bottom |
| Voice conversation (mic → Gemini Live → speech) | ✅ same audio session | mic button |
| Sara's character / animations | ⚠️ streams from the PC (no model bundled — licence) | stage |
| Character import (.pmx / zip) | ❌ PC only, explained in-app | **Character Studio** panel → states it is a desktop editor; import on the PC and it streams here |
| Character Studio (pose, fingers, cloth) | ❌ PC only, explained in-app | same panel |
| Your own video as the companion | ✅ phone extra (not on PC) | **Companion look** |
| Settings — General, AI models & keys, Voice, Personality, Reality mode, Calls, PC control & safety, Privacy, Presence, Character & companion, System, About | ✅ the *same* panel as the desktop UI, every section | **Settings** |
| Memory | ✅ same store, add/delete | **Memory** |
| Missions / task HUD / approvals | ✅ same task manager | **Missions**, **Today** |
| Automations & schedule history | ✅ same scheduler + audit log | **Automations** |
| Activity receipts + undo | ✅ same journal | **Activity** |
| Calls (state, policy, screening, summaries) | ✅ Android device APIs + server policy | **Calls** |
| Messages (WhatsApp Cloud API, preview → approve → send) | ✅ same connector | **Messages** |
| PC automation (apps, files, windows) | ⚠️ runs on the PC; the phone can start/approve tasks. Direct desktop permission needs `SARA_REMOTE_ALLOW_DESKTOP=1` | **Missions**, chat |
| See the PC screen | ⚠️ one frame per tap, needs the desktop agent (+ the remote-desktop opt-in) | **PC screen** |
| Continuous screen sharing (live frames) | ❌ not implemented on the phone; the app says so instead of showing a fake stream | — |
| Desktop companion (she stands on the Windows desktop) | ✅ toggles are server settings, editable from the phone; the companion itself appears on the PC | **Settings → Character & companion** |
| Graphics quality / realism / cloth | ✅ same server settings | **Settings → Character & companion** |
| Wake phrase | ⚠️ browser speech engine only; may stop in the background | **This device** |
| Theme colour | ✅ follows the server (voice command "change your colour") | — |
| Emergency stop everything | ✅ stops tasks, browser, mouse/keyboard, calls, workflows | menu → **Stop everything** |
| Self-check / capability report | ✅ live probes, `UNKNOWN` where unproven | **Self-check** |
| Model selection (which Gemini model) | ✅ same catalogue and keys | **Settings → AI models & keys** |
| First-run onboarding (own API key) | ✅ same key gate + a Connect screen for the PC address | launch |
| Local-only preferences (motion, avatar, wake, device log) | ✅ phone-only, stored on the device | **This device** |

## What "same UI" means here

The Settings overlay is literally the desktop component
(`src/components/SettingsPanel.tsx`) mounted in the phone shell, so the controls,
wording and validation cannot drift between the two. Its two-column layout
collapses to a horizontal section strip on a narrow screen.

Everything else is the phone composition (`src/mobile/*`), which reads the same
`/api/mobile/*` and `/api/*` endpoints as the desktop UI.

## Deliberate differences

- **No 3D model is bundled** in the APK (the models are licensed per user). With
  no model imported on the PC, the stage shows a quiet emblem plus the import
  hint; uploading a video is the offline alternative.
- **Screen capture is one-shot on the phone.** A continuous stream would burn
  battery and expose the desktop continuously; that is a decision, not a gap in
  the UI.
- **No desktop control by default.** A phone holding a chat session must not
  silently drive the PC; the operator opts in with `SARA_REMOTE_ALLOW_DESKTOP=1`.
