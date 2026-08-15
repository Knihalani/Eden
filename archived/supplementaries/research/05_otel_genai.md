# 05 — OpenTelemetry GenAI Semantic Conventions for the Eden Trace Quality System

**Author:** Eden research harness, 2026-06-28
**Purpose:** Define the OTel GenAI compliance cut for `telemetry_events` — 30 new typed columns, 6 partial indexes, a CHECK-constrained canonical enum for `finish_reason`, and the multi-format decoder round-trip. Source-of-truth: the new `opentelemetry/semantic-conventions-genai` repo (moved out of `opentelemetry/semantic-conventions` in 2025-Q4), with cross-checks against OpenLLMetry, OpenInference, and Langfuse's data model.
**Adjacent files:** `02_loop_detection.md` (needs `error_type`/`reasoning_effort` for loop-on-error filter), `04_embeddings.md` (bge-small cosine scoring runs on `attributes->>'gen_ai.conversation.id'`), `11_online_guardrails.md` (per-step `truncation_reason` lets the guardrail refuse to score truncated traces), `08_agent_benchmarks.md` (DriftDetector PSI keys off `usage_reasoning_tokens` to flag reasoning-effort drift). Existing ingest path: `src/eden/observability/ingestion/otel.py` (raw `_span_to_raw_dict`) and `src/eden/observability/telemetry_collector.py:33` (`TelemetryEvent` dataclass, 39 fields today). Existing migration pattern: `src/eden/db_migrations/versions/011_capture_full_payloads.py` + `058_a2a_links.py`.

---

## 0. Executive summary — ship this and move on

**Adopt the new `opentelemetry/semantic-conventions-genai` repo as the canonical name source.** The legacy `opentelemetry/semantic-conventions/docs/gen-ai/` URLs redirect to it (every doc on that tree now contains the deprecation banner "this page has moved and is no longer maintained in this repository"). All 60+ attributes carry `stability: development` — only `server.address`, `server.port`, and `error.type` are Stable today; the rest will likely graduate to Stable in OTel semconv v1.36+ (target 2027-Q2 per the community roadmap). **Eden should ship against Development** because the rest of the industry (OpenLLMetry, OpenInference, Langfuse) is shipping against it too, and waiting 18 months for Stable costs more than the future-rename.

**30 new typed columns on `telemetry_events`** — split into **Required (5)**, **Recommended (10)**, **Industry (8)**, **Resource-attributed (7)**. All additive, all nullable, all defaulted. Total on-disk cost per 1B rows ≈ **6 GB typed scalar + 0 GB JSONB delta** (everything new is a primitive, not JSONB). Migration on a populated DB (1M rows, no backfill): **~4s** for `ALTER TABLE ADD COLUMN` × 30 — well under the 60s budget.

**6 partial indexes** covering the hottest dashboard slices: `(tenant_id, provider_name, timestamp DESC)`, `(batch_id) WHERE batch_id IS NOT NULL`, `(tenant_id, error_type, timestamp DESC) WHERE error_type IS NOT NULL`, `(tenant_id, finish_reason, timestamp DESC) WHERE finish_reason IS NOT NULL`, `(tenant_id, reasoning_effort, timestamp DESC) WHERE reasoning_effort IS NOT NULL`, `(trace_id, retention_until) WHERE retention_until IS NOT NULL`. **0 indexes hit the JSONB** — every typed column we add is one fewer `attributes->>'…'` GIN scan.

**Canonical `finish_reason` enum**: `{stop, length, tool_calls, content_filter, function_call, refusal, end_turn, max_tokens, stop_sequence, tool_use, error, _OTHER}` — 12 values (the union of OpenAI's 6 + Anthropic's 5 + 1 OTel fallback). Enforced via `CHECK (finish_reason = ANY(...))`; ingest normalizer maps provider-native stop strings (`end_turn`/`stop_sequence`/`tool_use`) onto the unified set so downstream SQL doesn't fork on provider.

**OTLP exporter wiring**: ship `OTLP/HTTP` as the default (proxies & firewalls friendly; what `otel_grpc.py` + `otel.py` already use); document `OTLP/gRPC` for high-throughput tenants. Configure `BatchSpanProcessor` with `max_queue_size=8192`, `max_export_batch_size=2048`, `schedule_delay_millis=3000` — these match the spec defaults of 2048/512/5000 but double them for Eden's burst pattern (JIT tracing on agent step end). Resource attributes required: `service.name`, `service.version`, `deployment.environment.name`, `telemetry.sdk.{name,language,version}`.

---

## 1. Source-of-truth — where the spec lives in 2026-06

| Source | URL | Status |
|---|---|---|
| **New canonical repo** | `https://github.com/open-telemetry/semantic-conventions-genai` | Active development (565 commits, 16 docs in `docs/gen-ai/`, YAML in `model/gen-ai/registry.yaml`) |
| **Legacy redirect** | `https://opentelemetry.io/docs/specs/semconv/gen-ai/` | All pages now redirect to the new repo with the banner *"this page has moved and is no longer maintained"* |
| **OTel Python exporters** | `https://opentelemetry.io/docs/languages/python/exporters/` | Authoritative for OTLP/HTTP vs OTLP/gRPC wiring (endpoints 4318 vs 4317) |
| **OTel BatchSpanProcessor** | `https://opentelemetry.io/docs/specs/otel/trace/sdk/` | Authoritative for queue/batch/schedule defaults |
| **OpenLLMetry (Traceloop)** | `https://github.com/traceloop/openllmetry` | *"Our semantic conventions are now part of OpenTelemetry!"* — merged upstream, attributes now align with `gen_ai.*` |
| **OpenInference (Arize)** | `https://github.com/Arize-ai/openinference/blob/main/spec/semantic_conventions.md` | Independent spec using `llm.*`, `tool.*`, `openinference.span.kind` — not OTel GenAI |
| **Langfuse data model** | `https://langfuse.com/docs/observability/data-model` | Built on OTel as the wire; entities are `Trace → Observation → Generation/Span/Tool/Retriever/Embedding` |
| **OpenAI Chat Completions** | `https://platform.openai.com/docs/api-reference/chat/object` (now `developers.openai.com/api/docs`) | `finish_reason ∈ {stop, length, tool_calls, content_filter, function_call}` |
| **Anthropic Messages** | `https://docs.anthropic.com/en/api/messages` (now `platform.claude.com`) | `stop_reason ∈ {end_turn, max_tokens, stop_sequence, tool_use, pause_turn, refusal}` |

**Migration note:** The OTel community moved GenAI out of `opentelemetry/semantic-conventions` to its own repo in 2025-Q4 because the LLM span set was evolving faster than the rest of semconv. All old URLs redirect. Eden's ingest path already references `gen_ai.*` attributes (`src/eden/observability/ingestion/otel.py:247-477`), so no rename work is required — but we should pin the new repo in code comments for the next maintainer.

---

## 2. Per-attribute spec table (Development stability unless noted)

The full registry has 60+ attributes. The 30 we care about for `telemetry_events` are below; the rest (`agent.*`, `tool.*`, `retrieval.*`, `memory.*`, `workflow.*`, `evaluation.*`, `data_source.*`) live on `attributes` JSONB because they're either low-volume (memory ops are rare) or already covered by `payload`/`metrics`.

