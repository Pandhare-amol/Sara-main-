# SARA 8.0–14.0 audit and incremental implementation report

**Date:** 2026-10-16  
**Scope delivered in this increment:** the highest-priority SARA 13 vertical slice (multi-provider consultation, authorized source research, evidence persistence, explicit knowledge promotion, versioned skills, observability, and dashboard), plus provider/configuration and shutdown hardening needed to make that slice safe.

This report does **not** claim that the whole 8.0–14.0 roadmap is complete. The repository was audited before this increment. The prior baseline security and architecture audit is in [`PROJECT-AUDIT-2026-10-16.md`](./PROJECT-AUDIT-2026-10-16.md).

**17 October continuation:** the local document/project intelligence, extended recovery checkpoints and Microsoft Office increment is documented in [`SARA-8-12-KNOWLEDGE-OFFICE-2026-10-17.md`](./SARA-8-12-KNOWLEDGE-OFFICE-2026-10-17.md). The SARA 12 and Office rows below reflect that implementation.

## 1. Audit method and status definitions

The audit inspected implementations and call paths, not filenames or UI labels. Automated behavior was exercised with TypeScript/Node tests and a production build. Features requiring paid provider credentials, Windows UI Automation, a microphone, GPU/native capture, or external hardware remain externally blocked unless explicitly listed as tested.

| Status | Meaning |
|---|---|
| **Implemented and automated-test verified** | A real code path exists and deterministic automated tests passed. A fake provider/network fixture may be used only to exercise orchestration; that does not count as a live provider test. |
| **Implemented, externally unverified** | A real integration exists but the required credential, Windows host, service, or hardware was unavailable in this environment. |
| **Partial** | A safe useful subset exists, with named gaps. |
| **Missing** | No dependable implementation was found or added. |
| **Externally blocked** | The interface may exist, but truthful end-to-end validation needs something not available in this environment. |

## 2. SARA 8.0–14.0 capability matrix

### SARA 8–11: concurrent assistant, reliability, voice, visual automation, monitoring

| Capability | Status | Evidence and limits |
|---|---|---|
| Voice conversation with text fallback and barge-in hooks | Implemented, externally unverified | Gemini Live/audio session, interruption hooks, text input, and voice selection exist. Live microphone/provider audio was not exercised here. |
| Concurrent voice plus background tasks | Partial | Voice and persistent task sessions are separate and the resource scheduler/input arbiter coordinates automation. There is no formal high-load soak result for many simultaneous provider streams and Windows tasks. |
| Streaming and cancellation | Implemented and automated-test verified for model/task primitives | Provider streaming contracts, cancellation signals, stop/pause/takeover and emergency stop exist. Research has a dedicated abort controller and cancel endpoint. Pausing an in-flight HTTP/model request is intentionally not simulated; cancel/retry is supported. |
| Task checkpoints, recovery and restart safety | Implemented and automated-test verified | Persistent task state, legal transitions, recovery gating and outcome verification exist. Checkpoints now include objective/status, completed/remaining work, decisions, constraints, changed files, validation, recovery attempts, uncertain non-idempotent actions and the next safe action. Interrupted tasks/indexing require explicit recovery and never blindly replay uncertain work. |
| Reminders and utilities | Implemented | Persistent timers/alarms/reminders and missed reminder handling exist. OS notification behavior still needs packaged Windows validation. |
| Model routing, fallback, rate limits and health | Implemented and automated-test verified | Capability/tier routing, bounded retry, explicit fallback, rate-limit learning, health cooldown, latency/tokens and known-price estimates exist. Explicitly forced models now reject disabled, unconfigured, unavailable, offline, or capability-incompatible choices. |
| Visual perception, OCR/UIA, adaptive action and verification | Implemented, externally unverified | The Windows desktop agent, screenshots/OCR/UIA, semantic selectors, before/after perception, task verification and bounded recovery exist. Real Windows applications, DPI layouts, secure desktops and packaged agent startup were not available. |
| Permissions, approvals, audit and emergency stop | Implemented and automated-test verified | Backend policy, confirmation lifecycle, audit records, high-risk prompts and global stop are present. Default emergency shortcut: `Control+Alt+Shift+S`. Secure desktop/UAC cannot and must not be bypassed. |
| Controlled update/signing/release quality | Partial | CI, production build, version consistency, Electron hardening and audit controls exist. Signed update metadata, rollback installer, staged rollout and crash telemetry are still missing. |
| Observability | Partial | Task timings/usage, provider health, logs, research progress, sources, findings, failures and known/unpriced cost are visible. There is no external metrics backend, distributed trace, long-duration SLO report, or privacy-reviewed telemetry uploader. |

