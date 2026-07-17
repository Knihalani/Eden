"""100 — agent_ledgers + ledger_entries + evolution_ops_spend."""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "100_artifacts_ledger"
down_revision: str | Sequence[str] | None = "099"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS agent_ledgers (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            agent_id TEXT NOT NULL,
            version INT NOT NULL DEFAULT 1,
            inject_enabled BOOLEAN NOT NULL DEFAULT false,
            max_tokens INT NOT NULL DEFAULT 800,
            retrieval_enabled BOOLEAN NOT NULL DEFAULT true,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (org_id, agent_id)
        )
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS ledger_entries (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id UUID NOT NULL,
            agent_id TEXT NOT NULL,
            ledger_id UUID NOT NULL REFERENCES agent_ledgers(id) ON DELETE CASCADE,
            chapter TEXT NOT NULL DEFAULT 'general',
            text TEXT NOT NULL,
            citations JSONB NOT NULL DEFAULT '[]'::jsonb,
            source_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
            embedding BYTEA,
            weight DOUBLE PRECISION NOT NULL DEFAULT 1.0,
            version INT NOT NULL DEFAULT 1,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (ledger_id, chapter, md5(text))
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_ledger_entries_ledger_weight
        ON ledger_entries (ledger_id, weight DESC, created_at DESC)
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS evolution_ops_spend (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            kind TEXT NOT NULL,
            ref_id TEXT,
            cost_usd NUMERIC(12, 6) NOT NULL DEFAULT 0,
            recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_evolution_ops_spend_org_day
        ON evolution_ops_spend (org_id, recorded_at DESC)
        """
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS evolution_ops_spend")
    op.execute("DROP TABLE IF EXISTS ledger_entries")
    op.execute("DROP TABLE IF EXISTS agent_ledgers")
