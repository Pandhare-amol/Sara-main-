# SARA YouTube + Artifact/Office Upgrade — Delivery Audit

**Date:** 2026-10-17  
**Branch:** `arena/52f656c4-sara-main`  
**Scope:** only the existing YouTube-control and artifact/content-creation integration points

## 1. Result summary

This increment adds a dedicated, permission-bound YouTube adapter for the user's real Windows default browser and extends the existing autonomous task/Office paths for voice-controlled artifact work.

It does **not** add an embedded browser, web proxy, scraper, duplicate AI provider, credential path, UI redesign, authentication change, memory/database migration, or engagement manipulation.

Two setup gaps are intentionally reported rather than hidden:

1. The current provider-neutral model contract supports text output and image input/vision, but has **no authorized image-output adapter**. SARA therefore does not fabricate PNG/JPEG files.
2. `shell.run` is approval-, timeout-, and output-bounded, but is **not a security sandbox**. SARA does not claim generated code was sandbox-tested unless a disposable container or Windows Sandbox runner is configured later.

## 2. YouTube root cause

The former `searchYouTube` path in `desktop_agent/tools_search.py` built:

`https://www.youtube.com/results?search_query=...`

and returned as soon as the browser opened that results page. Prompt guidance then asked the live model to inspect and click a visible title with generic tools. That path had no deterministic result selector, player-specific controls, synchronized state, active-tab isolation, media-session verification, or YouTube-specific cancellation. A results page could therefore be mistaken for completed playback.

## 3. YouTube fix

### Dedicated surfaces

- Voice tools: `playYouTube`, `controlYouTube`, `getYouTubeState`
- Planner actions: `youtube.play`, `youtube.control`, `youtube.state`, `youtube.cancel`
- Desktop tools: `youtubePlay`, `youtubeControl`, `youtubeState`, `youtubeCancel`
- Windows adapter: `desktop_agent/tools_youtube.py`

`searchYouTube` remains available only for a results-only search. Requests containing playback intent are routed to `playYouTube`.

### Selection and tab isolation

- Reuses a tab only after verifying its current URL is YouTube.
- Reuses the adapter's previously verified YouTube window where available.
- If no verified YouTube tab exists, opens exactly one new default-browser tab instead of replacing an unrelated active tab.
- Selects visible result links by Windows UI Automation accessibility identity and reading order, not fixed coordinates. Chrome/Edge playable YouTube link targets are read from the accessibility value and filtered to watch/Shorts/live/playlist URLs; if a browser does not expose semantic targets, numbered selection refuses rather than confusing a channel link with a video.
- Verifies that selection reached a real `/watch`, `/shorts/`, or `/live` URL and extracts the video ID.
- Playlist requests must retain a real `list=` ID.
- Supports a 1-based result index, direct YouTube URL, playlist selection, channel constraint, and YouTube's own upload-date search filter for `latest` requests.
- A requested channel is verified against Windows media-session artist/channel metadata. If the browser exposes no channel metadata, the constraint fails honestly instead of being claimed.

The upload-date filter narrows search using the filter value produced by YouTube's own search UI. It is not represented as an API-level guarantee that an item is globally/latest for an unverifiable channel.

### Verified player state

Each state read synchronizes available fields from:

1. The real browser's UI Automation URL/title/loading state.
2. Windows Global System Media Transport Controls (SMTC) for browser media title, channel/artist, playback status, position, duration, and supported media commands.
3. YouTube accessibility controls for play/pause fallback, player mute, player-volume range, fullscreen, captions and playback-speed menus.

State includes:

- title and channel (when exposed)
- URL, video ID and playlist ID
- playback state, semantic stopped state, position and duration
- YouTube-player volume and mute state
- fullscreen, captions and playback speed when exposed
- query, result index, selection kind, requested channel and latest-filter context
- task status, verified fields, error code and error text

System volume is never substituted for YouTube player volume.

### Controls

