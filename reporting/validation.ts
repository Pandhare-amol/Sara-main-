import path from "node:path";
import { getReportTemplate } from "./templates";
import type {
  ReportCalculation,
  ReportSection,
  ReportSource,
  ReportValidationResult,
  WordReportRequest,
} from "./types";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const PLACEHOLDER = /\b(?:TODO|TBD|TBC|FIXME|lorem ipsum|insert (?:text|content|citation|data) here|to be determined)\b/i;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const MAX_TOTAL_TEXT = 500_000;

export function validateAndNormalizeReport(input: unknown, now = new Date()): ReportValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { valid: false, errors: ["Report request must be an object."], warnings };
  }
  const raw = input as Record<string, unknown>;
  const text = (value: unknown, name: string, max: number, required = false): string => {
    if (value === undefined || value === null) {
      if (required) errors.push(`${name} is required.`);
      return "";
    }
    if (typeof value !== "string") {
      errors.push(`${name} must be text.`);
      return "";
    }
    const clean = value.replace(CONTROL, "").replace(/\r\n?/g, "\n").trim();
    if (required && !clean) errors.push(`${name} is required.`);
    if (clean.length > max) errors.push(`${name} exceeds ${max} characters.`);
    return clean.slice(0, max);
  };

  const outputPath = text(raw.path, "path", 1_000, true);
  const title = text(raw.title, "title", 500, true);
  const purpose = text(raw.purpose, "purpose", 2_000, true);
  const audience = text(raw.audience, "audience", 500, true);
  const templateId = text(raw.templateId, "templateId", 80) || "generic-professional";
  let template;
  try {
    template = getReportTemplate(templateId);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    template = getReportTemplate(undefined);
  }

  if (outputPath && path.extname(outputPath).toLowerCase() !== ".docx") errors.push("path must end in .docx.");
  for (const [name, value] of [["title", title], ["purpose", purpose], ["audience", audience]] as const) {
    if (PLACEHOLDER.test(value)) errors.push(`${name} contains placeholder text.`);
  }

  const sources = normalizeSources(raw.sources, text, errors);
  const sourceIds = new Set(sources.map((source) => source.id));
  if (sourceIds.size !== sources.length) errors.push("Source IDs must be unique.");

  const sections = normalizeSections(raw.sections, text, errors, sourceIds);
  if (!sections.length) errors.push("At least one substantive report section is required.");
  if (new Set(sections.map((section) => section.id)).size !== sections.length) errors.push("Section IDs must be unique.");

  const assumptions = normalizeStringList(raw.assumptions, "assumptions", 100, 2_000, text, errors);
  const limitations = normalizeStringList(raw.limitations, "limitations", 100, 2_000, text, errors);
  const requiredSections = normalizeStringList(raw.requiredSections, "requiredSections", 30, 200, text, errors);
  const calculations = normalizeCalculations(raw.calculations, text, errors, sourceIds);

  const headings = new Set(sections.map((section) => normalizeHeading(section.heading)));
  if (calculations.length) headings.add(normalizeHeading("Calculation register"));
  if (assumptions.length) headings.add(normalizeHeading("Assumptions"));
  if (limitations.length) headings.add(normalizeHeading("Limitations"));
  if (sources.length) headings.add(normalizeHeading("References"));
  for (const required of requiredSections) {
    if (!headings.has(normalizeHeading(required))) errors.push(`Required section '${required}' is missing.`);
  }
  for (const recommended of template.recommendedSections) {
    if (!headings.has(normalizeHeading(recommended))) warnings.push(`Template recommendation not supplied: ${recommended}.`);
  }
  if (!sources.length) warnings.push("No external or internal sources were supplied; factual statements are user-provided and cannot be independently verified.");
  if (!limitations.length) warnings.push("No limitations were supplied.");

  const total = [title, purpose, audience, ...assumptions, ...limitations]
    .reduce((sum, value) => sum + value.length, 0) + sectionTextLength(sections);
  if (total > MAX_TOTAL_TEXT) errors.push(`Report content exceeds the ${MAX_TOTAL_TEXT.toLocaleString("en-US")} character safety limit.`);

  const confidentiality = oneOf(raw.confidentiality, ["public", "internal", "confidential", "restricted"] as const, "internal", "confidentiality", errors);
  const normalized: WordReportRequest = {
    path: outputPath,
    title,
    purpose,
    audience,
    templateId: template.id,
    scope: text(raw.scope, "scope", 2_000) || undefined,
    reportingPeriod: text(raw.reportingPeriod, "reportingPeriod", 200) || undefined,
    documentDate: normalizeDate(raw.documentDate, now, errors),
    author: text(raw.author, "author", 200) || "SARA",
    version: text(raw.version, "version", 40) || "1.0",
    language: text(raw.language, "language", 35) || "en-IN",
    confidentiality,
    sections,
    sources,
    assumptions,
    limitations,
    calculations,
    requiredSections,
  };
  return { valid: errors.length === 0, errors, warnings: unique(warnings), normalized: errors.length ? undefined : normalized };
}

