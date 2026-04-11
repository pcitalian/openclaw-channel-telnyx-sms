/**
 * @pcplayground/openclaw-channel-telnyx-sms
 *
 * Telnyx SMS/MMS channel extension for OpenClaw.
 * Sends and receives text messages via the Telnyx Messaging API v2.
 *
 * @see https://github.com/pcplayground/openclaw-channel-telnyx-sms
 */

export { telnyxSmsPlugin } from "./channel.js";
export { monitorTelnyxSmsProvider } from "./monitor.js";
export { sendSmsTelnyx } from "./send.js";
export { normalizeSmsMessagingTarget, looksLikeSmsTargetId } from "./normalize.js";
export { verifyTelnyxWebhook } from "./webhook.js";
export {
  resolveTelnyxSmsAccount,
  listTelnyxSmsAccountIds,
  resolveDefaultTelnyxSmsAccountId,
} from "./accounts.js";
export type {
  ResolvedTelnyxSmsAccount,
  TelnyxSmsAccountConfig,
  TelnyxSmsSendResult,
  TelnyxWebhookEvent,
  TelnyxMessagePayload,
} from "./types.js";
