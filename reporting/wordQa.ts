import fs from "node:fs/promises";
import { ZipArchive } from "../character_import/zip";
import { contentHash, extractFile } from "../knowledge/extract";
import { containsPlaceholder, normalizeHeading } from "./validation";
import type { ReportQaCheck, ReportQaResult, WordReportRequest } from "./types";

const REQUIRED_PARTS = [
  "[Content_Types].xml",
  "_rels/.rels",
  "docProps/core.xml",
  "word/document.xml",
  "word/styles.xml",
  "word/_rels/document.xml.rels",
];
const FORBIDDEN_PART = /(?:^|\/)(?:vbaProject\.bin|activeX\/|embeddings\/|externalLinks\/|oleObject)/i;

export interface WordQaDetails {
  qa: ReportQaResult;
  size: number;
  sha256: string;
}

export async function inspectGeneratedWord(file: string, request: WordReportRequest): Promise<WordQaDetails> {
  const checks: ReportQaCheck[] = [];
  const warnings: string[] = [];
  const add = (id: string, passed: boolean, detail: string) => checks.push({ id, status: passed ? "passed" : "failed", detail });

  let buffer: Buffer;
  try {
    buffer = await fs.readFile(file);
  } catch (error) {
    add("file-readable", false, `Output could not be read: ${error instanceof Error ? error.message : String(error)}`);
    return { qa: summary(checks, warnings, 0, 0, 0, 0), size: 0, sha256: "" };
  }
  add("file-readable", buffer.length > 0, buffer.length > 0 ? `Output is ${buffer.length} bytes.` : "Output is empty.");
  add("file-size", buffer.length <= 50 * 1024 * 1024, buffer.length <= 50 * 1024 * 1024 ? "Output is within the 50 MB validation limit." : "Output exceeds the 50 MB validation limit.");

  let zip: ZipArchive;
  try {
    zip = await ZipArchive.open(file);
    add("openxml-package", true, `ZIP central directory parsed (${zip.entries.length} parts).`);
  } catch (error) {
    add("openxml-package", false, `Invalid Open XML package: ${error instanceof Error ? error.message : String(error)}`);
    return { qa: summary(checks, warnings, 0, 0, 0, 0), size: buffer.length, sha256: contentHash(buffer) };
  }
  const names = new Set(zip.entries.map((entry) => entry.name));
  const missing = REQUIRED_PARTS.filter((name) => !names.has(name));
  add("required-parts", missing.length === 0, missing.length ? `Missing package parts: ${missing.join(", ")}.` : "All required Word package parts are present.");
  const forbidden = [...names].filter((name) => FORBIDDEN_PART.test(name));
  add("no-active-content", forbidden.length === 0, forbidden.length ? `Forbidden active or embedded content: ${forbidden.join(", ")}.` : "No macros, ActiveX, OLE objects, embedded files or external-link parts are present.");
  const headerPresent = [...names].some((name) => /^word\/header\d+\.xml$/.test(name));
  const footerPresent = [...names].some((name) => /^word\/footer\d+\.xml$/.test(name));
  add("header-footer", headerPresent && footerPresent, headerPresent && footerPresent ? "Header and footer parts are present." : "Header or footer is missing.");

  const readPart = (name: string): string => {
    const entry = zip.entries.find((candidate) => candidate.name === name);
    return entry ? zip.read(entry).toString("utf8") : "";
  };
  const documentXml = readPart("word/document.xml");
  const coreXml = readPart("docProps/core.xml");
  const relsXml = readPart("word/_rels/document.xml.rels");
  const headings = [...documentXml.matchAll(/<w:pStyle\b[^>]*w:val="Heading[123]"/g)].length;
  const tableCount = [...documentXml.matchAll(/<w:tbl\b/g)].length;
  const expectedHeadingMinimum = request.sections.length + 2; // contents + report basis
  add("heading-structure", headings >= expectedHeadingMinimum, headings >= expectedHeadingMinimum ? `${headings} styled headings found.` : `Only ${headings} styled headings found; expected at least ${expectedHeadingMinimum}.`);
  const inputTables = request.sections.reduce((count, section) => count + (section.tables?.length || 0), 0);
  const expectedTables = 1 + inputTables + (request.calculations?.length || 0);
  add("table-structure", tableCount >= expectedTables, tableCount >= expectedTables ? `${tableCount} structured tables found.` : `Only ${tableCount} tables found; expected at least ${expectedTables}.`);

  const externalRelationships = [...relsXml.matchAll(/<Relationship\b[^>]*TargetMode="External"[^>]*>/g)].map((match) => match[0]);
  const unsafeRelationship = externalRelationships.find((relationship) => !/relationships\/hyperlink/.test(relationship));
  add("external-content", !unsafeRelationship, unsafeRelationship ? "A non-hyperlink external relationship was found." : `${externalRelationships.length} external relationship(s), all explicit reference hyperlinks.`);

  let extractedText = "";
  try {
    const extraction = await extractFile(file);
    extractedText = extraction.sections.map((section) => section.text).join("\n");
    add("content-extraction", extraction.status === "ok" && extractedText.length > 0, extraction.status === "ok" && extractedText.length > 0 ? `${extractedText.length} characters were independently extracted from the generated file.` : extraction.reason || "No text could be extracted.");
    warnings.push(...extraction.warnings);
  } catch (error) {
    add("content-extraction", false, `Independent extraction failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const normalizedExtracted = normalizeHeading(extractedText);
  add("title-present", normalizedExtracted.includes(normalizeHeading(request.title)), "The document title is present in extracted content.");
  const missingHeadings = request.sections.filter((section) => !normalizedExtracted.includes(normalizeHeading(section.heading))).map((section) => section.heading);
  add("section-content", missingHeadings.length === 0, missingHeadings.length ? `Missing extracted section headings: ${missingHeadings.join(", ")}.` : "Every requested section heading is present.");
  add("no-placeholders", !containsPlaceholder(extractedText), containsPlaceholder(extractedText) ? "Placeholder text was detected in the generated document." : "No prohibited placeholder text was detected.");

  const expectedCitations = citedSourceIds(request);
  const missingCitations = expectedCitations.filter((id) => !extractedText.includes(`[${id}]`) && !extractedText.includes(id));
  add("citation-markers", missingCitations.length === 0, missingCitations.length ? `Missing citation markers: ${missingCitations.join(", ")}.` : `${expectedCitations.length} cited source ID(s) are present.`);
  const referenced = new Set(expectedCitations);
  const uncitedSources = (request.sources || []).filter((source) => !referenced.has(source.id)).map((source) => source.id);
  if (uncitedSources.length) warnings.push(`Sources listed but not cited in report content: ${uncitedSources.join(", ")}.`);
  const unsupportedFacts = request.sections.flatMap((section) => [...(section.paragraphs || []), ...(section.bullets || [])]).filter((item) => item.kind === "fact" && !(item.evidenceIds || []).length).length;
  if (unsupportedFacts) warnings.push(`${unsupportedFacts} fact-labelled statement(s) have no supplied source ID and remain user-provided/unverified.`);

  const metadataOkay = coreXml.includes(escapeXmlFragment(request.title)) && coreXml.includes(escapeXmlFragment(request.author || "SARA"));
  add("document-metadata", metadataOkay, metadataOkay ? "Core properties contain the supplied title and author." : "Core properties do not contain the supplied title and author.");

  return {
    qa: summary(checks, unique(warnings), extractedText.length, headings, tableCount, expectedCitations.length),
    size: buffer.length,
    sha256: contentHash(buffer),
  };
}

function citedSourceIds(request: WordReportRequest): string[] {
  const values: string[] = [];
  for (const section of request.sections) {
    for (const item of [...(section.paragraphs || []), ...(section.bullets || [])]) values.push(...(item.evidenceIds || []));
    for (const table of section.tables || []) values.push(...(table.evidenceIds || []));
  }
  for (const calculation of request.calculations || []) values.push(...(calculation.evidenceIds || []));
  return unique(values);
}

function summary(checks: ReportQaCheck[], warnings: string[], extractedCharacters: number, headings: number, tables: number, sourcesCited: number): ReportQaResult {
  return {
    passed: checks.length > 0 && checks.every((check) => check.status === "passed"),
    checks,
    warnings,
    extractedCharacters,
    headings,
    tables,
    sourcesCited,
  };
}

function escapeXmlFragment(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