function normalizeSources(
  value: unknown,
  text: (value: unknown, name: string, max: number, required?: boolean) => string,
  errors: string[],
): ReportSource[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) { errors.push("sources must be an array."); return []; }
  if (value.length > 200) errors.push("sources cannot contain more than 200 items.");
  return value.slice(0, 200).map((item, index) => {
    const raw = record(item, `sources[${index}]`, errors);
    const id = text(raw.id, `sources[${index}].id`, 80, true);
    if (id && !ID.test(id)) errors.push(`sources[${index}].id has invalid characters.`);
    const kind = oneOf(raw.kind, ["file", "web", "dataset", "interview", "user-provided", "system-record", "other"] as const, "other", `sources[${index}].kind`, errors);
    const location = text(raw.location, `sources[${index}].location`, 2_000) || undefined;
    if (kind === "web" && location) {
      try {
        const url = new URL(location);
        if (url.protocol !== "https:" && url.protocol !== "http:") errors.push(`sources[${index}].location must be an HTTP(S) URL for a web source.`);
      } catch {
        errors.push(`sources[${index}].location is not a valid URL.`);
      }
    }
    return {
      id,
      title: text(raw.title, `sources[${index}].title`, 500, true),
      kind,
      location,
      author: text(raw.author, `sources[${index}].author`, 300) || undefined,
      publisher: text(raw.publisher, `sources[${index}].publisher`, 300) || undefined,
      publishedAt: text(raw.publishedAt, `sources[${index}].publishedAt`, 80) || undefined,
      accessedAt: text(raw.accessedAt, `sources[${index}].accessedAt`, 80) || undefined,
      note: text(raw.note, `sources[${index}].note`, 1_000) || undefined,
    };
  });
}

function normalizeSections(
  value: unknown,
  text: (value: unknown, name: string, max: number, required?: boolean) => string,
  errors: string[],
  sourceIds: Set<string>,
): ReportSection[] {
  if (!Array.isArray(value)) { errors.push("sections must be an array."); return []; }
  if (value.length > 60) errors.push("sections cannot contain more than 60 items.");
  return value.slice(0, 60).map((item, index) => {
    const raw = record(item, `sections[${index}]`, errors);
    const id = text(raw.id, `sections[${index}].id`, 80, true);
    if (id && !ID.test(id)) errors.push(`sections[${index}].id has invalid characters.`);
    const heading = text(raw.heading, `sections[${index}].heading`, 300, true);
    if (PLACEHOLDER.test(heading)) errors.push(`sections[${index}].heading contains placeholder text.`);
    const level = raw.level === undefined ? 1 : Number(raw.level);
    if (![1, 2, 3].includes(level)) errors.push(`sections[${index}].level must be 1, 2 or 3.`);
    const paragraphs = normalizeParagraphs(raw.paragraphs, `sections[${index}].paragraphs`, text, errors, sourceIds, false);
    const bullets = normalizeParagraphs(raw.bullets, `sections[${index}].bullets`, text, errors, sourceIds, true);
    const tables = normalizeTables(raw.tables, `sections[${index}].tables`, text, errors, sourceIds);
    if (!paragraphs.length && !bullets.length && !tables.length) errors.push(`sections[${index}] must contain a paragraph, bullet or table.`);
    return { id, heading, level: level as 1 | 2 | 3, paragraphs, bullets, tables };
  });
}

function normalizeParagraphs(
  value: unknown,
  name: string,
  text: (value: unknown, name: string, max: number, required?: boolean) => string,
  errors: string[],
  sourceIds: Set<string>,
  bullets: boolean,
) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) { errors.push(`${name} must be an array.`); return []; }
  if (value.length > 500) errors.push(`${name} cannot contain more than 500 items.`);
  return value.slice(0, 500).map((item, index) => {
    const raw = record(item, `${name}[${index}]`, errors);
    const content = text(raw.text, `${name}[${index}].text`, 10_000, true);
    if (PLACEHOLDER.test(content)) errors.push(`${name}[${index}].text contains placeholder text.`);
    const kind = oneOf(raw.kind, ["fact", "analysis", "estimate", "assumption", "recommendation", "conclusion"] as const, "analysis", `${name}[${index}].kind`, errors);
    const evidenceIds = normalizeEvidenceIds(raw.evidenceIds, `${name}[${index}].evidenceIds`, errors, sourceIds);
    if (kind === "fact" && evidenceIds.length === 0) {
      // A fact can be directly supplied by the user, but it must remain visibly unsupported.
    }
    const base = { text: content, kind, evidenceIds };
    if (!bullets) return base;
    const level = raw.level === undefined ? 0 : Number(raw.level);
    if (![0, 1, 2].includes(level)) errors.push(`${name}[${index}].level must be 0, 1 or 2.`);
    return { ...base, level: level as 0 | 1 | 2 };
  });
}

