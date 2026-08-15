---
id: api-traces
title: Traces API
sidebar_label: Traces
sidebar_position: 3
---

# Traces API

Read-side endpoints for traces, spans, and the timeline view.

## `GET /v1/traces`

List traces for the active org.

### Query parameters

| Param | Type | Default | Notes |
|-------|------|---------|-------|
| `limit` | int | 50 | Max 200 |
| `offset` | int | 0 | |
| `cursor` | string | — | Cursor mode (overrides `offset` if set) |
| `agent_id` | string | — | Filter by agent |
| `outcome` | string | — | `success` \| `error` \| `timeout` |
| `min_duration_ms` | int | — | |
| `max_duration_ms` | int | — | |
| `since` | ISO-8601 | — | |
| `until` | ISO-8601 | — | |
| `search` | string | — | Full-text over prompts and responses |
| `tags` | string[] | — | Any-match |

### Response

```json
{
  "data": [
    {
      "trace_id": "trc_abc123",
      "root_span_name": "checkout",
      "agent_id": "agent_checkout_v2",
      "outcome": "success",
      "duration_ms": 1820,
      "input_tokens": 1240,
      "output_tokens": 410,
      "cost_usd": 0.0023,
      "started_at": "2026-06-19T10:30:00Z",
      "ended_at": "2026-06-19T10:30:01.820Z",
      "tags": ["prod", "checkout"]
    }
  ],
  "meta": {
    "api_version": "1.7.0",
    "request_id": "req_...",
    "total": 1234,
    "page": 1,
    "per_page": 50
  }
}
```

## `GET /v1/traces/{trace_id}/tree`

The full span tree for a trace, ordered by `parent_span_id` then
`start_time`. Used by the portal's **Timeline** tab.

```json
{
  "data": {
    "trace_id": "trc_abc123",
    "root_span_id": "spn_root",
    "spans": [
      {
        "span_id": "spn_root",
        "parent_span_id": null,
        "name": "checkout",
        "source_format": "openai",
        "model": "gpt-4o-mini",
        "outcome": "success",
        "duration_ms": 1820,
        "input_tokens": 1240,
        "output_tokens": 410,
        "cost_usd": 0.0023,
        "started_at": "2026-06-19T10:30:00Z",
        "ended_at": "2026-06-19T10:30:01.820Z",
        "attributes": { "user_id": "u_abc" },
        "tags": ["prod"],
        "children": ["spn_llm_1", "spn_tool_1"]
      },
      {
        "span_id": "spn_llm_1",
        "parent_span_id": "spn_root",
        "name": "openai.chat.completions",
        "model": "gpt-4o-mini",
        "outcome": "success",
        "duration_ms": 920,
        "input_tokens": 1240,
        "output_tokens": 180,
        "cost_usd": 0.0009,
        "prompt": "You are a checkout assistant...",
        "response": "Confirmed — order #ord_abc is on its way.",
        "started_at": "2026-06-19T10:30:00.100Z"
      }
    ]
  }
}
```

The tree is bounded to 1000 spans by default. Larger traces use
`POST /v1/traces/{trace_id}/export` to get the full dataset.

## `GET /v1/traces/{trace_id}/timeline`

Same data as `/tree` but flattened for the portal's Gantt view:

```json
{
  "data": {
    "trace_id": "trc_abc123",
    "tracks": [
      {
        "label": "LLM calls",
        "events": [
          {
            "span_id": "spn_llm_1",
            "name": "openai.chat.completions",
            "start_ms": 100,
            "end_ms": 1020,
            "model": "gpt-4o-mini"
          }
        ]
      },
      {
        "label": "Tool calls",
        "events": [
          {
            "span_id": "spn_tool_1",
            "name": "stripe.create_charge",
            "start_ms": 1100,
            "end_ms": 1750,
            "outcome": "success"
          }
        ]
      }
    ]
  }
}
```

## `POST /v1/traces/{trace_id}/export`

Export a trace (and all its spans) as a single JSON or NDJSON
document. Used by the portal's **Export** button and by the
golden-dataset pipeline.

### Request

```json
{
  "format": "ndjson",      // "json" | "ndjson"
  "include_prompts": true,
  "include_responses": true,
  "anonymize_pii": false   // apply the org's PII policy before exporting
}
```

### Response

`200 OK` with the file as `application/x-ndjson` (or `application/json`).

## `GET /v1/spans/search`

Full-text + structured search across all spans (not just root
spans). Use this when you want to find a specific prompt or
response across traces.

### Query parameters

| Param | Type | Notes |
|-------|------|-------|
| `q` | string | BM25 search over prompt + response |
| `model` | string | Filter by model |
| `outcome` | string | `success` \| `error` \| `timeout` |
| `min_cost_usd` | float | |
| `max_cost_usd` | float | |
| `since` | ISO-8601 | |
| `limit` | int | Default 50 |

### Response

```json
{
  "data": [
    {
      "span_id": "spn_...",
      "trace_id": "trc_...",
      "prompt": "...",
      "response": "...",
      "model": "gpt-4o-mini",
      "score": 0.87
    }
  ],
  "meta": { "...": "..." }
}
```

## `POST /v1/traces/compare`

Compare two traces side-by-side (used by the portal's regression
review workflow):

```json
{
  "baseline_trace_id": "trc_abc",
  "candidate_trace_id": "trc_def",
  "fields": ["duration_ms", "cost_usd", "outcome", "judge_score"]
}
```

Response highlights any field where the candidate differs from
baseline by more than the configured threshold.

## Replay

`POST /v1/traces/{trace_id}/replay` re-runs the trace against the
current prompt registry (dry-run by default, unless you pass
`commit: true`). See [Time-Travel Debug](/explanation/intelligence-categories#cat-20--time-travel-debug)
for the full replay semantics.

## Errors

| Status | Code | Cause |
|--------|------|-------|
| 404 | `trace_not_found` | Unknown trace id |
| 403 | `cross_org_access` | Trace belongs to a different org |
| 422 | `replay_failed` | The replay diverged (e.g. upstream model is gone) |