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
npm ci
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

## Project map

| Folder | What it is |
|---|---|
| `src/` | React UI, the 3D character engine (three.js, MMD/PMX), desktop companion renderer |
| `electron/` | Desktop shell: windows, tray, desktop companion brain, crash recovery |
| `server.ts`, `runtime/` | Local backend (Express + WebSocket), Gemini Live bridge |
| `agent/` | PC-control agent: planner, actions, WhatsApp/chat helpers, safety checks |
| `desktop_agent/` | Python tool server (UI Automation, input, files, apps) |
| `models/` | Provider-independent model router (Gemini, OpenAI-compatible, Anthropic-compatible and local) |
| `intelligence/` | Multi-provider review, authorized web research and promoted evidence |
| `knowledge/` | Authorized local document/code indexing, retrieval, provenance and project maps |
| `voice/` | Live voice tools, including permission-filtered knowledge queries |
| `settings/`, `permissions/`, `secrets/` | Settings, permission engine, DPAPI key store |
| `character_import/` | PMX importer and capability report |
| `cognition/`, `memory/`, `presence/` | Memory, initiative and presence |

## Learning and research

Open **LEARN** in the main header to run research against public URLs you explicitly authorize,
inspect the exact stored source passages, compare configured providers, promote cited findings to
knowledge, and review versioned skills. Sara checks public-network/redirect safety and robots.txt;
it does not bypass logins, paywalls, CAPTCHAs or access controls. A citation means a passage supports
the report, not that the claim was independently verified.

**LEARN → Sources** adds local-only-by-default indexing for explicitly authorized document, notes,
task-history and source-repository folders. Search results include exact passages and file/page/Office
locations; stale, conflicting or instruction-like text is labeled. Cloud model use is a separate opt-in
per source. Project sources also produce a static architecture/test/build map.

On Windows with desktop Microsoft Office installed, Sara can create verified Word, Excel and
PowerPoint files, export them to PDF, and safely edit existing Open XML files. Existing-file edits
support exact Word append/replacement, explicit Excel cell updates, and PowerPoint text-slide
append/update. Every Office write asks for approval; an edit previews its bounded change, creates and
hash-verifies a timestamped same-folder backup before saving, restores that backup on failure, and
verifies both output and backup. New files and PDF exports never overwrite. Formula-like Excel input
is always stored as text. Indexing Office Open XML files does not require Office and never executes
macros.

The full SARA 8.0–14.0 audit is in
[`docs/SARA-8-14-IMPLEMENTATION-2026-10-16.md`](docs/SARA-8-14-IMPLEMENTATION-2026-10-16.md).
The local knowledge/Office setup, format table, security model and current blockers are in
[`docs/SARA-8-12-KNOWLEDGE-OFFICE-2026-10-17.md`](docs/SARA-8-12-KNOWLEDGE-OFFICE-2026-10-17.md).

## Graphics quality

Settings → Character → Graphics quality: Auto, High, Medium, Optimized, Potato PC.
Auto steps down by itself if the character crashes on a weak GPU.

## Safety

- API keys are entered locally and posted once to the exact-origin backend secret store; they are never returned to the renderer or included in model catalogues/logs.
- High-risk actions (sending messages, deleting, installing, purchases) ask for confirmation.
- Text from websites, documents and the screen is treated as untrusted data.
- Stop everything any time with the emergency shortcut (default Ctrl+Alt+Shift+S).
