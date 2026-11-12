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
