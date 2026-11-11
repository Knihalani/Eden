# M5: a standing-constraint ledger built when items arrive

Status: 2026-11-11, branch `claude/m5-ledger`, session M5 (decisions D910–D919). Train suites only; held-out 17–19
are not run or read. Anthropic cap $30 (ledger `.local/m5/ledger.jsonl`), Modal cap $100. Numbers marked **[EST]**
are arithmetic or judgement; every other number comes from a command in this note.

## 0. The idea, and why D526 does not already answer it

A cheap model reads each new item once and writes the user's standing constraints and commitments as typed records
(`m5-ledger.ts`): effect (`blocks` or `clears`), kind (deadline, fee, limit, booking, restriction, absence, change,
promise, done), who, organisation or place, reference, plain things, the days it holds and whether it only matters
on those days, an amount, the item's own date and one sentence. At request time the request is matched against the
user's small ledger with no model (`packages/sim/lab/m5/m5_match.py`), and the matches go before the shipped push
pool's candidates.

D526 asked "would this item change an action?" at ingest and stored keys; look-alikes (a real constraint about
another venue, person or day) passed as often as facts. The ledger answers the three look-alike kinds with fields
instead of a verdict: an all-clear twin is a `clears` record (never matched; it supersedes the `blocks` record it
answers), another day is a dated record whose days miss the request's named days, another venue or person is an
exact-anchor miss (the request must name one of the record's specific anchors as whole words).

## 1. Pre-registration (committed before any held-out result is read)

- **Fit** the prompt and the matcher on the days requests of templates in train1–4 (users w41–w72, `days-calls.ts`
  with the shipped coverage: `--cards-live claude-haiku-5-5 --intent none`, M3's §1b baseline). **Held out:** the
  train5–6 families (157 hidden, 148 control in M3's run), read once per frozen version, and M2's test split.
- **Measure:** facts @5 (the planted item among the push's first five candidates) against the shipped pool, decoys
  @5 on control requests, neutral packets (the funnel's neutral variant, train seeds 41–44: requests where the
  ledger adds a candidate), extraction $ an item (Haiku direct, Batch price at half, an open model on Modal if
  Haiku's price fails the bound), and request-time ms.
- **Go** if held-out facts @5 rise by at least **+8 points** over the shipped pool with decoys @5 rising by no larger
  ratio than facts, at an extraction cost of at most about **$0.01 per user per day**; then a trial switch and a Pi
  pair the same day. **Otherwise stop**: the note says what was reached, and nothing is wired.

## 2. Frozen before the held-out read

Prompt v1 (`LEDGER_VERSION` 1 in `m5-ledger.ts`), matcher defaults of `m5_match.py` at this commit: a record matches
at score ≥ 2 (a person's name token 2, an organisation 2.5 or its rarest token 2, a reference 4, each plain thing the
request says 2; anchors in more than 5% of the user's records, the user's own name, do not count); `clears` records
other than kind `done`, and `blocks` records a later `clears` shares a specific anchor and a thing with, never match;
a dated record whose days miss every day the request names is rejected; the first two matches go before the shipped
pool. Fit split (train1–4 days requests): facts @5 186 → 205 of 276, decoys @5 211 → 211 of 285. Prompt v2 (roles,
up to 8 broader request words in `things`; $1.72 for the days corpora) was worse on the fit split (best 186 → 196,
decoys 211 → 220): broader words bring the twins back (D526's failure), and it was rejected before any held-out read.
