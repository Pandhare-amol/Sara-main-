import path from "node:path";
import { randomUUID } from "node:crypto";
import { readJsonFile, writeJsonFile } from "../shared/jsonFile";
import type { IndexedDocument, IndexJob, KnowledgeCatalog, KnowledgeChunk, KnowledgeChunkFile, ProjectMap, SourceGrant, CodeSymbol } from "./types";

const EMPTY_CATALOG: KnowledgeCatalog = { version: 1, roots: [], documents: [], symbols: [], jobs: [], projectMaps: [], corrections: [] };
const EMPTY_CHUNKS: KnowledgeChunkFile = { version: 1, chunks: [] };

/** Atomic JSON persistence with raw local source files kept outside the derived index. */
export class KnowledgeStore {
  private catalog: KnowledgeCatalog = structuredClone(EMPTY_CATALOG);
  private chunkFile: KnowledgeChunkFile = structuredClone(EMPTY_CHUNKS);
  private readonly catalogPath: string;
  private readonly chunksPath: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.catalogPath = path.join(dataDir, "knowledge", "catalog.v1.json");
    this.chunksPath = path.join(dataDir, "knowledge", "derived-index.v1.json");
  }

  async initialize(): Promise<void> {
    this.catalog = normalizeCatalog(await readJsonFile<KnowledgeCatalog>(this.catalogPath, structuredClone(EMPTY_CATALOG)));
    this.chunkFile = normalizeChunks(await readJsonFile<KnowledgeChunkFile>(this.chunksPath, structuredClone(EMPTY_CHUNKS)));
    const now = new Date().toISOString();
    let changed = false;
    for (const job of this.catalog.jobs) {
      if (["queued", "scanning"].includes(job.status)) {
        job.status = "interrupted";
        job.stage = "Interrupted by an application restart; review and retry from a fresh scan.";
        job.updatedAt = now;
        job.completedAt = now;
        job.checkpoint.nextSafeAction = "Run a fresh incremental reindex. Completed files will be hash-checked, not blindly replayed.";
        changed = true;
      }
    }
    if (changed) await this.save();
  }

  roots(ownerId: string): SourceGrant[] { return this.catalog.roots.filter((item) => item.ownerId === ownerId).map(clone); }
  root(ownerId: string, id: string): SourceGrant | undefined { const value = this.catalog.roots.find((item) => item.ownerId === ownerId && item.id === id); return value ? clone(value) : undefined; }
  documents(ownerId: string, sourceId?: string): IndexedDocument[] { return this.catalog.documents.filter((item) => item.ownerId === ownerId && (!sourceId || item.sourceId === sourceId)).map(clone); }
  chunks(ownerId: string, sourceIds?: Set<string>): KnowledgeChunk[] { return this.chunkFile.chunks.filter((item) => item.ownerId === ownerId && (!sourceIds || sourceIds.has(item.sourceId))).map(clone); }
  symbols(ownerId: string, documentIds?: Set<string>): CodeSymbol[] { return this.catalog.symbols.filter((item) => !documentIds || documentIds.has(item.documentId)).map(clone); }
  jobs(ownerId: string, sourceId?: string): IndexJob[] { return this.catalog.jobs.filter((item) => item.ownerId === ownerId && (!sourceId || item.sourceId === sourceId)).sort((a, b) => b.startedAt.localeCompare(a.startedAt)).map(clone); }
  job(ownerId: string, id: string): IndexJob | undefined { const value = this.catalog.jobs.find((item) => item.ownerId === ownerId && item.id === id); return value ? clone(value) : undefined; }
  projectMaps(ownerId: string): ProjectMap[] { return this.catalog.projectMaps.filter((item) => item.ownerId === ownerId).map(clone); }
  corrections(ownerId: string, documentId?: string) { return this.catalog.corrections.filter((item) => item.ownerId === ownerId && (!documentId || item.documentId === documentId)).map(clone); }
  projectMap(ownerId: string, sourceId: string): ProjectMap | undefined { const value = this.catalog.projectMaps.find((item) => item.ownerId === ownerId && item.sourceId === sourceId); return value ? clone(value) : undefined; }

  async putRoot(root: SourceGrant): Promise<void> {
    const index = this.catalog.roots.findIndex((item) => item.id === root.id);
    if (index >= 0) this.catalog.roots[index] = clone(root); else this.catalog.roots.push(clone(root));
    await this.save();
  }

  async putJob(job: IndexJob): Promise<void> {
    const index = this.catalog.jobs.findIndex((item) => item.id === job.id);
    if (index >= 0) this.catalog.jobs[index] = clone(job); else this.catalog.jobs.push(clone(job));
    this.catalog.jobs = this.catalog.jobs.sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 200);
    await this.saveCatalog();
  }

  async applyDocument(document: IndexedDocument, chunks: KnowledgeChunk[], symbols: CodeSymbol[]): Promise<void> {
    const index = this.catalog.documents.findIndex((item) => item.id === document.id);
    if (index >= 0) this.catalog.documents[index] = clone(document); else this.catalog.documents.push(clone(document));
    this.catalog.symbols = this.catalog.symbols.filter((item) => item.documentId !== document.id).concat(clone(symbols));
    this.chunkFile.chunks = this.chunkFile.chunks.filter((item) => item.documentId !== document.id).concat(clone(chunks));
    await this.save();
  }

  async markDeleted(documentId: string): Promise<void> {
    const doc = this.catalog.documents.find((item) => item.id === documentId);
    if (doc) { doc.status = "deleted"; doc.extractedAt = new Date().toISOString(); }
    this.catalog.symbols = this.catalog.symbols.filter((item) => item.documentId !== documentId);
    this.chunkFile.chunks = this.chunkFile.chunks.filter((item) => item.documentId !== documentId);
    await this.save();
  }

  async removeRoot(ownerId: string, sourceId: string): Promise<boolean> {
    const root = this.catalog.roots.find((item) => item.ownerId === ownerId && item.id === sourceId);
    if (!root) return false;
    const documentIds = new Set(this.catalog.documents.filter((item) => item.sourceId === sourceId).map((item) => item.id));
    this.catalog.roots = this.catalog.roots.filter((item) => item.id !== sourceId);
    this.catalog.documents = this.catalog.documents.filter((item) => item.sourceId !== sourceId);
    this.catalog.symbols = this.catalog.symbols.filter((item) => !documentIds.has(item.documentId));
    this.catalog.jobs = this.catalog.jobs.filter((item) => item.sourceId !== sourceId);
    this.catalog.projectMaps = this.catalog.projectMaps.filter((item) => item.sourceId !== sourceId);
    this.catalog.corrections = this.catalog.corrections.filter((item) => !documentIds.has(item.documentId));
    this.chunkFile.chunks = this.chunkFile.chunks.filter((item) => item.sourceId !== sourceId);
    await this.save();
    return true;
  }

  async putProjectMap(map: ProjectMap): Promise<void> {
    this.catalog.projectMaps = this.catalog.projectMaps.filter((item) => item.sourceId !== map.sourceId);
    this.catalog.projectMaps.push(clone(map));
    await this.saveCatalog();
  }

  async correct(ownerId: string, documentId: string, note: string): Promise<void> {
    const doc = this.catalog.documents.find((item) => item.ownerId === ownerId && item.id === documentId);
    if (!doc) throw notFound("Indexed document not found.");
    this.catalog.corrections.push({ id: randomUUID(), ownerId, documentId, note: note.trim().slice(0, 2_000), createdAt: new Date().toISOString() });
    await this.saveCatalog();
  }

  export(ownerId: string): { catalog: KnowledgeCatalog; chunks: KnowledgeChunkFile } {
    const documents = this.catalog.documents.filter((item) => item.ownerId === ownerId);
    const docIds = new Set(documents.map((item) => item.id));
    return {
      catalog: {
        version: 1,
        roots: this.catalog.roots.filter((item) => item.ownerId === ownerId), documents,
        symbols: this.catalog.symbols.filter((item) => docIds.has(item.documentId)),
        jobs: this.catalog.jobs.filter((item) => item.ownerId === ownerId),
        projectMaps: this.catalog.projectMaps.filter((item) => item.ownerId === ownerId),
        corrections: this.catalog.corrections.filter((item) => item.ownerId === ownerId),
      },
      chunks: { version: 1, chunks: this.chunkFile.chunks.filter((item) => item.ownerId === ownerId) },
    };
  }

  async enforceRetention(ownerId: string, now = Date.now()): Promise<number> {
    const roots = new Map(this.catalog.roots.filter((item) => item.ownerId === ownerId).map((item) => [item.id, item]));
    const expired = this.catalog.documents.filter((doc) => {
      const days = roots.get(doc.sourceId)?.retentionDays;
      return days !== null && days !== undefined && now - (doc.extractedAt ? Date.parse(doc.extractedAt) : doc.modifiedMs) > days * 86_400_000;
    });
    for (const doc of expired) await this.markDeleted(doc.id);
    return expired.length;
  }

  async flush(): Promise<void> { await this.writeQueue; }
  private save(): Promise<void> { return this.enqueue(async () => { await writeJsonFile(this.catalogPath, this.catalog); await writeJsonFile(this.chunksPath, this.chunkFile); }); }
  private saveCatalog(): Promise<void> { return this.enqueue(() => writeJsonFile(this.catalogPath, this.catalog)); }
  private enqueue(task: () => Promise<void>): Promise<void> { this.writeQueue = this.writeQueue.then(task, task); return this.writeQueue; }
}

function clone<T>(value: T): T { return structuredClone(value); }
function normalizeCatalog(value: KnowledgeCatalog): KnowledgeCatalog {
  return { ...structuredClone(EMPTY_CATALOG), ...(value?.version === 1 ? value : {}), roots: value?.roots || [], documents: value?.documents || [], symbols: value?.symbols || [], jobs: value?.jobs || [], projectMaps: value?.projectMaps || [], corrections: value?.corrections || [] };
}
function normalizeChunks(value: KnowledgeChunkFile): KnowledgeChunkFile { return value?.version === 1 && Array.isArray(value.chunks) ? value : structuredClone(EMPTY_CHUNKS); }
function notFound(message: string): Error & { status: number } { return Object.assign(new Error(message), { status: 404 }); }
