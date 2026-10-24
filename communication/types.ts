/**
 * Communication domain types.
 *
 * Scope, stated plainly: a Windows desktop process cannot read or control a
 * cellular call. Call state therefore enters SARA as events from an authorised
 * companion device (the Android app), over the existing authenticated HTTP
 * transport. This module defines that contract and the records SARA keeps.
 *
 * Nothing here pretends a call happened. A record only moves to CONNECTED when
 * the device reports CONNECTED, and an outgoing call stays `pending_device`
 * until the device acknowledges it.
 */

export const CALL_STATES = [
  "RINGING",
  "CONNECTED",
  "ACTIVE",
  "HELD",
  "ENDED",
  "MISSED",
  "REJECTED",
  "FAILED",
  "UNKNOWN",
] as const;

export type CallState = (typeof CALL_STATES)[number];

/** Terminal states: no further transitions are accepted except a late duplicate. */
export const TERMINAL_CALL_STATES: ReadonlySet<CallState> = new Set([
  "ENDED",
  "MISSED",
  "REJECTED",
  "FAILED",
]);

export type CallDirection = "incoming" | "outgoing";

export type Relationship = "family" | "friend" | "business" | "colleague" | "service" | "unknown";

export type ContactPriority = "high" | "normal" | "low";

/** What SARA knows about the other end, before any policy decision. */
export interface CallPeer {
  /** E.164-ish or as the device reported it. Never guessed. */
  number: string;
  name: string | null;
  contactId: string | null;
  relationship: Relationship;
  organization: string | null;
  priority: ContactPriority;
  /** True when no contact matched — the policy treats this as untrusted. */
  unknown: boolean;
}

export interface CallEventInput {
  /** What the device observed. `state` carries an explicit state machine value. */
  type: "ringing" | "connected" | "held" | "ended" | "missed" | "rejected" | "failed" | "state";
  /** Device-side call identifier; stable for the whole call. */
  callId: string;
  deviceId: string;
  direction?: CallDirection;
  number?: string;
  name?: string | null;
  state?: CallState;
  /** ISO timestamp from the device; the server clamps implausible values. */
  at?: string;
  /** Turns reported by the device when it ran speech recognition. */
  transcript?: Array<{ role: "caller" | "sara"; text: string; at?: string }>;
  metadata?: Record<string, string | number | boolean | null>;
}

export type CallAction = "answer_auto" | "ask_user" | "screen" | "notify" | "reject" | "voicemail";

export interface CallPolicyDecision {
  action: CallAction;
  /** Short, user-readable explanation. Shown in the UI and written to the audit log. */
  reason: string;
  /** True when SARA must not act until the user answers. */
  requiresUser: boolean;
  /** The device-side command to send once the decision is carried out. */
  command: "answer_call" | "reject_call" | "none";
}

/** Presence facts the policy needs. Supplied by the runtime, not invented here. */
export interface CallPresence {
  inMeeting: boolean;
  focusMode: boolean;
}

export interface CallPolicyContext {
  settings: {
    calls: {
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
    };
  };
  peer: CallPeer;
  presence: CallPresence;
}

export interface CallMessageRecord {
  id: string;
  callId: string | null;
  callerName: string | null;
  number: string;
  text: string;
  at: string;
  /** Where the message came from: SARA taking it during a call, or the user. */
  source: "call" | "manual";
}

export interface CallSummary {
  /** Only populated from material the device actually reported. */
  caller: string | null;
  number: string;
  purpose: string | null;
  requests: string[];
  promises: string[];
  deadlines: string[];
  followUps: string[];
  messages: string[];
  sentiment: "positive" | "neutral" | "negative" | "unknown";
  urgency: "high" | "normal" | "low" | "unknown";
  /** What the summary was built from — so it is never read as a full transcript. */
  basis: string[];
  /** Honest gaps, e.g. "No transcript was reported by the device." */
  notes: string[];
}

export interface CallRecord {
  id: string;
  deviceCallId: string;
  deviceId: string;
  direction: CallDirection;
  peer: CallPeer;
  state: CallState;
  decision: CallPolicyDecision | null;
  createdAt: string;
  updatedAt: string;
  answeredAt: string | null;
  endedAt: string | null;
  durationSec: number | null;
  /** Turn-by-turn text the device reported; [] when it reported none. */
  transcript: Array<{ role: "caller" | "sara"; text: string; at: string }>;
  metadata: Record<string, string | number | boolean | null>;
}

export type DeviceCommandKind = "place_call" | "answer_call" | "reject_call" | "end_call";

export interface DeviceCommand {
  id: string;
  deviceId: string;
  kind: DeviceCommandKind;
  /** Only ever contains what the device needs to act (number, call id). */
  payload: Record<string, string | number | boolean | null>;
  createdAt: string;
  expiresAt: string;
  status: "pending" | "acked";
  ackedAt: string | null;
  result: string | null;
}

export interface OutgoingCallRequest {
  /** A contact the user named, or an explicit number. Never both is required. */
  query?: string;
  number?: string;
  purpose?: string;
  /** The user has seen the preview and approved it. */
  confirmed?: boolean;
  deviceId?: string;
}

export interface OutgoingCallPlan {
  status: "needs_confirmation" | "queued" | "ambiguous" | "unknown_contact" | "refused";
  message: string;
  target?: { name: string | null; number: string; contactId: string | null };
  candidates?: Array<{ id: string; displayName: string }>;
  command?: DeviceCommand;
}
