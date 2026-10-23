/**
 * Sara remote access — opt-in bridge for the mobile web app and the Android app.
 *
 * Sara is a local-first assistant: by default the backend binds to 127.0.0.1 and
 * rejects any request whose Host/Origin is not this machine. That is exactly
 * what the Electron desktop app wants. A phone, however, cannot reach that.
 *
 * This module adds a *second*, explicitly enabled mode:
 *
 *   SARA_REMOTE_ACCESS=1          enable it (off by default)
 *   SARA_ACCESS_TOKEN=...         required, long shared secret (>= 24 chars)
 *   SARA_ALLOWED_ORIGINS=...      comma separated web origins (e.g. the Vercel URL)
 *   SARA_HOST=0.0.0.0             bind address (defaults to 0.0.0.0 when enabled)
 *   SARA_TRUST_PROXY=1            trust X-Forwarded-* from a reverse proxy
 *   SARA_REMOTE_ALLOW_DESKTOP=1   allow remote clients to drive the PC (default off)
 *
 * Safety properties:
 *  - Without a token the remote mode refuses to start (no accidental open server).
 *  - Tokens are compared in constant time over a hash.
 *  - Dangerous desktop-only endpoints are blocked for remote clients unless the
 *    operator explicitly opts in, even when they hold a valid token.
 *  - Local requests keep working exactly as before when remote mode is off.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { NextFunction, Request, Response } from "express";

export interface RemoteAccessConfig {
  enabled: boolean;
  token: string;
  allowedOrigins: string[];
  host: string;
  trustProxy: boolean;
  /** Allow phones to trigger PC automation (chat send, companion, tasks). */
  allowDesktopTools: boolean;
}

/** Origins a Capacitor WebView may report. */
export const CAPACITOR_ORIGINS = ["https://localhost", "http://localhost", "capacitor://localhost"];

/** Endpoints that only make sense on the machine Sara runs on. */
export const DESKTOP_ONLY_PATHS = [
  "/api/screen-vision",
  "/api/logs",
  "/api/proxy",
  "/api/web-proxy",
  "/api/characters/import",
  "/api/characters/",      // import/tests/delete of local model files
  "/api/debug/state",
  "/api/companion/",
  "/api/downloads",
];

/** Paths that never require the access token (no user data is returned). */
export const PUBLIC_PATHS = ["/api/health", "/api/health/"];

export class RemoteAccessConfigError extends Error {}

function truthy(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(String(value ?? "").trim());
}

export function normalizeOrigin(origin: string): string {
  return origin.trim().replace(/\/+$/, "").toLowerCase();
}

/**
 * Build the remote access config from the environment. Throws a descriptive
 * error when remote access is requested without a usable token, so a
 * misconfigured server fails loudly instead of exposing itself.
 */
export function loadRemoteAccessConfig(env: NodeJS.ProcessEnv = process.env): RemoteAccessConfig {
  const enabled = truthy(env.SARA_REMOTE_ACCESS) || truthy(env.MYRAA_REMOTE_ACCESS);
  const token = String(env.SARA_ACCESS_TOKEN ?? env.MYRAA_ACCESS_TOKEN ?? "").trim();
  const allowDesktopTools = truthy(env.SARA_REMOTE_ALLOW_DESKTOP) || truthy(env.MYRAA_REMOTE_ALLOW_DESKTOP);
  const trustProxy = truthy(env.SARA_TRUST_PROXY) || truthy(env.MYRAA_TRUST_PROXY);
  const configuredHost = String(env.SARA_HOST ?? env.MYRAA_HOST ?? "").trim();

  if (enabled && token.length < 24) {
    throw new RemoteAccessConfigError(
      "SARA_REMOTE_ACCESS is enabled but SARA_ACCESS_TOKEN is missing or shorter than 24 characters. " +
        "Generate one with `openssl rand -hex 32` and set it on the server. Refusing to expose Sara without auth.",
    );
  }

  const origins = String(env.SARA_ALLOWED_ORIGINS ?? env.MYRAA_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map(normalizeOrigin)
    .filter(Boolean);

  if (enabled) {
    for (const origin of CAPACITOR_ORIGINS) {
      if (!origins.includes(normalizeOrigin(origin))) origins.push(normalizeOrigin(origin));
    }
  }

  return {
    enabled,
    token,
    allowedOrigins: origins,
    host: configuredHost || (enabled ? "0.0.0.0" : "127.0.0.1"),
    trustProxy,
    allowDesktopTools,
  };
}

/** True when the TCP peer is this machine (desktop windows, local browser). */
export function isLoopbackPeer(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false;
  const address = remoteAddress.replace(/^::ffff:/, "");
  return address === "::1" || address === "127.0.0.1" || address.startsWith("127.");
}

/** Constant-time token comparison over fixed-length digests. */
export function tokenMatches(expected: string, provided: string | undefined | null): boolean {
  if (!expected || !provided) return false;
  const a = createHash("sha256").update(expected).digest();
  const b = createHash("sha256").update(String(provided)).digest();
  return timingSafeEqual(a, b);
}

export function originAllowed(config: RemoteAccessConfig, origin: string | undefined): boolean {
  if (!origin) return true; // native HTTP clients / same-origin navigations
  if (origin === "null") return false;
  return config.allowedOrigins.includes(normalizeOrigin(origin));
}

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.includes(pathname);
}

