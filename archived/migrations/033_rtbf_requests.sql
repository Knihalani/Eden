-- June 2026: RTBF request tracking (Phase K).
--
-- Closes a real audit gap. The existing
-- :class:`eden.services.governance_intel.gdpr.RightToBeForgottenService`
-- already performs the in-place redaction (zeroing user_id,
-- replacing content with "***") across 6+ tables. What's
-- missing is the LIFECYCLE — when did the request come in,
-- who triggered it, how long did it take, how many rows were
-- affected, did it fail?
--
-- The Cat 10 evidence pack generator
-- (``compliance_evidence``) needs this data to prove GDPR
-- Art. 17 was honoured. The audit-log is too coarse — we
-- need a dedicated table.
--
-- Per-row schema:
--   * status enum — pending / in_progress / completed / failed.
--   * requester — the user who triggered the request (could
--     be the user themselves via a self-serve flow, or an
--     admin acting on their behalf).
--   * target — the user whose data is being redacted. NOT
--     the same as requester in the admin-on-behalf case.
--   * org_id — the org both users belong to. (In a B2B
--     deployment, the data subject's data lives in the
--     same org as the requester.)
--   * reason — free text. Required for some jurisdictions.
--   * affected_rows — set on completion. NULL while pending.
--   * error — populated on failure. NULL on success.
--
-- Indexes:
--   * (org_id, created_at DESC) — the default "show me my
--     recent RTBF requests" view.
--   * (status) WHERE status IN ('pending', 'in_progress') —
--     the operator dashboard's "in-flight" panel.
--   * (target_user_id) — the data subject's own data-export
--     view (so they can see "yes, my request was honoured").

CREATE TABLE IF NOT EXISTS rtbf_requests (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id              UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    -- The user who triggered the request. May be the data
    -- subject themselves (self-serve) or an admin acting on
    -- their behalf.
    requester_user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- The user whose data is being redacted. In a
    -- self-serve flow, requester == target.
    target_user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- Free-text reason. Required for some jurisdictions
    -- (e.g. "GDPR Art. 17 right to erasure").
    reason              TEXT,
    -- ``pending`` when the row is created; flips to
    -- ``in_progress`` when the redaction starts; ends at
    -- ``completed`` or ``failed``.
    status              TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'in_progress', 'completed', 'failed')),
    -- Counter of rows updated. Set on completion. NULL while
    -- in flight. Surfaces in the operator dashboard.
    affected_rows       INT,
    -- Error message if the request failed. NULL on success.
    -- We store the raw exception text so a future run can
    -- retry the failed steps (after a fix is deployed).
    error               TEXT,
    -- When the redaction started running (i.e. when status
    -- transitioned to ``in_progress``). NULL while pending.
    started_at          TIMESTAMPTZ,
    -- When the redaction finished (either successfully or
    -- with an error). NULL while pending or in_progress.
    completed_at        TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Per-org "recent requests" view.
CREATE INDEX IF NOT EXISTS idx_rtbf_requests_org_created
    ON rtbf_requests (org_id, created_at DESC);

-- Operator "in-flight" view (partial index for the
-- high-churn rows only).
CREATE INDEX IF NOT EXISTS idx_rtbf_requests_in_flight
    ON rtbf_requests (org_id, created_at DESC)
    WHERE status IN ('pending', 'in_progress');

-- "Show me all requests for this data subject".
CREATE INDEX IF NOT EXISTS idx_rtbf_requests_target
    ON rtbf_requests (target_user_id, created_at DESC);


-- Trigger: keep ``updated_at`` fresh on every UPDATE so the
-- operator dashboard can show "last activity 2m ago" without
-- scanning the event log.
CREATE OR REPLACE FUNCTION rtbf_requests_touch_updated() RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_rtbf_requests_touch_updated ON rtbf_requests;
CREATE TRIGGER trg_rtbf_requests_touch_updated
    BEFORE UPDATE ON rtbf_requests
    FOR EACH ROW EXECUTE FUNCTION rtbf_requests_touch_updated();


COMMENT ON TABLE rtbf_requests IS
    'Phase K: RTBF (right to be forgotten) request lifecycle. '
    'Pairs with eden.services.governance_intel.gdpr.RightToBeForgottenService. '
    'Used by the Cat 10 evidence pack generator to prove GDPR Art. 17 was honoured.';
