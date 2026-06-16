---
id: development
title: Getting started
sidebar_label: Development
sidebar_position: 2
---

# Getting started

This page walks you through running Eden locally.

## Prerequisites

- Python 3.12+
- Node 20+ (for the portal)
- Docker + Docker Compose
- PostgreSQL 16 with the `pgvector` extension
- Redis 7+
- Qdrant (vector DB)

## Backend

```bash
git clone https://github.com/eden/eden
cd eden
python -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"

# Apply DB migrations
alembic upgrade head

# Start the optional streaming / gRPC / edge profiles
docker compose -f docker/docker-compose.yml --profile streaming up -d
docker compose -f docker/docker-compose.yml --profile grpc up -d
docker compose -f docker/docker-compose.yml --profile edge up -d

# Run the API
uvicorn eden.api.app:app --reload
```

## Portal

```bash
cd clients/portal
npm install
npm run dev
```

The portal runs at `http://localhost:3000`. The API runs at
`http://localhost:8000`. Open `http://localhost:3000` and you
should be redirected to the login page.

## Tests

```bash
# Unit tests
pytest tests/unit/

# Integration (requires a running Postgres)
pytest tests/integration/

# End-to-end (requires the portal + API)
pytest tests/e2e/ -m e2e

# Performance benchmarks
PYTHONPATH=src:. python -m bench.run_all
```

## Linting

```bash
ruff check src/ tests/
mypy src/eden
```

## Code style

- Python: `ruff` (lint + format), `mypy` (types)
- TypeScript: `eslint` + `prettier`
- SQL: 4-space indent, lowercase keywords, explicit `IF NOT EXISTS`

## Architecture docs

- `docs/ARCHITECTURE.md` — high-level system design
- `/observability/roadmap` — active roadmap
- `eden-master-architecture-index.md` — full doc index
