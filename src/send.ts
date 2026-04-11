/**
 * Telnyx SMS/MMS Channel — Outbound Messaging
 *
 * Sends SMS and MMS messages via the Telnyx Messaging API v2.
 * POST https://api.telnyx.com/v2/messages
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { loadConfig } from "openclaw/plugin-sdk/config-runtime";
import { resolveTelnyxSmsAccount } from "./accounts.js";
import type {
  TelnyxSendRequest,
  TelnyxSendResponse,
  TelnyxSmsSendResult,
} from "./types.js";

const TELNYX_API_BASE = "https://api.telnyx.com/v2";

export type TelnyxSmsSendOpts = {
  cfg?: OpenClawConfig;
  accountId?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  timeoutMs?: number;
};

/**
 * Send an SMS or MMS message via Telnyx.
 *
 * @param to    - Recipient phone number (E.164 format)
 * @param text  - Message body text
 * @param opts  - Additional options (media, account, timeout)
 */
export async function sendSmsTelnyx(
  to: string,
  text: string,
  opts: TelnyxSmsSendOpts = {},
): Promise<TelnyxSmsSendResult> {
  const cfg = opts.cfg ?? loadConfig();
  const account = resolveTelnyxSmsAccount({ cfg, accountId: opts.accountId });

  if (!account.config.apiKey) {
    throw new Error("Telnyx SMS: apiKey is required. Set channels.telnyx-sms.apiKey in openclaw.json.");
  }
  if (!account.phoneNumber) {
    throw new Error(
      "Telnyx SMS: phoneNumber is required. Set channels.telnyx-sms.phoneNumber in openclaw.json.",
    );
  }

  // Build request body
  const body: TelnyxSendRequest = {
    from: account.phoneNumber,
    to: to.trim(),
    text: text || "",
  };

  if (account.config.messagingProfileId) {
    body.messaging_profile_id = account.config.messagingProfileId;
  }

  // Collect media URLs for MMS
  const mediaUrls: string[] = [];
  if (opts.mediaUrl?.trim()) {
    mediaUrls.push(opts.mediaUrl.trim());
  }
  if (opts.mediaUrls?.length) {
    mediaUrls.push(...opts.mediaUrls.filter((url) => url.trim()));
  }
  if (mediaUrls.length > 0) {
    body.media_urls = mediaUrls.slice(0, 10); // Telnyx max: 10 media files
    body.type = "MMS";
  }

  // Send via Telnyx API
  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${TELNYX_API_BASE}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${account.config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      throw new Error(
        `Telnyx API ${response.status}: ${response.statusText}${errorBody ? ` — ${errorBody}` : ""}`,
      );
    }

    const result = (await response.json()) as TelnyxSendResponse;

    return {
      messageId: result.data.id,
      type: result.data.type,
      parts: result.data.parts,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Send a typing indicator. SMS doesn't support typing, so this is a no-op.
 * Included for interface compatibility with the OpenClaw channel contract.
 */
export async function sendTypingSms(
  _to: string,
  _opts?: { stop?: boolean },
): Promise<boolean> {
  // SMS protocol has no typing indicator concept
  return false;
}
