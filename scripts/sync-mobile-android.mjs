#!/usr/bin/env node
/**
 * Copies the standalone web build into the standalone Android project.
 *
 * `npx cap sync` targets the `android/` folder by name, so this project (which
 * must stay separate, with its own applicationId) is assembled explicitly
 * instead: web assets in, Capacitor's runtime config written, nothing generated
 * from the desktop app's state.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const from = path.join(root, "dist-mobile");
const assets = path.join(root, "android-mobile", "app", "src", "main", "assets");
const to = path.join(assets, "public");

if (!fs.existsSync(path.join(from, "index.html"))) {
  console.error("[mobile-sync] dist-mobile/index.html missing — run `npm run build:mobile` first.");
  process.exit(1);
}

fs.rmSync(to, { recursive: true, force: true });
fs.mkdirSync(to, { recursive: true });
fs.cpSync(from, to, { recursive: true });

const config = {
  appId: "ai.sara.mobile",
  appName: "Sara Mobile",
  webDir: "public",
  loggingBehavior: "debug",
  server: { androidScheme: "https" },
  plugins: {
    StatusBar: { overlaysWebView: false, style: "DARK", backgroundColor: "#03040a" },
  },
};
fs.writeFileSync(path.join(assets, "capacitor.config.json"), JSON.stringify(config, null, 2));

const files = fs.readdirSync(to);
console.log(`[mobile-sync] copied ${files.length} entries into android-mobile/app/src/main/assets/public`);
