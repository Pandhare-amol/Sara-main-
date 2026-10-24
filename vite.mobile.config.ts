/**
 * Build config for the standalone Sara Mobile bundle.
 *
 * Separate from the desktop/mobile-client build on purpose: only `mobile.html`
 * and the standalone tree are compiled, into `dist-mobile`, so the phone app can
 * never accidentally pull in the server client, the desktop UI or the character
 * studio.
 */
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import fs from "fs";
import path from "path";
import { defineConfig } from "vite";

const appVersion = JSON.parse(fs.readFileSync(path.resolve(__dirname, "package.json"), "utf8")).version as string;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  build: {
    outDir: "dist-mobile",
    emptyOutDir: true,
    rollupOptions: {
      input: path.resolve(__dirname, "mobile.html"),
    },
    chunkSizeWarningLimit: 900,
  },
  server: {
    hmr: process.env.DISABLE_HMR !== "true",
  },
});
