const base = require("./smoke-jsdom-preload.cjs");
const g = globalThis;
g.fetch = g.window.fetch = async (input) => {
  const url = String(input);
  const json = (data) => new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
  if (url.includes("/api/config")) return json({ hasApiKey: true });
  if (url.includes("/api/memories")) return json([]);
  if (url.includes("/api/app-settings")) {
    return json({
      version: 3, onboardingComplete: true,
      behavior: { proactivity: "balanced", awayCheckin: true, returnGreeting: true, awayAfterMin: 15, dndManual: false, autoDndFullscreen: false, autoDndMeetings: false, autoDndRecording: false },
      autonomy: { maxSteps: 12, conflictWaitSec: 20, emergencyShortcut: "Ctrl+Alt+Shift+S", showTaskHud: true },
      voice: { voiceName: "Aoede", style: "natural", pitch: 0, bargeIn: true, speakTaskUpdates: "important" },
      companion: { enabled: false, setupComplete: false, scale: 1, fullscreenBehavior: "hide", clickThrough: false, interactionLevel: "normal", walkAround: false, iconPlay: false, standOut: 0, hideAndPeek: false },
      character: { activeCharacterId: "", eyeFollowCursor: true, headFollowCursor: true, idleVariety: 1 },
      graphics: { realism: 1, quality: "auto", autoStep: 0 },
      physics: { enabled: true, quality: "balanced", secondaryMotion: 1, gravityMultiplier: 1, stiffness: 1, damping: 1, drag: 1, collisionQuality: "low", wind: 0, clothEnabled: true, clothLooseness: 1 },
      privacy: { screenAwareness: false, cameraPresence: false, clipboardInContext: false },
      performance: { activeFps: 60, idleFps: 30, sleepFps: 15, perceptionPollSec: 5 },
      developer: { debugView: false, physicsDebug: false, verboseLogs: false },
      calls: { enabled: false, answerKnownContacts: "ask", answerFamily: "ask", answerBusinessContacts: "ask", answerUnknownCall: false, answerDuringMeetings: false, answerDuringFocus: false, screenCalls: true, takeMessage: true, notifyOnMissed: true, maxCallMinutes: 20 },
      persona: { profile: "companion", context: "both", warmth: 78, humor: 55, formality: 30, directness: 55, empathy: 75, energy: 60, curiosity: 65 },
      reality: { mode: "standard", challengeAssumptions: true },
    });
  }
  if (url.includes("/api/characters")) return json([]);
  if (url.includes("/api/models")) return json({ selection: { brain: "auto", live: "auto", background: "auto", fallbackAllowed: true, offlineLocalFallback: false }, providers: [], models: [] });
  if (url.includes("/api/tasks")) return json([]);
  if (url.includes("/api/confirmations")) return json([]);
  if (url.includes("/api/agent-health")) return json({ online: false });
  return json({ ok: true });
};
