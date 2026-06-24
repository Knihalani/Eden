"""055_prompt_versioning — D.9 prompt versioning schema per upgradespec §B.2.

Revision ID: 055
Revises: 054
Create Date: 2026-06-24

Three new tables per the spec:

* ``prompts`` — the per-org prompt registry. PK is the
  UUID; unique on ``(org_id, name)``.

* ``prompt_versions`` — the version timeline. PK is the
  UUID; unique on ``(prompt_id, version)``. Template
  hash is sha256 of the normalized template so re-runs
  dedupe naturally and the version timeline can show
  byte-identical history.

* ``prompt_eval_runs`` — the auto-eval-on-save history.
  One row per (prompt_version_id, dataset_id) pair.
  Status lifecycle: pending → running → completed|failed.

The migration also adds the nullable
``prompt_version_id`` FK on ``telemetry_events`` so
traces can be attributed to the version that generated
them (no backfill required; existing rows stay NULL).

Conventions (per the v1.4 cat-ship pattern):
* Tables include ``org_id VARCHAR(128) NOT NULL`` and
  ``created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()``.
* Every table gets an ``idx_<name>_org (org_id, created_at DESC)``
  index for the per-org time-series access pattern.
"""

from __future__ import annotations

from alembic import op

revision = "055"
down_revision = "054"
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
    # ── 1. prompts — per-org registry ──────────────────────────────
    _table(
        "prompts",
        """
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id          VARCHAR(128) NOT NULL,
        name            VARCHAR(256) NOT NULL,
        description     TEXT,
        tags            TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
        auto_eval_on_save BOOLEAN NOT NULL DEFAULT FALSE,
        created_by      VARCHAR(128) NOT NULL,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(org_id, name)
        """,
        "CREATE INDEX IF NOT EXISTS idx_prompts_tags "
        "ON prompts USING GIN (tags)",
    )

    # ── 2. prompt_versions — version timeline ──────────────────────
    _table(
        "prompt_versions",
        """
        id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id            VARCHAR(128) NOT NULL,
        prompt_id         UUID NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
        version           INTEGER NOT NULL,
        template          TEXT NOT NULL,
        template_hash     VARCHAR(64) NOT NULL,
        model             VARCHAR(64) NOT NULL,
        params            JSONB NOT NULL DEFAULT '{}'::jsonb,
        variables         JSONB NOT NULL DEFAULT '[]'::jsonb,
        parent_version_id UUID REFERENCES prompt_versions(id),
        change_note       TEXT,
        created_by        VARCHAR(128) NOT NULL,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(prompt_id, version)
        """,
        "CREATE INDEX IF NOT EXISTS idx_prompt_versions_template_hash "
        "ON prompt_versions (template_hash)",
    )

    # ── 3. prompt_eval_runs — auto-eval history ────────────────────
    _table(
        "prompt_eval_runs",
        """
        id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id               VARCHAR(128) NOT NULL,
        prompt_version_id    UUID NOT NULL REFERENCES prompt_versions(id) ON DELETE CASCADE,
        dataset_id           UUID,
        baseline_version_id  UUID REFERENCES prompt_versions(id),
        status               VARCHAR(16) NOT NULL DEFAULT 'pending',
        results              JSONB,
        scores_summary       JSONB,
        n_evaluated          INT NOT NULL DEFAULT 0,
        created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        started_at           TIMESTAMPTZ,
        completed_at         TIMESTAMPTZ,
        CHECK (status IN ('pending', 'running', 'completed', 'failed'))
        """,
        "CREATE INDEX IF NOT EXISTS idx_prompt_eval_runs_version "
        "ON prompt_eval_runs (prompt_version_id, created_at DESC)",
    )

    # ── 4. telemetry_events.prompt_version_id (nullable FK) ────────
    # No backfill — existing rows stay NULL. The portal renders
    # "no version tracked" for NULL prompt_version_id.
    op.execute(
        "ALTER TABLE telemetry_events "
        "ADD COLUMN IF NOT EXISTS prompt_version_id UUID"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_telemetry_prompt_version "
        "ON telemetry_events (prompt_version_id) "
        "WHERE prompt_version_id IS NOT NULL"
    )


def downgrade() -> None:
    op.execute(
        "DROP INDEX IF EXISTS idx_telemetry_prompt_version"
    )
    op.execute(
        "ALTER TABLE telemetry_events DROP COLUMN IF EXISTS prompt_version_id"
    )
    for table in (
        "prompt_eval_runs",
        "prompt_versions",
        "prompts",
    ):
        op.execute(f"DROP TABLE IF EXISTS {table}")