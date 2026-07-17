# Eden GA Completion Checklist

> **Created:** July 16, 2026 (from GA Completion Program audit)  
> **Update rule:** After every wave merge, refresh status + PR link for touched IDs.  
> **Status values:** `DONE` | `PARTIAL` | `STUB` | `MISSING` | `BLOCKED` | `OUT OF SCOPE`

---

## Out of scope (never schedule)

| ID | Reason | Notes |
|---|---|---|
| F04 | MCP | Portal/API handoffs only per program lock |
| N02 | MCP toolchain observability | Defer entirely |
| F59 | Archived | Custom render templates — retired |
| F63 | Archived | Judge autotune — retired |
| F67 | Archived | LLM jury composite |
| F69 | Archived | Remote eval sandboxes |
| F72 | Archived | Virtual data planes |
| F77 | Archived | Fine-tune export |
| F78 | Archived | Multimodal playground |
| F80 | Archived | OSS local workshop |
| N07 | Retired | LangGraph env-gen — use D6/D7 |
| Cat 23 | Retired | Replaced by N23 spec |

---

## Phase 0 — N14 Platform activation (blocker)

| ID | Status | Wave | Spec | Notes |
|---|---|---|---|---|
| N14 | **DONE** | Phase 0 | [n14-production-platform-activation.md](features/n14-production-platform-activation.md) | `install_all` in lifespan (all pods); leader-gated workers; health + metrics; demote wired; integration tests green |

---

## Phase 1 — Harden Wave 1–2

| ID | Status | Wave | Spec | Notes |
|---|---|---|---|---|
| F03 | **DONE** | Phase 1 | [f03-checkpoint-ingestion-from-spans.md](features/f03-checkpoint-ingestion-from-spans.md) | Microbench + 1k-trace/hr backfill budget in `cache.py`; tests green |
| F12 | **PARTIAL** | Phase 1 | [f12-typesense-span-search.md](features/f12-typesense-span-search.md) | PII + fallback tests pass; staging 10M p95 **BLOCKED** — Typesense unreachable locally Jul 17; see `docs/ops/F12-STAGING-10M-SPAN-SEARCH.md` |
| F20 | **DONE** | Phase 1 | [f20-zero-config-auto-issue-detection.md](features/f20-zero-config-auto-issue-detection.md) | 8 detectors on standard profile; `auto_issue_detection_v1` default true; e2e <60s |
| F28 | **DONE** | Phase 1 | [f28-agent-stumbles.md](features/f28-agent-stumbles.md) | Stumble loop + detector profiles hardened |
| F29 | **DONE** | Phase 1 | [f29-agent-issues-sentry.md](features/f29-agent-issues-sentry.md) | Grouping + promotion + Slack `user_count` |
| F30 | **DONE** | Phase 1 | [f30-triage-agent.md](features/f30-triage-agent.md) | `triage_result` persisted; portal debugger deep-link (not MCP) |
| F35 | **DONE** | Phase 1 | [f35-default-signal-library.md](features/f35-default-signal-library.md) | 8 templates seeded on org create (`profile=advanced`) |
| F47 | **DONE** | Phase 1 | [f47-slack-block-kit-alerts.md](features/f47-slack-block-kit-alerts.md) | Block Kit POST + P0 `user_count`; p95<60s alert test |
| F48 | DONE | Wave 1 | [f48-portal-api-contract-fix.md](features/f48-portal-api-contract-fix.md) | Contract tests green |

---

## Phase 2 — Portal OS & Observe

