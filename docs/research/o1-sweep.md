# O1: the weekly sweep of unused sources, spread over the week (`syncSweepSpread`, D604)

2026-11-11, O1. $0: no model call. Simulated data only. Branch `claude/o1-sweep-2`.

## In plain words

- **The problem.** A source the user does not use is re-listed once a week (D356). A user's sources are
  backfilled together, so a week later they all come due in the same sync tick: on the day bench a 1,000-source
  user's Eden made about 1,030 listing calls in one minute of days 8, 15 and 22, and about 40 a day in between.
  The sync's call budget is per source, so nothing spreads them. A connector platform that limits calls a minute
  sees a burst of a thousand.
- **The change (a trial, off).** Each unused source gets its own point in the week, a hash of the tenant, the user
  and the source, and is swept at the first tick past it, or a week after its last sweep if that comes first.
  Nothing is saved for it. So no source ever waits longer than it does with the switch off, whatever days the
  user is away, and D356's bound and its doubt of unswept copies are untouched.
- **Its cost.** A source whose last sweep was not at its point (after the backfill, after a return from more than
  a week away) is swept at its next point, up to a week early: half a sweep more a source on average, each time
  that happens. Two forms that avoid this were built and dropped: waiting for the point (4 to 11 days) left a
  user who is away four days of every week with sources on 14-day gaps for good, and a cap on that wait did not
  hold (the third review). A rule cannot be spread, add no sweep and never be later than the default at once.
