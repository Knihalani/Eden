"""012_prompt_canary — Phase 7.2d A/B traffic split for prompt versions.

Revision ID: 012
Revises: 011
Create Date: 2026-06-05

Adds the ``prompt_version_assignments`` table that lets the system
route a configurable percentage of an agent's calls to a candidate
prompt version. The ``PromotionLoop`` (Phase 7.2d) reads these
assignments, watches the per-version call stats, and promotes the
winner to 100% traffic.

Why a separate table (not just a flag on ``prompt_versions``)?
    - Per-tenant traffic splits (so a single customer can be on a
      different variant than the rest of the population)
    - Time-boxed experiments (``expires_at``)
    - Audit trail of who set which assignment and when
    - Multi-experiment parallelism (two candidates can canary against
      the same control at 10% each, total 20%)
"""

from alembic import op

revision = "012"
down_revision = "011"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE IF NOT EXISTS prompt_version_assignments (
            assignment_id   UUID PRIMARY KEY,
            tenant_id       VARCHAR(128) NOT NULL,
            agent           VARCHAR(64) NOT NULL,
            version         INT NOT NULL,
            traffic_pct     INT NOT NULL DEFAULT 100,
            experiment_id   UUID,
            status          VARCHAR(32) NOT NULL DEFAULT 'active',
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            expires_at      TIMESTAMPTZ,
            promoted_at     TIMESTAMPTZ,
            ended_at        TIMESTAMPTZ,
            UNIQUE(tenant_id, agent, version, experiment_id)
        )
    """)

    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_pva_lookup
        ON prompt_version_assignments (tenant_id, agent)
    """)

    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_pva_experiment
        ON prompt_version_assignments (experiment_id)
        WHERE experiment_id IS NOT NULL
    """)

    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_pva_active
        ON prompt_version_assignments (tenant_id, agent, status, traffic_pct)
        WHERE status = 'active'
    """)

    op.execute("""
        CREATE TABLE IF NOT EXISTS prompt_canary_experiments (
            experiment_id   UUID PRIMARY KEY,
            tenant_id       VARCHAR(128) NOT NULL,
            agent           VARCHAR(64) NOT NULL,
            control_version INT NOT NULL,
            candidate_version INT NOT NULL,
            traffic_pct     INT NOT NULL,
            started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            expires_at      TIMESTAMPTZ,
            ended_at        TIMESTAMPTZ,
            status          VARCHAR(32) NOT NULL DEFAULT 'active',
            promoted_at     TIMESTAMPTZ,
            notes           TEXT
        )
    """)

    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_pce_tenant_agent
        ON prompt_canary_experiments (tenant_id, agent, status)
    """)


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_pce_tenant_agent")
    op.execute("DROP TABLE IF EXISTS prompt_canary_experiments")

    op.execute("DROP INDEX IF EXISTS idx_pva_active")
    op.execute("DROP INDEX IF EXISTS idx_pva_experiment")
    op.execute("DROP INDEX IF EXISTS idx_pva_lookup")
    op.execute("DROP TABLE IF EXISTS prompt_version_assignments")
