# @pcplayground/openclaw-channel-telnyx-sms

Telnyx SMS/MMS channel extension for [OpenClaw](https://openclaw.ai) — give your AI assistant a real phone number for text messaging.

> **Built with AI.** This extension was developed by [Claude](https://claude.ai) (Anthropic) with human testing, verification, and direction by [Martin Rudolph](https://github.com/pcitalian). If you have questions, ideas, or want to share how you're using it, head over to [Discussions](https://github.com/pcitalian/openclaw-channel-telnyx-sms/discussions).

## Features

- **Inbound SMS/MMS** — receive text messages and media via Telnyx webhooks
- **Outbound SMS/MMS** — send replies as standard text messages (with optional MMS media)
- **Ed25519 webhook verification** — validates Telnyx webhook signatures for security
- **Allowlist access control** — restrict which phone numbers can message your assistant via the OpenClaw console UI
- **Unknown sender gate** — when someone not on the allowlist texts, optionally notify an admin via another channel (Discord, WhatsApp, etc.) with approve/deny
- **Event log** — in-memory ring buffer tracking the last 20 send/receive events with status codes, visible in the console status panel
- **Multi-account support** — run multiple phone numbers from a single OpenClaw instance
- **Session continuity** — each phone number gets its own conversation thread
- **MMS media handling** — inbound images/files are downloaded and passed to the agent
- **Console UI integration** — full config schema with `channelConfigs` so all settings (allowlist, DM policy, chunk limits, gate notifications) render natively in the OpenClaw console

## Prerequisites

- [OpenClaw](https://openclaw.ai) v2.0.0 or later
- A [Telnyx](https://telnyx.com) account with:
  - An API v2 key
  - A phone number with SMS/MMS enabled
  - A Messaging Profile configured with a webhook URL
- For US numbers: an approved 10DLC campaign (required by carriers since 2024)

## Installation

```bash
npm install @pcplayground/openclaw-channel-telnyx-sms
```

Or add to your OpenClaw config manually — see [Configuration](#configuration).

## Telnyx Portal Setup

Follow these steps to configure Telnyx before connecting to OpenClaw.

### 1. Create an API Key

1. Log into [portal.telnyx.com](https://portal.telnyx.com)
2. Go to **Account → API Keys**
3. Click **Create API Key**
4. Copy the key (starts with `KEY...`) — you'll need it for the OpenClaw config

### 2. Buy a Phone Number

1. Go to **Numbers → Search & Buy**
2. Search for a number in your desired area code
3. Ensure **SMS/MMS** capability is listed
4. Purchase the number

### 3. Create a Messaging Profile

1. Go to **Messaging → Profiles**
2. Click **Add New Profile**
3. Name it (e.g., "OpenClaw Raven")
4. Under **Inbound Settings**:
   - Set **Webhook URL** to: `https://your-domain.com/hooks/telnyx-sms/inbound`
   - Note the **Public Key** — you'll need it for webhook signature verification
5. Under **Number Assignment**:
   - Assign your purchased phone number to this profile
6. Save the profile and note the **Profile ID**

### 4. Register for 10DLC (US Numbers Only)

US carriers require 10DLC registration for A2P (application-to-person) messaging:

1. Go to **Messaging → 10DLC**
2. **Register Your Brand:**
   - Company name, EIN, website, contact info
   - Brand type: typically "Low Volume Standard" for personal/small business
3. **Create a Campaign:**
   - Select your brand
   - Use case: "Customer Care" or "Mixed" depending on your usage
   - Describe what your assistant does
   - Sample messages showing typical interactions
4. Wait for approval (usually 1-3 business days)
5. Once approved, assign your number to the campaign

### 5. Set Up a Webhook Tunnel (for development)

If OpenClaw runs behind a firewall, you'll need a tunnel:

**Using Cloudflare Tunnel:**
```bash
cloudflared tunnel route dns your-tunnel your-domain.com
```

**Using ngrok (development only):**
```bash
ngrok http 18789
# Then update the webhook URL in Telnyx portal
```

## Configuration

Add the channel to your `openclaw.json`:

```json5
{
  "channels": {
    "telnyx-sms": {
      // Required
      "apiKey": "KEYxxxxxxxxxxxxxxxxxxxxxxxx",
      "phoneNumber": "+15551234567",

      // Recommended
      "messagingProfileId": "your-profile-id",
      "webhookPublicKey": "your-ed25519-public-key",

      // Access control
      "dmPolicy": "allowlist",
      "allowFrom": [
        "+15559876543",
        "+15558765432"
      ],

      // Message handling
      "textChunkLimit": 1500,
      "blockStreaming": true,
      "chunkMode": "length",
      "historyLimit": 15,

      // Unknown sender gate (optional)
      "gateNotify": {
        "enabled": true,
        "notifyChannel": "discord",
        "notifyTarget": "admin-alerts",
        "rejectReply": "This number is not authorized. Your message has been forwarded for review.",
        "cooldownMinutes": 60
      },

      // Optional
      "mediaMaxMb": 1,
      "name": "Raven SMS"
    }
  }
}
```

### Configuration Reference

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `apiKey` | string | Yes | — | Telnyx API v2 key (`KEY...`) |
| `phoneNumber` | string | Yes | — | Your Telnyx number in E.164 format |
| `messagingProfileId` | string | No | — | Messaging Profile ID from Telnyx portal |
| `webhookPublicKey` | string | No | — | Ed25519 public key for webhook verification |
| `dmPolicy` | string | No | `"allowlist"` | Access policy: `"open"`, `"allowlist"`, `"disabled"` |
| `allowFrom` | string[] | No | `[]` | E.164 numbers allowed to message (use `["*"]` to allow all) |
| `historyLimit` | integer | No | `15` | Number of past messages loaded into conversation context |
| `blockStreaming` | boolean | No | `true` | Buffer full AI response before sending (recommended for SMS) |
| `chunkMode` | string | No | `"length"` | How to split long messages: `"length"` or `"newline"` |
| `textChunkLimit` | integer | No | `1500` | Max chars per outbound SMS (Telnyx 10-part limit = ~1530) |
| `mediaMaxMb` | integer | No | `1` | Max MMS media size in MB (Telnyx limit: 1MB/file) |
| `webhookPort` | integer | No | `8788` | HTTP port for the inbound webhook server |
| `webhookPath` | string | No | `"/telnyx-sms-webhook"` | URL path for the Telnyx webhook endpoint |
| `enabled` | boolean | No | `true` | Enable/disable this channel |
| `name` | string | No | — | Display name in OpenClaw portal |

### Gate Notify (Unknown Sender Alerts)

When `dmPolicy` is `"allowlist"` and someone not on the list texts your number, the gate system can notify you via another configured channel instead of silently dropping the message.

| Field | Type | Default | Description |
|---|---|---|---|
| `gateNotify.enabled` | boolean | `false` | Enable gate notifications |
| `gateNotify.notifyChannel` | string | — | Channel to send alerts (e.g. `"discord"`, `"whatsapp"`) |
| `gateNotify.notifyTarget` | string | — | Target peer/user on the notify channel |
| `gateNotify.rejectReply` | string | — | Auto-reply to rejected sender (empty = no reply) |
| `gateNotify.cooldownMinutes` | integer | `60` | Minutes before re-notifying about same number |

### Multi-Account Setup

Run multiple phone numbers by adding an `accounts` section:

```json5
{
  "channels": {
    "telnyx-sms": {
      // Shared defaults
      "apiKey": "KEYxxxxxxxxxxxxxxxxxxxxxxxx",
      "dmPolicy": "allowlist",

      "accounts": {
        "primary": {
          "phoneNumber": "+15551234567",
          "allowFrom": ["+15559876543"],
          "name": "Raven Primary"
        },
        "family": {
          "phoneNumber": "+15551234568",
          "allowFrom": ["+15558765432", "+15557654321"],
          "name": "Raven Family"
        }
      }
    }
  }
}
```

## Architecture

```
                    ┌──────────────┐
   Inbound SMS ──▶ │    Telnyx    │
                    │   Cloud API  │
   Outbound SMS ◀──│              │
                    └──────┬───────┘
                           │ webhook POST
                           ▼
                    ┌──────────────┐
                    │  Cloudflare  │
                    │   Tunnel     │
                    └──────┬───────┘
                           │
                           ▼
                    ┌──────────────┐
                    │   OpenClaw   │
                    │   Gateway    │
                    │              │
                    │ /hooks/      │
                    │ telnyx-sms/  │──▶ Ed25519 verify
                    │ inbound      │──▶ Allowlist check
                    │              │──▶ dispatchInboundMessage()
                    │              │──▶ AI inference
                    │              │──▶ sendSmsTelnyx() reply
                    └──────────────┘
```

### How It Works

**Inbound (receiving messages):**

1. Someone texts your Telnyx number
2. Telnyx POSTs a `message.received` webhook to your OpenClaw instance
3. The extension verifies the Ed25519 signature
4. Checks the sender against your allowlist
5. Downloads any MMS media attachments
6. Dispatches through OpenClaw's standard inference pipeline
7. Sends the AI response back via Telnyx SMS

**Outbound (sending messages):**

1. The AI agent decides to send a message
2. Long messages are chunked into SMS-friendly segments (~1500 chars, respecting Telnyx's 10-part concatenated SMS limit)
3. Each chunk is sent via Telnyx POST /v2/messages
4. MMS media URLs are included when the agent sends images/files

### Session Routing

Each phone number gets its own session, following OpenClaw's standard `dmScope` routing:

- `dmScope: "main"` → all SMS conversations collapse to `agent:main:main`
- `dmScope: "channel"` → each phone number gets `agent:main:telnyx-sms:+1XXXXXXXXXX`

## Security

- **Webhook signatures:** Ed25519 verification prevents forged inbound messages
- **Replay protection:** Webhooks older than 5 minutes are rejected
- **Deduplication:** Event IDs are tracked to prevent duplicate processing
- **Allowlist:** Restrict access to specific phone numbers
- **No credentials in code:** API keys live in openclaw.json, not in source

## Troubleshooting

**"Telnyx SMS: apiKey is required"**
Set `channels.telnyx-sms.apiKey` in your openclaw.json.

**Messages sent but not received by the assistant**
- Check that the webhook URL is correct in the Telnyx portal
- Verify your Cloudflare tunnel / ngrok is running
- Check OpenClaw logs for signature verification failures
- Ensure the sender's number is in your `allowFrom` list

**10DLC registration rejected**
- Provide clear, detailed use case descriptions
- Include realistic sample messages
- Ensure your brand website is accessible
- Try "Low Volume Standard" brand type if "Standard" is rejected

**MMS media not downloading**
- Telnyx media URLs expire after 30 days
- Check `mediaMaxMb` — default is 1MB, Telnyx max is 1MB per file
- Ensure your OpenClaw instance has outbound internet access

## Migrating from n8n Bridge

If you're currently using an n8n workflow to bridge Telnyx SMS to OpenClaw's `/v1/chat/completions` endpoint, this native channel replaces that setup:

1. Install this extension
2. Add the `telnyx-sms` channel config to openclaw.json
3. Update the Telnyx webhook URL from n8n to OpenClaw directly
4. Disable the n8n workflow
5. The extension handles the 2-second webhook ACK requirement natively

Benefits over the n8n bridge:
- Native session management (no manual `user` field mapping)
- Proper allowlist/pairing support
- Webhook signature verification
- MMS media handling
- Status monitoring in the OpenClaw portal

## Contributing

PRs welcome! This project follows the OpenClaw channel plugin patterns established by the Signal and Telegram extensions.

```bash
git clone https://github.com/pcitalian/openclaw-channel-telnyx-sms.git
cd openclaw-channel-telnyx-sms
npm install
npm run build
npm test
```

For questions, ideas, or to share your setup, use [GitHub Discussions](https://github.com/pcitalian/openclaw-channel-telnyx-sms/discussions) rather than Issues — Issues are for bugs and concrete feature requests.

## Credits

This extension was developed by [Claude](https://claude.ai) (Anthropic's AI assistant) with human testing, verification, and direction by [Martin Rudolph](https://github.com/pcitalian). The architecture, code, documentation, and console UI integration were all produced through collaborative AI-human development.

## License

MIT — see [LICENSE](./LICENSE)
