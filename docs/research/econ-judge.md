# Eden's model calls and its critical path (track judge, D65)

Status: 2026-10-31, one session. **Every number below is in-sample**: the hidden, held-out 1, 2, 3 and 4 suites,
which every configuration was tuned on. Held-out 5–9 were neither run nor read here. The configuration is ALL
(D64: D62's R plus `sync`). The agent is the Pi harness on `z-ai/glm-5.3-flash`, graded by `deepseek/deepseek-v4.1-flash`.
Live spend was $0.277 of the track's $0.30 cap.

## The question

The full benchmark (D64) found that Eden's model judge adds nothing measurable. In H, eden-judge − eden was +0.010
hidden (−0.024..+0.046), at +0.64 s and +$0.019 per 1,000 tasks. This track decides what to do with Eden's model calls,
from four options:

- (a) drop the judge;
- (b) move it off the critical path;
- (c) distil it into a no-model scorer;
- (d) spend its budget on card enrichment instead.

It also audits the 530 ms that Eden (ALL) spends on the agent's critical path.

## Findings

1. **Eden's 530 ms is a listing call, not computation.** In ALL, the request's first `observe` waits for the slow
   path. With `sync`, the slow path first polls every synced source the staleness model calls stale (`sync.freshen`,
   one or two listing calls). Then it answers from the local index.
   - From the full benchmark's eden (ALL) timelines (seeds 41–44, the in-sample and blind suites together, 1,168
     tasks):
     - first observe: p50 448 ms, mean 464 ms;
     - the on-demand poll was on the first observe's path in 891 tasks, at p50 503 ms;
     - early (`anticipate`'s answer from what is held) returned at once in 277 tasks;
     - the rest waited for the poll: p50 550 ms.
   - Eden's own work on that path is small: probes, rank, graph walk and card match take a few milliseconds.
2. **Not waiting for the poll changes no decision in the simulation.** The new flag `syncPollBehind` answers the
   lookup from the index as it stands and lets the poll run behind. The funnel (in-sample, seeds 41–44, 536 tasks)
   gives the same delivered and decoy sets task by task at both time scales:
   - at `--time 1` (profile latency), first observe goes from p50 424 / p90 928 ms to 5.0 / 106 ms;
   - the planted fact is delivered at p50 4.6 ms instead of 280 ms.

   The simulated worlds are static: every poll in the funnel stored nothing new (520 of 520 `sync.freshen` spans had
   `fresh: 0`). The follow-up lookup for what a poll does bring is covered by the unit tests, not by this benchmark.
3. **The judge on the critical path costs facts as well as time, because it switches off the no-model early
   answer.** With a model, `early` and the fast path defer to the slow path, so the judge decides everything.
   - In the funnel with the live judge (seeds 41 and 42, 134 hidden tasks):
     - the judge loses 17 planted deliveries that the no-model path makes, mostly `anticipated-conflict` and
       `grounded-*`;
     - it gains 12 (`model`);
     - it adds 60 decoys to the no-model path's handful (and drops 2).
   - In the full benchmark (ALL, in-sample, paired), eden-judge − eden is:
     - −0.026 hidden (−0.082..+0.030);
     - +1.10 s wall (+0.53..+1.77);
     - +$0.039 per 1,000 tasks (+0.026..+0.063);
     - both-judge − both: −0.071 (−0.127..+0.004).
4. **Behind the answer, the judge only adds.** `judgeBehind` keeps every no-model decision, delivered at once. The
   judge then reads the candidates the answer left out, and its picks are queued for the agent's next request.
   - Funnel, seed 41: planted delivered 51 → 57 of 67, with no loss. The six gains are the templates the no-model
     path cannot ground: dentist-moved, cat-feeding-friend-away, family-day-out-mobility, incident-access-suspended,
     vendor-review-expired and invoice-already-paid.
   - Decoys delivered 4 → 36 of 67. The judge rules on relevance, and a decoy is the same relevant record without
     the problem.
   - Live, the agent mostly ignored those decoys: false concerns did not rise (below).
5. **Live check (in-sample, seed 43).** Four conditions ran in one process, paired by task. The $0.26 cap cut the
   first run at 412 of 536 runs, so pairs are fewer than tasks. A second run (hidden tasks only, the two new
   conditions) added pairs. Bootstrap 95% intervals:

| Comparison | Hidden raised | False concern (control) | Wall s | $ / 1k tasks (agent + Eden) | Eden on the critical path, ms |
|---|---|---|---|---|---|
| eden-judge − eden | −0.098 (−0.268..+0.073), n=41 | −0.027 (−0.081..0.000), n=37 | +2.27 (+1.70..+2.91) | +0.027 (−0.002..+0.057) | +1,759 (+1,575..+1,969) |
| eden~pb − eden | −0.047 (−0.140..+0.047), n=43 | −0.024 (−0.073..0.000), n=41 | −0.60 (−1.25..+0.03) | −0.002 (−0.037..+0.032) | **−426 (−526..−347)** |
| eden-judge~jb − eden~pb, run 1 | +0.070 (−0.023..+0.163), n=43 | 0.000 (0.000..0.000), n=40 | +0.50 (−0.09..+0.99) | +0.010 (−0.028..+0.043) | +19 (0..+43) |
| eden-judge~jb − eden~pb, run 2 (hidden only) | +0.107 (−0.071..+0.286), n=28 | — | −1.20 (−2.35..−0.18) | +0.003 (−0.047..+0.051) | −13 (−37..+3) |
| eden-judge~jb − eden~pb, pooled | **+0.085 (−0.014..+0.183), n=71** | | −0.26 (−0.98..+0.40) | | |
| eden-judge~jb − eden-judge | +0.081 (−0.108..+0.243), n=37 | 0.000 (−0.088..+0.088), n=34 | **−2.45 (−3.09..−1.78)** | −0.030 (−0.066..+0.011) | −2,158 (−2,377..−1,931) |

Per condition, first run:

| Condition | First observe p50 | Eden on the critical path, mean | Eden judge calls / task | Eden $ / 1k tasks |
|---|---|---|---|---|
| eden | 413 ms | 491 ms | 0 | 0 (cards replayed) |
| eden-judge | 2,215 ms | 2,228 ms | 0.94 | 0.023 |
| eden~pb | 6 ms | 79 ms | 0 | 0 |
| eden-judge~jb | 6 ms | 95 ms | 0.90 | 0.017–0.022 |

How to read the live check:
- The −426 ms Eden-path drop is the measured effect of `syncPollBehind`. The hidden-rate differences of eden~pb are
  noise: the funnel delivers the same items.
- The wall-clock differences are noisy, because 4 CPUs were shared with 7 other agents. The −0.60 s for eden~pb is
  of the size the critical path predicts.
- In run 1, 17 of `judgeBehind`'s queued items arrived after the agent's final answer (`lateItems`; 2 for the judge
  on the path). An addition reaches only an agent that makes another request.
- In the full benchmark, the agent made more than one model call in 92% of Eden tasks.

6. **Realistic simulation (in-sample, 4 seeds, perfect judge modelled).**

| Configuration | Judge | Precision | Recall | Soft fire | Must delivered | Model calls / turn |
|---|---|---|---|---|---|---|
| ALL | none | 0.596 | 0.432 | 0.121 | 327 / 757 | 0 |
| ALL + `syncPollBehind` | none | 0.595 | 0.432 | 0.121 | 327 / 757 | 0 |
| ALL | perfect | 0.989 | 0.793 | 0.000 | 600 / 757 | 0.275 |
| ALL + `syncPollBehind` + `judgeBehind` | perfect | 0.764 | 0.759 | 0.121 | 575 / 757 | 0.221 |

A perfect judge on the path is the simulation's upper bound: it vetoes the no-model path's soft fires. A judge behind
the answer cannot veto, so it keeps the no-model soft fire rate and adds recall. The real judge, live, does not
reach the perfect judge's precision: on the path it lost facts. That is why the live check, not the perfect
simulation, decides between them.

## The four options

- **(a) Drop the judge from the recommended configuration: adopt.** No in-sample measurement shows the judge on the
  path helping, and four show it costing:
  - the full benchmark's ALL in-sample: −0.026 hidden, +1.10 s, +$0.039 per 1,000 tasks;
  - this run: −0.098 hidden, +2.27 s;
  - the funnel: −17 / +12 planted, +60 decoys.

  ALL's recommended form has no model call per event.
- **(b) The judge behind the answer (`judgeBehind`): promising, needs the blind run.**
  - The funnel's +6 of 67 planted delivered comes with no loss; live it is +0.085 hidden (−0.014..+0.183) pooled over
    71 pairs, with no rise in false concerns in 40 control pairs.
  - It costs about $0.02 per 1,000 tasks live and puts no time on the critical path.
  - Its decoys are many in the funnel (36 of 67) but did not become false concerns live.
  - The synthesis should run eden~pb against eden-judge~jb on the blind suites before recommending it.
- **(c) Distil the judge into a no-model scorer: not now.** In the funnel, of the judge's picks that the no-model path
  does not make (two seeds), 12 are planted facts and 60 are decoys. The 12 come from six templates seen on both
  seeds. A scorer fitted to them would be fitted to six in-sample templates, and nothing here could check it blind.
  `judgeBehind` gets the same additions from the real judge for about $0.02 per 1,000 tasks.
- **(d) Spend the judge's budget on card enrichment: no gain to buy.**
  - Cards as built buy +14 planted delivered of 268 (204 → 218, decoys 18 → 18; funnel, cards off against on).
  - They already cover 98% of cached items (6,546 replayed, 114 uncovered).
  - Steady-state cards cost $0.003–0.004 per user-month. At 20 tasks a day, `judgeBehind` costs about $0.012–0.040
    per user-month at the live and funnel per-task prices.
  - More money cannot buy more coverage. A stronger card model is the only lever left, and it was not measured here.

## What changed (all behind flags, off by default)

- `syncPollBehind` (engine, with `sync` and `syncOnDemand`):
  - An event's lookup does not wait for the on-demand poll: every warm synced source answers from the index as it
    stands, and the poll runs behind.
  - If the poll stores anything (new or changed items, counted by `SyncManager.freshen`'s new `tally`), the lookup is
    made again once both are done, and what it delivers is queued:
    - after a delivery, or after anticipation's early answer, it adds only what is sure or grounded (`served`);
    - after silence, it decides as the lookup would have had it waited, with no model; with a model it decides as
      after a delivery, so the follow-up never makes the event's second judge call (review fix: it re-ran the full
      slow path, judge included, two judge calls for one event);
    - an item the session was given and the poll then changed (edited in place at its source) is delivered again as
      it now reads (review fix: the index answered with the superseded copy, and the ledger, keyed by id, kept the
      follow-up from correcting it; D40 says a stale copy is never delivered, and D65 records where this flag departs
      from it: the old copy can go out first, and the correction follows). With the flag, the ledger records each
      delivered item's words (`Ledger.revised`), and the near-duplicate check does not hold back the corrected copy;
    - follow-ups run one at a time after any lookup in flight, so each request made while the poll was out gets
      its own (integration change: the track skipped the follow-up when another lookup was running, which lost an
      item that answered the second of two requests made during one poll; `econ-judge.test.ts`).
  - It applies only with `syncOnDemand`: without the poll a stale copy is searched live, as with the flag off
    (integration fix: the track's lookup answered stale warm copies from the index even with no poll to bring them
    current).
  - The agent's `ask_context` still waits for the poll.
  - `ObserveResult.pending` is true while a poll or follow-up left behind the answer is running (review fix: it was
    false, so an integrator that skips `/v1/pending` on false never saw the follow-up's delivery; the same holds for
    `judgeBehind`'s judge).
  - `SyncManager.isWarm` is new.
- `judgeBehind` (engine, with a model):
  - The fast path, `early` and the slow path decide as with no model, and judge-contested sure items go out at once.
  - The judge then reads the candidates that answer left out: the slow path's seats, or after an early answer the best
    eligible ones. That is bounded by `judgeCandidates` and the seats.
  - Its call goes through `Budget` with the judge's caps (`JUDGE_MAX_TOKENS`, `judgeWindowChars`, `judgeItemBytes`).
  - Its fresh picks are queued as a `model:` injection.
  - A failing, cut-off, unaffordable or `judgeTied`-untied call adds nothing.
  - Its trace has the reason `judge-behind`.
- Session state:
  - The work a lookup leaves running (`Session.behind`) is held on the session, keyed by tenant, user and session, and
    dropped with it.
  - The new test file has an isolation test: one user's poll and follow-up never reach another user's session, nor a
    forgotten one.
- Lab (merged with the lab base, docs/research/econ-lab.md, before this flag):
  - `pi-ab.ts` gains `--variant-config` (conditions `eden~name`, paired in one process) and `--cards FILE` (cards
    replayed from disk; missing ones made live and appended).
  - `hidden-funnel.ts` waits for work left behind a lookup, and counts on-demand polls by the sync's own count (a poll
    behind a lookup is in no trace).

With every flag off, `bun run eval` is unchanged except latency (66 fields compared, 0 differ), and the ALL funnel
gives the same delivered and decoy sets as main, task by task.

## Recommendation

- **Recommended configuration:** no model judge. `syncPollBehind` is a candidate for the next recommended
  configuration (`ALL2`, decided after the blind run); ALL stays the recommended configuration until then. Its cost
  to weigh there: the first answer can carry a copy the poll behind it then corrects, and the correction reaches only
  the agent's next request (or `/v1/pending`). How often that happens is unmeasured (the worlds are static).
- **Experimental, not recommended:** `judgeBehind`, off by default, kept for the blind run.
- **Expected impact, if the in-sample effects hold blind:**
  - facts found: unchanged by `syncPollBehind`; +0.07–0.09 hidden with `judgeBehind` (CI includes 0);
  - total cost: unchanged without the judge; about +$0.02 per 1,000 tasks with `judgeBehind`;
  - end-to-end time: about −0.4 s of the agent's task from Eden's critical path (530 → about 80 ms), roughly 5% of
    the 8.55 s p50, and −2.4 s against the judge on the path.

## Limits

- **In-sample only:** one live seed, with small paired samples. The budget cap cut the first run, unevenly across
  conditions.
- **Static simulation:** the worlds do not change between polls. `syncPollBehind`'s follow-up never fired in the
  benchmark. A live mailbox does change, and the follow-up then delivers what arrived later than the first answer.
  The integration added engine tests in a changing world (`econ-judge.test.ts`, "in a changing world"): an item that
  arrives while the poll is out reaches the agent's next request through the follow-up after silence and after a
  delivery, an unrelated arrival is delivered by no follow-up, and two requests made during one poll each get one.
  These are unit tests, not a measured rate.
- **Late additions:** `judgeBehind`'s additions arrive about 0.5–2 s after the first answer and reach only a later
  request. Of 105 tasks in run 1, 17 queued items arrived after the final answer.
- **Shared machine:** the wall-time intervals come from a shared 4-CPU machine.

## Reproduce

Run from the repo root. `$ALL` is D64's ALL configuration (D62's R plus `"sync": true`).