| ID | Status | Wave | Spec | Notes |
|---|---|---|---|---|
| U12 | **DONE** | Phase 2 | [u12-portal-ia.md](ui/u12-portal-ia.md) | 9 core items ≤12; Observe/Improve/Evaluate/Workspace; legacy redirects |
| U00 | **DONE** | Phase 2 | [00-portal-operating-system.md](ui/00-portal-operating-system.md) | `portal-os/` shell primitives; no full U18 AppShell |
| F58 | **DONE** | Phase 2 | [f58-saved-table-views.md](features/f58-saved-table-views.md) | Wraps Phase N `saved-searches`; `?view=` URL state |
| U08 | **DONE** | Phase 2 | [u08-saved-views-and-filters.md](ui/u08-saved-views-and-filters.md) | Dual FilterBar + query language on `/traces` |
| U01 | **DONE** | Phase 2 | [u01-traces-hub.md](ui/u01-traces-hub.md) | Traces \| Spans \| Sessions; split-pane transcript default |
| F23 | **DONE** | Phase 2 | [f23-session-first-sdk.md](features/f23-session-first-sdk.md) | SDK `begin()` + agent-sessions API + Sessions tab |
| N12 | **DONE** | Phase 2 | [n12-session-multiturn-timeline-ui.md](features/n12-session-multiturn-timeline-ui.md) | `/sessions/[id]` turn cards + keyboard nav |
| N13 | **PARTIAL** | Phase 2 | [n13-transcript-ui-v2.md](features/n13-transcript-ui-v2.md) | VirtualizedTranscript + swimlanes/RRWeb; **F21 labels DONE (W27)** |

---

## Phase 3 — Artifacts & Ledger GA

| ID | Status | Wave | Spec | Notes |
|---|---|---|---|---|
| F39 | **DONE** | Phase 3 | [f39-runtime-nudge-injection.md](features/f39-runtime-nudge-injection.md) | EvidenceGate promote only; action apply + warm cache + trigger DSL; portal U02 detail/export/NL/promote modal |
| F40 | **DONE** | Phase 3 | [f40-the-book-agent-memory.md](features/f40-the-book-agent-memory.md) | Vector retrieval + embeddings on upsert; cold-path warm; portal diff/citations/inject |
| F41 | **DONE** | Phase 3 | [f41-evidence-gated-promotion.md](features/f41-evidence-gated-promotion.md) | `/promotions` inbox; Bayesian path; min_n=50; 7d demotion + Ledger DNR |
| F42 | **DONE** | Phase 3 | [f42-behavioral-drift-pinpoint.md](features/f42-behavioral-drift-pinpoint.md) | Weekly baseline worker (Mon 04:00 UTC cron) + live histograms on drift API |
| F81 | **DONE** | Phase 3 | [f81-nl-alerts-real-benign-triage.md](features/f81-nl-alerts-real-benign-triage.md) | real/benign/duplicate triage + paging confidence gate |
| U02 | **DONE** | Phase 3 | [u02-artifacts.md](ui/u02-artifacts.md) | Detail, export, NL author, promote warning modal, promotions link |
| U05 | **DONE** | Phase 3 | [u05-book-and-drift.md](ui/u05-book-and-drift.md) | Version diff, citation chips, inject preview + toggle |
| F85 | **PARTIAL** | Phase 3 | [f85-critical-path-e2e-debug-hardening.md](features/f85-critical-path-e2e-debug-hardening.md) | **8/8 PASS local** Jul 17; Clerk redirect loop fixed; CI `localhost:3000`; first green CI pending |

---

## Phase 4 — Eval loop

| ID | Status | Wave | Spec | Notes |
|---|---|---|---|---|
| F53 | **DONE** | Phase 4 | [f53-versioned-dataset-hub.md](features/f53-versioned-dataset-hub.md) | `datasets_hub` API + snapshots + promote-from-trace; portal empty states teach loop |
| F50 | **PARTIAL** | Phase 4 | [f50-annotation-queues.md](features/f50-annotation-queues.md) | Queues API + workstation shipped; full U06 AC → SOTA W18. See [SOTA-WAVE-TRACKER.md](SOTA-WAVE-TRACKER.md) |
| F49 | **PARTIAL** | Phase 4 | [f49-prompt-playground.md](features/f49-prompt-playground.md) | Portal `/playgrounds` wired; persistence/matrix gaps → SOTA W18 |
| F51 | **DONE** | Phase 4 | [f51-offline-experiment-runner.md](features/f51-offline-experiment-runner.md) | Postgres offline runner + immutable compare grid |
| F44 | **DONE** | Phase 4 | [f44-auto-production-eval-slices.md](features/f44-auto-production-eval-slices.md) | Nightly cron 02:00 UTC; 7d stratified sampling; dataset_id on slices |
| F33 | **DONE** | Phase 4 | [f33-issue-linked-experiments.md](features/f33-issue-linked-experiments.md) | Real telemetry stumble rates + Bayesian report UI |
| N01 | **DONE** | Phase 4 | [n01-production-trace-regression-eval.md](features/n01-production-trace-regression-eval.md) | Runner + mandatory on resolve + canary >5% gate + CI webhook |
| N04 | **DONE** | Phase 4 | [n04-agent-change-impact-preview.md](features/n04-agent-change-impact-preview.md) | 7d stratified replay + real regression + portal `/improve/change-impact` |

