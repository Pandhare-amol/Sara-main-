/**
 * Rendered by scripts/smoke-mobile-ui.mjs: mounts the phone shell in jsdom and
 * exercises the menu + panels. This is a crash/composition test, not a
 * pixel test — real WebGL, audio and touch behaviour are verified on a device.
 */
import React from "react";
import { createRoot } from "react-dom/client";
import { MobileApp } from "../src/mobile/MobileApp";

const results: Array<[string, boolean]> = [];
const check = (name: string, pass: boolean) => results.push([name, pass]);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const clickByLabel = (label: string) => {
  const element = document.querySelector(`[aria-label="${label}"]`);
  if (!element) return false;
  (element as HTMLElement).dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  return true;
};
const clickByText = (text: string) => {
  const element = Array.from(document.querySelectorAll("button")).find(
    (node) => (node.textContent || "").trim() === text,
  );
  if (!element) return false;
  (element as HTMLElement).dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  return true;
};

async function run() {
  const root = createRoot(document.getElementById("root")!);
  root.render(React.createElement(MobileApp));
  await sleep(1_200);

  const html = () => document.body.innerHTML;
  check("phone shell renders", html().length > 500);
  check("brand is Sara", html().includes("Sara"));
  check("text composer exists", Boolean(document.querySelector('[aria-label="Message Sara"]')));
  check("microphone control exists", Boolean(document.querySelector('[aria-label="Start voice session"]')));
  check("composer is usable without a live session", Boolean(document.querySelector('input[aria-label="Message Sara"]')));

  // Bottom-bar panels.
  for (const [control, panelTitle] of [
    ["Open conversation history", "Conversation"],
    ["Open missions", "Missions"],
  ] as const) {
    clickByLabel(control);
    await sleep(400);
    const opened = html().includes(panelTitle);
    check(`panel "${panelTitle}" opens`, opened);
    if (!opened && process.env.SARA_SMOKE_DEBUG) console.log((document.body.textContent || "").slice(-600));
    clickByLabel("Close");
    await sleep(200);
  }

  // Menu-driven panels.
  for (const panelTitle of ["Today", "Calls", "Automations", "Look at this", "How she talks", "Memory", "Connection", "Settings", "Self-check", "Help & diagnostics"]) {
    clickByLabel("Open menu");
    await sleep(150);
    check(`menu item "${panelTitle}" present`, clickByText(panelTitle));
    await sleep(400);
    check(`panel "${panelTitle}" opens`, (document.body.textContent || "").includes(panelTitle));
    clickByLabel("Close");
    await sleep(200);
  }

  // The composed briefing must show real content, not an empty shell.
  clickByLabel("Open menu");
  await sleep(150);
  clickByText("Today");
  await sleep(500);
  const briefText = document.body.textContent || "";
  check("briefing shows the greeting", briefText.includes("Two things need you today"));
  check("briefing lists a reminder", briefText.includes("Call the bank"));
  check("briefing asks for approval", briefText.includes("Waiting for your approval"));
  check("briefing names its sources", briefText.includes("sources:"));
  clickByLabel("Close");
  await sleep(200);

  // Vision: the capture controls exist and a missing photo keeps Ask disabled.
  clickByLabel("Open menu");
  await sleep(150);
  clickByText("Look at this");
  await sleep(400);
  check("vision offers camera capture", Boolean(document.querySelector('input[capture="environment"]')));
  const askButton = Array.from(document.querySelectorAll("button")).find((n) => (n.textContent || "").includes("Ask Sara"));
  check("vision cannot ask without a photo", Boolean(askButton && (askButton as HTMLButtonElement).disabled));
  clickByLabel("Close");
  await sleep(200);

  // Persona: profiles come from the real settings payload.
  clickByLabel("Open menu");
  await sleep(150);
  clickByText("How she talks");
  await sleep(500);
  const personaText = document.body.textContent || "";
  check("persona panel lists profiles", personaText.includes("Companion") && personaText.includes("Executive"));
  check("persona panel lists reality modes", personaText.includes("Strict"));
  clickByLabel("Close");
  await sleep(200);

  // Calls: the live call is shown with its policy reason and the two actions.
  clickByLabel("Open menu");
  await sleep(150);
  clickByText("Calls");
  await sleep(500);
  const callText = document.body.textContent || "";
  check("calls panel shows the ringing caller", callText.includes("Rahul"));
  check("calls panel explains the policy", callText.includes("policy says ask"));
  check("calls panel offers answer and decline", callText.includes("Answer") && callText.includes("Decline"));
  check("calls panel refuses to fake unknown-caller answering", callText.includes("never answers an unknown number"));
  clickByLabel("Close");
  await sleep(200);

  // Stop: two-step arming, never a single accidental tap.
  clickByLabel("Open menu");
  await sleep(150);
  check("stop entry in menu", clickByText("Stop everything"));
  await sleep(400);
  check("stop arms before firing", Boolean(Array.from(document.querySelectorAll("button")).find((n) => (n.textContent || "").includes("Arm stop"))));
  check("stop has no immediate action", !Array.from(document.querySelectorAll("button")).some((n) => (n.textContent || "").includes("Yes, stop everything")));
  clickByLabel("Close");
  await sleep(200);

  let failed = 0;
  for (const [name, pass] of results) {
    console.log(`${pass ? "PASS" : "FAIL"} ${name}`);
    if (!pass) failed += 1;
  }
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((error) => {
  console.error("Smoke test crashed:", error);
  process.exit(1);
});
