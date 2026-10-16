import { useCallback, useEffect, useMemo, useState, type Key, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  AlertTriangle, BookOpenCheck, BrainCircuit, CheckCircle2, Database, FlaskConical,
  Globe2, Loader2, Play, RefreshCw, RotateCcw, ShieldAlert, Square, Trash2, X,
} from "lucide-react";

type Tab = "research" | "knowledge" | "collaboration" | "skills" | "providers";

type ResearchSession = {
  id: string; question: string; status: string; stage: string; progress: number;
  sourceIds: string[]; findings: Finding[]; contradictions: Array<{ topic: string; description: string }>;
  report: string; limitations: string[]; errors: Array<{ sourceUrl?: string; message: string }>;
  modelRuns: Array<{ modelId: string; providerId: string; latencyMs: number; estimatedCostUsd: number | null }>;
  createdAt: string; parentSessionId: string | null;
};
type Finding = { id: string; claim: string; status: string; confidence: number; sourceIds: string[]; limitations: string[] };
type ResearchSource = { id: string; title: string; finalUrl: string; authority: string; retrievedAt: string; lastModified: string | null; injectionSuspected: boolean; passages: Array<{ id: string; excerpt: string; relevance: number }> };
type Knowledge = { id: string; topic: string; content: string; status: string; confidence: number; sourceIds: string[]; revalidateAfter: string };
type Provider = { id: string; displayName: string; locality: string; enabled: boolean; configured: boolean; verificationError: string | null };
type Skill = { id: string; name: string; description: string; status: string; version: number; confidence: number; tests: string[]; verificationEvidence: Array<{ kind: string; passed: boolean; summary: string }>; versions: Array<{ version: number; status: string; changeReason: string }> };
type IntelligenceStatus = { providers: Provider[]; models: Array<{ id: string; provider: string; displayName: string; availability: string }>; usage: { models: Record<string, UsageView> }; health: Record<string, { recentFailures: number; coolingDown: boolean }>; activeResearchIds: string[]; research: ResearchSession[]; knowledge: Knowledge[] };
type UsageView = { calls: number; failures: number; inputTokens: number; outputTokens: number; avgLatencyMs: number | null; estimatedCostUsd: number; unpricedCalls: number };
type CollaborationResult = { status: string; verificationStatus: string; consultations: Array<{ modelId: string; providerId: string; text: string; latencyMs: number; estimatedCostUsd: number | null }>; failures: Array<{ modelId: string; error: string }>; review: null | { reviewerModelId: string; independentProvider: boolean; recommendedAnswer: string; consensus: string[]; disagreements: Array<{ topic: string; positions: Array<{ modelId: string; position: string }> }>; unsupportedClaims: Array<{ modelId: string; claim: string; reason: string }>; limitations: string[] } };

interface Props { isOpen: boolean; onClose: () => void }

