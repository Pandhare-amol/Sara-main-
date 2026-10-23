/**
 * Connect screen for a Sara backend that is not served from this origin —
 * the mobile web app and the Android build use it to reach a PC over HTTPS.
 *
 * The URL and access token are validated against GET /api/health before they
 * are saved. The token is stored on this device only and never logged.
 */
import { useState, type FormEvent } from "react";
import { Check, Loader2, PlugZap, ShieldCheck, TriangleAlert } from "lucide-react";
import { getServerConfig, isNativeApp, saveServerConfig, type SaraServerConfig } from "../lib/serverConfig";

interface Props {
  onConnected?: (config: SaraServerConfig) => void;
  /** Hide the outer card chrome when embedded in a settings sheet. */
  embedded?: boolean;
}

type TestResult =
  | { state: "idle" }
  | { state: "testing" }
  | { state: "ok"; latencyMs: number; version?: string; remoteAccess?: boolean }
  | { state: "error"; message: string };

function normalizeBase(raw: string): string {
  const value = raw.trim().replace(/\/+$/, "");
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  return `https://${value.replace(/^\/+/, "")}`;
}

export function ServerConnectionPanel({ onConnected, embedded = false }: Props) {
  const current = getServerConfig();
  const [baseUrl, setBaseUrl] = useState(current.apiBase);
  const [token, setToken] = useState(current.token);
  const [result, setResult] = useState<TestResult>({ state: "idle" });

  async function test(base = baseUrl, secret = token): Promise<boolean> {
    const normalized = normalizeBase(base);
    if (!normalized) {
      setResult({ state: "error", message: "Enter the address where Sara's server is running." });
      return false;
    }
    setResult({ state: "testing" });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    const started = performance.now();
    try {
      const response = await fetch(`${normalized}/api/health`, {
        headers: secret ? { Authorization: `Bearer ${secret}` } : undefined,
        signal: controller.signal,
        cache: "no-store",
      });
      if (!response.ok) {
        throw new Error(
          response.status === 401
            ? "The server answered but rejected the access token."
            : `The server answered with ${response.status}.`,
        );
      }
      const body = (await response.json()) as { ok?: boolean; version?: string; remoteAccess?: boolean };
      if (!body?.ok) throw new Error("That address is not a Sara server.");
      const latencyMs = Math.round(performance.now() - started);
      setResult({ state: "ok", latencyMs, version: body.version, remoteAccess: body.remoteAccess });
      return true;
    } catch (error) {
      const aborted = (error as { name?: string })?.name === "AbortError";
      setResult({
        state: "error",
        message: aborted
          ? "The server did not answer in time. Check the address, the tunnel, and that Sara is running."
          : error instanceof Error
            ? error.message.includes("Failed to fetch") || error.message.includes("fetch")
              ? "Could not reach that address. Use the public HTTPS URL of Sara's server (not this phone's localhost)."
              : error.message
            : String(error),
      });
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const ok = await test();
    if (!ok) return;
    const saved = saveServerConfig({ apiBase: normalizeBase(baseUrl), token });
    onConnected?.(saved);
  }

  return (
    <div className={embedded ? "" : "mx-auto w-full max-w-md"}>
      <form
        onSubmit={submit}
        className={
          embedded
            ? "space-y-4"
            : "space-y-4 rounded-3xl border border-white/10 bg-white/[0.04] p-6 shadow-[0_30px_80px_rgba(0,0,0,0.6)] backdrop-blur-2xl"
        }
      >
        {!embedded && (
          <div className="flex flex-col items-center text-center">
            <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500/30 to-cyan-500/20 ring-1 ring-white/10">
              <PlugZap className="h-5 w-5 text-indigo-200" />
            </div>
            <h2 className="font-display text-lg font-semibold tracking-tight text-white">Connect to Sara</h2>
            <p className="mt-1.5 text-xs leading-relaxed text-white/50">
              Sara lives on your computer. Enter the secure address of her server, then her access token.
            </p>
          </div>
        )}

        <label className="block">
          <span className="mb-1.5 block text-[11px] font-medium uppercase tracking-wider text-white/40">Server address</span>
          <input
            type="url"
            inputMode="url"
            autoComplete="url"
            spellCheck={false}
            value={baseUrl}
            onChange={(event) => {
              setBaseUrl(event.target.value);
              setResult({ state: "idle" });
            }}
            placeholder="https://sara.example.com"
            aria-label="Sara server address"
            className="w-full rounded-xl border border-white/10 bg-black/40 px-4 py-3 text-sm text-white outline-none transition focus:border-indigo-400/60 focus:ring-2 focus:ring-indigo-500/20"
          />
        </label>

        <label className="block">
          <span className="mb-1.5 block text-[11px] font-medium uppercase tracking-wider text-white/40">Access token</span>
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={token}
            onChange={(event) => {
              setToken(event.target.value);
              setResult({ state: "idle" });
            }}
            placeholder="The SARA_ACCESS_TOKEN your server was started with"
            aria-label="Sara access token"
            className="w-full rounded-xl border border-white/10 bg-black/40 px-4 py-3 text-sm text-white outline-none transition focus:border-indigo-400/60 focus:ring-2 focus:ring-indigo-500/20"
          />
        </label>

        {result.state === "ok" && (
          <p className="flex items-start gap-2 rounded-xl bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200 ring-1 ring-emerald-500/20">
            <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              Connected in {result.latencyMs} ms{result.version ? ` · Sara ${result.version}` : ""}.
              {result.remoteAccess ? "" : " Remote access is off on this server, so the phone may be refused later."}
            </span>
          </p>
        )}

        {result.state === "error" && (
          <p className="flex items-start gap-2 rounded-xl bg-rose-500/10 px-3 py-2 text-xs text-rose-200 ring-1 ring-rose-500/20">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{result.message}</span>
          </p>
        )}

        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void test()}
            disabled={result.state === "testing" || !baseUrl.trim()}
            className="flex-1 rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm font-medium text-white/80 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {result.state === "testing" ? (
              <span className="inline-flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" /> Testing…
              </span>
            ) : (
              "Test connection"
            )}
          </button>
          <button
            type="submit"
            disabled={result.state === "testing"}
            className="flex-1 rounded-xl bg-gradient-to-r from-indigo-500 to-cyan-500 px-4 py-3 text-sm font-semibold text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Save & connect
          </button>
        </div>

        <p className="flex items-start gap-2 text-[11px] leading-relaxed text-white/35">
          <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            Use an <strong className="font-medium text-white/55">https://</strong> address exposed by a tunnel or reverse proxy.
            {" "}The token stays on this device and is never placed in the build.
            {isNativeApp() ? "" : " On a computer, leave the address empty to use the local server."}
          </span>
        </p>
      </form>
    </div>
  );
}
