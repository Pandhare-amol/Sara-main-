const { JSDOM } = require("jsdom");
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: "https://app.example.com/",
  pretendToBeVisual: true,
});
const g = globalThis;
g.window = dom.window;
g.document = dom.window.document;
Object.defineProperty(g, "navigator", { value: dom.window.navigator, configurable: true });
g.HTMLElement = dom.window.HTMLElement;
g.Element = dom.window.Element;
g.Node = dom.window.Node;
g.Event = dom.window.Event;
g.CustomEvent = dom.window.CustomEvent;
g.DOMException = dom.window.DOMException;
g.getComputedStyle = dom.window.getComputedStyle;
g.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 16);
g.cancelAnimationFrame = (id) => clearTimeout(id);
const matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
g.matchMedia = matchMedia;
dom.window.matchMedia = matchMedia;
g.ResizeObserver = dom.window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
g.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
// URL-aware stub so composition panels render real shapes instead of `{ok:true}`.
const stubSettings = {
  persona: { profile: "companion", context: "both", warmth: 78, humor: 55, formality: 30, directness: 55, empathy: 75, energy: 60, curiosity: 65 },
  reality: { mode: "standard", challengeAssumptions: true },
};
g.fetch = dom.window.fetch = async (input) => {
  const url = String(input && input.url ? input.url : input);
  const json = (data) => new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
  if (url.includes("/api/mobile/briefing")) {
    return json({
      generatedAt: new Date().toISOString(),
      greeting: "Good morning. Two things need you today.",
      mode: { persona: "companion", context: "both", reality: "standard" },
      counts: { activeTasks: 1, needsYou: 1, remindersToday: 1, finishedToday: 0, memories: 4, openGoals: 1 },
      nextReminders: [{ id: "u1", kind: "reminder", label: "Call the bank", dueAt: Date.now() + 3600_000, inMinutes: 60, today: true, repeat: "none" }],
      activeTasks: [{ id: "t1", goal: "Rename the invoices", state: "waiting_user", status: null, waitingQuestion: "Which folder?" }],
      pausedTasks: [],
      confirmations: [{ id: "c1", title: "Send message", description: "WhatsApp to Aman", capability: "messaging", createdAt: new Date().toISOString() }],
      finishedToday: [],
      goals: [{ id: "g1", title: "Ship v2", progress: 40, nextAction: "Write the release note" }],
      pc: { agentOnline: true, toolCount: 42, remoteControlAllowed: true, availableFromThisDevice: true },
      notes: ["Live PC control comes from your Windows agent."],
      sources: ["tasks", "confirmations", "utilities"],
    });
  }
  if (url.includes("/api/mobile/diagnostics")) {
    return json({
      generatedAt: new Date().toISOString(),
      overall: "ok",
      items: [
        { id: "gemini", label: "Gemini key", state: "ok", detail: "Configured on the server." },
        { id: "desktop-agent", label: "Windows agent", state: "ok", detail: "Online — 42 tools reported." },
      ],
    });
  }
  if (url.includes("/api/mobile/automations")) {
    return json({
      generatedAt: new Date().toISOString(),
      scheduled: [{ id: "u1", kind: "reminder", label: "Call the bank", dueAt: Date.now() + 3600_000, repeat: "none", status: "scheduled" }],
      repeating: 0,
      goals: [{ id: "g1", title: "Ship v2", status: "active", progress: 40, nextAction: null }],
      skills: [{ id: "s1", name: "Rename files" }],
      activity: [{ at: new Date().toISOString(), kind: "tool", summary: "Opened Notepad", taskId: "t1" }],
      notes: ["Long-running background monitors are not implemented."],
    });
  }
  if (url.includes("/api/capabilities")) {
    return json({
      capabilities: [
        { id: "core.reasoning", label: "Gemini reasoning", area: "system", platform: "server", risk: "low", status: "AVAILABLE", permissions: [], detail: "Gemini is configured on the server.", verification: "answer returned" },
        { id: "phone.call.place", label: "Phone Call Place", area: "phone", platform: "android", risk: "high", status: "NEEDS_PERMISSION", permissions: ["CALL_PHONE"], detail: "Reported by phone-1", verification: "device reports" },
        { id: "messaging.whatsapp", label: "whatsapp messaging", area: "messaging", platform: "server", risk: "high", status: "UNAVAILABLE", permissions: [], detail: "WhatsApp Cloud API is not configured", verification: "provider id" },
      ],
      available: ["chat"],
      summary: "CAPABILITIES RIGHT NOW",
      devices: [{ deviceId: "phone-1", platform: "android", reportedAt: new Date().toISOString(), count: 3 }],
    });
  }
  if (url.includes("/api/messaging/status")) {
    return json({ providers: [{ id: "whatsapp", label: "WhatsApp (Cloud API)", status: { ok: true, detail: "Configured; sends verified by message id." } }], webhookConfigured: true });
  }
  if (url.includes("/api/messaging/messages") || url.includes("/api/messaging/summary")) {
    return json({ messages: [{
      id: "w1", provider: "whatsapp", conversationId: "9198", fromId: "9198", fromName: "Rahul",
      text: "Can you send the proposal by Friday?", at: new Date().toISOString(), unread: true, importance: "high",
      reason: "Mentions urgency or a deadline.",
    }] });
  }
  if (url.includes("/api/messaging/send")) {
    return json({ status: "REQUIRES_APPROVAL", verified: false, provider: "whatsapp", to: "9198", detail: "Sara prepared the message and is waiting for your approval.", preview: "hello" });
  }
  if (url.includes("/api/calls/policy")) {
    return json({
      calls: {
        enabled: true, answerKnownContacts: "ask", answerFamily: "ask", answerBusinessContacts: "ask",
        answerUnknownCall: false, answerDuringMeetings: false, answerDuringFocus: false,
        screenCalls: true, takeMessage: true, notifyOnMissed: true, maxCallMinutes: 20,
      },
      deviceTokenConfigured: false,
    });
  }
  if (url.includes("/api/calls")) {
    return json({
      active: [{
        id: "call-1", deviceCallId: "d1", deviceId: "phone-1", direction: "incoming",
        peer: { number: "9876543210", name: "Rahul", contactId: "c1", relationship: "business", organization: "Acme", priority: "high", unknown: false },
        state: "RINGING", decision: { action: "ask_user", reason: "Your policy says ask before answering.", requiresUser: true },
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), answeredAt: null, endedAt: null, durationSec: null, transcript: [],
      }],
      recent: [],
    });
  }
  if (url.includes("/api/app-settings")) return json(stubSettings);
  if (url.includes("/api/memories")) return json([]);
  if (url.includes("/api/tasks")) return json([]);
  if (url.includes("/api/confirmations")) return json([]);
  if (url.includes("/api/agent-health")) return json({ online: true, tool_count: 42 });
  return json({ ok: true, hasApiKey: true });
};
Object.defineProperty(dom.window, "innerWidth", { value: 360, writable: true });
Object.defineProperty(dom.window, "innerHeight", { value: 800, writable: true });
class StubWebSocket {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  readyState = 0;
  constructor() {}
  close() { this.readyState = 3; }
  send() {}
  addEventListener() {} removeEventListener() {}
}
g.WebSocket = dom.window.WebSocket = StubWebSocket;
g.HTMLCanvasElement = dom.window.HTMLCanvasElement;
dom.window.HTMLCanvasElement.prototype.getContext = () => null;
