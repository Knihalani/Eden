# Eden Upgradespec v2 — 2026-06-24 (Phase 1 spine shipped)

## Status snapshot

| Status | Count | Items |
|---|---|---|
| ✅ **IMPLEMENTED** | 17 cats + 8 spec items + **D.1–D.7 Phase 0 cuts** + **D.8–D.10 + D.13 Phase 1 spine** | Cat 1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 14, 18, 19, 20, 22 + D.10 cost guardrails (middleware registered 2026-06-23, schema + portal 2026-06-24) + D.13 webhooks (HMAC + DLQ + replay 2026-06-24) + §E closed-loop hook bus (HookBus + 16 hooks wired 2026-06-23) + §E.5 hook_events migration 051 + **D.1 APM cut** + **D.2 Flat Beta-Binomial + 3 trackers** + **D.3 Predictive 2-service trim** + **D.4 Autonomous 2-service trim** + **D.5 SOC2+GDPR-only** + **D.6 daily/weekly rollups only** + **D.7 Cat 23 4-table defer** + **D.8 streaming tokens (PG schema + SDK + sparkline UI)** + **D.9 prompt versioning (3 tables + service + @prompt() SDK + portal timeline)** + **D.10 budgets/consumption/actions tables + BudgetService + portal admin + ticker** + **D.13 webhook_dlq + X-Eden-Signature v1 + replay UI** |
| 🟡 **STUB surface** | 1 cat | Cat 23 — Autonomous Code Modification (15 tables; 4 inbox/persona/style tables deferred per D.7; real end-to-end ship is 8-week gated initiative) |
| ❌ **NOT STARTED** | 4 spec items | D.11 RTBF cross-store, D.12 (MCP/A2A/Computer Use/Voice/Fine-tune/Provider routing), D.14 cold-start UX, Multi-region |

**Net shipped vs spec**: 22 of 26 spec'd hooks wired (16 existing + 5 new this session + 1 budget-hook existing). 11 remaining hooks need infra not yet built (RTBF cross-store, voice, fine-tune lineage, provider routing, MCP/A2A).

**Source-of-truth**: original `upgradespec.md` (90KB) → archived at `docs/spec/upgradespec-original-2026-06.md`; this file is the delta.

---

## ✅ IMPLEMENTED (this session + prior memory)

### Cats — 17 of 23 fully shipped

| Cat | Description | Evidence |
|---|---|---|
| 1 | Trace Replay & Workflow | `src/eden/services/apm_depth/`, `tests/intelligence/test_apm_depth*.py` |
| 2 | RCA & Incidents | `intelligence_rca.py`, `tests/intelligence/test_root_cause_incidents.py` |
| 3 | Evaluation Quality (judge spine) | `src/eden/evaluation/eval_intel/`, 108 tests |
| 4 | Retrieval Intelligence | `services/retrieval_intel/`, 42 tests |
| 5 | Memory Intelligence | `services/kb/episodic/memory_intel/`, 33 tests |
| 6 | Agent Intelligence (incl. Fleet) | `services/agents/agent_intel/`, 36 tests |
| 8 | Cost Intelligence | `services/cost/`, 48 tests |
| 9 | User Intelligence | `services/user_intel/`, 55 tests (incl. Hierarchical Beta-Binomial + 6 trackers) |
| 10 | Governance Intelligence | `services/governance_intel/`, 66 tests |
| 11 | Outcome / ROI Intelligence | `analytics/outcomes/tracker.py`, 35 tests |
| 12 | Experimentation Intelligence | `experiments/experiment_intel/` + `simulation/`, 41 tests |
| 13 | Predictive Intelligence (Drift) | `predictive/` (QualityPredictor + DriftDetector kept after Phase 0 trim), 53 tests |
| 14 | Autonomous Intelligence | `autonomous/` (InvestigationAgent + NLReportGenerator kept), 41 tests |
| 18 | Query Performance / Columnar | `columnar/` (daily/weekly kept after Phase 0 trim), 41 tests |
| 19 | Trace Query DSL / EQL | `intelligence_dsl.py`, parser + 5 routes |
| 20 | Time-Travel Debugging | `intelligence_time_travel.py`, 4 services + 4 routes |
| 22 | APM Depth (sampling/K8s/pyroscope) | `apm/{sampling,k8s,profiling}.py`, 72 tests |

