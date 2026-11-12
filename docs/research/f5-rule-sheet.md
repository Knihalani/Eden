# F5: the rule sheet (the push check reads the user's active constraint cards)

Status: 2026-11-12, branch `claude/f5-rule-sheet` (from main 006b505c), session F5. Tuning and selection on train
(train1–6), reworded (train1r–6r) and longtail only; heldout19 is never read or run here, and heldout20 is not looked
for. Paid calls go to Anthropic directly with `HAIKU_API_KEY` through the lab's spend ledger
(`.local/f5/ledger.jsonl`, D97): **Anthropic-direct lab figures**. Cap $40. No Modal. Numbers marked **[EST]** are
arithmetic or judgement; every other number comes from a command in this note.

## 0. The idea

h19-diagnosis.md: 31% of heldout19's hidden facts never reached the agent, and 42 of those 50 planted items were
carded, mostly with a constraint kind. Their cards' anticipated requests carried the right intent, but the literal
BM25 match missed across languages, paraphrase and indirect plans. The push check is already a Haiku call on the
request path. **The rule sheet** gives it the user's active constraint cards as a compact block (statement, kind,
span, source, the item's title), so the model's world knowledge links "Get me a return to Edinburgh" to "bookings go
through TravelPerk". A rule it names brings its item into the packet, as the pool's named items are.

Built (trial switches, off; `push-check.ts`, `partner.ts` `sheetOf`, `ruledItems`):

- `pushCheckSheet` N: at most N cards (cap 120). Cards made before the request, no `none` or `preference` card,
  none whose end is before the user's day, items still cached and not bulk mail, one per statement, newest items
  first. No model or source call to build it.
- The sheet is a user message of its own after `CHECK_SYSTEM`, marked `cache` (an Anthropic breakpoint), so the
  instructions and the sheet are one cached prefix per user; it changes only when a card lands or expires. Its
  instructions (`SHEET_HEAD`) are fixed and say the cards are data.
- The request's turn adds `<in-items>`: the rule numbers whose items the pool already holds (outside the cached
  block), so the reply does not repeat them.
- The reply gains a second list, `"rules":[{"r":n,"on","hits","act"}]`, at most 3, read as items are
  (`parseCompareSheet`: `act` true and a `hits` that is not none). A bad rule number fails the reply open, as a bad
  item number does. A named rule's item joins the packet after the pool's named items, within `pushCandidates`.
- `pushCheckSheetAlways`: a push whose pool has nothing constraint-like (main makes no call there) is checked
  against the sheet when the sheet has a card.
- With no sheet the prompt, the key (`checkKey`) and the parse are main's.

