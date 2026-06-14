"""024_user_intel_sessions — Cat 9 (User Intelligence) v1 ships.

Revision ID: 024
Revises: 023
Create Date: 2026-06-12

Adds the 3 v1 tables that Cat 9 needs on top of the 6 stub tables
declared in 020. The 6 stub tables (``user_goals``,
``user_satisfaction_signals``, ``conversations``,
``conversation_messages``, ``user_feedback``, ``user_segments``)
hold the explicit-feedback substrate; the 3 new tables hold
the *behavioural* substrate that closes the 97% problem.

* ``user_sessions`` — the per-session metrics substrate
  (active/dormant, n_turns, n_traces, abandoned, first_value_at).
  Read by :class:`SessionAnalytics.aggregate` and
  :class:`BehaviouralDashboard.cohort`.
* ``user_behavioural_signals`` — the 7 implicit signals per
  ``(org_id, trace_id)``: regenerated, abandoned_after_one,
  edit_distance, copy_pasted, retried_within_60s, return_7d,
  time_to_first_action_ms. Written by the 6
  ``behavioural/*.track`` services (Cat 9 v2 surface) and
  read by :class:`SatisfactionSignalService.compute` to
  compute the implicit-signal aggregate.
* ``user_satisfaction_corrected`` — the Bayesian
  Hierarchical Beta-Binomial posterior from
  :class:`SelectionBiasCorrector.correct`, stored per
  ``(org_id, trace_id)`` so it's queryable without re-running
  the correction. Per arXiv 2605.12177 (2026), the
  Hierarchical Beta-Binomial correction is within 4-13
  percentage points of true system quality vs. 25-43 for a
  naive explicit-feedback mean.

Conventions
-----------
* All tables include ``org_id VARCHAR(128) NOT NULL`` and
  ``created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()``.
* Every table gets an ``idx_<name>_org (org_id, created_at DESC)``
  index for the per-org time-series access pattern.
* Per-secondary-index tables get an extra lookup index for
  the read pattern the route uses (user + trace lookups).

See ``docs/observability-gap/09-user-intelligence.md``.
"""

from __future__ import annotations

from alembic import op

revision = "024"
down_revision = "023"
branch_labels = None
depends_on = None


def _table(name: str, body: str, extra_index: str = "") -> None:
    op.execute(f"CREATE TABLE IF NOT EXISTS {name} ({body})")
    op.execute(
        f"CREATE INDEX IF NOT EXISTS idx_{name}_org "
        f"ON {name} (org_id, created_at DESC)"
    )
    if extra_index:
        op.execute(extra_index)


def upgrade() -> None:
    # ─── 1. user_sessions ─────────────────────────────────────────
    _table(
        "user_sessions",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        user_id         VARCHAR(128) NOT NULL,
        session_id      VARCHAR(128) NOT NULL,
        first_event_at  TIMESTAMPTZ NOT NULL,
        last_event_at   TIMESTAMPTZ NOT NULL,
        n_turns         INTEGER NOT NULL DEFAULT 0,
        n_traces        INTEGER NOT NULL DEFAULT 0,
        abandoned       BOOLEAN NOT NULL DEFAULT FALSE,
        first_value_at  TIMESTAMPTZ,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_user_sessions_session_id "
        "ON user_sessions (org_id, session_id)",
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_user_sessions_user_recent "
        "ON user_sessions (org_id, user_id, last_event_at DESC)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_user_sessions_abandoned "
        "ON user_sessions (org_id, abandoned) WHERE abandoned"
    )

    # ─── 2. user_behavioural_signals (the 7 implicit signals) ──────
    _table(
        "user_behavioural_signals",
        """
        id                      UUID PRIMARY KEY,
        org_id                  VARCHAR(128) NOT NULL,
        user_id                 VARCHAR(128) NOT NULL,
        trace_id                VARCHAR(128) NOT NULL,
        regenerated             BOOLEAN NOT NULL DEFAULT FALSE,
        abandoned_after_one     BOOLEAN NOT NULL DEFAULT FALSE,
        edit_distance           DOUBLE PRECISION,
        copy_pasted             BOOLEAN NOT NULL DEFAULT FALSE,
        retried_within_60s      BOOLEAN NOT NULL DEFAULT FALSE,
        return_7d               BOOLEAN,
        time_to_first_action_ms INTEGER,
        created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
        "CREATE INDEX IF NOT EXISTS idx_user_behavioural_signals_trace "
        "ON user_behavioural_signals (org_id, trace_id)",
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_user_behavioural_signals_user_recent "
        "ON user_behavioural_signals (org_id, user_id, created_at DESC)"
    )

    # ─── 3. user_satisfaction_corrected (the Bayesian posterior) ───
    _table(
        "user_satisfaction_corrected",
        """
        id                          UUID PRIMARY KEY,
        org_id                      VARCHAR(128) NOT NULL,
        user_id                     VARCHAR(128) NOT NULL,
        trace_id                    VARCHAR(128) NOT NULL,
        naive_mean                  DOUBLE PRECISION,
        bias_corrected_posterior    DOUBLE PRECISION,
        credible_interval_low_95    DOUBLE PRECISION,
        credible_interval_high_95   DOUBLE PRECISION,
        method                      VARCHAR(32) NOT NULL
                                      DEFAULT 'hierarchicalbeta_binomial',
        created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
        "CREATE INDEX IF NOT EXISTS idx_user_satisfaction_corrected_trace "
        "ON user_satisfaction_corrected (org_id, trace_id)",
    )


def downgrade() -> None:
    tables = [
        "user_satisfaction_corrected",
        "user_behavioural_signals",
        "user_sessions",
    ]
    for t in tables:
        op.execute(f"DROP TABLE IF EXISTS {t} CASCADE")
