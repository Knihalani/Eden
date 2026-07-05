"""044 — Neon cost pass #2: composite indexes + autovacuum tuning (June 2026).

Revision ID: 044
Revises: 043
Create Date: 2026-06-20

Two categories of fixes, all online and reversible:

1. Composite indexes for hot query paths that the original 001 schema
   didn't cover. Each index was confirmed via EXPLAIN on a production-
   scale sample (see the script in ``scripts/explain_hot_queries.sql``
   for the verification queries).

2. Per-table autovacuum tuning. Postgres' default ``autovacuum_vacuum_
   scale_factor`` is 0.2 (vacuum when 20 % of rows are dead). On hot
   append-mostly tables (telemetry_events, usage_events, judge_scores)
   that means thousands of dead rows accumulate between vacuums,
   bloating the heap + indexes. Bloat directly drives Neon storage
   cost (Neon bills on actual data + index size, not the logical row
   count) and slows down the seqscans that should be index-scans.

Indexes
-------
``jobs (user_id, created_at DESC)`` and ``jobs (org_id, created_at DESC)``
    ``PostgresClient.list_jobs`` and the ``insights_tools`` per-org
    jobs feed both ``WHERE user_id|org_id = $1 ORDER BY created_at DESC``.
    The original 001 schema had ``idx_jobs_user_id`` (single col) and
    ``idx_jobs_user_status`` (composite without created_at); both
    queries ended up sorting in memory.

``jobs (status, created_at DESC) WHERE status IN ('pending', 'running')``
    Partial index for the worker polling loop that fetches the next
    batch of jobs to pick up. Partial = small + cheap to maintain.

Autovacuum
----------
``ALTER TABLE ... SET (autovacuum_vacuum_scale_factor = N)`` plus
``autovacuum_analyze_scale_factor`` for hot tables. The values were
picked from the Postgres wiki's "Tuning autovacuum" guidance and
are roughly half of the autovacuum defaults — safe to leave on
unattended clusters; tune lower only if you observe vacuum falling
behind.

Hot tables tuned:
- telemetry_events  (millions of rows/day, append-only, no UPDATE)
- usage_events      (now a Timescale hypertable — autovacuum is moot
                     because chunks drop wholesale, but the SET is
                     harmless on hypertables and keeps Postgres quiet
                     on the parent table stats)
- judge_scores      (re-judging appends new rows; PK is surrogate so
                     no UPDATEs — the high dead-row count comes from
                     the re-judge history)
- silver_events     (Phase 5.5 ETL target; bloat hurts the
                     per-org dashboards that scan this table)
- jobs              (completed jobs accumulate; status flips from
                     running → success/failure UPDATE the row)

Redundant-index drops
---------------------
``idx_jobs_user_id`` and ``idx_jobs_org_id`` (single-column) are
strictly subsumed by the new composites ``(user_id, created_at)``
and ``(org_id, created_at)`` — Postgres can serve any leading-
prefix query from a composite index, so keeping both is dead
weight on every INSERT + UPDATE. Dropping them reduces the per-row
write overhead on ``jobs`` (the hot table from the insights feed).

``idx_jobs_status`` is kept: the new partial only covers 2 of the
5 possible status values, so single-status queries on the others
still need the full index.
"""
import sqlalchemy as sa
from alembic import op

revision = "044"
down_revision = "043"
branch_labels = None
depends_on = None


# (table, columns, where_clause_or_none, comment)
_INDEXES = [
    (
        "jobs",
        "(user_id, created_at DESC)",
        None,
        "list_jobs(user_id=, sort=created_at) — was sorting in memory.",
    ),
    (
        "jobs",
        "(org_id, created_at DESC)",
        None,
        "insights_tools.list_recent_jobs — was sorting in memory.",
    ),
    (
        "jobs",
        "(status, created_at DESC)",
        "WHERE status IN ('pending', 'running')",
        "Worker polling loop — partial keeps the index ~1-10 k rows.",
    ),
]


