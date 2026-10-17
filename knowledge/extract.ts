import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { ZipArchive } from "../character_import/zip";

export interface ExtractedSection {
  text: string;
  label: string;
  lineStart: number | null;
  lineEnd: number | null;
}

export interface ExtractionResult {
  status: "ok" | "unsupported";
  method: string | null;
  mimeType: string;
  sections: ExtractedSection[];
  reason: string | null;
  warnings: string[];
}

const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".mdx", ".rst", ".adoc", ".csv", ".tsv", ".json", ".jsonl", ".xml", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".log",
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".java", ".kt", ".kts", ".go", ".rs", ".rb", ".php", ".cs", ".fs", ".fsx",
  ".c", ".h", ".cc", ".cpp", ".hpp", ".swift", ".scala", ".sh", ".bash", ".zsh", ".fish", ".ps1", ".bat", ".cmd", ".sql", ".graphql",
  ".html", ".htm", ".css", ".scss", ".less", ".vue", ".svelte", ".astro", ".dockerfile", ".gitignore", ".editorconfig",
]);
const BINARY_OFFICE = new Set([".doc", ".xls", ".ppt"]);
const OFFICE_OPEN_XML = new Set([".docx", ".xlsx", ".pptx"]);
const MIME: Record<string, string> = {
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".pdf": "application/pdf", ".rtf": "application/rtf", ".md": "text/markdown", ".json": "application/json", ".xml": "application/xml",
};

export function supportedExtension(extension: string): boolean {
  const ext = extension.toLowerCase();
  return TEXT_EXTENSIONS.has(ext) || OFFICE_OPEN_XML.has(ext) || ext === ".rtf" || ext === ".pdf";
}

export async function extractFile(filePath: string): Promise<ExtractionResult> {
  const ext = extensionOf(filePath);
  if (BINARY_OFFICE.has(ext)) return unsupported(ext, `Legacy binary ${ext} files are recorded but not parsed. Save as ${ext}x to index the content safely.`);
  if (ext === ".pdf") return extractPdf(filePath);
  if (OFFICE_OPEN_XML.has(ext)) return extractOffice(filePath, ext);
  if (ext === ".rtf") {
    const raw = await fs.readFile(filePath, "utf8");
    const text = decodeRtf(raw);
    return result(ext, "rtf-text", linesToSections(text), text ? [] : ["The RTF contained no extractable plain text."]);
  }
  if (TEXT_EXTENSIONS.has(ext) || path.basename(filePath).toLowerCase() === "dockerfile") {
    const buffer = await fs.readFile(filePath);
    if (buffer.includes(0)) return unsupported(ext, "The file contains binary NUL bytes and was not decoded as text.");
    const text = decodeText(buffer);
    return result(ext, "plain-text", linesToSections(text), []);
  }
  return unsupported(ext, `Unsupported format ${ext || "(no extension)"}.`);
}

async function extractPdf(filePath: string): Promise<ExtractionResult> {
  const buffer = await fs.readFile(filePath);
  if (buffer.length > 50 * 1024 * 1024) return unsupported(".pdf", "PDF exceeds the 50 MB extraction safety limit.");
  try {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const loading = pdfjs.getDocument({ data: new Uint8Array(buffer), disableFontFace: true, useSystemFonts: false, isEvalSupported: false, verbosity: 0 });
    const document = await loading.promise;
    if (document.numPages > 1_000) { await document.destroy(); return unsupported(".pdf", "PDF exceeds the 1,000 page extraction safety limit."); }
    const sections: ExtractedSection[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      let text = "";
      for (const item of content.items) {
        if (!("str" in item)) continue;
        text += `${item.str}${item.hasEOL ? "\n" : " "}`;
      }
      text = text.replace(/[ \t]+\n/g, "\n").replace(/[ \t]{2,}/g, " ").trim();
      if (text) sections.push({ text, label: `page ${pageNumber}`, lineStart: null, lineEnd: null });
      page.cleanup();
    }
    await document.destroy();
    return result(".pdf", "pdfjs-text", sections, sections.length ? [] : ["The PDF had no extractable text; it may contain only scans/images or use unsupported encoding."]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/password/i.test(message)) return unsupported(".pdf", "Password-protected PDF could not be extracted.");
    throw new Error(`PDF extraction failed: ${message}`);
  }
}