| Control | Mechanism and verification |
|---|---|
| Play / resume | SMTC or semantic Play control; requires fresh `playing` state |
| Pause | SMTC or semantic Pause control; requires fresh `paused` state |
| Stop | Verifies `paused` plus position at the beginning; preserves real playback state rather than inventing a native YouTube stop state |
| Restart / replay | Verified seek to zero, then verified play |
| Next / previous | SMTC or YouTube shortcut; requires changed video ID/title |
| Another result | Advances stored search result context in the same verified YouTube tab |
| Related result | Uses YouTube's active-player next recommendation when no search context exists |
| Relative / absolute / middle / percent seek | Prefers SMTC exact seek; bounded YouTube shortcuts only when the resulting position can be verified |
| Player volume | UIA RangeValue/Value on YouTube's volume slider; post-action percentage verification |
| Mute / unmute | Accessible player control or shortcut only when current state is known; post-action verification |
| Fullscreen | Accessible player control or shortcut only with known state; post-action verification |
| Captions | Accessible captions control; fails if unavailable/unverifiable for the video |
| Playback speed | Accessible Settings → Playback speed selection and selected-rate verification |
| Cancel | Dedicated event checked throughout bounded waits; does not stop unrelated tasks or alter existing playback |

### Honest failures

The adapter recognizes and reports age/sign-in requirements, region restrictions, unavailable/private content, connectivity errors, player errors, autoplay failure, missing controls, missing state, missing result, and unsupported seek/volume/speed/caption behavior. It does not bypass restrictions, CAPTCHA, authentication, policy, or engagement controls.

## 4. Artifact and Office routing

### Voice and planner routing

- `createContentTask` routes image, text/report, DOCX, XLSX, PPTX, PDF, code, multi-artifact, and existing-file edit requests into the existing autonomous task manager.
- `artifact.capabilities` checks the existing provider registry contract and the local installed-Office status before binary work.
- Planner policy chooses Documents through `fs.known_folder` when no destination is supplied, uses unique descriptive names, never silently overwrites, reports exact returned paths, and opens/previews only when requested.
- Existing progress, confirmation, cancellation, retry bounds, checkpoints, task-file records and partial-result reporting are reused.

### Configured provider architecture

No provider was added or duplicated. Drafting/planning continues through the existing provider-neutral `ModelRouter`, which supports configured Gemini, OpenAI-compatible, and Anthropic-compatible adapters. Runtime capability output lists only providers that are enabled and actually configured; this audit does not claim any user's key or quota is available.

The current model/provider output contract is text. Images can be supplied to vision-capable models as input, but that is not image generation.

### Formats and mechanisms

| Format | Real mechanism | Validation / limitation |
|---|---|---|
| Text / Markdown / code | `fs.create_text` with model-planned content | UTF-8 file, new path only; binary extensions rejected |
| Professional DOCX | Existing cross-platform `report.create_word` (`docx@9.12.0`) | Structured evidence labels, citation/calculation checks, Open XML QA, size, SHA-256, no overwrite |
| Simple Word DOCX | Installed Microsoft Word COM | New `.docx`; valid Open XML, non-empty, SHA-256 |
| XLSX | Installed Microsoft Excel COM | Values remain values; explicit safe local formulas only; computed values returned; column/bar/line/pie charts; valid Open XML, non-empty, SHA-256 |
| PPTX | Installed Microsoft PowerPoint COM | Editable title/bullet text, readable sizing, optional validated local image embedded (not linked/uploaded); valid Open XML, non-empty, SHA-256 |
| PDF | Installed Word/Excel/PowerPoint export from an existing verified source | New path only; `%PDF-` header, `%%EOF`, non-empty, SHA-256 |
| Existing Office edits | Existing Word/Excel/PowerPoint COM tools | Explicit bounded edits, automatic same-folder hash-verified backup, restore on failure; PowerPoint text edits preserve existing pictures/charts |
| PNG/JPEG generation/editing | **Not configured** | Requires an authorized image-output adapter in the existing gateway; no placeholder is produced |
| Sandboxed code execution | **Not configured** | Requires an isolated disposable runner; host `shell.run` is never labelled a sandbox |

The text primitive now rejects image, PDF and Office extensions in both the Node executor and Python desktop agent. This prevents a text model from creating a corrupt file with a binary-looking extension.

The artifact open/preview route was also corrected: `fs.open` now calls the OS default-app `openPath` primitive; it no longer falls through to the unrelated File Explorer selection handler.

## 5. Safety boundaries retained

- Office writes remain `OFFICE_WRITE`-approval gated.
- Existing files are not silently replaced.
- Office edits keep verified backups and restore on failure.
- Formula-like values in ordinary workbook rows remain escaped text; formula execution requires the explicit allowlisted formula field.
- Formula creation rejects external workbook/sheet references, links, web/data functions, DDE syntax, unsupported characters and non-allowlisted functions.
- Presentation images must be authorized local PNG/JPEG/GIF/BMP files, at most 50 MB, and pass Pillow integrity verification before embedding.
- No private file is uploaded by these Office workflows.
- Web/page/file/model content remains untrusted data, not instructions.
- No UI, navigation, avatar, authentication, memory, provider selection, credential storage or database schema was changed.

