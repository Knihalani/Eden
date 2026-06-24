# Migration rollback runbook

> **Owner:** Platform · **Last reviewed:** 2026-06-24

Roll back a failed alembic migration using `alembic downgrade`. Used when a migration deploys but breaks production (e.g. fails to apply, breaks runtime queries, or has a logic bug).

## When to use

* Migration deployed to prod but `alembic upgrade head` failed halfway
* Migration succeeded but downstream services are throwing 5xx
* Need to re-deploy an older app version that expects the pre-migration schema

## Prerequisites

* `alembic` on PATH (installed via `pip install alembic` — already a dep)
* `DATABASE_URL` env var pointing at the prod DB
* `EDEN_REPO` checked out at the deploy SHA

## Steps

1. **Identify the offending migration**:

   ```bash
   alembic current
   ```

   Output looks like: `062_provider_routing (head)`

2. **Check the down_revision chain**:

   ```bash
   alembic history --rev-range=062:055
   ```

3. **Test the downgrade on staging FIRST**:

   ```bash
   DATABASE_URL=$EDEN_STAGING_DATABASE_URL alembic downgrade -1
   ```

   Wait 30 seconds, then:

   ```bash
   curl -s "$STAGING_BASE_URL/health" | jq .
   ```

   If staging breaks, ABORT — investigate the downgrade's incompatibility with the current app version.

4. **Run on prod**:

   ```bash
   DATABASE_URL=$EDEN_PROD_DATABASE_URL alembic downgrade -1
   ```

5. **Verify schema**:

   ```bash
   alembic current
   ```

   Should show the previous revision (e.g. `061_fine_tune_lineage`).

6. **Restart API instances** (some queries cache plans):

   ```bash
   for host in $EDEN_API_HOSTS; do
     ssh "$host" systemctl restart eden-api
   done
   ```

7. **Smoke test**:

   ```bash
   for endpoint in \
     "/v1/orgs/$ORG_ID/observability/traces" \
     "/v1/orgs/$ORG_ID/budget" \
     "/v1/internal/health"; do
     curl -sf "$PROD_BASE_URL$endpoint" -H "Authorization: Bearer $EDEN_API_TOKEN" > /dev/null \
       && echo "OK $endpoint" \
       || echo "FAIL $endpoint"
   done
   ```

## Critical-path migrations (cannot downgrade)

Per `docs/ops/migration-matrix.md`, these 5 migrations have `downgrade risk: hard` — they drop or alter hot-path columns. Downgrading requires coordinated app + DB rollback:

* **033** — drop_original_payload_columns
* **034** — timescale_telemetry
* **035** — timescale_judge_scores
* **039** — zstd_extended_drop
* **042** — usage_events_partitions

For these, do NOT downgrade. Instead:
1. Roll forward with a hotfix migration that adds the dropped columns back
2. Redeploy the old app version

## Verification

* `alembic current` shows the expected pre-rollback revision
* All smoke-test endpoints return 200
* No "relation does not exist" errors in the API logs (would indicate app + schema mismatch)

## Related

* `docs/ops/migration-matrix.md` — the per-migration downgrade risk table
* `docs/runbooks/postgres-restore.md`