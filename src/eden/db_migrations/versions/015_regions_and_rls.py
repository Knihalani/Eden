"""015_regions_and_rls — Phase 7.3c + 7.3e region + RLS.

Revision ID: 015
Revises: 014
Create Date: 2026-06-05

Adds:
  - `organizations.region` column (3c): tenants pick a region for
    data residency. The actual cross-region routing is a separate
    large project; this just plumbs the metadata.
  - Row-level security policies on observability tables (3e) using
    the same `current_setting('app.current_org_id', true)` GUC
    pattern that `org_resource_limits` already uses. The middleware
    issues `SET LOCAL app.current_org_id = $1` at the start of every
    request, so subsequent queries that join these tables
    automatically filter to the authenticated tenant.

The migration is intentionally idempotent: a fresh database gets the
policies; an existing one with a different RLS posture is
unaffected. We use IF NOT EXISTS semantics on the policies.
"""

from alembic import op

revision = "015"
down_revision = "014"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ── 3c: organizations.region ──
    op.execute("""
        ALTER TABLE organizations
        ADD COLUMN IF NOT EXISTS region VARCHAR(8)
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_organizations_region
        ON organizations (region)
        WHERE region IS NOT NULL
    """)

    # ── 3e: Row-level security on observability tables ──
    # Postgres RLS must be enabled per-table and per-policy. The
    # policy reads the GUC `app.current_org_id` which the middleware
    # sets via `SET LOCAL` at the start of every request.
    for table in (
        "telemetry_events",
        "judge_scores",
        "telemetry_stream_chunks",
        "telemetry_media_blobs",
    ):
        # Enable RLS (does NOT lock out the table owner; superuser
        # bypasses; we use FORCE so even table owners go through
        # the policy in non-superuser contexts).
        op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY")
        # Create the isolation policy. We use IF NOT EXISTS so the
        # migration is idempotent on databases that already have it.
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
                        USING (tenant_id = current_setting('app.current_org_id', true))
                    $policy$;
                END IF;
            END $$;
        """)

    # silver_events and data_retention_log also have org_id columns
    # (added in earlier migrations). Enable RLS on them too.
    for table in ("silver_events", "data_retention_log"):
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
    for table in (
        "telemetry_events", "judge_scores", "telemetry_stream_chunks",
        "telemetry_media_blobs", "silver_events", "data_retention_log",
    ):
        op.execute(f"DROP POLICY IF EXISTS tenant_isolation_{table} ON {table}")
        op.execute(f"ALTER TABLE {table} NO FORCE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE {table} DISABLE ROW LEVEL SECURITY")
    op.execute("DROP INDEX IF EXISTS idx_organizations_region")
    op.execute("ALTER TABLE organizations DROP COLUMN IF EXISTS region")
