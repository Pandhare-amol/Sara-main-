/**
 * CallManager — one owner for call state, policy and history.
 *
 * It does not talk to a modem. It consumes events from an authorised companion
 * device, applies `callPolicy`, asks the user through the existing
 * ConfirmationBroker when the policy says so, and queues device commands that
 * the phone polls. Every transition is persisted and audited.
 *
 * Honest boundaries, encoded here rather than in a marketing sentence:
 *  - a call is never marked connected unless the device said so;
 *  - an outgoing call stays pending until the device acknowledges the command;
 *  - a summary contains only what the device reported (transcript, messages).
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AuditLog } from "../agent/audit";
import type { ContactBook, Contact } from "../memory/contacts";
import type { ConfirmationBroker } from "../permissions/confirmations";
import type { AppSettings } from "../settings/appSettings";
import { readJsonFile, writeJsonFile } from "../shared/jsonFile";
import { appEvents } from "../shared/appEvents";
import { decideIncomingCall } from "./callPolicy";
import { buildPeer, formatPhone, normalizePhone } from "./identity";
import {
  CALL_STATES,
  TERMINAL_CALL_STATES,
  type CallEventInput,
  type CallMessageRecord,
  type CallPeer,
  type CallPresence,
  type CallRecord,
  type CallState,
  type CallSummary,
  type DeviceCommand,
  type DeviceCommandKind,
  type OutgoingCallPlan,
  type OutgoingCallRequest,
} from "./types";

interface StoreShape {
  version: 1;
  calls: CallRecord[];
  messages: CallMessageRecord[];
  commands: DeviceCommand[];
}

export interface CallManagerOptions {
  dataDir: string;
  settings: () => AppSettings;
  contacts: ContactBook;
  audit?: AuditLog;
  confirmations?: ConfirmationBroker;
  presence?: () => CallPresence;
  /** In-app notification (Electron window, phone). Must not throw. */
  notify?: (payload: { title: string; body: string; callId: string; priority: "high" | "normal" | "low" }) => void;
  now?: () => number;
  /** Command lifetime; an old queued command must not dial later. */
  commandTtlMs?: number;
  maxRecords?: number;
}

const MAX_COMMANDS = 200;

export class CallManager {
  private calls: CallRecord[] = [];
  private messages: CallMessageRecord[] = [];
  private commands: DeviceCommand[] = [];
  private readonly file: string;
  private readonly now: () => number;
  private readonly commandTtlMs: number;
  private readonly maxRecords: number;
  /** callId → pending confirmation id, so a stop can clean up. */
  private readonly pendingApproval = new Map<string, string>();
  private ready = false;

  constructor(private readonly options: CallManagerOptions) {
    this.file = path.join(options.dataDir, "communication", "calls.v1.json");
    this.now = options.now ?? Date.now;
    this.commandTtlMs = options.commandTtlMs ?? 120_000;
    this.maxRecords = options.maxRecords ?? 500;
  }

  async initialize(): Promise<void> {
    const stored = await readJsonFile<StoreShape>(this.file, { version: 1, calls: [], messages: [], commands: [] });
    this.calls = Array.isArray(stored.calls) ? stored.calls : [];
    this.messages = Array.isArray(stored.messages) ? stored.messages : [];
    this.commands = Array.isArray(stored.commands) ? stored.commands : [];
    this.ready = true;
  }

  /* ------------------------------------------------------------------ reads */

  list(limit = 30): CallRecord[] {
    return this.calls.slice(-Math.max(1, Math.min(limit, 200))).reverse().map(clone);
  }

  get(id: string): CallRecord | null {
    const call = this.calls.find((item) => item.id === id || item.deviceCallId === id);
    return call ? clone(call) : null;
  }

  active(): CallRecord[] {
    return this.calls.filter((call) => !TERMINAL_CALL_STATES.has(call.state)).map(clone);
  }

  listMessages(callId?: string, limit = 50): CallMessageRecord[] {
    const source = callId ? this.messages.filter((message) => message.callId === callId) : this.messages;
    return source.slice(-limit).reverse().map((message) => ({ ...message }));
  }

  /* ----------------------------------------------------------------- events */

