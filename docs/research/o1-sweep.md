# O1: the weekly sweep of unused sources, spread over the week (`syncSweepSpread`, D604)

2026-11-11, O1. $0: no model call. Simulated data only. Branch `claude/o1-sweep`, cut from `claude/o1-promote`.

## In plain words

- **The problem.** A source the user does not use is re-listed once a week (D356). A user's sources are
  backfilled together, so a week later they all come due in the same sync tick: on the day bench a 1,000-source
  user's Eden made 1,041 listing calls in one minute of day 8 and again on day 15, and almost none in between. The
  sync's call budget is per source, so nothing spreads them. A connector platform that limits calls a minute sees
  a burst of a thousand.
- **The change (a trial, off).** Each unused source gets its own point in the week, a hash of the tenant, the user
  and the source, and is swept at the first tick past that point. Nothing is saved for it. No source waits longer
  than a week (D356's bound holds, and its doubt of unswept copies is untouched). A sweep comes early, by up to a
  week, each time the source's last sweep was off its point: the first one, a return after a week or more idle (the
  return still lists every source in one tick, then they spread again), or a source that stops being used.
- **Measured** (`source-days.bench.ts 1000 300 16`, one run each; the counts move by a few percent between runs, and
  the reviewer's rerun read the same way: worst day 1,039 → 200, steady week 1,312 → 1,313):
  - Most background listings in one day: **1,041 → 207**.
  - A steady week (days 9–15): 1,286 → 1,278 listings. The same.
  - The first week (days 1–7): 183 → 1,220 listings. This is the cost: the first sweep comes early. On this bench
    every source is connected at once, so the whole first sweep lands in week one; against the default at the same
    instant the spread is ahead by between nothing and one sweep a source, half a sweep on average, once in the
    user's life.
  - The bench's wall time over the steady week: 19.1 s → 13.9 s, that week's worst day 11.5 s → 2.2 s (one run,
    this box).
  - **Card calls rise.** Over the steady week the card model was called 202 → 278 times (+38%; the reviewer's rerun
    210 → 303) for fewer items (1,480 → 942): items that arrive a few at a time make smaller batches. The bench
    prices a call flat ($0.0365 → $0.0503 a user a week); the token cost was not measured and could go either way
    (more calls of fixed prompt, fewer items). This is a paid model role, so it decides the trial.
  - Stale and deleted deliveries with every source unused (`quality-cli --never-used`, 16 users × 20 sessions):
    stale 11 → 12 of 122 updates, deleted items delivered 2 of 4 → 1 of 5, re-reads 2,461 → 2,089. One item
    either way; no interval, so read it as "no sign of harm", not as a measured level.
- **Not measured.** The worst single tick with the spread on: sweeps run only while the user is active, so the
  points that pass overnight come due at the day's first tick (the reviewer's probe, 200 sources, one active hour
  a day: 19–32 listings in that tick, about a seventh of the sources, against all of them). A connector's real
  rate limits; the cards' token cost; many users on one server (their points differ by the hash, and
  they connect at different times anyway).
- **Why it is a trial and not the default.** Steady listings are equal and the worst day is five times smaller,
  but two costs stand against it: the early sweeps (about 500 listings for a 1,000-source user on average, at
  sign-up and again after a long absence) and the card calls above. D112 promotes on "better or neutral at no extra
  paid cost", so it is promoted only if the cards' tokens a week are not higher on a run that prices tokens (or the
  cards batch across ticks) and the owner accepts the early sweeps; else it is deleted on its end date.

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
bun packages/engine/bench/source-days.bench.ts 1000 300 16
bun packages/engine/bench/source-days.bench.ts 1000 300 16 '--config={"syncSweepSpread":true}'
packages/sim/lab/n1/qrun.sh spread-off 0 '{"syncUnusedSweepMs":604800000}' --never-used
packages/sim/lab/n1/qrun.sh spread-on 0 '{"syncUnusedSweepMs":604800000,"syncSweepSpread":true}' --never-used
python3 packages/sim/lab/f1/fresh.py off=.local/n1/q-spread-off.json on=.local/n1/q-spread-on.json
```

Outputs: `packages/sim/lab/o1/sweep/` (`days-off.txt`, `days-on.txt`, `quality.txt`). Test:
`packages/engine/src/unused-sweep.test.ts` (40 unused sources, two users, three weeks: off, all on one day; on, at
most half on any day, the first within a week, then every seven days, the two users' points apart; and a sweep
inside a day of the last one waits for a frozen user's cache, the review's finding).

## What else was looked at (not built)

After D603 the calls left on a short task at 1,000 sources (4.8 on the funnel's seed 41) are almost all on the
user's own five connectors: 2.1–2.4 on-demand poll listings, 1.3–1.5 lookup searches and 0.8–1.2 searches of a cut
copy behind; the noise connectors take 0.1–0.4. Over a real week the unused sources' sweep (1,000 listings) is
about as many calls as everything else in this bench (D602 records why skipping it cannot be priced in the lab).
