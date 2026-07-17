"""097_cat23_rls — Phase 2A Cat 23 tenant RLS.

Revision ID: 097a
Revises: 096b
Create Date: 2026-07-13

Renumbered from a duplicate "097" (see 096_debugger_llm_cache.py
for the chain-repair note) — continues from "096b".

Enables row-level security on the Cat 23 (Autonomous Code
Modification) tables created in migration 027. Migration 027
intentionally deferred RLS; this revision lands the
``ENABLE ROW LEVEL SECURITY`` + ``FORCE`` +
``tenant_isolation_<table>`` policy blocks following the
:file:`015_regions_and_rls.py` pattern.

The policy reads the GUC ``app.current_org_id`` which the
middleware sets via ``SET LOCAL`` at the start of every
request, so subsequent queries automatically filter to the
authenticated tenant.

Idempotent: uses ``IF NOT EXISTS`` semantics on the policies
so re-runs on databases that already have them are no-ops.
"""

from __future__ import annotations

from alembic import op

revision = "097a"
down_revision = "096b"
branch_labels = None
depends_on = None

# Cat 23 tables from migration 027 (all carry ``org_id``).
_CAT23_TABLES: tuple[str, ...] = (
    # 8 core
    "repo_connections",
    "code_root_cause_links",
    "proposed_patches",
    "patch_test_runs",
    "pull_requests",
    "post_merge_windows",
    "revert_events",
    "codebase_knowledge_graph",
    # Approval workflow
    "approval_grants",
    "patch_approvals",
    "patch_approval_status",
    "approval_delegations",
    # Auto-approval
    "auto_approval_policies",
    "auto_approval_events",
    "auto_approval_dry_runs",
)


def upgrade() -> None:
    for table in _CAT23_TABLES:
        # Enable RLS (FORCE so even table owners go through
        # the policy in non-superuser contexts).
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
    for table in _CAT23_TABLES:
        op.execute(f"DROP POLICY IF EXISTS tenant_isolation_{table} ON {table}")
        op.execute(f"ALTER TABLE {table} NO FORCE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE {table} DISABLE ROW LEVEL SECURITY")
