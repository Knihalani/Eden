# A13: Eden at 1,000 sources, part 2 (cards, the daily sync, and the user's own sources)

Status: measured 2026-11-07 on branch `claude/a13-scale2` (from `claude/lucid-hypatia-v9wqk5` at 598bd6ebe), A1's next
steps ([a1-scale.md](a1-scale.md)). Decisions D320–D324. Paid spend: $0 (every figure is a no-model run; card calls are
counted by a stub and priced at A1's measured $0.000181 a call on Haiku 5.5). Machine: 4 vCPU, 15 GiB, Bun 1.4.4,
`BUN_OPTIONS` and `OPENROUTER_API_KEY` unset; the funnels ran two processes at a time, often beside other work, so their
ms figures are not latencies.

## In plain words

A1 left a user with ~1,000 connected sources finding 53 of 96 hidden facts (76 with five sources), paying ~30x a
five-source user's card calls, and syncing past its cap every day. A13 fixes most of that:

- **The user's own sources are kept whole.** With 1,000 busy connectors the sync's cap (3,000 items) is filled by the
  newest items across all of them, so the user's mailbox kept a handful and was searched live. Now a source that a
  lookup routed to on evidence (a person it mentioned, or the request's words among its items) counts as one the user
  uses: if the cap cut it, it is read again from the top (up to half the cap), and the trim keeps used sources' items
  before anyone else's. **Hidden facts at 1,000 sources: 53 → 75 of 96 (seed 41), 50 → 74 (seed 42); five
  sources: 76 and 76.** Decoys rise with them at the five-source rate (50 → 68 and 48 → 63, against 70
  and 66 with five sources).
- **Cards only for what the user uses.** The card model read every synced item: 8,120 calls on the screen at 1,000
  sources (220 with five). Now, past 32 sources, only items of used sources, or naming someone the user's requests
  named, are read; the rest wait and are read if their source is ever used. **508 and 534 card calls (−94%),
  5,028 items sent (five sources: 3,239)**, with hidden facts and decoys unchanged by this switch alone. About $0.12 →
  $0.008 a user for the screen's cold start and first day.
- **The daily sync stays inside its cap.** Sweeps and background polls no longer store items older than the user's
  cut, the user's synced items are trimmed back once they pass 1.5x the cap, and a sweep stops once it has seen every
  item it holds. On the day bench (1,000 sources of 300 items, items arriving all day), day 3: **listing calls 4,161 →
  1,406, items listed 325,142 → 118,965, the bench's wall time 51.9 s → 10.6 s a day, and the cache no longer churns at
  its 5,000 cap.**
- **Routing reads what the cap threw away.** Each source keeps a small vocabulary sketch (a Bloom filter, 128 B–4 KB)
  of everything the sync listed from it, and routing adds the request's rarer words found there. Measured before the review
  fixes, inside the default it added 1 and 3 hidden facts and cut connector calls a task by about 13.
- **Nothing moves with five sources.** The usual funnel (train, seeds 41–42, 768 tasks) is identical task by task, and
  `bun run eval` is identical apart from latency fields.
- **What is left is the daily sweep's floor:** one listing call per source per active day, about 1,050–1,140 a user a day at
  1,000 sources. Free on first-party APIs, about $0.8 a user a day on Unified.to and $27–29 on Zapier MCP. Deletes need a
  sweep; sweeping sources the user never uses less often, with a re-read before anything from them is delivered, is the
  next step.

| Switch (all on in the default)                    | Decision | What it does                                                                                                                         | Effect at 1,000 sources                                                                                |
| ------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `cardsSourceAware`                                | D320     | Past 32 sources, card only items of used sources or naming the user's people; the rest wait for their source to be used              | card calls 8,120 → 447 alone (s41), 8,676 → 505 inside the default; hidden and decoys unchanged        |
| `syncKeepCut`                                     | D321     | Background polls and sweeps store nothing older than the user's cut; trim at 1.5x the cap; a sweep stops once its held ids are seen   | funnel identical; day bench: sweeps 3,801 → ~1,100 listings a day (300-item sources)       |
| `routeSketch`                                     | D322     | A per-source Bloom filter of listed terms, kept after the trim; routing adds the request's rarer terms it holds                       | inside the default: hidden +1/+3, connector calls −13 a task                                    |
| `syncEngagedDeep`                                 | D323     | A used source the cap cut is read whole again (up to half the cap) and kept first by the trim                                        | hidden 54 → 75 and 50 → 74 inside the default                                                                |
| `source-days.bench.ts`; the sweep floor           | D324     | An instrument for per-day listing and card calls; the floor is accepted for now                                                      | ~1,050–1,140 sweep listings a user a day                                                                     |

## How it was measured

- **Quality and per-screen cost:** `bun run funnel --jobs 2 --suite train1,...,train6 --seeds S [--set ARM] --json F --
  --noise-sources 995 --limit 16` (A1's screen: each simulated user has the world's five sources and 995 noise
  connectors; 12 users and 192 tasks a seed; reader stub; cards and intent replayed, noise items' card calls counted by
  the stub). Task-by-task diffs from the JSON's `perTask`. The five-source reference is the same command without
  `--noise-sources`. The usual screen is `bun run funnel --jobs 4` (train, seeds 41–42).
- **Per day:** `packages/engine/bench/source-days.bench.ts` (new, D324): one user, 1,000 in-memory sources (the
  workload's four and 996 noise connectors), every source gaining items through the day (mail 40 a day, each noise
  connector an exponential rate with mean 1 a day), the sync ticking every simulated minute, a working day of requests
  every 10 minutes and asks every 30, a stub card model under the servers' budget (`DEFAULT_LIMITS`, $0.25 a user a
  day). Cold start, then three days.

## Numbers

### Quality and calls at 1,000 sources

"Calls" is what the connectors received per task in the tasks' windows; card calls are the screen's total for 12
users.

| Arm (995 noise sources a user)                              | Hidden s41 | Decoys s41 | Calls/task s41 | Card calls s41 (items) | Hidden s42 | Decoys s42 | Calls/task s42 | Card calls s42 (items) |
| ----------------------------------------------------------- | ---------- | ---------- | -------------- | ---------------------- | ---------- | ---------- | -------------- | ---------------------- |
| Five world sources only (reference)                         | 76         | 70         | 2.8            | 220 (3,239)            | 76         | 66         | 2.8            | 217 (3,469)            |
| A1's default                                                | 53         | 50         | 54.5           | 8,120 (153,232)        | 50         | 48         | 57.5           | 8,029 (151,417)        |
| + `cardsSourceAware` alone                                  | 53         | 50         | 54.5           | 447 (2,795)            | 50         | 48         | 57.5           | 449 (2,910)            |
| + `syncKeepCut` alone (final form)                          | 53         | 50         | 54.5           | 8,120                  | –          | –          | –              | –                      |
| + `routeSketch` alone                                       | 54         | 52         | 45.9           | 8,104                  | 50         | 49         | 48.5           | 8,011                  |
| + `syncEngagedDeep` alone                                   | 74         | 68         | 60.3           | 8,886                  | 71         | 61         | 61.8           | 8,701                  |
| **The new default** (after the review fixes)                | **75**     | **68**     | **48.6**       | **508 (5,028)**        | **74**     | **63**     | **49.5**       | **534 (5,542)**        |
| new default before the review fixes                         | 75         | 68         | 47.0           | 505 (5,024)            | 74         | 64         | 47.8           | 518 (5,517)            |
| … minus `cardsSourceAware` (before the fixes)               | 75         | 68         | 47.0           | 8,676 (163,240)        | 74         | 64         | 47.8           | 8,557 (160,695)        |
| … minus `syncEngagedDeep` (before the fixes)                | 54         | 52         | 45.9           | 457                    | 50         | 49         | 48.5           | 481                    |
| … minus `syncKeepCut` (before the fixes)                    | 75         | 68         | 47.0           | 505                    | 74         | 64         | 47.8           | 518                    |
| … minus `routeSketch` (earlier engagement rule)             | 74         | 68         | 60.3           | 512                    | 71         | 61         | 61.8           | 482                    |

The minus arms ran before the review fixes (used sources capped at half the cap, the 64 most recent; a deferred card read
whatever the source count; a saturated sketch restarts), which moved the default by 0 and 0 hidden facts, −0 and −1
decoys, +1.6 and +1.7 calls a task, +3 and +16 card calls. Card calls at A1's $0.000181: $0.1225 a user for the screen
under A1's default, $0.0077–0.0081 now, $0.0033 with five sources. Decoys per hidden fact 0.91 and 0.85 (five sources
0.92 and 0.87): the extra hidden facts come with decoys at the five-source rate, as D264 and D265 accepted. The usual
funnel (`bun run funnel --jobs 4`, train, seeds 41–42, 768 tasks) is identical task by task with every A13 switch on
(305/267, 2.7 calls a task); `bun run eval` differs only in its latency fields.

