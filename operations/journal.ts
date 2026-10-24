/**
 * Operation journal — receipts for everything Sara actually did.
 *
 * The agent already returns a structured ActionResult; this records it so the
 * user can see a timeline, and so reversible actions can be undone. Two rules
 * are enforced here rather than in the UI:
 *
 *  - a step is only SUCCESS when the executor reported success, and the
 *    `verified` flag says whether an independent check confirmed it;
 *  - an undo is only offered when the inverse is fully determined by the
 *    arguments. Anything ambiguous (a move whose final path we cannot know) is
 *    marked `unavailable` instead of guessing.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import { readJsonFile, writeJsonFile } from "../shared/jsonFile";
import { summarizeArgs } from "../shared/redact";

export type OperationStatus = "RUNNING" | "SUCCESS" | "FAILED" | "UNCERTAIN" | "CANCELLED" | "NEEDS_APPROVAL";

export type UndoState = "none" | "available" | "done" | "failed" | "unavailable";

export interface UndoAction {
  tool: string;
  args: Record<string, unknown>;
  /** What the user is agreeing to, in one line. */
  label: string;
  /** True when the undo itself is destructive and must be confirmed again. */
  destructive: boolean;
}

export interface OperationRecord {
  id: string;
  at: string;
  endedAt: string | null;
  taskId: string | null;
  tool: string;
  /** Redacted, human-readable arguments. */
  args: string;
  status: OperationStatus;
  /** Independent verification, when the tool provides it. */
  verified: boolean;
  verification: string | null;
  summary: string;
  error: string | null;
  durationMs: number | null;
  undo: UndoAction | null;
  undoState: UndoState;
  undoneAt: string | null;
  /** The operation created by the undo, when one ran. */
  undoOperationId: string | null;
}

/** What the executor hands back; a narrow shape so this module stays independent. */
export interface ExecutedResult {
  ok: boolean;
  tool: string;
  summary: string;
  error?: string;
  category?: string;
  verification?: { passed: boolean; evidence: string };
  durationMs?: number;
}

interface StoreShape {
  version: 1;
  operations: OperationRecord[];
}

export interface JournalOptions {
  dataDir: string;
  now?: () => number;
  limit?: number;
}

export class OperationJournal {
  private operations: OperationRecord[] = [];
  private readonly file: string;
  private readonly now: () => number;
  private readonly limit: number;
  private ready = false;
  private readonly running = new Map<string, { at: number; tool: string; args: Record<string, unknown>; taskId: string | null }>();

  constructor(options: JournalOptions) {
    this.file = path.join(options.dataDir, "operations", "journal.v1.json");
    this.now = options.now ?? Date.now;
    this.limit = options.limit ?? 500;
  }

  async initialize(): Promise<void> {
    const stored = await readJsonFile<StoreShape>(this.file, { version: 1, operations: [] });
    this.operations = Array.isArray(stored.operations) ? stored.operations : [];
    // Anything that was RUNNING when the process stopped is honest about it.
    for (const record of this.operations) {
      if (record.status === "RUNNING") {
        record.status = "UNCERTAIN";
        record.summary = `${record.summary} (the process stopped before this finished)`;
        record.endedAt = record.endedAt ?? new Date(this.now()).toISOString();
      }
    }
    this.ready = true;
  }

  /** Begin an operation; returns the id used by `finish`. */
  start(input: { tool: string; args: Record<string, unknown>; taskId: string | null }): string {
    const id = randomUUID();
    this.running.set(id, { at: this.now(), tool: input.tool, args: { ...input.args }, taskId: input.taskId });
    return id;
  }

  /** Record the outcome. Returns the stored record, or null if it never started. */
  async finish(id: string, result: ExecutedResult): Promise<OperationRecord | null> {
    const started = this.running.get(id);
    if (!started) return null;
    this.running.delete(id);
    const endedAt = this.now();
    const status = mapStatus(result);
    const record: OperationRecord = {
      id,
      at: new Date(started.at).toISOString(),
      endedAt: new Date(endedAt).toISOString(),
      taskId: started.taskId,
      tool: result.tool || started.tool,
      args: summarizeArgs(maskFreeText(started.args)),
      status,
      verified: Boolean(result.verification?.passed),
      verification: result.verification?.evidence ?? null,
      summary: String(result.summary || "").slice(0, 300),
      error: result.error ? String(result.error).slice(0, 300) : null,
      durationMs: typeof result.durationMs === "number" ? result.durationMs : endedAt - started.at,
      undo: status === "SUCCESS" ? undoFor(result.tool || started.tool, started.args) : null,
      undoState: "none",
      undoneAt: null,
      undoOperationId: null,
    };
    record.undoState = record.undo ? "available" : "unavailable";
    this.operations.push(record);
    if (this.operations.length > this.limit) this.operations = this.operations.slice(-this.limit);
    await this.save();
    return { ...record };
  }