async function extractOffice(filePath: string, ext: string): Promise<ExtractionResult> {
  const stat = await fs.stat(filePath);
  if (stat.size > 50 * 1024 * 1024) return unsupported(ext, "Office package exceeds the 50 MB extraction safety limit.");
  let zip: ZipArchive;
  try {
    zip = await ZipArchive.open(filePath);
  } catch (error) {
    throw new Error(`Invalid Office Open XML package: ${error instanceof Error ? error.message : String(error)}`);
  }
  const readXml = (name: string) => {
    const entry = zip.entries.find((item) => item.name === name);
    return entry ? zip.read(entry).toString("utf8") : "";
  };
  const sections: ExtractedSection[] = [];
  const warnings: string[] = [];
  if (ext === ".docx") {
    const names = zip.entries.map((item) => item.name).filter((name) => /^word\/(document|header\d+|footer\d+|footnotes|endnotes|comments)\.xml$/.test(name)).sort();
    for (const name of names) {
      const xml = readXml(name);
      const paragraphs = [...xml.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)].map((match) => officeText(match[1])).filter(Boolean);
      paragraphs.forEach((text, index) => sections.push({ text, label: `${officePartLabel(name)} paragraph ${index + 1}`, lineStart: null, lineEnd: null }));
    }
    if (!sections.length) warnings.push("The Word package contained no extractable paragraphs.");
    return result(ext, "openxml-word", sections, warnings);
  }
  if (ext === ".pptx") {
    const names = zip.entries.map((item) => item.name).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort(naturalSort);
    for (const name of names) {
      const number = Number(name.match(/slide(\d+)\.xml$/)?.[1] || 0);
      const paragraphs = [...readXml(name).matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)].map((match) => officeText(match[1])).filter(Boolean);
      if (paragraphs.length) sections.push({ text: paragraphs.join("\n"), label: `slide ${number}`, lineStart: null, lineEnd: null });
    }
    if (!sections.length) warnings.push("The PowerPoint package contained no extractable slide text.");
    return result(ext, "openxml-powerpoint", sections, warnings);
  }

  const shared = [...readXml("xl/sharedStrings.xml").matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((match) => officeText(match[1]));
  const sheetNames = zip.entries.map((item) => item.name).filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).sort(naturalSort);
  for (const name of sheetNames) {
    const sheetNumber = Number(name.match(/sheet(\d+)\.xml$/)?.[1] || 0);
    const rows = [...readXml(name).matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)];
    for (const row of rows) {
      const rowNumber = Number(row[1].match(/\br="(\d+)"/)?.[1] || 0) || null;
      const cells: string[] = [];
      for (const cell of row[2].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
        const ref = cell[1].match(/\br="([A-Z]+\d+)"/)?.[1] || "cell";
        const type = cell[1].match(/\bt="([^"]+)"/)?.[1] || "";
        const raw = cell[2].match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? officeText(cell[2]);
        const value = type === "s" ? shared[Number(raw)] ?? raw : decodeXml(raw);
        if (value !== "") cells.push(`${ref}: ${value}`);
      }
      if (cells.length) sections.push({ text: cells.join(" | "), label: `sheet ${sheetNumber}, row ${rowNumber ?? "?"}`, lineStart: null, lineEnd: null });
    }
  }
  if (!sections.length) warnings.push("The Excel package contained no extractable cell values.");
  return result(ext, "openxml-excel", sections, warnings);
}

