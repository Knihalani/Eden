"""152 — budgets / budget_consumption / budget_actions: scope_type + scope_id (FEAT-47).

Problem
-------
Eden's budgets are org-level only: all three budget tables
(``budgets``, ``budget_consumption``, ``budget_actions``) are keyed
solely on ``(org_id, "window")``. Portkey (workspace -> key -> tag) and
LiteLLM (key / team / user / customer / project) both support
multi-scope budgets; eden did not, so a team or agent could never have
its own cap distinct from the org-wide one.

Fix
---
Adds ``scope_type VARCHAR(16) NOT NULL DEFAULT 'org'`` and
``scope_id VARCHAR(128) NULL`` to all three tables, modeled on
LiteLLM's "one shared budget object referenced by scope" pattern — a
budget row is now identified by ``(org_id, window, scope_type,
scope_id)`` instead of just ``(org_id, window)``. Existing rows
backfill to ``scope_type='org', scope_id=NULL`` (the historical
org-level budget), so nothing already written changes meaning and
every existing caller of :mod:`eden.services.budget_service` keeps
its current (org-scoped) behavior untouched.

The prior unique indexes are dropped and re-created to include the
new columns so an org can now have *both* an org-level budget AND a
team-scoped budget for the same window without a unique-constraint
collision:

* ``budgets`` — the partial unique index on
  ``(org_id, "window") WHERE enforcement_enabled = TRUE`` becomes
  ``(org_id, "window", scope_type, COALESCE(scope_id, '')) WHERE
  enforcement_enabled = TRUE``.
* ``budget_consumption`` — the full unique index on
  ``(org_id, "window", window_start)`` becomes
  ``(org_id, "window", window_start, scope_type, COALESCE(scope_id, ''))``.

``COALESCE(scope_id, '')`` is used rather than the bare ``scope_id``
column because Postgres treats every ``NULL`` as distinct for
uniqueness purposes — a bare ``scope_id`` column in the index would
let two org-scoped (``scope_id IS NULL``) budgets for the same
org+window coexist, silently reintroducing the exact ambiguity this
migration exists to prevent. Folding the sentinel into the index also
lets :func:`eden.services.budget_service.upsert_budget` /
:func:`eden.services.budget_service.record_usage` keep using a plain
``ON CONFLICT (...) DO UPDATE`` (their existing upsert idiom) with a
conflict target that matches these indexes exactly.

``budget_actions`` has no unique index today (it is an append-only
audit log keyed by a UUID primary key, not by ``(org_id, window)``),
so only the two new columns are added there — no index changes are
required for backward compatibility.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "152_budget_scope"
down_revision: str | Sequence[str] | None = "151_improvement_plan_events"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # ── 1. budgets — add scope columns, widen the unique index ────
    op.execute(
        """
        ALTER TABLE budgets
        ADD COLUMN IF NOT EXISTS scope_type VARCHAR(16) NOT NULL DEFAULT 'org',
        ADD COLUMN IF NOT EXISTS scope_id VARCHAR(128) NULL
        """
    )
    op.execute("DROP INDEX IF EXISTS idx_budgets_org_window")
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_budgets_org_window_scope "
        "ON budgets (org_id, \"window\", scope_type, COALESCE(scope_id, '')) "
        "WHERE enforcement_enabled = TRUE"
    )

    # ── 2. budget_consumption — add scope columns, widen the index ─
    op.execute(
        """
        ALTER TABLE budget_consumption
        ADD COLUMN IF NOT EXISTS scope_type VARCHAR(16) NOT NULL DEFAULT 'org',
        ADD COLUMN IF NOT EXISTS scope_id VARCHAR(128) NULL
        """
    )
    op.execute("DROP INDEX IF EXISTS idx_budget_consumption_active")
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_budget_consumption_active_scope "
        "ON budget_consumption "
        "(org_id, \"window\", window_start, scope_type, COALESCE(scope_id, ''))"
    )

    # ── 3. budget_actions — add scope columns (no unique index) ────
    op.execute(
        """
        ALTER TABLE budget_actions
        ADD COLUMN IF NOT EXISTS scope_type VARCHAR(16) NOT NULL DEFAULT 'org',
        ADD COLUMN IF NOT EXISTS scope_id VARCHAR(128) NULL
        """
    )


def downgrade() -> None:
    # ── 3. budget_actions ───────────────────────────────────────
    op.execute(
        """
        ALTER TABLE budget_actions
        DROP COLUMN IF EXISTS scope_type,
        DROP COLUMN IF EXISTS scope_id
        """
    )

    # ── 2. budget_consumption ───────────────────────────────────
    op.execute("DROP INDEX IF EXISTS idx_budget_consumption_active_scope")
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_budget_consumption_active "
        "ON budget_consumption (org_id, \"window\", window_start)"
    )
    op.execute(
        """
        ALTER TABLE budget_consumption
        DROP COLUMN IF EXISTS scope_type,
        DROP COLUMN IF EXISTS scope_id
        """
    )

    # ── 1. budgets ──────────────────────────────────────────────
    op.execute("DROP INDEX IF EXISTS idx_budgets_org_window_scope")
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_budgets_org_window "
        "ON budgets (org_id, \"window\") "
        "WHERE enforcement_enabled = TRUE"
    )
    op.execute(
        """
        ALTER TABLE budgets
        DROP COLUMN IF EXISTS scope_type,
        DROP COLUMN IF EXISTS scope_id
        """
    )
