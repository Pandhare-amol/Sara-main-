/**
 * Incoming-call policy.
 *
 * Pure and deterministic, so every branch is testable without a phone.
 *
 * The rules encode one principle: SARA never decides on her own that an unknown
 * caller may be answered. `answerUnknownCall = true` only means the user is
 * asked; it never means "answer automatically".
 */
import type { CallPolicyContext, CallPolicyDecision, CallPresence } from "./types";

const NEVER: CallPolicyDecision = {
  action: "reject",
  reason: "This caller type is set to never auto-answer.",
  requiresUser: false,
  command: "reject_call",
};

export function decideIncomingCall({ settings, peer, presence }: CallPolicyContext): CallPolicyDecision {
  const calls = settings.calls;

  if (!calls.enabled) {
    return {
      action: "notify",
      reason: "Phone integration is switched off, so SARA only reports the call.",
      requiresUser: true,
      command: "none",
    };
  }

  const quiet = describeQuiet(presence);

  // Presence gates come first: during a meeting or focus time even an allowed
  // caller goes to a notification unless the user explicitly allowed it.
  if (quiet && !allowedDuring(presence, calls)) {
    return {
      action: "notify",
      reason: `${quiet} — the call is reported, not answered.`,
      requiresUser: true,
      command: "none",
    };
  }

  if (peer.unknown || peer.contactId === null) {
    if (!calls.answerUnknownCall) {
      return {
        action: "notify",
        reason: "Unknown number. SARA reports it and lets you decide.",
        requiresUser: true,
        command: "none",
      };
    }
    return {
      action: "ask_user",
      reason: "Unknown number, but you allowed SARA to ask about unknown callers.",
      requiresUser: true,
      command: "none",
    };
  }

  // A contact flagged low priority (spam-like behaviour) is never auto-answered.
  if (peer.priority === "low") {
    return {
      action: "notify",
      reason: `${displayName(peer)} is marked low priority, so SARA will not answer for you.`,
      requiresUser: true,
      command: "none",
    };
  }

  const mode = modeFor(peer.relationship, peer.contactId, calls);
  if (mode === "never") return { ...NEVER, reason: `${displayName(peer)} is in a group you set to never answer.` };

  if (mode === "ask") {
    return {
      action: "ask_user",
      reason: `${displayName(peer)} is calling. Your policy says ask before answering.`,
      requiresUser: true,
      command: "none",
    };
  }

  // mode === "auto"
  if (calls.screenCalls) {
    return {
      action: "screen",
      reason: `${displayName(peer)} is calling; SARA answers and screens the call first.`,
      requiresUser: false,
      command: "answer_call",
    };
  }

  return {
    action: "answer_auto",
    reason: `${displayName(peer)} is calling and your policy allows SARA to answer.`,
    requiresUser: false,
    command: "answer_call",
  };
}

function modeFor(
  relationship: CallPolicyContext["peer"]["relationship"],
  contactId: string | null,
  calls: CallPolicyContext["settings"]["calls"],
): "never" | "ask" | "auto" {
  if (contactId === null) return "never";
  if (relationship === "family") return calls.answerFamily;
  if (relationship === "business" || relationship === "colleague") return calls.answerBusinessContacts;
  return calls.answerKnownContacts;
}

function allowedDuring(presence: CallPresence, calls: CallPolicyContext["settings"]["calls"]): boolean {
  if (presence.inMeeting && !calls.answerDuringMeetings) return false;
  if (presence.focusMode && !calls.answerDuringFocus) return false;
  return true;
}

function describeQuiet(presence: CallPresence): string | null {
  if (presence.inMeeting) return "You are in a meeting";
  if (presence.focusMode) return "Focus mode is on";
  return null;
}

function displayName(peer: CallPolicyContext["peer"]): string {
  return peer.name || peer.number;
}

/**
 * Outgoing calls always need an explicit, confirmed target. This is separate
 * from the incoming policy: nobody's rule set should let SARA dial by itself.
 */
export function requiresOutgoingConfirmation(): boolean {
  return true;
}

/** Ring time before the device should stop waiting for a human. */
export function answerWindowMs(): number {
  return 25_000;
}
