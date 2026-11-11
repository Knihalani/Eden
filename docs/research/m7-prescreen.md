# M7: a no-model pre-screen in front of the push check

Status: 2026-11-11, branch `claude/m7-prescreen`, session M7, decisions D930–D932. **Rejected on its offline bar;
`pushPrescreen` is deleted (D930). The check-call recorder and the lab scripts are kept (D932).** Train suites only:
held-out families are train5–6. heldout19 was never read or run. Paid calls went to Anthropic directly
(`HAIKU_API_KEY`, the lab transport D97): **Anthropic-direct lab figures**. Spend: Anthropic **$1.37** of $10, Modal
**$0** (the volume `eden-m7` holds the data; helper sessions trained on their own CPUs). Numbers marked **[EST]** are
arithmetic or judgement; every other number comes from a command in this note.

**In plain words.**

- **The aim.** The shipped push check (S, D828) costs +$0.21 per 1,000 tasks and about +1.1 s with a Haiku agent. A
  tiny CPU model was to answer the clear pools itself, so only the unsure ones would call Haiku.
- **Haiku is noisy where a pre-screen would act.** Asked the same check again, Haiku names the same items 75–79% of
  the time. A silence it recorded repeats about 90% of the time. A pre-screen cannot be held closer to one recorded
  answer than Haiku holds to itself, so the parent redefined the bar against Haiku's own repeat disagreement (§2).
- **No architecture came close.** Ten models were tried, from symbolic trees to binarised pair networks to a
  learned word-pair table. The best one settles 28% of held-out calls, but it disagrees with a fresh Haiku answer on
  22.8–25.3% of them, against Haiku's own 6.8–9.3% on the same pools: **+15.8 points (+11.5..+20.5)**. The bar
  allowed +1 point.
- **Why.** Haiku's yes is often semantic. A travel-spend policy bears on "book flights"; a school pickup clashes with
  "after school". Pools where no gated item shares a word, name, number or day with the request still get a yes 29%
  of the time. A pool is silent only if all of its ~15 items are confidently no, and per-item AUCs of 0.82–0.90 do
  not get there. This is the reader cascade's lesson again (D110, D157).
