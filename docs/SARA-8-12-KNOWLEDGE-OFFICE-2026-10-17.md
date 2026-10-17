# SARA 8–12 local knowledge, recovery and Microsoft Office increment

**Date:** 17 October 2026  
**Scope:** the previously missing SARA 12 local document/project intelligence slice, stronger SARA 8–11 recovery checkpoints, and verified Microsoft Office workflows.  
**Trust statement:** “implemented” below means code and an available automated test exist. Windows Office/UI behavior remains externally unverified until it runs on a Windows machine with desktop Office installed.

## 1. Delivered behavior

### Authorized local sources

The **LEARN → Sources** panel and `/api/knowledge-index/*` API now support explicit folder grants for:

- documents;
- source repositories/projects, including documentation and changelogs within them;
- notes;
- Sara's own persisted task-session history;
- explicitly configured local storage folders.

A folder is not read until the local user checks the authorization disclosure. The server owns the current principal (`local-default`); request JSON cannot select another owner. Every retrieval filters by that principal and eligible source grants **before** scoring. This is a single-user local-profile boundary, not a claim of multi-tenant authentication.

Cloud processing is disabled per source by default. Local search works without it. A separate, explicit source toggle is required before a passage can be returned to a cloud voice/planning model or sent to a cloud embedding model. Configured local models can use local-only sources.

The scanner does not follow symlinks. It excludes VCS metadata, dependency/build/cache directories, hidden directories, OS application-data locations, and likely credential/key files. File count and byte limits are bounded. Source roots remain the raw records; extracted chunks/vectors are separately persisted derived data.

### Incremental indexing and lifecycle

Each indexed file records:

- source/root identity, owner and optional project ID;
- relative path, filename, type, size and modification time;
- SHA-256 content identity and duplicate linkage;
- filesystem visibility/readability metadata;
- extraction method, status, error or unsupported reason;
- bounded version history;
- prompt-injection indicator.

Reindexing compares metadata and hashes, skips unchanged files, records duplicates, removes derived data for deleted files, and refreshes project maps. Jobs persist stage, progress, counters, issues, completed/pending paths and the next safe action. A process restart changes live jobs to `interrupted`; it never silently resumes uncertain work. Retry performs a fresh incremental scan. Cancellation retains already completed, independently verified file records.

Lifecycle controls include inspect, correction notes, reindex, export, retention, source disablement, cancellation/retry, and confirmed source deletion. Deleting a source removes its documents, chunks, vectors, symbols, corrections, jobs and map; it never deletes the original files.

### Extraction formats

| Format | Result |
|---|---|
| Plain text, Markdown, JSON/JSONL, XML, YAML, TOML, CSV/TSV, logs and common configuration files | Indexed with line ranges |
| TypeScript/JavaScript, Python and common compiled/scripting languages | Indexed with line ranges and static symbols/imports |
| PDF | Text extracted page-by-page with `pdfjs-dist`; image-only pages produce an explicit no-text warning; invalid/password-protected files are explicit failures/unsupported records |
| `.docx` | Open XML paragraph/header/footer/note text with document-part and paragraph locations |
| `.xlsx` | Open XML shared strings/cell values with sheet and row locations |
| `.pptx` | Open XML slide text with slide locations |
| `.rtf` | Conservative plain-text extraction |
| Legacy `.doc`, `.xls`, `.ppt` | Explicitly unsupported; save as Open XML rather than pretending extraction succeeded |
| Images/scanned-PDF OCR | Not part of this indexer; Windows screen OCR is separate and is not silently substituted |

Open XML packages use the existing bounded ZIP reader. No Office macro is executed during indexing.

### Retrieval and grounding

Search supports:

- exact phrase and keyword overlap;
- filename matches;
- code-symbol matches;
- metadata filters (source/project/extension/modification time);
- optional provider embeddings;
- hybrid reranking, score thresholds and per-document diversity;
- source passages with line, page, slide, paragraph, sheet or row citations.

Returned records explicitly identify source excerpts, current/stale state, suspicious instruction-like content, low retrieval confidence, user correction notes, and likely polarity conflicts between sources. Retrieved instructions remain quoted untrusted data. The planner prompt and voice tool require citations, uncertainty disclosure, and current implementation/test retrieval before code editing.

