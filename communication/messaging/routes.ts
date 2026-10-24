/**
 * Messaging endpoints.
 *
 * The webhook is the only unauthenticated route (Meta cannot present a session),
 * so it is guarded by HMAC verification of the app secret and refuses to accept
 * anything when that secret is absent.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Express, Request, Response } from "express";
import type { MessagingHub } from "./hub";
import type { WhatsAppConfig } from "./whatsappCloud";

export interface MessagingRoutesDeps {
  hub: MessagingHub;
  whatsapp: WhatsAppConfig | null;
  appSecret: string | null;
}

const MAX_MESSAGES = 40;

export function registerMessagingRoutes(app: Express, deps: MessagingRoutesDeps): void {
  const fail = (res: Response, error: unknown, status = 400) => {
    res.status(status).json({ error: error instanceof Error ? error.message : String(error) });
  };

  app.get("/api/messaging/status", (_req: Request, res: Response) => {
    res.json({
      providers: deps.hub.providers(),
      webhookConfigured: Boolean(deps.whatsapp?.verifyToken && deps.appSecret),
    });
  });

  app.get("/api/messaging/summary", (_req: Request, res: Response) => {
    res.json(deps.hub.summary());
  });

  app.get("/api/messaging/messages", (req: Request, res: Response) => {
    try {
      res.json({
        messages: deps.hub.list({
          limit: Math.min(Number(req.query.limit) || MAX_MESSAGES, 200),
          unreadOnly: req.query.unread === "1",
          provider: typeof req.query.provider === "string" ? req.query.provider : undefined,
          query: typeof req.query.q === "string" ? req.query.q : undefined,
        }),
      });
    } catch (error) {
      fail(res, error);
    }
  });

  app.get("/api/messaging/outbox", (_req: Request, res: Response) => {
    res.json({ outbox: deps.hub.outboxLog(50) });
  });

  app.post("/api/messaging/send", async (req: Request, res: Response) => {
    try {
      const outcome = await deps.hub.send({
        provider: String(req.body?.provider || ""),
        to: String(req.body?.to || ""),
        text: String(req.body?.text || ""),
        conversationId: typeof req.body?.conversationId === "string" ? req.body.conversationId : undefined,
        confirmed: req.body?.confirmed === true,
      });
      // 202: prepared and waiting for a human. 200: actually sent.
      res.status(outcome.status === "REQUIRES_APPROVAL" ? 202 : outcome.status === "SENT" ? 200 : 409).json(outcome);
    } catch (error) {
      fail(res, error, 500);
    }
  });

  /* ------------------------------------------------------ WhatsApp webhook */

  app.get("/api/messaging/whatsapp/webhook", (req: Request, res: Response) => {
    const mode = req.query["hub.mode"];
    const token = String(req.query["hub.verify_token"] || "");
    const challenge = String(req.query["hub.challenge"] || "");
    if (mode !== "subscribe" || !deps.whatsapp?.verifyToken) {
      res.status(400).send("verification failed");
      return;
    }
    const expected = Buffer.from(deps.whatsapp.verifyToken);
    const provided = Buffer.from(token);
    if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
      res.status(403).send("verification failed");
      return;
    }
    res.status(200).send(challenge);
  });

  app.post("/api/messaging/whatsapp/webhook", async (req: Request, res: Response) => {
    if (!deps.appSecret) {
      res.status(503).json({ error: "WhatsApp app secret is not configured, so webhook payloads are not trusted." });
      return;
    }
    const signature = req.header("x-hub-signature-256") || "";
    const raw = JSON.stringify(req.body ?? {});
    const expected = `sha256=${createHmac("sha256", deps.appSecret).update(raw).digest("hex")}`;
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      res.status(401).json({ error: "Signature verification failed." });
      return;
    }
    try {
      const accepted = await ingestWhatsApp(deps.hub, req.body);
      res.json({ ok: true, accepted });
    } catch (error) {
      fail(res, error, 500);
    }
  });
}

/** Pull text messages out of a Cloud API webhook payload. */
export async function ingestWhatsApp(hub: MessagingHub, payload: unknown): Promise<number> {
  const body = payload as {
    entry?: Array<{
      changes?: Array<{
        value?: {
          contacts?: Array<{ wa_id?: string; profile?: { name?: string } }>;
          messages?: Array<{ id?: string; from?: string; timestamp?: string; type?: string; text?: { body?: string } }>;
        };
      }>;
    }>;
  };
  let accepted = 0;
  for (const entry of body?.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      if (!value?.messages?.length) continue;
      const names = new Map((value.contacts ?? []).map((contact) => [contact.wa_id || "", contact.profile?.name || null]));
      for (const message of value.messages) {
        if (!message?.id || !message.from) continue;
        const text = message.type === "text" ? message.text?.body || "" : "";
        if (!text.trim()) continue;
        await hub.recordInbound({
          id: message.id,
          provider: "whatsapp",
          conversationId: message.from,
          fromId: message.from,
          fromName: names.get(message.from) ?? null,
          text: text.slice(0, 4_000),
          at: message.timestamp ? new Date(Number(message.timestamp) * 1000).toISOString() : new Date().toISOString(),
        });
        accepted += 1;
      }
    }
  }
  return accepted;
}
