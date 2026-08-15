---
id: intelligence-categories
title: Intelligence categories
sidebar_label: Intelligence categories
sidebar_position: 3
---

# Intelligence categories

Eden ships **22 intelligence surfaces**, grouped into four phases.
This page is the catalogue.

## Phase 1 — Observation (all shipped)

The platform-level observation surface — every LLM call, every
tool call, every user event becomes a queryable signal.

### Cat 1 — Trace Replay & Workflow

Reconstruct any trace from cold storage, replay it against the
current prompt registry, diff against the original. Includes
checkpoint rewind, live tail SSE, and per-step custom properties.

Tables: `trace_replays`, `trace_replay_steps`, `trace_replay_diffs`.

### Cat 2 — RCA & Incidents

Rule-based pre-filter, deterministic cluster keys
(`clu_<sha256[:16]>`), Jaccard secondary similarity. Auto-fires
`incident.created` webhooks on high-severity clusters.

Tables: `incident_clusters`, `incident_alerts`, `incident_summaries`.

### Cat 4 — Retrieval Intelligence

Utilization scorer, gap detector, chunk attribution, reorderer.
Reads `retrieval_logs` and `telemetry_events.response_body`.

Tables: `retrieval_logs`, `retrieval_gaps`, `chunk_attributions`.

### Cat 5 — Memory Intelligence

Attributor, timeline builder, impact scorer, reweaver. Token-overlap
influence + retrieval-score weighting.

Tables: `memory_attributions`, `memory_timeline`, `memory_impacts`.

### Cat 6 — Agent Intelligence

Agent performance scorer, relationship graph, handoff analyzer,
benchmark runner, fleet service. Fires
`on_drift_alert(drift_type="fleet_deprecation:...")` on identity
re-registration.

Tables: `agent_performance_daily`, `agent_relationships`, `handoff_log`.

### Cat 7 — APM Depth

Sampling policy (5 keep rules), tail sampling buffer, K8s
enrichment, Pyroscope continuous profiling.

Tables: `apm_sampling_decisions`, `apm_k8s_enrichment_log`,
`trace_step_profile_links`.

### Cat 8 — Cost Intelligence

Efficiency scorer, ROI analyzer, anomaly detector (z-score), OLS
forecast. Closed-loop hooks fire on `cost.threshold_breach` and
`cost.anomaly`.

Tables: `cost_summaries_daily`, `cost_anomalies`, `cost_forecasts`.

## Phase 2 — Quality & Evaluation

Judges, scoring, and regression detection.

### Cat 3 — Evaluation Quality

13 services: deterministic judges, LLM judges, rubric management,
regression detection, golden datasets, prompt management, eval
runs, batch replay, and a shared helper. The largest cat.

Persists to all 14 Cat 3 tables + `guardrail_policies` (Cat 15
cross-cat write). Fires `on_judge_regression` and
`on_judge_threshold_breach`.

### Cat 9 — User Intelligence

Hierarchical Beta-Binomial satisfaction correction (per
arXiv 2605.12177), 6 v2 behavioural trackers (Regeneration, Edit,
Return, Abandonment, CopyPaste, Retry), pure-Python Levenshtein.
Fires `on_drift_alert(drift_type="low_user_satisfaction")`.

Tables: `user_sessions`, `user_behavioural_signals`,
`user_satisfaction_corrected`.

### Cat 10 — Governance Intelligence

4 framework evidence packs (SOC 2, HIPAA, GDPR, ISO 27001),
Datadog-SDS-parity PII scanner, RTBF anonymisation, BFS lineage
graph, dashboard rollup.

Tables: `compliance_evidence_packs`, `data_lineage`, `pii_policies`.

### Cat 11 — Outcome / ROI Intelligence

Per-department ROI rollup. 3 anomaly types (low_roi,
cost_without_outcomes, roi_regression). Fires
`on_drift_alert(drift_type="low_roi_department")`.

Tables: `outcomes`, `outcome_rollups`.

## Phase 3 — Experimentation & Prediction

A/B testing and forecasting.

### Cat 12 — Experimentation