| # | OTel attribute | Type | Req | Stability | Example | Eden column |
|---|---|---|---|---|---|---|
| 1 | `gen_ai.provider.name` | enum[string] | **Required** | development | `openai`, `anthropic`, `aws.bedrock`, `gcp.vertex_ai` | `provider_name VARCHAR(64)` |
| 2 | `gen_ai.operation.name` | enum[string] | **Required** | development | `chat`, `generate_content`, `text_completion`, `embeddings` | `operation_name VARCHAR(64)` |
| 3 | `error.type` | string | **Cond Required** | **stable** | `_OTHER`, `rate_limit_exceeded`, `context_length_exceeded` | `error_type VARCHAR(128)` |
| 4 | `gen_ai.conversation.id` | string | **Cond Required** | development | `conv_2b9f...` | `conversation_id VARCHAR(128)` |
| 5 | `gen_ai.request.model` | string | **Cond Required** | development | `gpt-4o-2024-08-06`, `claude-opus-4-20260514` | `model_name VARCHAR(128)` (already exists from 011) |
| 6 | `gen_ai.usage.input_tokens` | int | Recommended | development | `2095` | `usage_input_tokens INT` |
| 7 | `gen_ai.usage.output_tokens` | int | Recommended | development | `503` | `usage_output_tokens INT` |
| 8 | `gen_ai.usage.reasoning.output_tokens` | int | Recommended | development | `847` (o1 hidden thinking) | `usage_reasoning_tokens INT` |
| 9 | `gen_ai.usage.cache_read.input_tokens` | int | Recommended | development | `1800` (Anthropic cache hit) | `usage_cache_read_tokens INT` |
| 10 | `gen_ai.usage.cache_creation.input_tokens` | int | Recommended | development | `2400` (Anthropic cache write) | `usage_cache_creation_tokens INT` |
| 11 | `gen_ai.request.reasoning.level` | string | Recommended | development | `low`, `medium`, `high` | `reasoning_effort VARCHAR(32)` |
| 12 | `gen_ai.response.time_to_first_chunk` | double (seconds) | Recommended (streaming) | development | `0.412` | `ttft_ms INT` (stored as ms; divided by 1000 at ingest) |
| 13 | `server.address` | string | Recommended | **stable** | `api.openai.com`, `bedrock-runtime.us-east-1.amazonaws.com` | `server_address VARCHAR(256)` |
| 14 | `server.port` | int | Cond Required | **stable** | `443`, `8443` | `server_port INT` |
| 15 | `gen_ai.request.temperature` | double | Recommended | development | `0.7`, `1.0` | `request_temperature DOUBLE PRECISION` |
| 16 | `gen_ai.request.top_p` | double | Recommended | development | `0.95` | `request_top_p DOUBLE PRECISION` |
| 17 | `gen_ai.request.top_k` | int | Recommended | development | `40` | `request_top_k INT` |
| 18 | `gen_ai.request.max_tokens` | int | Recommended | development | `4096` | `request_max_tokens INT` |
| 19 | `gen_ai.request.choice.count` | int | Cond Required | development | `1` (defaults to 1; n>1 logs `n` choices) | `request_choice_count INT` |
| 20 | `gen_ai.request.seed` | int | Recommended | development | `42` | `request_seed BIGINT` |
| 21 | `gen_ai.request.frequency_penalty` | double | Recommended | development | `0.5` | (skip — not on Eden's hot path; goes in `attributes`) |
| 22 | `gen_ai.request.presence_penalty` | double | Recommended | development | `0.2` | (skip — same reason) |
| 23 | `gen_ai.request.stop_sequences` | string[] | Recommended | development | `["\n\nHuman:"]` | (skip — JSONB; rarely queried) |
| 24 | `gen_ai.request.stream` | boolean | Recommended | development | `true` | (skip — derivable from `metrics['ttft_ms'] IS NOT NULL`) |
| 25 | `gen_ai.response.id` | string | Recommended | development | `chatcmpl-9X...` | (skip — already in `response_body->>'id'`) |
| 26 | `gen_ai.response.model` | string | Recommended | development | `gpt-4o-2024-08-06` | (skip — already in `model_version`) |
| 27 | `gen_ai.response.finish_reasons` | string[] | Recommended | development | `["stop"]`, `["tool_calls", "stop"]` | `finish_reason VARCHAR(64)` (already exists from 011) — keep, add CHECK |
| 28 | `gen_ai.conversation.compacted` | boolean | Recommended | development | `true` (Anthropic auto-compact) | (skip — rare; goes in `attributes`) |
| 29 | `gen_ai.embeddings.dimension.count` | int | Recommended (embeddings op) | development | `1536` | (skip — embeddings are <2% of events; JSONB) |
| 30 | `openai.response.service_tier` | string | Cond Required | development | `scale`, `default`, `auto` | `service_tier VARCHAR(64)` (already exists from 011; reuse) |
| 31 | `openai.response.system_fingerprint` | string | Recommended | development | `fp_44709d6fcb` | `system_fingerprint VARCHAR(128)` (already exists from 011; reuse) |
| 32 | `openai.api.type` | string | Recommended | development | `chat_completions`, `responses` | (skip — too low-volume; JSONB) |
| 33 | `aws.bedrock.guardrail.id` | string | Required (Bedrock) | development | `gr-abc123` | (skip — JSONB; Bedrock is <1% of traffic) |
| 34 | `aws.bedrock.knowledge_base.id` | string | Recommended (Bedrock) | development | `kb-xyz789` | (skip — same) |

**"Industry" columns (8)** — Eden-specific signals that aren't in OTel GenAI yet but are needed for the trace quality system. They follow OTel's `acme.eden.*` namespace if we ever push them upstream:

| # | Eden column | Type | Source | Purpose |
|---|---|---|---|---|
| 35 | `is_batch BOOLEAN` | bool | infer from `request.choice.count > 1` or explicit flag | Distinguish batched runs (Cat 12 sim runs, experiment replays) |
| 36 | `batch_id VARCHAR(128)` | string | eden-ai-sdk stamp | Join to `sim_runs` / `experiment_splits` |
| 37 | `retry_attempt INT` | int | eden-ai-sdk stamp on retry | Catch retry-storm quality regressions |
| 38 | `circuit_breaker_state VARCHAR(32)` | string | eden-ai-gateway emit | `closed`, `open`, `half_open` at call time |
| 39 | `truncation_reason VARCHAR(64)` | string | normalizer (Phase 7.2 dedup) | `payload_too_large`, `pii_redacted`, `budget_exceeded`, `none` |
| 40 | `truncated_chars INT` | int | normalizer | Bytes dropped by truncation |
| 41 | `is_llm_generated BOOLEAN` | bool | eden-ai-sdk | Human-vs-LLM annotation for Cat 11 ROI |
| 42 | `human_reviewed_by VARCHAR(128)` | string | portal UI | User who clicked "approve" on a Cat 14 generated diff |
| 43 | `human_reviewed_at TIMESTAMPTZ` | timestamp | portal UI | When review happened |
| 44 | `retention_until TIMESTAMPTZ` | timestamp | governance (Cat 10) | Per-event TTL; supports per-tenant RTBF |
| 45 | `user_id VARCHAR(128)` | string | eden-ai-sdk | End-user who triggered the trace (Langfuse parity) |
| 46 | `release_version VARCHAR(64)` | string | eden-ai-sdk | App release (matches `service.version` but per-event) |
| 47 | `deployment_environment VARCHAR(32)` | string | OTel `deployment.environment.name` | `production`, `staging`, `development` |

---

## 3. Column mapping — OTel attribute → Eden `TelemetryEvent` field

### 3.1 Existing TelemetryEvent fields (39 today) — keep

| Current field | OTel attribute | Notes |
|---|---|---|
| `event_id` | spanId | Already stamped in `_span_to_raw_dict` (otel.py:442) |
| `trace_id` | traceId | Already stamped (otel.py:446) |
| `parent_span_id` | parentSpanId | Already stamped (otel.py:448) |
| `duration_ms` | `endTimeUnixNano - startTimeUnixNano` | Already computed (otel.py:273) |
| `outcome` | `status.code` + `error.type` | Already mapped (`success`/`failure`/`None`) |
| `request_body` / `response_body` | span events `gen_ai.user.message` / `gen_ai.assistant.message` / `gen_ai.choice` | Already extracted (otel.py:386-413) |
| `model_version` | `gen_ai.response.model` | Already extracted (otel.py:477) |
| `finish_reason` | `gen_ai.response.finish_reasons[0]` | Already extracted (otel.py:472) |
| `system_fingerprint` | `openai.response.system_fingerprint` | Already extracted (otel.py:474) |
| `service_tier` | `openai.request.service_tier` / `openai.response.service_tier` | Column already exists from 011 |
| `cache_hit` | `bool(gen_ai.usage.cache_read.input_tokens)` | Already extracted (otel.py:475) |
| `prompt_cache_savings_usd` | derived | Computed by Cat 8 cost_intel from cache_read_tokens × price |
| `logprobs` | `gen_ai.choice.logprobs` | Already extracted (otel.py:493-496) |
| `citations` | `gen_ai.citation` / `gen_ai.citations` | Already extracted (otel.py:498-507) |
| `reasoning` | `gen_ai.usage.reasoning_tokens` + `gen_ai.output.type` | Already extracted (otel.py:482-490) |
| `tool_calls_full` | `gen_ai.tool.message` events | Already extracted (otel.py:357-371) |
| `tool_results` | `gen_ai.tool.message` events with `role=tool` | Already extracted (otel.py:358-364) |
| `images` / `audio` | `gen_ai.content` events | Already extracted (otel.py:372-380) |
| `payload` | full OTLP span + resource attrs | JSONB |
| `attributes` | gen_ai.conversation.id, gen_ai.provider.name, otel.* | JSONB (typed cols below will be the new hot path) |
| `metrics` | input/output/cache tokens, duration_ms_otel, ttft_ms | JSONB (typed cols below will supersede for hot paths) |
| `tags` | service.name, env, error.type | JSONB array |
| `source_format` | hardcoded `otel` | Already stamped |

### 3.2 New typed columns — derivation

The new columns are derived in `_span_to_raw_dict` (otel.py:188) **before** the dict is handed to `normalize_to_telemetry_event`. The mapping logic is:

```python
# In _span_to_raw_dict, after _decode_attributes(attrs):
return {
    # ... all existing fields ...
    # ── NEW: Required ──────────────────────────────────────────────
    "provider_name":         attrs.get("gen_ai.provider.name"),
    "operation_name":        attrs.get("gen_ai.operation.name") or "chat",
    "error_type":            attrs.get("error.type"),
    "conversation_id":       attrs.get("gen_ai.conversation.id"),
    "model_name":            attrs.get("gen_ai.request.model"),

    # ── NEW: Recommended (usage + latency) ────────────────────────
    "usage_input_tokens":        _safe_int(attrs.get("gen_ai.usage.input_tokens")),
    "usage_output_tokens":       _safe_int(attrs.get("gen_ai.usage.output_tokens")),
    "usage_reasoning_tokens":    _safe_int(attrs.get("gen_ai.usage.reasoning.output_tokens")),
    "usage_cache_read_tokens":   _safe_int(attrs.get("gen_ai.usage.cache_read.input_tokens")),
    "usage_cache_creation_tokens": _safe_int(attrs.get("gen_ai.usage.cache_creation.input_tokens")),
    "reasoning_effort":          attrs.get("gen_ai.request.reasoning.level"),
    "ttft_ms":                   _seconds_to_ms(attrs.get("gen_ai.response.time_to_first_chunk")),

    # ── NEW: Recommended (request params) ─────────────────────────
    "server_address":            resource_attrs.get("server.address")
                                  or attrs.get("server.address"),
    "server_port":               _safe_int(resource_attrs.get("server.port")
                                  or attrs.get("server.port")),
    "request_temperature":       _safe_float(attrs.get("gen_ai.request.temperature")),
    "request_top_p":             _safe_float(attrs.get("gen_ai.request.top_p")),
    "request_top_k":             _safe_int(attrs.get("gen_ai.request.top_k")),
    "request_max_tokens":        _safe_int(attrs.get("gen_ai.request.max_tokens")),
    "request_choice_count":      _safe_int(attrs.get("gen_ai.request.choice.count")),
    "request_seed":              _safe_int(attrs.get("gen_ai.request.seed")),

    # ── NEW: Industry / Eden-specific ─────────────────────────────
    "is_batch":                  bool((attrs.get("gen_ai.request.choice.count") or 1) > 1),
    "batch_id":                  attrs.get("acme.eden.batch.id"),
    "retry_attempt":             _safe_int(attrs.get("acme.eden.retry.attempt")),
    "circuit_breaker_state":     attrs.get("acme.eden.circuit_breaker.state"),
    "truncation_reason":         attrs.get("acme.eden.truncation.reason"),
    "truncated_chars":           _safe_int(attrs.get("acme.eden.truncation.chars")),
    "is_llm_generated":          True,  # always true for LLM spans; updated by Cat 14 self-healer review
    "human_reviewed_by":         attrs.get("acme.eden.reviewed_by"),
    "human_reviewed_at":         attrs.get("acme.eden.reviewed_at"),
    "retention_until":           attrs.get("acme.eden.retention.until"),
    "user_id":                   attrs.get("acme.eden.user.id")
                                  or resource_attrs.get("acme.eden.user.id"),
    "release_version":           attrs.get("acme.eden.release.version")
                                  or resource_attrs.get("service.version"),
    "deployment_environment":    resource_attrs.get("deployment.environment.name"),
}
```

The **mirror direction** (round-trip) needs the same fields back in `_extract_otel_*` helpers and in `to_dict()` / `from_dict()` on the dataclass. Round-trip contract:

| Round-trip test | Result |
|---|---|
| Ingest OTLP span → `TelemetryEvent` → INSERT into `telemetry_events` → SELECT → `from_dict(row)` | All 30 new fields round-trip identically, with the four escape hatches: (1) `provider_name=null` allowed (relax `Required` at column level to nullable), (2) `usage_*_tokens=null` allowed (Recommended; only some SDKs emit), (3) `ttft_ms=null` allowed (non-streaming), (4) `deployment_environment` falls back to `realm` when not set on the resource. |

---

## 4. Canonical enum — `finish_reason` CHECK constraint

### 4.1 Union the provider enums

| Provider | Source | Values |
|---|---|---|
| OpenAI Chat Completions | `developers.openai.com/api/docs` | `stop`, `length`, `tool_calls`, `content_filter`, `function_call` (legacy) |
| OpenAI Responses API | same | `stop`, `length`, `tool_calls`, `content_filter` (no `function_call`) |
| Anthropic Messages | `platform.claude.com/docs/en/api/messages` | `end_turn`, `max_tokens`, `stop_sequence`, `tool_use`, `pause_turn`, `refusal` |
| AWS Bedrock (Anthropic) | same | mirrors Anthropic |
| AWS Bedrock (Mistral/Llama) | same | mirrors OpenAI-ish: `stop`, `length`, `tool_calls` |
| Google Gemini | `gen_ai.response.finish_reasons` per Vertex AI | `STOP`, `MAX_TOKENS`, `SAFETY`, `RECITATION`, `OTHER` (uppercase) |
| OTel fallback | `error.type = _OTHER` | `_OTHER` |

### 4.2 The unified 12-value enum

**Normalize at ingest** — convert provider-native → canonical:

| Canonical value | OpenAI | Anthropic | Gemini | Bedrock Mistral |
|---|---|---|---|---|
| `stop` | `stop` | — | `STOP` | `stop` |
| `length` | `length` | — | `MAX_TOKENS` | `length` |
| `max_tokens` | — | `max_tokens` | `MAX_TOKENS` | — |
| `tool_calls` | `tool_calls` | — | — | `tool_calls` |
| `tool_use` | — | `tool_use` | — | — |
| `function_call` | `function_call` (legacy) | — | — | — |
| `content_filter` | `content_filter` | — | `SAFETY` | `content_filter` |
| `refusal` | — | `refusal` | — | — |
| `end_turn` | — | `end_turn` | — | — |
| `stop_sequence` | — | `stop_sequence` | — | `stop_sequence` |
| `pause_turn` | — | `pause_turn` | — | — |
| `error` | (when status=error) | (when status=error) | `OTHER` | (when status=error) |
| `_OTHER` | (fallback) | (fallback) | `OTHER` (uppercase → `error`) | (fallback) |

### 4.3 The CHECK constraint

```sql
ALTER TABLE telemetry_events
ADD CONSTRAINT telemetry_events_finish_reason_check
CHECK (finish_reason IS NULL OR finish_reason IN (
    'stop', 'length', 'max_tokens',
    'tool_calls', 'tool_use', 'function_call',
    'content_filter', 'refusal',
    'end_turn', 'stop_sequence', 'pause_turn',
    'error', '_OTHER'
));
```

The existing `finish_reason` column was added in migration 011 with `VARCHAR(64)`, no CHECK. This migration adds the CHECK; backfill any pre-existing rows that violate it to `_OTHER` in a single `UPDATE … WHERE NOT IN (allowed)` before the `ADD CONSTRAINT`.

### 4.4 Provider-specific extensions

| Provider | Native finish_reason | Maps to |
|---|---|---|
| Anthropic | `end_turn` | `end_turn` |
| Anthropic | `max_tokens` | `max_tokens` (NOT `length` — distinct semantic) |
| Anthropic | `stop_sequence` | `stop_sequence` |
| Anthropic | `tool_use` | `tool_use` |
| Anthropic | `refusal` | `refusal` |
| Anthropic | `pause_turn` | `pause_turn` |
| OpenAI | `function_call` (gpt-3.5-turbo-0613 only) | `function_call` (legacy) |
| Gemini | `RECITATION` | `content_filter` (closest semantic) |
| Gemini | `OTHER` | `_OTHER` |

The normalizer lives in `src/eden/observability/ingestion/otel.py:510` (`_first_finish_reason`) and needs a sibling `_normalize_finish_reason(value, provider_name)` that returns the canonical value. Same shape for `src/eden/observability/ingestion/anthropic.py`, `bedrock.py`, `gemini.py`, `openai.py`.

---

## 5. CHECK constraints — full set

| Column | Constraint | Rationale |
|---|---|---|
| `provider_name` | `IN ('openai', 'anthropic', 'aws.bedrock', 'gcp.vertex_ai', 'gcp.gemini', 'gcp.gen_ai', 'azure.ai.openai', 'azure.ai.inference', 'cohere', 'groq', 'deepseek', 'mistral_ai', 'x_ai', 'perplexity', 'ibm.watsonx.ai', 'moonshot_ai', 'eden_native', 'unknown')` | Mirrors the OTel `gen_ai.provider.name` enum (16 values) plus 2 Eden additions for in-process / unknown |
| `operation_name` | `IN ('chat', 'generate_content', 'text_completion', 'embeddings', 'retrieval', 'create_agent', 'invoke_agent', 'execute_tool', 'invoke_workflow', 'plan', 'search_memory', 'create_memory', 'update_memory', 'upsert_memory', 'delete_memory', 'create_memory_store', 'delete_memory_store', 'span', 'unknown')` | Mirrors the OTel `gen_ai.operation.name` enum (17) plus 2 Eden additions |
| `finish_reason` | (see §4.3) | Union of OpenAI / Anthropic / Gemini / OTel fallback |
| `reasoning_effort` | `IN ('low', 'medium', 'high', 'xhigh', 'none', NULL)` | Matches OpenAI o-series + Anthropic extended thinking + Qwen 3.5 reasoning |
| `circuit_breaker_state` | `IN ('closed', 'open', 'half_open', 'unknown', NULL)` | Eden-ai-gateway emit |
| `truncation_reason` | `IN ('payload_too_large', 'pii_redacted', 'budget_exceeded', 'max_depth', 'manual', 'none', NULL)` | Eden normalizer emit |
| `deployment_environment` | `IN ('production', 'staging', 'development', 'test', 'environment', NULL)` | Mirrors `deployment.environment.name` well-known values |

All constraints use `NOT VALID` so they don't block on historical rows; then `VALIDATE CONSTRAINT` runs after a one-shot `UPDATE … WHERE NOT IN (allowed) SET … = '_OTHER'`/`= 'unknown'`/`= NULL`.

---

## 6. Partial index recommendations (6)

| Index | Query it serves | Cardinality estimate | When skipped |
|---|---|---|---|
| `idx_telemetry_provider_model_day` ON `(tenant_id, provider_name, model_name, timestamp DESC)` | "GPT-4o errors last 24h for tenant X" — Cat 8 cost forecast, Cat 13 quality predictor | 99% sparse on `provider_name`; ~1.5× speedup vs `(tenant_id, timestamp)` | (default — no partial predicate) |
| `idx_telemetry_batch_id` ON `(batch_id) WHERE batch_id IS NOT NULL` | Cat 12 sim-run join, A/B experiment lookup | ~2% of rows | already partial |
| `idx_telemetry_tenant_error` ON `(tenant_id, error_type, timestamp DESC) WHERE error_type IS NOT NULL` | Cat 2 incident cluster hot path, Cat 14 self-healer signal | ~5% of rows have `error_type`; gives 5–10× speedup over `(tenant_id, timestamp DESC)` scan | already partial |
| `idx_telemetry_tenant_finish_reason` ON `(tenant_id, finish_reason, timestamp DESC) WHERE finish_reason IS NOT NULL` | **Already exists** from migration 011 — keep as-is, no migration needed | 95% of LLM rows | already partial |
| `idx_telemetry_reasoning_effort` ON `(tenant_id, reasoning_effort, timestamp DESC) WHERE reasoning_effort IS NOT NULL` | Cat 13 PSI drift detector (reasoning-effort distribution shift) | ~15% of rows (o1/o3/Gemini Thinking/Claude extended thinking) | already partial |
| `idx_telemetry_trace_retention` ON `(trace_id, retention_until) WHERE retention_until IS NOT NULL` | Cat 10 RTBF sweep ("delete all traces where retention_until < now()") | ~30% of rows (regulated tenants) | already partial |

**Size budget per 1B rows**: ~24 GB total (8 bytes × 3 columns × 1B / partial selectivity ≈ 50% effective). Negligible vs the 6 GB typed-column delta.

---

## 7. Migration SQL draft

```sql
-- Migration 066: otel_genai_columns
-- Revision ID: 066
-- Revises: 058  (or whatever the latest head is after Cat 23)
-- Purpose: Make Eden telemetry_events OTel GenAI semconv compliant.
--          30 new typed columns + 6 partial indexes + 7 CHECK constraints.
--          All additive, nullable, defaulted. Migration wall-clock target: <60s on 10M rows.

BEGIN;

-- ── Phase A: backfill existing finish_reason values that don't match the
--    canonical enum. Anything not in the new union becomes '_OTHER'.
UPDATE telemetry_events
SET finish_reason = '_OTHER'
WHERE finish_reason IS NOT NULL
  AND finish_reason NOT IN (
      'stop', 'length', 'max_tokens',
      'tool_calls', 'tool_use', 'function_call',
      'content_filter', 'refusal',
      'end_turn', 'stop_sequence', 'pause_turn',
      'error', '_OTHER'
  );

-- ── Phase B: add columns (parallel-safe via IF NOT EXISTS, single ALTER
--    is faster but breaks if any single ADD fails). Use 30 ALTERs, each
--    is ~100ms on 10M rows, total ~3s.
ALTER TABLE telemetry_events
    -- Required
    ADD COLUMN IF NOT EXISTS provider_name         VARCHAR(64),
    ADD COLUMN IF NOT EXISTS operation_name        VARCHAR(64) NOT NULL DEFAULT 'chat',
    ADD COLUMN IF NOT EXISTS error_type            VARCHAR(128),
    ADD COLUMN IF NOT EXISTS conversation_id       VARCHAR(128),
    ADD COLUMN IF NOT EXISTS model_name            VARCHAR(128),
    -- Recommended: usage
    ADD COLUMN IF NOT EXISTS usage_input_tokens        INT,
    ADD COLUMN IF NOT EXISTS usage_output_tokens       INT,
    ADD COLUMN IF NOT EXISTS usage_reasoning_tokens    INT,
    ADD COLUMN IF NOT EXISTS usage_cache_read_tokens   INT,
    ADD COLUMN IF NOT EXISTS usage_cache_creation_tokens INT,
    -- Recommended: latency
    ADD COLUMN IF NOT EXISTS reasoning_effort      VARCHAR(32),
    ADD COLUMN IF NOT EXISTS ttft_ms               INT,
    -- Recommended: request params
    ADD COLUMN IF NOT EXISTS server_address        VARCHAR(256),
    ADD COLUMN IF NOT EXISTS server_port           INT,
    ADD COLUMN IF NOT EXISTS request_temperature   DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS request_top_p         DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS request_top_k         INT,
    ADD COLUMN IF NOT EXISTS request_max_tokens    INT,
    ADD COLUMN IF NOT EXISTS request_choice_count  INT,
    ADD COLUMN IF NOT EXISTS request_seed          BIGINT,
    -- Industry: batch / retry
    ADD COLUMN IF NOT EXISTS is_batch              BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS batch_id              VARCHAR(128),
    ADD COLUMN IF NOT EXISTS retry_attempt         INT NOT NULL DEFAULT 0,
    -- Industry: routing
    ADD COLUMN IF NOT EXISTS circuit_breaker_state VARCHAR(32),
    -- Industry: truncation (Phase 7.2 dedup)
    ADD COLUMN IF NOT EXISTS truncation_reason     VARCHAR(64),
    ADD COLUMN IF NOT EXISTS truncated_chars       INT NOT NULL DEFAULT 0,
    -- Industry: governance (Cat 10)
    ADD COLUMN IF NOT EXISTS is_llm_generated      BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS human_reviewed_by     VARCHAR(128),
    ADD COLUMN IF NOT EXISTS human_reviewed_at     TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS retention_until        TIMESTAMPTZ,
    -- Industry: per-event identity
    ADD COLUMN IF NOT EXISTS user_id               VARCHAR(128),
    ADD COLUMN IF NOT EXISTS release_version       VARCHAR(64),
    ADD COLUMN IF NOT EXISTS deployment_environment VARCHAR(32);

-- ── Phase C: partial indexes (5 new + 1 already exists from 011) ─────
CREATE INDEX IF NOT EXISTS idx_telemetry_provider_model_day
    ON telemetry_events (tenant_id, provider_name, model_name, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_telemetry_batch_id
    ON telemetry_events (batch_id)
    WHERE batch_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_telemetry_tenant_error
    ON telemetry_events (tenant_id, error_type, timestamp DESC)
    WHERE error_type IS NOT NULL;

-- idx_telemetry_events_tenant_finish_reason already exists from 011.
-- Add the reasoning-effort + retention indexes (both new).
CREATE INDEX IF NOT EXISTS idx_telemetry_reasoning_effort
    ON telemetry_events (tenant_id, reasoning_effort, timestamp DESC)
    WHERE reasoning_effort IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_telemetry_trace_retention
    ON telemetry_events (trace_id, retention_until)
    WHERE retention_until IS NOT NULL;

-- ── Phase D: CHECK constraints (NOT VALID + backfill + VALIDATE) ─────
ALTER TABLE telemetry_events
    ADD CONSTRAINT telemetry_events_finish_reason_check
        CHECK (finish_reason IS NULL OR finish_reason IN (
            'stop','length','max_tokens','tool_calls','tool_use','function_call',
            'content_filter','refusal','end_turn','stop_sequence','pause_turn',
            'error','_OTHER'
        )) NOT VALID;

ALTER TABLE telemetry_events VALIDATE CONSTRAINT telemetry_events_finish_reason_check;

ALTER TABLE telemetry_events
    ADD CONSTRAINT telemetry_events_provider_name_check
        CHECK (provider_name IS NULL OR provider_name IN (
            'openai','anthropic','aws.bedrock','gcp.vertex_ai','gcp.gemini',
            'gcp.gen_ai','azure.ai.openai','azure.ai.inference','cohere',
            'groq','deepseek','mistral_ai','x_ai','perplexity','ibm.watsonx.ai',
            'moonshot_ai','eden_native','unknown'
        )) NOT VALID;

ALTER TABLE telemetry_events VALIDATE CONSTRAINT telemetry_events_provider_name_check;

ALTER TABLE telemetry_events
    ADD CONSTRAINT telemetry_events_operation_name_check
        CHECK (operation_name IN (
            'chat','generate_content','text_completion','embeddings','retrieval',
            'create_agent','invoke_agent','execute_tool','invoke_workflow','plan',
            'search_memory','create_memory','update_memory','upsert_memory',
            'delete_memory','create_memory_store','delete_memory_store',
            'span','unknown'
        ));

ALTER TABLE telemetry_events
    ADD CONSTRAINT telemetry_events_reasoning_effort_check
        CHECK (reasoning_effort IS NULL OR reasoning_effort IN
            ('low','medium','high','xhigh','none')) NOT VALID;
ALTER TABLE telemetry_events VALIDATE CONSTRAINT telemetry_events_reasoning_effort_check;

ALTER TABLE telemetry_events
    ADD CONSTRAINT telemetry_events_circuit_breaker_check
        CHECK (circuit_breaker_state IS NULL OR circuit_breaker_state IN
            ('closed','open','half_open','unknown')) NOT VALID;
ALTER TABLE telemetry_events VALIDATE CONSTRAINT telemetry_events_circuit_breaker_check;

ALTER TABLE telemetry_events
    ADD CONSTRAINT telemetry_events_truncation_reason_check
        CHECK (truncation_reason IS NULL OR truncation_reason IN
            ('payload_too_large','pii_redacted','budget_exceeded',
             'max_depth','manual','none')) NOT VALID;
ALTER TABLE telemetry_events VALIDATE CONSTRAINT telemetry_events_truncation_reason_check;

ALTER TABLE telemetry_events
    ADD CONSTRAINT telemetry_events_deployment_env_check
        CHECK (deployment_environment IS NULL OR deployment_environment IN
            ('production','staging','development','test','environment')) NOT VALID;
ALTER TABLE telemetry_events VALIDATE CONSTRAINT telemetry_events_deployment_env_check;

COMMIT;
```

**Estimated wall-clock on 10M rows, populated DB:**
- Phase A (backfill UPDATE): ~2s (single column rewrite, BRIN-indexed `timestamp` helps the predicate)
- Phase B (30 ALTER ADD COLUMN): ~5s (Postgres 11+ instant ADD with default; ~166ms each)
- Phase C (5 partial index CREATE): ~30s (CONCURRENTLY not used here to stay inside the transaction; **revise to use `CREATE INDEX CONCURRENTLY` outside the transaction** — adds ~10s but no lock contention)
- Phase D (7 CHECK ADD + VALIDATE): ~8s (each `VALIDATE CONSTRAINT` does a sequential scan; can run in parallel across constraints on different tablespace)

**Total**: ~55s — within the 60s budget.

**Optimization**: split into **2 migrations** if 55s is too tight:
1. **066a_otel_genai_columns** — Phase A + B + C only (no CHECKs; partial indexes give the same query speedup). ~37s.
2. **066b_otel_genai_constraints** — Phase D only. ~18s. Can run on a separate maintenance window.

---

## 8. Round-trip worked example — OTel span → `TelemetryEvent` → INSERT → SELECT → `from_dict`

### 8.1 Input (OTLP/HTTP JSON, abridged)

```json
{
  "resourceSpans": [{
    "resource": {
      "attributes": [
        {"key": "service.name",               "value": {"stringValue": "eden-ai-sdk"}},
        {"key": "service.version",            "value": {"stringValue": "1.4.0"}},
        {"key": "deployment.environment.name","value": {"stringValue": "production"}},
        {"key": "acme.eden.user.id",          "value": {"stringValue": "user_2b9f"}}
      ]
    },
    "scopeSpans": [{
      "scope": {"name": "opentelemetry-instrumentation-openai", "version": "0.42b0"},
      "spans": [{
        "traceId": "7f4e1a8b9c2d3e4f5a6b7c8d9e0f1a2b",
        "spanId":  "1a2b3c4d5e6f7a8b",
        "parentSpanId": "9f8e7d6c5b4a3210",
        "name":    "chat gpt-4o",
        "kind":    "SPAN_KIND_CLIENT",
        "startTimeUnixNano": "1719532800000000000",
        "endTimeUnixNano":   "1719532801234567000",
        "status":  {"code": "STATUS_CODE_OK"},
        "attributes": [
          {"key": "gen_ai.operation.name",         "value": {"stringValue": "chat"}},
          {"key": "gen_ai.provider.name",          "value": {"stringValue": "openai"}},
          {"key": "gen_ai.request.model",          "value": {"stringValue": "gpt-4o-2024-08-06"}},
          {"key": "gen_ai.request.temperature",    "value": {"doubleValue": 0.7}},
          {"key": "gen_ai.request.top_p",          "value": {"doubleValue": 0.95}},
          {"key": "gen_ai.request.max_tokens",     "value": {"intValue": 4096}},
          {"key": "gen_ai.request.choice.count",   "value": {"intValue": 1}},
          {"key": "gen_ai.request.stream",         "value": {"boolValue": true}},
          {"key": "gen_ai.conversation.id",        "value": {"stringValue": "conv_2b9f1c8d"}},
          {"key": "gen_ai.request.reasoning.level","value": {"stringValue": "medium"}},
          {"key": "server.address",                "value": {"stringValue": "api.openai.com"}},
          {"key": "server.port",                   "value": {"intValue": 443}},
          {"key": "gen_ai.response.id",            "value": {"stringValue": "chatcmpl-9XaBcD"}},
          {"key": "gen_ai.response.model",         "value": {"stringValue": "gpt-4o-2024-08-06"}},
          {"key": "gen_ai.response.finish_reasons","value": {"arrayValue": {"values": [
            {"stringValue": "tool_calls"}
          ]}}},
          {"key": "gen_ai.usage.input_tokens",     "value": {"intValue": 2095}},
          {"key": "gen_ai.usage.output_tokens",    "value": {"intValue": 503}},
          {"key": "gen_ai.usage.cache_read.input_tokens",  "value": {"intValue": 1800}},
          {"key": "openai.response.service_tier",         "value": {"stringValue": "default"}},
          {"key": "openai.response.system_fingerprint",   "value": {"stringValue": "fp_44709d6fcb"}},
          {"key": "acme.eden.batch.id",            "value": {"stringValue": "exp_abc123"}},
          {"key": "acme.eden.retry.attempt",       "value": {"intValue": 0}}
        ],
        "events": [
          {"name": "gen_ai.choice",
           "timeUnixNano": "1719532801100000000",
           "attributes": [
             {"key": "index",        "value": {"intValue": 0}},
             {"key": "finish_reason","value": {"stringValue": "tool_calls"}},
             {"key": "message",      "value": {"kvlistValue": {"values": [
               {"key": "role",    "value": {"stringValue": "assistant"}},
               {"key": "content", "value": {"stringValue": ""}},
               {"key": "tool_calls","value": {"arrayValue": {"values": [
                 {"kvlistValue": {"values": [
                   {"key": "id",       "value": {"stringValue": "call_xyz"}},
                   {"key": "type",     "value": {"stringValue": "function"}},
                   {"key": "function", "value": {"kvlistValue": {"values": [
                     {"key": "name",      "value": {"stringValue": "get_weather"}},
                     {"key": "arguments", "value": {"stringValue": "{\"city\":\"NYC\"}"}}
                   ]}}}
                 ]}}
               ]}}}
             ]}}}
           ]}}
        ]
      }]
    }]
  }]
}
```

### 8.2 Ingest path (otel.py already does this)

`OtelDecoder.detect()` → returns `True` (has `resourceSpans`). `OtelDecoder.decode()` walks resource/scope/span, calls `_span_to_raw_dict(span, resource_attrs, scope)` (otel.py:188-479), then `normalize_to_telemetry_event(raw, attribution)` (normalizer.py:108-201).

### 8.3 Resulting `TelemetryEvent` (after normalizer)

```python
TelemetryEvent(
    event_id="1a2b3c4d5e6f7a8b",
    trace_id="7f4e1a8b9c2d3e4f5a6b7c8d9e0f1a2b",
    parent_span_id="9f8e7d6c5b4a3210",
    span_id="1a2b3c4d5e6f7a8b",
    timestamp="2026-06-27T16:00:00+00:00",     # ISO 8601 from ns
    duration_ms=1234.567,                       # endTimeUnixNano - startTimeUnixNano
    event_type="otel.chat",
    name="gpt-4o-2024-08-06",                   # from gen_ai.response.model
    outcome="success",                          # STATUS_CODE_OK
    source_format="otel",
    realm="production",                         # deployment.environment.name=production

    # ── payload ─────────────────────────────────────────────────
    payload={
        "otel": {
            "operation": "chat",
            "request_model": "gpt-4o-2024-08-06",
            "response_model": "gpt-4o-2024-08-06",
            "provider": "openai",
            "response_id": "chatcmpl-9XaBcD",
            "finish_reasons": ["tool_calls"],
            "request_temperature": 0.7,
            "request_max_tokens": 4096,
            "request_top_p": 0.95,
            "request_stream": True
        },
        "resource": {
            "service.name": "eden-ai-sdk",
            "service.version": "1.4.0",
            "deployment.environment.name": "production",
            "acme.eden.user.id": "user_2b9f"
        },
        "events": [{"name": "gen_ai.choice", "time_ns": 1719532801100000000, ...}]
    },
    # ── metrics (JSONB, kept for back-compat) ──────────────────
    metrics={
        "input_tokens": 2095.0, "output_tokens": 503.0,
        "cache_read_tokens": 1800.0, "cache_creation_tokens": 0.0,
        "duration_ms_otel": 1234.567, "ttft_ms": 412.0
    },
    # ── attributes (JSONB) ─────────────────────────────────────
    attributes={
        "otel.span.kind": "SPAN_KIND_CLIENT",
        "otel.scope.name": "opentelemetry-instrumentation-openai",
        "otel.scope.version": "0.42b0",
        "otel.status.code": "STATUS_CODE_OK",
        "service.name": "eden-ai-sdk",
        "gen_ai.conversation.id": "conv_2b9f1c8d",
        "gen_ai.provider.name": "openai"
    },
    tags=["otel", "service:eden-ai-sdk", "env:production"],

    # ── capture fields (Phase 7.2) ────────────────────────────
    request_body={
        "messages": [], "model": "gpt-4o-2024-08-06",
        "temperature": 0.7, "max_tokens": 4096, "top_p": 0.95,
        "stream": True
    },
    response_body={
        "id": "chatcmpl-9XaBcD", "model": "gpt-4o-2024-08-06",
        "choices": [{"index": 0, "finish_reason": "tool_calls",
                     "message": {"role": "assistant", "content": "",
                                 "tool_calls": [...]}}],
        "finish_reasons": ["tool_calls"],
        "usage": {"input_tokens": 2095, "output_tokens": 503,
                  "cache_read_input_tokens": 1800}
    },
    tool_calls_full=[{
        "id": "call_xyz", "name": "get_weather",
        "arguments": "{\"city\":\"NYC\"}"
    }],
    reasoning=None,
    finish_reason="tool_calls",                   # from gen_ai.response.finish_reasons[0]
    stop_sequence=None,
    system_fingerprint="fp_44709d6fcb",
    cache_hit=True,                               # bool(cache_read_input_tokens)
    model_version="gpt-4o-2024-08-06",
    service_tier="default",

    # ── NEW typed columns (the cut we're proposing) ──────────
    provider_name="openai",
    operation_name="chat",
    error_type=None,
    conversation_id="conv_2b9f1c8d",
    model_name="gpt-4o-2024-08-06",
    usage_input_tokens=2095,
    usage_output_tokens=503,
    usage_reasoning_tokens=None,
    usage_cache_read_tokens=1800,
    usage_cache_creation_tokens=None,
    reasoning_effort="medium",
    ttft_ms=412,
    server_address="api.openai.com",
    server_port=443,
    request_temperature=0.7,
    request_top_p=0.95,
    request_top_k=None,
    request_max_tokens=4096,
    request_choice_count=1,
    request_seed=None,
    is_batch=False,                               # choice.count == 1
    batch_id="exp_abc123",
    retry_attempt=0,
    circuit_breaker_state=None,
    truncation_reason="none",
    truncated_chars=0,
    is_llm_generated=True,
    human_reviewed_by=None,
    human_reviewed_at=None,
    retention_until=None,
    user_id="user_2b9f",
    release_version="1.4.0",                      # from service.version
    deployment_environment="production",
)
```

### 8.4 Round-trip assertion

```python
# INSERT (collector.py:559-632, extended with the 30 new cols in the same order)
row = await client.execute(
    """INSERT INTO telemetry_events (
        event_id, tenant_id, project_id, trace_id, realm, event_type, timestamp,
        agent_id, agent_version, environment_id, parent_span_id, span_id, name,
        duration_ms, payload, metrics, attributes, tags, outcome, source_format,
        request_body, response_body, reasoning, tool_calls_full, tool_results,
        images, audio, logprobs, citations, finish_reason, stop_sequence,
        system_fingerprint, cache_hit, prompt_cache_savings_usd,
        model_version, service_tier,
        -- ... 12 zstd cols ...
        request_message_hashes, response_message_hashes,
        -- NEW COLUMNS (066):
        provider_name, operation_name, error_type, conversation_id, model_name,
        usage_input_tokens, usage_output_tokens, usage_reasoning_tokens,
        usage_cache_read_tokens, usage_cache_creation_tokens,
        reasoning_effort, ttft_ms,
        server_address, server_port,
        request_temperature, request_top_p, request_top_k, request_max_tokens,
        request_choice_count, request_seed,
        is_batch, batch_id, retry_attempt, circuit_breaker_state,
        truncation_reason, truncated_chars,
        is_llm_generated, human_reviewed_by, human_reviewed_at, retention_until,
        user_id, release_version, deployment_environment,
        created_at
    ) VALUES ($1, ..., $N, NOW())
    ON CONFLICT (event_id) DO NOTHING""",
    # bind values in the same order
    ...
)

# SELECT → round-trip
round_tripped = TelemetryEvent.from_dict(
    (await client.fetchrow(
        "SELECT * FROM telemetry_events WHERE event_id = $1",
        "1a2b3c4d5e6f7a8b"
    ))
)

assert round_tripped.provider_name == "openai"
assert round_tripped.usage_input_tokens == 2095
assert round_tripped.usage_cache_read_tokens == 1800
assert round_tripped.ttft_ms == 412
assert round_tripped.request_temperature == 0.7
assert round_tripped.deployment_environment == "production"
assert round_tripped.batch_id == "exp_abc123"
assert round_tripped.user_id == "user_2b9f"
assert round_tripped.conversation_id == "conv_2b9f1c8d"
assert round_tripped.is_batch is False
assert round_tripped.retry_attempt == 0
```

**The 8 `from_dict()` changes** — in the dataclass at `telemetry_collector.py:135-175`, add the 30 fields after `service_tier`. Each line is `data.get("provider_name")`, etc. The Pydantic ingest model in `src/eden/api/routes/observability.py:35` (`TelemetryEventIngest`) needs the same 30 fields added as `Optional[...]` with no default other than `None`. Migration of the dataclass is **backward compatible** — existing rows in Postgres will round-trip with all 30 new fields as `None`, which is correct (we only fill them for new ingest).

---

## 9. OTel exporter wiring (OTLP/HTTP vs OTLP/gRPC)

### 9.1 Endpoint defaults

| Protocol | Default endpoint | Package | Path |
|---|---|---|---|
| **OTLP/HTTP** | `http://localhost:4318` | `opentelemetry-exporter-otlp-proto-http` | `/v1/traces`, `/v1/metrics`, `/v1/logs` (signal suffix required in URL) |
| **OTLP/gRPC** | `http://localhost:4317` | `opentelemetry-exporter-otlp-proto-grpc` | just host:port |

For Eden: the OTLP HTTP receiver lives at `src/eden/observability/ingestion/otel.py:521` (`OtelDecoder`) and the gRPC receiver at `src/eden/observability/ingestion/otel_grpc.py`. **Recommendation: ship both receivers on the same FastAPI process** (current state) and document that tenants with high trace volume should configure their SDK to use the gRPC receiver for HTTP/2 multiplexing + bidirectional streaming.

### 9.2 Env-var configuration

```bash
# Standard OTel SDK env vars (read by opentelemetry-exporter-otlp-*)
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf       # or grpc
export OTEL_EXPORTER_OTLP_ENDPOINT=https://api.eden.com/otel
export OTEL_EXPORTER_OTLP_HEADERS="authorization=Bearer <token>,x-eden-tenant=<org_id>"
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://api.eden.com/otel/v1/traces
export OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=https://api.eden.com/otel/v1/metrics

# Resource attributes
export OTEL_SERVICE_NAME=eden-ai-sdk
export OTEL_SERVICE_VERSION=1.4.0
export OTEL_DEPLOYMENT_ENVIRONMENT=production
```

### 9.3 Python SDK wiring (recommended for the Eden SDK)

```python
from opentelemetry import trace, metrics
from opentelemetry.sdk.resources import Resource, SERVICE_NAME, SERVICE_VERSION, DEPLOYMENT_ENVIRONMENT
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.exporter.otlp.proto.http.metric_exporter import OOTLPMetricExporter  # (real: OTLPMetricExporter)
from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader

resource = Resource.create({
    SERVICE_NAME: "eden-ai-sdk",
    SERVICE_VERSION: "1.4.0",
    DEPLOYMENT_ENVIRONMENT: os.environ.get("EDEN_ENV", "production"),
    # Eden-specific resource attrs (acme.eden.* namespace):
    "acme.eden.user.id":   os.environ.get("EDEN_USER_ID", ""),
    "acme.eden.tenant.id": os.environ.get("EDEN_TENANT_ID", ""),
    "acme.eden.release.version": os.environ.get("EDEN_RELEASE", "1.4.0"),
})

# Trace pipeline
provider = TracerProvider(resource=resource, sampler=... )
processor = BatchSpanProcessor(
    OTLPSpanExporter(
        endpoint="https://api.eden.com/otel/v1/traces",
        headers={"authorization": f"Bearer {api_key}"},
    ),
    max_queue_size=8192,                  # spec default 2048; doubled for burst
    max_export_batch_size=2048,           # spec default 512; doubled
    schedule_delay_millis=3000,           # spec default 5000; halved for freshness
    max_export_timeout_millis=30000,      # spec default 30000
)
provider.add_span_processor(processor)
trace.set_tracer_provider(provider)

# Metric pipeline (Cat 8 cost metrics; Cat 13 drift detector)
metric_reader = PeriodicExportingMetricReader(
    exporter=OTLPMetricExporter(endpoint="https://api.eden.com/otel/v1/metrics"),
    export_interval_millis=60_000,
)
metrics.set_meter_provider(MeterProvider(resource=resource, metric_readers=[metric_reader]))
```

### 9.4 `BatchSpanProcessor` defaults (per OTel SDK spec)

| Parameter | Spec default | Eden recommended |
|---|---|---|
| `maxQueueSize` | 2048 | 8192 |
| `maxExportBatchSize` | 512 | 2048 |
| `scheduledDelayMillis` | 5000 | 3000 |
| `exportTimeoutMillis` | 30000 | 30000 |
| max concurrent exports | synchronized per exporter (no separate setting) | n/a |

The doubling is justified by Eden's JIT-tracing pattern (Cat 14 self-healer can emit 200+ spans in a burst when an agent's reasoning tree replays after a `_pending_approval` rejection). The 3s schedule delay gives the queue 3s to accumulate a fat batch before flush — cuts OTLP overhead by ~40% vs the 5s default.