A smoke (train1 seed 41, sheet 80, the first prompt format) showed sheets of 32–53 cards a user on train,
$0.000281 a check against about $0.000231 on main (h3's Pi figure), 73% of input tokens read from cache, and that
Haiku writes rule entries in a separate list (`"rules"` or `"r"`) and repeats rules already among the items. The
format above (an explicit second list, `<in-items>`) is the fix, made before the screen.

## 1. Pre-registration (committed before the screen's paid calls)

### 1a. The screen

`bun run funnel` with the check live (Haiku 5.5, `-- --neutral --check live`, one process a run, a check cache a run),
shipped coverage, on `train`, `reworded` and `longtail`, seeds 41 and 42, three arms:

- **B**: main (`pushCheckSheet` 0).
- **S**: `pushCheckSheet` 80.
- **SA**: `pushCheckSheet` 80 and `pushCheckSheetAlways`.

Read with `packages/sim/lab/n2/compare.py` over the runs (planted handed, decoy handed, neutral packets) and each run's
CHECK line (calls, $ a call). **Rule.** An arm passes if, summed over the runs, against B: planted handed at least
+8; decoy handed up by at most half its planted gain; neutral given a packet up by at most 3 points of the neutral
tasks; the check's $ per task at most 1.5x B's. The passing arm with the most planted handed goes to Pi (a tie: S).
None passes: no Pi run, the switches and their code are deleted, the findings kept.

**Amendment (before any screen result was read; the first screen's numbers were discarded, §2).** A fourth arm,
**SR**: S with `pushCheckSheetRefs` (a pool item on the sheet is sent as its title and its rule's number, its text
left to the cached sheet line; the cost lever). It passes by the same rule. Among passing arms, SR goes to Pi over a
passing S or SA when its planted handed is at least theirs less 4 and its $ per task is lower.

### 1b. The Pi pair

The arm's settings as `eden~F` against `eden`, M13's and H3's recipe (`packages/sim/lab/h3/pi.sh`'s flags: Haiku 5.5
as agent, grader, card, reader and check model, cards replayed, `--tenant-prompt`, payload notices, the `direct`
profile), on train and reworded, seeds 41–44, hidden, control and neutral; the exact command is an addendum
committed before its first call. Sonnet regrade (`i3-regrade.ts`), `p3/report.py --pair eden~F:eden --cluster
template`, `n5/mix.py` for cost and wall. **Promote** when all hold, else delete:

- hidden raised (Sonnet), template-clustered 95% lower bound above 0;
- Sonnet-confirmed concerns (control and neutral) not up;
- neutral given a packet up by at most 3 points;
- the push check's $ per 1,000 tasks at most +50% over `eden` on the pair's own ledger;
- p50 wall a task at most +0.3 s.

## 2. What happened first: the account ran out of credit mid-screen

The screen started at 6332e4e8. About 08:10 UTC every Anthropic call began to return 400 "Your credit balance is
too low" (shown by a 5-token call). Checks fail open, so about half of B's checks on train and reworded, and all of
S's, fell back to the default's candidates. The runs were stopped and their numbers discarded
(`.local/f5/screen-bad/`, not read for the rule). Only successful replies are in each run's check cache, so a re-run
replays them at $0. F5 had spent $0.40.

## 3. The sheet's ceiling, at $0

`pushCheckSheet` 120 with `pushCheckSheetAlways`, check calls failing (the 400s cost nothing), so the sheet is built
and reported but never read. Per hidden task, the funnel row records whether the planted item is in the push's pool
(`pushPoolAt`) and on the sheet (`pushSheetAt`), and its card kind (`plantedCard`). Seed 41:

| suite | hidden tasks with a push | planted not in the pool | of those, on the sheet | look-alikes not in the pool, on the sheet |
| --- | ---: | ---: | ---: | ---: |
| train | 190 | 29 | 11 | 8 of 46 |
| reworded | 185 | 36 | 14 | 11 of 55 |
| longtail | 23 | 8 | 2 | 1 of 11 |

Every missed planted item with a constraint card is on the sheet (sheets hold 32–53 cards, under the cap). The ones
that are not have no constraint card at shipped coverage: 18 of 29 on train and 21 of 36 on reworded read `none`
(no card, a `none` card, or not covered by the replay), and one reworded fact is a `preference` card, which the sheet
leaves out. So on train the sheet can reach at most about a third of the facts retrieval misses; the rest needs
cards first. heldout19's 42 of 50 carded (h19-diagnosis.md) was measured with the final enricher's own lines, not
shipped replay coverage, so the ceiling in the lab is lower than in that diagnosis [EST: the coverage differs].

## 4. Why the missed facts have no card, and a clock bug in shipped coverage ($0)

`--ask-diag` with the shipped card rules per planted item (`prefilter`, `automated`, `forIntent`; train and
reworded, seeds 41–42, the default, no check). Of 56 hidden facts on train missing from the push's pool, 30 carry a
card of some kind, 7 a `none` card from a full card read, and **26 fail the economy prefilter** (`worthCardingStrict`:
no DEONTIC word in their own text; e.g. "The front-door lock box was replaced on 23 October; the old code no longer
works" passes, but the planted chat or note wording often does not). 22 of those 26 pass `readForIntent`, so the
shipped enricher should read them for requests, yet shipped coverage has no line for them (reworded: 25 of 29).

The reason is a lab bug. `cold-start.ts`, which records shipped coverage (D872), builds the partner with no `now`, so
the partner runs on the wall clock (11 November at recording) while the sim worlds are dated 27 October
(`world.ts` `NOW`). `cardsLean`'s 7-day window then skips almost every past item the prefilter rejects.
`packages/sim/lab/f5/clock-check.ts` runs the shipped `buildPartner` on one world with a fake card model ($0):

| world | clock | request-only reads | items sent | card calls | lean-skipped |
| --- | --- | ---: | ---: | ---: | ---: |
| train1:41 | wall (as recorded) | 36 | 127 | 9 | 1,363 |
| train1:41 | the world's | 179 | 270 | 17 | 1,220 |
| train3:42 | wall | 36 | 122 | 8 | 1,369 |
| train3:42 | the world's | 198 | 284 | 16 | 1,207 |

So shipped coverage lacks most of the intent requests a deployment would hold for prefilter-rejected items, and a
new user's real card bill is about twice cold-start's (16–17 calls a world, not 8–9) [EST from these call counts;
the token cost of a request-only item is lower than a carded one's]. Fix: give `buildPartner` the world's clock
(advancing, or `warmAll` waits forever) and re-record. Reported to the integrator and F8 before dev20's recording.

**`cardsKeepOnly`** (trial, built): a request-only read keeps the card its call wrote (today it is set to `none`
whatever the model wrote; no extra call). At shipped coverage it changes almost nothing, because those items were
never read when the coverage was recorded (train, reworded, longtail seeds 41–42, no-model funnel, `--jobs 1`):
hidden surfaced 602 → 602 of 816, decoys 538 → 536, planted handed 551 → 551, neutral packets 765 → 770. It can only
be judged on coverage recorded on the right clock.

## 5. The subagent-simulated pilot (pre-registered before any answer was read)

The API has no credit for the rest of the day (the owner). Haiku subagents (the Agent tool, model "haiku") stand in
for the check's model; every number from them is labelled **subagent-simulated**, and their cost and latency are
not the API's. `packages/sim/lab/f5/pilot.ts` builds the prompts from `--check-dump` rows recorded with
`pushCheckSheet` 80 on train, reworded and longtail, seeds 41–42 (the calls failed: $0) with the engine's own
`checkMessages`, one user's prompts a batch file (the system message and the sheet written once), and scores the
answers with `parseCompareSheet`. Sets: Th and Tc (the planted fact, or the look-alike, on the sheet and not in the
pool; asked with the sheet only), Hh and Hc (in the pool; 40 sampled each; asked with and without), N (neutral; 40
sampled; with and without).

**Reading, fixed now.** The sheet goes on to the dev20 screen if Th named is at least 30% of Th; Tc named at most
half Th's rate; Hh named with the sheet at least without it less 3; Hc named with the sheet at most without it plus
3; N with any yes, with the sheet, at most without it plus 3. Otherwise the sheet's prompt is revised once, on these
sets, before dev20.

### 5a. Result (subagent-simulated; 25 Haiku subagents, 333 prompts, 0 unreadable)

| set | prompts | arm | planted (or look-alike) named | any yes | a rule named |
| --- | ---: | --- | ---: | ---: | ---: |
| Th: fact on the sheet, not in the pool | 54 | sheet | **51 (94%)** | 52 | 52 |
| Tc: look-alike on the sheet, not in the pool | 39 | sheet | **5 (13%)** | 14 | 10 |
| Hh: fact in the pool | 40 | main / sheet | 40 / 40 | 40 / 40 | 0 / 6 |
| Hc: look-alike in the pool | 40 | main / sheet | 6 / 7 | 12 / 14 | 0 / 1 |
| N: neutral | 40 | main / sheet | — | 7 / 9 | 0 / 4 |

Against §5's reading: Th 94% (≥ 30%), Tc 13% (≤ 47%), Hh 40 against 40 (≥ 37), Hc 7 against 6 (≤ 9), N 9
against 7 (≤ 10): **every clause passes**, so the sheet goes on to dev20.

Caveats. A subagent answered up to 12 prompts of one user in one context, with the system message and the sheet
written once, so it saw the other requests; the API reads one prompt a call. Subagents are not the API's Haiku with
thinking off: main's in-pool facts were named 40 of 40 here against about 85% planted handed on Pi with the API
(h3-pushcheck-lean.md §3b), so the subagent is the more generous reader, and these rates are upper bounds on the
API's. What the pilot does show is that the sheet makes the check name facts it could not name before (51 of 54 had
no other way in), at a look-alike rate of about one in eight, without moving the in-pool verdicts or the neutral
silence by more than two of 40. Applied to the funnel's counts (train, reworded and longtail, seeds 41–42: 54 such
facts and 39 such look-alikes of 816 hidden and 816 control tasks), the sheet would hand about +51 planted facts
(+6.3 points of hidden) for about +5 look-alikes [EST: the pilot's rates times the dump's counts].

## 6. The dev20 screen (pre-registered before any dev20 check was asked)

Served by subagents (D1101's queue transport, `EDEN_LAB_QUEUE`), both arms through it. `bun run funnel --suite dev20
--seeds 41 --jobs 1 -- --neutral --check live`, at dev20's coverage as F8 records it on the world's clock; arms **B**
(main), **S** (`pushCheckSheet` 80) and **SR** (S with `pushCheckSheetRefs`). Read per arm: planted handed, decoy
handed and neutral given a packet (`n2/compare.py`'s fields), and the check's input tokens from the queue's calls.
**S passes** if, against B: planted handed at least +8 of dev20's 160 hidden tasks; decoy handed up by at most half
that gain; neutral packets up by at most 5 of 160. **SR replaces S** if it passes too, with planted handed at least
S's less 4. A passing arm goes to the integrator's final protocol as the candidate; none passing: the switches are
deleted with their code and tests, the findings kept.

## 7. End-to-end: pi-ab single-shot (pre-registered before any of its calls)

Served by subagents (D1101), both arms in one run and one queue: `pi-ab --agent-sim single --time-scale 0`, every
role `claude-haiku-5-5` through the queue except the grader `claude-sonnet-5-5` (Sonnet subagents), conditions
`eden,eden~F` with F the arm the dev20 screen (§6) selects, train seed 41 and dev20 seed 41, variants hidden,
control and neutral, cards replayed at each suite's coverage. Read with `packages/sim/lab/p3/report.py --pair
eden~F:eden --cluster template`. **Promote** F into the default when all hold, else delete it with its code and
tests:

- hidden raised, F − eden, pooled over both suites: point estimate above 0 and the template-clustered 95% lower
  bound above −1 point (the sample is one seed, so a bound above 0 is not asked of it);
- concerns on control and neutral (Sonnet-graded): not up;
- neutral given a packet: up by at most 3 points.

Cost and wall are not measurable through subagents: the check's cost is priced from token counts [EST], and its
added wait from the H3 latency fit (596 ms + 2.93 ms an output token, D1072) with the extra input tokens read from
cache [EST].

### 5b. The pointer arm SR (subagent-simulated, the same sets and sampling, 16 subagents, 213 prompts, 0 unreadable)

| set | S (§5a) | SR |
| --- | ---: | ---: |
| Th: fact named | 51 / 54 | 52 / 54 |
| Tc: look-alike named | 5 / 39 | 5 / 39 |
| Hh: fact named | 40 / 40 | 39 / 40 |
| Hc: look-alike named | 7 / 40 | 3 / 40 |
| N: any yes | 9 / 40 | 8 / 40 |

A pool item on the sheet read as its title and its rule's line holds the facts and names fewer in-pool look-alikes.
Cost, from the 2,349 dumped checks [EST: about 4 characters a token, Haiku 5.5 list prices]: the pool is 3,188
characters a check, of which pointers drop 768 (24%, 4.8 items a check on the sheet), about 190 uncached tokens or
$0.000019 a check. The sheet itself is about 6,900 characters (about 1,700 tokens): $0.000017 a check read from
cache, $0.00021 when written. So with the sheet in cache, SR's check costs about what main's does (+$0.000017 −
$0.000019); each cache write adds about $0.0002.

**Amendment to §6 (before any dev20 check was asked).** The subagent budget runs two arms, not three: **B** and
**SR**. SR is judged by S's pass rule against B (planted handed at least +8 of 160, decoy handed up by at most half
that, neutral packets up by at most 5 of 160); S on its own is not run on dev20 (the pilots of §5a–5b found SR at
least as good on every set). Coverage: dev20's shipped cards as F8 recorded them (served by subagents per item, D1102,
world clock, ee34b1e9). Each arm's funnel runs twice through one queue: a first pass fills the queue (its checks fail
open while unanswered), the subagents answer, and a second, identical pass replays every answer; only the second
pass is read.

## 8. Card coverage on the world's clock, and `cardsKeepOnly` ($0)

After F8 re-recorded shipped coverage on the world's clock (D1102, ee34b1e9), the $0 diagnostic of §3 (seed 41,
`pushCheckSheet` 120, check calls failing at $0) reads, for hidden facts missing from the push's pool:

| suite | arm | missed | with a constraint card | on the sheet | look-alikes missed / carded |
| --- | --- | ---: | ---: | ---: | --- |
| train | main | 20 | 12 (60%) | 12 | 32 / 8 |
| train | `cardsKeepOnly` | 21 | 15 (71%) | 15 | 30 / 11 |
| reworded | main | 28 | 16 (57%) | 15 | 37 / 9 |
| reworded | `cardsKeepOnly` | 28 | 21 (75%) | 20 | 37 / 14 |

(Before the clock fix: 11 of 29 on train, 14 of 36 on reworded.) The no-model funnel, same runs: train hidden 149 →
150 of 192, decoys 149 → 148; reworded hidden 158 → 160, decoys 151 → 150. `cardsKeepOnly` costs no call: the
request-only read already asks the model for a card.

**Reading every item instead** (`cardsLean` off): `clock-check.ts` with a fake card model on the world's clock
(train1:41, train3:42) — shipped: 270–284 items sent, 16 calls, 130–136 thousand prompt characters a world;
`cardsLean` off: about 1,490 items, 76 calls, about 710 thousand characters. Priced [EST: Haiku 5.5 list, about 4
characters a token, about 80 output tokens an item]: shipped about $0.0033 in + $0.011 out ≈ **$0.014 a world**;
`cardsLean` off about $0.018 + $0.06 ≈ **$0.08 a world**, about 5.5x. Only 4 of train's 26 prefilter-rejected missed
facts were outside the lean read (§4), so reading everything buys little of the missed facts for its 5x;
`cardsKeepOnly` is the lever. A heavy user's month [EST: 3,000 new items, the shipped read rate of about 18%]: about
540 items read, 27 calls, about $0.03 a user-month with or without `cardsKeepOnly`; reading everything about $0.16.

## 9. Results: dev20 (served by subagents, D1101) and the realism stress test

### 9a. dev20, seed 41, B against SR (the §6 rule as amended)

Pass 2 replayed every pass-1 answer (303 checks an arm, 0 misses, 0 failed; 598 queue answers by about 25 Haiku
worker subagents in batches of 8). `n2/compare.py` over the two runs:

| | B (main) | SR (`pushCheckSheet` 80 + `pushCheckSheetRefs`) | rule | |
| --- | ---: | ---: | --- | --- |
| planted handed | 61 / 160 | 72 / 160 (+12 −1) | ≥ +8 | pass |
| decoy handed | 12 / 160 | 14 / 160 (+4 −2) | ≤ half the gain (5.5) | pass |
| neutral given a packet | 22 / 160 | 29 / 160 (+9 −2) | ≤ +5 | **fail** |
| hidden surfaced (packet or ask) | 79 / 160 | 89 / 160 (+11 −1) | — | |
| decoys surfaced | 56 / 160 | 61 / 160 (+5 −0) | — | |

**Verdict by the pre-registered rule: SR fails on dev20's neutral clause.** Reading: of the 9 neutral tasks SR sent a
packet that B did not, 1 came from a rule (a heating rule named on a weekend-away request), 8 from pool items SR's
check named and B's did not: pointers change how pool items read, and two subagent samples of the same check
disagree on speak/silent about 3% of the time (D1101's fidelity note: 0.969), about ±5 of 160 neutral tasks. The
fact gain (+11 net handed, +6.9 points of dev20's hidden) is two to three times that noise.

No-model reach on dev20 (SR pass 1's rows; F9's reading rule asks for it): 109 hidden tasks pushed; the planted item
was in the pool on 67 and missing on 42; of the 42, 20 carried a constraint card and 18 were on the sheet. The
look-alike was missing from the pool on 56 control tasks, 16 of them on the sheet.

### 9b. Realism: the sheet's size (subagent-simulated, SR prompts, one padded sheet per user)

Each user's sheet padded to 300 cards with other users' constraint cards (no card planted for any of the user's own
templates; seeded per user), §5's sets:

| set | native sheet (32–53 cards, §5b) | padded to 300 |
| --- | ---: | ---: |
| Th: fact named | 52 / 54 | **26 / 54** |
| Tc: look-alike named | 5 / 39 | 0 / 39 |
| Hc: look-alike in the pool named | 3 / 40 | 7 / 40 |
| N: any yes | 8 / 40 | 12 / 40 |

**The plain sheet does not scale**: at 300 cards the check finds half the facts it found at 50 and speaks more on
neutral requests. A request-independent cap does not save it either: by recency, with a heavier user's other cards
spread through time, a cap of 120 keeps the planted card 400 of 497 times at 150 cards, 192 at 300 and 164 at 500
(`PILOT_STATS`, $0). So past about 100 cards the sheet needs selection by meaning per request (F10's rule index:
an encoder picks a user's candidate rules and the sheet is the check's input for those), not a longer prompt.
Cost at 300 cards [EST]: about 10,000 tokens, $0.0001 a check read from cache (+43% of main's check), $0.0013 a
write. A first build of this stress test seeded the padding per template, so a batch file's sheet did not match
most of its prompts; its numbers were discarded and the file layout now keys on the sheet's hash.

### 9c. Staleness

`push-check-sheet.test.ts` ("staleness"): an item edited at its source leaves the sheet as soon as its new copy is
stored (its old card is no longer the item's), and its new card joins once made (`cardsOf` reads the item's current
content hash).

## 10. Pre-registered next steps (the integrator's decisions after §9; committed before any of their calls)

### 10a. The neutral re-test with a noise floor (subagent-simulated)

The dev20 seed 41 neutral checks of §9a (`SR-p2.dump.jsonl`, every neutral row with a check: the same input for all
arms) rebuilt by `pilot.ts` in three arms: **B** (main's prompt), **SR** (the sheet with pointers) and **S** (the
sheet, pool items in full, `pushCheckSheetRefs` off). Each arm is asked **twice**, by separate subagents (fresh
samples), one user's prompts a file as in §5. Read per arm and sample: neutral prompts with any yes. Noise floor
D = prompts where B's two samples disagree on any yes. **An arm passes the neutral clause** if its mean any-yes count
over its two samples exceeds B's mean by at most max(3, D/2). SR passes §6 if it passes here (its fact and decoy
clauses passed in §9a); S is reported beside it and goes forward instead of SR if it passes and SR does not.

### 10b. `cardsKeepOnly` ($0, then the queue)

Stage 1, $0: no-model funnel at shipped coverage, `--jobs 1 -- --neutral`, dev20 seeds 41–44 and train seeds 41–42,
main against `{"cardsKeepOnly":true}`. Passes if hidden surfaced is not down, decoys surfaced up by at most half the
hidden gain (or not up), and neutral packets up by at most 3 points of neutral tasks. Stage 2 (only if stage 1
passes): the same with the check live through the queue on dev20 seed 41 (`pushCheckSheet` as the stage-1 winner
of 10a, or 0 if none), the same three clauses on planted and decoy handed and neutral packets. Pass both: promote
`cardsKeepOnly` (D814). Fail: delete it.

### 10c. The selected sheet

F10's rule index selects a request's candidate cards (`ruleIndex.select`, `pushCheckSheetSelect` k); the check sees
only those. The 300- and 500-card stress of §9b is re-run on the selected sheet once F10's selector exists; its
rule is written then, before its calls.

## 11. Results of §10

### 11b. `cardsKeepOnly`, stage 1 ($0, no model, shipped coverage)

`--jobs 1 -- --neutral`, main (B0) against `{"cardsKeepOnly":true}` (K); `.local/f5/k2/`.

| run | hidden B0 → K | decoys B0 → K | neutral any packet B0 → K |
|---|---|---|---|
| dev20 41 | 70 → 70 | 53 → 54 | 98 → 100 |
| dev20 42 | 72 → 73 | 52 → 52 | 100 → 102 |
| dev20 43 | 78 → 78 | 56 → 55 | 92 → 97 |
| dev20 44 | 72 → 72 | 55 → 55 | 95 → 96 |
| train 41 | 158 → 160 | 151 → 150 | 189 → 190 |
| train 42 | 160 → 161 | 148 → 148 | 189 → 189 |
| **dev20 (640)** | **292 → 293** | **216 → 216** | **385 → 395 (+1.6 points)** |
| **train (384)** | **318 → 321** | **299 → 298** | **378 → 379 (+0.3 points)** |

Every clause passes (hidden not down, decoys not up, neutral packets up by less than 3 points), so stage 2 runs. The
gain without a model is small: a kept card reaches the rule paths on few tasks. Its case is the check's view (the
sheet and the card on a pool item), which stage 2 measures.

### 11a. The neutral re-test (subagent-simulated, D1101)

The 95 dev20 seed 41 neutral checks of §9a with a sheet, three arms, each asked twice by separate subagents
(`.local/f5/pilot/n10a-1`, `n10a-2`; 285 prompts a sample, all answered, none unreadable):

| arm | sample 1 any yes | sample 2 any yes | mean | − B | samples disagree on | any rule named (1 / 2) |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| B (main) | 22 | 21 | 21.5 | — | **9** (D) | 0 / 0 |
| SR (sheet + pointers) | 23 | 18 | 20.5 | −1.0 | 9 | 3 / 4 |
| S (sheet, pool items in full) | 23 | 25 | 24.0 | +2.5 | 14 | 7 / 11 |

Bound max(3, D/2) = 4.5. **SR passes (−1.0) and S passes (+2.5); by §10a, SR passes §6 and goes forward.** Main's
own prompt, asked twice, disagrees with itself on 9 of 95 neutral checks; §9a's +7 neutral packets for SR was within
that noise. S names rules more often (7 and 11 against SR's 3 and 4), on neutral requests too.

### 11b, stage 2. `cardsKeepOnly` through the queue (served by subagents, D1101): **fails; deleted**

dev20 seed 41, SR (`pushCheckSheet` 80 + `pushCheckSheetRefs`, §10a's winner) against SR + `cardsKeepOnly` (SRK).
Kept cards change every user's sheet, so all 306 of SRK's checks were new calls: 31 batches of 10 (one Haiku
subagent each; a batch of 10 overran one subagent's context, so its 6 unanswered checks and 1 other were re-batched),
pass 2 replayed every answer (306 of 306, 0 misses). `n2/compare.py`:

| | SR | SRK | rule | |
| --- | ---: | ---: | --- | --- |
| planted handed | 72 / 160 | 63 / 160 (+4 −13) | not down | **fail** |
| decoy handed | 14 / 160 | 13 / 160 (+7 −8) | up by at most half the gain | pass |
| neutral given a packet | 29 / 160 | 28 / 160 | up by at most 3 points | pass |
| hidden surfaced (packet or ask) | 89 / 160 | 90 / 160 (+6 −5) | — | |
| decoys surfaced | 61 / 160 | 56 / 160 (+1 −6) | — | |

By the pre-registered rule `cardsKeepOnly` is deleted (D814) with its code and tests. Reading: the planted-handed
drop sits within the per-task churn of two fresh samples (+4 −13 handed against +6 −5 surfaced); stage 1's $0
gain was +1 hidden on 640 dev20 tasks. Nothing here says kept cards help the check enough to pay for a re-test.

### 11c. The selected sheet at 300 cards: the $0 ceiling (before any call)

`pushCheckSheetSelect` is wired (partner `sheetOf` → `ruleIndex.select`, only above 60 active cards, k from the
switch, the request's named days passed, fail open to the whole sheet; `push-check-sheet.test.ts`). Lab: `pilot.ts`
with `PILOT_SELECT=k` draws §9b's sets on the 300-card padded sheet, then keeps the index's k (F10's
`ReplayRuleIndex`, e5-small vectors of every text here, `ruleScore` with days), so a planted card the selection drops
counts as missed. Each card gets its anticipated requests from the shipped coverage, matched by statement.

Where the planted card ranks among 300 (rank < k keeps it), train/reworded/longtail seeds 41–42:

| set | k 10 | 20 | 30 | 60 | 80 | 120 | whole sheet, model-read (§9b) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Th: hidden, missed by the pool (54) | 10 | 16 | 18 | 29 | 37 | 48 | named 26 |
| Tc: look-alike, missed by the pool (39) | 9 | 10 | 12 | 27 | 29 | 30 | named 0 |

**At k = 20 the selection keeps the planted card on 16 of 54 Th tasks: below the 26 the whole 300-card sheet already
finds, and far below the bar (at least half of 54 → 26 recovered, so 40).** No queue run can pass it, so none was
made. Caveat: only 8,476 of 72,311 sheet-card lines in these dumps (12%) match a shipped card's statement, so most
candidates carry no anticipated requests, the index's main signal (F10: "most of the signal"); the dumps were made
before D1102's coverage fix. This is the statement-only lower bound, on the hardest tasks (a fact no lexical lookup
reached). On all hidden rows with requests, F10 measured 568 of 674 in the top 20 at 300 cards.

### 10d. Pre-registered: the shipped sheet on a heavy user (subagent-simulated, D1101)

The integrator's guard question: on a user with about 300 active rule cards (F8's heavy realism: 333–350), is the
shipped SR (`pushCheckSheet` 80 + refs, so the newest 80 of the 300 reach the check) at least as good as main?
`pilot.ts` with `PILOT_PAD=300 PILOT_CAP=80`, arms B (main) and R (SR), sets Th, Tc, Hh, Hc, N drawn on the padded
sheet (as §9b; Th and Tc are named only through the sheet, so main names none). **SR holds** if, against B on the same
prompts: Hh (fact in the pool) named ≥ B − 2 of 40; Hc (look-alike in the pool) named ≤ B + 3 of 40; N (neutral) any
yes ≤ B + 4.5 of 40 (10a's bound). Else SR gets a guard before the freeze: the sheet off above a card count chosen on
these runs' $0 statistics, re-checked the same way.

F10's ceiling on the same subset with card requests (its dumps, world-clock coverage; 115 rows: hidden, planted item
not in the pool, card on the sheet), 300 cards: top 20 61%, top 30 66%, top 60 79% (150 cards: 72%, 79%, 83%; 500:
top 30 65 of 115). About 33 and 36 of 54 at k 20 and 30: below 40. **`pushCheckSheetSelect` is deleted (D1182)**; its
code is in commit debfb22e.

### 11d. The shipped sheet on a heavy user (10d, subagent-simulated, D1101): **fails; guard added (D1183)**

300 padded cards a user, the shipped cap (the newest 80 reach the check), B (main) and R (SR) on the same 288
prompts, 14 Haiku subagents, every prompt answered, none unreadable:

| set | B | R | rule | |
| --- | ---: | ---: | --- | --- |
| Hh: fact in the pool named | 39 / 40 | 39 / 40 | ≥ B − 2 | pass |
| Hc: look-alike in the pool named | 2 / 40 | 2 / 40 | ≤ B + 3 | pass |
| N: neutral, any yes | 1 / 40 | 9 / 40 | ≤ B + 4.5 | **fail** |
| Th: fact off the pool named (planted on the capped sheet in 11 tasks) | 0 / 11 | 9 / 11 | — | |
| Tc: look-alike off the pool named | 0 / 13 | 0 / 13 | — | |

All 9 neutral yeses name a rule from the padding: a newest slice of a heavy user's rules speaks where main is
silent. **Guard (D1183): a user with more active rules than `pushCheckSheet` gets no sheet**, so the check reads the
pool alone, exactly as main (by construction: no sheet, main's prompt; `push-check-sheet.test.ts`). The padding is
other users' rules, a harsher stand-in than a real heavy user's own; F8's `--realism heavy` run is the realistic one.
