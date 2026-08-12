# Eden Feature Gap Master Document

> **Date:** July 15, 2026 (bloat-cut pass — N23 added, eight P2 specs cut; files removed, no archive kept)  
> **Inventory:** **57 F-features** + **22 N-features** + **18 UI specs** = **97 specs**  
> **Prior inventory:** 24 F + 21 N = 45 (July 9 autonomous maintenance pass)  
> **⭐ Execution roadmap (single):** [`EDEN-MASTER-ROADMAP.md`](EDEN-MASTER-ROADMAP.md) — F01–F85 not-fully-shipped + Waves 11–13 portal programs + Wave 14 optim/debug (no time estimates)  
> **Autonomous model:** [`AUTONOMOUS-MAINTENANCE.md`](AUTONOMOUS-MAINTENANCE.md)  
> **Stand-out map:** [`PRODUCTION-MAINTENANCE-STANDOUT.md`](PRODUCTION-MAINTENANCE-STANDOUT.md)  
> **Ground truth:** [`CODEBASE-GROUND-TRUTH.md`](CODEBASE-GROUND-TRUTH.md)  
> **Performance:** [`PERFORMANCE-COST-STANDARDS.md`](PERFORMANCE-COST-STANDARDS.md)  
> **Competitor research:** [`COMPETITOR-UI-RESEARCH.md`](COMPETITOR-UI-RESEARCH.md)  
> **Portal UI specs:** [`ui/README.md`](ui/README.md)

---

## 1. Executive summary

Eden wins on **production agent maintenance & improvement** (operator-led **and** graded-autonomous) when we:

1. **Activate shipped backends** (N14) — ETEC, StatGate, quality worker
2. **Detect with $0 deterministic signals** (N08, F20) before LLM cost
3. **Improve in production safely** (N15 guardrails, F39 nudges, N18 prompt evolution, F41 evidence)
4. **Cut cost 80%+ without blind spots** (N16 sampling, N09 dedupe, zstd 15× shipped)
5. **Unify operator UX** (N17 improvement cockpit)
6. **Autonomously fix production agents** (F46 + N21 runtime heal + N20 code fix) — outages, quality drops, bad deploys
7. **Prove failures without hosted clones** (D6 fixture export + D7 regression memory + D12 session contract)

---

## 2. N-feature inventory (22)

### Platform & cost foundation

| ID | Feature | P | Spec |
|---|---|---|---|
| **N14** | **Production platform activation** | **P0 BLOCKER** | [n14](features/n14-production-platform-activation.md) |
| N09 | Content-addressed trace storage | P1 | [n09](features/n09-content-addressed-trace-storage.md) |
| N16 | Intelligence-aware tail sampling | P0 | [n16](features/n16-intelligence-aware-tail-sampling.md) |

### Detect & respond

| ID | Feature | P | Spec |
|---|---|---|---|
| N08 | StatGate incident response | P1 | [n08](features/n08-statgate-incident-delegation-trust.md) |
| N02 | MCP toolchain observability | P0 | [n02](features/n02-mcp-toolchain-observability.md) |

### Improve in production

| ID | Feature | P | Spec |
|---|---|---|---|
| N15 | Eval-to-live-guardrail promotion | P0 | [n15](features/n15-eval-to-live-guardrail-promotion.md) |
| N18 | Autonomous prompt evolution | P1 | [n18](features/n18-autonomous-prompt-evolution.md) |
| N19 | Compounding KB flywheel | P1 | [n19](features/n19-compounding-kb-flywheel.md) |
| N17 | Agent improvement cockpit | P0 | [n17](features/n17-agent-improvement-cockpit.md) |

### Verify & prove

| ID | Feature | P | Spec |
|---|---|---|---|
| N01 | Production → regression eval | P0 | [n01](features/n01-production-trace-regression-eval.md) |
| N04 | Change impact preview | P1 | [n04](features/n04-agent-change-impact-preview.md) |
| **D6** | Failure fixture export (replaces N07) | P0 | differentiation moat — redacted trace bundle for local replay |
| **D7** | Regression memory (N01 product surface) | P0 | [n01](features/n01-production-trace-regression-eval.md) |
| **D12** | Agent session contract (F23 + N12) | P1 | [f23](features/f23-session-first-sdk.md) |

