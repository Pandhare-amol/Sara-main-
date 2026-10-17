/**
 * Outbound URL safety. Server-side fetches (web.fetch, downloads and API hub
 * calls) may only reach public http(s) hosts: no loopback, private ranges,
 * link-local/metadata addresses or URLs carrying credentials.
 */
import dns from "node:dns/promises";
import net from "node:net";

export type ExternalUrlLookup = (hostname: string) => Promise<Array<{ address: string; family?: number }>>;

const systemLookup: ExternalUrlLookup = async (hostname) => dns.lookup(hostname, { all: true });

export async function assertSafeExternalUrl(
  value: string,
  lookup: ExternalUrlLookup = systemLookup,
): Promise<URL> {
  const parsed = new URL(value);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Only HTTP and HTTPS URLs are supported.");
  }
  if (parsed.username || parsed.password) throw new Error("URLs with embedded credentials are not allowed.");
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal")) {
    throw new Error("Local network addresses are not allowed.");
  }
  const addresses = net.isIP(hostname)
    ? [hostname]
    : (await lookup(hostname)).map((entry) => entry.address);
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new Error("Private, loopback, or link-local destinations are not allowed.");
  }
  return parsed;
}

export function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === "::1" || normalized === "::" || normalized.startsWith("fc") ||
      normalized.startsWith("fd") || normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb") ||
      normalized.startsWith("ff") || normalized.startsWith("2001:db8")) {
    return true;
  }
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  const ipv4 = mapped || (net.isIP(normalized) === 4 ? normalized : null);
  if (!ipv4) return false;
  const [a, b, c] = ipv4.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113);
}

export type SafeFetchInit = RequestInit & {
  maxRedirects?: number;
  fetcher?: typeof fetch;
  lookup?: ExternalUrlLookup;
};

/** Read a response without buffering more than the declared maximum. */
export async function readResponseBytes(
  response: Response,
  maximumBytes: number,
  errorMessage = "Response exceeds the configured size limit.",
): Promise<Uint8Array> {
  const maximum = Math.max(1, Math.floor(maximumBytes));
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > maximum) {
    await response.body?.cancel().catch(() => {});
    throw new Error(errorMessage);
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) {
        await reader.cancel().catch(() => {});
        throw new Error(errorMessage);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

/** Follow redirects manually so the hostname and DNS result of every hop are validated. */
export async function safeFetch(url: string, init: SafeFetchInit = {}): Promise<Response> {
  const {
    maxRedirects = 5,
    fetcher = fetch,
    lookup = systemLookup,
    ...requestInit
  } = init;
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    await assertSafeExternalUrl(current, lookup);
    const response = await fetcher(current, { ...requestInit, redirect: "manual" });
    if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
      current = new URL(response.headers.get("location")!, current).toString();
      await response.body?.cancel().catch(() => {});
      continue;
    }
    Object.defineProperty(response, "finalUrl", { value: current });
    return response;
  }
  throw new Error("Too many redirects.");
}
