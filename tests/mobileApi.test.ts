/**
 * HTTP-level tests for /api/mobile/*.
 *
 * They run a real express app on an ephemeral port and assert the wire
 * behaviour the phone depends on: honest 409s instead of guessed answers, a
 * vision rate limit, a stop that also kills pending approvals, and the
 * per-device PC-control decision.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import express from "express";

import { registerMobileRoutes, type MobileApiContext } from "../server_mobileApi";
import { normalizeSettings, type AppSettings } from "../settings/appSettings";

let baseUrl = "";
let server: import("node:http").Server;
let stopped = 0;
let denied = 0;
let visionCalls = 0;
let settings: AppSettings = normalizeSettings({});

const ctx: MobileApiContext = {
  version: "1.5.2",
  remoteAccess: true,
  allowDesktopTools: (isRemote) => !isRemote,
  tasks: () => [
    { id: "t1", goal: "Rename invoices", state: "running" },
    { id: "t2", goal: "Old job", state: "completed", updatedAt: new Date().toISOString() },
  ],
  confirmations: () => [
    { id: "c1", title: "Send email", description: "to Aman", capability: "messaging", createdAt: new Date().toISOString() },
  ],
  utilities: () => [
    { id: "u1", kind: "reminder", label: "Call the bank", dueAt: Date.now() + 3_600_000, repeat: "none", status: "scheduled" },
  ],
  goals: () => [{ id: "g1", title: "Ship v2", status: "active", progress: 40 }],
  skills: () => [{ name: "Rename files" }],
  audit: async () => [{ at: new Date().toISOString(), taskId: "t1", kind: "tool", summary: "Opened Notepad" }],
  agentHealth: async () => ({ online: true, tool_count: 42 }),
  hasApiKey: () => true,
  models: () => ({ selection: { brain: "gemini-2.5-flash" }, models: [{ id: "gemini-2.5-flash", availability: "available" }] }),
  memoryCount: async () => 3,
  settings: () => settings,
  generate: async ({ text }) => {
    visionCalls += 1;
    return { text: `You asked: ${text}`, modelId: "test-model", latencyMs: 5 };
  },
  emergencyStop: () => {
    stopped += 1;
    return 2;
  },
  denyAllConfirmations: () => {
    denied += 1;
    return 1;
  },
};

before(async () => {
  const app = express();
  app.use(express.json({ limit: "8mb" }));
  // Pretend the caller is remote for the PC-control test.
  app.use((req, res, next) => {
    res.locals.saraRemote = req.headers["x-sara-remote"] === "1";
    next();
  });
  registerMobileRoutes(app, ctx);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
});

const get = (path: string, headers: Record<string, string> = {}) => fetch(`${baseUrl}${path}`, { headers });
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${baseUrl}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

test("GET /api/mobile/briefing returns composed state", async () => {
  const response = await get("/api/mobile/briefing");
  assert.equal(response.status, 200);
  const body = (await response.json()) as Record<string, any>;
  assert.equal(body.counts.activeTasks, 1);
  assert.equal(body.counts.needsYou, 1, "one confirmation, no waiting question");
  assert.equal(body.confirmations[0].title, "Send email");
  assert.equal(body.pc.availableFromThisDevice, true, "a local window may drive the PC");
});

test("remote callers get PC control closed when the server says so", async () => {
  const local = (await (await get("/api/mobile/briefing")).json()) as Record<string, any>;
  assert.equal(local.pc.availableFromThisDevice, true);

  const remote = (await (await get("/api/mobile/briefing", { "x-sara-remote": "1" })).json()) as Record<string, any>;
  assert.equal(remote.pc.remoteControlAllowed, false);
  assert.equal(remote.pc.availableFromThisDevice, false);
  assert.ok(remote.notes.some((note: string) => /PC|desktop/i.test(note)));
});

test("GET /api/mobile/diagnostics reports the live wiring", async () => {
  const body = (await (await get("/api/mobile/diagnostics")).json()) as Record<string, any>;
  assert.equal(body.overall, "ok");
  assert.equal(body.items.find((i: any) => i.id === "gemini").state, "ok");
});

test("GET /api/mobile/automations exposes schedules and admits the gaps", async () => {
  const body = (await (await get("/api/mobile/automations")).json()) as Record<string, any>;
  assert.equal(body.scheduled.length, 1);
  assert.equal(body.activity[0].summary, "Opened Notepad");
  assert.ok(body.notes.some((note: string) => /not implemented/i.test(note)));
});

test("POST /api/mobile/vision rejects bad bodies before spending a model call", async () => {
  const before = visionCalls;
  const response = await post("/api/mobile/vision", { mimeType: "image/gif", image: "A".repeat(200) });
  assert.equal(response.status, 415);
  assert.equal(visionCalls, before);
});

test("POST /api/mobile/vision answers with the question echoed", async () => {
  const response = await post("/api/mobile/vision", { image: "A".repeat(200), mimeType: "image/jpeg", question: "What is this?" });
  assert.equal(response.status, 200);
  const body = (await response.json()) as Record<string, any>;
  assert.equal(body.answer, "You asked: What is this?");
  assert.equal(body.realityMode, "standard");
});

test("vision refuses (409) rather than guessing when there is no key", async () => {
  const original = ctx.hasApiKey;
  ctx.hasApiKey = () => false;
  try {
    const response = await post("/api/mobile/vision", { image: "A".repeat(200), mimeType: "image/jpeg" });
    assert.equal(response.status, 409);
    assert.match(((await response.json()) as { error: string }).error, /no Gemini key/i);
  } finally {
    ctx.hasApiKey = original;
  }
});

test("vision is rate limited per minute", async () => {
  const responses: number[] = [];
  for (let i = 0; i < 14; i += 1) {
    responses.push((await post("/api/mobile/vision", { image: "A".repeat(200), mimeType: "image/jpeg" })).status);
  }
  assert.ok(responses.includes(429), `expected a 429 in ${responses.join(",")}`);
});

test("POST /api/mobile/stop stops tasks and denies pending approvals", async () => {
  const before = { stopped, denied };
  const response = await post("/api/mobile/stop", { reason: "phone_stop_button" });
  assert.equal(response.status, 200);
  const body = (await response.json()) as Record<string, any>;
  assert.equal(body.ok, true);
  assert.equal(body.stoppedTasks, 2);
  assert.equal(body.deniedConfirmations, 1);
  assert.equal(stopped, before.stopped + 1);
  assert.equal(denied, before.denied + 1, "a stop must not leave an approval alive");
});

test("briefing follows the persona/reality settings", async () => {
  settings = normalizeSettings({ persona: { profile: "executive", context: "professional" }, reality: { mode: "strict" } });
  const body = (await (await get("/api/mobile/briefing")).json()) as Record<string, any>;
  assert.equal(body.mode.persona, "executive");
  assert.equal(body.mode.context, "professional");
  assert.equal(body.mode.reality, "strict");
});
