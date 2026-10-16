import { randomUUID } from "node:crypto";
import path from "node:path";
import { readJsonFile, writeJsonFile } from "../shared/jsonFile";
import type {
  KnowledgeItem,
  ResearchFinding,
  ResearchRequest,
  ResearchSession,
  ResearchSourceRecord,
} from "./types";

interface SessionFile {
  version: 1;
  sessions: ResearchSession[];
}

interface SourceFile {
  version: 1;
  sources: ResearchSourceRecord[];
}

interface KnowledgeFile {
  version: 1;
  items: KnowledgeItem[];
}

export class ResearchStore {
  private sessions: ResearchSession[] = [];
  private sources: ResearchSourceRecord[] = [];
  private knowledge: KnowledgeItem[] = [];
  private initialized = false;
  private mutationQueue: Promise<void> = Promise.resolve();
  private readonly sessionsFile: string;
  private readonly sourcesFile: string;
  private readonly knowledgeFile: string;

  constructor(dataDir: string) {
    const root = path.join(dataDir, "intelligence");
    this.sessionsFile = path.join(root, "research-sessions.v1.json");
    this.sourcesFile = path.join(root, "research-sources.v1.json");
    this.knowledgeFile = path.join(root, "knowledge.v1.json");
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    const [sessions, sources, knowledge] = await Promise.all([
      readJsonFile<SessionFile>(this.sessionsFile, { version: 1, sessions: [] }),
      readJsonFile<SourceFile>(this.sourcesFile, { version: 1, sources: [] }),
      readJsonFile<KnowledgeFile>(this.knowledgeFile, { version: 1, items: [] }),
    ]);
    this.sessions = Array.isArray(sessions.sessions) ? sessions.sessions : [];
    this.sources = Array.isArray(sources.sources) ? sources.sources : [];
    this.knowledge = Array.isArray(knowledge.items) ? knowledge.items : [];
    // Work never resumes silently after a process restart. The user may retry
    // the preserved request from the dashboard.
    let changed = false;
    for (const session of this.sessions) {
      if (session.status === "running" || session.status === "queued") {
        session.status = "partial";
        session.limitations = unique([...session.limitations, "Research was interrupted by an application restart; retry is required."]);
        session.updatedAt = new Date().toISOString();
        changed = true;
      }
    }
    this.initialized = true;
    if (changed) await this.persistSessions();
  }

  async createSession(request: ResearchRequest, parentSessionId: string | null = null): Promise<ResearchSession> {
    this.assertInitialized();
    const now = new Date().toISOString();
    const session: ResearchSession = {
      id: randomUUID(),
      question: request.question.trim(),
      projectId: request.projectId ?? null,
      request: structuredClone(request),
      status: "queued",
      stage: "PLAN",
      progress: 0,
      sourceIds: [],
      findings: [],
      contradictions: [],
      report: "",
      limitations: [],
      errors: [],
      modelRuns: [],
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      parentSessionId,
    };
    this.sessions.unshift(session);
    await this.persistSessions();
    return structuredClone(session);
  }

  async updateSession(id: string, patch: Partial<Omit<ResearchSession, "id" | "createdAt" | "request">>): Promise<ResearchSession> {
    this.assertInitialized();
    const session = this.sessions.find((item) => item.id === id);
    if (!session) throw new Error(`Unknown research session: ${id}`);
    Object.assign(session, structuredClone(patch), { updatedAt: new Date().toISOString() });
    await this.persistSessions();
    return structuredClone(session);
  }

  getSession(id: string): ResearchSession | null {
    this.assertInitialized();
    const session = this.sessions.find((item) => item.id === id);
    return session ? structuredClone(session) : null;
  }

  listSessions(limit = 50): ResearchSession[] {
    this.assertInitialized();
    return this.sessions.slice(0, Math.max(1, Math.min(200, limit))).map((item) => structuredClone(item));
  }

  async deleteSession(id: string): Promise<boolean> {
    this.assertInitialized();
    const before = this.sessions.length;
    this.sessions = this.sessions.filter((item) => item.id !== id);
    if (this.sessions.length === before) return false;
    const sourcesChanged = this.pruneUnreferencedSources();
    await Promise.all([this.persistSessions(), ...(sourcesChanged ? [this.persistSources()] : [])]);
    return true;
  }

  async putSource(source: ResearchSourceRecord): Promise<ResearchSourceRecord> {
    this.assertInitialized();
    // Preserve immutable retrieval records while deduplicating an identical
    // retrieval. A changed content hash creates a new source version.
    const duplicate = this.sources.find((item) => item.finalUrl === source.finalUrl && item.contentHash === source.contentHash);
    if (duplicate) return structuredClone(duplicate);
    this.sources.unshift(structuredClone(source));
    await this.persistSources();
    return structuredClone(source);
  }

  getSource(id: string): ResearchSourceRecord | null {
    this.assertInitialized();
    const source = this.sources.find((item) => item.id === id);
    return source ? structuredClone(source) : null;
  }

  sourcesForSession(sessionId: string): ResearchSourceRecord[] {
    const session = this.getSession(sessionId);
    if (!session) return [];
    const ids = new Set(session.sourceIds);
    return this.sources.filter((item) => ids.has(item.id)).map((item) => structuredClone(item));
  }

