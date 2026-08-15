-- Drop the original JSONB request_body / response_body columns from
-- telemetry_events. This is the deferred Phase 9 of the Postgres +
-- Compression plan (see migration 033's docstring for the full
-- prerequisites).
--
-- WHEN TO RUN
--   After ALL of the following are true:
--     (a) Every writer populates request_body_zstd / response_body_zstd
--         (verify: eden.storage.compression.compress_jsonb is wired
--         into TelemetryCollector._route_postgres)
--     (b) Every reader of request_body / response_body reads *_zstd first
--         (verify: get_trace_tree has the fallback path removed and
--         response_body_zstd IS NULL is zero in production logs)
--     (c) ≥ 30 days of production traffic on the new path
--     (d) Zero open support tickets that reference the old columns
--     (e) scripts/backfill_zstd_payloads.py --report-only shows 0 pending
--
-- HOW TO RUN
--   psql "$DATABASE_URL" -f scripts/drop_original_payload_columns.sql
--   or run the commands inline in the Neon SQL editor.
--
-- ROLLBACK (within the same transaction — this is destructive)
--   The original columns held full-fidelity JSON. Once dropped, the
--   data is gone. A PITR restore (Neon Scale has 30-day PITR) is
--   the only recovery path.

BEGIN;

ALTER TABLE telemetry_events DROP COLUMN IF EXISTS response_body;
ALTER TABLE telemetry_events DROP COLUMN IF EXISTS request_body;

-- Reclaim space. autovacuum will eventually return the pages to the
-- OS, but a manual VACUUM FULL (or pg_squeeze) reclaims faster.
-- VACUUM FULL takes an ACCESS EXCLUSIVE lock; run during a quiet
-- window on production. Skip if downtime is unacceptable; the
-- storage will be reclaimed over the next autovacuum cycle anyway.
-- VACUUM FULL telemetry_events;

COMMIT;
