/**
 * Tests for the persona/reality prompt engine and the mobile composition layer.
 *
 * These are the parts of the phone experience that must be provably honest:
 * tone directives may never grant permissions, and the briefing/diagnostics
 * builders must surface uncertainty instead of inventing it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_PERSONA,
  DEFAULT_REALITY,
  PERSONA_DIMENSIONS,
  PERSONA_PROFILES,
  describeLevel,
  personaBlock,
  personaDirective,
  realityDirective,
  visionDirective,
} from "../server_persona";
import {
  MinuteLimiter,
  VISION_LIMITS,
  buildAutomations,
  buildBriefing,
  buildDiagnostics,
  greetingFor,
  validateVisionBody,
} from "../server_mobileApi";
import { normalizeSettings, type AppSettings } from "../settings/appSettings";

const NOW = new Date("2026-10-23T09:00:00.000Z").getTime();

function settings(): AppSettings {
  return normalizeSettings({});
}

/* ------------------------------------------------------------------ persona */

test("every profile has a directive and defined dimensions", () => {
  for (const [id, profile] of Object.entries(PERSONA_PROFILES)) {
    assert.equal(profile.id, id);
    assert.ok(profile.directive.length > 40, `${id} needs a real directive`);
    for (const { key } of PERSONA_DIMENSIONS) {
      const value = profile.preset[key];
      assert.equal(typeof value, "number", `${id}.${key} must be a number`);
      assert.ok(value >= 0 && value <= 100, `${id}.${key} must be 0-100`);
    }
  }
});

test("persona directives never claim permissions or knowledge", () => {
  for (const id of Object.keys(PERSONA_PROFILES)) {
    const block = personaBlock({ ...DEFAULT_PERSONA, profile: id as keyof typeof PERSONA_PROFILES }, DEFAULT_REALITY);
    // A tone instruction must not be able to widen what she may do.
    assert.ok(!/you may now|ignore (the )?polic|skip (the )?confirm|without asking/i.test(block), `${id} leaks a permission`);
  }
});

test("persona directive reflects the configured dimensions", () => {
  const warm = personaDirective({ ...DEFAULT_PERSONA, warmth: 95, formality: 5 });
  const cold = personaDirective({ ...DEFAULT_PERSONA, warmth: 5, formality: 95 });
  assert.notEqual(warm, cold);
  assert.match(warm, /warmth/i);
});

test("describeLevel bands the 0-100 scale", () => {
  assert.equal(describeLevel(0), "very low");
  assert.equal(describeLevel(25), "low");
  assert.equal(describeLevel(50), "moderate");
  assert.equal(describeLevel(75), "high");
  assert.equal(describeLevel(100), "very high");
});

test("reality off drops the labelling taxonomy but keeps the no-invention rule", () => {
  const off = realityDirective({ mode: "off", challengeAssumptions: true });
  assert.ok(off.length > 0);
  assert.ok(!off.includes("PREDICTION"), "off mode must not impose the taxonomy");
  assert.match(off, /unknown|never invent/i);
});

test("strict reality mode demands fact/assumption separation and confidence", () => {
  const strict = realityDirective({ mode: "strict", challengeAssumptions: true });
  for (const word of ["FACT", "ASSUMPTION", "PREDICTION", "RECOMMENDATION", "UNKNOWN", "CONFIDENCE"]) {
    assert.ok(strict.includes(word), `strict mode must mention ${word}`);
  }
  assert.match(strict, /evidence against|counter-evidence|contradict/i);
  assert.match(strict, /premise/i);
});

test("standard reality mode stays lighter than strict", () => {
  const standard = realityDirective({ mode: "standard", challengeAssumptions: false });
  const strict = realityDirective({ mode: "strict", challengeAssumptions: true });
  assert.ok(standard.length > 0 && standard.length < strict.length);
});

test("personaBlock always ends with the non-negotiable safety line", () => {
  const block = personaBlock(DEFAULT_PERSONA, DEFAULT_REALITY);
  assert.match(block, /delivery|tone/i);
  assert.match(block, /permission|confirm/i);
});

test("personaBlock tolerates missing settings", () => {
  assert.doesNotThrow(() => personaBlock(null, null));
  assert.ok(personaBlock(undefined, undefined).length > 0);
});