  /**
   * Apply a device event. Returns the updated record, or null when the event is
   * a duplicate that changes nothing (duplicates are expected on flaky mobile
   * networks and must not create a second record).
   */
  async handleEvent(input: CallEventInput): Promise<CallRecord | null> {
    await this.whenReady();
    const deviceCallId = String(input.callId || "").trim();
    if (!deviceCallId) throw new Error("callId is required.");
    if (!input.deviceId) throw new Error("deviceId is required.");

    let record = this.calls.find((item) => item.deviceId === input.deviceId && item.deviceCallId === deviceCallId) ?? null;
    const nextState = resolveState(input);

    const isNew = !record;
    if (!record) {
      record = this.createRecord(input, nextState);
      this.calls.push(record);
    } else if (TERMINAL_CALL_STATES.has(record.state)) {
      // A finished call is final. Late or out-of-order device events are
      // ignored rather than reviving it; a genuinely new call arrives with a
      // new device call id.
      return null;
    }

    if (input.transcript?.length) {
      for (const turn of input.transcript) {
        const text = String(turn.text || "").trim().slice(0, 2_000);
        if (!text) continue;
        const at = safeIso(turn.at, this.now()) ?? new Date(this.now()).toISOString();
        const exists = record.transcript.some((item) => item.role === turn.role && item.text === text && item.at === at);
        if (!exists) record.transcript.push({ role: turn.role === "sara" ? "sara" : "caller", text, at });
      }
      record.transcript = record.transcript.slice(-80);
    }

    const previous = record.state;
    const transition = isNew
      ? { changed: true, entered: record.state }
      : applyTransition(record, nextState, this.now());
    if (!transition.changed && !input.transcript?.length) {
      return null;
    }
    record.updatedAt = new Date(this.now()).toISOString();
    if (input.metadata) {
      for (const [key, value] of Object.entries(input.metadata)) {
        if (value === undefined || typeof value === "object") continue;
        record.metadata[key.slice(0, 40)] = value;
      }
    }

    if (transition.entered === "RINGING") {
      await this.onRinging(record);
    }
    if (transition.entered && isTerminal(transition.entered)) {
      this.onTerminal(record, transition.entered);
    }

    this.prune();
    await this.save();
    this.publish(record);
    if (transition.entered && transition.entered !== previous) {
      this.options.audit?.record(null, "call", `Call ${transition.entered.toLowerCase()}: ${record.peer.name || formatPhone(record.peer.number)}`, {
        callId: record.id,
        direction: record.direction,
        decision: record.decision?.action ?? "none",
      });
    }
    return clone(record);
  }

  /* -------------------------------------------------------- user decisions */

  async answer(id: string, via: "ui" | "voice" | "api" = "api"): Promise<CallRecord> {
    const record = this.require(id);
    if (TERMINAL_CALL_STATES.has(record.state)) throw new Error("That call has already ended.");
    this.resolvePending(record.id, true);
    record.answeredAt = record.answeredAt ?? new Date(this.now()).toISOString();
    record.state = "CONNECTED";
    record.updatedAt = new Date(this.now()).toISOString();
    record.decision = { action: "answer_auto", reason: `Answered by the user (${via}).`, requiresUser: false, command: "answer_call" };
    this.queue(record, "answer_call", { deviceCallId: record.deviceCallId, number: record.peer.number });
    this.options.audit?.record(null, "call", `You answered ${record.peer.name || formatPhone(record.peer.number)}`, { callId: record.id, via });
    await this.save();
    this.publish(record);
    return clone(record);
  }

  async reject(id: string, via: "ui" | "voice" | "api" = "api"): Promise<CallRecord> {
    const record = this.require(id);
    if (TERMINAL_CALL_STATES.has(record.state)) throw new Error("That call has already ended.");
    this.resolvePending(record.id, false);
    record.state = "REJECTED";
    record.endedAt = new Date(this.now()).toISOString();
    record.updatedAt = record.endedAt;
    this.queue(record, "reject_call", { deviceCallId: record.deviceCallId });
    this.options.audit?.record(null, "call", `You rejected ${record.peer.name || formatPhone(record.peer.number)}`, { callId: record.id, via });
    await this.save();
    this.publish(record);
    return clone(record);
  }

  async end(id: string): Promise<CallRecord> {
    const record = this.require(id);
    this.queue(record, "end_call", { deviceCallId: record.deviceCallId });
    if (!TERMINAL_CALL_STATES.has(record.state)) {
      record.state = "ENDED";
      record.endedAt = new Date(this.now()).toISOString();
      record.updatedAt = record.endedAt;
      if (record.answeredAt) {
        record.durationSec = Math.max(0, Math.round((Date.parse(record.endedAt) - Date.parse(record.answeredAt)) / 1000));
      }
    }
    await this.save();
    this.publish(record);
    return clone(record);
  }

