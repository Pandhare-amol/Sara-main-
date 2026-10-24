/**
 * Desktop regression smoke test (scripts/smoke-ui.mjs).
 *
 * Mounts the original full-size Sara UI with a stubbed backend and checks that
 * the shell, header controls and text composer still render. WebGL and audio are
 * stubbed; this is a composition test, not a visual one.
 */
import React from "react";
import { createRoot } from "react-dom/client";
import App from "../src/App";

const root = createRoot(document.getElementById("root")!);
root.render(React.createElement(App));
setTimeout(() => {
  const text = document.body.textContent || "";
  const html = document.body.innerHTML;
  const checks: Array<[string, boolean]> = [
    ["desktop shell renders", html.length > 1000],
    ["brand", text.includes("Sara")],
    ["topics control", text.includes("TOPICS")],
    ["memory control", text.includes("RECALLS")],
    ["settings control", text.includes("SETTINGS")],
    ["text composer", html.includes('aria-label="Message Sara"')],
  ];
  for (const [name, pass] of checks) console.log(`${pass ? "PASS" : "FAIL"} ${name}`);
  console.log(`\n${checks.filter(([, pass]) => pass).length}/${checks.length} checks passed`);
  process.exit(checks.every(([, pass]) => pass) ? 0 : 1);
}, 1_500);