- **What stays.** `--check-dump`: every check call with its pool, reply and task labels, a dataset for any student
  of the check (M1's checkers too). Also kept: the trainers, Haiku's self-agreement probe, and 16 hand-written short
  real constraints as a fixture gate.

## 1. Data: the check's own calls, recorded

There were no recorded check replies on any volume (`eden-checker` holds M1's per-item teacher rows, not check
calls), so the check was run live once and recorded. `bun run funnel --suite S --seeds N --jobs 1 -- --neutral
--check live --check-cache C --check-dump D` writes one row per check call:

- what the engine sent the check: the request head, the day and the pool's items (`readerItem`, 200 characters);
- each item's cached `title\ntext`, as the tagger reads it;
- the check's answer (the set of items named; null when unreadable) and its raw reply;
- the task's labels (suite, seed, variant, template, planted id).

M7's rows also carry the push gate's flags (`like`), recorded through the deleted `pushPrescreen` hook.

| Set | Calls (rows) | Readable |
| --- | --- | --- |
| train seeds 41–46, hidden + control + neutral | 4,543 | 3,204 (yes null and empty pools dropped) |
| train-rw seed 41 (P2's reworded train) | 565 | 551 |
| longtail seed 41 | 57 | 52 |

Labels cost $1.10, about $0.00024 a call. A replay is byte-identical: re-dumping seeds 41–44 from their caches gave
the same check key and verdict on 564 of 566, 563 of 566, 558 of 559 and 567 of 568 rows (the rest were failed calls
that fail open differently). M3's tagger (`tags-v1.bin`, from `claude/m3-retriever`) gave each item's nine logits
(`m7/tag-dump.ts`). The features use only the one quantised probability `TagMemo` keeps (`1 − P(all-clear tags)`, in
1/255 steps), because that is all the engine holds.

Verdicts on train 41–44 (2,259 calls):

| Variant | Haiku named an item | Named none | Unreadable |
| --- | --- | --- | --- |
| hidden | 689 | 54 | 17 |
| control | 365 | 374 | 21 |
| neutral | 195 | 529 | 15 |

The yes answers on neutral requests are mostly legitimate (read by hand on seed 41): a travel policy ("travel over
£500 needs pre-approval") for "Book flights to Kraków", a school pickup at 15:30 against "a check-up … after school",
a calendar standup on the day the user will be away.

## 2. Haiku against itself (the noise floor; D931)

`m7/self-agree.ts` re-asks recorded calls live with the same prompt (`checkMessages`) and compares the verdicts. The
sample was a fixed shuffle of 296 train 41–44 calls, re-asked three times ($0.21):

| | Run 1 | Run 2 | Run 3 |
| --- | --- | --- | --- |
| Same items named as recorded | 75.7% | 75.4% | 78.8% |
| A recorded silence silent again | 89.7% | 89.2% | 91.2% |
| Speak/silent the same (run 1) | 90.9% | | |

With four samples a pool (281 pools): silent on all four 31.7% (neutral 54 of 81, control 31 of 96, hidden 4 of 104),
on three 7.5%, on two 3.6%.

The pre-registered offline bar (f2534d04: ≥ 40% settled, ≤ 1% disagreement with the recorded verdict) was below this
floor, and no pre-screen could pass it. **The parent redefined it before the frozen read** (4756b07d):

- at least 25% of held-out calls settled;
- on the settled pools, disagreement with a fresh Haiku sample no worse than Haiku's own repeat disagreement on the
  same pools (point estimate ≤ Haiku's, upper bound within +1 point);
- none of 16 short real-constraint fixtures settled silent.

The end-to-end bar was unchanged (check calls −25% or better), with decoys handed reported. Held-out curves of rounds 0–1
(threshold-free) had been read before the redefinition; the candidate and its threshold were frozen from out-of-fold
numbers only.

## 3. Hypotheses and rounds

Each candidate gives each pooled item a probability that the check names it. A pool is settled silent when its top
item is under a threshold, and passed through when exactly one item is above a high threshold and all others are
low. Thresholds are chosen out of fold on train1–4, five folds grouped by template.

| # | Name | What it exploits | Architecture |
| --- | --- | --- | --- |
| H1 | GateLattice | yes only when an item's point lands on the request's own thing | 26 symbolic features per item (pool-relative idf overlap, names, numbers, days, date delta, block and clear lexicons, gate flag, rank, source, length, tag probability) → GBM |
| H2 | XnorPair | learned lexical comparison | M3's ternary/binary kernel on hashed request and item n-grams, (r·c, r, c, prior bits) binary MLP |
| H3 | HitBloom | the reply's `hits`: request words found in the item | match/miss bits of request content words + item code → binary MLP |
| H4 | PoolSet | pool context | per-item codes max-pooled to a pool head P(any yes) |
| H5 | ReplyHeads | the reply's structure (listed, hits, act) as three labels | HitBloom with three heads |
| H6 | RequestPrior | request kinds that rarely get a yes | the request alone → pool head |
| H7 | TagGate | M3's tag | no gated item with tag P ≥ θ → silent |
| H8 | Mondrian thresholds | calibration per request shape | (not built: no candidate had a stratum worth it) |
| H9 | VerdictMemo | repeated pools over a day | (not built: one request a session in the funnel) |
| R2 | PairHash | which item words bear on which request words (travel ← flights), no vectors | hashed (request word, item word) pairs and item words → logistic; stacked into H1 as one feature |

Round 1 ran on four Haiku helper sessions (CPU; branch at 699ca85a). Rounds 0 and 2 ran here. "Curve" is the
held-out disagreement with the recorded verdict when the pools with the lowest top item are settled silent (10 / 20
/ 30 / 40% of 1,058 held-out calls; 504 of them silent).

| # | Variant | Item AUC | 10% | 20% | 30% | 40% |
| --- | --- | --- | --- | --- | --- | --- |
| H1 | GBM, 7–31 leaves, 150–400 trees (helper A) | 0.817–0.842 | 8.6–15.2% | 18.0–20.4% | 21.8–24.0% | 26.5–30.0% |
| H1 | GBM without the tag | 0.818 | 13.3% | 20.4% | 27.8% | 32.9% |
| H1 | GBM without lexical overlap | 0.836 | 12.4% | 23.2% | 25.6% | 30.0% |
| H3 | HitBloom, binary / float (helper C) | 0.837 / 0.843 | 18.1 / 16.2% | 27.5 / 23.2% | 34.4 / 27.4% | 38.5 / 33.3% |
| H5 | ReplyHeads, binary / float (helper C) | 0.837 / 0.845 | 9.5 / 13.3% | 20.4 / 27.5% | 26.8 / 31.9% | 31.0 / 32.2% |
| H2 | XnorPair (helper B) | see §3.1 | | | | |
| H4, H6 | PoolSet, RequestPrior (helper D) | see §3.1 | | | | |
| R2 | PairHash alone (C 0.1) | 0.850 | 6.7% | 18.0% | 24.6% | 31.0% |
| R2 | **H1 + PairHash, stacked** | **0.895** | 5.7% | 13.3% | 21.8% | 27.7% |
| R2 | the same, then a pool-level GBM head | pool AUC 0.746 | 11.4% | 17.1% | 24.3% | 31.2% |
| H7 | the tag veto alone, θ 0.5 | — | settles 1.7% of calls; Haiku speaks on 41% of them | | | |

At the original bar (thresholds for ≤ 0.6% out-of-fold disagreement), every candidate settled 0–2.4% of held-out
calls, the same order as the reader cascade (D110: 2.5%).

**What more data does.** H1 + PairHash trained on 365, 733, 1,469 and 2,146 pools gives held-out item AUC 0.861, 0.884,
0.895 and 0.895. The 40% point stays at 28–34%: past about 730 pools, more labels from these families do not help.

**Surface cues (the parent's note from M3).** Out of fold, at the frozen share:

- GBM alone settled 5 of the 16 fixtures silent (`len` and `rlen` were among its top features);
- with PairHash stacked it settled none;
- with PairHash and the length features dropped, 2;
- with length augmentation (each training pool again with its items cut to 35–100% of their words), 1.

**Planted facts lost.** On held-out, of the 277 hidden pools where the check named the planted fact, H1 + PairHash
settles 0 / 4 / 15 / 27 silent at 10 / 20 / 30 / 40%. Those would be facts the packet no longer hands the agent.

### 3.1 Helpers B and D

<!-- filled when their reports arrive -->

## 4. The frozen read (D930)

**Candidate, frozen from out-of-fold numbers only:**

- GBM (15 leaves, 300 trees) over H1's features, plus the stacked PairHash score;
- silent when the pool's top item is under 0.1165, the 27% out-of-fold share (21.1% out-of-fold disagreement with
  the recorded verdict);
- fixtures: 0 of 16 silenced.

**Held-out (train5–6), read once:** 296 of 1,058 calls settled (28.0%), 20.95% disagreement with the recorded verdict.
The settled pools were then re-asked twice, live ($0.13); 281 pools have both fresh samples:

| On the 281 settled pools | Disagreement |
| --- | --- |
| Pre-screen (silent) vs fresh sample A / B | **22.8% / 25.3%** |
| Pre-screen vs the recorded verdict | 21.7% |
| Haiku vs Haiku: A vs B / recorded vs A / recorded vs B | **8.5% / 6.8% / 9.3%** |
| Pre-screen minus Haiku (mean over the fresh pairs; bootstrap over pools, 4,000 draws) | **+15.8 points (+11.5..+20.5)** |

**The redefined bar fails:** the pre-screen's point estimate is not ≤ Haiku's, and its upper bound is 19.5 points
above, not 1. Per the rule there was no Pi run, and `pushPrescreen` was deleted the same day (D814).

## 5. Decisions

- **D930, rejected:** the push check's no-model pre-screen, `pushPrescreen` (§4). The trial switch, `prescreen.ts`,
  the partner's `prescreen` dependency and its trace fields are deleted; the engine is as on main.
- **D931, finding:** Haiku's compare-first check repeats its own verdict on 75–79% of calls and its silences on about
  90% (§2). Any student of the check (a pre-screen, a distilled checker) is measured against that floor, never against
  one recorded answer as truth.
- **D932, adopted (lab tooling):** kept for M1 and later students of the check.
  - the funnel's `--check-dump F` (`check-dump.ts`, `check-dump.test.ts`);
  - `packages/sim/lab/m7/`: `m7.py` (features, GBM, PairHash, settle rule, out-of-fold thresholds, curve,
    fixtures), `nets.py` (the binarised candidates), `tag-dump.ts`, `self-agree.ts`, `fixtures.json` (16 short real
    constraints) and `fixtures.py` (their pools);
  - the data on the Modal Volume `eden-m7` (`data/`).

## 6. What next (not done)

- **A stronger teacher than one noisy sample.** M1's 8B soft scores (M2 v2 pairgroups) or a majority of several Haiku
  answers would denoise the labels. That narrows the noise part, not the semantic gap: the pre-screen is 16 points
  above Haiku's own noise **[EST: the gap is the model's, not the label's]**.
- **Not a pre-screen at all.** A silence that saves no call saves no money. Starting the check and handing the packet
  early when a model is confident would cut wait, not cost. Nothing here measured it.

## 7. Reproduce

```bash
unset OPENROUTER_API_KEY
# labels (live; about $0.13 a seed with neutral tasks), one process a seed:
bun run funnel --suite train --seeds 41 --jobs 1 -- --neutral --check live --check-cache C41.jsonl \
  --check-dump D41.jsonl --spend-ledger L.jsonl --spend-cap 3
# the same rows again at $0: --check replay --check-cache C41.jsonl
bun packages/sim/lab/m7/tag-dump.ts $PWD/<m3 tagger.ts> D41.jsonl ...   # M3's tagger, branch claude/m3-retriever
python3 -I packages/sim/lab/m7/m7.py --dumps 'D*.jsonl' --pairhash --share 0.27 --fixtures FX.jsonl \
  --settled-out S.jsonl                                                     # the frozen read
bun packages/sim/lab/m7/self-agree.ts --n 400 --out A.jsonl --spend-ledger L.jsonl --spend-cap 1 S.jsonl
python3 -I packages/sim/lab/m7/nets.py --dumps 'D*.jsonl' --arch hitbloom    # round 1's nets
```

The data (`train-41`…`46`, `rw-41`, `lt-41`, their `.tags.jsonl`, the agreement samples) is on the Modal Volume
`eden-m7` under `data/`. The fixture pools: `python3 -I packages/sim/lab/m7/fixtures.py FX.jsonl`, then `tag-dump.ts`
on it.
