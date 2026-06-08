-- Migration 019: Insight persistence + closed-loop correlation
--
-- Closes §3.2 of the June 2026 roadmap (Insights → KB → better envs
-- closed-loop measurement). Adds the two tables that the
-- ``correlation_report()`` query in
-- ``src/eden/insights/correlation.py`` joins against:
--
--   insights  — one row per Insight produced by the detectors
--   kb_insight_writes — one row per successful KB upsert
--
-- The join to ``jobs`` (via ``affected_trace_ids`` → ``jobs.request
-- ->>'trace_id'``) lets us measure the gold-tier uplift in the
-- window after an insight is written to the KB.
--
-- Idempotent: safe to re-run.

BEGIN;

CREATE TABLE IF NOT EXISTS insights (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    insight_id VARCHAR(64) UNIQUE NOT NULL,
    organization_id UUID,
    detector VARCHAR(64) NOT NULL,
    severity VARCHAR(16) NOT NULL,
    confidence NUMERIC(4, 3) NOT NULL,
    summary TEXT NOT NULL,
    recommended_action TEXT,
    affected_trace_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE insights IS
    'Persistent store for Insights produced by the detector registry. One row per Insight; idempotent on insight_id.';
COMMENT ON COLUMN insights.affected_trace_ids IS
    'JSON array of trace ids this insight refers to. Used to join back to jobs.outcome_tier for the closed-loop correlation report.';

CREATE INDEX IF NOT EXISTS idx_insights_org_created
    ON insights (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_insights_detector
    ON insights (detector);
CREATE INDEX IF NOT EXISTS idx_insights_severity
    ON insights (severity);

CREATE TABLE IF NOT EXISTS kb_insight_writes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    insight_id VARCHAR(64) NOT NULL,
    entity_id UUID NOT NULL,
    written_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE kb_insight_writes IS
    'Append-only log of successful KB writes from the InsightsService. One row per (insight, entity) pair; the correlation report groups by week to measure gold-tier uplift post-write.';

CREATE INDEX IF NOT EXISTS idx_kb_insight_writes_insight
    ON kb_insight_writes (insight_id, written_at DESC);
CREATE INDEX IF NOT EXISTS idx_kb_insight_writes_written_at
    ON kb_insight_writes (written_at DESC);

COMMIT;
