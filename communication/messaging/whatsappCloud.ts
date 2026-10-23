/**
 * WhatsApp Cloud API provider (official Meta Graph API).
 *
 * This is the only WhatsApp path Sara uses for programmatic sending. It needs a
 * WhatsApp Business account; there is no DOM automation fallback and no QR
 * pairing hack. Inbound messages arrive through the same app's webhook.
 *
 * Sending is verified only through the id Meta returns for the accepted
 * message. A 2xx without a message id is reported as UNCERTAIN.
 */
import type { MessagingProvider, OutboundMessage, ProviderStatus, SendOutcome } from "./types";

const GRAPH_VERSION = "v21.0";

export interface WhatsAppConfig {
  /** Meta app access token (server-side secret). */
  token: string;
  /** The Business phone number id that sends. */
  phoneNumberId: string;
  /** Verify token used by the webhook handshake. */
  verifyToken: string;
  /** Override for tests; defaults to the public Graph host. */
  apiBase?: string;
}

export function readWhatsAppConfig(env: NodeJS.ProcessEnv = process.env): WhatsAppConfig | null {
  const token = (env.WHATSAPP_TOKEN || "").trim();
  const phoneNumberId = (env.WHATSAPP_PHONE_NUMBER_ID || "").trim();
  if (!token || !phoneNumberId) return null;
  return {
    token,
    phoneNumberId,
    verifyToken: (env.WHATSAPP_VERIFY_TOKEN || "").trim(),
    apiBase: (env.WHATSAPP_API_BASE || "https://graph.facebook.com").trim(),
  };
}

export class WhatsAppCloudProvider implements MessagingProvider {
  readonly id = "whatsapp";
  readonly label = "WhatsApp (Cloud API)";

  constructor(private readonly config: WhatsAppConfig | null) {}

  status(): ProviderStatus {
    if (!this.config) {
      return {
        ok: false,
        detail: "WhatsApp Cloud API is not configured (WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID).",
      };
    }
    return { ok: true, detail: "WhatsApp Cloud API configured; sends are verified by the message id Meta returns." };
  }

  async send(message: Omit<OutboundMessage, "confirmed">, options: { signal?: AbortSignal } = {}): Promise<SendOutcome> {
    const base: Pick<SendOutcome, "provider" | "to"> = { provider: this.id, to: message.to };
    if (!this.config) {
      return { ...base, status: "NOT_SUPPORTED", verified: false, detail: this.status().detail };
    }
    const text = message.text.trim();
    if (!text) {
      return { ...base, status: "FAILED", verified: false, detail: "The message is empty.", error: { code: "EMPTY_MESSAGE", message: "Nothing to send.", retryable: false } };
    }
    const recipient = message.to.replace(/[^\d+]/g, "");
    if (recipient.replace(/\D/g, "").length < 7) {
      return { ...base, status: "FAILED", verified: false, detail: "That is not a usable phone number.", error: { code: "BAD_RECIPIENT", message: "Recipient is not a phone number.", retryable: false } };
    }

    const url = `${this.config.apiBase.replace(/\/$/, "")}/${GRAPH_VERSION}/${this.config.phoneNumberId}/messages`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    options.signal?.addEventListener("abort", () => controller.abort(), { once: true });

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: recipient,
          type: "text",
          text: { preview_url: false, body: text.slice(0, 4_000) },
        }),
        signal: controller.signal,
      });

      const raw = await response.text();
      let parsed: unknown = null;
      try {
        parsed = raw ? JSON.parse(raw) : null;
      } catch {
        parsed = null;
      }
      const body = parsed as { messages?: Array<{ id?: string }>; error?: { message?: string; code?: number; type?: string } } | null;

      if (!response.ok) {
        const apiError = body?.error;
        return {
          ...base,
          status: "FAILED",
          verified: false,
          detail: apiError?.message ? `WhatsApp refused the message: ${apiError.message}` : `WhatsApp returned HTTP ${response.status}.`,
          error: {
            code: apiError?.code ? `WHATSAPP_${apiError.code}` : `HTTP_${response.status}`,
            message: apiError?.message || `HTTP ${response.status}`,
            retryable: response.status === 429 || response.status >= 500,
          },
        };
      }

      const id = body?.messages?.[0]?.id;
      if (!id) {
        return {
          ...base,
          status: "UNCERTAIN",
          verified: false,
          detail: "WhatsApp accepted the request but returned no message id, so delivery is unconfirmed.",
        };
      }
      return {
        ...base,
        status: "SENT",
        verified: true,
        providerMessageId: id,
        detail: `WhatsApp accepted the message (id ${id.slice(0, 24)}).`,
      };
    } catch (error) {
      const aborted = (error as { name?: string })?.name === "AbortError";
      return {
        ...base,
        status: aborted ? "UNCERTAIN" : "FAILED",
        verified: false,
        detail: aborted ? "WhatsApp did not answer within 20 seconds; delivery is unknown." : `Could not reach WhatsApp: ${(error as Error).message}`,
        error: { code: aborted ? "TIMEOUT" : "NETWORK", message: (error as Error).message, retryable: true },
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
