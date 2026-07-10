# Eden Feature Gap Master Document

> **Date:** July 9, 2026 (autonomous maintenance pass)  
> **Inventory:** 24 F-features + **22 N-features** = **46 specs**  
> **Autonomous model:** [`AUTONOMOUS-MAINTENANCE.md`](AUTONOMOUS-MAINTENANCE.md)  
> **Stand-out map:** [`PRODUCTION-MAINTENANCE-STANDOUT.md`](PRODUCTION-MAINTENANCE-STANDOUT.md)  
> **Ground truth:** [`CODEBASE-GROUND-TRUTH.md`](CODEBASE-GROUND-TRUTH.md)  
> **Performance:** [`PERFORMANCE-COST-STANDARDS.md`](PERFORMANCE-COST-STANDARDS.md)

---

## 1. Executive summary

Eden wins on **production agent maintenance & improvement** (operator-led **and** graded-autonomous) when we:

1. **Activate shipped backends** (N14) — ETEC, StatGate, quality worker
2. **Detect with $0 deterministic signals** (N08, F20) before LLM cost
3. **Improve in production safely** (N15 guardrails, F39 nudges, N18 prompt evolution, F41 evidence)
4. **Cut cost 80%+ without blind spots** (N16 sampling, N09 dedupe, zstd 15× shipped)
5. **Unify operator UX** (N17 improvement cockpit)
6. **Autonomously fix production agents** (F46 + N21 runtime heal + N20 code fix) — outages, quality drops, bad deploys
7. **Reproduce failures** (N07 env gen — unique)

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

### Verify & reproduce

| ID | Feature | P | Spec |
|---|---|---|---|
| N01 | Production → regression eval | P0 | [n01](features/n01-production-trace-regression-eval.md) |
| N04 | Change impact preview | P1 | [n04](features/n04-agent-change-impact-preview.md) |
| N07 | Environment from failures (v2) | P0 | [n07](features/n07-environment-from-production-failures.md) |

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
| N20 | Autonomous code fix (PR from diagnosis) | P0 | [n20](features/n20-autonomous-code-modification.md) |
| N22 | Safety bounds (how far Eden may auto-fix) | P0 | [n22](features/n22-autonomy-policy-engine.md) |

See [`AUTONOMOUS-MAINTENANCE.md`](AUTONOMOUS-MAINTENANCE.md) — incident playbooks for outages, quality drops, deploy regressions.

---

## 3. F-feature inventory (24)

| ID | Feature | P | Spec |
|---|---|---|---|
| F01 | Cached-prefix live debugger | P0 | [f01](features/f01-cached-prefix-live-debugger.md) |
| F03 | Checkpoint ingestion from spans | P1 | [f03](features/f03-checkpoint-ingestion-from-spans.md) |
| F04 | Eden MCP server | P0 | [f04](features/f04-eden-mcp-server.md) |
| F06 | Per-trace signal investigator | P1 | [f06](features/f06-per-trace-signal-investigator.md) |
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
| F39 | Runtime nudge injection | P0 | [f39](features/f39-runtime-nudge-injection.md) |
| F40 | The Book (agent memory) | P1 | [f40](features/f40-the-book-agent-memory.md) |
| F41 | Evidence-gated promotion | P0 | [f41](features/f41-evidence-gated-promotion.md) |
| F42 | Behavioral drift pinpoint | P1 | [f42](features/f42-behavioral-drift-pinpoint.md) |
| F44 | Auto production eval slices | P1 | [f44](features/f44-auto-production-eval-slices.md) |
| F46 | Closed-loop orchestrator | P0 | [f46](features/f46-closed-loop-orchestrator.md) |
| F47 | Slack Block Kit alerts | P1 | [f47](features/f47-slack-block-kit-alerts.md) |
| F48 | Portal API contract fix | P0 | [f48](features/f48-portal-api-contract-fix.md) |

All F-specs include § Performance & cost optimization where expanded.

---

## 4. Build waves (maintenance + autonomous)

```
Wave -1   N14 Platform activation  ← BLOCKER
Wave 0    F48 Portal fix
Wave 1    F28 → F29 → F20 → N08
Wave 2    N16 + N09 (cost stack)
Wave 3    F04 MCP + N17 cockpit v1
Wave 4    F30 → F22 → N01 → N04
Wave 5    N15 + F39 + F41 + N18
Wave 6    F46 + N21 (runtime fix) + N20 (code fix) + N18/N39
Wave 7    N22 safety bounds + N10–N13 UX + F35/F44
Capstone  N19 KB flywheel
```

Full rationale: [`PRODUCTION-MAINTENANCE-STANDOUT.md`](PRODUCTION-MAINTENANCE-STANDOUT.md)

**Autonomous gate:** N22 must ship before N20/N21 execute paths go production.

---

## 5. Document map

| Doc | Role |
|---|---|
| **AUTONOMOUS-MAINTENANCE.md** | Normal vs assisted vs autonomous maintenance model |
| **PRODUCTION-MAINTENANCE-STANDOUT.md** | Why Eden wins on maintenance/improvement |
| **CODEBASE-GROUND-TRUTH.md** | Shipped vs missing — spec accuracy |
| **PERFORMANCE-COST-STANDARDS.md** | Cross-cutting SLAs |
| **MARKET-HYPOTHESES.md** | Market research |
| **features/fXX, nXX** | Implementation specs |
| **features/DELETED-FEATURES.md** | Pruned F05/F10/etc. + N09–N13 restore map |

---

## 6. Spec depth status (third pass)

| Depth | Specs |
|---|---|
| **Deep (180–400+ lines)** | F01, F03, F04, F06, F09, F20, F28–F30, F22, F39, F41, F46, F47, F48, N07–N22, N14–N19 |
| **Expanded this pass** | N01–N06, N10–N13, N19, F21, F33–F35, F40, F42, F44 |

Every spec includes mandatory § Performance & cost optimization (see `_SPEC_TEMPLATE.md`).

---

*46 specs, codebase-verified + autonomous maintenance pass — July 2026.*
