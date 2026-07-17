"""098_cat23_deferred_tables — Cat 23 Gate 4b deferred tables.

Revision ID: 098a
Revises: 097b
Create Date: 2026-07-13

Renumbered from a duplicate "098" (see 096_debugger_llm_cache.py
for the chain-repair note) — continues from "097b".

Adds the three Cat 23 tables that were commented out in
migration 027 (upgradespec §D.7):

* ``agent_persona_config`` — per-org Eden Agent persona
* ``repo_style_profiles`` — per-repo style profile
* ``patch_review_actions`` — per-review-action audit row

``agent_activity_events`` already landed in revision 095.

Idempotent: ``CREATE TABLE IF NOT EXISTS`` so re-runs on
databases that already have them are no-ops. Also enables
tenant RLS matching migration 097's pattern.
"""

from __future__ import annotations

from alembic import op

revision = "098a"
down_revision = "097b"
branch_labels = None
depends_on = None

_TABLES: tuple[str, ...] = (
    "agent_persona_config",
    "repo_style_profiles",
    "patch_review_actions",
)


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS agent_persona_config (
            id                          VARCHAR(64)   PRIMARY KEY,
            org_id                      VARCHAR(128)  NOT NULL,
            display_name                VARCHAR(256)  NOT NULL DEFAULT 'Eden Agent',
            avatar                      VARCHAR(128)  NOT NULL DEFAULT 'eden-mark',
            voice                       VARCHAR(64)   NOT NULL DEFAULT 'concise',
            track_record_visible_to     JSONB,
            commit_message_style        VARCHAR(64)   NOT NULL DEFAULT 'conventional-commits',
            pr_body_template            VARCHAR(64)   NOT NULL DEFAULT 'default',
            created_at                  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
            updated_at                  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_agent_persona_config_org "
        "ON agent_persona_config (org_id, created_at DESC)"
    )

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS repo_style_profiles (
            id                          VARCHAR(64)   PRIMARY KEY,
            org_id                      VARCHAR(128)  NOT NULL,
            repo_id                     VARCHAR(64)   NOT NULL,
            indentation                 JSONB,
            type_hints_style            VARCHAR(64)   NOT NULL DEFAULT 'pep484',
            naming_convention           JSONB,
            import_style                VARCHAR(64)   NOT NULL DEFAULT 'absolute',
            error_handling              VARCHAR(64)   NOT NULL DEFAULT 'exceptions',
            logging_style               VARCHAR(64)   NOT NULL DEFAULT 'stdlib-logging',
            docstring_style             VARCHAR(64)   NOT NULL DEFAULT 'google',
            test_framework              VARCHAR(64)   NOT NULL DEFAULT 'pytest',
            lint_config                 JSONB,
            complexity_median           INT           NOT NULL DEFAULT 5,
            architecture_patterns       JSONB,
            last_learned_at             TIMESTAMPTZ,
            last_learned_from_pr_id     VARCHAR(64),
            created_at                  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_repo_style_profiles_org "
        "ON repo_style_profiles (org_id, created_at DESC)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_repo_style_profiles_repo "
        "ON repo_style_profiles (org_id, repo_id)"
    )

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS patch_review_actions (
            id                          VARCHAR(64)   PRIMARY KEY,
            org_id                      VARCHAR(128)  NOT NULL,
            patch_id                    VARCHAR(64)   NOT NULL,
            action                      VARCHAR(64)   NOT NULL,
            actor_user_id               VARCHAR(128)  NOT NULL,
            comment                     TEXT          NOT NULL DEFAULT '',
            reason                      TEXT          NOT NULL DEFAULT '',
            edited_diff                 TEXT,
            version_after               INT,
            created_at                  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_patch_review_actions_org "
        "ON patch_review_actions (org_id, created_at DESC)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_patch_review_actions_patch "
        "ON patch_review_actions (org_id, patch_id)"
    )

    # Tenant RLS — same pattern as 097_cat23_rls.
    for table in _TABLES:
        op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY")
        op.execute(f"""
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM pg_policies
                    WHERE schemaname = 'public'
                      AND tablename = '{table}'
                      AND policyname = 'tenant_isolation_{table}'
                ) THEN
                    EXECUTE $policy$
                        CREATE POLICY tenant_isolation_{table} ON {table}
                        USING (org_id = current_setting('app.current_org_id', true))
                    $policy$;
                END IF;
            END $$;
        """)


def downgrade() -> None:
    for table in reversed(_TABLES):
        op.execute(f"DROP POLICY IF EXISTS tenant_isolation_{table} ON {table}")
        op.execute(f"DROP TABLE IF EXISTS {table}")
