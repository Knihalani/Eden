-- June 2026: NL signals (Phase Q — Plain English Signals).
--
-- Closes the Laminar "Plain English Signals" gap. The user
-- writes a plain-English signal definition ("LLM refusal rate
-- above 5% in the last 24 hours") and the backend compiles
-- it to a structured rule that the existing Cat 2 alerting
-- pipeline can consume.
--
-- The table stores the user's NL description + the
-- compiled rule (JSONB). The cluster_id field links
-- semantically similar signals so the operator can
-- deduplicate ("you already have a signal that says this").

CREATE TABLE IF NOT EXISTS nl_signals (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    description     TEXT NOT NULL,
    -- The compiled rule (metric, op, threshold, window, scope,
    -- keywords). JSONB so we can evolve the schema without
    -- migrations.
    rule            JSONB NOT NULL DEFAULT '{}'::jsonb,
    enabled         BOOLEAN NOT NULL DEFAULT TRUE,
    created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    -- Optional: the cluster this signal belongs to (set by
    -- SignalClusterer).
    cluster_id      TEXT,
    -- Lightweight usage tracking.
    last_matched_at TIMESTAMPTZ,
    match_count     INT NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Per-org "recent signals" view.
CREATE INDEX IF NOT EXISTS idx_nl_signals_org_created
    ON nl_signals (org_id, created_at DESC);

-- Per-cluster view (operator dashboard "find duplicates").
CREATE INDEX IF NOT EXISTS idx_nl_signals_cluster
    ON nl_signals (org_id, cluster_id, created_at DESC)
    WHERE cluster_id IS NOT NULL;

-- Trigger: keep ``updated_at`` fresh.
CREATE OR REPLACE FUNCTION nl_signals_touch_updated() RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_nl_signals_touch_updated ON nl_signals;
CREATE TRIGGER trg_nl_signals_touch_updated
    BEFORE UPDATE ON nl_signals
    FOR EACH ROW EXECUTE FUNCTION nl_signals_touch_updated();


COMMENT ON TABLE nl_signals IS
    'Phase Q: plain-English signal definitions. NL → compiled rule '
    'via eden.services.cat2_intel.signals.compile_signal.';