---

## Phase 5 — Online quality & dashboards

| ID | Status | Wave | Spec | Notes |
|---|---|---|---|---|
| F52 | **PARTIAL** | Phase 5 | [f52-online-scoring-rules.md](features/f52-online-scoring-rules.md) | Rules CRUD + cascade shipped; full U14 UI → SOTA W18 |
| F79 | **DONE** | Phase 5 | [f79-span-level-scoring.md](features/f79-span-level-scoring.md) | `span_scores` table + span/trace score APIs |
| F54 | **DONE** | Phase 5 | [f54-code-evaluators.md](features/f54-code-evaluators.md) | Sandboxed code evaluators (no imports); default scorer tier |
| F55 | **DONE** | Phase 5 | [f55-categorical-classifiers.md](features/f55-categorical-classifiers.md) | Classifiers → trace columns via custom properties |
| F61 | **DONE** | Phase 5 | [f61-automations-engine.md](features/f61-automations-engine.md) | Score-threshold → dataset/queue/alert automations |
| F57 | **DONE** | Phase 5 | [f57-custom-monitoring-dashboards.md](features/f57-custom-monitoring-dashboards.md) | Editable Home dashboard + widget CRUD/query execute |
| F60 | **DONE** | Phase 5 / SOTA W8 | [f60-cost-usage-analytics.md](features/f60-cost-usage-analytics.md) | FinOps explorer + export + 50/80/100 alerts + cache savings |
| F66 | **DONE** | Phase 5 | [f66-collaborative-prompt-workspace.md](features/f66-collaborative-prompt-workspace.md) | Collaborators + workspace API on prompts |
| F68 | **DONE** | Phase 5 | [f68-gateway-prompt-deploy.md](features/f68-gateway-prompt-deploy.md) | Env deploy API + gateway `prompt_deploy` filter (60s cache) |
| F56 | **DONE** | Phase 5 | [f56-ci-eval-github-action.md](features/f56-ci-eval-github-action.md) | `.github/actions/eden-eval` blocks PR on regression fail |
| F76 | **DONE** | Phase 5 | [f76-sql-export-to-dataset.md](features/f76-sql-export-to-dataset.md) | SQL → dataset/queue export API |
| F75 | **DONE** | Phase 5 | [f75-late-trace-metadata.md](features/f75-late-trace-metadata.md) | `POST /traces/{id}/metadata` on finished traces |
| F73 | **DONE** | Phase 5 | [f73-ingest-pii-redaction.md](features/f73-ingest-pii-redaction.md) | Settings PII tab + `/pii-policy` productized |
| N03 | **DONE** | Phase 5 | [n03-continuous-production-eval-sampling.md](features/n03-continuous-production-eval-sampling.md) | Daily budget cap; rules engine; no invented scores |
| N15 | **DONE** | Phase 5 | [n15-eval-to-live-guardrail-promotion.md](features/n15-eval-to-live-guardrail-promotion.md) | Shadow promote → EvidenceGate → live guardrail filter |

---

## Phase 6 — Debugger & fix

