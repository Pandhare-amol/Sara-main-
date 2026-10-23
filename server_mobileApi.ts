/**
 * Sara Mobile API — a thin composition layer over subsystems that already
 * exist. It adds no new brain, no second memory store and no parallel policy:
 * every number below is read from the runtime, the cognition stores, the
 * permission broker or the audit log, and every response names its sources.
 *
 *   GET  /api/mobile/briefing     one round-trip for the phone home screen
 *   GET  /api/mobile/diagnostics  self-diagnostics with a suggested action
 *   GET  /api/mobile/automations  reminders, goals, learned skills, activity
 *   POST /api/mobile/vision       camera/document understanding (Gemini)
 *   POST /api/mobile/stop         emergency stop + deny pending approvals
 *
 * The builders are pure and exported, so they can be unit-tested without a
 * server, a model key or a PC.
 */
import type { Express, Request, Response } from "express";
import { personaDirective, realityDirective, visionDirective } from "./server_persona";
import type { AppSettings } from "./settings/appSettings";

/* ------------------------------------------------------------------ types */

export interface TaskLike {
  id: string;
  goal: string;
  state: string;
  currentStatus?: string;
  updatedAt?: string;
  startedAt?: string;
  result?: string | null;
  error?: string | null;
  pendingQuestion?: { text: string } | null;
  pendingConfirmation?: { description: string } | null;
  plan?: { summary: string; steps: Array<{ text: string; status: string }> } | null;
  actions?: Array<{ summary: string; status: string; at: string }>;
}

export interface ConfirmationLike {
  id: string;
  title: string;
  description: string;
  capability: string;
  createdAt: string;
}

export interface UtilityLike {
  id: string;
  kind: "alarm" | "reminder" | "timer";
  label: string;
  dueAt: number;
  repeat: "none" | "daily" | "weekdays";
  status: string;
}

export interface GoalLike {
  id: string;
  title?: string;
  description?: string;
  status?: string;
  progress?: number;
  nextAction?: string | null;
  updatedAt?: string | number;
  [key: string]: unknown;
}

export interface AuditLike {
  at: string;
  taskId: string | null;
  kind: string;
  summary: string;
}

export interface SkillLike {
  id?: string;
  name?: string;
  goal?: string;
  [key: string]: unknown;
}

export interface MobileApiContext {
  version: string;
  remoteAccess: boolean;
  /** Remote PC control is decided per caller: local windows always may. */
  allowDesktopTools: (isRemote: boolean) => boolean;
  tasks: (limit: number) => TaskLike[];
  confirmations: () => ConfirmationLike[];
  utilities: () => UtilityLike[];
  goals: () => GoalLike[];
  skills: () => SkillLike[];
  audit: (limit: number) => AuditLike[] | Promise<AuditLike[]>;
  agentHealth: () => Promise<{ online: boolean; tool_count?: number }>;
  hasApiKey: () => boolean;
  models: () => { selection?: { brain?: string }; models?: Array<{ id: string; availability?: string }> };
  memoryCount: () => Promise<number>;
  settings: () => AppSettings;
  generate: (args: {
    task: "vision";
    system: string;
    text: string;
    image: { mimeType: string; data: string };
    signal: AbortSignal;
  }) => Promise<{ text: string; modelId: string; latencyMs: number }>;
  emergencyStop: (reason: string) => number;
  denyAllConfirmations: () => number;
}

const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted"]);

/* --------------------------------------------------------------- builders */

function startOfDay(now: number): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function endOfDay(now: number): number {
  const date = new Date(now);
  date.setHours(23, 59, 59, 999);
  return date.getTime();
}

export function greetingFor(now: number): string {
  const hour = new Date(now).getHours();
  if (hour < 5) return "Still up";
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  if (hour < 22) return "Good evening";
  return "Good night";
}

/**
 * The home-screen briefing. Deliberately factual: each block is a real store,
 * and `sources` tells the client (and the user) where it came from. Nothing is
 * invented when a store is empty — the block is simply empty.
 */