### SARA 12: persistent documents, code and task intelligence

| Capability | Status | Evidence and limits |
|---|---|---|
| Structured long-term memory with provenance/corrections/expiry | Implemented and automated-test verified | Existing structured memory supports confidence, source IDs, duplicate merging, supersession, expiry and project filtering. |
| Persistent resumable task intelligence | Implemented and automated-test verified | Plans, actions, observations, touched files, checkpoints, verification, timing and model use are persisted. |
| Authorized webpage evidence store | Implemented and automated-test verified in this increment | Retrieval records and passages are stored separately from reports/knowledge, with URL, redirect result, retrieval time, Last-Modified, SHA-256 content hash and injection indicator. |
| PDF/DOCX/code repository ingestion | Implemented and automated-test verified | Explicitly authorized local folders now index PDF, DOCX/XLSX/PPTX Open XML, RTF, text/configuration files and common source languages. PDF citations use pages; Office citations use paragraphs/slides/sheets/rows; source citations use lines. Legacy DOC/XLS/PPT and extraction failures are explicit rather than silently accepted. |
| Incremental file/code indexing and project map | Implemented and automated-test verified | Per-source manifests track identity/hash/mtime/version/status/duplicates; reindex skips unchanged files and cleans deleted derivations. Project maps cover entry points, modules, dependencies, routes, model symbols, tests, build commands, imports, Git history and unresolved markers. Bounded periodic refresh is opt-in per source. |
| Hybrid keyword/vector retrieval and snippet citations | Implemented; live embeddings externally unverified | Exact/keyword, filename, code-symbol and metadata retrieval are locally available. Optional permitted embeddings feed hybrid reranking. Results are thresholded/diversified and include passage locations, staleness, likely conflicts, injection flags, corrections and uncertainty. |
| Per-user/document ACL filtering | Implemented for the current single-user profile | The backend-owned `local-default` principal and explicit source grants are applied before retrieval; request bodies cannot select another owner. Cloud-model access is an independent per-source opt-in. This is not a claim of multi-tenant remote authentication. |
| Deletion and correction | Implemented and automated-test verified | Research/knowledge lifecycle remains. Indexed-source deletion removes documents, chunks/vectors, symbols, corrections, jobs and maps without deleting originals. Correction notes are surfaced in later retrieval; export, retention, reindex and interruption recovery are available. |

### SARA 13: AI intelligence network, research and safe learning

| Capability | Status | Evidence and limits |
|---|---|---|
| Gemini/OpenAI-compatible/Anthropic-compatible/local gateway | Implemented; live providers externally unverified | Real provider adapters already existed. OpenAI and Anthropic provider templates/models are now visible in settings; saving a backend key explicitly enables that provider. Local OpenAI-compatible endpoints remain configuration-driven. No provider secret enters renderer catalogues or logs. |
| Multi-provider consultation | Implemented and automated-test verified with provider fixtures | Up to three bounded parallel consultations are selected with provider diversity preference. Partial provider failures are retained rather than hidden. |
| Independent coordinator/reviewer | Implemented and automated-test verified with provider fixtures | A preferably unused provider reviews proposals, records consensus, disagreements, unsupported claims and limitations. The result says `reviewed`, never `verified`, because model agreement is not proof. |
| Token/latency/cost reporting | Implemented | Per-call token and latency data are retained. Cost is estimated only when the model configuration declares input and output prices; otherwise the result and dashboard explicitly say unpriced/unknown. |
| PLAN/DISCOVER/EXTRACT/ANALYZE/REPORT research | Partial, automated-test verified with HTTP/model fixtures | All stages and progress are persisted. `DISCOVER` is deliberately limited to user-supplied authorized URLs; no search engine/API connector is configured yet. |
| Authorized browsing policy | Implemented and automated-test verified | Explicit `authorized: true`, public HTTP(S)-only SSRF controls, DNS/redirect validation, robots.txt enforcement, response limits, bounded source count and no CAPTCHA/paywall/auth bypass. Terms/licence interpretation cannot be automated reliably and remains the user's responsibility. |
| Passage citations and source metadata | Implemented and automated-test verified | Reports must cite exact stored passage labels; unknown citations are rejected as evidence. Findings preserve source/passage IDs, timestamps, URL, content hash and freshness metadata. |
| Contradiction and uncertainty handling | Implemented | Coordinator disagreements become unresolved contradiction records. Findings are only `supported`, `uncertain`, `conflicting` or `unresolved`; research never marks them verified. |
| Website prompt-injection defense | Implemented and automated-test verified | Source text is bounded untrusted data, known injection phrases are flagged, page content cannot grant permissions or invoke tools, and provider system prompts prohibit following retrieved instructions. |
| Explicit learning/promotion | Implemented and automated-test verified | Research does not silently alter long-term knowledge. A user must promote a source-cited finding. Stored knowledge carries status, confidence, source/passage IDs, limitations and a 30-day revalidation deadline. |
| Versioned reusable skills | Implemented and automated-test verified | Pending proposals are non-executable. Reuse requires passed `automated_test` or `demonstration` evidence; a boolean/manual review alone is insufficient. Versions preserve tools, permissions, dependencies, tests, provenance, limitations, failure guidance and rollback history. Stale or repeatedly failing skills are suspended. |
| Isolated code experiment sandbox | Missing | No code execution sandbox is claimed. A dependable implementation still needs OS-level isolation, network deny-by-default, read-only inputs, resource/output/time limits, dependency/license checks and review before applying patches. |
| Scheduled quiet refresh | Partial | Knowledge and skills become outdated when revalidation deadlines pass, and research can be retried from preserved requests. There is no quiet-hours scheduler, change notification policy or automatic re-research queue yet. |
| Learning/research dashboard | Implemented | The **LEARN** panel shows research progress/history, sources/passages, findings, limitations/errors, knowledge, consultations/disagreements, skills/versions, providers, health, usage and known/unpriced cost. Start, cancel, retry, delete, promote, mark-outdated and rollback operations call real backend APIs. |

