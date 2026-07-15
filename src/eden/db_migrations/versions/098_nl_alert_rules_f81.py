"""098 — F81 NL alert rules, alert events triage, feedback."""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "098"
down_revision: str | Sequence[str] | None = "097"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS nl_alert_rules (
            id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            name            TEXT NOT NULL,
            nl_text         TEXT NOT NULL,
            compiled_eql    TEXT NOT NULL,
            triage_enabled  BOOLEAN NOT NULL DEFAULT TRUE,
            channels        JSONB NOT NULL DEFAULT '{"in_app": true}'::jsonb,
            enabled         BOOLEAN NOT NULL DEFAULT TRUE,
            created_by      TEXT,
            last_fired_at   TIMESTAMPTZ,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_nl_alert_rules_org
        ON nl_alert_rules (org_id, created_at DESC)
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS alert_events (
            id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id              UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            rule_id             UUID REFERENCES nl_alert_rules(id) ON DELETE SET NULL,
            title               TEXT NOT NULL,
            severity            TEXT NOT NULL DEFAULT 'warning',
            payload             JSONB NOT NULL DEFAULT '{}'::jsonb,
            triage_verdict      TEXT,
            triage_reason       TEXT,
            triage_confidence   NUMERIC,
            incident_id         UUID,
            acknowledged        BOOLEAN NOT NULL DEFAULT FALSE,
            created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_alert_events_org_verdict
        ON alert_events (org_id, triage_verdict, created_at DESC)
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS alert_triage_feedback (
            id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            alert_event_id  UUID NOT NULL REFERENCES alert_events(id) ON DELETE CASCADE,
            human_verdict   TEXT NOT NULL,
            created_by      TEXT,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_alert_triage_feedback_event
        ON alert_triage_feedback (alert_event_id, created_at DESC)
        """
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS alert_triage_feedback")
    op.execute("DROP TABLE IF EXISTS alert_events")
    op.execute("DROP TABLE IF EXISTS nl_alert_rules")
