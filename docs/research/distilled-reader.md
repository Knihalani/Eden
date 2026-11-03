# The distilled reader: a no-model cascade in front of the ask-time reader

Status: 2026-11-03. **Rejected (D104).** Lab only, simulated data. Every number below comes from a command run in
this session. Spend: $1.30 on Anthropic (Haiku 5.5, the experiment's spend ledger, cap $5) and $0.03 on OpenRouter
(glm-5.3-flash cards).

## Summary

- **The question.** Can a local scorer answer the reader's relational question ("does this candidate bind this
  request?", D95/D96) for the requests it is sure of, so the paid reader runs only on the rest? The bar (pre-registered
  below, before the blind run): hidden surfaced at least NEW's − 2 points with at least 1.5× fewer reader calls.
- **Labels.** Haiku 5.5 read every request of the six train suites (train1–6, seeds 41–44) inside NEW, as it does in
  production. That gave 1,417 reader calls and 30,924 (request, candidate) pairs, 1,180 of them binding.
  - The scorer: 150 boosted depth-3 trees over 38 features. The features are the candidate's card fields (kind,
    actions meeting the request, entities, dates against the day, limit) and cheap text counts (overlap, names,
    resolved and constraint words, money, age, source, pool position).
  - Shipped as constants: no dependency, 0.6–0.7 ms per call.
- **It ranks candidates well and cannot do the part that matters.**
  - Leave-one-suite-out AUC on pairs: 0.864 (folds 0.784–0.932).
  - Planted hidden item against its decoy: AUC **0.544**. The decoy is the same record with the constraint lifted,
    about another account, or already met, and word counts cannot tell them apart. That is the same wall the rule
    tracks hit (broad-set.md) and the scratch scorer of the 2026-11-03b audit hit (AUC 0.512).
- **Train CV** (each suite scored by the model fitted without it; the reader replayed):
  - At the cut allowed by the loss limit, the cascade decided 35 of 1,417 calls (**1.03× fewer reader calls**).
  - Forced to 1.5×, hidden fell 4.6 points and decoys rose 6.1.
- **Blind** (held-out 10–11, seeds 41–42, once):
  - hidden 82 → 82 of 128;
  - decoys 49 → 52 (+2.3 points);
  - reader calls 169 → 155 (**1.09×**), about 6% of the reader's cost.

  It fails the call bar and the decoy guard.
- **Why the ceiling is low here as well.**
  - The reader binds nothing on 46% of train calls, so a perfect "silent" gate could save at most 1.85×.
  - Those calls are almost all control tasks (537 of 707 control calls against 113 of 710 hidden calls). Telling them
    apart is again planted against decoy.
  - A silent answer also loses the reader's rejections, which `askReaderDrop` uses to drop lookalikes. So a cascade
    raises decoys even when it loses no hidden item.

## Pre-registered bar (written and committed before the blind run, commit 5c8937f)

The blind check runs once, on held-out 10 and 11, seeds 41–42 (128 hidden and 128 control tasks), with the scorer,
its thresholds and its features frozen from train. Held-out 12 and 13 are not run. Nothing is tuned after it.