| ID | Status | Wave | Spec | Notes |
|---|---|---|---|---|
| F01 | **DONE** | Phase 6 | [f01-cached-prefix-live-debugger.md](features/f01-cached-prefix-live-debugger.md) | `live_prefix` rerun + PrefixCacheService wired; `microbench_prefix_replay` p95&lt;2s |
| F74 | **DONE** | Phase 6 | [f74-debugger-session-continuity.md](features/f74-debugger-session-continuity.md) | `debug_sessions` API + `/debugger-sessions` portal compare |
| F09 | **DONE** | Phase 6 | [f09-browser-session-recording-rrweb.md](features/f09-browser-session-recording-rrweb.md) | Browser session store + replay API + `BrowserReplayPanel` |
| F22 | **DELETED** | Phase 6 / W26 | [f22-issue-fix-github-chat.md](features/f22-issue-fix-github-chat.md) | **DELETED SOTA W26** — use N20 improvement_plans + coding-agent handoff; do not rebuild |
| D6 | **DONE** | Phase 6 | — | `export-fixture` API + one-click issue export |
| D7 | **DONE** | Phase 6 | — | Regression memory list/create + issue overview panel |
| D12 | **DONE** | Phase 6 | — | `GET /agent-sessions/contract` + SDK F23 semantics |
| U13 | **DONE** | Phase 6 | [u13-debugger-sessions.md](ui/u13-debugger-sessions.md) | `/debugger-sessions` list + detail compare UI |

---

## Phase 7 — Signals (no MCP)

| ID | Status | Wave | Spec | Notes |
|---|---|---|---|---|
| F06 | **DONE** | Phase 7 | [f06-per-trace-signal-investigator.md](features/f06-per-trace-signal-investigator.md) | `clusterer.py` + `backfill.py`; migration `104_wave8_signals`; API clusters/backfill/events |
| F65 | **DONE** | Phase 7 | [f65-topics-insights-clustering.md](features/f65-topics-insights-clustering.md) | `/topics` API + `/insights/topics` portal; patterns sync + dataset act |
| F71 | **DONE** | Phase 7 | [f71-interactive-slack-bot.md](features/f71-interactive-slack-bot.md) | `/integrations/slack/commands` + interactions; ack/assign/trace; F47 buttons |
| N10 | **DONE** | Phase 7 | [n10-deep-search-to-signal.md](features/n10-deep-search-to-signal.md) | Preview + backfill job + cost estimate; SpanSearchBar save-as-signal |

---

## Phase 8 — Autonomous SRE

| ID | Status | Wave | Spec | Notes |
|---|---|---|---|---|
| F46 | **DONE** | Phase 8 | [f46-closed-loop-orchestrator.md](features/f46-closed-loop-orchestrator.md) | detect→triage→remediate→verify→learn; N22 gate on heal; verify worker |
| N22 | **DONE** | Phase 8 | [n22-autonomy-policy-engine.md](features/n22-autonomy-policy-engine.md) | Policy row seeded on new org create; enforced in orchestrator + executor |
| N21 | **DONE** | Phase 8 | [n21-autonomous-self-heal-remediation.md](features/n21-autonomous-self-heal-remediation.md) | `heal_from_issue` execute path: rollback/reweight/cache_bust |
| N23 | **DONE** | Phase 8 | [n23-recurring-improvement-agent.md](features/n23-recurring-improvement-agent.md) | `improvement_agent_v1` + weekly cron default for new orgs; plans→approve→PR |
| N18 | **DONE** | Phase 8 | [n18-autonomous-prompt-evolution.md](features/n18-autonomous-prompt-evolution.md) | `evolution_loop_enabled` + 5% canary in new-org features; cockpit canaries |
| N19 | **DONE** | Phase 8 | [n19-compounding-kb-flywheel.md](features/n19-compounding-kb-flywheel.md) | Real skill templates; `_enqueue_promotion` → EvidenceGate |
| N08 | **DONE** | Phase 8 | [n08-statgate-incident-delegation-trust.md](features/n08-statgate-incident-delegation-trust.md) | StatGate P0 rail on `trace.finalized` before LLM triage |
| F62 | **DONE** | Phase 8 | [f62-slm-as-judge.md](features/f62-slm-as-judge.md) | `slm_hook.py` fast-tier cascade; no fake scores |
| N17 | **DONE** | Phase 8 | [n17-agent-improvement-cockpit.md](features/n17-agent-improvement-cockpit.md) | Cockpit + evolution canaries + Artifacts links |

---

## Phase 9 — Enterprise P1

| ID | Status | Wave | Spec | Notes |
|---|---|---|---|---|
| N06 | **DONE** | Phase 9 | [n06-compliance-audit-trail-automation.md](features/n06-compliance-audit-trail-automation.md) | Portal `/audit-trail`; chain verify API; JSON compliance pack export; UI label **Audit trail** (not Ledger) |
| N05 | **DONE** | Phase 9 | [n05-multi-agent-fleet-health.md](features/n05-multi-agent-fleet-health.md) | Fleet cards + heatmap + delegation; N22 autonomy badges; F42 drift badge; SLA summary; N17 severity sort |