  list(limit = 50, taskId?: string): OperationRecord[] {
    const source = taskId ? this.operations.filter((record) => record.taskId === taskId) : this.operations;
    return source.slice(-Math.max(1, Math.min(limit, 200))).reverse().map(copy);
  }

  get(id: string): OperationRecord | null {
    const record = this.operations.find((item) => item.id === id);
    return record ? copy(record) : null;
  }

  /** Claim an undo for execution. Returns null when it is not available. */
  async beginUndo(id: string): Promise<{ record: OperationRecord; action: UndoAction } | null> {
    const record = this.operations.find((item) => item.id === id);
    if (!record || record.undoState !== "available" || !record.undo) return null;
    record.undoState = "done";
    record.undoneAt = new Date(this.now()).toISOString();
    await this.save();
    return { record: copy(record), action: { ...record.undo, args: { ...record.undo.args } } };
  }

  /** Mark the outcome of an undo attempt. */
  async settleUndo(id: string, succeeded: boolean, undoOperationId: string | null): Promise<void> {
    const record = this.operations.find((item) => item.id === id);
    if (!record) return;
    record.undoState = succeeded ? "done" : "failed";
    record.undoOperationId = undoOperationId;
    if (!succeeded) record.undoneAt = null;
    await this.save();
  }

  async save(): Promise<void> {
    await writeJsonFile(this.file, { version: 1, operations: this.operations } satisfies StoreShape);
  }
}

/**
 * Mask free text before it reaches the journal.
 *
 * Typed messages and note bodies are the most private thing the agent handles,
 * and the journal is read by the UI and kept on disk, so those values are
 * replaced rather than stored.
 */
function maskFreeText(args: Record<string, unknown>): Record<string, unknown> {
  const masked: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    masked[key] = /^(text|message|body|typed|value|content|note|prompt)$/i.test(key) ? "[hidden]" : value;
  }
  return masked;
}

function mapStatus(result: ExecutedResult): OperationStatus {
  if (result.ok) return "SUCCESS";
  if (result.category === "CANCELLED") return "CANCELLED";
  if (result.category === "PERMISSION_DENIED" || result.category === "CONFIRMATION_REJECTED") return "FAILED";
  return "FAILED";
}

/**
 * Compute the inverse of an action, or null when it cannot be known for sure.
 *
 * Only file operations are reversible today. A move is deliberately excluded:
 * when the destination is a folder, the final path depends on the agent's
 * resolution, and guessing it could move the wrong file back.
 */
export function undoFor(tool: string, args: Record<string, unknown>): UndoAction | null {
  const source = typeof args.path === "string" ? args.path : null;
  if (!source) return null;

  if (tool === "fs.rename") {
    const newName = typeof args.new_name === "string" ? args.new_name : "";
    if (!newName || newName.includes("/") || newName.includes("\\")) return null;
    const renamedTo = path.join(path.dirname(source), newName);
    return {
      tool: "fs.rename",
      args: { path: renamedTo, new_name: path.basename(source) },
      label: `Rename ${path.basename(renamedTo)} back to ${path.basename(source)}`,
      destructive: false,
    };
  }

  if (tool === "fs.copy") {
    const destination = typeof args.destination === "string" ? args.destination : "";
    if (!destination) return null;
    // Only when the destination is an explicit file path; a folder destination
    // would require knowing the resolved name.
    const looksLikeFolder = !path.extname(destination);
    if (looksLikeFolder) return null;
    return {
      tool: "fs.delete",
      args: { path: destination },
      label: `Remove the copy at ${destination}`,
      destructive: true,
    };
  }

  if (tool === "fs.create_text") {
    return {
      tool: "fs.delete",
      args: { path: source },
      label: `Remove the file ${path.basename(source)} that was created`,
      destructive: true,
    };
  }

  return null;
}

function copy(record: OperationRecord): OperationRecord {
  return JSON.parse(JSON.stringify(record)) as OperationRecord;
}
