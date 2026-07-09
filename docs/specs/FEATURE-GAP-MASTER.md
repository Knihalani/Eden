# Eden Feature Gap Master Document

> **Date:** July 9, 2026 (expanded)  
> **Purpose:** Single source of truth for Eden feature gaps + next-level differentiation.  
> **Granular specs:** [`docs/specs/features/`](features/) — **24 F + 13 N features**  
> **Performance standards:** [`PERFORMANCE-COST-STANDARDS.md`](PERFORMANCE-COST-STANDARDS.md)  
> **Market research:** [`MARKET-HYPOTHESES.md`](MARKET-HYPOTHESES.md)

---

## 1. How to use this document

| If you want… | Go to… |
|---|---|
| What's missing | **Section 3–4** |
| Speed/cost SLAs (all features) | [`PERFORMANCE-COST-STANDARDS.md`](PERFORMANCE-COST-STANDARDS.md) |
| One feature's build spec | `features/fXX-*.md` or `nXX-*.md` |
| Why specs were deleted/restored | [`DELETED-FEATURES.md`](features/DELETED-FEATURES.md) |
| Build order | **Section 5** |

**Every spec includes § Performance & cost optimization** — latency budgets, cost model, caching, degradation.

---

## 2. Executive summary

### Inventory

| Category | Count | Notes |
|---|---|---|
| **F-features** | 24 | Competitor parity + closed loop |
| **N-features** | 13 | Differentiation + restored high-value (N09–N13) |
| **Deleted** | 24 | Mostly absorbed; see DELETED-FEATURES |

### Strategic pillars

1. **F04 Eden MCP** — coding-agent-first (Cursor, Claude Code)
2. **F28→F29→F30→F22→F46** — detect/triage/fix orchestration
3. **N07 + N08** — Eden moats (env gen, StatGate)
4. **PERFORMANCE-COST-STANDARDS** — every feature optimized for client UX

---

## 3. F-feature inventory (24)

### Debugger & MCP (F01, F03, F04)

| ID | Feature | Spec |
|---|---|---|
| F01 | Cached prefix live debugger | [f01](features/f01-cached-prefix-live-debugger.md) |
| F03 | Checkpoint ingestion | [f03](features/f03-checkpoint-ingestion-from-spans.md) |
| F04 | Eden MCP Server + docs (F27) | [f04](features/f04-eden-mcp-server.md) |

### Signals & detection (F06, F20, F34, F35)

| ID | Feature | Spec |
|---|---|---|
| F06 | Per-trace signal investigator | [f06](features/f06-per-trace-signal-investigator.md) |
| F20 | Zero-config issue detection | [f20](features/f20-zero-config-auto-issue-detection.md) |
| F34 | Trained signal classifiers | [f34](features/f34-trained-signal-classifiers.md) |
| F35 | Default signal library | [f35](features/f35-default-signal-library.md) |

### Issues & fix loop (F28–F30, F21–F23, F22, F46)

| ID | Feature | Spec |
|---|---|---|
| F28 | Agent stumbles | [f28](features/f28-agent-stumbles.md) |
| F29 | Agent issues | [f29](features/f29-agent-issues-sentry.md) |
| F30 | Triage agent | [f30](features/f30-triage-agent.md) |
| F21 | Tool call label learning | [f21](features/f21-tool-call-label-learning.md) |
| F22 | Issue fix GitHub chat | [f22](features/f22-issue-fix-github-chat.md) |
| F23 | Session-first SDK | [f23](features/f23-session-first-sdk.md) |
| F46 | Closed-loop orchestrator | [f46](features/f46-closed-loop-orchestrator.md) |

### Browser, search, runtime (F09, F12, F33–F44, F39–F42)

