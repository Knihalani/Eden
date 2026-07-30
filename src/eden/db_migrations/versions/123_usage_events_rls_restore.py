"""123 — restore tenant isolation on usage_events.

``usage_events`` is the billing table. Migration 002 created it with RLS
enabled, forced, and a ``tenant_isolation_usage_events`` policy. Migration 042
removed all three:

    ALTER TABLE usage_events NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE usage_events DISABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_usage_events ON usage_events;

That was a prerequisite for converting the table to a Timescale hypertable —
the conversion cannot proceed with those objects in place — and it is why the
statements are grouped under "clean up the schema quirks that block the
conversion". The conversion succeeded. The isolation was never put back, so
Eden's cost and quota table has had no row-level tenant boundary since.

This migration restores migration 002's policy verbatim and re-enables RLS.

**Verbatim matters.** The first draft of this file "cleaned up" 002's
``OR current_setting('app.current_org_id', true) IS NULL`` branch. Because a
``FOR ALL`` policy with no ``WITH CHECK`` reuses ``USING`` as its write check,
that would have made every ``bronze_sink`` insert fail RLS — and bronze_sink
swallows the error after three retries, so all usage, cost and quota data would
have been lost with nothing but a warning line. Restoring a dropped policy means
restoring the one that was dropped, not a stricter one written from memory.

**It deliberately does not re-apply ``FORCE``.** ``FORCE ROW LEVEL SECURITY``
subjects the table *owner* to the policy as well. If a read then runs on a
connection where ``app.current_org_id`` was never set, the policy does not
raise — it matches no rows and the query returns empty. A billing endpoint that
silently reports zero usage is worse than one with a boundary that only applies
to non-owner roles, and Eden's ``usage_events`` read paths are not yet all
pinned to a connection carrying the GUC (see ``_request_pg_conn`` in
``eden.storage.postgres``). FORCE is the intended end state; it belongs in a
follow-up that lands together with the connection pinning, not ahead of it.

The policy body matches the convention established by migration 097:
``org_id = current_setting('app.current_org_id', true)``.

Revision ID: 123_usage_events_rls_restore
Revises: 122_judge_watermark_composite
Create Date: 2026-07-29
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "123_usage_events_rls_restore"
down_revision: str | Sequence[str] | None = "122_judge_watermark_composite"
branch_labels = None
depends_on = None


def _table_exists(name: str) -> bool:
    """True when ``name`` exists in the current schema."""
    bind = op.get_bind()
    return bool(
        bind.exec_driver_sql(
            "SELECT 1 FROM information_schema.tables "
            f"WHERE table_schema = current_schema() AND table_name = '{name}'"
        ).scalar()
    )


def _column_type(table: str, column: str) -> str | None:
    """Return the declared type of ``table.column``, or None if absent."""
    bind = op.get_bind()
    return bind.exec_driver_sql(
        "SELECT data_type FROM information_schema.columns "
        f"WHERE table_schema = current_schema() AND table_name = '{table}' "
        f"AND column_name = '{column}'"
    ).scalar()


def upgrade() -> None:
    if not _table_exists("usage_events"):
        return

    op.execute("DROP POLICY IF EXISTS tenant_isolation_usage_events ON usage_events")

    # This restores migration 002's policy *verbatim* (002:249-255), including
    # the ``OR ... IS NULL`` branch. That branch is not slack to be tidied up —
    # it is what makes the policy compatible with Eden's writers, and removing
    # it breaks billing ingestion outright:
    #
    #   For a FOR ALL policy with no WITH CHECK, Postgres reuses USING as the
    #   check expression for INSERT and UPDATE. ``bronze_sink._flush``
    #   (data_platform/bronze_sink.py:194-208) writes usage_events from a
    #   background timer over a plain pool checkout, and one batch spans many
    #   orgs, so ``app.current_org_id`` is unset and *cannot* be set to a single
    #   value. Without the escape hatch every insert raises "new row violates
    #   row-level security policy", bronze_sink retries three times, logs, and
    #   drops the batch — every usage, cost and quota row lost, silently.
    #
    # So the boundary this policy provides is: a connection that *has* set the
    # GUC (every user-facing read — see the RLS middleware in
    # api/middleware/rls_org_context.py) is confined to its own org; trusted
    # background connections that never set it are not. That is the same
    # trade-off all ten of migration 002's policies make, and it is strictly
    # more isolation than the nothing that has been in place since 042.
    #
    # Tightening this to a strict predicate (and adding FORCE) requires pinning
    # every usage_events read *and write* path to a GUC-carrying connection
    # first, including giving bronze_sink a per-org flush. That is the follow-up;
    # doing the policy half of it alone converts a silent read leak into silent
    # write loss, which is worse.
    #
    # ``org_id`` is UUID here so the GUC (always text) needs the cast. The type
    # is read rather than assumed, and both variants are written out in full — an
    # interpolated predicate would keep the actual comparison out of this file,
    # which is the last thing a tenant-isolation policy should do.
    org_type = (_column_type("usage_events", "org_id") or "").lower()
    if org_type == "uuid":
        op.execute(
            """
            CREATE POLICY tenant_isolation_usage_events ON usage_events
            FOR ALL
            TO PUBLIC
            USING (
                org_id = NULLIF(
                    current_setting('app.current_org_id', true), ''
                )::UUID
                OR current_setting('app.current_org_id', true) IS NULL
            )
            """
        )
    else:
        op.execute(
            """
            CREATE POLICY tenant_isolation_usage_events ON usage_events
            FOR ALL
            TO PUBLIC
            USING (
                org_id = current_setting('app.current_org_id', true)
                OR current_setting('app.current_org_id', true) IS NULL
            )
            """
        )
    op.execute("ALTER TABLE usage_events ENABLE ROW LEVEL SECURITY")


def downgrade() -> None:
    if not _table_exists("usage_events"):
        return
    op.execute("ALTER TABLE usage_events DISABLE ROW LEVEL SECURITY")
    op.execute("DROP POLICY IF EXISTS tenant_isolation_usage_events ON usage_events")
