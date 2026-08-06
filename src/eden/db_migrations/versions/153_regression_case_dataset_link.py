"""FEAT-74 — give ``dataset_items`` what N01 regression cases need.

``regression_eval_cases.dataset_id`` (092) is a free-text
``VARCHAR(128)`` (e.g. ``"checkout/regressions"``) that can never join
to the UUID-keyed ``datasets.id`` used by the F53 dataset hub
(101_eval_loop — ``datasets`` / ``dataset_items``). The two
"dataset_id" columns were schema-incompatible even in principle.

``RegressionCaseBuilder._persist`` now resolves a real UUID dataset
via ``DatasetHub`` (using the old free-text name as the dataset's
``name``) and writes N01 regression cases into ``dataset_items``
instead, so ``dataset_items.dataset_id`` joins straight to
``datasets.id``. That table doesn't yet carry what regression cases
need to keep working the same as before:

* ``org_id`` — regression cases are looked up by org directly
  (``_find_by_fingerprint``, ``list_cases``); denormalized here rather
  than always joining through ``datasets`` for it, matching how
  ``regression_eval_cases`` itself carried its own ``org_id``.
* ``fingerprint`` + a unique ``(org_id, fingerprint)`` index — this is
  the N01 dedup guarantee ``regression_eval_cases`` had via
  ``uq_regression_eval_fingerprint`` (092); it must carry over intact
  so ``_find_by_fingerprint`` keeps preventing duplicate regression
  cases for the same issue.
* ``auto_generated`` — whether a case was machine-created vs. manual,
  mirrored from ``regression_eval_cases``.

``regression_eval_cases`` itself is left in place (untouched schema)
and still written to as a best-effort compatibility shim, since
``ClosedLoopOrchestrator._enrich_cases_for_replay`` still ``UPDATE``s
it by id; nothing reads it as the source of truth any more.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "153_regression_case_dataset_link"
down_revision: str | Sequence[str] | None = "152_budget_scope"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE dataset_items ADD COLUMN IF NOT EXISTS org_id VARCHAR(128)"
    )
    op.execute(
        "ALTER TABLE dataset_items ADD COLUMN IF NOT EXISTS fingerprint TEXT"
    )
    op.execute(
        """
        ALTER TABLE dataset_items
        ADD COLUMN IF NOT EXISTS auto_generated BOOLEAN NOT NULL DEFAULT FALSE
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_dataset_items_org "
        "ON dataset_items (org_id, created_at DESC)"
    )
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_dataset_items_fingerprint "
        "ON dataset_items (org_id, fingerprint) WHERE fingerprint IS NOT NULL"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS uq_dataset_items_fingerprint")
    op.execute("DROP INDEX IF EXISTS idx_dataset_items_org")
    op.execute("ALTER TABLE dataset_items DROP COLUMN IF EXISTS auto_generated")
    op.execute("ALTER TABLE dataset_items DROP COLUMN IF EXISTS fingerprint")
    op.execute("ALTER TABLE dataset_items DROP COLUMN IF EXISTS org_id")
