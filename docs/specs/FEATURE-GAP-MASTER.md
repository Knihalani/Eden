# Eden Feature Gap Master Document

> **Date:** July 9, 2026 (codebase-audit pass)  
> **Inventory:** 24 F-features + **19 N-features** = **43 specs**  
> **Stand-out map:** [`PRODUCTION-MAINTENANCE-STANDOUT.md`](PRODUCTION-MAINTENANCE-STANDOUT.md)  
> **Ground truth:** [`CODEBASE-GROUND-TRUTH.md`](CODEBASE-GROUND-TRUTH.md)  
> **Performance:** [`PERFORMANCE-COST-STANDARDS.md`](PERFORMANCE-COST-STANDARDS.md)

---

## 1. Executive summary

Eden wins on **production agent maintenance & improvement** when we:

1. **Activate shipped backends** (N14) — ETEC, StatGate, quality worker
2. **Detect with $0 deterministic signals** (N08, F20) before LLM cost
3. **Improve in production safely** (N15 guardrails, F39 nudges, N18 prompt evolution, F41 evidence)
4. **Cut cost 80%+ without blind spots** (N16 sampling, N09 dedupe, zstd 15× shipped)
5. **Unify operator UX** (N17 improvement cockpit)
6. **Reproduce failures** (N07 env gen — unique)

---

## 2. N-feature inventory (19)

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

---

## 3. F-feature inventory (24)

See prior sections — unchanged IDs F01, F03, F04, F06, F09, F12, F20–F23, F28–F30, F33–F35, F39–F42, F44, F46–F48.

All F-specs updated with codebase-accurate paths where applicable.

---

## 4. Build waves (maintenance-first)

```
Wave -1   N14 Platform activation  ← BLOCKER
Wave 0    F48 Portal fix
Wave 1    F28 → F29 → F20 → N08
Wave 2    N16 + N09 (cost stack)
Wave 3    F04 MCP + N17 cockpit v1
Wave 4    F30 → F22 → N01 → N04
Wave 5    N15 + F39 + F41 + N18
Wave 6    N07 Phase 1 + N06
Wave 7    N10–N13 UX polish
Capstone  F46 + N19
```

Full rationale: [`PRODUCTION-MAINTENANCE-STANDOUT.md`](PRODUCTION-MAINTENANCE-STANDOUT.md)

---

## 5. Document map

| Doc | Role |
|---|---|
| **PRODUCTION-MAINTENANCE-STANDOUT.md** | Why Eden wins on maintenance/improvement |
| **CODEBASE-GROUND-TRUTH.md** | Shipped vs missing — spec accuracy |
| **PERFORMANCE-COST-STANDARDS.md** | Cross-cutting SLAs |
| **MARKET-HYPOTHESES.md** | Market research |
| **features/fXX, nXX** | Implementation specs |

---

*43 specs, codebase-verified July 2026.*
