# O3: what a full intent index is worth over a user's days

Status: 2026-11-11, branch `claude/o3-k-behind`, session O3. Decision D713. Train suites only; heldout18 is not
dumped, labelled or run. Paid calls go to Anthropic directly with `HAIKU_API_KEY` through the lab (D97):
**Anthropic-direct lab figures**. Numbers marked **[EST]** are arithmetic or judgement; every other number comes from
a command in this note or the note it names.

## 0. Why

Over 32 users' days the fact a hidden request needs was not in that day's transcript in 134 of 433 tasks (D712,
o3-pointer.md §3.1), and at $0 it was outside the push's pool in 16 of 23 such misses on w45–w52 (§3.2). The lab's
checked-in intent requests cover 99% of the items of the four users they were made for; the shipped pipeline writes
requests only for the items a card call reads, about 14% of a user's items (181 to 238 of about 1,490) and 63 of
113 hidden planted items on w45–w52. With `intent` off on w41–w44, 11 of 46 facts are outside the pool against 2.

## 1. Pre-registration: a measurement (committed before its first paid call)

- **Paid step:** `cards-enrich.ts --days-users 45,…,52 --intent` on Haiku 5.5: requests for every item of those
  eight users' worlds (11,781 distinct items, 1,179 calls of ten), into `.local/o3/intent45/`. Hard cap $2.0 on the
  tool, on O3's ledger (cap $33). **[EST] $1.**
- **Readout, at $0:** `days-calls.ts --seeds 45,…,52 --pool-diag` twice on the same users: with the cards and
  requests the paid days run made for them (`.local/o3/cards-45-52.jsonl`, the shipped coverage; measured already:
  113 hidden requests, 59 pushed at their own request, 31 handed earlier that day, 16 outside the pool, 5 pooled
  failing the constraint test, 2 below the cut), and with the full requests file replayed beside the same cards
  (`--intent`). Reported: the same six counts, the control decoy's the same way, and the size of the handed packets.
- **No rule promotes anything here.** What it decides: a paid days run of full coverage against the default is
  pre-registered next (its own section, before its first call) only if the facts pushed at their own request rise by
  **at least 10 of 113** with full coverage. Below that the bet stops and the note says so.
- If the cap stops the calls early, the readout is run on the users whose items are all covered and says how many.

## 2. Result (2026-11-11): full coverage moves 2 of 113; the bet stops

The card calls finished under the cap: 1,179 calls, $0.506, requests for 11,541 of the 11,781 items.

| w45–w52, 113 hidden requests, `days-calls.ts --pool-diag` ($0) | pushed at its own request | handed earlier that day | outside the pool | pooled, fails the constraint test | pooled, below the cut |
|---|---|---|---|---|---|
| shipped coverage (the run's own card calls) | 59 | 31 | 16 | 5 | 2 |
| full coverage (requests for every item) | **61** | 27 | 12 | 4 | 9 |

Control decoys the same way (113): pushed 57 against 62, earlier that day 25 against 28, outside the pool 20 against
14, pooled and not handed 11 against 9. Handed items a request with a planted item: 4.18 against 4.22.

- **+2 of 113 pushed, against the 10 the pre-registration asked for: no paid days run is made on this.** The fuller
  index brings four more facts into the pool (16 to 12 outside) and seven more of the pooled ones fall below the cut:
  with requests for every item, more other items rank too. It hands the decoy five more times.
- **What it would have cost:** 147 card calls and $0.063 a user once (the backfill), against about 26 calls and
  $0.016 a user as the paid days run made them: four times the background spend for two facts in 113.
- **What D714's caveat is then worth:** on these eight users the fuller index is not the reason levels differ much;
  the gap between the covered seeds and the rest (17% against 33% of facts not in the day's transcript,
  o3-pointer.md §3.2) is not explained by coverage alone, and four users against 28 is a small comparison.
- **What is left of the days gap on these users, with full coverage:** 27 facts handed earlier the same day (raised
  about 60% of the time live), 12 outside the pool, 9 below the cut, 4 failing the constraint test. No single cause
  holds ten of them.

```bash
bun packages/sim/src/lab/cards-enrich.ts --dir .local/o3/intent45 --days-users 45,46,47,48,49,50,51,52 --intent \
  --model claude-haiku-5-5 --cap 2.0 --spend-ledger .local/o3/ledger.jsonl --spend-cap 33 --run-label intent45
bun packages/sim/src/lab/days-calls.ts --seeds 45,46,47,48,49,50,51,52 --cards .local/o3/cards-45-52.jsonl \
  --pool-diag A.jsonl                                       # shipped coverage
bun packages/sim/src/lab/days-calls.ts --seeds 45,46,47,48,49,50,51,52 --cards .local/o3/cards-45-52.jsonl \
  --intent .local/o3/intent45/intent-v2.jsonl --pool-diag B.jsonl   # full coverage
```
