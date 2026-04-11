/**
 * Telnyx SMS/MMS Channel — Target Normalization
 *
 * Normalizes phone numbers and SMS targets for session routing
 * and outbound messaging. All targets are E.164 phone numbers.
 */

import { normalizeE164 } from "openclaw/plugin-sdk/text-runtime";

/**
 * Normalize a raw SMS target string to a canonical E.164 form.
 * Accepts formats like: +15551234567, sms:+15551234567, 15551234567, (555) 123-4567
 */
export function normalizeSmsMessagingTarget(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  // Strip optional sms: prefix
  let normalized = trimmed;
  if (normalized.toLowerCase().startsWith("sms:")) {
    normalized = normalized.slice("sms:".length).trim();
  }
  if (normalized.toLowerCase().startsWith("telnyx:")) {
    normalized = normalized.slice("telnyx:".length).trim();
  }

  if (!normalized) return undefined;

  // Normalize to E.164
  const e164 = normalizeE164(normalized);
  return e164 ?? undefined;
}

/**
 * Check if a raw string looks like a valid SMS target (phone number).
 */
export function looksLikeSmsTargetId(raw: string, normalized?: string): boolean {
  const candidates = [raw, normalized ?? ""].map((v) => v.trim()).filter(Boolean);
  for (const candidate of candidates) {
    const stripped = candidate
      .replace(/^(sms:|telnyx:)/i, "")
      .trim();
    if (!stripped) continue;
    // E.164 pattern or digit-heavy string
    if (/^\+?\d{7,15}$/.test(stripped.replace(/[\s\-().]/g, ""))) {
      return true;
    }
  }
  return false;
}

/**
 * Parse an explicit target from a user-provided string.
 * SMS is always direct (no groups).
 */
export function parseSmsExplicitTarget(raw: string): { to: string; chatType: "direct" } | null {
  const normalized = normalizeSmsMessagingTarget(raw);
  if (!normalized) return null;
  return { to: normalized, chatType: "direct" };
}

/**
 * Infer the chat type from a target — SMS is always "direct".
 */
export function inferSmsChatType(_to: string): "direct" {
  return "direct";
}
