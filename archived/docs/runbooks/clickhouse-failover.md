# ClickHouse failover runbook

> **Owner:** Data platform · **Last reviewed:** 2026-06-24

Promote a ClickHouse replica to primary when the primary is unhealthy. Used during the rare event of primary-node failure or maintenance.

## When to use

* ClickHouse primary is unreachable for >10 minutes
* Replication lag exceeds 1 hour
* Scheduled primary maintenance (monthly OS patching)

## Prerequisites

* `clickhouse-client` on PATH
* `CLICKHOUSE_REPLICA_URL` env var (read replica endpoint)
* `CLICKHOUSE_PRIMARY_URL` env var (current primary — may be down)

## Steps

1. **Verify primary is down** (don't proceed if it's a transient blip):

   ```bash
   timeout 5 clickhouse-client --host "$CLICKHOUSE_PRIMARY_URL" --query "SELECT 1" 2>&1
   ```

   Expected: connection refused or timeout. If SELECT 1 succeeds, abort — primary is fine.

2. **Check replica lag** (must be <5 min for safe failover):

   ```bash
   clickhouse-client --host "$CLICKHOUSE_REPLICA_URL" \
     --query "SELECT max(timestamp) FROM eden.telemetry_events"
   ```

   Expected: within 5 min of NOW().

3. **Promote replica to primary**:

   ```bash
   clickhouse-client --host "$CLICKHOUSE_REPLICA_URL" \
     --query "SYSTEM REPLICA eden.replica1 PROMOTE"
   ```

4. **Update DNS / env vars**:

   ```bash
   # On each Eden API instance:
   systemctl edit eden-api   # set CLICKHOUSE_PRIMARY_URL=<replica>
   systemctl restart eden-api
   ```

5. **Smoke test**:

   ```bash
   curl -s "http://localhost:8000/v1/internal/health/clickhouse" | jq .status
   ```

   Expected: `"healthy"`.

6. **Trigger a manual rollup** to verify writes:

   ```bash
   curl -X POST "http://localhost:8000/orgs/<org>/intelligence/columnar/rollups" \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer $EDEN_API_TOKEN" \
     -d '{"table": "telemetry_events", "granularity": "day", "window_start": "<24h-ago>", "window_end": "<now>"}'
   ```

## Rollback

If promotion fails or replication lag was >5 min (data loss risk), do NOT promote. Instead:
* Page the on-call DBA
* Restore from S3 backup (see `postgres-restore.md` for the analogous Postgres procedure)

## Verification

* `curl /v1/internal/health/clickhouse` → `"healthy"`
* Manual rollup succeeds within 5s
* No "ClickHouse unavailable" warning in `eden.columnar._common` logs

## Related

* `docs/runbooks/postgres-restore.md`
* `docs/docs/operations/disaster-recovery-drill.md`