export function buildBriefing(input: {
  now?: number;
  tasks: TaskLike[];
  confirmations: ConfirmationLike[];
  utilities: UtilityLike[];
  goals: GoalLike[];
  settings: AppSettings;
  agent: { online: boolean; tool_count?: number };
  memoryCount: number;
  remoteAccess: boolean;
  allowDesktopTools: boolean;
}) {
  const now = input.now ?? Date.now();
  const dayStart = startOfDay(now);
  const dayEnd = endOfDay(now);

  const active = input.tasks.filter((task) => !TERMINAL.has(task.state));
  const waitingConfirm = input.confirmations;
  const paused = input.tasks.filter((task) => task.state === "paused" || task.state === "recovering");
  const finishedToday = input.tasks.filter(
    (task) => TERMINAL.has(task.state) && task.updatedAt && new Date(task.updatedAt).getTime() >= dayStart,
  );
  const upcoming = input.utilities
    .filter((item) => item.status === "scheduled" || item.status === "ringing")
    .map((item) => ({
      id: item.id,
      kind: item.kind,
      label: item.label,
      dueAt: item.dueAt,
      inMinutes: Math.max(0, Math.round((item.dueAt - now) / 60_000)),
      today: item.dueAt >= dayStart && item.dueAt <= dayEnd,
      repeat: item.repeat,
    }))
    .sort((a, b) => a.dueAt - b.dueAt);

  const nextReminders = upcoming.filter((item) => item.today).slice(0, 5);
  const openGoals = input.goals
    .filter((goal) => String(goal.status ?? "active") === "active")
    .slice(0, 4)
    .map((goal) => ({
      id: goal.id,
      title: String(goal.title ?? goal.description ?? "Goal").slice(0, 160),
      progress: typeof goal.progress === "number" ? goal.progress : null,
      nextAction: typeof goal.nextAction === "string" ? goal.nextAction : null,
    }));

  const needsYou = waitingConfirm.length + input.tasks.filter((task) => task.pendingQuestion).length;

  return {
    generatedAt: new Date(now).toISOString(),
    greeting: greetingFor(now),
    mode: {
      persona: input.settings.persona.profile,
      context: input.settings.persona.context,
      reality: input.settings.reality.mode,
    },
    counts: {
      activeTasks: active.length,
      needsYou,
      remindersToday: nextReminders.length,
      finishedToday: finishedToday.length,
      memories: input.memoryCount,
      openGoals: openGoals.length,
    },
    nextReminders,
    activeTasks: active.slice(0, 5).map((task) => ({
      id: task.id,
      goal: task.goal,
      state: task.state,
      status: task.currentStatus ?? null,
      waitingQuestion: task.pendingQuestion?.text ?? null,
    })),
    pausedTasks: paused.slice(0, 3).map((task) => ({ id: task.id, goal: task.goal, state: task.state })),
    confirmations: waitingConfirm.slice(0, 3).map((item) => ({
      id: item.id,
      title: item.title,
      description: item.description,
      capability: item.capability,
      createdAt: item.createdAt,
    })),
    finishedToday: finishedToday.slice(0, 5).map((task) => ({
      id: task.id,
      goal: task.goal,
      state: task.state,
      result: task.result ?? null,
    })),
    goals: openGoals,
    pc: {
      agentOnline: input.agent.online,
      toolCount: input.agent.tool_count ?? null,
      // A phone cannot drive the PC unless the operator explicitly allowed it.
      remoteControlAllowed: input.allowDesktopTools,
      availableFromThisDevice: input.agent.online && input.allowDesktopTools,
    },
    // Statements the summary must not blur: offline PC, remote limits.
    notes: [
      !input.agent.online && "The Windows agent is offline, so PC actions cannot run right now.",
      input.agent.online && !input.allowDesktopTools && "This device may talk to Sara and manage memory, but cannot start PC actions.",
      input.remoteAccess && "You are connected over remote access.",
    ].filter((line): line is string => Boolean(line)),
    sources: [
      "runtime.tasks (/api/tasks)",
      "runtime.confirmations (/api/confirmations)",
      "runtime.utilities (/api/utilities)",
      "cognition.goals (/api/goals)",
      "cognition.memories (/api/memories)",
      "settings (/api/app-settings)",
      "desktop agent (/api/agent-health)",
    ],
  };
}

