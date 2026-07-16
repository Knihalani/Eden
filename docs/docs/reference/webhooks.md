---
id: webhooks
title: Webhooks
sidebar_label: Webhooks
sidebar_position: 5
---

# Webhooks

Subscribe to platform events from your own service. Webhooks fire
on the same event bus as the portal's real-time UI.

## Endpoint configuration

```bash
curl -X POST https://api.edenobservability.com/orgs/org_abc/webhooks \
  -H "Authorization: Bearer sk_eden_admin_..." \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://your-app.com/eden/webhook",
    "events": ["trace.completed", "judge.threshold_breach"],
    "secret": "whsec_..."
  }'
```

| Field | Notes |
|-------|-------|
| `url` | HTTPS only (HTTP allowed for `localhost` / `127.0.0.1` in dev) |
| `events` | Subset of the catalog below |
| `secret` | HMAC-SHA256 signing key; rotate by issuing a new endpoint |

## Event catalog

### Traces

#### `trace.started`

First event of a new trace.

```json
{
  "event": "trace.started",
  "trace_id": "trc_abc",
  "agent_id": "checkout_v2",
  "started_at": "2026-06-19T10:30:00Z",
  "org_id": "org_abc"
}
```

#### `trace.completed`

Terminal event.

```json
{
  "event": "trace.completed",
  "trace_id": "trc_abc",
  "outcome": "success",
  "duration_ms": 1820,
  "input_tokens": 1240,
  "output_tokens": 410,
  "cost_usd": 0.0023,
  "judge_scores": {
    "no_pii": 1.0,
    "is_concise": 4.5
  }
}
```

### Judges

#### `judge.threshold_breach`

A single score crossed the configured threshold.

```json
{
  "event": "judge.threshold_breach",
  "judge_id": "judge_abc",
  "trace_id": "trc_abc",
  "score": 2.0,
  "threshold": 4.0,
  "severity": "warning"
}
```

#### `judge.regression`

An eval run's mean score dropped vs the previous run.

```json
{
  "event": "judge.regression",
  "judge_id": "judge_abc",
  "previous_mean": 4.5,
  "current_mean": 3.8,
  "drop": 0.7,
  "threshold": 0.5
}
```

### Cost

#### `cost.threshold_breach`

A budget crossed a configured threshold.

```json
{
  "event": "cost.threshold_breach",
  "resource": "tokens",
  "percent": 95.0,
  "used": 1_900_000_000,
  "soft_limit": 2_000_000_000,
  "hard_limit": 3_000_000_000,
  "severity": "critical"
}
```

#### `cost.anomaly`

A daily total is a z-score outlier.

```json
{
  "event": "cost.anomaly",
  "z": 4.2,
  "expected_usd": 140.00,
  "actual_usd": 412.00,
  "attributed_to": { "model": "gpt-4o", "agent_id": "agent_research_v3" }
}
```

### Incidents

#### `incident.created`

A new high-severity cluster was identified.

```json
{
  "event": "incident.created",
  "incident_id": "inc_abc",
  "cluster_id": "clu_<sha256[:16]>",
  "severity": "high",
  "trace_count": 142,
  "first_trace_at": "2026-06-19T09:00:00Z"
}
```

#### `incident.resolved`

Auto-resolved or manually closed.

### Agents

#### `agent.registered`

```json
{
  "event": "agent.registered",
  "agent_id": "checkout_v2",
  "framework": "openai",
  "version": "2.1.0"
}
```

#### `agent.deprecated`

Auto-deprecated by drift detection (Cat 6).

```json
{
  "event": "agent.deprecated",
  "agent_id": "agent_research_v3",
  "drift_type": "fleet_deprecation",
  "reason": "no events in 90 days"
}
```

### Audit

#### `audit.api_key.create`

#### `audit.api_key.revoke`

#### `audit.member.invite`

#### `audit.member.remove`

## Delivery

| Response | Retry? |
|----------|--------|
| 2xx | No |
| 4xx (except 408, 429) | No |
| 408, 429 | Yes (exp backoff, max 24h) |
| 5xx | Yes (exp backoff, max 24h) |

Headers:

- `X-Eden-Event-Id` — dedupe key (stable across retries)
- `X-Eden-Signature` — `t=<ts>,v1=<hmac-sha256>`
- `X-Eden-Attempt` — 0-indexed retry counter

## Dead-letter queue

After 24 hours of failed delivery, events land in the dead-letter
queue (Settings → Webhooks → DLQ). Replay, inspect, or disable
the endpoint from there.

See [How-to → Webhooks](/how-to/webhooks) for the setup walk-through.