# Eden Observability — Full Specification Document
## (Continuation of audit; Sections A–J)

---

## SECTION A — Architecture overview

### A.1 Current data flow (ASCII)

```
┌────────────────────────────────────────────────────────────────────────────┐
│                          CUSTOMER APPLICATION                              │
│                                                                            │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐     │
│  │  Python  │  │ TypeScript│  │   Go     │  │  Java    │  │  Rust    │     │
│  │   SDK    │  │   SDK     │  │   SDK    │  │   SDK    │  │   SDK    │     │
│  └────┬─────┘  └─────┬─────┘  └─────┬─────┘  └─────┬─────┘  └─────┬─────┘     │
│       │              │               │              │              │          │
│       │  OTel/JSON   │               │              │              │          │
└───────┼──────────────┼───────────────┼──────────────┼──────────────┼──────────┘
        │              │               │              │              │
        ▼              ▼               ▼              ▼              ▼
┌────────────────────────────────────────────────────────────────────────────┐
│                         EDEN GATEWAY (FastAPI)                             │
│                                                                            │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐           │
│  │  /v1/ingest │  │ /v1/proxy  │  │ /v1/ai/    │  │ /v1/observ │           │
│  │  (OTel)     │  │ (LLM passthrough) │ ab/v2 │  │ /ability   │           │
│  └─────┬───────┘  └─────┬──────┘  └─────┬──────┘  └─────┬──────┘           │
│        │                │               │              │                   │
│        │  ┌─────────────┴───────────────┴──────────────┘                   │
│        │  │                                                                │
│        ▼  ▼                                                                │
│  ┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐    │
│  │ PII Pre-Mask    │    │  Budget Guard    │    │  Rate Limiter    │    │
│  │ (Cat 10)        │    │  (§6.3 NEW)      │    │  (§2.11 NEW)     │    │
│  └────────┬─────────┘    └────────┬─────────┘    └────────┬─────────┘    │
│           │                       │                       │                  │
│           ▼                       ▼                       ▼                  │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │                     STREAMING TOKEN HOOK (§6.1 NEW)                 │  │
│  └─────────────────────────────────┬───────────────────────────────────┘  │
└────────────────────────────────────┼──────────────────────────────────────┘
                                     │
                                     ▼
┌────────────────────────────────────────────────────────────────────────────┐
│                       INGESTION LAYER                                      │
│                                                                            │
│  ┌─────────────────┐                                                       │
│  │ Redis (BullMQ)  │ ── queue ──▶ ┌─────────────────┐                     │
│  │                 │              │ Async Worker     │                     │
│  │ 9 formats:      │              │ (Python)         │                     │
│  │ OTel, OpenAI,   │              │                  │                     │
│  │ Anthropic, ...  │              └────────┬─────────┘                     │
│  └─────────────────┘                       │                               │
│                                            ▼                               │
│  ┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐    │
│  │ Postgres (OLTP)  │◀──▶│ ClickHouse (OLAP)│    │ S3 (objects)     │    │
│  │ 25+ tables       │    │ per-org partitions│    │ traces + media   │    │
│  │ telemetry_events │    │ eden.<org>.<YYYYMM>│   │ attachments      │    │
│  │ judge_scores     │    │                  │    │ (tombstoned)     │    │
│  │ prompts (§6.2)   │    │ streaming_tokens │    │                  │    │
│  │ budgets (§6.3)   │    │ (Cat 18 NEW)     │    │                  │    │
│  └──────────────────┘    └──────────────────┘    └──────────────────┘    │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
┌────────────────────────────────────────────────────────────────────────────┐
│                       INTELLIGENCE LAYER                                   │
│                                                                            │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐           │
│  │ Cat 1:     │  │ Cat 2:     │  │ Cat 3:     │  │ Cat 4:     │           │
│  │ Traces     │  │ RCA        │  │ Judge      │  │ Retrieval  │           │
│  │ (spine)    │  │            │  │ (spine)    │  │            │           │
│  └─────┬──────┘  └──────┬─────┘  └──────┬─────┘  └──────┬─────┘           │
│        │                │               │              │                   │
│  ┌─────┴────────────────┴───────────────┴──────────────┴──────┐            │
│  │                  CLOSED-LOOP HOOK BUS                     │            │
│  │  (20+ reasons → Investigation, RCA, PII, RTBF, ... )     │            │
│  └─────┬──────────────────────────────────────────────────────┘            │
│        │                                                                    │
│  ┌─────┴─────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐    │
│  │ Cat 14:       │  │ Cat 9:      │  │ Cat 12:     │  │ Cat 13:     │    │
│  │ Autonomous    │  │ User Intel  │  │ Experiment  │  │ Predictive  │    │
│  │ (spine)       │  │ (spine)     │  │             │  │             │    │
│  └───────────────┘  └─────────────┘  └─────────────┘  └─────────────┘    │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
┌────────────────────────────────────────────────────────────────────────────┐
│                       DELIVERY LAYER                                       │
│                                                                            │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐           │
│  │ Portal     │  │ CLI        │  │ Webhooks   │  │ SDKs       │           │
│  │ (Next.js)  │  │ (Codebuff) │  │ (signed)   │  │ (query)    │           │
│  └────────────┘  └────────────┘  └────────────┘  └────────────┘           │
└────────────────────────────────────────────────────────────────────────────┘
```

### A.2 Target data flow (with all §6 specs + §8 cats)

```
┌────────────────────────────────────────────────────────────────────────────┐
│                          CUSTOMER APPLICATION                              │
│                                                                            │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐     │
│  │  Python  │  │ TypeScript│  │   Go     │  │  Browser │  │  Edge    │     │
│  │   SDK    │  │   SDK     │  │   SDK    │  │   SDK    │  │  SDK     │     │
│  │          │  │           │  │ (NEW)    │  │ (NEW §8.5)│  │ (NEW §8.6)│   │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘  └──────────┘     │
│       │              │               │              │              │          │
│       │ OTel/JSON + MCP attributes (§8.1) + A2A (§8.2) + Computer Use (§8.3)│
│       ▼              ▼               ▼              ▼              ▼          │
└───────┼──────────────┼───────────────┼──────────────┼──────────────┼──────────┘
        │              │               │              │              │
        ▼              ▼               ▼              ▼              ▼
┌────────────────────────────────────────────────────────────────────────────┐
│                         EDEN GATEWAY                                       │
│                                                                            │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐           │
│  │ PII Pre-Mask │  │ Budget    │  │ Real-time │  │ Streaming  │           │
│  │             │  │ Guard     │  │ Anomaly   │  │ Token Hook │           │
│  │             │  │           │  │ (NEW §2.4)│  │ (NEW §6.1) │           │
│  └─────────────┘  └────────────┘  └────────────┘  └────────────┘           │
│                                                                            │
│  ┌──────────────────────────────────────────────────────────────────────┐ │
│  │              PROVIDER ROUTING ATTEMPTS (§2.12 NEW)                   │ │
│  └──────────────────────────────────────────────────────────────────────┘ │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
┌────────────────────────────────────────────────────────────────────────────┐
│                       INGESTION LAYER                                      │
│                                                                            │
│  ┌─────────────────┐    ┌──────────────────┐    ┌──────────────────┐    │
│  │ Postgres (OLTP) │    │ ClickHouse (OLAP)│    │ S3 (objects)     │    │
│  │                 │    │                  │    │                  │    │
│  │ NEW tables:     │    │ NEW:             │    │ NEW:             │    │
│  │ • prompts       │    │ • streaming_tokens│   │ • voice_sessions │    │
│  │ • prompt_versions│   │ • voice_session  │    │ • computer_use   │    │
│  │ • budgets       │    │ • computer_use   │    │   screenshots    │    │
│  │ • mcp_traces    │    │ • mcp_attributes │    │ • multi_modal    │    │
│  │ • a2a_links     │    │ • a2a_links      │    │   attachments    │    │
│  │ • voice_session │    │ • fine_tune_runs │    │                  │    │
│  │ • computer_use  │    │ • provider_route │    │                  │    │
│  │ • provider_route│    │                  │    │                  │    │
│  │ • fine_tune_runs│    │                  │    │                  │    │
│  └─────────────────┘    └──────────────────┘    └──────────────────┘    │
│                                                                            │
│  ┌──────────────────────────────────────────────────────────────────────┐ │
│  │  MULTI-REGION ROUTING (§8.8 NEW) — us / eu / ap                     │ │
│  └──────────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
┌────────────────────────────────────────────────────────────────────────────┐
│                       INTELLIGENCE LAYER                                   │
│                                                                            │
│  SPINE: Cat 1 (Traces) ─ Cat 3 (Judge) ─ Cat 8 (User Intel) ─ Cat 9 (Gov) │
│  CLOSED-LOOP HOOK BUS ──▶ 20+ reasons (§E)                                │
│                                                                            │
│  EXTENDED:                                                                   │
│  • Streaming analytics (Cat 1 + §6.1) — token-level P95 stalls            │
│  • Provider routing analytics (§2.12) — fallback patterns                  │
│  • MCP/A2A topology (§8.1, §8.2) — agent graph                             │
│  • Computer Use replayer (§8.3) — screenshot diff                          │
│  • Voice analytics (§8.4) — barge-in detection                             │
│  • Fine-tune lineage (§8.7) — trace → dataset → model                      │
└────────────────────────────────────────────────────────────────────────────┘
```

### A.3 Component ownership (RACI)

| Component                | Primary owner       | Secondary     | Reviewer           |
| ------------------------ | ------------------- | ------------- | ------------------ |
| Gateway ingest           | Platform team       | SRE           | Security (PII)     |
| Postgres schema          | Data team           | Platform      | SRE (backups)      |
| ClickHouse               | Data team           | SRE           | Platform (queries) |
| Cat 1 (Traces)           | Observability squad | Data          | —                  |
| Cat 3 (Judge)            | Eval squad          | Observability | —                  |
| Cat 8 (User)             | Eval squad          | Observability | —                  |
| Cat 9 (Gov)              | Security            | Platform      | Legal              |
| Closed-loop hooks        | Platform team       | All cats      | Security           |
| SDKs (Python, TS)        | SDK team            | Observability | —                  |
| SDKs (Go, Browser, Edge) | SDK team            | Observability | —                  |
| Webhooks                 | Platform team       | SRE           | —                  |
| Portal                   | Portal team         | Observability | —                  |

