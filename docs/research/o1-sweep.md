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
  than a week (D356's bound holds, and its doubt of unswept copies is untouched); a source's first sweep comes
  early, by up to a week, once.
- **Measured** (`source-days.bench.ts 1000 300 16`, one run each, the same seed):
  - Most background listings in one day: **1,041 → 207**.
  - A steady week (days 9–15): 1,286 → 1,278 listings. The same.
  - The first week (days 1–7): 183 → 1,220 listings. This is the cost: the first sweep comes early. On this bench
    every source is connected at once, so the whole first sweep lands in week one; against the default at the same
    instant the spread is ahead by between nothing and one sweep a source, half a sweep on average, once in the
    user's life.
  - The bench's wall time over the steady week: 19.1 s → 13.9 s, its worst day 11.5 s → 2.2 s (one run, this box).
  - Stale and deleted deliveries with every source unused (`quality-cli --never-used`, 16 users × 20 sessions):
    stale 11 → 12 of 122 updates, deleted items delivered 2 of 4 → 1 of 5, re-reads 2,461 → 2,089. One item
    either way; no interval, so read it as "no sign of harm", not as a measured level.
- **Not measured.** A connector's real rate limits; many users on one server (their points differ by the hash, and
  they connect at different times anyway).
- **Why it is a trial and not the default yet.** The steady cost is equal and the burst is five times smaller, but
  the early first sweep is extra connector calls once (about 500 for a 1,000-source user on average, against 1,000
  every week from then on). D112 promotes on "better or neutral at no extra paid cost"; whether a one-time half
  sweep counts is the owner's call. My recommendation is to promote.

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
most half on any day, the first within a week, then every seven days, the two users' points apart).

## What else was looked at (not built)

After D603 the calls left on a short task at 1,000 sources (4.8 on the funnel's seed 41) are almost all on the
user's own five connectors: 2.1–2.4 on-demand poll listings, 1.3–1.5 lookup searches and 0.8–1.2 searches of a cut
copy behind; the noise connectors take 0.1–0.4. Over a real week the unused sources' sweep (1,000 listings) is
about as many calls as everything else in this bench (D602 records why skipping it cannot be priced in the lab).
