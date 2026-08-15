# Eden Production Agent Maintenance — Stand-Out Feature Map

> **Purpose:** How Eden wins on **maintaining and improving** customer agents in production — not just observing them.  
> **Ground truth:** [`CODEBASE-GROUND-TRUTH.md`](CODEBASE-GROUND-TRUTH.md)  
> **Performance:** [`PERFORMANCE-COST-STANDARDS.md`](PERFORMANCE-COST-STANDARDS.md)

---

## 1. The maintenance/improvement stack (five layers)

```
┌─────────────────────────────────────────────────────────────────┐
│ L5 AUTONOMOUS SRE  F46 Orchestrator · N21 Runtime Fix · N20 Code │
│                    N18/N39/N15 Improve · N22 Safety Bounds        │
├─────────────────────────────────────────────────────────────────┤
│ L4 UX        N17 Improvement Cockpit · N13 Transcript · N12 Session│
├─────────────────────────────────────────────────────────────────┤
│ L3 IMPROVE   N15 Eval→Guardrail · F39 Nudge · N19 KB · F40 Book  │
│              F41 Evidence · N01 Regression · N04 Impact Preview   │
├─────────────────────────────────────────────────────────────────┤
│ L2 DETECT    F20/F28/F29 · N08 StatGate · N02 MCP · F06 Signals │
├─────────────────────────────────────────────────────────────────┤
│ L1 ACTIVATE  N14 Platform Wiring · N16 Smart Sampling · N09   │
│              Storage · zstd compression (shipped 15×)             │
├─────────────────────────────────────────────────────────────────┤
│ L0 FIX       F04 MCP · F01 Debugger · F22 Fix · D6/D7/D12 Prove   │
└─────────────────────────────────────────────────────────────────┘
```

**Rules:**
1. Ship **N14 first** — otherwise detect/fix backends are shelfware.
2. **F46 + N21** are the autonomous maintenance core — detect outage → rollback/fix → verify recovery.

---

## 2. Stand-out vs competitors (honest matrix)

| Capability | Laminar | Raindrop | Bento | Eden spec |
|---|---|---|---|---|
| MCP coding-agent interface | ✓ | partial | — | **F04** |
| Issues / stumbles | partial | ✓ | partial | **F28–F30** |
| Runtime nudges | — | — | ✓ | **F39** + StatGate gate |
| Deterministic P0 (no LLM) | — | — | — | **N08** ETEC/StatGate |
| Eval → live guardrail | partial | — | — | **N15** (EvalToGuardrailLink shipped) |
| Prompt auto-evolution + canary | — | — | partial | **N18** (evolver shipped) |
| Prove without clones | partial | — | — | **D6 + D7 + D12** (fixture + regression + session) |
| 80% cost cut w/ failure keep | partial | — | — | **N16** + **N09** |
| Unified maintenance visibility | — | partial | partial | **N17** |
| **Autonomous outage/quality fix** | — | partial | partial | **F46 + N21 + N20** |
| Compliance audit packs | — | — | — | **N06** + shipped compliance |

---

## 3. Cost-reducing architecture (client bill + Eden COGS)

| Spec | Mechanism | Measured / target |
|---|---|---|
| **Shipped** | `storage/compression.py` zstd dict | **15.58×** on LLM JSONB |
| **N16** | Intelligence-aware tail sampling | ~80–92% trace volume reduction |
| **N09** | Content-addressed blob dedupe | 3–20× on repeated prompts |
| **N08/F20** | Deterministic detectors | $0 vs $0.03/trace LLM investigator |
| **F34** | Classifier vs F06 investigator | 100× cost reduction at scale |
| **N03** | SLM cascade + daily budget | Capped prod eval spend |
| **F01** | Cached prefix debugger | Tail-only model cost on rerun |
| **Gateway** | Semantic cache + budgets | Shipped `ai_gateway.py` |

**Combined narrative:** ~**0.03–0.08×** all-in storage/LLM ops cost vs naive full-trace + full-LLM investigation — while **keeping 99%+ failures** (N16 keep rules).

---

## 4. Speed / UX wins (client experience)

| Spec | User-visible win | SLA |
|---|---|---|
| **N08** | P0 incident without waiting for LLM triage | <200ms |
| **F04 MCP** | Debug from Cursor without portal | read p95 <800ms |
| **F01** | 50-step prefix replay | p95 <2s |
| **N11** | Live trace tail during run | <500ms step visibility |
| **N17** | One queue for all improvement work | page p95 <800ms |
| **F48** | Debugger/signals pages actually load | fix 404s |
| **N13** | 50-step transcript virtualized | first paint <1s |
| **F12** | Sub-200ms search | p95 target |

---

## 5. Recommended build order (maintenance-focused)

```
0. N14 Platform Activation     ← unblock everything
1. F48 Portal fix
2. F28 → F29 → F20 → N08      ← detect ($0 LLM P0)
3. N16 Sampling + N09 Dedupe   ← cost architecture early
4. F04 MCP read tools
5. N17 Cockpit (read-only v1)  ← UX on existing hooks
6. F30 → F22 → N01 → N04       ← fix + verify loop
7. N15 Eval→Guardrail + F39    ← improve in production
8. N18 Prompt evolution
9. N22 Safety bounds (before broad auto-merge)
10. N20 Code fix + D6 fixture export + D7 regression memory
11. N19 KB flywheel
```

---

## 6. Full spec index (45 features)

**F:** 24 parity specs · **N:** N01–N06, N08–N22 differentiation + autonomous specs (N07 removed)

See [`FEATURE-GAP-MASTER.md`](FEATURE-GAP-MASTER.md) and [`AUTONOMOUS-MAINTENANCE.md`](AUTONOMOUS-MAINTENANCE.md).

---

*Last updated: July 9, 2026 — codebase audit pass.*
