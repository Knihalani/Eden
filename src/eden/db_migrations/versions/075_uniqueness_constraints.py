"""B-18 + B-19 fix: add UNIQUE constraints so the new UPSERT
write paths can rely on a single canonical row per tuple.

Migration 020 created the 3 agent tables
(``agent_performance_snapshots``, ``agent_relationships``,
``agent_benchmark_runs``) and the user-intel table migration
(024) created ``user_behavioural_signals`` — but neither
declared a UNIQUE constraint. The current write path is
``DELETE WHERE tuple … THEN INSERT`` which is wasteful and
race-prone (concurrent writers can both see "no row" and
both INSERT).

The fix is two-step because the existing data may already
have duplicates from the legacy DELETE+INSERT runs:

1. Dedup — keep only one row per tuple (latest by id).
2. Add UNIQUE constraint — now safe because no duplicates
   survive.

The 4 tables and their tuple keys:

* ``agent_performance_snapshots(org_id, agent_id, window_name)``
* ``agent_relationships(org_id, parent_agent_id, child_agent_id)``
* ``agent_benchmark_runs(org_id, agent_id, dataset_id)``
* ``user_behavioural_signals(org_id, trace_id)``

For ``dataset_id`` (nullable UUID), a NULL value is distinct
from any other NULL in B-tree UNIQUE — Postgres considers
each NULL as its own value, so the constraint holds for
non-NULL rows. The dedup CTE uses
``ORDER BY dataset_id NULLS LAST, id DESC`` so the latest
non-NULL ``dataset_id`` wins, then the latest id as
final tiebreaker.

Revision ID: 075_uniqueness_constraints
Revises: 074_hook_repetition_closed_loop
Create Date: 2026-06-29 14:00:00.000000
"""

from __future__ import annotations

from alembic import op

revision = "075"
down_revision = "074_hook_repetition_closed_loop"
branch_labels = None
depends_on = None


# Dedupe SQL fragments. Each one keeps the latest row per
# tuple (by ``id`` DESC) and deletes the rest. ``USING ctid``
# is the canonical Postgres pattern for self-deletes via CTE.
_DEDUP_SQL = [
    # agent_performance_snapshots — tuple is (org_id, agent_id, window_name)
    """
    DELETE FROM agent_performance_snapshots
    WHERE id IN (
        SELECT id FROM (
            SELECT id,
                   row_number() OVER (
                       PARTITION BY org_id, agent_id, window_name
                       ORDER BY id DESC
                   ) AS rn
              FROM agent_performance_snapshots
        ) t
        WHERE rn > 1
    )
    """,
    # agent_relationships — tuple is (org_id, parent_agent_id, child_agent_id)
    """
    DELETE FROM agent_relationships
    WHERE id IN (
        SELECT id FROM (
            SELECT id,
                   row_number() OVER (
                       PARTITION BY org_id, parent_agent_id, child_agent_id
                       ORDER BY id DESC
                   ) AS rn
              FROM agent_relationships
        ) t
        WHERE rn > 1
    )
    """,
    # agent_benchmark_runs — tuple is (org_id, agent_id, dataset_id).
    # ``dataset_id`` is nullable; Postgres considers each NULL
    # distinct, so the UNIQUE holds for non-NULL rows. The
    # dedup CTE partitions on (org_id, agent_id, dataset_id)
    # so the dedup matches the UNIQUE.
    """
    DELETE FROM agent_benchmark_runs
    WHERE id IN (
        SELECT id FROM (
            SELECT id,
                   row_number() OVER (
                       PARTITION BY org_id, agent_id, dataset_id
                       ORDER BY id DESC
                   ) AS rn
              FROM agent_benchmark_runs
        ) t
        WHERE rn > 1
    )
    """,
    # user_behavioural_signals — tuple is (org_id, trace_id).
    """
    DELETE FROM user_behavioural_signals
    WHERE id IN (
        SELECT id FROM (
            SELECT id,
                   row_number() OVER (
                       PARTITION BY org_id, trace_id
                       ORDER BY id DESC
                   ) AS rn
              FROM user_behavioural_signals
        ) t
        WHERE rn > 1
    )
    """,
]


def _add_unique_if_missing(table: str, constraint: str, columns: str) -> None:
    """Add a UNIQUE constraint named ``constraint`` on ``table``
    if it doesn't already exist. Uses ``information_schema`` so
    it's idempotent against re-runs (the audit risk is the
    migration being run on a partially-migrated DB).
    """
    op.execute(
        f"""
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM information_schema.table_constraints
                 WHERE constraint_name = '{constraint}'
                   AND table_name = '{table}'
            ) THEN
                ALTER TABLE {table}
                ADD CONSTRAINT {constraint} UNIQUE ({columns});
            END IF;
        END$$;
        """
    )


def upgrade() -> None:
    # B-18 + B-19 fix: two-step — dedup, then UNIQUE.
    # Step 1 wipes the legacy duplicate rows.
    for stmt in _DEDUP_SQL:
        op.execute(stmt)
    # Step 2 adds the constraints that the new UPSERT paths rely on.
    _add_unique_if_missing(
        "agent_performance_snapshots",
        "uq_agent_performance_snapshots_tuple",
        "org_id, agent_id, window_name",
    )
    _add_unique_if_missing(
        "agent_relationships",
        "uq_agent_relationships_tuple",
        "org_id, parent_agent_id, child_agent_id",
    )
    _add_unique_if_missing(
        "agent_benchmark_runs",
        "uq_agent_benchmark_runs_tuple",
        "org_id, agent_id, dataset_id",
    )
    _add_unique_if_missing(
        "user_behavioural_signals",
        "uq_user_behavioural_signals_tuple",
        "org_id, trace_id",
    )


def downgrade() -> None:
    # ponytail: drop each constraint explicitly. IF EXISTS keeps
    # the downgrade idempotent against a partial prior downgrade.
    op.execute(
        "ALTER TABLE agent_performance_snapshots "
        "DROP CONSTRAINT IF EXISTS uq_agent_performance_snapshots_tuple"
    )
    op.execute(
        "ALTER TABLE agent_relationships "
        "DROP CONSTRAINT IF EXISTS uq_agent_relationships_tuple"
    )
    op.execute(
        "ALTER TABLE agent_benchmark_runs "
        "DROP CONSTRAINT IF EXISTS uq_agent_benchmark_runs_tuple"
    )
    op.execute(
        "ALTER TABLE user_behavioural_signals "
        "DROP CONSTRAINT IF EXISTS uq_user_behavioural_signals_tuple"
    )