---

## SECTION B — Data model specification

### B.1 Streaming tokens (§6.1)

**Postgres DDL:**

```sql
-- Migration: 051_streaming_tokens.sql
CREATE TABLE streaming_tokens (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    trace_id        UUID NOT NULL,
    span_id         UUID NOT NULL,
    token_index     INTEGER NOT NULL CHECK (token_index >= 0),
    token_text      TEXT,
    token_byte_len  SMALLINT NOT NULL CHECK (token_byte_len >= 0),
    delta_ms        INTEGER NOT NULL CHECK (delta_ms >= 0),
    abs_ms          INTEGER NOT NULL CHECK (abs_ms >= 0),
    finish_reason   TEXT,
    redacted        BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(span_id, token_index),
    FOREIGN KEY (trace_id) REFERENCES telemetry_events(id) ON DELETE CASCADE
);

CREATE INDEX idx_streaming_tokens_trace ON streaming_tokens(trace_id);
CREATE INDEX idx_streaming_tokens_created_at ON streaming_tokens(created_at);

-- ClickHouse-side mirror (created by worker post-insert)
-- See ClickHouse DDL in §B.1.2
```

**ClickHouse DDL:**

```sql
CREATE TABLE streaming_tokens_ch (
    trace_id        UUID,
    span_id         UUID,
    token_index     UInt32,
    delta_ms        Int32,
    abs_ms          Int32,
    token_byte_len  UInt16,
    finish_reason   LowCardinality(String),
    redacted        UInt8,
    ts              DateTime
) ENGINE = MergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY (trace_id, token_index)
TTL ts + INTERVAL 90 DAY DELETE;
```

**Config keys:**

```yaml
streaming_token_capture_mode: byte_count_only  # or 'full' or 'none'
streaming_stall_threshold_multiplier: 5        # stall = delta_ms > multiplier * p50
streaming_token_batch_size: 50
streaming_token_batch_window_ms: 250
```

### B.2 Prompts + prompt versions (§6.2)

```sql
-- Migration: 052_prompts.sql
CREATE TABLE prompts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          UUID NOT NULL,
    name            TEXT NOT NULL,
    description     TEXT,
    tags            TEXT[] NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(org_id, name)
);
CREATE INDEX idx_prompts_org ON prompts(org_id);

CREATE TABLE prompt_versions (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    prompt_id         UUID NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
    version           INTEGER NOT NULL,
    template          TEXT NOT NULL,
    template_hash     TEXT NOT NULL,            -- sha256 of normalized template
    model             TEXT NOT NULL,
    params            JSONB NOT NULL DEFAULT '{}'::jsonb,
    variables         JSONB NOT NULL DEFAULT '[]'::jsonb,
    parent_version_id UUID REFERENCES prompt_versions(id),
    change_note       TEXT,
    created_by        UUID NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(prompt_id, version)
);
CREATE INDEX idx_prompt_versions_prompt ON prompt_versions(prompt_id, version DESC);

-- Add nullable FK to telemetry_events (no backfill required)
ALTER TABLE telemetry_events
    ADD COLUMN prompt_version_id UUID REFERENCES prompt_versions(id);
CREATE INDEX idx_telemetry_prompt_version
    ON telemetry_events(prompt_version_id)
    WHERE prompt_version_id IS NOT NULL;

-- Eval runs triggered automatically on prompt version create
CREATE TABLE prompt_eval_runs (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    prompt_version_id    UUID NOT NULL REFERENCES prompt_versions(id),
    dataset_id           UUID NOT NULL,
    baseline_version_id  UUID REFERENCES prompt_versions(id),
    status               TEXT NOT NULL DEFAULT 'pending',
                          -- 'pending' | 'running' | 'completed' | 'failed'
    results              JSONB,                 -- eval_run_results shape
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at         TIMESTAMPTZ,
    CHECK (status IN ('pending', 'running', 'completed', 'failed'))
);
CREATE INDEX idx_prompt_eval_runs_version ON prompt_eval_runs(prompt_version_id);
```

### B.3 Budgets + consumption + actions (§6.3)

```sql
-- Migration: 053_budgets.sql
CREATE TABLE budgets (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          UUID NOT NULL,
    scope           TEXT NOT NULL,
                          -- 'org' | 'team:<uuid>' | 'user:<uuid>'
                          -- | 'agent:<uuid>' | 'feature:<slug>'
    period          TEXT NOT NULL,
                          -- 'hour' | 'day' | 'week' | 'month'
    limit_usd       NUMERIC(12,6) NOT NULL CHECK (limit_usd >= 0),
    action          TEXT NOT NULL,
                          -- 'alert' | 'throttle' | 'kill'
    hard_cap        BOOLEAN NOT NULL DEFAULT FALSE,
    enabled         BOOLEAN NOT NULL DEFAULT TRUE,
    created_by      UUID NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (action IN ('alert', 'throttle', 'kill')),
    CHECK (period IN ('hour', 'day', 'week', 'month'))
);
CREATE INDEX idx_budgets_org ON budgets(org_id) WHERE enabled;

CREATE TABLE budget_consumption (
    budget_id       UUID NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
    window_start    TIMESTAMPTZ NOT NULL,
    spent_usd       NUMERIC(12,6) NOT NULL DEFAULT 0,
    estimated_usd   NUMERIC(12,6) NOT NULL DEFAULT 0,
    last_updated    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (budget_id, window_start)
);

CREATE TABLE budget_actions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    budget_id       UUID NOT NULL REFERENCES budgets(id),
    trace_id        UUID,
    action_taken    TEXT NOT NULL,
                          -- 'alert_sent' | 'throttled' | 'killed' | 'estimated'
    spend_at_action NUMERIC(12,6),
    over_by_usd     NUMERIC(12,6),
    scope           TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_budget_actions_budget ON budget_actions(budget_id, created_at DESC);
```

### B.4 MCP traces (§8.1)

```sql
-- Migration: 054_mcp_traces.sql
-- MCP data lives in telemetry_events.attributes->'mcp' (JSONB) — no new tables.
-- Add a typed view for fast querying:
CREATE VIEW mcp_traces_v AS
SELECT
    id                  AS trace_id,
    (attributes->'mcp'->>'server_name')     AS mcp_server_name,
    (attributes->'mcp'->>'tool_name')       AS mcp_tool_name,
    (attributes->'mcp'->>'resource_uri')    AS mcp_resource_uri,
    (attributes->'mcp'->>'prompt_name')     AS mcp_prompt_name,
    (attributes->'mcp'->>'sampling_requested')::boolean AS mcp_sampling,
    (attributes->'mcp'->>'transport')       AS mcp_transport,
    created_at
FROM telemetry_events
WHERE attributes ? 'mcp';

-- Index on JSON path for fast filtering
CREATE INDEX idx_telemetry_mcp_server
    ON telemetry_events ((attributes->'mcp'->>'server_name'))
    WHERE attributes ? 'mcp';
```

### B.5 A2A protocol traces (§8.2)

```sql
-- Migration: 055_a2a_links.sql
CREATE TABLE a2a_links (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    parent_trace_id     UUID NOT NULL,
    child_trace_id      UUID NOT NULL,
    parent_agent_id     UUID NOT NULL,
    child_agent_id      UUID NOT NULL,
    parent_span_id      UUID NOT NULL,
    invocation_type     TEXT NOT NULL,    -- 'a2a.send_message' | 'a2a.stream' | etc.
    response_status     TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(parent_trace_id, parent_span_id, child_trace_id)
);
CREATE INDEX idx_a2a_links_parent ON a2a_links(parent_trace_id);
CREATE INDEX idx_a2a_links_child ON a2a_links(child_trace_id);

-- Add to telemetry_events
ALTER TABLE telemetry_events
    ADD COLUMN parent_agent_span_id UUID,
    ADD COLUMN child_agent_trace_id UUID;

CREATE INDEX idx_telemetry_parent_agent_span
    ON telemetry_events(parent_agent_span_id)
    WHERE parent_agent_span_id IS NOT NULL;
```

### B.6 Computer Use traces (§8.3)