export type DiagnosticState = "ok" | "attention" | "offline" | "unknown";

export interface Diagnostic {
  id: string;
  label: string;
  state: DiagnosticState;
  detail: string;
  action?: string;
}

/**
 * Self-diagnostics (roadmap §39). Each row has a state and, when something is
 * wrong, a concrete next step. Nothing is reported "healthy" without evidence.
 */
export function buildDiagnostics(input: {
  version: string;
  hasApiKey: boolean;
  models: { selection?: { brain?: string }; models?: Array<{ id: string; availability?: string }> };
  agent: { online: boolean; tool_count?: number };
  memoryCount: number;
  utilities: number;
  remoteAccess: boolean;
  allowDesktopTools: boolean;
  realityMode: string;
}): { generatedAt: string; overall: DiagnosticState; items: Diagnostic[] } {
  const availableModels = (input.models.models ?? []).filter((m) => m.availability === "available").length;
  const items: Diagnostic[] = [
    {
      id: "gemini",
      label: "Gemini key",
      state: input.hasApiKey ? "ok" : "attention",
      detail: input.hasApiKey ? "Configured on the Sara server (the key never reaches this device)." : "No API key on the server yet.",
      ...(input.hasApiKey ? {} : { action: "Open Sara on the PC and enter a key, or use the key screen in the app." }),
    },
    {
      id: "models",
      label: "Models",
      state: availableModels > 0 ? "ok" : input.hasApiKey ? "attention" : "unknown",
      detail:
        availableModels > 0
          ? `${availableModels} model${availableModels === 1 ? "" : "s"} verified available. Brain: ${input.models.selection?.brain ?? "auto"}.`
          : input.hasApiKey
            ? "No model has been verified available yet."
            : "Waiting for an API key.",
      ...(availableModels > 0 ? {} : { action: "Settings → AI models & keys → refresh." }),
    },
    {
      id: "desktop-agent",
      label: "Windows agent",
      state: input.agent.online ? "ok" : "offline",
      detail: input.agent.online
        ? `Online — ${input.agent.tool_count ?? "?"} tools reported.`
        : "Not reachable from the Sara server.",
      ...(input.agent.online ? {} : { action: "Start Sara on the PC (the agent starts with it) and retry." }),
    },
    {
      id: "remote-control",
      label: "Remote PC control",
      state: input.allowDesktopTools ? (input.agent.online ? "ok" : "attention") : "attention",
      detail: input.allowDesktopTools
        ? "Enabled: this device may start PC actions. Risky steps still ask for approval."
        : "Disabled: this device cannot start PC actions (SARA_REMOTE_ALLOW_DESKTOP is off).",
      ...(input.allowDesktopTools ? {} : { action: "Set SARA_REMOTE_ALLOW_DESKTOP=1 on the server only if you intend to allow phone-initiated PC actions." }),
    },
    {
      id: "memory",
      label: "Memory",
      state: "ok",
      detail: `${input.memoryCount} remembered item${input.memoryCount === 1 ? "" : "s"} on the server.`,
    },
    {
      id: "automations",
      label: "Reminders & timers",
      state: "ok",
      detail: `${input.utilities} scheduled item${input.utilities === 1 ? "" : "s"}.`,
    },
    {
      id: "reality",
      label: "Reality mode",
      state: input.realityMode === "off" ? "attention" : "ok",
      detail:
        input.realityMode === "off"
          ? "Off: Sara answers naturally and does not label assumptions."
          : `${input.realityMode}: facts, assumptions and unknowns are labelled.`,
    },
    {
      id: "server",
      label: "Sara server",
      state: "ok",
      detail: `v${input.version}. Remote access ${input.remoteAccess ? "enabled (token required)" : "off (local only)"}.`,
    },
  ];

  const overall: DiagnosticState = items.some((item) => item.state === "offline")
    ? "offline"
    : items.some((item) => item.state === "attention")
      ? "attention"
      : items.some((item) => item.state === "unknown")
        ? "unknown"
        : "ok";

  return { generatedAt: new Date().toISOString(), overall, items };
}

