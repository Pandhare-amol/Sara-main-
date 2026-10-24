/**
 * Typed client for the runtime REST API (runtime/myraaRuntime.ts) and the
 * `/events` WebSocket. Everything here is renderer-safe: the backend never
 * returns secrets, and nothing in this file sends or stores one except
 * `saveProviderKey`, which posts the key once and keeps no copy.
 */

import { saraFetch } from "./serverConfig";

// ---- tasks ------------------------------------------------------------------------------

export type TaskState =
  | "queued" | "planning" | "running" | "paused" | "waiting_user" | "waiting_confirmation"
  | "user_takeover" | "recovering" | "completed" | "failed" | "cancelled" | "interrupted";

export const TERMINAL_TASK_STATES: ReadonlySet<TaskState> = new Set(["completed", "failed", "cancelled", "interrupted"]);

export interface TaskActionView {
  id: string;
  step: number;
  at: string;
  tool: string;
  summary: string;
  status: "ok" | "failed" | "denied" | "cancelled" | "skipped";
  durationMs: number;
  error?: string;
  verified: boolean | null;
}

export interface TaskView {
  id: string;
  goal: string;
  state: TaskState;
  origin: string;
  modelId: string | null;
  currentStatus: string;
  plan: { summary: string; steps: Array<{ text: string; status: "pending" | "active" | "done" | "skipped" }> } | null;
  actions: TaskActionView[];
  files: Array<{ path: string; change: string; at: string }>;
  pendingQuestion: { id: string; text: string; options?: string[]; askedAt: string } | null;
  pendingConfirmation: { id: string; capability: string; description: string; askedAt: string } | null;
  startedAt: string;
  updatedAt: string;
  completedAt?: string | null;
  result?: string | null;
  error?: string | null;
  steps?: number;
  sensitive?: boolean;
}

export type TaskAction = "stop" | "pause" | "resume" | "takeover" | "return" | "answer" | "continue";

// ---- confirmations & permissions --------------------------------------------------------

export interface ConfirmationRequest {
  id: string;
  taskId: string | null;
  capability: string;
  title: string;
  description: string;
  details: Record<string, unknown>;
  createdAt: string;
  expiresAt: string;
  allowRemember: boolean;
}

export type Decision = "allow" | "ask" | "deny";
export type MessageConfirmationMode = "always_confirm" | "confirm_new_recipients" | "trusted_without_confirmation" | "never_without_preview";

export interface PermissionsView {
  policy: {
    capabilities: Record<string, { decision: Decision }>;
    messageConfirmation: MessageConfirmationMode;
  };
  info: Record<string, { label: string; description: string; risk: "low" | "medium" | "high" }>;
}

/** Mirrors permissions/types.ts LOCKED_TO_ASK: these never go below "ask". */
export const LOCKED_CAPABILITIES: ReadonlySet<string> = new Set(["EXECUTE_DOWNLOAD", "INSTALL_SOFTWARE", "PURCHASE", "ACCOUNT_CHANGE", "POWER_CONTROL"]);

// ---- models -----------------------------------------------------------------------------

export type ModelAvailability = "available" | "unverified" | "unavailable" | "not_configured" | "disabled";

export interface ModelView {
  id: string;
  displayName: string;
  provider: string;
  providerName: string;
  locality: "local" | "cloud";
  tier: "fast" | "balanced" | "deep";
  capabilities: { vision: boolean; tools: boolean; reasoning: boolean; liveAudio: boolean; structuredOutput: boolean; streaming: boolean; embedding: boolean };
  contextLength: number;
  description: string;
  availability: ModelAvailability;
}

export interface ModelSelection {
  brain: string;
  live: string;
  background: string;
  fallbackAllowed: boolean;
  offlineLocalFallback: boolean;
}

export interface ModelCatalogue {
  selection: ModelSelection;
  providers: Array<{ id: string; displayName: string; locality: string; enabled: boolean; configured: boolean; verificationError: string | null }>;
  models: ModelView[];
  usage?: { models: Record<string, { calls: number; failures: number; avgLatencyMs: number | null }> };
  health?: Record<string, { recentFailures: number; coolingDown: boolean }>;
  network?: string;
}

