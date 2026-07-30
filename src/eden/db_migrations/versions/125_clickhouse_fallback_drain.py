"""125 — clickhouse_fallback: a terminal state and an index the drain can use.

Revision ID: 125_clickhouse_fallback_drain
Revises: 124_missing_columns_both_sides_assume
Create Date: 2026-07-30

``clickhouse_fallback`` was created in migration 008 to hold rows a
ClickHouse insert failed on, "for later retry" (the docstring on
``ClickHouseSink._fallback_to_postgres``). Until now the retry did not
exist: ``clickhouse_sink.py`` appends rows and *nothing* in ``src/`` ever
issued a ``SELECT`` against the table or set ``resolved_at``. Two
consequences, both live in production: the columnar copy of every failed
batch was permanently lost, and the table grew monotonically forever.

``data_platform/clickhouse_fallback_drain.py`` now replays those rows.
This revision gives it the two things the 008 schema is missing:

* **``dead_at``** — a terminal state distinct from ``resolved_at``.
  A row whose payload ClickHouse will never accept (a schema mismatch, a
  dropped column, a type error) fails identically on every attempt, so
  without a terminal state the drain retries it until the heat death of
  the universe and it permanently occupies the head of the oldest-first
  queue, starving every row behind it. Folding give-ups into
  ``resolved_at`` would work mechanically but would make "resolved" mean
  both "replayed into ClickHouse" and "discarded undelivered" — the one
  distinction an operator actually needs.

* **``idx_clickhouse_fallback_drain``** — the drain reads
  ``WHERE resolved_at IS NULL AND dead_at IS NULL ORDER BY failed_at
  LIMIT n``. 008's ``idx_clickhouse_fallback_unresolved`` is a partial
  index on ``(resolved_at) WHERE resolved_at IS NULL``: it can satisfy
  the predicate but carries no useful ordering, so the planner still has
  to sort every unresolved row to find the oldest ``n``. Indexing
  ``failed_at`` under the same partial predicate makes the batch read an
  index scan that stops after ``n`` rows regardless of backlog depth.

The predicate is ``IS NULL`` on both columns and therefore IMMUTABLE.
That is deliberate: migration 083 exists solely because a partial index
predicate used ``NOW()``, which Postgres rejects as STABLE, and it broke
``alembic upgrade head`` on every fresh database. The drain's backoff
comparison against ``last_retry_at`` is applied as a runtime filter on
top of this index, never inside its predicate.

``CREATE INDEX CONCURRENTLY`` is not available: ``env.py`` wraps the
whole migration chain in a single transaction, and CONCURRENTLY cannot
run inside one. A plain ``CREATE INDEX`` takes a brief ``SHARE`` lock,
which is acceptable here — ``clickhouse_fallback`` is written only on
the ClickHouse-insert failure path and read only by the drain.
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "125_clickhouse_fallback_drain"
down_revision: str | Sequence[str] | None = "124_missing_columns_both_sides_assume"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _table_exists(table_name: str) -> bool:
    conn = op.get_bind()
    row = conn.execute(
        sa.text(
            "SELECT 1 FROM information_schema.tables "
            "WHERE table_schema = 'public' AND table_name = :t"
        ),
        {"t": table_name},
    ).first()
    return row is not None


def upgrade() -> None:
    # A database stamped past 008 without its tables (the Neon staging
    # situation that motivated 083's guard) must not abort the chain.
    if not _table_exists("clickhouse_fallback"):
        return

    op.execute(
        "ALTER TABLE clickhouse_fallback "
        "ADD COLUMN IF NOT EXISTS dead_at TIMESTAMPTZ"
    )

    # Oldest-first over the live backlog only. Rows that are resolved or
    # dead leave the index entirely, so it stays proportional to the
    # backlog rather than to everything the table has ever held.
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_clickhouse_fallback_drain "
        "ON clickhouse_fallback (failed_at) "
        "WHERE resolved_at IS NULL AND dead_at IS NULL"
    )


def downgrade() -> None:
    if not _table_exists("clickhouse_fallback"):
        return

    # Index first: it references dead_at, so dropping the column while the
    # index exists would need a CASCADE and would silently take the index
    # with it. Explicit order keeps the downgrade free of surprises.
    op.execute("DROP INDEX IF EXISTS idx_clickhouse_fallback_drain")
    op.execute("ALTER TABLE clickhouse_fallback DROP COLUMN IF EXISTS dead_at")
