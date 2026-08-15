"""169 — per-kind outcome tables for F41 evidence (Wave 3, 3.4).

Revision ID: 169_outcome_tables
Revises: 168_nl_signals_agent_id
Create Date: 2026-08-11

Wave 3 (3.4): ``EvidenceGate._metrics_from_outcomes`` returned ``[]`` for
four of the six PromotionKinds (``guardrail``, ``model_routing``,
``kb_skill``, ``pr_merge``) because no real outcome source existed —
each had an explicit branch with a comment describing the missing table
(see ``evidence_gate.py`` FEAT-31 audit). These four tables mirror
``nudge_outcomes`` (id / outcome_success / metric_delta / recorded_at)
so every kind has a real, producer-fed evidence source:

  * ``guardrail_outcomes`` — one row per enforced guardrail decision
    whose *correctness* later became known (bypass detected, or the
    guardrail was promoted→demoted through the evidence gate).
    ``ref_id`` convention: judge_id.
  * ``routing_decisions`` — one row per ModelRouter classification;
    ``outcome_success`` flips false when the chosen tier had to fall
    back (the router guessed wrong). ``ref_id`` convention: agent name.
  * ``skill_outcomes`` — one row per skill applied to an issue whose
    resolution state is known (issue resolved=success, ignored=failure).
    ``ref_id`` convention: skill_id.
  * ``pr_outcomes`` — one row per merged plan; ``outcome_success``
    flips false when the guardian later reverts it. ``ref_id``
    convention: plan_id.

RLS: ``org_id`` mirrors ``promotion_candidates`` (UUID FK, CASCADE);
readers confine by ``WHERE org_id = $1``. Producers run on the same
plain pool checkout as the rest of the autonomy workers.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "169_outcome_tables"
down_revision: str | Sequence[str] | None = "168_nl_signals_agent_id"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS guardrail_outcomes (
            id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            guardrail_id    VARCHAR(256) NOT NULL,
            trace_id        TEXT,
            outcome_success BOOLEAN,
            metric_delta    JSONB,
            recorded_at     TIMESTAMPTZ NOT NULL DEFAULT now()
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_guardrail_outcomes_ref
        ON guardrail_outcomes (org_id, guardrail_id, recorded_at DESC)
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS routing_decisions (
            id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            agent           VARCHAR(256) NOT NULL,
            slot            VARCHAR(64),
            tier            VARCHAR(16) NOT NULL,
            heuristic_used  BOOLEAN NOT NULL DEFAULT false,
            fallback_used   BOOLEAN NOT NULL DEFAULT false,
            outcome_success BOOLEAN,
            recorded_at     TIMESTAMPTZ NOT NULL DEFAULT now()
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_routing_decisions_agent
        ON routing_decisions (org_id, agent, recorded_at DESC)
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS skill_outcomes (
            id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            skill_id        VARCHAR(256) NOT NULL,
            issue_id        VARCHAR(128),
            outcome_success BOOLEAN,
            metric_delta    JSONB,
            recorded_at     TIMESTAMPTZ NOT NULL DEFAULT now()
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_skill_outcomes_skill
        ON skill_outcomes (org_id, skill_id, recorded_at DESC)
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS pr_outcomes (
            id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            plan_id         VARCHAR(128) NOT NULL,
            pr_number       INTEGER,
            merged_at       TIMESTAMPTZ,
            reverted_at     TIMESTAMPTZ,
            outcome_success BOOLEAN,
            recorded_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (org_id, plan_id)
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_pr_outcomes_plan
        ON pr_outcomes (org_id, plan_id, recorded_at DESC)
        """
    )


def downgrade() -> None:
    for table in (
        "guardrail_outcomes",
        "routing_decisions",
        "skill_outcomes",
        "pr_outcomes",
    ):
        op.execute(f"DROP TABLE IF EXISTS {table}")
