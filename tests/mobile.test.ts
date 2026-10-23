/**
 * Tests for the mobile-only frontend helpers that can run without a browser:
 * backend URL resolution, token handling, the device conversation log and the
 * emotion cue. DOM-dependent components are covered by the production build
 * and the browser smoke test instead.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

/** Minimal browser shims, installed before the modules are imported. */
class MemoryStorage {
  private data = new Map<string, string>();
  getItem(key: string) {
    return this.data.has(key) ? (this.data.get(key) as string) : null;
  }
  setItem(key: string, value: string) {
    this.data.set(key, String(value));
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
  clear() {
    this.data.clear();
  }
}

const storage = new MemoryStorage();
const events = new EventTarget();
(globalThis as unknown as { window: unknown }).window = {
  localStorage: storage,
  location: { protocol: "https:", host: "app.example.com" },
  Capacitor: { isNativePlatform: () => nativeFlag },
  addEventListener: events.addEventListener.bind(events),
  removeEventListener: events.removeEventListener.bind(events),
  dispatchEvent: events.dispatchEvent.bind(events),
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
};
let nativeFlag = false;

const { apiUrl, assetUrl, authHeaders, clearServerConfig, getServerConfig, isNativeApp, needsServerSetup, saveServerConfig, wsUrl } =
  await import("../src/lib/serverConfig");
const { appendConversation, clearConversation, listConversation, latestMessage } = await import("../src/lib/conversationLog");
const { detectEmotionFromText } = await import("../src/lib/emotion");

test("defaults to the same origin so the desktop app is unchanged", () => {
  clearServerConfig();
  assert.equal(getServerConfig().apiBase, "");
  assert.equal(getServerConfig().token, "");
  assert.equal(apiUrl("/api/health"), "/api/health");
  assert.equal(wsUrl("/live"), "wss://app.example.com/live");
  assert.deepEqual(authHeaders(), {});
  assert.equal(isNativeApp(), false);
  assert.equal(needsServerSetup(), false);
});

test("a configured backend is used for REST, assets and sockets", () => {
  saveServerConfig({ apiBase: "https://sara.example.com/", token: "secret-token" });
  assert.equal(getServerConfig().apiBase, "https://sara.example.com");
  assert.equal(apiUrl("/api/config"), "https://sara.example.com/api/config");
  assert.equal(apiUrl("api/config"), "https://sara.example.com/api/config");
  assert.equal(assetUrl("/user-characters/a/model.pmx"), "https://sara.example.com/user-characters/a/model.pmx?access_token=secret-token");
  assert.equal(wsUrl("/live"), "wss://sara.example.com/live?access_token=secret-token");
  assert.equal(wsUrl("/events"), "wss://sara.example.com/events?access_token=secret-token");
  assert.deepEqual(authHeaders({ "Content-Type": "application/json" }), {
    "Content-Type": "application/json",
    Authorization: "Bearer secret-token",
  });
});

test("a bare host is upgraded to https and junk is rejected", () => {
  saveServerConfig({ apiBase: "sara.example.com", token: "" });
  assert.equal(getServerConfig().apiBase, "https://sara.example.com");
  saveServerConfig({ apiBase: "not a url", token: "" });
  assert.equal(getServerConfig().apiBase, "");
});

test("native builds without a backend report that setup is needed", () => {
  nativeFlag = true;
  clearServerConfig();
  assert.equal(isNativeApp(), true);
  assert.equal(needsServerSetup(), true);
  saveServerConfig({ apiBase: "https://sara.example.com", token: "t" });
  assert.equal(needsServerSetup(), false);
  nativeFlag = false;
  clearServerConfig();
});

test("conversation log keeps order, merges streaming fragments and clears", () => {
  clearConversation();
  const start = Date.now();
  appendConversation("user", "hello", start);
  appendConversation("sara", "Hi there", start + 500);
  appendConversation("sara", "Hi there, how are you?", start + 900); // same turn, streamed
  appendConversation("user", "   ", start + 1000); // ignored
  appendConversation("user", "tell me a joke", start + 30_000);

  const entries = listConversation();
  assert.equal(entries.length, 3);
  assert.equal(entries[0].role, "user");
  assert.equal(entries[1].text, "Hi there, how are you?");
  assert.equal(latestMessage()?.text, "tell me a joke");
  assert.equal(latestMessage("sara")?.text, "Hi there, how are you?");

  clearConversation();
  assert.equal(listConversation().length, 0);
});

test("emotion cue maps text to an expression, defaulting to idle", () => {
  assert.equal(detectEmotionFromText("haha that is funny"), "playful");
  assert.equal(detectEmotionFromText("I love this"), "happy");
  assert.equal(detectEmotionFromText("stop"), "idle");
});