### SARA 14: capability-routed generative studio

| Capability | Status | Evidence and limits |
|---|---|---|
| Text/code generation | Implemented through the model gateway | Provider-dependent and only available after configuration/availability checks. Existing agent coding still requires user approval and verification. |
| Embeddings | Implemented, externally unverified | Provider-independent embedding contract and Gemini adapter exist; no live key test occurred. |
| Realtime provider speech | Implemented, externally unverified | Existing Gemini Live path; not a general audio-generation/export studio. |
| Image generation/editing | Missing | Vision input is not image generation. No supported image artifact provider or save/export workflow is claimed. |
| TTS/music/audio generation | Missing beyond realtime voice | No provider-independent generated-audio artifact contract, rights metadata or export workflow. |
| Video generation/editing | Missing | No video provider adapter, job polling, artifact verification or export. |
| 3D/avatar generation/animation | Partial | Character import/render/pose/physics features exist, but there is no text-to-3D generation provider or generated asset licence pipeline. |
| Real PDF/DOCX/XLSX/PPTX export | Partial, Windows Office externally unverified | Dedicated, approval-gated local COM workflows create and verify new DOCX/XLSX/PPTX files and export Office Open XML files to PDF without overwriting. The interface/no-overwrite policy is tested; real Office execution remains blocked in this Linux environment and this is not a provider-independent artifact renderer. |
| Rights/safety/cost metadata per artifact | Missing | This requires the unified artifact/job contract planned below. |

## 3. Delivered architecture

### 3.1 Collaboration

`intelligence/collaborationEngine.ts`:

1. validates and bounds a request;
2. selects configured models, preferring distinct providers;
3. runs consultations concurrently with existing model-router cancellation, timeout, rate-limit and usage controls;
4. retains successes and explicit failures;
5. chooses a reviewer, preferring an unused provider;
6. normalizes consensus, disagreements, unsupported claims, recommended answer and limitations;
7. reports whether the reviewer is provider-independent;
8. labels output `reviewed` rather than `verified`.

### 3.2 Research and evidence

`intelligence/researchEngine.ts`, `robots.ts`, and `researchStore.ts` implement:

- explicit authorized URL input (maximum 8);
- public-network SSRF checks on every DNS/redirect hop;
- robots policy retrieval and longest-rule evaluation;
- 2 MB page and 256 KB robots limits;
- deterministic relevant-passage extraction;
- separate immutable retrieval/source records and report/session records;
- prompt-injection indicators;
- citation validation against stored passage labels;
- disagreement/limitation preservation;
- explicit promotion to knowledge;
- cancellation, retry lineage, deletion and restart interruption state.

Persistent data lives under the application data directory:

- `intelligence/research-sessions.v1.json`
- `intelligence/research-sources.v1.json`
- `intelligence/knowledge.v1.json`

Writes use the existing atomic JSON helper and serialized mutation queue.

### 3.3 Skill lifecycle

`cognition/skillManager.ts` upgrades persisted skill content to schema version 2 while reading v1 records conservatively. Legacy boolean-only skills become `legacy_unreviewed`, not silently trusted. New lifecycle APIs support:

