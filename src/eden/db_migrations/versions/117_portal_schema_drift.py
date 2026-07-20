"""117 — portal hub schema drift (invites / domains / annotate / prefs).

Revision ID: 117_portal_schema_drift
Revises: 116_saved_searches_phase_n
Create Date: 2026-07-20

Same class of bug as 116: early ``CREATE TABLE IF NOT EXISTS`` stubs
blocked later schemas. Portal hubs then 500 on missing columns/tables.

Fixes:
  * org_invitations — add status / token_hash / declined_at
  * org_allowed_domains — add added_by (TEXT; Clerk users.id)
  * annotations + labeling_assignments — create (annotate dialog)
  * sidebar_prefs + streaming_tokens — create if missing
"""

from __future__ import annotations

from alembic import op

revision: str = "117_portal_schema_drift"
down_revision: str = "116_saved_searches_phase_n"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ── org_invitations ──────────────────────────────────────────
    op.execute(
        """
        ALTER TABLE org_invitations
            ADD COLUMN IF NOT EXISTS token_hash TEXT
        """
    )
    op.execute(
        """
        ALTER TABLE org_invitations
            ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending'
        """
    )
    op.execute(
        """
        ALTER TABLE org_invitations
            ADD COLUMN IF NOT EXISTS declined_at TIMESTAMPTZ
        """
    )
    # Backfill token_hash from legacy plaintext token column when present.
    op.execute(
        """
        DO $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'org_invitations' AND column_name = 'token'
          ) THEN
            UPDATE org_invitations
               SET token_hash = COALESCE(NULLIF(token_hash, ''), token)
             WHERE token_hash IS NULL OR token_hash = '';
          END IF;
        END $$;
        """
    )
    op.execute(
        """
        UPDATE org_invitations
           SET status = CASE
             WHEN accepted_at IS NOT NULL THEN 'accepted'
             WHEN declined_at IS NOT NULL THEN 'declined'
             WHEN expires_at < NOW() THEN 'expired'
             ELSE 'pending'
           END
         WHERE status IS NULL OR status = '' OR status = 'pending'
        """
    )
    # Enforce NOT NULL on token_hash after backfill (empty stubs get placeholder).
    op.execute(
        """
        UPDATE org_invitations
           SET token_hash = 'migrated-' || id::text
         WHERE token_hash IS NULL OR token_hash = ''
        """
    )
    op.execute(
        """
        ALTER TABLE org_invitations
            ALTER COLUMN token_hash SET NOT NULL
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_org_invitations_token
            ON org_invitations (token_hash)
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_org_invitations_org_pending
            ON org_invitations (org_id, status)
            WHERE status = 'pending'
        """
    )

    # ── org_allowed_domains ──────────────────────────────────────
    op.execute(
        """
        ALTER TABLE org_allowed_domains
            ADD COLUMN IF NOT EXISTS added_by TEXT
        """
    )

    # ── annotations + labeling_assignments ───────────────────────
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS annotations (
            id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            item_id         UUID NOT NULL REFERENCES labeling_items(id) ON DELETE CASCADE,
            annotator_id    TEXT NOT NULL,
            label           JSONB NOT NULL,
            confidence      NUMERIC(3, 2) NOT NULL DEFAULT 0.5
                CHECK (confidence >= 0 AND confidence <= 1),
            notes           TEXT,
            time_spent_ms   INT,
            skills_exercised TEXT[] NOT NULL DEFAULT '{}',
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (item_id, annotator_id)
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_annotations_item
            ON annotations (item_id, created_at DESC)
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_annotations_annotator
            ON annotations (annotator_id, created_at DESC)
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_annotations_org_created
            ON annotations (org_id, created_at DESC)
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS labeling_assignments (
            id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            item_id         UUID NOT NULL REFERENCES labeling_items(id) ON DELETE CASCADE,
            annotator_id    TEXT NOT NULL,
            assigned_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            started_at      TIMESTAMPTZ,
            completed_at    TIMESTAMPTZ,
            source          TEXT NOT NULL DEFAULT 'auto'
                CHECK (source IN ('auto', 'manual', 'self')),
            UNIQUE (item_id, annotator_id)
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_labeling_assignments_org
            ON labeling_assignments (org_id, assigned_at DESC)
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_labeling_assignments_annotator
            ON labeling_assignments (annotator_id, completed_at)
            WHERE completed_at IS NULL
        """
    )

    # ── sidebar_prefs (user_id TEXT — Clerk) ─────────────────────
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS sidebar_prefs (
            user_id    TEXT NOT NULL,
            org_id     UUID NOT NULL,
            prefs      JSONB NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (user_id, org_id)
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_sidebar_prefs_org_id
            ON sidebar_prefs (org_id)
        """
    )

    # ── streaming_tokens ─────────────────────────────────────────
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS streaming_tokens (
            id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id          VARCHAR(128) NOT NULL,
            trace_id        VARCHAR(128) NOT NULL,
            span_id         VARCHAR(128) NOT NULL,
            token_index     INTEGER NOT NULL CHECK (token_index >= 0),
            token_text      TEXT,
            token_byte_len  SMALLINT NOT NULL DEFAULT 0 CHECK (token_byte_len >= 0),
            delta_ms        INTEGER NOT NULL DEFAULT 0 CHECK (delta_ms >= 0),
            abs_ms          INTEGER NOT NULL DEFAULT 0 CHECK (abs_ms >= 0),
            finish_reason   VARCHAR(32),
            redacted        BOOLEAN NOT NULL DEFAULT FALSE,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE(span_id, token_index)
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_streaming_tokens_trace
            ON streaming_tokens (org_id, trace_id, token_index)
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_streaming_tokens_span
            ON streaming_tokens (span_id, token_index)
        """
    )


def downgrade() -> None:
    # Non-destructive: leave tables/columns in place (prod data safety).
    pass
