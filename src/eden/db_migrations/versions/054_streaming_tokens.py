"""054_streaming_tokens — D.8 streaming tokens (Postgres side) per upgradespec §B.1.

Revision ID: 054
Revises: 053
Create Date: 2026-06-24

The spec calls for both a Postgres ``streaming_tokens`` table
and a ClickHouse mirror. This migration creates the Postgres
side; the ClickHouse mirror is created by the worker on
startup (per the v1.3 cat-ship pattern).

* ``streaming_tokens`` — one row per (span_id, token_index).
  PII is pre-masked at the SDK layer; ``redacted=true``
  marks tokens that were elided because the masked length
  exceeded the safe threshold.

The PK is ``(span_id, token_index)`` so concurrent writes
from the SSE/WebSocket handler are upserts (idempotent on
re-emit). The ``abs_ms`` / ``delta_ms`` columns let the
portal render the per-token sparkline + flag stalls.

Conventions (per the v1.4 cat-ship pattern, mirrors
:file:`053_webhook_dlq.py`):
* Tables include ``org_id`` + ``created_at``.
* Per-trace + per-created-at indexes for the hot read
  patterns.
"""

from __future__ import annotations

from alembic import op

revision = "054"
down_revision = "053"
branch_labels = None
depends_on = None


def upgrade() -> None:
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
        "CREATE INDEX IF NOT EXISTS idx_streaming_tokens_trace "
        "ON streaming_tokens (org_id, trace_id, token_index)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_streaming_tokens_span "
        "ON streaming_tokens (span_id, token_index)"
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS streaming_tokens")