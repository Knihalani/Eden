# Deliverables A→H (full spec)

Work in this dependency order. Each ships with tests + a section in
the spec.

## A. Migrations (7 total)

In `alembic/versions/`:
- `065_otel_genai_compliance.py` — 30 typed columns + 6 partial
  indexes on `telemetry_events`.
- `066_trace_efficiency_reports.py` — TAS, grade, intervention,
  fix_patches.
- `067_trace_loop_reports.py` — verdict, detectors_tripped, action,
  severity.
- `068_trace_quality_reports.py` — hallucination_score, components
  jsonb.
- `069_trace_reasoning_reports.py` — coherence/informativeness/goal/
  verify composite.
- `070_trace_guardrail_actions.py` — per-step action log + kill-switch.
- `071_tenant_guardrail_action_config.py` (NEW) — per-tenant per-action
  kill-switch defaults.

All additive (nullable + defaulted). Each has `up()` and `down()` +
forward+back test in `tests/migrations/`. ORM in
`src/eden/models/trace_quality.py` with explicit SQLAlchemy column
types.

In-depth additions:
- Index choice rationale comment on each migration (queries served,
  row count, selectivity).
- Back-fill SQL helper for each new column.
- Constraints documented inline (CHECK constraints on `grade`,
  `severity`, `intervention`, `applied`).
- Migration 071 seeds defaults from `Settings`; post-deploy migration
  inserts per-tenant rows from each `tenants` for non-default overrides.

## B. New routes (7)

All in `api/routes/trace_quality.py`. Pydantic in
`api/schemas/trace_quality.py`.

- `GET /v1/traces/{trace_id}/efficiency`
- `GET /v1/traces/{trace_id}/loops`
- `GET /v1/traces/{trace_id}/quality`
- `GET /v1/traces/{trace_id}/reasoning`
- `GET /v1/traces/{trace_id}/guardrail_actions`
- `POST /v1/guardrails/trajectory/check` (live per-step)
- `POST /v1/llmops/stat_gate/evaluate`
- `GET /v1/guardrails/actions/pending` (NEW — operator queue)
- `POST /v1/guardrails/actions/{id}/approve` (NEW — operator flips
  applied=False → applied=True)
- `POST /v1/admin/guardrails/{action_class}/enable|disable` (NEW —
  per-tenant kill switch)

In-depth additions:
- Tenant-scope via `require_org_member`; cross-tenant returns 404.
- ETag/If-None-Match on GET.
- Audit log via existing writer with
  `event_type = "trace_quality.computed"`.
- Cache-Control: private, max-age=300 on report endpoints.
- 422 schema / 404 missing / 503 sidecar-not-ready / 423 tenant-disabled.

## C. Wire supplementaries into existing Eden hooks

- **Cat 15 Policy extension.** `apply_extension()` at
  `api/app.py:lifespan` (monkey-patches `guardrails.policy.VALID_ACTIONS`).
  Idempotent.
- **Cat 17 Closed-loop gating.** Replace
  `llmops/closed_loop_executor.py:apply_approved` (currently
  `v0_noop`) with `StatGateGatedExecutor` from
  `phase_7_detection/stat_gated_executor.py`.
- **Cat 17 Closed-loop action collection.** Wire
  `phase_7_detection/closed_loop.py:collect_closed_loop_actions` into
  the existing `PromotionHook.on_drift_alert`.
- **Cat 22 SamplingPolicy.** Loop verdicts → keep rate 1.0.
- **Cat 15 TrajectoryGuardrail hot path.** Replace
  `guardrails/intervention.py:InterventionEngine.evaluate_and_act`
  (`live: false` noop) with
  `phase_4_guardrails/trajectory.TrajectoryGuardrail.evaluate_step`.

## D. Settings (see `06_settings.md`)

## E. Sidecar worker

New package: `src/eden/observability/quality_pipeline/`.

Worker that:
1. Streams rows from `telemetry_events` since last-watermark.
2. Buffers until `trace_<id>` has `span.end` observed.
3. Computes (5 steps, each with timeout):
   - TAS via `phase_2_efficiency.composite.compute_tas` (50ms)
   - Loop via `phase_3_loops.combined_loop_detector.check_combined` (100ms)
   - Quality via `phase_5_quality.pipeline.HallucinationPipeline` (200ms,
     model lazy-load first-call)
   - Reasoning via `phase_9_reasoning.scorer.compute_composite` (50ms)
   - DetectionReport via `phase_7_detection.detectors.run_all_detectors` (200ms)
4. Persists each report to migration tables 066-069 in one transaction.
5. Emits `PromotionHook.on_drift_alert` on `Severity.HIGH`.
6. Maintains 100-trace in-memory ring buffer.

In-depth additions:
- Graceful SIGTERM shutdown (drain, flush, exit 0 in 30s).
- Monotonic processing (crash-recovery via persisted watermark).
- Dead-letter table `quality_pipeline_failed_traces`.
- Prometheus: `quality_pipeline_traces_total{status}`,
  `quality_pipeline_step_duration_seconds{step}`,
  `quality_pipeline_watermark_age_seconds`.
- Health endpoint `GET /v1/internal/quality_pipeline/health`.
- Per-step timeouts configurable.
- Retry with exponential backoff for transient DB failures.
- Permanent-write-then-fail: high-severity detector fire is persisted
  even if downstream compute fails.
- Deployment topology in `docs/quality_pipeline.md`.

## F. Guardrail hot-path + per-action kill switch

Action-application flow:

```
TrajectoryGuardrail.evaluate_step(event)
  → recommended_action (one of 14)
  → check tenant_guardrail_action_config[(tenant, action)]
  → if applied_by_default=False:
       write trace_guardrail_actions(id, action, applied=False,
         reason="kill_switch_off")
       emit AuditEvent(action_recommended_but_not_applied)
       return NOOP
  → if applied_by_default=True:
       write trace_guardrail_actions(id, action, applied=True)
       run StatGateGatedExecutor for any mutating side effect
       emit AuditEvent(action_applied)
       return applied action
```

In-depth additions:
- Subclass wrapper test for each of the 5 PlanningFramework subclasses.
- Concurrent step test (100 parallel runs, correct step-index order).
- **Hot-path latency regression test fixture** — fails the build if
  any single hot-path check crosses 5ms p99 over 1000-step workload.

## G. Test depth (see `07_tests.md`)

~304 new integration tests + 5 e2e + 1 No-Drop Invariant fixture.

## H. Spec propagation (see `08_spec_propagation.md`)

Every commit changes the spec.
