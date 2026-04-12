/**
 * Telnyx SMS/MMS Channel — Inbound Monitor
 *
 * Creates a dedicated HTTP webhook server (following the same pattern as
 * Telegram's webhook.ts) to receive inbound SMS/MMS from Telnyx.
 *
 * Flow:
 *  1. Start HTTP server on configurable port (default 8788)
 *  2. Receive POST from Telnyx with message.received event
 *  3. Verify Ed25519 signature (if webhookPublicKey configured)
 *  4. ACK immediately with 200 (Telnyx requires response within 2 seconds)
 *  5. Process async: normalize → dispatch → reply pipeline → send SMS reply
 */

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { formatInboundEnvelope, formatInboundFromLabel } from "openclaw/plugin-sdk/channel-inbound";
import { resolveEnvelopeFormatOptions } from "openclaw/plugin-sdk/channel-inbound";
import { createChannelReplyPipeline } from "openclaw/plugin-sdk/channel-reply-pipeline";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { loadConfig, readSessionUpdatedAt, resolveStorePath } from "openclaw/plugin-sdk/config-runtime";
import { recordInboundSession } from "openclaw/plugin-sdk/conversation-runtime";
import { deliverTextOrMediaReply, resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { chunkTextWithMode, resolveChunkMode, resolveTextChunkLimit } from "openclaw/plugin-sdk/reply-runtime";
import { dispatchInboundMessage, finalizeInboundContext } from "openclaw/plugin-sdk/reply-runtime";
import { createReplyDispatcherWithTyping } from "openclaw/plugin-sdk/reply-runtime";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { createNonExitingRuntime, logVerbose, danger } from "openclaw/plugin-sdk/runtime-env";
import {
  applyBasicWebhookRequestGuards,
  createFixedWindowRateLimiter,
  WEBHOOK_RATE_LIMIT_DEFAULTS,
} from "openclaw/plugin-sdk/webhook-ingress";

import { resolveTelnyxSmsAccount } from "./accounts.js";
import { smsEventLog } from "./event-log.js";
import { handleUnknownSenderGate } from "./gate-notify.js";
import { normalizeE164, normalizeSmsMessagingTarget } from "./normalize.js";
import { sendSmsTelnyx } from "./send.js";
import type { TelnyxWebhookEvent, TelnyxMessagePayload } from "./types.js";
import { verifyTelnyxWebhook, extractWebhookIdempotencyKey } from "./webhook.js";

const CHANNEL_ID = "telnyx-sms";
const TELNYX_WEBHOOK_MAX_BODY_BYTES = 512 * 1024;
const TELNYX_WEBHOOK_BODY_TIMEOUT_MS = 10_000;
const DEFAULT_WEBHOOK_PORT = 8788;
const DEFAULT_WEBHOOK_PATH = "/telnyx-sms-webhook";

export type MonitorTelnyxSmsOpts = {
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  accountId?: string;
  config?: OpenClawConfig;
};

/** Set of recently-processed event IDs for deduplication. */
const processedEvents = new Map<string, number>();
const DEDUP_TTL_MS = 10 * 60 * 1000; // 10 minutes

function isDuplicate(eventId: string): boolean {
  const now = Date.now();
  for (const [key, ts] of processedEvents) {
    if (now - ts > DEDUP_TTL_MS) processedEvents.delete(key);
  }
  if (processedEvents.has(eventId)) return true;
  processedEvents.set(eventId, now);
  return false;
}

/**
 * Process an inbound Telnyx webhook event through the OpenClaw inference pipeline.
 */
async function handleInboundSms(params: {
  event: TelnyxWebhookEvent;
  cfg: OpenClawConfig;
  accountId: string;
  runtime: RuntimeEnv;
}) {
  const { event, cfg, accountId, runtime } = params;
  const payload = event.data.payload;

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
  const messagePreview = (payload.text ?? "").trim().slice(0, 120);
  const dmPolicy = account.config.dmPolicy ?? "allowlist";
  if (dmPolicy === "disabled") {
    logVerbose(`telnyx-sms: DM policy disabled, dropping message from ${senderDisplay}`);
    smsEventLog.record({
      direction: "inbound",
      phoneNumber: senderPhone,
      status: "dropped",
      dropReason: "DM policy disabled",
      preview: messagePreview,
    });
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
      logVerbose(`telnyx-sms: sender ${senderDisplay} not in allowFrom, triggering gate`);
      // Gate notification — alert admin via another channel instead of silently dropping
      void handleUnknownSenderGate({
        senderPhone,
        messagePreview,
        cfg,
        channelConfig: account.config as unknown as Record<string, unknown>,
        sendReply: async (to, text) => {
          await sendSmsTelnyx(to, text, { cfg, accountId });
        },
      }).catch((err) => {
        runtime.error?.(danger(`telnyx-sms: gate notify error: ${String(err)}`));
      });
      return;
    }
  }

  // Build message text + handle MMS media
  const messageText = (payload.text ?? "").trim();
  const mediaPaths: string[] = [];
  const mediaTypes: string[] = [];
  let mediaPath: string | undefined;
  let mediaType: string | undefined;

  if (payload.media?.length) {
    const maxBytes = (account.config.mediaMaxMb ?? 1) * 1024 * 1024;
    for (const media of payload.media) {
      if (!media.url) continue;
      if (media.size && media.size > maxBytes) {
        runtime.error?.(`telnyx-sms: media ${media.content_type} exceeds ${account.config.mediaMaxMb ?? 1}MB limit`);
        continue;
      }
      try {
        const response = await fetch(media.url);
        if (!response.ok) {
          runtime.error?.(`telnyx-sms: failed to download media: HTTP ${response.status}`);
          continue;
        }
        // For now, pass the Telnyx URL directly as media reference
        // (media files are accessible for ~30 days from Telnyx CDN)
        mediaPaths.push(media.url);
        mediaTypes.push(media.content_type ?? "application/octet-stream");
        if (!mediaPath) {
          mediaPath = media.url;
          mediaType = media.content_type ?? undefined;
        }
      } catch (err) {
        runtime.error?.(danger(`telnyx-sms: media download failed: ${String(err)}`));
      }
    }
  }

  let placeholder = "";
  if (mediaPaths.length > 0) {
    placeholder = mediaType?.startsWith("image/")
      ? "<media:image>"
      : mediaType?.startsWith("video/")
        ? "<media:video>"
        : "<media:attachment>";
  }
  const bodyText = messageText || placeholder;
  if (!bodyText) {
    logVerbose("telnyx-sms: empty message (no text or media), skipping");
    return;
  }

  // Log successful inbound event
  smsEventLog.record({
    direction: "inbound",
    phoneNumber: senderPhone,
    status: "success",
    messageId: event.data.id,
    preview: messageText.slice(0, 80),
  });

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

  // Build reply pipeline
  // Telnyx caps concatenated SMS at 10 parts (GSM-7: 153×10=1530 chars).
  // Use 1500 as safe default to avoid 400 "too many parts" rejections.
  const textLimit = resolveTextChunkLimit(cfg, CHANNEL_ID, accountId) ?? 1500;
  const chunkMode = resolveChunkMode(cfg, CHANNEL_ID, accountId);

  const { onModelSelected, typingCallbacks, ...replyPipeline } = createChannelReplyPipeline({
    cfg,
    agentId: route.agentId,
    channel: CHANNEL_ID,
    accountId: route.accountId,
    typing: { start: async () => {} }, // SMS has no typing indicators
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
          try {
            const result = await sendSmsTelnyx(senderPhone, chunk, { cfg, accountId });
            smsEventLog.record({
              direction: "outbound",
              phoneNumber: senderPhone,
              status: "success",
              messageId: result.messageId,
              preview: chunk.slice(0, 80),
            });
          } catch (err) {
            smsEventLog.record({
              direction: "outbound",
              phoneNumber: senderPhone,
              status: "error",
              error: String(err).slice(0, 200),
              preview: chunk.slice(0, 80),
            });
            throw err; // re-throw so onError handler fires
          }
        },
        sendMedia: async ({ mediaUrl, caption }) => {
          try {
            const result = await sendSmsTelnyx(senderPhone, caption ?? "", {
              cfg,
              accountId,
              mediaUrl,
            });
            smsEventLog.record({
              direction: "outbound",
              phoneNumber: senderPhone,
              status: "success",
              messageId: result.messageId,
              preview: (caption ?? "[media]").slice(0, 80),
            });
          } catch (err) {
            smsEventLog.record({
              direction: "outbound",
              phoneNumber: senderPhone,
              status: "error",
              error: String(err).slice(0, 200),
              preview: (caption ?? "[media]").slice(0, 80),
            });
            throw err;
          }
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
    replyOptions: { ...replyOptions, onModelSelected },
  });
  markDispatchIdle();

  if (queuedFinal) {
    logVerbose(`telnyx-sms: reply dispatched to ${senderDisplay}`);
  }
}

