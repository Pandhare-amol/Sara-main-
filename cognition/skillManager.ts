import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { LearnedSkill, SkillStep, SkillVerificationEvidence, SkillVersion } from "./types";

interface SkillFile {
  version: 2;
  skills: LearnedSkill[];
}

export interface LearnSkillInput {
  name: string;
  description: string;
  preconditions?: string[];
  steps: SkillStep[];
  expectedOutcome: string;
  projectId?: string | null;
  confidence?: number;
  verified: boolean;
  requiredTools?: string[];
  requiredPermissions?: string[];
  dependencies?: string[];
  tests?: string[];
  provenanceUrls?: string[];
  limitations?: string[];
  rollbackInstructions?: string[];
  verificationEvidence?: Array<Partial<SkillVerificationEvidence> & Pick<SkillVerificationEvidence, "kind" | "passed" | "summary">>;
  revalidateAfter?: string | null;
  changeReason?: string;
}

export type ProposeSkillInput = Omit<LearnSkillInput, "verified" | "verificationEvidence"> & {
  verificationEvidence?: LearnSkillInput["verificationEvidence"];
};

export class SkillManager {
  private skills: LearnedSkill[] = [];
  private loaded = false;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async initialize(): Promise<void> {
    if (this.loaded) return;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, "utf-8")) as { skills?: unknown[] };
      this.skills = Array.isArray(parsed.skills) ? parsed.skills.map((item) => migrateSkill(item)).filter((item): item is LearnedSkill => Boolean(item)) : [];
    } catch (error: any) {
      if (error?.code !== "ENOENT") {
        await fs.rename(this.filePath, `${this.filePath}.corrupt-${Date.now()}`).catch(() => {});
      }
      this.skills = [];
    }
    this.loaded = true;
  }

  /** Admit a reusable skill only when test or demonstration evidence passed. */
  async learn(input: LearnSkillInput): Promise<LearnedSkill> {
    this.assertLoaded();
    if (!input.verified) throw new Error("A proposed workflow must be verified before becoming a reusable skill. Use propose() for pending review.");
    const validated = validateInput(input);
    const evidence = sanitizeEvidence(input.verificationEvidence || []);
    assertReusableEvidence(evidence);
    const timestamp = new Date().toISOString();
    const existing = this.skills.find((skill) => skill.name === validated.name && skill.projectId === validated.projectId && skill.status !== "disabled");
    if (existing) {
      applyContent(existing, validated);
      existing.confidence = clamp(Math.max(existing.confidence, input.confidence ?? 0.7));
      existing.status = "verified";
      existing.verified = true;
      existing.verificationEvidence = evidence;
      existing.revalidateAfter = parseFutureDate(input.revalidateAfter) || defaultRevalidation();
      existing.version += 1;
      existing.updatedAt = timestamp;
      existing.versions.push(snapshot(existing, input.changeReason?.trim() || "Verified skill update"));
      await this.persist();
      return structuredClone(existing);
    }

    const skill = createSkill(validated, input, "verified", evidence);
    skill.versions = [snapshot(skill, input.changeReason?.trim() || "Initial verified version")];
    this.skills.push(skill);
    await this.persist();
    return structuredClone(skill);
  }

  /** Store an untrusted/proposed workflow without making it executable or discoverable by find(). */
  async propose(input: ProposeSkillInput): Promise<LearnedSkill> {
    this.assertLoaded();
    const validated = validateInput({ ...input, verified: false });
    const evidence = sanitizeEvidence(input.verificationEvidence || []);
    const skill = createSkill(validated, input, "pending_review", evidence);
    skill.versions = [snapshot(skill, input.changeReason?.trim() || "Initial proposal")];
    this.skills.push(skill);
    await this.persist();
    return structuredClone(skill);
  }

  async verify(id: string, evidenceInput: LearnSkillInput["verificationEvidence"], revalidateAfter?: string | null): Promise<LearnedSkill> {
    this.assertLoaded();
    const skill = this.requireSkill(id);
    if (skill.status === "disabled") throw new Error("A disabled skill must be explicitly re-enabled before verification.");
    const evidence = sanitizeEvidence(evidenceInput || []);
    assertReusableEvidence(evidence);
    skill.status = "verified";
    skill.verified = true;
    skill.verificationEvidence = evidence;
    skill.revalidateAfter = parseFutureDate(revalidateAfter) || defaultRevalidation();
    skill.version += 1;
    skill.updatedAt = new Date().toISOString();
    skill.versions.push(snapshot(skill, "Verification evidence accepted"));
    await this.persist();
    return structuredClone(skill);
  }

  async rollback(id: string, targetVersion: number): Promise<LearnedSkill> {
    this.assertLoaded();
    const skill = this.requireSkill(id);
    const target = skill.versions.find((item) => item.version === targetVersion);
    if (!target) throw new Error(`Unknown skill version: ${targetVersion}`);
    if (target.status !== "verified" || !hasReusableEvidence(target.verificationEvidence)) {
      throw new Error("Only a previously evidenced, verified version can be restored.");
    }
    skill.description = target.description;
    skill.preconditions = [...target.preconditions];
    skill.steps = structuredClone(target.steps);
    skill.expectedOutcome = target.expectedOutcome;
    skill.requiredTools = [...target.requiredTools];
    skill.requiredPermissions = [...target.requiredPermissions];
    skill.dependencies = [...target.dependencies];
    skill.tests = [...target.tests];
    skill.provenanceUrls = [...target.provenanceUrls];
    skill.limitations = [...target.limitations];
    skill.rollbackInstructions = [...target.rollbackInstructions];
    skill.verificationEvidence = structuredClone(target.verificationEvidence);
    skill.status = "verified";
    skill.verified = true;
    skill.version = Math.max(skill.version, ...skill.versions.map((item) => item.version)) + 1;
    skill.updatedAt = new Date().toISOString();
    skill.revalidateAfter = defaultRevalidation();
    skill.versions.push({ ...snapshot(skill, `Rollback to version ${targetVersion}`), rolledBackFromVersion: targetVersion });
    await this.persist();
    return structuredClone(skill);
  }

  async setStatus(id: string, status: "outdated" | "disabled"): Promise<LearnedSkill> {
    this.assertLoaded();
    const skill = this.requireSkill(id);
    skill.status = status;
    skill.verified = false;
    skill.updatedAt = new Date().toISOString();
    await this.persist();
    return structuredClone(skill);
  }

  async delete(id: string): Promise<boolean> {
    this.assertLoaded();
    const before = this.skills.length;
    this.skills = this.skills.filter((item) => item.id !== id);
    if (this.skills.length === before) return false;
    await this.persist();
    return true;
  }

  async recordOutcome(id: string, succeeded: boolean): Promise<LearnedSkill> {
    this.assertLoaded();
    const skill = this.requireSkill(id);
    if (skill.status !== "verified") throw new Error("Only a currently verified skill can record an execution outcome.");
    skill.uses += 1;
    if (succeeded) skill.successes += 1;
    else skill.failures += 1;
    skill.successRate = skill.uses ? skill.successes / skill.uses : 0;
    skill.confidence = clamp(skill.confidence + (succeeded ? 0.035 : -0.09));
    skill.lastUsedAt = new Date().toISOString();
    skill.updatedAt = skill.lastUsedAt;
    if (skill.uses >= 3 && skill.successRate < 0.5) {
      skill.status = "outdated";
      skill.verified = false;
      skill.limitations = unique([...skill.limitations, "Automatically suspended after repeated recorded failures; revalidation is required."]);
    }
    await this.persist();
    return structuredClone(skill);
  }

  find(name: string, projectId?: string | null): LearnedSkill | null {
    this.assertLoaded();
    this.expireStaleSkills();
    const normalized = normalizeName(name);
    const candidates = this.skills.filter(
      (skill) => skill.status === "verified" && skill.name === normalized && (!projectId || !skill.projectId || skill.projectId === projectId),
    );
    candidates.sort((a, b) => b.confidence - a.confidence || b.successRate - a.successRate);
    return candidates[0] ? structuredClone(candidates[0]) : null;
  }

  list(projectId?: string | null): LearnedSkill[] {
    this.assertLoaded();
    this.expireStaleSkills();
    return this.skills
      .filter((skill) => !projectId || !skill.projectId || skill.projectId === projectId)
      .map((skill) => structuredClone(skill));
  }

  private expireStaleSkills(): void {
    const now = Date.now();
    let changed = false;
    for (const skill of this.skills) {
      if (skill.status === "verified" && skill.revalidateAfter && Date.parse(skill.revalidateAfter) <= now) {
        skill.status = "outdated";
        skill.verified = false;
        skill.updatedAt = new Date().toISOString();
        skill.limitations = unique([...skill.limitations, "The revalidation deadline passed; this skill is unavailable until re-tested."]);
        changed = true;
      }
    }
    if (changed) void this.persist();
  }

  private requireSkill(id: string): LearnedSkill {
    const skill = this.skills.find((item) => item.id === id);
    if (!skill) throw new Error(`Unknown skill: ${id}`);
    return skill;
  }

  private async persist(): Promise<void> {
    const payload: SkillFile = { version: 2, skills: structuredClone(this.skills) };
    this.writeQueue = this.writeQueue.catch(() => {}).then(async () => {
      const temp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(temp, JSON.stringify(payload, null, 2), "utf-8");
      await fs.rename(temp, this.filePath);
    });
    await this.writeQueue;
  }

  private assertLoaded(): void {
    if (!this.loaded) throw new Error("SkillManager.initialize() must be called first.");
  }
}

