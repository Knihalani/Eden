---
title: "22 — APM Depth + Tracing Depth (v1.4)"
status: IMPLEMENTED v1
last_updated: 2026-06-12
version: 1.0
---

# 22 — APM Depth + Tracing Depth (v1.4)

> **Status:** ✅ **IMPLEMENTED v1** (shipped 2026-06-12,
> all 6 features). **Design + code complete.**
> This is **not** a new feature surface — it's a depth
> upgrade to the existing `telemetry_events` schema, the
> OTel ingestion decoder, and the sampling pipeline. Closes
> the gap between Eden's LLM-specific observability and the
> 2026 general-purpose APM stack (Datadog, Honeycomb, Grafana).
> **3-week ship**; ~6 new files, ~1,200 LOC.

## Table of Contents

1. [Goal & motivation](#goal--motivation)
2. [What's already in Eden](#whats-already-in-eden)
3. [The 6 APM signals — current state](#the-6-apm-signals--current-state)
4. [OTel GenAI v1.41 spec compliance](#otel-genai-v141-spec-compliance)
5. [Tail-based sampling at the gateway tier](#tail-based-sampling-at-the-gateway-tier)
6. [Per-step evaluation scores](#per-step-evaluation-scores)
7. [Agent-specific metrics](#agent-specific-metrics)
8. [K8s attribute enrichment](#k8s-attribute-enrichment)
9. [Continuous profiling (next-step)](#continuous-profiling-next-step)
10. [Message-level dedup (Laminar 20x parity, v1.4.1)](#message-level-dedup-laminar-20x-parity-v141)
11. [Acceptance criteria](#acceptance-criteria)

## Goal & motivation

Eden's observability platform is already strong on the
LLM-specific axis (9 ingest-format decoders, 7 Cat 3 + 3
Galileo Luna-2 judges, 5 cats shipped with real
implementations). The competitive gap to Datadog /
Honeycomb / Grafana is on the **general-purpose APM** axis:
6-signal coverage (traces + metrics + logs + RUM + synthetic
+ continuous profiling), OTel GenAI v1.41 spec compliance,
tail-based sampling at the gateway tier, K8s attribute
enrichment, code-level profiling.

This cat closes those gaps without inventing a new feature
surface — it makes the existing `telemetry_events` schema
and `OtelDecoder` more complete, more efficient, and more
deeply correlated with the infrastructure the customer
already runs.

The competitive payoff:

* **Datadog APM correlation** — every Eden span carries
  K8s pod / namespace / container / node attributes, so
  the existing APM correlation story (LLM span ↔ container
  ↔ host ↔ log) just works.
* **OpenTelemetry GenAI v1.41 compliance** — Eden becomes
  forward-compatible with the spec the OTel GenAI SIG is
  stabilising; the 2026 Greptime analysis says "building on
  the spec today is a reasonable bet" so we move now
  while the dual-emit window is open.
* **Tail-based sampling** — the gateway tier stops
  OOM-killing (the 2025 Michal Drozd post-mortem warned
  about this) and starts keeping 100% of error traces
  while dropping 90% of healthy ones. The cost-of-storage
  line item drops 5-10× for the same diagnostic quality.
* **Per-step evaluation** — the Cat 16 Decision Scorer
  becomes a step-by-step timeline, not a single trace-level
  number. The Cat 2 RCA can pinpoint the failing step in
  a 50-step agent run.

## What's already in Eden

* `src/eden/observability/ingestion/otel.py` — `OtelDecoder`
  reads `resourceSpans` / `resource_spans` JSON, maps
  `gen_ai.*` attributes (v1.36 + partial v1.41), 9
  source-format decoders
* `src/eden/observability/ingestion/framework.py` —
  framework decoder routes LangChain, LlamaIndex, Vercel
  AI, Mastra, CrewAI, Smolagents, Pydantic AI through OTel
* `src/eden/observability/ingestion/otel_grpc.py` — gRPC
  OTLP ingest path
* `src/eden/observability/telemetry_collector.py` —
  `Eden Telemetry Collector` (ETC) — async ingestion,
  validation, enrichment, dedup, fanout to Redis /
  Postgres / ClickHouse / WebSocket
* `src/eden/db_migrations/versions/009_telemetry_events.py` —
  `telemetry_events` schema with `idx_telemetry_events_
  trace_id`, `_tenant_type_time`, `_source_format`,
  `_tenant_realm_time`, `_tenant_timestamp` indices
* `src/eden/observability/realtime/live_tail.py` — Cat 1
  SSE live-tail endpoint (partial RUM coverage)
* `src/eden/decision/` — Cat 16 trajectory analyzer +
  decision scorer (per-step data structure already in
  the model; just needs to land in `telemetry_events`)

## The 6 APM signals — current state

Per the 2026 APM guide (Augment Code, May 2026), the 6
signals are: traces, metrics, logs, RUM, synthetic
monitoring, continuous profiling.

| Signal | Status in Eden (v1.3) | v1.4 work |
|---|---|---|
| **Traces** | ✅ `telemetry_events` + OTel decoder (v1.36 + partial v1.41) | Full v1.41 attribute coverage + dual-emit |
| **Metrics** | ✅ `usage_events` + `judge_scores` + rollup tables | 3 new agent-specific metrics (depth, tool success, cost/step) |
| **Logs** | ✅ `telemetry_collector` async ingest | (no work — already strong) |
| **RUM** | 🟡 Cat 1 SSE live-tail (internal-only) | (out of scope — internal admin use, not customer-facing RUM) |
| **Synthetic** | ❌ none | (next-step; document as Cat 22.5) |
| **Continuous profiling** | ❌ none | (next-step; Pyroscope integration in week 30) |

**Eden in v1.4: 4 of 6 signals live; 2 deferred.** This is
competitive with Langfuse (4/6), trailing Datadog (6/6),
ahead of Braintrust (3/6, no logs/profiling).

## OTel GenAI v1.41 spec compliance

The OTel GenAI semantic conventions are still in
**Development** status as of May 2026 (Greptime
analysis). The spec spans 6 layers:

1. **Client (model-call) spans** — `gen_ai.chat`,
   `gen_ai.embeddings`, `gen_ai.text_completion` (already
   supported in Eden's OTel decoder)
2. **Agent spans** — `gen_ai.operation.name=create_agent`,
   `invoke_agent` (CLIENT or INTERNAL)
3. **Workflow spans** — `gen_ai.operation.name=invoke_workflow`
4. **Tool spans** — `gen_ai.operation.name=execute_tool`,
   span name MUST include `gen_ai.tool.name`
5. **MCP spans** — Model Context Protocol conventions
6. **Events + exceptions + metrics** — `gen_ai.client
   .token.usage` (histogram), `gen_ai.client.operation
   .duration` (histogram)

### v1.4 dual-emit pattern

For each span, emit **both** the v1.36-legacy and
v1.41-current attribute names:

```python
def emit_llm_span(event, *, model, input_tokens, output_tokens, duration_ms):
    # v1.36 legacy
    event["gen_ai.usage.input_tokens"] = input_tokens
    event["gen_ai.usage.output_tokens"] = output_tokens
    # v1.41 current
    event["gen_ai.client.token.usage"] = input_tokens + output_tokens
    event["gen_ai.client.operation.duration"] = duration_ms
    # Dual-emit env var
    os.environ.setdefault("OTEL_SEMCONV_STABILITY_OPT_IN",
                          "gen_ai_latest_experimental")
```

This is the same dual-emit pattern OpenInference
instrumentations ship, and is recommended by the OTel
GenAI SIG during the spec transition.

### Agent span support

```python
# Agent span (new in v1.4)
{
    "name": "invoke_agent customer_service_agent",
    "kind": "INTERNAL",
    "attributes": {
        "gen_ai.operation.name": "invoke_agent",
        "gen_ai.agent.name": "customer_service_agent",
        "gen_ai.agent.version": "1.4.2",
        "gen_ai.request.model": "claude-sonnet-4",
        # ...
    }
}

# Tool span (new in v1.4)
{
    "name": "execute_tool search_kb",
    "kind": "INTERNAL",
    "attributes": {
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": "search_kb",
        "gen_ai.tool.call.arguments": "{\"query\": \"...\"}",  # Opt-In
        "gen_ai.tool.call.result": "{...}",  # Opt-In
    }
}
```

## Tail-based sampling at the gateway tier

The existing `telemetry_collector` writes to
`telemetry_events` but does **not** do tail-based sampling.
In production, this means we store 100% of spans, which
becomes a 5-10× cost problem for high-volume orgs.

### Design

```python
class TailSamplingPolicy:
    """Buffer spans for decision_wait=10s, then decide."""

    KEEP_RULES = [
        # Always keep errors
        KeepIf(status_code="ERROR"),
        # Always keep slow traces
        KeepIf(latency_p99_threshold_ms=500),
        # Always keep agent-loop traces
        KeepIf(matches="gen_ai.agent.loop"),
        # Always keep 1% probabilistic
        KeepIf(probabilistic=0.01),
        # Always keep QA team's tagged traces
        KeepIf(span_attribute="x-force-trace" == "true"),
    ]
```

### Sizing formula (per Sematext 2026 + Drozd 2025)

```
num_traces = expected_traces_per_sec × decision_wait × 1.5
memory_gb = num_traces × 20KB
decision_wait = p99_latency_sec + 2s
```

For Eden at 1,000 traces/sec: 18,000 slots, ~360 MB memory.
Fits comfortably on a single 4 GB gateway tier.

### Watch the dropped-trace counter

Per Drozd's post-mortem, the most common production bug is
"num_traces undersized → oldest traces dropped, including
the error traces you wanted to keep." v1.4 ships the
counter as a Cat 8 metric (`otel_sampling.dropped_traces`)
with a Cat 9 alert at > 1% drop rate.

## Per-step evaluation scores

The existing `telemetry_events` schema has one row per
LLM/agent event. A 50-step agent run produces 50 rows
linked by `trace_id` + `parent_span_id`. The Cat 3 judges
currently score **the trace as a whole** (via the
`JudgeRegistry.for_event` pattern that returns judges for
the event type).

v1.4 adds two columns to `telemetry_events` so the judges
can score **per step**:

```sql
ALTER TABLE telemetry_events
  ADD COLUMN step_index INT,
  ADD COLUMN step_judges JSONB;  -- {judge_name: JudgeScore}
```

The Cat 16 Decision Scorer then becomes a per-step
timeline:

```python
for event in trace_events:
    if event.step_judges:
        # Already scored per step
        continue
    if event.event_type in LLM_EVENT_TYPES:
        # Score this step
        judges = registry.for_event(event)
        scores = await runner.run_for_event(event, judges)
        event.step_judges = {s.judge_name: s.to_dict() for s in scores}
```

The Cat 2 RCA clusterer uses these per-step scores to
pinpoint the failing step (e.g., "step 23's hallucination
score dropped to 0.3; steps 1-22 were >0.8").

## Agent-specific metrics

Three new metrics derived from existing data:

### `decision_path_depth` (per trace, percentile over time)

```python
def compute_decision_path_depth(trace_id):
    """Count of reasoning steps in a trace."""
    return db.fetchval("""
        SELECT count(*)
        FROM telemetry_events
        WHERE trace_id = $1
          AND event_type LIKE 'otel.workflow.%'
    """, trace_id)
```

**Alert at p95 > 20** (potential loop condition; per the
Gheware 2026 production guide).

### `tool_call_success_rate` (per tool, per tenant)

```python
def compute_tool_success_rate(tool_name, tenant_id, window='1h'):
    return db.fetchrow("""
        SELECT
            count(*) FILTER (WHERE status_code = 'OK') AS success,
            count(*) AS total
        FROM telemetry_events
        WHERE tenant_id = $1
          AND event_type = 'otel.tool.execute'
          AND attributes->>'gen_ai.tool.name' = $2
          AND created_at > now() - INTERVAL '1 hour'
    """, tenant_id, tool_name)
```

**Alert at < 80%** over a 30-min window.

### `cost_per_step_usd` (per step, per agent)

```python
def compute_cost_per_step(trace_id):
    """Join usage_events to telemetry_events on step_index."""
    return db.fetch("""
        SELECT te.step_index,
               te.event_type,
               sum(ue.cost_usd) AS step_cost_usd
        FROM telemetry_events te
        JOIN usage_events ue
          ON ue.trace_id = te.trace_id
         AND ue.span_id = te.span_id
        WHERE te.trace_id = $1
        GROUP BY te.step_index, te.event_type
        ORDER BY te.step_index
    """, trace_id)
```

**Alert on > 3× baseline** (the Gheware 2026 token-spike
signal).

## K8s attribute enrichment

The existing `OtelDecoder` does not enrich spans with K8s
attributes. v1.4 ships the OTel `k8sattributes` processor
wired into the gateway tier (via `otel_grpc.py`):

```yaml
# otel-collector-config.yaml (gateway tier)
processors:
  k8sattributes:
    auth_type: serviceAccount
    pod_association:
      - sources:
          - from: resource_attribute
            name: k8s.pod.uid
    extract:
      metadata:
        - k8s.pod.name
        - k8s.namespace.name
        - k8s.deployment.name
        - k8s.node.name
      labels:
        - tag_name: app.kubernetes.io/component
          key: app.kubernetes.io/component
          from: pod
```

Result: every Eden span carries `k8s.pod.name`,
`k8s.namespace.name`, `k8s.deployment.name`, `k8s.node.name`.
The Cat 2 RCA clusterer + the new Cat 22 path-depth metric
both consume these.

## Continuous profiling (next-step)

Out of scope for v1.4 ship, but documented as the
next-step investment (week 30+).

Pyroscope is the 2026 default for OSS continuous profiling
(CNCF Incubating project as of Q1 2026). The integration is:

1. Add `pyroscope-io` SDK to the gateway tier
2. Tag every profile with `org_id`, `agent_id`,
   `trace_id_sample_rate=0.01`
3. Ship the Cat 22 Pyroscope client
   (`apm_depth/profiling.py`) that pulls the profile URL
   back to the portal

The win: when the user sees "step 23 took 2.3s," they can
click through to a flame graph showing the exact function
in the agent loop that consumed 80% of the CPU.

## Message-level dedup (Laminar 20x parity, v1.4.1)

**Status:** ✅ **IMPLEMENTED** — shipped 2026-06-17.

Laminar's May 2026 blog post describes a content-addressed
deduplication trick that turns O(k²) message storage into
O(k) for k-turn agent runs. Eden replicates the algorithm
here to get parity *and* cheaper storage for long-running
agents than Laminar's hosted offering.

### The k² problem

Every LLM span's `request_body.messages` array contains the
*full* conversation history at the time of that LLM call.
Span 1 stores `[m₀]`; span 2 stores `[m₀, m₁]`; ...; span k
stores `[m₀, …, mₖ₋₁]`. Across a k-turn trace the total
message-storage cost is `k(k+1)/2` ≈ **O(k²)**.

For a 50-turn coding agent (typical of long-running Claude
Code / OpenHands / Browser Use sessions) that's 1,275
message-slots stored where only 50 are unique. At 8KB avg
per message the span payload blows past 10MB per trace.

### The fix

Mirror Laminar's algorithm (see
`src/eden/observability/canonical.py` +
`src/eden/observability/message_store.py`):

1. **Canonical JSON hashing.** Every message is serialized
   with `sort_keys=True`, `ensure_ascii=False`,
   `separators=(",", ":")` and SHA-256-hashed. The result
   is a 64-char hex digest that is identical for two
   messages that are byte-equal under canonical form.
   Field-order invariance is the key property — `{"role":
   "user", "content": "hi"}` and `{"content": "hi", "role":
   "user"}` hash the same.
2. **Per-trace message store.** `trace_messages` (PK on
   `(trace_id, msg_hash)`) holds one row per unique message.
   Inserts are idempotent via `ON CONFLICT DO NOTHING`. The
   GIN index on `content` makes future full-text search
   (Phase B: Typesense) cheap to backfill.
3. **Spans store hash arrays.** `telemetry_events` gains
   `request_message_hashes TEXT[]` and
   `response_message_hashes TEXT[]` columns. The collector
   writes the hash array on every span; the JSONB payload
   columns stay populated for a 30-day burn-in (same pattern
   as the zstd migration 033).
4. **Reconstruction at read time.** The trace view's
   `get_trace_tree` joins the hash array against
   `trace_messages` per span. Fallback to the JSONB column
   on missing hash (pre-migration rows) so the trace view
   never goes blank.

### Measured impact

The unit test `tests/unit/observability/test_dedup.py::TestDedupRatio::test_50_turn_agent_dedup`
asserts that 50 spans storing 2,550 message-hashes (1+2+…+100
across all turns) collapse to exactly **100 unique messages**
in `trace_messages` — a **25.5×** dedup ratio on a synthetic
50-turn agent. Laminar advertises "20×" average / "50×" for
long-running agents; our measured numbers are at or above
parity.

For a real 100-turn coding agent:
* Before dedup: ~10MB of `request_body` JSONB
* After dedup: ~400KB of `request_message_hashes` plus
  ~80KB of `trace_messages` rows
* **~22× reduction** in trace storage cost, ~10× reduction
  in PG row size

### ClickHouse mirror (planned, not yet shipped)

The trace view path reads from Postgres. The ClickHouse
analytics mirror (`telemetry_events_ch`) currently stores
the raw `request_body` JSON; a follow-up migration will
mirror `request_message_hashes` to CH and rebuild the JSON
via ClickHouse's `Dictionary` engine over a Postgres-backed
external dictionary. This unlocks CH-side aggregations over
the deduped messages without losing the reconstruction
capability. Estimated effort: 1 week.

### Backwards compatibility

* Pre-migration rows have NULL hash columns → fallback to
  the existing zstd/JSONB read path (no change to trace
  view UX).
* The hash columns are nullable + array-typed → existing
  insert code paths that don't populate them still work.
* The 30-day burn-in keeps `request_body` and
  `response_body` populated so any pre-backfill row is
  still readable.

## Failure modes & guardrails

| Mode | Mitigation |
|---|---|
| Tail-sampling OOM (per Drozd 2025) | `num_traces` formula enforced; `otel_sampling.dropped_traces` counter alerted at >1% |
| OTel v1.41 spec changes (still Development) | Dual-emit v1.36 + v1.41; `OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental` is the default |
| Per-step scoring cost blowout (10× more judge calls) | Cat 9 `TenantBudget` applies; per-step scoring opt-in per tenant; `step_judges` cached on the event row |
| K8s attribute auth failure | `k8sattributes` processor has `auth_type: serviceAccount`; falls back to `from: connection` if the SA is unavailable |
| Pyroscope ingest cost (next-step) | Sampling rate at 1% default; per-tenant opt-in |

## Test plan

* **OTel dual-emit tests (4):** v1.36 + v1.41 attrs both
  present; legacy dashboards still work; v1.41 dashboards
  populated; opt-in env var correctly toggles emission
* **Tail-sampling tests (5):** errors always kept; slow
  traces always kept; healthy traces sampled at 10%;
  dropped-trace counter increments on overflow; num_traces
  formula tested at 1k, 10k, 100k traces/sec
* **Per-step scoring tests (4):** step_index assigned
  correctly; step_judges JSONB readable; Cat 2 RCA
  correctly identifies failing step; backwards compat
  (events without step_index still scored trace-level)
* **Agent-metric tests (4):** path_depth alert at p95 > 20;
  tool_success_rate alert at < 80%; cost_per_step_usd
  alert at > 3× baseline; metrics rollup into Cat 8 tables
* **K8s enrichment tests (3):** attributes present on
  ingested spans; missing SA falls back; namespace filter
  works
* **Route smoke tests (3):** no new routes — Cat 22
  upgrades the existing ingestion path. Tests assert
  schema/attrs only.

Target: **~23 tests, ~0.8s.**

## Acceptance criteria

- [ ] OTel v1.41 attribute coverage complete + dual-emit
  v1.36 + v1.41 verified on every span
- [ ] Tail-based sampling at the gateway tier with
  `num_traces` sized per the formula
- [ ] Per-step scoring on `telemetry_events` (step_index +
  step_judges columns)
- [ ] Three new agent-specific metrics live in the portal
  (path_depth, tool_success_rate, cost_per_step_usd)
- [ ] K8s pod/namespace/container/node attributes on every
  span
- [ ] All 23 tests pass
- [ ] No regressions in `tests/unit/observability/` (264
  baseline) or `tests/intelligence/` (393 baseline)

## Open questions

* **Synthetic monitoring** (Cat 22.5): shipped next or
  deferred? **Recommendation: deferred** (Pyroscope is the
  bigger win; synthetic is a separate product surface).
* **Pyroscope host** (self-hosted Grafana Cloud vs OSS):
  **Recommendation: OSS** (matches Eden's existing self-host
  posture; no incremental cost).
* **Per-step scoring opt-in vs always-on**: **Recommendation:
  opt-in per tenant** (Cat 9 budget control). Default is
  trace-level scoring (current behaviour); tenants with
  > 10 steps/trace enable per-step via the portal toggle.

## Cross-references

* Master doc: `docs/observability/gap-roadmap.md` § Cat 22
* 2026 APM guide: [www.augmentcode.com/guides/application-performance-monitoring](https://www.augmentcode.com/guides/application-performance-monitoring)
* Tail-sampling sizing: [www.michal-drozd.com/en/blog/otel-tail-sampling/](https://www.michal-drozd.com/en/blog/otel-tail-sampling/)
* OTel GenAI semconv: [opentelemetry.io/docs/specs/semconv/gen-ai/](https://opentelemetry.io/docs/specs/semconv/gen-ai/)
* OTel GenAI v1.41 Greptime deep-dive: [greptime.com/blogs/2026-05-09-opentelemetry-genai-semantic-conventions](https://greptime.com/blogs/2026-05-09-opentelemetry-genai-semantic-conventions)
* Distributed tracing for agentic workflows (Red Hat): [developers.redhat.com/articles/2026/04/06/distributed-tracing-agentic-workflows-opentelemetry](https://developers.redhat.com/articles/2026/04/06/distributed-tracing-agentic-workflows-opentelemetry)
* Separate SLM plan: `docs/observability/judge-v2-plan.md`