export function IntelligenceDashboard({ isOpen, onClose }: Props) {
  const [tab, setTab] = useState<Tab>("research");
  const [status, setStatus] = useState<IntelligenceStatus | null>(null);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ session: ResearchSession; sources: ResearchSource[]; active: boolean } | null>(null);
  const [question, setQuestion] = useState("");
  const [urls, setUrls] = useState("");
  const [authorized, setAuthorized] = useState(false);
  const [collaborationPrompt, setCollaborationPrompt] = useState("");
  const [collaborationResult, setCollaborationResult] = useState<CollaborationResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [next, nextSkills] = await Promise.all([
        apiRequest<IntelligenceStatus>("/api/intelligence/status"),
        apiRequest<Skill[]>("/api/skills"),
      ]);
      setStatus(next);
      setSkills(nextSkills);
      if (selectedId) {
        const selected = await apiRequest<{ session: ResearchSession; sources: ResearchSource[]; active: boolean }>(`/api/research/${encodeURIComponent(selectedId)}`);
        setDetail(selected);
      }
      setError(null);
    } catch (cause) {
      setError(message(cause));
    }
  }, [selectedId]);

  useEffect(() => {
    if (!isOpen) return;
    void load();
  }, [isOpen, load]);
  useEffect(() => {
    if (!isOpen || !(status?.activeResearchIds.length)) return;
    const timer = window.setInterval(() => void load(), 1_500);
    return () => window.clearInterval(timer);
  }, [isOpen, status?.activeResearchIds.length, load]);

  const select = async (id: string) => {
    setSelectedId(id);
    setBusy("detail");
    try {
      setDetail(await apiRequest(`/api/research/${encodeURIComponent(id)}`));
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(null); }
  };

  const startResearch = async () => {
    const sources = urls.split(/\r?\n/).map((url) => url.trim()).filter(Boolean).map((url) => ({ url, authority: "unknown" }));
    if (!question.trim() || !sources.length || !authorized) return;
    setBusy("research"); setError(null);
    try {
      const result = await apiRequest<{ session: ResearchSession }>("/api/research", { method: "POST", body: { question, sources, authorized: true } });
      setQuestion(""); setUrls(""); setAuthorized(false);
      await load();
      await select(result.session.id);
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(null); }
  };

  const researchAction = async (action: "cancel" | "retry" | "delete") => {
    if (!selectedId) return;
    setBusy(action); setError(null);
    try {
      if (action === "delete") {
        await apiRequest(`/api/research/${encodeURIComponent(selectedId)}`, { method: "DELETE" });
        setSelectedId(null); setDetail(null);
      } else {
        const result = await apiRequest<{ session?: ResearchSession }>(`/api/research/${encodeURIComponent(selectedId)}/${action}`, { method: "POST", body: {} });
        if (result.session) setSelectedId(result.session.id);
      }
      await load();
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(null); }
  };

  const promote = async (finding: Finding) => {
    if (!selectedId) return;
    setBusy(`promote:${finding.id}`);
    try {
      await apiRequest(`/api/research/${encodeURIComponent(selectedId)}/findings/${encodeURIComponent(finding.id)}/promote`, { method: "POST", body: {} });
      await load();
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(null); }
  };

  const collaborate = async () => {
    if (!collaborationPrompt.trim()) return;
    setBusy("collaboration"); setError(null); setCollaborationResult(null);
    try {
      setCollaborationResult(await apiRequest("/api/intelligence/collaborate", {
        method: "POST", body: { prompt: collaborationPrompt, task: "analysis", maxModels: 2, highImpact: true },
      }));
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(null); }
  };

  const skillAction = async (skill: Skill, action: "outdated" | "delete", version?: number) => {
    setBusy(`skill:${skill.id}`);
    try {
      if (action === "delete") await apiRequest(`/api/skills/${encodeURIComponent(skill.id)}`, { method: "DELETE" });
      else if (version) await apiRequest(`/api/skills/${encodeURIComponent(skill.id)}/rollback`, { method: "POST", body: { version } });
      else await apiRequest(`/api/skills/${encodeURIComponent(skill.id)}/status`, { method: "POST", body: { status: "outdated" } });
      await load();
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(null); }
  };

  const totalKnownCost = useMemo(() => (Object.values(status?.usage.models ?? {}) as UsageView[]).reduce((sum, item) => sum + item.estimatedCostUsd, 0), [status]);

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div className="fixed inset-0 z-[70] bg-black/55 backdrop-blur-sm" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
          <motion.aside className="fixed right-0 top-0 z-[71] flex h-full w-full max-w-3xl flex-col border-l border-white/10 bg-[#080b12]/98 shadow-2xl" initial={{ x: "100%" }} animate={{ x: 0 }} exit={{ x: "100%" }} transition={{ type: "spring", damping: 28, stiffness: 260 }}>
            <header className="flex items-center justify-between border-b border-white/10 px-5 py-4">
              <div><div className="flex items-center gap-2 text-sm font-semibold text-white"><BrainCircuit size={17} className="text-cyan-300" /> Learning & research</div><div className="mt-1 text-[10px] font-mono uppercase tracking-wider text-slate-500">Evidence, providers, skills and cost — no silent auto-learning</div></div>
              <button onClick={onClose} className="rounded-lg p-2 text-slate-400 hover:bg-white/10 hover:text-white" aria-label="Close learning dashboard"><X size={18} /></button>
            </header>
            <nav className="flex gap-1 overflow-x-auto border-b border-white/10 px-4 py-2">
              {(["research", "knowledge", "collaboration", "skills", "providers"] as Tab[]).map((item) => <button key={item} onClick={() => setTab(item)} className={`rounded-lg px-3 py-1.5 text-[10px] font-mono uppercase ${tab === item ? "bg-cyan-500/15 text-cyan-200" : "text-slate-500 hover:text-white"}`}>{item}</button>)}
              <button onClick={() => void load()} className="ml-auto rounded-lg p-1.5 text-slate-500 hover:text-white" title="Refresh"><RefreshCw size={13} /></button>
            </nav>
            {error && <div className="mx-4 mt-3 flex items-start gap-2 rounded-xl border border-rose-400/20 bg-rose-400/5 p-3 text-xs text-rose-200"><AlertTriangle size={14} className="mt-0.5 shrink-0" />{error}</div>}
            <div className="flex-1 overflow-y-auto p-4">
              {tab === "research" && <ResearchView status={status} detail={detail} selectedId={selectedId} busy={busy} question={question} urls={urls} authorized={authorized} setQuestion={setQuestion} setUrls={setUrls} setAuthorized={setAuthorized} start={() => void startResearch()} select={(id) => void select(id)} action={(action) => void researchAction(action)} promote={(finding) => void promote(finding)} />}
              {tab === "knowledge" && <KnowledgeView items={status?.knowledge || []} busy={busy} remove={async (id) => { setBusy(`knowledge:${id}`); try { await apiRequest(`/api/knowledge/${encodeURIComponent(id)}`, { method: "DELETE" }); await load(); } catch (cause) { setError(message(cause)); } finally { setBusy(null); } }} />}
              {tab === "collaboration" && <CollaborationView prompt={collaborationPrompt} setPrompt={setCollaborationPrompt} busy={busy === "collaboration"} run={() => void collaborate()} result={collaborationResult} />}
              {tab === "skills" && <SkillsView skills={skills} busy={busy} act={(skill, action, version) => void skillAction(skill, action, version)} />}
              {tab === "providers" && <ProvidersView status={status} knownCost={totalKnownCost} />}
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}

