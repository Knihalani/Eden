---
id: deployment
title: Deployment
sidebar_label: Deployment
sidebar_position: 4
---

# Deployment

Eden runs as a set of Docker services. The default
`docker/docker-compose.yml` brings up the core; profiles add
optional services (streaming, gRPC, edge).

## Core services

```bash
# Postgres + pgvector
docker compose -f docker/docker-compose.yml up -d postgres
# Redis
docker compose -f docker/docker-compose.yml up -d redis
# Qdrant (vector DB)
docker compose -f docker/docker-compose.yml up -d qdrant
# API
docker compose -f docker/docker-compose.yml up -d api
```

## Profiles

| Profile | What it adds | When to use it |
|---------|-------------|----------------|
| `streaming` | Redpanda + ksqlDB | Phase 5.4.5 stream processing |
| `grpc` | gRPC server (port 50051) | Internal service-to-service |
| `edge` | Ably / Cloudflare edge fanout | Multi-region deployments |

```bash
docker compose -f docker/docker-compose.yml --profile streaming up -d
docker compose -f docker/docker-compose.yml --profile grpc up -d
docker compose -f docker/docker-compose.yml --profile edge up -d
```

## Environment

All configuration is via `.env`. See `.env.example` for the full
list. Required:

- `POSTGRES_*` — DB connection
- `JWT_SECRET` — auth (must be 32+ chars in prod)
- `ENCRYPTION_KEY` — Fernet key for encrypted secrets
- `OPENROUTER_API_KEY` (or `MINIMAX_*`) — LLM provider

## Self-hosted (Helm)

A self-hosted Kubernetes Helm chart is in the §7.3 roadmap. In
the meantime, the Docker compose setup is suitable for
single-node deployments. For multi-node, run each service
behind its own StatefulSet.

## Backups

`docker/postgres/backup.sh` runs `pg_dump` and uploads to S3.
Cron via `.github/workflows/db-backup.yml` (once a firm engages
to set up; see §9.1.3) or a system cron.

## Disaster recovery

`scripts/dr_drill.sh` restores the latest backup into a fresh
DB, runs a smoke query, and writes a JSON report. Run quarterly
per `docs/runbooks/disaster-recovery-drill.md`.

## Observability

- `/health` — liveness + dependency check
- `bench.run_all` — performance benchmarks
- `src/eden/observability/alerts.py` — alert rules engine

## Scaling

Stateless services (API, CLI) scale horizontally behind any
load balancer. Postgres needs read replicas for read-heavy
workloads. ClickHouse for analytics scales independently.