function normalizeTables(
  value: unknown,
  name: string,
  text: (value: unknown, name: string, max: number, required?: boolean) => string,
  errors: string[],
  sourceIds: Set<string>,
) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) { errors.push(`${name} must be an array.`); return []; }
  if (value.length > 50) errors.push(`${name} cannot contain more than 50 tables.`);
  return value.slice(0, 50).map((item, index) => {
    const raw = record(item, `${name}[${index}]`, errors);
    const headers = stringCells(raw.headers, `${name}[${index}].headers`, 30, text, errors);
    if (!headers.length) errors.push(`${name}[${index}] needs at least one header.`);
    if (!Array.isArray(raw.rows)) errors.push(`${name}[${index}].rows must be an array.`);
    const rawRows = Array.isArray(raw.rows) ? raw.rows : [];
    if (rawRows.length > 2_000) errors.push(`${name}[${index}].rows cannot contain more than 2,000 rows.`);
    const rows = rawRows.slice(0, 2_000).map((row, rowIndex) => {
      const cells = stringCells(row, `${name}[${index}].rows[${rowIndex}]`, 30, text, errors);
      if (headers.length && cells.length !== headers.length) errors.push(`${name}[${index}].rows[${rowIndex}] has ${cells.length} cells; expected ${headers.length}.`);
      return cells;
    });
    return {
      title: text(raw.title, `${name}[${index}].title`, 300, true),
      headers,
      rows,
      note: text(raw.note, `${name}[${index}].note`, 1_000) || undefined,
      evidenceIds: normalizeEvidenceIds(raw.evidenceIds, `${name}[${index}].evidenceIds`, errors, sourceIds),
    };
  });
}

function normalizeCalculations(
  value: unknown,
  text: (value: unknown, name: string, max: number, required?: boolean) => string,
  errors: string[],
  sourceIds: Set<string>,
): ReportCalculation[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) { errors.push("calculations must be an array."); return []; }
  if (value.length > 100) errors.push("calculations cannot contain more than 100 items.");
  const calculations = value.slice(0, 100).map((item, index) => {
    const raw = record(item, `calculations[${index}]`, errors);
    const operation = oneOf(raw.operation, ["sum", "average", "difference", "ratio", "percentage_change"] as const, "sum", `calculations[${index}].operation`, errors);
    const rawInputs = Array.isArray(raw.inputs) ? raw.inputs : [];
    if (!Array.isArray(raw.inputs)) errors.push(`calculations[${index}].inputs must be an array.`);
    if (rawInputs.length > 100) errors.push(`calculations[${index}].inputs cannot contain more than 100 values.`);
    const inputs = rawInputs.slice(0, 100).map((entry, inputIndex) => {
      const source = record(entry, `calculations[${index}].inputs[${inputIndex}]`, errors);
      const number = Number(source.value);
      if (!Number.isFinite(number)) errors.push(`calculations[${index}].inputs[${inputIndex}].value must be finite.`);
      return { name: text(source.name, `calculations[${index}].inputs[${inputIndex}].name`, 200, true), value: number, unit: text(source.unit, `calculations[${index}].inputs[${inputIndex}].unit`, 50) || undefined };
    });
    const result = Number(raw.result);
    if (!Number.isFinite(result)) errors.push(`calculations[${index}].result must be finite.`);
    const calculationId = text(raw.id, `calculations[${index}].id`, 80, true);
    if (calculationId && !ID.test(calculationId)) errors.push(`calculations[${index}].id has invalid characters.`);
    const calculation: ReportCalculation = {
      id: calculationId,
      label: text(raw.label, `calculations[${index}].label`, 300, true),
      operation,
      inputs,
      result,
      unit: text(raw.unit, `calculations[${index}].unit`, 50) || undefined,
      note: text(raw.note, `calculations[${index}].note`, 1_000) || undefined,
      evidenceIds: normalizeEvidenceIds(raw.evidenceIds, `calculations[${index}].evidenceIds`, errors, sourceIds),
    };
    validateCalculation(calculation, index, errors);
    return calculation;
  });
  if (new Set(calculations.map((item) => item.id)).size !== calculations.length) errors.push("Calculation IDs must be unique.");
  return calculations;
}

