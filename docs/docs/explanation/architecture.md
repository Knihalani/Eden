---
id: architecture
title: Architecture
sidebar_label: Architecture
sidebar_position: 1
---

# Architecture

Eden is a single FastAPI service backed by Postgres, Redis, Qdrant,
and ClickHouse, fronted by a Next.js portal and two production client
SDKs (Python + TypeScript).
This page explains why it's shaped that way.

## Top-level view

```
                                    ┌─────────────────────┐
   ┌─────────────┐                  │   Eden API (FastAPI)│
   │ SDK (Py/TS) │  POST /ingest    │                     │
   │             │ ───────────────▶ │  ┌───────────────┐  │
   └─────────────┘                  │  │  Telemetry    │  │
                                    │  │  Collector    │  │
   ┌─────────────┐                  │  └───────┬───────┘  │
   │ Portal      │  /api/proxy/*    │          │          │
   │ (Next.js)   │ ───────────────▶ │  ┌───────▼───────┐  │
   └─────────────┘                  │  │  Intelligence │  │
                                    │  │  Services (22)│  │
                                    │  └───────┬───────┘  │
                                    │          │          │
                                    └──────────┼──────────┘
                                               │
                ┌──────────────────────────────┼──────────────────────────────┐
                ▼                              ▼                              ▼
        ┌──────────────┐              ┌──────────────┐               ┌──────────────┐
        │  Postgres    │              │  Qdrant      │               │ ClickHouse   │
        │  (durable)   │              │  (vectors)   │               │ (analytics)  │
        └──────────────┘              └──────────────┘               └──────────────┘
                ▲
                │ (hot path, 1k events/sec/org)
                │
        ┌──────────────┐
        │  Redis       │
        │  (cache +    │
        │  rate limit) │
        └──────────────┘
```

## Why this shape

**FastAPI for the API.** Single Python codebase means the
telemetry collector, intelligence services, and HTTP layer share
types (Pydantic), share an event bus, and share a DB session. The
alternative — polyglot microservices — buys nothing at Eden's scale
and slows iteration.

**Postgres for the source of truth.** Every event, every config,
every audit log entry lives in Postgres. Row-level security (RLS)
policies isolate orgs at the database layer. Traces, judge scores,
agent registrations, and cost events all sit in the same DB, so a
single SQL query can join them.

**Redis for the hot path.** Recent events (last 10k per trace),
rate-limit counters, and the exact-match cache live in Redis. The
cache is *additive* — Postgres is still authoritative, so a Redis
eviction is recoverable.

**Qdrant for vectors.** The retrieval-intelligence service embeds
prompts and responses and stores them in Qdrant. Semantic cache
hits (≥ 0.92 cosine) skip the LLM call entirely.

**ClickHouse for analytics.** Dashboard queries (cost over time,
judge score trends, p95 latency) hit ClickHouse. Postgres handles
single-row reads; ClickHouse handles the aggregation queries that
would otherwise lock the OLTP tables.

**Next.js for the portal.** Same reason as FastAPI — single
language (TypeScript) for the whole client. The portal is
Server-Side-Rendered with selective client components. All API
calls go through the `/api/proxy/[...path]` catch-all, which adds
the Clerk JWT and forwards Set-Cookie back to the browser.

## Telemetry pipeline

Every event flows through the same path:

```
SDK ─POST─▶  /ingest/{format}  ─▶  TelemetryCollector
                                            │
                ┌───────────────────────────┼───────────────────────────┐
                ▼                           ▼                           ▼
            PII scan                  Pydantic validate         Dedupe by event_id
                                            │
                                            ▼
                                    Enrich (cost, model, agent_id, fingerprint)
                                            │
                                            ▼
                                    Fan out to sinks:
                                            │
                ┌───────────────────────────┼───────────────────────────┐
                ▼                           ▼                           ▼
            Postgres                  Redis (hot)              ClickHouse (async)
            telemetry_events          ring buffer              usage_events
                                            │
                                            ▼
                                    WebSocket → portal real-time UI
```

The PII scan happens **before** the rest of the pipeline, so a
rejected payload never lands in Postgres. The cost enrichment is a
lookup against the `model_pricing` table; unknown models pass
through with `cost_usd: null` and a warning.

## Intelligence services

The 22 intelligence services are independent — they read from
`telemetry_events`, `usage_events`, `judge_scores`, and the
episodic KB, and write to their own tables. None of them block
ingestion; all run async (background tasks, scheduled jobs, or
on-demand API calls).

Read the [Intelligence categories](/explanation/intelligence-categories)
page for the full list and what each one does.

## Multi-tenancy

Every Postgres table that holds org data has an `org_id` column
with an RLS policy. The `get_current_org()` FastAPI dependency is
the only legal way to scope a request — it sets the `app.org_id`
Postgres GUC, which the RLS policies read.

Cross-org access returns `403 cross_org_access` from the API and is
audited.

Read [Multi-tenancy](/explanation/multi-tenancy) for the full
model, including the Clerk → Eden org mapping.

## Security

- **At rest** — Postgres encrypted via pgcrypto for sensitive
  columns (PII, API key secrets, OAuth tokens).
- **In transit** — TLS 1.3 at the ingress; mTLS between services
  inside the cluster.
- **Auth** — Clerk (with optional SSO/SAML) for users, bearer
  tokens for services.
- **PII** — in-place redaction before persistence; opt-out is
  audit-logged.
- **Audit** — every mutation logged to `org_audit_log`, retained
  7 years by default.

Read [Security model](/explanation/security-model) for the full
breakdown.

## Scaling

Stateless services (API, portal, SDK) scale horizontally behind
any load balancer. Postgres needs read replicas for read-heavy
workloads. ClickHouse scales independently. Qdrant shards by
org_id.

The current production cluster runs at 99.5% SLO on Northflank:

- `eden-api` — 3 replicas, autoscale to 10
- `eden-portal` — 2 replicas, autoscale to 6
- `eden-jobs-runner` — 2 replicas for background work
- `eden-jobs-cron` — 1 replica (leader-elected) for scheduled work

Read [How-to → Deploy](/how-to/deploy) for the manifest.