// ---- server-side settings (settings/appSettings.ts) -------------------------------------

export interface AppSettings {
  version: 3;
  onboardingComplete: boolean;
  behavior: {
    proactivity: "quiet" | "balanced" | "lively";
    awayCheckin: boolean;
    returnGreeting: boolean;
    awayAfterMin: number;
    dndManual: boolean;
    autoDndFullscreen: boolean;
    autoDndMeetings: boolean;
    autoDndRecording: boolean;
  };
  autonomy: { maxSteps: number; conflictWaitSec: number; emergencyShortcut: string; showTaskHud: boolean };
  voice: { voiceName: string; style: "natural" | "anime"; pitch: number; bargeIn: boolean; speakTaskUpdates: "all" | "important" | "none" };
  companion: {
    enabled: boolean;
    setupComplete: boolean;
    scale: number;
    fullscreenBehavior: "hide" | "notifications_only" | "always" | "game_aware";
    clickThrough: boolean;
    interactionLevel: "minimal" | "normal" | "playful";
    walkAround: boolean;
    iconPlay: boolean;
    standOut: number;
    hideAndPeek: boolean;
    [key: string]: unknown;
  };
  character: { activeCharacterId: string; eyeFollowCursor: boolean; headFollowCursor: boolean; idleVariety: number };
  graphics: { realism: number; quality: "auto" | "potato" | "low" | "balanced" | "high"; autoStep: number };
  physics: {
    enabled: boolean;
    quality: "low" | "balanced" | "high";
    secondaryMotion: number;
    gravityMultiplier: number;
    stiffness: number;
    damping: number;
    drag: number;
    collisionQuality: "off" | "low" | "high";
    wind: number;
    clothEnabled: boolean;
    clothLooseness: number;
  };
  privacy: { screenAwareness: boolean; cameraPresence: boolean; clipboardInContext: boolean };
  performance: { activeFps: number; idleFps: number; sleepFps: number; perceptionPollSec: number };
  developer: { debugView: boolean; physicsDebug: boolean; verboseLogs: boolean };
  persona: PersonaSettings;
  reality: RealitySettings;
  calls: CallSettingsView;
}

export type PersonaProfileId = "companion" | "professional" | "executive" | "mentor" | "friend" | "emergency";

export interface PersonaSettings {
  profile: PersonaProfileId;
  context: "personal" | "professional" | "both";
  warmth: number;
  humor: number;
  formality: number;
  directness: number;
  empathy: number;
  energy: number;
  curiosity: number;
}

export interface RealitySettings {
  mode: "off" | "standard" | "strict";
  challengeAssumptions: boolean;
}

// ---- calls (communication/) -------------------------------------------------------------

export type CallState = "RINGING" | "CONNECTED" | "ACTIVE" | "HELD" | "ENDED" | "MISSED" | "REJECTED" | "FAILED" | "UNKNOWN";

export interface CallPeerView {
  number: string;
  name: string | null;
  contactId: string | null;
  relationship: string;
  organization: string | null;
  priority: "high" | "normal" | "low";
  unknown: boolean;
}

export interface CallRecordView {
  id: string;
  deviceCallId: string;
  deviceId: string;
  direction: "incoming" | "outgoing";
  peer: CallPeerView;
  state: CallState;
  decision: { action: string; reason: string; requiresUser: boolean } | null;
  createdAt: string;
  updatedAt: string;
  answeredAt: string | null;
  endedAt: string | null;
  durationSec: number | null;
  transcript: Array<{ role: "caller" | "sara"; text: string; at: string }>;
}

export interface CallSummaryView {
  caller: string | null;
  number: string;
  purpose: string | null;
  requests: string[];
  promises: string[];
  deadlines: string[];
  followUps: string[];
  messages: string[];
  sentiment: string;
  urgency: string;
  basis: string[];
  notes: string[];
}

export interface CallMessageView {
  id: string;
  callId: string | null;
  callerName: string | null;
  number: string;
  text: string;
  at: string;
  source: "call" | "manual";
}

