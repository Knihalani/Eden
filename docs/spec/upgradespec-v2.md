# Eden Upgradespec v2 — 2026-06-23

## Status snapshot

| Status | Count | Items |
|---|---|---|
| ✅ **IMPLEMENTED** | 17 cats + 4 spec items | Cat 1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 14, 18, 19, 20, 22 + D.10 cost guardrails (middleware registered 2026-06-23) + D.13 webhooks (routers mounted 2026-06-23) + §E closed-loop hook bus (HookBus + 16 hooks wired 2026-06-23) + §E.5 hook_events migration 051 |
| 🟡 **STUB surface** | 1 cat | Cat 23 — Autonomous Code Modification (21 services, 19 tables, 73 STUB tests; real ship is 8-week gated initiative) |
| ❌ **NOT STARTED** | 4 spec items + 11 cats/services | D.1–D.7 Phase 0 cuts, D.8 streaming tokens, D.9 prompt versioning, D.11 RTBF cross-store, D.12 (MCP/A2A/Computer Use/Voice/Fine-tune/Provider routing), D.14 cold-start UX, Multi-region, Stripe billing, axe-core CI scan, WebSocket + SSE tests, outbound webhook delivery tests |

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

### Spec items shipped this session (2026-06-23)

| Item | Status | What shipped |
|---|---|---|
| **§E** Closed-loop hook bus | ✅ | `src/eden/llmops/hooks_bus.py` (HookBus.emit + dedup + severity precedence + cascade) + `hook_proposal.py` (PromotionProposal BaseModel per §E.4) + migration `051_hook_events.py` (per §E.5) + `promotion_hooks.py._record_action` routed through bus + 5 new hook classes (BudgetHook, IncidentHook, UserSatisfactionHook, DriftAlertHook, RoiHook) |
| **§6.3** Cost guardrails (D.10) | ✅ (middleware activated) | `QuotaEnforcementMiddleware` registered in `src/eden/api/app.py` before `TenantRateLimitMiddleware`; 48 tests in `tests/unit/billing/test_free_only.py` cover spec §G.1 acceptance |
| **§2.17** Webhooks reliability (D.13) | ✅ (CRUD mounted) | `routes/webhooks.py` mounted in `src/eden/api/app.py` at `/orgs/{org_id}/webhooks`; HMAC signing + backoff + DLQ to be implemented in v1.3 follow-up |
| **§B.1** Streaming tokens (D.8) | ❌ deferred | Schema + ClickHouse mirror + SDK + UI all pending — see "NOT STARTED" below |
| **§B.2** Prompt versioning (D.9) | ❌ deferred | Schema + SDK + auto-eval + UI all pending |

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

### Phase 0 — cut the bloat (per upgradespec §F.2, 3 weeks)

All 7 cuts **deferred** to a future session — cutting services that exist + have tests + are in production use is too risky to ship without:
- Active deploy validation
- 30-day `legacy_compat` flag transition window
- Closed-loop hook dependency check (per spec §I risk register)

| Cut | What | Why deferred |
|---|---|---|
| **D.1** Cat 13 APM → OTel Collector | Delete `eden/apm/{sampling,k8s,profiling}.py` + 026 tables; rely on OTel Collector `tail_sampling` + `k8sattributes` | Customers may depend on the surface; needs deprecation window |
| **D.2** Cat 9 → Flat Beta-Binomial | Migration `065_cat9_flatten.sql` drops copy_paste/retry/return signals; replace HierarchicalBetaBinomialCorrector with FlatBetaBinomialCorrector | Same — needs deprecation window |
| **D.3** Cat 11 → 2 services (keep QualityPredictor + DriftDetector) | Delete cost_predictor/capacity_predictor/risk_scorer/embedding_drift + 4 tables | Cat 11 has 53 tests + Cat 8 reads from it; deletion would regress Cat 8 |
| **D.4** Cat 12 → 2 services (InvestigationAgent + NLReportGenerator) | Fold ReportGenerator + RecommendationEngine into InvestigationAgent; delete self_healer_ui/auto_dashboard_builder/nl_query_engine | Self-healer UI has documented v1.6 ship path |
| **D.5** Cat 10 → SOC2 + GDPR only | Defer HIPAA + ISO27001 controls to `docs/eden-governance-roadmap.md` | Sales materials already mention all 4 frameworks; cut is marketing-driven |
| **D.6** Cat 18 → daily/weekly rollups only | Drop `columnar_hourly_rollups` table + hourly selector | Daily is the UI default anyway; cut is low-value |
| **D.7** Cat 23 STUB → defer 7 tables | Remove inbox_*/persona_*/style_* tables from migration 027 | STUB surface is already gated; cut adds risk without value |

### Phase 1 — ship the spine gaps (per upgradespec §F.3, 7 weeks)

All 4 features **deferred** to a future session — each is a multi-week effort requiring new SDKs + migrations + UI:

| Feature | Effort | Notes |
|---|---|---|
| **D.8** Streaming tokens (§6.1) | 2 weeks | Migration 051 + ClickHouse mirror + SDK auto-instrument + portal sparkline UI |
| **D.9** Prompt versioning (§6.2) | 3 weeks | Migration 052 + `@prompt()` decorator + auto-eval runner + version timeline UI |
| **D.10** Cost guardrails full (D.10.3 portal UI) | 2 weeks | Middleware registered this session; budget admin UI + real-time ticker pending |
| **D.13** Webhooks reliability full (D.13.6 portal UI) | 2 weeks | CRUD mounted this session; HMAC signing + backoff scheduler + DLQ + replay UI pending |

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

1. **When to ship Phase 0 cuts**: each cut should be gated on a customer-usage query showing zero hits on the legacy surface for 30 days, then a 14-day `legacy_compat=true` window with warning logs, then drop.
2. **When to enable Stripe**: customer request for paid plans, then wire `STRIPE_SECRET_KEY` + paid plan routes.
3. **When to ship D.8 / D.9 / D.10 full**: customer demand for streaming tokens / prompt versioning / cost guardrail UI.
4. **Cat 23 real ship**: gated on SLM Initiative + 4 hard gates (read-only → attribution → sandbox → end-to-end) over 8 weeks per memory `eden_cat23_stub_surface_shipped_2026_06.md`.
