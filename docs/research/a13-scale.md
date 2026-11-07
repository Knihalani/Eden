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
  before anyone else's. **Hidden facts at 1,000 sources: 53 → 75 of 96 (seed 41), 50 → {{NEW42}} (seed 42); five
  sources: 76 and {{FIVE42}}.** Decoys rise with them at the five-source rate (50 → 68 and 48 → {{NEWD42}}, against 70
  and {{FIVED42}} with five sources).
- **Cards only for what the user uses.** The card model read every synced item: 8,120 calls on the screen at 1,000
  sources (220 with five). Now, past 32 sources, only items of used sources, or naming someone the user's requests
  named, are read; the rest wait and are read if their source is ever used. **505 and {{CARDS42}} card calls (−94%),
  5,024 items sent (five sources: 3,239)**, with hidden facts and decoys unchanged by this switch alone. About $0.12 →
  $0.008 a user for the screen's cold start and first day.
- **The daily sync stays inside its cap.** Sweeps and background polls no longer store items older than the user's
  cut, the user's synced items are trimmed back once they pass 1.5x the cap, and a sweep stops once it has seen every
  item it holds. On the day bench (1,000 sources of 300 items, items arriving all day) **listing calls a day 4,229 →
  1,316, items listed 329,368 → 112,782, sync CPU 54 s → 7.6 s a day, and the cache no longer churns at its 5,000 cap.**
- **Routing reads what the cap threw away.** Each source keeps a small vocabulary sketch (a Bloom filter, 128 B–4 KB)
  of everything the sync listed from it, and routing adds the request's rarer words found there. Inside the new
  default it adds 1 and {{SK42}} hidden facts and cuts connector calls a task by about 13.
- **Nothing moves with five sources.** The usual funnel (train, seeds 41–42, 768 tasks) is identical task by task, and
  `bun run eval` is identical apart from latency fields.
- **What is left is the daily sweep's floor:** one listing call per source per active day, about 1,020 a user a day at
  1,000 sources. Free on first-party APIs, about $0.77 a user a day on Unified.to and $26 on Zapier MCP. Deletes need a
  sweep; sweeping sources the user never uses less often, with a re-read before anything from them is delivered, is the
  next step.

| Switch (all on in the default)                    | Decision | What it does                                                                                                                         | Effect at 1,000 sources                                                                                |
| ------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `cardsSourceAware`                                | D320     | Past 32 sources, card only items of used sources or naming the user's people; the rest wait for their source to be used              | card calls 8,120 → 447 alone (s41), 8,676 → 505 inside the default; hidden and decoys unchanged        |
| `syncKeepCut`                                     | D321     | Background polls and sweeps store nothing older than the user's cut; trim at 1.5x the cap; a sweep stops once its held ids are seen   | funnel identical; day bench: listing 4,229 → 1,316 a day, CPU 54 → 7.6 s a day (300-item sources)       |
| `routeSketch`                                     | D322     | A per-source Bloom filter of listed terms, kept after the trim; routing adds the request's rarer terms it holds                       | inside the default: hidden +1/+{{SK42}}, connector calls −13 a task                                    |
| `syncEngagedDeep`                                 | D323     | A used source the cap cut is read whole again (up to half the cap) and kept first by the trim                                        | hidden 54 → 75 (s41) inside the default                                                                |
| `source-days.bench.ts`; the sweep floor           | D324     | An instrument for per-day listing and card calls; the floor is accepted for now                                                      | ~1,020 sweep listings a user a day                                                                     |

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
users. {{TABLE}}

### Per user per day (`source-days.bench.ts 1000 N 3`)

{{DAYS}}

Priced on the plans in market.py's `CONNECTORS` (packages/sim/lab/before-after/market.py; `CONNECTOR_PLANS` in
`server/src/digest.ts`), day 3, per user per day (listings + searches):

{{PLANS}}

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

- **The daily sweep's floor.** {{FLOOR}}
- **Card batches are smaller.** Deferred items arrive in small groups as sources become used, so a card call carries
  fewer items (10 against 15 with five sources). The enricher could wait for a fuller batch; not measured.
- **Used is forever.** A source used once stays used for the user's sync's life; a deep read stops at half the cap and
  is not retried once a trim cut it. Neither showed on a one-day screen.
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
