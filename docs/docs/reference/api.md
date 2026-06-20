---
id: api
title: REST API overview
sidebar_label: REST API
sidebar_position: 1
---

# REST API overview

The Eden REST API is the wire-level interface for everything in the
portal — ingestion, traces, evaluations, agents, costs, governance.
The Next.js portal talks to these endpoints over the same auth the
public SDKs use.

## Base URLs

| Environment | Base URL |
|-------------|----------|
| Cloud (US) | `https://api.edenobservability.com` |
| Cloud (EU) | `https://api.eu.edenobservability.com` |
| Self-hosted | `https://{your-domain}` |
| Local dev | `http://localhost:8000` |

All paths are versioned at `/v1/`. The current version is **v1**;
breaking changes get a new `/v2/` prefix with a 12-month
deprecation window.

## Authentication

Three auth modes are accepted on every endpoint:

### 1. Clerk session cookie (browser)

Used by the portal. The browser sends the Clerk `__session` cookie;
the backend verifies it and extracts `user_id`, `org_id`, and the
Clerk JWT.

### 2. Bearer token (service-to-service)

```bash
curl https://api.edenobservability.com/v1/traces \
  -H "Authorization: Bearer sk_eden_..." \
  -H "X-Org-Id: org_..."
```

The API key is per-org. Issue one per environment from the portal
(Settings → API Keys). Rotate by issuing a new key, deploying the
new key, and revoking the old one — there's no in-place rotation.

### 3. Clerk JWT (custom integrations)

For services that already authenticate with Clerk:

```bash
curl https://api.edenobservability.com/v1/traces \
  -H "Authorization: Bearer eyJhbGciOi..." \
  -H "X-Org-Id: org_..."
```

The backend accepts Clerk JWTs in either the `Authorization: Bearer
...` header or the `__session` cookie. The `X-Org-Id` header is
**required** for ingestion paths.

## Required headers

| Header | Required for | Notes |
|--------|--------------|-------|
| `Authorization: Bearer <key>` | Everything except auth endpoints | One of Clerk session, API key, or Clerk JWT |
| `X-Org-Id: org_...` | Ingestion paths | The org the events belong to |
| `Content-Type: application/json` | POST/PUT bodies | |
| `Idempotency-Key: <uuid>` | POST endpoints | Recommended for ingest |
| `X-Region-Hint: <region>` | Optional | Forwarding hint for multi-region writes |

## Response envelope

Every successful response uses the same envelope:

```json
{
  "data": { /* endpoint-specific payload */ },
  "meta": {
    "api_version": "1.7.0",
    "request_id": "req_abc123",
    "timestamp": "2026-06-19T10:30:00Z"
  }
}
```

Paginated endpoints add `total`, `page`, `per_page` to `meta` and
return a `data` array.

Errors look like:

```json
{
  "detail": "human-readable message",
  "request_id": "req_abc123",
  "code": "trace_not_found"
}
```

HTTP status code is always set; `code` is machine-readable. See
[Error codes](/reference/api-error-codes).

## Rate limits

Default per-tenant limits:

| Plan | Ingest req / 60s | API req / 60s | Burst |
|------|------------------|---------------|-------|
| Free | 60 | 60 | 30 |
| Starter | 300 | 300 | 60 |
| Pro | 1500 | 1500 | 200 |
| Enterprise | Custom | Custom | Custom |

Hitting the limit returns `429 Too Many Requests` with a
`Retry-After` header. The SDKs auto-retry with exponential backoff
up to 3 times before bubbling the error.

## Pagination

Cursor-based for traces (where order is meaningful), offset-based
elsewhere:

```bash
# Offset pagination
GET /v1/traces?limit=50&offset=100

# Cursor pagination (traces only)
GET /v1/traces?limit=50&cursor=eyJ0IjoxNzMwNzI3MjAwfQ==
```

The response's `meta.next_cursor` (cursor mode) or `meta.has_more`
(offset mode) tells you when to stop.

## Idempotency

POST endpoints accept an `Idempotency-Key` header. Eden caches the
response for 24 hours keyed on `(org_id, endpoint, key)` — replaying
the same key returns the original response, never a duplicate
resource.

Recommended for all ingest paths.

## Versioning policy

- The current version ships at `/v1/`. It is stable.
- New endpoints may be added without a version bump (additive).
- New required fields on existing endpoints get a version bump and
  a 6-month overlap window.
- Removed fields get a `Deprecation` header and 12-month overlap.

The SDKs pin to a specific minor version. Pin explicitly to lock
behaviour:

```python
eden.configure(api_key=..., org_id=..., api_version="1.7.0")
```

## Endpoint index

| Group | Endpoints |
|-------|-----------|
| [Ingestion](/reference/api-ingestion) | `POST /orgs/{org}/ingest/openai`, `POST /orgs/{org}/ingest/anthropic`, `POST /orgs/{org}/ingest/custom`, `POST /orgs/{org}/ingest/app` |
| [Traces](/reference/api-traces) | `GET /v1/traces`, `GET /v1/traces/{trace_id}/tree`, `GET /v1/traces/{trace_id}/timeline`, `POST /v1/traces/{trace_id}/export` |
| [Agents](/reference/api-agents) | `GET /orgs/{org}/agents`, `POST /orgs/{org}/agents/register`, `GET /orgs/{org}/agents/{id}` |
| [Evaluations](/reference/api-eval) | `POST /v1/evals`, `GET /v1/evals/{eval_id}`, `POST /v1/judges`, `POST /v1/datasets` |
| [Cost](/reference/api-cost) | `GET /v1/budgets`, `POST /v1/budgets/{org}/alerts`, `GET /v1/cost/summary` |
| [Org](/reference/api-organization) | `GET /v1/orgs/{org}`, `POST /v1/orgs/{org}/members`, `GET /v1/orgs/{org}/api-keys` |
| [Errors](/reference/api-error-codes) | Standard error codes |

## Quick example

```bash
# Ingest an OpenAI chat completion
curl -X POST https://api.edenobservability.com/orgs/org_abc/ingest/openai \
  -H "Authorization: Bearer sk_eden_..." \
  -H "Content-Type: application/json" \
  -d '{
    "request": {
      "model": "gpt-4o-mini",
      "messages": [{"role": "user", "content": "Hello!"}]
    },
    "response": {
      "id": "chatcmpl-abc",
      "choices": [{"message": {"role": "assistant", "content": "Hi!"}}],
      "usage": {"prompt_tokens": 12, "completion_tokens": 4, "total_tokens": 16}
    },
    "duration_ms": 820,
    "outcome": "success"
  }'

# Fetch the trace you just ingested
curl https://api.edenobservability.com/v1/traces?limit=10 \
  -H "Authorization: Bearer sk_eden_..." \
  -H "X-Org-Id: org_abc"
```