Semantic vectors are optional. If no embedding model is configured, indexing and keyword/symbol search still complete. A cloud embedding call is refused unless that source independently permits external processing.

### Project map

Project sources produce a deterministic static map of:

- conventional and manifest-declared entry points;
- top-level modules;
- package and Python dependencies;
- detected HTTP routes;
- classes/interfaces/types as candidate data models;
- test files and likely frameworks;
- package/Make-style build commands;
- import relationships;
- bounded Git history, when the local repository exposes it;
- TODO/FIXME/HACK/XXX markers;
- evidence paths/lines, fingerprint, refresh time and static-analysis limitations.

No project code is imported or executed to build the map.

### Task recovery checkpoint

Persistent task sessions now add a structured checkpoint containing objective/status, completed and remaining work, decisions, constraints, changed files, validation evidence, recovery attempts, uncertain non-idempotent actions and the next safe action. The Task HUD exposes recovery details. Restart continuation warns about uncertain sends/writes and forbids blind replay until current state is observed.

### Microsoft Office workflows

New agent actions use desktop Office's local COM automation on Windows:

- `office.status`;
- `office.create_word` → new `.docx`;
- `office.create_workbook` → new `.xlsx`;
- `office.create_presentation` → new `.pptx`;
- `office.edit_word` → append text or replace an exact, approved number of case-sensitive matches in an existing `.docx`;
- `office.edit_workbook` → update up to 1,000 explicit cells in one existing `.xlsx` sheet, with optional expected-value preconditions;
- `office.edit_presentation` → append one text slide or update one existing text slide in a `.pptx` without deleting pictures/charts;
- `office.export_pdf` → new PDF from `.docx`, `.xlsx` or `.pptx`.

All Office writes use the locked `OFFICE_WRITE` capability, so approval cannot be relaxed to silent allow. The confirmation for an existing-file edit previews the bounded change and states the backup behavior. Before Office opens the source for editing, Sara creates a timestamped, non-overwriting backup beside it and verifies that its SHA-256 matches the original. The source is limited to a safe folder, exact Open XML extension, read/write access and 200 MB. Before Office opens it, the bounded package check rejects malformed archives, macros, ActiveX and auto-updating external templates/media/data (ordinary clickable hyperlinks are allowed). A successful edit requires a changed source hash, non-empty source, verified Office-specific content and an intact backup; a failed edit closes Office and attempts a hash-verified restoration from the backup. Both the modified source and backup are written to task checkpoints and the audit trail.

New-file and PDF actions reject overwrite and verify the output before reporting success. Excel creation and editing escape formula-like strings, including whitespace-prefixed `=`, `+`, `-` and `@`, as plain text. Office files can still be opened through the generic file/UIA path for changes outside these deterministic bounded operations; accessibility selectors remain preferred over coordinates.

## 2. Persistent files

Under Sara's application data directory:

- `knowledge/catalog.v1.json` — source grants, file manifests/version metadata, symbols, jobs, maps and correction notes;
- `knowledge/derived-index.v1.json` — extracted chunks and optional vectors;
- `tasks/sessions.v1.json` — task sessions plus structured recovery checkpoints.

Writes use atomic JSON replacement and a serialized store queue.

## 3. Local APIs

- `GET /api/knowledge-index`
- `POST /api/knowledge-index/sources`
- `POST /api/knowledge-index/connect-task-history`
- `GET|PATCH|DELETE /api/knowledge-index/sources/:id`
- `POST /api/knowledge-index/sources/:id/reindex`
- `GET /api/knowledge-index/jobs/:id`
- `POST /api/knowledge-index/jobs/:id/cancel|retry`
- `POST /api/knowledge-index/search`
- `GET /api/knowledge-index/projects/:sourceId`
- `POST /api/knowledge-index/projects/:sourceId/refresh`
- `POST /api/knowledge-index/documents/:id/correct`
- `GET /api/knowledge-index/export`

These remain behind the existing loopback host/origin policy. Source deletion additionally requires `confirm=true` and removes only index-derived data.

## 4. Setup and use

```bash
npm ci
npm run lint
npm test
npm run build
npm run dev
```