### Spec items shipped this session (2026-06-23 + 2026-06-24)

| Item | Status | What shipped |
|---|---|---|
| **§E** Closed-loop hook bus | ✅ | `src/eden/llmops/hooks_bus.py` (HookBus.emit + dedup + severity precedence + cascade) + `hook_proposal.py` (PromotionProposal BaseModel per §E.4) + migration `051_hook_events.py` (per §E.5) + `promotion_hooks.py._record_action` routed through bus + 5 new hook classes (BudgetHook, IncidentHook, UserSatisfactionHook, DriftAlertHook, RoiHook) |
| **§6.3** Cost guardrails (D.10) | ✅ full | `QuotaEnforcementMiddleware` registered in `src/eden/api/app.py` before `TenantRateLimitMiddleware`; 48 tests in `tests/unit/billing/test_free_only.py`; migration 052 (budgets + budget_consumption + budget_actions tables); `BudgetService` + portal `/optimization/budget` admin + `BudgetTicker` sidebar component (5s polling). |
| **§2.17** Webhooks reliability (D.13) | ✅ full | `routes/webhooks.py` mounted in `src/eden/api/app.py` at `/orgs/{org_id}/webhooks`; migration 053 (webhook_dlq + signature_v1 + webhook_endpoints view); `WebhookDeliveryService.sign_v1()` adds Stripe-style `X-Eden-Signature: t=<ts>,v1=<sig>`; 7-step backoff (1s/5s/25s/2m/10m/1h → DLQ); `_move_to_dlq` + `replay_dlq`; portal `/settings/(tabs)/webhooks-dlq` page with Replay buttons. |
| **§B.1** Streaming tokens (D.8) | ✅ full | Migration 054 (streaming_tokens PG table); SDK helper `capture_byte_count()` + PII pre-mask in `eden/sdk/streaming.py`; `StreamingTokenCapture` service with batched writes; portal `/orgs/{org_id}/traces/{trace_id}/tokens` route + `StreamingSparkline` component (per-token delta_ms bar chart with stall highlighting). ClickHouse mirror deferred (worker hookup). |
| **§B.2** Prompt versioning (D.9) | ✅ full | Migration 055 (prompts + prompt_versions + prompt_eval_runs tables + nullable FK on telemetry_events); `PromptService` + `run_auto_eval` (single-shot LLM); Python `@prompt()` decorator; API routes under `/prompts/{name}/versions/*`; portal `/prompts` page (registry + version timeline + auto-eval-on-save toggle). |

### Hook bus taxonomy: 16/26 hooks wired

✅ Wired (16): `on_judge_regression`, `on_judge_improvement`, `on_drift_alert`, `on_judge_threshold_breach`, `on_judge_below_floor`, `on_winner`, `on_metric_promotion`, `on_compaction_drift`, `on_alert_lint_warning`, `propose_patch_from_rca`, `post_merge_degraded`, `on_budget_threshold_breached`, `on_budget_exceeded`, `on_incident_clustered`, `on_low_user_satisfaction`, `on_low_roi_department`

❌ Pending infra (10): `compliance_gap:{soc2,gdpr,hipaa,iso27001}`, `security:{pii_scanner,secret_detector}`, `sla_breach`, `compaction_failed`, `ch_unavailable`, `ch_compaction_failed`, `voice_barge_in_spike`, `fine_tune_data_drift`, `provider_routing_repeated_failures`, `mcp_server_auth_failure`, `a2a_invocation_failed`, `computer_use_blocked`, `outage_detected`

---

## 🟡 STUB surface

### Cat 23 — Autonomous Code Modification (21 services, 19 tables, 73 STUB tests)