export function contentHash(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function suspiciousInstructions(text: string): boolean {
  return /(?:ignore|disregard|override)\s+(?:all\s+)?(?:previous|prior|system|developer)\s+(?:instructions?|prompts?)|(?:system|developer)\s+message\s*:|reveal\s+(?:your\s+)?(?:secret|password|token|credentials?)|execute\s+(?:this\s+)?command/i.test(text);
}

export function termsFor(text: string): string[] {
  return [...new Set(text.toLowerCase().match(/[\p{L}\p{N}_$.-]{2,}/gu) || [])].slice(0, 400);
}

function linesToSections(text: string): ExtractedSection[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const sections: ExtractedSection[] = [];
  let start = 0;
  while (start < lines.length) {
    if (lines[start].length > 6_000) {
      for (let offset = 0; offset < lines[start].length; offset += 5_500) {
        const part = lines[start].slice(offset, offset + 6_000).trim();
        if (part) sections.push({ text: part, label: `line ${start + 1}, characters ${offset + 1}-${offset + part.length}`, lineStart: start + 1, lineEnd: start + 1 });
      }
      start += 1;
      continue;
    }
    let end = start;
    let length = 0;
    while (end < lines.length && end - start < 80 && length + lines[end].length + 1 <= 6_000) { length += lines[end].length + 1; end += 1; }
    if (end === start) end += 1;
    const value = lines.slice(start, end).join("\n").trim();
    if (value) sections.push({ text: value, label: `lines ${start + 1}-${end}`, lineStart: start + 1, lineEnd: end });
    if (end >= lines.length) break;
    start = Math.max(start + 1, end - 5);
  }
  return sections;
}

function extensionOf(filePath: string): string {
  const base = path.basename(filePath).toLowerCase();
  return base === "dockerfile" ? ".dockerfile" : path.extname(base);
}
function result(ext: string, method: string, sections: ExtractedSection[], warnings: string[]): ExtractionResult {
  return { status: "ok", method, mimeType: MIME[ext] || (TEXT_EXTENSIONS.has(ext) ? "text/plain" : "application/octet-stream"), sections, reason: null, warnings };
}
function unsupported(ext: string, reason: string): ExtractionResult {
  return { status: "unsupported", method: null, mimeType: MIME[ext] || "application/octet-stream", sections: [], reason, warnings: [] };
}
function decodeText(buffer: Buffer): string {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString("utf16le");
  if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.from(buffer.subarray(2));
    for (let i = 0; i + 1 < swapped.length; i += 2) [swapped[i], swapped[i + 1]] = [swapped[i + 1], swapped[i]];
    return swapped.toString("utf16le");
  }
  return buffer.toString("utf8").replace(/^\uFEFF/, "");
}
function officeText(xml: string): string {
  return [...xml.matchAll(/<(?:w:t|a:t|t)\b[^>]*>([\s\S]*?)<\/(?:w:t|a:t|t)>/g)].map((match) => decodeXml(match[1])).join(" ").replace(/\s+/g, " ").trim();
}
function decodeXml(text: string): string {
  return text.replace(/&#(x?[0-9a-f]+);/gi, (_, value: string) => String.fromCodePoint(parseInt(value.startsWith("x") ? value.slice(1) : value, value.startsWith("x") ? 16 : 10)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}
function decodeRtf(raw: string): string {
  return raw.replace(/\\par[d]?\b/g, "\n").replace(/\\'[0-9a-f]{2}/gi, (match) => Buffer.from(match.slice(2), "hex").toString("latin1"))
    .replace(/\\u(-?\d+)\??/g, (_, value: string) => String.fromCharCode((Number(value) + 65536) % 65536))
    .replace(/\\[a-z]+-?\d* ?/gi, "").replace(/[{}]/g, "").replace(/\s+\n/g, "\n").trim();
}
function naturalSort(a: string, b: string): number { return a.localeCompare(b, undefined, { numeric: true }); }
function officePartLabel(name: string): string { return name.replace(/^word\//, "").replace(/\.xml$/, ""); }
