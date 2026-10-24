# Operation receipts and the undo journal

Every action the executor actually runs now leaves a **receipt**. The receipt
exists so the app can never show "done" for something that failed, was never
verified, or was cancelled halfway — and so a reversible change can be taken
back without asking Sara to remember what she did.

Code: `operations/journal.ts` (journal + undo rules), wired into
`agent/actions/executor.ts` (writes receipts) and `runtime/myraaRuntime.ts`
(HTTP surface).

## What a receipt contains

| field | meaning |
| --- | --- |
| `id`, `at`, `endedAt`, `durationMs` | when the action started and finished |
| `taskId` | the task that asked for it (`null` for one-off actions) |
| `tool` | the tool that ran, e.g. `fs.rename` |
| `args` | arguments, **redacted** (see below) |
| `status` | one of the statuses below |
| `verified` | `true` only when the executor's own verification passed |
| `verification` | the evidence string, e.g. `report.docx exists.` |
| `summary` | what happened, in plain words |
| `error` | failure text when `status` is `FAILED` / `UNCERTAIN` |
| `undo`, `undoState`, `undoneAt`, `undoOperationId` | the reversal, if one is fully determined |

### Statuses

- `RUNNING` — started, not finished. A receipt still `RUNNING` on the next boot
  becomes `UNCERTAIN`: the process died mid-action, so the honest answer is
  "we do not know".
- `SUCCESS` — the tool reported success. `verified` stays `false` unless the
  executor independently checked the outcome.
- `FAILED` — the tool or its verification failed.
- `UNCERTAIN` — the action went out but the result could not be established.
- `CANCELLED` — stopped by the emergency STOP or a cancelled task.
- `NEEDS_APPROVAL` — the policy layer asked for confirmation and never got one.

`SUCCESS` is derived from the executor's `result.ok`; there is no path that
writes `SUCCESS` optimistically.

### Redaction

Argument values are masked before they are stored. The journal masks
`text`, `message`, `body`, `typed`, `value`, `content`, `note` and `prompt`
in addition to the shared redactor's `clipboard`, `content`, `image_base64`,
`audio` and `data`. Typed text and message bodies therefore never land in the
journal file.

## Undo

An undo is only offered when the inverse is *fully determined*:

| action | undo | note |
| --- | --- | --- |
| `fs.rename` | `fs.rename` back to the original name | only when the new name is a plain file name (no separators) |
| `fs.copy` | `fs.delete` of the copy | only when the destination is an explicit file path; marked destructive |
| `fs.create_text` | `fs.delete` of the created file | marked destructive |
| `fs.move` | **not offered** (`unavailable`) | when the destination is a folder, the resolved final path depends on the desktop agent; guessing it could move the wrong file back |

Undo is **single-use**: `beginUndo` claims the receipt, and a second call
returns `null`. A failed undo leaves `undoState: "failed"` with no `undoneAt`,
so the UI shows the failure instead of a false "restored". The undo itself runs
through the same executor, so it is journaled, risk-checked and verified like
any other action, under a `120 s` child scope of the root cancellation scope.

### States

`none` (no inverse) · `available` · `done` · `failed` · `unavailable`.

## HTTP surface

| route | behaviour |
| --- | --- |
| `GET /api/operations?limit&taskId` | newest first, default 50 |
| `GET /api/operations/:id` | `404` when the id is not in the journal |
| `POST /api/operations/:id/undo` | `404` unknown id, `409` when no undo exists; otherwise `{ ok, label, result }` |

The undo request is audited under the `recovery` category.

## Storage and size

`operations/journal.v1.json` inside the data directory, capped at the newest
500 receipts (older ones are dropped, so the file cannot grow without bound).
The journal survives restarts, which is how crash-left `RUNNING` receipts are
found and downgraded to `UNCERTAIN`.

## UI

Mobile → menu → **Activity** lists receipts newest first with their honest
status, a `verified` / `unverified` marker, the verification evidence, error
text, duration, and an **Undo** button when one is available. Destructive
undos are labelled as such.

## Tests

`tests/operations.test.ts` — 14 cases:

- success vs failure vs uncertain vs cancelled status mapping
- `verified` only from verification evidence
- redaction of typed text and message bodies
- bounded journal (limit 5) and persistence across restart
- crash-left `RUNNING` → `UNCERTAIN`
- undo availability rules (rename / copy / create / move unsupported)
- single-use undo, failed undo state
- the executor writes a receipt for every action it runs
- a real on-disk `report.docx` → `report-final.docx` rename, undone through the
  same executor path the HTTP route uses, restoring the original name with the
  contents intact

## Limits

- Undo is **not** a general transaction rollback: it is one inverse action per
  receipt, and it does not chain.
- A move is deliberately not reversible from here.
- Deleting a receipt is not exposed; records expire by the 500-item cap.
- Undo runs as an ordinary action, so a policy that blocks the inverse blocks
  the undo — the app then reports the failure rather than claiming success.