```bash
# Funnel (no model), flags off and with syncPollBehind, at both time scales:
bun packages/sim/src/lab/hidden-funnel.ts --suite hidden,heldout,heldout2,heldout3,heldout4 --no-record \
  --config "$ALL" --json f.json --cards packages/sim/lab/cards/cards-v2.jsonl [--time 1]
# ... with '"syncPollBehind":true' added to the config; with --judge live --seeds 41 for the judge's funnel
# ($0.005 a seed), and '"judgeBehind":true' for the judge behind.
# Realistic simulation:
bun packages/sim/src/quality-cli.ts --profile realistic --seed 41 --planner --judge none|perfect \
  --config "$CFG" --cards packages/sim/lab/cards/cards-v2.jsonl
# Live check (copy the card file first: the run appends to it):
bun packages/sim/src/lab/pi-ab.ts --suite hidden,heldout,heldout2,heldout3,heldout4 --seeds 43 \
  --variants hidden,control --conditions eden,eden-judge,eden~pb,eden-judge~jb --config "$ALL" \
  --variant-config '{"pb":{"syncPollBehind":true},"jb":{"syncPollBehind":true,"judgeBehind":true}}' \
  --cards cards-copy.jsonl --time-scale 1 --grader deepseek/deepseek-v4.1-flash --budget 0.26 --out live.json
```
