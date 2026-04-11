/**
 * Telnyx SMS/MMS Channel — Plugin Definition
 *
 * Defines the complete channel plugin using `createChatChannelPlugin` from
 * the OpenClaw plugin SDK. This follows the same pattern as Signal and
 * Telegram channel plugins.
 *
 * The plugin registers:
 *   - Config schema for validation
 *   - Account resolution (single and multi-account)
 *   - Inbound webhook monitor (gateway.startAccount)
 *   - Outbound send functions (text and MMS media)
 *   - DM access policy (allowlist, open, pairing, disabled)
 *   - Status/health reporting
 */

import { buildDmGroupAccountAllowlistAdapter } from "openclaw/plugin-sdk/allowlist-config-edit";
import {
  adaptScopedAccountAccessor,
  createScopedChannelConfigAdapter,
} from "openclaw/plugin-sdk/channel-config-helpers";
import { createRestrictSendersChannelSecurity } from "openclaw/plugin-sdk/channel-policy";
import { attachChannelToResult, attachChannelToResults } from "openclaw/plugin-sdk/channel-send-result";
import { createChannelPluginBase, createChatChannelPlugin } from "openclaw/plugin-sdk/core";
import { resolveTextChunkLimit } from "openclaw/plugin-sdk/reply-runtime";
import { chunkText } from "openclaw/plugin-sdk/reply-runtime";
import { buildOutboundBaseSessionKey, type RoutePeer } from "openclaw/plugin-sdk/routing";
import {
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
  buildBaseChannelStatusSummary,
  collectStatusIssuesFromLastError,
} from "openclaw/plugin-sdk/status-helpers";
import { normalizeE164 } from "openclaw/plugin-sdk/text-runtime";

import {
  listTelnyxSmsAccountIds,
  resolveDefaultTelnyxSmsAccountId,
  resolveTelnyxSmsAccount,
  type ResolvedTelnyxSmsAccount,
} from "./accounts.js";
import { TelnyxSmsChannelConfigSchema } from "./config-schema.js";
import { monitorTelnyxSmsProvider } from "./monitor.js";
import {
  inferSmsChatType,
  looksLikeSmsTargetId,
  normalizeSmsMessagingTarget,
  parseSmsExplicitTarget,
} from "./normalize.js";
import { sendSmsTelnyx } from "./send.js";

// ─── Constants ────────────────────────────────────────────────────────

const CHANNEL_ID = "telnyx-sms";
const CHANNEL_LABEL = "Telnyx SMS";
const DEFAULT_ACCOUNT_ID = "default";
const SMS_CHUNK_LIMIT = 1600; // Keep messages under ~10 SMS segments

// ─── Config Adapter ───────────────────────────────────────────────────

const telnyxSmsConfigAdapter = createScopedChannelConfigAdapter<ResolvedTelnyxSmsAccount>({
  sectionKey: CHANNEL_ID,
  listAccountIds: (cfg) => listTelnyxSmsAccountIds(cfg),
  resolveAccount: adaptScopedAccountAccessor((params) => resolveTelnyxSmsAccount(params)),
  defaultAccountId: (cfg) => resolveDefaultTelnyxSmsAccountId(cfg),
  clearBaseFields: ["apiKey", "phoneNumber", "messagingProfileId", "webhookPublicKey", "name"],
  resolveAllowFrom: (account: ResolvedTelnyxSmsAccount) => account.config.allowFrom ?? [],
  formatAllowFrom: (allowFrom) =>
    allowFrom
      .map((entry) => String(entry).trim())
      .filter(Boolean)
      .map((entry) => (entry === "*" ? "*" : normalizeE164(entry) ?? entry))
      .filter(Boolean),
  resolveDefaultTo: (account: ResolvedTelnyxSmsAccount) => account.config.defaultTo,
});

// ─── Security Adapter ─────────────────────────────────────────────────

const telnyxSmsSecurity = createRestrictSendersChannelSecurity<ResolvedTelnyxSmsAccount>({
  channelKey: CHANNEL_ID,
  resolveDmPolicy: (account) => account.config.dmPolicy ?? "allowlist",
  resolveDmAllowFrom: (account) => account.config.allowFrom ?? [],
  surface: "SMS",
  openScope: "any phone number",
  policyPathSuffix: "dmPolicy",
  normalizeDmEntry: (raw) => normalizeE164(raw.trim()) ?? raw.trim(),
});

// ─── Outbound Helpers ─────────────────────────────────────────────────

