import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ACTION_MAP } from "../agent/actions/catalog";
import { ActionExecutor } from "../agent/actions/executor";
import { rootScope } from "../agent/cancellation";
import { ConfirmationBroker } from "../permissions/confirmations";
import { ReportService } from "../reporting/service";
import { REPORT_TEMPLATES } from "../reporting/templates";
import { validateAndNormalizeReport } from "../reporting/validation";
import { appEvents } from "../shared/appEvents";
import { validateJson } from "../shared/jsonSchema";

function request(output: string) {
  return {
    path: output,
    title: "SARA 16 Phase One Status",
    purpose: "Give maintainers a source-grounded delivery and risk summary.",
    audience: "Project maintainers",
    templateId: "project-status",
    scope: "Structured Word generation and deterministic validation only.",
    reportingPeriod: "2026-10-17",
    documentDate: "2026-10-17",
    author: "SARA engineering",
    version: "1.0",
    confidentiality: "internal",
    sections: [
      {
        id: "executive-summary",
        heading: "Executive summary",
        paragraphs: [
          { text: "The cross-platform generator creates a new Open XML Word file without requiring installed Microsoft Word.", kind: "fact", evidenceIds: ["S1"] },
          { text: "This reduces the platform dependency for first-pass professional reports while retaining explicit approval and verification.", kind: "analysis", evidenceIds: ["S1"] },
        ],
      },
      {
        id: "progress",
        heading: "Progress",
        tables: [{
          title: "Implemented controls",
          headers: ["Control", "Status"],
          rows: [["Never overwrite", "Enforced"], ["Open XML validation", "Enforced"]],
          evidenceIds: ["S1"],
        }],
      },
      {
        id: "next-steps",
        heading: "Next steps",
        bullets: [{ text: "Exercise installed Word separately on a Windows host before claiming desktop Office interoperability.", kind: "recommendation", evidenceIds: ["S2"] }],
      },
    ],
    sources: [
      { id: "S1", title: "Structured report generator test fixture", kind: "system-record", note: "Assertions in this automated test." },
      { id: "S2", title: "Office environment limitation", kind: "user-provided", note: "Installed Office is not available in this test workspace." },
    ],
    assumptions: ["The supplied test statements accurately describe this test fixture."],
    limitations: ["This execution does not test Microsoft Word COM automation or visual rendering in desktop Word."],
    calculations: [{
      id: "coverage-change",
      label: "Illustrative verified percentage change",
      operation: "percentage_change",
      inputs: [{ name: "Previous", value: 10, unit: "checks" }, { name: "Current", value: 15, unit: "checks" }],
      result: 50,
      unit: "%",
      evidenceIds: ["S1"],
    }],
    requiredSections: ["Executive summary", "Progress", "Next steps"],
  };
}

test("report templates are versioned, domain-labelled and do not claim compliance", () => {
  assert.ok(REPORT_TEMPLATES.length >= 10);
  assert.equal(new Set(REPORT_TEMPLATES.map((template) => template.id)).size, REPORT_TEMPLATES.length);
  for (const template of REPORT_TEMPLATES) {
    assert.match(template.version, /^\d+\.\d+\.\d+$/);
    assert.ok(template.domain);
    assert.ok(template.recommendedSections.length >= 4);
    assert.doesNotMatch(template.description, /certif(?:y|ies) compliance/i);
  }
});

test("report validation rejects unknown citations, placeholders and incorrect calculations", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sara-report-validation-"));
  const invalid = request(path.join(root, "invalid.docx"));
  invalid.sections[0].paragraphs![0].text = "TODO insert data here";
  invalid.sections[0].paragraphs![0].evidenceIds = ["MISSING"];
  invalid.calculations![0].result = 40;
  const result = validateAndNormalizeReport(invalid, new Date("2026-10-17T00:00:00Z"));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => /placeholder/i.test(error)));
  assert.ok(result.errors.some((error) => /unknown source 'MISSING'/i.test(error)));
  assert.ok(result.errors.some((error) => /recomputation gives 50/i.test(error)));
});

