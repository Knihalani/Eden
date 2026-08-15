"""172 — trace_bookmarks (W4-6 deal-driven bookmarks).

Revision ID: 172_trace_bookmarks
Revises: 171_drop_orphan_schema
Create Date: 2026-08-12

W4-6: personal, per-user trace bookmarks (star a run to revisit later).
One row per ``(org_id, trace_id, user_id)`` triple — so one user's
bookmark does not affect another user's view. The PK enforces uniqueness;
no separate UNIQUE INDEX is needed.

Indexed on ``(org_id, user_id)`` so the ``bookmarked=true`` trace-list
filter is a single narrow range scan (expected cardinality: low tens per
user, never thousands).

RLS: same policy shape as 167 (trace_summaries) — ENABLE without FORCE,
unset-GUC escape — so consumers that run on a plain pool checkout spanning
orgs are not blocked; GUC-carrying portal reads are still confined by
their own ``WHERE org_id = $1``.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "172_trace_bookmarks"
down_revision: str | Sequence[str] | None = "171_drop_orphan_schema"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS trace_bookmarks (
            org_id     VARCHAR(128) NOT NULL,
            trace_id   VARCHAR(128) NOT NULL,
            user_id    VARCHAR(256) NOT NULL,
            created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
            PRIMARY KEY (org_id, trace_id, user_id)
        )
        """
    )
    # The bookmarked-filter path: WHERE org_id = $1 AND user_id = $2
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_trace_bookmarks_org_user "
        "ON trace_bookmarks (org_id, user_id)"
    )

    op.execute("ALTER TABLE trace_bookmarks ENABLE ROW LEVEL SECURITY")
    op.execute(
        """
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_policies
                WHERE schemaname = 'public'
                  AND tablename  = 'trace_bookmarks'
                  AND policyname = 'tenant_isolation_trace_bookmarks'
            ) THEN
                EXECUTE $policy$
                    CREATE POLICY tenant_isolation_trace_bookmarks
                    ON trace_bookmarks
                    FOR ALL
                    TO PUBLIC
                    USING (
                        org_id = current_setting('app.current_org_id', true)
                        OR current_setting('app.current_org_id', true) IS NULL
                    )
                $policy$;
            END IF;
        END $$;
        """
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS trace_bookmarks")
