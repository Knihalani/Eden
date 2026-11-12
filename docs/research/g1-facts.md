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

**The bar was re-set by the integrator before any live result** (D1400's addendum, commit 3b6fa170): headline hidden
raised at least 55% absolute, on the harness fixed by D1155; guards decoys handed and neutral concerns flat, cost at
most +$0.01 per 1,000 requests, wait at most +50 ms; ship rule for the final's candidate, at least +5 points of hidden
raised with decoys handed and neutral concerns not up. A first run on the pre-D1155 harness was stopped by a platform
restart at 699 answers and is void; its outputs were never read.

**A third arm, `pushDayStartSeated` (D1401), was registered before any result** (commit f0a6fd4b), because the $0
screen said the plain arm would fail the cost guard: a push that only the day started is checked, and hands
anything, only when one of its day seats is itself constraint-like. At $0 it keeps 55 of the 79 facts (364 in a
checked pool) while the check calls that would be made on neutral requests rise 419 → 428 instead of 532.

### Result (dev20 seeds 41 and 42 only, 960 tasks an arm; served by subagents, D1101, single-shot)

`bash packages/sim/lab/g1/go.sh` (tree f0a6fd4b, shipped coverage, one queue; the strict arm replayed all but two
of its calls from the plain arm's answers), read with `python3 -I packages/sim/lab/g1/report.py .local/final/g1b
base seats strict --seeds 41,42`. Differences are paired by task, 95% intervals a bootstrap over templates.

| | default | `pushDaySeats` 3 | with `pushDayStartSeated` |
| --- | ---: | ---: | ---: |
| hidden raised (of 320) | 157 (49.1%) | 170 (53.1%), +4.1 (+1.2..+7.2) | 165 (51.6%), +2.5 (+0.3..+5.0) |
| fact handed by the push | 130 | 158, +8.8 (+4.4..+13.1) | 145, +4.7 (+1.2..+8.1) |
| fact reached the agent (push or ask) | 192 | 202, +3.1 (+0.3..+6.2) | 196, +1.2 (−0.6..+3.4) |
| look-alike handed by the push (control, of 320) | 27 | 33, +1.9 (+0.0..+4.1) | 29, +0.6 (−0.6..+1.9) |
| control concerns | 8 | 7 | 7 |
| neutral concerns (of 320) | 96 | 106, +3.1 (+0.6..+5.6) | 100, +1.2 (−0.6..+3.1) |
| neutral tasks with a packet | 99 | 116, +5.3 (+2.5..+8.4) | 106, +2.2 (+0.6..+4.1) |
| tasks whose push was checked (of 960) | 661 | 832 (+26%) | 706 (+7%; neutral 213 → 214) |
| cost of the extra checks [EST, $0.00023 a check, F5's sheet price] | — | about +$0.04 per 1,000 | about +$0.01 per 1,000 |
| wait of the extra checks [EST, 0.8 s a check, F7] | — | about +140 ms a request | about +40 ms a request |

**Verdict: both arms fail the rule; neither is promoted and nothing goes to the final's candidate.**

- The headline (55%) is not reached: 53.1% and 51.6%.
- The ship rule (+5 points with decoys and neutral not up) is not met. The plain arm reads +4.1 points and raises
  neutral concerns (+3.1, interval above 0) and look-alikes handed; it would also fail the cost and wait guards by
  estimate. The strict arm is clean on every guard but adds only +2.5 points.
- Seeds 43 and 44 were not run: the strict arm cannot reach +5 on these numbers and the plain arm fails on neutral
  concerns whatever its facts read, so the pre-registered four-seed run would not change the decision. The result
  is two seeds, and is labelled so.

**Why the screen's gain shrank.** The push handed the fact on 28 more tasks (+8.8 points), but the agent already
reached most of those facts through `ask_context` in the default arm (reached 192 against handed 130): the plans
that start no push are requests where the single-shot agent asks, and the ask's lookup finds the day's items. Only
+3.1 points of facts newly reached the agent, and +4.1 were newly raised. On the fixed harness (D1155) the ask path
carries more than the $0 funnel's pool counts show, so a lever that starts more pushes buys less than its pool gain.

## 4. What is kept, and what is open

Deleted with their code and tests (D1402; the code is in commit f0a6fd4b): `pushDaySeats`, `pushDayStartSeated`,
`days.ts`, `ItemCache.dated`, the seats in `pushGate`, the day-plan start.

Kept:

- the finding that 183 of 640 dev20 hidden requests start no push (§1), and `packages/sim/lab/g1/start.ts`, which
  reads any suite's requests as `observe` does;
- `packages/sim/lab/g1/labels.ts` (pool misses by the suites' own labels), `go.sh` (two Eden arms on one tree, one
  process an arm a seed: four seeds in one process held 8.7 GB) and `report.py` (any arms, paired);
- the date-reading gaps (§1): "the 20th", "Monday the 9th", weekdays in other languages. They also feed the
  conflict test and the day grounds, where they were not measured: a fix there is its own trial.

Open:

- The neutral concerns the plain arm added came with the packets (99 → 116 neutral tasks with one). A day-started
  push that hands only to an agent that then asks nothing more was not separated from the ask path here.
- A request in a language whose day words the glossary lacks still starts no push (17 of 160 templates).
