# Eden — User Observability Platform & Knowledge Base Architecture

> **Date:** May 29, 2026
> **Purpose:** Define the architecture for Eden's user-facing observability platform — a system that lets developers and companies see exactly how their agents perform inside Eden-generated environments and in production, automatically turns those observations into structured datasets and rerunnable benchmarks, feeds everything into a dual-layer knowledge base, and uses that intelligence to make every subsequent environment better.

---

## Table of Contents

1. [Strategic Thesis](#1-strategic-thesis)
2. [What Eden Observability Gives Users](#2-what-eden-observability-gives-users)
3. [The Three Data Realms](#3-the-three-data-realms)
4. [Architecture Overview](#4-architecture-overview)
5. [The Unified Trace Model](#5-the-unified-trace-model)
6. [Environment Observability](#6-environment-observability)
7. [Production Observability](#7-production-observability)
8. [Comparative Analysis & Disparity Detection](#8-comparative-analysis--disparity-detection)
9. [Dataset Generation Engine](#9-dataset-generation-engine)
10. [Benchmark Engine](#10-benchmark-engine)
11. [Insights Engine](#11-insights-engine)
12. [Visualization Layer](#12-visualization-layer)
13. [The Dual-Layer Knowledge Base](#13-the-dual-layer-knowledge-base)
14. [Feedback Flywheel](#14-feedback-flywheel)
15. [Zero-Friction Integration](#15-zero-friction-integration)
16. [Multi-Tenancy & Data Isolation](#16-multi-tenancy--data-isolation)
17. [Implementation Roadmap](#17-implementation-roadmap)
18. [Appendix A: Data Models](#appendix-a-data-models)
19. [Appendix B: API Specification](#appendix-b-api-specification)

---

## 1. Strategic Thesis

Every team building AI agents has the same problem: **they cannot see what their agents actually do.**

In production, agents are black boxes. In test environments, evaluation is ad-hoc and non-reproducible. When an agent fails, teams guess at the cause. When it succeeds, they don't know why. There is no systematic way to compare "how my agent performs in test" versus "how it performs in production," and no mechanism to close that gap.

Eden's observability platform solves this by giving every Eden customer:

1. **Complete visibility** into agent execution — inside Eden environments and in production — via a single, unified trace model.
2. **Automatic dataset generation** from every failure, anomaly, and disparity, turning live execution data into structured, versioned evaluation datasets.
3. **Rerunnable benchmarks** that can be executed on-demand or in CI, comparing agent versions, environment versions, or prod-vs-test disparities.
4. **Automated insights** that detect failure patterns, performance regressions, environment-prod gaps, and emergent behaviors without human analysis.
5. **A knowledge base that learns** — global best practices from all Eden users plus a tenant-specific layer that captures their code patterns, agent configs, failure taxonomies, and production realities.
6. **A feedback loop** where everything observed becomes intelligence that improves the next environment Eden generates for them.

The result: **the more a user runs agents through Eden, the better Eden's environments become for them specifically.**

---

## 2. What Eden Observability Gives Users

### 2.1 For Developers

| Capability | What It Does |
|-----------|-------------|
| **Trace Viewer** | Step-by-step replay of any agent run — tool calls, reasoning chains, environment interactions, state mutations, rewards, errors. Like Chrome DevTools for agents. |
| **Performance Dashboard** | Latency distributions, token usage, success/failure rates, tool-call accuracy, hallucination rates, per-environment breakdowns. |
| **Regression Detection** | Automatic alerts when a new agent version performs worse than baseline on any metric. |
| **Dataset Exporter** | One-click export of any filtered trace set into HuggingFace Datasets, JSONL, CSV, or OpenAI eval format. |
| **Benchmark Runner** | Define a benchmark once, run it against any agent version or environment version, see comparative results. |

### 2.2 For Teams / Companies

| Capability | What It Does |
|-----------|-------------|
| **Org-Wide Analytics** | Aggregate metrics across all agents, environments, and developers. Identify which environments catch the most prod failures. |
| **Environment-Production Gap Report** | Quantified comparison showing exactly which behaviors diverge between test and production, with severity scoring. |
| **Custom Insight Rules** | Define company-specific detectors (e.g., "flag any agent that invokes the refund tool twice in one session"). |
| **Knowledge Base Portal** | Searchable repository of patterns, failure modes, environment design decisions, and learnings specific to their domain. |
| **CI/CD Integration** | Block deploys if benchmark regressions exceed thresholds. Auto-generate test cases from production failures. |

### 2.3 For Eden

All of the above data — fully anonymized and aggregated across tenants where appropriate — feeds into Eden's own intelligence:

- **Global failure taxonomy** grows richer with every new agent domain observed.
- **Environment design patterns** improve as Eden sees which structures prevent which failure modes.
- **Benchmark coverage** expands as edge cases discovered in production are automatically promoted into the global test suite.
- **Reward hacking detection** becomes more robust as Eden correlates environment behavior with production outcomes across thousands of agents.

---

## 3. The Three Data Realms

Eden observability unifies three distinct but related sources of execution data:

### 3.1 Environment Realm
Data generated when a user's agent runs inside an **Eden-generated environment**.

- Agent-environment interaction traces (observations, actions, rewards, terminations)
- Environment state transitions and invariants
- Benchmark results (success/failure, regression detection)
- Reward hacking signals, divergence metrics, coverage scores
- Metadata: environment version, agent version, framework, task description

### 3.2 Production Realm
Data generated when a user's agent runs in **real production** — completely outside Eden's infrastructure.

- LLM API call traces (prompts, completions, tool calls, latencies, token usage)
- Agent-level traces (multi-step reasoning, memory access, external tool usage)
- Business outcome metrics (user satisfaction, task completion, error rates)
- Failure events: crashes, hallucinations, tool misuse, loops, timeouts

### 3.3 Comparative Realm
Data generated by **comparing Environment vs Production** execution on semantically similar tasks.

- Behavior disparity scores (did the agent take the same actions?)
- Performance gap metrics (latency, accuracy, cost per task)
- Coverage gap analysis (which prod scenarios are never tested in env?)
- Drift detection over time (is the gap widening?)

The Comparative Realm is where the most valuable insights live. It answers: **"Is my test environment actually representative of production?"**

---

## 4. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           USER AGENTS                                        │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐                   │
│  │ Agent in Eden│    │ Agent in Prod│    │  CI Runner   │                   │
│  │ Environment  │    │  (Real World)│    │              │                   │
│  └──────┬───────┘    └──────┬───────┘    └──────┬───────┘                   │
└─────────┼──────────────────┼──────────────────┼─────────────────────────────┘
          │                  │                  │
          ▼                  ▼                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                     EDEN OBSERVABILITY PLATFORM                              │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                    INGESTION LAYER                                   │    │
│  │  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────────────────┐    │    │
│  │  │ SDK     │  │OTel     │  │REST     │  │ WebSocket (Realtime)│    │    │
│  │  │ Auto-   │  │Exporter│  │Batch    │  │                     │    │    │
│  │  │ Instr.  │  │        │  │API      │  │                     │    │    │
│  │  └────┬────┘  └────┬────┘  └────┬────┘  └──────────┬──────────┘    │    │
│  │       └────────────┴────────────┴──────────────────┘              │    │
│  └──────────────────────────────┬─────────────────────────────────────┘    │
│                                 ▼                                           │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │              UNIFIED TRACE STORE (ClickHouse + S3)                  │    │
│  │                                                                     │    │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐            │    │
│  │  │ Environment  │  │ Production   │  │ Comparative  │            │    │
│  │  │ Traces       │  │ Traces       │  │ Metrics      │            │    │
│  │  └──────────────┘  └──────────────┘  └──────────────┘            │    │
│  └──────────────────────────────┬─────────────────────────────────────┘    │
│                                 ▼                                           │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │              PROCESSING LAYER                                      │    │
│  │                                                                     │    │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐            │    │
│  │  │ Dataset Gen  │  │ Insight      │  │ Benchmark    │            │    │
│  │  │ Engine       │  │ Engine       │  │ Engine       │            │    │
│  │  └──────────────┘  └──────────────┘  └──────────────┘            │    │
│  └──────────────────────────────┬─────────────────────────────────────┘    │
│                                 ▼                                           │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │              KNOWLEDGE BASE LAYER                                  │    │
│  │                                                                     │    │
│  │  ┌────────────────────────┐    ┌────────────────────────┐          │    │
│  │  │   GLOBAL KB (Eden)     │    │  TENANT KB (Per-Org)   │          │    │
│  │  │  ├ Best Practices      │    │  ├ Code Patterns       │          │    │
│  │  │  ├ Failure Taxonomy     │    │  ├ Agent Configs       │          │    │
│  │  │  ├ Environment Patterns│    │  ├ Prod Traces         │          │    │
│  │  │  ├ Benchmark Corpus     │    │  ├ Custom Detectors   │          │    │
│  │  │  └ Cross-Tenant Learn   │    │  └ Domain Knowledge   │          │    │
│  │  └────────────────────────┘    └────────────────────────┘          │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                 ▼                                           │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │              PRESENTATION LAYER                                    │    │
│  │                                                                     │    │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐            │    │
│  │  │ Trace Viewer │  │ Dashboards   │  │ KB Portal    │            │    │
│  │  │              │  │              │  │              │            │    │
│  │  └──────────────┘  └──────────────┘  └──────────────┘            │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
                                 ▼
                    ┌────────────────────┐
                    │  EDEN PIPELINE     │
                    │  (Environment Gen) │
                    └────────────────────┘
```

---

## 5. The Unified Trace Model

All observability data — environment, production, and comparative — flows through a single schema. This eliminates data silos and enables cross-realm queries.

### 5.1 Core Entity: `Trace`

```protobuf
message Trace {
  // Identity
  string trace_id = 1;           // UUID v4
  string tenant_id = 2;          // Organization identifier
  string project_id = 3;         // Project within tenant

  // Realm classification
  enum Realm {
    ENVIRONMENT = 0;
    PRODUCTION = 1;
    COMPARATIVE = 2;
  }
  Realm realm = 4;

  // What ran
  string agent_id = 5;           // User's agent identifier
  string agent_version = 6;      // Semantic version
  string environment_id = 7;     // Eden environment ID (if realm=ENVIRONMENT)
  string environment_version = 8;

  // What happened
  int64 started_at = 9;          // Unix nanoseconds
  int64 ended_at = 10;
  repeated Span spans = 11;      // Hierarchical spans

  // Outcome
  enum Outcome {
    SUCCESS = 0;
    FAILURE = 1;
    PARTIAL = 2;
    TIMEOUT = 3;
    CRASH = 4;
  }
  Outcome outcome = 12;
  map<string, float> metrics = 13;  // Latency, tokens, cost, accuracy, etc.

  // Enrichment
  repeated string tags = 14;
  map<string, string> metadata = 15;
  repeated Insight insights = 16;   // Auto-generated insights (see §11)
}
```

### 5.2 Span Model

```protobuf
message Span {
  string span_id = 1;
  string parent_id = 2;
  string name = 3;                 // e.g., "llm.completion", "tool.invoke", "env.step"
  int64 started_at = 4;
  int64 ended_at = 5;

  // Semantic payload (oneof)
  oneof payload {
    LLMCompletion llm = 10;
    ToolInvocation tool = 11;
    EnvironmentStep env_step = 12;
    ReasoningStep reasoning = 13;
    UserInteraction user = 14;
  }

  map<string, float> metrics = 20;
  map<string, string> attributes = 21;
  repeated Event events = 22;     // Log-like events within span
}
```

### 5.3 Semantic Payloads

**LLM Completion Span:**
```protobuf
message LLMCompletion {
  string model = 1;
  string provider = 2;              // openai, anthropic, local
  repeated Message messages = 3;    // Full prompt (can be pii-redacted)
  string completion = 4;
  int32 prompt_tokens = 5;
  int32 completion_tokens = 6;
  float latency_ms = 7;
  float cost_usd = 8;
  repeated ToolCall tool_calls = 9;
}
```

**Tool Invocation Span:**
```protobuf
message ToolInvocation {
  string tool_name = 1;
  string arguments_json = 2;
  string result_json = 3;
  bool success = 4;
  string error_message = 5;
}
```

**Environment Step Span:**
```protobuf
message EnvironmentStep {
  int32 step_number = 1;
  bytes observation = 2;            // Base64-encoded or JSON
  bytes action = 3;
  float reward = 4;
  bool terminated = 5;
  bool truncated = 6;
  bytes state_snapshot = 7;         // Full env state (optional)
  repeated InvariantCheck invariants = 8;
}
```

---

## 6. Environment Observability

When a user's agent runs inside an Eden-generated environment, Eden captures everything automatically. No instrumentation required from the user.

### 6.1 Auto-Capture Scope

| Category | Captured Data | Storage |
|---------|------------|---------|
| **Interactions** | Every observation → action → reward → state transition | ClickHouse (hot), S3 (cold) |
| **Invariants** | All assertion results, timing, failure context | ClickHouse |
| **Coverage** | Code coverage of env implementation, state-space coverage | PostgreSQL |
| **Benchmarks** | Success/failure per test case, regression flags, metric distributions | ClickHouse |
| **Agent Internals** | If user opts in: LLM calls, reasoning chains, tool usage inside env | ClickHouse |
| **Reward Signals** | All reward values, shaping analysis, hacking indicators | ClickHouse |

### 6.2 Real-Time Streaming

Environment traces stream to the user's dashboard in real time via WebSocket:

```javascript
// Browser client connects to trace stream
const ws = new WebSocket(
  `wss://observability.eden.dev/v1/traces/stream?project_id=${PROJECT_ID}`
);

ws.onmessage = (event) => {
  const traceUpdate = JSON.parse(event.data);
  // { trace_id, span_id, span_type, payload, timestamp }
  renderTraceStep(traceUpdate);
};
```

### 6.3 Environment-Specific Insights (Auto-Generated)

After every environment run, the Insights Engine produces:

1. **Success Analysis** — Which invariants passed/failed? What was the coverage score?
2. **Behavioral Pattern** — Did the agent explore or exploit? Did it get stuck in loops?
3. **Failure Root Cause** — If failed, which step diverged from expected? Was it a reasoning error, tool misuse, or environment bug?
4. **Comparison to Baseline** — How does this run compare to the last N runs of this agent in this environment?
5. **Recommended Dataset Entries** — Specific traces the engine recommends promoting to a regression dataset.

---

## 7. Production Observability

For production agents, Eden provides an SDK that instruments the user's agent code with minimal changes.

### 7.1 Auto-Instrumentation SDK

```python
import eden

# One line — traces all LLM calls, tool invocations, and agent steps
eden.instrument_agent(agent=my_agent, project_id="proj_abc123")

# Or decorator for function-based agents
@eden.trace_agent(project_id="proj_abc123")
async def my_agent(user_query: str) -> str:
    # All LLM calls, tool usage, and reasoning captured automatically
    return await run_agent(user_query)
```

**Supported frameworks (auto-instrumented):**
- OpenAI Agents SDK / OpenAI Python client
- Anthropic Claude API
- LangChain / LangGraph
- LiteLLM (universal proxy)
- Custom agents via manual span API

### 7.2 Manual Span API (for custom frameworks)

```python
import eden

tracer = eden.get_tracer(project_id="proj_abc123")

with tracer.span("planning") as span:
    plan = await generate_plan(query)
    span.set_attribute("plan.steps", len(plan.steps))
    span.set_metric("latency_ms", plan.latency_ms)

with tracer.span("tool.execute") as span:
    result = await execute_tool(tool_name, args)
    span.set_payload(eden.ToolInvocation(
        tool_name=tool_name,
        arguments=args,
        result=result,
        success=result.ok
    ))
```

### 7.3 OpenTelemetry Compatibility

The SDK exposes an OTLP exporter so existing observability infrastructure (Datadog, Honeycomb, Grafana Tempo) can receive Eden traces alongside infrastructure metrics:

```python
eden.configure(
    project_id="proj_abc123",
    exporters=[
        eden.EdenExporter(),           # Send to Eden platform
        eden.OTLPExporter(endpoint="https://otel.honeycomb.io"),
    ]
)
```

### 7.4 Production Trace Enrichment

Production traces are enriched with:

- **User context** (anonymized): user segment, session history, satisfaction signals
- **Business outcome**: Was the task completed to the user's satisfaction? (Requires explicit feedback or proxy signal)
- **Cost attribution**: Per-trace cost breakdown by model, tool, and step
- **Error classification**: Auto-categorized into taxonomy (hallucination, tool misuse, loop, timeout, refusal, etc.)

---

## 8. Comparative Analysis & Disparity Detection

The most powerful feature of Eden's observability is **automatic comparison** between how an agent behaves in an Eden environment versus how it behaves in production.

### 8.1 Semantic Task Matching

Eden matches environment runs with production traces that represent the **same semantic task**:

```python
# Eden automatically indexes traces by task embedding
# When a production trace arrives, it finds the most similar environment benchmark
matched_env_run = eden.find_matching_environment_run(
    production_trace=prod_trace,
    similarity_threshold=0.85
)
```

Matching is based on:
- Task description embedding (cosine similarity)
- Agent version
- Tool set overlap
- Input/output schema similarity

### 8.2 Disparity Dimensions

For each matched pair, Eden computes disparity scores across six dimensions:

| Dimension | Metric | Interpretation |
|-----------|--------|---------------|
| **Action Divergence** | Jaccard distance over action sequences | Did the agent take different steps? |
| **Outcome Divergence** | Binary mismatch | Success in env but failure in prod (or vice versa) |
| **Latency Gap** | Ratio of env latency to prod latency | Is the env unrealistically fast/slow? |
| **Tool Usage Gap** | Which tools were used in env but not prod | Does the env exercise the right tool set? |
| **Error Pattern Gap** | Failure taxonomy comparison | Are the same failure modes present? |
| **Coverage Gap** | % of prod scenarios represented in env test suite | What's missing from the environment? |

### 8.3 Disparity Report

Generated automatically per project, per week:

```json
{
  "report_id": "disp_2026w22",
  "project_id": "proj_abc123",
  "period": "2026-05-22 to 2026-05-29",
  "matched_pairs": 147,
  "summary": {
    "action_divergence": { "mean": 0.34, "p95": 0.78 },
    "outcome_divergence": { "mismatch_rate": 0.12 },
    "latency_gap": { "mean_ratio": 1.4, "env_slower": true },
    "coverage_gap": { "prod_scenarios": 89, "env_scenarios": 62, "gap": 0.30 }
  },
  "top_disparities": [
    {
      "dimension": "coverage_gap",
      "severity": "high",
      "missing_scenarios": [
        "user interrupts mid-task and changes request",
        "external API returns 503 with retry-after header",
        "concurrent user sessions race on shared resource"
      ],
      "recommended_action": "Generate environment variants covering these 3 scenarios"
    }
  ],
  "environment_recommendation": {
    "current_env_id": "env_xyz789",
    "recommended_changes": [
      "Add adversarial user behavior injection",
      "Add flaky external API simulation",
      "Add multi-session concurrency tests"
    ],
    "estimated_improvement": "Coverage gap reduction from 30% to 8%"
  }
}
```

This report is surfaced in the dashboard and automatically fed to the environment generation pipeline as context.

---

## 9. Dataset Generation Engine

Every trace in Eden's observability platform is a potential dataset entry. The Dataset Generation Engine automatically promotes high-value traces into structured, versioned datasets.

### 9.1 Auto-Promotion Rules

Users configure rules that define which traces become dataset entries:

```yaml
# .eden/dataset_rules.yaml
rules:
  - name: "production_failures"
    filter:
      realm: production
      outcome: failure
      confidence: "> 0.9"        # Auto-classified failure confidence
    extract:
      input: "{{trace.spans[0].payload.messages}}"
      expected: "{{trace.spans[-1].payload.result}}"
      actual: "{{trace.spans[-1].payload.error_message}}"
      failure_category: "{{trace.insights[0].category}}"
    dataset: "prod_failures_v1"
    auto_promote: true

  - name: "env_prod_disparities"
    filter:
      realm: comparative
      disparity_score: "> 0.6"
    extract:
      env_trace_id: "{{trace.environment_trace_id}}"
      prod_trace_id: "{{trace.production_trace_id}}"
      divergence_type: "{{trace.disparity.dimension}}"
    dataset: "disparity_cases_v1"
    auto_promote: true

  - name: "edge_cases"
    filter:
      realm: environment
      tags: contains("rare_state")
    extract:
      state: "{{trace.spans[?env_step].payload.state_snapshot}}"
      action: "{{trace.spans[?env_step].payload.action}}"
    dataset: "edge_cases_v1"
    auto_promote: false      # Require manual review
```

### 9.2 Dataset Types

| Dataset Type | Source | Use Case |
|-------------|--------|---------|
| **Regression Suite** | Environment failures + prod failures | CI validation — did the fix work? |
| **Edge Case Collection** | Rare states, boundary conditions | Stress testing — does the agent handle extremes? |
| **Adversarial Suite** | Hallucinations, jailbreaks, tool misuse | Safety testing — robustness verification |
| **Performance Benchmark** | High-latency traces, token-heavy traces | Efficiency optimization |
| **Disparity Collection** | Env-prod mismatches | Environment fidelity improvement |
| **Golden Path** | Successful production traces | Few-shot examples, fine-tuning data |

### 9.3 Dataset Versioning & Lineage

Every dataset entry knows its provenance:

```json
{
  "dataset_id": "ds_prod_failures_v1",
  "version": "2026.05.29-1423",
  "entry": {
    "id": "entry_abc",
    "source_trace_id": "trace_xyz789",
    "source_realm": "production",
    "extracted_at": "2026-05-29T14:23:00Z",
    "extract_rule": "production_failures",
    "input": { },
    "expected": { },
    "metadata": { }
  },
  "lineage": [
    "trace_xyz789 (production, 2026-05-28)",
    "→ extracted by rule 'production_failures'",
    "→ added to dataset 'prod_failures_v1'",
    "→ used in benchmark 'regression_suite_week_22'"
  ]
}
```

### 9.4 Export Formats

```bash
# CLI export
eden datasets export ds_prod_failures_v1 \
  --format huggingface \
  --split train:test=80:20 \
  --output ./datasets/prod_failures

# Supported formats: jsonl, csv, openai-eval, huggingface, langfuse
```

---

## 10. Benchmark Engine

Datasets are static. Benchmarks are **live, rerunnable, and comparative**.

### 10.1 Benchmark Definition

```yaml
# .eden/benchmarks.yaml
benchmarks:
  - name: "weekly_regression"
    description: "Run all regression datasets weekly"
    schedule: "0 0 * * 0"  # Weekly
    datasets:
      - ds_prod_failures_v1
      - ds_disparity_cases_v1
    agent_versions:
      - latest
      - baseline          # Compare to last deployed version
    environments:
      - latest            # Latest Eden env for this project
    metrics:
      - success_rate
      - mean_latency_ms
      - token_efficiency
      - tool_accuracy
    thresholds:
      success_rate:
        min: 0.95
        regression_delta: -0.05  # Alert if drops > 5%
```

### 10.2 Benchmark Execution

Benchmarks run on Eden's infrastructure (not the user's) so they don't consume user compute:

```bash
# Trigger manually
eden benchmark run weekly_regression

# Or via API
POST /v1/benchmarks/{benchmark_id}/run
{
  "agent_version": "1.4.2",
  "environment_version": "latest",
  "notify_on_completion": ["slack://#agent-alerts"]
}
```

### 10.3 Comparative Benchmarks

The most powerful benchmark type compares **same agent, different environments** or **same environment, different agents**:

```yaml
benchmarks:
  - name: "env_fidelity_check"
    type: comparative
    compare:
      - realm: environment
        environment_version: "2026.05.20"
      - realm: environment
        environment_version: "2026.05.27"
    metric: action_divergence
    alert_if: "divergence > 0.3"
```

This answers: **"Did my new environment version change agent behavior in unexpected ways?"**

---

## 11. Insights Engine

The Insights Engine automatically analyzes all traces and generates actionable intelligence without human review.

### 11.1 Detectors

| Detector | What It Finds | Data Source |
|----------|-------------|-------------|
| **Failure Pattern Detector** | Recurring failure sequences, e.g., "agent always fails after tool X returns empty" | All realms |
| **Performance Anomaly Detector** | Latency spikes, token usage explosions, cost outliers | Production + Environment |
| **Regression Detector** | Statistically significant metric degradation across versions | Environment benchmarks |
| **Environment-Prod Gap Detector** | Behaviors present in production but never observed in environment | Comparative realm |
| **Reward Hacking Detector** | Agents exploiting environment structure rather than solving the task | Environment |
| **Novel Behavior Detector** | Agent actions never seen before — potential emergent capability or bug | All realms |
| **Custom Detectors** | User-defined rules (regex on traces, threshold on metrics, span sequences) | All realms |

### 11.2 Insight Output

```json
{
  "insight_id": "ins_20260529_001",
  "detector": "failure_pattern",
  "severity": "high",
  "confidence": 0.94,
  "summary": "Agent fails 73% of the time when 'search' tool returns > 10 results",
  "affected_traces": ["trace_1", "trace_2", "trace_127"],
  "pattern": {
    "sequence": ["tool.search", "llm.completion", "outcome.failure"],
    "precondition": "search.result_count > 10",
    "postcondition": "outcome == failure"
  },
  "recommended_action": "Add environment variant with large search result sets",
  "auto_created_dataset": "ds_search_overflow_v1",
  "kb_entries_created": ["kb_fail_search_overload_001"]
}
```

### 11.3 Custom Detectors

Users define company-specific insight rules:

```yaml
# .eden/detectors.yaml
detectors:
  - name: "duplicate_refund_risk"
    description: "Flag agents that invoke refund tool twice in one session"
    trigger:
      span_sequence:
        - span_type: tool.invoke
          attributes.tool_name: "refund"
        - span_type: tool.invoke
          attributes.tool_name: "refund"
      within_seconds: 300
    severity: critical
    auto_create_dataset: true

  - name: "high_support_escalation"
    trigger:
      metric_threshold:
        metric: "escalation_rate"
        window: "1h"
        threshold: "> 0.15"
    severity: warning
```

---

## 12. Visualization Layer

### 12.1 Trace Viewer

An interactive, step-by-step replay of any agent execution:

- **Timeline view**: All spans laid out horizontally with latency proportional to width
- **Tree view**: Hierarchical parent-child relationship of spans
- **Environment view**: State transitions visualized as a graph (for env realm)
- **Diff view**: Side-by-side comparison of two traces (e.g., env vs prod)
- **Search & filter**: Full-text search across all span attributes, filter by outcome, tool, model, etc.

### 12.2 Dashboards

**Project Dashboard:**
- Success rate over time (env vs prod)
- Latency distributions by model and tool
- Top failure categories (pie chart + drill-down)
- Disparity score trend (is the env-prod gap closing?)
- Dataset growth (new entries per day by source)

**Environment Dashboard:**
- Coverage heatmap (which states/transitions are exercised)
- Invariant pass/fail matrix
- Reward hacking risk score
- Benchmark history with regression flags

**Production Dashboard:**
- Cost per task over time
- Model usage breakdown
- Error rate by tool and by failure category
- User satisfaction correlation with agent metrics

### 12.3 Knowledge Base Portal

A searchable, AI-assisted interface for exploring the dual-layer knowledge base:

- **Natural language search**: "Why does my agent fail on multi-turn conversations?"
- **Pattern explorer**: Browse global best practices and tenant-specific patterns
- **Failure taxonomy**: Hierarchical view of all failure modes, with frequency and affected agents
- **Environment design decisions**: For each generated environment, see which KB entries influenced its design
- **Contribution view**: See how your team's data has contributed to global best practices (anonymized)

---

## 13. The Dual-Layer Knowledge Base

The knowledge base is the intelligence layer that turns observability data into better environments. It has two tiers:

### 13.1 Global Knowledge Base (Eden-Owned)

Knowledge shared across all Eden tenants. Constantly growing as Eden observes more agents in more domains.

| Category | Contents | Source |
|----------|----------|--------|
| **Best Practices** | Environment design patterns, agent interaction patterns, testing strategies | Cross-tenant aggregation + expert curation |
| **Failure Taxonomy** | Hierarchical classification of all observed failure modes | Auto-generated from Insights Engine + manual review |
| **Environment Patterns** | Proven environment structures for specific agent types/tasks | Successful environment versions across tenants |
| **Benchmark Corpus** | Reference benchmarks for standard agent capabilities | Curated from global dataset generation |
| **Disparity Signatures** | Common environment-prod gaps and their resolutions | Comparative analysis across tenants |

**Access:** Read-only for tenants. Eden's pipeline reads this during environment generation.

### 13.2 Tenant Knowledge Base (Per-Organization)

Knowledge specific to one company or project.

| Category | Contents | Source |
|----------|----------|--------|
| **Code Patterns** | Recurring code structures in their agents | Static analysis + trace observation |
| **Agent Configs** | Model choices, tool sets, prompt templates, hyperparameters | User configuration + observed effective configs |
| **Production Traces** | Embeddings and summaries of all production runs | Observability ingestion |
| **Custom Detectors** | Company-specific insight rules | User-defined |
| **Domain Knowledge** | Business-specific concepts, entities, constraints | User-uploaded + inferred from traces |
| **Failure Modes** | Failure patterns specific to their domain | Insights Engine on their traces only |
| **Environment History** | All generated environments, their performance, and evolution | Eden environment generation logs |

**Access:** Full read-write for tenant members. Not accessible to other tenants or to Eden in raw form (see §16 on privacy).

### 13.3 KB Query Interface

Both layers are queryable via vector search + structured filters:

```python
# Python SDK
results = eden.kb.query(
    "How do I prevent my agent from getting stuck in loops?",
    layers=["global", "tenant"],
    filters={"category": "best_practice", "applicable_to": "customer_support_agent"},
    top_k=10
)

# Returns ranked KB entries with provenance and confidence
```

---

## 14. Feedback Flywheel

The observability platform exists to create a virtuous cycle:

```
┌─────────────────────────────────────────────────────────────────────┐
│                         FEEDBACK FLYWHEEL                          │
│                                                                     │
│   ┌──────────────┐                                                 │
│   │ 1. AGENT RUNS│  Agent executes in Eden env OR in production    │
│   └──────┬───────┘                                                 │
│          ▼                                                          │
│   ┌──────────────┐                                                 │
│   │ 2. CAPTURE   │  Full traces ingested into Unified Trace Store │
│   └──────┬───────┘                                                 │
│          ▼                                                          │
│   ┌──────────────┐                                                 │
│   │ 3. ANALYZE   │  Insights Engine detects patterns, anomalies   │
│   └──────┬───────┘                                                 │
│          ▼                                                          │
│   ┌─────────────────────────────────────────────┐                  │
│   │ 4. GENERATE DATASETS & BENCHMARKS           │                  │
│   │    • Auto-create regression datasets        │                  │
│   │    • Update benchmarks with new edge cases  │                  │
│   │    • Build disparity collections            │                  │
│   └──────┬──────────────────────────────────────┘                  │
│          ▼                                                          │
│   ┌─────────────────────────────────────────────┐                  │
│   │ 5. UPDATE KNOWLEDGE BASE                    │                  │
│   │    • Global: new failure taxonomy entries   │                  │
│   │    • Tenant: new code patterns, detectors │                  │
│   └──────┬──────────────────────────────────────┘                  │
│          ▼                                                          │
│   ┌─────────────────────────────────────────────┐                  │
│   │ 6. IMPROVE ENVIRONMENTS                     │                  │
│   │    • Archivist retrieves relevant KB entries│                  │
│   │    • Pipeline includes disparity reports    │                  │
│   │    • Next env generation closes the gaps    │                  │
│   └──────┬──────────────────────────────────────┘                  │
│          ▼                                                          │
│   ┌──────────────┐                                                 │
│   │ 7. BETTER ENV│  New environment version with fixes            │
│   └──────┬───────┘                                                 │
│          │                                                          │
│          └──────────────────────────────────────► (back to 1)       │
└─────────────────────────────────────────────────────────────────────┘
```

**The user's environment gets better every week without manual work.**

---

## 15. Zero-Friction Integration

### 15.1 One-Line Setup

```bash
# Python
pip install eden-observability
eden init --project-id proj_abc123

# Auto-instruments OpenAI, Anthropic, LangChain, etc.
```

```bash
# Node.js
npm install @eden/observability
eden init --project-id proj_abc123
```

### 15.2 Environment Integration (Automatic)

When a user runs an agent in an Eden environment, observability is **automatic** — no setup required. The environment itself emits traces to the user's project.

### 15.3 CI/CD Integration

```yaml
# .github/workflows/agent-ci.yml
- name: Run Eden Benchmarks
  run: |
    eden benchmark run weekly_regression \
      --agent-version ${{ github.sha }} \
      --fail-on-regression

- name: Check Disparity Score
  run: |
    eden disparity check \
      --threshold 0.2 \
      --fail-if-above
```

### 15.4 Slack / Teams Alerts

```yaml
# .eden/alerts.yaml
alerts:
  - name: "prod_failure_spike"
    condition: "production.failure_rate_1h > 0.1"
    channel: "slack://#agent-alerts"
    include_trace_preview: true

  - name: "env_prod_gap_widening"
    condition: "comparative.disparity_score_7d_trend > 0.1"
    channel: "email://team@company.com"
    include_recommendation: true
```

---

## 16. Multi-Tenancy & Data Isolation

### 16.1 Tenant Isolation Model

| Layer | Isolation Mechanism |
|-------|-------------------|
| **Trace Store** | `tenant_id` column in every table + row-level security policies |
| **Datasets** | Dataset IDs prefixed with tenant; physical separation in S3 buckets |
| **Tenant KB** | Dedicated vector collection per tenant in PostgreSQL/pgvector |
| **Global KB** | Shared read-only collection; no tenant data leakage |
| **Insights** | Insights computed per-tenant; global patterns derived from anonymized aggregations |

### 16.2 Privacy Controls

- **PII Redaction**: Automatic detection and redaction of PII in production traces before storage
- **Data Retention**: Configurable per-tenant (default: 90 days hot, 1 year cold)
- **Opt-Out**: Tenants can disable global KB contribution (their data still improves their own environments, but doesn't contribute to global patterns)
- **Audit Log**: All KB queries and retrievals logged for compliance

### 16.3 Global KB Anonymization

Before any tenant data contributes to the Global KB:

1. **PII scrubbing** (regex + NER model)
2. **Abstraction**: Replace company-specific entities with generic placeholders
3. **Aggregation**: Individual traces become statistical patterns, not retrievable raw data
4. **Review**: High-impact global entries (new failure taxonomy categories) reviewed by Eden team

---

## 17. Implementation Roadmap

### Phase 1: Foundation (Weeks 1–4)

| Week | Deliverable |
|------|------------|
| 1 | Unified Trace Model protobuf + ClickHouse schema |
| 2 | Ingestion API (REST batch + WebSocket streaming) |
| 3 | Python SDK with auto-instrumentation for OpenAI + Anthropic |
| 4 | Basic Trace Viewer (timeline + tree views) |

### Phase 2: Production Observability (Weeks 5–8)

| Week | Deliverable |
|------|------------|
| 5 | LangChain / LangGraph auto-instrumentation |
| 6 | Production trace ingestion + OTLP exporter |
| 7 | Performance dashboard (latency, tokens, cost) |
| 8 | PII redaction + data retention policies |

### Phase 3: Intelligence (Weeks 9–14)

| Week | Deliverable |
|------|------------|
| 9 | Dataset Generation Engine + auto-promotion rules |
| 10 | Benchmark Engine + CI integration |
| 11 | Insights Engine v1 (failure pattern + performance anomaly detectors) |
| 12 | Comparative analysis + disparity detection |
| 13 | Custom detectors + alert system |
| 14 | Knowledge Base v1 (global + tenant layers) |

### Phase 4: Feedback Loop (Weeks 15–18)

| Week | Deliverable |
|------|------------|
| 15 | Archivist integration — KB entries influence environment generation |
| 16 | Disparity reports auto-fed into pipeline context |
| 17 | Dataset auto-export to HuggingFace, OpenAI eval, Langfuse |
| 18 | Portal launch — dashboards, KB search, team management |

### Phase 5: Scale (Weeks 19–24)

| Week | Deliverable |
|------|------------|
| 19-20 | Node.js SDK, Go SDK |
| 21-22 | Advanced visualizations (state-space graphs, diff views) |
| 23-24 | Enterprise features (SSO, audit logs, custom retention, on-prem option) |

---

## Appendix A: Data Models

### A.1 ClickHouse Trace Schema

```sql
CREATE TABLE traces (
    trace_id UUID,
    tenant_id LowCardinality(String),
    project_id LowCardinality(String),
    realm Enum8('environment' = 0, 'production' = 1, 'comparative' = 2),
    agent_id LowCardinality(String),
    agent_version LowCardinality(String),
    environment_id Nullable(String),
    started_at DateTime64(9),
    ended_at DateTime64(9),
    duration_ms UInt32,
    outcome Enum8('success' = 0, 'failure' = 1, 'partial' = 2, 'timeout' = 3, 'crash' = 4),
    success Bool,
    metrics Map(String, Float64),
    tags Array(String),
    metadata Map(String, String),
    span_count UInt16,
    insights Array(String),  -- Insight IDs
    created_at DateTime DEFAULT now()
) ENGINE = MergeTree()
ORDER BY (tenant_id, project_id, started_at)
PARTITION BY toYYYYMMDD(started_at);
```

### A.2 PostgreSQL KB Schema

```sql
-- Global KB (read-only from tenant perspective)
CREATE TABLE global_kb_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    category VARCHAR(64) NOT NULL,  -- best_practice, failure_mode, pattern, benchmark
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    embedding VECTOR(1536),         -- pgvector
    source_tenant_count INT DEFAULT 0,
    confidence_score FLOAT,
    applicable_env_classes TEXT[],
    applicable_frameworks TEXT[],
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_global_kb_embedding ON global_kb_entries USING ivfflat (embedding vector_cosine_ops);

-- Tenant KB
CREATE TABLE tenant_kb_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id VARCHAR(64) NOT NULL,
    category VARCHAR(64) NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    embedding VECTOR(1536),
    source_trace_ids TEXT[],
    source_dataset_ids TEXT[],
    confidence_score FLOAT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_tenant_kb_tenant ON tenant_kb_entries (tenant_id);
CREATE INDEX idx_tenant_kb_embedding ON tenant_kb_entries USING ivfflat (embedding vector_cosine_ops);
```

### A.3 S3 Data Layout

```
s3://eden-observability/{tenant_id}/
  traces/
    {realm}/
      {year}/{month}/{day}/
        {trace_id}.parquet
  datasets/
    {dataset_id}/
      {version}/
        train.jsonl
        test.jsonl
        metadata.json
  benchmarks/
    {benchmark_id}/
      {run_id}/
        results.json
        traces/
```

---

## Appendix B: API Specification

### B.1 Ingest Trace (Batch)

```http
POST /v1/traces
Content-Type: application/json
Authorization: Bearer {api_key}

{
  "project_id": "proj_abc123",
  "traces": [
    {
      "trace_id": "trace_001",
      "realm": "production",
      "started_at": "2026-05-29T12:00:00Z",
      "spans": [  ]
    }
  ]
}
```

### B.2 Query Traces

```http
GET /v1/traces?project_id=proj_abc123&realm=production&outcome=failure&limit=100
Authorization: Bearer {api_key}
```

### B.3 Create Dataset

```http
POST /v1/datasets
Authorization: Bearer {api_key}

{
  "project_id": "proj_abc123",
  "name": "prod_failures_v1",
  "source_filter": {
    "realm": "production",
    "outcome": "failure"
  },
  "auto_promote": true
}
```

### B.4 Run Benchmark

```http
POST /v1/benchmarks/{benchmark_id}/run
Authorization: Bearer {api_key}

{
  "agent_version": "1.4.2",
  "environment_version": "latest"
}
```

### B.5 Query Knowledge Base

```http
POST /v1/kb/query
Authorization: Bearer {api_key}

{
  "project_id": "proj_abc123",
  "query": "How do I prevent my agent from getting stuck in loops?",
  "layers": ["global", "tenant"],
  "top_k": 10
}
```

### B.6 Get Disparity Report

```http
GET /v1/disparity?project_id=proj_abc123&period=7d
Authorization: Bearer {api_key}
```

---

*End of document.*
