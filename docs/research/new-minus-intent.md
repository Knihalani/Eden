# NEW and NEWL without the intent index

Status: 2026-11-03. Follow-up to the deep audit of 2026-11-03b, finding 6 (`cost-intent-in-new-background`): the
intent index (D87) in NEW sends about 16.9 times more items to the background model in about 6.1 times more calls.
Question: do NEW and NEWL keep their hidden-fact rate without it? Decision: D109. Every number below comes from a
command run in this session (Reproduce, below); the spend is from this run's spend ledger.

## Result

No. Dropping intent costs 8.6 points of hidden facts in NEW and 8.3 points in NEWL on train, against a bar of 2
points. Intent stays in both presets; no NEWX/NEWLX preset is added.

No-model funnel (`bun run funnel`, `--ask`, cards replayed), Eden's reader live on Claude Haiku 5.5, train1–6, seeds
41–42: 384 hidden and 384 control tasks. "Surfaced" is delivered or cited by the ask (the funnel score). "Decoys
flagged" counts control tasks whose planted decoy the reader flagged as bearing; "flagged blocks" is the subset it
flagged with kind `blocks`.

| Configuration | Hidden surfaced | Hidden delivered | Decoys surfaced | Decoys delivered | Decoys flagged | Flagged blocks | Hidden in reader pool | Reader calls | Reader $ (as made) |
|---|---|---|---|---|---|---|---|---|---|
| NEW | 290 (75.5%) | 253 | 152 | 91 | 21 | 5 | 262 | 707 | 0.2829 |
| NEW − intent | 257 (66.9%) | 236 | 150 | 92 | 22 | 4 | 242 | 707 | 0.2797 |
| NEWL | 283 (73.7%) | 246 | 146 | 88 | 20 | 4 | 251 | 657 | 0.1862 |
| NEWL − intent | 251 (65.4%) | 227 | 140 | 81 | 14 | 1 | 230 | 657 | 0.1867 |

- **Hidden.** NEW −33 tasks (−8.6 points): 37 lost, 4 gained, task by task. NEWL −32 (−8.3 points): 35 lost, 3
  gained. The loss shows in every one of the six suites (NEW per suite: 49/44/52/43/50/52 with intent,
  42/39/43/39/48/46 without).
- **Decoys.** Barely move: NEW −2, NEWL −6 surfaced. Intent's recall does not come with decoys here.
- **The reader.** The same number of reader calls with and without intent (707 and 657): intent changes what the
  reader is given (the planted item is in its pool 20–21 more times with intent), not how often it reads. Price per
  call is the same within 1% ($0.000400 vs $0.000396; $0.000283 vs $0.000284).
- **Earlier numbers.** haiku-phase3.md's NEWL train row (254 hidden delivered) and this run's NEWL (246 delivered)
  differ: a different tree (the audit-b base, with the reader's v7 prompt and later engine changes), freshly made
  intent requests, and `askReaderWaitMs` 60,000 here. Compare within this table only.

## Background cost (what intent sends)

From the same funnel runs' `cards use` counters (24 simulated users, train1–6 × 2 seeds; cards are replayed, so these
are what the engine would send, priced below at this session's measured enrichment price):

| | Card calls | Items sent | of which request-only (prefilter rejects, read for intent) | per user: calls / items |
|---|---|---|---|---|
| with intent (NEW, NEWL) | 1,832 | 35,700 | 33,587 | 76.3 / 1,487.5 |
| without intent | 300 | 2,113 | 0 | 12.5 / 88.0 |
| ratio | 6.1× | 16.9× | | |

Making the intent requests for every distinct train item cost $0.1806 for 3,541 items in 355 calls ($0.0000510 per
item, $0.000509 per call, 2,589 tokens in and 732 out per call). At that per-item price, intent's extra 1,399.5
items per user cost about $0.071 per user backfill (an estimate: per-item price times counted items; the card calls
without intent use a shorter prompt and are not priced here). That is what the 8.6 points cost.

## Decision rule and what it decided

Pre-set by the parent session: if dropping intent costs at most 2 points of hidden on train, add NEWX/NEWLX without
intent, recommend them and plan a blind check; otherwise keep intent and record why. It cost 8.6 and 8.3 points, so
intent stays (D109). No blind check is spent: the train result is far outside the bar, and a held-out run cannot turn
an 8-point loss into a 2-point one without tuning on what it reads.

Cheaper ways to keep intent's recall stay open and unmeasured: intent requests only for items a user's sources
actually hold over time (batching or the batch endpoint, audit finding 6 Stage 3, which waits on D98's provider
decision), or a cheaper model for the request-only items. The audit's Stage 2 (intent only on items the
prefilter passes) was skipped here as "in effect intent off"; that guess was wrong.

