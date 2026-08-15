# Postgres restore runbook

> **Owner:** Platform · **Last reviewed:** 2026-06-24

Restore a Postgres database from the S3 backup bucket into a fresh instance. Used during incident recovery (corrupted prod DB) or staging refresh.

## When to use

* Production Postgres data is corrupted or deleted
* Staging needs a recent snapshot of prod data
* DR drill (quarterly)

## Prerequisites

* `pg_restore` + `psql` on PATH
* `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` env vars set (or `aws sso login`)
* `DATABASE_URL` for the **target** instance (the new one)
* `BACKUP_BUCKET` env var = `eden-bronze` (prod) or `eden-bronze-staging`

## Steps

1. **List recent backups** (most-recent-first):

   ```bash
   aws s3api list-objects-v2 \
     --bucket "$BACKUP_BUCKET" \
     --prefix "postgres/prod/" \
     --query 'reverse(sort_by(Contents[?contains(Key, \`daily\`)] & Contents[?contains(Key, \`.dump\`)] , &LastModified))[:5].[Key, LastModified, Size]' \
     --output table
   ```

2. **Download the chosen dump**:

   ```bash
   aws s3 cp s3://$BACKUP_BUCKET/postgres/prod/daily/<date>.dump /tmp/restore.dump
   ```

3. **Create the target database** (skip if it already exists):

   ```bash
   psql "$DATABASE_URL" -c "CREATE DATABASE eden_new;"
   ```

4. **Restore** (custom format, parallel jobs = number of CPU cores):

   ```bash
   pg_restore \
     --dbname="$DATABASE_URL_NEW" \
     --no-owner \
     --no-privileges \
     --jobs=4 \
     --format=custom \
     /tmp/restore.dump
   ```

5. **Verify row counts** (per critical table):

   ```bash
   psql "$DATABASE_URL_NEW" -c "
     SELECT 'telemetry_events', count(*) FROM telemetry_events
     UNION ALL
     SELECT 'usage_events', count(*) FROM usage_events
     UNION ALL
     SELECT 'judge_scores', count(*) FROM judge_scores
     UNION ALL
     SELECT 'organizations', count(*) FROM organizations;
   "
   ```

6. **Smoke test the API** (read a known trace):

   ```bash
   curl -s "http://localhost:8000/v1/traces/<known-trace-id>" -H "X-Org-Id: smoke" | jq .status
   ```

7. **Cut over DNS / DATABASE_URL** to point at the restored instance.

## Rollback

If the restored data is missing rows or has inconsistencies, do NOT cut over. Investigate:
* Check `pg_stat_activity` for long-running queries that may have raced the restore
* Check the S3 backup's LastModified timestamp — was the backup pre-corruption?
* Run `pg_restore --list` on the dump file to verify schema

## Verification

* `psql` row counts match (within ±1% due to in-flight writes)
* `/v1/traces/<id>` returns 200 with the expected `trace_id`
* `/health` returns `{"postgres": "connected"}`

## Related

* `docs/runbooks/migration-rollback.md` — for rolling back the schema after a botched migration
* `docs/docs/operations/disaster-recovery-drill.md` — the quarterly DR drill procedure
* `docs/runbooks/clickhouse-failover.md` — ClickHouse counterpart