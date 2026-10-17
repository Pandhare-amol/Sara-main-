import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ModelRouter } from "../models/router";
import { createLogger } from "../shared/logger";
import { extractCodeSymbols } from "./codeSymbols";
import { buildProjectMap } from "./projectMap";
import { contentHash, extractFile, suspiciousInstructions, termsFor } from "./extract";
import { KnowledgeStore } from "./store";
import type { IndexedDocument, IndexIssue, IndexJob, KnowledgeChunk, SearchHit, SearchRequest, SourceGrant, SourceKind, SourceVisibility } from "./types";

const log = createLogger("knowledge.indexer");
const DEFAULT_EXTENSIONS = [
  ".txt", ".md", ".mdx", ".rst", ".adoc", ".rtf", ".csv", ".tsv", ".json", ".jsonl", ".xml", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".log",
  ".docx", ".xlsx", ".pptx", ".doc", ".xls", ".ppt", ".pdf",
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".java", ".kt", ".go", ".rs", ".rb", ".php", ".cs", ".c", ".h", ".cc", ".cpp", ".hpp", ".swift", ".scala", ".sh", ".ps1", ".bat", ".sql", ".graphql", ".html", ".css", ".scss", ".vue", ".svelte", ".astro",
];
const ALWAYS_SKIP_DIRS = new Set([".git", ".svn", ".hg", ".ssh", ".gnupg", ".config", "appdata", "library", "user data", "node_modules", "dist", "build", "coverage", ".next", ".nuxt", ".cache", "__pycache__", ".venv", "venv", "$recycle.bin", "system volume information"]);
const SECRET_FILE = /^(?:\.env(?:\..*)?|credentials?(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|.*\.(?:pem|p12|pfx|key|kdbx))$/i;

export interface CreateSourceInput {
  path: string;
  label?: string;
  kind?: SourceKind;
  visibility?: SourceVisibility;
  projectId?: string | null;
  includeExtensions?: string[];
  excludePatterns?: string[];
  maxFileBytes?: number;
  maxFiles?: number;
  autoRefreshMinutes?: number | null;
  allowExternalProcessing?: boolean;
  semanticIndex?: boolean;
  retentionDays?: number | null;
  authorized?: boolean;
}

export class KnowledgeIndexer {
  private readonly active = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  /** Serializes start decisions per owner/source across the first awaited store write. */
  private readonly starting = new Set<string>();
  private readonly refreshTimers = new Map<string, NodeJS.Timeout>();

  constructor(readonly store: KnowledgeStore, private readonly router: ModelRouter | null) {}

  async initialize(): Promise<void> {
    await this.store.initialize();
    for (const root of this.store.roots("local-default")) this.scheduleRefresh(root);
    await this.store.enforceRetention("local-default");
  }

  async addSource(ownerId: string, input: CreateSourceInput): Promise<SourceGrant> {
    if (input.authorized !== true) throw forbidden("Explicit authorization is required before a local path can be indexed.");
    if (!input.path || !path.isAbsolute(input.path)) throw badRequest("An absolute local folder path is required.");
    const resolved = path.resolve(input.path);
    const stat = await fs.stat(resolved).catch(() => null);
    if (!stat?.isDirectory()) throw badRequest("The authorized source path must be an existing folder.");
    const real = await fs.realpath(resolved);
    const now = new Date().toISOString();
    const root: SourceGrant = {
      id: randomUUID(), ownerId, label: String(input.label || path.basename(real) || real).trim().slice(0, 120),
      kind: (["documents", "project", "notes", "task_history", "storage"] as const).includes(input.kind as SourceKind) ? input.kind! : "documents",
      rootPath: resolved, realRootPath: real,
      visibility: input.visibility === "project" ? "project" : "private",
      projectId: input.projectId ? String(input.projectId).trim().slice(0, 120) : input.kind === "project" ? randomUUID() : null,
      includeExtensions: normalizeExtensions(input.includeExtensions?.length ? input.includeExtensions : DEFAULT_EXTENSIONS),
      excludePatterns: (input.excludePatterns || []).map(String).filter(Boolean).slice(0, 100),
      maxFileBytes: clamp(input.maxFileBytes, 16_384, 50 * 1024 * 1024, 10 * 1024 * 1024),
      maxFiles: clamp(input.maxFiles, 1, 100_000, 10_000),
      autoRefreshMinutes: input.autoRefreshMinutes == null ? null : clamp(input.autoRefreshMinutes, 1, 24 * 60, 5),
      allowExternalProcessing: input.allowExternalProcessing === true,
      semanticIndex: input.semanticIndex === true,
      retentionDays: input.retentionDays == null ? null : clamp(input.retentionDays, 1, 3650, 365),
      enabled: true, authorizedAt: now, updatedAt: now, lastIndexedAt: null,
    };
    await this.store.putRoot(root);
    this.scheduleRefresh(root);
    return root;
  }

  async updateSource(ownerId: string, sourceId: string, patch: Partial<CreateSourceInput> & { enabled?: boolean }): Promise<SourceGrant> {
    const root = this.requireRoot(ownerId, sourceId);
    if (patch.label !== undefined) root.label = String(patch.label).trim().slice(0, 120) || root.label;
    if (patch.excludePatterns) root.excludePatterns = patch.excludePatterns.map(String).filter(Boolean).slice(0, 100);
    if (patch.includeExtensions) root.includeExtensions = normalizeExtensions(patch.includeExtensions);
    if (patch.visibility) root.visibility = patch.visibility === "project" ? "project" : "private";
    if (patch.allowExternalProcessing !== undefined) root.allowExternalProcessing = patch.allowExternalProcessing === true;
    if (patch.semanticIndex !== undefined) root.semanticIndex = patch.semanticIndex === true;
    if (patch.enabled !== undefined) root.enabled = patch.enabled === true;
    if (patch.autoRefreshMinutes !== undefined) root.autoRefreshMinutes = patch.autoRefreshMinutes == null ? null : clamp(patch.autoRefreshMinutes, 1, 1440, 5);
    if (patch.retentionDays !== undefined) root.retentionDays = patch.retentionDays == null ? null : clamp(patch.retentionDays, 1, 3650, 365);
    root.updatedAt = new Date().toISOString();
    await this.store.putRoot(root);
    this.scheduleRefresh(root);
    return root;
  }

  async removeSource(ownerId: string, sourceId: string): Promise<boolean> {
    const stopping: Promise<void>[] = [];
    for (const [jobId, active] of this.active) {
      const job = this.store.job(ownerId, jobId);
      if (job?.sourceId === sourceId) { active.controller.abort(); stopping.push(active.promise); }
    }
    await Promise.allSettled(stopping);
    const timer = this.refreshTimers.get(sourceId); if (timer) clearInterval(timer);
    this.refreshTimers.delete(sourceId);
    return this.store.removeRoot(ownerId, sourceId);
  }

  async start(ownerId: string, sourceId: string, retryOf: string | null = null): Promise<IndexJob> {
    const startKey = `${ownerId}\0${sourceId}`;
    if (this.starting.has(startKey)) throw conflict("This source is already being indexed.");
    this.starting.add(startKey);
    try {
      const root = this.requireRoot(ownerId, sourceId);
      if (!root.enabled) throw conflict("This source is disabled.");
      const current = [...this.active.entries()].find(([id]) => this.store.job(ownerId, id)?.sourceId === sourceId);
      if (current) {
        const existingJob = this.store.job(ownerId, current[0]);
        if (!existingJob || !["completed", "failed", "cancelled", "interrupted"].includes(existingJob.status)) {
          throw conflict("This source is already being indexed.");
        }
        // A terminal status is persisted immediately before the active promise
        // removes itself. Await that tiny cleanup window so an immediate,
        // intentional reindex is not rejected nondeterministically under load.
        await current[1].promise;
      }
      const now = new Date().toISOString();
      const job: IndexJob = {
        id: randomUUID(), sourceId, ownerId, status: "queued", progress: 0, stage: "Queued",
        scanned: 0, indexed: 0, unchanged: 0, unsupported: 0, failed: 0, duplicates: 0, deleted: 0,
        issues: [], retryOf, checkpoint: { pendingPaths: [], completedPaths: [], nextSafeAction: "Scan the authorized root without following symlinks." },
        startedAt: now, updatedAt: now, completedAt: null,
      };
      await this.store.putJob(job);
      const controller = new AbortController();
      const promise = this.run(job, root, controller.signal)
        .catch((error) => log.warn("indexing job failed", { jobId: job.id, error: error instanceof Error ? error.message : String(error) }))
        .finally(() => this.active.delete(job.id));
      this.active.set(job.id, { controller, promise });
      return job;
    } finally {
      this.starting.delete(startKey);
    }
  }

  cancel(ownerId: string, jobId: string): boolean {
    if (!this.store.job(ownerId, jobId)) return false;
    const active = this.active.get(jobId);
    if (!active) return false;
    active.controller.abort();
    return true;
  }

  async retry(ownerId: string, jobId: string): Promise<IndexJob> {
    const previous = this.store.job(ownerId, jobId);
    if (!previous) throw notFound("Index job not found.");
    if (["queued", "scanning"].includes(previous.status)) throw conflict("Index job is still running.");
    return this.start(ownerId, previous.sourceId, previous.id);
  }

  async search(ownerId: string, request: SearchRequest): Promise<SearchHit[]> {
    const query = String(request.query || "").trim();
    if (!query) throw badRequest("Search query is required.");
    const allowedRoots = this.store.roots(ownerId).filter((root) => root.enabled
      && (!request.sourceIds?.length || request.sourceIds.includes(root.id))
      && (!request.projectId || root.projectId === request.projectId)
      && (request.consumer !== "cloud_model" || root.allowExternalProcessing));
    const allowedSourceIds = new Set(allowedRoots.map((root) => root.id));
    const documents = this.store.documents(ownerId).filter((doc) => allowedSourceIds.has(doc.sourceId) && doc.status === "indexed"
      && (!request.extensions?.length || request.extensions.map(normalizeExtension).includes(doc.extension))
      && (!request.modifiedAfter || doc.modifiedMs >= request.modifiedAfter));
    const documentIds = new Set(documents.map((doc) => doc.id));
    const docById = new Map(documents.map((doc) => [doc.id, doc]));
    const correctionByDocument = new Map<string, string[]>();
    for (const correction of this.store.corrections(ownerId)) {
      if (documentIds.has(correction.documentId)) correctionByDocument.set(correction.documentId, [...(correctionByDocument.get(correction.documentId) || []), correction.note]);
    }
    const chunks = this.store.chunks(ownerId, allowedSourceIds).filter((chunk) => documentIds.has(chunk.documentId));
    const symbols = this.store.symbols(ownerId, documentIds);
    const symbolDocs = new Map<string, number>();
    for (const symbol of symbols) if (matchesQuery(symbol.name, query)) symbolDocs.set(symbol.documentId, (symbolDocs.get(symbol.documentId) || 0) + 1);
    const qTerms = termsFor(query);
    const phrase = query.toLowerCase();
    const mode = request.mode || "hybrid";
    let queryVector: number[] | null = null;
    if (["semantic", "hybrid"].includes(mode) && chunks.some((chunk) => chunk.embedding)) {
      queryVector = await this.embedQuery(query, allowedRoots, request.consumer || "user");
    }
    const now = Date.now();
    const raw = chunks.map((chunk) => {
      const doc = docById.get(chunk.documentId)!;
      const lower = chunk.text.toLowerCase();
      const exact = lower.includes(phrase);
      const overlap = qTerms.filter((term) => chunk.terms.includes(term)).length;
      const keyword = qTerms.length ? overlap / qTerms.length : 0;
      const filename = matchesQuery(doc.fileName, query) ? 1 : 0;
      const symbol = Math.min(1, (symbolDocs.get(doc.id) || 0) / 2);
      const semantic = queryVector && chunk.embedding ? Math.max(0, cosine(queryVector, chunk.embedding)) : 0;
      let score = mode === "exact" ? (exact ? 1 : 0)
        : mode === "keyword" ? keyword * 0.75 + filename * 0.15 + symbol * 0.1
          : mode === "semantic" ? semantic
            : Math.min(1, (exact ? 0.45 : 0) + keyword * 0.3 + semantic * 0.2 + filename * 0.08 + symbol * 0.12);
      if (now - doc.modifiedMs < 30 * 86_400_000) score = Math.min(1, score + 0.02);
      const match: SearchHit["match"] = semantic > 0 && (exact || keyword || filename || symbol) ? "hybrid" : exact ? "exact" : symbol ? "symbol" : filename ? "filename" : semantic > keyword ? "semantic" : "keyword";
      return { chunk, doc, score, match };
    }).filter((item) => item.score >= clamp(request.threshold, 0, 1, mode === "exact" ? 1 : 0.12)).sort((a, b) => b.score - a.score);

    const limit = clamp(request.limit, 1, 50, 10);
    const selected: typeof raw = [];
    const perDoc = new Map<string, number>();
    for (const item of raw) {
      if ((perDoc.get(item.doc.id) || 0) >= 3) continue;
      selected.push(item); perDoc.set(item.doc.id, (perDoc.get(item.doc.id) || 0) + 1);
      if (selected.length >= limit) break;
    }
    const hits: SearchHit[] = [];
    for (const item of selected) {
      let stale = false;
      const root = allowedRoots.find((value) => value.id === item.doc.sourceId)!;
      const absolute = path.join(root.realRootPath, item.doc.relativePath);
      try { const stat = await fs.stat(absolute); stale = stat.mtimeMs !== item.doc.modifiedMs || stat.size !== item.doc.size; } catch { stale = true; }
      if (stale && request.includeStale === false) continue;
      hits.push({
        chunkId: item.chunk.id, documentId: item.doc.id, sourceId: item.doc.sourceId, projectId: item.doc.projectId,
        fileName: item.doc.fileName, relativePath: item.doc.relativePath, score: Number(item.score.toFixed(4)), match: item.match,
        passage: item.chunk.text.slice(0, 3_500), location: item.chunk.location, modifiedMs: item.doc.modifiedMs, stale,
        injectionSuspected: item.chunk.injectionSuspected,
        citation: citation(item.doc.relativePath, item.chunk.location),
        evidenceType: "source_excerpt", freshness: stale ? "stale" : "current", conflictsWith: [],
        uncertainty: [
          ...(stale ? ["The source changed or disappeared after indexing; reindex before relying on it."] : []),
          ...(item.chunk.injectionSuspected ? ["Instruction-like language was detected and is treated only as quoted data."] : []),
          ...(item.score < 0.35 ? ["Low retrieval confidence; inspect the cited source directly."] : []),
          ...(correctionByDocument.get(item.doc.id) || []).map((note) => `User correction note: ${note}`),
        ],
      });
    }
    for (let i = 0; i < hits.length; i += 1) {
      for (let j = i + 1; j < hits.length; j += 1) {
        if (hits[i].documentId !== hits[j].documentId && likelyConflict(hits[i].passage, hits[j].passage, qTerms)) {
          hits[i].conflictsWith.push(hits[j].citation);
          hits[j].conflictsWith.push(hits[i].citation);
        }
      }
      if (hits[i].conflictsWith.length) hits[i].uncertainty.push("Another retrieved source appears to make a conflicting assertion; both citations require review.");
    }
    return hits;
  }

  async refreshProjectMap(ownerId: string, sourceId: string) {
    const root = this.requireRoot(ownerId, sourceId);
    if (root.kind !== "project") throw badRequest("Architecture maps are available for project sources.");
    const docs = this.store.documents(ownerId, sourceId);
    const docIds = new Set(docs.map((doc) => doc.id));
    const map = await buildProjectMap(root, docs, this.store.chunks(ownerId, new Set([sourceId])), this.store.symbols(ownerId, docIds));
    await this.store.putProjectMap(map);
    return map;
  }

  async shutdown(): Promise<void> {
    for (const active of this.active.values()) active.controller.abort();
    for (const timer of this.refreshTimers.values()) clearInterval(timer);
    await Promise.allSettled([...this.active.values()].map((active) => active.promise));
    await this.store.flush();
  }

  private async run(job: IndexJob, root: SourceGrant, signal: AbortSignal): Promise<void> {
    try {
      job.status = "scanning"; job.stage = "Scanning authorized files"; job.updatedAt = new Date().toISOString();
      await this.store.putJob(job);
      const files = await this.walk(root, job, signal);
      job.checkpoint.pendingPaths = files.slice(0, 500);
      job.checkpoint.nextSafeAction = "Extract the next pending file after verifying its current metadata and hash.";
      await this.store.putJob(job);
      const existing = this.store.documents(root.ownerId, root.id);
      const byPath = new Map(existing.map((doc) => [keyPath(doc.relativePath), doc]));
      const seen = new Set<string>();
      for (let index = 0; index < files.length; index += 1) {
        if (signal.aborted) throw abortError();
        const absolute = files[index];
        const relative = path.relative(root.realRootPath, absolute);
        seen.add(keyPath(relative));
        job.stage = `Indexing ${relative}`;
        await this.indexOne(root, absolute, relative, byPath.get(keyPath(relative)), job, signal);
        job.progress = files.length ? Math.round(((index + 1) / files.length) * 96) : 96;
        job.checkpoint.completedPaths.push(relative);
        if (job.checkpoint.completedPaths.length > 500) job.checkpoint.completedPaths.splice(0, job.checkpoint.completedPaths.length - 500);
        job.checkpoint.pendingPaths = files.slice(index + 1, index + 501).map((item) => path.relative(root.realRootPath, item));
        job.updatedAt = new Date().toISOString();
        if (index % 10 === 0 || index === files.length - 1) await this.store.putJob(job);
      }
      for (const doc of existing) {
        if (doc.status !== "deleted" && !seen.has(keyPath(doc.relativePath))) { await this.store.markDeleted(doc.id); job.deleted += 1; }
      }
      root.lastIndexedAt = new Date().toISOString(); root.updatedAt = root.lastIndexedAt;
      await this.store.putRoot(root);
      if (root.kind === "project" && !signal.aborted) {
        job.stage = "Refreshing project architecture map"; job.progress = 97; await this.store.putJob(job);
        await this.refreshProjectMap(root.ownerId, root.id);
      }
      job.status = "completed"; job.stage = "Completed"; job.progress = 100;
      job.checkpoint.pendingPaths = []; job.checkpoint.nextSafeAction = "No action required; run incremental reindex after source changes.";
    } catch (error) {
      if (signal.aborted || (error as { name?: string }).name === "AbortError") {
        job.status = "cancelled"; job.stage = "Cancelled; completed files remain indexed";
        job.checkpoint.nextSafeAction = "Retry with a fresh scan; unchanged completed files will be skipped.";
      } else {
        job.status = "failed"; job.stage = "Indexing failed";
        issue(job, null, "READ_FAILED", error instanceof Error ? error.message : String(error), true);
        job.checkpoint.nextSafeAction = "Inspect the recorded error, then retry with a fresh incremental scan.";
      }
    } finally {
      job.completedAt = new Date().toISOString(); job.updatedAt = job.completedAt;
      await this.store.putJob(job);
    }
  }

  private async walk(root: SourceGrant, job: IndexJob, signal: AbortSignal): Promise<string[]> {
    const files: string[] = [];
    const stack = [root.realRootPath];
    while (stack.length && files.length < root.maxFiles) {
      if (signal.aborted) throw abortError();
      const folder = stack.pop()!;
      let entries: import("node:fs").Dirent[];
      try { entries = await fs.readdir(folder, { withFileTypes: true }); }
      catch (error) { issue(job, path.relative(root.realRootPath, folder), "PERMISSION_DENIED", `Could not list folder: ${message(error)}`, true); continue; }
      for (const entry of entries) {
        if (signal.aborted) throw abortError();
        const absolute = path.join(folder, entry.name);
        const relative = path.relative(root.realRootPath, absolute).replace(/\\/g, "/");
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (!entry.name.startsWith(".") && !ALWAYS_SKIP_DIRS.has(entry.name.toLowerCase()) && !excluded(relative, root.excludePatterns)) stack.push(absolute);
          continue;
        }
        if (!entry.isFile() || excluded(relative, root.excludePatterns)) continue;
        if (SECRET_FILE.test(entry.name)) { issue(job, relative, "SECURITY_BLOCKED", "Potential credential/secret file was excluded by policy.", false); continue; }
        const ext = normalizeExtension(path.extname(entry.name) || (entry.name.toLowerCase() === "dockerfile" ? ".dockerfile" : ""));
        if (!root.includeExtensions.includes(ext)) continue;
        files.push(absolute);
        if (files.length >= root.maxFiles) { issue(job, null, "LIMIT_REACHED", `Stopped discovery at the configured ${root.maxFiles} file limit.`, true); break; }
      }
    }
    files.sort((a, b) => a.localeCompare(b));
    return files;
  }

  private async indexOne(root: SourceGrant, absolute: string, relative: string, previous: IndexedDocument | undefined, job: IndexJob, signal: AbortSignal): Promise<void> {
    job.scanned += 1;
    let stat: import("node:fs").Stats;
    try { stat = await fs.stat(absolute); }
    catch (error) { job.failed += 1; issue(job, relative, "READ_FAILED", message(error), true); return; }
    if (stat.size > root.maxFileBytes) { job.unsupported += 1; issue(job, relative, "UNSUPPORTED", `File exceeds configured ${root.maxFileBytes} byte limit.`, false); await this.recordUnsupported(root, previous, relative, stat, "File exceeds configured size limit."); return; }
    if (previous && previous.modifiedMs === stat.mtimeMs && previous.size === stat.size && previous.status === "indexed") { job.unchanged += 1; return; }
    let buffer: Buffer;
    try { buffer = await fs.readFile(absolute); }
    catch (error) { job.failed += 1; issue(job, relative, "PERMISSION_DENIED", message(error), true); await this.recordFailure(root, previous, relative, stat, message(error)); return; }
    if (signal.aborted) throw abortError();
    const hash = contentHash(buffer);
    if (previous?.contentHash === hash && previous.status === "indexed") {
      previous.modifiedMs = stat.mtimeMs; previous.size = stat.size;
      previous.versions.push({ contentHash: hash, size: stat.size, modifiedMs: stat.mtimeMs, indexedAt: new Date().toISOString(), extractionStatus: "unchanged" });
      previous.versions = previous.versions.slice(-20);
      await this.store.applyDocument(previous, this.store.chunks(root.ownerId, new Set([root.id])).filter((item) => item.documentId === previous.id), this.store.symbols(root.ownerId, new Set([previous.id])));
      job.unchanged += 1; return;
    }
    const duplicate = this.store.documents(root.ownerId).find((doc) => doc.contentHash === hash && doc.status === "indexed" && doc.id !== previous?.id);
    const now = new Date().toISOString();
    const base = previous || newDocument(root, relative);
    const version = { contentHash: hash, size: stat.size, modifiedMs: stat.mtimeMs, indexedAt: now, extractionStatus: duplicate ? "duplicate" as const : "indexed" as const };
    Object.assign(base, { size: stat.size, modifiedMs: stat.mtimeMs, contentHash: hash, duplicateOf: duplicate?.id || null, status: duplicate ? "duplicate" : "indexed", error: null, unsupportedReason: null, extractedAt: now, permissions: { mode: stat.mode ?? null, readable: true, visibility: root.visibility } });
    base.versions = [...base.versions, version].slice(-20);
    if (duplicate) { await this.store.applyDocument(base, [], []); job.duplicates += 1; return; }
    try {
      const extraction = await extractFile(absolute);
      base.mimeType = extraction.mimeType; base.extractionMethod = extraction.method;
      if (extraction.status === "unsupported") {
        base.status = "unsupported"; base.unsupportedReason = extraction.reason; base.versions[base.versions.length - 1].extractionStatus = "unsupported";
        await this.store.applyDocument(base, [], []); job.unsupported += 1; issue(job, relative, "UNSUPPORTED", extraction.reason || "Unsupported format.", false); return;
      }
      const joined = extraction.sections.map((section) => section.text).join("\n");
      base.injectionSuspected = suspiciousInstructions(joined);
      const chunkSections = extraction.sections.flatMap((section) => splitSection(section.text).map((part, partIndex, parts) => ({ section, part, partIndex, partCount: parts.length })));
      if (chunkSections.length > 400) issue(job, relative, "LIMIT_REACHED", "Extracted content exceeded 400 chunks; the derived index retained the first 400 and recorded this limitation.", false);
      const chunks: KnowledgeChunk[] = chunkSections.slice(0, 400).map(({ section, part, partIndex, partCount }) => ({
        id: randomUUID(), documentId: base.id, sourceId: root.id, ownerId: root.ownerId, projectId: root.projectId,
        text: part, location: { label: `${section.label}${partCount > 1 ? `, part ${partIndex + 1}` : ""}`, lineStart: section.lineStart, lineEnd: section.lineEnd },
        tokenEstimate: Math.ceil(part.length / 4), contentHash: contentHash(part), terms: termsFor(part),
        embedding: null, embeddingModelId: null, injectionSuspected: suspiciousInstructions(part),
      }));
      const symbols = extractCodeSymbols(base.id, relative, joined);
      await this.addEmbeddings(root, chunks, job, relative, signal);
      await this.store.applyDocument(base, chunks, symbols);
      for (const warning of extraction.warnings) issue(job, relative, "EXTRACT_FAILED", warning, false);
      job.indexed += 1;
    } catch (error) {
      base.status = "failed"; base.error = message(error); base.extractionMethod = null; base.versions[base.versions.length - 1].extractionStatus = "failed";
      await this.store.applyDocument(base, [], []); job.failed += 1; issue(job, relative, "EXTRACT_FAILED", message(error), true);
    }
  }

  private async addEmbeddings(root: SourceGrant, chunks: KnowledgeChunk[], job: IndexJob, relative: string, signal: AbortSignal): Promise<void> {
    if (!root.semanticIndex || !this.router || !chunks.length) return;
    let model;
    try { model = this.router.candidates("embedding")[0]; }
    catch (error) { issue(job, relative, "EMBEDDING_FAILED", `Semantic index unavailable: ${message(error)}`, true); return; }
    if (model.locality === "cloud" && !root.allowExternalProcessing) {
      issue(job, relative, "EMBEDDING_FAILED", "Cloud embeddings were not used because external processing is not authorized for this source.", false); return;
    }
    try {
      for (let index = 0; index < chunks.length; index += 16) {
        const batch = chunks.slice(index, index + 16);
        const vectors = await this.router.embed(batch.map((chunk) => chunk.text.slice(0, 8_000)), signal);
        batch.forEach((chunk, i) => { chunk.embedding = vectors[i] || null; chunk.embeddingModelId = vectors[i] ? model.id : null; });
      }
    } catch (error) { issue(job, relative, "EMBEDDING_FAILED", `Keyword index completed; embeddings failed: ${message(error)}`, true); }
  }

  private async embedQuery(query: string, roots: SourceGrant[], consumer: NonNullable<SearchRequest["consumer"]>): Promise<number[] | null> {
    if (!this.router) return null;
    try {
      const model = this.router.candidates("embedding")[0];
      if (model.locality === "cloud" && (consumer === "local_model" || roots.some((root) => !root.allowExternalProcessing))) return null;
      return (await this.router.embed([query]))[0] || null;
    } catch { return null; }
  }

  private async recordUnsupported(root: SourceGrant, previous: IndexedDocument | undefined, relative: string, stat: import("node:fs").Stats, reason: string) {
    const doc = previous || newDocument(root, relative); const now = new Date().toISOString();
    Object.assign(doc, { status: "unsupported", size: stat.size, modifiedMs: stat.mtimeMs, unsupportedReason: reason, extractedAt: now });
    doc.versions.push({ contentHash: "", size: stat.size, modifiedMs: stat.mtimeMs, indexedAt: now, extractionStatus: "unsupported" }); doc.versions = doc.versions.slice(-20);
    await this.store.applyDocument(doc, [], []);
  }
  private async recordFailure(root: SourceGrant, previous: IndexedDocument | undefined, relative: string, stat: import("node:fs").Stats, error: string) {
    const doc = previous || newDocument(root, relative); const now = new Date().toISOString();
    Object.assign(doc, { status: "failed", size: stat.size, modifiedMs: stat.mtimeMs, error, extractedAt: now, permissions: { mode: stat.mode ?? null, readable: false, visibility: root.visibility } });
    doc.versions.push({ contentHash: "", size: stat.size, modifiedMs: stat.mtimeMs, indexedAt: now, extractionStatus: "failed" }); doc.versions = doc.versions.slice(-20);
    await this.store.applyDocument(doc, [], []);
  }
  private requireRoot(ownerId: string, sourceId: string): SourceGrant { const root = this.store.root(ownerId, sourceId); if (!root) throw notFound("Knowledge source not found."); return root; }
  private scheduleRefresh(root: SourceGrant): void {
    const prior = this.refreshTimers.get(root.id); if (prior) clearInterval(prior); this.refreshTimers.delete(root.id);
    if (!root.enabled || !root.autoRefreshMinutes) return;
    const timer = setInterval(() => { if (![...this.active.keys()].some((id) => this.store.job(root.ownerId, id)?.sourceId === root.id)) void this.start(root.ownerId, root.id).catch(() => {}); }, root.autoRefreshMinutes * 60_000);
    timer.unref?.(); this.refreshTimers.set(root.id, timer);
  }
}

