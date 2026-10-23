/**
 * Messaging tests.
 *
 * The WhatsApp provider is exercised against a local HTTP stub that behaves
 * like the Graph API — success with a message id, a rejected send, and a 2xx
 * with no id (which must come back UNCERTAIN, never SENT).
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import express from "express";
import { createHmac } from "node:crypto";

import { MessagingHub, classify } from "../communication/messaging/hub";
import { registerMessagingRoutes } from "../communication/messaging/routes";
import { WhatsAppCloudProvider, readWhatsAppConfig, type WhatsAppConfig } from "../communication/messaging/whatsappCloud";
import type { MessagingProvider } from "../communication/messaging/types";

/* ------------------------------------------------- Graph API stub */

let api: import("node:http").Server;
let apiBase = "";
let mode: "ok" | "no-id" | "error" | "slow" = "ok";
const received: Array<Record<string, unknown>> = [];

before(async () => {
  const app = express();
  app.use(express.json());
  app.post("/v21.0/12345/messages", async (req, res) => {
    received.push(req.body as Record<string, unknown>);
    if (mode === "error") {
      res.status(400).json({ error: { message: "Recipient phone number not verified", code: 131030 } });
      return;
    }
    if (mode === "no-id") {
      res.status(200).json({ messages: [] });
      return;
    }
    if (mode === "slow") {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    res.status(200).json({ messaging_product: "whatsapp", messages: [{ id: "wamid.TEST123" }] });
  });
  api = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => api.once("listening", () => resolve()));
  apiBase = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});

after(() => api.close());

beforeEach(() => {
  mode = "ok";
  received.length = 0;
});

const config = (): WhatsAppConfig => ({ token: "secret-token", phoneNumberId: "12345", verifyToken: "verify", apiBase });

/* ------------------------------------------------- provider behaviour */

test("an unconfigured WhatsApp provider says so instead of failing later", async () => {
  const provider = new WhatsAppCloudProvider(null);
  assert.equal(provider.status().ok, false);
  const outcome = await provider.send({ provider: "whatsapp", to: "9876543210", text: "hi" });
  assert.equal(outcome.status, "NOT_SUPPORTED");
  assert.equal(outcome.verified, false);
});

test("a successful send is verified by the message id", async () => {
  const provider = new WhatsAppCloudProvider(config());
  const outcome = await provider.send({ provider: "whatsapp", to: "+91 98765 43210", text: "I'll reach in 20 minutes." });
  assert.equal(outcome.status, "SENT");
  assert.equal(outcome.verified, true);
  assert.equal(outcome.providerMessageId, "wamid.TEST123");
  assert.equal(received[0].to, "+919876543210", "the number is normalised before sending");
  assert.deepEqual(received[0].text, { preview_url: false, body: "I'll reach in 20 minutes." });
});

test("a 2xx without an id is UNCERTAIN, not SENT", async () => {
  mode = "no-id";
  const outcome = await new WhatsAppCloudProvider(config()).send({ provider: "whatsapp", to: "9876543210", text: "hello" });
  assert.equal(outcome.status, "UNCERTAIN");
  assert.equal(outcome.verified, false);
  assert.match(outcome.detail, /unconfirmed/i);
});

test("provider errors are mapped with a retryability verdict", async () => {
  mode = "error";
  const outcome = await new WhatsAppCloudProvider(config()).send({ provider: "whatsapp", to: "9876543210", text: "hello" });
  assert.equal(outcome.status, "FAILED");
  assert.equal(outcome.error?.code, "WHATSAPP_131030");
  assert.equal(outcome.error?.retryable, false);
  assert.match(outcome.detail, /not verified/);
});

test("an unusable recipient is refused before any request", async () => {
  const outcome = await new WhatsAppCloudProvider(config()).send({ provider: "whatsapp", to: "12", text: "hello" });
  assert.equal(outcome.status, "FAILED");
  assert.equal(received.length, 0);
});

test("credentials are read from the environment only when complete", () => {
  assert.equal(readWhatsAppConfig({} as NodeJS.ProcessEnv), null);
  assert.equal(readWhatsAppConfig({ WHATSAPP_TOKEN: "x" } as NodeJS.ProcessEnv), null);
  const full = readWhatsAppConfig({ WHATSAPP_TOKEN: "x", WHATSAPP_PHONE_NUMBER_ID: "1" } as NodeJS.ProcessEnv);
  assert.equal(full?.phoneNumberId, "1");
  assert.equal(full?.apiBase, "https://graph.facebook.com");
});

/* ------------------------------------------------------------- hub */

let dir = "";
let hub: MessagingHub;
const requests: Array<{ id: string }> = [];

function makeHub(overrides: { providers?: MessagingProvider[]; now?: () => number } = {}) {
  return new MessagingHub({
    dataDir: dir,
    providers: overrides.providers ?? [new WhatsAppCloudProvider(config())],
    now: overrides.now,
    confirmations: {
      request: (input: any) => {
        const id = `req-${requests.length + 1}`;
        requests.push({ id });
        return { request: { ...input, id, createdAt: "", expiresAt: "" }, answer: new Promise(() => {}) };
      },
      resolve: () => true,
    } as never,
    audit: { record: () => {} } as never,
  });
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "sara-msg-"));
  requests.length = 0;
  hub = makeHub();
  await hub.initialize();
});

test("sending without approval returns REQUIRES_APPROVAL and sends nothing", async () => {
  const outcome = await hub.send({ provider: "whatsapp", to: "9876543210", text: "Hi Rahul" });
  assert.equal(outcome.status, "REQUIRES_APPROVAL");
  assert.equal(outcome.verified, false);
  assert.ok(outcome.approvalId);
  assert.match(outcome.preview || "", /Hi Rahul/);
  assert.equal(received.length, 0);
  assert.equal(hub.outboxLog().length, 0);
});

