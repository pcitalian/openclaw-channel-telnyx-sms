/**
 * Telnyx SMS/MMS Channel — Account Resolution
 *
 * Resolves account configuration from openclaw.json, supporting both
 * single-account (top-level fields) and multi-account (accounts map) layouts.
 */

import { normalizeE164 } from "openclaw/plugin-sdk/text-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { ResolvedTelnyxSmsAccount, TelnyxSmsAccountConfig } from "./types.js";

const DEFAULT_ACCOUNT_ID = "default";
const CHANNEL_KEY = "telnyx-sms";

type ChannelSection = NonNullable<NonNullable<OpenClawConfig["channels"]>[typeof CHANNEL_KEY]>;

function getChannelSection(cfg: OpenClawConfig): ChannelSection | undefined {
  return cfg.channels?.[CHANNEL_KEY] as ChannelSection | undefined;
}

/**
 * List all configured account IDs. Returns ["default"] when there are
 * no named accounts and top-level fields are present.
 */
export function listTelnyxSmsAccountIds(cfg: OpenClawConfig): string[] {
  const section = getChannelSection(cfg);
  if (!section) return [];

  const accounts = (section as Record<string, unknown>).accounts as
    | Record<string, unknown>
    | undefined;
  if (accounts && typeof accounts === "object") {
    const ids = Object.keys(accounts).filter(
      (key) => typeof accounts[key] === "object" && accounts[key] !== null,
    );
    if (ids.length > 0) return ids;
  }

  // Fall back to top-level single-account config
  if ((section as Record<string, unknown>).apiKey || (section as Record<string, unknown>).phoneNumber) {
    return [DEFAULT_ACCOUNT_ID];
  }

  return [];
}

/** Resolve account ID when none is specified — returns the first available. */
export function resolveDefaultTelnyxSmsAccountId(cfg: OpenClawConfig): string {
  const ids = listTelnyxSmsAccountIds(cfg);
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

/** Resolve a fully-populated account from config. */
export function resolveTelnyxSmsAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string;
}): ResolvedTelnyxSmsAccount {
  const { cfg } = params;
  const accountId = (params.accountId ?? "").trim() || resolveDefaultTelnyxSmsAccountId(cfg);
  const section = getChannelSection(cfg);

  // Determine the raw config object for this account
  let raw: Record<string, unknown> = {};
  if (section) {
    const accounts = (section as Record<string, unknown>).accounts as
      | Record<string, Record<string, unknown>>
      | undefined;
    if (accounts && accountId !== DEFAULT_ACCOUNT_ID && accounts[accountId]) {
      // Merge top-level defaults with account-specific overrides
      raw = { ...stripAccountsKey(section as Record<string, unknown>), ...accounts[accountId] };
    } else {
      raw = stripAccountsKey(section as Record<string, unknown>);
    }
  }

  const config: TelnyxSmsAccountConfig = {
    apiKey: String(raw.apiKey ?? ""),
    phoneNumber: normalizeE164(String(raw.phoneNumber ?? "")) ?? String(raw.phoneNumber ?? ""),
    messagingProfileId: raw.messagingProfileId ? String(raw.messagingProfileId) : undefined,
    webhookPublicKey: raw.webhookPublicKey ? String(raw.webhookPublicKey) : undefined,
    dmPolicy: parseDmPolicy(raw.dmPolicy),
    allowFrom: parseAllowFrom(raw.allowFrom),
    defaultTo: raw.defaultTo ? String(raw.defaultTo) : undefined,
    mediaMaxMb: typeof raw.mediaMaxMb === "number" ? raw.mediaMaxMb : 1,
    enabled: raw.enabled !== false,
    name: raw.name ? String(raw.name) : undefined,
  };

  const configured = Boolean(config.apiKey && config.phoneNumber);

  return {
    accountId,
    name: config.name ?? accountId,
    enabled: config.enabled !== false,
    configured,
    config,
    phoneNumber: config.phoneNumber,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────

function stripAccountsKey(obj: Record<string, unknown>): Record<string, unknown> {
  const { accounts: _accounts, ...rest } = obj;
  return rest;
}

function parseDmPolicy(
  value: unknown,
): "open" | "allowlist" | "pairing" | "disabled" {
  if (
    typeof value === "string" &&
    ["open", "allowlist", "pairing", "disabled"].includes(value)
  ) {
    return value as "open" | "allowlist" | "pairing" | "disabled";
  }
  return "allowlist";
}

function parseAllowFrom(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      const str = String(entry).trim();
      return normalizeE164(str) ?? str;
    })
    .filter(Boolean);
}
