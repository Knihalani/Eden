"""064 — add ``organizations.clerk_org_id`` (drift fix for raw SQL 038)

Revision ID: 064
Revises: 063
Create Date: 2026-06-27

Drift fix. The raw SQL migration ``migrations/038_org_clerk_id.sql``
was authored and the webhook handlers at
``src/eden/api/routes/clerk_webhooks.py`` (``_upsert_org``,
``_upsert_membership``, ``_delete_membership``) were updated to
reference ``organizations.clerk_org_id``, but **no alembic revision
was created**. ``alembic upgrade head`` ran 047 (the matching
``users.clerk_id`` fix) but skipped 038, so the column never
existed in production. Every ``/webhooks/clerk`` delivery since
the cutover returned 500 with ``UndefinedColumnError: column
"clerk_org_id" does not exist`` — visible in the 2026-06-26 →
2026-06-27 logs for ``organization.created``,
``organizationMembership.created``, and
``organizationMembership.deleted``.

This revision runs the same SQL as the raw 038 file. Two layers of
defense:

1. ``ADD COLUMN IF NOT EXISTS`` — safe to re-run if 038 was
   applied manually before this alembic revision lands. The IF
   NOT EXISTS guard means no error and noop.
2. ``CREATE UNIQUE INDEX IF NOT EXISTS … WHERE clerk_org_id IS
   NOT NULL`` — partial unique so the column may be NULL for
   legacy webhook-created rows that pre-date the Clerk cutover
   (``organizations.id`` IS the Clerk id for those rows; the
   read helper at
   ``src/eden/api/utils/clerk_client.py:resolve_clerk_org_id``
   falls back to ``organizations.id`` when this column is NULL).

The downgrade drops both. Note: dropping the column will break
the live webhook code path until it is re-added, so a downgrade
must be paired with a redeploy that doesn't reference
``clerk_org_id``.
"""
from alembic import op

revision = "064"
down_revision = "063"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE organizations "
        "ADD COLUMN IF NOT EXISTS clerk_org_id TEXT"
    )
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_organizations_clerk_org_id "
        "ON organizations (clerk_org_id) WHERE clerk_org_id IS NOT NULL"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_organizations_clerk_org_id")
    op.execute("ALTER TABLE organizations DROP COLUMN IF EXISTS clerk_org_id")