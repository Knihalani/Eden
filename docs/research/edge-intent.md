# The intent index: synthetic requests per item, matched with no model (track "intent")

Status: experiment behind `intent` (off by default; needs `cards`). Proposed decision D87. Every number below comes
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
  are 0.35, 2 terms and weight 1 (6 hits); D159 (below) measured 0.2, 1 term and 12 hits and left the default alone.
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

## The shipped baseline and the looser-threshold arm (D158, D159; 2026-11-06)

Intent has been on in `DEFAULT_CONFIG` since D125, but `bun run funnel` replayed only the cards, so every $0 screen,
the checked-in reader cache and the audit's "unranked quarter" (O7) measured the default with intent inert. Since D158
the funnel unpacks and replays `packages/sim/lab/distilled/intent-v2.jsonl.gz` by default whenever it covers the run
(train1–6 seeds 41–44, held-out 10–11 seeds 41–42), prints `intent: live|inert (why)` under the score header, and
`--intent none` gives the old shape. The numbers below are train1–6, seeds 41–42, `bun run funnel --jobs 4 --
--packet-k 15,30,60`, run in this package's session unless marked.

| Run | Stub TOTAL (hidden/decoys of 384) | Reader pool | Top-60 hidden / decoys |
|---|---|---|---|
| `--intent none` (the pre-D158 screen) | 214/211 | 230/229 | 292/299 (audit's run) |
| Intent replayed, thresholds 0.35/2/6 (the default) | 243/228 | 257/240 | 320/307 |
| Intent replayed, thresholds 0.2/1/12 (D159's arm, not shipped) | 258/243 | 270/246 | 330/317 |

Hidden items outside the ask's top 60 fall from 92 (inert, audit's run) to 64 (intent at the default thresholds) to
54 (D159's arm). No-model deliveries do not move with the thresholds (stub JSON totals: hidden delivered 98, decoys
delivered 72, both arms): an intent hit, one-term or not, is a reader-pool candidate only, which `intent.test.ts` pins on the
core configuration (a one-term hit enters the ask's reader pool at 0.2/1/12 and not at 0.35/2/6, is never pushed, and
never reaches another user or tenant).

**Paid reading.** The paid Haiku pairs on train (three independent pairs, fresh cache per arm, from the audit's
finder and verifiers, not re-run here) went 277/135 → 296/132, 274/136 → 295/132 and 277/133 → 294/134 at equal
reader calls (653 vs 655 in the finder's pair). The checked-in reader cache is of the shipped default (0.35/2/6,
intent replayed; ledger run `ib-reader-intent-cache-default`, 652 calls, $0.18548): hidden 274/384, decoys 137/384,
and it replays at $0 as 273/137 with 5 misses in 11.2 s (docs/LAB.md recipe 2a). An earlier recording at 0.2/1/12
(ledger run `ib-reader-intent-cache`, 654 calls, $0.18646, 295/135) was replaced when the thresholds stayed.

**Pi, held-out 13 (previously read, not blind).** `pi-ab.ts --suite heldout13 --variants hidden,control
--time-scale 1 --config default --conditions eden,eden~loose --variant-config` with `loose` =
`{"intentMinCoverage":0.2,"intentMinMatched":1,"intentHits":12}`, Haiku 5.5 for agent, cards, reader and grader,
cards-v2 replayed and no `--intent` file, so only items carded live had intent requests (shared by both arms),
`--source-profile packages/sim/lab/before-after/market-profiles/direct.json`, `--budget 0.6`, seeds 41 and 42 in two
processes, ledger runs `ib-pi-loose-41` and `ib-pi-loose-42` ($0.1331 + $0.1339 = $0.2670):

| Condition | Hidden raised (of 64) | False concerns (of 64) | Eden $/1k, hidden / control | Agent + Eden $/1k, hidden |
|---|---|---|---|---|
| eden (0.35/2/6) | 48 (seed 41: 24/32, 42: 24/32) | 1 | 0.374 / 0.513 | 0.645 |
| eden~loose (0.2/1/12) | 50 (26/32, 24/32) | 0 | 0.391 / 0.525 | 0.716 |

Paired, bootstrap 95% over tasks: hidden +0.031 (−0.063..+0.125), false concerns −0.016 (−0.047..0), wall +0.04 s
on hidden tasks. The hidden tasks' $/1k rose +0.070 (+0.008..+0.129), mostly the agent's longer inputs (1,326 → 1,409
input tokens per hidden task) as it read the extra packets; Eden's own per-task calls rose 0.017 $/1k. Over all 128
tasks per arm (recomputed from the two result JSONs), agent plus Eden went 0.759 → 0.798 $/1k (+5.1%) and Eden alone
0.444 → 0.458 (+3.2%).

The pair is weak evidence for the thresholds: with cards-v2 replayed and no intent file, only the items carded live
in the run had intent requests (486 and 514 new card lines for seeds 41 and 42, against 4,634 replayed cards-v2 lines
that had none), so most held-out 13 items had no intent hits in either arm and the pair is underpowered.

**Outcome: the default stays at 0.35/2/6.** Hidden was neutral (the CI spans zero), not better, and the paid cost
rose with a CI that excludes zero. D112 promotes only "measured better or neutral at no extra paid cost", which D159
cites, and Bar 5 (Eden's cost per task) would move the wrong way. The train reader pairs (hidden about +5 points at
equal reader calls) are the case for promoting anyway; that needs its own decision accepting the Pi cost rise and a
docs/COST-MODEL.md line, or a better-powered Pi pair with the intent file replayed.

`bun run eval` is unchanged (precision 0.8276, recall 0.48, falseFireRate 0): the eval wires no card maker, so intent
is inert there.

The wider 40/0/1 arm waits for the action-request gate trial (D168). The intent-on reader cache goes stale whenever
the intent file, the thresholds or anything upstream of the reader changes.

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
