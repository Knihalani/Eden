"""050 — pr_rejection_memory (Phase 3b not-now memory).

Revision ID: 050
Revises: 049
Create Date: 2026-06-23

Adds the ``pr_rejection_memory`` table that the Cat 23 scheduler
reads before generating a new patch. When a human rejects a
proposed_patch with ``wontfix`` / ``outdated`` / ``user_fixed``,
the rejection is persisted here with a TTL so the same patch isn't
regenerated during the cooldown window.

Schema mirrors the SQL migration at
``migrations/041_cat23_autonomous_code_modification.sql`` (table
#21). All other Cat 23 tables continue to live there.

Why not a new column on ``proposed_patches``? Rejections are
logically orthogonal to patches (one rejection → 0-or-1 patches,
one patch → 0-or-many rejections as it goes through the inbox),
and the not-now memory is queried by (org, file_path, title_hash)
which is a different access pattern than the proposed_patches
PK. The new table is also smaller — no diff/text columns — so
the partial index on (file_path, title_hash) WHERE expires_at > NOW()
fits in a fraction of the proposed_patches footprint.

The TTL is set per rejection_type:
- wontfix      → 30d (codebase intentionally doesn't want this)
- outdated     → 30d (upstream issue no longer relevant)
- user_fixed   → 90d (user already merged their own fix)

Configurable via Settings.patch_rejection_memory_wontfix_days /
.patch_rejection_memory_user_fixed_days.
"""
from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "050"
down_revision: str | Sequence[str] | None = "049"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Create pr_rejection_memory + 3 indexes."""
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS pr_rejection_memory (
            id                       VARCHAR(64) PRIMARY KEY,
            org_id                   VARCHAR(128) NOT NULL,
            file_path                TEXT NOT NULL,
            signal_type              VARCHAR(32) NOT NULL,
            title_hash               VARCHAR(64) NOT NULL,
            rejection_type           VARCHAR(32) NOT NULL,
            rejected_by_user_id      VARCHAR(128),
            reason                   TEXT NOT NULL DEFAULT '',
            expires_at               TIMESTAMPTZ NOT NULL,
            created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_pr_rejection_memory_org "
        "ON pr_rejection_memory (org_id, created_at DESC)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_pr_rejection_memory_active "
        "ON pr_rejection_memory (org_id, file_path, title_hash) "
        "WHERE expires_at > NOW()"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_pr_rejection_memory_expires "
        "ON pr_rejection_memory (expires_at)"
    )


def downgrade() -> None:
    """Drop pr_rejection_memory + indexes."""
    op.execute("DROP INDEX IF EXISTS idx_pr_rejection_memory_expires")
    op.execute("DROP INDEX IF EXISTS idx_pr_rejection_memory_active")
    op.execute("DROP INDEX IF EXISTS idx_pr_rejection_memory_org")
    op.execute("DROP TABLE IF EXISTS pr_rejection_memory")