- propose;
- attach demonstration/automated-test evidence;
- verify;
- record outcomes;
- automatically suspend repeated failures;
- mark outdated/disabled;
- roll back to an evidenced verified version;
- delete.

### 3.4 APIs

Key new local APIs:

- `GET /api/intelligence/status`
- `POST /api/intelligence/collaborate`
- `GET|POST /api/research`
- `GET|DELETE /api/research/:id`
- `POST /api/research/:id/cancel|retry`
- `POST /api/research/:id/findings/:findingId/promote`
- `GET|DELETE /api/knowledge[/:id]`
- `POST /api/knowledge/:id/correct`
- `POST /api/skills/proposals`
- `POST /api/skills/:id/verify|rollback|status|outcome`
- `DELETE /api/skills/:id`

These remain behind the existing loopback host/origin policy; they are not exposed as a permissive remote API.

## 4. Setup and use

```bash
npm ci
npm run lint
npm test
npm run build
npm run dev
```

1. Open **Settings → AI models & keys**.
2. Save only keys for providers you intend to use. Keys are sent once to the backend secret store and are never returned to the renderer.
3. Use **Refresh/Test** in model settings to verify actual availability.
4. Open **LEARN** in the main header.
5. For research, enter a question and one public URL per line, confirm authorization, then start.
6. Inspect preserved passages and limitations before promoting a finding to knowledge.
7. Cancel any active run from its detail view; retry creates a new session linked to the previous one.

Provider/key requirements:

- Gemini: Google Gemini API key.
- OpenAI: OpenAI API key and availability of the configured `gpt-5` model alias, or a user model override in `<data>/models/models.json`.
- Anthropic: Anthropic API key and availability of the configured `claude-sonnet-4-5` alias, or a user model override.
- Local: an explicitly enabled OpenAI-compatible service/model. No private file is uploaded merely by enabling it. A no-secret template is provided at [`models.example.json`](./models.example.json); copy and adapt it as `<data>/models/models.json`.

Model catalogues are checked at runtime; a default name is a configuration candidate, not a guarantee that a provider/account offers it. Skill schema migration is automatic on first load; v1 boolean-only verification is retained as `legacy_unreviewed` and requires fresh evidence before reuse.

## 5. Security and privacy limits

- Webpages, documents, provider output and tool output remain untrusted data.
- Research cannot grant permissions, execute page instructions, expose secrets or invoke desktop tools.
- Provider collaboration sends the supplied prompt/evidence to every selected cloud provider. Do not include private material unless the provider and project are explicitly authorized for it.
- No local file/document upload path was added in this increment.
- Robots permission is not a substitute for contractual permission, copyright review or website terms.
- Citations show what a source passage said; they do not prove the statement true.
- Model agreement is not independent verification.
- The current persistence boundary is one local application profile. Do not deploy the server as a multi-user service without authentication, tenant IDs and row-level authorization.
- There is no safe code sandbox yet, so learned content cannot execute arbitrary code.

## 6. Cancellation, emergency stop and rollback

- Research: **Cancel** aborts retrieval/provider requests; **Retry** starts a new linked session.
- Autonomous desktop work: use the task stop control or default global shortcut `Control+Alt+Shift+S`.
- Provider failure: successful consultations remain visible and the overall result becomes partial; failures are not replaced by fabricated answers.
- Skill rollback: open **LEARN → Skills** and restore a prior evidenced verified version.
- Code rollback: revert the implementation commit with Git after backing up application data. Persistent schema v2 is backward-readable only by the new manager; restoring old code may require restoring the old `skills.v1.json` backup as well.

## 7. Validation results

Executed in this repository on 2026-10-16:

