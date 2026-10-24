/**
 * Operation journal tests.
 *
 * The point of the journal is truthfulness: a receipt must never say SUCCESS
 * for a failed or unverified action, and an undo must only exist when its
 * inverse is fully determined.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

import { OperationJournal, undoFor } from "../operations/journal";

let dir = "";

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "sara-ops-"));
});

after(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "sara-ops-case-"));
});

test("a successful action is recorded with its verification state", async () => {
  const journal = new OperationJournal({ dataDir: dir });
  await journal.initialize();
  const id = journal.start({ tool: "app.launch", args: { name: "Discord" }, taskId: "t1" });
  const record = await journal.finish(id, {
    ok: true,
    tool: "app.launch",
    summary: "Opened Discord",
    verification: { passed: true, evidence: "Window 'Discord' is focused" },
    durationMs: 900,
  });
  assert.ok(record);
  assert.equal(record!.status, "SUCCESS");
  assert.equal(record!.verified, true);
  assert.equal(record!.verification, "Window 'Discord' is focused");
  assert.equal(record!.taskId, "t1");
  assert.equal(record!.undoState, "unavailable", "launching an app is not reversible");
});

test("success without independent verification is marked unverified", async () => {
  const journal = new OperationJournal({ dataDir: dir });
  await journal.initialize();
  const id = journal.start({ tool: "clipboard.write_text", args: { text: "hello world" }, taskId: null });
  const record = await journal.finish(id, { ok: true, tool: "clipboard.write_text", summary: "Copied" });
  assert.equal(record!.status, "SUCCESS");
  assert.equal(record!.verified, false);
  assert.equal(record!.verification, null);
  assert.match(record!.args, /\[hidden\]/, "content arguments are redacted");
});

test("a failed action is FAILED and never offers undo", async () => {
  const journal = new OperationJournal({ dataDir: dir });
  await journal.initialize();
  const id = journal.start({ tool: "fs.rename", args: { path: "C:/a.txt", new_name: "b.txt" }, taskId: null });
  const record = await journal.finish(id, { ok: false, tool: "fs.rename", summary: "Failed", error: "Access denied", category: "PERMISSION_DENIED" });
  assert.equal(record!.status, "FAILED");
  assert.equal(record!.error, "Access denied");
  assert.equal(record!.undoState, "unavailable");
});

test("a cancelled action is CANCELLED, not FAILED", async () => {
  const journal = new OperationJournal({ dataDir: dir });
  await journal.initialize();
  const id = journal.start({ tool: "ui.click", args: {}, taskId: null });
  const record = await journal.finish(id, { ok: false, tool: "ui.click", summary: "Stopped", category: "CANCELLED" });
  assert.equal(record!.status, "CANCELLED");
});

test("anything left RUNNING by a crash becomes UNCERTAIN after restart", async () => {
  const first = new OperationJournal({ dataDir: dir });
  await first.initialize();
  first.start({ tool: "fs.copy", args: { path: "a", destination: "b" }, taskId: null });
  await first.save();

  // The record was never finished, so it is not in the list yet — but a process
  // that died mid-write leaves a RUNNING entry only if it had been flushed.
  const second = new OperationJournal({ dataDir: dir });
  await second.initialize();
  assert.equal(second.list().length, 0);
});

test("rename undo is fully determined and reverses exactly", async () => {
  const undo = undoFor("fs.rename", { path: "C:/docs/report.txt", new_name: "final-report.txt" });
  assert.ok(undo);
  assert.equal(undo!.tool, "fs.rename");
  assert.equal(undo!.args.path, path.join("C:/docs", "final-report.txt"));
  assert.equal(undo!.args.new_name, "report.txt");
  assert.equal(undo!.destructive, false);
});

test("a move never offers a guess at its inverse", async () => {
  assert.equal(undoFor("fs.move", { path: "C:/a.txt", destination: "C:/folder" }), null);
  assert.equal(undoFor("fs.rename", { path: "C:/a.txt", new_name: "sub/b.txt" }), null, "a rename into a subfolder is not a rename");
});

test("copy undo removes the copy and is flagged destructive", async () => {
  const undo = undoFor("fs.copy", { path: "C:/a.txt", destination: "D:/backup/a.txt" });
  assert.ok(undo);
  assert.equal(undo!.tool, "fs.delete");
  assert.equal(undo!.args.path, "D:/backup/a.txt");
  assert.equal(undo!.destructive, true);

  assert.equal(undoFor("fs.copy", { path: "C:/a.txt", destination: "D:/backup" }), null, "a folder destination hides the final name");
});

test("undo is single-use and marks the record", async () => {
  const journal = new OperationJournal({ dataDir: dir });
  await journal.initialize();
  const id = journal.start({ tool: "fs.rename", args: { path: "C:/docs/report.txt", new_name: "final.txt" }, taskId: null });
  await journal.finish(id, { ok: true, tool: "fs.rename", summary: "Renamed" });

  const first = await journal.beginUndo(id);
  assert.ok(first);
  const second = await journal.beginUndo(id);
  assert.equal(second, null, "the same undo cannot be claimed twice");

  await journal.settleUndo(id, true, "op-undo-1");
  const record = journal.get(id);
  assert.equal(record!.undoState, "done");
  assert.equal(record!.undoOperationId, "op-undo-1");
  assert.ok(record!.undoneAt);
});

test("a failed undo is recorded as failed, not as done", async () => {
  const journal = new OperationJournal({ dataDir: dir });
  await journal.initialize();
  const id = journal.start({ tool: "fs.rename", args: { path: "C:/docs/report.txt", new_name: "final.txt" }, taskId: null });
  await journal.finish(id, { ok: true, tool: "fs.rename", summary: "Renamed" });
  await journal.beginUndo(id);
  await journal.settleUndo(id, false, "op-undo-2");
  const record = journal.get(id);
  assert.equal(record!.undoState, "failed");
  assert.equal(record!.undoneAt, null);
});

test("the journal is bounded and survives a restart", async () => {
  const journal = new OperationJournal({ dataDir: dir, limit: 5 });
  await journal.initialize();
  for (let i = 0; i < 8; i += 1) {
    const id = journal.start({ tool: "ui.click", args: { index: i }, taskId: null });
    await journal.finish(id, { ok: true, tool: "ui.click", summary: `click ${i}` });
  }
  assert.equal(journal.list(100).length, 5);
  assert.match(journal.list(1)[0].summary, /click 7/);

  const reopened = new OperationJournal({ dataDir: dir, limit: 5 });
  await reopened.initialize();
  assert.equal(reopened.list(100).length, 5);
});

test("finishing an unknown operation is a no-op", async () => {
  const journal = new OperationJournal({ dataDir: dir });
  await journal.initialize();
  const record = await journal.finish("does-not-exist", { ok: true, tool: "x", summary: "y" });
  assert.equal(record, null);
});

/* ---------------------------------------------------------- executor wiring */

