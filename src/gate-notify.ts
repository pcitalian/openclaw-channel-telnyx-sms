/**
 * Telnyx SMS/MMS Channel — Unknown Sender Gate & Notification
 *
 * When an SMS arrives from a number NOT in the allowlist:
 *  1. Log the event as "dropped" with reason
 *  2. Send an admin notification to a configured channel (WhatsApp, Discord, etc.)
 *     with sender info, message preview, and instructions to approve
 *  3. Optionally auto-reply to the sender with a configurable rejection message
 *
 * Config (in openclaw.json under channels.telnyx-sms):
 *   "gateNotify": {
 *     "enabled": true,
 *     "notifyChannel": "whatsapp",           // channel to send admin alerts to
 *     "notifyTarget": "+15559876543",         // admin phone/ID on that channel
 *     "rejectReply": "This number is not authorized to message this service.",
 *     "cooldownMinutes": 15                   // don't re-notify for same number within N min
 *   }
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { logVerbose, danger } from "openclaw/plugin-sdk/runtime-env";
import { smsEventLog } from "./event-log.js";

export interface GateNotifyConfig {
  enabled?: boolean;
  /** Which channel to send admin notification to (e.g. "whatsapp", "discord") */
  notifyChannel?: string;
  /** Target on that channel (phone number, channel ID, etc.) */
  notifyTarget?: string;
  /** Optional auto-reply to rejected sender */
  rejectReply?: string;
  /** Cooldown in minutes — don't re-notify for the same number within this window */
  cooldownMinutes?: number;
}

/** Track recently notified numbers to avoid spamming admin. */
const recentNotifications = new Map<string, number>();

function isInCooldown(phone: string, cooldownMs: number): boolean {
  const lastNotified = recentNotifications.get(phone);
  if (!lastNotified) return false;
  if (Date.now() - lastNotified < cooldownMs) return true;
  return false;
}

function markNotified(phone: string): void {
  recentNotifications.set(phone, Date.now());
  // Prune old entries (keep last 200)
  if (recentNotifications.size > 200) {
    const oldest = [...recentNotifications.entries()]
      .sort(([, a], [, b]) => a - b)
      .slice(0, recentNotifications.size - 100);
    for (const [key] of oldest) {
      recentNotifications.delete(key);
    }
  }
}

/**
 * Resolve gate notification config from the channel section.
 */
export function resolveGateNotifyConfig(
  channelConfig: Record<string, unknown>,
): GateNotifyConfig {
  const raw = channelConfig.gateNotify as Record<string, unknown> | undefined;
  if (!raw) return { enabled: false };
  return {
    enabled: raw.enabled !== false,
    notifyChannel: raw.notifyChannel as string | undefined,
    notifyTarget: raw.notifyTarget as string | undefined,
    rejectReply: raw.rejectReply as string | undefined,
    cooldownMinutes:
      typeof raw.cooldownMinutes === "number" ? raw.cooldownMinutes : 15,
  };
}

/**
 * Handle an unknown sender that was rejected by the allowlist.
 *
 * Returns true if a notification was sent, false if skipped (cooldown, not configured, etc.)
 */
export async function handleUnknownSenderGate(params: {
  senderPhone: string;
  messagePreview: string;
  cfg: OpenClawConfig;
  channelConfig: Record<string, unknown>;
  /** Function to send an SMS reply (for rejection message) */
  sendReply?: (to: string, text: string) => Promise<void>;
}): Promise<boolean> {
  const { senderPhone, messagePreview, cfg, channelConfig, sendReply } = params;
  const gate = resolveGateNotifyConfig(channelConfig);

  // Log the dropped event regardless
  smsEventLog.record({
    direction: "inbound",
    phoneNumber: senderPhone,
    status: "dropped",
    dropReason: "not in allowlist",
    preview: messagePreview.slice(0, 80),
  });

  if (!gate.enabled) {
    logVerbose(`telnyx-sms: gate notify disabled, silently dropping ${senderPhone}`);
    return false;
  }

  // Send rejection auto-reply if configured
  if (gate.rejectReply && sendReply) {
    try {
      await sendReply(senderPhone, gate.rejectReply);
      smsEventLog.record({
        direction: "outbound",
        phoneNumber: senderPhone,
        status: "success",
        preview: gate.rejectReply.slice(0, 80),
      });
    } catch (err) {
      logVerbose(
        danger(`telnyx-sms: failed to send rejection reply to ${senderPhone}: ${String(err)}`),
      );
      smsEventLog.record({
        direction: "outbound",
        phoneNumber: senderPhone,
        status: "error",
        error: String(err).slice(0, 200),
        preview: gate.rejectReply.slice(0, 80),
      });
    }
  }

  // Check cooldown
  const cooldownMs = (gate.cooldownMinutes ?? 15) * 60 * 1000;
  if (isInCooldown(senderPhone, cooldownMs)) {
    logVerbose(`telnyx-sms: gate notify cooldown active for ${senderPhone}, skipping notification`);
    return false;
  }

  // Send admin notification via another channel
  if (!gate.notifyChannel || !gate.notifyTarget) {
    logVerbose(
      `telnyx-sms: gate notify enabled but no notifyChannel/notifyTarget configured`,
    );
    return false;
  }

  try {
    // Use OpenClaw's outbound messaging to send to the admin channel
    // We dynamically import the send function for the target channel
    const notifyMessage = formatGateNotification(senderPhone, messagePreview);

    // Use the delivery queue to send via the configured channel
    const { deliverOutboundText } = await import(
      "openclaw/plugin-sdk/outbound-delivery"
    );
    await deliverOutboundText({
      cfg,
      channel: gate.notifyChannel,
      to: gate.notifyTarget,
      text: notifyMessage,
    });

    markNotified(senderPhone);
    logVerbose(
      `telnyx-sms: gate notification sent to ${gate.notifyChannel}:${gate.notifyTarget} for ${senderPhone}`,
    );
    return true;
  } catch (err) {
    // Fallback: try logging the notification if delivery fails
    logVerbose(
      danger(
        `telnyx-sms: gate notification delivery failed: ${String(err)}. ` +
          `Attempted to notify ${gate.notifyChannel}:${gate.notifyTarget} about ${senderPhone}`,
      ),
    );
    markNotified(senderPhone); // Still mark to avoid spam on repeated failures
    return false;
  }
}

/**
 * Format the admin notification message.
 */
function formatGateNotification(senderPhone: string, messagePreview: string): string {
  const preview =
    messagePreview.length > 120
      ? messagePreview.slice(0, 120) + "…"
      : messagePreview;

  return [
    `📱 SMS from unknown number`,
    `From: ${senderPhone}`,
    `Message: "${preview}"`,
    ``,
    `To allow this number, add it to the telnyx-sms allowFrom list:`,
    `  openclaw config channels.telnyx-sms.allowFrom --add "${senderPhone}"`,
    ``,
    `Or reply to this message with: /sms allow ${senderPhone}`,
  ].join("\n");
}
