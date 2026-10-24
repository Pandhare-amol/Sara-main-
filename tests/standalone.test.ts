/**
 * Tests for standalone Sara Mobile.
 *
 * These prove the parts that make the app honest without needing a Google key:
 * the request it builds, how it reads a stream, how it reports failures, what it
 * stores on the device, and which sentences it handles locally instead of
 * pretending the model did something.
 *
 * No test here claims a real model answered — the network is always a stub.
 */
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

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
(globalThis as unknown as { window: unknown }).window = { localStorage: storage };

const { looksLikeApiKey, maskKey, saveKey, readKey, forgetKey, describeKey } = await import("../src/mobile/standalone/deviceKey");
const { streamChat, generate, transcribe, GeminiError, textFromEnvelope } = await import("../src/mobile/standalone/gemini");
const engine = await import("../src/mobile/standalone/engine");
const store = await import("../src/mobile/standalone/store");

const KEY = "AIzaTESTKEY_0123456789abcdefghijklmnop";

function reset() {
  storage.clear();
}

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

const event = (text: string) =>
  `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] })}\n\n`;

/* ----------------------------------------------------------------------- key */

test("a real-looking key is accepted and junk is refused", () => {
  assert.equal(looksLikeApiKey(KEY), true);
  assert.equal(looksLikeApiKey("short"), false);
  assert.equal(looksLikeApiKey(`${KEY} with spaces`), false);
  assert.equal(looksLikeApiKey("x".repeat(400)), false);
});

test("the key is stored on the device and only its tail is ever shown", () => {
  reset();
  assert.equal(describeKey().present, false);
  assert.equal(saveKey(KEY), null);
  assert.equal(readKey(), KEY);
  const info = describeKey();
  assert.equal(info.present, true);
  assert.equal(info.source, "device");
  assert.ok(info.hint.endsWith(KEY.slice(-4)));
  assert.ok(!info.hint.includes(KEY.slice(0, 12)), "the hint must not leak the key");
  assert.equal(maskKey(""), "");
});

test("a malformed key is rejected with a usable message", () => {
  reset();
  const error = saveKey("nope");
  assert.match(String(error), /Google AI Studio key/);
  assert.equal(readKey(), "");
});

test("forgetting the key removes it", () => {
  reset();
  saveKey(KEY);
  forgetKey();
  assert.equal(readKey(), "");
  assert.equal(describeKey().present, false);
});

/* ------------------------------------------------------------------- requests */

test("the request carries the system instruction, history, key and SSE flag", async () => {
  let seen: { url: string; body: any; headers: any } | null = null;
  const fetchImpl = (async (url: string, init: any) => {
    seen = { url: String(url), body: JSON.parse(String(init.body)), headers: init.headers ?? {} };
    return sseResponse([event("Hello")]);
  }) as unknown as typeof fetch;

  const answer = await streamChat({
    key: KEY,
    model: "gemini-3.5-flash",
    system: "SYSTEM PROMPT",
    history: [
      { role: "user", text: "earlier question" },
      { role: "model", text: "earlier answer" },
    ],
    message: "now this",
    fetchImpl,
    onDelta: () => {},
  });

  assert.equal(answer, "Hello");
  assert.ok(seen);
  // Deliberate change from an earlier version: the key moved out of the URL and
  // into a header, so it cannot leak through logs or screenshots.
  assert.match(seen!.url, /models\/gemini-3\.5-flash:streamGenerateContent\?alt=sse$/);
  assert.doesNotMatch(seen!.url, /AIzaTESTKEY/);
  assert.equal(seen!.headers["x-goog-api-key"], KEY);
  assert.equal(seen!.body.systemInstruction.parts[0].text, "SYSTEM PROMPT");
  assert.deepEqual(
    seen!.body.contents.map((turn: any) => turn.role),
    ["user", "model", "user"],
  );
  assert.equal(seen!.body.contents.at(-1).parts[0].text, "now this");
});

test("a photo is sent inline exactly once", async () => {
  let body: any = null;
  const fetchImpl = (async (_url: string, init: any) => {
    body = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "A red mug." }] } }] }), { status: 200 });
  }) as unknown as typeof fetch;

  const answer = await generate({
    key: KEY,
    system: "vision",
    history: [],
    message: "what is this?",
    image: { mimeType: "image/jpeg", data: "BASE64DATA" },
    fetchImpl,
  });

  assert.equal(answer, "A red mug.");
  const parts = body.contents.at(-1).parts;
  assert.equal(parts.length, 2);
  assert.deepEqual(parts[1].inlineData, { mimeType: "image/jpeg", data: "BASE64DATA" });
});

