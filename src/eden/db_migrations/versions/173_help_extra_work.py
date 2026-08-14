"""173 — help contracts, extra-work events/candidates, session helped.

Revision ID: 173_help_extra_work
Revises: 172_trace_bookmarks
Create Date: 2026-08-14

P0 "Did it actually help?" first slice. ExtraWorkEvent[] is the source
of truth (Slack ambient listen). session_summaries.outcome is NOT
retasked — a new helped column + session_outcomes rows hold the
derived rollup. extra_work_candidates is a 7-day Fernet buffer.

RLS: same policy shape as 172 (ENABLE without FORCE, unset-GUC escape).
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "173_help_extra_work"
down_revision: str | Sequence[str] | None = "172_trace_bookmarks"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _rls(table: str, policy: str) -> None:
    op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")
    op.execute(
        f"""
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_policies
                WHERE schemaname = 'public'
                  AND tablename  = '{table}'
                  AND policyname = '{policy}'
            ) THEN
                EXECUTE $policy$
                    CREATE POLICY {policy}
                    ON {table}
                    FOR ALL
                    TO PUBLIC
                    USING (
                        org_id = current_setting('app.current_org_id', true)
                        OR current_setting('app.current_org_id', true) IS NULL
                    )
                $policy$;
            END IF;
        END $$;
        """
    )


def upgrade() -> None:
    op.execute(
        "ALTER TABLE org_slack_installs "
        "ADD COLUMN IF NOT EXISTS granted_scopes TEXT NOT NULL DEFAULT ''"
    )
    op.execute(
        "ALTER TABLE org_slack_installs "
        "ADD COLUMN IF NOT EXISTS history_consented_at TIMESTAMPTZ"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS agent_slack_channels_org_channel_idx "
        "ON agent_slack_channels (org_id, channel_id)"
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS help_contracts (
            id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id           VARCHAR(128) NOT NULL,
            agent_id         VARCHAR(256) NOT NULL,
            sentence         TEXT NOT NULL,
            x_job            TEXT,
            x_keywords       TEXT[] NOT NULL DEFAULT '{}',
            y_person         TEXT,
            y_slack_user_id  TEXT,
            created_by       VARCHAR(256) NOT NULL,
            created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            superseded_at    TIMESTAMPTZ,
            CONSTRAINT help_contracts_sentence_len_chk
                CHECK (char_length(sentence) >= 8)
        )
        """
    )
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS help_contracts_org_agent_current_uq "
        "ON help_contracts (org_id, agent_id) WHERE superseded_at IS NULL"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_help_contracts_org_agent "
        "ON help_contracts (org_id, agent_id) WHERE superseded_at IS NULL"
    )
    _rls("help_contracts", "tenant_isolation_help_contracts")
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS extra_work_events (
            id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id           VARCHAR(128) NOT NULL,
            session_id       VARCHAR(128),
            agent_id         VARCHAR(256) NOT NULL,
            user_id          VARCHAR(256),
            help_contract_id UUID,
            trace_id         VARCHAR(128),
            surface          VARCHAR(32) NOT NULL,
            kind             VARCHAR(64) NOT NULL,
            path             VARCHAR(32) NOT NULL,
            join_key         JSONB NOT NULL,
            snippet          VARCHAR(280),
            window           JSONB,
            confidence       VARCHAR(16) NOT NULL,
            polarity         VARCHAR(32) NOT NULL,
            raw              JSONB NOT NULL DEFAULT '{}',
            event_id         TEXT,
            observed_at      TIMESTAMPTZ NOT NULL,
            ingested_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            canary_arm       VARCHAR(16)
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_extra_work_events_org_agent_obs "
        "ON extra_work_events (org_id, agent_id, observed_at)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_extra_work_events_org_session_obs "
        "ON extra_work_events (org_id, session_id, observed_at) "
        "WHERE session_id IS NOT NULL"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_extra_work_events_org_surface_kind "
        "ON extra_work_events (org_id, surface, kind, observed_at)"
    )
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS extra_work_events_org_event_id_uq "
        "ON extra_work_events (org_id, event_id) WHERE event_id IS NOT NULL"
    )
    _rls("extra_work_events", "tenant_isolation_extra_work_events")
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS extra_work_candidates (
            id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id           VARCHAR(128) NOT NULL,
            agent_id         VARCHAR(256),
            help_contract_id UUID,
            channel_id       TEXT NOT NULL,
            payload_enc      TEXT NOT NULL,
            created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            expires_at       TIMESTAMPTZ NOT NULL
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_extra_work_candidates_expires "
        "ON extra_work_candidates (expires_at)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_extra_work_candidates_org_channel "
        "ON extra_work_candidates (org_id, channel_id)"
    )
    _rls("extra_work_candidates", "tenant_isolation_extra_work_candidates")
    op.execute(
        "ALTER TABLE session_summaries "
        "ADD COLUMN IF NOT EXISTS helped VARCHAR(16) NOT NULL DEFAULT 'unknown'"
    )
    op.execute(
        """
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint
                WHERE conname = 'session_summaries_helped_chk'
            ) THEN
                ALTER TABLE session_summaries
                ADD CONSTRAINT session_summaries_helped_chk
                CHECK (helped IN ('helped', 'not_helped', 'unknown'));
            END IF;
        END $$;
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS session_outcomes (
            id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id           VARCHAR(128) NOT NULL,
            session_id       VARCHAR(128),
            agent_id         VARCHAR(256) NOT NULL,
            help_contract_id UUID,
            trace_id         VARCHAR(128),
            user_id          VARCHAR(256),
            value            VARCHAR(16) NOT NULL,
            source           VARCHAR(16) NOT NULL,
            channel          TEXT NOT NULL,
            explicit         BOOLEAN NOT NULL,
            reason           TEXT,
            confidence       VARCHAR(16),
            observed_at      TIMESTAMPTZ NOT NULL,
            canary_arm       VARCHAR(16)
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_session_outcomes_org_session_obs "
        "ON session_outcomes (org_id, session_id, observed_at) "
        "WHERE session_id IS NOT NULL"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_session_outcomes_org_agent_obs "
        "ON session_outcomes (org_id, agent_id, observed_at)"
    )
    _rls("session_outcomes", "tenant_isolation_session_outcomes")


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS session_outcomes")
    op.execute(
        "ALTER TABLE session_summaries DROP CONSTRAINT IF EXISTS "
        "session_summaries_helped_chk"
    )
    op.execute("ALTER TABLE session_summaries DROP COLUMN IF EXISTS helped")
    op.execute("DROP TABLE IF EXISTS extra_work_candidates")
    op.execute("DROP TABLE IF EXISTS extra_work_events")
    op.execute("DROP TABLE IF EXISTS help_contracts")
    op.execute("DROP INDEX IF EXISTS agent_slack_channels_org_channel_idx")
