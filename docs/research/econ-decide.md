# Closing the decision gap without a model (track decide)

Decision: D67 (`decideConflict`; `decide` measured, then removed from the engine at integration; see the end). Everything here is **in-sample**: the hidden
suite and held-out 1–4 only. Held-out 5–9 were not run or read by this track (one aggregate funnel line per blind suite
was printed once while locating the benchmark's funnel file; no number from it is used here). $0 live spend.

## The question

With background sync (ALL, D64), every planted item is in Eden's cache when the request arrives, yet the no-model
funnel delivers 342 of 584 planted facts across the nine suites (blind 124 of 316). Every miss is a decision. Where
does the planted item sit when it is not delivered, and can a better no-model decision deliver it?

## Instrumentation

- `PartnerDeps.onCandidates` (`partner.ts`), a debug hook: each no-model decision (the fast path, anticipation's early
  decision, the lookup, the lookup after an early delivery) reports its ranked candidates, each with its facts, and what
  was delivered. Ids and numbers only, no content. Absent, nothing is computed.
- `decide.ts`'s `Facts`: 41 per-candidate facts the rule paths already read: lexical score, matched terms, rank,
  relative score, entity hit, words beyond names, `beyondName`, `about`, `conflict.ts`'s verdict (conflict, clear),
  the conflict ground's own test (`conflictHit`) and the graph's (`graphHit`), bulk, settled, away elsewhere, named day,
  a day the text names, dated, upcoming, an absence over the named day, probed, bridged, walked (score, binds, by name,
  automated, the graph's verdict), carded (violated, tied by name), participant, mentions, names the ref, unmeasured
  limit, age, and the request's shape (acts, imperative, question, names a day, external).
- `hidden-funnel.ts --candidates out.jsonl` writes one line per task: suite, seed, variant, template, the planted id,
  what was delivered and every decision's candidate list.

The baseline reproduces D64's funnel exactly (ALL, cards replayed, real sync, seeds 41–44, in-sample): **218 of 268**
planted facts delivered, **18 of 268** decoys delivered; with the hook on, the same.

## Where the 50 in-sample misses sat (ALL)

| Where the planted item was | Misses | Templates |
|---|---|---|
| Passes the conflict ground's test, but another path spoke first (a sure lexical match, an anticipated delivery, the graph's ground) or it was below `candidateScore` | 10 | interviewer-out, invoice-already-paid, invoice-disputed, procurement-threshold, vendor-access-suspended |
| No verdict: reached by the graph through a binding node, but `conflict.ts` says neither conflict nor clear | 18 | dentist-moved, duplicate-invoice, hiring-freeze, launch-date-moved, vendor-review-expired |
| No verdict: tied by words or a day only | 17 | bbq-clash-gala, cat-feeding-friend-away, family-day-out-mobility, incident-access-suspended, invoice-already-paid, travel-clash, vendor-access-suspended |
| Never ranked: the fast path delivered from the cache and no lookup ran | 3 | allergy, discount-cap, entertainment-threshold |
| A card violated, but the card seat (`cardItems` 1) went to another | 1 | cat-feeding-friend-away |
| A conflict verdict not tied beyond a name | 1 | entertainment-threshold |

(`tax.py` over the candidate dump.) The planted item was among the ranked candidates in 47 of 50 misses; its rank
ranged from 0 to 28 (the graph's finds rank last: they score 0 on words).

**Most of the gap is a reading gap, not a ranking gap.** 35 of 50 misses have no verdict from `conflict.ts`, the
graph or a card. Their decoys carry the same structural facts (same template, same people, often the same words: the
decoys were written to be lexically equal), so no reweighting of existing facts separates them; only a better reading
of the text (more `conflict.ts` patterns, a card for the item, or a model) can. A typical case: "Open a req for a
second solutions engineer" against a card `{kind: freeze, actions: [hire]}`; `requestActions` has no "req", so the card
is never matched. That is a lexicon change for the cards and conflict tracks, not a decision change, and was not made
here (tuning lexicons on in-sample templates would not tell us anything about the blind suites).

The 10 pure decision misses have one cause: **a conflict the engine had already found was silenced by an earlier
path.** `lookup` delivers what is sure on its words and returns before `grounded` runs; after an anticipated delivery
the slow path adds only what is sure or grounded among the eligible (score ≥ 0.3); `grounded` returns the first
ground that fires (clash, conflict, graph, card, away, occasion, person) and the conflict test reads only eligible
candidates.

The fallback (D36) is the other decision worth reading: in-sample it delivers 8 planted facts and 12 of the 18 decoys
(and 20 other items). Its hits and its decoys have the same facts (score 0.88–1.1, two to four matched terms, about,
probed, walked), so no gate on facts separates them: gated by the model at any threshold from 0.05 to 0.5 (out of
fold), the fallback delivers none of them (210 / 6 instead of 218 / 18). Dropping it is a precision-for-recall trade,
not a better decision; it stays as it is.

## What was built

### `decideConflict` (adopt)

With no model's say, after whichever rule path decided (sure, anticipated-then-slow, grounded by any ground, the
fallback, or silence), the conflict ground's own test (`grounded`'s request-frame conflicts, conflicting consequence
finds and the graph's conflicts, factored out unchanged as `Partner.conflicts`) is run over every ranked candidate
(not only the eligible, at most `decideCandidates` 64), and its best find that is not settled and not an unmeasured
limit joins the delivery **while the packet has room**: it never displaces what a rule path chose (an earlier variant
that replaced the last item lost one planted fact, allergy seed 44, and was dropped). No call, no state, no model.

### `decide` (built, measured, left off; removed from the engine by D67)

A logistic model over the 41 facts (`decide.ts`, `DECIDE_MODEL`), fitted by `decide-fit.ts` (Newton's method with an L2
penalty, no dependency) on the candidate dump: the planted item of a hidden task is the positive, every other
candidate a negative, the control task's decoy weighted 3×. With `decide`, the best candidate the rules (and
`decideConflict`) left undelivered is added when its probability clears `decideThreshold` (0.5), also only into room.