### Per user per day (`source-days.bench.ts 1000 N 3`)

| Run (day 3 unless named)            | Listing (sweeps, deep reads) | Listing on demand | Searches | Card calls ($) | Items listed | Synced held | Bench wall |
| ----------------------------------- | ---------------------------- | ----------------- | -------- | -------------- | ------------ | ----------- | ---------- |
| 300 items a source, A1's default    | 3,801                        | 360               | 406      | 605 ($0.110)   | 325,142      | 5,000 (cap) | 51.9 s     |
| 300 items a source, new default     | 1,115                        | 291               | 541      | 424 ($0.077)   | 118,965      | 3,092       | 10.6 s     |
| 300 items, cold start, A1's default | 1,000                        | 0                 | 3        | 1,365 ($0.247) | 99,793       | 3,000       | 14.5 s     |
| 300 items, cold start, new default  | 1,000                        | 0                 | 3        | 0 (deferred)   | 99,793       | 3,000       | 12.7 s     |
| 20 items a source, A1's default     | 1,019                        | 121               | 415      | 136 ($0.025)   | 22,790       | 5,000 (cap) | 2.1 s      |
| 20 items a source, new default      | 1,054                        | 109               | 352      | 90 ($0.016)    | 23,543       | 3,095       | 2.2 s      |
| 20 items, cold start, A1 / new      | 1,000 / 1,000                | 0                 | 3        | 389 ($0.070) / 0 | 19,961     | 3,160 / 3,000 | 2.9 / 2.7 s |

