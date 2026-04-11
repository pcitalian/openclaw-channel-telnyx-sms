/**
 * Telnyx SMS/MMS Channel — Type Definitions
 *
 * Core types for the Telnyx Messaging API v2 webhook payloads,
 * outbound message requests, and channel configuration.
 */

// ─── Telnyx Webhook Payloads ──────────────────────────────────────────

/** Top-level Telnyx webhook event wrapper. */
export type TelnyxWebhookEvent = {
  data: {
    event_type: string;
    id: string;
    occurred_at: string;
    payload: TelnyxMessagePayload;
    record_type: "event";
  };
  meta: {
    attempt: number;
    delivered_to: string;
  };
};

/** Payload within a `message.received` or `message.sent` webhook event. */
export type TelnyxMessagePayload = {
  direction: "inbound" | "outbound";
  id: string;
  type: "SMS" | "MMS";
  from: TelnyxPhoneInfo;
  to: TelnyxPhoneInfo[];
  text: string;
  media: TelnyxMedia[];
  subject?: string;
  encoding?: string;
  parts?: number;
  completed_at?: string;
  cost?: {
    amount: string;
    currency: string;
  };
  errors?: Array<{
    code: string;
    title: string;
    detail?: string;
  }>;
};

export type TelnyxPhoneInfo = {
  phone_number: string;
  carrier?: string;
  line_type?: string;
  status?: string;
};

export type TelnyxMedia = {
  url: string;
  content_type: string;
  size?: number;
  sha256?: string;
};

// ─── Outbound Message Types ───────────────────────────────────────────

/** Request body for POST /v2/messages. */
export type TelnyxSendRequest = {
  from: string;
  to: string;
  text: string;
  messaging_profile_id?: string;
  media_urls?: string[];
  webhook_url?: string;
  webhook_failover_url?: string;
  type?: "SMS" | "MMS";
  subject?: string;
  auto_detect?: boolean;
};

/** Response from POST /v2/messages. */
export type TelnyxSendResponse = {
  data: {
    record_type: "message";
    id: string;
    direction: "outbound";
    type: "SMS" | "MMS";
    from: TelnyxPhoneInfo;
    to: TelnyxPhoneInfo[];
    text: string;
    media: TelnyxMedia[];
    encoding: string;
    parts: number;
    cost?: {
      amount: string;
      currency: string;
    };
  };
};

// ─── Channel Configuration ────────────────────────────────────────────

/** Per-account configuration stored in openclaw.json → channels.telnyx-sms. */
export type TelnyxSmsAccountConfig = {
  /** Telnyx API v2 key (starts with KEY...). */
  apiKey: string;
  /** Phone number in E.164 format (e.g. +15551234567). */
  phoneNumber: string;
  /** Telnyx Messaging Profile ID (optional — required for alphanumeric sender). */
  messagingProfileId?: string;
  /** Webhook public key from Telnyx portal for Ed25519 signature verification. */
  webhookPublicKey?: string;
  /** DM access policy: "open", "allowlist", "pairing", or "disabled". */
  dmPolicy?: "open" | "allowlist" | "pairing" | "disabled";
  /** E.164 numbers allowed to message this channel (when dmPolicy=allowlist). */
  allowFrom?: string[];
  /** Default target for outbound messages (E.164 phone number). */
  defaultTo?: string;
  /** Maximum media size in MB for inbound MMS attachments (default: 1). */
  mediaMaxMb?: number;
  /** Whether this account is enabled. */
  enabled?: boolean;
  /** Display name for this account. */
  name?: string;
};

/** Resolved account info after config normalization. */
export type ResolvedTelnyxSmsAccount = {
  accountId: string;
  name: string;
  enabled: boolean;
  configured: boolean;
  config: TelnyxSmsAccountConfig;
  phoneNumber: string;
};

// ─── Send Result ──────────────────────────────────────────────────────

export type TelnyxSmsSendResult = {
  messageId: string;
  type?: "SMS" | "MMS";
  parts?: number;
};
