"""094 — retrieval_strategy_state tenant isolation.

Revision ID: 094
Revises: 093
Create Date: 2026-07-14

The ``retrieval_strategy_state`` table was originally keyed by
``collection`` alone, which allowed different orgs' strategies to
collide on the same row (e.g. both org A and org B writing to the
``skills`` collection). This migration:

1. Ensures the table exists (legacy SQL migrations were not always
   applied in Alembic-only CI / fresh deploys).
2. Adds ``org_id VARCHAR(128) NOT NULL DEFAULT ''`` — the empty
   string is the legacy sentinel so existing rows stay valid.
3. Drops the old ``UNIQUE(collection)`` constraint.
4. Creates a new ``UNIQUE(collection, org_id)`` constraint so each
   org's per-collection strategy is isolated.
5. Adds an ``(org_id, collection)`` index for the access pattern
   used by :class:`eden.kb.strategy_store.RetrievalStrategyStore`.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "094"
down_revision: str | Sequence[str] | None = "093"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Table lived in legacy ``migrations/022_retrieval_tuner.sql`` and
    # was never created by an earlier Alembic revision. Fresh CI DBs
    # that only run ``alembic upgrade head`` therefore lack it — create
    # it idempotently before the tenant-isolation ALTER.
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS retrieval_strategy_state (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            collection VARCHAR(50) NOT NULL,
            score_threshold FLOAT DEFAULT 0.7,
            default_limit INT DEFAULT 20,
            dense_weight FLOAT DEFAULT 0.6,
            sparse_weight FLOAT DEFAULT 0.4,
            preferred_filters JSONB DEFAULT '{}',
            last_tuned_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW()
        )
        """
    )

    op.execute(
        """
        ALTER TABLE retrieval_strategy_state
            ADD COLUMN IF NOT EXISTS org_id VARCHAR(128) NOT NULL DEFAULT ''
        """
    )

    op.execute(
        """
        ALTER TABLE retrieval_strategy_state
            DROP CONSTRAINT IF EXISTS retrieval_strategy_state_collection_key
        """
    )

    op.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS
            uq_retrieval_strategy_collection_org
        ON retrieval_strategy_state (collection, org_id)
        """
    )

    op.execute(
        """
        CREATE INDEX IF NOT EXISTS
            idx_retrieval_strategy_org
        ON retrieval_strategy_state (org_id, collection)
        """
    )


def downgrade() -> None:
    op.execute(
        "DROP INDEX IF EXISTS idx_retrieval_strategy_org"
    )
    op.execute(
        "DROP INDEX IF EXISTS uq_retrieval_strategy_collection_org"
    )
    op.execute(
        """
        ALTER TABLE retrieval_strategy_state
            ADD CONSTRAINT retrieval_strategy_state_collection_key
            UNIQUE (collection)
        """
    )
    op.execute(
        "ALTER TABLE retrieval_strategy_state DROP COLUMN IF EXISTS org_id"
    )
