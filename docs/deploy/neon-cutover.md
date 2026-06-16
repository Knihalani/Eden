# Eden — Neon Cutover Runbook

**Audience:** Eden operator running the database migration from the (broken) Northflank Postgres addon to **Neon Scale** (us-east-2 Ohio).

**Phase:** 8 of the Postgres + Compression plan (June 2026 research).

**Time required:** 30 min of operator time + 5 days of parallel-run observation.

---

## 0. Why

The Northflank-managed Postgres addon (`eden-postgres`) is blocked: the Northflank API does not expose the internal hostname for sandbox addons, and `externalAccessEnabled: true` silently no-ops. We migrated the database to Neon Scale — better branching (per-PR preview DBs), 99.95% SLA, 30-day PITR, HIPAA-ready, and the TimescaleDB / pgvector / pg_partman extensions are all in the allowlist.

The plan + the code are committed on `main`. This runbook is the operator-facing checklist for the cutover itself.

---

## 1. Day 0 — Provision Neon

1. Open <https://console.neon.tech> and create a new project:
   - **Region:** US East (Ohio) — `us-east-2`. Avoid multi-region on the free tier; pick the single region closest to your backend.
   - **Postgres version:** 16 (matches what was on Northflank).
   - **Plan:** Scale ($0.222/CU-hr + $0.35/GB-mo).
2. From the Neon dashboard, copy the **pooled connection string** for the `eden` database. It looks like:
   ```
   postgresql://eden:<password>@ep-xxx-yyy.us-east-2.aws.neon.tech/eden?sslmode=require
   ```
3. Enable the extensions your migrations need. In the Neon SQL editor (or via `psql`):
   ```sql
   CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
   CREATE EXTENSION IF NOT EXISTS vector;
   CREATE EXTENSION IF NOT EXISTS timescaledb;       -- Phase 4 + 5
   CREATE EXTENSION IF NOT EXISTS pg_partman;        -- if not already
   ```
   The remaining extensions (pg_cron, pgstattuple, pg_prewarm, etc.) are usually pre-installed; verify by running `\dx` in `psql`.
4. Add the connection string + the individual fields to your **Northflank** `eden-required` secret group. The env vars the manifest expects are:
   - `POSTGRES_HOST` — e.g. `ep-xxx-yyy.us-east-2.aws.neon.tech`
   - `POSTGRES_PORT` — `5432`
   - `POSTGRES_DB` — `eden`
   - `POSTGRES_USER` — `eden`
   - `POSTGRES_PASSWORD` — the password from the Neon connection string
   - `POSTGRES_SSLMODE` — `require` (Neon rejects plain-text connections)
   - `POSTGRES_CHANNEL_BINDING` — `require` (Neon recommendation)
   - `POSTGRES_ENDPOINT_ID` — the `ep-xxx-yyy` portion of the host
5. Also add the **B2 cold-tier secrets** (Phase 6) to the same group:
   - `B2_ENDPOINT_URL` — e.g. `https://s3.us-west-001.backblazeb2.com`
   - `B2_COLD_BUCKET` — e.g. `eden-cold`
   - `B2_ACCESS_KEY_ID` / `B2_SECRET_ACCESS_KEY` — from a B2 application key with `listFiles`, `readFiles`, `writeFiles`, `deleteFiles` on the bucket

## 2. Day 0 — Apply the migrations to Neon

The code on `main` includes 6 new migrations (`030`–`035`); the first three (BRIN, LZ4 TOAST, zstd columns) are non-destructive and run in seconds. The last three (Timescale hypertables) take minutes per table.

```bash
# From the eden repo root on your dev machine
export POSTGRES_HOST=ep-xxx-yyy.us-east-2.aws.neon.tech
export POSTGRES_PORT=5432
export POSTGRES_DB=eden
export POSTGRES_USER=eden
export POSTGRES_PASSWORD=<from-neon-console>
export POSTGRES_SSLMODE=require

# 1. Apply all 30+ migrations to the new DB. Expected output: many
#    "running upgrade" lines, ending with the head revision.
alembic upgrade head

# 2. Verify the new BRIN indexes exist.
psql "$DATABASE_URL" -c "\di+ idx_brin_*"
# Expect 4 rows (usage_events, telemetry_events, judge_scores,
# retrieval_logs).

# 3. Verify the Timescale hypertables.
psql "$DATABASE_URL" -c "SELECT hypertable_name FROM timescaledb_information.hypertables;"
# Expect: telemetry_events, judge_scores.

# 4. Verify the BYTEA columns.
psql "$DATABASE_URL" -c "\d telemetry_events" | grep _zstd
# Expect: request_body_zstd, response_body_zstd.

# 5. Verify the LZ4 default.
psql "$DATABASE_URL" -c "SHOW default_toast_compression;"
# Expect: lz4.
```

If any of these fail, **do not cut over**. Fix the migration first, then re-run.

## 3. Day 1–5 — Parallel run

The goal is to keep the Northflank addon (now read-only) as the system of record while we validate that the new Neon DB serves real traffic correctly.