test("ReportService creates a genuine verified DOCX, records provenance and refuses overwrite", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "sara-report-service-"));
  const dataDir = path.join(root, "data");
  const output = path.join(root, "reports", "phase-one.docx");
  const service = new ReportService({ dataDir, allowedOutputRoots: [root], now: () => new Date("2026-10-17T12:00:00Z") });
  await service.initialize();
  const generated = await service.createWord(request(output));

  assert.equal(generated.path, output);
  assert.equal(generated.verified, true);
  assert.equal(generated.qa.passed, true);
  assert.ok(generated.size > 5_000);
  assert.match(generated.sha256, /^[a-f0-9]{64}$/);
  assert.ok(generated.qa.headings >= 5);
  assert.ok(generated.qa.tables >= 3);
  assert.equal(generated.qa.sourcesCited, 2);
  assert.equal(fs.existsSync(output), true);
  assert.equal((await fsp.readFile(output)).subarray(0, 2).toString("ascii"), "PK");

  const records = service.list();
  assert.equal(records.length, 1);
  assert.equal(records[0].sha256, generated.sha256);
  assert.deepEqual(records[0].sourceIds, ["S1", "S2"]);
  assert.equal(records[0].calculations, 1);
  assert.equal(fs.existsSync(path.join(dataDir, "reports", "manifests.v1.json")), true);

  await assert.rejects(service.createWord(request(output)), /already exists/i);
  assert.equal(service.list().length, 1);
});

test("ReportService confines output to approved local roots", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "sara-report-roots-"));
  const service = new ReportService({ dataDir: path.join(root, "data"), allowedOutputRoots: [path.join(root, "allowed")] });
  await service.initialize();
  await assert.rejects(service.createWord(request(path.join(root, "outside.docx"))), /outside the allowed local roots/i);
  assert.equal(fs.existsSync(path.join(root, "outside.docx")), false);
});

test("report.create_word is approval-gated and records deterministic task evidence", async () => {
  const definition = ACTION_MAP.get("report.create_word");
  assert.ok(definition);
  assert.equal(definition.capability, "OFFICE_WRITE");
  assert.equal(definition.batchable, false);
  assert.equal(definition.changesUi, false);
  assert.deepEqual(definition.resources({}), []);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sara-report-action-"));
  const args = request(path.join(root, "approved.docx"));
  assert.equal(validateJson(args, definition.args).valid, true);
  const confirmations = new ConfirmationBroker();
  let confirmation: Record<string, unknown> | null = null;
  let generated = 0;
  const executor = new ActionExecutor({
    call: async () => ({ ok: false, error: "Desktop agent must not be used for cross-platform report generation." }),
    perception: {} as never,
    permissions: {
      check: () => ({ capability: "OFFICE_WRITE", decision: "ask", reason: "Reports always ask.", locked: true }),
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
    createWordReport: async (value) => {
      generated += 1;
      assert.equal(value.title, args.title);
      return {
        path: args.path,
        title: args.title,
        size: 12_345,
        sha256: "a".repeat(64),
        verified: true,
        verification: "openxml_structure_content_and_provenance",
        qa: { passed: true, checks: [{ id: "package", status: "passed", detail: "Valid." }], warnings: [] },
      };
    },
  });
  const unsubscribe = appEvents.subscribe((event) => {
    if (event.type !== "confirmation.requested") return;
    confirmation = event.payload as Record<string, unknown>;
    confirmations.resolve(String(confirmation.id), { approved: true, via: "ui" });
  });
  const scope = rootScope.child("report-action-test");
  try {
    const result = await executor.execute({ tool: "report.create_word", args }, { taskId: "report-action-test", goal: "Create the requested Word status report", state: null, scope });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.verification?.passed, true);
    assert.equal(generated, 1);
    assert.deepEqual(result.files, [{ path: args.path, change: "created", detail: "report.create_word" }]);
    assert.ok(confirmation);
    assert.equal(confirmation!.capability, "OFFICE_WRITE");
    assert.equal(confirmation!.allowRemember, false);
    const details = confirmation!.details as Record<string, unknown>;
    assert.equal((details.report as Record<string, unknown>).sections, 3);
    assert.match(String(details.delivery), /never overwritten/i);
  } finally {
    unsubscribe();
    scope.dispose();
  }
});
