# R10 — research state (re-read at the start of every cycle)

**Last updated:** cycle 0 (2026-10-18). Branch: `claude/eden-retrieval-research-lna5mi` (from `research/r10-retrieval`).

The user's brief (2026-10-18): retrieval "basically perfect… exactly what's needed every and all the time without much unnecessary stuff"; not only coding agents; no mundane methods; no local optima. The loop never ends; this file is its memory. LEDGER.md is the append-only experiment log; LOOKS.md logs every test/holdout look.

## Benchmarks

| Fixture | Memories | Cue sets | Notes |
|---|---|---|---|
| `code` (R1 CueBench-code + R8 test_nim) | 214 (205 live) | R1 dev 333 / test 333; R8 test_nim 558 | R8 negatives were tuned on in P4.3: not held out |
| `life` (LifeBench, `benchmarks/memory-life/`) | 315 (278 live) | dev 330 (author D) / test 330 (author T) / sealed holdout 210 (author H) | built cycle 0; all authors Claude subagents, distinct instances |

Protocol (`benchmarks/r10/common.py`): thresholds tuned on dev only at FIR ≤ 5% (and the strict 0% point); test scored only when a candidate earns it, logged in LOOKS.md. Methods may learn per-memory information only from the store and the sleep compiler's artifacts, never from dev cue text (dev and test cues share the store).

## Pareto frontier (dev unless marked)

| Method | Fixture | r@4 | full | prec | FIR | stale | proactive r@4 | p50 ms |
|---|---|---|---|---|---|---|---|---|
| bm25ctx (incumbent) | code dev, cap 5% | 0.567 | 0.563 | 0.748 | 0.043 | — | — | 0.18 |

## Hypothesis portfolio

| # | Family (mechanism) | Status | Kill criterion (written before running) |
|---|---|---|---|
| F1 | Lexical incumbent: BM25F on the situation + τ gate | baseline | — |
| F2 | Exemplar retrieval: compiled cue bank (prompt-to-prompt NN + near-miss margin) | baseline (R10 WIP) | — |
| F3 | Compositional need predicates: entity × activity compiled at sleep, matched by dictionary at hook time | live | dead if on life dev its proactive r@4 is not ≥ F1's + 0.10 at equal FIR, or code dev r@4 drops > 0.05 below F1 |
| F4 | Distilled per-user need model: sparse linear classifier per memory trained on compiler self-play | live | dead if it does not beat F2 by ≥ 0.03 r@4 at equal FIR on both fixtures' dev |
| F5 | Need-existence gate: P(any memory needed \| situation) as a separate silence model | live | dead if, on top of the best scorer, it does not cut FIR by ≥ 30% relative for ≤ 0.02 r@4 |
| F6 | Value-of-information packet: calibrated p(need) × value − token cost − redundancy; silence when ≤ 0 | live | dead if bullet precision gains < 0.05 at equal r@4 |
| F7 | Priming / spreading activation over an entity–memory graph across turns | waiting for multi-turn cues | dead if no gain on multi-turn cues over F1+context |
| F8 | Ceiling: LLM judge with the full store (oracle) | ceiling, not a candidate | — |
| F9 | Downstream-effect labels (does the answer change with vs without the memory) | later | — |

## Graveyard

(empty)

## Next three experiments

1. Baselines F1/F2 on life dev; F3/F4 once the sleep compiler's artifacts land.
2. F8 oracle ceiling on dev (a judge subagent labels each cue against the full store); decompose errors.
3. F5 need-existence gate stacked on the best scorer.

## Looks at test / holdout

See LOOKS.md. Holdout: never opened.
