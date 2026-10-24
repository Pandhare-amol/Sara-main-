/**
 * Caller identity.
 *
 * The phone reports a number; SARA turns it into a peer record using the local
 * contact book. When nothing matches, the peer is marked `unknown` and the
 * policy forbids automatic answering — SARA never invents a name from a guess.
 */
import { normalizeAlias, phoneDigits, type Contact } from "../memory/contacts";
import type { CallPeer, ContactPriority, Relationship } from "./types";

const VALID_RELATIONSHIPS: ReadonlySet<Relationship> = new Set([
  "family",
  "friend",
  "business",
  "colleague",
  "service",
  "unknown",
]);

export function normalizePhone(raw: string | null | undefined): string | null {
  const digits = phoneDigits(raw || "");
  if (digits.length < 7 || digits.length > 15) return null;
  return digits;
}

/** Pretty form for display only; the device dials what the user confirmed. */
export function formatPhone(raw: string): string {
  const digits = phoneDigits(raw);
  if (digits.length === 10) return `${digits.slice(0, 5)} ${digits.slice(5)}`;
  if (digits.length === 12 && digits.startsWith("91")) return `+91 ${digits.slice(2, 7)} ${digits.slice(7)}`;
  return digits.startsWith("+") ? digits : raw.trim();
}

export function relationshipOf(contact: Contact | undefined): Relationship {
  const value = contact?.relationship;
  return value && VALID_RELATIONSHIPS.has(value) ? value : "unknown";
}

export function priorityOf(contact: Contact | undefined): ContactPriority {
  return contact?.priority ?? "normal";
}

/**
 * Build the peer record for a call. `reportedName` is what the device claimed
 * (carrier CNAM or the phone's own contact list); it is kept only as a hint and
 * never overrides a matched local contact.
 */
export function buildPeer(input: {
  number: string;
  reportedName?: string | null;
  contact?: Contact | null;
}): CallPeer {
  const number = input.number.trim();
  const contact = input.contact || null;
  if (!contact) {
    return {
      number,
      name: input.reportedName?.trim() || null,
      contactId: null,
      relationship: "unknown",
      organization: null,
      priority: "normal",
      unknown: true,
    };
  }
  return {
    number,
    name: contact.displayName || input.reportedName?.trim() || null,
    contactId: contact.id,
    relationship: relationshipOf(contact),
    organization: contact.organization ?? null,
    priority: priorityOf(contact),
    unknown: false,
  };
}

/** True when the name the caller gave plausibly matches the stored contact. */
export function nameMatchesContact(spokenName: string, contact: Contact): boolean {
  const spoken = normalizeAlias(spokenName);
  if (!spoken) return false;
  const names = [contact.displayName, ...(contact.aliases || []), ...Object.values(contact.appNames || {})];
  return names.some((name) => {
    const candidate = normalizeAlias(name);
    if (!candidate) return false;
    if (candidate === spoken) return true;
    const a = new Set(candidate.split(" "));
    const b = spoken.split(" ");
    return b.length > 0 && b.every((token) => a.has(token) || candidate.includes(token));
  });
}