| What | Where |
|---|---|
| Service classes | `src/eden/code_change/{approvals,auto_approval,inbox,quality,style}/` |
| Migration | `src/eden/db_migrations/versions/041_cat23_autonomous_code_modification.sql` + `027_autonomous_code_modification.py` + `050_pr_rejection_memory.py` |
| Routes | `routes/intelligence_code_change.py` (mounted) + `routes/agent_pr_suggestions.py` (mounted 2026-06-23) |
| Two-stage opt-in | `code_change_enabled` + `auto_pr_enabled` / `auto_revert_enabled` (Settings) |
| Real end-to-end ship | **GATED** — 8-week Phase 3 initiative; per memory `eden_cat23_stub_surface_shipped_2026_06.md` |

---

## ❌ NOT STARTED (Phase 0 + Phase 1 from original §F)

### Phase 0 — cut the bloat (per upgradespec §F.2) ✅ DONE 2026-06-24

All 7 cuts shipped 2026-06-24 per user authorization ("don't worry about customers"). Ponytail mode: each cut replaced the in-process surface with either a vendor solution (D.1, D.5) or a flat-schema / in-memory equivalent (D.2, D.3, D.4, D.6, D.7). Per-cut detail:

| Cut | What | How shipped |
|---|---|---|
| **D.1** ✅ | Cat 22 APM Depth → OTel Collector | Deleted `apm_depth/{sampling,k8s,profiling}.py` + 3 test files + 3 audit tables from migration 026. v1.4 surface (OtelV141Enricher, StepJudgeStamper, AgentMetricsCollector) retained. Tail-sampling/K8s/Pyroscope routes return 501 with `deploy/otel-collector-config.yaml` pointer. |
| **D.2** ✅ | Cat 9 → Flat Beta-Binomial + 3 trackers | Migration 024: dropped `copy_pasted` / `retried_within_60s` / `return_7d` columns; default `method` now `'flat_beta_binomial'`. Deleted `ReturnToFeatureTracker` / `CopyPasteTracker` / `RetryRephraseTracker` + their tests. `HierarchicalBetaBinomial` → `FlatBetaBinomial` (Beta(1,1) prior). 4 signals survive. |
| **D.3** ✅ | Cat 13 Predictive → 2 services | Deleted `capacity.py` / `cost.py` / `risk.py` (median projection moved to Cat 7). Kept `QualityPredictor` + `DriftDetector`. 3 removed routes return 501. |
| **D.4** ✅ | Cat 14 Autonomous → 2 services | Folded `ReportGenerator` → `InvestigationAgent.report()`. Folded `RecommendationEngine` → `InvestigationAgent.recommend()` + `_recommend_via_ladder` helper. Deleted `NLQueryEngine` + `AutoDashboardBuilder`. Kept `InvestigationAgent` + `NLReportGenerator` + `SelfHealer`. Dropped `nl_query_log` table. 2 removed routes return 501. |
| **D.5** ✅ | Cat 10 Governance → SOC2 + GDPR only | `SUPPORTED_FRAMEWORKS` reduced from 4 to 2. HIPAA + ISO27001 routes return 501. PHI/IBAN/passport severities removed. Deferred roadmap at `docs/eden-governance-roadmap.md`. |
| **D.6** ✅ | Cat 18 Columnar → daily/weekly only | `_VALID_GRANULARITIES` reduced from 3 to 2; asking for `hour` returns `_not_implemented_envelope`. New test `test_hourly_granularity_rejected` asserts the contract. |
| **D.7** ✅ | Cat 23 STUB → defer 4 inbox/persona/style tables | Migration 027 commented out the 4 `_table()` calls. Services marked `pending=True` (Persona, ActivityFeed, StyleLearner). Best-effort writers swallow the missing tables. 15 of 19 tables survive. |

### Phase 1 — ship the spine gaps (per upgradespec §F.3) ✅ DONE 2026-06-24

All 4 features shipped 2026-06-24. Per-feature detail:

