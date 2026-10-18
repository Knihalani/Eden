# R10 — research state (re-read at the start of every cycle)

**Last updated:** cycle 3 in progress (2026-10-18). Draft PR: https://github.com/Knihalani/Eden/pull/149. Branch: `claude/r10-retrieval-benchmark-sf1jho` (from `claude/eden-retrieval-research-lna5mi` + `research/r10-retrieval`).

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

Human turns, plan labels, coverage v2, strict (leak-free) sleep visibility. 95% CIs in LEDGER (C2-E2, E5, E6, E7, E8). Full-dev numbers come from 391 code / about 450 life human events; pull and judge come from the judge sample (165 code, 187 life human events).

**code**

| Point | Method | Recall | Proactive | Precision | Silence | Tokens |
|---|---|---|---|---|---|---|
| incumbent | eden (plugin today, write store) | 0.091 | 0.077 | 0.006 | 0.104 | 61.7 |
| hook frontier | bank τ .2 ∧ lex+when ltau 2 | 0.327 | 0.154 | 0.040 | 0.470 | 88.8 |
| hook frontier | vote (bank, lex, situation; strip) | 0.321 | 0.231 | 0.041 | 0.521 | 75.8 |
| pull point (same events, C3-E1) | F13 agent-pull k=2 (sample); fails its 25% call line on code (28.2%) | 0.467 | 0.231 | 0.203 | 0.736 | ≈146 with the index |
| ceiling | judge (sample) | 0.691 | 0.462 | 0.255 | 0.636 | 65.0 |
| ceiling | oracle-need (strict sleep) | 0.824 | 0.615 | 1.0 | 1.0 | 9.3 |

**life**

| Point | Method | Recall | Proactive | Precision | Silence | Trigger recall | Tokens |
|---|---|---|---|---|---|---|---|
| incumbent | eden | 0.044 | 0.044 | 0.003 | 0.050 | 0.0 | 74.5 |
| hook frontier | bank τ .2 ∧ lex+when ltau 4 | 0.203 | 0.087 | 0.031 | 0.517 | 0.115 | 64.6 |
| **pull frontier** | F13 agent-pull k=2 (sample) | **0.287** | **0.217** | **0.168** | **0.843** | 0.192 | 39.6 |
| ceiling | judge (sample) | 0.570 | 0.522 | 0.239 | 0.648 | 0.50 | 66.9 |
| ceiling | oracle-need (strict sleep) | 0.667 | 0.652 | 1.0 | 1.0 | 0.923 | 5.7 |

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
| F13 | Agent-pull memory: the host model calls `recall()` against a one-line memory index; the hook never injects (critic D1) | **dead on code by its kill line** (C3-E1: 28.2% calls on no-need); passes on life (16.7%). Its call gate survives as a teacher (F16) |
| F16 | Distil the call gate into a hook-side need model: a per-user student on strip length, ask form, session novelty, index-entity hits and event class; the teacher is the pull or judge decision (critic C2 D1) | **dead** (C3-E2): AUC 0.63–0.67 cross-world | dead if AUC vs plan labels < 0.80, or silence < 0.70 at recall ≥ 0.30 on code |
| F17 | Prospective-memory agenda: at sleep, compile intentions with conditions (time window, person, place, plan step); the trigger lane checks conditions and does no retrieval (critic C2 D2) | new | dead if life trigger recall < 0.50 or > 20% of trigger negatives get a packet |
| F19 | Static word-vector semantics on the hot path (spaCy md vectors × self-play exemplars) | **dead** (C3-E3): need-detection AUC 0.66 code, 0.62 life | — |
| F18 | Conflict-triggered injection: the host drafts without memory, Eden injects only rows the draft contradicts or omits on a tracked slot (critic C2 D3) | new | dead if recall < 0.30 on need turns or > 10% of no-need turns get a packet | dead if it calls on > 25% of no-need human turns, or recall < 0.38 on the judge sample |
| F14 | Negative-history pruning: cues common in the user's own past (mostly no-need) turns are removed, with `unless` features (critic D2) | **dead** (C2-E1) | dead if silence does not rise ≥ 0.20 absolute at recall ≥ 0.30 |
| F15 | Situation tracking: slots (path prefix, command verb, package, person, next event) from tool calls and triggers; fire on a slot *change* into a keyed value (critic D3) | dead standalone (C2-E3); kept as a vote | dead if proactive + action recall < 0.30 or human silence < 0.60 |

## Graveyard

- **Lexical τ gating as the silence decision** (C1-E2). AUC 0.66–0.70 for need vs no-need on realistic streams, so no τ gives both silence and recall. Lexical evidence survives only as one input to an AND or a learned gate.
- **Cheap hook-side need detection, any mechanism** (C2–C3: lexical, exemplar, situation, distilled gate, static vectors). AUC caps at 0.62–0.70 on both worlds. Revisit only with a new *kind* of signal: a model in the loop, or sleep-time anticipation of the situation.
- **F14 negative-history pruning** (C2-E1). It only moves along the frontier: +0.09 silence at recall ≥ 0.30.
- **F15 situation entry, standalone** (C2-E3). Proactive 0.08.
- **Hand-built evidence combinations** (C2-E4). They plateau at about 0.30 recall and 0.5–0.6 silence.
- **F12 habituation as a row gate** (C1-E2). Silence 0.125 → 0.18–0.26 at a recall cost. Some row always clears its own bar. Revisit only per situation (F15).

## Next three experiments

1. **Cycle 3 = blank slate (rule 3).** Design a complete system from scratch without looking at the current best, then compare it with the pull frontier on both worlds.
2. **Pull, second stage:** better retrieval after the call (rerank with exemplars and cues, or a second model step), and a push lane for high-precision items (rules on actions, corrections). Target: the judge's recall at the pull's silence.
3. **Benchmark v1.1:**
   - length-calibrated prompts;
   - per-session leak-free sleep, to remove the strict delay (life ceiling 0.67);
   - a life labeler run;
   - the downstream-effect check (§4.7) to settle label strictness.

## Cycle 3 findings so far (LEDGER C3-E1…E5)

- Corrections from critic C2:
  - on the same events, pull is 2.5× precision and +0.18 silence (code);
  - F13 fails its kill line on code (28.2% calls on no-need turns);
  - its cost is about 146 tokens per turn with the index.
- **Downstream effect (C3-E4):**
  - memory changes the outcome on 80% of plan-need turns (+0.97 on 0–3);
  - labeler-only needs are half real (+0.53);
  - **a wrong packet costs −0.40 on no-need turns;**
  - a hook-side packet keeps about 30% of the available benefit.
- **Incumbent with P4.3's gate on (C3-E5):** silence 0.21. It still fires on 79% of no-need turns, against the real 31%.

## Open items against the realism contract

- §4.7 downstream effect: not built.
- §4.8: LongMemEval is blocked here. The environment's network policy denies huggingface.co and drive.google.com. LoCoMo is converted.
- §4.9 holdout: not written. Fresh red-team cases: not yet.
- Coverage (bullet → item) is mechanical token overlap. Its agreement with a judge is not yet measured.

## Looks at test / holdout

See LOOKS.md. Holdout: never opened. StreamBench test: never scored.