  /** Take a message during (or after) a call. Stored, never sent anywhere. */
  async takeMessage(id: string, text: string, source: "call" | "manual" = "call"): Promise<CallMessageRecord> {
    const record = this.require(id);
    const clean = String(text || "").trim().slice(0, 2_000);
    if (!clean) throw new Error("A message cannot be empty.");
    const message: CallMessageRecord = {
      id: randomUUID(),
      callId: record.id,
      callerName: record.peer.name,
      number: record.peer.number,
      text: clean,
      at: new Date(this.now()).toISOString(),
      source,
    };
    this.messages.push(message);
    this.options.audit?.record(null, "message", `Message taken from ${record.peer.name || formatPhone(record.peer.number)}`, { callId: record.id, source });
    this.options.notify?.({
      title: record.peer.name ? `Message from ${record.peer.name}` : `Message from ${formatPhone(record.peer.number)}`,
      body: clean.slice(0, 140),
      callId: record.id,
      priority: record.peer.priority === "high" ? "high" : "normal",
    });
    await this.save();
    appEvents.publish("call.message", { callId: record.id, message });
    return { ...message };
  }

  /* ---------------------------------------------------------------- summary */

  /**
   * Structured summary. Only reported material is used; missing pieces are
   * listed under `notes` instead of being filled in by a model.
   */
  summary(id: string): CallSummary {
    const record = this.require(id);
    const messages = this.messages.filter((message) => message.callId === record.id);
    const callerTurns = record.transcript.filter((turn) => turn.role === "caller");

    const requests = callerTurns.filter((turn) => /\b(can you|could you|please|need|send|call me back|tell him|tell her)\b/i.test(turn.text)).map((turn) => turn.text);
    const promises = record.transcript.filter((turn) => turn.role === "sara" && /\b(i will|i'll|i'll tell|sure, i will|i will let)\b/i.test(turn.text)).map((turn) => turn.text);
    const deadlines = record.transcript
      .map((turn) => deadlineOf(turn.text))
      .filter((value): value is string => Boolean(value));

    const basis: string[] = [];
    if (record.transcript.length) basis.push(`${record.transcript.length} transcript turn${record.transcript.length === 1 ? "" : "s"} from the device`);
    if (messages.length) basis.push(`${messages.length} message${messages.length === 1 ? "" : "s"} taken`);
    if (record.metadata.purpose && typeof record.metadata.purpose === "string") basis.push("caller-stated purpose");

    const notes: string[] = [];
    if (!record.transcript.length) notes.push("No transcript was reported by the device, so nothing is summarised as speech.");
    if (!messages.length && !record.transcript.length) notes.push("There is no content to summarise — only call metadata.");

    return {
      caller: record.peer.name,
      number: record.peer.number,
      purpose: typeof record.metadata.purpose === "string" ? record.metadata.purpose : null,
      requests: dedupe(requests).slice(0, 8),
      promises: dedupe(promises).slice(0, 8),
      deadlines: dedupe(deadlines).slice(0, 8),
      followUps: dedupe([...requests, ...messages.map((message) => message.text)]).slice(0, 8),
      messages: messages.map((message) => message.text),
      sentiment: "unknown",
      urgency: record.peer.priority === "high" ? "high" : "unknown",
      basis,
      notes,
    };
  }

  /* --------------------------------------------------------------- outgoing */

