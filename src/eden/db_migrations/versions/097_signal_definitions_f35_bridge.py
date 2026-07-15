"""097_signal_definitions_f35_bridge — F35 default-library bridge columns.

Revision ID: 097
Revises: 096
Create Date: 2026-07-15

Bridges the F35 default signal library (seeded into ``nl_signals``) into
``signal_definitions`` — the table the per-trace investigator (F06)
actually reads. Adds:

* ``template_id TEXT``      — the default-library template this row came
  from (``forgetting``, ``looping``…); NULL for ad-hoc signals.
* ``statgate_rule TEXT``    — deterministic StatGate expression evaluated
  with **zero** LLM cost (``looping`` / ``cost_spike``).
* ``investigator_prompt TEXT`` — the LLM investigator instruction; NULL
  means heuristic/StatGate only (no LLM schema contributed).

A partial unique index on ``(org_id, template_id)`` makes the seed
upsert idempotent for library templates while leaving ad-hoc signals
(template_id NULL) unconstrained.
"""

from __future__ import annotations

from alembic import op

revision = "097"
down_revision = "096"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE signal_definitions "
        "ADD COLUMN IF NOT EXISTS template_id TEXT"
    )
    op.execute(
        "ALTER TABLE signal_definitions "
        "ADD COLUMN IF NOT EXISTS statgate_rule TEXT"
    )
    op.execute(
        "ALTER TABLE signal_definitions "
        "ADD COLUMN IF NOT EXISTS investigator_prompt TEXT"
    )
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_signal_definitions_template "
        "ON signal_definitions (org_id, template_id) "
        "WHERE template_id IS NOT NULL"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS uq_signal_definitions_template")
    op.execute("ALTER TABLE signal_definitions DROP COLUMN IF EXISTS investigator_prompt")
    op.execute("ALTER TABLE signal_definitions DROP COLUMN IF EXISTS statgate_rule")
    op.execute("ALTER TABLE signal_definitions DROP COLUMN IF EXISTS template_id")
