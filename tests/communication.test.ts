/**
 * Communication subsystem tests.
 *
 * These cover the parts that must be provably correct without a phone:
 * the answering policy, caller identification, the call state machine,
 * message taking, summarising, outgoing confirmation, the device command
 * queue, and emergency stop.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

import { CallManager } from "../communication/callManager";
import { decideIncomingCall } from "../communication/callPolicy";
import { buildPeer, formatPhone, nameMatchesContact, normalizePhone } from "../communication/identity";
import { ContactBook } from "../memory/contacts";
import { normalizeSettings, type AppSettings } from "../settings/appSettings";
import type { CallPresence, CallPolicyContext } from "../communication/types";

let root = "";
let dir = "";
let caseId = 0;
let contacts: ContactBook;
let settings: AppSettings;
let presence: CallPresence = { inMeeting: false, focusMode: false };

/**
 * Each test gets its own data directory: CallManager persists call history, so
 * sharing one directory would let one test's calls leak into the next.
 */
async function freshCase(): Promise<void> {
  caseId += 1;
  dir = path.join(root, `case-${caseId}`);
  contacts = new ContactBook(dir);
  await contacts.initialize();
}

const settingsFor = (calls: Partial<AppSettings["calls"]> = {}): AppSettings => {
  const base = normalizeSettings({});
  return { ...base, calls: { ...base.calls, enabled: true, ...calls } };
};

function ctx(overrides: Partial<CallPolicyContext> = {}): CallPolicyContext {
  return {
    settings: settingsFor(),
    peer: {
      number: "9876543210",
      name: "Rahul",
      contactId: "c1",
      relationship: "business",
      organization: "Acme",
      priority: "normal",
      unknown: false,
    },
    presence: { inMeeting: false, focusMode: false },
    ...overrides,
  };
}

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "sara-calls-"));
});

after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  await freshCase();
  settings = settingsFor();
  presence = { inMeeting: false, focusMode: false };
});

/* ------------------------------------------------------------------- policy */

test("an unknown number is never auto-answered", () => {
  const unknownPeer = { ...ctx().peer, name: null, contactId: null, relationship: "unknown" as const, unknown: true };
  const off = decideIncomingCall(ctx({ peer: unknownPeer, settings: settingsFor({ answerUnknownCall: false }) }));
  assert.equal(off.action, "notify");
  assert.equal(off.command, "none");

  const on = decideIncomingCall(ctx({ peer: unknownPeer, settings: settingsFor({ answerUnknownCall: true }) }));
  assert.equal(on.action, "ask_user", "allowing unknown callers only means asking");
  assert.equal(on.requiresUser, true);
});

test("the policy follows the configured per-group mode", () => {
  const business = ctx();
  assert.equal(decideIncomingCall({ ...business, settings: settingsFor({ answerBusinessContacts: "auto", screenCalls: false }) }).action, "answer_auto");
  assert.equal(decideIncomingCall({ ...business, settings: settingsFor({ answerBusinessContacts: "ask" }) }).action, "ask_user");
  assert.equal(decideIncomingCall({ ...business, settings: settingsFor({ answerBusinessContacts: "never" }) }).action, "reject");

  const family = ctx({ peer: { ...ctx().peer, relationship: "family" } });
  assert.equal(decideIncomingCall({ ...family, settings: settingsFor({ answerFamily: "never", answerKnownContacts: "auto" }) }).action, "reject", "family rules win over the generic rule");
});

test("screening replaces a full auto-answer when enabled", () => {
  const decision = decideIncomingCall(ctx({ settings: settingsFor({ answerBusinessContacts: "auto", screenCalls: true }) }));
  assert.equal(decision.action, "screen");
  assert.equal(decision.command, "answer_call");
});

test("meetings and focus mode suppress answering unless allowed", () => {
  const base = settingsFor({ answerBusinessContacts: "auto", screenCalls: false });
  const meeting = decideIncomingCall(ctx({ settings: base, presence: { inMeeting: true, focusMode: false } }));
  assert.equal(meeting.action, "notify");
  assert.match(meeting.reason, /meeting/i);

  const allowed = decideIncomingCall(ctx({ settings: { ...base, calls: { ...base.calls, answerDuringMeetings: true } }, presence: { inMeeting: true, focusMode: false } }));
  assert.equal(allowed.action, "answer_auto");

  const focus = decideIncomingCall(ctx({ settings: base, presence: { inMeeting: false, focusMode: true } }));
  assert.equal(focus.action, "notify");
  assert.match(focus.reason, /focus/i);
});

test("disabled integration reports the call and never answers", () => {
  const decision = decideIncomingCall(ctx({ settings: settingsFor({ enabled: false }) }));
  assert.equal(decision.command, "none");
  assert.equal(decision.requiresUser, true);
});

test("low-priority contacts are not answered automatically", () => {
  const decision = decideIncomingCall(ctx({
    peer: { ...ctx().peer, priority: "low" },
    settings: settingsFor({ answerBusinessContacts: "auto" }),
  }));
  assert.equal(decision.action, "notify");
});

