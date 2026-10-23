/**
 * Sara server connection configuration (web + Android).
 *
 * The desktop build talks to the local backend on the same origin. The mobile
 * web build and the Capacitor Android app may talk to a Sara backend that runs
 * on the user's PC, exposed through HTTPS by a tunnel/reverse proxy.
 *
 * Resolution order for the base URL:
 *   1. Runtime configuration:   window.__SARA_CONFIG__ = { apiBase, ... }
 *   2. User configuration:      saved in localStorage from the Connect screen
 *   3. Build-time public value: import.meta.env.VITE_SARA_API_BASE
 *   4. Same origin (desktop / local browser)
 *
 * The access token is NEVER baked into the bundle. It comes from runtime config
 * or the user's Connect screen and is stored on the device only.
 */

export interface SaraServerConfig {
  /** e.g. https://sara.example.com — empty string means "same origin". */
  apiBase: string;
  /** Shared secret for a remotely exposed backend. Empty for local use. */
  token: string;
}

export interface SaraRuntimeConfig {
  apiBase?: string;
  token?: string;
  /** Optional label shown in diagnostics, e.g. "Owner PC". */
  label?: string;
}

declare global {
  interface Window {
    __SARA_CONFIG__?: SaraRuntimeConfig;
    Capacitor?: {
      isNativePlatform?: () => boolean;
      getPlatform?: () => string;
      Plugins?: Record<string, unknown>;
    };
  }
}

const STORAGE_KEY = "sara.server.v1";

function normalizeBase(raw: string | undefined | null): string {
  const value = String(raw ?? "").trim().replace(/\/+$/, "");
  if (!value) return "";
  if (/^https?:\/\/[^/]+/i.test(value)) return value;
  if (/^[a-z0-9.-]+(:\d+)?$/i.test(value)) return `https://${value}`;
  return "";
}

/** True inside the Capacitor Android shell. */
export function isNativeApp(): boolean {
  try {
    return Boolean(window.Capacitor?.isNativePlatform?.());
  } catch {
    return false;
  }
}

function readSaved(): Partial<SaraServerConfig> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<SaraServerConfig>;
    return {
      apiBase: typeof parsed.apiBase === "string" ? parsed.apiBase : undefined,
      token: typeof parsed.token === "string" ? parsed.token : undefined,
    };
  } catch {
    return {};
  }
}

let cached: SaraServerConfig | null = null;

export function getServerConfig(): SaraServerConfig {
  if (cached) return cached;
  const runtime = (typeof window !== "undefined" ? window.__SARA_CONFIG__ : undefined) ?? {};
  const saved = readSaved();
  const envBase = normalizeBase(import.meta.env?.VITE_SARA_API_BASE as string | undefined);
  cached = {
    apiBase: normalizeBase(saved.apiBase || runtime.apiBase || envBase) || "",
    token: String(saved.token || runtime.token || "").trim(),
  };
  return cached;
}

/** Persist a connection and drop the caches that depend on it. */
export function saveServerConfig(next: Partial<SaraServerConfig>, persist = true): SaraServerConfig {
  const current = getServerConfig();
  const merged: SaraServerConfig = {
    apiBase: normalizeBase(next.apiBase ?? current.apiBase) || "",
    token: String(next.token ?? current.token ?? "").trim(),
  };
  cached = merged;
  if (typeof window !== "undefined" && persist) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
    } catch {
      /* private mode — session only */
    }
  }
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("sara:server-config", { detail: merged }));
  return merged;
}

export function clearServerConfig(): void {
  cached = null;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }
}

/** True when a native build still has no backend configured. */
export function needsServerSetup(): boolean {
  return isNativeApp() && !getServerConfig().apiBase;
}

/** Resolve a backend path (or absolute URL) against the configured base. */
export function apiUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const base = getServerConfig().apiBase;
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return base ? `${base}${suffix}` : suffix;
}

/**
 * WebSocket URL for /live or /events. Browsers cannot set Authorization
 * headers on a WebSocket, so the token travels as a query parameter over TLS.
 */
export function wsUrl(path: string): string {
  const base = getServerConfig().apiBase;
  if (!base) {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const token = getServerConfig().token;
    const suffix = token ? `${path}${path.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(token)}` : path;
    return `${protocol}//${window.location.host}${suffix}`;
  }
  const url = new URL(base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = path.startsWith("/") ? path : `/${path}`;
  url.search = "";
  url.hash = "";
  const token = getServerConfig().token;
  if (token) url.searchParams.set("access_token", token);
  return url.toString();
}

/**
 * Absolute URL for a binary/asset request that cannot carry an Authorization
 * header (three.js texture loads, <img>, <video>). The token travels as a query
 * parameter over TLS, exactly like the WebSocket.
 */
export function assetUrl(path: string): string {
  const base = apiUrl(path);
  const token = getServerConfig().token;
  if (!base || !token) return base;
  const separator = base.includes("?") ? "&" : "?";
  return `${base}${separator}access_token=${encodeURIComponent(token)}`;
}

/** Headers for an authenticated backend call. */
export function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const token = getServerConfig().token;
  return token ? { ...extra, Authorization: `Bearer ${token}` } : { ...(extra ?? {}) };
}

export class SaraApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = "SaraApiError";
  }
}

interface SaraFetchInit extends RequestInit {
  /** Milliseconds before the request is aborted. 0 disables the timeout. */
  timeoutMs?: number;
}

/**
 * fetch() against the configured Sara backend with token auth, timeouts and
 * friendly errors. Throws SaraApiError so callers can distinguish 401 from a
 * network failure.
 */
export async function saraFetch(input: string, init: SaraFetchInit = {}): Promise<Response> {
  const { timeoutMs = 20_000, headers, ...rest } = init;
  const controller = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;
  if (rest.signal) {
    if (rest.signal.aborted) controller.abort();
    else rest.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  let response: Response;
  try {
    response = await fetch(apiUrl(input), {
      ...rest,
      signal: controller.signal,
      headers: authHeaders(headers as Record<string, string> | undefined),
    });
  } catch (error) {
    const aborted = (error as { name?: string })?.name === "AbortError";
    throw new SaraApiError(
      aborted
        ? "Sara did not answer in time. Check that her server is running and reachable."
        : "Cannot reach Sara's server. Check the connection address and your network.",
      0,
      aborted ? "SARA_TIMEOUT" : "SARA_UNREACHABLE",
    );
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (!response.ok) {
    let message = `Sara's server returned ${response.status}.`;
    let code: string | undefined;
    try {
      const body = await response.clone().json();
      if (typeof body?.error === "string") message = body.error;
      if (typeof body?.code === "string") code = body.code;
    } catch {
      /* not JSON */
    }
    if (response.status === 401) message = "Sara's access token is missing or incorrect.";
    throw new SaraApiError(message, response.status, code);
  }
  return response;
}

/** JSON helper with the same auth/routing rules. */
export async function saraJson<T>(input: string, init: SaraFetchInit = {}): Promise<T> {
  const response = await saraFetch(input, init);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}