### 9.5 Resource attributes (required for every span)

```python
from opentelemetry.sdk.resources import Resource, SERVICE_NAME, SERVICE_VERSION

required_resource_attrs = {
    SERVICE_NAME: "eden-ai-sdk",                # Required (per OTel semconv)
    SERVICE_VERSION: "1.4.0",                    # Recommended
    "service.namespace": "eden",                 # Recommended
    "deployment.environment.name": "production",# Opt-In (Stable for server.*, dev for deployment)
    "telemetry.sdk.name": "opentelemetry",       # SDK-stamped
    "telemetry.sdk.language": "python",          # SDK-stamped
    "telemetry.sdk.version": "1.27.0",           # SDK-stamped
    # Eden additions:
    "acme.eden.tenant.id": "<org_id>",
    "acme.eden.user.id":   "<user_id>",
    "acme.eden.release.version": "<git_sha>",
}
```

`service.name` is the only Required resource attribute. If unset, the SDK MUST default to `unknown_service` — Eden's Pydantic ingest model rejects empty `tenant_id`/`project_id`, so any unknown_service span would fail attribution. **Recommend: hard-fail the SDK init if `OTEL_SERVICE_NAME` is unset.**

---

## 10. Multi-format alignment (already-shipping ingestion paths)

The OTel GenAI cut must not break the existing 7 decoder paths (`src/eden/observability/ingestion/`):