## Results

All in-sample, ALL configuration, seeds 41–44, cards replayed, real sync. Paired bootstrap over tasks (10,000
resamples); the gains are 7 tasks from 5 templates in 3 suites, so the task-level interval is optimistic about
template-level variance.

### Funnel (hidden, held-out 1–4)

| Config | Planted delivered | Decoys delivered | Δ planted (95% CI) | Extra items / task (hidden, control) |
|---|---|---|---|---|
| ALL | 218/268 (0.813) | 18/268 | | |
| ALL + `decideConflict` | **225/268 (0.840)** | **18/268** | +0.026 (+0.007..+0.045) | +0.063, +0.015 |
| ALL + `decideConflict` + `decide`, leave-one-suite-out at engine level | 226/268 (0.843) | 18/268 | +0.004 over the row above (+0.000..+0.011) | +0.015, +0.015 |

Per suite (ALL → + `decideConflict`): hidden 37 → 37, held-out 36 → 39, held-out 2 50 → 53, held-out 3 48 → 48,
held-out 4 47 → 48; decoys unchanged in every suite. The seven gains: procurement-threshold ×2, interviewer-out ×2,
vendor-access-suspended, invoice-already-paid, invoice-disputed (`cmp.py`).

**Leave-one-suite-out for the learned model.** Each suite was decided by a model fitted on the other four, offline
(`decide-fit.ts`) and in the engine (`decideModel` set per fold; same result: 226/268, 18/268). Offline, over ALL
without `decideConflict`, the best threshold added 3 planted facts at 0 decoys (λ 10, τ 0.5) and 5 at +1 decoy (τ 0.3);
the parameter-free `decideConflict` added 7 at 0. On top of `decideConflict` the model adds 1 at every threshold
from 0.9 to 0.4 at 0 decoys, and only decoys below. Fitting on the residual candidates only, or other penalties (λ 3,
30), did no better. The model's leave-one-suite-out calibration (every candidate, ALL plus `decideConflict` dump):

| Probability bin | Candidates | Mean p | Share planted |
|---|---|---|---|
| < 0.1 | 12,309 | 0.005 | 0.006 |
| 0.1–0.3 | 84 | 0.18 | 0.19 |
| 0.3–0.7 | 114 | 0.48 | 0.23 |
| 0.7–0.9 | 27 | 0.78 | 0.70 |
| ≥ 0.9 | 32 | 0.97 | 0.81 |

Calibrated at the ends, overconfident in the middle on unseen suites.

