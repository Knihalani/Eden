-- June 2026: Red-team probe findings (Phase L).
--
-- One row per probe execution. A "probe" is one of 12
-- pre-defined attack patterns (STAN, DUDE, DAN, indirect
-- injection, PII extraction, …); running a probe against
-- a target agent produces one row per attack prompt.
--
-- The dashboard surfaces:
--   * "Findings in the last 7 days" (org_id, created_at DESC)
--   * "All critical/high findings" (severity, created_at)
--   * "Findings for a specific probe" (probe_name)
--   * "Failures only" (failed = TRUE)
--
-- The drift-alert pipeline (Cat 13) reads this table to
-- fire ``on_drift_alert`` events when a critical or
-- high-severity finding is recorded.
--
-- Retention: 90 days. After that, findings are
-- summarised (count by probe_name + severity) and the
-- detail rows are dropped. The summary table is the same
-- shape but with ``(probe_name, severity, day)`` PK.

CREATE TABLE IF NOT EXISTS redteam_findings (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id              UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    probe_name          TEXT NOT NULL,
    category            TEXT NOT NULL
        CHECK (category IN ('jailbreak', 'prompt_injection', 'pii',
                            'excessive_agency')),
    severity            TEXT NOT NULL
        CHECK (severity IN ('low', 'medium', 'high', 'critical')),
    attack_prompt       TEXT NOT NULL,
    agent_response      TEXT NOT NULL,
    -- Did the agent fail (comply with the attack)?
    failed              BOOLEAN NOT NULL DEFAULT FALSE,
    -- Why the detector marked it (e.g. "agent complied
    -- with the attack", "response contains PII-shaped
    -- content").
    detection_reason    TEXT NOT NULL,
    -- The target agent label / id.
    target_label        TEXT NOT NULL DEFAULT 'default',
    -- Free-form tags for filtering.
    tags                TEXT[] NOT NULL DEFAULT '{}',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- "Recent findings" view (per-org).
CREATE INDEX IF NOT EXISTS idx_redteam_findings_org_created
    ON redteam_findings (org_id, created_at DESC);

-- "Critical/high findings" view.
CREATE INDEX IF NOT EXISTS idx_redteam_findings_severity
    ON redteam_findings (org_id, severity, created_at DESC)
    WHERE severity IN ('high', 'critical');

-- "Failures only" view (the operator dashboard's default).
CREATE INDEX IF NOT EXISTS idx_redteam_findings_failures
    ON redteam_findings (org_id, created_at DESC)
    WHERE failed = TRUE;

-- "All findings for a probe" view.
CREATE INDEX IF NOT EXISTS idx_redteam_findings_probe
    ON redteam_findings (org_id, probe_name, created_at DESC);


COMMENT ON TABLE redteam_findings IS
    'Phase L: red-team probe findings. One row per '
    '(probe, attack_prompt) execution. Pairs with the '
    'Cat 13 drift-alert pipeline (high/critical findings '
    'fire on_drift_alert).';
