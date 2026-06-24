"""059_computer_use — D.12.3 Computer Use traces per upgradespec §B.6.

Revision ID: 059
Revises: 058
Create Date: 2026-06-24

Per spec §B.6 (D.12.3):

    CREATE TABLE computer_use_steps (
        id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        trace_id            UUID NOT NULL,
        span_id             UUID NOT NULL,
        step_index          INTEGER NOT NULL,
        screenshot_before   TEXT,              -- S3 URI (nullable if no before-shot)
        screenshot_after    TEXT,              -- S3 URI
        action_type         TEXT NOT NULL,     -- 'click' | 'type' | 'scroll' | 'drag' | 'key' | 'wait'
        action_payload      JSONB NOT NULL,
        target_app          TEXT,
        target_coords       JSONB,
        success             BOOLEAN,
        error               TEXT,
        duration_ms         INTEGER,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE(span_id, step_index),
        FOREIGN KEY (trace_id) REFERENCES telemetry_events(id) ON DELETE CASCADE
    );

    CREATE TABLE computer_use_screenshots_tombstoned (
        s3_uri              TEXT PRIMARY KEY,
        trace_id            UUID NOT NULL,
        tombstoned_at       TIMESTAMPTZ NOT NULL DEFAULT now()
    );

Ponytail: ``org_id`` added to ``computer_use_steps`` so the
service can org-scope queries without joining telemetry_events
(matches the spine's VARCHAR(128) convention). The
``screenshot_before/after`` columns are plain TEXT S3 URIs
(no FK — screenshots are opaque objects; the tombstone table
is the only referent).
"""

from __future__ import annotations

from alembic import op

revision = "059"
down_revision = "058"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS computer_use_steps (
            id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id              VARCHAR(128) NOT NULL,
            trace_id            UUID NOT NULL,
            span_id             UUID NOT NULL,
            step_index          INTEGER NOT NULL,
            screenshot_before   TEXT,
            screenshot_after    TEXT,
            action_type         TEXT NOT NULL,
            action_payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
            target_app          TEXT,
            target_coords       JSONB,
            success             BOOLEAN,
            error               TEXT,
            duration_ms         INTEGER,
            blocked             BOOLEAN NOT NULL DEFAULT FALSE,
            created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE(span_id, step_index),
            CHECK (action_type IN (
                'click', 'type', 'scroll', 'drag', 'key', 'wait'
            ))
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_computer_use_steps_trace "
        "ON computer_use_steps(trace_id, step_index)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_computer_use_steps_org "
        "ON computer_use_steps(org_id, created_at DESC)"
    )

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS computer_use_screenshots_tombstoned (
            s3_uri              TEXT PRIMARY KEY,
            org_id              VARCHAR(128) NOT NULL,
            trace_id            UUID NOT NULL,
            tombstoned_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            tombstoned_by       VARCHAR(128),
            reason              TEXT
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_cu_screenshots_tombstoned_org "
        "ON computer_use_screenshots_tombstoned(org_id, tombstoned_at DESC)"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_cu_screenshots_tombstoned_org")
    op.execute("DROP TABLE IF EXISTS computer_use_screenshots_tombstoned")
    op.execute("DROP INDEX IF EXISTS idx_computer_use_steps_org")
    op.execute("DROP INDEX IF EXISTS idx_computer_use_steps_trace")
    op.execute("DROP TABLE IF EXISTS computer_use_steps")