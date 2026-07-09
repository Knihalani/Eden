# Eden Feature Gap Master Document

> **Date:** July 9, 2026 (revised)  
> **Purpose:** Single source of truth for Eden feature gaps vs competitors — **pruned to high-value specs** + **next-level market hypotheses**.  
> **Granular specs:** [`docs/specs/features/`](features/) — **24 F-features + 8 N-features**  
> **Market research:** [`MARKET-HYPOTHESES.md`](MARKET-HYPOTHESES.md)  
> **Deleted specs:** [`features/DELETED-FEATURES.md`](features/DELETED-FEATURES.md)  
> **Competitor analysis:** [`eden-competitor-gap-analysis-laminar-sentrial-raindrop-bento.md`](../eden-competitor-gap-analysis-laminar-sentrial-raindrop-bento.md)

---

## 1. How to use this document

| If you want… | Go to… |
|---|---|
| What's missing (high-value only) | **Section 3** |
| Next-level differentiation | **Section 4** (N-features) |
| One feature's build spec | `docs/specs/features/fXX-*.md` or `nXX-*.md` |
| Why specs were deleted | [`DELETED-FEATURES.md`](features/DELETED-FEATURES.md) |
| Market thesis | [`MARKET-HYPOTHESES.md`](MARKET-HYPOTHESES.md) |
| Priority / dependency order | **Section 5** |

---

## 2. Executive summary

### Strategic shift (July 2026 revision)

1. **Pruned 48 → 24 F-features** — removed CLI, Workshop, per-framework integrations, and polish specs with low deal impact
2. **F04 refocused as Eden MCP Server** — coding-agent-first interface (Cursor, Claude Code); absorbs deleted F05, F10, F26, F37
3. **Added 8 N-features** — next-level agent maintenance, improvement, observability based on market research

### The gap in one sentence

> Competitors ship **detect → understand → fix → verify** loops with coding-agent-native tooling; Eden has deep backend modules but **critical UX paths are broken, stubbed, or not wired** — and lacks MCP-as-product plus production-to-CI regression flows.

### Three layers

| Layer | Focus | Specs |
|---|---|---|
| **Foundation** | Already shipped — leverage | Gateway, evals, EQL, governance, env gen PRD |
| **Closed loop (parity)** | Stop losing deals | F01, F04, F20, F28–F30, F39, F46, F48 |
| **Next level (win)** | Category leadership | N01, N02, N07, N08 + N03–N06 |

### Counts (revised)

| Status | F-features | Meaning |
|---|---|---|
| **MISSING** | 17 | No shippable product surface |
| **PARTIAL** | 6 | Backend/UI fragment exists |
| **BROKEN** | 1 | F48 — portal calls wrong APIs |
| **N-features (new)** | 8 | Market-hypothesis differentiation |

---

## 3. F-feature inventory (24 surviving)

### 3.1 Debugger & coding-agent interface (F01, F03, F04)

| ID | Feature | Status | Spec |
|---|---|---|---|
| F01 | Cached prefix live debugger | PARTIAL | [f01](features/f01-cached-prefix-live-debugger.md) |
| F03 | Checkpoint ingestion from LLM spans | MISSING | [f03](features/f03-checkpoint-ingestion-from-spans.md) |
| F04 | **Eden MCP Server** (coding-agent-first) | MISSING | [f04](features/f04-eden-mcp-server.md) |

**Plain language:** No cached-prefix live rerun; checkpoints not auto-ingested; **no Eden MCP server** for Cursor/Claude Code. Deleted F05 CLI, F10 local server, F32 Workshop — all subsumed by F04.

**Eden has (fragmented):** Hermetic `ReRunEngine`, Cat 20 `TraceReplayer`, MCP **ingest** only, broken portal debugger.

---

### 3.2 Signals & detection (F06, F20, F34, F35)

| ID | Feature | Status | Spec |
|---|---|---|---|
| F06 | Per-trace signal investigation agent | MISSING | [f06](features/f06-per-trace-signal-investigator.md) |
| F20 | Zero-config automatic issue detection | MISSING | [f20](features/f20-zero-config-auto-issue-detection.md) |
| F34 | Per-org trained signal classifiers | MISSING | [f34](features/f34-trained-signal-classifiers.md) |
| F35 | Default signal library | MISSING | [f35](features/f35-default-signal-library.md) |

