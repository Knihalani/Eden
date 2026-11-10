# F2: pruning the intent requests, reaching no-shared-word facts behind a checker, and a card order for new users

Status: 2026-11-10, branch `claude/f2-quality` (from `claude/lucid-hypatia-v9wqk5` at `0fbbeb56`), session F2.
Decisions D480–D484. Train only (train1–6); no held-out suite was run, and `heldout18` was not touched. Paid calls:
Pi on Modal (`lab_fanout.py`), `claude-haiku-5-5` in every role on Anthropic's API through the lab provider (D97):
**Anthropic-direct lab figures. Spent $3.187 Anthropic** of the $6 cap (the shards' ledgers); Modal: 10 CPU
containers of 46–132 s, about $0.11 **[EST]** at the README's list prices (no billing report read). Every other number
comes from a command run in this session.

## In plain words

- **(A) Pruning the intent requests: no no-model rule works, and the trial is deleted (D480, D481).** Each item's
  background requests were scored against the item four ways (the share of a request's words the item holds, names
  the item does not hold, keep the closest N, keep the farthest N) and the weak ones dropped. On both draws of the
  requests every rule loses hidden facts: dropping only the 617 requests that share no word with their item (under 4%
  of them) loses 13 and 7 hidden tasks net; keeping the three closest loses 9 and 7. No rule lowers decoys by 10. The
  requests that look least like their item are the ones that reach hidden facts: that is what the index is for.
  Doc2Query-- filters with a trained relevance model; a lexical stand-in for it prunes the bridge. A checker-scored
  rule was not run: I1's checker had not landed (below).
- **(B) Embeddings behind I1's checker: not run.** `claude/i1-checker` did not exist on the remote at any poll of
  this session (the last at the end of the run), so there was no checker to put in front of M3's hybrid.
- **(C) A card order for new users works, and is now in the default (D482, D483).** When a new user's first requests
  arrive before the background card model has read everything, which items it read first decides what Eden can find.
  The order the owner proposed (events ahead, mail from people the user writes to, the last three days) did nothing on
  its own at $0 (−1 to −4 hidden tasks). Reading **items with constraint wording first** (the prefilter already says
  which: 299 of the 384 planted items, against 32% of what the model is sent) did: with 4 of a user's ~16 card calls
  made, the funnel finds +24 and +18 more hidden facts on the two draws (235 → 259, 237 → 255, of 384), +20 and +20
  at 8 calls, and nothing changes once every item is read. Live on Pi, cards made in-run by Haiku, four
  card calls a user, seeds 41–48: **hidden facts raised 47.0% → 56.0%, +9.0 points (+6.6..+11.4, n 1,536)**; false
  concerns +0.3 points (−0.4..+0.9; 11 → 15 of 1,536); the agent's cost $0.261 → $0.274 per 1,000 task runs (it reads
  a few more packets). The pre-registered rule said promote. The shipped order is constraint wording first, then the
  owner's three signs, then the newer date.
- **How much of the gap it closes.** On seed 41 the same arm with every card made (no cap) raised 60.4% (116/192)
  against 49.0% capped at four calls: a gap of 11.5 points, of which the order closed 2.1 on that seed (18%; seed 41
  had the smallest effect of the eight, +2.1 against a pooled +9.0, so the pooled share is larger but was measured
  against no pooled reference). At $0 the order closes 30% (draw 1) and 26% (draw 2) of the funnel's gap to full
  cards at 4 calls, and 32% and 35% at 8.
- **The distilled card model (M2) was not run:** no `eden-cards-distill` endpoint was deployed on Modal.

## 0. Pre-registration

### (A) Pruning the intent requests: the $0 bar

Written after the first no-model screen had been read (it had no paid run; the bar is the one A22's D361 sets for any
lever on the intent index, stated here so the later, checker-scored screen is read against the same rule).