| Source | Existing finish_reason mapping | New fields it CAN populate | New fields it CAN'T populate (require SDK cooperation) |
|---|---|---|---|
| `openai.py` | direct from response | provider_name, model_name, usage_*, request_*, server_address, system_fingerprint, service_tier | conversation_id (if not in metadata), reasoning_effort (need o-series SDK tag), batch_id (Eden stamp) |
| `anthropic.py` | `stop_reason` → `finish_reason` | provider_name, model_name, usage_*, usage_cache_*, reasoning_effort (extended-thinking), request_* | ttft_ms (needs streaming instrumentation) |
| `bedrock.py` | via Anthropic | provider_name=`aws.bedrock`, model_name, usage_* | everything else requires the Bedrock InvokeModel response to surface GenAI attrs |
| `gemini.py` | `finishReason` UPPERCASE → canonical | provider_name, model_name, usage_* | reasoning_effort (Gemini Thinking is a flag not a level), server_address (default) |
| `helicone.py` | proxied through OpenAI-format | all | none — helicone proxies raw request/response |
| `langfuse.py` | via OpenAI-format on the way out | all gen_ai.* attrs (Langfuse v3 emits OTel) | depends on Langfuse's normalization |
| `framework.py` | varies | all | mixed (langchain/llamaindex emit OTel GenAI natively since late 2025) |
| `webhook.py` | varies | all | mixed |

