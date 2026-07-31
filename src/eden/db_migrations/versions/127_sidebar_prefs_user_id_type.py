"""127 — align sidebar_prefs.user_id with live users.id (TEXT vs UUID).

Revision ID: 127_sidebar_prefs_user_id_type
Revises: 126_ai_conversations
Create Date: 2026-07-31

Migration 063 created ``sidebar_prefs.user_id`` as UUID. Neon later
widened ``users.id`` to TEXT (Clerk). Migration 117 used
``CREATE TABLE IF NOT EXISTS`` with TEXT, which is a no-op when the
063 table already exists — so prod can stay UUID while the route binds
Clerk/Eden TEXT ids → ``invalid input syntax for type uuid``.

Probe ``users.id`` / ``organizations.id`` and ALTER columns when the
live types diverge. Empty tables only (USING cast) — prefs are
per-user UI state, not critical telemetry.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op
from sqlalchemy import text

revision: str = "127_sidebar_prefs_user_id_type"
down_revision: str | Sequence[str] | None = "126_ai_conversations"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _col_data_type(table: str, column: str) -> str | None:
    row = (
        op.get_bind()
        .execute(
            text(
                """
            SELECT data_type
            FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND table_name = :table
              AND column_name = :column
            """
            ),
            {"table": table, "column": column},
        )
        .fetchone()
    )
    if row is None:
        return None
    return (row[0] or "").lower()


def _users_id_sql_type() -> str:
    data_type = _col_data_type("users", "id")
    if data_type in ("text", "character varying", "varchar"):
        return "TEXT"
    return "UUID"


def _orgs_id_sql_type() -> str:
    data_type = _col_data_type("organizations", "id")
    if data_type in ("text", "character varying", "varchar"):
        return "TEXT"
    return "UUID"


def upgrade() -> None:
    if _col_data_type("sidebar_prefs", "user_id") is None:
        # Table missing — create with live types (same as 117 intent).
        user_id_type = _users_id_sql_type()
        org_id_type = _orgs_id_sql_type()
        op.execute(
            f"""
            CREATE TABLE IF NOT EXISTS sidebar_prefs (
                user_id    {user_id_type} NOT NULL,
                org_id     {org_id_type} NOT NULL,
                prefs      JSONB NOT NULL,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                PRIMARY KEY (user_id, org_id)
            )
            """
        )
        op.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_sidebar_prefs_org_id
                ON sidebar_prefs (org_id)
            """
        )
        return

    want_user = _users_id_sql_type()
    want_org = _orgs_id_sql_type()
    have_user = _col_data_type("sidebar_prefs", "user_id") or ""
    have_org = _col_data_type("sidebar_prefs", "org_id") or ""

    user_is_text = have_user in ("text", "character varying", "varchar")
    org_is_text = have_org in ("text", "character varying", "varchar")
    want_user_text = want_user == "TEXT"
    want_org_text = want_org == "TEXT"

    if user_is_text != want_user_text:
        op.execute(
            f"""
            ALTER TABLE sidebar_prefs
            ALTER COLUMN user_id TYPE {want_user}
            USING user_id::text
            """
            if want_user_text
            else """
            ALTER TABLE sidebar_prefs
            ALTER COLUMN user_id TYPE UUID
            USING user_id::uuid
            """
        )

    if org_is_text != want_org_text:
        op.execute(
            f"""
            ALTER TABLE sidebar_prefs
            ALTER COLUMN org_id TYPE {want_org}
            USING org_id::text
            """
            if want_org_text
            else """
            ALTER TABLE sidebar_prefs
            ALTER COLUMN org_id TYPE UUID
            USING org_id::uuid
            """
        )


def downgrade() -> None:
    pass
