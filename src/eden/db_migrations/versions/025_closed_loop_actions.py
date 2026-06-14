"""025_closed_loop_actions — Cat 17 (Closed-Loop Wiring) v1 ships.

Revision ID: 025
Revises: 024
Create Date: 2026-06-12

Adds the single v1 table that Cat 17 needs on top of the
existing hook surface in
:mod:`eden.llmops.promotion_hooks`:

* ``closed_loop_actions`` — the per-hook record of the
  *recommended* action. Each row is a tuple of
  ``(hook_name, action_kind, target, payload, status)``.

The v0 ship is **advisory only** — the hook writes a
``pending_approval`` row, and a separate
:class:`ClosedLoopExecutor` surfaces the pending actions
to the operator / portal for review. The hook does NOT
mutate production state. Auto-apply is a per-tenant
opt-in (the v0 ship does not include the executor's
auto-apply path; that's the v0.1 follow-up).

Hook → ``action_kind`` mapping:

* :meth:`PromotionHook.on_judge_regression` →
  ``block_promotion`` (target = ``canary_id`` or
  ``prompt_version_id``)
* :meth:`PromotionHook.on_judge_improvement` →
  ``bump_canary`` (target = ``canary_id``)
* :meth:`PromotionHook.on_drift_alert` →
  ``rollback_canary`` (target = ``canary_id``)
* :meth:`GuardrailHook.on_judge_threshold_breach` →
  ``promote_judge`` (target = ``judge_name``)
* :meth:`GuardrailHook.on_judge_below_floor` →
  ``disable_guardrail`` (target = ``policy_id``)
* :meth:`ExperimentHook.on_winner` →
  ``archive_variant`` (target = ``variant_id``)
* :meth:`MetricStudioHook.on_metric_promotion` →
  ``register_regression_watch`` (target = ``metric_id``)
* :meth:`ColumnarHook.on_compaction_drift` →
  ``pause_rollup_scheduler`` (target = ``partition_id``)
* :meth:`DSLHook.on_alert_lint_warning` →
  ``surface_lint_warning`` (target = ``alert_id``)

Conventions:
* All tables include ``org_id VARCHAR(128) NOT NULL`` and
  ``created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()``.
* Every table gets an ``idx_<name>_org (org_id, created_at DESC)``
  index for the per-org time-series access pattern.
* A partial index on ``(org_id, status) WHERE status='pending_approval'``
  for the executor's hot read path.

See ``docs/eden-observability-gap-roadmap.md`` (Cat 17) and
``docs/observability-gap/17-closed-loop-wiring.md``.
"""

from __future__ import annotations

from alembic import op

revision = "025"
down_revision = "024"
branch_labels = None
depends_on = None


def _table(name: str, body: str, extra_index: str = "") -> None:
    op.execute(f"CREATE TABLE IF NOT EXISTS {name} ({body})")
    op.execute(
        f"CREATE INDEX IF NOT EXISTS idx_{name}_org "
        f"ON {name} (org_id, created_at DESC)"
    )
    if extra_index:
        op.execute(extra_index)


def upgrade() -> None:
    _table(
        "closed_loop_actions",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        hook_name       VARCHAR(64) NOT NULL,
        action_kind     VARCHAR(64) NOT NULL,
        target          VARCHAR(256),
        payload_json    TEXT,
        severity        VARCHAR(16) NOT NULL DEFAULT 'medium',
        status          VARCHAR(32) NOT NULL DEFAULT 'pending_approval',
        applied_at      TIMESTAMPTZ,
        applied_by      VARCHAR(128),
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
        "CREATE INDEX IF NOT EXISTS idx_closed_loop_actions_pending "
        "ON closed_loop_actions (org_id, status) "
        "WHERE status = 'pending_approval'",
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS closed_loop_actions")