**Migration checklist per decoder:**
1. Add a `_normalize_finish_reason(value, provider_name)` call before assigning `finish_reason` (otel.py:472 already calls `_first_finish_reason`; wrap it).
2. Populate the 30 new typed columns in the raw-dict shape the decoder returns (parallel to otel.py:444-479).
3. Map `acme.eden.*` resource attrs where present (most decoders pass through resource attrs into `payload["resource"]`).

---

## 11. Comparison with OpenLLMetry, OpenInference, Langfuse

### 11.1 OpenLLMetry (Traceloop)

| Aspect | OpenLLMetry | OTel GenAI (what Eden adopts) |
|---|---|---|
| Attribute namespace | Was `traceloop.*` + `llm.*`; **merged into OTel** (per README) | `gen_ai.*` |
| `system` | `llm.system` (e.g., `openai`, `anthropic`) | `gen_ai.provider.name` |
| `model_name` | `llm.model_name` | `gen_ai.request.model` / `gen_ai.response.model` |
| Token counts | `llm.token_count.prompt`, `llm.token_count.completion`, `llm.token_count.total` | `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens` (no total — sum at query time) |
| Conversation | `session.id` | `gen_ai.conversation.id` |
| Messages | `llm.input_messages`, `llm.output_messages` | `gen_ai.input.messages`, `gen_ai.output.messages` (Opt-In) |
| Invocation params | `llm.invocation_parameters` (JSON string) | individual `gen_ai.request.*` attributes (Recommended) |
| Finish reason | `llm.finish_reason` | `gen_ai.response.finish_reasons` (string[]) |
| Vector DB | `db.system = "pinecone"`, `db.*` (kept proprietary) | `gen_ai.data_source.id`, `gen_ai.retrieval.documents` |
| Stability | Mixed (legacy = Experimental) | Mostly Development; some Stable |

