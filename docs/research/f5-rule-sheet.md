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
