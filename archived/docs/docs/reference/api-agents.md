---
id: api-agents
title: Agents API
sidebar_label: Agents
sidebar_position: 4
---

# Agents API

The agent registry lets your service identify itself to Eden so the
portal can group traces by agent, surface per-agent KPIs, and
auto-discover agents via the CLI's `eden config discover-agents`
command.

## `GET /orgs/{org_id}/agents`

List agents registered to the active org.

### Query parameters

| Param | Type | Notes |
|-------|------|-------|
| `framework` | string | `openai`, `langchain`, `crewai`, `autogen`, `custom`, etc. |
| `name` | string | Case-insensitive substring match |
| `limit` | int | Default 50, max 200 |
| `offset` | int | |

### Response

```json
{
  "data": [
    {
      "agent_id": "agent_checkout_v2",
      "name": "checkout",
      "framework": "openai",
      "version": "2.1.0",
      "repo_url": "https://github.com/acme/checkout-agent",
      "registered_at": "2026-06-01T08:00:00Z",
      "last_seen_at": "2026-06-19T10:30:00Z",
      "tags": ["prod", "checkout"]
    }
  ],
  "meta": { "...": "..." }
}
```

## `POST /orgs/{org_id}/agents/register`

Idempotent registration. Call this at agent startup. If
`(org_id, agent_id)` already exists, the existing row is updated;
otherwise a new row is inserted.

### Request

```json
{
  "agent_id": "checkout_v2",          // optional; server-generated UUID if omitted
  "name": "checkout",                 // required
  "framework": "openai",              // optional but recommended
  "version": "2.1.0",                 // optional, free-form
  "repo_url": "https://github.com/acme/checkout-agent",
  "register_token": "rt_...",         // required for first-time registration
  "tags": ["prod", "checkout"],
  "metadata": {
    "model_default": "gpt-4o-mini",
    "max_tokens": 1024
  }
}
```

The `register_token` is a one-time token issued from the portal's
**Onboarding → Register an agent** step. After the first successful
registration, subsequent calls reuse the API key alone.

### Response

```json
{
  "data": {
    "agent_id": "checkout_v2",
    "registered_at": "2026-06-19T10:30:00Z",
    "is_new": true
  }
}
```

## `GET /orgs/{org_id}/agents/{agent_id}`

Fetch one agent registration.

## `DELETE /orgs/{org_id}/agents/{agent_id}`

Soft-delete (sets `archived_at`). Existing traces are preserved and
still queryable via `?agent_id=...`.

## Scoping traces to an agent

Once an agent is registered, threads its `agent_id` through every
LLM call:

```python
import eden

@eden.trace_agent(name="checkout", agent_id="checkout_v2")
def run(user_input: str) -> str:
    # All LLM calls inside automatically inherit agent_id.
    ...
```

Or via the ingestion API:

```json
{
  "events": [
    { "...": "...", "attributes": { "agent_id": "checkout_v2" } }
  ]
}
```

The portal's **Agents** tab groups traces, cost, and judge scores by
`agent_id` once any events carry it.

## Errors

| Status | Code | Cause |
|--------|------|-------|
| 409 | `agent_already_registered` | `agent_id` exists with a different `register_token` |
| 422 | `invalid_framework` | `framework` not in the known list |
| 404 | `agent_not_found` | Unknown agent id |