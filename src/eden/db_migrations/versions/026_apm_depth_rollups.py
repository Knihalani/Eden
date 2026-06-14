"""026_apm_depth_rollups — Cat 22 (APM Depth + Tracing Depth) v1.4 ships.

Revision ID: 026
Revises: 025
Create Date: 2026-06-12

Adds the 3 tables Cat 22 v1.4 needs on top of the existing
``telemetry_events`` schema (which already has the
``attributes`` JSONB column the v1.4 dual-emit + per-step
work writes into):

* ``apm_sampling_decisions`` — the audit log of every
  tail-sampling decision. The :class:`TailSampler` writes
  a sample-of-decisions row (1% of probabilistic + 100%
  of keep/drop) so the portal can explain "why was this
  trace dropped". The dropped-trace counter on the
  buffer is also persisted here as a daily rollup.

* ``apm_k8s_enrichment_log`` — the audit log of every K8s
  enrichment event. The :class:`K8sEnricher` writes a row
  on every successful enrichment (org_id, trace_id,
  sources, fallback_used) so the portal can show the
  "K8s attributes last seen X minutes ago" freshness
  indicator.

* ``trace_step_profile_links`` — the Cat 22 Pyroscope
  ground-truth. One row per ``(org, trace, step)`` tuple,
  keyed by the deterministic ``profile_<sha256[:16]>``
  id. Stores the Pyroscope URL + the sample rate + the
  is_active flag (v0 = False; v1.4.1 = True once the
  gateway SDK lands).

Conventions (per the v1.4 cat-ship pattern, mirrors
:file:`025_closed_loop_actions.py`):
* All tables include ``org_id VARCHAR(128) NOT NULL`` and
  ``created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()``.
* Every table gets an ``idx_<name>_org (org_id, created_at DESC)``
  index for the per-org time-series access pattern.
* A partial index on the hot read path (``profile_id`` on
  the links table) so the portal's profile-drill-down
  is O(1) PK lookup.

See ``docs/eden-observability-gap-roadmap.md`` (Cat 22) and
``docs/observability-gap/22-apm-tracing-depth.md``.
"""

from __future__ import annotations

from alembic import op

revision = "026"
down_revision = "025"
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
    # 1. apm_sampling_decisions — the tail-sampling audit log
    _table(
        "apm_sampling_decisions",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        trace_id        VARCHAR(128) NOT NULL,
        verdict         VARCHAR(16) NOT NULL,
        rule            VARCHAR(64) NOT NULL,
        score           DOUBLE PRECISION NOT NULL DEFAULT 0,
        attributes_json TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
        "CREATE INDEX IF NOT EXISTS idx_apm_sampling_decisions_trace "
        "ON apm_sampling_decisions (org_id, trace_id) "
        "WHERE verdict IN ('keep', 'drop')",
    )

    # 2. apm_k8s_enrichment_log — the K8s enrichment audit log
    _table(
        "apm_k8s_enrichment_log",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        trace_id        VARCHAR(128),
        sources         TEXT,
        fallback_used   BOOLEAN NOT NULL DEFAULT FALSE,
        attributes_json TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
        "CREATE INDEX IF NOT EXISTS idx_apm_k8s_enrichment_log_trace "
        "ON apm_k8s_enrichment_log (org_id, trace_id)",
    )

    # 3. trace_step_profile_links — the Pyroscope ground truth
    #    PK is the deterministic ``profile_<sha256[:16]>`` id
    #    so re-runs dedupe naturally.
    _table(
        "trace_step_profile_links",
        """
        profile_id      VARCHAR(64) PRIMARY KEY,
        id              UUID NOT NULL,
        org_id          VARCHAR(128) NOT NULL,
        trace_id        VARCHAR(128) NOT NULL,
        step_index      INTEGER NOT NULL,
        pyroscope_url   TEXT NOT NULL DEFAULT '',
        sample_rate     DOUBLE PRECISION NOT NULL DEFAULT 0.01,
        is_active       BOOLEAN NOT NULL DEFAULT FALSE,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_trace_step_profile_links_pk "
        "ON trace_step_profile_links (profile_id)",
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS trace_step_profile_links")
    op.execute("DROP TABLE IF EXISTS apm_k8s_enrichment_log")
    op.execute("DROP TABLE IF EXISTS apm_sampling_decisions")