test("a confirmed send is verified and recorded", async () => {
  const outcome = await hub.send({ provider: "whatsapp", to: "9876543210", text: "Hi Rahul", confirmed: true });
  assert.equal(outcome.status, "SENT");
  assert.equal(hub.outboxLog()[0].verified, true);
  assert.equal(hub.outboxLog()[0].providerMessageId, "wamid.TEST123");
});

test("the same draft is not sent twice in a row", async () => {
  const first = await hub.send({ provider: "whatsapp", to: "9876543210", text: "same", confirmed: true });
  assert.equal(first.status, "SENT");
  const second = await hub.send({ provider: "whatsapp", to: "9876543210", text: "same", confirmed: true });
  assert.equal(second.status, "FAILED");
  assert.equal(second.error?.code, "DUPLICATE");
  assert.equal(received.length, 1);
});

test("an unknown provider is refused, not silently routed elsewhere", async () => {
  const outcome = await hub.send({ provider: "telegram", to: "x", text: "hi", confirmed: true });
  assert.equal(outcome.status, "NOT_SUPPORTED");
});

test("inbound messages are classified deterministically", async () => {
  assert.equal(classify("Can you send the report by Friday?", null).importance, "high");
  assert.equal(classify("Your OTP is 1234", null).importance, "high");
  assert.equal(classify("Sale ends tonight", "no-reply@shop.com").importance, "low");
  assert.equal(classify("ok", null).importance, "normal");

  await hub.recordInbound({ id: "w1", provider: "whatsapp", conversationId: "1", fromId: "1", fromName: "Rahul", text: "Please send the proposal by Friday" });
  const summary = hub.summary();
  assert.equal(summary.unread, 1);
  assert.equal(summary.important, 1);
  assert.equal(summary.highlights[0].fromName, "Rahul");
  assert.match(summary.highlights[0].reason, /deadline|asks/i);

  await hub.recordInbound({ id: "w1", provider: "whatsapp", conversationId: "1", fromId: "1", fromName: "Rahul", text: "duplicate webhook" });
  assert.equal(hub.list().length, 1, "a redelivered webhook does not duplicate");
});

test("search and provider filters read the stored inbox only", async () => {
  await hub.recordInbound({ id: "a", provider: "whatsapp", conversationId: "1", fromId: "1", fromName: "Meera", text: "Invoice attached" });
  await hub.recordInbound({ id: "b", provider: "whatsapp", conversationId: "2", fromId: "2", fromName: "Aman", text: "Lunch?" });
  assert.equal(hub.list({ query: "invoice" }).length, 1);
  assert.equal(hub.list({ query: "Aman" }).length, 1);
  assert.equal(hub.list({ provider: "telegram" }).length, 0);
});

/* ------------------------------------------------------------ webhook */

test("the WhatsApp webhook verifies the token and the signature", async () => {
  const app = express();
  app.use(express.json());
  registerMessagingRoutes(app, {
    hub,
    whatsapp: { ...config(), verifyToken: "verify-me" },
    appSecret: "app-secret",
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const good = await fetch(`${base}/api/messaging/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=abc`);
    assert.equal(good.status, 200);
    assert.equal(await good.text(), "abc");

    const bad = await fetch(`${base}/api/messaging/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=abc`);
    assert.equal(bad.status, 403);

    const payload = {
      entry: [{ changes: [{ value: { contacts: [{ wa_id: "9198", profile: { name: "Rahul" } }], messages: [{ id: "wamid.1", from: "9198", timestamp: "1761000000", type: "text", text: { body: "Is the boss available?" } }] } }] }],
    };
    const raw = JSON.stringify(payload);
    const signature = `sha256=${createHmac("sha256", "app-secret").update(raw).digest("hex")}`;

    const unsigned = await fetch(`${base}/api/messaging/whatsapp/webhook`, { method: "POST", headers: { "Content-Type": "application/json" }, body: raw });
    assert.equal(unsigned.status, 401);

    const signed = await fetch(`${base}/api/messaging/whatsapp/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-hub-signature-256": signature },
      body: raw,
    });
    assert.equal(signed.status, 200);
    assert.equal(((await signed.json()) as { accepted: number }).accepted, 1);
    const stored = hub.list();
    assert.equal(stored[0].text, "Is the boss available?");
    assert.equal(stored[0].fromName, "Rahul");
  } finally {
    server.close();
  }
});

test("without an app secret the webhook refuses payloads", async () => {
  const app = express();
  app.use(express.json());
  registerMessagingRoutes(app, { hub, whatsapp: config(), appSecret: null });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const response = await fetch(`${base}/api/messaging/whatsapp/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entry: [] }),
    });
    assert.equal(response.status, 503);
  } finally {
    server.close();
  }
});

test("the send endpoint maps approval to 202 and success to 200", async () => {
  const app = express();
  app.use(express.json());
  registerMessagingRoutes(app, { hub, whatsapp: config(), appSecret: "app-secret" });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const draft = await fetch(`${base}/api/messaging/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "whatsapp", to: "9876543210", text: "hello" }),
    });
    assert.equal(draft.status, 202);
    assert.equal(((await draft.json()) as { status: string }).status, "REQUIRES_APPROVAL");

    const sent = await fetch(`${base}/api/messaging/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "whatsapp", to: "9876543210", text: "hello", confirmed: true }),
    });
    assert.equal(sent.status, 200);
    assert.equal(((await sent.json()) as { verified: boolean }).verified, true);
  } finally {
    server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
