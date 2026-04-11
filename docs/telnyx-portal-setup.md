# Telnyx Portal Setup Guide

Complete walkthrough for configuring Telnyx to work with the OpenClaw Telnyx SMS channel extension.

## Step 1: Create a Telnyx Account

1. Go to [telnyx.com/sign-up](https://telnyx.com/sign-up)
2. Complete registration and verify your email
3. Add a payment method (required before buying numbers)

## Step 2: Generate an API Key

1. Navigate to **Account → API Keys** in the left sidebar
2. Click **Create API Key**
3. Give it a name like "OpenClaw"
4. Copy the key — it starts with `KEY` followed by a long alphanumeric string
5. Save this securely; you'll add it to `openclaw.json` as `apiKey`

> **Security note:** This key has full API access. Never commit it to source control.

## Step 3: Purchase a Phone Number

1. Go to **Numbers → Search & Buy Numbers**
2. Set filters:
   - **Country:** United States (or your country)
   - **Number type:** Local or Toll-Free
   - **Features:** Check "SMS" and optionally "MMS"
3. Search for numbers in your preferred area code
4. Click **Buy** on your chosen number
5. Note the number in E.164 format (e.g., `+15551234567`)

## Step 4: Create a Messaging Profile

This connects your number to a webhook endpoint.

1. Go to **Messaging → Messaging Profiles**
2. Click **Add New Profile**
3. Fill in:
   - **Profile Name:** "OpenClaw Assistant" (or your preferred name)
   
4. **Inbound Settings:**
   - **Webhook URL:** `https://your-openclaw-domain.com/hooks/telnyx-sms/inbound`
   - **Failover URL:** (optional) A backup URL if the primary fails
   - **Webhook API Version:** `2` (v2)
   
5. **Outbound Settings:**
   - Leave defaults unless you need delivery status webhooks
   
6. Note the **Public Key** shown in the Inbound Settings section. This is the Ed25519 key used for webhook signature verification. Copy it — you'll use it as `webhookPublicKey` in your config.

7. **Assign Your Number:**
   - In the profile, go to the **Numbers** tab
   - Click **Assign Number** and select the number you purchased
   
8. Click **Save**
9. Note the **Profile ID** (shown in the profile URL or details) — use as `messagingProfileId`

## Step 5: 10DLC Registration (US Numbers Only)

Since 2024, US carriers require 10DLC (10-Digit Long Code) registration for application-to-person (A2P) messaging. Without this, your messages may be filtered or blocked.

### 5a. Register Your Brand

1. Go to **Messaging → 10DLC → Brands**
2. Click **Register Brand**
3. Fill in:
   - **Legal company name:** Your business name (or your name for personal use)
   - **DBA/Brand name:** How you want to appear
   - **Company type:** "Private" for most cases
   - **EIN/Tax ID:** Your business EIN (or SSN for sole proprietor)
   - **Website:** Your domain
   - **Vertical:** Select the closest industry match
   - **Contact info:** Email and phone
4. For brand tier, select:
   - **"Low Volume Standard"** — good for personal or small-scale use (up to ~2,000 msgs/day)
   - **"Standard"** — for higher volume
5. Submit and wait for approval (typically 24-48 hours)

### 5b. Create a Campaign

After your brand is approved:

1. Go to **Messaging → 10DLC → Campaigns**
2. Click **Register Campaign**
3. Fill in:
   - **Brand:** Select your approved brand
   - **Use case:** Choose the best match:
     - "Customer Care" — for assistants that help users
     - "Mixed" — for general-purpose AI assistants
     - "Marketing" — if the assistant sends promotional content
   - **Description:** Be specific about what your assistant does. Example:
     > "AI assistant named Raven that responds to text messages from family members.
     > Handles scheduling, reminders, home automation queries, and general conversation.
     > Only communicates with pre-approved phone numbers via allowlist."
   - **Sample messages:** Provide 2-3 realistic examples:
     > "Good morning! Here's your schedule for today: 9am team standup, 12pm lunch with Charlynn, 3pm CJ pickup from school."
     
     > "The front door camera shows a delivery driver. Package was left on the porch at 2:34 PM."
   - **Message flow:** Describe how users opt in:
     > "Users are manually added to an allowlist by the system administrator. Only pre-approved phone numbers can interact with the assistant."

4. **Content attributes:**
   - Subscriber opt-in: Yes (via allowlist)
   - Subscriber opt-out: Yes (users can text STOP)
   - Subscriber help: Yes (users can text HELP)
   - Embedded links: No (unless your assistant sends URLs)
   - Embedded phone numbers: No
   - Age-gated content: No
   
5. Submit and wait for approval (1-5 business days)

### 5c. Assign Number to Campaign

After campaign approval:

1. Go to your approved campaign
2. Click **Assign Numbers**
3. Select your phone number
4. Confirm assignment

## Step 6: Configure OpenClaw

Add the channel configuration to your `openclaw.json`:

```json5
{
  "channels": {
    "telnyx-sms": {
      "apiKey": "KEYxxxxxxxxxxxxxxxxxxxxxxxx",
      "phoneNumber": "+15551234567",
      "messagingProfileId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      "webhookPublicKey": "your-ed25519-public-key-base64",
      "dmPolicy": "allowlist",
      "allowFrom": [
        "+15559876543",
        "+15558765432"
      ],
      "name": "Raven SMS"
    }
  }
}
```

## Step 7: Set Up Webhook Routing

Your OpenClaw instance needs to be reachable from the internet for Telnyx to deliver webhooks.

### Option A: Cloudflare Tunnel (recommended for production)

```bash
# Create a tunnel pointing to your OpenClaw gateway
cloudflared tunnel create openclaw-sms
cloudflared tunnel route dns openclaw-sms sms.yourdomain.com

# Add to your Docker Compose or run directly
cloudflared tunnel run --url http://localhost:18789 openclaw-sms
```

Then set the Telnyx webhook to: `https://sms.yourdomain.com/hooks/telnyx-sms/inbound`

### Option B: Reverse Proxy (nginx/Caddy)

If you already have a reverse proxy:

```nginx
location /hooks/telnyx-sms/ {
    proxy_pass http://localhost:18789;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

### Option C: ngrok (development only)

```bash
ngrok http 18789
# Copy the HTTPS URL and update the Telnyx webhook
```

## Step 8: Test the Setup

1. Restart OpenClaw to load the new channel config
2. Check the OpenClaw portal — the Telnyx SMS channel should appear as "connected"
3. Send a test SMS from an allowed number to your Telnyx number
4. You should see the message appear in OpenClaw logs and receive a reply

### Debugging

**Check OpenClaw logs:**
```bash
docker logs -f pcplayground_raven 2>&1 | grep telnyx
```

**Test the Telnyx API directly:**
```bash
curl -X POST https://api.telnyx.com/v2/messages \
  -H "Authorization: Bearer KEYxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
    "from": "+15551234567",
    "to": "+15559876543",
    "text": "Test message from Telnyx API"
  }'
```

**Verify webhook delivery:**
- In the Telnyx portal, go to **Messaging → Messaging Profiles → your profile**
- Check the **Webhook Logs** tab for delivery status

## Common Issues

| Issue | Cause | Fix |
|---|---|---|
| Messages not arriving | Webhook URL incorrect | Verify URL in Telnyx portal matches your OpenClaw endpoint |
| 401 on webhook | Signature verification failing | Check `webhookPublicKey` matches the key in Telnyx portal |
| Messages filtered by carrier | 10DLC not registered | Complete 10DLC brand + campaign registration |
| "Rate limit exceeded" | Too many messages | Check Telnyx rate limits for your number type |
| MMS not working | Number doesn't support MMS | Verify MMS capability on your Telnyx number |
| Replies not sending | Invalid API key | Regenerate API key in Telnyx portal |
