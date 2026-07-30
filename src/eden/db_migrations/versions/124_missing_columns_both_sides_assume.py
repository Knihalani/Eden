"""124 — add the columns and table that application code already assumes.

The SQL-vs-DDL guard was extended to check *bare* column references in
single-table statements (it previously checked only ``alias.column``, which a
single-table query never produces). That surfaced 106 references to columns no
migration had ever created. Most were misnamings, fixed in the reading code.
These are different: the column is genuinely absent, and the code that
*writes* the row (or a test that asserts the behaviour) assumes it too, so
there is nothing to rename towards.

``eden_component_heartbeats.checked_at``
    The table was created with ``component, org_id, status, meta`` and no
    timestamp. Both ``self_obs/heartbeats.py`` inserts name ``checked_at`` in
    their column list, so *the write itself* has always raised
    ``UndefinedColumn`` — and it is wrapped in
    ``except Exception: logger.debug("heartbeat persist skipped")``. The
    self-observability heartbeat has therefore never recorded a single row, and
    the three readers that order by ``checked_at`` had nothing to read anyway. A
    heartbeat table without a time column cannot answer the only question it
    exists for ("when did we last hear from this component?").

``users.email_verified``
    ``POST /auth/signup`` inserts ``(email, password_hash, name,
    email_verified)``. With no such column the INSERT raises, the handler's
    ``except`` sees a message that is not "unique"/"duplicate", and every
    email/password signup returns 503 "Failed to create user". The column is the
    fix; the alternative (dropping it from the INSERT) would silently mark new
    accounts verified, which is the opposite of the audit note at that call site.

``jobs.current_stage`` and ``jobs.archivist_summary``
    ``current_stage`` is selected by ``PostgresClient.get_job`` and read by the
    live progress paths (``api/routes/websocket.py``, ``realtime/mobile_sse.py``),
    so the absent column failed the whole SELECT and broke every job-progress
    subscription rather than merely omitting a field. ``archivist_summary`` is in
    the INSERT column list of ``kb/episodic/client.py`` and declared on the job
    response model, so that insert could never succeed either.

``lineage_runs.org_id`` and ``retrieval_logs.org_id``
    Both tables were created with no tenant column, and five reader queries each
    filter on ``org_id``. So the reads were broken *and* the rows were untenanted
    — a table with no org boundary is a cross-tenant leak waiting for the first
    query that forgets to filter. Added nullable: existing rows have no
    recoverable owner, and a NULL cannot match ``org_id = $1``, so legacy rows
    stay invisible rather than leaking to whoever asks first. The writers are
    updated in the same change to populate it going forward.

Revision ID: 124_missing_columns_both_sides_assume
Revises: 123_usage_events_rls_restore
Create Date: 2026-07-30
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "124_missing_columns_both_sides_assume"
down_revision: str | Sequence[str] | None = "123_usage_events_rls_restore"
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


def upgrade() -> None:
    # ── eden_component_heartbeats.checked_at ──────────────────────────
    if _table_exists("eden_component_heartbeats"):
        op.execute(
            """
            ALTER TABLE eden_component_heartbeats
            ADD COLUMN IF NOT EXISTS checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            """
        )
        # The readers all want the newest row per component within an org.
        op.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_heartbeats_org_component_checked
            ON eden_component_heartbeats (org_id, component, checked_at DESC)
            """
        )

    # ── users.email_verified ──────────────────────────────────────────
    if _table_exists("users"):
        # DEFAULT FALSE, so existing accounts are not silently promoted to
        # verified by this migration. They predate the flag; treating them as
        # unverified is the safe reading, and the signup path sets FALSE
        # explicitly for new ones.
        op.execute(
            """
            ALTER TABLE users
            ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE
            """
        )

    # ── lineage_runs.org_id ───────────────────────────────────────────
    if _table_exists("lineage_runs"):
        op.execute(
            "ALTER TABLE lineage_runs ADD COLUMN IF NOT EXISTS org_id VARCHAR(128)"
        )
        op.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_lineage_runs_org_recorded
            ON lineage_runs (org_id, recorded_at DESC)
            """
        )

    # ── jobs.current_stage, jobs.archivist_summary ────────────────────
    if _table_exists("jobs"):
        # ``current_stage`` is read by the live job-progress paths
        # (api/routes/websocket.py:605,610,632 and realtime/mobile_sse.py:354)
        # and selected by ``PostgresClient.get_job``. With the column absent that
        # SELECT raised, so *every* websocket/SSE job-progress subscription
        # failed rather than merely missing a field.
        op.execute("ALTER TABLE jobs ADD COLUMN IF NOT EXISTS current_stage TEXT")
        # ``archivist_summary`` is in the INSERT column list of
        # ``kb/episodic/client.py`` and declared on the job response model
        # (api/app.py:349), so the insert itself could never succeed.
        op.execute("ALTER TABLE jobs ADD COLUMN IF NOT EXISTS archivist_summary JSONB")

    # ── org_pii_patterns ──────────────────────────────────────────────
    #
    # ``SecurityScanner._fetch_patterns`` read
    # ``SELECT pattern_name, regex FROM org_pii_policies WHERE enabled = TRUE``.
    # ``org_pii_policies`` (migration 013) is a *category*-based, one-row-per-org
    # table — categories, enabled_categories, mode, extra_redact_keys — with no
    # per-pattern regex at any grain, so that query raised on every scan and the
    # handler fell back to the built-in defaults.
    #
    # The feature is not a mistake, though: there is a test asserting a tenant
    # can supply a custom regex and have it override a default, and it passed
    # because its fake Postgres returned rows regardless of the SQL. So the
    # promise was documented and tested, the storage simply never existed — the
    # worst combination for a redaction control, because an operator adding a
    # pattern would see it accepted and silently not applied.
    #
    # Per-pattern rows are a different grain from org_pii_policies, so they get
    # their own table rather than more columns on that one.
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS org_pii_patterns (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id VARCHAR(128) NOT NULL,
            pattern_name TEXT NOT NULL,
            regex TEXT NOT NULL,
            enabled BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (org_id, pattern_name)
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_org_pii_patterns_org_enabled
        ON org_pii_patterns (org_id) WHERE enabled
        """
    )

    # ── retrieval_logs.org_id ─────────────────────────────────────────
    if _table_exists("retrieval_logs"):
        op.execute(
            "ALTER TABLE retrieval_logs ADD COLUMN IF NOT EXISTS org_id VARCHAR(128)"
        )
        op.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_retrieval_logs_org_created
            ON retrieval_logs (org_id, created_at DESC)
            """
        )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS org_pii_patterns")
    if _table_exists("retrieval_logs"):
        op.execute("DROP INDEX IF EXISTS idx_retrieval_logs_org_created")
        op.execute("ALTER TABLE retrieval_logs DROP COLUMN IF EXISTS org_id")
    if _table_exists("lineage_runs"):
        op.execute("DROP INDEX IF EXISTS idx_lineage_runs_org_recorded")
        op.execute("ALTER TABLE lineage_runs DROP COLUMN IF EXISTS org_id")
    if _table_exists("jobs"):
        op.execute("ALTER TABLE jobs DROP COLUMN IF EXISTS archivist_summary")
        op.execute("ALTER TABLE jobs DROP COLUMN IF EXISTS current_stage")
    if _table_exists("users"):
        op.execute("ALTER TABLE users DROP COLUMN IF EXISTS email_verified")
    if _table_exists("eden_component_heartbeats"):
        op.execute("DROP INDEX IF EXISTS idx_heartbeats_org_component_checked")
        op.execute(
            "ALTER TABLE eden_component_heartbeats DROP COLUMN IF EXISTS checked_at"
        )
