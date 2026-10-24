/**
 * Device authentication for the phone → server channel.
 *
 * One token (`SARA_CALL_DEVICE_TOKEN`) authorises a phone to report its own
 * device state and to receive commands meant for it. Two behaviours matter:
 *
 *  - a missing server token is a configuration error, never a bypass (503);
 *  - the comparison is constant-time.
 */
import { timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";

export const DEVICE_TOKEN_HEADER = "x-sara-device-token";

export type DeviceGuard = (req: Request, res: Response) => boolean;

export function createDeviceGuard(token: string | null | undefined): DeviceGuard {
  const expected = (token || "").trim();
  return (req, res) => {
    if (!expected) {
      res.status(503).json({
        error: "Phone integration is not enabled: set SARA_CALL_DEVICE_TOKEN on the server and in the app.",
        code: "DEVICE_TOKEN_NOT_CONFIGURED",
      });
      return false;
    }
    const provided = req.header(DEVICE_TOKEN_HEADER) || "";
    if (!safeEqual(expected, provided)) {
      res.status(401).json({ error: "Device token rejected.", code: "DEVICE_UNAUTHORIZED" });
      return false;
    }
    return true;
  };
}

export function safeEqual(expected: string, provided: string | undefined): boolean {
  if (!provided) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Read the configured token once, treating an empty value as "not configured". */
export function readDeviceToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = (env.SARA_CALL_DEVICE_TOKEN || "").trim();
  return value.length >= 16 ? value : null;
}
