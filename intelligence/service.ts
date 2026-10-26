import type { Express, Request, Response } from "express";
import { appEvents } from "../shared/appEvents";
import type { ModelRouter } from "../models/router";
import { ModelError } from "../models/types";
import { CollaborationEngine } from "./collaborationEngine";
import { ResearchEngine } from "./researchEngine";
import { ResearchStore } from "./researchStore";
import type { CollaborationRequest, ResearchRequest, ResearchSession } from "./types";

export class IntelligenceService {
  readonly store: ResearchStore;
  readonly collaboration: CollaborationEngine;
  readonly research: ResearchEngine;
  private readonly active = new Map<string, { controller: AbortController; promise: Promise<ResearchSession> }>();

  constructor(private readonly router: ModelRouter, dataDir: string) {
    this.store = new ResearchStore(dataDir);
    this.collaboration = new CollaborationEngine(router);
    this.research = new ResearchEngine(router, this.collaboration, this.store);
  }

  async initialize(): Promise<void> {
    await this.store.initialize();
  }

  async startResearch(input: unknown, parentSessionId: string | null = null): Promise<ResearchSession> {
    const request = this.research.validateRequest(input);
    const session = await this.store.createSession(request, parentSessionId);
    this.launch(session.id);
    return session;
  }

  async retryResearch(id: string): Promise<ResearchSession> {
    const previous = this.store.getSession(id);
    if (!previous) throw notFound("Research session not found.");
    if (this.active.has(id)) throw conflict("Research is still running.");
    return this.startResearch(previous.request, previous.id);
  }

  cancelResearch(id: string): boolean {
    const active = this.active.get(id);
    if (!active) return false;
    active.controller.abort();
    return true;
  }

  async deleteResearch(id: string): Promise<boolean> {
    const active = this.active.get(id);
    if (active) {
      active.controller.abort();
      await active.promise.catch(() => {});
    }
    return this.store.deleteSession(id);
  }

  async shutdown(): Promise<void> {
    for (const item of this.active.values()) item.controller.abort();
    await Promise.allSettled([...this.active.values()].map((item) => item.promise));
    await this.store.flush();
  }

  registerRoutes(app: Express): void {
    const handle = (handler: (req: Request) => Promise<unknown> | unknown) => async (req: Request, res: Response) => {
      try {
        const value = await handler(req);
        if (!res.headersSent) res.json(value ?? { ok: true });
      } catch (error) {
        const status = Number((error as { status?: number })?.status) || (error instanceof ModelError ? 502 : 400);
        const message = error instanceof ModelError ? error.userMessage : error instanceof Error ? error.message : String(error);
        if (!res.headersSent) res.status(status).json({ error: message });
      }
    };

    app.get("/api/intelligence/status", handle(() => {
      const catalogue = this.router.registry.publicCatalogue();
      return {
        providers: catalogue.providers,
        models: catalogue.models,
        usage: this.router.usage.snapshot(),
        health: this.router.healthSnapshot(),
        activeResearchIds: [...this.active.keys()],
        research: this.store.listSessions(50),
        knowledge: this.store.listKnowledge(),
      };
    }));

    app.post("/api/intelligence/collaborate", handle((req) => this.collaboration.collaborate(req.body as CollaborationRequest)));

    app.get("/api/research", handle((req) => this.store.listSessions(Number(req.query.limit) || 50)));
    app.post("/api/research", handle(async (req) => ({ session: await this.startResearch(req.body), started: true })));
    app.get("/api/research/:id", handle((req) => {
      const session = this.store.getSession(String(req.params.id));
      if (!session) throw notFound("Research session not found.");
      return { session, sources: this.store.sourcesForSession(session.id), active: this.active.has(session.id) };
    }));
    app.post("/api/research/:id/cancel", handle((req) => ({ ok: this.cancelResearch(String(req.params.id)) })));
    app.post("/api/research/:id/retry", handle(async (req) => ({ session: await this.retryResearch(String(req.params.id)), started: true })));
    app.delete("/api/research/:id", handle(async (req) => ({ deleted: await this.deleteResearch(String(req.params.id)) })));
    app.post("/api/research/:id/findings/:findingId/promote", handle(async (req) => ({
      knowledge: await this.store.promoteFinding(String(req.params.id), String(req.params.findingId), req.body?.topic),
    })));

    app.get("/api/knowledge", handle((req) => this.store.listKnowledge({
      text: typeof req.query.q === "string" ? req.query.q : undefined,
      projectId: typeof req.query.projectId === "string" ? req.query.projectId : undefined,
      includeInactive: req.query.includeInactive === "true",
    })));
    app.post("/api/knowledge/:id/correct", handle(async (req) => ({
      knowledge: await this.store.correctKnowledge(String(req.params.id), {
        content: String(req.body?.content || ""),
        reason: String(req.body?.reason || ""),
      }),
    })));
    app.delete("/api/knowledge/:id", handle(async (req) => ({ deleted: await this.store.deleteKnowledge(String(req.params.id)) })));
  }

  private launch(id: string): void {
    const controller = new AbortController();
    const promise = this.research.run(id, controller.signal).finally(() => {
      this.active.delete(id);
      const session = this.store.getSession(id);
      if (session) appEvents.publish("research.updated", {
        id: session.id,
        status: session.status,
        stage: session.stage,
        progress: session.progress,
        sourceCount: session.sourceIds.length,
        findingCount: session.findings.length,
      });
    });
    this.active.set(id, { controller, promise });
    // The session and every terminal failure are persisted by ResearchEngine.
    void promise.catch(() => {});
  }
}

function notFound(message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status: 404 });
}

function conflict(message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status: 409 });
}