export interface CallSettingsView {
  enabled: boolean;
  answerKnownContacts: "never" | "ask" | "auto";
  answerFamily: "never" | "ask" | "auto";
  answerBusinessContacts: "never" | "ask" | "auto";
  answerUnknownCall: boolean;
  answerDuringMeetings: boolean;
  answerDuringFocus: boolean;
  screenCalls: boolean;
  takeMessage: boolean;
  notifyOnMissed: boolean;
  maxCallMinutes: number;
}

export interface OutgoingCallPlan {
  status: "needs_confirmation" | "queued" | "ambiguous" | "unknown_contact" | "refused";
  message: string;
  target?: { name: string | null; number: string; contactId: string | null };
  candidates?: Array<{ id: string; displayName: string }>;
}

// ---- operation receipts (operations/journal.ts) -------------------------------------------

export type OperationStatus = "RUNNING" | "SUCCESS" | "FAILED" | "UNCERTAIN" | "CANCELLED" | "NEEDS_APPROVAL";
export type UndoState = "none" | "available" | "done" | "failed" | "unavailable";

export interface OperationView {
  id: string;
  at: string;
  endedAt: string | null;
  taskId: string | null;
  tool: string;
  args: string;
  status: OperationStatus;
  verified: boolean;
  verification: string | null;
  summary: string;
  error: string | null;
  durationMs: number | null;
  undo: { tool: string; label: string; destructive: boolean } | null;
  undoState: UndoState;
  undoneAt: string | null;
}

// ---- capabilities (capabilities/registry.ts) --------------------------------------------

export type CapabilityStatus = "AVAILABLE" | "NEEDS_PERMISSION" | "UNAVAILABLE" | "NOT_SUPPORTED" | "UNKNOWN";

export interface CapabilityView {
  id: string;
  label: string;
  area: string;
  platform: string;
  risk: "low" | "medium" | "high" | "critical";
  status: CapabilityStatus;
  permissions: string[];
  detail: string;
  verification: string;
  tool?: string;
}

export interface CapabilityCatalogue {
  capabilities: CapabilityView[];
  available: string[];
  summary: string;
  devices: Array<{ deviceId: string; platform: string; reportedAt: string; count: number }>;
}

// ---- messaging (communication/messaging) -------------------------------------------------

export interface ProviderView { id: string; label: string; status: { ok: boolean; detail: string } }

export interface InboundMessageView {
  id: string;
  provider: string;
  conversationId: string;
  fromId: string;
  fromName: string | null;
  text: string;
  at: string;
  unread: boolean;
  importance: "high" | "normal" | "low";
  reason: string;
}

export interface SendOutcomeView {
  status: "SENT" | "FAILED" | "UNCERTAIN" | "REQUIRES_APPROVAL" | "NOT_SUPPORTED" | "PERMISSION_DENIED";
  verified: boolean;
  provider: string;
  to: string;
  detail: string;
  providerMessageId?: string;
  approvalId?: string;
  preview?: string;
  error?: { code: string; message: string; retryable: boolean };
}

// ---- mobile composition API (server_mobileApi.ts) ----------------------------------------

export interface MobileBriefing {
  generatedAt: string;
  greeting: string;
  mode: { persona: PersonaProfileId; context: PersonaSettings["context"]; reality: RealitySettings["mode"] };
  counts: { activeTasks: number; needsYou: number; remindersToday: number; finishedToday: number; memories: number; openGoals: number };
  nextReminders: Array<{ id: string; kind: string; label: string; dueAt: number; inMinutes: number; today: boolean; repeat: string }>;
  activeTasks: Array<{ id: string; goal: string; state: string; status: string | null; waitingQuestion: string | null }>;
  pausedTasks: Array<{ id: string; goal: string; state: string }>;
  confirmations: Array<{ id: string; title: string; description: string; capability: string; createdAt: string }>;
  finishedToday: Array<{ id: string; goal: string; state: string; result: string | null }>;
  goals: Array<{ id: string; title: string; progress: number | null; nextAction: string | null }>;
  pc: { agentOnline: boolean; toolCount: number | null; remoteControlAllowed: boolean; availableFromThisDevice: boolean };
  notes: string[];
  sources: string[];
}

