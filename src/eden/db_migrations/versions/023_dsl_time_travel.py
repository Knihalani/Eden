"""023_dsl_time_travel — Cat 19 (DSL / EQL) + Cat 20 (Time-Travel) v1.3.

Revision ID: 023
Revises: 022
Create Date: 2026-06-11

Adds the data model for the two remaining v1.3 categories:

* **Cat 19 — Trace Query DSL / EQL** (``eql_alert_rules``,
  ``eql_lint_warnings``): alert-as-code definitions compiled
  from EQL queries, plus a persisted audit log of every lint
  warning the linter surfaces. The :class:`AlertAsCode` service
  writes one row per ``compile_alert`` call; the linter writes
  one row per lint warning on every ``lint`` call so the UI
  can show the customer the warnings before they submit.

* **Cat 20 — Time-Travel Debugging** (``trace_fork_branches``,
  ``trace_replay_steps``): the parent → child lineage of every
  fork the customer creates, and the per-step cache-vs-live
  decision for every replay. The :class:`TraceForker` writes
  one row per fork; the :class:`TraceReplayer` writes one row
  per step per replay.

Conventions
-----------
* All tables include ``org_id VARCHAR(128) NOT NULL`` and
  ``created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()``.
* Every table gets an ``idx_<name>_org (org_id, created_at DESC)``
  index for the per-org time-series access pattern.
* Per-secondary-index tables get an extra lookup index for
  the read pattern the route / closed-loop wiring uses.

See ``docs/observability-gap/19-trace-query-dsl.md`` and
``docs/observability-gap/20-time-travel-debugging.md``.
"""

from __future__ import annotations

from alembic import op

revision = "023"
down_revision = "022"
branch_labels = None
depends_on = None


# Mirror the pattern in 021 / 022 so the downgrade / upgrade
# shapes stay in lockstep. Centralised so adding a new table is
# a 2-line edit, not 6.
def _table(name: str, body: str, extra_index: str = "") -> None:
    op.execute(f"CREATE TABLE IF NOT EXISTS {name} ({body})")
    op.execute(
        f"CREATE INDEX IF NOT EXISTS idx_{name}_org "
        f"ON {name} (org_id, created_at DESC)"
    )
    if extra_index:
        op.execute(extra_index)


