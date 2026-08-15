---
id: api-error-codes
title: Error codes
sidebar_label: Error codes
sidebar_position: 8
---

# Error codes

Every error response has the same shape:

```json
{
  "detail": "human-readable message",
  "code": "machine_readable_code",
  "request_id": "req_abc123",
  "extra": { /* optional context */ }
}
```

The HTTP status is always set; `code` is stable and machine-readable
(use it for retry decisions and branch logic). `detail` is
human-readable and may change.

## Auth & authz

| Status | Code | Cause |
|--------|------|-------|
| 401 | `not_authenticated` | Missing or expired token |
| 401 | `invalid_token` | Token signature mismatch |
| 403 | `not_org_member` | Caller isn't in the org |
| 403 | `permission_denied` | Role doesn't allow the action |
| 403 | `cross_org_access` | Resource belongs to a different org |
| 403 | `org_archived` | Org has been soft-deleted; restore from the portal first |
| 403 | `feature_disabled` | The route is gated behind a feature flag the org hasn't enabled |

## Resources

| Status | Code | Cause |
|--------|------|-------|
| 404 | `trace_not_found` | Unknown trace id |
| 404 | `span_not_found` | Unknown span id |
| 404 | `agent_not_found` | Unknown agent id |
| 404 | `judge_not_found` | Unknown judge id |
| 404 | `dataset_not_found` | Unknown dataset id |
| 404 | `eval_not_found` | Unknown eval id |
| 404 | `org_not_found` | Unknown org id |
| 404 | `member_not_found` | Unknown user id |
| 404 | `key_not_found` | Unknown API key id |

## Validation

| Status | Code | Cause |
|--------|------|-------|
| 400 | `bad_request` | Generic 400 (rare — prefer a specific code) |
| 422 | `decode_failed` | Ingestion body failed to decode |
| 422 | `invalid_prompt` | LLM judge rubric failed schema validation |
| 422 | `invalid_threshold` | Threshold percent outside `0 < p < 100` |
| 422 | `invalid_framework` | Framework not in the known list |
| 422 | `replay_failed` | Trace replay diverged (upstream model gone, etc.) |

## Limits

| Status | Code | Cause |
|--------|------|-------|
| 413 | `payload_too_large` | Body over 5 MiB |
| 429 | `rate_limited` | Per-tenant RPM cap hit |
| 429 | `judge_quota_exceeded` | Per-org LLM-as-judge budget hit |
| 402 | `payment_required` | Cost hard limit hit, no overage budget |
| 429 | `seats_limit_exceeded` | Trying to invite past the seats cap |

## Server-side

| Status | Code | Cause |
|--------|------|-------|
| 500 | `internal_error` | Unexpected exception (server log has details) |
| 502 | `upstream_unavailable` | Postgres, Qdrant, or ClickHouse unreachable |
| 503 | `maintenance` | Planned maintenance window (Retry-After always set) |
| 504 | `upstream_timeout` | Upstream exceeded its SLA |

## Retry guidance

| Code class | Retry? | Backoff |
|------------|--------|---------|
| 4xx (validation) | No | — |
| 401, 403 | No (after re-auth) | — |
| 404 | No | — |
| 429 | Yes | Honor `Retry-After` (seconds) |
| 5xx | Yes | Exponential, 100ms → 1.6s, max 3 tries |
| 502, 503, 504 | Yes | Same as 5xx |

The SDKs implement the retry policy by default. To turn it off:

```python
eden.configure(api_key=..., org_id=..., max_retries=0)
```

## Request ID correlation

Every response (success or error) carries `request_id`. Quote it
when opening a support ticket — it lets us grep the server log
instantly.

```bash
$ curl -i ... | grep -i x-request-id
X-Request-ID: req_01HXYZABCDEF
```