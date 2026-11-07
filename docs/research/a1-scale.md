# A1: Eden at scale (1,000 sources per user, many users per server)

Status: measured 2026-11-07 on branch `claude/a1-scale` (from `claude/lucid-hypatia-v9wqk5` at c7cfc8fc9), session
A1 of the afternoon audit ([audit-1107-plan.md](audit-1107-plan.md)). Decisions D261–D265. Paid spend: $0 (every
figure here is a no-model run). Machine: 4 vCPU Xeon @ 2.10 GHz, 15 GiB, Bun 1.4.4, `BUN_OPTIONS` and
`OPENROUTER_API_KEY` unset; runs alternated with other work in this session, so load is stated where it mattered.

## In plain words

- **With ~1,000 connected sources, Eden stopped finding things.** On the $0 funnel (train1–6, seed 41, 16 tasks per
  suite), adding 995 unrelated connectors to each simulated user took hidden facts surfaced from **76/96 to
  26/96**. Two causes, both invisible with the lab's usual five sources:
  1. *A cut copy answered as if whole.* The background sync keeps a user's newest 3,000 items across all sources.
     With 1,000 busy connectors the newest 3,000 are mostly theirs, so the mailbox keeps a handful of items; but
     the mailbox still counted as "synced and current", so lookups answered it from the local index and never
     searched it. Anything older than the cut was unreachable. (This also bites a single large mailbox past
     3,000 items.)
  2. *Routing over 1,000 sources was close to random.* A lookup searches 3–6 sources. Routing ranks them by names the
     source has mentioned and by learned usefulness; a request that names no one ("have I used my ISA allowance?")
     has no mention evidence, and 1,000 fresh sources share the same prior, so the picks were a lottery.
- **It was also very expensive.** Each lookup polled every stale synced source before answering: **1,031 listing
  calls per task** at 1,000 sources (2.8 with five), and one funnel process grew past 4.5 GB of RSS (two shards were
  killed by the OOM killer). Everything the polls stored went to the card enricher, a paid model role: **27,236 card
  calls** over the screen against 267 with five sources (about $4.9 at the measured $0.000181 a call, for 12
  simulated users' 16 tasks each; the per-user daily budget caps it in production).
- **Cold start took about a minute of listing per user** at 50 ms per call (1,000 first pages read one after another),
  and stored 20,000 items to keep 3,000.
- **Memory per (user, source) pair was 12 KB** before any item: mostly two empty 4 KB latency histograms the
  fan-out keeps per pair it has called.

What changed (four new behaviours, measured neutral on the usual funnel and eval and better at 1,000 sources, are
promoted into the default; one was measured and deleted; the efficiency fixes change no output):

| Fix | Decision | What it does | Effect at 1,000 sources |
|---|---|---|---|
| One query per route; ids mapped through a Map; trim reads item times with one user lookup | D261 | Pure efficiency | CPU per event 7.44 → 5.7 ms, ask p50 12.2 → 7.6 ms (identical calls and decisions) |
| Sparse latency histograms | D261 | A histogram keeps up to 64 samples as bucket numbers before taking its 4 KB counters | 8,457 → 199–410 B per rolling histogram; per-source heap 12.0 → 4.2 KB |
| `syncBackfillLanes` 8 | D262 | 8 sources' backfill pages read at once | Cold start at 50 ms a call: 55.4 → 9.3 s wall; card calls −37% |
| ~~`syncBackfillShare`~~ (deleted) | D262 | First backfill page sized to the source's share of the cap | Cold-start CPU 3.7x lower, but more polls later (+40% listing at 100 items a source) and −3/96 hidden on one seed |
| `syncPollWidth` 8 | D263 | A lookup polls at most its 8 best-routed stale sources | 1,028 → ~21 listing calls per task |
| `syncLocalComplete` | D264 | A source whose synced copy the cap cut is searched live, not answered from the index | hidden 25 → 40 /96 (with D263) |
| `routeLocalHits` | D265 | Routing adds log2(1 + the source's items among the request's best local matches) | hidden 40 → 53 /96 (seed 41; 50 on seed 42) (with D263, D264) |

## How it was measured

Two new instruments:

- `packages/engine/bench/many-sources.bench.ts`: one user, N in-memory connectors that count calls (four workload
  sources with real requests, N−4 "noise" connectors), the shipped wiring with no key (`DEFAULT_CONFIG`, sync on,
  planner serving), a simulated clock (one minute per event). Reports cold start (ticks, listing calls, CPU, wall),
  calls and CPU per event and per ask, ask latency, heap. `--config=<json>` runs an arm.
- `bun run funnel ... -- --noise-sources N [--noise-items 20]` (`packages/sim/src/lab/noise-sources.ts`): N noise
  connectors beside the world's five, each a real `SimSource` (listing, search with a realistic profile's semantics,
  latency, errors, rate limit), work vocabulary, about 3% of items naming one of the world's people. Deterministic.

## Findings, ranked by impact