function buildSmsBaseSessionKey(params: {
  cfg: Parameters<typeof resolveTelnyxSmsAccount>[0]["cfg"];
  agentId: string;
  accountId?: string | null;
  peer: RoutePeer;
}) {
  return buildOutboundBaseSessionKey({ ...params, channel: CHANNEL_ID });
}

function resolveSmsOutboundSessionRoute(params: {
  cfg: Parameters<typeof resolveTelnyxSmsAccount>[0]["cfg"];
  agentId: string;
  accountId?: string | null;
  target: string;
}) {
  const normalized = normalizeSmsMessagingTarget(params.target);
  if (!normalized) return null;

  const peer: RoutePeer = { kind: "direct", id: normalized };
  const baseSessionKey = buildSmsBaseSessionKey({
    cfg: params.cfg,
    agentId: params.agentId,
    accountId: params.accountId,
    peer,
  });

  return {
    sessionKey: baseSessionKey,
    baseSessionKey,
    peer,
    to: normalized,
  };
}

async function sendFormattedSmsText(ctx: {
  cfg: Parameters<typeof resolveTelnyxSmsAccount>[0]["cfg"];
  to: string;
  text: string;
  accountId?: string | null;
  abortSignal?: AbortSignal;
}) {
  ctx.abortSignal?.throwIfAborted();
  const limit =
    resolveTextChunkLimit(ctx.cfg, CHANNEL_ID, ctx.accountId ?? undefined, {
      fallbackLimit: SMS_CHUNK_LIMIT,
    }) ?? SMS_CHUNK_LIMIT;

  // Split long messages into SMS-friendly chunks
  const chunks = chunkText(ctx.text, limit);
  const results = [];
  for (const chunk of chunks) {
    ctx.abortSignal?.throwIfAborted();
    const result = await sendSmsTelnyx(ctx.to, chunk, {
      cfg: ctx.cfg,
      accountId: ctx.accountId ?? undefined,
    });
    results.push(result);
  }
  return attachChannelToResults(CHANNEL_ID, results);
}

async function sendFormattedSmsMedia(ctx: {
  cfg: Parameters<typeof resolveTelnyxSmsAccount>[0]["cfg"];
  to: string;
  text: string;
  mediaUrl: string;
  accountId?: string | null;
  abortSignal?: AbortSignal;
}) {
  ctx.abortSignal?.throwIfAborted();
  const result = await sendSmsTelnyx(ctx.to, ctx.text, {
    cfg: ctx.cfg,
    accountId: ctx.accountId ?? undefined,
    mediaUrl: ctx.mediaUrl,
  });
  return attachChannelToResult(CHANNEL_ID, result);
}

// ─── Probe (health check) ─────────────────────────────────────────────

type TelnyxSmsProbe = {
  ok: boolean;
  phoneNumber?: string;
  error?: string;
};

