"""165 — drop the two confirmed-dead leftover test tables (P3.3).

Revision ID: 165_drop_dead_test_tables
Revises: 164_vector_documents
Create Date: 2026-08-10

P3.3 (Neon cleanup): the wave plan listed ``test_y``,
``test_part_full_renamed``, ``app_events``, ``clickhouse_fallback`` and
``jobs`` as dead. Live investigation (2026-08-10) found only the first
two are genuinely dead:

* ``app_events`` — **live**: the ``/orgs/{org}/app-events`` ingest route
  writes it.
* ``clickhouse_fallback`` — **live**: ``clickhouse_fallback_drain``
  (``data_platform/clickhouse_fallback_drain.py``) replays rows back
  into ClickHouse on the cron tick.
* ``jobs`` — **live**: ``kb/episodic/client.py`` inserts/updates/selects
  it.

``test_y`` and ``test_part_full_renamed`` have zero code references
(grep across ``src/``, ``scripts/``, ``tests/``), zero rows, and were
created by long-retired partition experiments. Dropping them reclaims
the catalog slots and removes two tables the SQL-schema guard must
otherwise keep modelling.

Both drops are ``IF EXISTS`` so a half-migrated DB recovers with
``alembic upgrade head`` (same idempotency lesson as 077/133/135/163).
Downgrade recreates empty tables with no FKs — safe.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "165_drop_dead_test_tables"
down_revision: str | Sequence[str] | None = "164_vector_documents"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("DROP TABLE IF EXISTS test_y")
    op.execute("DROP TABLE IF EXISTS test_part_full_renamed")


def downgrade() -> None:
    # Recreate as empty, FK-free shells. These tables had no useful
    # schema (partition-experiment leftovers); a bare id column is
    # enough for code that might reference them by name.
    op.execute(
        "CREATE TABLE IF NOT EXISTS test_y (id BIGINT)"
    )
    op.execute(
        "CREATE TABLE IF NOT EXISTS test_part_full_renamed (id BIGINT)"
    )
