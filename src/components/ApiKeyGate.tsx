/**
 * ApiKeyGate — first-run onboarding.
 *
 * Sara ships without any API key. On launch we ask the backend whether a key
 * is configured (GET /api/config). If not, this full-screen overlay blocks the
 * app until the user pastes their own Google Gemini key, which the backend
 * validates with a live test call and stores in their per-user data folder.
 *
 * The key never touches localStorage and is never sent back to the frontend.
 *
 * On a phone (or any build pointed at a remote backend) the first step is the
 * server connection itself: GET /api/health. If that fails, the user gets the
 * Connect screen instead of a misleading "paste a key" form.
 */

import { useEffect, useState, type ReactNode, type FormEvent } from "react";
import { KeyRound, Loader2, ExternalLink, ShieldCheck, ServerCrash } from "lucide-react";
import { getServerConfig, isNativeApp, needsServerSetup, SaraApiError, saraFetch, saraJson } from "../lib/serverConfig";
import { ServerConnectionPanel } from "./ServerConnectionPanel";

type Phase = "checking" | "needsServer" | "unreachable" | "needsKey" | "ready";

type ApiResponse = {
  hasApiKey?: boolean;
  ok?: boolean;
  error?: string;
};

export function ApiKeyGate({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>(() => (needsServerSetup() ? "needsServer" : "checking"));
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    // Native builds with no saved server must not probe a nonexistent origin.
    if (needsServerSetup() && retryKey === 0) return;
    let cancelled = false;
    (async () => {
      setPhase("checking");
      try {
        const data = await saraJson<ApiResponse>("/api/config", { cache: "no-store", timeoutMs: 15_000 });
        if (cancelled) return;
        setPhase(data.hasApiKey ? "ready" : "needsKey");
      } catch (err) {
        if (cancelled) return;
        // 401 on a server that IS reachable means "token needed", not "offline".
        if (err instanceof SaraApiError && err.status === 401) {
          setPhase("needsServer");
          setError("Sara's server refused the access token.");
          return;
        }
        setPhase(isNativeApp() || getServerConfig().apiBase ? "needsServer" : "unreachable");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [retryKey]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const key = value.trim();
    if (!key || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await saraFetch("/api/config/apikey", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: key }),
        timeoutMs: 30_000,
      });
      const data = (await res.json()) as ApiResponse;
      if (!res.ok) throw new Error(data.error || "Could not save the key.");
      setValue("");
      setPhase("ready");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setSubmitting(false);
    }
  }

  if (phase === "ready") return <>{children}</>;

  const shell = (content: ReactNode) => (
    <div className="fixed inset-0 z-[100] flex items-center justify-center overflow-y-auto bg-[#050509] px-4 py-8 text-white">
      <div className="pointer-events-none absolute -left-40 -top-40 h-[420px] w-[420px] rounded-full bg-indigo-700/20 blur-[130px]" />
      <div className="pointer-events-none absolute -bottom-40 -right-40 h-[480px] w-[480px] rounded-full bg-cyan-700/15 blur-[150px]" />
      <div className="relative z-10 w-full max-w-md">{content}</div>
    </div>
  );

  if (phase === "needsServer") {
    return shell(
      <div className="space-y-4">
        <ServerConnectionPanel
          onConnected={() => {
            setError(null);
            setPhase("checking");
            setRetryKey((n) => n + 1);
          }}
        />
        {error && <p className="text-center text-xs text-rose-300">{error}</p>}
        <button
          type="button"
          onClick={() => setRetryKey((n) => n + 1)}
          className="mx-auto block text-[11px] uppercase tracking-widest text-white/35 underline transition hover:text-white/70"
        >
          Try the saved connection again
        </button>
      </div>,
    );
  }

  if (phase === "checking") {
    return shell(
      <div className="flex flex-col items-center gap-4 text-white/60">
        <Loader2 className="h-7 w-7 animate-spin" />
        <span className="text-sm tracking-wide">Starting Sara…</span>
      </div>,
    );
  }

  if (phase === "unreachable") {
    return shell(
      <div className="rounded-3xl border border-white/10 bg-white/[0.04] p-8 text-center backdrop-blur-2xl">
        <ServerCrash className="mx-auto mb-4 h-8 w-8 text-amber-300" />
        <h1 className="text-lg font-semibold">Sara's server is not running</h1>
        <p className="mt-2 text-sm leading-relaxed text-white/55">
          Start the desktop app with <code className="rounded bg-black/40 px-1.5 py-0.5 text-xs">npm run dev</code>, then
          reload this page. On a phone, use <strong className="font-medium text-white/70">Connect to a server</strong>{" "}
          and enter Sara's HTTPS address.
        </p>
        <div className="mt-5 flex flex-col gap-2 sm:flex-row">
          <button
            type="button"
            onClick={() => setRetryKey((n) => n + 1)}
            className="flex-1 rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm font-medium text-white/80 transition hover:bg-white/10"
          >
            Retry
          </button>
          <button
            type="button"
            onClick={() => setPhase("needsServer")}
            className="flex-1 rounded-xl bg-gradient-to-r from-indigo-500 to-cyan-500 px-4 py-3 text-sm font-semibold text-white transition hover:brightness-110"
          >
            Connect to a server
          </button>
        </div>
      </div>,
    );
  }

  return shell(
    <form
      onSubmit={submit}
      className="rounded-3xl border border-white/10 bg-white/[0.04] p-8 shadow-[0_30px_80px_rgba(0,0,0,0.6)] backdrop-blur-2xl"
    >
      <div className="mb-6 flex flex-col items-center text-center">
        <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500/30 to-cyan-500/20 ring-1 ring-white/10">
          <KeyRound className="h-6 w-6 text-indigo-200" />
        </div>
        <h1 className="text-xl font-semibold tracking-tight">Welcome to Sara</h1>
        <p className="mt-2 text-sm leading-relaxed text-white/55">
          Sara runs on your own Google Gemini API key. Paste it below to get started — it stays on the computer running
          Sara and is never shared.
        </p>
      </div>

      <label className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-white/40">Gemini API key</label>
      <input
        type="password"
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="AIza…"
        spellCheck={false}
        aria-label="Gemini API key"
        className="w-full rounded-xl border border-white/10 bg-black/40 px-4 py-3 text-sm text-white outline-none transition focus:border-indigo-400/60 focus:ring-2 focus:ring-indigo-500/20"
      />

      {error && (
        <p className="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-300 ring-1 ring-red-500/20">{error}</p>
      )}

      <button
        type="submit"
        disabled={submitting || !value.trim()}
        className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-indigo-500 to-cyan-500 px-4 py-3 text-sm font-semibold text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {submitting ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" /> Verifying…
          </>
        ) : (
          <>Continue</>
        )}
      </button>

      <div className="mt-5 flex items-center justify-between text-xs text-white/40">
        <span className="inline-flex items-center gap-1.5">
          <ShieldCheck className="h-3.5 w-3.5" /> Server-side only
        </span>
        <a
          href="https://aistudio.google.com/app/apikey"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-indigo-300 transition hover:text-indigo-200"
        >
          Get a free key <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </div>

      <button
        type="button"
        onClick={() => setPhase("needsServer")}
        className="mt-4 w-full text-center text-[11px] uppercase tracking-widest text-white/30 underline transition hover:text-white/60"
      >
        Use a different Sara server
      </button>
    </form>,
  );
}
