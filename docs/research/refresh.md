# Stale cached items (D40)

Status: 2026-10-29, simulation only (planner on, `quality-cli`). No live model run (the key's spend limit), and no
timed run: the latency a deferred delivery adds was not measured.

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

At `--updates 0.5` (planner on, 10 seeds per mix, both judge settings), stale copies were 2–11% of the deliveries of
changed items (zoo-a 2 of 70 with no model, zoo-b 12 of 110, realistic 3 of 63): rare, because most lookups search
live, which re-caches the current copy.

## Two mechanisms

1. **Deferral:** a cached item last fetched or seen in a lookup longer ago than `refreshAfterMs` is never delivered from
   the fast path. The cue goes to the slow path, whose live search brings the source's current copy.
2. **Refetch:** after that search, the best candidates still older than `refreshAfterMs` are re-read through their
   source's `fetch` (`SourceFanout.fetch`: the same breaker, rate limit and concurrency limit as a search, a timeout,
   redaction before anything is held), at most `maxRefreshes` per lookup.

## Tuning (zoo-tune, seeds 1–10, `--updates 0.5`)

Recall of must-know facts, paired per-seed gain over no refresh (95% t-interval, df 9), stale deliveries, calls per
lookup:

| Variant | Judge | Recall | Gain per seed | Stale | Calls per lookup |
|---|---|---|---|---|---|
| no refresh | none | 0.245 | — | 4 of 61 | 5.37 |
| deferral and refetch, 2 h | none | 0.252 | +1.3 (−1.6–4.2) | 0 of 66 | 5.65 |
| deferral only, 1 h, 2 h or 4 h | none | 0.256 | +2.0 (−0.6–4.6) | 1 of 69–71 | 5.30 |
| no refresh | perfect | 0.454 | — | 2 of 160 | 5.36 |
| deferral and refetch, 1 h or 2 h | perfect | 0.495 | +7.8 (5.4–10.2) | 0 of 185 | 5.64 |
| deferral and refetch, 4 h | perfect | 0.494 | +7.7 (4.4–11.0) | 0 of 191 | 5.61 |
| deferral and refetch, 8 h | perfect | 0.479 | +4.8 (2.3–7.3) | 1 of 185 | 5.54 |
| deferral only, 1 h or 2 h | perfect | 0.484 | +5.8 (2.8–8.8) | 1 of 182 | 5.32 |
| deferral only, 4 h | perfect | 0.481 | +5.1 (1.1–9.1) | 1 of 187 | 5.32 |

Thresholds of 1 and 2 hours scored the same (sessions are at least 2 hours apart). Refetching added about 5% to calls
per lookup; deferral alone cut them about 1%.

## Held out (fresh seeds 31–40, no decision had used them)

`off` is no refresh; `defer` is deferral only at 2 hours (the default); `+fetch` adds refetching (`maxRefreshes` 3).
With updates (`--updates 0.5`):

| Mix | Judge | Recall off → defer (gain per seed) | + fetch | Precision off → defer | Soft-fire rate off → defer | Stale off / defer / + fetch | Calls off / defer / + fetch |
|---|---|---|---|---|---|---|---|
| held-out A | none | 0.249 → 0.260 (+2.1, −0.8–5.0) | 0.255 | 0.593 → 0.611 | 0.271 → 0.188 | 5 / 0 / 0 | 5.63 / 5.57 / 5.84 |
| held-out A | perfect | 0.448 → 0.474 (+4.6, 1.0–8.2) | 0.479 | 0.789 → 0.806 | 0.243 → 0.183 | 4 / 0 / 0 | 5.60 / 5.53 / 5.80 |
| held-out B | none | 0.261 → 0.290 (+5.3, 2.5–8.1) | 0.290 | 0.532 → 0.544 | 0.337 → 0.288 | 10 / 1 / 0 | 5.54 / 5.44 / 5.76 |
| held-out B | perfect | 0.558 → 0.581 (+4.1, 0.0–8.2) | 0.584 | 0.773 → 0.771 | 0.329 → 0.290 | 11 / 0 / 0 | 5.49 / 5.42 / 5.70 |
| realistic | none | 0.248 → 0.262 (+2.5, 0.3–4.7) | 0.258 | 0.586 → 0.614 | 0.211 → 0.185 | 5 / 0 / 0 | 5.78 / 5.72 / 6.04 |
| realistic | perfect | 0.438 → 0.460 (+4.0, 0.4–7.6) | 0.462 | 0.780 → 0.806 | 0.211 → 0.168 | 5 / 0 / 0 | 5.75 / 5.70 / 5.98 |

Without updates (`--updates 0`), deferral moved recall almost as much (A +1.9 and +4.3 facts per seed with no model
and the judge, B +4.8 and +3.5, realistic +2.7 and +3.8), with the same precision and soft-fire changes. No hard false
fire in any run (1,316 silent turns per row).

## Reading

- **Deferral removed nearly every stale delivery and paid for itself.** Stale deliveries went from 4–11 per mix to
  0–1, calls per lookup fell about 1%, precision rose 1–3 points on five of six rows (flat on held-out B with the
  judge), and the soft-fire rate fell on every row.
- **Most of the recall gain is not about freshness.** It appears just as much without updates. A cue whose only
  confident hit is an hours-old cached copy now takes a live lookup, which finds more of what the turn needs (and the
  judge or the no-model fallback picks from it) instead of resending the old copy, which was often a soft fire.
- **Refetching through `fetch` added calls, not recall.** On held-out mixes it moved recall by −0.7 to +0.9 facts per
  seed against deferral alone, within noise, at about 5% more calls. In the simulation the slow path's live search
  nearly always returns the changed item; refetching would matter for an item search no longer finds, which this
  simulation rarely produces. It is built, tested and opt-in (`maxRefreshes`).
- **Not measured:** the latency a deferral adds (the delivery moves from the fast path to the slow path's lookup; at
  `--time 0` latency is not meaningful), real connectors, and update rates other than 0 and 0.5.

## Reproduce

```bash
bun packages/sim/src/quality-cli.ts --profile realistic --seed 31 --planner --updates 0.5 --judge perfect \
  [--refresh-after-hours 0|2] [--max-refreshes 0|3]
```