Traffic splitter (deterministic SHA-256 weighted bucket), auto
evaluator, experiment recommender (Bayesian beta-binomial), winner
detector (hard-judge majority + veto). Replay production in staging.

Tables: `experiments`, `experiment_splits`, `experiment_assignments`,
`experiment_results`.

### Cat 13 — Predictive

Quality predictor, cost predictor, capacity predictor, risk
scorer, drift detector. PSI drift on judge-score distribution, 64-bucket
hash-histogram embedding drift.

Tables: `predictions`, `drift_alerts`.

### Cat 18 — Query Performance / Columnar

Per-org partitions (`eden.<org>.<YYYY_MM>`), hourly/daily/weekly
rollups, 4h-SLA compaction, read-only SQL allowlist, Postgres-fallback.

Tables: managed by ClickHouse Sink + compaction workers.

### Cat 19 — Trace Query DSL / EQL

SQL-only EQL parser (no sqlglot), span search, field selection.
Per-step edit DSL `step_<n>.<key>`.

Tables: read-only against `telemetry_events`.

### Cat 20 — Time-Travel Debug

Non-destructive replay, cache-miss warnings, per-step edit DSL,
checkpoint rewind.

Tables: read-only against `trace_replays`.

## Phase 4 — Autonomy

Self-healing and code modification.

### Cat 14 — Autonomous Intelligence

Investigation agent, report generator, recommendation engine,
self-healer, NL query engine, auto dashboard builder, NL report
generator. Single-shot LLM calls, graceful degradation on LLM
failure.

Tables: `investigations`, `recommendations`, `self_heal_proposals`.

### Cat 15 — Guardrails

Pre-flight check, runtime check, post-flight check. Fires
`on_pii_match`, `on_judge_threshold_breach`,
`on_drift_alert(drift_type="compliance_gap:<framework>")`.

Tables: `guardrail_policies`, `guardrail_decisions`.

### Cat 21 — Custom Metric Studio

User-defined metrics with custom LoRA heads. Multi-tenant
isolation, label-based slicing.

Tables: `custom_metrics`, `custom_metric_lora_jobs`.

### Cat 22 — APM Depth + Tracing Depth (v1.4)

5-keep-rule sampling, tail sampling buffer (15k slots), K8s
enrichment (Downward API + SA JWT), Pyroscope continuous profiling.

Tables: same as Cat 7, but the v1.4 surface adds the
Pyroscope-side `trace_step_profile_links`.

### Cat 23 — Autonomous Code Modification (cut in Phase 1B)

The original `src/eden/code_change/` stub package (62 files, 46 API
handlers, 19 tables) was removed in the Phase 1B bloat cut
(2026-07-15). The legacy DB tables are preserved but the service
layer is gone. Salvaged primitives (`patches/issue_patch_trigger.py`,
`patches/patch_generator.py`, `patches/pr_creator.py`) live in
`src/eden/patches/` and power the N23 recurring improvement agent
(see the roadmap). A full autonomous code-modification surface is
planned but not yet scheduled.

## Closed-loop hooks

The intelligence services communicate via a single hook bus
(`promotion_hooks.py`). Hooks fire on:

- `on_judge_threshold_breach` (Cat 3)
- `on_judge_regression` (Cat 3, Cat 12)
- `on_drift_alert` (Cat 6, Cat 9, Cat 11, Cat 13)
- `on_cost_threshold_breach` (Cat 8)
- `on_cost_anomaly` (Cat 8)
- `on_compliance_gap` (Cat 10)
- `on_security_event` (Cat 10)
- `on_pii_match` (Cat 10, Cat 15)
- `on_winner` (Cat 12)
- `on_trace_completed` (Cat 1)
- `on_incident_created` (Cat 2)

Each hook can write to multiple destinations (DB tables, webhooks,
Slack channels) — see [Reference → Webhooks](/reference/webhooks).

## What's NOT in v1.7

- Cat 17 — Streaming Intelligence (planned v1.7.x)
- Cat 16 — Code Generation Eval (planned v1.8)
- Cat 23 autonomous code-modification service (stub was cut in Phase 1B;
  see Cat 23 entry above)

Read the per-category write-ups in `docs/docs/observability/` for
the implementation details (internal docs, excluded from the
public site).