test("deltas stream in order and the full answer is returned", async () => {
  const deltas: string[] = [];
  const fetchImpl = (async () =>
    sseResponse([event("Hel"), event("lo "), event("there")])) as unknown as typeof fetch;

  const answer = await streamChat({
    key: KEY,
    system: "s",
    history: [],
    message: "hi",
    fetchImpl,
    onDelta: (delta) => deltas.push(delta),
  });

  assert.deepEqual(deltas, ["Hel", "lo ", "there"]);
  assert.equal(answer, "Hello there");
});

test("events split across chunks are reassembled", async () => {
  const full = event("Split answer");
  const cut = Math.floor(full.length / 2);
  const fetchImpl = (async () => sseResponse([full.slice(0, cut), full.slice(cut)])) as unknown as typeof fetch;

  const answer = await streamChat({ key: KEY, system: "s", history: [], message: "hi", fetchImpl, onDelta: () => {} });
  assert.equal(answer, "Split answer");
});

test("a JSON error inside a stream is reported, not shown as an answer", async () => {
  const fetchImpl = (async () =>
    sseResponse([`data: ${JSON.stringify({ error: { message: "quota exceeded", status: "RESOURCE_EXHAUSTED" } })}\n\n`])) as unknown as typeof fetch;

  await assert.rejects(
    () => streamChat({ key: KEY, system: "s", history: [], message: "hi", fetchImpl, onDelta: () => {} }),
    (error: unknown) => error instanceof GeminiError && /quota exceeded/.test((error as Error).message),
  );
});

/* --------------------------------------------------------------- error mapping */

test("an invalid key is non-retryable and names the fix", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ error: { message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT" } }), {
      status: 400,
    })) as unknown as typeof fetch;

  await assert.rejects(
    () => generate({ key: "bad", system: "s", history: [], message: "hi", fetchImpl }),
    (error: unknown) => {
      const err = error as InstanceType<typeof GeminiError>;
      assert.equal(err.code, "INVALID_KEY");
      assert.equal(err.retryable, false);
      assert.match(err.message, /rejected that API key/);
      return true;
    },
  );
});

test("rate limits are retryable and say what to do", async () => {
  const fetchImpl = (async () => new Response("{}", { status: 429 })) as unknown as typeof fetch;
  await assert.rejects(
    () => generate({ key: KEY, system: "s", history: [], message: "hi", fetchImpl }),
    (error: unknown) => {
      const err = error as InstanceType<typeof GeminiError>;
      assert.equal(err.code, "RATE_LIMIT");
      assert.equal(err.retryable, true);
      return true;
    },
  );
});

test("an offline phone gets an offline message, not a stack trace", async () => {
  const fetchImpl = (async () => {
    throw new TypeError("Failed to fetch");
  }) as unknown as typeof fetch;
  await assert.rejects(
    () => generate({ key: KEY, system: "s", history: [], message: "hi", fetchImpl }),
    (error: unknown) => {
      const err = error as InstanceType<typeof GeminiError>;
      assert.equal(err.code, "OFFLINE");
      assert.match(err.message, /could not reach Google/);
      return true;
    },
  );
});

test("an empty answer is an error, never an empty bubble shown as success", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ candidates: [{ content: { parts: [] } }] }), { status: 200 })) as unknown as typeof fetch;
  await assert.rejects(
    () => generate({ key: KEY, system: "s", history: [], message: "hi", fetchImpl }),
    /empty answer/,
  );
});

test("a safety block is surfaced as a block", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ promptFeedback: { blockReason: "SAFETY" } }), { status: 200 })) as unknown as typeof fetch;
  await assert.rejects(
    () => generate({ key: KEY, system: "s", history: [], message: "hi", fetchImpl }),
    /stopped that answer \(safety\)/,
  );
});

test("envelope parsing tolerates missing parts", () => {
  assert.equal(textFromEnvelope(null), "");
  assert.equal(textFromEnvelope({}), "");
  assert.equal(textFromEnvelope({ candidates: [{ content: { parts: [{}, { text: "b" }] } }] }), "b");
});

