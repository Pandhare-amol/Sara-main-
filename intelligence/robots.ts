import { readResponseBytes, safeFetch, type ExternalUrlLookup } from "../shared/netSafety";

export const RESEARCH_USER_AGENT = "SaraResearchBot/13.0";

export interface RobotsNetworkOptions {
  fetcher?: typeof fetch;
  lookup?: ExternalUrlLookup;
}

/**
 * Enforce robots.txt before research-page retrieval. A missing robots file
 * permits retrieval; authentication denials and temporary server failures do
 * not. This is intentionally conservative and never attempts to bypass a
 * block.
 */
export async function assertRobotsAllowed(url: string, signal?: AbortSignal, network: RobotsNetworkOptions = {}): Promise<void> {
  const target = new URL(url);
  const robotsUrl = new URL("/robots.txt", target.origin).toString();
  const response = await safeFetch(robotsUrl, {
    signal,
    fetcher: network.fetcher,
    lookup: network.lookup,
    headers: { "User-Agent": RESEARCH_USER_AGENT, Accept: "text/plain" },
    maxRedirects: 3,
  });
  if (response.status === 404 || response.status === 410) {
    await response.body?.cancel().catch(() => {});
    return;
  }
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel().catch(() => {});
    throw new Error("Website policy denied automated research access.");
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Could not verify website robots policy (HTTP ${response.status}).`);
  }
  const body = new TextDecoder().decode(await readResponseBytes(response, 256_000, "robots.txt exceeds the 256 KB policy limit."));
  if (!robotsAllows(body, `${target.pathname}${target.search}`, "sararesearchbot")) {
    throw new Error("Website robots policy disallows research retrieval for this URL.");
  }
}

export function robotsAllows(text: string, path: string, agent = "sararesearchbot"): boolean {
  const groups: Array<{ agents: string[]; rules: Array<{ kind: "allow" | "disallow"; value: string }> }> = [];
  let current: (typeof groups)[number] | null = null;
  let rulesStarted = false;
  for (const raw of text.split(/\r?\n/)) {
    const clean = raw.replace(/\s*#.*$/, "").trim();
    if (!clean) continue;
    const separator = clean.indexOf(":");
    if (separator < 0) continue;
    const field = clean.slice(0, separator).trim().toLowerCase();
    const value = clean.slice(separator + 1).trim();
    if (field === "user-agent") {
      if (!current || rulesStarted) {
        current = { agents: [], rules: [] };
        groups.push(current);
        rulesStarted = false;
      }
      current.agents.push(value.toLowerCase());
      continue;
    }
    if ((field === "allow" || field === "disallow") && current) {
      current.rules.push({ kind: field, value });
      rulesStarted = true;
    }
  }
  const exact = groups.filter((group) => group.agents.some((item) => agent.includes(item) || item.includes(agent)));
  const selected = exact.length ? exact : groups.filter((group) => group.agents.includes("*"));
  const matches = selected.flatMap((group) => group.rules)
    .filter((rule) => rule.value && pathMatches(path, rule.value))
    .sort((a, b) => b.value.length - a.value.length || (a.kind === "allow" ? -1 : 1));
  return matches[0]?.kind !== "disallow";
}

function pathMatches(path: string, pattern: string): boolean {
  const anchored = pattern.endsWith("$");
  const source = (anchored ? pattern.slice(0, -1) : pattern)
    .split("*")
    .map(escapeRegex)
    .join(".*");
  return new RegExp(`^${source}${anchored ? "$" : ""}`).test(path);
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.-]/g, "\\$&");
}
