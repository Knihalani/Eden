# Eden — Customer Quickstart

Five minutes from sign-up to first trace in the dashboard.

## 1. Install the SDK

Pick your language. The SDK auto-batches, retries on 429/5xx,
and falls back to disk when offline.

```bash
# Python
pip install eden-sdk
# TypeScript
npm install @eden/sdk
# Rust
cargo add eden-sdk
# Go
go get github.com/eden-labs/sdk-go
```

## 2. Set your API key

```bash
export EDEN_API_KEY=sk_...
export EDEN_DEFAULT_ORG=<your-org-id>
```

Generate a key at `/portal/settings/api-keys`. Copy it once —
the portal only shows it on creation.

## 3. First trace

```python
import eden
with eden.trace("my-agent") as t:
    t.span("tool_call", tool="web_search", query="eden pricing")
    t.span("llm_call", model="gpt-4o-mini", tokens=240)
    t.metric("cost_usd", 0.0008)
    t.event("user_feedback", thumbs="up")
```

Open `/portal/observability` — your trace is in the live tail
within 10 ms of `t.__exit__`.

## 4. First dashboard

- `/portal/observability` — token + cost cards, trace table
  with virtualized scroll, span tree on click.
- `/portal/observability/apm` — latency percentiles, error
  budget burn-down, service map.
- `/portal/observability/insights` — prioritized drift list
  with severity bars and action buttons.

## 5. Wire a webhook

`/portal/settings/webhooks` → New → paste your URL → save.
Eden retries with exponential backoff (10 attempts, max 24h),
signs every delivery with `v1=<HMAC-SHA256>`, and dead-letters
on final failure. Inspect the DLQ at `/portal/webhooks-dlq`.

## Next steps

- **Add the judge**: `/portal/llmops` to start scoring your
  LLM outputs. Pre-built judges for factuality, toxicity, and
  instruction-following.
- **Set a budget**: `/portal/settings/billing` → "Hard cap"
  to block requests when monthly spend exceeds the threshold.
- **Onboard your team**: `/portal/settings/teams` → invite.
  Roles: owner / admin / member / viewer.

## Troubleshooting

`/docs/TROUBLESHOOTING.md` covers the top 10 errors with log
excerpts and fixes. For deeper issues, the runbooks in
`/docs/runbooks/` are operator-facing.
