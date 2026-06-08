"""011_capture_full_payloads — Phase 7.2 Full LLM Call Capture.

Revision ID: 011
Revises: 010
Create Date: 2026-06-05

Adds the columns and tables needed to capture the COMPLETE LLM call
(request, response, reasoning, tool calls, tool results, images, audio,
logprobs, citations, finish reasons, system fingerprint, cache hits and
savings) instead of the truncated excerpts the Phase 7.0 decoders kept.

This is the data layer that makes the portal's transcript view, Datadog-style
Patterns, and per-token stream replay possible — none of those features
can ship without the full payloads being captured end-to-end.

New columns on telemetry_events:
- request_body, response_body      : full LLM call bodies as JSONB
- reasoning                        : o1 reasoning, Anthropic thinking, Gemini thoughts
- tool_calls_full, tool_results    : structured tool invocation records
- images, audio                    : multimodal input/output descriptors
- logprobs, citations              : per-token probabilities + RAG citations
- finish_reason, stop_sequence     : provider stop signals
- system_fingerprint               : OpenAI o-series model build identifier
- cache_hit, prompt_cache_savings_usd : cache analytics
- model_version, service_tier      : disambiguation + billing tier

New tables:
- telemetry_stream_chunks          : per-token/per-chunk stream capture
                                     (one row per StreamingResponse delta)
- telemetry_media_blobs            : S3/local URI references for media
                                     payloads (no inline base64 in the DB)
"""

from alembic import op