---

## Phase 10–12 — Portal U18 → U19 → U20

| ID | Status | Wave | Spec | Notes |
|---|---|---|---|---|
| U18 | **DONE** | Phase 10 | [u18-portal-overhaul.md](ui/u18-portal-overhaul.md) | AppShell wired in `(portal)/layout.tsx`; DetailPanelShell on traces, artifacts, issues, alerts, experiments, promotions; CoreResourcePage on evaluate routes; ⌘K ≥5 actions; mobile nav 5 items; route-agreement CI test; Storybook stubs |
| U19 | **DONE** | Phase 11 | [u19-portal-improvement.md](ui/u19-portal-improvement.md) | Cross-link matrix (`portal-cross-links.ts`); U02 artifacts full bar (tabs, evidence, bulk, j/k, promote modal); U05 ledger/drift histograms + inject preview; density on traces/issues/alerts/experiments/debugger-sessions; `u19-portal.test.ts` |
| U20 | **DONE** | Phase 12 | [u20-portal-polish.md](ui/u20-portal-polish.md) | WCAG AA on Home/Traces/Issues/Artifacts/Playground; `prefers-reduced-motion`; unified issue badges; toast on promote/ack/approve/save; axe CI gate (critical-only) on main; authenticated axe **PASS** Jul 17 (8/8 routes, 0 critical); `u20-portal.test.ts` |

---

## Phase 13 — F82–F85 + GA harden

| ID | Status | Wave | Spec | Notes |
|---|---|---|---|---|
| F82 | **DONE** | Phase 13 | [f82-portal-performance-budgets.md](features/f82-portal-performance-budgets.md) | InfiniteDataTable/VirtualizedList on core tables; progressive trace panel; perf marks; `web-vitals.yml` CI |
| F83 | **DONE** | Phase 13 | [f83-platform-wide-optimization.md](features/f83-platform-wide-optimization.md) | [optimization-pass.md](optimization-pass.md); PG indexes mig 106; CH MVs; `CostTracker`→`budget_service` mirror |
| F84 | **PARTIAL** | Phase 13 | [f84-dogfood-debugging-self-observability.md](features/f84-dogfood-debugging-self-observability.md) | W9: heartbeats + `/admin/flags` + MCP `eden_health` + ingest lag UI; staging continuous probes still open |
| F85 | **PARTIAL** | Phase 13 | [f85-critical-path-e2e-debug-hardening.md](features/f85-critical-path-e2e-debug-hardening.md) | **8/8 PASS local** Jul 17; seed-auth loud fail + `clerkSetup` in runner; CI strict (no continue-on-error) |

---

## Supporting / infrastructure (referenced in program)

| ID | Status | Wave | Spec | Notes |
|---|---|---|---|---|
| N16 | PARTIAL | — | [n16-intelligence-aware-tail-sampling.md](features/n16-intelligence-aware-tail-sampling.md) | Cat 22 wiring in N14 |
| N09 | PARTIAL | — | [n09-content-addressed-trace-storage.md](features/n09-content-addressed-trace-storage.md) | Content-addressed storage |
| N11 | **DONE** | W27 | [n11-live-trace-streaming.md](features/n11-live-trace-streaming.md) | Redis `trace:live:*`; portal Live badge; SDK `EDEN_LIVE`/`stream=True`; MCP `tail_trace` |
| N20 | **DONE (dogfood)** | W26 | [n20-autonomous-code-modification.md](features/n20-autonomous-code-modification.md) | Fingerprint≥5 → improvement_plans; N22+N06; GitHub App PR; N01 merge advice |
| F21 | **DONE** | W27 | [f21-tool-call-label-learning.md](features/f21-tool-call-label-learning.md) | Labels persist + calibrator; MCP `label_tool_call`; inference flag default off |
| F34 | **DONE** | W28 | [f34-trained-signal-classifiers.md](features/f34-trained-signal-classifiers.md) | Classifiers before F06; FinOps savings; train/promote/shadow |
| F64 | **DONE** | W28 | [f64-agentic-metrics-pack.md](features/f64-agentic-metrics-pack.md) | Agentic metrics pack on Home + Fleet |
| F70 | **DONE** | — | [f70-in-product-ai-copilot.md](features/f70-in-product-ai-copilot.md) | SOTA W23 — Loop-class ChatSidebar (not F22/MCP) |
| U03–U11, U14–U17 | PARTIAL/MISSING | Various | [ui/](ui/) | Secondary portal surfaces — track per wave |