export type DiagnosticState = "ok" | "attention" | "offline" | "unknown";

export interface MobileDiagnostics {
  generatedAt: string;
  overall: DiagnosticState;
  items: Array<{ id: string; label: string; state: DiagnosticState; detail: string; action?: string }>;
}

export interface MobileAutomations {
  generatedAt: string;
  scheduled: Array<{ id: string; kind: string; label: string; dueAt: number; repeat: string; status: string }>;
  repeating: number;
  goals: Array<{ id: string; title: string; status: string; progress: number | null; nextAction: string | null }>;
  skills: Array<{ id: string; name: string }>;
  activity: Array<{ at: string; kind: string; summary: string; taskId: string | null }>;
  notes: string[];
}

export interface VisionAnswer {
  answer: string;
  question: string;
  modelId: string;
  latencyMs: number;
  realityMode: RealitySettings["mode"];
}

/** Deep-partial patch accepted by POST /api/app-settings. */
export type AppSettingsPatch = { [K in keyof AppSettings]?: AppSettings[K] extends object ? Partial<AppSettings[K]> : AppSettings[K] };

// ---- characters -------------------------------------------------------------------------

export interface CharacterSummary {
  id: string;
  displayName: string;
  builtIn?: boolean;
  [key: string]: unknown;
}

// ---- fetch helpers ----------------------------------------------------------------------

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await saraFetch(url, {
    method,
    cache: "no-store",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new Error("MYRAA backend returned an invalid response.");
  }
  if (!res.ok) throw new Error((data as { error?: string } | null)?.error || `Request failed (${res.status}).`);
  return data as T;
}

