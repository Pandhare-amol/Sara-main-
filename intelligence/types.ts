import type { Usage } from "../models/types";

export type CollaborationTask = "research" | "coding" | "planning" | "analysis" | "conversation";

export interface CollaborationRequest {
  prompt: string;
  task?: CollaborationTask;
  modelIds?: string[];
  maxModels?: number;
  highImpact?: boolean;
  maxOutputTokens?: number;
}

export interface ModelConsultation {
  modelId: string;
  providerId: string;
  text: string;
  latencyMs: number;
  usage: Usage;
  estimatedCostUsd: number | null;
}

export interface ModelConsultationFailure {
  modelId: string;
  providerId: string;
  code: string;
  error: string;
}

export interface CollaborationReview {
  reviewerModelId: string;
  reviewerProviderId: string;
  independentProvider: boolean;
  consensus: string[];
  disagreements: Array<{ topic: string; positions: Array<{ modelId: string; position: string }> }>;
  unsupportedClaims: Array<{ modelId: string; claim: string; reason: string }>;
  recommendedAnswer: string;
  limitations: string[];
  latencyMs: number;
  usage: Usage;
  estimatedCostUsd: number | null;
}

export interface CollaborationResult {
  id: string;
  prompt: string;
  task: CollaborationTask;
  highImpact: boolean;
  status: "completed" | "partial" | "failed";
  consultations: ModelConsultation[];
  failures: ModelConsultationFailure[];
  review: CollaborationReview | null;
  verificationStatus: "unverified" | "reviewed";
  totalLatencyMs: number;
  totalUsage: Usage;
  estimatedCostUsd: number | null;
  createdAt: string;
}

export type SourceAuthority = "official" | "primary" | "secondary" | "community" | "unknown";

export interface ResearchSourceInput {
  url: string;
  label?: string;
  authority?: SourceAuthority;
}

export type ResearchStage = "PLAN" | "DISCOVER" | "EXTRACT" | "ANALYZE" | "REPORT";
export type ResearchStatus = "queued" | "running" | "completed" | "partial" | "failed" | "cancelled";

export interface ResearchRequest {
  question: string;
  sources: ResearchSourceInput[];
  /** Must be explicitly true. Sara does not crawl or search unspecified websites. */
  authorized: true;
  modelIds?: string[];
  projectId?: string | null;
}

export interface EvidencePassage {
  id: string;
  sourceId: string;
  excerpt: string;
  locator: string;
  relevance: number;
  injectionSuspected: boolean;
}

export interface ResearchSourceRecord {
  id: string;
  requestedUrl: string;
  finalUrl: string;
  title: string;
  authority: SourceAuthority;
  retrievedAt: string;
  lastModified: string | null;
  contentType: string | null;
  contentHash: string;
  passages: EvidencePassage[];
  injectionSuspected: boolean;
}

export type EvidenceStatus = "supported" | "uncertain" | "conflicting" | "unresolved";

export interface ResearchFinding {
  id: string;
  claim: string;
  sourceIds: string[];
  passageIds: string[];
  status: EvidenceStatus;
  confidence: number;
  rationale: string;
  limitations: string[];
}

export interface ResearchContradiction {
  topic: string;
  sourceIds: string[];
  description: string;
  resolved: false;
}

export interface ResearchModelRun {
  modelId: string;
  providerId: string;
  latencyMs: number;
  usage: Usage;
  estimatedCostUsd: number | null;
}

export interface ResearchSession {
  id: string;
  question: string;
  projectId: string | null;
  request: ResearchRequest;
  status: ResearchStatus;
  stage: ResearchStage;
  progress: number;
  sourceIds: string[];
  findings: ResearchFinding[];
  contradictions: ResearchContradiction[];
  report: string;
  limitations: string[];
  errors: Array<{ sourceUrl?: string; message: string }>;
  modelRuns: ResearchModelRun[];
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  parentSessionId: string | null;
}

export type KnowledgeStatus = "supported" | "uncertain" | "conflicting" | "outdated" | "corrected";

export interface KnowledgeItem {
  id: string;
  projectId: string | null;
  topic: string;
  content: string;
  status: KnowledgeStatus;
  confidence: number;
  sourceIds: string[];
  passageIds: string[];
  researchSessionId: string;
  limitations: string[];
  createdAt: string;
  updatedAt: string;
  lastValidatedAt: string;
  revalidateAfter: string;
  supersedesId: string | null;
  active: boolean;
}
