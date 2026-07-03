# API down runbook

> **Owner:** Platform · **Last reviewed:** 2026-07-02

Bring the Eden backend (FastAPI on Northflank) back when the API is returning 5xx or not responding.

## When to use

* `/health` returns `status != "healthy"` for >2 min
* Northflank dashboard shows the `eden-api` deployment in a crash-loop
* Customers report 502 / 504 from the portal

## First 60 seconds — triage

1. **Check the health endpoint**:
   ```bash
   curl -fsS https://api.edenobservability.com/health | jq
   ```
   * `postgres: "connected"` + `qdrant: "connected"` + `redis: "connected"` → infra is fine; the bug is in app code (read step 4).
   * Any component `disconnected` → jump to the matching sub-runbook (postgres-restore, clickhouse-failover).

2. **Check Northflank**:
   * Dashboard → project `eden-staging-us-central` (prod is `eden-prod`).
   * `Logs` tab → tail the last 200 lines. Look for `Traceback` or repeated 5xx.
   * `Runtime` tab → check `Replicas` count, `CPU`, `Memory`. A spike to 100% CPU with no traffic = stuck worker.

3. **Check if the build is broken**:
   * `Deployments` tab → latest deployment SHA matches `origin/main` HEAD.
   * If they differ: someone rolled back. Confirm with the team before re-deploying.

## First 15 minutes — remediate

4. **Re-deploy the last good SHA**:
   ```bash
   # From the repo root
   git log --oneline -1 origin/main
   # Re-trigger build
   curl -X POST https://api.northflank.com/v1/projects/.../services/.../deployments \
     -H "Authorization: Bearer $NF_TOKEN" \
     -d "{\"commitSha\": \"$SHA\"}"
   ```

5. **Roll back to the previous deployment** (if the latest is bad):
   * Northflank → `eden-api` → `Deployments` → pick the previous green deployment → `Redeploy`.

6. **Restart the service** (clear any stuck workers):
   * Northflank → `eden-api` → `Runtime` → `Restart`.

7. **Clear the Redis dedup cache** (only if hook dedup is the cause):
   ```bash
   redis-cli -u $REDIS_URL --scan --pattern "eden:dedup:*" | xargs redis-cli -u $REDIS_URL del
   ```
   * This is a cache flush, NOT data loss. Hook events are persisted to Postgres.

## After — communicate

8. **Status page**: post a notice on `status.edenobservability.com` (Resend → `ops@eden`).
9. **Customer comms**: if the outage was >5 min, email affected orgs via the audit log table — `SELECT email FROM users WHERE org_id IN (... affected orgs ...)`.

## Post-mortem

* Open an incident in Linear (`INC-YYYY-MM-DD`).
* File a writeup in `docs/postmortems/INC-YYYY-MM-DD.md` within 48h.
* Add a regression test if applicable (e.g. the bug only fires after N requests).