- Screen: `bun run funnel` (train1–6, seeds 41–42, 384 hidden and 384 control tasks) with the trial on, on **both**
  draws of the requests (`intent-v2`, shipped; `intent-v2-draw2`, A22's re-draw), each against its own draw's default.
- A rule passes only if, **on both draws**, hidden net ≥ 0 and decoys net ≤ −10, or hidden net ≥ +10 and decoys net
  ≤ +3. D361: the default itself moves 7 hidden and 8 decoys between the draws, and 43 hidden and 34 decoy tasks
  change, so a move under about 10 tasks on one draw is not a result.
- A pass buys a live Pi run (its own rule written before it); a fail deletes the trial (D112).
- The same bar applies to a rule that scores requests with I1's checker, if `claude/i1-checker` lands one.

### (B) Embedding reach behind I1's checker

Not started: `claude/i1-checker` does not exist on the remote at the time of writing. If a usable checker lands
before this session ends, the bar is M3's (D450), read after the checker's filter: the hybrid at k 3 keeps hidden net
≥ +10 at decoys net ≤ +3 in the first five. Otherwise (B) is reported as not run.

### (C) `cardsOrder` live: the rule, written before any paid call

**What is measured.** A new user's backfill fills the card queue faster than the model empties it, so the first
requests meet cards for only part of the items. pi-ab waits for the enrichment to finish before the first request
(`cards.idle()`), so it cannot see the order; `--cards-calls N` (new, lab only) lets each user's card model answer its
first N calls and leaves the rest uncovered. The $0 screen (§2) reads the funnel at N = 1…24 on both draws.

**Live runs (Modal, `lab_fanout.py`, one shard at a time or two).** Pi, `--suite train`, seeds 41–48, one seed a
shard, `--variants hidden,control`, `--tenant-prompt`, `--push payload`, the `direct` source profile, time scale 1,
`claude-haiku-5-5` in every role, **no `--cards` file: every card and its requests are made in-run by Haiku**.

1. Main: arms `eden` and `eden~order` (`{"cardsOrder":true}`), both with `--cards-calls 4`, paired task by task.
   Cap $3.60 ($0.45 a shard).
2. Reference (the gap's other end): arm `eden` with no call cap, seeds 41–42. Cap $1.20. Unpaired with (1): the same
   tasks in another process, so it gives a level, not a paired effect.
3. A smoke shard first (train1, seed 41, `--limit 4`). Cap $0.10.

Anthropic at most $4.90 of the $6 cap; Modal well under $20 (**[EST]** about $0.05 a shard from M1's billing).

**Primary figure.** Hidden facts raised (Haiku-graded), `eden~order` minus `eden` at N = 4, paired by task, pooled
over seeds 41–48, with `cl8/pooled.py`'s bootstrap interval. Secondary: control concerns (Haiku-graded; regraded by
Sonnet only if the rule turns on them), the share of the gap closed = (order − fifo) / (reference − fifo) on seeds
41–42, and $ per 1,000 tasks.

**Rule.**

- **Promote** `cardsOrder` into `DEFAULT_CONFIG` if the pooled paired hidden effect is ≥ +2.0 points with its 95%
  interval above zero, and control concerns are not up by more than 1.0 point.
- **Delete** it if the point estimate is below zero, or control concerns rise by more than 1.0 point with an interval
  above zero.
- **Otherwise** (a point of 0 to +2, or an interval that spans zero): not promoted; the switch stays a trial to its end
  date with the $0 result as its evidence, and the note says the live run could not tell.

The distilled card model (M2) is run through `--cards-endpoint` only if an endpoint is deployed on Modal when the
main run ends; none was when this was written (`modal app list`: every `eden-cards-distill` app stopped or ephemeral).

**Amendment after the smoke shard, before any main-run call.** The smoke (train1, seed 41, `--limit 4`, 16 task runs,
4 streams) spent $0.0260: 16 card calls at $0.0012 each ($0.0195) and $0.0004 a task run. At that rate a main shard
(24 streams, 96 card calls, 768 task runs) costs about $0.43 **[EST]**, so $0.45 a shard would stop shards early. Caps
are now: main $4.40 ($0.55 a shard, run as four fan-outs of two seeds), reference **seed 41 only** $0.65. With the
smoke, at most $5.08 of the $6 cap. The rule and the figures are unchanged; the share of the gap closed is read on
seed 41.

## 1. (A) The pruning screen (D480, D481)

Trial `intentPrune` (commit `5ab10a9d`: `intent.ts` `pruneRequests`, wired through `CardEnricher`): the requests the
card call wrote for an item pass a rule against that item's title and first 4,000 characters before they are
indexed. Rules: `share:x` (at least x of the request's distinct stemmed terms are the item's), `names` (no capitalised
word past the first, and no number, that the item does not hold), `top:n` (the n sharing most), `far:n` (the n
sharing least). `bun run funnel --jobs 4 --set '{"intentPrune":"…"}'` on both draws, each against its own default
(`packages/sim/lab/f2/prune-screen.txt`, by `table.py`); surfaced of 384, tasks gained and lost in brackets:

| Rule | Requests dropped (draw 1) | Draw 1 hidden | Draw 1 decoys | Draw 2 hidden | Draw 2 decoys | Bar |
| --- | --- | --- | --- | --- | --- | --- |
| default | | 314 | 273 | 307 | 281 | |
| `share:0.01` (no shared word) | 617 | 301 (+3 −16) | 275 (+4 −2) | 300 (+2 −9) | 280 (+2 −3) | fails |
| `share:0.25` | 1,017 | 296 (+3 −21) | 275 (+6 −4) | 297 (+3 −13) | 279 (+2 −4) | fails |
| `share:0.34` | | 275 (+5 −44) | 265 (+3 −11) | 274 (+4 −37) | 273 (+7 −15) | fails |
| `share:0.5` | | 268 (+5 −51) | 262 (+2 −13) | 271 (+5 −41) | 268 (+7 −20) | fails |
| `names` | 2,032 | 287 (+4 −31) | 270 (+4 −7) | 289 (+7 −25) | 270 (+4 −15) | fails |
| `top:1` | | 254 (+7 −67) | 247 (+9 −35) | 244 (+5 −68) | 254 (+14 −41) | fails |
| `top:2` | | 278 (+5 −41) | 258 (+7 −22) | 279 (+9 −37) | 263 (+6 −24) | fails |
| `top:3` | 961 | 305 (+2 −11) | 273 (+1 −1) | 300 (+4 −11) | 279 (+6 −8) | fails |
| `far:1` | | 282 (+6 −38) | 265 (+15 −23) | 269 (+10 −48) | 256 (+4 −29) | fails |
| `far:2` | | 298 (+9 −25) | 267 (+6 −12) | 289 (+7 −25) | 272 (+6 −15) | fails |
| `far:3` | 961 | 309 (+2 −7) | 273 (+2 −2) | 299 (+0 −8) | 273 (+2 −10) | fails |

Where decoys fall they fall with hidden facts, about one for one or worse (`share:0.5`: hidden −46 and −36, decoys
−11 and −13). Why: the planted items' requests share fewer words with their item than other items' do (`look.py`:
median share 0.50 against 0.60; 113 of the 1,265 requests on planted hidden items share no word with them, 9%, against
4,312 of 94,828 on other items, 5%), because a hidden fact is by construction something the request does not name.
A rule that reads word overlap as relevance removes those first. The rule and its code are deleted (D112).

## 2. (C) The card order

### $0: the funnel with N card calls a user

`bun run funnel --jobs 4 [--set '{"cardsOrder":true}'] [--intent draw2] -- --cards-calls N`: each world's card model
(the replayed cards and requests) answers its first N calls and leaves the rest uncovered. A world here needs about
16 calls. Hidden / decoys surfaced of 384, as the queue filled → with the order
(`packages/sim/lab/f2/order-curve.txt`):

| N | Draw 1 hidden | Draw 1 decoys | Draw 2 hidden | Draw 2 decoys |
| --- | --- | --- | --- | --- |
| 0 | 223 → 223 | 223 → 223 | 223 → 223 | 223 → 223 |
| 1 | 221 → 224 | 226 → 230 | 224 → 227 | 227 → 231 |
| 2 | 228 → 229 | 236 → 234 | 233 → 233 | 242 → 237 |
| 4 | 235 → 259 (+27 −3) | 240 → 248 | 237 → 255 (+24 −6) | 241 → 248 |
| 8 | 252 → 272 (+22 −2) | 246 → 252 | 250 → 270 (+23 −3) | 255 → 253 |
| 12 | 282 → 290 | 265 → 264 | 279 → 289 | 262 → 267 |
| 16 | 314 → 314 | 272 → 272 | 306 → 308 | 281 → 281 |
| no cap | 314 → 314 | 273 → 273 | 307 → 308 | 281 → 282 |

Four shapes of the order at N 4 and 8 (hidden, draw 1 / draw 2; run before the shape was fixed, the last two with a
temporary switch that is not in the tree):

| Order | N 4 | N 8 |
| --- | --- | --- |
| the owner's three signs only (ahead, correspondents, last three days) | 231 / 234 (as filled: 235 / 237) | not run |
| constraint wording first, then arrival | 256 / 255 | 273 / 270 |
| constraint wording first, then the newer date | not read / 256 | 272 / 271 |
| constraint wording first, then the three signs, then the newer date (shipped) | 259 / 255 | 272 / 270 |

The gain is constraint wording first; the three signs are level with it and kept as its tie-break (they are what a
real mailbox would be expected to reward and the sim does not test: its planted items sit evenly through each
world's dates and senders). Decoys rise with the facts at N 4 (+8 and +7), as every reach lever's do (D331, D450).

### Live (Pi, Modal)

`.local/f2/go.sh` (the README's pi-ab fan-out with `--tenant-prompt --push payload --source-profile …/direct.json`,
Haiku 5.5 in every role, `--variant-config '{"order":{"cardsOrder":true}}'`, no `--cards`), at commit `b064e37f`
(the smoke at `5ab10a9d`): `cardsOrder` was still a trial there, so `eden` is the old order.

| Run | Seeds | Arms | Card calls | $ |
| --- | --- | --- | --- | --- |
| smoke (train1, `--limit 4`) | 41 | `eden`, `eden~order`, `--cards-calls 4` | 16 | 0.026 |
| main | 41–48, two shards at a time | `eden`, `eden~order`, `--cards-calls 4` | 768 | 2.840 |
| reference | 41 | `eden`, no cap | 183 | 0.321 |

Per seed (`packages/sim/lab/f2/order-arms.txt`), hidden raised of 192, as filled → ordered: 41: 94 → 98; 42: 86 → 106;
43: 91 → 116; 44: 94 → 109; 45: 96 → 109; 46: 87 → 105; 47: 90 → 109; 48: 84 → 108. Pooled, paired by task
(`cl8/pooled.py`, `order-pooled.txt`):

| | n | as filled | ordered | paired effect |
| --- | --- | --- | --- | --- |
| hidden raised (Haiku-graded) | 1,536 | 722 (47.0%) | 860 (56.0%) | **+9.0 points (+6.6..+11.4)** |
| seeds 41–44 | 768 | | | +8.3 (+4.8..+12.0) |
| seeds 45–48 | 768 | | | +9.6 (+6.2..+13.0) |
| control concerns (Haiku-graded) | 1,536 | 11 | 15 | +0.3 points (−0.4..+0.9) |
| agent $ per 1,000 task runs | | 0.261 | 0.274 | |

Card spend was the same in both arms by construction (four calls a user: $0.0011 a call). The rule (§0): effect ≥ +2.0
with the interval above zero and concerns not up by more than 1.0 point: **promote**. The concerns were not regraded
by Sonnet (the rule did not turn on them).

### What is in the default now

`cardsOrder: true` (part `cards`). `CardEnricher.drain` sorts what waits before each batch (`orderQueue`), and over
the queue's bound drops the last in that order instead of the oldest. Sorting 2,000 waiting items takes 3.3–3.8 ms
(three runs of 20, this box), once per card call.

**A tie rule came with it.** With the order promoted, `funnel-flags.test.ts`'s check that a sharded funnel writes the
same files as one process failed under load (2 of 3 runs with six busy cores; 0 of 3 with the order off). Cause:
items that say the same thing get the same requests and so the same intent score, and such ties fell in the order
the index was given them, which is the order the card model read them in. Read as they arrive that order is fixed;
read best first it depends on which pages had arrived when each batch was taken. Equal scores are now put in the
order their items were queued (`Queued.seq` → `IntentIndex.set`), reading 16 hits past the cut; the same test then
passed 4 of 4 under the same load. The rule itself moves one funnel task: the default reads **314/274** (the control
task `car-finance-outstanding/41` now surfaces; identical with `cardsOrder` on and off), draw 2 307/281 (control +1
−1). The live runs and the tables above were made before this rule; the N 4 and N 8 rows re-run on the final tree
read the same hidden counts (235 → 259, 237 → 255, 252 → 272, 250 → 270).

**Review (the `reviewer` subagent, on `e1e6f337`): one finding, fixed.** Past the queue's bound the first build
sorted the whole queue for every further item inside `enqueue`: a 4,000-item backfill took 8.3 s on the store path
against 0.13 s without the order (the reviewer's measurement). The bound is now applied once per `enqueue` (and at
twice the bound within one call), and each item's sender and addressees are read once: 4,000 items 102 ms against
74 ms with the order off, 8,000 items 275 ms against 232 ms (`.local/f2/enq.ts`, one run each, this box). A test
covers a backfill of twice the bound. The funnel at no cap and at `--cards-calls 4` is byte for byte the same after
the fix (314/274; 259/248).

Final tree: `bun run check` green, `bun run eval` precision 0.65, recall 0.52, falseFireRate 0 (the eval wires no card
maker), `bun run funnel --jobs 4` 314/274.

## 3. Decisions

- **D480** trial `intentPrune` (owner: the repo owner via F2; entered and ended 2026-11-10): rejected and deleted.
- **D481** finding: the intent requests that share least with their item carry the hidden facts; the index cannot be
  shrunk by a no-model score without losing them.
- **D482** trial `cardsOrder` (entered 2026-11-10), with the lab's `--cards-calls N`.
- **D483** `cardsOrder` promoted into `DEFAULT_CONFIG` the same day on the pre-registered rule; equal-score intent
  hits keep the order their items came in (funnel 314/274).
- **D484** (B) and the checker-scored half of (A) not run: no I1 checker; the distilled card arm of (C) not run: no
  endpoint.

## Next most valuable step

The live gap that is left is the uncapped one: with every card made in-run seed 41 read 60.4%, and M1 read 64.5% on
seeds 41–44 with replayed (topped-up) cards. A22 found a single pass of the card model leaves about a tenth of items
without requests (345 of 384 planted items covered; funnel 289/272 against 314/273). Sending the items a batch's reply
left out once more is the next lever on a new user's quality, and its cost is bounded by the items dropped.

## Reproduce

```bash
zcat packages/sim/lab/distilled/intent-v2-draw2.jsonl.gz > .local/f2/draw2.jsonl
bun run funnel --jobs 4 --json .local/f2/base.json; bun run funnel --jobs 4 --intent $PWD/.local/f2/draw2.jsonl --json .local/f2/base2.json
git checkout 5ab10a9d        # the tree with both trials
bun run funnel --jobs 4 --set '{"intentPrune":"share:0.25"}' --json .local/f2/share-0.25-d1.json   # and --intent draw2 → -d2
python3 -I packages/sim/lab/f2/table.py .local/f2 share-0.25 names top-3 far-3
bun run funnel --jobs 4 --set '{"cardsOrder":true}' --json OUT.json -- --cards-calls 4               # and without --set
python3 -I packages/sim/lab/a15/score.py FIFO.json OUT.json
# live (Modal; one fan-out of two seeds at a time):
EDEN_COMMIT=HEAD modal run packages/sim/modal/lab_fanout.py --kind pi-ab --suites train --seeds 41,42 --cap 1.1 \
  --run f2-main-41-42 --args "--conditions eden,eden~order --variant-config '{\"order\":{\"cardsOrder\":true}}' \
  --model claude-haiku-5-5 --grader claude-haiku-5-5 --card-model claude-haiku-5-5 --reader-model claude-haiku-5-5 \
  --tenant-prompt --push payload --source-profile packages/sim/lab/before-after/market-profiles/direct.json \
  --variants hidden,control --cards-calls 4"
python3 -I packages/sim/lab/cl8/pooled.py 'eden~order' eden .local/modal/f2-main-*/s*/out
python3 -I packages/sim/lab/f2/arms.py .local/modal/f2-main-*/s*/out
```

On the final tree `eden` is the ordered arm; the old order is `--variant-config '{"fifo":{"cardsOrder":false}}'`.

## Caveats

- Train only. The live effect is at one cap (four calls of about sixteen); the $0 curve says it peaks between 4 and 8
  calls and is nil at 0–2 and once all cards are in.
- A call cap stands in for time: in production the calls keep running while the user works, so a user's first minutes
  look like N 4 and later ones like no cap. Requests were not interleaved with card calls in real time.
- The reference (no cap) is one seed in another process: a level, not a paired effect.
- Haiku-graded throughout; M4 (D456) found Sonnet moved Haiku's hidden verdicts both ways about equally.
- The sim's planted items are 78% constraint-worded by the prefilter's test; a real user's decisive items may be less
  so, and then the order helps less. The three signs under it are untested by this sim.
- (A)'s bar was written down after its first screen was read (no paid run depended on it).