**Agent-as-judge support.** Where the model does help is ranking what to show beside the packet for the agent to judge
(an "also found" list): of the 43 planted facts the rules miss (ALL + `decideConflict`), the k best undelivered
candidates by the model's out-of-fold probability hold 6 / 12 / 14 / 17 (k = 1 / 2 / 3 / 5), against 7 / 9 / 14 / 17
by lexical score, while holding **44 / 53 / 67 / 75 decoys against 96 / 120 / 127 / 137** (over the 250 control tasks
whose decoy was not delivered). At k = 2 the model's list finds a third more of the missed facts with less than half the
decoys. The track exposed the probability in the candidate dump and exported it for the one-turn track's list; that
list was rejected (oneturn), so D67 removed both from the engine.

### Realistic simulation and zoo (planner, drafts, cards replayed; realistic seeds 41–44, zoo seeds 41–42)

| Profile, judge | Config | Recall | Precision | Soft fire (mean of seeds) | Hard false fires | Bytes / needed fact |
|---|---|---|---|---|---|---|
| realistic, none | ALL | 0.431 | 0.595 | 0.121 | 0 | 531 |
| | + `decideConflict` | 0.441 | 0.601 | 0.121 | 0 | 524 |
| | + `decide` | 0.445 | 0.603 | 0.121 | 0 | 523 |
| realistic, perfect | all three | 0.795 | 0.990 | 0.000 | 0 | 415 |
| zoo-a, none | ALL | 0.437 | 0.608 | 0.150 | 0 | 512 |
| | + `decideConflict` | 0.455 | 0.614 | 0.150 | 0 | 501 |
| | + `decide` | 0.460 | 0.616 | 0.150 | 0 | 498 |
| zoo-b, none | ALL | 0.437 | 0.608 | 0.150 | 0 | 512 |
| | + `decideConflict` | 0.455 | 0.616 | 0.150 | 0 | 500 |
| | + `decide` | 0.460 | 0.618 | 0.150 | 0 | 498 |
| zoo-a / zoo-b, perfect | all three | 0.769 | 0.982 | 0.000 | 0 | 430 |

Per seed, no-model must-facts delivered never fall (realistic 86/84/79/77 → 87/90/80/77 with `decideConflict`); the
items added in realistic were relevant 11 times out of 11 (delivered 768 → 779, relevant 457 → 468, pooled). With a
judge nothing changes, by construction (`aggsim.py`, `perseed.py`).

### Cost and time

- Model calls: none. `decideConflict` and `decide` run only when no model decides.
- Engine CPU, funnel, in-sample, seeds played one after another (`--serial --cpu`, two runs each, noisy machine): task
  CPU per task (engine and in-process connectors) ALL 12.5 ms, + `decideConflict` 14.1 ms (+1.6 ms), + `decide` 18.0 ms
  (+5.5 ms: the facts read `conflict.ts` for every candidate). All of it is the slow path, after the early decision.
- Agent tokens: +0.063 items per hidden task, +0.015 per control task (a packet item is a few dozen tokens).
- `bun run eval` with every flag off: JSON identical to main's except latency fields.

## Recommendation

- Turn `decideConflict` on in ALL. In-sample it delivers 7 more of 268 planted facts at the same 18 decoys, and raises
  no-model recall and precision in every simulated profile. At D64's measured uptake (raised 0.851 when delivered,
  0.368 when not), +0.026 delivery is about +0.013 facts raised per hidden task in-sample; the blind effect is unknown
  until the synthesis runs held-out 5–9.
- Leave `decide` off. Leave-one-suite-out it adds one planted fact of 268 for 4 ms of CPU per task. Its probability is
  worth using to order an "also found" list, not to decide.
- The rest of the gap is reading: 35 of 50 in-sample misses have no verdict from any no-model reader. That is work for
  `conflict.ts`, the card lexicons and the card enrichment (or a model), measured blind.

## Reproduce

```bash
D=/path/to/scratch; CFG="$(cat ALL.cfg)"   # D64's ALL; add "decideConflict":true ("decide" is gone, D67)
bun packages/sim/src/lab/hidden-funnel.ts --suite hidden,heldout,heldout2,heldout3,heldout4 --no-record \
  --config "$CFG" --cards packages/sim/lab/cards/cards-v2.jsonl --json $D/f.json --candidates $D/cand.jsonl
bun packages/sim/src/lab/decide-fit.ts $D/cand.jsonl --lambda 10 --out $D/model.json --folds $D/folds
bun packages/sim/src/quality-cli.ts --profile realistic --seed 41 --planner --judge none --drafts clause \
  --config "$CFG" --cards packages/sim/lab/cards/cards-v2.jsonl
```

