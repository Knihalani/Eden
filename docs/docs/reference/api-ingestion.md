---
id: api-ingestion
title: Ingestion API
sidebar_label: Ingestion
sidebar_position: 2
---

# Ingestion API

The ingestion endpoints accept LLM telemetry from any client. All
four formats (`openai`, `anthropic`, `langchain`, `custom`) land in
the same `telemetry_events` table.

## Common headers

Every ingestion POST requires:

| Header | Value |
|--------|-------|
| `Authorization` | `Bearer sk_eden_...` |
| `X-Org-Id` | `org_...` |
| `Content-Type` | `application/json` |
| `Idempotency-Key` | (recommended) UUID for safe retries |

Body cap is **5 MiB**. Larger traces must be chunked.

## `POST /orgs/{org_id}/ingest/openai`

Accept an OpenAI-shaped chat-completion event.

### Request body

```json
{
  "request": {
    "model": "gpt-4o-mini",
    "messages": [{"role": "user", "content": "Hello"}],
    "temperature": 0.7,
    "max_tokens": 256
  },
  "response": {
    "id": "chatcmpl-abc123",
    "model": "gpt-4o-mini-2024-07-18",
    "choices": [
      {
        "index": 0,
        "message": {"role": "assistant", "content": "Hi!"},
        "finish_reason": "stop"
      }
    ],
    "usage": {
      "prompt_tokens": 12,
      "completion_tokens": 4,
      "total_tokens": 16
    }
  },
  "duration_ms": 820,
  "outcome": "success",
  "trace_id": "trc_optional",
  "parent_span_id": "spn_optional",
  "tags": ["prod", "checkout"],
  "attributes": {
    "user_id": "u_abc",
    "session_id": "sess_42"
  }
}
```

### Response

```json
{
  "data": {
    "event_id": "evt_<sha256[:16]>",
    "trace_id": "trc_<sha256[:16]>",
    "span_id": "spn_<sha256[:16]>"
  },
  "meta": { "api_version": "1.7.0", "request_id": "req_..." }
}
```

IDs are content-derived (`<type>_<sha256[:16]>`) so re-sending the
same payload is idempotent — the same event ID comes back and
nothing is duplicated.

## `POST /orgs/{org_id}/ingest/anthropic`

Anthropic Messages shape:

```json
{
  "request": {
    "model": "claude-3-5-sonnet-20240620",
    "system": "You are a helpful assistant.",
    "messages": [{"role": "user", "content": "Hello"}],
    "max_tokens": 1024
  },
  "response": {
    "id": "msg_abc123",
    "content": [{"type": "text", "text": "Hi!"}],
    "stop_reason": "end_turn",
    "usage": {"input_tokens": 12, "output_tokens": 4}
  },
  "duration_ms": 940,
  "outcome": "success"
}
```

## `POST /orgs/{org_id}/ingest/langchain`

Accepts LangChain's `LLMResult` / `ChatResult` shapes. Same envelope
as OpenAI/Anthropic; the decoder normalises both.

```json
{
  "request": {
    "model": "gpt-4o-mini",
    "messages": [{"role": "user", "content": "Hello"}]
  },
  "response": {
    "generations": [[{"text": "Hi!", "generation_info": {}}]],
    "llm_output": {"token_usage": {"prompt_tokens": 12, "completion_tokens": 4}}
  },
  "chain_name": "AgentExecutor",
  "agent_name": "router",
  "intermediate_steps": [["search", "result text"]],
  "duration_ms": 1200,
  "outcome": "success"
}
```

## `POST /orgs/{org_id}/ingest/custom`

Free-form event for any non-LLM telemetry (tool calls, retrievals,
business outcomes):

```json
{
  "events": [
    {
      "name": "checkout_completed",
      "outcome": "success",
      "duration_ms": 137,
      "attributes": {
        "order_id": "ord_abc",
        "amount_usd": 99.00,
        "items": 3
      },
      "tags": ["prod"],
      "trace_id": "trc_xyz"
    }
  ]
}
```

The SDKs send this format under the hood — the framework-specific
endpoints above are convenience wrappers that decode the upstream
SDK shape and re-emit the event in `custom` format internally.

## `POST /orgs/{org_id}/ingest/app`

High-volume batch endpoint for browser / mobile app events:

```json
{
  "events": [
    {
      "event_type": "page_view",
      "user_id": "u_abc",
      "session_id": "sess_42",
      "url": "/checkout",
      "timestamp": "2026-06-19T10:30:00Z",
      "attributes": { "referrer": "/" }
    }
  ]
}
```

Default rate limit: **5000 events / minute / tenant** (separate from
the agent ingest path). Tune via `settings.app_ingest_per_tenant_rpm`.

## Batching

The SDKs send events in batches of up to 200 per POST (configurable
via `max_batch_size`). The server-side limit per batch is 5 MiB. For
bulk backfill, run batches of 1000 events at most — larger batches
hit the time budget on slow networks.

## Webhook fan-out

If you have [webhooks](/reference/webhooks) configured, ingestion
fires them on:

- `trace.started` — first event of a new trace
- `trace.completed` — terminal event (outcome set, span closed)
- `judge.threshold_breach` — judge score crosses your configured threshold

## Errors specific to ingestion

| Status | Code | Cause |
|--------|------|-------|
| 413 | `payload_too_large` | Body over 5 MiB |
| 422 | `decode_failed` | Unknown `source_format` or malformed payload |
| 429 | `rate_limited` | Per-tenant RPM cap hit |
| 502 | `upstream_unavailable` | Postgres or Qdrant unreachable; events are queued client-side and retried |

See [Error codes](/reference/api-error-codes) for the full list.