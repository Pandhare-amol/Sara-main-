export type ReportTemplateId =
  | "generic-professional"
  | "business-proposal"
  | "project-status"
  | "technical-design"
  | "research-brief"
  | "sales-performance"
  | "finance-review"
  | "hr-people"
  | "education-assessment"
  | "manufacturing-operations"
  | "support-service"
  | "risk-compliance";

export type ReportContentKind =
  | "fact"
  | "analysis"
  | "estimate"
  | "assumption"
  | "recommendation"
  | "conclusion";

export interface ReportSource {
  /** Stable report-local identifier, such as S1 or policy-2026. */
  id: string;
  title: string;
  kind: "file" | "web" | "dataset" | "interview" | "user-provided" | "system-record" | "other";
  location?: string;
  author?: string;
  publisher?: string;
  publishedAt?: string;
  accessedAt?: string;
  /** A short note about relevance or limitations; never an invented quotation. */
  note?: string;
}

export interface ReportParagraph {
  text: string;
  kind: ReportContentKind;
  /** IDs from ReportRequest.sources supporting this paragraph. */
  evidenceIds?: string[];
}

export interface ReportBullet extends ReportParagraph {
  level?: 0 | 1 | 2;
}

export interface ReportTable {
  title: string;
  headers: string[];
  rows: string[][];
  note?: string;
  evidenceIds?: string[];
}

export interface ReportSection {
  id: string;
  heading: string;
  level?: 1 | 2 | 3;
  paragraphs?: ReportParagraph[];
  bullets?: ReportBullet[];
  tables?: ReportTable[];
}

export type ReportCalculationOperation = "sum" | "average" | "difference" | "ratio" | "percentage_change";

export interface ReportCalculation {
  id: string;
  label: string;
  operation: ReportCalculationOperation;
  inputs: Array<{ name: string; value: number; unit?: string }>;
  /** Expected result supplied by the caller. Generation fails if deterministic recomputation differs. */
  result: number;
  unit?: string;
  note?: string;
  evidenceIds?: string[];
}

export interface WordReportRequest {
  path: string;
  title: string;
  purpose: string;
  audience: string;
  templateId?: ReportTemplateId;
  scope?: string;
  reportingPeriod?: string;
  documentDate?: string;
  author?: string;
  version?: string;
  language?: string;
  confidentiality?: "public" | "internal" | "confidential" | "restricted";
  sections: ReportSection[];
  sources?: ReportSource[];
  assumptions?: string[];
  limitations?: string[];
  calculations?: ReportCalculation[];
  /** Optional headings that must be present before delivery. */
  requiredSections?: string[];
}

export type QaStatus = "passed" | "failed";

export interface ReportQaCheck {
  id: string;
  status: QaStatus;
  detail: string;
}

export interface ReportQaResult {
  passed: boolean;
  checks: ReportQaCheck[];
  warnings: string[];
  extractedCharacters: number;
  headings: number;
  tables: number;
  sourcesCited: number;
}

export interface GeneratedWordReport {
  id: string;
  path: string;
  title: string;
  templateId: ReportTemplateId;
  templateVersion: string;
  createdAt: string;
  size: number;
  sha256: string;
  verified: true;
  verification: "openxml_structure_content_and_provenance";
  qa: ReportQaResult;
}

export interface ReportManifestRecord extends GeneratedWordReport {
  principalId: string;
  sourceIds: string[];
  sectionIds: string[];
  assumptions: number;
  limitations: number;
  calculations: number;
}

export interface ReportValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  normalized?: WordReportRequest;
}
