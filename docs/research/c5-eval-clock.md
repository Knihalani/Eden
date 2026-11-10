# C5: the no-model eval depended on the date (D435, D436)

**Status: current. Fixed 2026-11-10.**

## Symptom

`bun run eval` on the same commits (4fb7f1cd3, 2ef09df8d) read precision 0.65 on 2026-11-07 and 0.6842 on
2026-11-10. Recall (0.52) and falseFireRate (0) were the same on both days.

## Cause

`runScenarios` built its `ContextPartner` with no `now`, so the engine fell back to `Date.now`, and so did its
`Budget`s and `AskReader`. The events still carried the scenario's own times (`scenario.clock`, one millisecond per
event). Most engine paths take their time from the event (`buildCue(…, event.at, …)` in observe). The push does not:
it runs through `ask` (`internal.push`), whose cue is built at `this.now()`. So the push's "today" was the day the eval
ran.

Only one scenario reads a relative day that a different date could change: `large-vendor-freeze` (clock
2026-11-03). Its request is "Pay the Acme Logistics invoice 4471 today, please.", and invoice 4471 is "due 10
November".

- Run on 2026-11-10, "today" is 10 November. The handed candidates hold both anchors (Acme, and the 10th), so they
  settle the request, and `pushCandidatesSettled` (D400, 2 in the default) cuts the packet to 3 items: the hold,
  invoice 4390 and invoice 4471.
- Run on 2026-11-07, or on any other day, nothing settles the request, and the push hands all 5 candidates. That
  adds last year's hold (`docs:hold-2025`) and the Acme Catering invoice.

Both expected items are delivered on either day, so recall does not move. Delivered goes from 38 to 40, which takes
precision from 26/38 = 0.684 to 26/40 = 0.65. On 2026-11-11 the push hands 5 again, in a different order. So any
eval run on 10 November 2026 would have read 0.684.

**How it was found.** First, the wall clock was faked (`Date.now` and `new Date()` shifted) and each scenario's
counts were compared: only `large-vendor-freeze` differed. Next, the scenario's own clock was moved to 11-10, which
reproduced the 3. Last, the partner's `now` was shifted at one `this.now()` call site at a time, by filtering on the
stack. Of the 61 call sites, only `ask`'s `buildCue` moved the result.

## Fix

The engine does not change. The eval now passes one clock everywhere: `runScenarios` keeps a `clock` set by
`scenarioClock(scenario)` and advanced by each event, and passes `now: () => clock` to the partner, to every
`Budget` (`new Budget(limits, now, spend)`) and to the stub and live readers. `ItemCache`, the fan-out and the sync
take the partner's `now`. The query planner's `performance.now` only times deadlines, so it does not depend on the
date.

The eval's pinned no-model numbers are precision **0.65**, recall **0.52** and falseFireRate **0**: 26 of 50 expected
items found, and 38 → 40 delivered. They are the same under faked dates of 2026-11-07, 2026-11-10 and 2031-03-01, with
identical per-scenario counts. `run.test.ts` checks this with two tests, which run every scenario under three faked
dates and pin `large-vendor-freeze` to 5 delivered on 11-10. Both tests fail on the old harness.

D436 records that the push's cue is timed at `now()` rather than at its event. With an injected clock the two agree,
so this was left alone. Changing it would be a behaviour change and would need a measurement.

## The funnel

`hidden-funnel.ts` already passes `now: () => clock` to the partner, the cards and the reader. It was run under faked
dates of 2026-11-07 and 2026-11-10, with the preload reaching the subprocess through `BUN_OPTIONS`. Both runs read
hidden 314/384 and decoys 273/384, and the per-task JSON rows were identical once timing fields were left out.
