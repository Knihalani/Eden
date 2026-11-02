# Haiku 5.5 optimisation: the reader learns to say "lookalike"

Status: 2026-11-02. Phase 1 of the Haiku campaign (the user's $40 Anthropic budget, lab only). No-model funnel
(`hidden-funnel.ts --ask`) with Eden's model calls live on Claude Haiku 5.5. Every number below comes from a command
run in this session; the spend is from the campaign's spend ledger (`packages/sim/src/lab/spend.ts`).

## Summary

- **What improved.** NEW = ALL3 + the intent index (D87) + the ask-time reader (D95), with prompt v5 and
  `askReaderDrop`. On the broad train set (train1–6, seeds 41–42, 384 hidden and 384 control tasks):
  - planted hidden items surfaced rose from 214 to 286 (+18.8 points);
  - decoys surfaced fell from 211 to 150 (−15.9 points);
  - both at the real 2.5 s wait, on the reviewed code (below).
- **Blind check** (held-out 10–11, seeds 41–42, 128 + 128 tasks): hidden 72 → 87 (+11.7 points), decoys 60 → 50
  (−7.8 points).
- **What made it work.** The fix is the output's shape, not more rules. Asked only for binding items, Haiku flagged
  the lookalike decoy almost as often as the planted item: 105 of 192 decoys against 118 of 192 hidden, seed 41.
  Three changes cut decoy flags to 7 of 192 while it still flagged 118 of 192 hidden:
  - it labels lookalikes explicitly;
  - it writes what the item means before it decides;
  - it checks that the item is about the same thing.
- **Cost and latency.** $0.00042 per reader call (3,770 tokens in, 249 out, 24% of the prompt read from the cache).
  p50 1.41 s, p90 1.99 s; 32 of 644 calls (5%) were over the 2.5 s wait.
- **What did not help:**
  - adaptive thinking at low effort (Haiku did not think: same output tokens, same result);
  - a 40-item pool (one more planted item in the pool, four more decoy flags).
- **Not done:** the reader gating proactive packets (Phase 1's item c) was not tried; the agent benchmark (Phase 2)
  measures NEW as is.

## Setup

- **Reader:** `--reader live --reader-model claude-haiku-5-5`, `AnthropicModel` (direct Messages API, thinking off,
  the system prompt cached), metered on the campaign's spend ledger.
- **Wait:** `askReaderWaitMs` lifted to 60 s for scoring judgement; the "2.5 s" column replays the baseline's answer
  for every call slower than the production wait (`reader-score.py`).
- **Cards:** replayed (`cards-v2.jsonl` + `cards-train.jsonl`).
- **Intent requests:** made once with Haiku for every item of the train worlds and of the held-out 10–11 worlds:
  - `cards-enrich.ts --intent --model claude-haiku-5-5`;
  - 3,331 + 199 items, 379 calls, $0.198;
  - replayed with `--intent`.
- **Tuning:** on train only; held-out 10–11 run once, at the end.
- **"Harmful decoy":** a control task whose planted decoy the reader flagged, so it reaches the agent with a bearing.

## The prompt, version by version (train seed 41, ALL3 + reader, 192 + 192 tasks)

| Version | Change | Hidden surfaced | Hidden flagged | Decoys surfaced | Decoy flagged | p50 / p90 ms |
|---|---|---|---|---|---|---|
| ALL3 (no reader) | | 107 | | 106 | | |
| v2 (D95's) | only binding items listed | 136 | 118 | 133 | 105 | 1008 / 1576 |
| v3 | lookalikes listed and labelled; date moved out of the system prompt | 134 | 114 | 127 | 88 | 1434 / 2151 |
| v3, thinking on (low) | | 135 | 117 | 130 | 89 | 1450 / 2230 |
| v4 | each entry writes `why`, then decides `binds`, then names the kind | 134 | 114 | 109 | 13 | 1518 / 2295 |
| v4, pool 40 | | 134 | 114 | 112 | 17 | 1540 / 2328 |

v2's bearings often denied themselves:
- "Boardroom is booked 07:30–13:00 on 18 Nov, not 11 Nov" (flagged as blocks);
- "Company cards restored … so card payment now works" (done);
- "Gideon lifted the Q3 bonus hold" (done).

The model read the item right and labelled it wrong: the label came first, before the model had read the item against
the request. Putting the reason before the decision fixed most of it.

## With the intent index (train seed 41)

| Configuration | Hidden surfaced | Decoys surfaced | Decoy flagged | p50 / p90 ms |
|---|---|---|---|---|
| ALL3 | 107 | 106 | | |
| ALL3 + intent (no model at ask time) | 123 | 117 | | |
| + reader v4 | 153 | 119 | 15 | 1478 / 2370 |
| + reader v5 (`same` check before `binds`, ≤ 6 entries) | 152 | 117 | 7 | 1360 / 1958 |
| + reader v5 + `askReaderDrop` | 145 | 57 | 7 | (same calls) |

v5's remaining v4 decoy flags were mostly the same kind of thing, but another one:
- a cancelled penalty notice at another street;
- a swimming class moved, for a ballet request;
- a support case about a different bucket.

The `same` field asks the model to check that first.

## Train, seeds 41–42, and blind (the merge rows)

| Suite | Configuration | Hidden | Decoys | Decoy flagged (any kind / blocks, limits, done) | p50 / p90 ms | $ per call |
|---|---|---|---|---|---|---|
| train (384 + 384) | ALL3 | 214 | 211 | | | |
| | ALL3 + intent | 247 | 234 | | | |
| | + reader v5 | 296 | 233 | 20 (5.2%) / 10 (2.6%) | 1413 / 1992 | 0.000420 |
| | NEW, before review fixes | 282 | 124 | 20 (5.2%) / 10 (2.6%) | 1413 / 1992 | 0.000420 |
| | **NEW (final)** | **286** | **150** | 22 (5.7%) / 11 (2.9%) | 1407 / 2000 | |
| held-out 10–11 (128 + 128) | ALL3 | 72 | 60 | | | |
| | ALL3 + intent | 77 | 64 | | | |
| | NEW, before review fixes | 85 | 43 | 4 (3.1%) / 3 (2.3%) | 1214 / 1730 | 0.000322 |
| | **NEW (final)** | **87** | **50** | 4 (3.1%) / 3 (2.3%) | 1214 / 1730 | |

The train and held-out NEW rows count a call slower than 2.5 s as not made (`reader-score.py`'s capped column).

The final rows are the code as merged, after the review. Two fixes changed the numbers:
- a drop that would empty an answer is not made, since an empty answer reads "Nothing in the connected sources";
- items are redacted before they are cut, which changed 38 + 7 prompts, read again live.

The guard gives back some of the decoy cut, 124 → 150 on train.

The merge bar set for this phase:
- hidden ≥ +5 points on train: +18.8;
- harmful decoys ≤ 5%: 2.9% counting the blocking kinds as D95 defines harm (a "blocking bearing"), 5.7%
  counting "changes" too;
- blind not worse: better on both counts.

The "changes" kind carries half the decoy flags, so it is the next thing to tighten.

## What `askReaderDrop` does, and its cost

Only items the reader named and rejected (`same: false`, `binds: false`, or kind `lookalike`) leave the ask's
answer. An item it did not mention stays, and an item it flagged is never dropped (`reader.test.ts`). Before the empty-answer guard, on train:
- it removed 109 decoys from asks (233 → 124);
- it cost 14 hidden items (296 → 282): the reader read the planted item and wrongly called it a lookalike.

Under "precision over recall" that trade is the right one, but it is a recall cost, said here.

## Spend

Phase 1 Anthropic spend, all roles (reader, intent requests for train and held-out 10–11, smokes, the final
re-reads): **$1.39** of the $40 cap, every call in the
ledger (`.local/haiku/ledger.jsonl` during the run; the summary is above).

## Reproduce

```bash
H=.local/haiku; cat packages/sim/lab/cards/cards-v2.jsonl packages/sim/lab/cards/cards-train.jsonl > $H/merged.jsonl
NEW=$(bun -e 'import {PRESETS} from "./packages/sim/src/lab/presets"; console.log(JSON.stringify({...PRESETS.NEW, askReaderWaitMs: 60000}))')
LEDGER="--spend-ledger $H/ledger.jsonl --spend-cap 40 --spend-headroom 3"
bun packages/sim/src/lab/cards-enrich.ts --dir $H/intent --funnel train --seeds 41,42 --intent \
  --model claude-haiku-5-5 --concurrency 6 $LEDGER
bun packages/sim/src/lab/hidden-funnel.ts --suite train --seeds 41,42 --ask --config "$NEW" --cards $H/merged.jsonl \
  --intent $H/intent/intent-v2.jsonl --json $H/new.json --no-record --reader live --reader-model claude-haiku-5-5 \
  --reader-cache $H/reader-cache-v5.jsonl $LEDGER
python3 -I packages/sim/lab/scripts/reader-score.py BASE.json $H/new.json
```
