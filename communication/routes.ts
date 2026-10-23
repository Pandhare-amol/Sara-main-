/**
 * HTTP surface for the communication subsystem.
 *
 * Two different callers, two different trust levels:
 *
 *  - the **phone** (device endpoints) authenticates with a device token from
 *    `SARA_CALL_DEVICE_TOKEN`; without that token configured the device
 *    endpoints answer 503 instead of accepting unauthenticated call events;
 *  - the **UI** uses the normal session/remote-access guard that already wraps
 *    every `/api` route.
 */
import { timingSafeEqual } from "node:crypto";
import type { Express, Request, Response } from "express";
import type { AppSettings } from "../settings/appSettings";
import type { CallManager } from "./callManager";
import type { CallEventInput } from "./types";

export interface CallRoutesDeps {
  calls: CallManager;
  settings: () => AppSettings;
  updateCallsSettings: (patch: Record<string, unknown>) => Promise<unknown>;
  /** Read from the environment by the caller so tests can inject a token. */
  deviceToken: string | null;
}

const POLICY_KEYS = [
  "enabled",
  "answerKnownContacts",
  "answerFamily",
  "answerBusinessContacts",
  "answerUnknownCall",
  "answerDuringMeetings",
  "answerDuringFocus",
  "screenCalls",
  "takeMessage",
  "notifyOnMissed",
  "maxCallMinutes",
] as const;

function safeEqual(expected: string, provided: string | undefined): boolean {
  if (!provided) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function registerCallRoutes(app: Express, deps: CallRoutesDeps): void {
  const fail = (res: Response, error: unknown, status = 500) => {
    res.status(status).json({ error: error instanceof Error ? error.message : String(error) });
  };

  /** Device auth. A missing server token is a configuration error, not a bypass. */
  const device = (req: Request, res: Response): boolean => {
    if (!deps.deviceToken) {
      res.status(503).json({
        error: "Phone events are not enabled: set SARA_CALL_DEVICE_TOKEN on the server and in the phone app.",
        code: "DEVICE_TOKEN_NOT_CONFIGURED",
      });
      return false;
    }
    if (!safeEqual(deps.deviceToken, req.header("x-sara-device-token") || undefined)) {
      res.status(401).json({ error: "Device token rejected.", code: "DEVICE_UNAUTHORIZED" });
      return false;
    }
    return true;
  };

  /* ------------------------------------------------------------ phone side */

  app.post("/api/calls/events", async (req: Request, res: Response) => {
    if (!device(req, res)) return;
    try {
      const body = (req.body || {}) as CallEventInput;
      const record = await deps.calls.handleEvent(body);
      res.json({ ok: true, changed: Boolean(record), call: record });
    } catch (error) {
      fail(res, error, 400);
    }
  });

  app.get("/api/calls/devices/:deviceId/commands", async (req: Request, res: Response) => {
    if (!device(req, res)) return;
    try {
      res.json({ commands: await deps.calls.pendingCommands(String(req.params.deviceId)) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post("/api/calls/devices/:deviceId/commands/:commandId/ack", async (req: Request, res: Response) => {
    if (!device(req, res)) return;
    try {
      const command = await deps.calls.ackCommand(String(req.params.deviceId), String(req.params.commandId), String(req.body?.result || ""));
      res.json({ ok: true, command });
    } catch (error) {
      fail(res, error, 400);
    }
  });

  /* --------------------------------------------------------------- UI side */

  app.get("/api/calls", (req: Request, res: Response) => {
    try {
      const limit = Number(req.query.limit) || 30;
      res.json({ active: deps.calls.active(), recent: deps.calls.list(limit) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.get("/api/calls/messages", (req: Request, res: Response) => {
    try {
      const callId = typeof req.query.callId === "string" ? req.query.callId : undefined;
      res.json({ messages: deps.calls.listMessages(callId, Number(req.query.limit) || 50) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.get("/api/calls/policy", (_req: Request, res: Response) => {
    try {
      res.json({ calls: deps.settings().calls, deviceTokenConfigured: Boolean(deps.deviceToken) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post("/api/calls/policy", async (req: Request, res: Response) => {
    try {
      const raw = (req.body || {}) as Record<string, unknown>;
      const patch: Record<string, unknown> = {};
      for (const key of POLICY_KEYS) {
        if (raw[key] !== undefined) patch[key] = raw[key];
      }
      const settings = await deps.updateCallsSettings(patch);
      res.json({ ok: true, calls: (settings as AppSettings).calls });
    } catch (error) {
      fail(res, error, 400);
    }
  });

  app.get("/api/calls/:id", (req: Request, res: Response) => {
    try {
      const call = deps.calls.get(String(req.params.id));
      if (!call) {
        res.status(404).json({ error: "That call is not in Sara's history." });
        return;
      }
      res.json({ call, summary: deps.calls.summary(call.id), messages: deps.calls.listMessages(call.id) });
    } catch (error) {
      fail(res, error, 400);
    }
  });

  app.post("/api/calls/:id/answer", async (req: Request, res: Response) => {
    try {
      res.json({ ok: true, call: await deps.calls.answer(String(req.params.id), "ui") });
    } catch (error) {
      fail(res, error, 400);
    }
  });

  app.post("/api/calls/:id/reject", async (req: Request, res: Response) => {
    try {
      res.json({ ok: true, call: await deps.calls.reject(String(req.params.id), "ui") });
    } catch (error) {
      fail(res, error, 400);
    }
  });

  app.post("/api/calls/:id/end", async (req: Request, res: Response) => {
    try {
      res.json({ ok: true, call: await deps.calls.end(String(req.params.id)) });
    } catch (error) {
      fail(res, error, 400);
    }
  });

  app.post("/api/calls/:id/message", async (req: Request, res: Response) => {
    try {
      const text = String(req.body?.text || "");
      res.json({ ok: true, message: await deps.calls.takeMessage(String(req.params.id), text, "manual") });
    } catch (error) {
      fail(res, error, 400);
    }
  });

  app.post("/api/calls/outgoing", async (req: Request, res: Response) => {
    try {
      const plan = await deps.calls.requestOutgoing({
        query: typeof req.body?.query === "string" ? req.body.query : undefined,
        number: typeof req.body?.number === "string" ? req.body.number : undefined,
        purpose: typeof req.body?.purpose === "string" ? req.body.purpose : undefined,
        confirmed: req.body?.confirmed === true,
        deviceId: typeof req.body?.deviceId === "string" ? req.body.deviceId : undefined,
      });
      const status = plan.status === "queued" || plan.status === "needs_confirmation" ? 200 : 409;
      res.status(status).json(plan);
    } catch (error) {
      fail(res, error, 400);
    }
  });
}