interface ValidatedContent {
  name: string;
  description: string;
  preconditions: string[];
  steps: SkillStep[];
  expectedOutcome: string;
  projectId: string | null;
  requiredTools: string[];
  requiredPermissions: string[];
  dependencies: string[];
  tests: string[];
  provenanceUrls: string[];
  limitations: string[];
  rollbackInstructions: string[];
}

function validateInput(input: LearnSkillInput): ValidatedContent {
  const name = normalizeName(input.name || "");
  if (!name) throw new Error("Skill name is required.");
  if (!input.description?.trim()) throw new Error("Skill description is required.");
  if (!input.expectedOutcome?.trim()) throw new Error("Skill expectedOutcome is required.");
  if (!Array.isArray(input.steps) || !input.steps.length) throw new Error("A skill needs at least one step.");
  if (input.steps.length > 50) throw new Error("A skill cannot contain more than 50 steps.");
  const provenanceUrls = unique(input.provenanceUrls || []).map((value) => {
    let parsed: URL;
    try { parsed = new URL(value); } catch { throw new Error(`Invalid skill provenance URL: ${value}`); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error(`Invalid skill provenance URL: ${value}`);
    return parsed.toString();
  });
  return {
    name,
    description: input.description.trim().slice(0, 8_000),
    preconditions: unique(input.preconditions || []),
    steps: sanitizeSteps(input.steps),
    expectedOutcome: input.expectedOutcome.trim().slice(0, 4_000),
    projectId: input.projectId ?? null,
    requiredTools: unique(input.requiredTools || []),
    requiredPermissions: unique(input.requiredPermissions || []),
    dependencies: unique(input.dependencies || []),
    tests: unique(input.tests || []),
    provenanceUrls,
    limitations: unique(input.limitations || []),
    rollbackInstructions: unique(input.rollbackInstructions || []),
  };
}

function createSkill(
  content: ValidatedContent,
  input: Pick<LearnSkillInput, "confidence" | "revalidateAfter">,
  status: LearnedSkill["status"],
  evidence: SkillVerificationEvidence[],
): LearnedSkill {
  const timestamp = new Date().toISOString();
  return {
    id: randomUUID(),
    ...structuredClone(content),
    confidence: clamp(input.confidence ?? (status === "verified" ? 0.7 : 0.4)),
    uses: 0,
    successes: 0,
    failures: 0,
    successRate: 0,
    verified: status === "verified",
    status,
    version: 1,
    versions: [],
    verificationEvidence: evidence,
    revalidateAfter: status === "verified" ? parseFutureDate(input.revalidateAfter) || defaultRevalidation() : null,
    createdAt: timestamp,
    updatedAt: timestamp,
    lastUsedAt: null,
  };
}

function applyContent(skill: LearnedSkill, content: ValidatedContent): void {
  skill.description = content.description;
  skill.preconditions = content.preconditions;
  skill.steps = content.steps;
  skill.expectedOutcome = content.expectedOutcome;
  skill.requiredTools = content.requiredTools;
  skill.requiredPermissions = content.requiredPermissions;
  skill.dependencies = content.dependencies;
  skill.tests = content.tests;
  skill.provenanceUrls = content.provenanceUrls;
  skill.limitations = content.limitations;
  skill.rollbackInstructions = content.rollbackInstructions;
}

function snapshot(skill: LearnedSkill, changeReason: string): SkillVersion {
  return {
    version: skill.version,
    description: skill.description,
    preconditions: [...skill.preconditions],
    steps: structuredClone(skill.steps),
    expectedOutcome: skill.expectedOutcome,
    requiredTools: [...skill.requiredTools],
    requiredPermissions: [...skill.requiredPermissions],
    dependencies: [...skill.dependencies],
    tests: [...skill.tests],
    provenanceUrls: [...skill.provenanceUrls],
    limitations: [...skill.limitations],
    rollbackInstructions: [...skill.rollbackInstructions],
    verificationEvidence: structuredClone(skill.verificationEvidence),
    status: skill.status,
    createdAt: new Date().toISOString(),
    changeReason: changeReason.slice(0, 1_000),
  };
}

function sanitizeSteps(steps: SkillStep[]): SkillStep[] {
  return steps.map((step, index) => {
    if (!step.action?.trim()) throw new Error(`Skill step ${index + 1} needs an action.`);
    return {
      id: step.id?.trim() || `step-${index + 1}`,
      action: step.action.trim().slice(0, 4_000),
      tool: step.tool?.trim().slice(0, 200) || undefined,
      arguments: step.arguments ? structuredClone(step.arguments) : undefined,
    };
  });
}

function sanitizeEvidence(input: NonNullable<LearnSkillInput["verificationEvidence"]>): SkillVerificationEvidence[] {
  return input.slice(0, 30).map((item) => {
    if (!['automated_test', 'demonstration', 'manual_review', 'legacy_assertion'].includes(item.kind)) throw new Error(`Invalid verification evidence kind: ${item.kind}`);
    if (!item.summary?.trim()) throw new Error("Verification evidence needs a summary.");
    return {
      id: item.id || randomUUID(),
      kind: item.kind,
      passed: item.passed === true,
      summary: item.summary.trim().slice(0, 4_000),
      reference: item.reference?.trim().slice(0, 2_000) || undefined,
      outputHash: item.outputHash?.trim().slice(0, 256) || undefined,
      verifier: item.verifier?.trim().slice(0, 200) || undefined,
      createdAt: item.createdAt && Number.isFinite(Date.parse(item.createdAt)) ? item.createdAt : new Date().toISOString(),
    };
  });
}

function assertReusableEvidence(evidence: SkillVerificationEvidence[]): void {
  if (!hasReusableEvidence(evidence)) {
    throw new Error("Reusable skills require passed automated_test or demonstration evidence; a boolean or manual review alone is insufficient.");
  }
}

function hasReusableEvidence(evidence: SkillVerificationEvidence[]): boolean {
  return evidence.some((item) => item.passed && (item.kind === "automated_test" || item.kind === "demonstration"));
}

function migrateSkill(value: unknown): LearnedSkill | null {
  if (!value || typeof value !== "object") return null;
  const old = value as Partial<LearnedSkill> & Record<string, unknown>;
  if (!old.id || !old.name || !old.description || !Array.isArray(old.steps)) return null;
  const createdAt = typeof old.createdAt === "string" ? old.createdAt : new Date().toISOString();
  const alreadyV2 = typeof old.status === "string" && typeof old.version === "number" && Array.isArray(old.versions);
  if (alreadyV2) return old as LearnedSkill;
  const evidence: SkillVerificationEvidence[] = [{
    id: randomUUID(),
    kind: "legacy_assertion",
    passed: false,
    summary: "Migrated from the v1 boolean verification field; independent evidence was not stored.",
    createdAt,
  }];
  const migrated: LearnedSkill = {
    id: String(old.id),
    name: normalizeName(String(old.name)),
    description: String(old.description),
    preconditions: Array.isArray(old.preconditions) ? old.preconditions.map(String) : [],
    steps: sanitizeSteps(old.steps as SkillStep[]),
    expectedOutcome: String(old.expectedOutcome || ""),
    projectId: typeof old.projectId === "string" ? old.projectId : null,
    confidence: clamp(Number(old.confidence) || 0.5),
    uses: Number(old.uses) || 0,
    successes: Number(old.successes) || 0,
    failures: Number(old.failures) || 0,
    successRate: clamp(Number(old.successRate) || 0),
    verified: false,
    status: "legacy_unreviewed",
    version: 1,
    versions: [],
    requiredTools: [],
    requiredPermissions: [],
    dependencies: [],
    tests: [],
    provenanceUrls: [],
    limitations: ["Legacy skill needs fresh demonstration or automated-test evidence."],
    rollbackInstructions: [],
    verificationEvidence: evidence,
    revalidateAfter: null,
    createdAt,
    updatedAt: typeof old.updatedAt === "string" ? old.updatedAt : createdAt,
    lastUsedAt: typeof old.lastUsedAt === "string" ? old.lastUsedAt : null,
  };
  migrated.versions = [snapshot(migrated, "Migrated from v1; verification pending")];
  return migrated;
}

function parseFutureDate(value?: string | null): string | null {
  if (!value) return null;
  const at = Date.parse(value);
  if (!Number.isFinite(at) || at <= Date.now()) throw new Error("revalidateAfter must be a future ISO date.");
  return new Date(at).toISOString();
}

function defaultRevalidation(): string {
  return new Date(Date.now() + 30 * 86_400_000).toISOString();
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}