```sql
-- Migration: 056_computer_use.sql
CREATE TABLE computer_use_steps (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    trace_id            UUID NOT NULL,
    span_id             UUID NOT NULL,
    step_index          INTEGER NOT NULL,
    screenshot_before   TEXT,              -- S3 URI (nullable if no before-shot)
    screenshot_after    TEXT,              -- S3 URI
    action_type         TEXT NOT NULL,     -- 'click' | 'type' | 'scroll' | 'drag' | 'key' | 'wait'
    action_payload      JSONB NOT NULL,
    target_app          TEXT,              -- 'chrome' | 'safari' | 'vscode' | ...
    target_coords       JSONB,             -- {x, y, width, height} or null
    success             BOOLEAN,
    error               TEXT,
    duration_ms         INTEGER,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(span_id, step_index),
    FOREIGN KEY (trace_id) REFERENCES telemetry_events(id) ON DELETE CASCADE
);
CREATE INDEX idx_computer_use_steps_trace ON computer_use_steps(trace_id);

-- Tombstones for S3 screenshot purge
CREATE TABLE computer_use_screenshots_tombstoned (
    s3_uri              TEXT PRIMARY KEY,
    trace_id            UUID NOT NULL,
    tombstoned_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### B.7 Voice / audio sessions (§8.4)

```sql
-- Migration: 057_voice_sessions.sql
CREATE TABLE voice_sessions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    trace_id            UUID NOT NULL,
    span_id             UUID NOT NULL,
    session_id          TEXT NOT NULL,
    transport           TEXT,              -- 'webrtc' | 'websocket' | 'sip'
    asr_provider         TEXT,              -- 'deepgram' | 'whisper' | 'assemblyai'
    asr_latency_ms       INTEGER,
    asr_confidence      NUMERIC(4,3),
    asr_input_audio_ms  INTEGER,
    llm_first_audio_ms  INTEGER,
    tts_provider         TEXT,              -- 'elevenlabs' | 'cartesia' | 'openai'
    tts_first_byte_ms    INTEGER,
    tts_total_ms         INTEGER,
    barge_in_detected    BOOLEAN DEFAULT FALSE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    FOREIGN KEY (trace_id) REFERENCES telemetry_events(id) ON DELETE CASCADE
);
CREATE INDEX idx_voice_sessions_trace ON voice_sessions(trace_id);
CREATE INDEX idx_voice_sessions_session ON voice_sessions(session_id, created_at DESC);
```

### B.8 Provider routing attempts (§2.12)

```sql
-- Migration: 058_provider_routing.sql
CREATE TABLE provider_routing_attempts (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    trace_id            UUID NOT NULL,
    span_id             UUID NOT NULL,
    attempted_provider  TEXT NOT NULL,    -- 'openai' | 'anthropic' | 'google' | ...
    attempted_model     TEXT NOT NULL,
    failure_reason      TEXT,             -- null on success
    latency_ms          INTEGER,
    decision            TEXT NOT NULL,    -- 'success' | 'fallback' | 'retry' | 'abort'
    sequence_index      INTEGER NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (decision IN ('success', 'fallback', 'retry', 'abort'))
);
CREATE INDEX idx_provider_routing_trace ON provider_routing_attempts(trace_id, sequence_index);
```

### B.9 Fine-tuning lineage (§8.7)

```sql
-- Migration: 059_fine_tune_lineage.sql
CREATE TABLE fine_tuning_runs (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id              UUID NOT NULL,
    provider            TEXT NOT NULL,    -- 'openai' | 'together' | 'anyscale'
    base_model          TEXT NOT NULL,
    fine_tuned_model    TEXT NOT NULL,
    dataset_id          UUID NOT NULL,
    training_params     JSONB NOT NULL DEFAULT '{}'::jsonb,
    status              TEXT NOT NULL DEFAULT 'pending',
                          -- 'pending' | 'running' | 'succeeded' | 'failed'
    eval_results        JSONB,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at        TIMESTAMPTZ
);

-- Link fine-tunes back to the traces that built their dataset
CREATE TABLE dataset_trace_lineage (
    dataset_id          UUID NOT NULL,
    trace_id            UUID NOT NULL,
    span_id             UUID,
    added_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (dataset_id, trace_id)
);