- **Measured** (`source-days.bench.ts 1000 300 23`, one run each; counts move by a few percent between runs):

  | Background listings | Off | On |
  | --- | --- | --- |
  | Worst day | 1,035 | 214 |
  | A steady week (days 15–21) | 1,293 | 1,287 |
  | The first week (days 1–7) | 148 | 1,176 |
  | Days 1–23 | 3,785 | 4,102 |

  - Bench wall time on its worst day: 11.9 s → 2.3 s (one run, this box).
  - **Card calls rise, carded items fall.** Steady week: 176 → 262 calls (+49%) for 1,422 → 904 items; the bench
    prices a call flat, so its own dollar column reads $0.0319 → $0.0474 (+49%). Items that arrive a few at a
    time make smaller batches. A call's fixed cost is small: in run 3's ledgers (3,142 card calls) the fixed
    prefix is 1,319 tokens and was read from the prompt cache in all but 2 calls, 2% of the card bill at list
    prices; uncached input (the items' text) is 37% and output 59%. So the bill follows the items carded more
    than the calls, and would be lower with the spread **only because fewer items are carded**, which I did not
    explain: at equal items, more calls cost a little more. An estimate, not a measurement, and not claimed as a
    saving.
  - **Users who are away** (the test's `absences`, 200 unused sources, ten weeks, active 09:00–18:00, one run):

    | Active days | Longest gap, off → on | Most sources in one tick after week one | Sweeps |
    | --- | --- | --- | --- |
    | Monday to Friday | 7 → 7 days | 200 → 80 | 1,800 → 1,920 |
    | Three days a week | 7 → 7 days | 200 → 144 | 1,800 → 1,856 |

    The points that pass while the user is away come due at the first tick back, so the cut in the worst tick is
    2.5 times for a weekday user and 1.4 for a three-day one, not the always-on bench's 5.
  - `quality-cli --never-used` was run and is **not evidence either way**: its background-call column is 0 in
    both arms and I did not confirm its clock reaches a long sweep. The safety argument is that the spread only
    ever sweeps sooner; D356's doubt is untouched.
- **Not measured.** A connector's real rate limits; the cards' token cost; many users on one server (their points
  differ by the hash, and they connect at different times anyway).
- **Verdict: an off trial for the owner, not promoted.** The worst day is five times smaller at the same steady
  cost, but the first week costs a whole extra sweep (148 → 1,176 listings; real money on per-call plans) and the
  card calls' cost is an estimate. It is for an operator whose connector plan limits calls a minute. Promoted
  only if a run that prices card tokens reads them not higher and the owner accepts the early sweeps; else
  deleted on its end date.

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

Outputs: `packages/sim/lab/o1/sweep/` (`days-off.txt`, `days-on.txt`, `quality.txt`). Tests:
`packages/engine/src/unused-sweep.test.ts`: 40 unused sources, two users, four weeks (off, all on one day; on, at
most half on any day, the first within a week, then every seven days, the two users' points apart); three absence
patterns, where no source waits longer and no tick is larger than with the switch off (it fails on the form that
waited for the point); and a short long period, where a turn inside a day of the last sweep waits for the user's
cache (the first review's finding).

## What else was looked at (not built)

After D603 the calls left on a short task at 1,000 sources (4.8 on the funnel's seed 41) are almost all on the
user's own five connectors: 2.1–2.4 on-demand poll listings, 1.3–1.5 lookup searches and 0.8–1.2 searches of a cut
copy behind; the noise connectors take 0.1–0.4. Over a real week the unused sources' sweep (1,000 listings) is
about as many calls as everything else in this bench (D602 records why skipping it cannot be priced in the lab).

## Fewer on-demand polls for sources that send no notice: screened at $0, not kept (D605)

The parent asked whether the notify path's saving (2.2 calls a task with notices) can be had for connectors that
send none. The knob that exists is `syncStaleChance` (0.15): a copy is polled before a request when the chance
that its source gained an item since the last poll passes it. On static worlds a higher value looks free:

| `syncStaleChance` | Funnel, 5 sources, seed 41: poll listings a task | Surfaced | Days, 4 users: steady calls a request |
| --- | --- | --- | --- |
| 0.15 (default) | 2.7 | 154 / 142 | 1.34 |
| 0.4 | 1.7 | 154 / 142 | 0.65 |
| 0.8 | 1.0 | 154 / 142 | 0.42 |

Those screens cannot see staleness: the funnel's world does not change, and the days screen's changed items came
with a notice. `days-calls.ts --recap-notice none` (new, lab only) moves the day's items with no notice, so only a
poll or a sweep can find the change (4 users, 8 days, 79 moved items, `--notify-share 0.05`):

| `syncStaleChance` | Steady calls a request | Update packets (of 79 moved) | Requests holding an old copy undoubted |
| --- | --- | --- | --- |
| 0.15 (default) | 1.46 | 28 | 80 |
| 0.4 | 0.70 | 13 | 113 |
| 0.8 | 0.42 | 3 | 218 |

Halving the polls halves the updates that reach the agent. Not kept: the default stands. Two things this shows
beside the answer: the earlier "free" readings (moon-sync.md's 0.3 and 0.5 on the funnel) were of a static world;
and at the default, a change with no notice already reaches the agent as an update in only 28 of 79 cases on this
screen, which is the larger problem and a quality one (one run, simulated; the screen's moves happen at the day's
recap, so it is a hard case).

## The card calls' prompt cache: checked, nothing to fix

I had read run 3's card calls as "about 2,700 fixed input tokens a call, 29% cache-read" and told the parent that
better caching looked like the cheapest cut left in Eden's own model spend. That reading was wrong, and the ledgers
say so (`.local/modal/o1-earn2t-*/s*/ledger.jsonl`, role `eden.cards`, 3,142 calls; `inputTokens` there is the whole
prompt, cached part included):

- the fixed prefix is 1,319 tokens, and 3,140 of 3,142 calls read it from the cache (the two misses are first calls);
- a call averages 1,594 uncached input tokens (the items), 1,319 cache-read and 505 output tokens;
- at Haiku's list ratios (cache read 0.1, output 5 against input 1) the bill is 59% output, 37% uncached input,
  2% cache reads.

The cache already works. What a card call costs is its items' text going in and the cards and requests coming out;
a cut there changes what a card says, which is a quality change, not a caching fix. Nothing built.
