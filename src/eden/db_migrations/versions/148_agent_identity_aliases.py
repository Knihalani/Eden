"""148 — agent_identity_aliases: reconcile telemetry-side synthetic agent_id
labels (framework instrumentation ids such as
``pydantic-ai:OpenAIChatModel()``) with the registered agent_id so the
Agents dashboard stops rendering a duplicate "ghost" card for the same
logical agent (BUG-6).

Rows are written by ``portal.list_portal_agents`` whenever
``_PREFERRED_AGENT_ID_SQL`` resolves a winning agent_id for a trace that
also contains a losing (synthetic) raw label — i.e. whenever we have direct
evidence the two labels refer to the same agent. The merge logic in that
handler then resolves telemetry-side agent_ids through this table before
falling back to creating a standalone card.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "148_agent_identity_aliases"
down_revision: str | Sequence[str] | None = "147_drift_baseline_watermark"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS agent_identity_aliases (
            org_id TEXT NOT NULL,
            synthetic_label TEXT NOT NULL,
            agent_id TEXT NOT NULL,
            first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (org_id, synthetic_label)
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS agent_identity_aliases_org_agent_idx
        ON agent_identity_aliases (org_id, agent_id)
        """
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS agent_identity_aliases_org_agent_idx")
    op.execute("DROP TABLE IF EXISTS agent_identity_aliases")