| ID | Feature | Spec |
|---|---|---|
| F09 | Browser RRWeb recording | [f09](features/f09-browser-session-recording-rrweb.md) |
| F12 | Typesense span search | [f12](features/f12-typesense-span-search.md) |
| F33 | Issue-linked experiments | [f33](features/f33-issue-linked-experiments.md) |
| F39 | Runtime nudge injection | [f39](features/f39-runtime-nudge-injection.md) |
| F40 | The Book agent memory | [f40](features/f40-the-book-agent-memory.md) |
| F41 | Evidence-gated promotion | [f41](features/f41-evidence-gated-promotion.md) |
| F42 | Behavioral drift pinpoint | [f42](features/f42-behavioral-drift-pinpoint.md) |
| F44 | Auto production eval slices | [f44](features/f44-auto-production-eval-slices.md) |

### Platform (F47, F48)

| ID | Feature | Spec |
|---|---|---|
| F47 | Slack Block Kit alerts | [f47](features/f47-slack-block-kit-alerts.md) |
| F48 | Portal API contract fix | [f48](features/f48-portal-api-contract-fix.md) |

---

## 4. N-feature inventory (13)

### Core differentiation (N01–N08)

| ID | Feature | Moat? | Spec |
|---|---|---|---|
| N01 | Production → regression eval | Convergence | [n01](features/n01-production-trace-regression-eval.md) |
| N02 | MCP toolchain observability | Meta | [n02](features/n02-mcp-toolchain-observability.md) |
| N03 | Continuous production eval | Live quality | [n03](features/n03-continuous-production-eval-sampling.md) |
| N04 | Change impact preview | Pre-merge | [n04](features/n04-agent-change-impact-preview.md) |
| N05 | Multi-agent fleet health | Platform | [n05](features/n05-multi-agent-fleet-health.md) |
| N06 | Compliance audit automation | **Unique** | [n06](features/n06-compliance-audit-trail-automation.md) |
| N07 | Environment from failures | **Category** | [n07](features/n07-environment-from-production-failures.md) |
| N08 | StatGate incident response | **Unique** | [n08](features/n08-statgate-incident-delegation-trust.md) |

### Restored high-value (N09–N13)

| ID | Restores | Spec |
|---|---|---|
| N09 | F11 trace dedupe | [n09](features/n09-content-addressed-trace-storage.md) |
| N10 | F36 deep search → signal | [n10](features/n10-deep-search-to-signal.md) |
| N11 | F10 live dev (streaming) | [n11](features/n11-live-trace-streaming.md) |
| N12 | F17 session timeline UI | [n12](features/n12-session-multiturn-timeline-ui.md) |
| N13 | F38 transcript UI v2 | [n13](features/n13-transcript-ui-v2.md) |

---

## 5. Implementation waves

```
Wave 0   F48
Wave 1   F28 → F29 → F20 → F30 → F04 (read) → F47
Wave 2   F03 → F01 → F04 (debug/fix) → F22
Wave 3   F39 → F41 → F40
Wave 4   N02 + N08 + N09 (storage/cost foundation)
Wave 5   N01 + N04 + N03
Wave 6   N05 + N06 + N07
Wave 7   N10 + N11 + N12 + N13 (UX polish)
Capstone F46

Parallel P1: F06, F12, F23, F35, F09, F33, F44, F42, F21, F34
```

---

## 6. Performance & cost (platform-wide)

All features conform to [`PERFORMANCE-COST-STANDARDS.md`](PERFORMANCE-COST-STANDARDS.md):

- Ingest hot path ≤5ms p99 overhead
- LLM cascade: deterministic → SLM → full LLM
- Every LLM feature: daily budget + sampling
- Standard degradation modes and metrics

---

## 7. What Eden has (leverage)

Gateway, ETEC/StatGate, 22 intel cats, evals, EQL, env gen PRD, governance, MCP ingest, GitHub App — see prior analysis in [`eden-competitor-gap-analysis`](../eden-competitor-gap-analysis-laminar-sentrial-raindrop-bento.md).

---

*Last updated: July 9, 2026 — 24 F + 13 N specs, all with performance/cost sections.*