/* ---------------------------------------------------------------- transcription */

test("a voice note is transcribed through the same key", async () => {
  let body: any = null;
  const fetchImpl = (async (_url: string, init: any) => {
    body = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "call the bank tomorrow" }] } }] }), { status: 200 });
  }) as unknown as typeof fetch;

  const text = await transcribe({ key: KEY, audio: { mimeType: "audio/webm", data: "AUDIO" }, fetchImpl });
  assert.equal(text, "call the bank tomorrow");
  assert.deepEqual(body.contents.at(-1).parts[1].inlineData, { mimeType: "audio/webm", data: "AUDIO" });
  assert.match(body.systemInstruction.parts[0].text, /transcribe/i);
});

test("unintelligible audio asks for another try instead of inventing words", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "[unclear]" }] } }] }), { status: 200 })) as unknown as typeof fetch;
  await assert.rejects(() => transcribe({ key: KEY, audio: { mimeType: "audio/webm", data: "A" }, fetchImpl }), /could not make out/);
});

/* ------------------------------------------------------------------- commands */

test("local commands are recognised before the model is called", () => {
  assert.deepEqual(engine.parseCommand("remember that my sister is Asha"), { kind: "remember", text: "my sister is Asha" });
  assert.equal(engine.parseCommand("forget my sister")?.kind, "forget");
  const remind = engine.parseCommand("remind me to call the bank at 18:30", new Date("2026-10-23T09:00:00"));
  assert.equal(remind?.kind, "remind");
  assert.equal(remind?.kind === "remind" ? remind.text : "", "call the bank");
  assert.ok(remind?.kind === "remind" && remind.dueAt?.includes("T18:30"));
  assert.equal(engine.parseCommand("how are you?"), null);
});

test("relative and rollover times are parsed honestly", () => {
  const now = new Date("2026-10-23T09:00:00");
  assert.equal(engine.parseWhen("in 20 minutes", now).dueAt, new Date("2026-10-23T09:20:00").toISOString());
  assert.equal(engine.parseWhen("in 2 hours", now).dueAt, new Date("2026-10-23T11:00:00").toISOString());
  // 08:00 has already passed today, so it means tomorrow — never the past.
  assert.equal(engine.parseWhen("at 08:00", now).dueAt, new Date("2026-10-24T08:00:00").toISOString());
  assert.equal(engine.parseWhen("sometime", now).dueAt, null);
});

/* --------------------------------------------------------------------- a turn */

test("a remember turn is saved locally and no request is made", async () => {
  reset();
  let called = false;
  const fetchImpl = (async () => {
    called = true;
    return new Response("{}");
  }) as unknown as typeof fetch;

  const result = await engine.runTurn("remember that I park on level 3", { key: KEY, fetchImpl });
  assert.equal(called, false, "a local command must not hit the network");
  assert.equal(result.handled?.kind, "remember");
  assert.match(String(result.handled?.message), /Remembered/);
  assert.equal(store.listMemories()[0].text, "I park on level 3");
  assert.equal(store.listMessages().at(-1)?.role, "sara");
});

test("a reminder is saved with its time and confirmed", async () => {
  reset();
  const now = new Date("2026-10-23T09:00:00");
  const result = await engine.runTurn("remind me to stretch in 15 minutes", {
    key: KEY,
    now,
    fetchImpl: (async () => new Response("{}")) as unknown as typeof fetch,
  });
  assert.equal(result.handled?.kind, "remind");
  assert.equal(result.handled?.saved, true);
  const saved = store.listReminders()[0];
  assert.equal(saved.text, "stretch");
  assert.equal(saved.dueAt, new Date("2026-10-23T09:15:00").toISOString());
  assert.match(String(result.handled?.message), /Reminder saved/);
});

test("a reminder with no time is stored but says so", async () => {
  reset();
  const result = await engine.runTurn("remind me to buy milk", { key: KEY, fetchImpl: (async () => new Response("{}")) as unknown as typeof fetch });
  assert.equal(result.handled?.saved, true);
  assert.match(String(result.handled?.message), /could not tell when/);
  assert.equal(store.listReminders()[0].dueAt, null);
});

