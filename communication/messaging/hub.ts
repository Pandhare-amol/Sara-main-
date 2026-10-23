/**
 * MessagingHub — one place that decides whether a message may be sent.
 *
 * Rules, in order:
 *  1. the provider must exist and be configured;
 *  2. the user must have approved this exact draft (or be re-confirming a
 *     retry of the same draft within the idempotency window);
 *  3. the same draft cannot be sent twice in a row (duplicate protection);
 *  4. only the provider's own acknowledgement counts as SENT.
 *
 * Inbound messages recorded here are what a webhook delivered — never invented.
 */
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { AuditLog } from "../../agent/audit";
import type { ConfirmationBroker } from "../../permissions/confirmations";
import { readJsonFile, writeJsonFile } from "../../shared/jsonFile";
import type {
  InboundMessage,
  MessagingProvider,
  OutboundMessage,
  ProviderId,
  ProviderStatus,
  SendOutcome,
} from "./types";

interface OutboxEntry {
  id: string;
  at: string;
  provider: ProviderId;
  to: string;
  /** Redacted preview; the full text is not persisted. */
  preview: string;
  status: SendOutcome["status"];
  verified: boolean;
  providerMessageId: string | null;
  detail: string;
}

interface StoreShape {
  version: 1;
  inbound: InboundMessage[];
  outbox: OutboxEntry[];
}

export interface MessagingHubOptions {
  dataDir: string;
  providers: MessagingProvider[];
  audit?: AuditLog;
  confirmations?: ConfirmationBroker;
  now?: () => number;
  /** Duplicate window for the same (provider, to, text). */
  dedupeWindowMs?: number;
}

export class MessagingHub {
  private inbound: InboundMessage[] = [];
  private outbox: OutboxEntry[] = [];
  private readonly file: string;
  private readonly now: () => number;
  private readonly dedupeWindowMs: number;
  private ready = false;
  private readonly recentSends = new Map<string, number>();

  constructor(private readonly options: MessagingHubOptions) {
    this.file = path.join(options.dataDir, "communication", "messages.v1.json");
    this.now = options.now ?? Date.now;
    this.dedupeWindowMs = options.dedupeWindowMs ?? 90_000;
  }

  async initialize(): Promise<void> {
    const stored = await readJsonFile<StoreShape>(this.file, { version: 1, inbound: [], outbox: [] });
    this.inbound = Array.isArray(stored.inbound) ? stored.inbound : [];
    this.outbox = Array.isArray(stored.outbox) ? stored.outbox : [];
    this.ready = true;
  }

  providers(): Array<{ id: ProviderId; label: string; status: ProviderStatus }> {
    return this.options.providers.map((provider) => ({ id: provider.id, label: provider.label, status: provider.status() }));
  }

  providerStatuses(): Array<{ id: string; configured: boolean; detail: string }> {
    return this.options.providers.map((provider) => {
      const status = provider.status();
      return { id: provider.id, configured: status.ok, detail: status.detail };
    });
  }

  /**
   * Send a message. Without `confirmed: true` this returns REQUIRES_APPROVAL and
   * either creates a confirmation request (when a broker exists) or simply
   * describes the draft.
   */
  async send(message: OutboundMessage): Promise<SendOutcome> {
    await this.whenReady();
    const provider = this.options.providers.find((item) => item.id === message.provider);
    const preview = `${message.provider} → ${message.to}: "${message.text.trim().slice(0, 240)}"`;

    if (!provider) {
      return { provider: message.provider, to: message.to, status: "NOT_SUPPORTED", verified: false, detail: `No ${message.provider} connector is installed.` };
    }
    const status = provider.status();
    if (!status.ok) {
      return { provider: message.provider, to: message.to, status: "NOT_SUPPORTED", verified: false, detail: status.detail, preview };
    }

    const text = message.text.trim();
    if (!text) {
      return { provider: message.provider, to: message.to, status: "FAILED", verified: false, detail: "The message is empty.", preview, error: { code: "EMPTY_MESSAGE", message: "Nothing to send.", retryable: false } };
    }

    if (!message.confirmed) {
      const request = this.options.confirmations?.request({
        taskId: null,
        capability: "SEND_MESSAGE",
        title: `Send ${message.provider} message to ${message.to}?`,
        description: text.slice(0, 400),
        details: { provider: message.provider, to: message.to },
        allowRemember: false,
      }, { timeoutMs: 120_000 });
      return {
        provider: message.provider,
        to: message.to,
        status: "REQUIRES_APPROVAL",
        verified: false,
        detail: "Sara prepared the message and is waiting for your approval.",
        preview,
        ...(request ? { approvalId: request.request.id } : {}),
      };
    }

    const fingerprint = createHash("sha256").update(`${message.provider}|${message.to}|${text}`).digest("hex").slice(0, 32);
    const last = this.recentSends.get(fingerprint);
    if (last !== undefined && this.now() - last < this.dedupeWindowMs) {
      return {
        provider: message.provider,
        to: message.to,
        status: "FAILED",
        verified: false,
        detail: "That exact message was already sent a moment ago, so it was not sent again.",
        preview,
        error: { code: "DUPLICATE", message: "Duplicate message suppressed.", retryable: false },
      };
    }

    const outcome = await provider.send({ provider: message.provider, to: message.to, text, conversationId: message.conversationId });
    if (outcome.status === "SENT") this.recentSends.set(fingerprint, this.now());

    this.outbox.push({
      id: randomUUID(),
      at: new Date(this.now()).toISOString(),
      provider: message.provider,
      to: message.to,
      preview,
      status: outcome.status,
      verified: outcome.verified,
      providerMessageId: outcome.providerMessageId ?? null,
      detail: outcome.detail,
    });
    if (this.outbox.length > 300) this.outbox = this.outbox.slice(-300);
    this.options.audit?.record(null, "message", `${outcome.status} ${message.provider} message to ${message.to}`, {
      verified: outcome.verified,
      providerId: outcome.providerMessageId ?? null,
    });
    await this.save();
    return outcome;
  }

