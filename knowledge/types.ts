export type SourceKind = "documents" | "project" | "notes" | "task_history" | "storage";
export type SourceVisibility = "private" | "project";
export type IndexJobStatus = "queued" | "scanning" | "completed" | "failed" | "cancelled" | "interrupted";
export type ExtractionStatus = "indexed" | "unchanged" | "unsupported" | "failed" | "duplicate" | "deleted";

/** A folder is never indexed until a local user explicitly creates this grant. */
export interface SourceGrant {
  id: string;
  ownerId: string;
  label: string;
  kind: SourceKind;
  rootPath: string;
  realRootPath: string;
  visibility: SourceVisibility;
  projectId: string | null;
  includeExtensions: string[];
  excludePatterns: string[];
  maxFileBytes: number;
  maxFiles: number;
  autoRefreshMinutes: number | null;
  /** Allows excerpts to be sent to a configured cloud model. Off by default. */
  allowExternalProcessing: boolean;
  /** Build vectors when a compatible local model, or an explicitly authorized cloud model, is available. */
  semanticIndex: boolean;
  retentionDays: number | null;
  enabled: boolean;
  authorizedAt: string;
  updatedAt: string;
  lastIndexedAt: string | null;
}

export interface SourceVersion {
  contentHash: string;
  size: number;
  modifiedMs: number;
  indexedAt: string;
  extractionStatus: ExtractionStatus;
}

export interface IndexedDocument {
  id: string;
  sourceId: string;
  ownerId: string;
  projectId: string | null;
  relativePath: string;
  fileName: string;
  extension: string;
  mimeType: string;
  size: number;
  modifiedMs: number;
  contentHash: string | null;
  duplicateOf: string | null;
  status: ExtractionStatus;
  error: string | null;
  unsupportedReason: string | null;
  extractionMethod: string | null;
  extractedAt: string | null;
  injectionSuspected: boolean;
  permissions: { mode: number | null; readable: boolean; visibility: SourceVisibility };
  versions: SourceVersion[];
}

export interface CodeSymbol {
  id: string;
  documentId: string;
  name: string;
  kind: "function" | "class" | "interface" | "type" | "constant" | "route" | "heading";
  exported: boolean;
  line: number;
  signature: string;
}

export interface KnowledgeChunk {
  id: string;
  documentId: string;
  sourceId: string;
  ownerId: string;
  projectId: string | null;
  text: string;
  location: { label: string; lineStart: number | null; lineEnd: number | null };
  tokenEstimate: number;
  contentHash: string;
  terms: string[];
  embedding: number[] | null;
  embeddingModelId: string | null;
  injectionSuspected: boolean;
}

export interface IndexIssue {
  path: string | null;
  code: "UNSUPPORTED" | "READ_FAILED" | "EXTRACT_FAILED" | "PERMISSION_DENIED" | "LIMIT_REACHED" | "EMBEDDING_FAILED" | "STALE_SOURCE" | "SECURITY_BLOCKED";
  message: string;
  retryable: boolean;
}

export interface IndexJob {
  id: string;
  sourceId: string;
  ownerId: string;
  status: IndexJobStatus;
  progress: number;
  stage: string;
  scanned: number;
  indexed: number;
  unchanged: number;
  unsupported: number;
  failed: number;
  duplicates: number;
  deleted: number;
  issues: IndexIssue[];
  retryOf: string | null;
  checkpoint: { pendingPaths: string[]; completedPaths: string[]; nextSafeAction: string };
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface ProjectEvidenceRef {
  documentId: string;
  relativePath: string;
  line: number | null;
}

export interface ProjectMap {
  id: string;
  sourceId: string;
  ownerId: string;
  projectId: string;
  name: string;
  entryPoints: Array<{ value: string; evidence: ProjectEvidenceRef }>;
  modules: Array<{ name: string; path: string; fileCount: number }>;
  dependencies: Array<{ name: string; version: string | null; kind: "runtime" | "development" | "python" | "other"; evidence: ProjectEvidenceRef }>;
  apis: Array<{ method: string | null; route: string; handler: string | null; evidence: ProjectEvidenceRef }>;
  dataModels: Array<{ name: string; kind: string; evidence: ProjectEvidenceRef }>;
  tests: Array<{ path: string; framework: string | null }>;
  buildCommands: Array<{ name: string; command: string; evidence: ProjectEvidenceRef }>;
  relationships: Array<{ from: string; to: string; kind: "import" | "reference" }>;
  recentChanges: Array<{ commit: string; at: string; summary: string }>;
  unresolvedIssues: Array<{ text: string; evidence: ProjectEvidenceRef }>;
  sourceFingerprint: string;
  refreshedAt: string;
  limitations: string[];
}

export interface SearchHit {
  chunkId: string;
  documentId: string;
  sourceId: string;
  projectId: string | null;
  fileName: string;
  relativePath: string;
  score: number;
  match: "exact" | "keyword" | "symbol" | "filename" | "semantic" | "hybrid";
  passage: string;
  location: KnowledgeChunk["location"];
  modifiedMs: number;
  stale: boolean;
  injectionSuspected: boolean;
  citation: string;
  evidenceType: "source_excerpt";
  freshness: "current" | "stale";
  conflictsWith: string[];
  uncertainty: string[];
}

export interface SearchRequest {
  query: string;
  sourceIds?: string[];
  projectId?: string;
  extensions?: string[];
  modifiedAfter?: number;
  mode?: "exact" | "keyword" | "semantic" | "hybrid";
  limit?: number;
  threshold?: number;
  includeStale?: boolean;
  consumer?: "user" | "local_model" | "cloud_model";
}

export interface KnowledgeCatalog {
  version: 1;
  roots: SourceGrant[];
  documents: IndexedDocument[];
  symbols: CodeSymbol[];
  jobs: IndexJob[];
  projectMaps: ProjectMap[];
  corrections: Array<{ id: string; ownerId: string; documentId: string; note: string; createdAt: string }>;
}

export interface KnowledgeChunkFile {
  version: 1;
  chunks: KnowledgeChunk[];
}
