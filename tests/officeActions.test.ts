import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import test from "node:test";
import { ACTION_MAP } from "../agent/actions/catalog";
import { ActionExecutor } from "../agent/actions/executor";
import { rootScope } from "../agent/cancellation";
import { ConfirmationBroker } from "../permissions/confirmations";
import { PermissionEngine } from "../permissions/engine";
import { appEvents } from "../shared/appEvents";
import { validateJson } from "../shared/jsonSchema";

const EDIT_ACTIONS = ["office.edit_word", "office.edit_workbook", "office.edit_presentation"] as const;

test("Office edit actions are locked, bounded, non-batchable catalog entries", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sara-office-policy-"));
  const permissions = new PermissionEngine(dir, {});
  await permissions.initialize();
  assert.equal(permissions.check("OFFICE_WRITE").decision, "ask");
  assert.equal(permissions.check("OFFICE_WRITE").locked, true);

  for (const name of EDIT_ACTIONS) {
    const definition = ACTION_MAP.get(name);
    assert.ok(definition, `${name} should be registered`);
    assert.equal(definition.capability, "OFFICE_WRITE");
    assert.equal(definition.batchable, false);
    assert.deepEqual(definition.resources({}), ["focus"]);
  }

  const word = ACTION_MAP.get("office.edit_word")!;
  assert.equal(validateJson({ path: "C:\\Users\\A\\r.docx", operation: "append", content: "Hello" }, word.args).valid, true);
  assert.equal(validateJson({ path: "C:\\Users\\A\\r.docx", operation: "overwrite", content: "Hello" }, word.args).valid, false);

  const workbook = ACTION_MAP.get("office.edit_workbook")!;
  assert.equal(validateJson({
    path: "C:\\Users\\A\\r.xlsx",
    sheet_name: "Summary",
    updates: [{ cell: "B2", value: "=WEBSERVICE(\"x\")", expected_value: "old" }],
  }, workbook.args).valid, true);
  assert.equal(validateJson({
    path: "C:\\Users\\A\\r.xlsx",
    sheet_name: "Summary",
    updates: [{ cell: "B2", value: 2, formula: "=1+1" }],
  }, workbook.args).valid, false, "unapproved formula properties are rejected");
});

test("Office edit approval previews changes and executor records source plus backup", async () => {
  const confirmations = new ConfirmationBroker();
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const source = "C:\\Users\\A\\Documents\\report.docx";
  const backup = "C:\\Users\\A\\Documents\\report.sara-backup-20261017T000000000000Z.docx";
  const call = async (tool: string, args: Record<string, unknown>) => {
    calls.push({ tool, args });
    if (tool === "officeEditWord") {
      return {
        ok: true,
        result: {
          result: "Updated and verified report.docx in Microsoft Word; kept an automatic backup.",
          path: source,
          backup_path: backup,
          size: 2048,
          application: "word",
          verified: true,
          verification: "backup_hash_and_post_edit_content",
          before_sha256: "a".repeat(64),
          after_sha256: "b".repeat(64),
          operation: "replace_text",
          replacements: 1,
        },
      };
    }
    if (tool === "statPath") return { ok: true, result: { exists: true, size: 2048, path: args.path } };
    return { ok: false, error: `Unexpected tool ${tool}` };
  };
  const executor = new ActionExecutor({
    call: call as never,
    perception: {} as never,
    permissions: {
      check: () => ({ capability: "OFFICE_WRITE", decision: "ask", reason: "Office edits always ask.", locked: true }),
      grantForSession: () => false,
      rememberRecipient: async () => {},
    } as never,
    confirmations,
    scheduler: { withLease: async (_owner: string, _resources: string[], fn: () => Promise<unknown>) => fn() } as never,
    arbiter: {} as never,
    downloads: {} as never,
    contacts: {} as never,
    audit: { record: () => {} } as never,
    remember: async () => {},
    notify: () => {},
  });
  const scope = rootScope.child("office-edit-test");
  let request: Record<string, unknown> | null = null;
  const unsubscribe = appEvents.subscribe((event) => {
    if (event.type !== "confirmation.requested") return;
    request = event.payload as Record<string, unknown>;
    confirmations.resolve(String(request.id), { approved: true, via: "ui" });
  });
  try {
    const result = await executor.execute({
      tool: "office.edit_word",
      args: {
        path: source,
        operation: "replace_text",
        find_text: "Draft",
        content: "Final",
        expected_replacements: 1,
      },
    }, { taskId: "office-edit-test", goal: "Replace Draft with Final in report.docx", state: null, scope });

    assert.equal(result.ok, true, result.error);
    assert.equal(result.verification?.passed, true);
    assert.deepEqual(result.files, [
      { path: source, change: "modified", detail: "office.edit_word" },
      { path: backup, change: "created", detail: "Automatic backup before office.edit_word" },
    ]);
    assert.ok(request);
    assert.equal(request!.capability, "OFFICE_WRITE");
    assert.equal(request!.allowRemember, false);
    const details = request!.details as Record<string, unknown>;
    assert.match(String(details.change), /Replace exactly 1 occurrence/);
    assert.match(String(details.backup), /hash-verified/);
    assert.deepEqual(calls.map((item) => item.tool), ["officeEditWord", "statPath", "statPath"]);
  } finally {
    unsubscribe();
    scope.dispose();
  }
});
