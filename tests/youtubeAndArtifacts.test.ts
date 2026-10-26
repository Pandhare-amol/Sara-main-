import assert from "node:assert/strict";
import test from "node:test";
import { ACTION_MAP, exposedGroups } from "../agent/actions/catalog";
import { ActionExecutor } from "../agent/actions/executor";
import { rootScope } from "../agent/cancellation";
import { validateJson } from "../shared/jsonSchema";
import { handleLiveAgentTool, LIVE_AGENT_TOOL_NAMES } from "../voice/liveAgentTools";

function executorWith(call: (tool: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<{ ok: boolean; result?: unknown; error?: string }>, contentCapabilities?: () => Record<string, unknown>) {
  return new ActionExecutor({
    call: call as never,
    perception: {} as never,
    permissions: { check: (capability: string) => ({ capability, decision: "allow", reason: "test", locked: false }) } as never,
    confirmations: {} as never,
    scheduler: { withLease: async (_owner: string, _resources: string[], fn: () => Promise<unknown>) => fn() } as never,
    arbiter: { userActivity: async () => ({ active: false, keyboard: false, strength: "none" }), markSynthetic: () => {} } as never,
    downloads: {} as never,
    contacts: {} as never,
    audit: { record: () => {} } as never,
    remember: async () => {},
    notify: () => {},
    contentCapabilities,
  });
}

const youtubeState = {
  verified: true,
  active: true,
  title: "Verified video",
  channel: "Verified channel",
  url: "https://www.youtube.com/watch?v=abcdefghijk",
  video_id: "abcdefghijk",
  playlist_id: null,
  playback_state: "playing",
  position_seconds: 4,
  duration_seconds: 120,
  volume_percent: 60,
  muted: false,
  task_status: "playing",
  verified_fields: ["url", "video_id", "title", "playback_state"],
  result: "Verified YouTube playback",
};

test("YouTube actions and dedicated voice tools are exposed with isolated resources", () => {
  for (const name of ["youtube.play", "youtube.control", "youtube.state", "youtube.cancel"]) {
    assert.ok(ACTION_MAP.has(name), `${name} should be registered`);
  }
  assert.deepEqual(ACTION_MAP.get("youtube.play")!.resources({}), ["browser", "keyboard", "clipboard", "focus"]);
  assert.equal(ACTION_MAP.get("youtube.play")!.batchable, false);
  assert.equal(ACTION_MAP.get("youtube.control")!.capability, "CONTROL_INPUT");
  assert.ok(exposedGroups("Play the latest video from Example Channel on YouTube", {}).has("youtube"));
  for (const name of ["playYouTube", "controlYouTube", "getYouTubeState", "createContentTask"]) {
    assert.ok(LIVE_AGENT_TOOL_NAMES.has(name), `${name} voice declaration is missing`);
  }
});

test("voice handlers route playback, YouTube-only cancellation and artifact requests into the task engine", async () => {
  const direct: Array<{ goal: string; action: { tool: string; args: Record<string, unknown> } }> = [];
  const started: string[] = [];
  const runtime = {
    manager: {
      runDirect: (goal: string, action: { tool: string; args: Record<string, unknown> }) => {
        direct.push({ goal, action });
        return { id: `direct-${direct.length}` };
      },
      start: (goal: string) => {
        started.push(goal);
        return { id: `started-${started.length}` };
      },
    },
    tasks: { active: () => [], list: () => [] },
  } as never;
  await handleLiveAgentTool(runtime, "playYouTube", { query: "demo", channel: "Official", result_index: 2, latest: true });
  await handleLiveAgentTool(runtime, "controlYouTube", { action: "cancel" });
  await handleLiveAgentTool(runtime, "createContentTask", { request: "Create a verified DOCX in Documents" });
  assert.equal(direct[0].action.tool, "youtube.play");
  assert.deepEqual(direct[0].action.args, {
    query: "demo", channel: "Official", result_index: 2, latest: true,
    playlist: false, selection: "video", start_playback: true,
  });
  assert.equal(direct[1].action.tool, "youtube.cancel");
  assert.equal(started[0], "Create a verified DOCX in Documents");
});

test("executor maps youtube.play to the verified adapter and preserves synchronized state", async () => {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const executor = executorWith(async (tool, args) => {
    calls.push({ tool, args });
    if (tool === "youtubePlay") return { ok: true, result: youtubeState };
    return { ok: false, error: `unexpected ${tool}` };
  });
  const scope = rootScope.child("youtube-action");
  try {
    const result = await executor.execute({ tool: "youtube.play", args: { query: "Verified video", result_index: 1, selection: "video", start_playback: true } }, {
      taskId: "youtube-action", goal: "Play Verified video on YouTube", state: null, scope,
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.verification?.passed, true);
    assert.deepEqual(calls, [{ tool: "youtubePlay", args: { query: "Verified video", result_index: 1, selection: "video", start_playback: true } }]);
    assert.equal((result.data as Record<string, unknown>).video_id, "abcdefghijk");
    assert.equal((result.data as Record<string, unknown>).volume_percent, 60);
  } finally {
    scope.dispose();
  }
});

test("executor refuses an unverified YouTube success payload", async () => {
  const executor = executorWith(async () => ({ ok: true, result: { ...youtubeState, verified: false, error: "AUTOPLAY_BLOCKED" } }));
  const scope = rootScope.child("youtube-unverified");
  try {
    const result = await executor.execute({ tool: "youtube.control", args: { action: "play" } }, {
      taskId: "youtube-unverified", goal: "Resume YouTube", state: null, scope,
    });
    assert.equal(result.ok, false);
    assert.match(String(result.error), /AUTOPLAY_BLOCKED/);
  } finally {
    scope.dispose();
  }
});

test("artifact capability route reports real gateway and Office state, including image gap", async () => {
  const executor = executorWith(async (tool) => tool === "officeStatus"
    ? { ok: true, result: { windows: true, applications: { word: true, excel: false, powerpoint: true } } }
    : { ok: false, error: "unexpected" }, () => ({
    gateway: "existing provider-neutral ModelRouter",
    textAndCode: { configured: true, providers: [{ id: "gemini" }] },
    imageOutput: { configured: false, setupNeeded: "Configure an authorized image-output adapter." },
    codeTesting: { sandboxed: false, setupNeeded: "Configure an isolated disposable runner." },
  }));
  const scope = rootScope.child("artifact-capabilities");
  try {
    const result = await executor.execute({ tool: "artifact.capabilities", args: {} }, {
      taskId: "artifact-capabilities", goal: "Create an image and presentation", state: null, scope,
    });
    assert.equal(result.ok, true, result.error);
    const data = result.data as Record<string, any>;
    assert.equal(data.imageOutput.configured, false);
    assert.equal(data.codeTesting.sandboxed, false);
    assert.equal(data.office.applications.excel, false);
    assert.match(data.formats.docx, /report\.create_word/);
  } finally {
    scope.dispose();
  }
});

test("text primitive cannot fabricate image, PDF or Office artifacts", async () => {
  let called = false;
  const executor = executorWith(async () => { called = true; return { ok: true, result: {} }; });
  for (const extension of ["png", "pdf", "docx", "xlsx", "pptx"]) {
    const scope = rootScope.child(`fake-${extension}`);
    try {
      const result = await executor.execute({ tool: "fs.create_text", args: { path: `C:\\Users\\A\\Documents\\fake.${extension}`, content: "not a real binary" } }, {
        taskId: `fake-${extension}`, goal: `Create fake.${extension}`, state: null, scope,
      });
      assert.equal(result.ok, false);
      assert.match(String(result.error), /cannot create a real/);
    } finally {
      scope.dispose();
    }
  }
  assert.equal(called, false);
});

test("fs.open calls the OS open primitive, not File Explorer selection", async () => {
  const calls: string[] = [];
  const executor = executorWith(async (tool) => {
    calls.push(tool);
    if (tool === "statPath") return { ok: true, result: { exists: true, size: 100, kind: "document" } };
    if (tool === "openPath") return { ok: true, result: { path: "C:\\Users\\A\\Documents\\report.docx", kind: "document" } };
    return { ok: false, error: `unexpected ${tool}` };
  });
  const scope = rootScope.child("open-artifact");
  try {
    const result = await executor.execute({ tool: "fs.open", args: { path: "C:\\Users\\A\\Documents\\report.docx" } }, {
      taskId: "open-artifact", goal: "Open the generated report", state: null, scope,
    });
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(calls, ["statPath", "openPath"]);
  } finally {
    scope.dispose();
  }
});

test("workbook and presentation schemas admit only bounded structured creation fields", () => {
  const workbook = ACTION_MAP.get("office.create_workbook")!;
  assert.equal(validateJson({
    path: "C:\\Users\\A\\Documents\\sales.xlsx",
    rows: [["Month", "Sales"], ["Jan", 10]],
    formulas: [{ cell: "B3", formula: "=SUM(B2:B2)", number_format: "0.00" }],
    charts: [{ type: "column", source_range: "A1:B2", anchor_cell: "D2", title: "Sales" }],
  }, workbook.args).valid, true);
  assert.equal(validateJson({
    path: "C:\\Users\\A\\Documents\\sales.xlsx",
    rows: [],
    charts: [{ type: "3d-external", source_range: "A1:B2" }],
  }, workbook.args).valid, false);

  const presentation = ACTION_MAP.get("office.create_presentation")!;
  assert.equal(validateJson({
    path: "C:\\Users\\A\\Documents\\brief.pptx",
    slides: [{ title: "Summary", bullets: ["Editable"], image_path: "C:\\Users\\A\\Pictures\\chart.png" }],
  }, presentation.args).valid, true);
});