---

## U18 WP10 — Portal QA matrix (desktop / tablet / mobile)

| Flow | Desktop (≥1024px) | Tablet (768–1023px) | Mobile (<768px) |
|---|---|---|---|
| App shell load | Sidebar expanded/collapsed; ⌘K; org switcher; budget ticker | Sidebar drawer; breadcrumbs truncate | Bottom nav 5 items; hamburger drawer; no horizontal scroll on core tables |
| Traces hub | Split-pane `DetailPanelShell`; j/k prev/next; `?traceId=` shareable | Detail panel sticky; list scrolls | Detail as full-screen drawer overlay |
| Issues | List + `?issueId=` detail panel; link to full `/issues/[id]` | Same master-detail | Drawer detail; Esc closes |
| Alerts | Feed + `?alertId=` detail; batch ack | Filters wrap; panel readable | Drawer detail |
| Artifacts / Promotions | CoreResourcePage + detail panel | Approve/reject in panel header | Drawer detail |
| Experiments / Datasets / Playgrounds | CoreResourcePage shell | Wide tables scroll internally | Evaluate routes usable without trap scroll |
| Command palette | ⌘K opens all core + Advanced routes + ≥5 actions | Same | Search icon opens palette |
| Auth / org chrome | Session banner; org sync banner; Clerk switcher preserved under AppShell | Same | Same |

*Manual sign-off: run on staging before U19 density pass.*

---

## GA launch checklist (final gate)

- [x] N14 health all green (`statgate_installed`, `quality_worker_running`, `evolution_loop_running` on leader)
- [x] New org: auto detection + shadow Artifacts + Ledger draft within 7d of first trace (or alert)
- [ ] F85 8/8 green on main — **8/8 PASS local** Jul 17 (`localhost:3040`); Clerk fixes: `/sign-in` URLs, `allowedRedirectOrigins`, `clerkSetup` in golden runner; CI uses `localhost:3000`; **first green CI run pending**
- [x] `bench/evolution` full suite cost + lift gates — nightly `evolution-nightly.yml` + smoke on evolution PRs
- [x] F82 Web Vitals CI green — `.github/workflows/web-vitals.yml` (LCP/INP on Home + Traces)
- [x] F83 optimization report published — `docs/specs/optimization-pass.md` (CH MVs + budget mirror done; Redis→PG cap merge deferred)
- [x] No `preview_disabled` on core routes for GA-tier orgs (new-org features seed)
- [x] Feature flags + rollback runbook — `docs/runbooks/feature-flags-rollback.md`
- [x] GT audit clean — zero CRITICAL wiring gaps — `CODEBASE-GROUND-TRUTH.md` refreshed Jul 17; N11 **DONE (W27)**; F21 labels **DONE (W27)**; N20 dogfood DONE (W26); F70 DONE (W23)
- [x] No U19 before U18 exit; no GA mark before F85 green — U18/U19/U20 DONE; F85 partial blocks full GA sign-off
- [ ] F12 10M staging span search p95 proof — **BLOCKED** on staging Typesense; local Typesense at `localhost:8108` unreachable Jul 17; SQLite proxy N=50k p95 253 ms documented (not 10M Typesense gate)
- [x] Live axe with Clerk auth on all core routes — **PASS** Jul 17 (`seed-auth.mjs` + `audit-a11y.cjs`); 8/8 U20 routes, 0 critical / 0 serious authenticated

**Achievement report:** [GA-ACHIEVEMENT-REPORT.md](GA-ACHIEVEMENT-REPORT.md)

---

*Source audit: Eden GA Completion Program plan (2026-07-16). Update this file when closing gaps.*