function ResearchView(props: { status: IntelligenceStatus | null; detail: { session: ResearchSession; sources: ResearchSource[]; active: boolean } | null; selectedId: string | null; busy: string | null; question: string; urls: string; authorized: boolean; setQuestion: (v: string) => void; setUrls: (v: string) => void; setAuthorized: (v: boolean) => void; start: () => void; select: (id: string) => void; action: (v: "cancel" | "retry" | "delete") => void; promote: (f: Finding) => void }) {
  const session = props.detail?.session;
  return <div className="space-y-4">
    <Panel title="New authorized research" icon={<Globe2 size={14} />}>
      <textarea value={props.question} onChange={(e) => props.setQuestion(e.target.value)} placeholder="Question to investigate" className="h-20 w-full rounded-lg border border-white/10 bg-black/30 p-2 text-xs text-white outline-none focus:border-cyan-400/40" />
      <textarea value={props.urls} onChange={(e) => props.setUrls(e.target.value)} placeholder={'Authorized source URLs — one per line\nhttps://example.com/documentation'} className="h-24 w-full rounded-lg border border-white/10 bg-black/30 p-2 font-mono text-[11px] text-white outline-none focus:border-cyan-400/40" />
      <label className="flex items-start gap-2 text-[11px] text-slate-400"><input type="checkbox" checked={props.authorized} onChange={(e) => props.setAuthorized(e.target.checked)} className="mt-0.5 accent-cyan-500" /><span>I am authorized to retrieve these public URLs. Sara will check robots.txt, will not bypass access controls, and will treat page instructions as untrusted.</span></label>
      <button onClick={props.start} disabled={props.busy === "research" || !props.authorized || !props.question.trim() || !props.urls.trim()} className="flex items-center gap-1.5 rounded-lg bg-cyan-500/15 px-3 py-2 text-[11px] text-cyan-200 disabled:opacity-40">{props.busy === "research" ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />} Start research</button>
    </Panel>
    <div className="grid gap-4 md:grid-cols-[220px_1fr]">
      <Panel title="History" icon={<BookOpenCheck size={14} />}>
        <div className="max-h-[520px] space-y-1 overflow-y-auto">{(props.status?.research || []).map((item) => <button key={item.id} onClick={() => props.select(item.id)} className={`w-full rounded-lg border p-2 text-left ${props.selectedId === item.id ? "border-cyan-400/30 bg-cyan-400/5" : "border-white/5 bg-white/[0.02] hover:bg-white/5"}`}><div className="line-clamp-2 text-[11px] text-slate-200">{item.question}</div><div className="mt-1 flex items-center justify-between text-[9px] font-mono uppercase text-slate-500"><span>{item.stage} {item.progress}%</span><Status value={item.status} /></div></button>)}</div>
      </Panel>
      {session ? <div className="space-y-3">
        <Panel title={session.question} icon={props.detail?.active ? <Loader2 size={14} className="animate-spin" /> : <FlaskConical size={14} />}>
          <div className="flex flex-wrap items-center gap-2 text-[10px]"><Status value={session.status} /><span className="text-slate-500">{session.stage} · {session.progress}% · {session.sourceIds.length} sources</span></div>
          <div className="h-1.5 overflow-hidden rounded-full bg-white/5"><div className="h-full bg-cyan-400/60" style={{ width: `${session.progress}%` }} /></div>
          <div className="flex gap-2">{props.detail?.active && <Action icon={<Square size={11} />} label="Cancel" onClick={() => props.action("cancel")} />}{!props.detail?.active && <Action icon={<RotateCcw size={11} />} label="Retry" onClick={() => props.action("retry")} />}<Action icon={<Trash2 size={11} />} label="Delete" onClick={() => props.action("delete")} danger /></div>
        </Panel>
        {session.report && <Panel title="Report" icon={<BookOpenCheck size={14} />}><p className="whitespace-pre-wrap text-xs leading-relaxed text-slate-200">{session.report}</p></Panel>}
        {!!session.findings.length && <Panel title="Evidence findings" icon={<CheckCircle2 size={14} />}>{session.findings.map((finding) => <div key={finding.id} className="rounded-lg border border-white/5 bg-black/20 p-2.5"><div className="flex items-center justify-between gap-2"><Status value={finding.status} /><span className="text-[9px] text-slate-500">{Math.round(finding.confidence * 100)}% · {finding.sourceIds.length} source records</span></div><p className="mt-1 text-[11px] leading-relaxed text-slate-200">{finding.claim}</p>{finding.limitations.map((item) => <p key={item} className="mt-1 text-[9px] text-amber-300/70">{item}</p>)}{finding.sourceIds.length > 0 && <button onClick={() => props.promote(finding)} disabled={props.busy === `promote:${finding.id}`} className="mt-2 text-[9px] font-mono uppercase text-cyan-300 hover:text-cyan-100">Save as knowledge</button>}</div>)}</Panel>}
        {!!props.detail?.sources.length && <Panel title="Raw evidence passages" icon={<Database size={14} />}>{props.detail.sources.map((source) => <details key={source.id} className="rounded-lg border border-white/5 bg-black/20 p-2.5"><summary className="cursor-pointer text-[11px] text-slate-200">{source.title} <span className="text-[9px] text-slate-500">· {source.authority}</span>{source.injectionSuspected && <ShieldAlert size={11} className="ml-1 inline text-amber-300" />}</summary><a href={source.finalUrl} target="_blank" rel="noreferrer" className="mt-1 block break-all text-[9px] text-cyan-300">{source.finalUrl}</a><p className="mt-1 text-[9px] text-slate-500">Retrieved {new Date(source.retrievedAt).toLocaleString()}{source.lastModified ? ` · Last modified ${source.lastModified}` : ""}</p>{source.passages.map((passage) => <blockquote key={passage.id} className="mt-2 border-l border-cyan-400/30 pl-2 text-[10px] leading-relaxed text-slate-400">{passage.excerpt}</blockquote>)}</details>)}</Panel>}
        {(session.limitations.length > 0 || session.errors.length > 0) && <Panel title="Limitations & errors" icon={<AlertTriangle size={14} />}>{session.limitations.map((item) => <p key={item} className="text-[10px] text-amber-200/75">• {item}</p>)}{session.errors.map((item, index) => <p key={`${item.message}-${index}`} className="text-[10px] text-rose-300/75">• {item.sourceUrl ? `${item.sourceUrl}: ` : ""}{item.message}</p>)}</Panel>}
      </div> : <div className="rounded-xl border border-dashed border-white/10 p-8 text-center text-xs text-slate-500">Select a research run to inspect its preserved evidence.</div>}
    </div>
  </div>;
}