| Check | Result |
|---|---|
| `npm run lint` | Passed (`tsc --noEmit`, zero diagnostics). |
| `npm run test:node` | **99 passed, 0 failed, 8 skipped**. Six skips require a live Gemini key; other skips are platform-specific. Wall time was approximately 17.3 s in this sandbox. |
| Intelligence/cognition targeted run | **16 passed, 0 failed** in 1.46 s reported test duration. The three intelligence tests alone completed in 0.44 s; fixture consultation responses declare 7–11 ms synthetic adapter latency. These are orchestration fixtures, not cloud-provider benchmarks. |
| `PATH="$PWD/.venv/bin:$PATH" npm run test:python` | **29 passed, 0 failed, 3 Windows-only skipped** (32 total) in 0.089 s reported test time. |
| `npm run build` | Passed. Vite transformed 2,143 modules in 8.97 s; the Node backend bundle completed in 144 ms. Total command wall time was approximately 10.05 s. |
| GitHub `windows-latest` CI | Passed in 1m54s on PR run 38934901774: install, type-check, all Node suites, Python suite and production build. This validates automation on a Windows runner, not interactive UIA/OCR/microphone behavior. |
| Production HTTP smoke | Root `200`; intelligence status `200`; unauthorized research correctly `400`; status reported 4 providers, 10 models and no fabricated activity. Ten loopback status requests measured **0.90 ms min / 1.47 ms mean / 4.60 ms max** in this sandbox. |
| `npm audit --json` | 0 critical, 0 high, 8 moderate, 0 low. The remaining findings are development/build transitive dependencies documented in the baseline audit; no forced breaking remediation was applied. |
| `git diff --check` | Passed. |

Live cloud providers, Windows UIA/OCR, microphone/audio, Electron GUI and packaged installers were **not** exercised, because this environment had no user credentials, Windows desktop or capture hardware. The intelligence tests use explicit local fake provider/HTTP fixtures and therefore validate orchestration and safety logic—not external service quality or real provider latency.

### Principal files added or changed in this increment

- `intelligence/types.ts` — collaboration, research, evidence and knowledge contracts.
- `intelligence/collaborationEngine.ts` — provider-diverse consultations and cautious review.
- `intelligence/researchEngine.ts` — staged authorized research and citation enforcement.
- `intelligence/robots.ts` — robots policy retrieval/parser.
- `intelligence/researchStore.ts` — atomic source/session/knowledge persistence and deletion.
- `intelligence/service.ts` — lifecycle, cancellation and REST APIs.
- `cognition/skillManager.ts`, `cognition/types.ts` — versioned/evidenced skills and rollback.
- `models/defaults.ts`, `models/registry.ts`, `models/router.ts`, `models/usage.ts` — optional providers, forced-route validation and cost visibility.
- `agent/webFetch.ts` — source metadata plus bounded HTML/text/JSON/XML retrieval.
- `runtime/myraaRuntime.ts`, `server.ts`, `shared/appEvents.ts` — service wiring, progress and graceful persistence.
- `src/components/IntelligenceDashboard.tsx`, `src/App.tsx`, `src/components/SettingsPanel.tsx` — real dashboard and optional provider configuration.
- `tests/intelligence.test.ts`, `cognition/tests/cognition.test.ts` — collaboration/research/injection/deletion and skill-version regressions.
- `README.md` and this report — setup, security boundaries and remaining work.

## 8. Remaining phased plan

### Phase A — complete SARA 12 ingestion

1. Add authorized roots and per-project access policy.
2. Parse PDF/DOCX/XLSX/PPTX and code with file/version hashes and deletion tombstones.
3. Build keyword + vector retrieval with reranking, exact snippet citations and permission filtering before retrieval.
4. Add incremental watchers, symbol/import/project maps and index health/rebuild tools.

### Phase B — sandboxed learning and revalidation

1. Add an OS-isolated worker (Windows AppContainer/job object or containerized helper) with no network/secrets by default.
2. Enforce read-only inputs, disposable workspace, CPU/RAM/disk/output/time limits.
3. Add static analysis, tests, dependency vulnerability/licence review and human approval before patch application.
4. Store test logs/output hashes as first-class skill evidence.
5. Add quiet-hours refresh schedules, source change detection and correction notifications.

### Phase C — research discovery and provider policy

1. Add opt-in official search/API connectors with provider-specific credentials and terms metadata.
2. Add domain allowlists, per-project provider/data residency policies and dollar/token budgets.
3. Add claim-level cross-source independence scoring and freshness policies.
4. Add provider circuit-breaker dashboards and long-duration reliability tests.

### Phase D — SARA 14 artifact studio

1. Define provider-independent generation job/artifact contracts (capability, MIME type, provenance, rights, safety, cost, status, checksum).
2. Add one real provider at a time with asynchronous job polling, cancellation and byte-level output verification.
3. Add local artifact storage/export and format validators before showing a success message.
4. Add image, audio, video and 3D only where the configured provider genuinely supports them.
5. Add real document exporters with deterministic fixture validation.

### Phase E — release validation

1. Windows 10/11 UIA/OCR and multi-monitor/DPI matrix.
2. Microphone/speaker barge-in and long conversation tests.
3. Signed installer/update/rollback tests.
4. Multi-hour concurrency, restart, provider outage and quota exhaustion tests.
5. Security review of connector scopes, data retention and multi-profile isolation.