**Absorbed:** F07 clusters, F08 backfill → F06 Phase 2. Deleted F36, F43.

---

### 3.3 Issues, triage & fix loop (F28–F30, F21–F23, F22, F46)

| ID | Feature | Status | Spec |
|---|---|---|---|
| F28 | Agent stumbles | MISSING | [f28](features/f28-agent-stumbles.md) |
| F29 | Agent issues (Sentry-style) | MISSING | [f29](features/f29-agent-issues-sentry.md) |
| F30 | Triage agent | PARTIAL | [f30](features/f30-triage-agent.md) |
| F21 | Tool call label learning | MISSING | [f21](features/f21-tool-call-label-learning.md) |
| F22 | Issue fix-in-code GitHub chat | PARTIAL | [f22](features/f22-issue-fix-github-chat.md) |
| F23 | Session-first SDK | MISSING | [f23](features/f23-session-first-sdk.md) |
| F46 | Closed-loop orchestrator | MISSING | [f46](features/f46-closed-loop-orchestrator.md) |

**Absorbed:** F37 run_autofix → F04 `run_autofix` tool.

---

### 3.4 Browser & search (F09, F12)

| ID | Feature | Status | Spec |
|---|---|---|---|
| F09 | Browser session recording (RRWeb) | PARTIAL | [f09](features/f09-browser-session-recording-rrweb.md) |
| F12 | Typesense full-text span search | PARTIAL | [f12](features/f12-typesense-span-search.md) |

**Deleted:** F13–F16 per-framework integrations → F09 + OTel docs.

---

### 3.5 Runtime learning (F39–F42, F44)

| ID | Feature | Status | Spec |
|---|---|---|---|
| F39 | Runtime nudge injection | MISSING | [f39](features/f39-runtime-nudge-injection.md) |
| F40 | The Book agent memory | MISSING | [f40](features/f40-the-book-agent-memory.md) |
| F41 | Evidence-gated promotion | PARTIAL | [f41](features/f41-evidence-gated-promotion.md) |
| F42 | Behavioral drift pinpoint | PARTIAL | [f42](features/f42-behavioral-drift-pinpoint.md) |
| F44 | Auto production eval slices | PARTIAL | [f44](features/f44-auto-production-eval-slices.md) |
| F33 | Issue-linked experiments | PARTIAL | [f33](features/f33-issue-linked-experiments.md) |

**Absorbed:** F45 runtime skill export → F39 §11 repo export.

---

### 3.6 Platform & alerts (F47, F48)

| ID | Feature | Status | Spec |
|---|---|---|---|
| F47 | Slack Block Kit outbound alerts | MISSING | [f47](features/f47-slack-block-kit-alerts.md) |
| F48 | Portal API contract fix | **BROKEN** | [f48](features/f48-portal-api-contract-fix.md) |

**Deleted:** F31 interactive Slack bot (F47 sufficient).

**F48 blockers:**
- Portal `GET /debugger/checkpoints?trace_id=` → Backend expects path param
- Portal `POST /debugger/rewind/{id}` → route missing
- Signals `/compile` mismatch
- `/debugger`, `/signals` not in sidebar

---

## 4. N-feature inventory (8 next-level)

| ID | Feature | Priority | Eden moat? | Spec |
|---|---|---|---|---|
| N01 | Production trace → regression eval | P0 | Eval+obs convergence | [n01](features/n01-production-trace-regression-eval.md) |
| N02 | MCP toolchain observability | P0 | Meta + SEP-414 | [n02](features/n02-mcp-toolchain-observability.md) |
| N03 | Continuous production eval sampling | P1 | Live quality scores | [n03](features/n03-continuous-production-eval-sampling.md) |
| N04 | Agent change impact preview | P1 | Pre-merge safety | [n04](features/n04-agent-change-impact-preview.md) |
| N05 | Multi-agent fleet health | P1 | Platform teams | [n05](features/n05-multi-agent-fleet-health.md) |
| N06 | Compliance audit trail automation | P1 | **Unique** governance | [n06](features/n06-compliance-audit-trail-automation.md) |
| N07 | Environment from production failures | P0 | **Category-defining** | [n07](features/n07-environment-from-production-failures.md) |
| N08 | StatGate incident response | P1 | **Unique** ETEC/StatGate | [n08](features/n08-statgate-incident-delegation-trust.md) |

