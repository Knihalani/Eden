# O1: the weekly sweep of unused sources, spread over the week (`syncSweepSpread`, D604)

2026-11-11, O1. $0: no model call. Simulated data only. Branch `claude/o1-sweep-2`.

## In plain words

- **The problem.** A source the user does not use is re-listed once a week (D356). A user's sources are
  backfilled together, so a week later they all come due in the same sync tick: on the day bench a 1,000-source
  user's Eden made about 1,030 listing calls in one minute of days 8, 15 and 22, and about 40 a day in between.
  The sync's call budget is per source, so nothing spreads them. A connector platform that limits calls a minute
  sees a burst of a thousand.
- **The change (a trial, off).** Each unused source gets its own point in the week, a hash of the tenant, the user
  and the source, and is swept there every week. Nothing is saved for it. A source whose last sweep was not at its
  point (after the backfill, after the user was away more than a week and a half, after `sweepSoon`) waits for
  its point: between 4 and 11 days, once, in place of 7. So the spread adds no sweep on average (the first build
  swept early instead and cost a whole extra sweep in week one; the parent asked for this form). Copies not swept
  for more than a day are re-read before delivery as ever (D356), which is what makes the 11 days safe to hand
  over; what can be late is a new or deleted item's discovery, by up to four days, once.
- **Measured** (`source-days.bench.ts 1000 300 23`, one run each; counts move by a few percent between runs):

  | Background listings | Off | On |
  | --- | --- | --- |
  | Worst day | 1,035 | 196 |
  | A steady week (days 15–21) | 1,293 | 1,291 |
  | Days 2–22 (three sweeps each) | 3,727 | 3,212 |
  | The first week (days 1–7) | 148 | 497 |

  The first week is higher because three sevenths of the sources have their point on days 5–7; the other four
  sevenths come on days 8–11, later than the default's day 8.
  - Bench wall time on its worst day: 11.9 s → 2.3 s; over the steady week 14.9 s → 13.4 s (one run, this box).
  - **Card calls rise, carded items fall.** Steady week: 176 → 253 calls (+44%) for 1,422 → 871 items. Items that
    arrive a few at a time make smaller batches. By the sizes in run 3's ledgers (o1-earn.md; 461 card calls: about
    2,700 input tokens fixed a call, about 400 input and 100 output tokens an item) that is roughly 16% fewer
    tokens, not more: **an estimate, not a measurement**, and I did not find why fewer items are carded, so I do
    not claim it as a saving.
  - Stale and deleted deliveries with every source unused (`quality-cli --never-used`, 16 users × 20 sessions):
    stale 11 of 122 → 11 of 137 updates, deleted items delivered 2 of 4 → 2 of 8, re-reads 2,461 → 2,294. Level;
    no interval.
- **Not measured.** The worst single tick with the spread on (sweeps run only while the user is active, so the
  points that pass overnight come due at the day's first tick: about a seventh of the sources against all of
  them); a connector's real rate limits; the cards' token cost; many users on one server (their points differ by
  the hash, and they connect at different times anyway).
- **Verdict: a trial for the owner, not promoted.** The parent's bar was "the worst-day cut with no first-week
  increase and stale deliveries not up". The worst day is five times smaller and stale deliveries are level, but
  the first week still rises (148 → 497 listings, repaid by day 22) and the card calls' cost is an estimate. It is
  promoted if a run that prices card tokens reads them not higher; else deleted on its end date.

## Memory per user with the rare-word table (asked by the parent after D603)

`users.bench.ts 200 3000 --world --waves=4`, the default against `--config={"sourceYieldEarn":false}` (no table),
one run each, three sources a user (the bench's shape, so the table is small here; at 1,000 sources it is up to
1 MB, o1-earn.md §2c):

| | Default (table on) | Earn rule off |
| --- | --- | --- |
| Live, a quarter active: heap a user | 1.70 MB | 1.68 MB |
| Live: RSS a user | 3.44 MB | 3.49 MB |
| Frozen: heap a user | 0.43 MB | 0.42 MB |
| Frozen: RSS a user | 0.91 MB | 0.88 MB |
| Frozen: kept beside the blobs | 144.7 KB | 128.3 KB |
| First read after a freeze, p50 | 110 ms | 105 ms |

So a three-source user at the cap costs about 16 KB more frozen and 0.02 MB more heap live; RSS differs by less
than the two runs' noise. The capacity figures of D651 move by under 2% for such users. A 1,000-source user is a
different case: up to 1 MB more, live and frozen (the table stays in memory for a frozen user).

## Reproduce

```bash
bun packages/engine/bench/source-days.bench.ts 1000 300 23
bun packages/engine/bench/source-days.bench.ts 1000 300 23 '--config={"syncSweepSpread":true}'
packages/sim/lab/n1/qrun.sh spread-off 0 '{"syncUnusedSweepMs":604800000}' --never-used
packages/sim/lab/n1/qrun.sh spread-on 0 '{"syncUnusedSweepMs":604800000,"syncSweepSpread":true}' --never-used
python3 packages/sim/lab/f1/fresh.py off=.local/n1/q-spread-off.json on=.local/n1/q-spread-on.json
```

Outputs: `packages/sim/lab/o1/sweep/` (`days-off.txt`, `days-on.txt`, `quality.txt`). Test:
`packages/engine/src/unused-sweep.test.ts` (40 unused sources, two users, four weeks: off, all on one day; on, at
most half on any day, the first 4 to 11 days after the backfill, then every seven days, no more listings than off,
the two users' points apart, and every sweep waits for the user's cache first, the review's finding).

The first build (commit ea151a3d) swept a source at the first tick past its point whatever its last sweep: the
worst day 1,041 → 207, but the first week 183 → 1,220 listings, and the review found it could sweep a frozen
user without thawing the cache through `ready`.

## What else was looked at (not built)

After D603 the calls left on a short task at 1,000 sources (4.8 on the funnel's seed 41) are almost all on the
user's own five connectors: 2.1–2.4 on-demand poll listings, 1.3–1.5 lookup searches and 0.8–1.2 searches of a cut
copy behind; the noise connectors take 0.1–0.4. Over a real week the unused sources' sweep (1,000 listings) is
about as many calls as everything else in this bench (D602 records why skipping it cannot be priced in the lab).
