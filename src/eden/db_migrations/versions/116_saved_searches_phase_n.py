"""116 — fix saved_searches schema collision (portal ViewsMenu 500).

Revision ID: 116_saved_searches_phase_n
Revises: 115_api_keys_prefix
Create Date: 2026-07-20

Migration 092 created a WS1 stub ``saved_searches``
(query_text / trace_count / signal_id). Phase N
``SavedSearchService`` + portal ViewsMenu expect a different
table (owner_id / name / query_type / params / …).

``CREATE TABLE IF NOT EXISTS`` in ``migrations/032_…sql`` never
applied because the stub already existed → UndefinedColumnError
→ HTTP 500 on ``GET /orgs/{id}/saved-searches``.

Fix: rename the stub (preserve deep-to-signal rows) and create
the Phase N table. ``owner_id`` is TEXT (Clerk ``users.id``), not
UUID — matching org_api_keys / 115 lesson.
"""

from __future__ import annotations

from alembic import op

revision: str = "116_saved_searches_phase_n"
down_revision: str = "115_api_keys_prefix"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ── 1. Move WS1 stub out of the way if present ───────────────
    op.execute(
        """
        DO $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'saved_searches'
              AND column_name = 'query_text'
          ) THEN
            ALTER TABLE saved_searches
              RENAME TO saved_search_signal_links;
          END IF;
        END $$;
        """
    )
    op.execute(
        """
        DO $$
        BEGIN
          IF to_regclass('public.saved_search_signal_links') IS NOT NULL THEN
            ALTER INDEX IF EXISTS saved_searches_pkey
              RENAME TO saved_search_signal_links_pkey;
          END IF;
        EXCEPTION WHEN OTHERS THEN
          NULL;  -- index may already be renamed / absent
        END $$;
        """
    )

    # ── 2. Phase N saved searches (portal Views / sharing) ───────
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS saved_searches (
            id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            -- Clerk-era users.id is TEXT — do not UUID-FK.
            owner_id        TEXT NOT NULL,
            name            TEXT NOT NULL,
            query_type      TEXT NOT NULL
                CHECK (query_type IN ('sql', 'eql', 'text')),
            query           TEXT NOT NULL,
            params          JSONB NOT NULL DEFAULT '{}'::jsonb,
            is_shared       BOOLEAN NOT NULL DEFAULT FALSE,
            is_pinned       BOOLEAN NOT NULL DEFAULT FALSE,
            tags            TEXT[] NOT NULL DEFAULT '{}',
            last_used_at    TIMESTAMPTZ,
            use_count       INT NOT NULL DEFAULT 0,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_saved_searches_owner_updated
            ON saved_searches (owner_id, updated_at DESC)
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_saved_searches_org_shared
            ON saved_searches (org_id, is_shared, updated_at DESC)
            WHERE is_shared = TRUE
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_saved_searches_org_pinned
            ON saved_searches (org_id, is_pinned DESC, updated_at DESC)
        """
    )
    op.execute(
        """
        CREATE OR REPLACE FUNCTION saved_searches_touch_updated() RETURNS TRIGGER AS $$
        BEGIN
            NEW.updated_at = NOW();
            RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
        """
    )
    op.execute(
        """
        DROP TRIGGER IF EXISTS trg_saved_searches_touch_updated ON saved_searches
        """
    )
    op.execute(
        """
        CREATE TRIGGER trg_saved_searches_touch_updated
            BEFORE UPDATE ON saved_searches
            FOR EACH ROW EXECUTE FUNCTION saved_searches_touch_updated()
        """
    )

    # ── 3. shared_traces (also missing on prod; same Phase N SQL) ─
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS shared_traces (
            id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            trace_id        TEXT NOT NULL,
            token_hash      TEXT NOT NULL UNIQUE,
            token_prefix    TEXT NOT NULL,
            -- Clerk users.id is TEXT
            created_by      TEXT NOT NULL,
            label           TEXT,
            expires_at      TIMESTAMPTZ,
            revoked_at      TIMESTAMPTZ,
            view_count      INT NOT NULL DEFAULT 0,
            last_viewed_at  TIMESTAMPTZ,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_shared_traces_org_created
            ON shared_traces (org_id, created_at DESC)
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_shared_traces_trace
            ON shared_traces (org_id, trace_id)
        """
    )


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS trg_saved_searches_touch_updated ON saved_searches")
    op.execute("DROP TABLE IF EXISTS saved_searches")
    op.execute("DROP TABLE IF EXISTS shared_traces")
    # Restore stub name if we renamed it
    op.execute(
        """
        DO $$
        BEGIN
          IF to_regclass('public.saved_search_signal_links') IS NOT NULL
             AND to_regclass('public.saved_searches') IS NULL THEN
            ALTER TABLE saved_search_signal_links RENAME TO saved_searches;
          END IF;
        END $$;
        """
    )