revision = "011"
down_revision = "010"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ── telemetry_events: new capture columns ────────────────────────────
    # Use IF NOT EXISTS so this migration is safe to re-run on databases
    # that have already had the columns added (e.g. dev environments that
    # applied a hotfix before the migration was cut).
    new_columns = [
        ("request_body", "JSONB"),
        ("response_body", "JSONB"),
        ("reasoning", "JSONB"),
        ("tool_calls_full", "JSONB"),
        ("tool_results", "JSONB"),
        ("images", "JSONB"),
        ("audio", "JSONB"),
        ("logprobs", "JSONB"),
        ("citations", "JSONB"),
        ("finish_reason", "VARCHAR(64)"),
        ("stop_sequence", "TEXT"),
        ("system_fingerprint", "VARCHAR(128)"),
        ("cache_hit", "BOOLEAN"),
        ("prompt_cache_savings_usd", "NUMERIC(12,6)"),
        ("model_version", "VARCHAR(128)"),
        ("service_tier", "VARCHAR(64)"),
    ]
    for col_name, col_type in new_columns:
        op.execute(
            f"ALTER TABLE telemetry_events ADD COLUMN IF NOT EXISTS {col_name} {col_type}"
        )

    # Per-tenant finish-reason distribution (alerting on "length" spikes).
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_telemetry_events_tenant_finish_reason
        ON telemetry_events (tenant_id, finish_reason, timestamp DESC)
        WHERE finish_reason IS NOT NULL
    """)

    # Per-tenant cache-hit rate (cost optimization dashboards).
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_telemetry_events_tenant_cache
        ON telemetry_events (tenant_id, cache_hit, timestamp DESC)
        WHERE cache_hit = TRUE
    """)

    # Model + version disambiguation (for A/B tests on prompt versions).
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_telemetry_events_tenant_model_version
        ON telemetry_events (tenant_id, model, model_version, timestamp DESC)
        WHERE model_version IS NOT NULL
    """)

    # ── telemetry_stream_chunks ──────────────────────────────────────────
    # One row per streaming chunk. The parent event_id references the
    # telemetry_events row emitted at the end of the stream. chunk_index
    # is monotonic within a single event; deltas are PII-masked at ingest.
    op.execute("""
        CREATE TABLE IF NOT EXISTS telemetry_stream_chunks (
            chunk_id        UUID PRIMARY KEY,
            event_id        VARCHAR(128) NOT NULL,
            tenant_id       VARCHAR(128) NOT NULL,
            trace_id        VARCHAR(128) NOT NULL,
            parent_span_id  VARCHAR(64),
            span_id         VARCHAR(64),
            chunk_index     INT NOT NULL,
            delta_text      TEXT,
            reasoning_delta TEXT,
            tool_call_delta JSONB,
            ttft_ms         NUMERIC(10,3),
            itl_ms          NUMERIC(10,3),
            tpot_ms         NUMERIC(10,3),
            received_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT fk_tsc_event
                FOREIGN KEY (event_id)
                REFERENCES telemetry_events(event_id)
                ON DELETE CASCADE
        )
    """)

    # Per-event ordered retrieval (replay UI: "show me all chunks for this event").
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_tsc_event
        ON telemetry_stream_chunks (event_id, chunk_index)
    """)

    # Per-tenant time-series (streaming dashboards).
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_tsc_tenant_time
        ON telemetry_stream_chunks (tenant_id, received_at DESC)
    """)

    # Per-trace fan-out.
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_tsc_trace
        ON telemetry_stream_chunks (trace_id, received_at ASC)
    """)

    # ── telemetry_media_blobs ────────────────────────────────────────────
    # Stores URIs (S3 or local) for image/audio payloads. We never inline
    # base64 in the database — too costly. The portal fetches the bytes
    # through the /orgs/{org_id}/media/{blob_id} route.
    op.execute("""
        CREATE TABLE IF NOT EXISTS telemetry_media_blobs (
            blob_id         UUID PRIMARY KEY,
            tenant_id       VARCHAR(128) NOT NULL,
            event_id        VARCHAR(128) NOT NULL,
            media_type      VARCHAR(32) NOT NULL,
            content_type    VARCHAR(64) NOT NULL,
            storage_uri     TEXT NOT NULL,
            size_bytes      BIGINT NOT NULL,
            sha256          VARCHAR(64) NOT NULL,
            metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT fk_tmb_event
                FOREIGN KEY (event_id)
                REFERENCES telemetry_events(event_id)
                ON DELETE CASCADE
        )
    """)

    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_tmb_event
        ON telemetry_media_blobs (event_id)
    """)

    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_tmb_tenant_time
        ON telemetry_media_blobs (tenant_id, created_at DESC)
    """)

    # SHA-256 uniqueness is a cheap dedup for repeated images (avatars,
    # test fixtures, etc.). Tenant-scoped so identical bytes from
    # different tenants don't collide.
    op.execute("""
        CREATE UNIQUE INDEX IF NOT EXISTS uq_tmb_tenant_sha
        ON telemetry_media_blobs (tenant_id, sha256)
    """)

    # ── telemetry_streaming_metrics rollup ───────────────────────────────
    # Hourly rollup of streaming metrics per (tenant, model). Pre-computed
    # so the portal perf dashboard can render p50/p95/p99 of TTFT, ITL,
    # and TPOT without scanning telemetry_stream_chunks every time.
    op.execute("""
        CREATE TABLE IF NOT EXISTS telemetry_streaming_metrics (
            id              BIGSERIAL PRIMARY KEY,
            tenant_id       VARCHAR(128) NOT NULL,
            model           VARCHAR(128) NOT NULL,
            hour            TIMESTAMPTZ NOT NULL,
            sample_count    INT NOT NULL,
            ttft_ms_avg     NUMERIC(10,3),
            ttft_ms_p50     NUMERIC(10,3),
            ttft_ms_p95     NUMERIC(10,3),
            itl_ms_avg      NUMERIC(10,3),
            itl_ms_p50      NUMERIC(10,3),
            itl_ms_p95      NUMERIC(10,3),
            tpot_ms_avg     NUMERIC(10,3),
            tpot_ms_p50     NUMERIC(10,3),
            tpot_ms_p95     NUMERIC(10,3),
            UNIQUE (tenant_id, model, hour)
        )
    """)

    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_tsm_tenant_time
        ON telemetry_streaming_metrics (tenant_id, hour DESC)
    """)


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_tsm_tenant_time")
    op.execute("DROP TABLE IF EXISTS telemetry_streaming_metrics")

    op.execute("DROP INDEX IF EXISTS uq_tmb_tenant_sha")
    op.execute("DROP INDEX IF EXISTS idx_tmb_tenant_time")
    op.execute("DROP INDEX IF EXISTS idx_tmb_event")
    op.execute("DROP TABLE IF EXISTS telemetry_media_blobs")

    op.execute("DROP INDEX IF EXISTS idx_tsc_trace")
    op.execute("DROP INDEX IF EXISTS idx_tsc_tenant_time")
    op.execute("DROP INDEX IF EXISTS idx_tsc_event")
    op.execute("DROP TABLE IF EXISTS telemetry_stream_chunks")

    op.execute("DROP INDEX IF EXISTS idx_telemetry_events_tenant_model_version")
    op.execute("DROP INDEX IF EXISTS idx_telemetry_events_tenant_cache")
    op.execute("DROP INDEX IF EXISTS idx_telemetry_events_tenant_finish_reason")

    drop_columns = [
        "service_tier",
        "model_version",
        "prompt_cache_savings_usd",
        "cache_hit",
        "system_fingerprint",
        "stop_sequence",
        "finish_reason",
        "citations",
        "logprobs",
        "audio",
        "images",
        "tool_results",
        "tool_calls_full",
        "reasoning",
        "response_body",
        "request_body",
    ]
    for col_name in drop_columns:
        op.execute(f"ALTER TABLE telemetry_events DROP COLUMN IF EXISTS {col_name}")