export const api = {
  tasks: (limit = 20) => request<TaskView[]>("GET", `/api/tasks?limit=${limit}`),
  recoverableTasks: () => request<TaskView[]>("GET", "/api/tasks/recoverable"),
  startTask: (goal: string) => request<TaskView>("POST", "/api/tasks", { goal, origin: "text" }),
  taskAction: (id: string, action: TaskAction, text?: string) => request<unknown>("POST", `/api/tasks/${encodeURIComponent(id)}/${action}`, text === undefined ? {} : { text }),
  emergencyStop: () => request<{ stopped: number }>("POST", "/api/autonomy/stop", { reason: "stop_button" }),

  confirmations: () => request<ConfirmationRequest[]>("GET", "/api/confirmations"),
  resolveConfirmation: (id: string, approved: boolean, remember: "once" | "session" = "once") =>
    request<{ ok: boolean }>("POST", `/api/confirmations/${encodeURIComponent(id)}`, { approved, remember }),

  permissions: () => request<PermissionsView>("GET", "/api/permissions"),
  setPermission: (capability: string, decision: Decision) => request<unknown>("POST", `/api/permissions/${encodeURIComponent(capability)}`, { decision }),
  setMessageConfirmation: (mode: MessageConfirmationMode) => request<unknown>("POST", "/api/permissions/messaging", { mode }),

  models: () => request<ModelCatalogue>("GET", "/api/models"),
  selectModels: (patch: Partial<ModelSelection>) => request<ModelSelection>("POST", "/api/models/select", patch),
  testModel: (modelId: string) => request<{ ok?: boolean; latencyMs?: number; error?: string; [key: string]: unknown }>("POST", "/api/models/test", { modelId }),
  refreshModels: () => request<ModelCatalogue>("POST", "/api/models/refresh"),
  saveProviderKey: (providerId: string, apiKey: string) => request<{ ok: boolean }>("POST", `/api/providers/${encodeURIComponent(providerId)}/key`, { apiKey }),

  appSettings: () => request<AppSettings>("GET", "/api/app-settings"),
  updateAppSettings: (patch: AppSettingsPatch) => request<AppSettings>("POST", "/api/app-settings", patch),
  setDnd: (active: boolean) => request<unknown>("POST", "/api/dnd", { active }),

  characters: () => request<CharacterSummary[]>("GET", "/api/characters"),

  // Calls. The phone reports states; this UI decides and asks.
  calls: () => request<{ active: CallRecordView[]; recent: CallRecordView[] }>("GET", "/api/calls?limit=20"),
  callDetail: (id: string) => request<{ call: CallRecordView; summary: CallSummaryView; messages: CallMessageView[] }>("GET", `/api/calls/${encodeURIComponent(id)}`),
  callPolicy: () => request<{ calls: CallSettingsView; deviceTokenConfigured: boolean }>("GET", "/api/calls/policy"),
  updateCallPolicy: (patch: Partial<CallSettingsView>) => request<{ ok: boolean; calls: CallSettingsView }>("POST", "/api/calls/policy", patch),
  answerCall: (id: string) => request<{ ok: boolean; call: CallRecordView }>("POST", `/api/calls/${encodeURIComponent(id)}/answer`, {}),
  rejectCall: (id: string) => request<{ ok: boolean; call: CallRecordView }>("POST", `/api/calls/${encodeURIComponent(id)}/reject`, {}),
  endCall: (id: string) => request<{ ok: boolean; call: CallRecordView }>("POST", `/api/calls/${encodeURIComponent(id)}/end`, {}),
  saveCallMessage: (id: string, text: string) => request<{ ok: boolean; message: CallMessageView }>("POST", `/api/calls/${encodeURIComponent(id)}/message`, { text }),
  outgoingCall: (input: { query?: string; number?: string; purpose?: string; confirmed?: boolean }) =>
    request<OutgoingCallPlan>("POST", "/api/calls/outgoing", input),

  // The PC's own screen. Desktop-only on the server unless the operator opts in
  // with SARA_REMOTE_ALLOW_DESKTOP=1; a 403 is reported, never hidden.
  capturePcScreen: (maxDim = 1024) =>
    request<{ ok: boolean; width: number; height: number; active_window: string | null; image_base64: string; image_mime: string; source: string }>(
      "POST",
      "/api/screen-vision",
      { max_dim: maxDim },
    ),

  // Operation receipts and undo.
  operations: (limit = 40) => request<{ operations: OperationView[] }>("GET", `/api/operations?limit=${limit}`),
  undoOperation: (id: string) =>
    request<{ ok: boolean; label: string; result: { summary: string; error?: string } }>("POST", `/api/operations/${encodeURIComponent(id)}/undo`, {}),

  // Capabilities and messaging.
  capabilities: () => request<CapabilityCatalogue>("GET", "/api/capabilities"),
  messagingStatus: () => request<{ providers: ProviderView[]; webhookConfigured: boolean }>("GET", "/api/messaging/status"),
  messagingSummary: () =>
    request<{ total: number; unread: number; important: number; byProvider: Record<string, number>; highlights: InboundMessageView[] }>("GET", "/api/messaging/summary"),
  messages: (query = "") => request<{ messages: InboundMessageView[] }>("GET", `/api/messaging/messages${query ? `?${query}` : ""}`),
  sendMessage: (input: { provider: string; to: string; text: string; confirmed?: boolean }) =>
    request<SendOutcomeView>("POST", "/api/messaging/send", input),

  // Mobile composition endpoints. They read the same stores as the desktop UI.
  briefing: () => request<MobileBriefing>("GET", "/api/mobile/briefing"),
  diagnostics: () => request<MobileDiagnostics>("GET", "/api/mobile/diagnostics"),
  automations: () => request<MobileAutomations>("GET", "/api/mobile/automations"),
  vision: (image: string, mimeType: string, question: string) =>
    request<VisionAnswer>("POST", "/api/mobile/vision", { image, mimeType, question }),
  stopEverything: () => request<{ ok: boolean; stoppedTasks: number; deniedConfirmations: number }>("POST", "/api/mobile/stop", { reason: "phone_stop_button" }),
};

export const AVAILABILITY_LABEL: Record<ModelAvailability, string> = {
  available: "Available",
  unverified: "Not yet checked",
  unavailable: "Not available on this key",
  not_configured: "Needs an API key",
  disabled: "Disabled",
};
