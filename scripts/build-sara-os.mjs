#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const args = process.argv.slice(2);

function valueAfter(flag, fallback) {
  const index = args.indexOf(flag);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}

if (args.includes("--help") || args.includes("-h")) {
  console.log(`Build the bootable Sara OS amd64 ISO through Docker or Podman.

Usage:
  npm run os:build -- [--engine docker|podman] [--output DIR] [--no-cache] [--force]
  npm run os:build -- --dry-run

The output directory defaults to out/sara-os. Existing ISO artifacts are never
overwritten unless --force is supplied. The image boots on UEFI and legacy BIOS
x86_64 PCs and in VM software available on Windows, macOS, and Linux.`);
  process.exit(0);
}

const engine = valueAfter("--engine", process.env.SARA_OS_CONTAINER_ENGINE || "docker");
if (!new Set(["docker", "podman"]).has(engine)) {
  throw new Error(`Unsupported container engine '${engine}'. Use docker or podman.`);
}
const outputArg = valueAfter("--output", path.join("out", "sara-os"));
const output = path.resolve(root, outputArg);
const dryRun = args.includes("--dry-run");
const force = args.includes("--force");
const noCache = args.includes("--no-cache");

if (fs.existsSync(output)) {
  const artifacts = fs.readdirSync(output).filter((name) => /\.(?:iso|sha256)$/i.test(name) || name === "build-info.json");
  if (artifacts.length && !force) {
    throw new Error(`Refusing to overwrite existing Sara OS artifacts in ${output}. Use --force or choose --output.`);
  }
  if (force) {
    for (const name of artifacts) fs.rmSync(path.join(output, name), { force: true, recursive: true });
  }
} else if (!dryRun) {
  fs.mkdirSync(output, { recursive: true });
}

function capture(command, commandArgs, fallback) {
  const result = spawnSync(command, commandArgs, { cwd: root, encoding: "utf8" });
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : fallback;
}

const revision = capture("git", ["rev-parse", "--short=12", "HEAD"], "unknown");
const sourceEpoch = capture("git", ["show", "-s", "--format=%ct", "HEAD"], "0");
const outputSpec = `type=local,dest=${output}`;
const buildArgs = [
  "build",
  "--platform", "linux/amd64",
  "--file", "os/Dockerfile",
  "--target", "artifact",
  "--output", outputSpec,
  "--build-arg", `SARA_VERSION=${pkg.version}`,
  "--build-arg", `SARA_REVISION=${revision}`,
  "--build-arg", `SOURCE_DATE_EPOCH=${sourceEpoch}`,
];
if (noCache) buildArgs.push("--no-cache");
buildArgs.push(".");

console.log(`Sara OS ${pkg.version} (${revision})`);
console.log(`${engine} ${buildArgs.map((part) => JSON.stringify(part)).join(" ")}`);
if (dryRun) process.exit(0);

const probe = spawnSync(engine, ["version"], { cwd: root, stdio: "ignore" });
if (probe.status !== 0) {
  throw new Error(`${engine} is not available. Install Docker Desktop or Podman and ensure its engine is running.`);
}

const result = spawnSync(engine, buildArgs, {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, DOCKER_BUILDKIT: process.env.DOCKER_BUILDKIT || "1" },
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const iso = fs.readdirSync(output).find((name) => name.endsWith(".iso"));
if (!iso) throw new Error(`The container build completed but no ISO was exported to ${output}.`);
console.log(`\nCreated ${path.join(output, iso)}`);
console.log(`Verify with ${path.join(output, `${iso}.sha256`)}`);