  /** Record an inbound message a provider webhook delivered. */
  async recordInbound(
    input: Omit<InboundMessage, "importance" | "reason" | "unread" | "at"> & { at?: string; unread?: boolean },
  ): Promise<InboundMessage> {
    await this.whenReady();
    const existing = this.inbound.find((item) => item.provider === input.provider && item.id === input.id);
    if (existing) return { ...existing };
    const { importance, reason } = classify(input.text, input.fromName);
    const message: InboundMessage = {
      ...input,
      at: input.at || new Date(this.now()).toISOString(),
      unread: input.unread ?? true,
      importance,
      reason,
    };
    this.inbound.push(message);
    if (this.inbound.length > 500) this.inbound = this.inbound.slice(-500);
    await this.save();
    return { ...message };
  }

  /** Inbound messages, newest first. */
  list(options: { limit?: number; unreadOnly?: boolean; provider?: ProviderId; query?: string } = {}): InboundMessage[] {
    const query = options.query?.trim().toLowerCase();
    return this.inbound
      .filter((message) => (options.unreadOnly ? message.unread : true))
      .filter((message) => (options.provider ? message.provider === options.provider : true))
      .filter((message) => (query ? message.text.toLowerCase().includes(query) || (message.fromName || "").toLowerCase().includes(query) : true))
      .slice(-(options.limit ?? 40))
      .reverse()
      .map((message) => ({ ...message }));
  }

  summary(): { total: number; unread: number; important: number; byProvider: Record<string, number>; highlights: InboundMessage[] } {
    const unread = this.inbound.filter((message) => message.unread);
    const important = unread.filter((message) => message.importance === "high");
    const byProvider: Record<string, number> = {};
    for (const message of unread) byProvider[message.provider] = (byProvider[message.provider] || 0) + 1;
    return {
      total: this.inbound.length,
      unread: unread.length,
      important: important.length,
      byProvider,
      highlights: important.slice(-5).reverse().map((message) => ({ ...message })),
    };
  }

  outboxLog(limit = 30): OutboxEntry[] {
    return this.outbox.slice(-limit).reverse();
  }

  private async whenReady(): Promise<void> {
    if (!this.ready) await this.initialize();
  }

  private async save(): Promise<void> {
    await writeJsonFile(this.file, { version: 1, inbound: this.inbound, outbox: this.outbox } satisfies StoreShape);
  }
}

/**
 * Deterministic importance. Deliberately simple and explainable: a message is
 * high when it asks for something, names a deadline, or comes from a known
 * important contact. The reason is stored with the message.
 */
export function classify(text: string, fromName: string | null): { importance: InboundMessage["importance"]; reason: string } {
  const body = text || "";
  if (/\b(urgent|asap|immediately|deadline|today|tomorrow|by (mon|tues|wednes|thurs|fri|satur|sun)day)\b/i.test(body)) {
    return { importance: "high", reason: "Mentions urgency or a deadline." };
  }
  if (/\?\s*$|^\s*(can|could|would|will) you\b|\bplease\b/i.test(body)) {
    return { importance: "high", reason: "Asks the user to do something." };
  }
  if (/\b(payment|invoice|bank|otp|verification|refund)\b/i.test(body)) {
    return { importance: "high", reason: "Mentions money or account security." };
  }
  if (fromName && /\b(no-?reply|newsletter|promo|offer|marketing)\b/i.test(fromName)) {
    return { importance: "low", reason: "Automated or promotional sender." };
  }
  return { importance: "normal", reason: "No urgency markers." };
}
