/**
 * Capability registry tests.
 *
 * The registry's job is to stop the model from promising things the machine
 * cannot do, so every test is about honest reporting rather than happy paths.
 */
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import express from "express";

import {
  CapabilityRegistry,
  availableTools,
  buildCapabilities,
  capabilitySummary,
  type CapabilityInput,
} from "../capabilities/registry";
import { registerCapabilityRoutes } from "../capabilities/routes";
import { createDeviceGuard } from "../shared/deviceAuth";

const TOKEN = "capability-device-token-1234567890";

function input(overrides: Partial<CapabilityInput> = {}): CapabilityInput {
  return {
    desktop: { online: false, toolCount: null },
    devices: [],
    server: {
      hasGeminiKey: false,
      visionEnabled: false,
      callsEnabled: false,
      deviceTokenConfigured: false,
      messagingProviders: [{ id: "whatsapp", configured: false, detail: "not configured" }],
      memoryReady: true,
      voiceAvailable: false,
    },
    ...overrides,
  };
}

test("an unconfigured server offers almost nothing", () => {
  const catalogue = buildCapabilities(input());
  const available = catalogue.filter((capability) => capability.status === "AVAILABLE");
  assert.deepEqual(available.map((capability) => capability.id), ["core.memory"]);
  assert.deepEqual(availableTools(catalogue), ["memory"]);
});

test("desktop capabilities follow the live probe", () => {
  const offline = buildCapabilities(input());
  assert.ok(offline.every((capability) => capability.area !== "desktop" || capability.status === "UNAVAILABLE"));
  assert.match(offline.find((capability) => capability.id === "desktop.mouse_keyboard")!.detail, /not reachable/i);

  const online = buildCapabilities(input({ desktop: { online: true, toolCount: 42 } }));
  const desktop = online.filter((capability) => capability.area === "desktop");
  assert.ok(desktop.length > 0);
  assert.ok(desktop.every((capability) => capability.status === "AVAILABLE"));
  assert.match(desktop[0].detail, /42 desktop tools/);
  assert.ok(availableTools(online).includes("app.launch"));
});

test("a phone report is authoritative and replaces the previous one", () => {
  const registry = new CapabilityRegistry();
  registry.record({
    deviceId: "phone-1",
    platform: "android",
    reportedAt: "2026-10-23T10:00:00.000Z",
    capabilities: [
      { id: "phone.call.place", status: "AVAILABLE", permissions: ["CALL_PHONE"] },
      { id: "phone.camera.capture", status: "NEEDS_PERMISSION", permissions: ["CAMERA"] },
      { id: "phone.notifications.read", status: "NOT_SUPPORTED" },
    ],
  });

  const first = buildCapabilities(input({ devices: registry.list() }));
  assert.equal(first.find((capability) => capability.id === "phone.call.place")?.status, "AVAILABLE");
  assert.equal(first.find((capability) => capability.id === "phone.camera.capture")?.status, "NEEDS_PERMISSION");
  assert.equal(first.find((capability) => capability.id === "phone.notifications.read")?.status, "NOT_SUPPORTED");
  assert.equal(first.find((capability) => capability.id === "phone.call.place")?.risk, "high");

  registry.record({
    deviceId: "phone-1",
    platform: "android",
    reportedAt: "2026-10-23T10:05:00.000Z",
    capabilities: [{ id: "phone.call.place", status: "NEEDS_PERMISSION", permissions: ["READ_PHONE_STATE"] }],
  });
  const second = buildCapabilities(input({ devices: registry.list() }));
  assert.equal(second.find((capability) => capability.id === "phone.call.place")?.status, "NEEDS_PERMISSION");
  assert.equal(second.filter((capability) => capability.id === "phone.notifications.read").length, 0, "stale capabilities disappear");
});

test("the instruction summary never lists an unavailable capability as usable", () => {
  const summary = capabilitySummary(buildCapabilities(input({ desktop: { online: true, toolCount: 10 } })));
  assert.match(summary, /CAPABILITIES RIGHT NOW/);
  assert.match(summary, /Available:/);
  assert.match(summary, /Mouse & keyboard/);
  assert.match(summary, /not listed as available/i);

  const empty = capabilitySummary(buildCapabilities(input({ server: { ...input().server, memoryReady: false } })));
  assert.match(empty, /Available: none\./);
});

test("messaging providers appear only when configured", () => {
  const configured = buildCapabilities(input({
    server: { ...input().server, messagingProviders: [{ id: "whatsapp", configured: true, detail: "Cloud API ready" }] },
  }));
  assert.equal(configured.find((capability) => capability.id === "messaging.whatsapp")?.status, "AVAILABLE");
  assert.ok(availableTools(configured).includes("messaging.whatsapp.send"));
});

/* ------------------------------------------------------------------- routes */

let server: import("node:http").Server;
let baseUrl = "";
const registry = new CapabilityRegistry();

before(async () => {
  const app = express();
  app.use(express.json());
  registerCapabilityRoutes(app, {
    registry,
    device: createDeviceGuard(TOKEN),
    server: () => ({ desktop: input().desktop, server: input().server }),
  });
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => server.close());

test("GET /api/capabilities returns the catalogue", async () => {
  const body = (await (await fetch(`${baseUrl}/api/capabilities`)).json()) as { capabilities: unknown[]; available: string[]; devices: unknown[] };
  assert.ok(Array.isArray(body.capabilities) && body.capabilities.length > 0);
  assert.ok(Array.isArray(body.available));
  assert.ok(Array.isArray(body.devices));
});

test("POST /api/capabilities/report needs the device token", async () => {
  const denied = await fetch(`${baseUrl}/api/capabilities/report`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId: "phone-2", capabilities: [] }),
  });
  assert.equal(denied.status, 401);

  const accepted = await fetch(`${baseUrl}/api/capabilities/report`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-sara-device-token": TOKEN },
    body: JSON.stringify({ deviceId: "phone-2", platform: "android", capabilities: [{ id: "phone.youtube.play", status: "AVAILABLE" }] }),
  });
  assert.equal(accepted.status, 200);
  const after = (await (await fetch(`${baseUrl}/api/capabilities`)).json()) as { capabilities: Array<{ id: string; status: string }> };
  assert.equal(after.capabilities.find((capability) => capability.id === "phone.youtube.play")?.status, "AVAILABLE");
});

test("a malformed report is rejected instead of stored", async () => {
  const response = await fetch(`${baseUrl}/api/capabilities/report`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-sara-device-token": TOKEN },
    body: JSON.stringify({ capabilities: "nope" }),
  });
  assert.equal(response.status, 400);
});
