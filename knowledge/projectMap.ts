import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { IndexedDocument, KnowledgeChunk, ProjectEvidenceRef, ProjectMap, SourceGrant, CodeSymbol } from "./types";
import { importsFrom } from "./codeSymbols";

const execFileAsync = promisify(execFile);

export async function buildProjectMap(root: SourceGrant, documents: IndexedDocument[], chunks: KnowledgeChunk[], symbols: CodeSymbol[]): Promise<ProjectMap> {
  const projectId = root.projectId || root.id;
  const docs = documents.filter((doc) => doc.sourceId === root.id && doc.status === "indexed");
  const byDocument = new Map<string, string>();
  for (const chunk of chunks.filter((item) => item.sourceId === root.id)) {
    const prior = byDocument.get(chunk.documentId) || "";
    if (prior.length < 200_000) byDocument.set(chunk.documentId, `${prior}\n${chunk.text}`.slice(0, 200_000));
  }
  const evidence = (doc: IndexedDocument, line: number | null = null): ProjectEvidenceRef => ({ documentId: doc.id, relativePath: doc.relativePath, line });
  const entryPoints: ProjectMap["entryPoints"] = [];
  const dependencies: ProjectMap["dependencies"] = [];
  const buildCommands: ProjectMap["buildCommands"] = [];
  const apis: ProjectMap["apis"] = [];
  const dataModels: ProjectMap["dataModels"] = [];
  const tests: ProjectMap["tests"] = [];
  const relationships: ProjectMap["relationships"] = [];
  const unresolvedIssues: ProjectMap["unresolvedIssues"] = [];
  const limitations: string[] = ["Architecture is derived by static inspection only; dynamic imports and runtime wiring may be absent."];

  for (const doc of docs) {
    const normalized = doc.relativePath.replace(/\\/g, "/");
    const text = byDocument.get(doc.id) || "";
    const base = path.basename(normalized).toLowerCase();
    if (/^(main|index|server|app|cli)\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|cs)$/.test(base)) entryPoints.push({ value: normalized, evidence: evidence(doc, 1) });
    if (/((^|\/)(__tests__|tests?|specs?)\/|\.(test|spec)\.[^.]+$|_test\.py$)/i.test(normalized)) tests.push({ path: normalized, framework: detectTestFramework(text) });

    if (base === "package.json") {
      const json = safeJson(text);
      const main = typeof json?.main === "string" ? json.main : typeof json?.module === "string" ? json.module : null;
      if (main) entryPoints.push({ value: main, evidence: evidence(doc, 1) });
      for (const [name, command] of Object.entries(asRecord(json?.scripts))) buildCommands.push({ name, command: String(command), evidence: evidence(doc, 1) });
      for (const [name, version] of Object.entries(asRecord(json?.dependencies))) dependencies.push({ name, version: String(version), kind: "runtime", evidence: evidence(doc, 1) });
      for (const [name, version] of Object.entries(asRecord(json?.devDependencies))) dependencies.push({ name, version: String(version), kind: "development", evidence: evidence(doc, 1) });
    }
    if (/^(requirements[^/]*\.txt|pyproject\.toml|poetry\.lock|pipfile)$/i.test(base)) {
      text.split(/\r?\n/).forEach((line, index) => {
        const match = line.trim().match(/^([a-z0-9_.-]+)\s*(?:[=<>~!]+\s*([^\s;#]+))?/i);
        if (match && !/^(python|project|dependencies|build-system)$/i.test(match[1])) dependencies.push({ name: match[1], version: match[2] || null, kind: "python", evidence: evidence(doc, index + 1) });
      });
    }
    if (/^(makefile|justfile|taskfile\.ya?ml)$/i.test(base)) {
      text.split(/\r?\n/).forEach((line, index) => {
        const match = line.match(/^([\w.-]+):\s*(?:#.*)?$/);
        if (match && !match[1].startsWith(".")) buildCommands.push({ name: match[1], command: `${base} ${match[1]}`, evidence: evidence(doc, index + 1) });
      });
    }
    importsFrom(text).forEach((target) => relationships.push({ from: normalized, to: target, kind: "import" }));
    text.split(/\r?\n/).forEach((line, index) => {
      const match = line.match(/\b(TODO|FIXME|HACK|XXX)\b[:\s-]*(.{0,220})/i);
      if (match) unresolvedIssues.push({ text: `${match[1].toUpperCase()}: ${match[2].trim()}`.slice(0, 260), evidence: evidence(doc, index + 1) });
    });
  }

  for (const symbol of symbols.filter((item) => docs.some((doc) => doc.id === item.documentId))) {
    const doc = docs.find((item) => item.id === symbol.documentId)!;
    if (symbol.kind === "route") {
      const match = symbol.signature.match(/^(GET|POST|PUT|PATCH|DELETE|USE)\s+(.+)/);
      apis.push({ method: match?.[1] || null, route: match?.[2] || symbol.name, handler: null, evidence: evidence(doc, symbol.line) });
    }
    if (["class", "interface", "type"].includes(symbol.kind)) dataModels.push({ name: symbol.name, kind: symbol.kind, evidence: evidence(doc, symbol.line) });
  }

  const top = new Map<string, number>();
  for (const doc of docs) {
    const part = doc.relativePath.replace(/\\/g, "/").split("/")[0] || ".";
    top.set(part, (top.get(part) || 0) + 1);
  }
  const modules = [...top.entries()].sort((a, b) => b[1] - a[1]).slice(0, 80).map(([name, fileCount]) => ({ name, path: name, fileCount }));
  const recentChanges: ProjectMap["recentChanges"] = [];
  try {
    const { stdout } = await execFileAsync("git", ["log", "-15", "--date=iso-strict", "--pretty=format:%h%x09%ad%x09%s"], { cwd: root.realRootPath, timeout: 5_000, windowsHide: true, maxBuffer: 512_000 });
    for (const line of stdout.split(/\r?\n/)) {
      const [commit, at, ...summary] = line.split("\t");
      if (commit && at) recentChanges.push({ commit, at, summary: summary.join("\t").slice(0, 300) });
    }
  } catch {
    limitations.push("Git history was unavailable for this source.");
  }

  const sourceFingerprint = createHash("sha256").update(docs.map((doc) => `${doc.relativePath}:${doc.contentHash}`).sort().join("\n")).digest("hex");
  return {
    id: randomUUID(), sourceId: root.id, ownerId: root.ownerId, projectId, name: root.label,
    entryPoints: uniqueBy(entryPoints, (item) => item.value), modules,
    dependencies: uniqueBy(dependencies, (item) => `${item.kind}:${item.name}`),
    apis: uniqueBy(apis, (item) => `${item.method}:${item.route}:${item.evidence.relativePath}:${item.evidence.line}`),
    dataModels: uniqueBy(dataModels, (item) => `${item.name}:${item.evidence.relativePath}`),
    tests: uniqueBy(tests, (item) => item.path),
    buildCommands: uniqueBy(buildCommands, (item) => `${item.name}:${item.command}`),
    relationships: uniqueBy(relationships, (item) => `${item.from}:${item.to}`).slice(0, 4_000),
    recentChanges, unresolvedIssues: unresolvedIssues.slice(0, 500), sourceFingerprint,
    refreshedAt: new Date().toISOString(), limitations,
  };
}

function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function safeJson(text: string): Record<string, unknown> | null {
  try {
    const start = text.indexOf("{"); const end = text.lastIndexOf("}");
    return JSON.parse(start >= 0 && end >= start ? text.slice(start, end + 1) : text) as Record<string, unknown>;
  } catch { return null; }
}
function uniqueBy<T>(items: T[], key: (value: T) => string): T[] { const seen = new Set<string>(); return items.filter((item) => { const value = key(item); if (seen.has(value)) return false; seen.add(value); return true; }); }
function detectTestFramework(text: string): string | null {
  if (/\b(vitest|describe\(|it\(|test\()/i.test(text)) return /vitest/i.test(text) ? "vitest" : "node/jest-style";
  if (/\bpytest\b|def\s+test_/i.test(text)) return "pytest";
  if (/\bJUnit\b|@Test\b/.test(text)) return "JUnit";
  if (/\btesting\.T\b/.test(text)) return "go test";
  return null;
}
