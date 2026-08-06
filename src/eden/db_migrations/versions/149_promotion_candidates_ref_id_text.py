"""149 — promotion_candidates.ref_id: UUID -> TEXT (FEAT-28).

Revision ID: 149_promotion_candidates_ref_id_text
Revises: 148_agent_identity_aliases
Create Date: 2026-08-05

Migration 092 declared ``promotion_candidates.ref_id`` as ``UUID NOT NULL``,
but every caller of ``EvidenceGate.enqueue`` across the codebase writes
non-UUID refs into it: composite ``"{agent}:{candidate_version}"`` strings
for ``kind="prompt_version"`` (``PromotionLoop._evidence_gate_promote`` and
the manual-promote route in ``prompt_canary.py``), skill ids for
``kind="kb_skill"``, and judge/policy names for ``kind="guardrail"``. Only
``kind="nudge"`` refs happen to be UUIDs today.

asyncpg's UUID codec rejects the non-hex composite strings outright, so the
INSERT in ``EvidenceGate.enqueue`` always raised for these kinds. The bare
``except Exception`` there silently swallowed it and returned ``None``,
which made ``PromotionLoop._evidence_gate_promote`` always return ``False``
(100% canary promotion could never pass the evidence gate) and made the
manual promote API route always 503 ("EvidenceGate enqueue failed").

Widen the column to TEXT so it can hold any of the ref shapes actually in
use. TEXT is a strict superset of UUID's string representation, so existing
UUID values round-trip unchanged.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op
from sqlalchemy import text

revision: str = "149_promotion_candidates_ref_id_text"
down_revision: str | Sequence[str] | None = "148_agent_identity_aliases"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _col_data_type(table: str, column: str) -> str | None:
    row = (
        op.get_bind()
        .execute(
            text(
                """
                SELECT data_type
                FROM information_schema.columns
                WHERE table_schema = current_schema()
                  AND table_name = :table
                  AND column_name = :column
                """
            ),
            {"table": table, "column": column},
        )
        .fetchone()
    )
    if row is None:
        return None
    return (row[0] or "").lower()


def upgrade() -> None:
    data_type = _col_data_type("promotion_candidates", "ref_id")
    if data_type is None:
        # Table doesn't exist yet in this environment — nothing to widen.
        return
    if data_type in ("text", "character varying", "varchar"):
        # Already widened (e.g. re-run against a fresh 092+149-consolidated
        # environment) — no-op.
        return
    op.execute(
        """
        ALTER TABLE promotion_candidates
        ALTER COLUMN ref_id TYPE TEXT
        USING ref_id::text
        """
    )


def downgrade() -> None:
    # Not reversible in general: TEXT values written since this migration
    # (composite "agent:version" refs, skill ids, judge names) are not valid
    # UUIDs, so a blind cast back to UUID would fail. Leave as TEXT.
    pass
