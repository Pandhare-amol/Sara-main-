import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { appEvents } from "../shared/appEvents";
import { readJsonFile, writeJsonFile } from "../shared/jsonFile";
import { REPORT_TEMPLATES, getReportTemplate } from "./templates";
import type { GeneratedWordReport, ReportManifestRecord, ReportValidationResult, WordReportRequest } from "./types";
import { validateAndNormalizeReport } from "./validation";
import { renderWordReport } from "./wordRenderer";
import { inspectGeneratedWord } from "./wordQa";

interface ManifestStore {
  version: 1;
  records: ReportManifestRecord[];
}

export interface ReportServiceOptions {
  dataDir: string;
  /** Test/deployment override. Production defaults to the user home and data directory. */
  allowedOutputRoots?: string[];
  principalId?: string;
  now?: () => Date;
}

export interface CreateReportOptions {
  signal?: AbortSignal;
}

export class ReportQaError extends Error {
  constructor(message: string, readonly details: unknown) {
    super(message);
    this.name = "ReportQaError";
  }
}

export class ReportService {
  private readonly manifestFile: string;
  private readonly allowedRoots: string[];
  private readonly principalId: string;
  private readonly now: () => Date;
  private readonly activePaths = new Set<string>();
  private records: ReportManifestRecord[] = [];
  private initialized = false;

  constructor(options: ReportServiceOptions) {
    this.manifestFile = path.join(options.dataDir, "reports", "manifests.v1.json");
    this.allowedRoots = unique(options.allowedOutputRoots || [os.homedir(), options.dataDir]).map((root) => path.resolve(root));
    this.principalId = options.principalId || "local-user";
    this.now = options.now || (() => new Date());
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    const stored = await readJsonFile<ManifestStore>(this.manifestFile, { version: 1, records: [] });
    this.records = stored.version === 1 && Array.isArray(stored.records) ? stored.records.slice(-5_000) : [];
    this.initialized = true;
  }

  templates() {
    return REPORT_TEMPLATES.map((template) => ({ ...template, recommendedSections: [...template.recommendedSections], qualityPrompts: [...template.qualityPrompts] }));
  }

  validate(input: unknown): ReportValidationResult {
    return validateAndNormalizeReport(input, this.now());
  }

  list(limit = 100): ReportManifestRecord[] {
    this.assertInitialized();
    const bounded = Math.max(1, Math.min(500, Math.floor(limit) || 100));
    return this.records.filter((record) => record.principalId === this.principalId).slice(-bounded).reverse().map((record) => structuredClone(record));
  }

  async createWord(input: unknown, options: CreateReportOptions = {}): Promise<GeneratedWordReport> {
    this.assertInitialized();
    throwIfAborted(options.signal);
    const validation = this.validate(input);
    if (!validation.valid || !validation.normalized) {
      throw new Error(`Report request is invalid: ${validation.errors.join(" ")}`);
    }
    const request = validation.normalized;
    const destination = await this.authorizeOutputPath(request.path);
    const pathKey = process.platform === "win32" ? destination.toLowerCase() : destination;
    if (this.activePaths.has(pathKey)) throw new Error("A report is already being generated at this path.");
    this.activePaths.add(pathKey);
    const temporary = path.join(path.dirname(destination), `.${path.basename(destination, ".docx")}.${randomUUID()}.tmp.docx`);
    try {
      throwIfAborted(options.signal);
      const buffer = await renderWordReport(request);
      throwIfAborted(options.signal);
      await fs.writeFile(temporary, buffer, { flag: "wx", mode: 0o600 });
      const inspected = await inspectGeneratedWord(temporary, request);
      if (!inspected.qa.passed) {
        throw new ReportQaError("Generated Word report failed deterministic QA and was not delivered.", inspected.qa);
      }
      throwIfAborted(options.signal);
      // A hard link is atomic and fails if the destination appeared during generation.
      // The temp file is in the same directory, so this cannot cross filesystems.
      await fs.link(temporary, destination);
      await fs.unlink(temporary);

      const template = getReportTemplate(request.templateId);
      const createdAt = this.now().toISOString();
      const generated: GeneratedWordReport = {
        id: randomUUID(),
        path: destination,
        title: request.title,
        templateId: template.id,
        templateVersion: template.version,
        createdAt,
        size: inspected.size,
        sha256: inspected.sha256,
        verified: true,
        verification: "openxml_structure_content_and_provenance",
        qa: { ...inspected.qa, warnings: unique([...validation.warnings, ...inspected.qa.warnings]) },
      };
      const record: ReportManifestRecord = {
        ...generated,
        principalId: this.principalId,
        sourceIds: (request.sources || []).map((source) => source.id),
        sectionIds: request.sections.map((section) => section.id),
        assumptions: request.assumptions?.length || 0,
        limitations: request.limitations?.length || 0,
        calculations: request.calculations?.length || 0,
      };
      this.records.push(record);
      this.records = this.records.slice(-5_000);
      try {
        await writeJsonFile(this.manifestFile, { version: 1, records: this.records } satisfies ManifestStore);
      } catch (error) {
        this.records.pop();
        await fs.unlink(destination).catch(() => {});
        throw new Error(`Report was rolled back because its provenance manifest could not be saved: ${error instanceof Error ? error.message : String(error)}`);
      }
      appEvents.publish("report.updated", generated);
      return generated;
    } finally {
      this.activePaths.delete(pathKey);
      await fs.unlink(temporary).catch(() => {});
    }
  }

  private async authorizeOutputPath(requested: string): Promise<string> {
    if (requested.includes("\0")) throw new Error("Report path contains a NUL byte.");
    if (/^(?:\\\\|\/\/)/.test(requested)) throw new Error("Network/UNC report destinations are not allowed.");
    if (!path.isAbsolute(requested)) throw new Error("Report path must be absolute.");
    const destination = path.resolve(requested);
    if (path.extname(destination).toLowerCase() !== ".docx") throw new Error("Report path must end in .docx.");
    if (!this.allowedRoots.some((root) => within(root, destination))) {
      throw new Error(`Report destination is outside the allowed local roots: ${this.allowedRoots.join(", ")}.`);
    }
    try {
      await fs.lstat(destination);
      throw new Error("Report destination already exists; originals are never overwritten.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = path.dirname(destination);
    await fs.mkdir(parent, { recursive: true });
    const realParent = await fs.realpath(parent);
    const realRoots = await Promise.all(this.allowedRoots.map(async (root) => fs.realpath(root).catch(() => path.resolve(root))));
    if (!realRoots.some((root) => within(root, realParent))) throw new Error("Report destination resolves outside the allowed local roots through a symbolic link.");
    return path.join(realParent, path.basename(destination));
  }

  private assertInitialized(): void {
    if (!this.initialized) throw new Error("ReportService.initialize() must be called first.");
  }
}

function within(root: string, candidate: string): boolean {
  const normalize = (value: string) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  const normalizedRoot = normalize(root).replace(/[\\/]+$/, "");
  const normalizedCandidate = normalize(candidate);
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Report generation was cancelled.");
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
