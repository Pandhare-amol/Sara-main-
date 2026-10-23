/**
 * HTTP tests for the communication routes.
 *
 * The device token is the security boundary between the phone and the server,
 * so its three states (not configured, wrong, correct) are each exercised, as
 * are the UI actions and the policy endpoint.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import express from "express";

import { CallManager } from "../communication/callManager";
import { registerCallRoutes } from "../communication/routes";
import { ContactBook } from "../memory/contacts";
import { normalizeSettings, patchSettings, type AppSettings } from "../settings/appSettings";

const TOKEN = "device-token-for-tests";
let dir = "";
let app: ReturnType<typeof express>;
let server: import("node:http").Server;
let baseUrl = "";
let settings: AppSettings = { ...normalizeSettings({}), calls: { ...normalizeSettings({}).calls, enabled: true, answerBusinessContacts: "ask" } };
let manager: CallManager;

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "sara-call-http-"));
  const contacts = new ContactBook(dir);
  await contacts.initialize();
  await contacts.upsert({ displayName: "Rahul", phones: ["9876543210"], relationship: "business", priority: "high" });

  manager = new CallManager({ dataDir: dir, contacts, settings: () => settings });

  app = express();
  app.use(express.json());
  registerCallRoutes(app, {
    calls: manager,
    settings: () => settings,
    updateCallsSettings: async (patch) => {
      settings = patchSettings(settings, { calls: patch });
      return settings;
    },
    deviceToken: TOKEN,
  });
  // The 503-without-token case is covered by a second app instance below.
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.close();
  await fs.rm(dir, { recursive: true, force: true });
});

const request = (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(`${baseUrl}${url}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

test("device events are refused without the token", async () => {
  const response = await request("POST", "/api/calls/events", { type: "ringing", callId: "x", deviceId: "d" });
  assert.equal(response.status, 401);
  assert.equal(((await response.json()) as { code: string }).code, "DEVICE_UNAUTHORIZED");
});

test("device events are refused with the wrong token", async () => {
  const response = await request("POST", "/api/calls/events", { type: "ringing", callId: "x", deviceId: "d" }, { "x-sara-device-token": "nope" });
  assert.equal(response.status, 401);
});

test("a valid device event is accepted and identified", async () => {
  const response = await request(
    "POST",
    "/api/calls/events",
    { type: "ringing", callId: "call-1", deviceId: "phone-1", number: "9876543210" },
    { "x-sara-device-token": TOKEN },
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as { call: { id: string; peer: { name: string }; state: string } };
  assert.equal(body.call.peer.name, "Rahul");
  assert.equal(body.call.state, "RINGING");
});

test("the UI sees the active call and its policy decision", async () => {
  const body = (await (await request("GET", "/api/calls")).json()) as { active: Array<{ peer: { name: string }; decision: { action: string } }> };
  assert.equal(body.active.length, 1);
  assert.equal(body.active[0].peer.name, "Rahul");
  assert.equal(body.active[0].decision.action, "ask_user");
});

test("the device can poll commands and acknowledge them", async () => {
  const denied = await request("GET", "/api/calls/devices/phone-1/commands");
  assert.equal(denied.status, 401);

  const polled = (await (await request("GET", "/api/calls/devices/phone-1/commands", undefined, { "x-sara-device-token": TOKEN })).json()) as {
    commands: Array<{ id: string; kind: string }>;
  };
  // The policy was "ask", so nothing has been queued yet.
  assert.equal(polled.commands.length, 0);

  const answered = await request("POST", "/api/calls/call-1/answer", {});
  assert.equal(answered.status, 200);

  const after = (await (await request("GET", "/api/calls/devices/phone-1/commands", undefined, { "x-sara-device-token": TOKEN })).json()) as {
    commands: Array<{ id: string; kind: string }>;
  };
  assert.equal(after.commands[0].kind, "answer_call");

  const ack = await request(
    "POST",
    `/api/calls/devices/phone-1/commands/${after.commands[0].id}/ack`,
    { result: "dialing" },
    { "x-sara-device-token": TOKEN },
  );
  assert.equal(ack.status, 200);
  assert.equal(((await ack.json()) as { command: { status: string } }).command.status, "acked");
});

test("an outgoing call needs a confirmed target and refuses unknown numbers", async () => {
  const preview = await request("POST", "/api/calls/outgoing", { query: "Rahul" });
  assert.equal(preview.status, 200);
  assert.equal(((await preview.json()) as { status: string }).status, "needs_confirmation");

  const unknown = await request("POST", "/api/calls/outgoing", { query: "Nobody", confirmed: true });
  assert.equal(unknown.status, 409);
  assert.equal(((await unknown.json()) as { status: string }).status, "unknown_contact");
});

test("policy can be read and updated, and rejects impossible values", async () => {
  const before = (await (await request("GET", "/api/calls/policy")).json()) as { calls: { answerFamily: string }; deviceTokenConfigured: boolean };
  assert.equal(before.deviceTokenConfigured, true);

  await request("POST", "/api/calls/policy", { answerFamily: "auto", answerUnknownCall: true, maxCallMinutes: 5000 });
  const after = (await (await request("GET", "/api/calls/policy")).json()) as { calls: { answerFamily: string; answerUnknownCall: boolean; maxCallMinutes: number } };
  assert.equal(after.calls.answerFamily, "auto");
  assert.equal(after.calls.answerUnknownCall, true);
  assert.equal(after.calls.maxCallMinutes, 120, "clamped by normalizeSettings");

  await request("POST", "/api/calls/policy", { answerFamily: "sometimes" });
  const clamped = (await (await request("GET", "/api/calls/policy")).json()) as { calls: { answerFamily: string } };
  assert.equal(clamped.calls.answerFamily, "auto", "an invalid value keeps the previous valid one");
});

test("a call detail includes summary and messages", async () => {
  await request("POST", "/api/calls/call-1/message", { text: "Call back after 6." });
  const detail = (await (await request("GET", "/api/calls/call-1")).json()) as {
    call: { id: string };
    summary: { messages: string[]; notes: string[] };
    messages: Array<{ text: string }>;
  };
  assert.equal(detail.messages[0].text, "Call back after 6.");
  assert.deepEqual(detail.summary.messages, ["Call back after 6."]);
  assert.ok(detail.summary.notes.length > 0);

  const missing = await request("GET", "/api/calls/does-not-exist");
  assert.equal(missing.status, 404);
});

test("without a configured device token the server refuses to accept events", async () => {
  const app2 = express();
  app2.use(express.json());
  registerCallRoutes(app2, {
    calls: manager,
    settings: () => settings,
    updateCallsSettings: async () => settings,
    deviceToken: null,
  });
  const server2 = app2.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server2.once("listening", () => resolve()));
  const port = (server2.address() as AddressInfo).port;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/calls/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-sara-device-token": TOKEN },
      body: JSON.stringify({ type: "ringing", callId: "y", deviceId: "d" }),
    });
    assert.equal(response.status, 503);
    assert.equal(((await response.json()) as { code: string }).code, "DEVICE_TOKEN_NOT_CONFIGURED");
  } finally {
    server2.close();
  }
});
