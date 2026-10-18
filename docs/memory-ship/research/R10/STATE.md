# R10 — research state (re-read at the start of every cycle)

**Last updated:** end of cycle 1 (2026-10-18). Draft PR: https://github.com/Knihalani/Eden/pull/149. Branch: `claude/r10-retrieval-benchmark-sf1jho` (from `claude/eden-retrieval-research-lna5mi` + `research/r10-retrieval`).

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

Human turns, plan labels; 95% bootstrap CIs in LEDGER. All numbers are from LEDGER C1-E2…E6.

**code** (55 need / 336 no-need dev human turns):

| Point | Method | Store | Recall | Proactive | Precision | Human silence | Non-human silence | Tokens |
|---|---|---|---|---|---|---|---|---|
| incumbent | eden (the plugin today) | write | 0.091 | 0.077 | 0.006 | 0.104 | 1.0 | 61.7 |
| frontier | bank τ=0.2 ∧ lex+when ltau=2, gate (strict) | sleep | 0.388 | 0.231 | 0.045 | 0.470 | 1.0 | 88.8 |
| frontier | bank τ=0.2, gate (strict) | sleep | 0.415 | 0.308 | 0.033 | 0.310 | 1.0 | 125.7 |
| frontier | bank ∧ ltau=4 (strict) | sleep | 0.318 | 0.154 | 0.048 | 0.560 | 1.0 | 66.4 |
| ceiling | judge (opus), 165-event sample | sleep | 0.842 | 0.769 | 0.237 | 0.509 | 0.70 | 81.8 |
| ceiling | oracle-need (strict) | sleep | 0.915 | 0.846 | 1.0 | 1.0 | 1.0 | 10.4 |

**life** (oracle and sleep stores scored; write-path replay running):

| Point | Method | Store | Recall | Proactive | Precision | Human silence | Trigger recall | Tokens |
|---|---|---|---|---|---|---|---|---|
| frontier | lex τ=8, when=1, gate | sleep | 0.270 | 0.087 | 0.022 | 0.320 | 0.115 | 112.6 |
| ceiling | oracle-need | sleep | 0.846 | 0.783 | 1.0 | 1.0 | 1.0 | 8.4 |

The life world is far harder: proactive recall below 0.1, and trigger recall about 0.1. The sleep compiler there misses 15% of the needed items.

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
| F11 | LLM write path at sleep with `when` cues (SLEEP-SPEC) | **alive** (C1-E2, E6): proactive 0.08 → 0.31 strict | dead if, under strict visibility on both worlds, recall does not beat lex on the same store by ≥ 0.05 |
| F12 | Habituation (a row's own score history) | weak (C1-E2): silence +0.05–0.13 at a recall cost | kept only as a feature for F4/F5 |
| F4 | Self-play exemplar bank (haiku exemplars, near-miss margin) | **frontier** (C1-E6) | passed on code; must pass on life |
| F13 | Agent-pull memory: the host model calls `recall()` against a one-line memory index; the hook never injects (critic D1) | new | dead if it calls on > 25% of no-need human turns, or recall < 0.38 on the judge sample |
| F14 | Negative-history pruning: cues common in the user's own past (mostly no-need) turns are removed, with `unless` features (critic D2) | new | dead if silence does not rise ≥ 0.20 absolute at recall ≥ 0.30 |
| F15 | Situation tracking: slots (path prefix, command verb, package, person, next event) from tool calls and triggers; fire on a slot *change* into a keyed value (critic D3) | new | dead if proactive + action recall < 0.30 or human silence < 0.60 |

## Graveyard

- **Lexical τ gating as the silence decision** (C1-E2). AUC 0.66–0.70 for need vs no-need on realistic streams, so no τ gives both silence and recall. Lexical evidence survives only as one input to an AND or a learned gate.
- **F12 habituation as a row gate** (C1-E2). Silence 0.125 → 0.18–0.26 at a recall cost. Some row always clears its own bar. Revisit only per situation (F15).

## Next three experiments

1. **Benchmark v1.1, from the critic's fixes, before any further frontier claim:**
   - a judge check of the coverage rule (κ on 200 bullets; split composite rows);
   - a length-calibrated stream (p50 about 12 words, ≥ 20% of prompts ≤ 3 words) by a rewrite author on a different model;
   - adjudication of the 224 labeler-only items with a downstream-effect check (§4.7).
2. **F4 + F11 on the life world** (self-play for its 611 sleep rows), and Eden's life replay. A frontier point must hold on both worlds.
3. **F14 negative-history pruning, and F15 situation tracking:** the two silence mechanisms that are not lexical. In parallel, F13 agent-pull on the judge sample, as a blank-slate challenger.

## Open items against the realism contract

- §4.7 downstream effect: not built.
- §4.8: LongMemEval is blocked here. The environment's network policy denies huggingface.co and drive.google.com. LoCoMo is converted.
- §4.9 holdout: not written. Fresh red-team cases: not yet.
- Coverage (bullet → item) is mechanical token overlap. Its agreement with a judge is not yet measured.

## Looks at test / holdout

See LOOKS.md. Holdout: never opened. StreamBench test: never scored.