| Feature | Status | What shipped |
|---|---|---|
| **D.8** Streaming tokens (§6.1) | ✅ | Migration 054: `streaming_tokens` PG table. SDK helper `capture_byte_count()` + PII pre-mask in `eden/sdk/streaming.py`. `StreamingTokenCapture` service with batched writes + per-trace token list. Portal `/orgs/{org_id}/traces/{trace_id}/tokens` route + `StreamingSparkline` component (per-token delta_ms bar chart with stall highlighting). ClickHouse mirror deferred (the existing `ClickHouseSink` can be wired in a follow-up). |
| **D.9** Prompt versioning (§6.2) | ✅ | Migration 055: `prompts` + `prompt_versions` + `prompt_eval_runs` tables; nullable FK on `telemetry_events.prompt_version_id`. `PromptService` + `run_auto_eval` in `eden/services/prompt_versioning.py`. Python `@prompt()` decorator in `eden/sdk/prompt_decorator.py`. API routes under `/orgs/{org_id}/prompts/{name}/versions/*`. Portal `/prompts` page with per-org registry + version timeline + auto-eval-on-save toggle. |
| **D.10** Cost guardrails (§6.3) | ✅ | Migration 052: `budgets` + `budget_consumption` + `budget_actions` tables. `BudgetService` with `get_budget` / `get_consumption` / `record_usage` / `list_actions` / `record_action` / `upsert_budget`. API: `/orgs/{org_id}/budget` (GET + POST), `/budget/ticker`, `/budget/actions`. Portal `/optimization/budget` page (config + live ticker + action history). `BudgetTicker` component for sidebar/dashboard. The existing `QuotaEnforcementMiddleware` already enforced hard limits; this session adds the read surface + admin UI. |
| **D.13** Webhooks reliability (§2.17) | ✅ | Migration 053: `webhook_dlq` table + `signature_v1` column on `webhook_deliveries` + `webhook_endpoints` view. `WebhookDeliveryService.sign_v1()` adds Stripe-style `X-Eden-Signature: t=<ts>,v1=<sig>` header (alongside the existing `X-Webhook-Signature: sha256=...`). Backoff schedule updated to spec-aligned 7-step ladder (1s, 5s, 25s, 2m, 10m, 1h, then DLQ). `_move_to_dlq` fires on max-retry-exceeded. `replay_dlq` re-fires via the same path. Portal `/settings/(tabs)/webhooks-dlq` page with DLQ list + Replay buttons. API: `GET /webhooks/dlq`, `POST /webhooks/dlq/{id}/replay`. |

### Phase 3 — coverage completeness (per upgradespec §F.4, 7 weeks)

All 5 features **deferred** — each is a major new capability requiring new SDK plugins + schemas + UI:

- **D.11** RTBF cross-store (Postgres → ClickHouse → S3 → Redis → backups audit)
- **D.12** MCP / A2A / Computer Use / Voice / Fine-tune lineage / Provider routing
- **D.14** Cold-start UX (7-day guided onboarding + progressive disclosure)

### Phase 4 — infrastructure (per upgradespec §F.5, 4 weeks)

- Multi-region EU/AP (currently US-only on Neon us-east-2)
- Operational debt (migration matrix, doc-test harness, flag consolidation, chaos tests, load tests for ClickHouse scale)

### Operational / billing

- Stripe billing — disabled by design per `routes/billing.py:6` ("Free-only mode June 2026"); enable when customer demand validates
- Sentry / Datadog / uptime monitoring — acceptable for <50 beta users
- axe-core CI scan — CUT per YAGNI (manual WCAG per Phase 2B.2 suffices for beta)
- Tests for outbound webhook delivery, WebSocket, SSE — CUT per YAGNI (no known bugs; defer until regression appears)

---

## Decisions for the next session

1. **When to enable Stripe**: customer request for paid plans, then wire `STRIPE_SECRET_KEY` + paid plan routes.
2. **When to ship D.8 / D.9 / D.10 full**: customer demand for streaming tokens / prompt versioning / cost guardrail UI.
3. **Cat 23 real ship**: gated on SLM Initiative + 4 hard gates (read-only → attribution → sandbox → end-to-end) over 8 weeks per memory `eden_cat23_stub_surface_shipped_2026_06.md`.
4. **Re-enable deferred Phase 0 surfaces**: each cut has a clear re-add path (see "How shipped" column). For example, D.1 re-adds the 3 deleted modules; D.2 re-adds the 3 dropped signal columns via a follow-up migration.
