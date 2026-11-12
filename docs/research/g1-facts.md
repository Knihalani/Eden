# G1: hidden facts found and given — plans with a day (`pushDaySeats`, D1400)

Status: 2026-11-12, branch `claude/g1-facts`, session G1 (the owner's target 2). Tuning and screens on dev20 only
(seeds 41–44, shipped coverage on the world's clock, D1102). heldout20 was never read or run. No paid API call: the
live pair is **served by subagents (D1101), single-shot**, so its levels are not API figures; compare arms within the
run. Numbers marked **[EST]** are arithmetic; every other number comes from a command named here.

## 1. Where the facts go missing, before any lever ($0)

`bun run funnel --suite dev20 --seeds 41,42,43,44 -- --neutral --pool-dump P --corpus-dump C --ask-diag A` on main
(the default, shipped coverage, no check wired):

| hidden tasks (640) | count |
| --- | ---: |
| planted fact in the push's pool (the check's view) | 314 |
| a push ran, the fact is not in its pool | 143 |
| **no push started at all** | **183** |

The third row is the finding. `packages/sim/lab/g1/start.ts` reads each request as `observe` does (`pushStart`, then
the turn gate, D1014): of 160 hidden templates, 50 start by a listed verb, 33 by the open shape, 33 by the gate
alone, **23 are started by the rule and vetoed by the gate as statements, and 21 start nowhere**. Nearly all 44 are
plans said as statements, the phrasing a proactive partner exists for:

- "Tomorrow I'm doing the Ben Nevis hike with the running club lot." (a steroid injection in that knee today)
- "I'll pick Mum up from Heathrow Thursday after work." (her flight now lands at 06:15)
- "The new sofa's being delivered on Saturday." (the goods lift is out of service 30 Oct – 6 Nov)
- "Planning to hire a car in Scotland next weekend." (the photocard licence expired)

The funnel's ask (it always asks) cites 64 of the 183; the other 119 are never surfaced. In the live pipeline the
agent asks on about one request in eight, so most of the 183 are lost there.

By card (`--ask-diag`, the 326 facts not in the pool): 155 have a constraint card (F5's rule sheet, D1180, can reach
them once a push runs and its check is called), 164 have none (122 read for requests only, 42 the prefilter
rejects), 7 a preference card. By the suites' own labels the pool misses 65% of the no-word-overlap facts, 62% of
those needing world knowledge, 59% of non-English requests, 69% of calendar items, 80% of health and 83% of
residents' items.

What ties a missed fact to its request, when words do not, is very often **the day**: the request names a day and
the item is on it, spans it or writes it. But the engine did not read the day in many requests:

- a bare day of the month ("on the 20th", "the weekend of the 7th") resolved to nothing;
- "Monday the 9th" resolved to the coming Monday (2 November), not the 9th;
- a weekday in another language resolved to nothing, though the glossary (D1153) already knows "czwartek" and
  "الجمعة";
- an item that spans the day without writing it ("Mon 26 Oct – Fri 6 Nov", "until at least Monday 2 November") did
  not count as on it.

## 2. The lever: `pushDaySeats` (trial, D1400)

A plan with a day is an action on that day. With no model and no source call:

1. **The request's days are read further** (`days.ts`, `datedText`): a bare ordinal gets its month (the next such
   date; with a weekday before it, the next such date that is that weekday), in English, Swedish ("den 12:e") and
   German ("am 12."); the glossary's English is read beside the request, so a weekday in any of its 26 languages
   is a day.
2. **A turn that names a coming day starts the push** (`namesComingDay`): only where nothing else started one (no
   rule, or the gate's statement veto), only when the gate does not read chatter, four words or more, the day today
   or later within 62 days, a window of at most a week; or a coming period with no day ("in January", "over
   Christmas", "next month"). With no gate loaded nothing is added.
3. **Up to 3 items on the request's day take seats in the pool** right after the first `pushCandidates`
   (`ItemCache.dated`, `pushGate`): events starting that day (soonest first), then items whose text spans it
   (`coversDay`), then items that write the date, newest first; bulk mail out; windows of more than three days get
   none. Day items the pool's tail already held move up rather than being pushed past the 15-item cap. **A seat is
   handed only when the push check names it**: with no check (no model key), or a late or failed one, the push
   hands what it handed before.

Dates, not words: nothing matches the request's vocabulary against the item's, so the lever does not depend on the
wording of either. The look-alike is often on another day or already past, which a day test tells apart where a
meaning match cannot (F13's D1302: a meaning bridge retrieves both twins).

### $0 screen (dev20 seeds 41–44, `--neutral`, merged tree 24669678b, no check wired)

`bun run funnel --suite dev20 --seeds 41,42,43,44 --set '{"pushDaySeats":3}' -- --neutral --pool-dump P`, read with
the pool's `cl` flags (a pool with a constraint-like item is one the check would be called on):

| | default | `pushDaySeats` 3 |
| --- | ---: | ---: |
| hidden requests that start a push | 457 | 573 |
| planted fact in a pool the check would read | 309 | 388 (+12.3 points of 640) |
| look-alike in a pool the check would read (control) | 251 | 309 |
| check calls that would be made: hidden / control / neutral | 449 / 447 / 419 | 566 / 559 / 532 (+26%) |
| no-model delivered: hidden / decoys | 258 / 189 | 300 / 227 |
| funnel score (surfaced): hidden / decoys | 345 / 259 | 364 / 275 |

Parts, same screen: the day reading and the seats alone (no new starts) put 11 more facts in view; the starts bring
the rest. A wider start (any turn of four words the gate does not read as chatter, no day needed) read 411 facts in
a checked pool for 613 / 606 / 575 checks: +23 facts for 8% more calls, but it starts a push on 621 of 640 of
dev20's requests and on any remark in real traffic; not built.

Still starting no push with the switch on: 17 of 160 templates, mostly requests in languages whose day words the
glossary does not carry (romaji Japanese, Finnish, Malay, Hungarian, Korean, Russian, Vietnamese) and statements
with no time ("I'll send Jamie £95 for the cabin").

### Cost of the scan

`ItemCache.dated` reads each of the user's items' text once per push that names a day (`packages/sim/lab/g1/
dated-bench.ts`, one dev20 world, 1,593 items): p50 16 ms, p99 27 ms on a machine busy with the live run [to be
re-measured idle]. Decoding the stored text is about 7 ms of it, the range test 5 ms. It runs on the push's path
(behind the user's message), never on the fast path, and a user's items are capped (`maxItemsPerUser`,
`maxSyncedPerUser`).

## 3. The pre-registered pair (served by subagents, single-shot)

Rule, committed in 1d76d907 before any live call (D1400): on dev20 seeds 41–44, hidden, control and neutral,
`{"pushDaySeats":3}` against the default on the same tree and coverage, F6's single-shot recipe
(`packages/sim/lab/g1/go.sh`): hidden raised +15 points absolute; decoys handed up by at most a third of that gain;
neutral concerns within noise; cost at most +$0.03 per 1,000 requests; wait at most +100 ms a request.

RESULTS_PENDING