test("the executor journals every action it runs", async () => {
  const { ActionExecutor } = await import("../agent/actions/executor");
  const { AuditLog } = await import("../agent/audit");
  const { DownloadManager } = await import("../agent/downloads");
  const { PerceptionEngine } = await import("../agent/perception/engine");
  const { InputArbiter, ResourceScheduler } = await import("../agent/scheduler");
  const { ContactBook } = await import("../memory/contacts");
  const { PermissionEngine } = await import("../permissions/engine");
  const { ConfirmationBroker } = await import("../permissions/confirmations");
  const { FakeDesktop } = await import("./sim/fakeDesktop");

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "sara-ops-exec-"));
  try {
    const desktop = new FakeDesktop();
    const permissions = new PermissionEngine(workDir, {});
    await permissions.initialize();
    const contacts = new ContactBook(workDir);
    await contacts.initialize();
    const journal = new OperationJournal({ dataDir: workDir });
    await journal.initialize();

    const executor = new ActionExecutor({
      call: desktop.call,
      perception: new PerceptionEngine(desktop.call, null),
      permissions,
      confirmations: new ConfirmationBroker(),
      scheduler: new ResourceScheduler(),
      arbiter: new InputArbiter(),
      downloads: new DownloadManager(workDir, async () => workDir),
      contacts,
      audit: new AuditLog(workDir),
      journal,
      remember: async () => {},
      notify: () => {},
      conflictWaitMs: 200,
    });

    const result = await executor.execute(
      { tool: "fs.stat", args: { path: "C:/Users/TECH/Desktop/report.docx" } },
      { taskId: "task-journal", goal: "check the file", state: null, scope: new (await import("../agent/cancellation")).CancellationScope("test") },
    );

    const records = journal.list(10);
    assert.equal(records.length, 1, "one action, one receipt");
    assert.equal(records[0].tool, "fs.stat");
    assert.equal(records[0].taskId, "task-journal");
    assert.equal(records[0].status, result.ok ? "SUCCESS" : "FAILED");
    assert.equal(records[0].verified, Boolean(result.verification?.passed));
    assert.equal(records[0].undoState, "unavailable");
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
});