### Enterprise & UX

| ID | Feature | P | Spec |
|---|---|---|---|
| N03 | Continuous production eval | P1 | [n03](features/n03-continuous-production-eval-sampling.md) |
| N05 | Multi-agent fleet health | P1 | [n05](features/n05-multi-agent-fleet-health.md) |
| N06 | Compliance audit automation | P1 | [n06](features/n06-compliance-audit-trail-automation.md) |
| N10 | Deep search → signal | P1 | [n10](features/n10-deep-search-to-signal.md) |
| N11 | Live trace streaming | P1 | [n11](features/n11-live-trace-streaming.md) |
| N12 | Session timeline UI | P1 | [n12](features/n12-session-multiturn-timeline-ui.md) |
| N13 | Transcript UI v2 | P2 | [n13](features/n13-transcript-ui-v2.md) |

### Autonomous agent maintenance (platform SRE)

| ID | Feature | P | Spec |
|---|---|---|---|
| **F46** | **Closed-loop orchestrator (detect→fix→verify→learn)** | **P0** | [f46](features/f46-closed-loop-orchestrator.md) |
| **N21** | **Runtime remediation** (rollback/cache/reweight) | **P0** | [n21](features/n21-autonomous-self-heal-remediation.md) |
| N20 | Autonomous code fix (PR from diagnosis) | P0 | [n20](features/n20-autonomous-code-modification.md) — **superseded inbox by N23** |
| N22 | Safety bounds (how far Eden may auto-fix) | P0 | [n22](features/n22-autonomy-policy-engine.md) |
| **N23** | **Recurring agentic improvement agent** (Cat 23 replacement) | **P0** | [n23](features/n23-recurring-improvement-agent.md) — **SHIPPED v0** (Wave 7) |

See [`AUTONOMOUS-MAINTENANCE.md`](AUTONOMOUS-MAINTENANCE.md) — incident playbooks for outages, quality drops, deploy regressions.

---

## 3. F-feature inventory (57)

| ID | Feature | P | Spec |
|---|---|---|---|
| F01 | Cached-prefix live debugger | P0 | [f01](features/f01-cached-prefix-live-debugger.md) |
| F03 | Checkpoint ingestion from spans | P1 | [f03](features/f03-checkpoint-ingestion-from-spans.md) |
| F04 | Eden MCP server | P0 | [f04](features/f04-eden-mcp-server.md) |
| F06 | Per-trace signal investigator | P1 | [f06](features/f06-per-trace-signal-investigator.md) — **PARTIAL** (`signals/investigator.py` + F35 bridge) |
| F09 | Browser session recording (RRWeb) | P2 | [f09](features/f09-browser-session-recording-rrweb.md) |
| F12 | Typesense span search | P1 | [f12](features/f12-typesense-span-search.md) |
| F20 | Zero-config auto issue detection | P0 | [f20](features/f20-zero-config-auto-issue-detection.md) |
| F21 | Tool call label learning | P2 | [f21](features/f21-tool-call-label-learning.md) |
| F22 | Issue fix GitHub chat | P0 | [f22](features/f22-issue-fix-github-chat.md) |
| F23 | Session-first SDK | P1 | [f23](features/f23-session-first-sdk.md) |
| F28 | Agent stumbles | P0 | [f28](features/f28-agent-stumbles.md) |
| F29 | Agent issues (Sentry-style) | P0 | [f29](features/f29-agent-issues-sentry.md) |
| F30 | Triage agent | P0 | [f30](features/f30-triage-agent.md) |
| F33 | Issue-linked experiments | P1 | [f33](features/f33-issue-linked-experiments.md) |
| F34 | Trained signal classifiers | P2 | [f34](features/f34-trained-signal-classifiers.md) |
| F35 | Default signal library | P1 | [f35](features/f35-default-signal-library.md) |
| F39 | Runtime nudge injection | P0 | [f39](features/f39-runtime-nudge-injection.md) — **SHIPPED** (`NudgeEngine` → `nudge_outcomes` → demotion/EvidenceGate fully wired) |
| F40 | The Book (agent memory) | P1 | [f40](features/f40-the-book-agent-memory.md) |
| F41 | Evidence-gated promotion | P0 | [f41](features/f41-evidence-gated-promotion.md) — **SHIPPED** (`EvidenceGate` + Bayesian path; matches GA checklist DONE) |
| F42 | Behavioral drift pinpoint | P1 | [f42](features/f42-behavioral-drift-pinpoint.md) |
| F44 | Auto production eval slices | P1 | [f44](features/f44-auto-production-eval-slices.md) |
| F46 | Closed-loop orchestrator | P0 | [f46](features/f46-closed-loop-orchestrator.md) |
| F47 | Slack Block Kit alerts | P1 | [f47](features/f47-slack-block-kit-alerts.md) |
| F48 | Portal API contract fix | P0 | [f48](features/f48-portal-api-contract-fix.md) |