| # | What breaks | Where | Impact at 1,000 sources | Fixed? |
|---|---|---|---|---|
| 1 | A source whose synced copy the user's cap cut still answers as current: older items unreachable | `partner.ts` `localOf`, `sync.ts` | hidden facts 76 → 26 /96 (with #2) | D264 |
| 2 | Routing over many sources is a lottery when the request names no one | `source-map.ts` `route` | as #1 | D265 |
| 3 | Every lookup polls every stale synced source | `sync.ts` `freshen`, `partner.ts` `searchLive` | 1,031 listing calls a task; ~4.5 GB RSS a funnel process | D263 |
| 4 | Card enrichment (paid) follows what the sync stores, so it grows with the source count | `cards.ts`, `sync.ts` `store` | card calls 267 → 27,236 over the screen | D263, D262 (to 8,124); left: see below |
| 5 | Cold start reads a whole page from every source, one at a time, and stores 3–30x what it keeps | `sync.ts` `backfill` | 55 s wall at 50 ms a call; 12 s CPU at 100 items a source | D262 (wall); CPU left |
| 6 | 8 KB of empty latency counters per (user, source) pair | `@eden/primitives` `histogram.ts`, `guarded.ts` | 12 KB per source before items (8–16 MB a user) | D261 |
| 7 | One SQLite query per source per route; `Array.find` per routed id; a cache lookup per item per trim | `source-map.ts`, `partner.ts`, `sync.ts` | 7.4 ms CPU an event, 18.6 ms an ask | D261 |
| 8 | The backfill never trims after its last page (a user can hold up to a batch of pages over the cap) | `sync.ts` `backfill` | small; up to 8 pages with lanes | no (left) |
| 9 | The daily sweep re-lists every source up to `syncMaxItems` and stores what it lists, past the user's cap; polls do too | `sync.ts` `sweep`, `poll`, `store` | at 1,000 sources, a sweep is ≥ 1,000 calls a user a day and churns the cache's synced cap | no (left) |
| 10 | Live searches of cut sources cost calls and time where the copy used to (wrongly) answer: a single large mailbox now searches live on each lookup | D264 | 41–59 searches a task at 1,000 sources; 1–3 a lookup for one big mailbox (estimate) | accepted cost |

## Numbers

### Quality and calls at 1,000 sources (the funnel with 995 noise connectors)

`bun run funnel --jobs 2 --suite train1,...,train6 --seeds S --set '<arm>' -- --noise-sources 995 --limit 16`,
stub reader, cards and intent replayed, 96 hidden and 96 control tasks a seed. "Calls" is what the connectors received
per task (listings plus searches). ms/task is contended (2 processes) and only indicative.

| Arm (seed 41) | Hidden | Decoys | Calls / task | Listing | Search | ms / task |
|---|---|---|---|---|---|---|
| Five world sources only (no noise), old default | 76/96 | 70/96 | 2.78 | 2.78 | 0 | 8.2 |
| Old default, 995 noise sources | 26/96 | 23/96 | 1,031 | 1,031 | 0 | 2,855 |
| + `syncPollWidth` 8 (D263) | 25/96 | 25/96 | 20.9 | 20.8 | 0.02 | 26 |
| + `syncLocalComplete` (D264) | 40/96 | 40/96 | 79.6 | 20.5 | 59.1 | 55 |
| + `routeLocalHits` (D265) | 53/96 | 48/96 | 55.5 | 14.3 | 41.2 | 73 |
| + `syncBackfillLanes` 8 (D262): **the new default** | 53/96 | 47/96 | 55.3 | 14.2 | 41.0 | 48 |
| (deleted) + `syncBackfillShare` | 50/96 | 46/96 | 56.3 | 14.6 | 41.7 | 63 |

Card calls (the paid background role, stub-counted here) over the same screen: five sources 267; old default at 1,000
sources 27,236; + D263 12,773; + D264 12,948; + D265 12,807; + lanes 8,124; + share 4,929.

