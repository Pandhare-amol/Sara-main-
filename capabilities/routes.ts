/**
 * Capability endpoints.
 *
 * `POST /api/capabilities/report` is the phone's declaration of what it can do;
 * `GET /api/capabilities` is the catalogue the UI and the model read.
 */
import type { Express, Request, Response } from "express";
import type { DeviceGuard } from "../shared/deviceAuth";
import {
  buildCapabilities,
  availableTools,
  capabilitySummary,
  type CapabilityInput,
  type CapabilityRegistry,
  type DeviceReport,
} from "./registry";

export interface CapabilityRoutesDeps {
  registry: CapabilityRegistry;
  device: DeviceGuard;
  /** Everything except the device list, read fresh on each request. */
  server: () => Omit<CapabilityInput, "devices">;
}

const VALID_STATUS = new Set(["AVAILABLE", "NEEDS_PERMISSION", "UNAVAILABLE", "NOT_SUPPORTED", "UNKNOWN"]);

export function registerCapabilityRoutes(app: Express, deps: CapabilityRoutesDeps): void {
  const fail = (res: Response, error: unknown, status = 400) => {
    res.status(status).json({ error: error instanceof Error ? error.message : String(error) });
  };

  const catalogue = () => buildCapabilities({ ...deps.server(), devices: deps.registry.list() });

  app.get("/api/capabilities", (_req: Request, res: Response) => {
    try {
      const capabilities = catalogue();
      res.json({
        capabilities,
        available: availableTools(capabilities),
        summary: capabilitySummary(capabilities),
        devices: deps.registry.list().map((report) => ({
          deviceId: report.deviceId,
          platform: report.platform,
          reportedAt: report.reportedAt,
          count: report.capabilities.length,
        })),
      });
    } catch (error) {
      fail(res, error, 500);
    }
  });

  app.post("/api/capabilities/report", (req: Request, res: Response) => {
    if (!deps.device(req, res)) return;
    try {
      const body = (req.body || {}) as Partial<DeviceReport>;
      if (!body.deviceId || typeof body.deviceId !== "string") throw new Error("deviceId is required.");
      if (!Array.isArray(body.capabilities)) throw new Error("capabilities must be an array.");
      const report = deps.registry.record({
        deviceId: body.deviceId.slice(0, 80),
        platform: body.platform === "ios" || body.platform === "windows" ? body.platform : "android",
        reportedAt: new Date().toISOString(),
        appVersion: typeof body.appVersion === "string" ? body.appVersion.slice(0, 40) : undefined,
        capabilities: body.capabilities
          .filter((item) => item && typeof item.id === "string")
          .map((item) => ({
            id: item.id,
            status: VALID_STATUS.has(item.status as string) ? item.status : "UNKNOWN",
            permissions: Array.isArray(item.permissions) ? item.permissions.filter((value) => typeof value === "string") : [],
            detail: typeof item.detail === "string" ? item.detail : "",
          })),
      });
      res.json({ ok: true, report });
    } catch (error) {
      fail(res, error);
    }
  });
}
