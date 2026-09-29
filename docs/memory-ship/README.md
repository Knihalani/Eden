# Memory ship pack

**Start here:**
- [PROGRESS.md](./PROGRESS.md): what is done and what is next. Run `/next` in Claude Code to advance it.
- [ROADMAP.md](./ROADMAP.md) (v2, 2026-09-29): the build order.
- [DECISIONS.md](./DECISIONS.md): every choice and the evidence behind it.

| Doc | Role |
|---|---|
| [ROADMAP.md](./ROADMAP.md) | Phases, slices, sizes, gates; the minimal viable delivery |
| [DECISIONS.md](./DECISIONS.md) | Decision register D1–D37 (D37: offline models via NVIDIA NIM), locks L1–L8, execution decisions X1–X12 (by reference), earn-in backlog. **Decides all conflicts** |
| [EXECUTION.md](./EXECUTION.md) | How it is built: Day-0 reset, slice lifecycle and definition of done, eval discipline and statistics, flags + shadow + staged rollout, optimization-loop policy, NIM model per job, data governance, migration, calendar, risks |
| [A4-DELIVERY-CONTRACT.md](./A4-DELIVERY-CONTRACT.md) | Normative design v2: identity, scope, kinds, ledger, delivery points, sleep, restatement |
| [A7-CUES.md](./A7-CUES.md) | How cues work beyond word overlap: situation cue, slots, compiled triggers, action-time cues, learned bridges, gate |
| [A5-EVALUATION.md](./A5-EVALUATION.md) | Oracle-based metrics, harness v2, arms, ship rule |
| [A6-TRUST-AND-SAFETY.md](./A6-TRUST-AND-SAFETY.md) | Authority, paste stripping, secrets, declarative wording, guard safety, forgetting |
| [A1-ADVERSARIAL-REVIEW.md](./A1-ADVERSARIAL-REVIEW.md) | First review of EDEN-MEMORY.md against code (defects D1–D17) + code map |
| [A2-TECHNICAL-CHOICES.md](./A2-TECHNICAL-CHOICES.md) | Technical choices vs 2024–2026 SOTA; 1M-row measurements; competitor matrix (citation-audited) |
| [A3-NATURE.md](./A3-NATURE.md) | Biological mechanisms as specs (citation-audited) |
| [research/](./research/) | Evidence: R0 hook facts (verified against raw doc snapshots in `research/sources/`) · R1 cue experiment (+ Addendum A, policy triggers) · R2 cue architecture · R3 review of v1 docs (real transcripts) · R4 citation audit · R5 scope on 19 repos · R6 real usage · R7 consistency audit of the v2 set (all S0/S1 fixes applied) · R8 NIM re-run (strong-model held-out cues, aliases, extraction, poisoning screen, 1B embedder) · R9 execution-methodology research |
| [EDEN-MEMORY.md](./EDEN-MEMORY.md) | Prior working doc: its measurements (§9) are still accurate; its plan is superseded |

**Precedence:**
- DECISIONS decides.
- A4 and A7 specify.
- ROADMAP orders.
- A1–A3 and research/ are evidence.
- EDEN-MEMORY is history.

Superseded earlier drafts (do not extend): [01-SHIP-AND-SOTA.md](./01-SHIP-AND-SOTA.md), [02-LONG-HORIZON.md](./02-LONG-HORIZON.md), [03-BUILD.md](./03-BUILD.md).

**Benchmarks:**
- Long horizon: `bun benchmarks/memory-long-horizon/run.ts`.
- Cues: `benchmarks/memory-cues/` (CueBench-code fixture + scripts; `policy_trigger.py`).
- Scope: `benchmarks/memory-scope/`.
