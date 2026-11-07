# S3a: hidden facts the intent index never surfaces (RealUse-1 issue 3)

Status: done, 2026-11-07. Plan: [realuse-1-weak-points.md](realuse-1-weak-points.md), issue 3. Decisions: D200
(promoted), D201 (rejected), D202 (no change). Every paid call went to the Anthropic API with `HAIKU_API_KEY`,
`claude-haiku-5-5` in every role, `OPENROUTER_API_KEY` unset, on one ledger with a hard $3 cap
(`--spend-ledger .local/ledger.jsonl --spend-cap 3 --spend-headroom 0.3`). **Spent: $1.14999** (sum of the ledger's
`costUsd`, all labels `s3a-*`; nothing else was paid). These are Anthropic-direct figures (D97).

## The problem

RealUse-1's blind suite raised 65.6% of hidden facts against 74-80% on read suites. On train1-6 seeds 41-42 (LAB.md
recipe 2a, `--ask-diag`), 45 of 384 hidden facts never reached the ask's candidates: 27 under the intent thresholds,
10 with no shared term, 5 past the `intentHits` cut, 3 with no intent requests. Reproduced exactly at the start of this
session (TOTAL 311/137, pool 278/254, buckets 3/10/27/5).

## Step 1: thresholds by card kind (D200, promoted)

`--ask-diag` rows now carry `cardKind`, the card the engine held for the planted item at the ask
(`ask-coverage.ts`, `hidden-funnel.ts`). Split by it (train seeds 41-42, before D200):

| Card kind | hidden n | under thresholds | past the cut | decoy n | under thresholds | past the cut |
|---|---:|---:|---:|---:|---:|---:|
| none | 254 | 14 | 2 | 287 | 22 | 4 |
| any constraint kind | 130 | 13 | 3 | 97 | 5 | 0 |

Per kind the rows are too few to calibrate (1 to 3 a kind under the thresholds), so the switch splits carded from
uncarded. Hidden and decoy items under the floor have similar coverage (0.03-0.20 both), so a single lower floor would
add decoys as fast as hidden facts; the card is what tells them apart.

