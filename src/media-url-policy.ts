/**
 * Telnyx SMS/MMS Channel — Media URL Policy
 *
 * SSRF defense for inbound MMS media downloads. Telnyx webhooks carry a
 * `media.url` field pointing at the media file on Telnyx's CDN. Before the
 * plugin fetches that URL, we validate that it's actually a Telnyx-owned
 * HTTPS URL — not an attacker-chosen target like an internal service or a
 * cloud metadata endpoint.
 *
 * Defense layers (enforced together):
 *  1. Scheme must be HTTPS
 *  2. Hostname must end in `.telnyx.com` (case-insensitive)
 *  3. Hostname must NOT be an IP literal in a private / loopback / link-local
 *     range, even if it somehow passed (2) — cheap belt-and-braces.
 *
 * Note on DNS rebinding: we only validate the hostname string. A malicious
 * authoritative DNS for `*.telnyx.com` (not realistic without a Telnyx
 * account compromise) could still resolve to a private IP. The Ed25519
 * signature check on the webhook itself remains the primary defense.
 */

const ALLOWED_HOST_SUFFIX = /\.telnyx\.com$/i;

// Private / loopback / link-local / metadata ranges. Matching is done against
// the raw hostname string, so this only catches IP-literal hostnames.
const PRIVATE_IPV4 = [
  /^127\./,            // loopback
  /^10\./,             // private
  /^192\.168\./,       // private
  /^172\.(1[6-9]|2\d|3[01])\./, // private
  /^169\.254\./,       // link-local (incl. AWS/GCP metadata 169.254.169.254)
  /^0\./,              // reserved "this network"
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // carrier-grade NAT 100.64/10
  /^224\./,            // multicast
  /^255\.255\.255\.255$/, // broadcast
];

const PRIVATE_IPV6 = [
  /^::1$/,             // loopback
  /^fe80:/i,           // link-local
  /^fc[0-9a-f][0-9a-f]:/i, /^fd[0-9a-f][0-9a-f]:/i, // ULA (fc00::/7)
  /^::ffff:/i,         // IPv4-mapped (would need IPv4 ranges re-checked)
];

export type MediaUrlDecision =
  | { ok: true; url: URL }
  | { ok: false; reason: string };

/**
 * Validate a media URL against the SSRF policy.
 * Returns `{ ok: true }` when safe to fetch, `{ ok: false, reason }` otherwise.
 */
export function validateMediaUrl(raw: string): MediaUrlDecision {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "invalid URL" };
  }

  if (url.protocol !== "https:") {
    return { ok: false, reason: `non-HTTPS scheme (${url.protocol})` };
  }

  const host = url.hostname.toLowerCase();

  // Reject IP literals in reserved ranges even if they somehow pass the
  // allowlist (they can't — IP literals don't end in .telnyx.com — but this
  // guards against surprising URL parser quirks).
  for (const rx of PRIVATE_IPV4) {
    if (rx.test(host)) {
      return { ok: false, reason: `private/reserved IPv4 host (${host})` };
    }
  }
  for (const rx of PRIVATE_IPV6) {
    if (rx.test(host)) {
      return { ok: false, reason: `private/reserved IPv6 host (${host})` };
    }
  }

  if (!ALLOWED_HOST_SUFFIX.test(host)) {
    return { ok: false, reason: `host not on Telnyx allowlist (${host})` };
  }

  return { ok: true, url };
}