  /**
   * Prepare or queue an outgoing call. Without `confirmed: true` this never
   * dials — it returns a preview naming the exact person and number.
   */
  async requestOutgoing(input: OutgoingCallRequest): Promise<OutgoingCallPlan> {
    await this.whenReady();
    const explicit = input.number ? normalizePhone(input.number) : null;
    let contact: Contact | undefined;
    let number = explicit;
    let name: string | null = null;

    if (input.query) {
      const resolution = this.options.contacts.resolve(input.query);
      if (resolution.status === "ambiguous") {
        return {
          status: "ambiguous",
          message: `More than one contact matches "${input.query}". Say which one.`,
          candidates: resolution.candidates.map((candidate) => ({ id: candidate.id, displayName: candidate.displayName })),
        };
      }
      if (resolution.status === "unknown") {
        return { status: "unknown_contact", message: `I don't have a contact called "${input.query}". Give me the number instead.` };
      }
      contact = resolution.contact;
      name = contact.displayName;
      const stored = (contact.phones || []).map((phone) => normalizePhone(phone)).find((value): value is string => Boolean(value));
      if (!stored && !number) {
        return {
          status: "refused",
          message: `${contact.displayName} has no phone number saved. I will not guess one.`,
          target: { name, number: "", contactId: contact.id },
        };
      }
      number = number || stored || null;
    }

    if (!number) return { status: "refused", message: "I need a contact or an exact number to call." };

    if (!input.confirmed) {
      return {
        status: "needs_confirmation",
        message: `Call ${name || formatPhone(number)} on ${formatPhone(number)}?`,
        target: { name, number, contactId: contact?.id ?? null },
      };
    }

    if (!this.options.settings().calls.enabled) {
      return { status: "refused", message: "Phone integration is switched off in settings.", target: { name, number, contactId: contact?.id ?? null } };
    }

    const deviceId = input.deviceId || this.lastDeviceId();
    if (!deviceId) {
      return { status: "refused", message: "No phone has connected yet, so I cannot place a call." };
    }

    const command = this.enqueue(deviceId, "place_call", {
      number,
      name: name ?? "",
      purpose: (input.purpose || "").slice(0, 200),
    });
    this.options.audit?.record(null, "call", `Outgoing call requested: ${name || formatPhone(number)}`, {
      number: formatPhone(number),
      deviceId,
      purpose: (input.purpose || "").slice(0, 120),
    });
    await this.save();
    return {
      status: "queued",
      message: `Calling ${name || formatPhone(number)} from your phone. It has not connected until the phone reports it.`,
      target: { name, number, contactId: contact?.id ?? null },
      command,
    };
  }

  /* ---------------------------------------------------------------- devices */

  /** Commands the device should execute now. Expired ones are dropped, not retried. */
  async pendingCommands(deviceId: string): Promise<DeviceCommand[]> {
    await this.whenReady();
    const now = this.now();
    const live = this.commands.filter((command) => command.deviceId === deviceId && command.status === "pending" && Date.parse(command.expiresAt) > now);
    return live.map((command) => ({ ...command }));
  }

  async ackCommand(deviceId: string, commandId: string, result: string): Promise<DeviceCommand> {
    await this.whenReady();
    const command = this.commands.find((item) => item.id === commandId && item.deviceId === deviceId);
    if (!command) throw new Error("Unknown command for this device.");
    command.status = "acked";
    command.ackedAt = new Date(this.now()).toISOString();
    command.result = String(result || "").slice(0, 200);
    this.options.audit?.record(null, "call", `Phone reported: ${command.kind} ${command.result}`, { commandId: command.id, deviceId });
    await this.save();
    return { ...command };
  }

  lastDeviceId(): string | null {
    return this.calls.length ? this.calls[this.calls.length - 1].deviceId : this.commands.length ? this.commands[this.commands.length - 1].deviceId : null;
  }

  /* --------------------------------------------------------- emergency stop */

  /**
   * Called by the runtime's emergency stop. Queues an end for every live call
   * and drops pending approvals, so a stopped SARA cannot answer afterwards.
   */
  async stop(reason: string): Promise<{ endedCalls: number; clearedCommands: number }> {
    await this.whenReady();
    // Drop every queued action first: a stopped SARA must not answer or dial.
    // The hang-up commands generated below are the only thing the phone may do.
    const clearedCommands = this.commands.filter((command) => command.status === "pending").length;
    this.commands = this.commands.filter((command) => command.status !== "pending");
    let endedCalls = 0;
    for (const record of this.calls) {
      if (TERMINAL_CALL_STATES.has(record.state)) continue;
      record.state = "ENDED";
      record.endedAt = new Date(this.now()).toISOString();
      record.updatedAt = record.endedAt;
      this.queue(record, "end_call", { deviceCallId: record.deviceCallId });
      endedCalls += 1;
    }
    for (const [callId, confirmationId] of this.pendingApproval) {
      this.options.confirmations?.resolve(confirmationId, { approved: false, via: "cancel" });
      this.pendingApproval.delete(callId);
    }
    if (endedCalls || clearedCommands) {
      this.options.audit?.record(null, "call", `Emergency stop: ${reason}`, { endedCalls, clearedCommands });
    }
    await this.save();
    return { endedCalls, clearedCommands };
  }