- **Configuration under test:** NEW (D98) with `askReaderWaitMs` 60,000 (as haiku-opt.md, so latency does not decide
  what is read), with the reader behind the cascade (`--distill cascade:model.json`). Escalated calls go to Haiku 5.5
  (replayed from the NEW run's reader cache where the prompt is the same, live otherwise).
- **Baseline:** NEW, same settings, reader on every call, same suites and seeds, run in the same session.
- **Adopt behind a flag only if both hold:**
  1. hidden surfaced (delivered or ask-cited) ≥ NEW's − 2 points;
  2. reader calls ≤ NEW's / 1.5 (escalation rate ≤ 66.7% of the reader calls NEW makes).
- **Reported whatever happens:** decoys surfaced against NEW (a rise above +2 points is reported as a failure of
  precision even if 1 and 2 hold), local-silent and local-bind counts, and the implied reader cost and latency saving.
- Otherwise the direction is recorded as rejected.

## Setup

- **Harness:** the no-model funnel (`hidden-funnel.ts --ask`) with NEW and `askReaderWaitMs` 60,000. Cards are the
  checked-in caches plus `cards-train-4344.jsonl`: 315 glm-5.3-flash cards for the seed 43–44 train items the others
  lack, $0.016. Intent requests were made with Haiku for the train worlds and held-out 10–11 (1,004 calls, $0.36;
  committed as `packages/sim/lab/distilled/intent-v2.jsonl.gz`).
- **The seam:** `DistilledReaderMaker` (`packages/sim/src/lab/distilled-reader.ts`) implements the engine's
  `ReaderMaker`. The engine builds, gates and caches the reader's pool as in production, and `packages/engine` is
  unchanged. Three modes, through `--distill`:
  - `record:FILE` calls the real reader and records each call;
  - `labels:LABELS,OUT` replays the committed labels at $0;
  - `cascade:MODEL` decides confident calls locally and escalates the rest.
- **Decisions the scorer may make:**
  - *silent*: the best candidate scores below `silent`, and the call answers "nothing binds";
  - *bind*: exactly one candidate is above `silent` and it is at or above `bind`, and the call flags it as `changes`
    with no bearing.
  - Thresholds are chosen on out-of-fold scores only. `silent` is the largest cut that loses at most 1% of the hidden
    tasks whose planted item the reader flagged; `bind` is the smallest cut at which local binds agree with the reader
    95% of the time on at least 20 calls.
- **Labels:** a pair is positive when the reader named the candidate in `bears`. All 1,417 calls were readable.

## Results

### What the reader said on train (1,417 calls, seeds 41–44)

| Planted variant | Calls | Planted item in pool | Reader flagged it | Reader bound nothing |
|---|---|---|---|---|
| hidden | 710 | 587 | 538 | 113 |
| control (decoy) | 707 | 568 | 57 | 537 |

### The scorer, leave-one-suite-out

| Fold | train1 | train2 | train3 | train4 | train5 | train6 | all (out of fold) |
|---|---|---|---|---|---|---|---|
| Pair AUC | 0.920 | 0.798 | 0.920 | 0.784 | 0.843 | 0.932 | 0.864 |

- Planted hidden item against planted decoy, where the pool held it: AUC 0.544 over 1,155 calls.

The silent cut against what it would lose (out of fold, 644 hidden tasks with a reader call, 489 with the planted item
flagged):

| Silent cut | Calls decided silent | The reader had bound something | Flagged hidden tasks lost |
|---|---|---|---|
| 0.0370 | 14 (1.0%) | 5 | 4 |
| **0.0503 (chosen)** | **35 (2.5%)** | 7 | 6 |
| 0.0798 | 99 (7.0%) | 26 | 15 |
| 0.1006 | 171 (12.1%) | 67 | 35 |
| 0.1862 (the 1.5× point) | 475 (33.5%) | 218 | 133 |
| 0.2533 | 739 (52.2%) | 358 | 226 |

Local binds never reached the precision bar:
- at a cut of 0.5, 20 binds of which 11 (55%) agreed with the reader, 7 of them on the planted decoy;
- at 0.9, one bind.

`bind` is therefore off.

### Train CV in the funnel (seeds 41–44, 768 hidden and 768 control tasks, fold models, reader replayed)

| Configuration | Hidden surfaced | Decoys surfaced | Reader calls | Decided locally | Fewer calls |
|---|---|---|---|---|---|
| NEW | 583 (75.9%) | 306 (39.8%) | 1,417 | | |
| Cascade, chosen cut | 579 (75.4%) | 314 (40.9%) | 1,382 | 35 silent | 1.03× |
| Cascade, cut 0.1862 | 548 (71.4%) | 353 (46.0%) | 941 | 477 silent | 1.51× |

### Blind: held-out 10–11, seeds 41–42 (once, frozen model)

| Configuration | Hidden surfaced | Decoys surfaced | Reader calls | Decided locally | Reader $ as made |
|---|---|---|---|---|---|
| NEW | 82 / 128 (64.1%) | 49 / 128 (38.3%) | 169 | | $0.0520 |
| Cascade | 82 / 128 (64.1%) | 52 / 128 (40.6%) | 155 | 14 silent | $0.0486 |

Against the bar:
- hidden: +0.0 points, which passes;
- reader calls: 1.09× fewer, which fails (1.5× needed);
- decoys: +2.3 points, over the +2 guard.

**Rejected.**

Implied saving:
- cost: 14 of 169 reader calls (8.3%), −6.4% of the reader's cost as made;
- latency: the reader's wait (p50 1,117 ms, p90 1,680 ms as made) is skipped only on those 8.3% of reads, so its p50
  is unchanged;
- the scorer itself adds 0.61–0.73 ms per call (169 blind pools, mean 18.7 candidates, 3 runs).

### Reproduction from the committed labels

A script bug overwrote the first seed 43–44 card cache before it was committed (a glm rerun makes different cards,
so different reader prompts). The committed `labels-train.jsonl` was therefore re-made with the committed
`cards-train-4344.jsonl`: 1,416 calls, 662 of them replayed from the first run's reader cache and 754 sent live ($0.32).

On that dataset:
- pair AUC 0.862;
- planted hidden against decoy 0.549;
- the chosen cut decides 30 of 1,416 calls (1.02×).

Replaying it at $0 (`run.sh labels`) rebuilds 1,409 of 1,416 calls. Seven miss: a replayed verdict has no `why`,
which can change a later read's input. The fit gives AUC 0.859, 0.550 and 1.02×.

The blind row above used the model fitted on the first dataset; its NEW baseline and cascade shared every card and
prompt.

## What this says

- **Do not reopen this with more features or a bigger model of the same inputs.** On this cut, a cheap scorer can
  tell the reader's bound candidate from the rest of the pool (AUC 0.86) but not the planted item from its lookalike
  (0.54–0.57).
  - Every simulated request is built to carry one of the two, so the reader's work here is exactly that distinction.
  - The reader adds value through reading, not ranking (broad-set.md, haiku-phase3.md).
- **Real traffic may differ.** Most real requests carry no constraint at all, and there a "nothing here" gate could
  skip many reads. That is NEWL's `readerGate` (D99), which these suites cannot measure either: it skipped 2–10 of 768
  on train. Measuring it needs traffic with constraint-free requests, not a better scorer.
- **A cascade must also emulate rejections.** With `askReaderDrop`, a reader that reads and rejects a lookalike
  removes it from the answer. A local "silent" verdict removes nothing, so decoys rose in every cascade run (+1.0,
  +6.1 and +2.3 points).

## Reproduce

```bash
packages/sim/lab/distilled/run.sh labels   # $0: train records from the committed labels, fit, out-of-fold table
packages/sim/lab/distilled/run.sh live     # paid (about $1 on Haiku 5.5): labels, CV in the funnel, the blind pair
```

`--distill` (on `hidden-funnel.ts`) takes `record:OUT.jsonl`, `labels:LABELS.jsonl,OUT.jsonl` (with `--reader stub`)
or `cascade:MODEL.json` (with a reader model; a model file's `folds` score each train suite with the model that left
it out). `distilled-fit.ts --records … --out MODEL.json [--labels-out L.jsonl]` fits the scorer and prints the tables
above.
