---
id: deploy
title: Deploy self-hosted
sidebar_label: Deploy self-hosted
sidebar_position: 4
---

# How-to — Deploy self-hosted

Three deployment paths: **Docker Compose** (single-node dev or
small teams), **Kubernetes** (production), **Northflank / Render /
Fly.io** (managed PaaS).

## 1. Docker Compose

For dev, CI, and small single-node deployments.

```bash
git clone https://github.com/eden/eden.git
cd eden
cp .env.example .env

# Required env vars
# POSTGRES_HOST=postgres
# POSTGRES_PASSWORD=<32+ chars>
# JWT_SECRET=<32+ chars>
# ENCRYPTION_KEY=<Fernet key>
# OPENROUTER_API_KEY=<or one of MINIMAX_*, OPENAI_API_KEY, etc.>

docker compose -f docker/docker-compose.yml up -d
```

The compose stack ships:

| Service | Port | Notes |
|---------|------|-------|
| `postgres` | 5432 | + pgvector extension |
| `redis` | 6379 | hot-path cache + rate limiter |
| `qdrant` | 6333 | vector search for retrieval intel |
| `clickhouse` | 8123 | analytics + dashboard queries |
| `api` | 8000 | FastAPI |
| `portal` | 3000 | Next.js (optional) |

Visit `http://localhost:3000/signup` to create your first account.

### Optional profiles

```bash
# Streaming (Redpanda + ksqlDB)
docker compose -f docker/docker-compose.yml --profile streaming up -d

# gRPC server (port 50051)
docker compose -f docker/docker-compose.yml --profile grpc up -d

# Edge fanout (Ably / Cloudflare)
docker compose -f docker/docker-compose.yml --profile edge up -d
```

## 2. Kubernetes (Helm)

For production multi-node deployments.

```bash
helm repo add eden https://charts.eden.dev
helm repo update

helm install eden eden/eden \
  --namespace eden \
  --create-namespace \
  --values values.yaml
```

`values.yaml`:

```yaml
api:
  replicaCount: 3
  image: eden/api:1.7.0
  resources:
    requests: { cpu: 500m, memory: 512Mi }
    limits:   { cpu: 2,    memory: 2Gi }
  env:
    POSTGRES_HOST: eden-postgres
    POSTGRES_PASSWORD: <from-secret>
    JWT_SECRET:        <from-secret>
    ENCRYPTION_KEY:    <from-secret>

postgres:
  enabled: true
  storageClass: gp3
  size: 100Gi
  backup:
    enabled: true
    schedule: "0 3 * * *"
    retention: 30

qdrant:
  enabled: true
  persistence:
    size: 50Gi

ingress:
  enabled: true
  className: nginx
  hosts:
    - host: eden.your-domain.com
      paths: ["/api"]
  tls:
    - secretName: eden-tls
      hosts: [eden.your-domain.com]
```

## 3. Managed PaaS

The simplest path is to deploy to Northflank, Render, or Fly.io. The
repo includes ready-made manifests:

```bash
# Northflank
northflank.yml                    # already in the repo root

# Render
render.yaml                       # already in the repo root

# Fly.io
fly.toml                          # already in the repo root
```

### Northflank (recommended)

```bash
# Install the CLI
npm install -g @northflank/cli

# Login
northflank login

# Create the project
northflank create project eden --region us-central

# Deploy
northflank deploy --project eden --service eden-api
```

The `northflank.yml` declares:

- `eden-api` (the FastAPI service)
- `eden-portal` (the Next.js service)
- `eden-postgres` (the Postgres addon; if your account can't add
  addons, swap for Neon / Supabase — see the
  [Neon cutover notes](eden_neon_cutover_jun17_2026))
- `eden-jobs-runner` (background worker)
- `eden-jobs-cron` (scheduled jobs)

## 4. Environment variables

The full list is in [Environment variables](/reference/environment-variables).
The minimum required set:

```bash
POSTGRES_HOST=...
POSTGRES_PORT=5432
POSTGRES_DB=eden
POSTGRES_USER=eden
POSTGRES_PASSWORD=...           # 32+ chars

JWT_SECRET=...                  # 32+ chars
ENCRYPTION_KEY=...              # Fernet (cryptography.fernet.generate_key)

OPENROUTER_API_KEY=...          # OR one of MINIMAX_*, OPENAI_API_KEY, etc.

APP_BASE_URL=https://your-domain.com
CORS_ORIGINS=https://your-domain.com
```

## 5. Migrations

Alembic migrations live in `src/eden/db_migrations/versions/`. Run
them as a one-shot job (Kubernetes Job, Northflank job, or `docker
compose run --rm api alembic upgrade head`).

## 6. Backups

`docker/postgres/backup.sh` runs `pg_dump` and uploads to S3. Run
via cron:

```bash
# /etc/cron.d/eden-backup
0 3 * * * root /opt/eden/scripts/backup.sh >> /var/log/eden-backup.log 2>&1
```

The Helm chart includes a `CronJob` for this — `backup.enabled=true`.

## 7. Disaster recovery drill

Quarterly:

```bash
scripts/dr_drill.sh
```

Restores the latest backup into a fresh DB, runs a smoke query
(`SELECT COUNT(*) FROM telemetry_events`), and writes a JSON
report. See the runbook for the full checklist.

## 8. Observability

The platform itself emits OpenTelemetry-compatible traces. Point
your collector at `:4317` (gRPC) or `:4318` (HTTP) to scrape them.

Eden's `/health` endpoint returns:

```json
{
  "status": "healthy",
  "components": {
    "postgres": "connected",
    "redis": "connected",
    "qdrant": "connected",
    "clickhouse": "connected"
  },
  "version": "1.7.0",
  "uptime_seconds": 12345
}
```

Wire this into your load balancer's health check.

## 9. Production checklist

Before flipping DNS:

- [ ] `JWT_SECRET` and `ENCRYPTION_KEY` are unique to this env
- [ ] Postgres backups are running and tested (`scripts/dr_drill.sh`)
- [ ] `CORS_ORIGINS` matches the portal's exact origin
- [ ] `APP_BASE_URL` is the public URL (used in emails)
- [ ] TLS is terminated at the ingress
- [ ] `/health` returns `healthy` from outside the cluster
- [ ] Sentry / Datadog / your APM is wired to the API's OTel endpoint
- [ ] PagerDuty / Opsgenie has the on-call runbook URL
- [ ] You can roll back to the previous image tag