Full market rationale: [`MARKET-HYPOTHESES.md`](MARKET-HYPOTHESES.md)

---

## 5. Implementation waves (revised)

```
Wave 0 (blocker)       F48 Portal API fix
         │
Wave 1 (P0 loop)       F28 → F29 → F20 → F30
         │                    F04 Eden MCP (read tools first)
         │                    F47 Slack alerts
         │
Wave 2 (debugger)      F03 → F01 → F04 (debug + fix tools)
         │                    F22 fix chat
         │
Wave 3 (learning)      F39 nudges → F41 evidence gate → F40 Book
         │
Wave 4 (observability) N02 MCP fleet + N08 StatGate incidents
         │
Wave 5 (verify)        N01 regression eval + N04 impact preview + N03 prod sampling
         │
Wave 6 (enterprise)    N05 fleet + N06 audit + N07 env gen
         │
Capstone               F46 closed-loop orchestrator
```

**P1 parallel:** F06 signals, F09 RRWeb, F12 search, F23 sessions, F33 experiments, F35 signal library

---

## 6. What Eden has (leverage, don't rebuild)

| Capability | Location | vs competitors |
|---|---|---|
| Gateway + PII + budgets | `gateway.py` | Ahead |
| 22 intelligence categories | intelligence docs | Much broader |
| ETEC + StatGate | trace quality spec | **Unique** — N08 |
| Cat 3 evals / judges | `evaluation/` | Deeper |
| EQL + SQL | Cat 19 | Laminar parity |
| Environment generation PRD | Part VIII | **Unique** — N07 |
| Compliance / SOC2 / RTBF | Cat 10 | Ahead — N06 |
| MCP ingest | `observability_mcp.py` | Seed for N02 |
| GitHub App | `github.py` | F22/F04 autofix |
| Hermetic debugger | `checkpoints.py` | F01 foundation |

---

## 7. Spec file index

### F-features (24)

```
f01-cached-prefix-live-debugger.md    f29-agent-issues-sentry.md
f03-checkpoint-ingestion-from-spans.md f30-triage-agent.md
f04-eden-mcp-server.md                f33-issue-linked-experiments.md
f06-per-trace-signal-investigator.md  f34-trained-signal-classifiers.md
f09-browser-session-recording-rrweb.md f35-default-signal-library.md
f12-typesense-span-search.md          f39-runtime-nudge-injection.md
f20-zero-config-auto-issue-detection.md f40-the-book-agent-memory.md
f21-tool-call-label-learning.md       f41-evidence-gated-promotion.md
f22-issue-fix-github-chat.md          f42-behavioral-drift-pinpoint.md
f23-session-first-sdk.md              f44-auto-production-eval-slices.md
f28-agent-stumbles.md                 f46-closed-loop-orchestrator.md
                                      f47-slack-block-kit-alerts.md
                                      f48-portal-api-contract-fix.md
```

### N-features (8)

```
n01-production-trace-regression-eval.md
n02-mcp-toolchain-observability.md
n03-continuous-production-eval-sampling.md
n04-agent-change-impact-preview.md
n05-multi-agent-fleet-health.md
n06-compliance-audit-trail-automation.md
n07-environment-from-production-failures.md
n08-statgate-incident-delegation-trust.md
```

### Supporting docs

```
MARKET-HYPOTHESES.md
features/DELETED-FEATURES.md
features/SPEC-REVIEW.md
features/README.md
```

---

## 8. Document map

| Document | Role |
|---|---|
| **This file** | Master inventory + waves |
| `MARKET-HYPOTHESES.md` | Market research + N-feature thesis |
| `features/fXX-*.md` | Competitor-parity implementation specs |
| `features/nXX-*.md` | Next-level differentiation specs |
| `features/DELETED-FEATURES.md` | Pruning rationale + merge map |
| `features/SPEC-REVIEW.md` | Cross-feature review |
| `competitor-gaps/` | Superseded competitor-organized specs |

---

*Last updated: July 9, 2026 — 24 F-features + 8 N-features, pruned from 48, MCP-first strategy.*
