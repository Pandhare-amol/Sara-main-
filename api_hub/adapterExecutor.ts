import { readResponseBytes, safeFetch, type ExternalUrlLookup } from "../shared/netSafety";
import { isSafePublicUrl } from "./healthChecker";
import { validateAdapter } from "./adapterRegistry";
import type {
  ApiAdapterExecutionResult,
  DeclarativeApiAdapter,
} from "./types";

export interface AdapterExecutionOptions {
  fetcher?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  maximumResponseBytes?: number;
  env?: NodeJS.ProcessEnv;
  lookup?: ExternalUrlLookup;
}

export async function executeVerifiedAdapter(
  adapter: DeclarativeApiAdapter,
  args: Record<string, unknown>,
  options: AdapterExecutionOptions = {},
): Promise<ApiAdapterExecutionResult> {
  validateAdapter(adapter);
  if (!adapter.verified) throw new Error("Unverified API adapters cannot execute.");

  const parameters = normalizeParameters(adapter, args);
  let url = renderPath(adapter.urlTemplate, parameters.path);
  const parsed = new URL(url);
  for (const [name, value] of Object.entries(parameters.query)) parsed.searchParams.set(name, stringify(value));
  url = parsed.toString();
  if (!isSafePublicUrl(url)) throw new Error("Adapter resolved to an unsafe URL.");

  const headers: Record<string, string> = {
    accept: "application/json",
    ...Object.fromEntries(Object.entries(parameters.header).map(([name, value]) => [name, stringify(value)])),
  };
  if (adapter.credentialEnv) {
    const credential = (options.env || process.env)[adapter.credentialEnv]?.trim();
    if (!credential) throw new Error(`Connection '${adapter.credentialEnv}' is not configured.`);
    headers[adapter.credentialHeader || "authorization"] = `${adapter.credentialPrefix || ""}${credential}`;
  }
  const body = adapter.method === "POST" && Object.keys(parameters.body).length
    ? JSON.stringify(parameters.body)
    : undefined;
  if (body) headers["content-type"] = "application/json";

  const controller = new AbortController();
  const relayAbort = () => controller.abort("cancelled");
  if (options.signal?.aborted) relayAbort();
  else options.signal?.addEventListener("abort", relayAbort, { once: true });
  const timeout = setTimeout(() => controller.abort("timeout"), clamp(options.timeoutMs ?? 15_000, 1_000, 60_000));
  timeout.unref?.();
  try {
    const response = await safeFetch(url, {
      method: adapter.method,
      headers,
      body,
      signal: controller.signal,
      maxRedirects: 3,
      fetcher: options.fetcher,
      lookup: options.lookup,
    });
    const maximum = clamp(options.maximumResponseBytes ?? 2_000_000, 1_024, 10_000_000);
    const bytes = await readResponseBytes(response, maximum, "API response exceeds the configured size limit.");
    if (!response.ok) throw new Error(`API provider returned HTTP ${response.status}.`);
    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new Error("API provider did not return valid JSON.");
    }
    const data: Record<string, unknown> = {};
    for (const [field, jsonPath] of Object.entries(adapter.output)) {
      data[field] = readRestrictedJsonPath(payload, jsonPath);
    }
    return {
      adapterId: adapter.id,
      providerId: adapter.providerId,
      capability: adapter.capability,
      sourceUrl: redactUrl(response.url || url),
      sourceStatus: response.status,
      timestamp: new Date().toISOString(),
      data,
    };
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(options.signal?.aborted ? "API adapter call was cancelled." : "API adapter call timed out.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", relayAbort);
  }
}

export function verifyAdapterAgainstFixture(
  candidate: DeclarativeApiAdapter,
  fixture: unknown,
  notes = "Validated against a controlled JSON fixture.",
): DeclarativeApiAdapter {
  validateAdapter(candidate);
  for (const jsonPath of Object.values(candidate.output)) {
    if (readRestrictedJsonPath(fixture, jsonPath) === undefined) {
      throw new Error(`Fixture does not contain required output path '${jsonPath}'.`);
    }
  }
  const timestamp = new Date().toISOString();
  return {
    ...candidate,
    verified: true,
    verifiedAt: timestamp,
    verificationNotes: notes.slice(0, 500),
    updatedAt: timestamp,
  };
}

function normalizeParameters(adapter: DeclarativeApiAdapter, args: Record<string, unknown>) {
  const output: Record<"path" | "query" | "header" | "body", Record<string, unknown>> = {
    path: {}, query: {}, header: {}, body: {},
  };
  const accepted = new Set(adapter.parameters.map((parameter) => parameter.name));
  const unknown = Object.keys(args).filter((name) => !accepted.has(name));
  if (unknown.length) throw new Error(`Unknown adapter parameter(s): ${unknown.join(", ")}.`);
  for (const parameter of adapter.parameters) {
    const value = args[parameter.name] ?? parameter.default;
    if (parameter.required && (value === undefined || value === null || value === "")) {
      throw new Error(`Required adapter parameter '${parameter.name}' is missing.`);
    }
    if (value !== undefined && value !== null) {
      if (!["string", "number", "boolean"].includes(typeof value)) {
        throw new Error(`Adapter parameter '${parameter.name}' must be a scalar value.`);
      }
      output[parameter.in][parameter.name] = value;
    }
  }
  return output;
}

function renderPath(template: string, values: Record<string, unknown>): string {
  const rendered = template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_whole, name: string) => {
    if (!(name in values)) throw new Error(`Missing path parameter '${name}'.`);
    return encodeURIComponent(stringify(values[name]));
  });
  if (/\{[a-zA-Z0-9_]+\}/.test(rendered)) throw new Error("Adapter URL contains unresolved parameters.");
  return rendered;
}

export function readRestrictedJsonPath(value: unknown, jsonPath: string): unknown {
  const normalized = jsonPath.replace(/^\$/, "");
  if (!normalized) return value;
  const parts = [...normalized.matchAll(/\.([a-zA-Z0-9_-]+)|\[([0-9]+)\]/g)];
  let current: unknown = value;
  for (const part of parts) {
    const key = part[1] ?? Number(part[2]);
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    for (const name of [...url.searchParams.keys()]) {
      if (/key|token|secret|auth|password/i.test(name)) url.searchParams.set(name, "[redacted]");
    }
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return "remote provider";
  }
}

function stringify(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  throw new Error("Adapter parameter must be a scalar value.");
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(value)));
}
