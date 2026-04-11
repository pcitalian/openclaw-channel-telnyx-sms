/**
 * Telnyx SMS/MMS Channel — Webhook Signature Verification
 *
 * Verifies Ed25519 signatures on inbound Telnyx webhook events.
 * Telnyx signs every webhook with EdDSA; the public key is found in
 * the Telnyx portal under Messaging → Profile → Inbound Settings.
 *
 * Signature formula:
 *   signature_input = `${timestamp}|${rawBody}`
 *   valid = Ed25519.verify(signature, signature_input, publicKey)
 *
 * Headers:
 *   telnyx-signature-ed25519  — Base64-encoded Ed25519 signature
 *   telnyx-timestamp          — Unix timestamp (UTC seconds)
 */

import { createVerify } from "node:crypto";

/** Maximum age of a webhook before we reject it (replay protection). */
const MAX_WEBHOOK_AGE_SECONDS = 300; // 5 minutes

export type WebhookVerifyResult =
  | { valid: true }
  | { valid: false; reason: string };

/**
 * Verify a Telnyx webhook Ed25519 signature.
 *
 * @param rawBody   - The raw request body as a string (NOT parsed JSON)
 * @param signature - Value of the `telnyx-signature-ed25519` header
 * @param timestamp - Value of the `telnyx-timestamp` header
 * @param publicKey - Ed25519 public key from Telnyx portal (base64)
 */
export function verifyTelnyxWebhook(params: {
  rawBody: string;
  signature: string;
  timestamp: string;
  publicKey: string;
}): WebhookVerifyResult {
  const { rawBody, signature, timestamp, publicKey } = params;

  // Validate timestamp presence
  if (!timestamp || !signature) {
    return { valid: false, reason: "Missing signature or timestamp header" };
  }

  // Replay protection: reject webhooks older than 5 minutes
  const webhookTime = parseInt(timestamp, 10);
  if (isNaN(webhookTime)) {
    return { valid: false, reason: "Invalid timestamp" };
  }
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - webhookTime) > MAX_WEBHOOK_AGE_SECONDS) {
    return {
      valid: false,
      reason: `Webhook timestamp too old (${Math.abs(now - webhookTime)}s > ${MAX_WEBHOOK_AGE_SECONDS}s)`,
    };
  }

  // Build the signed payload: "{timestamp}|{rawBody}"
  const signedPayload = `${timestamp}|${rawBody}`;

  try {
    // Decode the base64 signature and public key
    const signatureBuffer = Buffer.from(signature, "base64");
    const publicKeyBuffer = Buffer.from(publicKey, "base64");

    // Construct a DER-encoded Ed25519 public key for Node.js crypto
    // Ed25519 public key DER prefix: 302a300506032b6570032100
    const DER_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
    const derKey = Buffer.concat([DER_PREFIX, publicKeyBuffer]);

    const verify = createVerify("Ed25519" as never);
    // Node's Ed25519 verify uses the "ed25519" key type
    // For Ed25519, we use crypto.verify directly instead of createVerify
    const isValid = await_ed25519_verify(
      signatureBuffer,
      Buffer.from(signedPayload),
      derKey,
    );

    if (!isValid) {
      return { valid: false, reason: "Signature verification failed" };
    }

    return { valid: true };
  } catch (err) {
    return {
      valid: false,
      reason: `Signature verification error: ${String(err)}`,
    };
  }
}

/**
 * Synchronous Ed25519 verification using Node.js crypto.
 * Uses the `crypto.verify` function which supports Ed25519 natively in Node 16+.
 */
function await_ed25519_verify(
  signature: Buffer,
  data: Buffer,
  derPublicKey: Buffer,
): boolean {
  // Import crypto.verify for Ed25519
  const { verify } = require("node:crypto") as typeof import("node:crypto");
  return verify(
    null, // Ed25519 doesn't use a separate hash algorithm
    data,
    {
      key: derPublicKey,
      format: "der",
      type: "spki",
    },
    signature,
  );
}

/**
 * Extract an idempotency key from a webhook event for deduplication.
 * Uses `data.id` from the Telnyx event payload.
 */
export function extractWebhookIdempotencyKey(rawBody: string): string | undefined {
  try {
    const parsed = JSON.parse(rawBody);
    return parsed?.data?.id ?? undefined;
  } catch {
    return undefined;
  }
}