test("forget removes the matching memory and says how many", async () => {
  reset();
  store.addMemory("my sister is Asha");
  store.addMemory("I park on level 3");
  const result = await engine.runTurn("forget my sister", { key: KEY, fetchImpl: (async () => new Response("{}")) as unknown as typeof fetch });
  assert.equal(result.handled?.saved, true);
  assert.match(String(result.handled?.message), /Forgotten/);
  assert.equal(store.listMemories().length, 1);
  assert.equal(store.listMemories()[0].text, "I park on level 3");
});

test("forgetting something that is not stored says nothing was forgotten", async () => {
  reset();
  const result = await engine.runTurn("forget about my car", { key: KEY, fetchImpl: (async () => new Response("{}")) as unknown as typeof fetch });
  assert.equal(result.handled?.saved, false);
  assert.match(String(result.handled?.message), /nothing to forget/);
});

test("a normal message streams, is stored, and carries memory in the prompt", async () => {
  reset();
  store.addMemory("my sister is Asha");
  let system = "";
  let historyLength = 0;
  const fetchImpl = (async (_url: string, init: any) => {
    const body = JSON.parse(String(init.body));
    system = body.systemInstruction.parts[0].text;
    historyLength = body.contents.length;
    return sseResponse([event("Hi "), event("there.")]);
  }) as unknown as typeof fetch;

  const result = await engine.runTurn("hello", { key: KEY, fetchImpl, onDelta: () => {} });
  assert.equal(result.answer, "Hi there.");
  assert.equal(result.handled, null);
  assert.match(system, /my sister is Asha/, "stored memory reaches the model");
  assert.match(system, /Never invent a memory/, "the no-invention rule is always present");
  assert.equal(historyLength, 1, "a first turn sends only the new message");
  assert.deepEqual(
    store.listMessages().map((message) => message.role),
    ["user", "sara"],
  );
});

test("the system prompt states this is a phone with no PC access", () => {
  reset();
  const prompt = engine.buildSystemPrompt({ device: { lines: ["speech output: available (replies can be read aloud)"] } });
  assert.match(prompt, /entirely on this device/i);
  assert.match(prompt, /no access to the user's computer/i);
  assert.match(prompt, /speech output: available/);
  assert.match(prompt, /PERSONA/);
  assert.match(prompt, /REALITY MODE/);
});

/* ---------------------------------------------------------------------- store */

test("memory is capped so the phone cannot fill up", () => {
  reset();
  for (let index = 0; index < store.MEMORY_LIMIT + 5; index += 1) store.addMemory(`note ${index}`);
  assert.equal(store.listMemories().length, store.MEMORY_LIMIT);
  assert.equal(store.listMemories()[0].text, `note ${store.MEMORY_LIMIT + 4}`, "newest first");
});

test("memory search matches words, not noise", () => {
  reset();
  store.addMemory("my sister is Asha, she lives in Pune");
  store.addMemory("the car needs an oil change");
  assert.equal(store.searchMemories("Asha")[0].text, "my sister is Asha, she lives in Pune");
  assert.equal(store.searchMemories("ok").length, 0, "two-letter words are ignored");
});

test("conversation is capped and clearing empties it", () => {
  reset();
  for (let index = 0; index < store.MESSAGE_LIMIT + 3; index += 1) store.appendMessage({ role: "user", text: `m${index}` });
  assert.equal(store.listMessages().length, store.MESSAGE_LIMIT);
  assert.equal(store.listMessages().at(-1)?.text, `m${store.MESSAGE_LIMIT + 2}`);
  store.clearMessages();
  assert.equal(store.listMessages().length, 0);
});

test("reminders sort open items first and due items are found", () => {
  reset();
  const now = Date.now();
  store.addReminder("later", new Date(now + 3_600_000).toISOString());
  store.addReminder("overdue", new Date(now - 60_000).toISOString());
  const done = store.addReminder("finished", new Date(now - 120_000).toISOString())!;
  store.setReminderDone(done.id, true);

  const listed = store.listReminders();
  assert.equal(listed[0].text, "overdue", "open + earlier first");
  assert.equal(listed.at(-1)?.text, "finished", "done items last");
  assert.deepEqual(
    store.dueReminders(now).map((item) => item.text),
    ["overdue"],
  );
});

test("settings default to the desktop's persona and persist a change", () => {
  reset();
  const defaults = store.loadSettings();
  assert.equal(defaults.persona.profile, "companion");
  assert.equal(defaults.reality.mode, "standard");
  assert.equal(defaults.speakReplies, true);

  store.saveSettings({ reality: { ...defaults.reality, mode: "strict" }, model: "gemini-3.1-pro-preview" });
  const saved = store.loadSettings();
  assert.equal(saved.reality.mode, "strict");
  assert.equal(saved.model, "gemini-3.1-pro-preview");
});

/* ------------------------------------------------------- transport hardening */

test("the key travels in a header, never in the URL", async () => {
  reset();
  let url = "";
  let headers: any = null;
  const fetchImpl = (async (target: string, init: any) => {
    url = String(target);
    headers = init.headers;
    return sseResponse([event("Hi")]);
  }) as unknown as typeof fetch;

  await streamChat({ key: KEY, system: "s", history: [], message: "hello", fetchImpl, onDelta: () => {} });

  assert.equal(headers["x-goog-api-key"], KEY);
  assert.ok(!url.includes(KEY), "the key must not appear in the URL");
  assert.match(url, /alt=sse/);
});

test("a header the server rejects is retried with the query form", async () => {
  reset();
  const calls: Array<{ url: string; headers: any }> = [];
  const fetchImpl = (async (target: string, init: any) => {
    calls.push({ url: String(target), headers: init.headers });
    if (calls.length === 1) {
      return new Response(JSON.stringify({ error: { message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT" } }), { status: 403 });
    }
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "recovered" }] } }] }), { status: 200 });
  }) as unknown as typeof fetch;

  const answer = await generate({ key: KEY, system: "s", history: [], message: "hello", fetchImpl });

  assert.equal(answer, "recovered");
  assert.equal(calls.length, 2);
  assert.match(calls[1].url, /\?key=/);
});