The track's `DECIDE_MODEL` (removed by D67) was `decide-fit.ts --lambda 10` over the dump of ALL plus
`decideConflict` with `decideCandidates` 200.
The analysis scripts (`an1.py`, `tax.py`, `fb.py`, `rules.py`, `cmp.py`, `boot.py`, `aggsim.py`, `loso.sh`, `sims.sh`)
stayed in the session scratchpad.

## Integration (D67)

Integrated after D65 (poll and judge behind) and D66 (card economy), as the econ synthesis planned:

- **Kept:** `decideConflict`, off by default; the `conflicts()` refactor of the conflict ground's block in
  `partner.ts`; the `onCandidates` hook, `decide.ts`'s `Facts` and `hidden-funnel.ts --candidates`, as lab instruments.
- **Removed from the engine:** the `decide`, `decideThreshold` and `decideModel` flags and the fitted `DECIDE_MODEL`.
  The logistic model (its type and probability) now lives in `decide-fit.ts`, which still fits and scores it
  leave-one-suite-out from a candidate dump. Engine-level per-fold runs (`decideModel`) are no longer possible.
- **With `syncPollBehind`:** the follow-up lookup made once the poll stored something runs as a `served` lookup, which
  adds only sure or grounded items; `decideConflict`'s pass runs there too, so a fresh item the request breaks is
  queued for the agent's next request instead of waiting for `ask_context` (test: `decide.test.ts`). With a model the
  follow-up decides as with none (D65's review), so the pass runs there too, with no judge call.
- **With `judgeBehind`:** the lookup decides as with no model, so `decideConflict` runs before the judge, and the judge
  reads only what the answer left out (one fewer candidate when a conflict was added; test: `decide.test.ts`).
- **With `cardsEconomy`:** re-run in this session on the in-sample funnel (`--lead-in clause`, seeds 41–44, no model):

| Config | Cards replayed | Planted delivered | Decoys delivered |
| --- | --- | --- | --- |
| ALL | cards-v2 | 218/268 | 19/268 |
| ALL + `decideConflict` | cards-v2 | 225/268 | 19/268 |
| ALL + `cardsEconomy` | cards-v2 | 218/268 | 19/268 |
| ALL + `cardsEconomy` + `decideConflict` | cards-v2 | 225/268 | 19/268 |
| ALL + `cardsEconomy` + `decideConflict` | econ-price20-v2 | 226/268 | 18/268 |

  With `cardsEconomy` the `decideConflict` run is identical task by task to the one without it (0 of 536 tasks
  differ): the same 7 hidden gains (procurement-threshold ×2, interviewer-out ×2, vendor-access-suspended,
  invoice-already-paid, invoice-disputed), no loss, no decoy change; one control task whose decoy was already delivered
  gets one more item. On the price-routed card file, against D66's run of `cardsEconomy` alone (219/18), the same 7
  gains and nothing else. The 19 decoys of the ALL row (the track measured 18) come from `--lead-in clause`, as in
  D66's funnel. The synthesis expected about 225/18; nothing here needs investigating.
- **Review fixes:** the pass now also runs (a) on the fast path's sure answer from the cache, which used to return
  before the slow path's pass (with `anticipate` warming the cache, the common case), reading the cache's ranking and
  adding only a current copy; and (b) wherever `noModel()` decides, so a model that failed, was cut off or was over
  budget delivers what no model would (D41), the judge-free `judgeSure` branch included. A judge that answered still
  decides alone. The pass reads `noModel()`'s cue (with `recoverNames`' names), and the candidate dump labels a
  delivery only the pass made `decide-conflict`, never silence. Tests: `decide.test.ts`. The in-sample funnel above
  re-run after the fixes (ECON, cards-v2, `--lead-in clause`): 218/19 without `decideConflict`, 225/19 with it,
  unchanged: on these suites neither fix changes a delivery.
- `bun run eval` with every flag off: identical to origin/main's except latency fields.

```bash
# ALL from pi-full-benchmark.md; ECON = ALL + {"cardsEconomy": true}; add "decideConflict": true to either.
bun packages/sim/src/lab/hidden-funnel.ts --suite hidden,heldout,heldout2,heldout3,heldout4 --no-record \
  --lead-in clause --config "$ECON" --cards packages/sim/lab/cards/cards-v2.jsonl --json out.json
```
