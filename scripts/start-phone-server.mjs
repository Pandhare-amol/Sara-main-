#!/usr/bin/env node
/**
 * Start Sara so the Android app can connect to this PC.
 *
 * What it does:
 *  - creates (or reuses) an access token in `.sara-phone.json` next to this repo
 *    — the file is git-ignored and never leaves the machine;
 *  - binds the server to all interfaces so the phone can reach it over the LAN;
 *  - prints every LAN address the phone can use, plus the token to paste into
 *    the app's Connection screen;
 *  - then runs the normal server (`tsx server.ts`) in the foreground.
 *
 * Remote access stays opt-in: without this script the server keeps its original
 * local-only behaviour. Desktop control from the phone remains separate
 * (`--allow-desktop` sets SARA_REMOTE_ALLOW_DESKTOP=1), because a phone holding
 * a chat session should not silently be able to drive the PC.
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const stateFile = path.join(root, ".sara-phone.json");
const args = new Set(process.argv.slice(2));
const allowDesktop = args.has("--allow-desktop");
const port = Number(process.env.MYRAA_PORT || process.env.PORT || 3000);

function loadOrCreateToken() {
  try {
    const saved = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    if (saved?.token && String(saved.token).length >= 24) return { token: saved.token, fresh: false };
  } catch {
    /* first run, or the file was deleted */
  }
  const token = randomBytes(24).toString("base64url");
  fs.writeFileSync(stateFile, JSON.stringify({ token, createdAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  return { token, fresh: true };
}

function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const info of list ?? []) {
      if (info.family !== "IPv4" || info.internal) continue;
      out.push({ name, address: info.address });
    }
  }
  return out;
}

const { token, fresh } = loadOrCreateToken();
const addresses = lanAddresses();

console.log("");
console.log("  Sara — phone access");
console.log("  ───────────────────");
console.log(`  Token:  ${token}`);
console.log(`  ${fresh ? "New token created" : "Existing token"}: ${path.relative(process.cwd(), stateFile)} (private, git-ignored)`);
console.log("");
if (addresses.length === 0) {
  console.log("  No LAN address found. Connect this PC to Wi-Fi/Ethernet and run again.");
} else {
  console.log("  In the Android app → Connection, enter one of:");
  for (const { name, address } of addresses) console.log(`    http://${address}:${port}    (${name})`);
}
console.log("");
console.log("  Then paste the token. Keep this window open while you use the phone.");
console.log(`  Desktop control from the phone: ${allowDesktop ? "ENABLED for this run" : "disabled (rerun with --allow-desktop to allow it)"}`);
console.log("");

const env = {
  ...process.env,
  PORT: String(port),
  SARA_REMOTE_ACCESS: "1",
  SARA_ACCESS_TOKEN: token,
  SARA_HOST: "0.0.0.0",
  ...(allowDesktop ? { SARA_REMOTE_ALLOW_DESKTOP: "1" } : {}),
};

const child = spawn(process.platform === "win32" ? "npx.cmd" : "npx", ["tsx", "server.ts"], {
  cwd: root,
  env,
  stdio: "inherit",
  // Node refuses to spawn a .cmd file without a shell on Windows.
  shell: process.platform === "win32",
});

const stop = (signal) => {
  if (!child.killed) child.kill(signal);
};
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
child.on("exit", (code) => process.exit(code ?? 0));

// A stable, non-secret fingerprint so logs can be compared without printing the
// token again.
console.log(`  token fingerprint: ${createHash("sha256").update(token).digest("hex").slice(0, 8)}`);
