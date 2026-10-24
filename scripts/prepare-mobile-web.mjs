#!/usr/bin/env node
/**
 * Turns the standalone build into something a WebView can load.
 *
 * Vite emits `mobile.html` (so the desktop build keeps `index.html`); Capacitor
 * loads `index.html`, so this copies it and drops the original. Nothing else is
 * rewritten: the asset URLs the build produced are already absolute.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, "dist-mobile");
const index = path.join(dist, "index.html");

if (!fs.existsSync(path.join(dist, "mobile.html"))) {
  console.error("[mobile-web] dist-mobile/mobile.html is missing — run the mobile build first.");
  process.exit(1);
}
fs.copyFileSync(path.join(dist, "mobile.html"), index);
fs.unlinkSync(path.join(dist, "mobile.html"));

const html = fs.readFileSync(index, "utf8");
if (!html.includes("<div id=\"root\">")) {
  console.error("[mobile-web] index.html has no #root element.");
  process.exit(1);
}
if (/src="\/src\//.test(html)) {
  console.error("[mobile-web] index.html still points at the dev server sources.");
  process.exit(1);
}
/**
 * Separation guard.
 *
 * The standalone app must not be able to reach a Sara server: there is none in
 * this build. If a future change pulls the server client (or a desktop panel)
 * into the standalone tree, these strings would appear and the build fails here
 * instead of shipping an app that silently depends on a computer.
 */
const forbidden = ["/api/", "sara.server.v1", "saraFetch", "wsUrl("];
const assetsDir = path.join(dist, "assets");
const bundles = fs.readdirSync(assetsDir).filter((name) => name.endsWith(".js"));
const offenders = [];
for (const name of bundles) {
  const source = fs.readFileSync(path.join(assetsDir, name), "utf8");
  for (const needle of forbidden) {
    if (source.includes(needle)) offenders.push(`${name} contains "${needle}"`);
  }
}
if (offenders.length) {
  console.error("[mobile-web] the standalone bundle depends on a Sara server:");
  offenders.forEach((line) => console.error(`  - ${line}`));
  process.exit(1);
}

console.log(`[mobile-web] dist-mobile/index.html ready (${bundles.length} bundle(s), no server dependencies)`);