// ─── HTTP Webhook Server ─────────────────────────────────────────────

async function listenHttpServer(params: {
  server: ReturnType<typeof createServer>;
  port: number;
  host: string;
}) {
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      params.server.off("error", onError);
      reject(err);
    };
    params.server.once("error", onError);
    params.server.listen(params.port, params.host, () => {
      params.server.off("error", onError);
      resolve();
    });
  });
}

/**
 * Start the Telnyx SMS webhook HTTP server and inbound monitor.
 *
 * Called by `gateway.startAccount` in the channel plugin.
 * Runs until the abort signal fires.
 */
export async function monitorTelnyxSmsProvider(opts: MonitorTelnyxSmsOpts = {}): Promise<void> {
  const runtime = opts.runtime ?? createNonExitingRuntime();
  const cfg = opts.config ?? loadConfig();
  const account = resolveTelnyxSmsAccount({ cfg, accountId: opts.accountId });

  if (!account.configured) {
    runtime.error?.(
      `[${account.accountId}] Telnyx SMS not configured: apiKey and phoneNumber required`,
    );
    return;
  }

  const webhookPath = account.config.webhookPath ?? DEFAULT_WEBHOOK_PATH;
  const webhookPort = account.config.webhookPort ?? DEFAULT_WEBHOOK_PORT;
  const webhookHost = account.config.webhookHost ?? "0.0.0.0";

  runtime.log?.(
    `[${account.accountId}] Telnyx SMS monitor starting (${account.phoneNumber})`,
  );

  const rateLimiter = createFixedWindowRateLimiter({
    windowMs: WEBHOOK_RATE_LIMIT_DEFAULTS.windowMs,
    maxRequests: WEBHOOK_RATE_LIMIT_DEFAULTS.maxRequests,
    maxTrackedKeys: WEBHOOK_RATE_LIMIT_DEFAULTS.maxTrackedKeys,
  });

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const respondText = (statusCode: number, text = "") => {
      if (res.headersSent || res.writableEnded) return;
      res.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(text);
    };

    // Health check endpoint
    if (req.url === "/healthz") {
      respondText(200, "ok");
      return;
    }

    // Only accept POST to the webhook path
    if (req.url !== webhookPath || req.method !== "POST") {
      respondText(404, "not found");
      return;
    }

    // Rate limiting
    const clientIp = req.socket.remoteAddress ?? "unknown";
    if (
      !applyBasicWebhookRequestGuards({
        req,
        res,
        rateLimiter,
        rateLimitKey: `${webhookPath}:${clientIp}`,
      })
    ) {
      return;
    }

    // Read and process the body — collect raw bytes first for signature verification
    void (async () => {
      const rawChunks: Buffer[] = [];
      let totalBytes = 0;
      const bodyPromise = new Promise<{ ok: true; raw: string; value: unknown } | { ok: false; code: string; error: string }>((resolve) => {
        const timer = setTimeout(() => {
          req.removeAllListeners("data");
          req.removeAllListeners("end");
          resolve({ ok: false, code: "REQUEST_BODY_TIMEOUT", error: "Body read timeout" });
        }, TELNYX_WEBHOOK_BODY_TIMEOUT_MS);
        req.on("data", (chunk: Buffer) => {
          totalBytes += chunk.length;
          if (totalBytes > TELNYX_WEBHOOK_MAX_BODY_BYTES) {
            clearTimeout(timer);
            req.removeAllListeners("data");
            req.removeAllListeners("end");
            resolve({ ok: false, code: "PAYLOAD_TOO_LARGE", error: "Payload too large" });
            return;
          }
          rawChunks.push(chunk);
        });
        req.on("end", () => {
          clearTimeout(timer);
          const raw = Buffer.concat(rawChunks).toString("utf-8");
          try {
            const value = JSON.parse(raw);
            resolve({ ok: true, raw, value });
          } catch {
            resolve({ ok: false, code: "INVALID_JSON", error: "Invalid JSON body" });
          }
        });
        req.on("error", () => {
          clearTimeout(timer);
          resolve({ ok: false, code: "READ_ERROR", error: "Body read error" });
        });
      });
      const body = await bodyPromise;

      if (!body.ok) {
        if (body.code === "PAYLOAD_TOO_LARGE") {
          respondText(413, body.error);
        } else if (body.code === "REQUEST_BODY_TIMEOUT") {
          respondText(408, body.error);
        } else {
          respondText(400, body.error);
        }
        return;
      }

      const rawBody = body.raw;

      // Deduplication
      const eventId = extractWebhookIdempotencyKey(rawBody);
      if (eventId && isDuplicate(eventId)) {
        respondText(200, "duplicate");
        return;
      }

      // Verify Ed25519 signature (only if headers are present — Cloudflare tunnel may strip them)
      const sigHeader = (req.headers["telnyx-signature-ed25519"] as string) ?? "";
      const tsHeader = (req.headers["telnyx-timestamp"] as string) ?? "";
      if (account.config.webhookPublicKey && sigHeader && tsHeader) {
        const result = verifyTelnyxWebhook({
          rawBody,
          signature: sigHeader,
          timestamp: tsHeader,
          publicKey: account.config.webhookPublicKey,
        });
        if (!result.valid) {
          runtime.error?.(`telnyx-sms: webhook signature invalid: ${result.reason}`);
          respondText(401, "invalid signature");
          return;
        }
      }

      // Parse the event
      const event = body.value as TelnyxWebhookEvent;
      if (event?.data?.event_type !== "message.received") {
        respondText(200, "ignored");
        return;
      }

      // ACK immediately — process asynchronously
      respondText(200, "ok");

      // Process the inbound message
      void handleInboundSms({
        event,
        cfg,
        accountId: account.accountId,
        runtime,
      }).catch((err) => {
        runtime.error?.(danger(`telnyx-sms: inbound handler failed: ${String(err)}`));
      });
    })().catch((err) => {
      runtime.error?.(`telnyx-sms: webhook handler error: ${String(err)}`);
      respondText(500, "internal error");
    });
  });

  await listenHttpServer({ server, port: webhookPort, host: webhookHost });

  const boundAddress = server.address();
  const boundPort =
    boundAddress && typeof boundAddress !== "string" ? boundAddress.port : webhookPort;

  runtime.log?.(
    `[${account.accountId}] Telnyx SMS webhook listening on http://${webhookHost}:${boundPort}${webhookPath}`,
  );

  // Wait for abort signal
  let shutDown = false;
  const shutdown = () => {
    if (shutDown) return;
    shutDown = true;
    server.close();
    runtime.log?.(`[${account.accountId}] Telnyx SMS monitor stopped`);
  };

  if (opts.abortSignal) {
    opts.abortSignal.addEventListener("abort", shutdown, { once: true });
    await new Promise<void>((resolve) => {
      if (opts.abortSignal!.aborted) {
        shutdown();
        resolve();
        return;
      }
      opts.abortSignal!.addEventListener("abort", () => resolve(), { once: true });
    });
  }
}
