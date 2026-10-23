/**
 * Capability registry.
 *
 * One place that answers "what can Sara actually do right now, on this server
 * and on this phone". The model is shown only the AVAILABLE entries, so it
 * cannot plan a call on a phone that never checked in, or a PC action while the
 * Windows agent is down.
 *
 * Nothing here infers capability. Each status comes from a live probe or from a
 * report the device itself sent:
 *
 *   server features  → configuration + runtime state
 *   desktop agent    → /health probe (tool_count)
 *   phone            → POST /api/capabilities/report (device token)
 */

export type CapabilityStatus =
  | "AVAILABLE"
  | "NEEDS_PERMISSION"
  | "UNAVAILABLE"
  | "NOT_SUPPORTED"
  | "UNKNOWN";

export type CapabilityArea =
  | "phone"
  | "messaging"
  | "media"
  | "camera"
  | "files"
  | "apps"
  | "notifications"
  | "desktop"
  | "web"
  | "memory"
  | "system";

export type CapabilityPlatform = "android" | "ios" | "windows" | "server";

export type CapabilityRisk = "low" | "medium" | "high" | "critical";

export interface CapabilityDescriptor {
  /** Stable dotted id, e.g. `phone.call.place`. */
  id: string;
  label: string;
  area: CapabilityArea;
  platform: CapabilityPlatform;
  risk: CapabilityRisk;
  status: CapabilityStatus;
  /** Which permissions the platform requires, in the platform's own words. */
  permissions: string[];
  /** What the user experiences, and what remains impossible. */
  detail: string;
  /** How a successful run is verified — never "assume the intent worked". */
  verification: string;
  /** Registry tool the model may call, when one exists. */
  tool?: string;
}

export interface DeviceReport {
  deviceId: string;
  platform: CapabilityPlatform;
  reportedAt: string;
  /** Raw capability ids the device says it supports, with the platform's verdict. */
  capabilities: Array<{
    id: string;
    status: CapabilityStatus;
    permissions?: string[];
    detail?: string;
  }>;
  appVersion?: string;
}

export interface CapabilityInput {
  /** Live desktop-agent probe. */
  desktop: { online: boolean; toolCount?: number | null };
  /** Latest report from each phone, keyed by device id. */
  devices: DeviceReport[];
  server: {
    hasGeminiKey: boolean;
    visionEnabled: boolean;
    callsEnabled: boolean;
    deviceTokenConfigured: boolean;
    messagingProviders: Array<{ id: string; configured: boolean; detail: string }>;
    memoryReady: boolean;
    voiceAvailable: boolean;
  };
}

/** Server-side capabilities that always exist when the runtime is healthy. */
function serverCapabilities(input: CapabilityInput): CapabilityDescriptor[] {
  const keyed = input.server.hasGeminiKey;
  return [
    {
      id: "core.reasoning",
      label: "Gemini reasoning",
      area: "system",
      platform: "server",
      risk: "low",
      status: keyed ? "AVAILABLE" : "UNAVAILABLE",
      permissions: [],
      detail: keyed ? "Gemini is configured on the server." : "No Gemini key configured; only local deterministic paths work.",
      verification: "The model answered a request; failures surface as errors, not empty answers.",
      tool: "chat",
    },
    {
      id: "core.voice",
      label: "Live voice session",
      area: "system",
      platform: "server",
      risk: "medium",
      status: input.server.voiceAvailable && keyed ? "AVAILABLE" : "UNAVAILABLE",
      permissions: ["microphone (device)"],
      detail: input.server.voiceAvailable && keyed
        ? "Gemini Live is available for streaming voice."
        : "Live voice needs a Gemini key and microphone permission.",
      verification: "Audio frames flow over the existing /live bridge; silence is reported as silence.",
      tool: "live",
    },
    {
      id: "core.memory",
      label: "Memory",
      area: "memory",
      platform: "server",
      risk: "low",
      status: input.server.memoryReady ? "AVAILABLE" : "UNAVAILABLE",
      permissions: [],
      detail: input.server.memoryReady ? "Structured memory is loaded." : "Memory store is not initialised.",
      verification: "Writes are read back from the store.",
      tool: "memory",
    },
    {
      id: "core.vision.photo",
      label: "Photo understanding",
      area: "camera",
      platform: "server",
      risk: "medium",
      status: input.server.visionEnabled ? "AVAILABLE" : "UNAVAILABLE",
      permissions: ["camera (device)"],
      detail: input.server.visionEnabled ? "One photo at a time, downscaled on the phone." : "Vision needs a Gemini key.",
      verification: "The model response is returned with the question it answered.",
      tool: "phone.vision",
    },
    {
      id: "phone.call.events",
      label: "Call reporting",
      area: "phone",
      platform: "server",
      risk: "high",
      status: input.server.callsEnabled && input.server.deviceTokenConfigured ? "AVAILABLE" : "UNAVAILABLE",
      permissions: ["READ_PHONE_STATE"],
      detail: input.server.callsEnabled
        ? input.server.deviceTokenConfigured
          ? "The server accepts call events from an authorised phone."
          : "Call policy is on but no device token is configured."
        : "Call integration is switched off in settings.",
      verification: "Call records only move to CONNECTED when the device reports it.",
      tool: "phone.calls",
    },
  ];
}

