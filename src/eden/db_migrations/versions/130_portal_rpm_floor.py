"""130 — Raise free-tier portal RPM floor (60 → 300).

Revision ID: 130_portal_rpm_floor
Revises: 129_dataset_columns
Create Date: 2026-08-01

Portal hubs fan out many React Query GETs against the shared org bucket.
Free/org_free rows stuck at 60 requests_per_minute caused live "Too many
requests" errors during normal navigation. Align snapshot rows with
plan_tiers (300 rpm / 8000 rph). API-key traffic still uses the tighter
middleware path when a key is present.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "130_portal_rpm_floor"
down_revision: str | Sequence[str] | None = "129_dataset_columns"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        UPDATE org_resource_limits
        SET
            requests_per_minute = 300,
            requests_per_hour = GREATEST(COALESCE(requests_per_hour, 0), 8000),
            updated_at = NOW()
        WHERE plan_name IN ('free', 'org_free')
          AND COALESCE(requests_per_minute, 0) < 300
        """
    )


def downgrade() -> None:
    op.execute(
        """
        UPDATE org_resource_limits
        SET
            requests_per_minute = 60,
            requests_per_hour = 2000,
            updated_at = NOW()
        WHERE plan_name IN ('free', 'org_free')
          AND requests_per_minute = 300
        """
    )
