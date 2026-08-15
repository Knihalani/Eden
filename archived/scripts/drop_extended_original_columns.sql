-- Drop the 6 extended JSONB columns from telemetry_events.
-- This is the deferred Phase B2 drop (see migration 039's docstring
-- for the full prerequisites; mirrors scripts/drop_original_payload_columns.sql).
--
-- WHEN TO RUN
--   After ALL of the following are true:
--     (a) Every writer populates the 6 *_zstd columns
--         (verify: src/eden/observability/telemetry_collector.py
--         _route_postgres writes reasoning_zstd, tool_calls_full_zstd,
--         tool_results_zstd, payload_zstd, metrics_zstd, attributes_zstd)
--     (b) Every reader of the original 6 JSONB columns reads *_zstd first
--         (verify: telemetry_collector._read_payload falls back to JSONB
--         only on zstd error)
--     (c) ≥ 30 days of production traffic on the new path
--     (d) Zero open support tickets that reference the original 6 columns
--     (e) scripts/backfill_extended_zstd.py --report-only shows 0 pending
--
-- HOW TO RUN
--   psql "$DATABASE_URL" -f scripts/drop_extended_original_columns.sql
--
-- ROLLBACK
--   The original columns held full-fidelity JSON. Once dropped, the
--   data is gone. A PITR restore (Neon Scale has 30-day PITR) is
--   the only recovery path.

BEGIN;

ALTER TABLE telemetry_events DROP COLUMN IF EXISTS reasoning;
ALTER TABLE telemetry_events DROP COLUMN IF EXISTS tool_calls_full;
ALTER TABLE telemetry_events DROP COLUMN IF EXISTS tool_results;
ALTER TABLE telemetry_events DROP COLUMN IF EXISTS payload;
ALTER TABLE telemetry_events DROP COLUMN IF EXISTS metrics;
ALTER TABLE telemetry_events DROP COLUMN IF EXISTS attributes;

-- Reclaim space. autovacuum will eventually return the pages to the
-- OS, but a manual VACUUM FULL (or pg_squeeze) reclaims faster.
-- VACUUM FULL takes an ACCESS EXCLUSIVE lock; run during a quiet
-- window on production.
-- VACUUM FULL telemetry_events;

COMMIT;
