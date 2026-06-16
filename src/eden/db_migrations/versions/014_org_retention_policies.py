"""014_org_retention_policies — Phase 7.3b per-tenant retention override.

Revision ID: 014
Revises: 013
Create Date: 2026-06-05

Adds per-tenant retention windows. The default retention manager
in ``data_platform/retention.py`` is a module-level list; this
table lets enterprise customers override those windows to:

- Keep raw traces longer (e.g. for 365 days instead of the default 7)
- Delete PII faster (e.g. scrub_pii_after_days = 0 to keep zero PII)
- Apply different windows to different table_name values
  (the manager already has a table_name dimension)

The policy is time-effective (effective_from, effective_until) so
changes are auditable.
"""

from alembic import op

revision = "014"
down_revision = "013"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE IF NOT EXISTS org_retention_policies (
            policy_id          UUID PRIMARY KEY,
            tenant_id          VARCHAR(128) NOT NULL,
            table_name         VARCHAR(64) NOT NULL,
            hot_days           INT NOT NULL,
            warm_days          INT NOT NULL,
            cold_days          INT NOT NULL,
            delete_days        INT NOT NULL,
            pii_scrub_after_days INT,
            created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            effective_from     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            effective_until    TIMESTAMPTZ,
            created_by         VARCHAR(128),
            notes              TEXT,
            UNIQUE (tenant_id, table_name, effective_from)
        )
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_orp_lookup
        ON org_retention_policies (tenant_id, table_name, effective_from DESC)
    """)
    op.execute("""
        ALTER TABLE data_retention_log
        ADD COLUMN IF NOT EXISTS org_id VARCHAR(128)
    """)
    op.execute("""
        -- The data_retention_log table (from migration 008) uses
        -- ``completed_at`` not ``ran_at``; index the existing column
        -- instead. Pre-existing typo corrected 2026-06-16.
        CREATE INDEX IF NOT EXISTS idx_drl_org
        ON data_retention_log (org_id, completed_at DESC)
    """)


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_drl_org")
    op.execute("ALTER TABLE data_retention_log DROP COLUMN IF EXISTS org_id")
    op.execute("DROP INDEX IF EXISTS idx_orp_lookup")
    op.execute("DROP TABLE IF EXISTS org_retention_policies")
