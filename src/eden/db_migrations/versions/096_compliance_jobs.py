"""096_compliance_jobs — GDPR/CCPA compliance persistence.

Revision ID: 096
Revises: 095
Create Date: 2026-07-13

Tables:
* compliance_jobs — async export / delete jobs with status + download URL
* dsar_tickets — public DSAR intake tickets for ops SLA tracking
* do_not_sell_requests — CCPA opt-out records
"""

from __future__ import annotations

from alembic import op

revision = "096"
down_revision = "095"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS compliance_jobs (
            id              VARCHAR(64) PRIMARY KEY,
            job_type        VARCHAR(32) NOT NULL,
            status          VARCHAR(32) NOT NULL DEFAULT 'queued',
            subject_user_id VARCHAR(128),
            subject_org_id  VARCHAR(128),
            requested_by    VARCHAR(128),
            download_url    TEXT,
            error_message   TEXT,
            payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            completed_at    TIMESTAMPTZ
        );
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_compliance_jobs_subject_user
            ON compliance_jobs (subject_user_id, created_at DESC);
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_compliance_jobs_status
            ON compliance_jobs (status, created_at DESC);
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS dsar_tickets (
            id              VARCHAR(64) PRIMARY KEY,
            subject_name    TEXT NOT NULL,
            subject_email   TEXT NOT NULL,
            request_type    VARCHAR(32) NOT NULL,
            details         TEXT,
            status          VARCHAR(32) NOT NULL DEFAULT 'open',
            sla_due_at      TIMESTAMPTZ NOT NULL,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            resolved_at     TIMESTAMPTZ
        );
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_dsar_tickets_status
            ON dsar_tickets (status, sla_due_at);
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS do_not_sell_requests (
            id              VARCHAR(64) PRIMARY KEY,
            email           TEXT NOT NULL,
            email_hash      VARCHAR(64) NOT NULL,
            effective_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        """
    )
    op.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS idx_do_not_sell_email_hash
            ON do_not_sell_requests (email_hash);
        """
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS do_not_sell_requests;")
    op.execute("DROP TABLE IF EXISTS dsar_tickets;")
    op.execute("DROP TABLE IF EXISTS compliance_jobs;")
