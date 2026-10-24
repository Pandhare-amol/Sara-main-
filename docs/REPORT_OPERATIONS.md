# Operations report — receipts, verified outcome, undo

Evidence-based. Everything marked PASS ran in this workspace or on a GitHub
runner on **2026-10-23**. Items that could not be executed here are under
*Remaining limitations*; nothing is reported as working because it looks
finished.

## FILES MODIFIED

```
operations/journal.ts             NEW — OperationJournal, status model, undoFor, maskFreeText
agent/actions/executor.ts         journal receipts around every action (executeInner + start/finish)
runtime/myraaRuntime.ts           journal instance + /api/operations, /api/operations/:id, /:id/undo
src/lib/appApi.ts                 OperationView types + operations()/undoOperation()
src/mobile/MobileIntelPanels.tsx  Activity panel (receipts, verification, undo)
src/mobile/MobileApp.tsx          menu entry "Activity"
src/mobile/MobilePanels.tsx       sheet id + title
tests/operations.test.ts          NEW — 14 tests
package.json                      test:operations, wired into `npm test`
.github/workflows/android-apk.yml persona/calls/capabilities/operations now run in CI
docs/OPERATIONS_AND_UNDO.md       NEW — operator documentation
```

## EXECUTION TRUTH

| Item | State | Evidence |
| --- | --- | --- |
| Every action the executor runs leaves a receipt | PASS | `tests/operations.test.ts` "the executor journals every action it runs": one `fs.stat` → exactly one record with the same tool, task id and status |
| `SUCCESS` only when the tool reported success | PASS | status derived from `result.ok`; failed tool → `FAILED` (unit test) |
| `verified` only from real verification | PASS | `verified` copied from `result.verification.passed`; test asserts `false` for an unverified success |
| Crash-left work is not reported as done | PASS | a `RUNNING` receipt reloaded from disk becomes `UNCERTAIN` on `initialize()` |
| Cancelled work is distinguishable | PASS | `CANCELLED` status covered by unit test |
| Typed text / message bodies never stored | PASS | `maskFreeText` masks `text|message|body|typed|value|content|note|prompt`; test asserts the sentence does not appear in `args` |
| Journal is bounded | PASS | 500-record cap; limit-5 test shows the older records are dropped |
| Journal survives restart | PASS | write, reopen, `initialize()`, `list()` still returns the receipt |

## UNDO

| Item | State | Evidence |
| --- | --- | --- |
| Rename is reversible on a real filesystem | PASS | test creates `report.docx`, runs `fs.rename` through the executor, then runs the inverse through the same executor path the HTTP route uses: `report.docx` is back and its contents are intact |
| Copy / created file are reversible | PASS | `undoFor` returns `fs.delete` for `fs.copy` (explicit file destination) and `fs.create_text`, marked `destructive` |
| Move is not pretended to be reversible | PASS | `undoFor("fs.move", …)` → `unavailable`; documented in the panel and in `docs/OPERATIONS_AND_UNDO.md` |
| Undo is single-use | PASS | second `beginUndo` returns `null` |
| A failed undo does not claim success | PASS | `settleUndo(id,false,…)` → `undoState:"failed"`, `undoneAt` stays `null` |
| Undo is journaled and audited too | PASS | inverse runs through `executor.execute` (own receipt, task id `undo:<id>`) and writes a `recovery` audit entry |

## API

| Request | Observed | State |
| --- | --- | --- |
| `GET /api/operations` (built server, `dist/server.cjs`, port 3030) | `200 {"operations":[]}` | PASS |
| `GET /api/operations/<unknown>` | `404 {"error":"That operation is not in Sara's journal."}` | PASS |
| `POST /api/operations/<unknown>/undo` | `404` unknown id (409 reserved for "exists but not reversible") | PASS |
| `POST /api/operations/<known-but-not-reversible>/undo` | `409 {"error":"That action cannot be undone from here."}` | PASS (unit + route logic) |

Live run used `MYRAA_DATA_DIR=/tmp/sara-ops-smoke`, i.e. a real built server, no
stubs.

## UI

`Activity` is a new sheet in the mobile menu: newest receipt first, tool, local
time, duration, status, `verified`/`unverified` marker, verification evidence,
error text, and an **Undo** button only when `undoState === "available"`
(destructive undos are labelled). The phone-shell smoke suite renders the menu
with the new entry (50/50 checks pass).

## PERFORMANCE

- No extra process, timer, network call or Gemini request: receipts are written
  in-process around code that already ran.
- Reads hit an in-memory array; the file is rewritten only when a receipt
  changes, capped at 500 records.
- The Activity panel fetches only when opened.

## TESTS

| Suite | Result |
| --- | --- |
| `npm run test:operations` | **14/14 pass** |
| `npm run lint` (`tsc --noEmit`) | 0 errors |
| `npm run test:agent` | 46 pass, 0 fail, 1 skipped |
| `npm run test:characters` | 8 pass, 1 skipped |
| `npm run test:python` | 32 pass (3 skipped) — after `pip install Pillow numpy` in this sandbox |
| `npm run test:remote-access` | 13/13 |
| `npm run test:mobile` | 6/6 |
| `npm run test:persona` | 33/33 |
| `npm run test:calls` | 30/30 |
| `npm run test:capabilities` | 23/23 |
| `npm run test:ui` (phone 50 + desktop 6) | PASS |
| `npm run build` | PASS — `dist/server.cjs` 924,283 B; mobile chunk 94,070 B |
| `npm run check:bundle-secrets` | PASS — 12 files scanned, no credentials |
| CI `android-apk.yml` run `39896998417` (commit `edb6d18`) | **success** |
| CI re-run `39897308938` (commit `7223a6b`, tests added to pipeline) | **success** — web 1,228,705 B, debug APK 5,375,635 B |

CI change: the unit-test step previously ran agent/characters/remote-access/mobile
only, so the persona, calls, capabilities/messaging and operations suites were
never executed on the runner. They now run there and passed on `7223a6b`.

## REMAINING LIMITATIONS (observed)

- Undo is one inverse action, not a transaction: it does not chain, and it does
  not roll back side effects a tool performed that are not modelled in `undoFor`.
- `fs.move` is deliberately not reversible from the journal.
- Only the newest 500 receipts are kept; there is no export yet.
- The sandbox is Linux without a Windows desktop agent, so receipts for
  Windows-only tools could not be produced here; the journal code path they use
  is the same one exercised by the tests.
- No physical Android device was used; the Activity panel was verified in the
  jsdom phone-shell smoke suite, not on hardware.
