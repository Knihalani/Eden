# Migration failure runbook

> **Owner:** Platform · **Last reviewed:** 2026-07-13

Recover when `alembic upgrade head` fails during deploy or leaves the schema in a half-applied state.

## When to use

* Northflank deploy logs show `alembic upgrade head` exiting non-zero
* API pods crash-loop with `relation "…" does not exist` or `column "…" does not exist`
* `alembic current` shows a revision that does not match the running image's expected head
* A migration applied on staging but fails on prod with a constraint or extension error

## First 60 seconds — triage

1. **Read the migration error** (Northflank build logs or pod stdout):
   ```bash
   # From a shell with DATABASE_URL set
   uv run alembic upgrade head 2>&1 | tail -50
   ```
   Common classes:
   * `DuplicateTable` / `DuplicateColumn` — migration re-run on a partially applied DB
   * `UndefinedObject` — missing extension (`vector`, `timescaledb`)
   * `deadlock detected` — concurrent migration attempt; retry once
   * `down_revision` mismatch — branch drift between image and migration files

2. **Check current revision vs expected head**:
   ```bash
   uv run alembic current
   git show HEAD:migrations/versions/ | tail -5   # or src/eden/db_migrations/versions/
   uv run alembic heads
   ```

3. **Check API health** (may be down if schema is incompatible):
   ```bash
   curl -fsS https://api.edenobservability.com/health | jq
   ```

## First 15 minutes — remediate

4. **If the migration is idempotent-safe**, fix the SQL and re-run:
   * Prefer `IF NOT EXISTS` guards (see migration `075_hook_repetition_closed_loop.py` pattern).
   * Re-deploy the fixed SHA after CI passes.

5. **If the migration partially applied** (table exists but index missing):
   * Inspect `alembic_version` and the failing object's presence:
     ```sql
     SELECT version_num FROM alembic_version;
     \d+ <table_name>
     ```
   * Either complete the missing DDL manually **or** downgrade one step and re-upgrade (staging first).

6. **If downgrade is required**, follow [migration-rollback.md](./migration-rollback.md):
   ```bash
   DATABASE_URL=$EDEN_STAGING_DATABASE_URL uv run alembic downgrade -1
   # verify staging, then prod
   DATABASE_URL=$EDEN_PROD_DATABASE_URL uv run alembic downgrade -1
   ```

7. **If the app must stay up on an old schema**:
   * Roll back the API deployment to the previous green SHA (Northflank → Redeploy).
   * Do **not** leave a newer migration revision in Postgres with an older app image — that combination causes 5xx on every query touching the new columns.

## After — verify

8. **Re-run upgrade on staging**:
   ```bash
   DATABASE_URL=$EDEN_STAGING_DATABASE_URL uv run alembic upgrade head
   curl -fsS "$STAGING_BASE_URL/health" | jq .postgres
   ```

9. **Smoke-test critical paths**:
   * Login → dashboard load
   * `POST /v1/ingest/traces` with a test API key
   * Portal → Observability → trace list

10. **Update** `docs/ops/migration-matrix.md` if the migration's risk tier or rollback notes changed.

## Post-mortem

* Open `INC-YYYY-MM-DD` in Linear.
* File `docs/postmortems/INC-YYYY-MM-DD.md` within 48h.
* Add a regression test or idempotency guard in the migration if the failure was repeatable.