function KnowledgeView({ items, busy, remove }: { items: Knowledge[]; busy: string | null; remove: (id: string) => Promise<void> }) {
  return <div className="space-y-3"><p className="text-[11px] text-slate-500">Only findings you explicitly promote appear here. “Supported” means a stored passage was cited; it does not mean independently verified.</p>{items.length ? items.map((item) => <Panel key={item.id} title={item.topic} icon={<Database size={14} />}><div className="flex items-center gap-2"><Status value={item.status} /><span className="text-[9px] text-slate-500">{Math.round(item.confidence * 100)}% · refresh by {new Date(item.revalidateAfter).toLocaleDateString()}</span></div><p className="text-xs leading-relaxed text-slate-200">{item.content}</p><button disabled={busy === `knowledge:${item.id}`} onClick={() => void remove(item.id)} className="flex items-center gap-1 text-[9px] uppercase text-rose-300"><Trash2 size={10} /> Delete</button></Panel>) : <Empty text="No source-grounded knowledge has been promoted." />}</div>;
}

function CollaborationView({ prompt, setPrompt, busy, run, result }: { prompt: string; setPrompt: (v: string) => void; busy: boolean; run: () => void; result: CollaborationResult | null }) {
  return <div className="space-y-4"><Panel title="Independent model consultation" icon={<BrainCircuit size={14} />}><textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Ask configured models to compare approaches…" className="h-36 w-full rounded-lg border border-white/10 bg-black/30 p-3 text-xs text-white outline-none focus:border-cyan-400/40" /><button onClick={run} disabled={busy || !prompt.trim()} className="flex items-center gap-1.5 rounded-lg bg-cyan-500/15 px-3 py-2 text-[11px] text-cyan-200 disabled:opacity-40">{busy ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />} Consult & review</button><p className="text-[10px] text-slate-500">Requests use up to two configured models and a reviewer. Agreement is labeled reviewed, never verified.</p></Panel>{result && <><Panel title="Coordinator result" icon={<CheckCircle2 size={14} />}><div className="flex gap-2"><Status value={result.status} /><Status value={result.verificationStatus} /></div>{result.review ? <><p className="whitespace-pre-wrap text-xs leading-relaxed text-slate-200">{result.review.recommendedAnswer}</p><p className="text-[10px] text-slate-500">Reviewer: {result.review.reviewerModelId} · {result.review.independentProvider ? "independent provider" : "same provider / not independent"}</p></> : <p className="text-[10px] text-amber-200">No coordinator review completed.</p>}</Panel>{result.consultations.map((item) => <details key={item.modelId} className="rounded-xl border border-white/10 bg-white/[0.02] p-3"><summary className="cursor-pointer text-[11px] text-slate-200">{item.modelId} · {item.providerId} · {item.latencyMs} ms</summary><p className="mt-2 whitespace-pre-wrap text-[11px] leading-relaxed text-slate-400">{item.text}</p></details>)}{result.review?.disagreements.map((item) => <Panel key={item.topic} title={`Disagreement: ${item.topic}`} icon={<AlertTriangle size={14} />}>{item.positions.map((position) => <p key={`${position.modelId}-${position.position}`} className="text-[10px] text-slate-300"><b>{position.modelId}:</b> {position.position}</p>)}</Panel>)}{result.failures.map((item) => <p key={`${item.modelId}-${item.error}`} className="text-[10px] text-rose-300">{item.modelId}: {item.error}</p>)}</>}</div>;
}

