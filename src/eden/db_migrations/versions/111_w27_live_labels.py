"""111 — Wave 27: F21 calibrators + N11 live session metadata.

Revision ID: 111_w27_live_labels
Revises: 110_w26_drop_issue_fix_sessions
Create Date: 2026-07-17

Additive only. Forward-compat: yes.
"""

from __future__ import annotations

from alembic import op

revision: str = "111_w27_live_labels"
down_revision: str = "110_w26_drop_issue_fix_sessions"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS tool_call_calibrators (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id TEXT NOT NULL,
            agent_id TEXT NOT NULL,
            tool_name TEXT NOT NULL,
            model_blob BYTEA NOT NULL,
            precision DOUBLE PRECISION,
            recall DOUBLE PRECISION,
            sample_count INT NOT NULL DEFAULT 0,
            trained_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (org_id, agent_id, tool_name)
        )
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS tool_call_predictions (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id TEXT NOT NULL,
            span_id TEXT NOT NULL,
            calibrator_id UUID NOT NULL,
            confidence DOUBLE PRECISION NOT NULL,
            predicted_label TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS live_trace_sessions (
            org_id TEXT NOT NULL,
            session_id TEXT NOT NULL,
            trace_id TEXT,
            last_event_id BIGINT NOT NULL DEFAULT 0,
            event_count INT NOT NULL DEFAULT 0,
            dropped_events INT NOT NULL DEFAULT 0,
            finalized BOOLEAN NOT NULL DEFAULT FALSE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (org_id, session_id)
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_tool_call_calibrators_org_agent
        ON tool_call_calibrators (org_id, agent_id)
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_tool_call_predictions_org_span
        ON tool_call_predictions (org_id, span_id)
        """
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_tool_call_predictions_org_span")
    op.execute("DROP INDEX IF EXISTS idx_tool_call_calibrators_org_agent")
    op.execute("DROP TABLE IF EXISTS live_trace_sessions")
    op.execute("DROP TABLE IF EXISTS tool_call_predictions")
    op.execute("DROP TABLE IF EXISTS tool_call_calibrators")