async function probeTelnyxSms(
  account: ResolvedTelnyxSmsAccount,
  _timeoutMs?: number,
): Promise<TelnyxSmsProbe> {
  if (!account.config.apiKey || !account.phoneNumber) {
    return { ok: false, error: "Not configured (missing apiKey or phoneNumber)" };
  }

  try {
    // Quick validation — check if the API key works by listing messaging profiles
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), _timeoutMs ?? 5000);
    try {
      const res = await fetch(
        "https://api.telnyx.com/v2/messaging_profiles?page[size]=1",
        {
          headers: { Authorization: `Bearer ${account.config.apiKey}` },
          signal: controller.signal,
        },
      );
      if (res.ok) {
        return { ok: true, phoneNumber: account.phoneNumber };
      }
      return { ok: false, error: `API returned ${res.status}` };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// ─── Channel Plugin ───────────────────────────────────────────────────

export const telnyxSmsPlugin = createChatChannelPlugin({
  base: {
    ...createChannelPluginBase({
      id: CHANNEL_ID,
      meta: {
        label: CHANNEL_LABEL,
        docs: "https://github.com/pcplayground/openclaw-channel-telnyx-sms",
        icon: "sms",
      },
      capabilities: {
        chatTypes: ["direct"], // SMS is always 1:1
        media: true, // MMS support
        reactions: false, // SMS has no reactions
      },
      streaming: {
        // SMS doesn't support streaming — collect full response before sending
        blockStreamingCoalesceDefaults: { minChars: 800, idleMs: 2000 },
      },
      reload: { configPrefixes: [`channels.${CHANNEL_ID}`] },
      configSchema: TelnyxSmsChannelConfigSchema,
      config: {
        ...telnyxSmsConfigAdapter,
        isConfigured: (account) => account.configured,
        describeAccount: (account) => ({
          accountId: account.accountId,
          name: account.name,
          enabled: account.enabled,
          configured: account.configured,
          extra: { phoneNumber: account.phoneNumber },
        }),
      },
      security: telnyxSmsSecurity,
    }),
    allowlist: buildDmGroupAccountAllowlistAdapter({
      channelId: CHANNEL_ID,
      resolveAccount: resolveTelnyxSmsAccount,
      normalize: ({ allowFrom }) =>
        allowFrom
          .map((entry) => String(entry).trim())
          .filter(Boolean)
          .map((entry) => (entry === "*" ? "*" : normalizeE164(entry) ?? entry))
          .filter(Boolean),
      resolveDmAllowFrom: (account) => account.config.allowFrom ?? [],
      resolveDmPolicy: (account) => account.config.dmPolicy ?? "allowlist",
    }),
    messaging: {
      normalizeTarget: normalizeSmsMessagingTarget,
      parseExplicitTarget: ({ raw }) => parseSmsExplicitTarget(raw),
      inferTargetChatType: ({ to }) => inferSmsChatType(to),
      resolveOutboundSessionRoute: (params) => resolveSmsOutboundSessionRoute(params),
      targetResolver: {
        looksLikeId: looksLikeSmsTargetId,
        hint: "<E.164 phone number, e.g. +15551234567>",
      },
    },
    status: createComputedAccountStatusAdapter<ResolvedTelnyxSmsAccount, TelnyxSmsProbe>({
      defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
      collectStatusIssues: (accounts) =>
        collectStatusIssuesFromLastError(CHANNEL_ID, accounts),
      buildChannelSummary: ({ snapshot }) =>
        buildBaseChannelStatusSummary(snapshot, {
          probe: snapshot.probe,
          lastProbeAt: snapshot.lastProbeAt ?? null,
        }),
      probeAccount: async ({ account, timeoutMs }) =>
        await probeTelnyxSms(account, timeoutMs),
      formatCapabilitiesProbe: ({ probe }) =>
        (probe as TelnyxSmsProbe | undefined)?.phoneNumber
          ? [{ text: `Telnyx SMS: ${(probe as TelnyxSmsProbe).phoneNumber}` }]
          : [],
      resolveAccountSnapshot: ({ account }) => ({
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured: account.configured,
        extra: { phoneNumber: account.phoneNumber },
      }),
    }),
    gateway: {
      startAccount: async (ctx) => {
        const account = ctx.account;
        ctx.setStatus({
          accountId: account.accountId,
          phoneNumber: account.phoneNumber,
        });
        ctx.log?.info(
          `[${account.accountId}] starting Telnyx SMS provider (${account.phoneNumber})`,
        );
        return monitorTelnyxSmsProvider({
          accountId: account.accountId,
          config: ctx.cfg,
          runtime: ctx.runtime,
          abortSignal: ctx.abortSignal,
        });
      },
    },
  },
  pairing: {
    text: {
      idLabel: "phoneNumber",
      message:
        "You've been approved to message this assistant via SMS. Send any message to start a conversation.",
      normalizeAllowEntry: (raw: string) => {
        const stripped = raw.replace(/^(sms:|telnyx:)/i, "").trim();
        return normalizeE164(stripped) ?? stripped;
      },
      notify: async ({ id, message, cfg, accountId }) => {
        await sendSmsTelnyx(id, message, { cfg, accountId });
      },
    },
  },
  security: telnyxSmsSecurity,
  outbound: {
    base: {
      deliveryMode: "direct",
      chunker: chunkText,
      chunkerMode: "text",
      textChunkLimit: SMS_CHUNK_LIMIT,
      sendFormattedText: async ({ cfg, to, text, accountId, abortSignal }) =>
        await sendFormattedSmsText({ cfg, to, text, accountId, abortSignal }),
      sendFormattedMedia: async ({ cfg, to, text, mediaUrl, accountId, abortSignal }) =>
        await sendFormattedSmsMedia({
          cfg,
          to,
          text,
          mediaUrl: mediaUrl ?? "",
          accountId,
          abortSignal,
        }),
    },
    attachedResults: {
      channel: CHANNEL_ID,
      sendText: async ({ cfg, to, text, accountId }) =>
        await sendSmsTelnyx(to, text, { cfg, accountId: accountId ?? undefined }),
      sendMedia: async ({ cfg, to, text, mediaUrl, accountId }) =>
        await sendSmsTelnyx(to, text, {
          cfg,
          accountId: accountId ?? undefined,
          mediaUrl,
        }),
    },
  },
});
