/**
 * Messaging domain.
 *
 * One interface, several providers. A provider is only allowed to report SENT
 * when the service returned an identifier for the message it accepted;
 * everything else is FAILED or UNCERTAIN. Nothing here scrapes a UI.
 */

export type ProviderId = string;

export interface ProviderStatus {
  ok: boolean;
  /** User-readable, no secrets. */
  detail: string;
}

export interface OutboundMessage {
  provider: ProviderId;
  /** Provider-specific recipient handle (phone number, user id, thread id). */
  to: string;
  text: string;
  /** Optional provider conversation/thread the reply belongs to. */
  conversationId?: string;
  /** The user has seen the draft and approved it. */
  confirmed?: boolean;
}

export type SendStatus =
  | "SENT"
  | "FAILED"
  | "UNCERTAIN"
  | "REQUIRES_APPROVAL"
  | "NOT_SUPPORTED"
  | "PERMISSION_DENIED";

export interface SendOutcome {
  status: SendStatus;
  verified: boolean;
  provider: ProviderId;
  to: string;
  providerMessageId?: string;
  detail: string;
  error?: { code: string; message: string; retryable: boolean };
  /** Set when the provider needs a human decision before it will send. */
  approvalId?: string;
  /** Exactly what would be sent, for the preview. */
  preview?: string;
}

export interface InboundMessage {
  id: string;
  provider: ProviderId;
  conversationId: string;
  fromId: string;
  fromName: string | null;
  text: string;
  at: string;
  unread: boolean;
  /** Deterministic importance signal, not a model guess. */
  importance: "high" | "normal" | "low";
  reason: string;
}

export interface MessagingProvider {
  id: ProviderId;
  label: string;
  /** Configuration + permission check. Never throws. */
  status(): ProviderStatus;
  send(message: Omit<OutboundMessage, "confirmed">, options?: { signal?: AbortSignal }): Promise<SendOutcome>;
}
