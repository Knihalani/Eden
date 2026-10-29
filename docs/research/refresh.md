# Stale cached items (D40)

Status: 2026-10-29, simulation only (planner on, `quality-cli`). No live model run (the key's spend limit); one small
timed run.

## The question

Eden delivers from its item cache on the fast path. A cached copy can be out of date: a meeting moved after Eden
cached the invitation. D35 gave `McpSource` a `fetch` mapping, but nothing used it. Is a refresh worth building, and
which?

## A simulation where items change

Until now the simulated sources never changed an item after it was cached. `--updates R` (packages/sim/src/updates.ts)
gives a share R of the facts whose detail holds a clock time (`12:30`: meetings, calls, appointments, flights) a new
version, the time moved one to three hours later, before a chosen later session. From that session on the connector
serves the new text, the labels ask for the new fact, and the agent's own tools see the new text. Scoring reads which
version a delivered, cached or judged text shows: a stale copy states the old fact, which no later turn needs.
`updates.staleDelivered` counts deliveries that showed an old version. A run with `--updates 0` scores exactly as
before (checked on four runs, and a test).

At `--updates 0.5` (planner on, fresh seeds 31–40, no refresh), stale copies were 7–10% of the deliveries of changed
items with no model (held-out A 5 of 65, B 10 of 103, realistic 5 of 69) and 3–5% with the perfect judge (5 of 150,
12 of 241, 6 of 165): rare, because most lookups search live, which re-caches the current copy. Each delivered item
is scored on its own line of the packet.

## Two mechanisms

1. **Deferral:** a cached item last fetched or seen in a lookup longer ago than `refreshAfterMs` is never delivered from
   the fast path. The cue goes to the slow path, which delivers the source's current copy when its live search returns
   it (and may still rank the cached copy when it does not).
2. **Refetch:** after that search, the best candidates still older than `refreshAfterMs` are re-read through their
   source's `fetch` (`SourceFanout.fetch`: the same breaker, rate limit and concurrency limit as a search, a timeout,
   redaction before anything is held), at most `maxRefreshes` per lookup.

## Tuning (zoo-tune, seeds 1–10, `--updates 0.5`)

Recall of must-know facts, paired per-seed gain over no refresh (95% t-interval, df 9), stale deliveries, calls per
lookup and total connector calls:

| Variant | Judge | Recall | Gain per seed | Stale | Calls per lookup | Total calls |
|---|---|---|---|---|---|---|
| no refresh | none | 0.245 | — | 4 of 61 | 5.37 | 26,315 |
| deferral, 2 h | none | 0.256 | +2.0 (−0.6–4.6) | 1 of 69 | 5.30 | 26,923 (+2.3%) |
| deferral and refetch, 2 h | none | 0.252 | +1.3 (−1.6–4.2) | 0 of 66 | 5.65 | 28,686 (+9.0%) |
| no refresh | perfect | 0.454 | — | 5 of 160 | 5.36 | 26,296 |
| deferral, 2 h | perfect | 0.484 | +5.8 (2.8–8.8) | 2 of 182 | 5.32 | 27,038 (+2.8%) |
| deferral and refetch, 2 h | perfect | 0.495 | +7.8 (5.4–10.2) | 1 of 185 | 5.64 | 28,691 (+9.1%) |

An earlier version of this table (before review fixes to scoring and update planning) also tried 1, 4 and 8 hours:
1 and 2 hours scored the same (sessions are at least 2 hours apart), 4 hours slightly lower, and 8 hours (tried
with refetching only) lower. Deferral
alone was chosen: on the tuning set refetching added recall only with the judge (+2.0 facts per seed over deferral,
within noise) for about 6% more calls.

## Held out (fresh seeds 31–40, no decision had used them)

`off` is no refresh; `defer` is deferral at 2 hours (the default); `+fetch` adds refetching (`maxRefreshes` 3). With
updates (`--updates 0.5`):

