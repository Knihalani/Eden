---
id: architecture
title: Architecture
sidebar_label: Architecture
sidebar_position: 3
---

# Architecture

> A 5-minute tour of how Eden works. For deep dives, see the
> per-component architecture docs (linked from
> `eden-master-architecture-index.md`).

## Pipeline (interview → environment)

```
User → Interviewer → Spec → Planner → Critic → Refiner →
        Executor → Tester → Verifier → Archivist → Job complete
```

Each node is an LLM-powered agent. The Archivist writes the
result to the Knowledge Base so the next Planner can read it.

## Knowledge Base

Three layers, each with its own storage and lifecycle:

| Layer | Storage | Use |
|-------|---------|-----|
| **Episodic** | Postgres (`jobs` table) | Per-job run history |
| **Semantic** | Postgres + Qdrant (graph_entities) | Cross-job knowledge |
| **Procedural** | Postgres + Qdrant (env_classes, design_patterns) | Reusable patterns |

AUDN protocol (Add / Update / Delete / No-op / Conflict) governs
writes so the KB doesn't accumulate duplicates.

## Observability

A single `TelemetryEvent` type flows through four sinks:

- **Redis** — hot-path (last 10k events per trace)
- **Postgres** — durable audit log
- **ClickHouse** — analytics (p50/p95/p99 latencies, SLO queries)
- **WebSocket** — real-time fanout to the portal

The `TelemetryCollector` validates, enriches (content hashes,
fingerprinting), deduplicates, and routes.

## AI Gateway

Every LLM call goes through a single chokepoint. The gateway:

- Scrubs PII (filter registry; PII by default)
- Checks exact-match cache (Redis) then semantic cache (Qdrant)
- Enforces per-tenant token budgets
- Routes to the cheapest healthy provider
- Records per-call metrics (latency, cost, error rate)
- Surfaces an OpenAI-compatible surface for SDKs

## Multi-tenancy

Every row in Postgres carries `org_id`. Row-level security
policies block cross-org reads. The `get_current_org` FastAPI
dependency is the only legal way to scope a request to a tenant.

## Sandbox

Generated code runs in a Firecracker microVM. The runner spins up
an ephemeral VM, runs the Tester probes (12 categories), captures
the result, and tears the VM down. BandSox handles snapshot
management.

## Data platform

Bronze → Silver → Gold lakehouse pattern:

- **Bronze** — raw event lake (S3 Parquet)
- **Silver** — curated, typed, deduplicated (ClickHouse)
- **Gold** — quality-scored training datasets

## Components by directory

| Path | What it is |
|------|-----------|
| `src/eden/agents/` | The 14 pipeline agents |
| `src/eden/kb/` | Knowledge Base (episodic + semantic + procedural) |
| `src/eden/observability/` | Telemetry collector, alerts engine |
| `src/eden/optimization/` | Cost optimization (caching, routing) |
| `src/eden/llmops/` | AI gateway, model registry, prompt registry |
| `src/eden/data_platform/` | Bronze/Silver/Gold lakehouse |
| `src/eden/insights/` | Detector registry, dataset engine, correlation |
| `src/eden/multi_agent/` | Multi-agent environments |
| `src/eden/sandbox/` | Firecracker runner |
| `src/eden/api/` | FastAPI routes + middleware |
| `src/eden/cli/` | `eden` CLI |
| `src/eden/sdk/` | Python SDK |
| `clients/portal/` | Next.js portal |
