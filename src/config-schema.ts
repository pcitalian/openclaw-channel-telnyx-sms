/**
 * Telnyx SMS/MMS Channel — Configuration Schema
 *
 * TypeBox schema for validating channel configuration in openclaw.json.
 * Follows the same pattern as Signal and Telegram config schemas.
 */

import { Type, type Static } from "@sinclair/typebox";

/** Schema for a single Telnyx SMS account. */
export const TelnyxSmsAccountSchema = Type.Object(
  {
    apiKey: Type.String({
      description:
        "Telnyx API v2 key. Starts with KEY... Found at portal.telnyx.com → API Keys.",
    }),
    phoneNumber: Type.String({
      description:
        "Your Telnyx phone number in E.164 format (e.g. +15551234567). Must be SMS-enabled and assigned to a Messaging Profile.",
    }),
    messagingProfileId: Type.Optional(
      Type.String({
        description:
          "Telnyx Messaging Profile ID. Required for alphanumeric sender IDs. Found in the Telnyx portal under Messaging → Profiles.",
      }),
    ),
    webhookPublicKey: Type.Optional(
      Type.String({
        description:
          "Ed25519 public key from your Telnyx Messaging Profile for webhook signature verification. Found under Messaging → Profile → Inbound Settings.",
      }),
    ),
    dmPolicy: Type.Optional(
      Type.Union(
        [
          Type.Literal("open"),
          Type.Literal("allowlist"),
          Type.Literal("pairing"),
          Type.Literal("disabled"),
        ],
        {
          description:
            'DM access policy. "allowlist" restricts to numbers in allowFrom. "open" allows anyone. "pairing" requires approval. "disabled" blocks all inbound.',
          default: "allowlist",
        },
      ),
    ),
    allowFrom: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "E.164 phone numbers allowed to message this channel (used when dmPolicy is allowlist). Example: [\"+15559876543\", \"+15558765432\"]",
      }),
    ),
    defaultTo: Type.Optional(
      Type.String({
        description:
          "Default outbound target phone number (E.164). Used when the agent sends a message without specifying a recipient.",
      }),
    ),
    mediaMaxMb: Type.Optional(
      Type.Number({
        description: "Maximum MMS media size in MB. Telnyx limit is 1 MB per file, 10 files max.",
        default: 1,
        minimum: 0.1,
        maximum: 10,
      }),
    ),
    enabled: Type.Optional(
      Type.Boolean({
        description: "Whether this account is active.",
        default: true,
      }),
    ),
    name: Type.Optional(
      Type.String({
        description: "Display name for this account in the OpenClaw portal.",
      }),
    ),
  },
  { additionalProperties: false },
);

/** Top-level channel config that may contain multiple accounts. */
export const TelnyxSmsChannelConfigSchema = Type.Object(
  {
    ...TelnyxSmsAccountSchema.properties,
    accounts: Type.Optional(
      Type.Record(Type.String(), TelnyxSmsAccountSchema, {
        description:
          "Named accounts for multi-number setups. Each key is an account ID. If omitted, the top-level fields define the default account.",
      }),
    ),
  },
  { additionalProperties: false },
);

export type TelnyxSmsChannelConfig = Static<typeof TelnyxSmsChannelConfigSchema>;