function desktopCapabilities(input: CapabilityInput): CapabilityDescriptor[] {
  const online = input.desktop.online;
  const tools = input.desktop.toolCount ?? 0;
  const detail = online ? `Windows agent online with ${tools} desktop tools.` : "The Windows agent is not reachable.";
  const base = { area: "desktop" as const, platform: "windows" as const, detail, permissions: [] as string[] };
  const status: CapabilityStatus = online ? "AVAILABLE" : "UNAVAILABLE";
  return [
    { ...base, id: "desktop.mouse_keyboard", label: "Mouse & keyboard", risk: "medium", status, verification: "The executor verifies UI state after input when the target is checkable.", tool: "ui.click" },
    { ...base, id: "desktop.apps", label: "Launch/close apps", risk: "medium", status, verification: "Process and window are checked after launch; a bare process is not success.", tool: "app.launch" },
    { ...base, id: "desktop.files", label: "Files on the PC", risk: "medium", status, verification: "Paths are resolved inside allowed roots before acting.", tool: "fs.copy" },
    { ...base, id: "desktop.screen", label: "Screen perception", risk: "medium", status, verification: "UI Automation → accessibility tree → OCR → vision, cheapest first.", tool: "screen.look" },
    { ...base, id: "desktop.browser", label: "Real browser control", risk: "low", status, verification: "The URL and page title are read back from the live window.", tool: "browser.open" },
    { ...base, id: "desktop.system", label: "Power & system", risk: "critical", status, permissions: ["confirmation"], verification: "The OS acknowledges the command; it is always confirmed first.", tool: "sys.power" },
  ];
}

function deviceCapabilities(devices: DeviceReport[]): CapabilityDescriptor[] {
  const out: CapabilityDescriptor[] = [];
  const seen = new Set<string>();
  for (const device of devices) {
    for (const item of device.capabilities) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      out.push({
        id: item.id,
        label: humanize(item.id),
        area: areaFor(item.id),
        platform: device.platform,
        risk: riskFor(item.id),
        status: item.status,
        permissions: item.permissions ?? [],
        detail: item.detail || `Reported by ${device.deviceId} at ${device.reportedAt}.`,
        verification: "The phone reports the outcome of the actual OS call; the server does not upgrade it.",
      });
    }
  }
  return out;
}

