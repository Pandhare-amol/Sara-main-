import type { ReportTemplateId } from "./types";

export interface ReportTemplate {
  id: ReportTemplateId;
  version: string;
  name: string;
  domain: string;
  description: string;
  recommendedSections: string[];
  /** These are quality prompts, not assertions of legal or regulatory compliance. */
  qualityPrompts: string[];
  complianceDisclaimer?: string;
}

const VERSION = "1.0.0";

export const REPORT_TEMPLATES: ReadonlyArray<ReportTemplate> = [
  {
    id: "generic-professional", version: VERSION, name: "Professional report", domain: "General",
    description: "Audience-aware report with an executive summary, evidence, conclusions and actionable next steps.",
    recommendedSections: ["Executive summary", "Scope and methodology", "Findings", "Recommendations", "Limitations"],
    qualityPrompts: ["State purpose and scope", "Separate evidence from interpretation", "Make recommendations attributable and actionable"],
  },
  {
    id: "business-proposal", version: VERSION, name: "Business proposal", domain: "Business operations",
    description: "Decision proposal with context, options, benefits, costs, risks and an implementation approach.",
    recommendedSections: ["Executive summary", "Business need", "Proposed approach", "Options considered", "Costs and benefits", "Risks", "Implementation plan"],
    qualityPrompts: ["Name the decision required", "Identify estimates and assumptions", "Include an owner and timeframe for recommendations"],
  },
  {
    id: "project-status", version: VERSION, name: "Project status", domain: "Project management",
    description: "Status report for progress, milestones, decisions, dependencies, risks and next actions.",
    recommendedSections: ["Executive summary", "Progress", "Milestones", "Risks and issues", "Decisions needed", "Next steps"],
    qualityPrompts: ["Use dated status evidence", "Do not infer completion from activity", "Assign owners only when supplied"],
  },
  {
    id: "technical-design", version: VERSION, name: "Technical design", domain: "Software and engineering",
    description: "Technical design record covering goals, architecture, interfaces, security, operations and verification.",
    recommendedSections: ["Executive summary", "Goals and non-goals", "Current state", "Architecture", "Interfaces and data", "Security and privacy", "Reliability and recovery", "Testing", "Deployment and rollback"],
    qualityPrompts: ["Trace requirements to design choices", "Label unresolved decisions", "State verification and rollback evidence"],
  },
  {
    id: "research-brief", version: VERSION, name: "Research brief", domain: "Research and development",
    description: "Source-grounded brief with research questions, method, findings, uncertainty and implications.",
    recommendedSections: ["Executive summary", "Research questions", "Method", "Evidence", "Analysis", "Limitations", "Conclusions"],
    qualityPrompts: ["Preserve source provenance", "Do not turn correlation into causation", "Describe material uncertainty"],
  },
  {
    id: "sales-performance", version: VERSION, name: "Sales performance", domain: "Sales",
    description: "Performance review for supplied pipeline, conversion, account and forecast data.",
    recommendedSections: ["Executive summary", "Performance overview", "Pipeline", "Drivers and variances", "Forecast assumptions", "Actions"],
    qualityPrompts: ["Identify reporting period and currency", "Show calculation basis", "Label forecasts as estimates"],
  },
  {
    id: "finance-review", version: VERSION, name: "Finance review", domain: "Finance",
    description: "Management review of supplied financial figures, variances, assumptions, risks and decisions.",
    recommendedSections: ["Executive summary", "Financial overview", "Variance analysis", "Cash and commitments", "Assumptions", "Risks", "Recommendations"],
    qualityPrompts: ["State currency, period and units", "Recompute supported calculations", "Avoid audit or compliance claims"],
    complianceDisclaimer: "This template supports documentation quality only. It does not certify accounting, audit, tax or regulatory compliance.",
  },
  {
    id: "hr-people", version: VERSION, name: "People and HR review", domain: "Human resources",
    description: "Privacy-conscious summary of supplied workforce themes, measures, risks and actions.",
    recommendedSections: ["Executive summary", "Scope and data handling", "Workforce observations", "Themes", "Risks", "Actions"],
    qualityPrompts: ["Minimize personal data", "Avoid unsupported sensitive inferences", "Report small cohorts carefully"],
    complianceDisclaimer: "This template is not legal advice and does not certify employment-law, privacy or policy compliance.",
  },
  {
    id: "education-assessment", version: VERSION, name: "Education assessment", domain: "Education",
    description: "Assessment summary covering objectives, evidence, outcomes, limitations and improvement actions.",
    recommendedSections: ["Executive summary", "Objectives", "Assessment method", "Outcomes", "Analysis", "Limitations", "Improvement plan"],
    qualityPrompts: ["Tie outcomes to supplied evidence", "Describe the assessed population", "Avoid unsupported causal claims"],
  },
  {
    id: "manufacturing-operations", version: VERSION, name: "Manufacturing operations", domain: "Manufacturing",
    description: "Operations review for production, quality, downtime, safety observations and improvement actions.",
    recommendedSections: ["Executive summary", "Operating context", "Production performance", "Quality", "Downtime and constraints", "Safety observations", "Corrective actions"],
    qualityPrompts: ["State units and measurement windows", "Separate observed causes from hypotheses", "Do not claim safety certification"],
    complianceDisclaimer: "This template does not certify product, quality, safety or regulatory compliance.",
  },
  {
    id: "support-service", version: VERSION, name: "Support and service review", domain: "Customer support",
    description: "Service review for supplied workload, response, resolution, customer themes and action plans.",
    recommendedSections: ["Executive summary", "Service demand", "Response and resolution", "Customer themes", "Root-cause hypotheses", "Actions"],
    qualityPrompts: ["Define metric windows", "Separate observations from root-cause hypotheses", "Protect customer information"],
  },
  {
    id: "risk-compliance", version: VERSION, name: "Risk and compliance working paper", domain: "Risk and compliance",
    description: "Evidence-indexed working paper for control observations, gaps, risks and remediation tracking.",
    recommendedSections: ["Executive summary", "Scope and criteria", "Evidence reviewed", "Observations", "Risk assessment", "Gaps", "Remediation plan", "Limitations"],
    qualityPrompts: ["Identify criteria and evidence precisely", "Distinguish design from operating effectiveness", "Avoid certification claims"],
    complianceDisclaimer: "This is a documentation template, not a legal opinion, audit report or certification of regulatory compliance.",
  },
] as const;

const TEMPLATE_MAP = new Map(REPORT_TEMPLATES.map((template) => [template.id, template]));

export function getReportTemplate(id: string | undefined): ReportTemplate {
  const template = TEMPLATE_MAP.get((id || "generic-professional") as ReportTemplateId);
  if (!template) throw new Error(`Unknown report template '${id}'.`);
  return template;
}
