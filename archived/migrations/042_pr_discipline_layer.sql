-- 042_pr_discipline_layer — PR-discipline tables (Cat 23 v1.7 revamp).
-- Three new tables that the discipline layer (eden.code_change.discipline)
-- reads + writes:
--   * pr_decision_audit  — append-only audit trail of every discipline decision
--   * pr_dedupe_index    — per-org short-window dedupe index keyed on fingerprint
--   * circuit_breaker_state — per-org short-window circuit breaker state
-- All three use IF NOT EXISTS so re-running the migration is safe.
BEGIN;

CREATE TABLE IF NOT EXISTS pr_decision_audit (
    id              BIGSERIAL PRIMARY KEY,
    org_id          VARCHAR(128) NOT NULL,
    fingerprint     VARCHAR(32) NOT NULL,
    trigger_kind    VARCHAR(16) NOT NULL,
    outcome         VARCHAR(32) NOT NULL,
    score           DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    reasons         JSONB,
    repo_id         VARCHAR(64) NOT NULL DEFAULT '',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pr_decision_audit_org
    ON pr_decision_audit (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pr_decision_audit_fingerprint
    ON pr_decision_audit (org_id, fingerprint);

CREATE TABLE IF NOT EXISTS pr_dedupe_index (
    org_id          VARCHAR(128) NOT NULL,
    fingerprint     VARCHAR(32) NOT NULL,
    last_outcome    VARCHAR(32) NOT NULL DEFAULT '',
    last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at      TIMESTAMPTZ NOT NULL,
    occurrences     INT NOT NULL DEFAULT 1,
    PRIMARY KEY (org_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_pr_dedupe_index_expires
    ON pr_dedupe_index (expires_at);

CREATE TABLE IF NOT EXISTS circuit_breaker_state (
    org_id              VARCHAR(128) NOT NULL,
    breaker_name        VARCHAR(64) NOT NULL,
    state               VARCHAR(16) NOT NULL DEFAULT 'closed',
    failure_count       INT NOT NULL DEFAULT 0,
    rejection_count     INT NOT NULL DEFAULT 0,
    opened_at           TIMESTAMPTZ,
    window_started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (org_id, breaker_name)
);
CREATE INDEX IF NOT EXISTS idx_circuit_breaker_state_state
    ON circuit_breaker_state (state) WHERE state = 'open';

-- Extend repo_connections to track graph index state.
-- Greptile / Local graph status surfaces per-repo via
-- these new columns; the repo_connector can use them to
-- avoid re-indexing on every connect.
ALTER TABLE repo_connections
    ADD COLUMN IF NOT EXISTS graph_indexed        BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS graph_index_status   VARCHAR(16) NOT NULL DEFAULT 'pending',
    ADD COLUMN IF NOT EXISTS graph_latest_sha     VARCHAR(64) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS graph_indexed_at     TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS graph_provider       VARCHAR(16) NOT NULL DEFAULT 'local';

COMMIT;
