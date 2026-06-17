-- June 2026: Content-addressed message dedup (Phase A: Laminar 20x trick).
--
-- Background
-- ──────────
-- Every LLM span's ``request_body`` contains the full messages array sent
-- to the model. In a k-turn agent run, span 1 stores [m0], span 2 stores
-- [m0,m1], ..., span k stores [m0..m{k-1}]. Total message-storage cost
-- across a trace is k(k+1)/2 ≈ O(k²).
--
-- Laminar's May 2026 blog post ("How Laminar compresses agent traces by
-- 20x") describes the fix: hash every message via canonical JSON, store
-- each unique (trace_id, msg_hash) once, and let spans store a flat array
-- of 32-byte hashes. Reconstruction happens at read time via a JOIN.
--
-- Eden replicates this here. We choose trace-scoped dedup (per Laminar's
-- "Trace-scoped, not project-scoped") so 95% of the value comes through
-- without cross-trace coordination costs.
--
-- Schema
-- ──────
-- * ``trace_messages`` — one row per (trace_id, msg_hash). PK enforces
--   uniqueness. ``content`` is JSONB so message payloads remain queryable
--   by GIN index if needed (e.g. for future full-text search).
-- * ``request_message_hashes`` / ``response_message_hashes`` on
--   ``telemetry_events`` — array columns holding the dedup keys per span.
--   Nullable: spans ingested before this migration have NULL here, and
--   the trace tree view falls back to the raw JSONB columns during the
--   30-day burn-in (same pattern as the zstd migration 033).
--
-- ClickHouse mirror lives in a follow-up migration; the source of truth
-- for reconstruction is Postgres.

CREATE TABLE IF NOT EXISTS trace_messages (
    trace_id        TEXT NOT NULL,
    msg_hash        TEXT NOT NULL,             -- hex SHA-256 of canonical-JSON(msg)
    role            TEXT NOT NULL
        CHECK (role IN ('system', 'user', 'assistant', 'tool', 'function')),
    content         JSONB NOT NULL,
    first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (trace_id, msg_hash)
);

-- Per-trace lookup is the hot path for reconstruction; the PK already
-- gives (trace_id, msg_hash) ordering, but an explicit index on trace_id
-- alone helps with "delete all messages for a trace" cleanup and with
-- count-by-trace aggregate queries.
CREATE INDEX IF NOT EXISTS idx_trace_messages_trace_id
    ON trace_messages(trace_id);

-- Hash columns on telemetry_events. These are added idempotently so
-- re-running this migration is safe. Both default NULL so existing rows
-- are unaffected.
ALTER TABLE telemetry_events
    ADD COLUMN IF NOT EXISTS request_message_hashes  TEXT[] DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS response_message_hashes TEXT[] DEFAULT NULL;

-- GIN index on the trace_messages content so future full-text search
-- (Phase B: Typesense / PG FTS) can also fall back to GIN. Cheap to
-- add now, expensive to backfill later.
CREATE INDEX IF NOT EXISTS idx_trace_messages_content_gin
    ON trace_messages USING GIN (content);

COMMENT ON TABLE trace_messages IS
    'Content-addressed dedup of LLM messages within a single trace. '
    'Same (trace_id, msg_hash) means byte-identical message under canonical JSON. '
    'Spans store arrays of msg_hash on telemetry_events.request_message_hashes; '
    'reconstruction happens at read time via JOIN.';
COMMENT ON COLUMN trace_messages.msg_hash IS
    '64-char hex SHA-256 of canonical-JSON(message). sort_keys=True, ensure_ascii=False, separators=(",", ":").';