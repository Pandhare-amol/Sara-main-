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
x86_64 PCs and in VM software available on Windows, macOS, and Linux.

The disposable builder container uses --privileged because Debian live-build
must mount proc/devpts inside its chroot. Sara itself never runs privileged.`);
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

function run(command, commandArgs) {
  console.log(`${command} ${commandArgs.map((part) => JSON.stringify(part)).join(" ")}`);
  if (dryRun) return;
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, DOCKER_BUILDKIT: process.env.DOCKER_BUILDKIT || "1" },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const revision = capture("git", ["rev-parse", "--short=12", "HEAD"], "unknown");
const sourceEpoch = capture("git", ["show", "-s", "--format=%ct", "HEAD"], "0");
const safeVersion = String(pkg.version).toLowerCase().replace(/[^a-z0-9_.-]+/g, "-");
const safeRevision = revision.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-");
const builderTag = `sara-os-builder:${safeVersion}-${safeRevision}`;
const buildArgs = [
  "build",
  "--platform", "linux/amd64",
  "--file", "os/Dockerfile",
  "--target", "iso-builder",
  "--tag", builderTag,
  "--build-arg", `SARA_VERSION=${pkg.version}`,
  "--build-arg", `SARA_REVISION=${revision}`,
  "--build-arg", `SOURCE_DATE_EPOCH=${sourceEpoch}`,
];
if (noCache) buildArgs.push("--no-cache");
buildArgs.push(".");

const runArgs = [
  "run",
  "--rm",
  "--privileged",
  "--platform", "linux/amd64",
  "--env", `SARA_OUTPUT_UID=${typeof process.getuid === "function" ? process.getuid() : 0}`,
  "--env", `SARA_OUTPUT_GID=${typeof process.getgid === "function" ? process.getgid() : 0}`,
  "--volume", `${output}:/out`,
  builderTag,
];

console.log(`Sara OS ${pkg.version} (${revision})`);
if (!dryRun) {
  const probe = spawnSync(engine, ["version"], { cwd: root, stdio: "ignore" });
  if (probe.status !== 0) {
    throw new Error(`${engine} is not available. Install Docker Desktop or Podman and ensure its engine is running.`);
  }
}
run(engine, buildArgs);
run(engine, runArgs);
if (dryRun) process.exit(0);

const iso = fs.readdirSync(output).find((name) => name.endsWith(".iso"));
if (!iso) throw new Error(`The container build completed but no ISO was exported to ${output}.`);
console.log(`\nCreated ${path.join(output, iso)}`);
console.log(`Verify with ${path.join(output, `${iso}.sha256`)}`);