1. Open **LEARN → Sources**.
2. Enter an absolute folder, choose its purpose, read and check the authorization disclosure.
3. Leave cloud processing off for local-only search. Enable semantic indexing only if a suitable embedding model is configured.
4. Use **Authorize & index**, then inspect progress and extraction issues.
5. Search for architecture, authentication, tests, earlier work or unresolved items. Open the cited local file before consequential edits.
6. Use **Allow cloud use** on a source only if its excerpts may be sent to the configured voice/planning provider.
7. Use **Delete index** to remove that source's metadata and all derived records without touching originals.
8. Ask Sara to create or edit a Word/Excel/PowerPoint file, or export one to PDF. The task panel must show an Office-write approval before the operation runs. For edits, review the exact change preview; the verified `*.sara-backup-<UTC timestamp>.*` file remains beside the original.

Microsoft Office workflows additionally require:

- Windows;
- locally installed desktop Word/Excel/PowerPoint with COM registration;
- the existing `pywin32==308` desktop-agent dependency;
- a destination under Sara's safe user/project folders.

## 5. Automated evidence from this increment

Targeted tests cover:

- mandatory source authorization and principal isolation;
- incremental indexing, duplicate detection and deletion cleanup;
- prompt-injection flags;
- stale and conflicting source labels;
- cloud-model prefiltering before retrieval;
- code symbols and architecture maps;
- interrupted index checkpoints;
- Word/Excel/PowerPoint Open XML locations and PDF page extraction;
- legacy Office unsupported handling;
- task checkpoint persistence and uncertain-action recovery;
- locked Office-write approval policy and bounded edit-change confirmation previews;
- Office edit action routing plus modified-source/backup task records;
- exclusive timestamped backups, SHA-256 verification and restoration;
- Word replacement-count, Excel cell-address/formula-injection and PowerPoint slide bounds;
- rejection of malformed, macro/ActiveX and linked external-content Open XML edit sources;
- Office tool registration, destination extension and no-overwrite behavior.

Local validation for this branch state:

- TypeScript type-check: passed;
- Node suites: **116 tests, 108 passed, 8 skipped, 0 failed** (the skips are credential/Windows-only cases);
- Python desktop-agent suites: **41 tests, 38 passed, 3 Windows-only skipped, 0 failed**;
- production Vite/server build: passed;
- built-server knowledge API smoke test: authorized source creation, completed indexing and cited search passed;
- `git diff --check`: passed;
- production dependency audit (`npm audit --omit=dev`): 0 findings;
- full audit: 8 existing moderate Electron Builder transitive findings; the suggested forced change remains a breaking build-chain change and was not applied without installer regression evidence.

Windows CI passed on the implementation commit `a8ab47f`: push run [`38993686878`](https://github.com/Pandhare-amol/Sara-main-/actions/runs/38993686878) completed in 1m46s and PR run [`38993690538`](https://github.com/Pandhare-amol/Sara-main-/actions/runs/38993690538) completed in 1m41s. Both exercised dependency installation, type-check, Node suites, Python suites and production build on `windows-latest`. This validates Windows CI compatibility; it does **not** prove live Office COM behavior because the hosted runner does not provide a licensed desktop Office installation.

## 6. Honest remaining limits and external blockers

- The current application has one backend-owned local profile. It enforces that namespace, but does not claim remote multi-user identity, login sessions or OS ACL impersonation.
- Local folders and Sara task history are implemented. OneDrive/SharePoint/Google Drive service APIs are not configured; a locally synchronized, explicitly authorized folder works as local storage.
- OCR for scanned PDFs is not part of document indexing.
- Static project maps cannot prove dynamic runtime relationships and do not replace tests.
- Semantic retrieval requires a configured embedding-capable model; no live cloud embedding call has been made in this environment.
- Microsoft Office application control cannot be executed in this Linux workspace. The COM interfaces and non-Windows/policy/schema/backup/restore tests exist; real Office create/edit/save/export behavior, dialogs and UIA behavior need Windows with Office installed.
- Live cloud voice, microphone, Windows UIA/OCR, packaged Electron, installer signing/staged updates, long-duration soak/SLOs and hardware-specific behavior remain external validation work. None is reported as completed here.
- No isolated code-execution sandbox was added, and retrieved code is never executed by the indexer.