test("a dead network is tried twice, then reported with its real cause", async () => {
  reset();
  let attempts = 0;
  const fetchImpl = (async () => {
    attempts += 1;
    throw new TypeError("Failed to fetch");
  }) as unknown as typeof fetch;

  await assert.rejects(
    () => generate({ key: KEY, system: "s", history: [], message: "hi", fetchImpl }),
    (error: any) => error instanceof GeminiError && error.code === "OFFLINE" && /Failed to fetch/.test(error.detail),
  );
  assert.equal(attempts, 2, "one retry, then stop");
});

test("a WebView without streams still gets a real answer", async () => {
  reset();
  let plainRequests = 0;
  const fetchImpl = (async (target: string) => {
    if (String(target).includes(":streamGenerateContent")) {
      return new Response(null, { status: 200 }); // no body to read
    }
    plainRequests += 1;
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "plain answer" }] } }] }), { status: 200 });
  }) as unknown as typeof fetch;

  const deltas: string[] = [];
  const answer = await streamChat({ key: KEY, system: "s", history: [], message: "hi", fetchImpl, onDelta: (d) => deltas.push(d) });

  assert.equal(answer, "plain answer");
  assert.equal(plainRequests, 1);
  assert.deepEqual(deltas, ["plain answer"]);
});

/* -------------------------------------------------------------------- models */