function SkillsView({ skills, busy, act }: { skills: Skill[]; busy: string | null; act: (skill: Skill, action: "outdated" | "delete", version?: number) => void }) {
  return <div className="space-y-3"><p className="text-[11px] text-slate-500">Proposals are not reusable until passed demonstration or automated-test evidence is attached. Every verified update remains rollbackable.</p>{skills.length ? skills.map((skill) => <Panel key={skill.id} title={`${skill.name} · v${skill.version}`} icon={<FlaskConical size={14} />}><div className="flex gap-2"><Status value={skill.status} /><span className="text-[9px] text-slate-500">confidence {Math.round(skill.confidence * 100)}%</span></div><p className="text-[11px] text-slate-300">{skill.description}</p>{skill.verificationEvidence.map((item, i) => <p key={`${item.summary}-${i}`} className={`text-[9px] ${item.passed ? "text-emerald-300/75" : "text-amber-300/75"}`}>{item.kind}: {item.summary}</p>)}<div className="flex flex-wrap gap-2">{skill.status === "verified" && <Action icon={<ShieldAlert size={10} />} label="Mark outdated" onClick={() => act(skill, "outdated")} />}{skill.versions.filter((v) => v.status === "verified" && v.version !== skill.version).slice(-3).map((version) => <Action key={version.version} icon={<RotateCcw size={10} />} label={`Restore v${version.version}`} onClick={() => act(skill, "outdated", version.version)} />)}<Action icon={<Trash2 size={10} />} label="Delete" onClick={() => act(skill, "delete")} danger /></div>{busy === `skill:${skill.id}` && <Loader2 size={12} className="animate-spin text-cyan-300" />}</Panel>) : <Empty text="No skill proposals or verified skills." />}</div>;
}