**Correction, 2026-11-06 (D170, trial `intentConstraintOnly`).** The arm was run on the shipped default (with
`cardsLean`), train1–6 seeds 41–42, intent requests replayed. At $0 (stub reader): items sent to the card model 13,604
to 2,113 and calls 822 to 300, the same cost as intent off, yet the reader's pool keeps all of intent's gain: hidden
257 to 257 and decoys 240 to 235 (intent off: 230/229). A fresh-cache paid pair (reader live on Claude Haiku 5.5,
empty reader cache per arm; ledger runs `r2-intent-co-base`, 653 calls, $0.1874, and `r2-intent-co-on`, 656 calls,
$0.1894): hidden surfaced 275 to 281, paired +1.56 points (95% CI −1.41..+4.54); decoys 136 to 139, +0.78 points
(CI −1.87..+3.44). Intent's gain comes from the requests of constraint-worded items; the request-only reads bought
nothing measurable here. The lab's planted facts are constraint-worded by design, so these screens cannot see an
unworded item that bears on a request only through its requests; `cards.test.ts` shows the switch misses such an item.

**Result, 2026-11-06 (D177: the trial ended, the switch deleted).** The pre-registered gate was a fresh-cache paid pair
with hidden not lower and decoys not higher beyond ±3 tasks. Run again on the merged tree (4503fabb6, train1–6 seeds
41–42, Claude Haiku 5.5 reader live in both arms, empty reader cache per arm): default 286/140 against
`intentConstraintOnly` 281/144, paired hidden −1.30 points (95% CI −4.17..+1.56), decoys +1.04 points (CI
−1.82..+3.91); ledger runs `close-d170-fresh-base` (652 calls, $0.1864) and `close-d170-fresh-co` (654 calls, $0.1866).
A top-up of the committed reader cache (`close-d170-co`, 269 calls, $0.0786) replayed 281/139 against 279/144. Hidden
flagged by the reader fell in both pairs (238 to 228, 234 to 226), and the reader pool at $0 went 262/246 to 258/241.
Decoys rose 4 and 5 tasks, beyond ±3, and hidden fell: the request-only reads do buy something after all (the earlier
pair's +1.56 was noise), so the switch, its stat and its tests are deleted under D112. `cardsLean`, `cardsLeanDays`,
`readForIntent` and `automated` stay (they were to go only on promotion). The scores are the planning run's; the
ledger rows were re-summed when the switch was deleted.

## Spend

$0.8299 of a $1 cap, all Claude Haiku 5.5 through the lab's Anthropic provider (D97), one spend ledger:

| Step | Calls | $ |
|---|---|---|
| Intent requests, train items (`cards-enrich.ts --intent`) | 355 | 0.1806 |
| NEWL, reader live | 656 | 0.1860 |
| NEWL − intent (401 of 657 reads replayed from NEWL's identical prompts) | 256 | 0.0725 |
| NEW, reader live | 704 | 0.2821 |
| NEW − intent (430 of 707 replayed) | 277 | 0.1087 |

A replayed read is the cached reply to a byte-identical prompt (`reader-disk.ts` keys on the whole prompt and the
model), made earlier in this session; reruns of all four rows from the cache cost $0. The intent file and the reader
cache are under `.local/` and not checked in (large, simulated data only).

## Reproduce

```bash
H=.local/nmi; L="--spend-ledger $H/ledger.jsonl --spend-cap 1 --spend-headroom 0.03"
bun packages/sim/src/lab/cards-enrich.ts --dir $H/intent --funnel train --seeds 41,42 --intent \
  --model claude-haiku-5-5 --concurrency 6 $L
R="--intent $H/intent/intent-v2.jsonl --reader live --reader-model claude-haiku-5-5 --reader-cache $H/reader-cache.jsonl"
bun run funnel --preset NEWL --set '{"askReaderWaitMs":60000}' --json $H/newl.json -- $R $L --run-label newl
bun run funnel --preset NEWL --set '{"askReaderWaitMs":60000,"intent":false}' --json $H/newl-x.json -- $R $L \
  --run-label newl-x
bun run funnel --preset NEW --set '{"askReaderWaitMs":60000}' --json $H/new.json -- $R $L --run-label new
bun run funnel --preset NEW --set '{"askReaderWaitMs":60000,"intent":false}' --json $H/new-x.json -- $R $L \
  --run-label new-x
python3 -I packages/sim/lab/scripts/reader-score.py $H/new-x.json $H/new.json
```

The NEWL run took 7 min 38 s (reader live forces one process); the others took about as long.