Seed 42, same suites: D263–D265 50/96 hidden, 46/96 decoys, 57.6 calls, 12,802 card calls; with lanes 8 50/96,
47/96, 57.5, 8,014 card calls; with the share too 50/96, 46/96, 57.9. With 100-item noise sources (one process per
suite, train1 and train2, seed 41; the harness's indexes of 99,500 noise items did not fit a 6-suite process):
lanes 8 13/32 hidden, 18/32 decoys, listing 27.2 and 19.8 a task; with the share 13/32, 15/32, listing 38.2 and 30.2.
The `syncLocalComplete` arm without the poll width was OOM-killed at
`--jobs 2` (it polls every stale source, as the old default does). The usual funnel (`bun run funnel --jobs 4`,
train, seeds 41–42, 768 tasks) with all five on: hidden 305/384, decoys 267/384, 2.69 calls a task, task by task
+0 −0 against the base tree; `bun run eval` identical apart from latency fields (precision 0.8276, recall 0.48,
falseFireRate 0).

### One user, 1,000 in-memory sources (`many-sources.bench.ts`)

| Run | Before | After |
|---|---|---|
| `1000 20 300 40`, 3 runs, D261 only: CPU an event | 7.44 (7.11–7.62) ms | 5.7 (4.9–6.08) ms |
| same: ask p50 / CPU an ask | 12.16 (12.05–12.23) / 18.63 ms | 7.59 (6.81–8.05) / 12.61 ms |
| same, D263 alone: listing calls an event / an ask | 3.29 / 7.08 | 0.85 / 3.75 |
| `1000 20 20 5 50` (50 ms a call): cold start wall, calls | 55.4 s, 1,000 (one lane) | 9.3 s, 1,000 (8 lanes); 8.7 s, 1,163 (8 lanes and share) |
| `1000 100 20 5 0`, 8 lanes, 2 runs: cold-start CPU, items stored, calls | 11.6–12.5 s, 99,685, 1,000 | 3.2–3.3 s, 22,095, 1,180 (share) |
| `N 1 60 10`, 2 runs: heap per extra source | 12.0 KB (+14.44 MB at 1,000) | 4.2 KB (+6.70 MB) |

The cold-start runs before D262 were one each (the 55.4 s arm and its 56.0 s twin from an earlier run agree).

### Histogram (`bun packages/primitives/bench/histogram.bench.ts`, before/after back to back, 2 pairs)

| Measure | Before | After |
|---|---|---|
| heap per `RollingHistogram`, 0 / 1 / 50 samples | 8,457 / 8,459 / 8,459 B | 199 / 267 / 410 B |
| quantile p95, 1,000 samples (p50) | 2.86–4.67 µs | 2.90–2.92 µs |
| quantile p95, 5 samples (p50) | 2.70–4.82 µs | 118–122 ns |
| record (p50) | 26.7–48.5 ns | 31.5–34.7 ns |
| rolling record+quantile (p50) | 4.67–4.97 µs | 5.47–5.63 µs |

The rolling bench is slower because its window resets to the few-samples form every simulated minute and then
promotes again; it is microseconds beside a source call.

## What is left

- **The sweep and polls past the cap (#8).** A daily sweep lists every source up to `syncMaxItems` and stores it all,
  and a poll stores each source's newest whatever the user's cut: at 1,000 sources that is a thousand-plus calls a
  user a day and items the cache's synced cap (5,000) then evicts, oldest synced first, which can be the user's
  newest mail. Next: a sweep that stops once it has seen every id it holds for the source, and a store that keeps
  nothing older than the user's cut.
- **Quality at 1,000 sources is still 50–53 of 96 against 76 with five.** Routing evidence is the gap: the boost reads
  only what is cached, and a cut mailbox holds few items. Learned per-user source usefulness (`probeYield`, the
  source map's outcomes) helps over a user's days, which this one-day screen does not show. A per-source profile
  (its vocabulary from what the backfill read, kept after the trim) would give routing evidence for every source.
- **Card enrichment at many sources (#4).** Even the new default makes about 30x the card calls of a five-source
  user on this screen (8,124 against 267), because cards follow every item the sync stores, most of them from
  connectors the user never asks about. The share cut that to 4,929 but cost polls; a better lever is to card only
  items of sources lookups have routed to (or that mention the user's people), within the cards' existing budget.
- **Many users per server.** Not re-measured here beyond per-source memory: router-sim and `sim:perf` use five sources
  a user. Per synced user the item cache is ~2 MB at 500 items (RealUse-1 E); a 1,000-source user adds ~4 MB of
  per-source state after D261 (12 MB before). Cold-start storms: a 1,000-source user's cold start still stores
  every first page (12 s of CPU at 100 items a source, on the event loop in 8-page batches); sizing first pages saved
  that but was not neutral (D262), so a cheaper store for items the trim will drop is the open lever.
- **The backfill overshoot (#7)** is small and left.
- **Live searches of cut copies (#9)** are the honest cost of D264; a large mailbox is searched live on lookups that
  route to it, as before sync.

## Reproduce

```bash
unset BUN_OPTIONS OPENROUTER_API_KEY
bun packages/engine/bench/many-sources.bench.ts 1000 20 300 40            # 3x; --config='{"syncPollWidth":0,...}' for an arm
bun packages/engine/bench/many-sources.bench.ts 1000 20 20 5 50          # cold start at 50 ms a call
bun packages/engine/bench/many-sources.bench.ts 1000 1 60 10             # per-source heap (1 item each)
bun packages/primitives/bench/histogram.bench.ts
bun run funnel --jobs 2 --suite train1,train2,train3,train4,train5,train6 --seeds 41 --set '<arm>' \
  --json out.json -- --noise-sources 995 --limit 16                       # --jobs 2: the old default needs ~4.5 GB a process
bun run funnel --jobs 4 --baseline base.json                              # the usual screen: unchanged
bun run eval
```