def upgrade() -> None:
    # ─── Cat 19 — Trace Query DSL / EQL ─────────────────────────
    # 1. eql_alert_rules — alert-as-code definitions compiled
    #    from EQL. The :class:`AlertAsCode.compile` service
    #    writes one row per call; the route reads from the same
    #    table on the GET. The (org_id, enabled, next_fire_at)
    #    index is the cron watchdog's hot path — it queries
    #    ``WHERE enabled = true AND next_fire_at <= now()``
    #    every 60s.
    _table(
        "eql_alert_rules",
        """
        id                  UUID PRIMARY KEY,
        org_id              VARCHAR(128) NOT NULL,
        -- Customer-facing identifier (e.g. "eql_alert_abc").
        alert_id            VARCHAR(128) NOT NULL UNIQUE,
        name                VARCHAR(128) NOT NULL,
        -- The original EQL query (SQL with optional
        -- root./parent./any. prefixes). Preserved for the
        -- "edit alert" UI path.
        eql_query           TEXT NOT NULL,
        -- The compiled ClickHouse SQL (the form the cron
        -- watchdog actually executes). Stale by definition
        -- after the alert is recompiled; the audit log
        -- captures the recompile events.
        clickhouse_sql      TEXT NOT NULL,
        -- The EQL shape — 'traces' | 'spans' | 'summary'.
        -- Default 'traces' (Braintrust parity).
        shape               VARCHAR(16) NOT NULL DEFAULT 'traces',
        -- How often the alert fires (seconds). Minimum 60
        -- enforced at the service layer.
        interval_seconds    INT NOT NULL DEFAULT 3600,
        -- info | warning | high | critical.
        severity            VARCHAR(16) NOT NULL,
        -- Audit fields — the cron watchdog updates these.
        last_fired_at       TIMESTAMPTZ,
        next_fire_at        TIMESTAMPTZ,
        -- Kill switch. Disabled alerts do not fire.
        enabled             BOOLEAN NOT NULL DEFAULT true,
        -- Closed-loop: 'pending' | 'active' | 'auto_disabled'.
        -- 'auto_disabled' is set by the watchdog when the
        -- alert times out 3 times in a row (Braintrust
        -- parity; "log alert" behaviour).
        lifecycle_status    VARCHAR(16) NOT NULL DEFAULT 'active',
        -- The number of times this alert has fired. Useful
        -- for the per-org usage rollup.
        n_fired             BIGINT NOT NULL DEFAULT 0,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
        "CREATE INDEX IF NOT EXISTS idx_eql_alert_rules_watchdog "
        "ON eql_alert_rules (org_id, enabled, next_fire_at)",
    )

    # 2. eql_lint_warnings — persisted audit log of every lint
    #    warning the linter surfaces. The customer sees the
    #    warnings on the response, but we also persist them so
    #    the UI can show "this query has fired these warnings
    #    10 times this month" — the path to "stop shipping
    #    queries with NO_FILTERS".
    _table(
        "eql_lint_warnings",
        """
        id                  UUID PRIMARY KEY,
        org_id              VARCHAR(128) NOT NULL,
        -- The query the linter ran on (truncated to 1k chars
        -- so a 100kB adversarial query can't bloat the table).
        query               TEXT NOT NULL,
        -- NO_FILTERS | ANY_SPAN_OVERUSE | MISSING_ORG |
        -- SHAPE_MISMATCH.
        warning_code        VARCHAR(32) NOT NULL,
        -- info | warning | error.
        severity            VARCHAR(16) NOT NULL,
        message             TEXT NOT NULL,
        -- The lint mode the customer used — 'default' returns
        -- the warnings; 'strict' blocks. Persisted so the
        -- audit log captures the customer's choice.
        lint_mode           VARCHAR(16) NOT NULL DEFAULT 'default',
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
        "CREATE INDEX IF NOT EXISTS idx_eql_lint_warnings_code "
        "ON eql_lint_warnings (org_id, warning_code)",
    )

    # ─── Cat 20 — Time-Travel Debugging ────────────────────────
    # 3. trace_fork_branches — the parent → child lineage of
    #    every fork. The fork_id is the customer-facing
    #    identifier ("frk_<uuid>"); parent_fork_id is NULL for
    #    the first fork and the fork's own fork_id for a
    #    fork-of-fork. The (org_id, parent_trace_id) index is
    #    the "list forks for this trace" route.
    _table(
        "trace_fork_branches",
        """
        id                  UUID PRIMARY KEY,
        org_id              VARCHAR(128) NOT NULL,
        -- Customer-facing identifier ("frk_xxxxxxxxxxxx").
        fork_id             VARCHAR(128) NOT NULL UNIQUE,
        -- The trace being forked. References
        -- telemetry_events.trace_id (no FK so the table can
        -- outlive a telemetry_events retention).
        parent_trace_id     VARCHAR(128) NOT NULL,
        -- NULL for the first fork; non-NULL for fork-of-fork.
        parent_fork_id      VARCHAR(128),
        -- The step the customer chose to fork at. The
        -- replayer serves steps 1..N-1 from cache.
        fork_at_step        INT NOT NULL,
        name                VARCHAR(256) NOT NULL,
        -- The edits applied at fork time, JSON-encoded. The
        -- replayer reads this so a replay is reproducible
        -- even if the customer later edits the fork.
        edits_json          TEXT,
        -- Aggregate counters. n_replays is incremented on
        -- each successful replay; last_replay_outcome tracks
        -- the latest result so the list-forks route can show
        -- the success/fail rate per fork.
        n_replays           BIGINT NOT NULL DEFAULT 0,
        last_replay_outcome VARCHAR(16),
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
        "CREATE INDEX IF NOT EXISTS idx_trace_fork_branches_parent "
        "ON trace_fork_branches (org_id, parent_trace_id)",
    )

    # 4. trace_replay_steps — per-step cache-vs-live decision
    #    for every replay. The (org_id, replay_id, step_index)
    #    index is the diff route's hot path.
    _table(
        "trace_replay_steps",
        """
        id                  UUID PRIMARY KEY,
        org_id              VARCHAR(128) NOT NULL,
        -- Customer-facing identifier ("rpl_xxxxxxxxxxxx").
        replay_id           VARCHAR(128) NOT NULL,
        fork_id             VARCHAR(128) NOT NULL,
        step_index          INT NOT NULL,
        -- True if the step was served from cache; False if
        -- it was re-executed live. The diff route reads this
        -- to render the side-by-side timeline.
        served_from_cache   BOOLEAN NOT NULL,
        -- The cache key the recorder wrote. NULL when the
        -- step was not cacheable.
        cache_key           TEXT,
        -- True if the step was re-executed live (always
        -- True for steps at/after fork_at_step; sometimes
        -- True for steps before the fork that had a cache
        -- miss).
        re_executed         BOOLEAN NOT NULL,
        -- The hash of the response (matches the
        -- telemetry_events.response_hash convention). NULL
        -- when the step was not cacheable.
        response_hash       TEXT,
        -- The token + cost tallies for the live step. 0
        -- for cache-served steps.
        tokens_used         INT NOT NULL DEFAULT 0,
        cost_usd            DOUBLE PRECISION NOT NULL DEFAULT 0.0,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
        "CREATE INDEX IF NOT EXISTS idx_trace_replay_steps_replay "
        "ON trace_replay_steps (org_id, replay_id, step_index)",
    )


def downgrade() -> None:
    # Drop in reverse dependency order.
    op.execute("DROP INDEX IF EXISTS idx_trace_replay_steps_replay")
    op.execute("DROP INDEX IF EXISTS idx_trace_fork_branches_parent")
    op.execute("DROP INDEX IF EXISTS idx_eql_lint_warnings_code")
    op.execute("DROP INDEX IF EXISTS idx_eql_alert_rules_watchdog")
    op.execute("DROP INDEX IF EXISTS idx_trace_replay_steps_org")
    op.execute("DROP INDEX IF EXISTS idx_trace_fork_branches_org")
    op.execute("DROP INDEX IF EXISTS idx_eql_lint_warnings_org")
    op.execute("DROP INDEX IF EXISTS idx_eql_alert_rules_org")
    op.execute("DROP TABLE IF EXISTS trace_replay_steps")
    op.execute("DROP TABLE IF EXISTS trace_fork_branches")
    op.execute("DROP TABLE IF EXISTS eql_lint_warnings")
    op.execute("DROP TABLE IF EXISTS eql_alert_rules")
