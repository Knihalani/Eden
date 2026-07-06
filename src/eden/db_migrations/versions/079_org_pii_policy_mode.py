"""079_org_pii_policy_mode — PII policy ``mode`` tri-state.

Revision ID: 079
Revises: 078
Create Date: 2026-07-05

Adds a single ``mode`` column to ``org_pii_policies`` that
subsumes the existing ``fail_closed_on_credentials`` boolean
plus an ``enabled_categories = []`` shortcut for the "never
mask" case. The three accepted values are:

  * ``off``         — never mask (system designed to use the PII)
  * ``redact``      — mask per the active category set (default)
  * ``fail_closed`` — mask + raise on credential detection

The route handler is backwards-compatible: rows without an
explicit ``mode`` derive the value from the existing boolean
field, so existing tenants see no behaviour change. New tenants
can pick the tri-state knob via the API.

The column is added with a NOT NULL DEFAULT 'redact' so the
migration is safe on a populated table.
"""

from alembic import op

revision = "079"
down_revision = "078"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        ALTER TABLE org_pii_policies
        ADD COLUMN IF NOT EXISTS mode VARCHAR(16) NOT NULL DEFAULT 'redact'
    """)
    # Backfill: rows that already had fail_closed_on_credentials=true
    # should report mode='fail_closed' so the GET handler's derived
    # value matches the stored one.
    op.execute("""
        UPDATE org_pii_policies
        SET mode = 'fail_closed'
        WHERE fail_closed_on_credentials = TRUE
          AND (mode IS NULL OR mode = 'redact')
    """)
    op.execute("""
        UPDATE org_pii_policies
        SET mode = 'off'
        WHERE enabled_categories = '{}'::text[]
          AND (mode IS NULL OR mode = 'redact')
    """)


def downgrade() -> None:
    op.execute("ALTER TABLE org_pii_policies DROP COLUMN IF EXISTS mode")
