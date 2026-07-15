"""096_debugger_llm_cache — F03 prefix cache table.

Revision ID: 096
Revises: 095
Create Date: 2026-07-14

Adds ``debugger_llm_cache`` — the content-addressed LLM response cache
that backs the F03 prefix-cache ingest path and the Wave-7 F01
hash-based cached-prefix reuse.

Schema:
* PK: (org_id, source_trace_id, step_number, input_hash) — one row per
  unique (trace × step × message-hash) tuple.
* ``response JSONB NOT NULL`` — the raw LLM response (same shape as
  ``Checkpoint.response``).
* ``model TEXT`` — optional model tag for future cache-hit analytics.
* ``created_at TIMESTAMPTZ`` — ingestion timestamp for TTL cleanup.

Indexes:
* ``idx_cache_trace`` on (org_id, source_trace_id, step_number) — the
  hot read path: "give me all steps for this trace in order."
"""

from __future__ import annotations

from alembic import op

revision = "096"
down_revision = "095"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS debugger_llm_cache (
            org_id           TEXT          NOT NULL,
            source_trace_id  TEXT          NOT NULL,
            step_number      INT           NOT NULL,
            input_hash       TEXT          NOT NULL,
            response         JSONB         NOT NULL,
            model            TEXT,
            created_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),
            PRIMARY KEY (org_id, source_trace_id, step_number, input_hash)
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_cache_trace "
        "ON debugger_llm_cache (org_id, source_trace_id, step_number)"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_cache_trace")
    op.execute("DROP TABLE IF EXISTS debugger_llm_cache")