### Eval / portal parity (F49–F81) — added July 14, 2026

| ID | Feature | P | Spec |
|---|---|---|---|
| **F49** | Production prompt playground | **P0** | [f49](features/f49-prompt-playground.md) |
| **F50** | Annotation queues (SME) | **P0** | [f50](features/f50-annotation-queues.md) |
| **F51** | Offline experiment runner + compare | **P0** | [f51](features/f51-offline-experiment-runner.md) |
| **F52** | Online scoring rules engine | **P0** | [f52](features/f52-online-scoring-rules.md) |
| **F53** | Versioned dataset hub | **P0** | [f53](features/f53-versioned-dataset-hub.md) |
| F54 | Code evaluators (sandboxed) | P1 | [f54](features/f54-code-evaluators.md) |
| F55 | Categorical classifiers | P1 | [f55](features/f55-categorical-classifiers.md) |
| F56 | CI eval GitHub Action | P1 | [f56](features/f56-ci-eval-github-action.md) |
| F57 | Custom monitoring dashboards | P1 | [f57](features/f57-custom-monitoring-dashboards.md) |
| **F58** | Saved table views | **P0** | [f58](features/f58-saved-table-views.md) |
| ~~F59~~ | ~~Custom render templates~~ | ~~P2~~ | **CUT** — spec removed in bloat-cut pass (no archive kept) |
| F60 | Cost & usage analytics surface | P1 | [f60](features/f60-cost-usage-analytics.md) |
| F61 | Automations engine | P1 | [f61](features/f61-automations-engine.md) |
| F62 | SLM-as-judge / Luna-cost path | P1 | [f62](features/f62-slm-as-judge.md) |
| ~~F63~~ | ~~Judge autotune / CLHF~~ | ~~P2~~ | **CUT** — spec removed in bloat-cut pass (no archive kept) |
| F64 | Agentic metrics pack | P2 | [f64](features/f64-agentic-metrics-pack.md) |
| F65 | Topics / insights clustering | P1 | [f65](features/f65-topics-insights-clustering.md) |
| F66 | Collaborative prompt workspace | P1 | [f66](features/f66-collaborative-prompt-workspace.md) |
| ~~F67~~ | ~~LLM jury / composite metrics~~ | ~~P2~~ | **CUT** — spec removed in bloat-cut pass (no archive kept) |
| F68 | Gateway prompt deploy | P1 | [f68](features/f68-gateway-prompt-deploy.md) |
| ~~F69~~ | ~~Remote eval sandboxes~~ | ~~P2~~ | **CUT** — spec removed in bloat-cut pass (no archive kept) |
| F70 | In-product AI copilot | P2 | [f70](features/f70-in-product-ai-copilot.md) |
| F71 | Interactive Slack bot | P1 | [f71](features/f71-interactive-slack-bot.md) |
| ~~F72~~ | ~~Virtual / customer data planes~~ | ~~P2~~ | **CUT** — spec removed in bloat-cut pass (no archive kept) |
| F73 | Ingest PII redaction | P1 | [f73](features/f73-ingest-pii-redaction.md) |
| F74 | Debugger session continuity | P1 | [f74](features/f74-debugger-session-continuity.md) |
| F75 | Late metadata on finished traces | P1 | [f75](features/f75-late-trace-metadata.md) |
| F76 | SQL/EQL → dataset/queue export | P1 | [f76](features/f76-sql-export-to-dataset.md) |
| ~~F77~~ | ~~Fine-tune export pipeline~~ | ~~P2~~ | **CUT** — spec removed in bloat-cut pass (no archive kept) |
| ~~F78~~ | ~~Multimodal playground inputs~~ | ~~P2~~ | **CUT** — spec removed in bloat-cut pass (no archive kept) |
| F79 | Span-level scoring API | P1 | [f79](features/f79-span-level-scoring.md) |
| ~~F80~~ | ~~OSS local workshop~~ | ~~P2~~ | **CUT** — spec removed in bloat-cut pass (no archive kept) |
| F81 | NL alerts + real/benign triage (Bento 4.5) | **P0** | [f81](features/f81-nl-alerts-real-benign-triage.md) |
| **F82** | Portal performance budgets | **P0** | [f82](features/f82-portal-performance-budgets.md) |
| **F83** | Platform-wide optimization pass | **P0** | [f83](features/f83-platform-wide-optimization.md) |
| **F84** | Dogfood debugging & self-observability | **P0** | [f84](features/f84-dogfood-debugging-self-observability.md) |
| **F85** | Critical-path E2E & debug hardening | **P0** | [f85](features/f85-critical-path-e2e-debug-hardening.md) |