Day 1 has no sweep (the user is idle overnight and the first sweep is due a day after the backfill); the new default's
day-1 card calls (266 at 300 items, $0.048) are the deferred items of sources the day's requests used. With 20-item
sources every source fits one page, so a sweep is one call either way and the gain is the cap and the cards. The
last arm of the bench ran once each; the run before the review fixes gave 1,081 / 171 / 516 and 183 card calls.

Priced on the plans in market.py's `CONNECTORS` (packages/sim/lab/before-after/market.py; `CONNECTOR_PLANS` in
`server/src/digest.ts`), day 3, per user per day (listings + searches):

| Plan ($ per 1,000 calls)        | A1's default (4,567 calls) | New default (1,947 calls) | Sweep floor alone (1,115) |
| ------------------------------- | -------------------------- | ------------------------- | ------------------------- |
| First-party APIs (quota only)   | $0                         | $0                        | $0                        |
| Composio (overage, 0.30)        | $1.37                      | $0.58                     | $0.33                     |
| Unified.to (Pro, 0.75)          | $3.43                      | $1.46                     | $0.84                     |
| Arcade.dev (Team, 10)           | $45.67                     | $19.47                    | $11.15                    |
| Pipedream Connect (overage, 12) | $54.80                     | $23.36                    | $13.38                    |
| Zapier MCP (10k tasks, 25.8)    | $117.83                    | $50.23                    | $28.77                    |

Card calls add $0.110 → $0.077 a day at 300 items a source (a model cost, the same on every plan).