-- Link fine-tunes to traces that used the fine-tuned model (forward lineage)
CREATE TABLE fine_tune_trace_usage (
    fine_tuning_run_id  UUID NOT NULL REFERENCES fine_tuning_runs(id),
    trace_id            UUID NOT NULL,
    first_used_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (fine_tuning_run_id, trace_id)
);
```

### B.10 RTBF cross-store extensions (§6.4)

```sql
-- Migration: 060_rtbf_tombstones.sql
-- Tombstones for S3 object filtering at query time
CREATE TABLE s3_tombstones (
    s3_uri              TEXT PRIMARY KEY,
    trace_id            UUID NOT NULL,
    subject_hash        TEXT NOT NULL,    -- anon_<sha256[:16]>
    tombstoned_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at          TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_s3_tombstones_trace ON s3_tombstones(trace_id);

-- RTBF run audit (extends existing pii_findings)
CREATE TABLE rtbf_runs (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subject_user_id     UUID NOT NULL,
    subject_hash        TEXT NOT NULL,    -- anon_<sha256[:16]>
    requested_by        UUID NOT NULL,
    reason              TEXT NOT NULL,    -- 'gdpr_art_17' | 'manual'
    phases_total        INTEGER NOT NULL,
    phases_completed    INTEGER NOT NULL DEFAULT 0,
    phases_failed       JSONB NOT NULL DEFAULT '[]'::jsonb,
                          -- [{phase: 'clickhouse', error: '...'}, ...]
    status              TEXT NOT NULL DEFAULT 'in_progress',
                          -- 'in_progress' | 'completed' | 'failed'
    started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at        TIMESTAMPTZ,
    CHECK (status IN ('in_progress', 'completed', 'failed'))
);
```

### B.11 Webhooks reliability (§2.17)

```sql
-- Migration: 061_webhooks.sql
CREATE TABLE webhook_endpoints (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id              UUID NOT NULL,
    url                 TEXT NOT NULL,
    secret              TEXT NOT NULL,    -- for HMAC-SHA256 signing
    events              TEXT[] NOT NULL,  -- list of subscribed hook reasons
    enabled             BOOLEAN NOT NULL DEFAULT TRUE,
    rate_limit_per_min  INTEGER DEFAULT 60,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE webhook_deliveries (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    endpoint_id         UUID NOT NULL REFERENCES webhook_endpoints(id),
    event_type          TEXT NOT NULL,
    payload             JSONB NOT NULL,
    attempt_count       INTEGER NOT NULL DEFAULT 0,
    max_attempts        INTEGER NOT NULL DEFAULT 6,
    next_attempt_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    status              TEXT NOT NULL DEFAULT 'pending',
                          -- 'pending' | 'success' | 'failed' | 'dlq'
    response_status     INTEGER,
    response_body       TEXT,
    last_error          TEXT,
    delivered_at        TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (status IN ('pending', 'success', 'failed', 'dlq'))
);
CREATE INDEX idx_webhook_deliveries_pending
    ON webhook_deliveries(next_attempt_at)
    WHERE status = 'pending';
CREATE INDEX idx_webhook_deliveries_endpoint
    ON webhook_deliveries(endpoint_id, created_at DESC);

CREATE TABLE webhook_dlq (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    delivery_id         UUID NOT NULL REFERENCES webhook_deliveries(id),
    reason              TEXT NOT NULL,
    failed_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### B.12 Multi-region routing (§8.8)

```sql
-- Migration: 062_multi_region.sql
CREATE TABLE org_data_residency (
    org_id              UUID PRIMARY KEY,
    data_region         TEXT NOT NULL DEFAULT 'us',
                          -- 'us' | 'eu' | 'ap'
    configured_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    configured_by       UUID NOT NULL,
    CHECK (data_region IN ('us', 'eu', 'ap'))
);

-- Region-aware view of telemetry_events (for cross-region routing)
ALTER TABLE telemetry_events
    ADD COLUMN data_region TEXT NOT NULL DEFAULT 'us';
CREATE INDEX idx_telemetry_region
    ON telemetry_events(org_id, data_region, created_at DESC);
```

### B.13 Onboarding state (§10)

```sql
-- Migration: 063_onboarding_state.sql
CREATE TABLE onboarding_state (
    org_id              UUID PRIMARY KEY,
    current_step        TEXT NOT NULL DEFAULT 'install',
    completed_steps     TEXT[] NOT NULL DEFAULT '{}',
    cat_enablements     JSONB NOT NULL DEFAULT '{}'::jsonb,
                          -- {"cat-3": {"enabled_at": "...", "config": {...}}, ...}
    first_trace_at      TIMESTAMPTZ,
    milestones_reached  TEXT[] NOT NULL DEFAULT '{}',
                          -- ['first_10_traces', 'first_judge_score', ...]
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### B.14 Feature flags consolidation (§9.4)

```sql
-- Migration: 064_flags.sql
CREATE TABLE feature_flags (
    name                TEXT PRIMARY KEY,
    default_value       TEXT NOT NULL,    -- 'on' | 'off' | JSON-encoded value
    description         TEXT NOT NULL,
    owning_cat          TEXT NOT NULL,    -- 'cat-3' | 'cat-23' | etc.
    expires_at          TIMESTAMPTZ,
    status              TEXT NOT NULL DEFAULT 'active',
                          -- 'active' | 'graduated' | 'deprecated'
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE feature_flag_evaluations (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id              UUID NOT NULL,
    flag_name           TEXT NOT NULL REFERENCES feature_flags(name),
    evaluated_value     TEXT NOT NULL,
    source              TEXT NOT NULL,    -- 'default' | 'org_override' | 'pilot'
    evaluated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_flag_eval_org ON feature_flag_evaluations(org_id, flag_name, evaluated_at DESC);

CREATE TABLE feature_flag_org_overrides (
    org_id              UUID NOT NULL,
    flag_name           TEXT NOT NULL REFERENCES feature_flags(name),
    override_value      TEXT NOT NULL,
    set_by              UUID NOT NULL,
    set_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at          TIMESTAMPTZ,
    PRIMARY KEY (org_id, flag_name)
);
```

---

## SECTION C — API contracts

### C.1 Streaming tokens (§6.1)

```yaml
# OpenAPI fragment
/v1/traces/{trace_id}/tokens:
  get:
    summary: List token-level events for a trace
    parameters:
      - name: trace_id
        in: path
        required: true
        schema: { type: string, format: uuid }
      - name: include_text
        in: query
        schema: { type: boolean, default: false }
    responses:
      200:
        content:
          application/json:
            schema:
              type: object
              properties:
                tokens:
                  type: array
                  items:
                    type: object
                    properties:
                      i:        { type: integer }
                      delta_ms: { type: integer }
                      abs_ms:   { type: integer }
                      byte_len: { type: integer }
                      text:     { type: string }   # only if include_text=true
                      redacted: { type: boolean }
                stats:
                  type: object
                  properties:
                    count:    { type: integer }
                    p50_ms:   { type: number }
                    p95_ms:   { type: number }
                    p99_ms:   { type: number }
                    total_ms: { type: integer }
                    stalls:   { type: integer }
```

### C.2 Prompts (§6.2)

```yaml
/v1/prompts:
  get:    # list prompts for org
    parameters:
      - name: tags
        in: query
        schema: { type: array, items: { type: string } }
  post:   # create new prompt
    body:
      type: object
      required: [name, template, model]
      properties:
        name:        { type: string }
        description: { type: string }
        tags:        { type: array, items: { type: string } }
        template:    { type: string }
        model:       { type: string }
        params:      { type: object }
        variables:   { type: array, items: { type: string } }
        change_note: { type: string }

/v1/prompts/{prompt_id}:
  get:    # prompt detail with version history
  patch:  # update metadata (name/description/tags only)

/v1/prompts/{prompt_id}/versions:
  post:   # create new version (auto-increments version, triggers eval run)
  get:    # list versions

/v1/prompts/{prompt_id}/versions/{version}:
  get:    # specific version + its eval results

/v1/prompts/{prompt_id}/versions/{version}/traces:
  get:    # list traces that used this version
    parameters:
      - name: since
        in: query
        schema: { type: string, format: date-time }
      - name: limit
        in: query
        schema: { type: integer, default: 50 }
      - name: cursor
        in: query
        schema: { type: string }
```

### C.3 Budgets (§6.3)

```yaml
/v1/budgets:
  get:    # list budgets for org (filtered by caller role)
  post:
    body:
      type: object
      required: [scope, period, limit_usd, action]
      properties:
        scope:      { type: string, enum: [org, team, user, agent, feature] }
        period:     { type: string, enum: [hour, day, week, month] }
        limit_usd:  { type: number, format: float }
        action:     { type: string, enum: [alert, throttle, kill] }
        hard_cap:   { type: boolean, default: false }

/v1/budgets/{budget_id}:
  get:    # budget + current consumption
  patch:  # update limit, action, enabled
  delete: # soft delete (enabled=false)

/v1/budgets/{budget_id}/consumption:
  get:    # time-series of consumption (last 30d default)

/v1/budgets/{budget_id}/actions:
  get:    # audit log of throttled/killed/alerted actions
```

### C.4 RTBF (§6.4)

```yaml
/v1/governance/rtbf:
  post:
    body:
      type: object
      required: [subject_user_id, reason]
      properties:
        subject_user_id: { type: string, format: uuid }
        reason:          { type: string, enum: [gdpr_art_17, manual] }
        dry_run:         { type: boolean, default: false }
    responses:
      202:
        content:
          application/json:
            schema:
              type: object
              properties:
                run_id:        { type: string, format: uuid }
                phases_total:  { type: integer }

/v1/governance/rtbf/{run_id}:
  get:    # poll status

/v1/governance/rtbf/{run_id}/retry:
  post:
    body:
      type: object
      properties:
        phases: { type: array, items: { type: string } }
                # e.g. ['clickhouse', 's3'] — retry only failed phases
```

### C.5 Closed-loop hooks query (§E)

```yaml
/v1/hooks:
  get:    # list active hooks for org
  post:   # configure hook subscriber

/v1/hooks/events:
  get:    # recent hook firings (filterable by reason, severity, time)
    parameters:
      - name: reason
        in: query
        schema: { type: string }
      - name: severity
        in: query
        schema: { type: string, enum: [low, medium, high, critical] }
      - name: since
        in: query
        schema: { type: string, format: date-time }
      - name: hook_id
        in: query
        schema: { type: string, format: uuid }
```

### C.6 Multi-region (§8.8)

```yaml
/v1/admin/data_residency:
  get:    # current org's residency
  post:
    body:
      type: object
      required: [data_region]
      properties:
        data_region: { type: string, enum: [us, eu, ap] }
    # Note: changing data_region triggers a one-time data migration job
    # (async, ~24-72h depending on volume)
```

### C.7 Webhooks (§2.17, §B.11)

```yaml
/v1/webhooks/endpoints:
  get:
  post:
    body:
      type: object
      required: [url, events]
      properties:
        url:     { type: string, format: uri }
        events:  { type: array, items: { type: string } }
                # e.g. ['low_user_satisfaction', 'budget_exceeded', 'drift_alert']
        secret:  { type: string }
                # if omitted, server generates; returned once on create

/v1/webhooks/endpoints/{id}:
  patch:  # update url, events, enabled
  delete: # disable (soft delete + secret rotation)

/v1/webhooks/deliveries:
  get:    # list recent deliveries (filterable by status, endpoint)

/v1/webhooks/deliveries/{id}/replay:
  post:   # re-queue a failed or dlq delivery
```

### C.8 MCP / A2A / Computer Use / Voice (§8)

```yaml
/v1/traces/{trace_id}/mcp:
  get:    # MCP-specific span attributes for this trace
  # returns: [{server_name, tool_name, resource_uri, prompt_name, sampling, transport}]

/v1/traces/{trace_id}/a2a:
  get:    # A2A links from this trace
  # returns: {parent: [...], children: [{trace_id, agent_id, invocation_type, response_status}]}

/v1/traces/{trace_id}/computer_use:
  get:    # computer use steps with screenshot URIs
  # returns: {steps: [{step_index, action_type, action_payload, target_app, success, screenshot_before, screenshot_after}]}

/v1/voice_sessions:
  get:    # list voice sessions with filtering (provider, barge_in, etc.)
    parameters:
      - name: provider
        in: query
      - name: had_barge_in
        in: query
      - name: asr_p95_ms_gt
        in: query

/v1/fine_tuning_runs:
  get:    # list fine-tuning runs
  post:   # register a fine-tuning run (manual or via provider webhook)

/v1/fine_tuning_runs/{id}/lineage:
  get:    # trace -> dataset -> fine-tune + fine-tune -> trace usage
```

---

## SECTION D — Per-cat spec sheets

### D.1 Cat 13 APM Depth → CUT (migrate to OTel Collector + K8s)

**Decision:** remove `eden/apm/sampling.py`, `eden/apm/k8s.py`, `eden/apm/profiling.py`; rely on OTel Collector `tail_sampling` + `k8sattributes` processors.

**Migration steps:**

1. **Add OTel Collector config** (existing `deploy/otel-collector-config.yaml`):
   ```yaml
   processors:
     tail_sampling:
       decision_wait: 10s
       num_traces: 20000
       expected_new_traces_per_sec: 5000
       policies:
         - name: errors
           type: status_code
           status_code: { status_codes: [ERROR] }
         - name: slow
           type: latency
           latency: { threshold_ms: 5000 }
         - name: force_trace
           type: string_attribute
           string_attribute: { key: eden.force_trace, values: [true] }
     k8sattributes:
       passthrough: false
       auth_type: serviceAccount
       extract:
         metadata: [k8s.pod.name, k8s.namespace.name, k8s.deployment.name]
   exporters:
     otlp/eden:
       endpoint: eden-gateway:4317
   service:
     pipelines:
       traces:
         receivers: [otlp]
         processors: [tail_sampling, k8sattributes, batch]
         exporters: [otlp/eden]
   ```

2. **Remove from gateway code:**
   - Delete `src/eden/apm/sampling.py`, `k8s.py`, `profiling.py`
   - Delete `migrations/026_apm_*.sql` tables (`apm_sampling_decisions`, `apm_k8s_enrichment_log`, `trace_step_profile_links`)
   - Delete `src/eden/apm/` route modules
   - Update portal to remove APM tabs

3. **Verify no closed-loop hook depends on these:**
   - Search `promotion_hooks.py` for `apm_*` references — should be none
   - If found, redirect to the underlying OTel attributes

4. **Pyroscope correlation:** delete `build_pyroscope_url` references. If customers ask, point them to Grafana Phlare (better tool anyway).

5. **Customer migration note:**
   - Send email to APM-enabled orgs: "APM features are now powered by standard OTel Collector. Run `helm upgrade eden-collector` to apply."

**Estimated time:** 1-2 weeks.
**Risk:** low — Pyroscope correlation has no committed customers yet (per the roadmap narrative).
**Tests removed:** ~72 tests; replaced with 5 integration tests for the OTel collector config.

### D.2 Cat 9 → Flat Beta-Binomial + 3 trackers

**Decision:** remove `UserBehaviouralSignal.COPY_PASTE`, `UserBehaviouralSignal.RETRY`, `UserBehaviouralSignal.RETURN_TO_THREAD`. Drop hierarchical Beta-Binomial (org → feature → user). Keep Beta-Binomial at feature level.

**Migration steps:**

1. **Schema change** (new migration `065_cat9_flatten.sql`):
   ```sql
   -- Drop the copy_paste, retry, return signals
   DELETE FROM user_behavioural_signals
   WHERE signal_type IN ('copy_paste', 'retry', 'return_to_thread');

   ALTER TABLE user_behavioural_signals
       DROP CONSTRAINT user_behavioural_signals_signal_type_check;

   ALTER TABLE user_behavioural_signals
       ADD CONSTRAINT user_behavioural_signals_signal_type_check
       CHECK (signal_type IN ('regeneration', 'edit', 'abandonment'));

   -- Flat satisfaction: drop org/feature hierarchy
   ALTER TABLE user_satisfaction_corrected
       DROP COLUMN org_prior_alpha,
       DROP COLUMN org_prior_beta,
       DROP COLUMN feature_prior_alpha,
       DROP COLUMN feature_prior_beta;
   ```

2. **Code change:** remove `HierarchicalBetaBinomialCorrector`, replace with `FlatBetaBinomialCorrector`. Update `BehaviouralDashboard` to remove 3 cohorts.

3. **Tests:** keep ~30 tests for the 3 trackers (down from 55). Update `test_user_satisfaction_corrected` to use flat prior (Beta(1,1)).

**Estimated time:** 1 week.
**Risk:** low — additive data is dropped; recomputable.

### D.3 Cat 11 (Predictive) → 2 services

**Decision:** keep `QualityPredictor` (trailing-mean judge projection) + `DriftDetector` (PSI on judge distribution). Cut `CostPredictor`, `CapacityPredictor`, `RiskScorer`, embedding hash drift.

**Migration steps:**

1. **Delete services:** `cost_predictor.py`, `capacity_predictor.py`, `risk_sorer.py`, `embedding_drift.py`.
2. **Delete tables:** `cost_forecasts`, `capacity_forecasts`, `risk_scores`, `embedding_drift_log`.
3. **Move CostPredictor logic into Cat 7 (Cost Intelligence):** keep the trailing-median projection; it's used by the budget guardrail (§6.3).
4. **Keep closed-loop hooks:** `on_drift_alert` (PSI only), `on_quality_regression`. Delete `on_capacity_warning`, `on_risk_threshold`.

**Estimated time:** 1 week.
**Risk:** low — no closed-loop dependency on the removed services.

### D.4 Cat 12 (Autonomous) → 2 services

**Decision:** keep `InvestigationAgent` + `NLReportGenerator`. Cut `ReportGenerator` (duplicate), `RecommendationEngine` (folded into InvestigationAgent), `SelfHealer` UI, `AutoDashboardBuilder`, `NLQueryEngine`.

**Migration steps:**

1. **Fold `ReportGenerator` into `InvestigationAgent.report()` method.**
2. **Fold `RecommendationEngine` into `InvestigationAgent.recommend()` method.**
3. **Delete:** `self_healer_ui.py`, `auto_dashboard_builder.py`, `nl_query_engine.py`.
4. **Tables:** drop `auto_dashboards`, `nl_query_log`. Keep `investigation_reports` (Cat 14 spine).

**Estimated time:** 1 week.
**Risk:** medium — if anyone built UI on top of `auto_dashboards`, they'll need migration. Run a usage query first.

### D.5 Cat 10 (Governance) → SOC2 + GDPR only

**Decision:** keep SOC2 Type II + GDPR (incl. Art.17 RTBF). Defer HIPAA + ISO27001 to v2.

**Migration steps:**

1. **Move HIPAA + ISO27001 controls to `docs/eden-governance-roadmap.md`** (not in code).
2. **Update portal:** remove HIPAA + ISO27001 tabs from compliance dashboard.
3. **Update sales materials:** remove HIPAA + ISO27001 from enterprise pitch until customer demand.

**Estimated time:** 1 week.
**Risk:** low — purely marketing surface.

### D.6 Cat 18 (Columnar) → daily/weekly rollups only

**Decision:** drop hourly rollups. Keep daily + weekly.

**Migration steps:**

1. **Schema:** drop `columnar_hourly_rollups` table.
2. **Compaction:** update `ColumnarCompactor` to skip hourly schedule.
3. **UI:** remove hourly granularity selector.

**Estimated time:** 1 week.
**Risk:** low — daily is the UI default anyway.

### D.7 Cat 23 STUB → defer 7 tables

**Decision:** ship only the 12 core tables. Defer `inbox_*` (4 tables), `persona_*` (2 tables), `style_*` (2 tables) to "create on first PR."

**Migration steps:**

1. **Update migration 027:** remove the 7 deferred tables from the schema. (Cat 23 memory says migration is `041_cat23_autonomous_code_modification.sql` per git status — adjust accordingly.)
2. **Update service classes:** mark `InboxService`, `PersonaStyleLearner`, `StyleEnforcer` as `pending=True` (not registered with the worker).
3. **Update routes:** keep the routes but return 503 with `Retry-After: 86400` for now.

**Estimated time:** 1 week.
**Risk:** low — STUB is pre-implementation.

### D.8 NEW: Streaming traces (§6.1)

**Spec sheet:**
- **Data model:** `streaming_tokens` (Postgres) + `streaming_tokens_ch` (ClickHouse) — §B.1
- **API:** `/v1/traces/{trace_id}/tokens` — §C.1
- **SDK:** auto-instrument SSE/WebSocket LLM responses; emit `streaming.token` events
- **UI:** replace completion blob with per-token sparkline in trace detail
- **Hooks:** none new; `low_user_satisfaction` + `judge_regression` may correlate with token stalls
- **Tests:** ~25 (token ordering, redaction, stall detection, partial failure, throughput)
- **Acceptance:** p95 token write latency <50ms; 10k tokens/sec/org sustained
- **Estimated time:** 2 weeks

### D.9 NEW: Prompt versioning (§6.2)

**Spec sheet:**
- **Data model:** `prompts` + `prompt_versions` + `prompt_eval_runs` — §B.2
- **API:** `/v1/prompts/*` — §C.2
- **SDK:** `@prompt()` decorator (Python); `prompt()` helper (TS)
- **UI:** prompt list + version timeline + diff view + "traces that used this version"
- **Auto-eval:** on every new prompt version, run eval against pinned dataset if `auto_eval_on_save=true`
- **Tests:** ~20 (version monotonicity, template hash, lineage, backfill)
- **Acceptance:** SDK emit latency <5ms; eval-on-save p95 <30s for 100-row dataset
- **Estimated time:** 3 weeks

### D.10 NEW: Cost guardrails (§6.3)

**Spec sheet:**
- **Data model:** `budgets` + `budget_consumption` + `budget_actions` — §B.3
- **API:** `/v1/budgets/*` — §C.3
- **Enforcement:** in `eden.gateway.ingest`, before token counting
- **Feature flag:** `budget_enforcement_enabled` per org (default off for existing customers)
- **Hooks:** `on_budget_threshold_breached`, `on_budget_exceeded`
- **Tests:** ~15 (hard cap, window rollover, concurrent enforcement, estimate vs actual)
- **Acceptance:** pre-token-count overhead <2ms p95; hard cap blocks 100% of over-limit requests
- **Estimated time:** 2 weeks

### D.11 NEW: RTBF cross-store (§6.4)

**Spec sheet:**
- **Data model:** `s3_tombstones` + `rtbf_runs` — §B.10
- **API:** `/v1/governance/rtbf/*` — §C.4
- **Phases:** Postgres → ClickHouse → S3 (tombstone) → Redis → backups (audit-only)
- **Tests:** ~10 (per-phase, concurrent, audit trail)
- **Acceptance:** all phases complete in <6h for 1M trace volume; audit log queryable 1 year post-completion
- **Estimated time:** 3 weeks
- **Risk:** medium — needs legal review before shipping

### D.12 NEW: MCP / A2A / Computer Use / Voice / Fine-tune lineage (§8)

**Spec sheet (combined for compactness):**

| Sub-spec                 | Tables                                                               | API routes                     | SDK work                                                     | Tests | Effort          |
| ------------------------ | -------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------ | ----- | --------------- |
| MCP (§8.1)               | view only                                                            | `/v1/traces/{id}/mcp`          | Python: `mcp` auto-instrument; TS: same                      | ~8    | 1 week          |
| A2A (§8.2)               | `a2a_links`                                                          | `/v1/traces/{id}/a2a`          | Python: `a2a` auto-instrument; TS: same                      | ~10   | 2 weeks         |
| Computer Use (§8.3)      | `computer_use_steps`, `computer_use_screenshots_tombstoned`          | `/v1/traces/{id}/computer_use` | Python: `claude-computer-use`, `openai-operator`; TS: same   | ~12   | 2 weeks         |
| Voice (§8.4)             | `voice_sessions`                                                     | `/v1/voice_sessions`           | Python: LiveKit, Vapi, Retell AI plugins                     | ~15   | 3 weeks         |
| Fine-tune lineage (§8.7) | `fine_tuning_runs`, `dataset_trace_lineage`, `fine_tune_trace_usage` | `/v1/fine_tuning_runs/*`       | Python: `openai.fine_tuning.jobs.*` webhook ingest; TS: same | ~12   | 2 weeks         |
| Provider routing (§2.12) | `provider_routing_attempts`                                          | (extension of trace view)      | Python: LiteLLM, Portkey, OpenRouter middleware              | ~10   | 1 week          |
| Multi-region (§8.8)      | `org_data_residency`                                                 | `/v1/admin/data_residency`     | Region-aware endpoint routing                                | ~8    | 6 weeks (infra) |

**Total new spec effort:** ~17 weeks.

### D.13 NEW: Webhooks reliability (§2.17, §B.11)

**Spec sheet:**
- **Data model:** `webhook_endpoints` + `webhook_deliveries` + `webhook_dlq` — §B.11
- **API:** `/v1/webhooks/*` — §C.7
- **Signing:** HMAC-SHA256, header `X-Eden-Signature: t=<unix_ts>,v1=<sig>`
- **Backoff:** 1s, 5s, 25s, 2m, 10m, 1h, then DLQ
- **Replay UI:** in portal, with audit log
- **Tests:** ~12 (retry, DLQ, signature verification, replay)
- **Acceptance:** delivery p95 <2s; 99.9% success rate for healthy endpoints
- **Estimated time:** 2 weeks

### D.14 NEW: Cold-start UX (§10)

**Spec sheet:**
- **Data model:** `onboarding_state` — §B.13
- **Onboarding flow:** 7-day guided checklist (see §10.1)
- **Progressive disclosure:** §10.2 schedule
- **Value moments:** §10.3 copy
- **API:** internal — `/v1/internal/onboarding/{org_id}/state`
- **Tests:** ~10 (state transitions, default enablements, copy correctness)
- **Estimated time:** 2-3 weeks (UX-heavy)

---

## SECTION E — Closed-loop hook specification

### E.1 The 20+ hooks (canonical taxonomy)

| #   | Hook reason                          | Source | Severity    | Default action                    | Requires approval |
| --- | ------------------------------------ | ------ | ----------- | --------------------------------- | ----------------- |
| 1   | `low_user_satisfaction`              | Cat 8  | medium      | Alert → Investigation             | No                |
| 2   | `low_roi_department`                 | Cat 18 | medium      | Alert → Investigation             | No                |
| 3   | `compliance_gap:soc2`                | Cat 9  | high        | Alert → Investigation             | No                |
| 4   | `compliance_gap:gdpr`                | Cat 9  | critical    | Alert + Auto-RTBF suggestion      | Yes               |
| 5   | `compliance_gap:hipaa`               | Cat 9  | high        | Alert                             | No                |
| 6   | `compliance_gap:iso27001`            | Cat 9  | high        | Alert                             | No                |
| 7   | `security:pii_scanner`               | Cat 9  | high        | Alert + Redaction suggestion      | Yes               |
| 8   | `security:secret_detector`           | Cat 9  | critical    | Alert + Auto-redact (no approval) | No                |
| 9   | `sla_breach`                         | Cat 16 | high        | Alert → Investigation             | No                |
| 10  | `compaction_failed`                  | Cat 16 | medium      | Alert (internal only)             | No                |
| 11  | `ch_unavailable`                     | Cat 16 | critical    | Alert + Fallback to Postgres      | No                |
| 12  | `drift_alert`                        | Cat 11 | medium-high | Alert → Investigation             | No                |
| 13  | `judge_regression`                   | Cat 3  | high        | Alert → Investigation             | No                |
| 14  | `judge_threshold_breach`             | Cat 3  | medium      | Alert                             | No                |
| 15  | `fleet_deprecation:*`                | Cat 6  | low         | Alert                             | No                |
| 16  | `budget_threshold_breached`          | §6.3   | medium      | Alert + Throttle at 100%          | No                |
| 17  | `budget_exceeded`                    | §6.3   | high        | Alert + (Throttle                 | Kill) per action  |
| 18  | `prompt_version_eval_regression`     | §6.2   | medium      | Alert → Investigation             | No                |
| 19  | `incident_clustered`                 | Cat 2  | medium      | Alert → RCA                       | No                |
| 20  | `outage_detected:*`                  | §2.4   | high        | Alert → Investigation             | No                |
| 21  | `mcp_server_auth_failure`            | §8.1   | medium      | Alert                             | No                |
| 22  | `a2a_invocation_failed`              | §8.2   | medium      | Alert                             | No                |
| 23  | `computer_use_blocked`               | §8.3   | high        | Alert + Pause session             | Yes               |
| 24  | `voice_barge_in_spike`               | §8.4   | low         | Alert                             | No                |
| 25  | `fine_tune_data_drift`               | §8.7   | medium      | Alert → Investigation             | No                |
| 26  | `provider_routing_repeated_failures` | §2.12  | medium      | Alert                             | No                |

### E.2 Hook bus specification

```python
# src/eden/hooks/bus.py
@dataclass
class HookEvent:
    reason: str                              # from §E.1
    severity: Literal['low', 'medium', 'high', 'critical']
    org_id: UUID
    source: dict                             # the data that triggered (e.g., satisfaction_score)
    context: dict                            # org/team/user/agent context
    timestamp: datetime
    parent_hook_id: Optional[UUID] = None    # for dedup/cascade
    dedup_window_seconds: int = 300          # default 5 min
    requires_human_approval: bool = False    # from §E.1

class HookBus:
    def emit(self, event: HookEvent) -> UUID:
        """Returns hook_id. Side effects: dedup → persist → fan-out."""
        ...

    def fan_out(self, hook_id: UUID) -> List[UUID]:
        """Returns list of downstream action_ids."""
        ...
```

### E.3 Dedup + precedence rules

1. **Within `dedup_window_seconds`**, if a hook with the same `(reason, org_id, primary_entity_id)` already fired, increment `repetition_count` instead of emitting a new event. The dedup window is per-reason.
2. **Cascade dedup:** if `parent_hook_id` is set, the new event inherits the parent's `dedup_window` and joins the cascade. Cascade fan-out runs once for the whole group, not per-child.
3. **Precedence:** higher severity hooks suppress lower-severity hooks for the same entity within 1 hour.
4. **Order of fan-out:** PII redaction → RTBF suggestion → InvestigationAgent → RCA → alert (webhook/Slack/email).

### E.4 Approval gate (mandatory for hooks that mutate)

Any hook that triggers a write must pass `PromotionHook.propose()`:

```python
# src/eden/hooks/approval.py
class PromotionProposal(BaseModel):
    action: Literal['anonymize', 'redact', 'rtbf', 'throttle', 'kill', 'rollback_prompt', 'pause_session']
    target_id: UUID
    target_type: str
    reason_hook_id: UUID
    proposed_at: datetime
    proposed_by: Literal['system', 'user_id']
    requires_approval: bool
    approved_by: Optional[UUID] = None
    approved_at: Optional[datetime] = None
    status: Literal['pending', 'approved', 'rejected', 'expired']
    expires_at: datetime  # default +24h

def propose(proposal: PromotionProposal) -> UUID:
    """Returns proposal_id. Auto-approves if requires_approval=False."""
    ...
```

### E.5 Audit trail

Every hook firing writes to `hook_events` table:
```sql
CREATE TABLE hook_events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          UUID NOT NULL,
    reason          TEXT NOT NULL,
    severity        TEXT NOT NULL,
    source          JSONB NOT NULL,
    context         JSONB NOT NULL,
    parent_hook_id  UUID,
    repetition_count INTEGER NOT NULL DEFAULT 1,
    dedup_window_seconds INTEGER NOT NULL DEFAULT 300,
    fan_out_actions JSONB,                  -- list of downstream action_ids
    proposals       JSONB,                  -- list of PromotionProposal ids
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_hook_events_org_time ON hook_events(org_id, created_at DESC);
CREATE INDEX idx_hook_events_reason ON hook_events(reason, created_at DESC);
```

### E.6 Hook configuration (per-org)

```yaml
# /v1/hooks config payload
hook_subscriptions:
  - reason: low_user_satisfaction
    severity_threshold: medium
    channels:
      - slack:#alerts-llm
      - webhook:abc123
    auto_propose: investigation_report
  - reason: compliance_gap:gdpr
    severity_threshold: low
    channels:
      - email:legal@company.com
      - webhook:legal-webhook-id
    auto_propose: rtbf_workflow
    auto_approve: false  # always require human approval
```

---

## SECTION F — Migration runbook

### F.1 Sequencing principle

The 22-week spec is decomposed into 4 phases to manage risk:

**Phase 1 — Cut the bloat (weeks 1-3):**
- D.1 Cat 13 APM cut
- D.2 Cat 9 flatten
- D.3 Cat 11 trim
- D.4 Cat 12 trim
- D.5 Cat 10 trim
- D.6 Cat 18 trim
- D.7 Cat 23 trim

**Phase 2 — Ship the spine gaps (weeks 4-10):**
- D.8 Streaming tokens
- D.9 Prompt versioning
- D.10 Cost guardrails
- D.13 Webhooks reliability

**Phase 3 — Coverage completeness (weeks 11-17):**
- D.11 RTBF cross-store
- D.12 MCP / A2A / Computer Use / Voice / Fine-tune / Provider routing
- D.14 Cold-start UX

**Phase 4 — Infrastructure (weeks 18-22):**
- D.12 Multi-region
- Operational debt (§9): migrations, test pyramid, flags consolidation

### F.2 Phase 1 — Cut the bloat runbook

**Pre-flight checklist:**
- [ ] Verify no closed-loop hook depends on Cat 13 APM
- [ ] Verify no customer UI depends on the 3 Cat 9 trackers (query `usage_events` for `signal_type IN ('copy_paste', 'retry', 'return_to_thread')`)
- [ ] Verify no customer UI depends on Cat 11 `cost_forecasts`, `capacity_forecasts`, `risk_scores`, `embedding_drift_log`
- [ ] Verify no customer UI depends on Cat 12 `auto_dashboards`, `nl_query_log`
- [ ] Verify no customer UI depends on Cat 18 hourly granularity
- [ ] Verify no customer UI depends on Cat 23 inbox/persona/style

**Cut steps (per cat):**
1. Add `legacy_compat` flag (default on for orgs created before cut date)
2. Mark services as deprecated in `eden/cat_*/service.py` (`@deprecated(since="v1.6", removal="v2.0")`)
3. Update route handlers to log a deprecation warning + return data if `legacy_compat=true`
4. Wait 30 days; query usage
5. Drop routes + tables + services

### F.3 Phase 2 — Ship the spine gaps runbook

**Streaming tokens (§D.8):**
1. Migration 051 (§B.1)
2. ClickHouse mirror in worker
3. SDK changes: Python (`openai`, `anthropic` plugins), TS (`openai`, `anthropic`, `vercel-ai-sdk`)
4. Gateway: hook into SSE handler in `eden/gateway/sse_proxy.py`
5. Portal: trace detail UI
6. Tests
7. Feature flag: `streaming_tokens_enabled` per org (default off)
8. Rollout: pilot to 5 customers, monitor for 1 week, then default-on

**Prompt versioning (§D.9):**
1. Migration 052 (§B.2)
2. Python SDK: `@prompt()` decorator
3. TS SDK: `prompt()` helper
4. OpenAI/Anthropic SDK auto-emit
5. Auto-eval runner (Cron + on-version-create trigger)
6. Portal: prompt list + version timeline + diff + "traces that used this version"
7. Tests
8. Rollout: pilot to 5 customers, monitor for 2 weeks (eval-on-save overhead)

**Cost guardrails (§D.10):**
1. Migration 053 (§B.3)
2. Gateway enforcement (`eden/gateway/ingest.py`)
3. Portal: budget admin + real-time ticker
4. Tests (especially concurrent enforcement)
5. Feature flag: `budget_enforcement_enabled` (default off)
6. Rollout: pilot to 5 customers, monitor for 2 weeks

**Webhooks (§D.13):**
1. Migration 061 (§B.11)
2. Hook bus integration: `hook_subscriptions` resolved at fire-time
3. Signing (HMAC-SHA256)
4. Backoff scheduler (Redis BullMQ)
5. DLQ + replay UI
6. Tests
7. Rollout: default-on (webhooks are user-facing)

### F.4 Phase 3 — Coverage completeness runbook

**MCP / A2A / Computer Use / Voice / Fine-tune / Provider routing (§D.12):**
1. Migrations 054-058 (§B.4-B.9)
2. SDK auto-instrumentation per protocol
3. Portal UI per protocol (initially a tab, later full views)
4. Tests per protocol
5. Feature flags per protocol (default on for new installs)

**RTBF cross-store (§D.11):**
1. Migration 060 (§B.10)
2. Worker job: `rtbf_run_worker` (handles each phase)
3. Legal review (REQUIRED before merge)
4. Tests (especially concurrency + audit)
5. Portal: RTBF admin (org_admin role only)
6. Rollout: GDPR-mandated customers first, then default-on

**Cold-start UX (§D.14):**
1. Migration 063 (§B.13)
2. Onboarding state machine
3. Portal: `/onboarding` route with step components
4. Empty-state copy per cat
5. Tests
6. Rollout: gradual (new orgs only, then 7-day delayed migration for existing)

### F.5 Phase 4 — Infrastructure runbook

**Multi-region (§8.8):**
1. Migration 062 (§B.12)
2. EU region: Postgres + ClickHouse + S3 in `eu-central-1`
3. AP region: same in `ap-southeast-1`
4. Gateway routing: org_id → region
5. Cross-region data migration tool (for existing orgs)
6. Tests
7. Rollout: EU pilot with one enterprise customer, then default for new EU orgs

**Operational debt (§9):**
1. Migration compatibility matrix doc
2. Doc-test harness
3. Feature flag inventory + quarterly cleanup
4. Chaos test suite
5. Load test for ClickHouse partition scale
6. Internal `/internal/health` dashboard

### F.6 Rollback procedures

| Change            | Rollback time | Mechanism                                        |
| ----------------- | ------------- | ------------------------------------------------ |
| Cat 13 APM cut    | <1h           | Helm rollback of OTel Collector config           |
| Cat 9 flatten     | <30min        | Restore 3 trackers via migration                 |
| Cat 11 trim       | <1h           | Re-enable services via feature flag              |
| Cat 12 trim       | <1h           | Re-enable services via feature flag              |
| Streaming tokens  | <30min        | Feature flag (default off)                       |
| Prompt versioning | <1h           | Feature flag (default off)                       |
| Cost guardrails   | <30min        | Feature flag (default off)                       |
| Webhooks          | <30min        | Re-enable legacy inline webhooks                 |
| RTBF              | <1h           | Disable new endpoint, fall back to Postgres-only |
| MCP / A2A / etc.  | <30min        | Feature flag per protocol                        |
| Multi-region      | <2h           | Disable region routing, force all to `us`        |

---

## SECTION G — Test specifications

### G.1 Per-feature test plans

**Streaming tokens (target 25 tests):**
```
tests/observability/streaming/test_token_ordering.py
  test_monotonic_emission
  test_concurrent_emissions_preserve_order
  test_partial_failure_recovery

tests/observability/streaming/test_redaction.py
  test_pii_redacted_at_ingest_not_query
  test_redaction_irreversible
  test_byte_count_only_mode

tests/observability/streaming/test_stall_detection.py
  test_synthetic_stall_detected
  test_burst_then_pause_detected
  test_threshold_configurable

tests/observability/streaming/test_performance.py
  test_10k_tokens_per_sec_sustained
  test_p95_write_latency_under_50ms
  test_clickhouse_partition_pruning

tests/observability/streaming/test_ui.py
  test_token_sparkline_renders
  test_stall_bars_red
  test_redacted_tokens_show_byte_count_only
```

**Prompt versioning (target 20 tests):**
```
tests/prompts/test_version_monotonicity.py
  test_no_version_reuse
  test_no_version_gaps_within_prompt
  test_concurrent_creates_get_unique_versions

tests/prompts/test_template_hash.py
  test_whitespace_change_bumps_hash
  test_unicode_normalization
  test_trivial_change_note_suppresses_version

tests/prompts/test_lineage.py
  test_parent_chain_traversal
  test_fork_creates_parent_version_id

tests/prompts/test_backfill.py
  test_pre_existing_traces_have_null_prompt_version_id
  test_query_filters_null_safely

tests/prompts/test_auto_eval.py
  test_new_version_triggers_eval_run
  test_eval_run_uses_pinned_dataset
  test_eval_results_compare_to_baseline

tests/prompts/test_sdk.py
  test_python_decorator_emits_version_id
  test_ts_helper_emits_version_id
  test_template_variables_declared
```

**Cost guardrails (target 15 tests):**
```
tests/budgets/test_hard_cap.py
  test_100_sequential_calls_block_at_limit
  test_estimated_cost_uses_7d_rolling_median

tests/budgets/test_window_rollover.py
  test_hourly_window_resets_at_minute_60
  test_daily_window_resets_at_midnight_utc

tests/budgets/test_concurrent.py
  test_two_parallel_calls_one_throttled
  test_budget_actions_audit_complete

tests/budgets/test_reconciliation.py
  test_estimate_low_actual_high_second_call_blocked
  test_estimate_high_actual_low_no_block
```

**RTBF (target 10 tests):**
```
tests/governance/test_rtbf_postgres.py
  test_user_record_anonymized
  test_telemetry_attributes_user_id_replaced

tests/governance/test_rtbf_clickhouse.py
  test_mutation_completes
  test_partition_affected_recorded
  test_mutation_failure_retried

tests/governance/test_rtbf_s3.py
  test_tombstone_marker_written
  test_query_filters_tombstoned_objects
  test_tombstone_reversible

tests/governance/test_rtbf_concurrent.py
  test_two_requests_same_user_idempotent_audit
  test_different_users_parallel_runs_isolated
```

**Closed-loop hooks (target 30 tests):**
```
tests/hooks/test_dedup.py
  test_within_dedup_window_increments_repetition
  test_after_window_emits_new_event
  test_per_reason_dedup_independent

tests/hooks/test_cascade.py
  test_parent_child_share_dedup_window
  test_fan_out_runs_once_per_cascade
  test_severity_suppression_higher_wins

tests/hooks/test_approval.py
  test_high_severity_requires_approval
  test_auto_approve_when_not_required
  test_proposal_expires_after_24h

tests/hooks/test_chaos.py
  test_100_concurrent_hooks_no_deadlock
  test_hook_bus_recovers_from_downstream_failure
  test_dlq_captures_unreachable_consumers
```

### G.2 Coverage targets

| Surface           | Line cov | Branch cov | Critical-path cov |
| ----------------- | -------- | ---------- | ----------------- |
| Gateway ingest    | 85%      | 80%        | 100%              |
| Cat 1 (Traces)    | 80%      | 75%        | 100%              |
| Cat 3 (Judge)     | 80%      | 75%        | 100%              |
| Cat 8 (User)      | 80%      | 75%        | 100%              |
| Closed-loop hooks | 90%      | 85%        | 100%              |
| Streaming tokens  | 85%      | 80%        | 100%              |
| Prompts           | 85%      | 80%        | 100%              |
| Budgets           | 90%      | 85%        | 100%              |
| RTBF              | 90%      | 85%        | 100%              |
| Webhooks          | 85%      | 80%        | 100%              |

### G.3 Test pyramid distribution

Per cat: 70% unit / 20% integration / 5% E2E / 5% load/chaos.

For the closed-loop hooks: 50% unit / 30% integration / 10% chaos / 10% E2E.

### G.4 Specific E2E journey tests

```
tests/e2e/test_onboarding_to_value.py
  # Phase: install → first trace → first judge score → first hook firing
  test_install_sdk_lands_on_onboarding
  test_send_5_traces_lands_on_traces_view
  test_enable_judge_lands_first_score
  test_low_quality_trace_fires_drift_alert
  test_drift_alert_reaches_slack_webhook

tests/e2e/test_prompt_change_to_eval.py
  test_save_new_prompt_version_triggers_eval
  test_eval_results_compare_to_baseline
  test_judge_regression_fires_hook

tests/e2e/test_cost_runaway.py
  test_loop_agent_300_calls_minute
  test_budget_kill_blocks_subsequent_calls
  test_budget_actions_audit_complete
```

---

## SECTION H — 90-day rollout plan

### Week-by-week breakdown

**Weeks 1-2 (Phase 1 starts):**
- Cat 13 APM cut (helm chart + portal removal)
- Cat 9 flatten (migration + service refactor)
- Cat 11 trim (services + tables + hook cleanup)
- Cat 18 trim (drop hourly rollups)
- Cat 23 trim (defer 7 tables)

**Weeks 3-4 (Phase 1 completes, Phase 2 starts):**
- Cat 12 trim (2 services only)
- Cat 10 trim (SOC2 + GDPR only)
- Streaming tokens migration + SDK
- Webhooks reliability migration + worker

**Weeks 5-7 (Phase 2 continues):**
- Streaming tokens portal UI
- Prompt versioning backend + SDK + auto-eval
- Cost guardrails migration + gateway enforcement

**Weeks 8-10 (Phase 2 completes, Phase 3 starts):**
- Prompt versioning portal UI
- Cost guardrails portal UI
- Webhooks portal UI (DLQ + replay)
- RTBF cross-store migration + worker (after legal review)

**Weeks 11-13 (Phase 3 continues):**
- MCP + A2A SDK auto-instrumentation
- Computer Use SDK + portal
- Voice SDK + portal
- Provider routing SDK + schema

**Weeks 14-17 (Phase 3 completes):**
- Fine-tune lineage
- Cold-start UX (onboarding state machine + portal flow)
- Empty-state copy per cat

**Weeks 18-22 (Phase 4):**
- Multi-region EU infrastructure
- Operational debt (migration matrix, doc-tests, flag consolidation)
- Chaos test suite
- Internal /internal/health dashboard

### Gantt chart (ASCII)

```
Week:    1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18 19 20 21 22
─────────────────────────────────────────────────────────────────────────────
Cat 13   ▓▓
Cat 9    ▓▓
Cat 11   ▓▓
Cat 18   ▓▓
Cat 23   ▓▓
Cat 12   ▓▓
Cat 10   ▓▓
Streaming      ▓▓▓▓
Webhooks       ▓▓▓▓
Prompts           ▓▓▓▓▓
Budgets              ▓▓▓▓
RTBF                       ▓▓▓
MCP/A2A                       ▓▓▓
Computer Use                     ▓▓▓
Voice                            ▓▓▓▓
Provider Routing                   ▓▓
Fine-tune                            ▓▓
Cold-start UX                          ▓▓▓
Multi-region                              ▓▓▓▓▓
Op debt                                     ▓▓▓▓▓
```

### Pilot rollout gates

Each spec (D.8 - D.14) has a pilot phase before default-on:

| Spec              | Pilot orgs        | Pilot duration | Default-on trigger                 |
| ----------------- | ----------------- | -------------- | ---------------------------------- |
| Streaming tokens  | 5 (high-volume)   | 1 week         | <0.1% ingest error rate            |
| Prompt versioning | 5 (eval-heavy)    | 2 weeks        | <30s eval p95 for 100-row datasets |
| Cost guardrails   | 5 (runaway-prone) | 2 weeks        | Zero false-positive kills          |
| Webhooks          | 10 (mixed)        | 1 week         | >99.5% delivery success            |
| RTBF              | 3 (GDPR-mandated) | 2 weeks        | Legal sign-off                     |
| MCP / A2A / etc.  | 5 (per protocol)  | 1 week each    | <0.5% trace loss                   |
| Cold-start UX     | 10 (new orgs)     | 4 weeks        | >80% reach "first judge score"     |

---

## SECTION I — Risk register

| ID   | Change                                                | Probability | Impact   | Mitigation                                                                 | Owner            |
| ---- | ----------------------------------------------------- | ----------- | -------- | -------------------------------------------------------------------------- | ---------------- |
| R-01 | Cat 13 APM cut breaks closed-loop hook                | Low         | High     | Verify no hook depends on APM tables before cut; dry-run in staging        | Platform         |
| R-02 | Cat 9 flatten loses customer-tracked copy_paste data  | Medium      | Medium   | 30-day deprecation window + export endpoint                                | Eval             |
| R-03 | Cat 11 trim removes embedding drift customers rely on | Medium      | High     | Survey 5 pilot customers; offer custom embedding service                   | Observability    |
| R-04 | Streaming tokens inflates ClickHouse cost             | Medium      | High     | TTL 90d; partition by org; cardinality cap (max 100k tokens/trace)         | Data             |
| R-05 | Prompt versioning triggers runaway evals              | Medium      | High     | Rate-limit auto-eval (max 10 runs/day per prompt); require opt-in          | Eval             |
| R-06 | Cost guardrails false-positive kills                  | Medium      | Critical | Default-off for existing customers; "shadow mode" (alert only) for 30 days | Platform         |
| R-07 | RTBF Phase 3 (S3) leaves orphan objects               | Low         | High     | Tombstone + 24h lifecycle policy; daily janitor verifies                   | Data             |
| R-08 | Multi-region data migration corrupts traces           | Low         | Critical | Dry-run migration; checksum verification; pause + resume support           | Data             |
| R-09 | Webhook signing secret leaks                          | Low         | High     | Per-endpoint secret; rotation endpoint; audit log of secret views          | Platform         |
| R-10 | Cold-start UX hides critical Cat 11                   | Low         | Medium   | Admin override to enable all cats; clear "why this is greyed out" copy     | Portal           |
| R-11 | MCP/A2A/Computer Use SDKs lag spec                    | Medium      | Medium   | Auto-instrument via OTel semantic conventions; manual fallback             | SDK              |
| R-12 | Fine-tune lineage misses OpenAI webhook events        | Medium      | Medium   | Provider webhook receiver; idempotent by fine_tune_id                      | Eval             |
| R-13 | Provider routing attempts overload on retries         | Low         | Medium   | Cap at 10 attempts/trace; sample at >100 attempts                          | Data             |
| R-14 | Feature flag explosion (§9.4)                         | High        | Low      | Quarterly cleanup; lint rule against unregistered flags                    | Platform         |
| R-15 | Schema migration tax (§9.1) blocks new customers      | Medium      | High     | Compat mode; on-write create; compat matrix doc                            | Data             |
| R-16 | Closed-loop hook cascade (§3.1) thrashes              | Medium      | High     | Dedup window 5min; cascade dedup; severity precedence                      | Platform         |
| R-17 | Legal review delays RTBF                              | High        | Medium   | Start legal review in parallel with engineering                            | Legal            |
| R-18 | Cat 23 STUB → real ship slips                         | High        | Low      | Cat 23 not on critical path; defer OK                                      | Product          |
| R-19 | Operational debt compounds faster than fix rate       | High        | Medium   | 20% of every quarter reserved for debt; explicit tracking                  | Eng leadership   |
| R-20 | Pilot customers churn during rollout                  | Medium      | High     | Feature flag everything; opt-in for cut features; clear comms              | Customer success |

---

## SECTION J — Definition of done

### J.1 Per-feature DoD

Every shipped feature must meet all of:

1. **Data model:**
   - Migration tested in staging with 1M+ row backfill (where applicable)
   - Migration reversible via documented `eden db migrate --down` (unless destructive)
   - ClickHouse mirror in place (where applicable)
   - Indexes added per query patterns

2. **API:**
   - OpenAPI spec checked in (`docs/api/<feature>.yaml`)
   - Auth verified (org_id isolation; RBAC for admin endpoints)
   - Rate limit applied (per route, per org)
   - Error responses documented

3. **SDK:**
   - Python + TS SDK changes (Go if applicable)
   - Auto-emit for supported integrations (OpenAI, Anthropic, etc.)
   - Sample app demonstrates usage
   - Versioned release notes

4. **UI:**
   - Portal pages designed (Figma) before code
   - Empty states covered (no data yet, error states)
   - Loading states (skeletons for >200ms)
   - Mobile-friendly (responsive, not native)
   - Accessibility: WCAG 2.1 AA

5. **Tests:**
   - Unit tests ≥ 80% line, ≥ 75% branch
   - Integration tests for the data path
   - E2E test for the user journey
   - Load test for the hot path
   - All tests pass in CI

6. **Documentation:**
   - User-facing docs (`.agents/skills/<feature>/SKILL.md`)
   - API reference (OpenAPI → docs site)
   - Migration guide (for breaking changes)
   - Internal runbook (for ops)

7. **Telemetry:**
   - Feature usage tracked (per org, per feature)
   - Errors logged with feature tag
   - Latency tracked in `/internal/health` dashboard

8. **Rollout:**
   - Feature flag in place (if not default-on)
   - Pilot plan defined
   - Rollback procedure documented + tested
   - Communication plan (changelog, customer email if breaking)

### J.2 Cross-cutting quality bar

- **No silent failures:** every error has a path to surface (log, hook, alert, dashboard)
- **No data loss in migrations:** destructive migrations require `dry_run=true` first
- **No default-on breaking changes:** any breaking change is feature-flagged
- **No customer-facing "we'll fix this later" UI:** if it's broken, hide it
- **No undocumented APIs:** every endpoint in OpenAPI
- **No test gaps in critical paths:** the 100% coverage table in §G.2 is non-negotiable

### J.3 Ship checklist (template)

Before merge to `main`:

```
- [ ] Migration written + tested in staging
- [ ] ClickHouse mirror written (where applicable)
- [ ] API endpoint(s) added + OpenAPI updated
- [ ] SDK changes (Python + TS) merged
- [ ] Portal UI complete + reviewed
- [ ] Tests: unit + integration + E2E all pass
- [ ] Coverage: line ≥ 80%, branch ≥ 75%
- [ ] Docs: user-facing + API reference + runbook
- [ ] Telemetry: feature usage tracked + errors logged
- [ ] Feature flag: created with default value + expiration
- [ ] Pilot plan: defined with success criteria
- [ ] Rollback procedure: documented + tested
- [ ] Risk register entry: created + reviewed
- [ ] Stakeholder sign-off: PM + Eng Lead + (Security if applicable)
```

---

## Closing summary

This spec document covers:

- **Phase 1 (weeks 1-3):** cut Cat 13, Cat 9 hierarchy, Cat 11 trim, Cat 12 trim, Cat 10 trim, Cat 18 trim, Cat 23 trim. Net: -8 weeks of eng time.
- **Phase 2 (weeks 4-10):** ship streaming tokens, prompt versioning, cost guardrails, webhooks reliability.
- **Phase 3 (weeks 11-17):** ship RTBF cross-store, MCP/A2A/Computer Use/Voice/Fine-tune/Provider routing, cold-start UX.
- **Phase 4 (weeks 18-22):** multi-region infrastructure + operational debt cleanup.

**Total: 22 weeks. Net engineering: same team, more shipped.**

**Single biggest leverage:** Phases 1 frees 8-10 weeks; that budget funds Phase 2.

**The 5 things not to compromise:**
1. Streaming tokens (§6.1) — 2026 table-stakes
2. Prompt versioning (§6.2) — eval workflow backbone
3. Cost guardrails (§6.3) — enterprise requirement
4. RTBF cross-store (§6.4) — GDPR completeness
5. Cold-start UX (§10) — conversion bottleneck

**The 5 things to defer:**
1. Cat 23 real ship (after Phase 1-3 land)
2. Multi-region AP (only US + EU in v1)
3. Voice/audio (partner with LiveKit instead)
4. MCP server (every LLM vendor builds one)
5. Edge inference observability (Cloudflare/Workers AI handles)

Want me to (a) pick the highest-ROI spec from §D and write its full engineering ticket with sub-tasks, (b) draft the migration communication plan for Phase 1 customer-facing changes, or (c) write the doc-test harness spec for §9.3?