/** Reminders, goals, learned skills and the day's activity trail. */
export function buildAutomations(input: {
  now?: number;
  utilities: UtilityLike[];
  goals: GoalLike[];
  skills: SkillLike[];
  audit: AuditLike[];
}) {
  const now = input.now ?? Date.now();
  const scheduled = input.utilities
    .filter((item) => item.status === "scheduled" || item.status === "ringing")
    .sort((a, b) => a.dueAt - b.dueAt)
    .map((item) => ({
      id: item.id,
      kind: item.kind,
      label: item.label,
      dueAt: item.dueAt,
      repeat: item.repeat,
      status: item.status,
    }));

  const repeats = input.utilities.filter((item) => item.repeat !== "none").length;

  return {
    generatedAt: new Date(now).toISOString(),
    scheduled,
    repeating: repeats,
    goals: input.goals.map((goal) => ({
      id: goal.id,
      title: String(goal.title ?? goal.description ?? "Goal").slice(0, 160),
      status: String(goal.status ?? "active"),
      progress: typeof goal.progress === "number" ? goal.progress : null,
      nextAction: typeof goal.nextAction === "string" ? goal.nextAction : null,
    })),
    skills: input.skills.slice(0, 12).map((skill) => ({
      id: String(skill.id ?? skill.name ?? skill.goal ?? "skill").slice(0, 80),
      name: String(skill.name ?? skill.goal ?? "Learned skill").slice(0, 120),
    })),
    activity: input.audit.slice(0, 40).map((entry) => ({
      at: entry.at,
      kind: entry.kind,
      summary: entry.summary,
      taskId: entry.taskId,
    })),
    // Honest capability note for the UI: what is *not* a background scheduler.
    notes: [
      "Reminders and timers are real and fire through the server's scheduler.",
      "Long-running background monitors (price/folder watchers) are not implemented; they are not simulated here.",
    ],
  };
}

/* ------------------------------------------------------------- vision I/O */

export const VISION_LIMITS = {
  /** ~4 MB decoded. A 1280 px JPEG is far below this; the client downscales. */
  maxBase64Chars: 6_000_000,
  allowedMime: ["image/jpeg", "image/png", "image/webp"] as const,
  perMinute: 12,
};

export function validateVisionBody(body: unknown): { ok: true; mimeType: string; data: string; question: string } | { ok: false; error: string; status: number } {
  const payload = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const image = typeof payload.image === "string" ? payload.image : "";
  const mimeType = typeof payload.mimeType === "string" ? payload.mimeType : "image/jpeg";
  const question = typeof payload.question === "string" ? payload.question.trim().slice(0, 1_000) : "";

  if (!image) return { ok: false, error: "No image was included. Take a photo first.", status: 400 };
  if (image.length > VISION_LIMITS.maxBase64Chars) {
    return { ok: false, error: "That image is too large. Use a smaller photo (under ~4 MB).", status: 413 };
  }
  if (!VISION_LIMITS.allowedMime.includes(mimeType as (typeof VISION_LIMITS.allowedMime)[number])) {
    return { ok: false, error: `Unsupported image type ${mimeType}. Use JPEG, PNG or WebP.`, status: 415 };
  }
  const base64 = image.replace(/^data:[^;]+;base64,/, "");
  if (!/^[A-Za-z0-9+/=\s]+$/.test(base64.slice(0, 200)) || base64.length < 64) {
    return { ok: false, error: "The image data was not valid base64.", status: 400 };
  }
  return {
    ok: true,
    mimeType,
    data: base64.replace(/\s+/g, ""),
    question: question || "What is in this image, and is there anything the user should act on?",
  };
}

/** Sliding one-minute limiter for the expensive vision call. */
export class MinuteLimiter {
  private hits: number[] = [];
  constructor(private readonly limit = VISION_LIMITS.perMinute, private readonly now: () => number = Date.now) {}
  take(): boolean {
    const t = this.now();
    this.hits = this.hits.filter((at) => t - at < 60_000);
    if (this.hits.length >= this.limit) return false;
    this.hits.push(t);
    return true;
  }
}

/* ------------------------------------------------------------ http wiring */

