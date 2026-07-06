"""082_org_cost_overrides_cache - cache-discount rates on org_cost_overrides.

Revision ID: 082
Revises: 081
Create Date: 2026-07-06

Anthropic cache reads are 10% of input, OpenAI cache reads are
50% of input, and Anthropic cache writes cost 25% above the base
input rate. The :class:`CostResolver` already picks the right
cache rate from the :class:`PricingCatalog` for list prices, but
enterprise contracts frequently bundle a negotiated cache rate
(e.g. an Anthropic Bedrock reservation with a custom
cache-read discount).

This migration adds two nullable numeric columns to
``org_cost_overrides``:

  * ``cost_per_1k_cache_read``  - USD per 1K cached-read tokens
  * ``cost_per_1k_cache_write`` - USD per 1K cache-write tokens

Both are nullable: ``NULL`` means "no contract rate for this
bucket, fall back to the catalog rate". Old rows from migration
081 get ``NULL`` automatically, so this is a safe additive
change.

The resolver carries the values through to
:attr:`CostResolution.cost_per_1k_cache_read` /
:attr:`CostResolution.cost_per_1k_cache_write`, and
:meth:`CostResolution.estimate_with_cache` applies them.
"""

from alembic import op

revision = "082"
down_revision = "081"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE org_cost_overrides
            ADD COLUMN IF NOT EXISTS cost_per_1k_cache_read NUMERIC(12, 8),
            ADD COLUMN IF NOT EXISTS cost_per_1k_cache_write NUMERIC(12, 8)
        """
    )


def downgrade() -> None:
    op.execute(
        """
        ALTER TABLE org_cost_overrides
            DROP COLUMN IF EXISTS cost_per_1k_cache_write,
            DROP COLUMN IF EXISTS cost_per_1k_cache_read
        """
    )