/* ----------------------------------------------------------------- identity */

test("phone numbers are compared by their trailing digits", async () => {
  await contacts.upsert({ displayName: "Aman Verma", phones: ["+91 90000 11111"], relationship: "friend" });
  assert.ok(contacts.findByPhone("09000011111"));
  assert.ok(contacts.findByPhone("9000011111"));
  assert.equal(contacts.findByPhone("12345"), undefined, "too short to match");
});

test("a tie between contacts resolves to nobody instead of guessing", async () => {
  await contacts.upsert({ displayName: "Tie One", phones: ["+44 7700 900123"] });
  await contacts.upsert({ displayName: "Tie Two", phones: ["7700900123"] });
  assert.equal(contacts.findByPhone("7700900123"), undefined);
});

test("normalizePhone and formatPhone keep only usable digits", () => {
  assert.equal(normalizePhone("+91 (98765) 43210"), "919876543210");
  assert.equal(normalizePhone("123"), null);
  assert.equal(formatPhone("9876543210"), "98765 43210");
});

test("peer records never invent an identity", () => {
  const unknown = buildPeer({ number: "+91 80000 00000", reportedName: "Bank" });
  assert.equal(unknown.unknown, true);
  assert.equal(unknown.contactId, null);

  const known = buildPeer({
    number: "9876543210",
    contact: { id: "c1", displayName: "Rahul", aliases: [], appNames: {}, relationship: "business", organization: "Acme", priority: "high", createdAt: "", updatedAt: "" },
  });
  assert.equal(known.name, "Rahul");
  assert.equal(known.relationship, "business");
  assert.equal(known.priority, "high");
  assert.equal(known.unknown, false);
});

test("a spoken name is matched against the stored contact", () => {
  const contact = { id: "c1", displayName: "Rahul Sharma", aliases: ["rahul"], appNames: {}, createdAt: "", updatedAt: "" };
  assert.equal(nameMatchesContact("Rahul", contact), true);
  assert.equal(nameMatchesContact("Rahul Sharma", contact), true);
  assert.equal(nameMatchesContact("Vikram", contact), false);
});

/* ------------------------------------------------------------------ manager */

function makeManager(overrides: { settings?: () => AppSettings; notify?: (p: any) => void } = {}) {
  return new CallManager({
    dataDir: dir,
    contacts,
    settings: overrides.settings ?? (() => settings),
    presence: () => presence,
    notify: overrides.notify,
  });
}

test("a ringing call is identified, decided and audited", async () => {
  settings = settingsFor({ answerBusinessContacts: "ask" });
  await contacts.upsert({ displayName: "Rahul", phones: ["9876543210"], relationship: "business", priority: "high" });
  const manager = makeManager();
  const record = await manager.handleEvent({ type: "ringing", callId: "dev-1", deviceId: "phone-a", number: "9876543210" });
  assert.ok(record);
  assert.equal(record!.state, "RINGING");
  assert.equal(record!.peer.name, "Rahul");
  assert.equal(record!.decision?.action, "ask_user");
  assert.equal(manager.active().length, 1);
});

test("state transitions follow the device and never skip to connected", async () => {
  settings = settingsFor({ answerBusinessContacts: "auto", screenCalls: false });
  const manager = makeManager();
  const ringing = await manager.handleEvent({ type: "ringing", callId: "dev-2", deviceId: "phone-a", number: "9876543210" });
  assert.equal(ringing!.state, "RINGING");

  const duplicate = await manager.handleEvent({ type: "ringing", callId: "dev-2", deviceId: "phone-a", number: "9876543210" });
  assert.equal(duplicate, null, "a duplicate event changes nothing");

  const connected = await manager.handleEvent({ type: "connected", callId: "dev-2", deviceId: "phone-a" });
  assert.equal(connected!.state, "CONNECTED");
  assert.ok(connected!.answeredAt);

  const ended = await manager.handleEvent({ type: "ended", callId: "dev-2", deviceId: "phone-a" });
  assert.equal(ended!.state, "ENDED");
  assert.ok(ended!.endedAt);
  assert.equal(manager.active().length, 0);

  const late = await manager.handleEvent({ type: "connected", callId: "dev-2", deviceId: "phone-a" });
  assert.equal(late, null, "a terminal call cannot be revived by a late event");
});

test("the device is told to answer or reject; the UI can override", async () => {
  settings = settingsFor({ answerBusinessContacts: "auto", screenCalls: false });
  const manager = makeManager();
  await contacts.upsert({ displayName: "Nisha", phones: ["9000012345"], relationship: "business" });
  const call = await manager.handleEvent({ type: "ringing", callId: "dev-3", deviceId: "phone-b", number: "9000012345" });
  const commands = await manager.pendingCommands("phone-b");
  assert.equal(commands.length, 1);
  assert.equal(commands[0].kind, "answer_call");

  await manager.reject(call!.id, "ui");
  const after = await manager.pendingCommands("phone-b");
  assert.ok(after.some((command) => command.kind === "reject_call"));
  assert.equal(manager.get(call!.id)!.state, "REJECTED");
});

