---
title: Observability
sidebar_label: Overview
sidebar_position: 0
slug: /observability
---

# Observability

Eden's observability layer is organised as **22 productised
intelligence categories**, each implemented as a set of services,
tables, routes, tests, and (where appropriate) closed-loop hooks.

This section is the source of truth for what each category does,
how it integrates, and where it sits in the broader product
strategy.

## The categories

| # | Category | Status | Summary |
|---|----------|--------|---------|
| 1 | [Trace replay & workflow](/observability/trace-replay) | `shipped` | Replay, rewind, time-travel, checkpoint. |
| 2 | [Root cause & incidents](/observability/root-cause-incidents) | `shipped` | Rule-based RCA, cluster detection, incident summarisation. |
| 3 | [Evaluation quality](/observability/evaluation-quality-intelligence) | `shipped` | 13 services, judge-score analytics, regression detection. |
| 4 | [Retrieval](/observability/retrieval-intelligence) | `shipped` | RAG utilisation, gap detection, chunk attribution. |
| 5 | [Memory](/observability/memory-intelligence) | `shipped` | Attributor, timeline, impact, reweaver. |
| 6 | [Agent &amp; fleet](/observability/agent-intelligence) | `shipped` | Performance, relationships, handoffs, fleet. |
| 7 | [Tool](/observability/tool-intelligence) | `shipped` | Tool call frequency, errors, latency. |
| 8 | [Cost](/observability/cost-intelligence) | `shipped` | Efficiency, ROI, anomalies, forecast. |
| 9 | [User ("97% problem")](/observability/user-intelligence) | `shipped` | Hierarchical Beta-Binomial correction, 6 v2 trackers. |
| 10 | [Governance](/observability/governance-intelligence) | `shipped` | Compliance, security, approvals, lineage. |
| 11 | [Outcome / ROI](/observability/outcome-roi-intelligence) | `shipped` | Per-department ROI, anomaly detection. |
| 12 | [Experimentation](/observability/experimentation-intelligence) | `shipped` | A/B/n, Bayesian recommender, simulation. |
| 13 | [Predictive](/observability/predictive-intelligence) | `shipped` | Forecast, risk, drift (PSI / embedding). |
| 14 | [Autonomous](/observability/autonomous-intelligence) | `shipped` | NL queries, self-heal proposals, dashboards. |
| 15 | [Runtime protection](/observability/runtime-protection-guardrails) | `stub` | LLM firewall, PII redaction, content moderation. |
| 16 | [Decision](/observability/decision-intelligence) | `stub` | Decision trees, what-if, explainer. |
| 17 | [Closed-loop wiring](/observability/closed-loop-wiring) | `shipped` | Hooks fired from Cat 2/3/4/8/9/10/13. |
| 18 | [Query performance](/observability/query-performance) | `shipped` | Columnar engine, rollups, 4h-SLA compaction. |
| 19 | [Trace query DSL](/observability/trace-query-dsl) | `shipped` | EQL parser, 5 routes, 70 tests. |
| 20 | [Time-travel debugging](/observability/time-travel-debugging) | `shipped` | Replay, rewind, per-step edit DSL. |
| 21 | [Custom-metric studio](/observability/custom-metric-studio) | `shipped` | User-defined metrics on telemetry. |
| 22 | [APM depth](/observability/apm-tracing-depth) | `shipped` | Tail sampling, K8s enrichment, Pyroscope profiling. |
| 23 | [Autonomous code modification](/observability/autonomous-code-modification) | `stub-surface` | 21 services, gated on 4 hard gates. |

**22 / 23** IMPLEMENTED · **1 / 23** STUB surface
(real end-to-end ship gated on SLM Initiative)

## Strategy

- [Gap roadmap](/observability/gap-roadmap) — the strategic plan that
  got us from 4/22 to 22/22.
- [Judge v2 (SLM-as-judge)](/observability/judge-v2-plan) — the
  8-week rollout to replace GPT-4o judges with a Qwen 3.5 4B
  backbone, 50-90× cheaper.

## How the categories connect

```
Trace ─► [Cat 1, 2, 3] ─► Judge scores ─► [Cat 3, 17] ─► KB / prompt
  │                                                          │
  └─► Retrieval (4) ─► Memory (5) ─► Agent (6) ─► Tool (7) ─┘
                                                              │
              Cost (8) ─► Outcome (11) ─► ROI / dept ◄────────┘
                                                              │
User (9) ─► Governance (10) ─► Predictive (13) ─► Autonomy (14)
```

Most categories read from `telemetry_events`, `usage_events`, and
`judge_scores`. Writes fan out to per-category tables and (where
appropriate) fire closed-loop hooks via `PromotionHook`.