test("the model list keeps only text-capable models and strips the prefix", async () => {
  reset();
  const { listModels } = await import("../src/mobile/standalone/gemini");
  const fetchImpl = (async (target: string) => {
    assert.match(String(target), /\/models\?pageSize=200/);
    return new Response(
      JSON.stringify({
        models: [
          { name: "models/gemini-3.5-flash", displayName: "Gemini 3.5 Flash", supportedGenerationMethods: ["generateContent", "countTokens"] },
          { name: "models/embedding-001", displayName: "Embedding", supportedGenerationMethods: ["embedContent"] },
          { name: "models/gemini-3.8-flash", supportedGenerationMethods: ["generateContent"] },
        ],
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  const result = await listModels({ key: KEY, fetchImpl });
  assert.deepEqual(result.models.map((model: any) => model.id), ["gemini-3.5-flash", "gemini-3.8-flash"]);
  assert.equal(result.models[0].displayName, "Gemini 3.5 Flash");
  assert.equal(result.models[1].displayName, "gemini-3.8-flash", "falls back to the id");
  assert.equal(result.status, 200);
});

test("the connection probe names the exact step that failed", async () => {
  reset();
  const { probeConnection } = await import("../src/mobile/standalone/gemini");

  const offline = await probeConnection({
    key: KEY,
    model: "gemini-3.5-flash",
    fetchImpl: (async () => {
      throw new TypeError("net::ERR_NAME_NOT_RESOLVED");
    }) as unknown as typeof fetch,
  });
  assert.equal(offline.ok, false);
  assert.equal(offline.steps[0].state, "ok", "Android still reports a network");
  assert.equal(offline.steps[1].id, "reach");
  assert.equal(offline.steps[1].state, "no");
  assert.match(offline.steps[1].detail, /ERR_NAME_NOT_RESOLVED/);

  const rejected = await probeConnection({
    key: KEY,
    fetchImpl: (async () =>
      new Response(JSON.stringify({ error: { message: "API key not valid", status: "INVALID_ARGUMENT" } }), { status: 403 })) as unknown as typeof fetch,
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.steps.at(-1)?.id, "key");
  assert.match(rejected.steps.at(-1)!.detail, /API key not valid/);
});

test("the live probe switches the model when the key does not have it", async () => {
  reset();
  const { probeConnection } = await import("../src/mobile/standalone/gemini");
  const fetchImpl = (async (target: string) => {
    if (String(target).includes("/models?")) {
      return new Response(JSON.stringify({ models: [{ name: "models/gemini-3.8-flash", supportedGenerationMethods: ["generateContent"] }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }), { status: 200 });
  }) as unknown as typeof fetch;

  const result = await probeConnection({ key: KEY, model: "gemini-3.5-flash", live: true, fetchImpl });
  assert.equal(result.modelKnown, false);
  assert.equal(result.steps.find((step: any) => step.id === "model")?.state, "warn");
  assert.equal(result.ok, true, "the key still works with another model");
  assert.equal(result.steps.at(-1).id, "answer");
});

/* ------------------------------------------------------------------ customize */

test("customization survives a save, clamps bad values and resets", () => {
  reset();
  const defaults = store.loadSettings();
  assert.equal(defaults.appearance.accent, "cyan");
  assert.equal(defaults.speech.rate, 1);
  assert.equal(defaults.streaming, true);

  store.saveSettings({
    appearance: { ...defaults.appearance, accent: "violet", fontScale: "l", timestamps: true },
    speech: { ...defaults.speech, rate: 1.35, voiceName: "en-us-x-sfg#female_1-local" },
    temperature: 9,
    nickname: "Amol",
  });

  const saved = store.loadSettings();
  assert.equal(saved.appearance.accent, "violet");
  assert.equal(saved.appearance.fontScale, "l");
  assert.equal(saved.appearance.timestamps, true);
  assert.equal(saved.speech.rate, 1.35);
  assert.equal(saved.speech.voiceName, "en-us-x-sfg#female_1-local");
  assert.equal(saved.temperature, 2, "out-of-range creativity is clamped");
  assert.equal(saved.nickname, "Amol");

  const restored = store.resetSettings();
  assert.equal(restored.appearance.accent, "cyan");
  assert.equal(restored.nickname, "");
});

test("a half-written settings blob cannot break the app", () => {
  reset();
  storage.setItem("sara.mobile.settings.v1", JSON.stringify({ appearance: { accent: "chartreuse" }, speech: { rate: "fast" }, model: 42 }));
  const loaded = store.loadSettings();
  assert.equal(loaded.appearance.accent, "cyan", "unknown accent falls back");
  assert.equal(loaded.speech.rate, 1, "non-numeric rate falls back");
  assert.equal(loaded.model, "gemini-3.5-flash");
  assert.equal(loaded.appearance.backdrop, "deep");
});

test("a failed send can take its message back out of the log", () => {
  reset();
  store.appendMessage({ role: "user", text: "hello" });
  store.appendMessage({ role: "sara", text: "hi" });
  store.appendMessage({ role: "user", text: "retry me" });
  assert.equal(store.removeLastMessage("user"), true);
  assert.deepEqual(store.listMessages().map((message) => message.text), ["hello", "hi"]);
  assert.equal(store.removeLastMessage("user"), true);
  assert.equal(store.removeLastMessage("user"), false);
});

test("erasing everything leaves no key, memory or conversation", () => {
  reset();
  saveKey(KEY);
  store.addMemory("something");
  store.appendMessage({ role: "user", text: "hello" });
  store.clearAllData();
  assert.deepEqual(store.listMemories(), []);
  assert.deepEqual(store.listMessages(), []);
});