export function isDesktopOnlyPath(pathname: string): boolean {
  return DESKTOP_ONLY_PATHS.some((prefix) => pathname === prefix.replace(/\/$/, "") || pathname.startsWith(prefix));
}

function readBearer(header: string | undefined): string | undefined {
  const match = /^Bearer\s+(.+)$/i.exec(String(header ?? "").trim());
  return match ? match[1].trim() : undefined;
}

export function extractToken(req: Request | IncomingMessage): string | undefined {
  const headers = req.headers as Record<string, string | string[] | undefined>;
  const bearer = readBearer(Array.isArray(headers.authorization) ? headers.authorization[0] : headers.authorization);
  if (bearer) return bearer;
  const custom = headers["x-sara-token"];
  if (typeof custom === "string" && custom.trim()) return custom.trim();
  if (Array.isArray(custom) && custom[0]) return custom[0].trim();
  const url = String((req as IncomingMessage).url ?? "");
  const queryIndex = url.indexOf("?");
  if (queryIndex >= 0) {
    const params = new URLSearchParams(url.slice(queryIndex + 1));
    const queryToken = params.get("access_token");
    if (queryToken) return queryToken;
  }
  return undefined;
}

/** CORS + auth + capability gating for remote mode. */
export function createRemoteAccessGuard(config: RemoteAccessConfig) {
  return function remoteAccessGuard(req: Request, res: Response, next: NextFunction): void {
    if (!config.enabled) return next();

    // A request that physically comes from this machine (the desktop app and
    // its browser tab) keeps the original local-only behaviour: no token, no
    // origin allow-list. Only tunnelled peers need remote credentials.
    if (isLoopbackPeer(req.socket?.remoteAddress)) {
      res.locals.saraRemote = false;
      return next();
    }

    const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
    if (origin) {
      res.setHeader("Vary", "Origin");
      if (!originAllowed(config, origin)) {
        res.status(403).json({ error: "This origin is not allowed to reach this Sara server." });
        return;
      }
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,X-Sara-Token");
      res.setHeader("Access-Control-Max-Age", "600");
    }

    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }

    const pathname = String(req.path || "/");
    if (isPublicPath(pathname)) return next();

    // The SPA shell and its static assets are public: a phone must be able to
    // load the UI before it has a token. Only backend data and user character
    // files require authentication.
    if (!pathname.startsWith("/api/") && !pathname.startsWith("/user-characters/")) return next();

    if (!tokenMatches(config.token, extractToken(req))) {
      res.status(401).json({
        error: "Missing or invalid Sara access token.",
        code: "SARA_AUTH_REQUIRED",
      });
      return;
    }

    if (!config.allowDesktopTools && isDesktopOnlyPath(pathname)) {
      res.status(403).json({
        error: "This feature is only available on the computer running Sara, not from a remote device.",
        code: "SARA_DESKTOP_ONLY",
      });
      return;
    }

    res.locals.saraRemote = true;
    next();
  };
}

/**
 * Authorize a WebSocket upgrade. Returns null when allowed, otherwise a
 * human-readable reason plus the HTTP status worth logging.
 */
export function authorizeWebSocket(
  config: RemoteAccessConfig,
  request: IncomingMessage,
): { ok: true; remote: boolean } | { ok: false; reason: string } {
  const origin = typeof request.headers.origin === "string" ? request.headers.origin : undefined;

  if (!config.enabled) {
    // Original local-only behaviour: only Sara's own windows may connect.
    const host = String(request.headers.host || "");
    const localOrigin = !origin || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
    if (!localOrigin || !/^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host)) {
      return { ok: false, reason: "Sara only accepts local WebSocket connections." };
    }
    return { ok: true, remote: false };
  }

  // Local windows keep their original behaviour, whatever origin they use:
  // the TCP peer decides, not a spoofable header.
  if (isLoopbackPeer(request.socket?.remoteAddress)) return { ok: true, remote: false };
  if (!originAllowed(config, origin)) return { ok: false, reason: "Origin not allowed." };
  if (!tokenMatches(config.token, extractToken(request))) {
    return { ok: false, reason: "Missing or invalid Sara access token." };
  }
  return { ok: true, remote: true };
}

/**
 * Live voice tools that act on the computer. A phone must not be able to send
 * messages or drive the desktop just because it holds a chat session, unless
 * the operator opted in.
 */
export const REMOTE_BLOCKED_LIVE_TOOLS = new Set([
  "startTask",
  "controlTask",
  "sendChatMessage",
  "companionAction",
]);

export function remoteToolDenied(tool: string): Record<string, unknown> {
  return {
    error: `"${tool}" requires the computer running Sara. Remote device control of the PC is disabled (SARA_REMOTE_ALLOW_DESKTOP).`,
    code: "SARA_DESKTOP_ONLY",
  };
}
