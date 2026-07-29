"""121 — eden_leader_leases: a leader-election backend that is not Redis.

Every background loop elected through a single Redis lock. On 2026-07-29
that proved to be a single point of total failure: the Upstash free tier's
monthly request cap was reached ("max requests limit exceeded. Limit:
500000, Usage: 500000"), and past the limit Upstash serves reads while
silently discarding writes. ``SET NX`` returned null, so every lock read
as "refused" while nothing held it, no loop could start, and the whole
annotate/evaluate/improve half of the product was down for 7.4 days —
with ``PING`` still succeeding, so nothing reported a problem.

Postgres was healthy the entire time. This table backs
``eden.storage.pg_lease``, which ``eden.workers.leader`` falls back to
when Redis cannot accept writes. Redis stays the primary (it is cheaper
and the fleet is tuned for it); this is the escape hatch.

Revision ID: 121_leader_leases
Revises: 120_guardrail_policies_direction
Create Date: 2026-07-29
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "121_leader_leases"
down_revision: str | Sequence[str] | None = "120_guardrail_policies_direction"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS eden_leader_leases (
            lock_name  TEXT PRIMARY KEY,
            holder     TEXT NOT NULL,
            expires_at TIMESTAMPTZ NOT NULL
        )
        """
    )
    # Expired-lease sweeps and the "who holds this" read both filter on
    # expiry; the table is tiny (one row per loop) but the index keeps the
    # acquire path an index lookup rather than a scan as loops are added.
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_eden_leader_leases_expires
        ON eden_leader_leases (expires_at)
        """
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_eden_leader_leases_expires")
    op.execute("DROP TABLE IF EXISTS eden_leader_leases")
