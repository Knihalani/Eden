-- Phase 3: Agent uploads + sim/test runs.
--
-- One row per upload (a tarball push from `eden agent push <dir>`).
-- Multiple uploads per (org, agent) are kept; the most-recent is the
-- "active" one. Older rows stay for history (the portal can render
-- past runs against the code that was active at the time).
--
-- The `eval_yaml` JSONB is the parsed eden-sim-eval.yaml so the
-- portal can render the scenario list without re-reading the
-- filesystem on every page load.

CREATE TABLE agent_uploads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL,
    upload_version INT NOT NULL DEFAULT 1,
    code_path TEXT NOT NULL,
    entry_point TEXT,
    framework TEXT,
    language TEXT,
    file_count INT,
    total_bytes BIGINT,
    eval_yaml JSONB,
    uploaded_by UUID REFERENCES users(id),
    uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    CONSTRAINT uq_agent_uploads_org_agent_ver UNIQUE (org_id, agent_id, upload_version)
);

-- Common query paths
CREATE INDEX idx_agent_uploads_org_agent ON agent_uploads (org_id, agent_id);
CREATE INDEX idx_agent_uploads_active
    ON agent_uploads (org_id, agent_id, is_active)
    WHERE is_active = TRUE;
CREATE INDEX idx_agent_uploads_recent
    ON agent_uploads (org_id, agent_id, uploaded_at DESC);

-- Auto-update ``is_active`` so a new upload supersedes the prior
-- active one within the same (org, agent) pair. The trigger fires
-- AFTER INSERT of the new row; we flip the OLD active rows to FALSE
-- so the (org, agent) pair has at most one active upload.
CREATE OR REPLACE FUNCTION agent_uploads_supersede()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.is_active = TRUE THEN
        UPDATE agent_uploads
        SET is_active = FALSE
        WHERE org_id = NEW.org_id
          AND agent_id = NEW.agent_id
          AND id <> NEW.id
          AND is_active = TRUE;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_agent_uploads_supersede
AFTER INSERT ON agent_uploads
FOR EACH ROW
EXECUTE FUNCTION agent_uploads_supersede();


-- ============================================================================
-- SIM RUNS — one row per server-side execution of an upload
-- ============================================================================

CREATE TABLE sim_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL,
    upload_id UUID NOT NULL REFERENCES agent_uploads(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id),
    kind TEXT NOT NULL,                        -- 'sim' | 'test'
    status TEXT NOT NULL DEFAULT 'pending',    -- pending | running | passed | failed | error
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMPTZ,
    duration_ms INT,
    results JSONB,
    error TEXT,
    runner_kind TEXT,                         -- 'firecracker' | 'subprocess'
    CONSTRAINT chk_sim_runs_status CHECK (status IN ('pending','running','passed','failed','error')),
    CONSTRAINT chk_sim_runs_kind CHECK (kind IN ('sim','test'))
);

CREATE INDEX idx_sim_runs_agent
    ON sim_runs (org_id, agent_id, started_at DESC);
CREATE INDEX idx_sim_runs_upload
    ON sim_runs (upload_id, started_at DESC);
CREATE INDEX idx_sim_runs_pending
    ON sim_runs (org_id, status)
    WHERE status IN ('pending','running');
CREATE INDEX idx_sim_runs_status_kind
    ON sim_runs (org_id, agent_id, kind, started_at DESC);