1. **Stop the API writing to Northflank.** Scale the `eden-api` service to 0 replicas on Northflank. The `eden-worker` and `eden-cron` keep running and continue writing to Northflank Postgres.
2. **Mirror rows Northflank → Neon.** Two options:
   - **Logical replication** (preferred): on the Northflank addon, run `CREATE PUBLICATION eden_pub FOR ALL TABLES;` and on Neon, `CREATE SUBSCRIPTION eden_sub CONNECTION '…' PUBLICATION eden_pub;`. Verify replication lag with `SELECT now() - pg_last_xact_replay_timestamp();` — must stay < 5 s.
   - **`pg_dump | psql` fallback:** every 5 min, dump the Northflank DB with `pg_dump --schema-only` plus incremental row dumps; restore into Neon. (Slower; acceptable for staging but not prod.)
3. **Point a separate test API at Neon.** Deploy a separate Northflank service (or a Heroku / Fly.io instance) with the same image, the same code, but the Neon connection string. Run a smoke-test suite against it: login, signup, 2FA, the 23 cat endpoints, the agent push endpoint, the trace view.
4. **Run the backfill for zstd payloads.** Once the test API is stable, run:
   ```bash
   uv run python scripts/backfill_zstd_payloads.py \
       --pg-url "$NEON_DSN" \
       --batch-size 1000 \
       --max-batches 100000 \
       --report-only
   ```
   The first run should show a non-zero pending count. Then run without `--report-only` to compress. The script is idempotent — you can re-run if it gets interrupted.

## 4. Day 5 — Cutover

1. Stop the worker and cron (scale to 0 replicas on Northflank). API traffic should already be off since Day 1.
2. Wait for logical replication lag to hit 0 (`SELECT now() - pg_last_xact_replay_timestamp() = '00:00:00'`).
3. In the Northflank console, set the `eden-required` secret values to the Neon credentials (you may have already done this in Step 1 — that's fine; the secrets are already pointing at Neon).
4. Re-deploy the API, worker, and cron services on Northflank. The new pods will connect to Neon via the secret group.
5. Smoke test:
   - `GET /health` on all 3 services → 200.
   - `POST /auth/login` via the portal → 200, session cookie set.
   - `GET /orgs/{org}/usage/summary` → 200.
   - `GET /orgs/{org}/agents` → 200.
   - `POST /orgs/{org}/telemetry/ingest` with a known payload → 200.
   - `GET /orgs/{org}/traces/{trace_id}` → returns the payload you just ingested.
6. Verify the lossless guarantee: the trace returned by the API must match the payload you sent byte-for-byte. This is the strict-lossless contract of the zstd-dict compression; if the bytes differ, **roll back**.

## 5. Day 6–14 — Decommission

1. Leave the Northflank addon running read-only for 14 days as a safety net. (`ALTER SYSTEM SET default_transaction_read_only = on;` then `SELECT pg_reload_conf();` on the addon.)
2. After 14 days with no rollback needed, drop the addon in the Northflank console.
3. Remove the `eden-postgres` references from the runbooks and on-call playbooks.

## 6. Rollback plan

If anything goes wrong within 14 days of the cutover:

1. Re-deploy the API, worker, and cron services on Northflank with the original `eden-postgres` addon (you have the old connection details in git history).
2. Northflank is at schema revision 035 (kept in sync throughout the parallel run); no migration needed.
3. Re-enable writes on the addon (`ALTER SYSTEM RESET default_transaction_read_only;` then `SELECT pg_reload_conf();`).
4. Verify the API, worker, and cron are working from Northflank.
5. The data on Neon is preserved for 30 days (PITR) — you can restore from a Neon snapshot if needed for forensics.

If Neon fails after 14 days, restore from a Neon PITR snapshot (30-day PITR included on Neon Scale). The data flow direction reverses: bring Northflank back up, restore the snapshot into Neon, then mirror forward.

## 7. What to monitor post-cutover

- **`/health` latency p99** — should stay < 100 ms. Neon adds ~10-20 ms vs the in-VPC Northflank addon; p99 > 200 ms is a red flag.
- **Postgres CPU** — Neon's "Always on" Compute plan bills per CU-hour; if you see sustained > 80% CPU, bump to the next compute tier.
- **Storage growth rate** — should drop 60-80% within a week as the LZ4 TOAST and zstd-dict compressions take effect. Check `SELECT pg_size_pretty(pg_database_size(current_database()));` weekly.
- **Compression ratio on `usage_events` (Phase 4)** — should hit 90-97% after the Timescale compression policy runs (30 days after migration 034 ships). Run the verification query from migration 034's docstring.
- **B2 cold-tier growth** — should start non-zero on Day 8 (when the first 7-day-old telemetry archives), growing ~5-10 GB / week at current rates. Monitor `aws s3 ls s3://eden-cold/cold/telemetry_events/ --recursive --summarize | tail -5` weekly.

## 8. References

- **Plan file:** `clever-snuggling-giraffe.md` in `~/.claude/plans/` (the full Phase 0-9 design with all 6 migrations + 5 compression techniques)
- **Research:** `eden_postgres_compression_research_2026_06.md` in memory (the source-of-truth picks: Neon Scale < 1 TB, Aurora I/O-Opt 1-10 TB, Aurora Limitless > 10 TB)
- **Neon docs:** <https://neon.tech/docs>
- **TimescaleDB on Neon:** <https://neon.tech/docs/extensions/timescaledb>
- **Postgres + Compression research output:** the research agents' full reports (held in conversation context)
