/**
 * Telnyx SMS/MMS Channel — Inbound Monitor
 *
 * Registers an HTTP webhook endpoint on the OpenClaw gateway to receive
 * inbound SMS/MMS messages from Telnyx. When a message arrives:
 *
 *  1. Verify Ed25519 signature (if webhookPublicKey configured)
 *  2. ACK immediately with 200 (Telnyx requires response within 2 seconds)
 *  3. Normalize the Telnyx payload into an OpenClaw inbound context
 *  4. Dispatch through the standard reply pipeline
 *
 * This module follows the same inbound pattern as Signal's event-handler.ts
 * and WhatsApp's auto-reply.ts, using the plugin-sdk's dispatchInboundMessage.
 */

import { formatInboundEnvelope, formatInboundFromLabel } from "openclaw/plugin-sdk/channel-inbound";
import { resolveEnvelopeFormatOptions } from "openclaw/plugin-sdk/channel-inbound";
import { createChannelReplyPipeline } from "openclaw/plugin-sdk/channel-reply-pipeline";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { loadConfig, readSessionUpdatedAt, resolveStorePath } from "openclaw/plugin-sdk/config-runtime";
import { recordInboundSession } from "openclaw/plugin-sdk/conversation-runtime";
import { kindFromMime } from "openclaw/plugin-sdk/media-runtime";
import { saveMediaBuffer } from "openclaw/plugin-sdk/media-runtime";
import { deliverTextOrMediaReply, resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { chunkTextWithMode, resolveChunkMode, resolveTextChunkLimit } from "openclaw/plugin-sdk/reply-runtime";
import { dispatchInboundMessage, finalizeInboundContext } from "openclaw/plugin-sdk/reply-runtime";
import { createReplyDispatcherWithTyping } from "openclaw/plugin-sdk/reply-runtime";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { createNonExitingRuntime, type RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { logVerbose, danger } from "openclaw/plugin-sdk/runtime-env";
import { normalizeE164 } from "openclaw/plugin-sdk/text-runtime";
import { resolveTelnyxSmsAccount } from "./accounts.js";
import { normalizeSmsMessagingTarget } from "./normalize.js";
import { sendSmsTelnyx } from "./send.js";
import type { TelnyxWebhookEvent, TelnyxMessagePayload } from "./types.js";
import { verifyTelnyxWebhook, extractWebhookIdempotencyKey } from "./webhook.js";

const CHANNEL_ID = "telnyx-sms";

export type MonitorTelnyxSmsOpts = {
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  accountId?: string;
  config?: OpenClawConfig;
};

function resolveRuntime(opts: MonitorTelnyxSmsOpts): RuntimeEnv {
  return opts.runtime ?? createNonExitingRuntime();
}

/** Set of recently-processed event IDs for deduplication. */
const processedEvents = new Map<string, number>();
const DEDUP_TTL_MS = 10 * 60 * 1000; // 10 minutes

function isDuplicate(eventId: string): boolean {
  const now = Date.now();
  // Purge stale entries
  for (const [key, ts] of processedEvents) {
    if (now - ts > DEDUP_TTL_MS) processedEvents.delete(key);
  }
  if (processedEvents.has(eventId)) return true;
  processedEvents.set(eventId, now);
  return false;
}

/**
 * Process an inbound Telnyx webhook event.
 * Called by the gateway HTTP handler after ACKing the webhook.
 */
async function handleInboundSms(params: {
  event: TelnyxWebhookEvent;
  cfg: OpenClawConfig;
  accountId: string;
  runtime: RuntimeEnv;
}) {
  const { event, cfg, accountId, runtime } = params;
  const payload = event.data.payload;

  // Only handle inbound messages
  if (payload.direction !== "inbound") return;

  const account = resolveTelnyxSmsAccount({ cfg, accountId });
  if (!account.enabled || !account.configured) {
    logVerbose(`telnyx-sms: account ${accountId} not enabled/configured, skipping`);
    return;
  }

  // Extract sender info
  const senderPhone = normalizeE164(payload.from.phone_number) ?? payload.from.phone_number;
  const senderDisplay = senderPhone;
  const senderName = payload.from.carrier
    ? `${senderPhone} (${payload.from.carrier})`
    : senderPhone;

  // Check allowlist
  const dmPolicy = account.config.dmPolicy ?? "allowlist";
  if (dmPolicy === "disabled") {
    logVerbose(`telnyx-sms: DM policy disabled, dropping message from ${senderDisplay}`);
    return;
  }
  if (dmPolicy === "allowlist") {
    const allowFrom = account.config.allowFrom ?? [];
    const senderNormalized = normalizeE164(senderPhone) ?? senderPhone;
    const isAllowed =
      allowFrom.length === 0 ||
      allowFrom.some((entry) => {
        if (entry === "*") return true;
        const normalized = normalizeE164(entry) ?? entry;
        return normalized === senderNormalized;
      });
    if (!isAllowed) {
      logVerbose(
        `telnyx-sms: sender ${senderDisplay} not in allowFrom, dropping`,
      );
      return;
    }
  }

  // Build message text
  const messageText = (payload.text ?? "").trim();

  // Handle MMS media
  let mediaPath: string | undefined;
  let mediaType: string | undefined;
  const mediaPaths: string[] = [];
  const mediaTypes: string[] = [];
  const maxBytes = (account.config.mediaMaxMb ?? 1) * 1024 * 1024;

  if (payload.media?.length) {
    for (const media of payload.media) {
      if (!media.url) continue;
      if (media.size && media.size > maxBytes) {
        runtime.error?.(
          `telnyx-sms: media ${media.content_type} exceeds ${account.config.mediaMaxMb ?? 1}MB limit`,
        );
        continue;
      }
      try {
        // Download media from Telnyx URL (expires after 30 days)
        const response = await fetch(media.url);
        if (!response.ok) {
          runtime.error?.(`telnyx-sms: failed to download media: HTTP ${response.status}`);
          continue;
        }
        const buffer = Buffer.from(await response.arrayBuffer());
        const saved = await saveMediaBuffer(
          buffer,
          media.content_type || undefined,
          "inbound",
          maxBytes,
        );
        mediaPaths.push(saved.path);
        mediaTypes.push(saved.contentType ?? media.content_type ?? "application/octet-stream");
        if (!mediaPath) {
          mediaPath = saved.path;
          mediaType = saved.contentType ?? media.content_type ?? undefined;
        }
      } catch (err) {
        runtime.error?.(danger(`telnyx-sms: media download failed: ${String(err)}`));
      }
    }
  }

  // Build placeholder for media-only messages
  let placeholder = "";
  if (mediaPaths.length > 0) {
    const kind = kindFromMime(mediaType);
    placeholder = kind ? `<media:${kind}>` : "<media:attachment>";
  }
  const bodyText = messageText || placeholder;
  if (!bodyText) {
    logVerbose("telnyx-sms: empty message (no text or media), skipping");
    return;
  }

  // Resolve agent routing
  const route = resolveAgentRoute({
    cfg,
    channel: CHANNEL_ID,
    accountId,
    peer: { kind: "direct", id: senderPhone },
  });

  const storePath = resolveStorePath(cfg.session?.store, { agentId: route.agentId });
  const envelopeOptions = resolveEnvelopeFormatOptions(cfg);
  const previousTimestamp = readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });

  const fromLabel = formatInboundFromLabel({
    isGroup: false,
    directLabel: senderName,
    directId: senderDisplay,
  });

  const body = formatInboundEnvelope({
    channel: "SMS",
    from: fromLabel,
    timestamp: new Date(event.data.occurred_at).getTime(),
    body: bodyText,
    chatType: "direct",
    sender: { name: senderName, id: senderDisplay },
    previousTimestamp,
    envelope: envelopeOptions,
  });

  const smsTo = normalizeSmsMessagingTarget(senderPhone) ?? senderPhone;

  const ctxPayload = finalizeInboundContext({
    Body: body,
    BodyForAgent: bodyText,
    RawBody: messageText,
    CommandBody: messageText,
    BodyForCommands: messageText,
    From: `sms:${senderPhone}`,
    To: smsTo,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: "direct" as const,
    ConversationLabel: fromLabel,
    SenderName: senderName,
    SenderId: senderDisplay,
    Provider: CHANNEL_ID as "telnyx-sms",
    Surface: "sms" as const,
    MessageSid: event.data.id,
    Timestamp: new Date(event.data.occurred_at).getTime(),
    MediaPath: mediaPath,
    MediaType: mediaType,
    MediaUrl: mediaPath,
    MediaPaths: mediaPaths.length > 0 ? mediaPaths : undefined,
    MediaUrls: mediaPaths.length > 0 ? mediaPaths : undefined,
    MediaTypes: mediaTypes.length > 0 ? mediaTypes : undefined,
    CommandAuthorized: true,
    OriginatingChannel: CHANNEL_ID as "telnyx-sms",
    OriginatingTo: smsTo,
  });

  // Record inbound session
  await recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    updateLastRoute: {
      sessionKey: route.mainSessionKey,
      channel: CHANNEL_ID,
      to: senderPhone,
      accountId: route.accountId,
    },
    onRecordError: (err) => {
      logVerbose(`telnyx-sms: failed updating session meta: ${String(err)}`);
    },
  });

  // Resolve text chunking limits
  const textLimit = resolveTextChunkLimit(cfg, CHANNEL_ID, accountId) ?? 1600; // SMS segment-friendly
  const chunkMode = resolveChunkMode(cfg, CHANNEL_ID, accountId);

  // Build reply pipeline
  const { onModelSelected, typingCallbacks, ...replyPipeline } = createChannelReplyPipeline({
    cfg,
    agentId: route.agentId,
    channel: CHANNEL_ID,
    accountId: route.accountId,
    typing: {
      // SMS doesn't support typing indicators — no-op
      start: async () => {},
    },
  });

  const { dispatcher, replyOptions, markDispatchIdle } = createReplyDispatcherWithTyping({
    ...replyPipeline,
    typingCallbacks,
    deliver: async (replyPayload: ReplyPayload) => {
      const reply = resolveSendableOutboundReplyParts(replyPayload);
      await deliverTextOrMediaReply({
        payload: replyPayload,
        text: reply.text,
        chunkText: (value) => chunkTextWithMode(value, textLimit, chunkMode),
        sendText: async (chunk) => {
          await sendSmsTelnyx(senderPhone, chunk, { cfg, accountId });
        },
        sendMedia: async ({ mediaUrl, caption }) => {
          await sendSmsTelnyx(senderPhone, caption ?? "", {
            cfg,
            accountId,
            mediaUrl,
          });
        },
      });
    },
    onError: (err, info) => {
      runtime.error?.(danger(`telnyx-sms ${info.kind} reply failed: ${String(err)}`));
    },
  });

  // Dispatch through standard inference pipeline
  const { queuedFinal } = await dispatchInboundMessage({
    ctx: ctxPayload,
    cfg,
    dispatcher,
    replyOptions: {
      ...replyOptions,
      onModelSelected,
    },
  });
  markDispatchIdle();

  if (queuedFinal) {
    logVerbose(`telnyx-sms: reply dispatched to ${senderDisplay}`);
  }
}

