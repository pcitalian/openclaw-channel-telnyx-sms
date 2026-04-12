/**
 * Telnyx SMS/MMS Channel — Plugin Definition
 *
 * Defines the complete channel plugin using `createChatChannelPlugin`.
 * Follows the same pattern as Telegram and WhatsApp channel plugins.
 */

import { buildDmGroupAccountAllowlistAdapter } from "openclaw/plugin-sdk/allowlist-config-edit";
import { createChatChannelPlugin } from "openclaw/plugin-sdk/core";
import { chunkText } from "openclaw/plugin-sdk/reply-runtime";
import { resolveTextChunkLimit } from "openclaw/plugin-sdk/reply-runtime";
import {
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
  buildBaseChannelStatusSummary,
} from "openclaw/plugin-sdk/status-helpers";
import { buildOutboundBaseSessionKey, type RoutePeer } from "openclaw/plugin-sdk/routing";
import {
  listTelnyxSmsAccountIds,
  resolveDefaultTelnyxSmsAccountId,
  resolveTelnyxSmsAccount,
} from "./accounts.js";
import type { ResolvedTelnyxSmsAccount } from "./types.js";
import { smsEventLog } from "./event-log.js";
import { monitorTelnyxSmsProvider } from "./monitor.js";
import {
  inferSmsChatType,
  looksLikeSmsTargetId,
  normalizeE164,
  normalizeSmsMessagingTarget,
  parseSmsExplicitTarget,
} from "./normalize.js";
import { sendSmsTelnyx } from "./send.js";

// ─── Constants ────────────────────────────────────────────────────────

const CHANNEL_ID = "telnyx-sms";
const DEFAULT_ACCOUNT_ID = "default";
// Telnyx limits concatenated SMS to 10 parts max per API call.
// GSM-7: 153 chars/part × 10 = 1530 max. Use 1500 for safety margin.
const SMS_CHUNK_LIMIT = 1500;

// ─── Outbound Helpers ─────────────────────────────────────────────────

function resolveSmsOutboundSessionRoute(params: {
  cfg: Parameters<typeof resolveTelnyxSmsAccount>[0]["cfg"];
  agentId: string;
  accountId?: string | null;
  target: string;
}) {
  const normalized = normalizeSmsMessagingTarget(params.target);
  if (!normalized) return null;

  const peer: RoutePeer = { kind: "direct", id: normalized };
  const baseSessionKey = buildOutboundBaseSessionKey({
    ...params,
    channel: CHANNEL_ID,
  });

  return {
    sessionKey: baseSessionKey,
    baseSessionKey,
    peer,
    to: normalized,
  };
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

export const telnyxSmsPlugin = createChatChannelPlugin<ResolvedTelnyxSmsAccount>({
  pairing: {
    idLabel: "phoneNumber",
  },
  outbound: {
    base: {
      deliveryMode: "direct",
      chunker: chunkText,
      chunkerMode: "text",
      textChunkLimit: SMS_CHUNK_LIMIT,
      sendFormattedText: async ({ cfg, to, text, accountId, abortSignal }) => {
        abortSignal?.throwIfAborted();
        const limit =
          resolveTextChunkLimit(cfg, CHANNEL_ID, accountId ?? undefined, {
            fallbackLimit: SMS_CHUNK_LIMIT,
          }) ?? SMS_CHUNK_LIMIT;

        const chunks = chunkText(text, limit);
        const results = [];
        for (const chunk of chunks) {
          abortSignal?.throwIfAborted();
          const result = await sendSmsTelnyx(to, chunk, {
            cfg,
            accountId: accountId ?? undefined,
          });
          results.push(result);
        }
        return results;
      },
      sendFormattedMedia: async ({ cfg, to, text, mediaUrl, accountId, abortSignal }) => {
        abortSignal?.throwIfAborted();
        return await sendSmsTelnyx(to, text, {
          cfg,
          accountId: accountId ?? undefined,
          mediaUrl: mediaUrl ?? undefined,
        });
      },
    },
  },
  base: {
    id: CHANNEL_ID,
    meta: {
      label: "Telnyx SMS",
      icon: "message",
    },
    capabilities: {
      chatTypes: ["direct"],
      media: true,
      reactions: false,
    },
    config: {
      sectionKey: CHANNEL_ID,
      listAccountIds: (cfg) => listTelnyxSmsAccountIds(cfg),
      defaultAccountId: (cfg) => resolveDefaultTelnyxSmsAccountId(cfg),
      resolveAccount: (params) => resolveTelnyxSmsAccount(params),
      isConfigured: (account) => account.configured,
    },
    allowlist: buildDmGroupAccountAllowlistAdapter({
      channelId: CHANNEL_ID,
      resolveAccount: resolveTelnyxSmsAccount,
      normalize: ({ values }) =>
        values
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
    status: createComputedAccountStatusAdapter<ResolvedTelnyxSmsAccount, TelnyxSmsProbe, unknown>({
      defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
      collectStatusIssues: () => [],
      buildChannelSummary: ({ snapshot }) => buildBaseChannelStatusSummary(snapshot),
      probeAccount: async ({ account, timeoutMs }) =>
        probeTelnyxSms(account, timeoutMs),
      formatCapabilitiesProbe: ({ probe }) => {
        const lines: { text: string }[] = [];
        if (probe?.phoneNumber) {
          lines.push({ text: `Phone: ${probe.phoneNumber}` });
        }
        if (probe?.error) {
          lines.push({ text: `Error: ${probe.error}` });
        }
        // Append recent event log
        const recentEvents = smsEventLog.formatRecent(5);
        if (recentEvents.length > 0) {
          lines.push({ text: `── Recent Events ──` });
          for (const eventLine of recentEvents) {
            lines.push({ text: eventLine });
          }
        }
        return lines;
      },
      resolveAccountSnapshot: ({ account, runtime, probe }) => {
        const configured = Boolean(account.config.apiKey && account.phoneNumber);
        return {
          accountId: account.accountId,
          name: account.name ?? account.accountId,
          enabled: account.enabled,
          configured,
          extra: {
            phoneNumber: account.phoneNumber,
            probe,
          },
        };
      },
    }),
    gateway: {
      startAccount: async (ctx) => {
        const account = ctx.account;
        ctx.log?.info(
          `[${account.accountId}] starting Telnyx SMS provider (${account.phoneNumber})`,
        );
        ctx.setStatus({
          accountId: ctx.accountId,
          connected: true,
          healthState: "running",
        });
        return monitorTelnyxSmsProvider({
          accountId: account.accountId,
          config: ctx.cfg,
          abortSignal: ctx.abortSignal,
        });
      },
    },
  },
});