## 6. Test evidence

### Automated mocked/unit coverage added

`desktop_agent/test_youtube.py` covers:

- semantic search-result and playlist candidate selection
- search-to-watch-to-play verification
- direct video/playlist URL parsing
- pause/resume and stop/restart
- next/previous and another-result context
- seek, player volume, range-value normalization, mute, fullscreen, captions and speed routing
- autoplay restriction
- missing-video and player-error propagation
- unrelated-tab isolation

`tests/youtubeAndArtifacts.test.ts` covers:

- action and voice-tool registration
- voice routing to verified YouTube/direct artifact tasks
- executor mapping and refusal of an unverified playback payload
- runtime capability reporting, including image and sandbox gaps
- binary-fabrication rejection
- correct OS open/preview route
- bounded workbook formula/chart and presentation-image schemas

`desktop_agent/test_office.py` additionally covers:

- safe formula allowlist and external-function rejection
- mocked Excel formula evaluation result and chart construction
- mocked editable PowerPoint text plus local-image embedding
- PDF signature/end-marker validation
- direct UTF-8 primitive rejection of fake image/PDF/Office files

### Executed locally

- TypeScript type-check: passed.
- Targeted Node YouTube/artifact suite: **8/8 passed**.
- Full Node suite (`npm run test:node`): **130 total / 122 passed / 8 environment-gated skipped / 0 failed**.
- Real-browser security boundary suite: **3/3 passed** (included in the full Node total).
- Full Python desktop suite in `.venv`: **64 total / 61 passed / 3 Windows-only UIA skipped / 0 failed**.
- Full project command with the virtual environment selected (`PATH="$PWD/.venv/bin:$PATH" npm test`): passed, including type-check, all Node suites and all Python suites.
- Production build (`npm run build`): passed (Vite and bundled server).
- Windows CI for implementation commit `0516902`: push run [`39012684103`](https://github.com/Pandhare-amol/Sara-main-/actions/runs/39012684103) passed; pull-request run [`39012686931`](https://github.com/Pandhare-amol/Sara-main-/actions/runs/39012686931) passed. Both completed dependency install (including SMTC), type-check, all listed Node/Python regressions and production build.
- Python compile and `git diff --check`: passed.

### Not claimed

No live YouTube playback was run in this Linux checkout. The YouTube tests are mocked deterministic adapter tests plus architecture/security regression tests, not a claim about a real signed-in browser/account/region.

No installed Microsoft Office COM application was available in this Linux checkout. Excel and PowerPoint execution tests use deterministic COM fakes; cross-platform DOCX generation remains genuinely executed and verified by the existing report suite. A Windows CI run verifies import/registration/regressions, but an interactive live browser and licensed installed Office remain separate manual acceptance environments.

## 7. Manual live acceptance still required

On an authorized Windows test machine:

1. Start the desktop agent with the updated requirements (including `winrt-Windows.Media.Control==3.2.1`).
2. In the user's default browser, test search-to-play, explicit result index, channel constraint, latest filter, playlist selection and direct YouTube URL.
3. Verify every player control in the Controls table against the returned synchronized state.
4. Verify an unrelated active non-YouTube tab is not replaced, and that subsequent commands reuse the verified YouTube tab.
5. Exercise autoplay blocked, signed-out/age/region restriction (where safely reproducible), unavailable video and offline/player-error paths.
6. With locally installed Office, create a formula/chart workbook, editable presentation with an authorized local image, export DOCX/XLSX/PPTX to PDF, and inspect each returned path/hash.

Until that run occurs, live YouTube and installed-Office behavior is **implemented but not live-certified**.

## 8. Exact files changed

- `agent/actions/catalog.ts`
- `agent/actions/executor.ts`
- `agent/planner/prompts.ts`
- `desktop_agent/registry.py`
- `desktop_agent/requirements.txt`
- `desktop_agent/test_office.py`
- `desktop_agent/test_youtube.py` (new)
- `desktop_agent/tools_files.py`
- `desktop_agent/tools_office.py`
- `desktop_agent/tools_uia.py`
- `desktop_agent/tools_youtube.py` (new)
- `package.json`
- `runtime/myraaRuntime.ts`
- `server.ts`
- `tests/youtubeAndArtifacts.test.ts` (new)
- `voice/liveAgentTools.ts`
- `docs/SARA-YOUTUBE-AND-ARTIFACT-UPGRADE-2026-10-17.md` (this audit)