function splitSection(text: string): string[] {
  if (text.length <= 8_000) return [text];
  const parts: string[] = [];
  for (let offset = 0; offset < text.length; offset += 7_500) parts.push(text.slice(offset, offset + 8_000));
  return parts;
}
function newDocument(root: SourceGrant, relative: string): IndexedDocument {
  return { id: randomUUID(), sourceId: root.id, ownerId: root.ownerId, projectId: root.projectId, relativePath: relative, fileName: path.basename(relative), extension: normalizeExtension(path.extname(relative)), mimeType: "application/octet-stream", size: 0, modifiedMs: 0, contentHash: null, duplicateOf: null, status: "failed", error: null, unsupportedReason: null, extractionMethod: null, extractedAt: null, injectionSuspected: false, permissions: { mode: null, readable: false, visibility: root.visibility }, versions: [] };
}
function issue(job: IndexJob, pathValue: string | null, code: IndexIssue["code"], text: string, retryable: boolean): void { if (job.issues.length < 500 && !job.issues.some((item) => item.path === pathValue && item.code === code && item.message === text)) job.issues.push({ path: pathValue, code, message: text.slice(0, 1_000), retryable }); }
function normalizeExtensions(values: string[]): string[] { return [...new Set(values.map(normalizeExtension).filter(Boolean))].slice(0, 200); }
function normalizeExtension(value: string): string { const clean = String(value || "").trim().toLowerCase(); return clean ? clean.startsWith(".") ? clean : `.${clean}` : ""; }
function excluded(relative: string, patterns: string[]): boolean { return patterns.some((pattern) => glob(pattern).test(relative)); }
function glob(pattern: string): RegExp { const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\0").replace(/\*/g, "[^/]*").replace(/\?/g, ".").replace(/\0/g, ".*"); return new RegExp(`(?:^|/)${escaped}(?:$|/)`, "i"); }
function matchesQuery(value: string, query: string): boolean { const lower = value.toLowerCase(); return lower.includes(query.toLowerCase()) || termsFor(query).some((term) => lower.includes(term)); }
function likelyConflict(a: string, b: string, queryTerms: string[]): boolean {
  const polarity = (value: string) => /\b(?:not|never|no longer|disabled|false|unsupported|deprecated|removed|fails?|broken)\b/i.test(value) ? -1 : /\b(?:enabled|true|supported|active|works?|available|implemented)\b/i.test(value) ? 1 : 0;
  const left = polarity(a), right = polarity(b);
  if (!left || !right || left === right) return false;
  const meaningful = queryTerms.filter((term) => term.length >= 3);
  return meaningful.length > 0 && meaningful.filter((term) => a.toLowerCase().includes(term) && b.toLowerCase().includes(term)).length >= Math.min(2, meaningful.length);
}
function cosine(a: number[], b: number[]): number { const n = Math.min(a.length, b.length); let dot = 0, aa = 0, bb = 0; for (let i = 0; i < n; i += 1) { dot += a[i] * b[i]; aa += a[i] ** 2; bb += b[i] ** 2; } return aa && bb ? dot / Math.sqrt(aa * bb) : 0; }
function citation(relative: string, location: KnowledgeChunk["location"]): string { return location.lineStart ? `${relative}#L${location.lineStart}${location.lineEnd && location.lineEnd !== location.lineStart ? `-L${location.lineEnd}` : ""}` : `${relative} (${location.label})`; }
function clamp(value: unknown, min: number, max: number, fallback: number): number { const number = Number(value); return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.round(number))) : fallback; }
function keyPath(value: string): string { return process.platform === "win32" ? value.toLowerCase() : value; }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function abortError(): Error { return Object.assign(new Error("Indexing cancelled."), { name: "AbortError" }); }
function badRequest(text: string): Error & { status: number } { return Object.assign(new Error(text), { status: 400 }); }
function forbidden(text: string): Error & { status: number } { return Object.assign(new Error(text), { status: 403 }); }
function notFound(text: string): Error & { status: number } { return Object.assign(new Error(text), { status: 404 }); }
function conflict(text: string): Error & { status: number } { return Object.assign(new Error(text), { status: 409 }); }