test("vision directive inherits the reality mode", () => {
  assert.match(visionDirective({ mode: "strict", challengeAssumptions: true }), /confidence|uncertain/i);
});

/* ----------------------------------------------------------------- settings */

test("settings default to companion + standard reality", () => {
  const s = settings();
  assert.equal(s.persona.profile, "companion");
  assert.equal(s.reality.mode, "standard");
  assert.equal(s.reality.challengeAssumptions, true);
});

test("normalizeSettings clamps persona sliders and rejects unknown enums", () => {
  const s = normalizeSettings({ persona: { warmth: 500, humor: -20, profile: "wizard" }, reality: { mode: "extreme" } });
  assert.equal(s.persona.warmth, 100);
  assert.equal(s.persona.humor, 0);
  assert.equal(s.persona.profile, DEFAULT_PERSONA.profile);
  assert.equal(s.reality.mode, DEFAULT_REALITY.mode);
});

/* ----------------------------------------------------------------- briefing */

const task = (over: Record<string, unknown>) =>
  ({ id: "t1", goal: "Do the thing", state: "running", ...over }) as never;

test("briefing counts what needs the user, not everything it knows", () => {
  const briefing = buildBriefing({
    now: NOW,
    tasks: [
      task({ id: "a", state: "running" }),
      task({ id: "b", state: "waiting_user", pendingQuestion: { text: "Which folder?" } }),
      task({ id: "c", state: "completed", updatedAt: new Date(NOW - 60_000).toISOString() }),
      task({ id: "d", state: "completed", updatedAt: new Date(NOW - 3 * 86_400_000).toISOString() }),
    ],
    confirmations: [{ id: "c1", title: "Send message", description: "WhatsApp", capability: "messaging", createdAt: new Date(NOW).toISOString() }],
    utilities: [],
    goals: [{ id: "g1", title: "Ship v2", status: "active", progress: 40 }],
    settings: settings(),
    agent: { online: true, tool_count: 42 },
    memoryCount: 7,
    remoteAccess: true,
    allowDesktopTools: false,
  });

  assert.equal(briefing.counts.activeTasks, 2);
  assert.equal(briefing.counts.needsYou, 2, "one waiting task + one confirmation");
  assert.equal(briefing.counts.finishedToday, 1, "only today's finished task counts");
  assert.equal(briefing.counts.memories, 7);
  assert.equal(briefing.activeTasks.find((t) => t.id === "b")?.waitingQuestion, "Which folder?");
  assert.equal(briefing.pc.availableFromThisDevice, false);
  assert.ok(briefing.notes.some((note) => /desktop|PC/i.test(note)), "must explain why PC control is unavailable");
});

test("briefing marks PC control unavailable when the agent is offline", () => {
  const briefing = buildBriefing({
    now: NOW,
    tasks: [],
    confirmations: [],
    utilities: [],
    goals: [],
    settings: settings(),
    agent: { online: false },
    memoryCount: 0,
    remoteAccess: false,
    allowDesktopTools: true,
  });
  assert.equal(briefing.pc.agentOnline, false);
  assert.equal(briefing.pc.availableFromThisDevice, false);
  assert.ok(briefing.notes.length > 0);
});

test("briefing surfaces only today's reminders and sorts them", () => {
  const later = NOW + 5 * 60_000;
  const tomorrow = NOW + 30 * 3600_000;
  const briefing = buildBriefing({
    now: NOW,
    tasks: [],
    confirmations: [],
    utilities: [
      { id: "u2", kind: "reminder", label: "Later", dueAt: later, repeat: "none", status: "scheduled" },
      { id: "u3", kind: "reminder", label: "Tomorrow", dueAt: tomorrow, repeat: "daily", status: "scheduled" },
      { id: "u4", kind: "timer", label: "Done", dueAt: NOW - 1000, repeat: "none", status: "completed" },
    ],
    goals: [],
    settings: settings(),
    agent: { online: true, tool_count: 1 },
    memoryCount: 0,
    remoteAccess: true,
    allowDesktopTools: true,
  });
  assert.deepEqual(briefing.nextReminders.map((item) => item.id), ["u2"]);
});

test("greeting changes with the time of day", () => {
  const morning = greetingFor(new Date("2026-10-23T03:30:00").getTime());
  const night = greetingFor(new Date("2026-10-23T23:30:00").getTime());
  assert.notEqual(morning, night);
});