| Mix | Judge | Recall off → defer (gain per seed) | + fetch | Precision off → defer | Soft-fire rate off → defer | Stale off / defer / + fetch | Total calls: defer, + fetch (vs off) |
|---|---|---|---|---|---|---|---|
| held-out A | none | 0.249 → 0.260 (+2.1, −0.8–5.0) | 0.255 | 0.593 → 0.611 | 0.271 → 0.188 | 5 / 0 / 0 | +2.8%, +7.9% |
| held-out A | perfect | 0.448 → 0.474 (+4.6, 1.0–8.2) | 0.479 | 0.789 → 0.806 | 0.243 → 0.183 | 5 / 0 / 0 | +2.8%, +7.9% |
| held-out B | none | 0.261 → 0.290 (+5.3, 2.5–8.1) | 0.290 | 0.532 → 0.544 | 0.337 → 0.288 | 10 / 1 / 0 | +3.4%, +9.3% |
| held-out B | perfect | 0.558 → 0.581 (+4.1, 0.0–8.2) | 0.584 | 0.773 → 0.771 | 0.329 → 0.290 | 12 / 2 / 1 | +3.8%, +9.2% |
| realistic | none | 0.248 → 0.262 (+2.5, 0.3–4.7) | 0.258 | 0.586 → 0.614 | 0.211 → 0.185 | 5 / 0 / 0 | +2.9%, +8.5% |
| realistic | perfect | 0.438 → 0.460 (+4.0, 0.4–7.6) | 0.462 | 0.780 → 0.806 | 0.211 → 0.168 | 6 / 0 / 0 | +3.1%, +8.2% |

Calls per lookup fell about 1% with deferral (realistic 5.78 to 5.72), but it adds about 4% more lookups (realistic
4,840 to 5,030), so total connector calls rose 2.8–3.8%.

Without updates (`--updates 0`), deferral moved recall almost as much (A +1.9 and +4.3 facts per seed with no model
and the judge, B +4.8 and +3.5, realistic +2.7 and +3.8), with the same precision, soft-fire and call changes (total
calls +2.8% to +3.9%). No hard false fire in any run (1,316 silent turns per row).

## Reading

- **Deferral removed nearly every stale delivery.** Stale deliveries went from 5–12 per mix to 0–2. Precision rose 1–3
  points on five of six rows (flat on held-out B with the judge), and the soft-fire rate fell on every row. It costs
  about 3% more connector calls in all: fewer per lookup, more lookups.
- **Most of the recall gain is not about freshness.** It appears just as much without updates. A cue whose only
  confident hit is an hours-old cached copy now takes a live lookup, which finds more of what the turn needs (and the
  judge or the no-model fallback picks from it) instead of resending the old copy, which was often a soft fire.
- **A stale copy can still go out from the slow path.** When the live search does not return the item (the source is
  down, or no longer finds it), the slow path ranks the cached copy as before; the remaining stale deliveries (B, 1
  and 2) are these.
- **Refetching through `fetch` added calls, not recall.** On held-out mixes it moved recall by −0.7 to +0.9 facts per
  seed against deferral alone, within noise, for 5–6% more calls. In the simulation the slow path's live search
  nearly always returns the changed item; refetching would matter for an item search no longer finds, which this
  simulation rarely produces. It is built, tested and opt-in (`maxRefreshes`).
- **Latency, one small timed run.** Realistic, seeds 31–33, 3 users × 8 sessions, `--updates 0.5`, source latency
  and agent pacing at 1/20 of real time: every must-know fact delivered arrived before the agent's answer in both
  settings (23 of 122 without deferral, 27 of 122 with it); fast-path deliveries went from 10 to 2, and delivery
  latency medians per seed moved from 116, 138 and 71 ms to 116, 152 and 92 ms (scaled time). A deferred delivery
  waits for a lookup, but at this pacing the lookup lands before the agent answers. Small: not a measurement of real
  connectors' tail latency.
- **Not measured:** real connectors, and update rates other than 0 and 0.5.

## Reproduce

```bash
bun packages/sim/src/quality-cli.ts --profile realistic --seed 31 --planner --updates 0.5 --judge perfect \
  [--refresh-after-hours 0|2] [--max-refreshes 0|3]
```