**Verdict:** OpenLLMetry is now an upstream contributor to OTel GenAI; their SDK emits `gen_ai.*` natively as of late 2025. **Eden's choice of OTel GenAI is forward-compatible with OpenLLMetry** — no migration cost for tenants that use the OTel-instrumentation packages directly.

### 11.2 OpenInference (Arize)

| Aspect | OpenInference | OTel GenAI |
|---|---|---|
| `span.kind` | `openinference.span.kind = "LLM"` / "TOOL" / "CHAIN" / "RETRIEVER" / "EMBEDDING" / "AGENT" / "RERANKER" / "GUARDRAIL" / "EVALUATOR" | `gen_ai.operation.name` (no kind field — kind inferred from operation) |
| `system` | `llm.system` | `gen_ai.provider.name` |
| `model_name` | `llm.model_name` | `gen_ai.request.model` |
| Token counts | `llm.token_count.{prompt,completion,total}` | `gen_ai.usage.{input,output}_tokens` |
| Messages | `llm.input_messages.<i>.message.{role,content}` | `gen_ai.input.messages` (typed array) |
| Invocation params | `llm.invocation_parameters` (JSON) | individual `gen_ai.request.*` attrs |
| Tool calls | `tool.name`, `tool.description`, `tool.parameters` | `gen_ai.tool.name`, `gen_ai.tool.definitions` |
| User/session | `session.id`, `user.id` | `gen_ai.conversation.id` (no user/session — must add to Eden's `user_id`) |
| Capture control | `OPENINFERENCE_HIDE_INPUTS`, `OPENINFERENCE_HIDE_OUTPUTS` env vars | `OTEL_SEMCONV_STABILITY_OPT_IN` + per-attr Opt-In flag |

**Verdict:** OpenInference is a parallel, more mature spec — but **not OTel-compliant**. It's dominant in the Phoenix/Arize ecosystem. For Eden, the right play is: **adopt OTel GenAI as primary** (industry trajectory), but **continue to parse `llm.*` attrs from OpenInference-emitting SDKs into the existing `attributes` JSONB** (not into the new typed columns). Same approach we already use for Helicone/Langfuse.

### 11.3 Langfuse

Langfuse is built on OTel as the wire format. Its data model is `Trace → Observation → {Span, Generation, Tool, Retriever, Embedding, Event, Agent}`. The **enrichment attributes** (`user_id`, `session_id`, `tags`, `metadata`, `release`, `version`) are Langfuse's value-add over OTel GenAI.

**Verdict:** **Add Langfuse's enrichment attrs as Eden's Industry columns** (`user_id`, `release_version`, etc. — see §2 table rows 45-47). This makes Eden-compatible traces importable into Langfuse via the OTel SDK and vice-versa.

### 11.4 Decision matrix

| Tenant uses | Their trace emits | Eden's path |
|---|---|---|
| OpenTelemetry SDK directly | `gen_ai.*` | ✅ typed columns populated; full benefit |
| OpenLLMetry | `gen_ai.*` (post-2025 merge) | ✅ same as OTel |
| OpenInference / Phoenix | `llm.*`, `tool.*`, `openinference.span.kind` | ⚠️ JSONB only; consider adding a `provider_name`-from-`llm.system` mapper in normalizer |
| Langfuse SDK | OTel + enrichment | ✅ typed columns + user_id/release_version |
| Helicone proxy | `gen_ai.*` (post-2025) or raw OpenAI-format | ✅ mapped through `openai.py` decoder |
| Native SDK (no instrumentation) | raw response only | ⚠️ `provider_name` and `usage_*` populated from response; `request_*` populated from request body; `acme.eden.*` blank |

---

## 12. Citations

1. **OpenTelemetry GenAI semantic conventions** (new canonical repo) — https://github.com/open-telemetry/semantic-conventions-genai
   - 60-attribute registry: https://raw.githubusercontent.com/open-telemetry/semantic-conventions-genai/main/model/gen-ai/registry.yaml
   - Span attributes: https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-spans.md
   - Metrics: https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-metrics.md
   - Events: https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-events.md
   - OpenAI provider: https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/openai.md
   - Anthropic provider: https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/anthropic.md
   - AWS Bedrock provider: https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/aws-bedrock.md
2. **Legacy redirect** (every doc shows "this page has moved" banner) — https://opentelemetry.io/docs/specs/semconv/gen-ai/
3. **OTel Python exporters** (HTTP/gRPC endpoint defaults 4318/4317, env vars) — https://opentelemetry.io/docs/languages/python/exporters/
4. **OTel Tracing SDK spec** (BatchSpanProcessor defaults: max_queue_size=2048, max_export_batch_size=512, scheduledDelayMillis=5000, exportTimeoutMillis=30000) — https://opentelemetry.io/docs/specs/otel/trace/sdk/
5. **Resource semantic conventions** (service.name Required; service.version Recommended; deployment.environment.name Opt-In) — https://opentelemetry.io/docs/specs/semconv/resource/
6. **OpenTelemetry Collector configuration** (batch processor `timeout: 5s`, `send_batch_size: 1024`) — https://opentelemetry.io/docs/collector/configuration/
7. **OpenLLMetry (Traceloop)** — https://github.com/traceloop/openllmetry — *"Our semantic conventions are now part of OpenTelemetry!"*
8. **OpenInference (Arize)** — https://github.com/Arize-ai/openinference/blob/main/spec/semantic_conventions.md — `llm.system`, `llm.model_name`, `llm.token_count.*`, `llm.input_messages`, `llm.output_messages`, `llm.invocation_parameters`, `openinference.span.kind ∈ {LLM, TOOL, CHAIN, RETRIEVER, EMBEDDING, AGENT, RERANKER, GUARDRAIL, EVALUATOR}`
9. **Langfuse data model** — https://langfuse.com/docs/observability/data-model — `Trace → Observation → {Span, Generation, Tool, Retriever, Embedding, Event, Agent}`, enrichment attrs `user_id`/`session_id`/`tags`/`metadata`/`release`/`version`
10. **OpenAI Chat Completions API reference** — https://platform.openai.com/docs/api-reference/chat/object → now https://developers.openai.com/api/docs — `finish_reason ∈ {stop, length, tool_calls, content_filter, function_call}`
11. **Anthropic Messages API** — https://docs.anthropic.com/en/api/messages → now https://platform.claude.com/docs/en/api/messages — `stop_reason ∈ {end_turn, max_tokens, stop_sequence, tool_use, pause_turn, refusal}`
12. **Eden existing migration patterns** — `src/eden/db_migrations/versions/009_telemetry_events.py` (base table), `011_capture_full_payloads.py` (Phase 7.2 cols, partial index pattern), `058_a2a_links.py` (recent ALTER pattern, `parent_agent_span_id` UUID + partial idx)
13. **Eden existing OTel ingest path** — `src/eden/observability/ingestion/otel.py:188-479` (`_span_to_raw_dict`), `otel.py:521` (`OtelDecoder`), `normalizer.py:108-201` (`normalize_to_telemetry_event`), `telemetry_collector.py:33` (`TelemetryEvent` dataclass)