function messagingCapabilities(input: CapabilityInput): CapabilityDescriptor[] {
  return input.server.messagingProviders.map((provider) => ({
    id: `messaging.${provider.id}`,
    label: `${provider.id} messaging`,
    area: "messaging" as const,
    platform: "server" as const,
    risk: "high" as const,
    status: provider.configured ? ("AVAILABLE" as const) : ("UNAVAILABLE" as const),
    permissions: [],
    detail: provider.detail,
    verification: "The provider's response id is stored; anything without one is UNVERIFIED, not sent.",
    tool: `messaging.${provider.id}.send`,
  }));
}

/** The catalogue the API and the model see. */
export function buildCapabilities(input: CapabilityInput): CapabilityDescriptor[] {
  return [
    ...serverCapabilities(input),
    ...messagingCapabilities(input),
    ...deviceCapabilities(input.devices),
    ...desktopCapabilities(input),
  ];
}

/** Only capabilities a tool call could actually use right now. */
export function availableTools(catalogue: CapabilityDescriptor[]): string[] {
  return catalogue
    .filter((capability) => capability.status === "AVAILABLE" && capability.tool)
    .map((capability) => capability.tool as string)
    .sort();
}

/** A short, honest line for the system instruction. */
export function capabilitySummary(catalogue: CapabilityDescriptor[]): string {
  const available = catalogue.filter((capability) => capability.status === "AVAILABLE");
  const blocked = catalogue.filter((capability) => capability.status !== "AVAILABLE");
  const names = available.slice(0, 24).map((capability) => capability.label).join(", ");
  const missing = blocked.slice(0, 8).map((capability) => `${capability.label} (${capability.status.toLowerCase().replace(/_/g, " ")})`).join(", ");
  return [
    "CAPABILITIES RIGHT NOW (do not attempt anything outside this list):",
    available.length ? `- Available: ${names}.` : "- Available: none.",
    missing ? `- Not usable: ${missing}.` : "",
    "- If a capability is not listed as available, say so plainly instead of pretending or simulating it.",
  ].filter(Boolean).join("\n");
}

/* ------------------------------------------------------------------ helpers */

function humanize(id: string): string {
  return id.split(".").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

function areaFor(id: string): CapabilityArea {
  if (id.startsWith("phone")) return "phone";
  if (id.startsWith("messaging") || id.includes("sms")) return "messaging";
  if (id.includes("camera") || id.includes("photo")) return "camera";
  if (id.includes("app")) return "apps";
  if (id.includes("file")) return "files";
  if (id.includes("notification")) return "notifications";
  if (id.includes("youtube") || id.includes("media")) return "media";
  if (id.includes("desktop") || id.includes("pc")) return "desktop";
  if (id.includes("web") || id.includes("browser")) return "web";
  return "system";
}

function riskFor(id: string): CapabilityRisk {
  if (/power|shutdown|reset|purchase/.test(id)) return "critical";
  if (/call|sms|message|send|delete|camera/.test(id)) return "high";
  if (/file|app|media|notification/.test(id)) return "medium";
  return "low";
}

/* ---------------------------------------------------------------- registry */

/**
 * Keeps the latest report per device. Reports are replaced wholesale: a phone
 * that loses permission says so on its next report, and the old answer must not
 * linger.
 */
export class CapabilityRegistry {
  private readonly devices = new Map<string, DeviceReport>();

  record(report: DeviceReport): DeviceReport {
    const clean: DeviceReport = {
      ...report,
      reportedAt: report.reportedAt || new Date().toISOString(),
      capabilities: report.capabilities
        .filter((item) => typeof item.id === "string" && item.id.length > 0)
        .map((item) => ({
          id: item.id.slice(0, 80),
          status: item.status,
          permissions: (item.permissions || []).slice(0, 12).map((permission) => permission.slice(0, 60)),
          detail: (item.detail || "").slice(0, 300),
        })),
    };
    this.devices.set(clean.deviceId, clean);
    return structuredClone(clean);
  }

  list(): DeviceReport[] {
    return [...this.devices.values()].map((report) => structuredClone(report));
  }

  get(deviceId: string): DeviceReport | null {
    const report = this.devices.get(deviceId);
    return report ? structuredClone(report) : null;
  }
}
