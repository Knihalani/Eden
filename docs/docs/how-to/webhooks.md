---
id: webhooks
title: Set up webhooks
sidebar_label: Set up webhooks
sidebar_position: 12
---

# How-to — Set up webhooks

Subscribe to platform events from your own service. Webhooks fire
on the same event bus as the portal's real-time UI.

## Add a webhook

### From the portal

**Settings → Webhooks → Add endpoint**.

Fill in:

- **URL** — `https://your-app.com/eden/webhook`
- **Events** — pick from the catalog below
- **Secret** — used to sign the payload (HMAC-SHA256)
- **Description** — for your own bookkeeping

The portal sends a test event on save.

### From the API

```bash
curl -X POST https://api.edenobservability.com/v1/orgs/org_abc/webhooks \
  -H "Authorization: Bearer sk_eden_admin_..." \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://your-app.com/eden/webhook",
    "events": ["trace.completed", "judge.threshold_breach"],
    "secret": "whsec_..."
  }'
```

## Events

| Event | Fires when |
|-------|-----------|
| `trace.started` | First event of a new trace |
| `trace.completed` | Terminal event (outcome set, span closed) |
| `judge.threshold_breach` | A judge score crosses the configured threshold |
| `judge.regression` | A regression alert fires |
| `cost.threshold_breach` | A cost budget crosses a configured threshold |
| `cost.anomaly` | A cost anomaly is detected |
| `budget.hard_exceeded` | The org hit a hard cost limit |
| `incident.created` | A new incident cluster is identified |
| `incident.resolved` | An incident is auto-resolved or manually closed |
| `agent.registered` | A new agent is registered in the org |
| `agent.deprecated` | An agent is auto-deprecated (drift detection) |
| `pii.match` | A PII redaction occurred (sampled, 1 in 1000) |
| `audit.api_key.create` | A new API key was issued |
| `audit.api_key.revoke` | An API key was revoked |

The full catalog with payload schemas is in
[Reference → Webhooks](/reference/webhooks).

## Signature verification

Every webhook includes an `X-Eden-Signature` header:

```
X-Eden-Signature: t=<unix-timestamp>,v1=<hex-digest>
```

Verify with the secret:

```python
import hmac, hashlib, time

def verify(secret: str, header: str, body: bytes) -> bool:
    parts = dict(p.split("=", 1) for p in header.split(","))
    timestamp = parts["t"]
    digest = parts["v1"]

    # Replay protection: reject anything older than 5 minutes.
    if abs(time.time() - int(timestamp)) > 300:
        return False

    signed = f"{timestamp}.".encode() + body
    expected = hmac.new(secret.encode(), signed, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, digest)
```

The `t=` field is independent of the body so the signature is
robust to header reordering.

## Idempotency

Every webhook carries an `X-Eden-Event-Id` header. Store this as
the dedupe key — Eden retries failed deliveries (5xx, timeout) with
exponential backoff for up to 24 hours, so the same event may
arrive more than once.

## Retry policy

| Response | Retry? |
|----------|--------|
| 2xx | No |
| 4xx (except 408, 429) | No — fix your endpoint |
| 408, 429 | Yes, exponential backoff |
| 5xx | Yes, exponential backoff (1s → 60s, max 24h) |

The `X-Eden-Attempt` header tells you which retry this is (0-indexed).

## Dead-letter queue

If delivery fails after 24 hours, the event lands in the
**Webhooks → Dead-letter queue** tab. From there you can:

- Replay the event (re-POST with the original payload)
- Inspect the request and response logs from each attempt
- Disable the endpoint to stop further retries

## Local development

Use a tunnel:

```bash
# ngrok
ngrok http 3000
# Paste the https://... URL into Settings → Webhooks

# Cloudflare tunnel
cloudflared tunnel --url http://localhost:3000
```

Or use the webhook inspector:

```bash
# webhook.site
# 1. Visit https://webhook.site, copy the URL
# 2. Paste into Settings → Webhooks
# 3. Trigger an event in Eden
# 4. See the payload on webhook.site
```

## Code example

A minimal Express handler:

```js
import express from "express";
import crypto from "node:crypto";

const app = express();
app.use(express.raw({ type: "application/json" }));

app.post("/eden/webhook", (req, res) => {
  const header = req.headers["x-eden-signature"];
  const secret = process.env.EDEN_WEBHOOK_SECRET;

  const parts = Object.fromEntries(
    header.split(",").map((p) => p.split("=", 2))
  );
  const signed = `${parts.t}.`.encode() + req.body;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(signed)
    .digest("hex");

  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1))) {
    return res.status(401).send("bad signature");
  }

  const event = JSON.parse(req.body);
  switch (event.type) {
    case "trace.completed":
      // your handler
      break;
    case "judge.threshold_breach":
      // your handler
      break;
  }

  res.status(200).end();
});
```