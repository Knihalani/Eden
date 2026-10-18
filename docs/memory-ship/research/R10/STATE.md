# R10 — research state (re-read at the start of every cycle)

**Last updated:** cycle 1 (2026-10-18). Branch: `claude/r10-retrieval-benchmark-sf1jho` (from `claude/eden-retrieval-research-lna5mi` + `research/r10-retrieval`).

The user's brief is `BRIEF.md`. In short: retrieval "basically perfect"; not only coding; no mundane methods; no local optima; a benchmark that reflects real use. The loop never ends, and this file is its memory. LEDGER.md is the append-only experiment log. LOOKS.md logs every test or holdout look.

## Benchmarks

**Primary: StreamBench** (`benchmarks/memory-stream/`, built cycle 1 to BRIEF §4). Audit of what came before: `REALISM-AUDIT.md`.

| World | Items (oracle) | Sessions | Human turns | Need turns | Non-human share | Triggers | Status |
|---|---|---|---|---|---|---|---|
| `code`: Jordan, acme-platform, 2026-08-17 → 10-23 | 214 (R1's memories, 9 corrections) | 110 | 493 | 69 (14.0%) | 0.45 | — | planned; authoring |
| `life`: Riya (LifeBench world), 2025-04 → 2026-10 | 315 (LifeBench's memories, 37 corrections) | 160 | 697 | 98 (14.1%) | 0.43 | 57 (33 with needs) | planned; authoring |
| `locomo-*` (external anchor, 10 conversations) | 5,882 dialogue turns | 272 + probes | — | 1,540 QA probes with evidence (446 adversarial negatives) | — | — | converted; not committed (CC BY-NC) |

Splits: dev is session index mod 5 ≠ 4, test is mod 5 = 4. Every split shares one continuous store. Holdout: a separately authored stream, not yet written.

**Secondary arms** (pairs; never optimised on alone): R1 CueBench-code, R8 `test_nim`, LifeBench memories (its cue files were never committed: see the audit).

## Pareto frontier (StreamBench dev; per arm)

(empty until the first replay: see "Next three experiments")

## Hypothesis portfolio

Families differ in mechanism. Every kill criterion was written before its run.

| # | Family (mechanism) | Status | Kill criterion |
|---|---|---|---|
| F1 | Lexical incumbent: BM25 over the situation, plus a τ gate (today's product core) | baseline | — |
| F2 | Exemplar retrieval: compiled cue bank (prompt-to-prompt NN) | baseline (R10 WIP) | — |
| F3 | Compositional need predicates: entity × activity, compiled at sleep, dictionary-matched at hook time | live | dead if StreamBench proactive recall is not ≥ F1's + 0.10 at equal human silence, on both worlds |
| F4 | Distilled per-user need model: a sparse classifier per store, trained on sleep-time self-play | live | dead if it does not beat F1 by ≥ 0.05 recall at equal silence and precision on both worlds' dev |
| F5 | Need-existence gate: P(any need \| situation) as a separate silence model, using event class, turn mode and novelty | live | dead if it does not cut false packets on no-need turns by ≥ 30% relative for ≤ 0.02 recall |
| F6 | Value-of-information packet: p(need) × value − token cost − redundancy with the window; silence when ≤ 0 | live | dead if bullet precision gains < 0.05 at equal recall |
| F7 | Write-side admission: store only what can be needed again (statements of fact, preference, plan, rule), not requests or tool echoes | new (cycle 1) | dead if, at the oracle-need ceiling on the write store, recall drops > 0.05 while store rows fall < 50% |
| F8 | Ceilings: oracle-need on the write store and on the oracle store; an LLM judge with the full store | ceiling | — |
| F9 | Downstream-effect labels (does the answer change with vs without the packet) | later | — |
| F10 | Context model: what is already in the window (stated, read, or in instructions) suppresses its bullets | new (cycle 1) | dead if redundancy does not fall by half at ≤ 0.01 recall cost |

## Graveyard

(empty)

## Next three experiments

1. Author both worlds, assemble with zero rule breaks, replay through today's plugin. Score `eden`, F1 and F8 on the write and oracle stores. Decompose Eden's errors into classes (write-path noise, retrieval miss, gate fire, redundancy, stale).
2. F7 write-side admission and F10 context model: the cheapest attacks on the largest error class, if the realism facts hold (89% unneeded bullets).
3. F5 need-existence gate on event class, turn mode and novelty, measured per class (human, non-human, trigger).

## Open items against the realism contract

- §4.7 downstream effect: not built.
- §4.8: LongMemEval is blocked here. The environment's network policy denies huggingface.co and drive.google.com. LoCoMo is converted.
- §4.9 holdout: not written. Fresh red-team cases: not yet.
- Coverage (bullet → item) is mechanical token overlap. Its agreement with a judge is not yet measured.

## Looks at test / holdout

See LOOKS.md. Holdout: never opened. StreamBench test: never scored.