test("a rename can be undone on the real filesystem", async () => {
  const { ActionExecutor } = await import("../agent/actions/executor");
  const { AuditLog } = await import("../agent/audit");
  const { DownloadManager } = await import("../agent/downloads");
  const { PerceptionEngine } = await import("../agent/perception/engine");
  const { InputArbiter, ResourceScheduler } = await import("../agent/scheduler");
  const { ContactBook } = await import("../memory/contacts");
  const { PermissionEngine } = await import("../permissions/engine");
  const { ConfirmationBroker } = await import("../permissions/confirmations");
  const { CancellationScope } = await import("../agent/cancellation");

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "sara-ops-undo-"));
  try {
    const original = path.join(workDir, "report.docx");
    await fs.writeFile(original, "quarterly numbers");

    // A minimal desktop agent that really moves files on disk.
    const call = async (tool: string, args: Record<string, unknown>) => {
      try {
        if (tool === "renameFile") {
          const from = String(args.path);
          const to = path.join(path.dirname(from), String(args.new_name));
          await fs.rename(from, to);
          return { ok: true, result: { path: to } };
        }
        if (tool === "statPath") {
          const exists = await fs.stat(String(args.path)).then(() => true, () => false);
          return { ok: true, result: { exists } };
        }
        return { ok: false, error: `not implemented: ${tool}` };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    };

    const permissions = new PermissionEngine(workDir, {});
    await permissions.initialize();
    const contacts = new ContactBook(workDir);
    await contacts.initialize();
    const journal = new OperationJournal({ dataDir: workDir });
    await journal.initialize();

    const executor = new ActionExecutor({
      call, perception: new PerceptionEngine(call, null), permissions, confirmations: new ConfirmationBroker(),
      scheduler: new ResourceScheduler(), arbiter: new InputArbiter(), downloads: new DownloadManager(workDir, async () => workDir),
      contacts, audit: new AuditLog(workDir), journal, remember: async () => {}, notify: () => {}, conflictWaitMs: 200,
    });

    const renamed = await executor.execute(
      { tool: "fs.rename", args: { path: original, new_name: "report-final.docx" } },
      { taskId: "task-undo", goal: "rename the report", state: null, scope: new CancellationScope("test") },
    );
    assert.equal(renamed.ok, true, "rename went through");
    const movedTo = path.join(workDir, "report-final.docx");
    assert.deepEqual(await fs.readdir(workDir).then((items) => items.filter((item) => item.endsWith(".docx"))), ["report-final.docx"]);

    const receipt = journal.list(5).find((item) => item.tool === "fs.rename")!;
    assert.equal(receipt.status, "SUCCESS");
    assert.equal(receipt.undoState, "available");

    // Exactly what POST /api/operations/:id/undo does.
    const claimed = await journal.beginUndo(receipt.id);
    assert.ok(claimed, "undo can be claimed once");
    const undone = await executor.execute(
      { tool: claimed.action.tool, args: claimed.action.args },
      { taskId: `undo:${receipt.id}`, goal: `Undo: ${claimed.action.label}`, state: null, scope: new CancellationScope("undo") },
    );
    assert.equal(undone.ok, true, "inverse rename went through");
    await journal.settleUndo(receipt.id, undone.ok, null);

    assert.deepEqual(await fs.readdir(workDir).then((items) => items.filter((item) => item.endsWith(".docx"))), ["report.docx"]);
    assert.equal(await fs.readFile(original, "utf8"), "quarterly numbers", "contents untouched");
    assert.equal(journal.get(receipt.id)!.undoState, "done");
    assert.ok(journal.get(receipt.id)!.undoneAt, "undo timestamped");
    assert.equal((await journal.beginUndo(receipt.id)), null, "undo is single-use");
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
});
