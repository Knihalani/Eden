# M5: a standing-constraint ledger built when items arrive

Status: 2026-11-11, branch `claude/m5-ledger`, session M5 (decisions D910–D912). **Stopped** (D910, D912). Train suites
only; held-out 17–19 are not run or read. Anthropic cap $30 (ledger `.local/m5/ledger.jsonl`), Modal cap $100.
Numbers marked **[EST]**
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
answers), another day is a dated record whose days miss the explicit dates the request names (weekday names and
"tomorrow" are not read), another venue or person is an exact-anchor miss (the request must name one of the record's
specific anchors as whole words). As frozen, the last rule binds only the anchor score: a record's plain things also
count when it names another person or venue (§2), which the fit split preferred.

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
request says 2; a person also matches a request word of four or more letters that begins the name, "Chris" for
"Christopher"; anchors in more than 5%, and at least 5, of the user's records, the user's own name, do not count);
things count for every live record, also one naming another person or venue (`--strict` limits them to records whose
specific anchors the request names or that have none: fit facts 186 → 194, decoys 211 → 211); `clears` records other
than kind `done`, and `blocks` records a later `clears` shares a whole anchor string and a thing with, never match; a
dated record whose days miss every explicit date the request names is rejected; the first two matches go before the
shipped pool. Fit split (train1–4 days requests): facts @5 186 → 205 of 276 (21 in, 2 out of the first five),
decoys @5 211 → 211 of 285 (net: 3 in, 3 out). Prompt v2 (`LEDGER_SYSTEM_V2`, `--prompt v2`; roles,
up to 8 broader request words in `things`; $1.72 for the days corpora) was worse on the fit split (best 186 → 196,
decoys 211 → 220): broader words bring the twins back (D526's failure), and it was rejected before any held-out read.

## 3. Results, and the stop (D910)

**Held-out families (train5–6 days requests, read once at cdeeeef6):**

| | shipped pool | with the ledger | change |
|---|---|---|---|
| facts @5 (157 hidden) | 116 | 125 | **+9, +5.7 points** (ratio 1.078) |
| decoys @5 (148 control) | 88 | 95 | +7 (ratio 1.080) |

**Stop.** Below the +8-point bar, and decoys rise slightly faster than facts. Nothing is wired; no trial, no Pi pair.
(The shipped baseline here is a fresh live-carded run of the same recipe as M3's §1b: 116 of 157 against M3's 123,
so card-run variance alone moves the base by a few facts.)

**Short worlds** (the funnel's train1–6, seeds 41–44, its `--pool-dump`, ledger made from those worlds; same frozen
matcher): fit facts @5 403 → 417 of 512, decoys 371 → 380; held-out families 201 → 208 of 256 (+2.7 points), decoys
156 → 170. **Neutral:** the ledger puts a new item in the first five on 321 of 768 neutral requests (198 fit, 123
held); the shipped push already sends a packet on about 97% of them, so neutral packets would not rise in count, only
change content.

**Why it falls short.** The ledger is precise: on the fit split decoys @5 did not move net (211 → 211, 3 in and 3
out), because the all-clear twin is written as a `clears` record and another day is a date miss. What it lacks is
reach. Of the 90 fit facts the
shipped pool misses at @5, 85 have a record and about 20 match the request's words; the rest need a leap the
request never states ("Dubai" for a pause on international trips, "£120k" for a £50k signing limit, "our usual
babysitter" for Megan's exams, "Saturday 31 Oct" for a provider's maintenance window). Widening the records' words
to reach them (prompt v2) brought the twins back as D526 found: facts 186 → 196, decoys 211 → 220 on the fit split.
A symbolic match over model-written records reaches the facts that share an anchor with the request, which the
shipped pool mostly reaches already.

**Costs (measured):** extraction $0.000035 an item (Haiku 5.5 direct, no thinking, 15 items a call; 46,859 days
items read for $1.72 with prompt v2 and $1.63 with v1; the short worlds' 6,891 for $0.31), p50 1.1 s a call; Batch
pricing would halve it **[EST]**. The sim's users get about 25 dated items a day (w41: 1,215 dated items over 61
days, peak 40), so about
**$0.0009 a user a day** (300 items a day would be $0.011) **[EST from the measured rate]**. Request time: 3.3 ms in
unoptimised Python over a 266-record ledger (anchors recomputed per request); a TypeScript matcher with the anchors
built at ingest would be well under that **[EST]**. Records: about 0.18 an item.

**Not done:** M2's `eden-synth` test split (on a Modal Volume; Modal's API is unreachable from this session's
container); the open-model extraction arm on Modal (Haiku's price passes the bound by a factor of ten, so it was not
needed for the stop).

Spend: Anthropic $4.16 of $30 (ledger `.local/m5/ledger.jsonl`: shipped-coverage cards, extraction v1 and v2), Modal $0.

## Reproduce

```bash
# Shipped-coverage days baseline (M3's §1b recipe), users w41–w72; also dumps each user's corpus.
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/days-calls.ts --seeds 41,…,72 --cards-live claude-haiku-5-5 \
  --intent none --cards-out .local/m5/d/cards.jsonl --spend-ledger .local/m5/ledger.jsonl --spend-cap 3 \
  --pool-diag .local/m5/d/pool.jsonl --corpus-dump .local/m5/d/corpus.jsonl
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/m5-ledger.ts extract --corpus .local/m5/d/corpus.jsonl \
  --out .local/m5/led-v1.jsonl --spend-ledger .local/m5/ledger.jsonl --spend-cap 30 --concurrency 6
python3 -I packages/sim/lab/m5/m5_match.py --ledger .local/m5/led-v1.jsonl --corpus .local/m5/d/corpus.jsonl \
  --pool .local/m5/d/pool.jsonl --only fit   # --only held: the one held-out read
# Short worlds and neutral: bun run funnel --seeds 41,42,43,44 -- --neutral --pool-dump P --corpus-dump C
```

## 4. Version 3, the typed mapping (pre-registered, the parent's request)

v1's records and prompt, unchanged ($0 extraction); the matcher adds three typed comparisons with no model: an
amount the request names against a record's limit or threshold, a role word the request uses ("babysitter",
"Mum", "approver") against a record's person through the record's own sentence, and a destination the request
names against a record's category through a small hand-built gazetteer of the sim's places. **Fit** on train3–6,
**read once** on train1–2 (157 hidden in v1's run is train5–6; train1–2 counts are in §5). Same bar: facts @5 at
least +8 points over the shipped pool with decoys @5 rising by no larger ratio. Anthropic cap for this version $5.
**Caveat, written before the read:** train1–2 were in v1's fit split and v1's miss examples from them were read
while building v1, so this fold is not blind to the author; the read is a second fold, not a clean held-out set.

## 4. Version 3, the typed mapping (pre-registered at the parent's request)

v1's records and prompt are unchanged ($0 extraction). The matcher adds three typed comparisons, with no model:

- an amount the request names, against a record's limit or threshold;
- a role word the request uses ("babysitter", "Mum", "approver"), against a record's person, through the record's
  own sentence;
- a destination the request names, against a record's category, through a small hand-built gazetteer of the sim's
  places.

**Fit** on train3–6; **read once** on train1–2. Same bar: facts @5 at least +8 points over the shipped pool, with
decoys @5 rising by no larger ratio. Anthropic cap for this version: $5.

**Caveat, written before the read:** train1–2 were in v1's fit split, and v1's miss examples from them were read
while v1 was built, so this fold is not blind to the author. The read is a second fold, not a clean held-out set.

**Frozen (v3):** `m5_match.py --typed` at this commit, other defaults as in §2 (front 2; `--day-w` stays 0, a day
weight added nothing on fit). Fit (train3–6 days requests): facts @5 220 → 246 of 315 (+8.3 points; v1's matcher
239), decoys @5 184 → 188 of 287 (v1's 188).

## 5. Version 3's result: stop (D912)

train1–2 days requests, read once at 7d26ee8e with `--typed`:

| | shipped pool | v3 (typed) | change |
|---|---|---|---|
| facts @5 (118 hidden) | 82 | 89 | **+7, +5.9 points** (ratio 1.085) |
| decoys @5 (146 control) | 115 | 118 | +3 (ratio 1.026) |

**Stop.** Decoys pass the clause (they rise far slower than facts), but facts are below the +8-point bar.

For reference only, outside the pre-registered read:

- v1's matcher on the same rows (it was fit on them) gets 82 → 91 facts and 115 → 118 decoys. The typed comparisons
  added nothing there.
- v3 on train5–6 (already read once under v1) gets 116 → 127 facts (+7.0 points) and 88 → 95 decoys.

The typed comparisons reach a few of the leaps:

- an amount over a stated limit (£120k against £50k to sign);
- a destination abroad against a pause on international trips or a passport away;
- a role named in the record's own item.

Most misses still name nothing the record holds. A hire car does not name the expired licence, a party invite does
not name the babysitter who cancelled, and a hoodie order does not name an embargoed logo. No pass of v1's records
reaches +8 points on a second fold. Anthropic spend for v3: $0, since v1's records were reused.
