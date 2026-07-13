"""093 — Red-team findings table (org-scoped).

Revision ID: 093
Revises: 092
Create Date: 2026-07-13

Ensures ``redteam_findings`` exists in Alembic-managed DBs with the
org-scoped schema used by :mod:`eden.redteam.findings_store`. The
standalone SQL ``migrations/034_redteam_findings.sql`` predates this
revision; ``CREATE TABLE IF NOT EXISTS`` keeps fresh + legacy envs safe.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "093"
down_revision: str | Sequence[str] | None = "092"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
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
            failed              BOOLEAN NOT NULL DEFAULT FALSE,
            detection_reason    TEXT NOT NULL,
            target_label        TEXT NOT NULL DEFAULT 'default',
            tags                TEXT[] NOT NULL DEFAULT '{}',
            created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_redteam_findings_org_created
        ON redteam_findings (org_id, created_at DESC)
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_redteam_findings_severity
        ON redteam_findings (org_id, severity, created_at DESC)
        WHERE severity IN ('high', 'critical')
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_redteam_findings_failures
        ON redteam_findings (org_id, created_at DESC)
        WHERE failed = TRUE
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_redteam_findings_probe
        ON redteam_findings (org_id, probe_name, created_at DESC)
        """
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS redteam_findings")
