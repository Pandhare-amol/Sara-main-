#!/usr/bin/env node
/**
 * Fail the build if the browser bundle looks like it contains a secret.
 *
 * Frontend env vars (VITE_*) are public by definition, so a real Gemini key,
 * an access token or a private key must never reach `dist/assets`. This scans
 * the built bundle and the generated runtime config.
 *
 * Usage: node scripts/check-bundle-secrets.mjs [distDir]
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const root = process.argv[2] || "dist";
const TEXT_EXT = new Set([".js", ".mjs", ".cjs", ".css", ".html", ".json", ".map", ".txt", ".webmanifest"]);

/** Patterns that only match real credentials, not documentation. */
const RULES = [
  { name: "Google API key", re: /AIza[0-9A-Za-z_-]{35}/ },
  { name: "Gemini key assignment", re: /GEMINI_API_KEY\s*[:=]\s*["'`][^"'`]{8,}/ },
  { name: "Bearer token literal", re: /Bearer\s+[A-Za-z0-9._-]{24,}/ },
  { name: "PEM private key", re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: "AWS access key", re: /AKIA[0-9A-Z]{16}/ },
  { name: "GitHub token", re: /gh[pousr]_[A-Za-z0-9]{36,}/ },
];

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

let files = [];
try {
  files = walk(root).filter((file) => TEXT_EXT.has(extname(file)));
} catch (error) {
  console.error(`[secrets] Cannot read ${root}: ${error.message}`);
  process.exit(1);
}

if (files.length === 0) {
  console.error(`[secrets] No built files found in ${root}. Run the web build first.`);
  process.exit(1);
}

const findings = [];
for (const file of files) {
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  for (const rule of RULES) {
    const match = rule.re.exec(text);
    if (match) findings.push({ file, rule: rule.name, sample: match[0].slice(0, 12) + "…" });
  }
}

if (findings.length > 0) {
  console.error("[secrets] Refusing to ship a bundle that may contain credentials:");
  for (const finding of findings) console.error(`  - ${finding.rule} in ${finding.file} (${finding.sample})`);
  process.exit(1);
}

console.log(`[secrets] OK — scanned ${files.length} built files, no credentials found.`);