  async promoteFinding(sessionId: string, findingId: string, topic?: string): Promise<KnowledgeItem> {
    this.assertInitialized();
    const session = this.sessions.find((item) => item.id === sessionId);
    if (!session) throw new Error("Research session not found.");
    if (!['completed', 'partial'].includes(session.status)) throw new Error("Research must finish before a finding can be saved.");
    const finding = session.findings.find((item) => item.id === findingId);
    if (!finding) throw new Error("Research finding not found.");
    if (!finding.sourceIds.length) throw new Error("A finding without source evidence cannot become knowledge.");
    const now = new Date();
    const key = normalize(`${session.projectId || "global"}:${finding.claim}`);
    const existing = this.knowledge.find((item) => item.active && normalize(`${item.projectId || "global"}:${item.content}`) === key);
    if (existing) return structuredClone(existing);
    const item: KnowledgeItem = {
      id: randomUUID(),
      projectId: session.projectId,
      topic: (topic || session.question).trim().slice(0, 240),
      content: finding.claim,
      status: finding.status === "supported" ? "supported" : finding.status === "conflicting" ? "conflicting" : "uncertain",
      confidence: finding.confidence,
      sourceIds: [...finding.sourceIds],
      passageIds: [...finding.passageIds],
      researchSessionId: session.id,
      limitations: [...finding.limitations],
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      lastValidatedAt: now.toISOString(),
      revalidateAfter: new Date(now.getTime() + 30 * 86_400_000).toISOString(),
      supersedesId: null,
      active: true,
    };
    this.knowledge.unshift(item);
    await this.persistKnowledge();
    return structuredClone(item);
  }

  listKnowledge(query?: { text?: string; projectId?: string | null; includeInactive?: boolean }): KnowledgeItem[] {
    this.assertInitialized();
    const terms = tokens(query?.text || "");
    const now = Date.now();
    let staleChanged = false;
    for (const item of this.knowledge) {
      if (item.active && item.status !== "corrected" && Date.parse(item.revalidateAfter) <= now && item.status !== "outdated") {
        item.status = "outdated";
        item.updatedAt = new Date().toISOString();
        staleChanged = true;
      }
    }
    if (staleChanged) void this.persistKnowledge();
    return this.knowledge
      .filter((item) => query?.includeInactive || item.active)
      .filter((item) => !query?.projectId || item.projectId === query.projectId)
      .filter((item) => !terms.length || terms.every((term) => `${item.topic} ${item.content}`.toLowerCase().includes(term)))
      .map((item) => structuredClone(item));
  }

  async correctKnowledge(id: string, correction: { content: string; finding?: ResearchFinding; reason: string }): Promise<KnowledgeItem> {
    this.assertInitialized();
    const previous = this.knowledge.find((item) => item.id === id);
    if (!previous) throw new Error("Knowledge item not found.");
    const content = correction.content.trim();
    if (!content || !correction.reason.trim()) throw new Error("Correction content and reason are required.");
    previous.active = false;
    previous.status = "corrected";
    previous.updatedAt = new Date().toISOString();
    const now = new Date();
    const item: KnowledgeItem = {
      ...structuredClone(previous),
      id: randomUUID(),
      content,
      status: correction.finding?.status === "supported" ? "supported" : "uncertain",
      confidence: correction.finding?.confidence ?? Math.min(previous.confidence, 0.5),
      sourceIds: correction.finding?.sourceIds || [],
      passageIds: correction.finding?.passageIds || [],
      limitations: unique([...(correction.finding?.limitations || []), `Correction reason: ${correction.reason.trim()}`]),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      lastValidatedAt: now.toISOString(),
      revalidateAfter: new Date(now.getTime() + 30 * 86_400_000).toISOString(),
      supersedesId: previous.id,
      active: true,
    };
    this.knowledge.unshift(item);
    await this.persistKnowledge();
    return structuredClone(item);
  }

  async deleteKnowledge(id: string): Promise<boolean> {
    this.assertInitialized();
    const before = this.knowledge.length;
    this.knowledge = this.knowledge.filter((item) => item.id !== id);
    if (before === this.knowledge.length) return false;
    const sourcesChanged = this.pruneUnreferencedSources();
    await Promise.all([this.persistKnowledge(), ...(sourcesChanged ? [this.persistSources()] : [])]);
    return true;
  }

  private pruneUnreferencedSources(): boolean {
    const referenced = new Set<string>();
    for (const session of this.sessions) for (const id of session.sourceIds) referenced.add(id);
    for (const item of this.knowledge) for (const id of item.sourceIds) referenced.add(id);
    const before = this.sources.length;
    this.sources = this.sources.filter((source) => referenced.has(source.id));
    return this.sources.length !== before;
  }

  async flush(): Promise<void> {
    await this.mutationQueue;
  }

  private persistSessions(): Promise<void> {
    return this.enqueue(() => writeJsonFile(this.sessionsFile, { version: 1, sessions: this.sessions } satisfies SessionFile));
  }

  private persistSources(): Promise<void> {
    return this.enqueue(() => writeJsonFile(this.sourcesFile, { version: 1, sources: this.sources } satisfies SourceFile));
  }

  private persistKnowledge(): Promise<void> {
    return this.enqueue(() => writeJsonFile(this.knowledgeFile, { version: 1, items: this.knowledge } satisfies KnowledgeFile));
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    this.mutationQueue = this.mutationQueue.catch(() => {}).then(operation);
    return this.mutationQueue;
  }

  private assertInitialized(): void {
    if (!this.initialized) throw new Error("ResearchStore.initialize() must be called first.");
  }
}

function tokens(text: string): string[] {
  return [...new Set(text.toLowerCase().match(/[a-z0-9]{2,}/g) || [])].slice(0, 12);
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