**`intentByKind`** (`keepIntents`, intent.ts; partner.ts `intentFinds` and the lab's `intentPlace` both call it):

- a hit whose item holds a constraint card counts from `intentCardCoverage` (0.1) instead of `intentMinCoverage`
  (0.2);
- carded hits the first `intentHits` raw hits or ids left out take up to `intentCardHits` (4) places after the others;
- the store is read `3 x intentHits` deep for them (`CARD_REACH`), since a weak carded hit ranks behind uncarded ones by
  BM25.

Sweeps (train seeds 41-42, the reader replayed with misses, so only the pool lines are clean):

| Arm | hidden in pool | decoys in pool | reader misses |
|---|---:|---:|---:|
| default before | 278 | 254 | 0 |
| floor 0.1, no extra places | 281 | 254 | 496 |
| floor 0.05, no extra places | 281 | 256 | 514 |
| floor 0.1, 4 places, read 1x deep | 284 | 255 | 909 |
| floor 0.1, 1 place, read 3x deep | 284 | 255 | 968 |
| floor 0.1, 4 places, read 3x deep (shipped) | 287 | 255 | 1,008 |
| shipped, plus uncarded floor 0.25 | 279 | 250 | 1,129 |
| shipped, plus uncarded floor 0.3 | 274 | 249 | 1,136 |
| floor 0, 4 places, 3x deep | 287 | 256 | 1,101 |

Lowering the carded floor alone moved carded hits from "under thresholds" to "past the cut": the first 12 raw hits are
full of uncarded ones. Raising the uncarded floor lost hidden about one for one with decoys. With the misses topped up
(one process), the shipped arm reads 285/254.

**Train, paid reader replayed** (recipe 2a, topped up: `s3a-bykind-reader-topup` 497 calls $0.15136,
`s3a-default-reader-topup2` 2 calls $0.0007; then 654 replayed, 0 missed):

| | hidden surfaced | decoys surfaced | hidden in pool | decoys in pool | decoys flagged in pool | reader calls |
|---|---:|---:|---:|---:|---:|---:|
| before | 311 | 137 | 278 | 254 | 23 | 651 |
| `intentByKind` | 316 | 132 | 285 | 254 | 27 | 654 |

Task by task (`--baseline`): hidden +11 −6, decoys +9 −14. A changed pool moves the reader's answers on other tasks
too, so the net is the figure to read. Unranked hidden 45 to 38. Seeds 41-44 at pool level (stub reader, $0):
hidden in pool 557 to 566/768, decoys 506 to 505, mean reader prompt 7,493 to 7,673 characters, reader calls 1,306 to
1,314; seeds 43-44 alone +0 hidden, −2 decoys. The stub screen (recipe 1) moves 281/256 to 282/255.

**Pi live** (Haiku 5.5 in every role, direct profile, `--push signals`, held-out 13 hidden/control and held-out 14
hidden/control/neutral, seeds 41-42, one process per suite and seed, conditions `eden,eden+intentByKind`; ledger runs
`s3a-kind-h13-41`, `-h13-42`, `-h14-41`, `-h14-42`: $0.13338, $0.13308, $0.1644, $0.17548):

| | hidden raised | control false concern | neutral any concern | Eden $/1k (hidden) | wall p50 s (hidden) |
|---|---:|---:|---:|---:|---:|
| eden | 0.734 (128) | 0.008 (128) | 0.016 (64) | 0.303 | 3.85 |
| eden+intentByKind | 0.773 (128) | 0.008 (128) | 0.016 (64) | 0.344 | 3.96 |

Paired bootstrap 95% (`pi-ab-report.ts` over the four files): hidden +0.039 (−0.031..+0.109; held-out 13 +0.047,
held-out 14 +0.031), control +0.000 (−0.023..+0.023), Eden $/1k on hidden tasks +0.040 (+0.003..+0.076), agent+Eden
cache-neutral +0.053 (−0.006..+0.106), wall +0.13 s (−0.18..+0.44). On control tasks the cost moved +0.000
(−0.049..+0.049).

**The trade, and why it is promoted.** Hidden rises on train (+5) and live (+3.9 points, not significant alone), with
no rise in false or neutral concerns and decoys surfaced down on train. It costs Eden about $0.04 per 1,000 hidden
tasks more (a CI that excludes zero), about +13% of its per-task cost there, and about +$0.01 per 1,000 on control and
neutral tasks: at RealUse-1's assumed 1:1:8 mix about +$0.014 per 1,000 tasks for about +0.4 points of all tasks
raising a hidden fact. That is the trade the plan asked to state. `bun run eval` is identical (precision 0.8276, recall
0.48, falseFireRate 0) and `eval-live.ts` on Haiku gives the same three ($0.00086, `s3a-eval-live`).

The reader cache of recipe 2a is replaced by its topped-up copy (1,915 lines, plain md5
`477e2bf92262b86a4399b070bddd82c0`); the pre-D200 readings stay in it, so `--set '{"intentByKind":false}'` still
replays 311/137.

## Step 2: requests in the phrasing agents use (D201, rejected)

The asks are delegations ("Book my flights to Toronto for the client visit on 12 November, economy, around £600"),
the stored requests short paraphrases ("update the website relaunch backfill ticket"). The variant prompt asked for:

> write up to 4 requests the user might give their personal assistant (an AI agent that acts for them) where this
> item would change what the assistant should do or say. Word them the way people delegate to an assistant: whole
> instructions in the imperative that name the concrete person, organisation, thing, amount or day involved (...),
> and at least one as a question (...). Use everyday words for the action, which may differ from the item's own.
> (...) Write [] for bulk mail, newsletters, promotions and marketing (no "unsubscribe" requests).

A first 40-item sample gave newsletters "Unsubscribe me ..." requests, so the last sentence was added before the full
run. Train seeds 41-44 re-enriched (6,891 items; `s3a-intent-agent-train4144` 687 calls $0.36402, then 34 + 25 calls
$0.01939 for the items Haiku left unanswered): **$0.0000531 an item**, 779 output tokens a call, 1,463 cached input
tokens a call. The shipped prompt on the same first 40 items: $0.0000473 an item, 675 output tokens a call (a sample,
not the full set).

Screen at $0 (stub reader, seeds 41-44, every planted item with a line in both files; the default with D200):

| Requests | hidden in pool | decoys in pool | hidden unranked | no shared term |
|---|---:|---:|---:|---:|
| shipped (intent-v2) | 566 | 505 | 74 | 16 |
| agent-worded | 534 | 498 | 94 | 26 |
| both (up to 8 an item) | 571 | 520 | | |

Requests that name the specifics match fewer of an ask's words: the specifics of an item and of a request about it
rarely coincide, while the shipped paraphrases share the common action and object words. Together they add three
decoys for each hidden fact. No reader top-up or live run was spent on it; the switch, the prompt, `cards-enrich.ts
--intent-prompt` and their tests are deleted.

## Step 3: the other buckets (D202, no change)

- **No intent requests (3 hidden).** All three were sent to the card model and have requests in the replay, but held
  none when the ask arrived: their requests were made after it (`requestsOf` counts only requests made before the
  request). Fixing that means waiting on a background model call at request time (D4, D45).
- **Past the `intentHits` cut (5 hidden, 4 decoys).** 3 of the hidden ones held a constraint card and D200 keeps
  them; the 2 uncarded ones (`physio-late-change-fee`, both seeds) sit beside 4 uncarded decoys. After D200 the bucket
  is hidden 8 (6 carded) and decoys 7 (3 carded): carded hits that clear 0.1 but find none of the 4 places, so more
  places would add decoys at about 2 for 1.
- **No shared term (10 hidden, 25 decoys)** is untouched: D189 showed no-model expansion does not close it.

## Reproduce

```bash
gunzip -c packages/sim/lab/distilled/reader-haiku-train-4142-intent.jsonl.gz > .local/reader-haiku-train-4142-intent.jsonl
R="--reader replay --reader-model claude-haiku-5-5 --reader-cache .local/reader-haiku-train-4142-intent.jsonl"
env -u OPENROUTER_API_KEY bun run funnel --jobs 4 --allow-misses --json .local/kind.json -- $R --ask-diag .local/kind-diag.json
env -u OPENROUTER_API_KEY bun run funnel --jobs 4 --allow-misses --set '{"intentByKind":false}' --json .local/before.json -- $R
env -u OPENROUTER_API_KEY bun run funnel --jobs 4 --seeds 41,42,43,44 --set '{"intentByKind":false}'   # pool, stub
# Pi, as run (before the promotion), per suite S (heldout13: hidden,control; heldout14: hidden,control,neutral), seed N:
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/pi-ab.ts --suite S --seeds N --variants V \
  --conditions eden,eden+intentByKind --config '{"intentByKind":false}' \
  --cards packages/sim/lab/cards/cards-v2.jsonl --cards-out .local/pi/L.cards.jsonl \
  --model claude-haiku-5-5 --grader claude-haiku-5-5 --card-model claude-haiku-5-5 --reader-model claude-haiku-5-5 \
  --source-profile packages/sim/lab/before-after/market-profiles/direct.json --push signals --budget 1.5 \
  --spend-ledger .local/ledger.jsonl --spend-cap 3 --spend-headroom 0.3 --run-label L --out .local/pi/L.json
bun packages/sim/src/lab/pi-ab-report.ts .local/pi/*.json
```

The runs used `--config default` on the tree before the promotion (where `intentByKind` was off); on the promoted
tree the `--config '{"intentByKind":false}'` above gives the same base arm (not re-run). It is the RealUse-1 part A
command with the cap at 3.
