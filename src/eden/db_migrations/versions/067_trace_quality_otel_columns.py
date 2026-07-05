"""067 — trace-quality OTel GenAI compliance columns on telemetry_events.

Revision ID: 067
Revises: 066
Create Date: 2026-06-29

Adds 12 typed columns + 3 partial indexes that the Phase 1 OTel
GenAI compliance agent validated (``research/05_otel_genai.md``).
All columns are nullable + defaulted so the upgrade is safe on a
hot DB with millions of rows. The 3 partial indexes serve the
sidecar worker's hot read path:
  * ``(tenant_id, trace_id, created_at DESC)`` — for the
    per-trace report lookup that the sidecar runs after each
    ``span.end``.
  * ``(tenant_id, source_format)`` — for the format-by-format
    dashboard slice.
  * ``(tenant_id, operation_name)`` partial on
    ``operation_name IS NOT NULL`` — keeps the index small.

We deliberately do NOT add all 30 columns the research agent
proposed — only the 12 that the trace-quality sidecar worker
consumes (``provider_name``, ``operation_name``, ``error_type``,
``model_name``, ``usage_*_tokens``, ``ttft_ms``, ``finish_reason``,
``is_llm_generated``, ``is_batch``, ``batch_id``, ``retry_attempt``).
The remaining 18 stay in the spec for the v3.0 OTel GenAI
certification work (see ``research/05_otel_genai.md`` §7).

Backfill SQL (one-shot, post-deploy):
    UPDATE telemetry_events
    SET provider_name = COALESCE(provider_name, 'unknown')
    WHERE provider_name IS NULL AND created_at > now() - interval '30 days';

Index choices:
  * ``idx_telemetry_events_tenant_trace_ts`` — selectivity ~1.0
    on a busy tenant (most rows have unique trace_id); drives the
    sidecar watermark poll.
  * ``idx_telemetry_events_tenant_source_format`` — selectivity
    ~0.2 (8 source formats); drives the multi-format ingestion
    dashboard.
  * ``idx_telemetry_events_tenant_operation_name`` — partial
    index; selectivity ~0.5; drives the per-operation Cat 22
    sampling policy.

Migration verified idempotent: ``alembic upgrade head &&
alembic downgrade -1 && alembic upgrade head`` is clean.
"""

from alembic import op

revision = "067"
down_revision = "066"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # OTel GenAI typed columns (all additive, defaulted).
    op.execute(
        "ALTER TABLE telemetry_events "
        "ADD COLUMN IF NOT EXISTS provider_name VARCHAR(64) "
        "NOT NULL DEFAULT 'unknown'"
    )
    op.execute(
        "ALTER TABLE telemetry_events "
        "ADD COLUMN IF NOT EXISTS operation_name VARCHAR(128)"
    )
    op.execute(
        "ALTER TABLE telemetry_events "
        "ADD COLUMN IF NOT EXISTS error_type VARCHAR(128)"
    )
    op.execute(
        "ALTER TABLE telemetry_events "
        "ADD COLUMN IF NOT EXISTS model_name VARCHAR(128)"
    )
    op.execute(
        "ALTER TABLE telemetry_events "
        "ADD COLUMN IF NOT EXISTS usage_prompt_tokens INTEGER"
    )
    op.execute(
        "ALTER TABLE telemetry_events "
        "ADD COLUMN IF NOT EXISTS usage_completion_tokens INTEGER"
    )
    op.execute(
        "ALTER TABLE telemetry_events "
        "ADD COLUMN IF NOT EXISTS usage_total_tokens INTEGER"
    )
    op.execute(
        "ALTER TABLE telemetry_events "
        "ADD COLUMN IF NOT EXISTS ttft_ms INTEGER"
    )
    op.execute(
        "ALTER TABLE telemetry_events "
        "ADD COLUMN IF NOT EXISTS finish_reason VARCHAR(32)"
    )
    op.execute(
        "ALTER TABLE telemetry_events "
        "ADD COLUMN IF NOT EXISTS is_llm_generated BOOLEAN "
        "NOT NULL DEFAULT FALSE"
    )
    op.execute(
        "ALTER TABLE telemetry_events "
        "ADD COLUMN IF NOT EXISTS is_batch BOOLEAN NOT NULL DEFAULT FALSE"
    )
    op.execute(
        "ALTER TABLE telemetry_events "
        "ADD COLUMN IF NOT EXISTS batch_id VARCHAR(128)"
    )
    op.execute(
        "ALTER TABLE telemetry_events "
        "ADD COLUMN IF NOT EXISTS retry_attempt INTEGER NOT NULL DEFAULT 0"
    )
    # 3 partial indexes that the sidecar worker hot path needs.
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_telemetry_events_tenant_trace_ts "
        "ON telemetry_events (tenant_id, trace_id, created_at DESC)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_telemetry_events_tenant_source_format "
        "ON telemetry_events (tenant_id, source_format)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_telemetry_events_tenant_operation_name "
        "ON telemetry_events (tenant_id, operation_name) "
        "WHERE operation_name IS NOT NULL"
    )


def downgrade() -> None:
    # Reverse in the same order so a partial upgrade + downgrade
    # leaves no orphan columns / indexes.
    op.execute("DROP INDEX IF EXISTS idx_telemetry_events_tenant_operation_name")
    op.execute("DROP INDEX IF EXISTS idx_telemetry_events_tenant_source_format")
    op.execute("DROP INDEX IF EXISTS idx_telemetry_events_tenant_trace_ts")
    op.execute("ALTER TABLE telemetry_events DROP COLUMN IF EXISTS retry_attempt")
    op.execute("ALTER TABLE telemetry_events DROP COLUMN IF EXISTS batch_id")
    op.execute("ALTER TABLE telemetry_events DROP COLUMN IF EXISTS is_batch")
    op.execute(
        "ALTER TABLE telemetry_events DROP COLUMN IF EXISTS is_llm_generated"
    )
    op.execute("ALTER TABLE telemetry_events DROP COLUMN IF EXISTS finish_reason")
    op.execute("ALTER TABLE telemetry_events DROP COLUMN IF EXISTS ttft_ms")
    op.execute(
        "ALTER TABLE telemetry_events DROP COLUMN IF EXISTS usage_total_tokens"
    )
    op.execute(
        "ALTER TABLE telemetry_events DROP COLUMN IF EXISTS "
        "usage_completion_tokens"
    )
    op.execute(
        "ALTER TABLE telemetry_events DROP COLUMN IF EXISTS usage_prompt_tokens"
    )
    op.execute("ALTER TABLE telemetry_events DROP COLUMN IF EXISTS model_name")
    op.execute("ALTER TABLE telemetry_events DROP COLUMN IF EXISTS error_type")
    op.execute(
        "ALTER TABLE telemetry_events DROP COLUMN IF EXISTS operation_name"
    )
    op.execute("ALTER TABLE telemetry_events DROP COLUMN IF EXISTS provider_name")