All F-specs include § Performance & cost optimization where expanded.

### Portal UI specs (U00–U20)

See [`ui/README.md`](ui/README.md) — interaction/layout specs. **U18–U20** are Waves 11–13 portal programs.

---

## 4. Build waves

**Canonical wave order (dependency order, no timelines):**  
→ [`EDEN-MASTER-ROADMAP.md`](EDEN-MASTER-ROADMAP.md) Waves **1–14**

Summary:

| Waves | Focus |
|---|---|
| 1–2 | Foundations + detect/issues harden |
| 3–6 | Observe OS, Bento loop, eval loop, online/dashboards |
| 7–10 | Debugger/fix, signals/topics, autonomy, enterprise P2 |
| **11–13** | **Portal overhaul → improvement → polish** (U18–U20) |
| **14** | **Platform optim + dogfood debug + E2E** (F82–F85) |

Historical Wave -1…7 maintenance sequencing remains valid for N14/N22 gates; map into master roadmap when scheduling.

**Autonomous gate:** N22 must ship before N20/N21 execute paths go production.

---

## 5. Document map

| Doc | Role |
|---|---|
| **EDEN-MASTER-ROADMAP.md** | ⭐ Single execution roadmap |
| **AUTONOMOUS-MAINTENANCE.md** | Normal vs assisted vs autonomous maintenance model |
| **PRODUCTION-MAINTENANCE-STANDOUT.md** | Why Eden wins on maintenance/improvement |
| **CODEBASE-GROUND-TRUTH.md** | Shipped vs missing — spec accuracy |
| **PERFORMANCE-COST-STANDARDS.md** | Cross-cutting SLAs |
| **MARKET-HYPOTHESES.md** | Market research |
| **COMPETITOR-UI-RESEARCH.md** | Cross-product gap digest |
| **ui/** | Portal UI specs **U00–U20** |
| **features/fXX, nXX** | Implementation specs |
| **features/DELETED-FEATURES.md** | Pruned IDs + restore map |

---

## 6. Spec depth status

| Depth | Specs |
|---|---|
| **Deep (180–400+ lines)** | F01, F03, F04, F06, F09, F20, F28–F30, F22, F39, F41, F46, F47, F48, N01–N06, N08–N22, N14–N19 |
| **Expanded prior pass** | N01–N06, N10–N13, N19, F21, F33–F35, F40, F42, F44 |
| **New July 14 (full template)** | F49–F53, F58, F81 + U00–U05, U08, U12 |
| **New July 14 (complete structured)** | F54–F57, F59–F80 + U06–U07, U09–U11, U13–U17 |

Every feature spec includes mandatory § Performance & cost optimization (see `_SPEC_TEMPLATE.md`).

---

*97 specs (57F + 22N + 18UI), bloat-cut pass — July 15, 2026. Eight P2 F-specs CUT — their spec files were removed outright (no archive kept).*
