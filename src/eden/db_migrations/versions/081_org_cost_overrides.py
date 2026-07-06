"""081_org_cost_overrides - per-tenant cost overrides.

Revision ID: 081
Revises: 080
Create Date: 2026-07-05

The Eden gateway computes cost for billing + observability using
the :class:`PricingCatalog`, which combines a static seed of
verified public list prices with a live overlay from OpenRouter's
``/api/v1/models``. But for any org with a volume discount, an
enterprise contract, or a private Bedrock reservation, the list
price is wrong.

This migration adds ``org_cost_overrides`` - a per-tenant rate
table that the gateway consults *before* the catalog. Routes:

  * override (per-tenant contract)         >  list price
  * override > live OpenRouter overlay     >  static seed

Each row is versioned with ``effective_from`` / ``effective_until``
so rate changes are auditable; the resolver picks the most-recent
effective row.

Schema notes
------------
* ``(org_id, provider, model_id)`` is the natural key but we use
  a surrogate ``override_id`` for stable external references.
* ``provider`` matches the ``Provider`` enum value
  (``openai``, ``openrouter``, ``anthropic``, ``minimax``,
  ``ollama``, ...). Use the wildcard ``*`` to set a fallback
  rate for any provider on a given model.
* ``source`` records provenance: ``contract`` (real billing data
  from a signed deal), ``manual`` (ops-set), ``reconciliation``
  (derived from observed invoice deltas), ``test`` (dev-only).
* ``notes`` is a free-text field for the deal name, the contract
  id, the person who negotiated it, etc.
"""

from alembic import op

revision = "081"
down_revision = "080"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS org_cost_overrides (
            override_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id UUID NOT NULL,
            provider VARCHAR(32) NOT NULL,
            model_id VARCHAR(128) NOT NULL,
            cost_per_1k_input NUMERIC(12, 8) NOT NULL,
            cost_per_1k_output NUMERIC(12, 8) NOT NULL,
            currency CHAR(3) NOT NULL DEFAULT 'USD',
            source VARCHAR(32) NOT NULL DEFAULT 'manual',
            effective_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            effective_until TIMESTAMPTZ,
            notes TEXT,
            created_by UUID,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    # Lookup index for the hot path (org + provider + model +
    # currently-effective range). Partial index keeps it small
    # because most orgs have only a handful of overrides.
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS ix_org_cost_overrides_lookup
            ON org_cost_overrides (org_id, provider, model_id, effective_from DESC)
            WHERE effective_until IS NULL
        """
    )
    # Per-org scan index for the admin GET that returns all
    # overrides for an org.
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS ix_org_cost_overrides_org
            ON org_cost_overrides (org_id, effective_from DESC)
        """
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_org_cost_overrides_org")
    op.execute("DROP INDEX IF EXISTS ix_org_cost_overrides_lookup")
    op.execute("DROP TABLE IF EXISTS org_cost_overrides")
