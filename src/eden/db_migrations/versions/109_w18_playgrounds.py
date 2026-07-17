"""109 — Wave 18: persisted playgrounds + prompt templates (U03/F49).

Revision ID: 109_w18_playgrounds
Revises: 108_f84_heartbeats
Create Date: 2026-07-17

Additive-only. Forward-compat: yes.
"""

from __future__ import annotations

from alembic import op

revision: str = "109_w18_playgrounds"
down_revision: str = "108_f84_heartbeats"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS prompt_templates (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id VARCHAR(128) NOT NULL,
            name TEXT NOT NULL,
            version INT NOT NULL DEFAULT 1,
            system TEXT NOT NULL DEFAULT '',
            user_template TEXT NOT NULL DEFAULT '',
            tools JSONB NOT NULL DEFAULT '[]'::jsonb,
            required_params JSONB NOT NULL DEFAULT '[]'::jsonb,
            optional_params JSONB NOT NULL DEFAULT '[]'::jsonb,
            model TEXT NOT NULL DEFAULT 't1',
            temperature DOUBLE PRECISION NOT NULL DEFAULT 0.0,
            max_tokens INT NOT NULL DEFAULT 1024,
            description TEXT NOT NULL DEFAULT '',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (org_id, name, version)
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_prompt_templates_org_name "
        "ON prompt_templates (org_id, name, version DESC)"
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS playgrounds (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id VARCHAR(128) NOT NULL,
            name TEXT NOT NULL,
            config JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_by TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_playgrounds_org "
        "ON playgrounds (org_id, updated_at DESC)"
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS playground_runs (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            playground_id UUID NOT NULL REFERENCES playgrounds(id) ON DELETE CASCADE,
            org_id VARCHAR(128) NOT NULL,
            status TEXT NOT NULL DEFAULT 'completed',
            results JSONB NOT NULL DEFAULT '{}'::jsonb,
            cost_usd NUMERIC,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_playground_runs_pg "
        "ON playground_runs (playground_id, created_at DESC)"
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS playground_runs")
    op.execute("DROP TABLE IF EXISTS playgrounds")
    op.execute("DROP TABLE IF EXISTS prompt_templates")
