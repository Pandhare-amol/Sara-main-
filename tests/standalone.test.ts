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
  let seen: { url: string; body: any } | null = null;
  const fetchImpl = (async (url: string, init: any) => {
    seen = { url: String(url), body: JSON.parse(String(init.body)) };
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
  assert.match(seen!.url, /models\/gemini-3\.5-flash:streamGenerateContent\?key=/);
  assert.match(seen!.url, /alt=sse/);
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
