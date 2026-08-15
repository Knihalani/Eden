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

### Soft-launch default (`full`, 100% keep)

API Settings and SDKs default to **`EDEN_SAMPLING_PROFILE=full`** so
traffic is never dropped unless you opt in. Server-side N16
`decide()` runs on every ingest event but is a no-op under `full`.

For **production cost reduction**, keep 100% of important traces
(error / slow / high-cost / `force_trace`, plus other ingest-time
signals) and sample ordinary success traffic:

```bash
# ~15% keep of non-signal traces; important traces always kept
export EDEN_SAMPLING_PROFILE=balanced
# or ~5%:
# export EDEN_SAMPLING_PROFILE=aggressive
```

The SDKs still default to `sampling_profile = "full"` with
`client_probabilistic_sampling = False`, so even if you set
`EDEN_SAMPLING_PROFILE=balanced` for the server, leave the SDK on
force-keep-only (or `full`) — that way the probabilistic 15% runs
once on the server and does **not** compound with a second client drop.

Rollback: `EDEN_SAMPLING_ENABLED=false` (forces 100% keep).

Two other server-side knobs feed the keep rules directly (both are
`Settings` fields in `src/eden/config.py`, with the usual
`EDEN_*`-prefixed env alias):

- `sampling_high_cost_usd` (default `0.50`) — a trace is force-kept
  once its enriched `metrics.cost_usd` reaches this many dollars.
- `sampling_slow_threshold_ms` (default `5000`) — a trace is
  force-kept once `duration_ms` exceeds this.

#### SDK + server: don't set the same profile on both without meaning to

`EDEN_SAMPLING_PROFILE` is read by **both** the server (`Settings`)
and the Python/TypeScript SDKs (`EdenConfig.sampling_profile` /
`ResolvedConfig`) — they are independent gates, not one shared knob.
If you set `EDEN_SAMPLING_PROFILE=balanced` intending to enable the
*server's* N16 gate, but an SDK in the same environment also reads
that var, two independent ~15% gates compound **multiplicatively**
(0.15 × 0.15 ≈ 2.25% effective keep), not additively — with nothing in
either layer's logs to explain the drop.

To make "set the profile on the server alone" behave exactly as
documented, the SDKs' client-side probabilistic drop is **off by
default**: with a non-`full` profile, the SDK only force-keeps
error/slow/`force_trace` traces and otherwise sends everything,
leaving the probabilistic decision to the server. Set
`EDEN_CLIENT_PROBABILISTIC_SAMPLING=1` (Python)
/ `clientProbabilisticSampling: true` (TypeScript) only for a
deployment that has no server-side N16 gate to defer to. Setting a
non-`full` SDK profile without this flag still logs one
process-lifetime warning as a heads-up that the *server* may also be
sampling.

### Where it lives

In-process policy: `src/eden/observability/sampling/policy.py`.
Ingest gate: `src/eden/observability/sampling/apply.py`
(`should_route_event`, called from `TelemetryCollector.ingest` after
enrich / before sink routing). Sampled-out events record a
metrics-only row via `trace_sampling_summaries`.

OTel edge sampling (optional): `deploy/otel-collector-config.yaml`.

### Keep rules — what actually runs where

The keep rules in the table below are all evaluated by
`IntelligenceAwareSamplingPolicy.decide()`
(`src/eden/observability/sampling/policy.py`), but not all of them can
fire at the point this table implies. **Ingest time** — inside
`should_route_event` / `keep_signals_for_event`
(`src/eden/observability/sampling/apply.py`), which runs once per event
right after `_enrich()` and before sink routing — only has the signals
that are computable from a *single event* the instant it arrives:

| Rule | Available at ingest? | Source |
|------|----------------------|--------|
| `error` / failure outcomes | Yes | `event.outcome`, `attributes["error"]` / `otel.status_code` |
| `force_trace` attribute | Yes | `attributes["eden.force_trace"]` (see the SDK example below) |
| `high_cost` | Yes | `metrics["cost_usd"]` (stamped by `_enrich` from token counts before this gate runs) vs. `sampling_high_cost_usd` (default `$0.50`) |
| `slow` (`duration_ms` > threshold, default 5s) | Yes | `event.duration_ms` vs. `sampling_slow_threshold_ms` |
| `tool_error` | Yes, if the SDK/attribute sets `eden.tool_error` on the event | — |
| `loop` / `judge_failure` / `stumble` / `stat_gate_fail` / `mcp_auth_failure` | **No — post-hoc only** | These are trace-quality verdicts computed by the async quality pipeline (`src/eden/observability/quality_pipeline/`) AFTER the trace is stored; a single event at ingest time has no loop/judge/stumble verdict yet to read. They only take effect through the OTel-collector tail-sampling path below (which waits `decision_wait` before deciding) or when something upstream stamps the attribute onto the event before it reaches ingest. |
| `probabilistic` | Yes | Fallback for everything else — keeps `profile` rate (`full`=1.0, `balanced`=0.15, `aggressive`=0.05) |

In short: at ingest, Eden can only ever force-keep on signals a single
event already carries (error / force_trace / high_cost / slow /
explicitly-stamped tool_error). Loop, judge-failure, and stumble
detection are real, but they run later against already-stored traces —
they cannot retroactively un-sample an event ingest already dropped.

### Tail sampling (OTel collector only)

Eden's in-process N16 gate (the table above) makes its keep/drop
decision per-event, with no cross-span buffering. If you want a
decision made at *trace completion* instead — so a loop/judge/stumble
verdict computed from the whole trace can influence sampling — that is
a separate, optional deployment piece: the OTel Collector's
`tail_sampling` processor (`deploy/otel-collector-config.yaml`), which
buffers spans **in the collector's own process memory** (not Redis;
this codebase has no Redis-backed sampling buffer anywhere) for
`decision_wait: 10s`, sized for `num_traces: 20000` in-flight traces.
Older/completed traces are evicted from that in-memory buffer as
decisions are made — there's no separate FIFO-eviction formula beyond
the collector's own `num_traces` cap.

### Per-trace opt-in

For debugging or compliance, force a single trace to be kept. The
attribute must reach the server as `eden.force_trace` — the Python and
TypeScript SDKs both map a `force_trace` key to that wire name
automatically:

```python
import eden

@eden.trace_agent(name="checkout", attributes={"force_trace": True})
def run(question: str) -> str:
    ...
```

```typescript
import { trace } from "@eden-ai/sdk";

const t = trace("checkout", { attributes: { force_trace: true } });
// ... t.setOutput(result);
t.end();
```

Any other attribute key you pass through `attributes={...}` follows
the same rule: a key already namespaced under `eden.` (e.g.
`eden.tool_error`) is sent as-is; everything else is prefixed with
`eden.span.` so it doesn't collide with Eden's own reserved keys.

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