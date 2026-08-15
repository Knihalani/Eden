# Northflank production deploy checklist

> **Owner:** Platform · **Last reviewed:** 2026-07-13

Pre-flight and post-deploy gates for promoting `eden-api` and `eden-portal` to production on Northflank.

## Pre-deploy (staging green)

- [ ] `origin/main` CI green: backend (lint + test + build), portal, sdk-ts
- [ ] `uv lock --check` and `alembic upgrade head` pass on staging DB
- [ ] Coverage gate (`--cov-fail-under=55`) passing in backend CI
- [ ] No open P0/P1 incidents on the status page
- [ ] Migration reviewed against [migration-matrix.md](./ops/migration-matrix.md)
- [ ] Secrets rotated in the last 90 days OR this deploy does not touch auth/billing paths
- [ ] `REDIS_URL`, `DATABASE_URL`, `JWT_SECRET`, `ENCRYPTION_KEY` present in Northflank secrets (prod project)

## Deploy

1. **Tag the release** (optional but recommended):
   ```bash
   git tag -a v0.1.0-$(date +%Y%m%d) -m "prod deploy"
   git push origin --tags
   ```

2. **Northflank → `eden-prod` → `eden-api`**:
   * Confirm commit SHA matches the intended `main` HEAD
   * Trigger deploy; watch build logs for `alembic upgrade head` success
   * Wait for all replicas `Running` (typically 2–3 min)

3. **Northflank → `eden-prod` → `eden-portal`**:
   * Deploy the matching portal SHA (Vercel or Northflank static — follow project config)
   * Confirm `NEXT_PUBLIC_API_URL` points at prod API

## Post-deploy smoke (15 min)

- [ ] `GET /health` → `status: healthy`, postgres + redis connected
  ```bash
  curl -fsS https://api.edenobservability.com/health | jq
  ```
- [ ] Portal landing page loads (`/`)
- [ ] Clerk sign-in works (`/sign-in`)
- [ ] Authenticated dashboard loads (`/dashboard`)
- [ ] Trace ingest: SDK or `POST /v1/ingest/traces` returns 2xx
- [ ] Internal health (VPN/IP allowlist): `GET /v1/internal/health` returns 5 components
- [ ] No 5xx spike in Northflank logs (last 10 min)
- [ ] PagerDuty / Slack `#eden-ops` quiet

## Rollback triggers

Roll back immediately if any of:

* `/health` unhealthy for >2 min
* Error rate >5% for >5 min
* `alembic upgrade head` failed in build logs
* Customer-reported data loss or auth-wide outage

Rollback path: Northflank → previous green deployment → Redeploy. See [api-down.md](./runbooks/api-down.md) and [migration-failure.md](./runbooks/migration-failure.md).

## Sign-off

| Role | Name | Date | SHA |
|------|------|------|-----|
| Deployer | | | |
| Reviewer | | | |