export function registerMobileRoutes(app: Express, ctx: MobileApiContext): void {
  const limiter = new MinuteLimiter();

  const fail = (res: Response, error: unknown, status = 500) => {
    res.status(status).json({ error: error instanceof Error ? error.message : String(error) });
  };

  const isRemote = (res: Response) => res.locals.saraRemote === true;

  app.get("/api/mobile/briefing", async (_req: Request, res: Response) => {
    try {
      const settings = ctx.settings();
      const agent = await ctx.agentHealth().catch(() => ({ online: false }));
      res.json(
        buildBriefing({
          tasks: ctx.tasks(40),
          confirmations: ctx.confirmations(),
          utilities: ctx.utilities(),
          goals: ctx.goals(),
          settings,
          agent,
          memoryCount: await ctx.memoryCount().catch(() => 0),
          remoteAccess: isRemote(res) && ctx.remoteAccess,
          allowDesktopTools: !isRemote(res) || ctx.allowDesktopTools(true),
        }),
      );
    } catch (error) {
      fail(res, error);
    }
  });

  app.get("/api/mobile/diagnostics", async (_req: Request, res: Response) => {
    try {
      const settings = ctx.settings();
      const agent = await ctx.agentHealth().catch(() => ({ online: false }));
      res.json(
        buildDiagnostics({
          version: ctx.version,
          hasApiKey: ctx.hasApiKey(),
          models: ctx.models(),
          agent,
          memoryCount: await ctx.memoryCount().catch(() => 0),
          utilities: ctx.utilities().filter((item) => item.status === "scheduled" || item.status === "ringing").length,
          remoteAccess: isRemote(res) && ctx.remoteAccess,
          allowDesktopTools: !isRemote(res) || ctx.allowDesktopTools(true),
          realityMode: settings.reality.mode,
        }),
      );
    } catch (error) {
      fail(res, error);
    }
  });

  app.get("/api/mobile/automations", async (_req: Request, res: Response) => {
    try {
      res.json(
        buildAutomations({
          utilities: ctx.utilities(),
          goals: ctx.goals(),
          skills: ctx.skills(),
          audit: await ctx.audit(60),
        }),
      );
    } catch (error) {
      fail(res, error);
    }
  });

  app.post("/api/mobile/vision", async (req: Request, res: Response) => {
    const parsed = validateVisionBody(req.body);
    if (parsed.ok === false) {
      res.status(parsed.status).json({ error: parsed.error });
      return;
    }
    if (!ctx.hasApiKey()) {
      res.status(409).json({ error: "Sara has no Gemini key yet, so she cannot look at a photo." });
      return;
    }
    if (!limiter.take()) {
      res.status(429).json({ error: "Too many photos in a minute. Wait a moment and try again." });
      return;
    }

    const settings = ctx.settings();
    const system = [
      "You are Sara, the user's assistant, analysing one photo they just took on their phone.",
      realityDirective(settings.reality),
      visionDirective(settings.reality),
      personaDirective(settings.persona),
    ].join("\n\n");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45_000);
    try {
      const started = Date.now();
      const result = await ctx.generate({
        task: "vision",
        system,
        text: parsed.question,
        image: { mimeType: parsed.mimeType, data: parsed.data },
        signal: controller.signal,
      });
      res.json({
        answer: result.text,
        question: parsed.question,
        modelId: result.modelId,
        latencyMs: Date.now() - started,
        realityMode: settings.reality.mode,
      });
    } catch (error) {
      const aborted = (error as { name?: string })?.name === "AbortError";
      fail(res, aborted ? new Error("Sara took too long to look at that photo. Try again.") : error, 502);
    } finally {
      clearTimeout(timer);
    }
  });

  app.post("/api/mobile/stop", (req: Request, res: Response) => {
    try {
      const reason = typeof req.body?.reason === "string" ? req.body.reason.slice(0, 120) : "phone_stop_button";
      const stopped = ctx.emergencyStop(`phone:${reason}`);
      // A pending approval must not survive a stop: the agent would otherwise
      // resume and act on an answer the user never gave.
      const denied = ctx.denyAllConfirmations();
      res.json({ ok: true, stoppedTasks: stopped, deniedConfirmations: denied, at: new Date().toISOString() });
    } catch (error) {
      fail(res, error);
    }
  });
}
