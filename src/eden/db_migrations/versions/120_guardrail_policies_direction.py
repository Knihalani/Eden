"""120 — guardrail_policies: add direction column.

Revision ID: 120_guardrail_policies_direction
Revises: 119_repo_connections_agent_id
Create Date: 2026-07-27

``InterventionEngine.evaluate_and_act`` applied every active policy
(regardless of type) to both inbound-prompt and outbound-completion
call sites, with no way for an org to scope a policy (e.g.
``hallucination``, which needs ``context`` to compute a meaningful
``overlap_ratio``) to only the direction it's meant for. An org with
an active ``hallucination`` policy therefore saw it fire on
``/evaluate`` calls guarding plain user input (no ``context``),
producing false-positive "ungrounded" blocks.

Adds ``direction`` (``'input'`` | ``'output'`` | ``'both'``) to
``guardrail_policies``, matching the convention already used by the
in-memory ``eden.guardrails.evaluator.GuardrailPolicy.direction``
field. Defaults existing + new rows to ``'both'`` so current
enforcement behaviour is unchanged until an org opts a policy into a
narrower scope.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "120_guardrail_policies_direction"
down_revision: str | Sequence[str] | None = "119_repo_connections_agent_id"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE guardrail_policies
            ADD COLUMN IF NOT EXISTS direction VARCHAR(16)
                NOT NULL DEFAULT 'both'
        """
    )
    # Belt-and-braces: existing rows created before the DEFAULT existed
    # (if the column was added without one on some substrate) still land
    # on 'both' rather than NULL.
    op.execute(
        """
        UPDATE guardrail_policies SET direction = 'both'
        WHERE direction IS NULL
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_guardrail_policies_org_type_direction
        ON guardrail_policies (org_id, type, direction)
        WHERE status = 'active'
        """
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_guardrail_policies_org_type_direction")
    op.execute(
        """
        ALTER TABLE guardrail_policies
            DROP COLUMN IF EXISTS direction
        """
    )
