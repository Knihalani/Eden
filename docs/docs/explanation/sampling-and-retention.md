---
id: sampling-and-retention
title: Sampling and retention
sidebar_label: Sampling and retention
sidebar_position: 6
---

# Sampling and retention

Eden's ingest path takes every event. Trace storage doesn't have
to — you can sample, redact, or drop parts of the dataset to keep
costs predictable.

## Sampling

### Soft-launch default (100% keep)

API Settings and SDKs default to **`EDEN_SAMPLING_PROFILE=full`** so
soft-launch traffic is never dropped. Server-side N16
`decide()` runs on every ingest event but is a no-op under `full`.

For cost reduction after soft-launch:

```bash
# ~15% keep of non-signal traces; errors / loops / stumbles always kept
export EDEN_SAMPLING_PROFILE=balanced
# or ~5%:
# export EDEN_SAMPLING_PROFILE=aggressive
```

Rollback: `EDEN_SAMPLING_ENABLED=false` (forces 100% keep).

### Where it lives

In-process policy: `src/eden/observability/sampling/policy.py`.
Ingest gate: `src/eden/observability/sampling/apply.py`
(`should_route_event`, called from `TelemetryCollector.ingest` after
enrich / before sink routing). Sampled-out events record a
metrics-only row via `trace_sampling_summaries`.

OTel edge sampling (optional): `deploy/otel-collector-config.yaml`.

### Keep rules (default)

| Rule | Effect |
|------|--------|
| `error` / failure outcomes | Keep |
| `loop` / `tool_error` / `stumble` / judge / stat-gate / MCP auth | Keep |
| `force_trace` attribute | Keep |
| `slow` (`duration_ms` > threshold, default 5s) | Keep |
| `probabilistic` | Keep `profile` rate of the rest (`full`=1.0, `balanced`=0.15, `aggressive`=0.05) |

### Tail sampling

For very high-volume orgs, tail sampling buffers events in Redis
and decides keep / drop at trace completion. The buffer is sized
for 1k traces/sec × 10s × 1.5 = 15,000 slots per the Sematext
2026 formula. Older slots are evicted FIFO when full.

### Per-trace opt-in

For debugging or compliance, force a single trace to be kept:

```python
import eden

@eden.trace_agent(name="checkout", attributes={"force_trace": True})
def run(question: str) -> str:
    ...
```

## Retention

### Per-org policy

```bash
curl -X PUT https://api.edenobservability.com/orgs/org_abc/retention \
  -H "Authorization: Bearer sk_eden_admin_..." \
  -H "Content-Type: application/json" \
  -d '{
    "telemetry_events": {
      "full_prompt_response_days": 30,
      "metadata_only_days": 365,
      "delete_after_days": null
    },
    "judge_scores": { "delete_after_days": null },
    "usage_events": { "delete_after_days": 2555 },  # 7 years
    "audit_log": { "delete_after_days": 2555 }
  }'
```

| Phase | Default | Effect |
|-------|---------|--------|
| `full_prompt_response_days` | 30 | After this, `prompt` and `response` are dropped, the row is kept |
| `metadata_only_days` | 365 | After this, the row is kept but compressed; tokens + cost + judge scores retained |
| `delete_after_days` | `null` (forever) | Hard delete |

### Compliance-driven retention

- **GDPR** — set `delete_after_days` per the data subject's consent
  window
- **HIPAA** — 6-year retention minimum (set `metadata_only_days` ≥ 2190)
- **SOC 2** — 7-year retention for `audit_log` (the default)

The retention worker runs nightly. It's reversible — if you change
your mind within the same calendar day, the original prompt and
response are still in the WARM tier.

## Cold storage

After the `full_prompt_response_days` window, `prompt` and
`response` are exported to S3-compatible cold storage
(`eden-cold-{org_id}/{YYYY}/{MM}/{DD}.parquet`) and removed from
Postgres. You can re-import them for compliance audits:

```bash
curl -X POST https://api.edenobservability.com/orgs/org_abc/cold-storage/restore \
  -H "Authorization: Bearer sk_eden_admin_..." \
  -d '{
    "since": "2026-01-01",
    "until": "2026-06-01",
    "trace_ids": ["trc_abc", "trc_def"]
  }'
```

The restore is async (returns a job id). Poll `GET /v1/jobs/{id}`
for status.

## Storage costs

Per-org cost (mid-size customer, 10M events/month, default
retention):

| Tier | Size | $/month |
|------|------|---------|
| Postgres hot (0–30 days) | ~300 GB | ~$30 |
| Postgres warm (30–365 days) | ~30 GB | ~$3 |
| Cold storage (S3 IA) | ~270 GB | ~$5 |
| ClickHouse | ~50 GB | ~$10 |
| Qdrant | ~10 GB | ~$5 |
| **Total** | | **~$53/month** |

Lower this by:

- Sampling aggressively (the cost scales linearly with kept traces)
- Truncating prompts (`max_prompt_tokens: 2048` in the org policy)
- Dropping `attributes` you don't need
- Tightening `metadata_only_days`

## Forecast

The cost intel service projects the next 30 days via OLS regression
on the last 90 days. The dashboard surfaces a "projected cost"
line on the cost chart and fires `cost.forecast_breach` webhooks
when the projection crosses a threshold.