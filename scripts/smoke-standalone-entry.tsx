/**
 * Rendered by scripts/smoke-ui.mjs: mounts the standalone Sara Mobile shell in
 * jsdom and walks its screens.
 *
 * This is a composition/crash test. It proves the app renders and its local
 * stores work; it does not claim a model answered, because there is no key and
 * no network here.
 */
import React from "react";
import { createRoot } from "react-dom/client";
import { StandaloneApp } from "../src/mobile/standalone/StandaloneApp";

const results: Array<[string, boolean]> = [];
const check = (name: string, pass: boolean) => results.push([name, pass]);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const text = () => document.body.textContent || "";
const clickByLabel = (label: string) => {
  const element = document.querySelector(`[aria-label="${label}"]`);
  if (!element) return false;
  (element as HTMLElement).dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  return true;
};
const clickByText = (needle: string) => {
  const element = Array.from(document.querySelectorAll("button")).find((node) => (node.textContent || "").trim() === needle);
  if (!element) return false;
  (element as HTMLElement).dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  return true;
};
const type = (label: string, value: string) => {
  const input = document.querySelector(`[aria-label="${label}"]`) as HTMLInputElement | null;
  if (!input) return false;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  return true;
};

async function run() {
  const root = createRoot(document.getElementById("root")!);
  root.render(React.createElement(StandaloneApp));
  await sleep(900);

  check("standalone shell renders", text().trim().length > 60 && Boolean(document.querySelector("header")));
  check("brand is Sara", text().includes("Sara"));
  check("it is labelled as the phone app", text().includes("mobile"));
  check("composer exists", Boolean(document.querySelector('input[aria-label="Message Sara"]')));
  check("microphone control exists", Boolean(document.querySelector('[aria-label="Hold to talk"]')));
  check("camera control exists", Boolean(document.querySelector('[aria-label="Look at this"]')));
  check("no key yet → setup banner", text().includes("Add your AI key to start"));

  // Every menu entry must open something.
  for (const label of ["Conversation", "Memory", "Reminders", "Look at this", "Self-check", "What this app does", "AI key"]) {
    clickByLabel("Open menu");
    await sleep(150);
    const opened = clickByText(label);
    await sleep(350);
    check(`menu item "${label}" present`, opened);
    check(`panel "${label}" opens`, Boolean(document.querySelector('[role="dialog"]')));
    clickByLabel("Close");
    await sleep(200);
  }

  // The key panel must refuse junk and store a real-looking key.
  clickByLabel("Open menu");
  await sleep(150);
  clickByText("AI key");
  await sleep(300);
  check("key panel explains where the key lives", text().includes("on this device only") || text().includes("lives on this device"));
  check("key panel links to AI Studio", Boolean(document.querySelector('a[href="https://aistudio.google.com/apikey"]')));
  type("Gemini API key", "short");
  await sleep(100);
  clickByText("Save key on this phone");
  await sleep(300);
  check("a bad key is refused", text().includes("does not look like a Google AI Studio key"));
  type("Gemini API key", "AIzaSMOKE_0123456789abcdefghijklmnop");
  await sleep(100);
  clickByText("Save key on this phone");
  await sleep(400);
  clickByLabel("Close");
  await sleep(300);
  check("banner disappears once a key is stored", !text().includes("Add your AI key to start"));
  check("key stored on the device", Boolean(window.localStorage.getItem("sara.mobile.gemini-key.v1")));

  // Memory works entirely on device.
  clickByLabel("Open menu");
  await sleep(150);
  clickByText("Memory");
  await sleep(350);
  type("New memory", "smoke test note");
  await sleep(100);
  clickByText("Save");
  await sleep(300);
  check("memory saved locally", text().includes("smoke test note"));
  clickByLabel("Close");
  await sleep(200);

  // Self-check must report the truth about this environment.
  clickByLabel("Open menu");
  await sleep(150);
  clickByText("Self-check");
  await sleep(350);
  const selfCheck = text();
  check("self-check reports the key", selfCheck.includes("AI key"));
  check("self-check reports computer control as unavailable", selfCheck.includes("Not part of this app"));
  check("self-check checks the real connection", selfCheck.includes("The connection to Google"));
  check("self-check offers a live test", selfCheck.includes("Test connection now"));
  check("self-check names the failing step instead of saying nothing", /Reach Google/.test(text()));
  check("self-check reports the speech engine truthfully", /Speech output/.test(text()));
  clickByLabel("Close");
  await sleep(200);

  // Honest limits panel.
  clickByLabel("Open menu");
  await sleep(150);
  clickByText("What this app does");
  await sleep(350);
  const limits = text();
  check("limits list what works", limits.includes("Chat with streaming answers"));
  check("limits list what needs the computer", limits.includes("Needs the computer app") && limits.includes("WhatsApp"));
  clickByLabel("Close");
  await sleep(200);

  // Settings shows persona + reality and never pretends to be the PC settings.
  clickByLabel("Open menu");
  await sleep(150);
  clickByText("Settings");
  await sleep(400);
  const settings = text();
  check("settings offers persona profiles", settings.includes("Companion") && settings.includes("Mentor"));
  check("settings offers reality modes", settings.includes("Strict"));
  check("settings says it is separate from the PC", settings.includes("separate from the PC app"));
  const modelSelect = document.querySelector('select[aria-label="Model"]') as HTMLSelectElement | null;
  check("settings lists models", Boolean(modelSelect && modelSelect.options.length >= 3));

  // Customization: colour, text size, voice and the user's own instructions.
  check("customize offers her voice controls", settings.includes("Test the voice") && settings.includes("Speaking speed"));
  check("customize offers a colour choice", Boolean(document.querySelector('[aria-label="Colour Violet"]')));
  check("customize offers text sizes", settings.includes("Largest"));
  check("customize lets the user write their own instructions", Boolean(document.querySelector('[aria-label="Custom instructions"]')));

  clickByLabel("Colour Violet");
  await sleep(200);
  const sendStyle = document.querySelector('[aria-label="Send"]')?.getAttribute("style") || "";
  check("the accent colour really reaches the send button", /167, 139, 250/.test(sendStyle));

  clickByText("Largest");
  await sleep(250);
  const shell = document.querySelector("#root > div") as HTMLElement | null;
  check("text size really scales the app", shell?.style.zoom === "1.2");

  const nameInput = document.querySelector('[aria-label="Your name"]') as HTMLInputElement | null;
  check("customize can store what she calls you", Boolean(nameInput));
  if (nameInput) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    setter?.call(nameInput, "Amol");
    nameInput.dispatchEvent(new window.Event("input", { bubbles: true }));
    await sleep(200);
    check("the nickname is saved on the phone", /"nickname":"Amol"/.test(String(window.localStorage.getItem("sara.mobile.settings.v1"))));
  }

  clickByLabel("Close");
  await sleep(250);

  // A send without a network must fail loudly, never pretend.
  type("Message Sara", "hello there");
  await sleep(100);
  clickByLabel("Send");
  await sleep(600);
  check("a failed request is reported to the user", /could not reach Google|failed|error/i.test(text()));

  const passed = results.filter(([, pass]) => pass).length;
  console.log(`[standalone] ${passed}/${results.length} checks passed`);
  for (const [name, pass] of results) console.log(`${pass ? "PASS" : "FAIL"} ${name}`);
  // The app keeps a reminder interval alive; a smoke run must still end.
  await new Promise((resolve) => root.unmount(resolve));
  process.exit(passed === results.length ? 0 : 1);
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