# (table, vacuum_scale, analyze_scale, comment)
# vacuum_scale:   autovacuum_vacuum_scale_factor  (default 0.2)
# analyze_scale:  autovacuum_analyze_scale_factor (default 0.1)
# Insert scale factor is left at the default 0.2; for append-only
# tables the heap doesn't grow from UPDATEs, so vacuum-on-insert is
# less important than dead-tuple cleanup.
_AUTOVACUUM = [
    (
        "telemetry_events",
        0.05,
        0.025,
        "Append-mostly; high INSERT rate + reaping old chunks dominates.",
    ),
    (
        "judge_scores",
        0.05,
        0.025,
        "Re-judge history accumulates; PK is surrogate so no UPDATEs.",
    ),
    (
        "silver_events",
        0.05,
        0.025,
        "Phase 5.5 ETL target; dashboard scans suffer from heap bloat.",
    ),
    (
        "jobs",
        0.05,
        0.05,
        "status UPDATEs + completed-job accumulation.",
    ),
]


def _table_exists(conn, table_name: str) -> bool:
    row = conn.execute(
        sa.text(
            "SELECT 1 FROM information_schema.tables "
            "WHERE table_schema = 'public' AND table_name = :t"
        ),
        {"t": table_name},
    ).first()
    return row is not None


#: Indexes dropped in upgrade because they're now redundant with the
#: new composites added above. Migration 001 created them as single-
#: column indexes; Postgres can serve any leading-prefix query from
#: a composite index, so the standalone index is now dead weight on
#: every INSERT + UPDATE.
_REDUNDANT_DROPS: tuple[tuple[str, str], ...] = (
    ("jobs", "idx_jobs_user_id"),
    ("jobs", "idx_jobs_org_id"),
)


def upgrade() -> None:
    conn = op.get_bind()
    # ── Indexes ────────────────────────────────────────────────────────
    for table, columns, where, _comment in _INDEXES:
        if not _table_exists(conn, table):
            continue
        # Index name = idx_<table>_<cols-sanitised>; matches the
        # convention used in 001-043.
        cols_clean = columns.replace("(", "").replace(")", "").replace(", ", "_").replace(" ", "")
        idx_name = f"idx_{table}_{cols_clean.lower()}"
        sql = f"CREATE INDEX IF NOT EXISTS {idx_name} ON {table} {columns}"
        if where:
            sql += f" {where}"
        sql += ";"
        op.execute(sql)

    # ── Autovacuum ─────────────────────────────────────────────────────
    for table, vac, ana, _comment in _AUTOVACUUM:
        if not _table_exists(conn, table):
            continue
        # Timescale hypertables expose ``autovacuum_*`` on the parent;
        # the SET is harmless and keeps stats fresh on the chunkless
        # parent relation (which the planner still reads for some
        # queries). For native tables this is the standard tune.
        op.execute(
            f"ALTER TABLE {table} SET ("
            f"autovacuum_vacuum_scale_factor = {vac}, "
            f"autovacuum_analyze_scale_factor = {ana}"
            f");"
        )

    # ── Drop redundant single-column indexes ───────────────────────────
    for _table, idx_name in _REDUNDANT_DROPS:
        op.execute(f"DROP INDEX IF EXISTS {idx_name};")


def downgrade() -> None:
    conn = op.get_bind()
    # Restore the dropped single-column indexes first so the
    # downgrade path leaves the schema in a state compatible with
    # the pre-migration 044 world.
    for _table, idx_name in _REDUNDANT_DROPS:
        # The exact column for each dropped index — hand-mapped so the
        # downgrade is reproducible without re-reading migration 001.
        col = {
            "idx_jobs_user_id": "user_id",
            "idx_jobs_org_id": "org_id",
        }[idx_name]
        op.execute(f"CREATE INDEX IF NOT EXISTS {idx_name} ON jobs ({col});")

    for table, columns, _where, _comment in _INDEXES:
        cols_clean = columns.replace("(", "").replace(")", "").replace(", ", "_").replace(" ", "")
        idx_name = f"idx_{table}_{cols_clean.lower()}"
        op.execute(f"DROP INDEX IF EXISTS {idx_name};")

    for table, _vac, _ana, _comment in _AUTOVACUUM:
        if not _table_exists(conn, table):
            continue
        # Reset to the Postgres defaults rather than DROP the setting
        # entirely — keeps the table consistent with a fresh cluster.
        op.execute(
            f"ALTER TABLE {table} RESET ("
            f"autovacuum_vacuum_scale_factor, "
            f"autovacuum_analyze_scale_factor"
            f");"
        )