/* -------------------------------------------------------------- diagnostics */

test("diagnostics degrade honestly without a key or agent", () => {
  const report = buildDiagnostics({
    version: "1.5.2",
    hasApiKey: false,
    models: { selection: {}, models: [] },
    agent: { online: false },
    memoryCount: 0,
    utilities: 0,
    remoteAccess: false,
    allowDesktopTools: false,
    realityMode: "standard",
  });
  const gemini = report.items.find((item) => item.id === "gemini");
  assert.equal(gemini?.state, "attention");
  assert.ok(gemini?.action);
  assert.equal(report.items.find((item) => item.id === "desktop-agent")?.state, "offline");
  assert.notEqual(report.overall, "ok");
});

test("diagnostics is ok when the core path is healthy", () => {
  const report = buildDiagnostics({
    version: "1.5.2",
    hasApiKey: true,
    models: { selection: { brain: "gemini-2.5-flash" }, models: [{ id: "gemini-2.5-flash", availability: "available" }] },
    agent: { online: true, tool_count: 42 },
    memoryCount: 3,
    utilities: 2,
    remoteAccess: true,
    allowDesktopTools: true,
    realityMode: "strict",
  });
  assert.equal(report.overall, "ok");
  assert.ok(report.items.length >= 4);
  assert.ok(report.items.every((item) => item.detail.length > 0));
});

/* -------------------------------------------------------------- automations */

test("automations reports real schedules and refuses to fake monitors", () => {
  const data = buildAutomations({
    now: NOW,
    utilities: [
      { id: "u1", kind: "alarm", label: "Stand up", dueAt: NOW + 60_000, repeat: "weekdays", status: "scheduled" },
      { id: "u2", kind: "timer", label: "Tea", dueAt: NOW - 60_000, repeat: "none", status: "completed" },
    ],
    goals: [{ id: "g1", description: "Learn Rust" }],
    skills: [{ name: "Rename files" }, {}],
    audit: [{ at: new Date(NOW).toISOString(), taskId: "t1", kind: "tool", summary: "Opened Notepad" }],
  });
  assert.equal(data.scheduled.length, 1);
  assert.equal(data.repeating, 1);
  assert.equal(data.activity[0].summary, "Opened Notepad");
  assert.equal(data.skills.length, 2);
  assert.ok(data.skills.every((skill) => skill.id.length > 0 && skill.name.length > 0));
  assert.ok(data.notes.some((note) => /not implemented/i.test(note)), "must admit what does not exist");
});

/* ------------------------------------------------------------------- vision */

test("vision rejects empty, oversized and unsupported payloads", () => {
  assert.equal(validateVisionBody(null).ok, false);
  const empty = validateVisionBody({});
  assert.equal(empty.ok, false);
  assert.equal(empty.ok === false && empty.status, 400);

  const huge = validateVisionBody({ image: "A".repeat(VISION_LIMITS.maxBase64Chars + 1) });
  assert.equal(huge.ok === false && huge.status, 413);

  const gif = validateVisionBody({ image: "A".repeat(200), mimeType: "image/gif" });
  assert.equal(gif.ok === false && gif.status, 415);

  const junk = validateVisionBody({ image: "!!!! not base64 !!!!", mimeType: "image/png" });
  assert.equal(junk.ok, false);
});

test("vision accepts a data URL and normalises it", () => {
  const result = validateVisionBody({ image: `data:image/png;base64,${"A".repeat(120)}`, mimeType: "image/png", question: "  what is this?  " });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.mimeType, "image/png");
    assert.equal(result.question, "what is this?");
    assert.ok(!result.data.startsWith("data:"));
  }
});

test("vision supplies a default question", () => {
  const result = validateVisionBody({ image: "A".repeat(120) });
  assert.ok(result.ok && result.question.length > 10);
});

test("MinuteLimiter caps the expensive call", () => {
  let now = 0;
  const limiter = new MinuteLimiter(3, () => now);
  assert.equal(limiter.take(), true);
  assert.equal(limiter.take(), true);
  assert.equal(limiter.take(), true);
  assert.equal(limiter.take(), false);
  now = 61_000;
  assert.equal(limiter.take(), true, "window slides");
});