  /* ---------------------------------------------------------------- internals */

  private async onRinging(record: CallRecord): Promise<void> {
    const presence = this.options.presence?.() ?? { inMeeting: false, focusMode: false };
    const decision = decideIncomingCall({ settings: this.options.settings(), peer: record.peer, presence });
    record.decision = decision;

    this.options.audit?.record(null, "call", `Incoming call: ${record.peer.name || formatPhone(record.peer.number)} → ${decision.action}`, {
      callId: record.id,
      policy: decision.action,
      reason: decision.reason.slice(0, 160),
    });

    this.options.notify?.({
      title: record.peer.name ? `${record.peer.name} is calling` : `Unknown number ${formatPhone(record.peer.number)}`,
      body: decision.reason,
      callId: record.id,
      priority: record.peer.priority === "high" ? "high" : "normal",
    });

    if (decision.command !== "none") {
      this.queue(record, decision.command, { deviceCallId: record.deviceCallId, number: record.peer.number });
      return;
    }

    if (decision.action === "ask_user" && this.options.confirmations) {
      const { request, answer } = this.options.confirmations.request({
        taskId: null,
        capability: "PHONE_CALL",
        title: `Answer call from ${record.peer.name || formatPhone(record.peer.number)}?`,
        description: decision.reason,
        details: { number: formatPhone(record.peer.number), relationship: record.peer.relationship },
        allowRemember: false,
      }, { timeoutMs: 25_000 });
      this.pendingApproval.set(record.id, request.id);
      void answer.then((result) => {
        this.pendingApproval.delete(record.id);
        if (result.approved) {
          record.answeredAt = new Date(this.now()).toISOString();
          record.state = "CONNECTED";
          this.queue(record, "answer_call", { deviceCallId: record.deviceCallId, number: record.peer.number });
        } else if (!TERMINAL_CALL_STATES.has(record.state)) {
          record.state = result.via === "timeout" ? "MISSED" : "REJECTED";
          record.endedAt = new Date(this.now()).toISOString();
          this.queue(record, "reject_call", { deviceCallId: record.deviceCallId });
        }
        record.updatedAt = new Date(this.now()).toISOString();
        void this.save().then(() => this.publish(record));
      });
    }
  }

  private onTerminal(record: CallRecord, state: CallState): void {
    record.endedAt = record.endedAt ?? new Date(this.now()).toISOString();
    if (record.answeredAt) {
      record.durationSec = Math.max(0, Math.round((Date.parse(record.endedAt) - Date.parse(record.answeredAt)) / 1000));
    }
    if (state === "MISSED" && this.options.settings().calls.notifyOnMissed) {
      this.options.notify?.({
        title: `Missed call from ${record.peer.name || formatPhone(record.peer.number)}`,
        body: "SARA did not answer. Tap to call back when you are ready.",
        callId: record.id,
        priority: record.peer.priority === "high" ? "high" : "normal",
      });
    }
  }

  private createRecord(input: CallEventInput, state: CallState): CallRecord {
    const rawNumber = String(input.number || "").trim();
    const contact = rawNumber ? this.options.contacts.findByPhone(rawNumber) ?? null : null;
    const peer = buildPeer({ number: rawNumber || "unknown", reportedName: input.name ?? null, contact });
    const at = safeIso(input.at, this.now()) ?? new Date(this.now()).toISOString();
    return {
      id: randomUUID(),
      deviceCallId: String(input.callId),
      deviceId: String(input.deviceId),
      direction: input.direction === "outgoing" ? "outgoing" : "incoming",
      peer: state === "UNKNOWN" ? { ...peer, unknown: true } : peer,
      state,
      decision: null,
      createdAt: at,
      updatedAt: at,
      answeredAt: null,
      endedAt: null,
      durationSec: null,
      transcript: [],
      metadata: {},
    };
  }

  private resolvePending(callId: string, approved: boolean): void {
    const confirmationId = this.pendingApproval.get(callId);
    if (!confirmationId) return;
    this.pendingApproval.delete(callId);
    this.options.confirmations?.resolve(confirmationId, { approved, via: "api" });
  }

  private queue(record: CallRecord, kind: DeviceCommandKind, payload: Record<string, string | number | boolean | null>): void {
    this.enqueue(record.deviceId, kind, { ...payload, callRecordId: record.id }, record.deviceCallId);
  }