function ProvidersView({ status, knownCost }: { status: IntelligenceStatus | null; knownCost: number }) {
  return <div className="space-y-3">
    <Panel title="Usage & pricing visibility" icon={<Database size={14} />}>
      <p className="text-xs text-slate-200">Known configured estimate: ${knownCost.toFixed(6)}</p>
      <p className="text-[10px] text-slate-500">Models without declared current token prices remain explicitly unpriced; Sara does not invent a cost.</p>
    </Panel>
    {status?.providers.map((provider) => {
      const models = status.models.filter((model) => model.provider === provider.id);
      const usages = models.map((model) => status.usage.models[model.id]).filter((item): item is UsageView => Boolean(item));
      const calls = usages.reduce((sum, item) => sum + item.calls, 0);
      const failures = usages.reduce((sum, item) => sum + item.failures, 0);
      const tokens = usages.reduce((sum, item) => sum + item.inputTokens + item.outputTokens, 0);
      const unhealthy = models.filter((model) => status.health[model.id]?.coolingDown || status.health[model.id]?.recentFailures);
      return <Panel key={provider.id} title={provider.displayName} icon={<BrainCircuit size={14} />}>
        <div className="flex flex-wrap gap-2"><Status value={provider.enabled ? provider.configured ? "configured" : "missing key" : "disabled"} /><span className="text-[9px] text-slate-500">{provider.locality} · {models.length} models</span></div>
        {models.map((model) => <p key={model.id} className="text-[9px] text-slate-500">{model.displayName}: {model.availability}{status.health[model.id]?.coolingDown ? " · cooling down" : ""}</p>)}
        {provider.verificationError && <p className="text-[10px] text-rose-300">{provider.verificationError}</p>}
        {calls > 0 && <p className="text-[10px] text-slate-400">{calls} calls · {failures} failures · {tokens} tokens{unhealthy.length ? ` · ${unhealthy.length} unhealthy` : ""}</p>}
      </Panel>;
    }) || <Loader2 size={16} className="animate-spin" />}
  </div>;
}

function Panel({ title, icon, children }: { key?: Key; title: string; icon: ReactNode; children: ReactNode }) { return <section className="space-y-2 rounded-xl border border-white/10 bg-white/[0.025] p-3"><h3 className="flex items-center gap-2 text-[10px] font-mono uppercase tracking-wider text-slate-400">{icon}<span className="line-clamp-2">{title}</span></h3>{children}</section>; }
function Status({ value }: { value: string }) { const positive = ["completed", "supported", "verified", "configured", "reviewed"].includes(value); const negative = ["failed", "conflicting", "disabled", "outdated"].includes(value); return <span className={`rounded-full border px-1.5 py-0.5 text-[8px] font-mono uppercase ${positive ? "border-emerald-400/20 bg-emerald-400/10 text-emerald-300" : negative ? "border-rose-400/20 bg-rose-400/10 text-rose-300" : "border-amber-400/20 bg-amber-400/10 text-amber-200"}`}>{value.replaceAll("_", " ")}</span>; }
function Action({ icon, label, onClick, danger }: { key?: Key; icon: ReactNode; label: string; onClick: () => void; danger?: boolean }) { return <button onClick={onClick} className={`flex items-center gap-1 rounded-lg border px-2 py-1 text-[9px] uppercase ${danger ? "border-rose-400/15 text-rose-300" : "border-white/10 text-slate-300"}`}>{icon}{label}</button>; }
function Empty({ text }: { text: string }) { return <div className="rounded-xl border border-dashed border-white/10 p-8 text-center text-xs text-slate-500">{text}</div>; }

async function apiRequest<T>(url: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(url, { method: options.method || "GET", cache: "no-store", headers: options.body === undefined ? undefined : { "Content-Type": "application/json" }, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  const data = await response.json().catch(() => null) as { error?: string } | null;
  if (!response.ok) throw new Error(data?.error || `Request failed (${response.status}).`);
  return data as T;
}
function message(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause); }