function validateCalculation(calculation: ReportCalculation, index: number, errors: string[]): void {
  const values = calculation.inputs.map((item) => item.value);
  if (["difference", "ratio", "percentage_change"].includes(calculation.operation) && values.length !== 2) {
    errors.push(`calculations[${index}] operation ${calculation.operation} requires exactly two inputs.`);
    return;
  }
  if (["sum", "average"].includes(calculation.operation) && values.length < 1) {
    errors.push(`calculations[${index}] operation ${calculation.operation} requires at least one input.`);
    return;
  }
  let actual = 0;
  if (calculation.operation === "sum") actual = values.reduce((sum, value) => sum + value, 0);
  if (calculation.operation === "average") actual = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (calculation.operation === "difference") actual = values[0] - values[1];
  if (calculation.operation === "ratio") {
    if (values[1] === 0) { errors.push(`calculations[${index}] cannot divide by zero.`); return; }
    actual = values[0] / values[1];
  }
  if (calculation.operation === "percentage_change") {
    if (values[0] === 0) { errors.push(`calculations[${index}] cannot calculate percentage change from zero.`); return; }
    actual = ((values[1] - values[0]) / Math.abs(values[0])) * 100;
  }
  const tolerance = Math.max(1e-9, Math.abs(actual) * 1e-9);
  if (!Number.isFinite(actual) || Math.abs(actual - calculation.result) > tolerance) {
    errors.push(`calculations[${index}].result is ${calculation.result}, but deterministic recomputation gives ${Number(actual.toPrecision(12))}.`);
  }
}

function normalizeEvidenceIds(value: unknown, name: string, errors: string[], sourceIds: Set<string>): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) { errors.push(`${name} must be an array.`); return []; }
  const ids = unique(value.map((item) => String(item).trim()).filter(Boolean));
  if (ids.length > 50) errors.push(`${name} cannot contain more than 50 IDs.`);
  for (const id of ids) if (!sourceIds.has(id)) errors.push(`${name} refers to unknown source '${id}'.`);
  return ids.slice(0, 50);
}

function normalizeStringList(
  value: unknown,
  name: string,
  maxItems: number,
  maxLength: number,
  text: (value: unknown, name: string, max: number, required?: boolean) => string,
  errors: string[],
): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) { errors.push(`${name} must be an array.`); return []; }
  if (value.length > maxItems) errors.push(`${name} cannot contain more than ${maxItems} items.`);
  return value.slice(0, maxItems).map((item, index) => text(item, `${name}[${index}]`, maxLength, true));
}

function stringCells(value: unknown, name: string, maxItems: number, text: (value: unknown, name: string, max: number, required?: boolean) => string, errors: string[]): string[] {
  if (!Array.isArray(value)) { errors.push(`${name} must be an array.`); return []; }
  if (value.length > maxItems) errors.push(`${name} cannot contain more than ${maxItems} cells.`);
  return value.slice(0, maxItems).map((cell, index) => text(cell, `${name}[${index}]`, 2_000));
}

function record(value: unknown, name: string, errors: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${name} must be an object.`);
    return {};
  }
  return value as Record<string, unknown>;
}

function oneOf<T extends string>(value: unknown, options: readonly T[], fallback: T, name: string, errors: string[]): T {
  if (value === undefined || value === null || value === "") return fallback;
  if (!options.includes(value as T)) {
    errors.push(`${name} must be one of: ${options.join(", ")}.`);
    return fallback;
  }
  return value as T;
}

function normalizeDate(value: unknown, now: Date, errors: string[]): string {
  if (value === undefined || value === null || value === "") return now.toISOString().slice(0, 10);
  const text = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) {
    errors.push("documentDate must use YYYY-MM-DD.");
  }
  return text;
}

function sectionTextLength(sections: ReportSection[]): number {
  return sections.reduce((total, section) => total + section.heading.length
    + (section.paragraphs || []).reduce((sum, item) => sum + item.text.length, 0)
    + (section.bullets || []).reduce((sum, item) => sum + item.text.length, 0)
    + (section.tables || []).reduce((sum, table) => sum + table.title.length + table.headers.join("").length + table.rows.flat().join("").length, 0), 0);
}

export function normalizeHeading(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export function containsPlaceholder(value: string): boolean {
  return PLACEHOLDER.test(value);
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