## What was tried and changed on the way

- **Filtering a lookup's own poll by the cut** lost 2 of 96 hidden facts at 1,000 sources (51/48 against 53/50; 8 task
  changes, none gained): what an on-demand poll stores (its source's newest few items) is routing evidence. Only
  background stores are filtered.
- **Trimming right after the backfill** (back to the cap once a page over it) lost 2 too (51/46): the backfill's last
  pages are routing evidence as well. The trim waits for 1.5x the cap, before the cache's own synced cap (5,000) would
  evict by sync order.
- **Counting every routed source as used** (first build) carded 910 calls' worth of items; counting only sources routed
  on evidence (score above the prior's draw) cut it to 447 at the same hidden facts; with the sketch on, a sketch match
  alone made 600 more card calls for no hidden fact (all with: 1,099 against 505), so a sketch match routes but does
  not make a source used.
- **A stronger sketch weight** (2x, 4x the log boost) did not add hidden facts on its own (54/96 each): routing was not
  the binding limit; the cut copies were. With the cap lifted to 30,000 (no copy cut) the old default reached 70/96,
  which pointed at keeping the user's own sources whole (D323).
- **The people rule** (an unused source's item naming someone the user's requests named) changed no number on this
  screen (the requests rarely name the noise items' people); kept as the cheap case the task asked for.

## What is left

- **The daily sweep's floor.** A sweep re-lists each source once per active day to catch deletions (D57), so a
  1,000-source user costs ~1,100 listing calls a day however little changed; on per-call connector plans that is most
  of the bill above. Sweeping a source no lookup has used for days less often would cut it, but a deleted item could
  then be delivered: the trial deleted in A8 (D297) lost removals that way. The safe shape is a longer sweep interval
  for unused sources plus a re-read before anything from such a source is delivered (D126's path); measure the delete
  lag and the calls together. **Done in A21 (D356, [a21-scale.md](a21-scale.md)):** 1,114 → 284 sweep listings a day,
  no rise in deleted or stale deliveries.
- **Card batches are smaller.** Deferred items arrive in small groups as sources become used, so a card call carries
  fewer items (10 against 15 with five sources). The enricher could wait for a fuller batch; not measured.
- **Churn among used sources.** A user's used sources are the 64 most recent; on the day bench (asks naming 60
  people at random) the set turns over, and a source used again after it left is read whole again if cut: day-3 card
  calls at 300 items were 183 before that bound and 424 after it (still below A1's 605). A deep read stops at half the
  cap, and the used items the trim keeps first are bounded at half the cap in all; a deep read cut short is not
  retried until the source leaves the used set and comes back.
- **Names noted from every lookup.** The people rule reads names from every lookup's cue, the push's on tool results
  too, not only the user's own requests; bounded at 256 a user, most recent kept.
- **A deep read across ticks** reads an offset listing two pages a tick; a delete between ticks can skip an item, and
  the copy reads as whole until the next sweep stores it (the backfill has the same weakness).
- **One-day screen.** The funnel is a cold start and 16 tasks; learned usefulness over days (`probeYield`, the source
  map's outcomes) and sources whose relevance changes are not on it.
- **Many users per server** was not re-measured: the sketch adds 128 B–4 KB per (user, source) and the deep reads add
  one-time listing calls (27 a user on the screen).

## Reproduce

```bash
unset BUN_OPTIONS OPENROUTER_API_KEY
bun run funnel --jobs 2 --suite train1,train2,train3,train4,train5,train6 --seeds 41 --json n995.json \
  -- --noise-sources 995 --limit 16                                           # the default; --set '{"<switch>":false}' for minus
bun run funnel --jobs 2 --suite train1,train2,train3,train4,train5,train6 --seeds 41 -- --limit 16   # five sources
bun run funnel --jobs 4 --baseline base.json                                   # the usual screen: unchanged
bun packages/engine/bench/source-days.bench.ts 1000 300 3                      # --config='{"syncKeepCut":false,...}'
bun run eval
```
