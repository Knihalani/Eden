"""048 — add users.avatar_url column.

The June 2026 Clerk cutover shipped a half-finished schema: the
``/auth/me`` auto-provision, the ``/webhooks/clerk`` ``user.created``
handler, and the ``/auth/users/me`` PATCH endpoint all reference
``users.avatar_url`` as if the column existed, but the matching
``ALTER TABLE users ADD COLUMN avatar_url TEXT`` migration was
never written. Every rich INSERT in those code paths has been
failing with ``UndefinedColumnError: column "avatar_url" of
relation "users" does not exist`` for every new Clerk signup since
the cutover. The auto-provision has a bare-minimum fallback that
hides the bug, but the webhook ``user.created`` delivery shows
up in the Clerk dashboard as a 500 error — which is the
"webhook sending has been failing" symptom the operator saw.

This migration adds the missing column. Non-destructive: existing
rows get NULL (no avatar). The Clerk avatar URL is ~150 chars
so TEXT (unlimited) is safe; a ``max_length`` check is enforced
at the API layer via Pydantic.

The down_revision stays on ``047`` because the previous
``down_revision = "046"`` was correct only for the original
``047`` revision id. Adding 048 lets the migration chain
continue to be linear + ordered.

Revision ID: 048
Revises: 047
Create Date: 2026-06-22
"""

from __future__ import annotations

import logging

from alembic import op

logger = logging.getLogger(__name__)


revision = "048"
down_revision = "047"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT"
    )


def downgrade() -> None:
    op.execute("ALTER TABLE users DROP COLUMN IF EXISTS avatar_url")
