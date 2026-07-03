# Eden — Architecture

## Overview

Eden is an observability + improvement platform for AI agents and LLM apps.
Three deployable surfaces share a single backend:

```
┌──────────────────┐    Clerk OAuth    ┌──────────────────┐
│  Portal (Next.js)│ ────────────────► │  Backend         │
│  edenobservability.com                 │  (FastAPI)        │
└──────────────────┘                   │  api.edenobservability.com
                                        │
                                        ▼
                          ┌──────────────────────────────┐
                          │  Postgres (Neon)             │
                          │  Redis (dedup, rate-limit)   │
                          │  ClickHouse / Tinybird       │
                          │  S3-compatible (Impossible)  │
                          │  Qdrant Cloud                │
                          │  OpenRouter (LLMs)           │
                          └──────────────────────────────┘
```

## Components

| Layer       | Tech                        | Role                                           |
|-------------|-----------------------------|------------------------------------------------|
| Portal      | Next.js 16 (App Router)     | UI, Clerk auth, OTel browser SDK                |
| Backend     | FastAPI (Python 3.12)       | REST API, auth, ingestion, eval, observability |
| Database    | Postgres 16 (Neon Scale)    | Source of truth, RLS-enforced                  |
| Cache       | Redis (Upstash)             | Dedup, rate-limit, SSE tail buffer             |
| Object store| Impossible Cloud (S3)       | Tenant uploads, KB docs, trace payloads        |
| Vector      | Qdrant Cloud                | KB embeddings, retrieval                       |
| LLM         | OpenRouter (MiniMax M3)     | T1/T2/T3 tier routing                          |
| Email       | Resend                      | DSAR + exports + verification                  |
| Error track | Sentry                      | Backend + portal error tracking                |
| Analytics   | PostHog (opt-in)            | Product analytics, opt-in only                 |

## Auth flow

1. User lands on the portal.
2. Clerk hosts the sign-in form. On success, Clerk issues a session JWT in a
   `__session` HttpOnly cookie.
3. The portal's catch-all proxy attaches the Clerk session JWT as
   `Authorization: Bearer <jwt>` to every backend call.
4. The backend's `clerk_auth._verify_clerk_token` decodes the JWT against
   Clerk's JWKS (auto-refreshed on `kid` miss), looks up / provisions the
   Eden user, and sets the request-scoped `current_user` via FastAPI deps.

## Telemetry ingestion

```
SDK → POST /orgs/{org_id}/ingest/{format}
  → OTel collector (multi-format decoders: otlp, langchain, openai, ...)
  → PII pre-mask (PIIFilter.apply)
  → TelemetryCollector.ingest_batch
      → dedup (Laminar 20× trick, content-addressed messages)
      → enrich (tenant_id, agent_id, trace_id, ...)
      → route
          ├→ Postgres (telemetry_events, judge_scores)
          ├→ ClickHouse (columnar rollups, 90-day window)
          ├→ Tinybird (cost + judge hourly/daily)
          ├→ Qdrant (KB embeddings)
          └→ Typesense (full-text search)
```

## Judge pipeline

```
TelemetryEvent → JudgeRegistry.for_event(event) → [Judge1, Judge2, ...]
  → JudgeRunner.run_for_event (asyncio.gather + Semaphore)
      ├→ OpenRouter LLM call (T1 tier)
      └→ JudgeScore → Postgres judge_scores table
                        → judge_detector → Insight
                        → KB → next prompt iteration
```

## Hook / closed loop

```
LLM call → BudgetService.record_usage
  → if over budget: hook.emit(on_budget_exceeded)
      → HookBus.sweep() (cascading dedup)
      → if high-severity: PromotionHook fires
          ├→ drift_alert → Slack / PagerDuty
          ├→ policy_change → guardrail update
          └→ truncate_context → next prompt
```

## Webhook delivery

```
event → webhook_delivery.deliver_event
  → CAS UPDATE webhook_deliveries (status: pending → in_flight)
  → SSRF guard (_assert_public_ip re-resolves at delivery)
  → HMAC-SHA256 sign (Stripe-style v1)
  → httpx.AsyncClient.post (shared + Semaphore(16))
  → on 2xx: succeeded
  → on fail: retry via loop.call_later (0s, 1s, 5s, 25s, 2m, 10m, 1h)
  → on exhaustion: webhook_dlq
      → portal UI "Replay" button → webhook_delivery.replay_dlq
          (cap 3 replays, 60s gap)
```

## Multi-tenancy

Every table that holds tenant data has a row-level security (RLS) policy
gated on the `app.current_org_id` GUC, set per-request by
`RLSOrgContextMiddleware` (registered at app level). Bypass is only possible
via `BYPASSRLS` (the migration role) — not the application user.

Every mutation logs an entry in `audit_log` with the actor's user_id,
org_id, action, and resource.

## Deployment

* Backend: Northflank (FastAPI on Python 3.12, multi-replica).
* Portal: Vercel (Next.js, edge runtime for middleware).
* Background workers: Northflank jobs (`sidecar-worker`, `cleanup`).

CI: GitHub Actions (`.github/workflows/{backend-ci,portal-ci,deploy}.yml`).