  private enqueue(
    deviceId: string,
    kind: DeviceCommandKind,
    payload: Record<string, string | number | boolean | null>,
    deviceCallId?: string,
  ): DeviceCommand {
    if (deviceCallId) {
      // One live command of each kind per call, so a retry cannot double-dial.
      this.commands = this.commands.filter(
        (command) => !(command.deviceId === deviceId && command.kind === kind && command.status === "pending" && command.payload.deviceCallId === deviceCallId),
      );
    }
    const command: DeviceCommand = {
      id: randomUUID(),
      deviceId,
      kind,
      payload,
      createdAt: new Date(this.now()).toISOString(),
      expiresAt: new Date(this.now() + this.commandTtlMs).toISOString(),
      status: "pending",
      ackedAt: null,
      result: null,
    };
    this.commands.push(command);
    if (this.commands.length > MAX_COMMANDS) this.commands = this.commands.slice(-MAX_COMMANDS);
    appEvents.publish("call.changed", { kind: "command", deviceId, command: { id: command.id, kind: command.kind } });
    return command;
  }

  private require(id: string): CallRecord {
    const record = this.calls.find((item) => item.id === id || item.deviceCallId === id);
    if (!record) throw new Error("That call is not in SARA's history.");
    return record;
  }

  private publish(record: CallRecord): void {
    appEvents.publish("call.changed", { kind: "call", call: clone(record) });
  }

  private prune(): void {
    if (this.calls.length > this.maxRecords) {
      const terminal = this.calls.filter((call) => TERMINAL_CALL_STATES.has(call.state));
      const excess = this.calls.length - this.maxRecords;
      const drop = new Set(terminal.slice(0, excess).map((call) => call.id));
      this.calls = this.calls.filter((call) => !drop.has(call.id));
    }
    if (this.messages.length > this.maxRecords * 2) this.messages = this.messages.slice(-this.maxRecords * 2);
    const now = this.now();
    this.commands = this.commands.filter((command) => command.status === "pending" || Date.parse(command.createdAt) > now - 86_400_000);
  }

  private async whenReady(): Promise<void> {
    if (!this.ready) await this.initialize();
  }

  private async save(): Promise<void> {
    await writeJsonFile(this.file, { version: 1, calls: this.calls, messages: this.messages, commands: this.commands } satisfies StoreShape);
  }
}

/* --------------------------------------------------------------------- pure */

export function resolveState(input: CallEventInput): CallState {
  if (input.type === "state" && input.state && CALL_STATES.includes(input.state)) return input.state;
  switch (input.type) {
    case "ringing": return "RINGING";
    case "connected": return "CONNECTED";
    case "held": return "HELD";
    case "ended": return "ENDED";
    case "missed": return "MISSED";
    case "rejected": return "REJECTED";
    case "failed": return "FAILED";
    default: return input.state && CALL_STATES.includes(input.state) ? input.state : "UNKNOWN";
  }
}

export function applyTransition(record: CallRecord, next: CallState, now: number): { changed: boolean; entered: CallState | null } {
  if (record.state === next) {
    if (next === "CONNECTED" && !record.answeredAt) {
      record.answeredAt = new Date(now).toISOString();
      return { changed: true, entered: "CONNECTED" };
    }
    return { changed: false, entered: null };
  }
  const previous = record.state;
  record.state = next;
  if (next === "CONNECTED" || next === "ACTIVE") record.answeredAt = record.answeredAt ?? new Date(now).toISOString();
  if (isTerminal(next)) record.endedAt = record.endedAt ?? new Date(now).toISOString();
  return { changed: previous !== next, entered: next };
}

function isTerminal(state: CallState): boolean {
  return TERMINAL_CALL_STATES.has(state);
}

function safeIso(value: string | undefined, now: number): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  // Reject clocks that are wildly off rather than trusting them.
  if (Math.abs(parsed - now) > 6 * 3600_000) return null;
  return new Date(parsed).toISOString();
}

function deadlineOf(text: string): string | null {
  const match = text.match(/\b(by|before|until|on)\s+((mon|tues|wednes|thurs|fri|satur|sun)day|tomorrow|today|tonight|next week|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}(:\d{2})?\s?(am|pm))\b/i);
  return match ? match[0].slice(0, 60) : null;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function clone(record: CallRecord): CallRecord {
  return JSON.parse(JSON.stringify(record)) as CallRecord;
}

export type { CallPeer };
