"""103 — Phase 6 Wave 7: debug sessions, browser recording."""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "103_wave7_debugger_browser"
down_revision: str | Sequence[str] | None = "102_wave6_online_quality"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS debug_sessions (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id VARCHAR(128) NOT NULL,
            title TEXT NOT NULL DEFAULT 'Debug session',
            source_trace_id TEXT,
            notes TEXT NOT NULL DEFAULT '',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_debug_sessions_org "
        "ON debug_sessions (org_id, updated_at DESC)"
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS debug_session_runs (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            session_id UUID NOT NULL REFERENCES debug_sessions(id) ON DELETE CASCADE,
            org_id VARCHAR(128) NOT NULL,
            source_trace_id TEXT NOT NULL,
            result_trace_id TEXT,
            from_step INT NOT NULL DEFAULT 0,
            rerun_mode TEXT NOT NULL DEFAULT 'hermetic',
            diff_summary JSONB NOT NULL DEFAULT '[]'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_debug_session_runs_session "
        "ON debug_session_runs (session_id, created_at ASC)"
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS browser_sessions (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id VARCHAR(128) NOT NULL,
            trace_id TEXT NOT NULL,
            agent_session_id TEXT,
            user_agent TEXT NOT NULL DEFAULT '',
            viewport_w INT NOT NULL DEFAULT 0,
            viewport_h INT NOT NULL DEFAULT 0,
            started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            ended_at TIMESTAMPTZ
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_browser_sessions_trace "
        "ON browser_sessions (org_id, trace_id, started_at DESC)"
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS browser_session_events (
            id BIGSERIAL PRIMARY KEY,
            browser_session_id UUID NOT NULL REFERENCES browser_sessions(id) ON DELETE CASCADE,
            step_number INT,
            event_type TEXT NOT NULL,
            payload JSONB NOT NULL,
            recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_browser_session_events_session "
        "ON browser_session_events (browser_session_id, step_number, recorded_at ASC)"
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS browser_session_events")
    op.execute("DROP TABLE IF EXISTS browser_sessions")
    op.execute("DROP TABLE IF EXISTS debug_session_runs")
    op.execute("DROP TABLE IF EXISTS debug_sessions")
