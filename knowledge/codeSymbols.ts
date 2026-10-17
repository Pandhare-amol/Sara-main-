import { randomUUID } from "node:crypto";
import path from "node:path";
import type { CodeSymbol } from "./types";

const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".java", ".kt", ".go", ".rs", ".rb", ".php", ".cs", ".c", ".h", ".cc", ".cpp", ".hpp", ".swift", ".scala"]);

export function isCodeFile(filePath: string): boolean {
  return CODE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

/** Lightweight, non-executing symbol discovery. It intentionally never loads project code. */
export function extractCodeSymbols(documentId: string, filePath: string, text: string): CodeSymbol[] {
  if (!isCodeFile(filePath)) return headings(documentId, text);
  const ext = path.extname(filePath).toLowerCase();
  const lines = text.split(/\r?\n/);
  const symbols: CodeSymbol[] = [];
  const push = (name: string, kind: CodeSymbol["kind"], line: number, signature: string, exported = false) => {
    if (!name || symbols.some((item) => item.name === name && item.line === line && item.kind === kind)) return;
    symbols.push({ id: randomUUID(), documentId, name: name.slice(0, 160), kind, line, signature: signature.trim().slice(0, 500), exported });
  };

  lines.forEach((line, index) => {
    const n = index + 1;
    const exported = /\bexport\b/.test(line) || /\bpublic\b/.test(line);
    let match: RegExpMatchArray | null;
    if ((match = line.match(/\b(?:export\s+)?(?:async\s+)?function\s+([\w$]+)\s*\(([^)]*)\)/))) push(match[1], "function", n, line, exported);
    if ((match = line.match(/\b(?:export\s+)?(?:abstract\s+)?class\s+([\w$]+)/))) push(match[1], "class", n, line, exported);
    if ((match = line.match(/\b(?:export\s+)?interface\s+([\w$]+)/))) push(match[1], "interface", n, line, true);
    if ((match = line.match(/\b(?:export\s+)?type\s+([\w$]+)\s*=/))) push(match[1], "type", n, line, true);
    if ((match = line.match(/\b(?:export\s+)?const\s+([\w$]+)\s*=\s*(?:async\s*)?\(/))) push(match[1], "function", n, line, exported);
    else if ((match = line.match(/\b(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*=/))) push(match[1], "constant", n, line, exported);
    if (ext === ".py") {
      if ((match = line.match(/^\s*(?:async\s+)?def\s+([\w]+)\s*\(([^)]*)\)/))) push(match[1], "function", n, line, !line.startsWith(" "));
      if ((match = line.match(/^\s*class\s+([\w]+)/))) push(match[1], "class", n, line, !line.startsWith(" "));
    }
    if ((match = line.match(/\b(?:app|router|server)\.(get|post|put|patch|delete|use)\s*\(\s*[`'"]([^`'"]+)/i))) push(match[2], "route", n, `${match[1].toUpperCase()} ${match[2]}`, exported);
    if ((match = line.match(/@(?:app|router)\.(get|post|put|patch|delete)\(\s*[`'"]([^`'"]+)/i))) push(match[2], "route", n, `${match[1].toUpperCase()} ${match[2]}`, exported);
    if ((match = line.match(/\b(?:MapGet|MapPost|MapPut|MapDelete|MapPatch)\s*\(\s*[`'"]([^`'"]+)/))) push(match[1], "route", n, line, exported);
  });
  return symbols.slice(0, 2_000);
}

function headings(documentId: string, text: string): CodeSymbol[] {
  return text.split(/\r?\n/).flatMap((line, index) => {
    const match = line.match(/^#{1,6}\s+(.+)/);
    return match ? [{ id: randomUUID(), documentId, name: match[1].trim().slice(0, 160), kind: "heading" as const, exported: false, line: index + 1, signature: line.trim().slice(0, 500) }] : [];
  });
}

export function importsFrom(text: string): string[] {
  const values: string[] = [];
  const patterns = [
    /\b(?:import|export)\b[\s\S]{0,160}?\bfrom\s*["']([^"']+)["']/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
    /^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm,
    /^\s*use\s+([\w:]+)/gm,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = match[1] || match[2];
      if (value) values.push(value);
    }
  }
  return [...new Set(values)].slice(0, 500);
}
