/**
 * Capacitor configuration for the Sara Android app.
 *
 * The APK bundles the production web build from `dist/` (never a dev server
 * URL) and talks to the Sara backend the user configures in-app over HTTPS.
 *
 * App id: ai.sara.companion  (stable; changing it makes a different app)
 */
import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "ai.sara.companion",
  appName: "Sara",
  webDir: "dist",
  // Only the web assets are copied; the Node backend is never packaged.
  android: {
    // The WebView origin scheme is set in `server.androidScheme` below: it must
    // be https so Web Audio, getUserMedia and secure storage are available.
    allowMixedContent: false,
    captureInput: true,
    webContentsDebuggingEnabled: false,
  },
  server: {
    androidScheme: "https",
    cleartext: false,
  },
  plugins: {
    StatusBar: {
      overlaysWebView: false,
      style: "DARK",
      backgroundColor: "#03040a",
    },
  },
};

export default config;
