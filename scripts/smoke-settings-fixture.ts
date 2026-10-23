/**
 * A complete server settings object for the browser smoke tests.
 *
 * The smoke bundle cannot import `settings/appSettings.ts` (it pulls in
 * `node:fs`), so this mirrors the shape that endpoint returns in production.
 * It is a fixture for tests only — the app never imports it.
 */
import type { AppSettings } from "../src/lib/appApi";

export const SMOKE_APP_SETTINGS: AppSettings = {
  version: 3,
  onboardingComplete: true,
  behavior: {
    proactivity: "balanced",
    awayCheckin: true,
    returnGreeting: true,
    awayAfterMin: 15,
    dndManual: false,
    autoDndFullscreen: true,
    autoDndMeetings: true,
    autoDndRecording: true,
  },
  autonomy: { maxSteps: 25, conflictWaitSec: 2, emergencyShortcut: "Ctrl+Alt+Shift+S", showTaskHud: true },
  voice: { voiceName: "Aoede", style: "anime", pitch: 2, bargeIn: true, speakTaskUpdates: "important" },
  companion: {
    enabled: false,
    setupComplete: true,
    scale: 1,
    fullscreenBehavior: "game_aware",
    clickThrough: false,
    interactionLevel: "normal",
    walkAround: true,
    iconPlay: false,
    standOut: 0.5,
    hideAndPeek: true,
  },
  character: { activeCharacterId: "default", eyeFollowCursor: true, headFollowCursor: true, idleVariety: 50 },
  graphics: { realism: 0.85, quality: "auto", autoStep: 0 },
  physics: {
    enabled: true,
    quality: "balanced",
    secondaryMotion: 1,
    gravityMultiplier: 1,
    stiffness: 1,
    damping: 1,
    drag: 1,
    collisionQuality: "low",
    wind: 0.2,
    clothEnabled: true,
    clothLooseness: 1,
  },
  privacy: { screenAwareness: true, cameraPresence: false, clipboardInContext: true },
  performance: { activeFps: 60, idleFps: 30, sleepFps: 10, perceptionPollSec: 2 },
  developer: { debugView: false, physicsDebug: false, verboseLogs: false },
  persona: {
    profile: "companion",
    context: "both",
    warmth: 78,
    humor: 55,
    formality: 30,
    directness: 55,
    empathy: 75,
    energy: 60,
    curiosity: 65,
  },
  reality: { mode: "standard", challengeAssumptions: true },
  calls: {
    enabled: true,
    answerKnownContacts: "ask",
    answerFamily: "ask",
    answerBusinessContacts: "ask",
    answerUnknownCall: false,
    answerDuringMeetings: false,
    answerDuringFocus: false,
    screenCalls: true,
    takeMessage: true,
    notifyOnMissed: true,
    maxCallMinutes: 20,
  },
};
