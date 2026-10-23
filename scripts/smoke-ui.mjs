#!/usr/bin/env node
/**
 * UI smoke tests for both shells.
 *
 * Bundles the real source with esbuild (Vite's `import.meta.env` values are
 * defined), mounts each shell in jsdom with WebGL, audio, sockets and the
 * backend stubbed, and exercises the screens.
 *
 *  - mobile: the phone shell and every panel
 *  - desktop: the original full UI still mounts and keeps its controls
 *
 * It catches render crashes and regressions; real rendering, audio and touch
 * behaviour are verified on a browser/device.
 *
 *   npm run test:ui
 */
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outdir = mkdtempSync(join(tmpdir(), "sara-smoke-"));

const define = {
  __APP_VERSION__: JSON.stringify("smoke"),
  "import.meta.env": JSON.stringify({
    VITE_MYRAA_PUBLIC: "0",
    DEV: false,
    PROD: true,
    MODE: "production",
    BASE_URL: "/",
  }),
};

const suites = [
  { name: "mobile shell", entry: "scripts/smoke-mobile-entry.tsx", preload: "scripts/smoke-jsdom-preload.cjs" },
  { name: "desktop shell", entry: "scripts/smoke-desktop-entry.tsx", preload: "scripts/desk-smoke-preload.cjs" },
];

let failed = false;
for (const suite of suites) {
  const outfile = join(outdir, `${suite.entry.replace(/[^a-z]/gi, "-")}.cjs`);
  try {
    await build({
      absWorkingDir: root,
      entryPoints: [suite.entry],
      bundle: true,
      platform: "browser",
      format: "cjs",
      outfile,
      logLevel: "error",
      jsx: "automatic",
      loader: { ".tsx": "tsx", ".ts": "ts", ".css": "empty" },
      define,
    });
  } catch (error) {
    console.error(`[smoke] ${suite.name}: bundle failed — ${error.message}`);
    failed = true;
    continue;
  }
  console.log(`\n=== ${suite.name} ===`);
  const result = spawnSync(process.execPath, ["-r", join(root, suite.preload), outfile], {
    cwd: root,
    stdio: "inherit",
  });
  if (result.status !== 0) failed = true;
}

rmSync(outdir, { recursive: true, force: true });
if (failed) {
  console.error("\n[smoke] One or more UI suites failed.");
  process.exit(1);
}
console.log("\n[smoke] All UI suites passed.");