test("taking a message stores it and notifies without fabricating a summary", async () => {
  const notifications: Array<{ title: string; body: string }> = [];
  const manager = makeManager({ notify: (payload) => notifications.push(payload) });
  const call = await manager.handleEvent({ type: "ringing", callId: "dev-4", deviceId: "phone-c", number: "9000099999" });
  const message = await manager.takeMessage(call!.id, "He will call back after 6.", "call");
  assert.equal(message.text, "He will call back after 6.");
  assert.ok(notifications.some((item) => item.body.includes("call back")));
  await assert.rejects(() => manager.takeMessage(call!.id, "   "), /cannot be empty/);

  const summary = manager.summary(call!.id);
  assert.deepEqual(summary.messages, ["He will call back after 6."]);
  assert.equal(summary.purpose, null);
  assert.ok(summary.notes.some((note) => /no transcript/i.test(note)), "must admit the gap");
});

test("summary uses only what the device reported", async () => {
  const manager = makeManager();
  const call = await manager.handleEvent({
    type: "ringing",
    callId: "dev-5",
    deviceId: "phone-d",
    number: "9000011111",
    name: "Courier",
    transcript: [
      { role: "caller", text: "Can you please send the revised proposal by Friday?" },
      { role: "sara", text: "I will tell him you called." },
    ],
  });
  const summary = manager.summary(call!.id);
  assert.equal(summary.requests.length, 1);
  assert.equal(summary.promises.length, 1);
  assert.ok(summary.deadlines.some((deadline) => /friday/i.test(deadline)));
  assert.ok(summary.basis.some((basis) => /transcript/i.test(basis)));
  assert.equal(summary.sentiment, "unknown", "sentiment is not inferred from nothing");
});

test("outgoing calls always need a confirmed target", async () => {
  await contacts.upsert({ displayName: "Meera", phones: ["9812345678"], relationship: "friend" });
  const manager = makeManager();

  const preview = await manager.requestOutgoing({ query: "Meera" });
  assert.equal(preview.status, "needs_confirmation");
  assert.match(preview.message, /Meera/);
  assert.equal((await manager.pendingCommands("phone-e")).length, 0, "nothing was dialled");

  const unknown = await manager.requestOutgoing({ query: "Nobody At All", confirmed: true });
  assert.equal(unknown.status, "unknown_contact");

  const noNumber = await manager.requestOutgoing({ confirmed: true });
  assert.equal(noNumber.status, "refused");
});

test("an ambiguous contact is refused with candidates, not guessed", async () => {
  await contacts.upsert({ displayName: "Karan Mehta", aliases: ["karan"], phones: ["9700000001"] });
  await contacts.upsert({ displayName: "Karan Rao", aliases: ["karan"], phones: ["9700000002"] });
  const manager = makeManager();
  const plan = await manager.requestOutgoing({ query: "Karan" });
  assert.equal(plan.status, "ambiguous");
  assert.equal((plan.candidates || []).length, 2);
});

test("emergency stop ends live calls and drops queued phone commands", async () => {
  settings = settingsFor({ answerBusinessContacts: "auto", screenCalls: false });
  await contacts.upsert({ displayName: "Nisha", phones: ["9000012345"], relationship: "business" });
  const manager = makeManager();
  await manager.handleEvent({ type: "ringing", callId: "dev-6", deviceId: "phone-f", number: "9000012345" });
  assert.ok((await manager.pendingCommands("phone-f")).length > 0);

  const result = await manager.stop("phone_stop_button");
  assert.equal(result.endedCalls, 1);
  assert.equal(result.clearedCommands, 1);
  const remaining = await manager.pendingCommands("phone-f");
  assert.ok(remaining.every((command) => command.kind === "end_call"), "only the hang-up survives a stop");
  assert.equal(manager.active().length, 0);
});

test("commands expire instead of dialling later", async () => {
  await contacts.upsert({ displayName: "Nisha", phones: ["9000012345"], relationship: "business" });
  settings = settingsFor({ answerBusinessContacts: "auto", screenCalls: false });
  let now = Date.parse("2026-10-23T10:00:00.000Z");
  const manager = new CallManager({
    dataDir: dir,
    contacts,
    settings: () => settings,
    now: () => now,
    commandTtlMs: 5_000,
  });
  await manager.handleEvent({ type: "ringing", callId: "dev-7", deviceId: "phone-g", number: "9000012345" });
  assert.equal((await manager.pendingCommands("phone-g")).length, 1);
  now += 6_000;
  assert.equal((await manager.pendingCommands("phone-g")).length, 0);
});

test("call history survives a restart", async () => {
  settings = settingsFor({ answerBusinessContacts: "ask" });
  const manager = makeManager();
  const call = await manager.handleEvent({ type: "ringing", callId: "dev-8", deviceId: "phone-h", number: "9000012345" });
  assert.ok(call);

  const reopened = makeManager();
  await reopened.initialize();
  const history = reopened.list(10);
  assert.ok(history.some((item) => item.deviceCallId === "dev-8"));
  assert.equal(reopened.get(call!.id)?.id, call!.id);
});
