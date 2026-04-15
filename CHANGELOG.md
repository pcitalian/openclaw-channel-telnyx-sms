# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.2] — 2026-04-14

### Fixed

- **Manifest:** declare the environment variables read by the plugin (`TELNYX_API_KEY`, `TELNYX_FROM_NUMBER`, `TELNYX_PUBLIC_KEY`, `TELNYX_MESSAGING_PROFILE_ID`) via `channelEnvVars` in `openclaw.plugin.json`. Prior versions under-reported required credentials in the registry metadata, which ClawHub's security scanner flagged as misleading. No code changes — the env vars have always been read as fallbacks when equivalent fields are absent from `channels.telnyx-sms` config.

## [1.3.1] — 2026-04-14

### Fixed

- **Packaging:** include `openclaw.plugin.json` in the published tarball. ClawHub rejects code-plugin uploads that do not include this file, so v1.3.0 could not be published through the ClawHub portal. No code changes from v1.3.0 — the security fixes in v1.3.0 are unchanged.

## [1.3.0] — 2026-04-14

### Security

- **SSRF defense on MMS media downloads.** Inbound webhooks carry a `media.url` pointing to the media file on Telnyx's CDN. Prior versions fetched that URL without validating it — a compromised Telnyx account or an unsigned webhook could have induced the plugin to fetch arbitrary URLs (internal services, cloud metadata endpoints, etc.). New `src/media-url-policy.ts` enforces: HTTPS only, hostname must end in `.telnyx.com`, private/loopback/link-local IP literals rejected. Rejected URLs are logged and recorded to the event log with `status: "dropped"`.

- **Fail-closed Ed25519 verification.** Prior versions silently accepted webhooks when the public key or signature/timestamp headers were missing. This release rejects all webhooks with HTTP 401 if:
  - `webhookPublicKey` is not configured (via `channels.telnyx-sms.webhookPublicKey` or the `TELNYX_PUBLIC_KEY` env var), or
  - `telnyx-signature-ed25519` / `telnyx-timestamp` headers are absent, or
  - signature verification fails.

  **Potentially breaking** for deployments that ran without a public key — you must now set one. If a Cloudflare Tunnel or other proxy is stripping the signature headers, configure it to preserve them rather than disabling plugin verification.

### Verified against

- OpenClaw 2026.4.14 (live regression: outbound SMS still delivers with Telnyx messageId; unit tests on URL policy; fail-closed 401 confirmed by removing the public key env var)

## [1.2.0] — 2026-04-14

### Fixed

- **Outbound SMS broken on OpenClaw ≥ 2026.4.14.** The gateway's outbound handler in newer OpenClaw releases looks for `outbound.sendText` / `outbound.sendMedia` rather than `outbound.base.sendFormattedText` / `sendFormattedMedia`. The plugin previously only defined the `Formatted*` variants, causing outbound sends to fail with:

  ```
  Outbound not configured for channel: telnyx-sms
  ```

  Stock plugins (Discord, BlueBubbles) were already using the newer shape; this release brings `telnyx-sms` in line. Inbound, webhook verification, allowlist, gate-notify, and status are unaffected by this change.

### Added

- `outbound.attachedResults` block with `sendText` and `sendMedia` methods that delegate to the existing `sendSmsTelnyx` helper. Chunking behavior is preserved.

### Retained

- `outbound.base.sendFormattedText` / `sendFormattedMedia` are kept for backward compatibility with OpenClaw < 2026.4.14, where they were treated as the primary send methods. Running against pre-2026.4.14 gateways should still work.

### Verified against

- OpenClaw 2026.4.14 (live test: outbound SMS delivered to a real handset with Telnyx messageId returned)
- OpenClaw 2026.4.12 (regression check: `base.sendFormatted*` path still used)

## [1.1.0] — 2026-04-12

### Added

- Console UI integration via `channelConfigs` — allowlist, DM policy, gate-notify, chunk limits, and other settings now render natively in the OpenClaw console.
- Gate-notify: when an unknown sender texts, optionally alert an admin via another configured channel (Discord, WhatsApp, etc.) with approve/deny.
- Event log — in-memory ring buffer tracking the last 20 send/receive events with status codes, exposed through the console status panel.

### Changed

- Documentation reorganized — `docs/telnyx-portal-setup.md` covers Telnyx portal configuration end-to-end.

## [1.0.0] — 2026-04-03

### Added

- Initial release: Telnyx SMS/MMS channel extension for OpenClaw.
- Inbound SMS/MMS via Telnyx webhooks with Ed25519 signature verification.
- Outbound SMS/MMS via the Telnyx Messaging API v2.
- Allowlist access control with E.164 normalization.
- Multi-account support (multiple phone numbers per OpenClaw instance).
- Session continuity per phone number.