/**
 * Start the Telnyx SMS monitor.
 *
 * Registers a webhook handler on the gateway's HTTP server and processes
 * inbound SMS messages through the OpenClaw inference pipeline.
 *
 * This function is called by `gateway.startAccount` in the channel plugin
 * and runs until the abort signal fires.
 */
export async function monitorTelnyxSmsProvider(opts: MonitorTelnyxSmsOpts = {}): Promise<void> {
  const runtime = resolveRuntime(opts);
  const cfg = opts.config ?? loadConfig();
  const account = resolveTelnyxSmsAccount({ cfg, accountId: opts.accountId });

  runtime.log?.(`[${account.accountId}] Telnyx SMS monitor starting (${account.phoneNumber})`);

  if (!account.configured) {
    runtime.error?.(
      `[${account.accountId}] Telnyx SMS not configured: apiKey and phoneNumber required`,
    );
    return;
  }

  // The webhook HTTP handler is registered by the gateway when it calls
  // `startAccount`. The gateway maps:
  //   POST /hooks/telnyx-sms/inbound → this handler
  //
  // This monitor function sets up the handler and then waits for abort.

  const webhookHandler = async (req: {
    rawBody: string;
    headers: Record<string, string>;
  }): Promise<{ status: number; body?: string }> => {
    // CRITICAL: Respond within 2 seconds — Telnyx will retry on timeout.
    // We ACK immediately and process asynchronously.

    const eventId = extractWebhookIdempotencyKey(req.rawBody);
    if (eventId && isDuplicate(eventId)) {
      return { status: 200, body: "duplicate" };
    }

    // Verify signature if public key is configured
    if (account.config.webhookPublicKey) {
      const result = verifyTelnyxWebhook({
        rawBody: req.rawBody,
        signature: req.headers["telnyx-signature-ed25519"] ?? "",
        timestamp: req.headers["telnyx-timestamp"] ?? "",
        publicKey: account.config.webhookPublicKey,
      });
      if (!result.valid) {
        runtime.error?.(`telnyx-sms: webhook signature invalid: ${result.reason}`);
        return { status: 401, body: "invalid signature" };
      }
    }

    // Parse the event
    let event: TelnyxWebhookEvent;
    try {
      event = JSON.parse(req.rawBody) as TelnyxWebhookEvent;
    } catch {
      return { status: 400, body: "invalid JSON" };
    }

    // Only process message.received events
    if (event.data.event_type !== "message.received") {
      return { status: 200, body: "ignored" };
    }

    // Process asynchronously — don't block the 200 response
    void handleInboundSms({
      event,
      cfg,
      accountId: account.accountId,
      runtime,
    }).catch((err) => {
      runtime.error?.(danger(`telnyx-sms: inbound handler failed: ${String(err)}`));
    });

    return { status: 200, body: "ok" };
  };

  // Expose the handler for the gateway to wire up
  (globalThis as Record<string, unknown>)[
    `__openclaw_telnyx_sms_webhook_${account.accountId}`
  ] = webhookHandler;

  // Wait for abort signal
  if (opts.abortSignal) {
    await new Promise<void>((resolve) => {
      if (opts.abortSignal!.aborted) {
        resolve();
        return;
      }
      opts.abortSignal!.addEventListener("abort", () => resolve(), { once: true });
    });
  }

  // Cleanup
  delete (globalThis as Record<string, unknown>)[
    `__openclaw_telnyx_sms_webhook_${account.accountId}`
  ];
  runtime.log?.(`[${account.accountId}] Telnyx SMS monitor stopped`);
}
