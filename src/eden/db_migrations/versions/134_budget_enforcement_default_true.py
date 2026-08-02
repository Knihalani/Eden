"""134 — budgets.enforcement_enabled default TRUE for free-tier.

Revision ID: 134_budget_enforcement_default_true
Revises: 133_email_verification_tokens
Create Date: 2026-08-02

Wave 4 cost controls: new budget rows (and any existing rows that
still carry the migration-052 ``DEFAULT FALSE``) should enforce hard
caps by default. ``budget_service.FREE_TIER_DEFAULTS`` already sets
``enforcement_enabled=True`` for missing-row fallbacks; this migration
aligns the table default and flips legacy free-tier rows that were
seeded with enforcement off.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "134_budget_enforcement_default_true"
down_revision: str | Sequence[str] | None = "133_email_verification_tokens"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # New INSERTs without an explicit flag get enforcement on.
    op.execute(
        "ALTER TABLE budgets "
        "ALTER COLUMN enforcement_enabled SET DEFAULT TRUE"
    )
    # Flip existing free-tier-shaped rows that still have enforcement off.
    # Match the FREE_TIER_DEFAULTS hard cap (≤ 4.0 USD) so paid/custom
    # budgets are left alone.
    op.execute(
        """
        UPDATE budgets
           SET enforcement_enabled = TRUE,
               updated_at = NOW()
         WHERE enforcement_enabled = FALSE
           AND cost_hard_limit_usd <= 4.0
        """
    )


def downgrade() -> None:
    op.execute(
        "ALTER TABLE budgets "
        "ALTER COLUMN enforcement_enabled SET DEFAULT FALSE"
    )
