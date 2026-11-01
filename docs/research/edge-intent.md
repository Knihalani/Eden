# The intent index: synthetic requests per item, matched with no model (track "intent")

Status: experiment behind `intent` (off by default; needs `cards`). Proposed decision D86. Every number below comes
from a command run in this session, on dev6a and dev6b, seed 41, no model at request time (`hidden-funnel.ts --ask`).
Held-out 5–12 were not run or read. The old in-sample suites were not run: requests exist only for the dev worlds.

## Why

Facts found are lost on reach, not use (docs/research/path-to-90.md): 89 of 122 dev misses are never candidates,
because the request and the decisive item share no word. Offline, doc2query (a model writes, per item, the requests
it would change) raised the decisive item's top-5 recall from 47% to 60%, 68% counting either list. This track builds
it into the engine.

## What was built

- **One call, two outputs** (`cards.ts`). With `intent`, the background card call also asks, per item, for up to four
  requests in the user's words ("requests this item would change"; [] for none). Items the card prefilter rejects
  are now read too, for their requests only: their card stays none whatever the model writes, so cards are unchanged.
  The output is validated (`parseRequests`, `cleanRequests`): strings only, at most four, 120 characters each,
  redacted with `sanitizeForStore`, first entry per item wins. A card that shares no word with its item (crossed
  batch indexes) drops the requests written beside it. Item text stays fenced as data (`inert`).
- **A second index per user** (`intent.ts`, `IntentIndex`). One BM25 index over the requests, apart from the item
  cache's index, with its own vocabulary and a light suffix stemmer ("approve", "approved", "approving" meet). It is
  keyed by the item's content hash, as cards are: held exactly as long as the card (dropped with the item, its source,
  the user, or after the card's time to live), rebuilt from live docs when its vocabulary outgrows them. Only
  requests made before a request arrived count.
- **Request time, no model** (`partner.ts`). The request's own text is searched; hits need two request terms and
  0.35 of their idf (`intentMinMatched`, `intentMinCoverage`), at most six (`intentHits`).
  - Lookup: intent hits join the ranked candidates (their lexical score is unchanged), are eligible for the judge,
    take `intentSeats` (1) seat of their own when a model judges, and count as tied for `judgeTied`.
  - Ask: verdict hits keep the lead; the rest of the pool and the intent hits are fused by reciprocal rank
    (k = 2, `intentWeight` 1).
  - Precision rule: an intent hit is a candidate, never a no-model delivery on its own. The rule paths still read its
    words and its card, so it is pushed only where `conflict.ts` or a violated card binds it.
- **Lab.** `cards-enrich.ts --intent` writes `{h, r, c, p}` lines to `intent-v<N>.jsonl` for every item. With
  `--model <id>:free --allow-logging`, a free OpenRouter model runs through the lab's shared access (`free.ts`,
  edge-freelab.md; edge-combined.md replaced this track's own `free-model.ts` with it): logging endpoints for the lab
  only, since the worlds are generated, every request paced (`--rpm`) and capped (`--max-requests`). The production
  client and its D12 defaults are unchanged.
  `hidden-funnel.ts --intent FILE` replays the requests while cards still come from `--cards`, so the comparison
  isolates the index.

## Results (funnel, dev6a + dev6b, seed 41, `--ask`, 60 hidden and 60 control tasks)

Cards replayed from `packages/sim/lab/cards/cards-v2.jsonl` in every row.

| Configuration | Hidden delivered | Hidden ask-cited | Hidden either | Decoys delivered | Decoys ask-cited | Decoys either | Ask bytes (hidden) |
|---|---|---|---|---|---|---|---|
| ALL3 | 23 | 30 | 30 | 3 | 22 | 22 | 631 |
| ALL3 + intent, free model, prompt v1 | 23 | 31 | 31 | 3 | 23 | 23 | 672 |
| ALL3 + intent, glm doc2query requests | 23 | **38** | **38** | 3 | 27 | 27 | 699 |

- The free run: nvidia/nemotron-3.5-super-vl:free, 214 calls (38 of them retries of batches cut off at the output
  cap), 1,454 of 1,594 items read, $0. Prompt v1 gave requests for only 91 items (6%). The model reads "[] for an
  item that would change nothing" next to the card's "none" and leaves almost everything empty. So this row measures
  the prompt, not the index.
- The glm row replays the requests path-to-90 already bought: the same seed-41 worlds, a doc2query-only prompt,
  glm-5.3-flash, 1,093 item contents with requests, no new spend. It is the index's measure with good requests:
  hidden either +8/60 (50% → 63%), decoys ask-cited +5/60, nothing delivered changes.
- Prompt v2 (in the code now, `INTENT_VERSION` 2) says "kind none still gets requests; [] only for bulk mail". On the
  first 100 items by hash (90 read, 11 calls), it gave requests for 60 of 90 (67%). On the 80 items both versions
  read, v1 gave 5, v2 50, and the glm prompt 19. The free-request cap (250 for the track; 232 used) left no room to
  re-read all items with v2, so the funnel was not re-run with v2.
- The new hidden ask citations are items with lexical score 0: "Approve the £6,800 order for twelve laptops" finds the
  second-signature rule; "Sign the DocuSign for the Shoreditch office lease" and "Confirm the venue booking for Mum's
  70th" find their constraints. The new decoy citations are their near-miss twins: the requests describe the topic,
  not whether the constraint still holds. Telling the twins apart is the verdicts' job, not the index's.
- Grid on the glm requests: `intentHits` 4/6/10 makes no difference. Coverage 0.2/0.35/0.5 gives hidden 39–40/38/36
  against decoys 29–31/27/26. Weight 0.3/0.5/1/2 gives hidden 33/36/38/38 against decoys 24/26/27/27. The defaults
  are 0.35, 2 terms and weight 1.
- With every flag off, `bun run eval` equals main's in every field but latency (compared field by field).

## Verdict

The index works: with good requests it is the largest no-model reach gain measured on the dev suites (+13 points of
either). Its cost is +8 points of decoy citations in asks and +68 bytes per answer, with no change to pushed packets.
The free model with prompt v1 does not write enough requests to show it. Before a live A/B:

1. Re-read the dev worlds with prompt v2 on the default model (about 160 calls, about $0.004 at the measured per-item
   price), and re-run this table.
2. Pair it with a precision guard for intent-only ask seats, for example dropping one the conflict test clears or that
   `supersede` replaces.
3. Pre-register the blind live A/B (ALL3 vs ALL3 + intent) on a fresh held-out suite.

## Cost

See docs/COST-MODEL.md, "Intent index". No new call: the card call grows by about four short requests per item, and
every new item is read, not only the 11–15% the prefilter passes. That is about $0.035 per user-month at measured
per-item prices (estimate). Request time adds one BM25 search over at most four requests per held item.

## Reproduce

```
bun packages/sim/src/lab/cards-enrich.ts --dir DIR --funnel dev6a,dev6b --seeds 41 --intent \
  --model nvidia/nemotron-3.5-super-vl:free --allow-logging --max-requests 250 --concurrency 3
bun packages/sim/src/lab/hidden-funnel.ts --suite dev6a,dev6b --seeds 41 --ask --no-record \
  --cards packages/sim/lab/cards/cards-v2.jsonl --intent DIR/intent-v1.jsonl --config '<ALL3 + "intent": true>'
```
