# M35.2 Savings + harmed

**Date:** 2026-09-22
**Bun:** 1.3.13
**Report:** §11.2 — AMA-Bench tool traces [arxiv:2602.22769]; MemoryBench humility (memory can be zero lift or harm). Live wrap+hook ledger is M47 (`HELP.md`), not this file.
**API:** hook inject (`respondToHook` / `memoryHookResponse` + `openMemory`). Not BrainMemory. Not `memory_search`.
**k:** product default (`EDEN_MEMORY_CAP` unset → 6). Not k=40. Not hay. Not LoCoMo 92.
**Control:** `EDEN_MEMORY=0` (consent off → empty inject). On arm: `EDEN_MEMORY` unset (consent on). Ranker not retuned. M38 omit was not implemented.

**Totals:** helped 9 / no-lift 1 / harmed 0

Counted rows are on vs off only. Harmed is 0 because no measured on-arm put sqlite/Clerk on a math cue, and the Terminal-Bench on-arm junk count is 0. That is a count, not a target. Uncontrolled exams below are not in the totals and are not helped.

## Counted (on vs off)

Measured 2026-09-22 unless noted. Holdout on-arm matches `RESULTS.md` Gate 1 WIN 8 / LOSS 0 / FAIL 0 (2026-09-22): gold needles in `additionalContext`. Off arm was run here and was not written back into `RESULTS.md`. Off `additionalContext` was empty on all 8 cases (holdout’s own label for empty inject is FAIL). On-arm text repeated the `Eden Memory:` block twice; needles still matched. Not retuned.

| case | class | on | off | Δ | control | notes |
|---|---|---|---|---|---|---|
| holdout flake | helped | gold: auth.test.ts; flake | empty | needles on only | EDEN_MEMORY=0 | cue asks which file flaked |
| holdout adr | helped | gold: Clerk | empty | needles on only | EDEN_MEMORY=0 | paraphrase cue “what auth provider?” |
| holdout file-rule | helped | gold: tests; before committing | empty | needles on only | EDEN_MEMORY=0 | commit-shaped cue |
| holdout version | helped | gold: Node 18; Node 16 absent; CI kept | empty | needles on only | EDEN_MEMORY=0 | newest fact only |
| holdout junk | helped | gold: postgres; session store; chatter absent | empty | needles on only | EDEN_MEMORY=0 | asdf/qwerty/lol/thanks not in inject |
| holdout test-exit | helped | gold: exit code 1; test_refresh_token; AMA-NEEDLE:EXIT_NONZERO=1 | empty | needles on only | EDEN_MEMORY=0 | §11.2 AMA tool trace |
| holdout git-sha | helped | gold: c3f8a91b2e4d7a0c5b6e8f1a3d9c2e7b4a1f6c80; AMA-NEEDLE:GIT_SHA | empty | needles on only | EDEN_MEMORY=0 | §11.2 AMA tool trace |
| holdout flake-log | helped | gold: test_concurrent_login; failed 2 of 7; FLAKE-SIG:auth-race-token-reuse | empty | needles on only | EDEN_MEMORY=0 | §11.2 AMA tool trace |
| silent-math | no-lift | empty | empty | 0 | EDEN_MEMORY=0 | five facts stored, including sqlite and Clerk; cue “What is 17 times 23?” injected none. Same store, cue “what database do we use?” did inject sqlite (store was live). Not harmed. |
| TB 2.1 subset | helped | 50.0% Harbor mean | 40.0% | +10.0 pp | EDEN_MEMORY=0 | `benchmarks/terminal-bench/RESULTS.md` 2026-09-21. n=2 tasks, k=5, not the 89-task board. Tokens total +26941 (167167 → 194108). On-arm silence empty/junk/on_cue/no_inject = 0/0/5/5. Absolute % is terminus-2. |

`M15-EVIDENCE.md` still freezes an older Harbor Δ of −20.0 pp (on 10.0% vs off 30.0%) and calls that run infrastructure, not a memory win. It is not averaged into the row above.

## Not counted (no no-memory control)

These are published inject scores. None has an `EDEN_MEMORY=0` arm. A WIN against another system, or against an older Eden lock, is not helped.

| exam | published | comparator | why it is not helped |
|---|---|---|---|
| Table 3 overall (M15 lock) | 30.0 | HippoRAG-v2 41.6 | LOSS. `M15-EVIDENCE.md` 2026-09-19. No off arm. |
| Table 3 overall (`TABLE3-RESULTS.md`) | 44.8 | HippoRAG-v2 41.6 | Competitor row, not a no-memory lift. No `EDEN_MEMORY=0` arm. Not helped. |
| EventQA 534k | 64 | BM25 74.6 | LOSS. `EVENTQA-M18.md` 2026-09-19. WIN vs M15 56 is not a no-memory lift. |
| FC-SH 262k | 60 | assembly paper 82 | LOSS. `FC-SH-M21.md` 2026-09-20. WIN vs M15 54 is not a no-memory lift. |
| LME-V2 Small | 3.5% (16/451) | RAG 42.8; AgentRunbook-C 74.9 | LOSS. `benchmarks/lme-v2/RESULTS.md` 2026-09-20. The baseline column is prior Eden runs (M15 2.7%, diagnostic ~3.5%), not `EDEN_MEMORY=0`. |

## Construction traps

Not helped rows:

- Memorable 454/454 is a fixture-completion score, not this inject exam.
- Mem0 92 (LoCoMo 92) is not an Eden on-vs-off result.

No BrainMemory column. No cortex-off column. No k=40. No hay. No `memory_search`. Fail-open and silent inject stay as they are. Harmed note ids are not wired into inject (that is M47.2).

## CI

`bun test benchmarks/memory-holdout/savings.test.ts`

The live scan fails when a product `RESULTS` file under `benchmarks/memory-holdout/`, `benchmarks/memoryagentbench/`, `benchmarks/lme-v2/`, or `benchmarks/terminal-bench/` claims lift, Gate-1 `WIN`, or `+N pp` without a no-memory control (`off`, `EDEN_MEMORY=0`, `no-memory`). Bare `baseline` / `Δ` / `control` tokens do not count. `WIN vs HippoRAG` is a competitor comparison, not a no-memory lift. Denials (`No EDEN_MEMORY=0 arm`) are not a control. `cortex-off` does not count as off. Autopsy `SOTA-GAP-REPORT.md` and evidence-lock files that disclose protocol are skipped. Counted rows in this file name `EDEN_MEMORY=0`.

Holdout `RESULTS.md` names the M35.2 `EDEN_MEMORY=0` off arm. `TABLE3-RESULTS.md` is a competitor row (44.8 vs 41.6), not a no-memory lift. `benchmarks/lme-v2/RESULTS.md` LOSS vs RAG is not helped (prior-Eden `baseline` is not an off arm). `benchmarks/terminal-bench/RESULTS.md` names `EDEN_MEMORY=0` and Δ.
