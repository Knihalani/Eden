# Request-side query expansion for the ask (audit 2026-11-06 F10, D189)

**Result: rejected.** A no-model expansion of the ask's request (pseudo-relevance feedback over the user's own index,
trial `askExpand`) added 130 items to 62 reader pools on train and none of them was a planted hidden fact or a decoy.
The switch, `expand.ts`, `ItemCache.docFreq` and their tests are deleted (D112); the trial is commit 8fd2884 on branch
`claude/p3-f10-query-expansion` for anyone who wants to re-run it.

## The gap it targeted

Train1–6, seeds 41–42, the shipped default with cards and intent replayed (D158) and D159's thresholds, intent
file covering every planted item (`intent: planted items with an intent replay line: hidden 384/384, decoys
384/384`). Commands, run on 2026-11-06:

```bash
gunzip -c packages/sim/lab/distilled/reader-haiku-train-4142-intent.jsonl.gz > .local/reader-haiku-train-4142-intent.jsonl
bun run funnel --jobs 4 --allow-misses --json .local/base.json -- --reader replay \
  --reader-model claude-haiku-5-5 --reader-cache .local/reader-haiku-train-4142-intent.jsonl
bun run funnel --jobs 1 --allow-misses -- --reader replay --reader-model claude-haiku-5-5 \
  --reader-cache .local/reader-haiku-train-4142-intent.jsonl --ask-diag .local/diag-base.jsonl
```

- Replayed paid reader (Haiku 5.5, 647 replayed, 2 missed): TOTAL hidden 281/384, decoys 139/384; reader pool hidden
  262/384, decoys 246/384 (LAB.md recipe 2a's figures, reproduced).
- `--ask-diag`: hidden rank -1 58/384 = no intent requests 3, requests but no match 55 (no shared term 10, under the
  thresholds 45, past the cut 0, over 0), not in replay 0; decoys rank -1 71/384 = not sent with the prefilter
  rejecting 4, no match 67 (25, 41, past the cut 1, 0).

## Why the user's own items cannot bridge it

A probe outside the engine (each of the 58 tasks' whole world put in one `ItemCache`, the request's content terms
searched as `rank` does; a scratch script not kept in the repo, so these figures are reproducible only by rewriting
it from this description) read the request against the planted item and the user's
vocabulary:

- 31 of the 58 planted hidden items share no content word with the request (decoys: 40 of 71).
- The request's distinctive words are mostly not in the user's index at all: "contents", "quote", "Harbourside"
  (contents-cover-switched); "Skyline", "broadband" (broadband-already-switched); "flights", "Toronto"
  (travel-needs-preapproval); "car", "transfer" (car-finance-outstanding); "ParentPay", "DPD", "Pipewell". The
  words left are generic ("renewal", "insurance", "year"), so the request's best matches are other topics (for the
  contents insurance request: the Globex, Hooli and Vandelay renewal pricing threads) and their shared words lead
  further away.
- Graph aliases need a node to start from; a name no item holds is no node, and the default's graph walk is already
  in the ask (`askVerdicts`), so these 58 are unranked with it.

Reached in that probe (planted item newly in the expansion's finds; decoys from the control worlds):

| Expansion | Hidden of 58 | Decoys of 71 |
|---|---|---|
| PRF, shipped trial settings (5 feedback items, 6 words in at least 2 of them, at most 5% of items, 4 finds of 2+ words) | 3 | 4 |
| PRF, 10 feedback items | 3 | 3 |
| PRF, 10 feedback items, 10% share | 3 | 3 |
| PRF, 3 feedback items, words in 1 of them | 0 | 5 |
| PRF, 10 words, finds of 1+ word | 4 | 6 |
| PRF, 20 feedback items, 12 words, 10% share, 8 finds | 2 | 4 |
| Generic action-verb synonyms added to the request's own search (book → reserve, submit → send, accept → confirm, ...) | 5 | 4 |

Every arm reaches about as many decoys as hidden facts, at a few percent of the gap: the request words that would
tell the planted fact from its decoy are the ones the user's items do not hold, so no expansion drawn from those
items can separate them. Only general knowledge (a model, or the intent requests the card model already writes per
item, D87) can say that "contents insurance" is about "belongings" under "home cover".

## The trial, measured ($0)

Trial settings as in the first row above; the finds join the reader's pool after every candidate, only into seats
the pool leaves empty (so `readsAll` and every candidate's seat are unchanged), never a no-model delivery.

```bash
bun run funnel --jobs 4 --json .local/stub-base.json
bun run funnel --jobs 4 --set '{"askExpand":true}' --baseline .local/stub-base.json --json .local/stub-exp.json
```

- Stub reader: TOTAL 259/235 in both arms; reader pool hidden 262/384 and decoys 246/384 in both; task by task, 0
  hidden and 0 decoys gained or lost in the pool. 62 tasks' pools grew, by 130 items in all: mean pool 12.3 to 12.5
  items, mean prompt 7,519 to 7,574 characters over the same 653 reader calls.
- Replayed paid reader with the switch on: 706 reader calls against the default's 649, 120 of them prompts the cache
  did not hold (answered fail-open); pool 262/246 unchanged. The extra calls come with the misses (a missed reading is
  a failure, not a cached verdict, so a later ask of the same request calls again: an inference from the reader's
  `failures` counts, 120 here and 2 in the default; both stub arms made 653). The surfaced totals of that run (284/148) mix reader and no-reader answers and are not a reading.
- `bun run eval` (no reader), and `bun run eval --reader stub` with and without `--config '{"askExpand":true}'`:
  precision 0.8276, recall 0.48, falseFireRate 0, ask recall 1 in all three.
- `--ask-diag` is identical by construction: the finds sit outside the ask's ranked candidates.

**How much the empty-seat rule left reachable.** In the default stub run, 122 hidden tasks have no planted item in
the reader's pool: 62 had no reading (outcome `skipped`, pool 0), 57 a full pool of 15 (53 read, 4 gated) and only 3
had a free seat (14 items). So "0 gained" in the pool is largely what the empty-seat rule allows, not the expansion's
own reach. The probe above is the evidence that the expansion has none to give, and the reviewer of this change ran a
variant that lets the finds take seats (inserted after the first 10 of the ask's order, no room limit; their run on
commit 8fd2884 with that edit, not re-run here): reader pool hidden 262 to 258 (+2, -6) and decoys 246 to 238, so
displacing candidates loses more planted facts than it finds.

No paid call was made. With no planted item added to any pool, the reader cannot flag one, so the paid train top-up
(about 120 calls) and the blind held-out 13 Pi pair would have measured reader noise and spent the blind suite on an
arm that had already failed the train screen; the only paid effect left is the larger prompt (+0.7% characters).

## What would move this gap

The 45 "under thresholds" rows are the request-to-item bridge that exists (the model's intent requests); D159
loosened it once. The 10 "no shared term" rows and the PRF result above say the rest needs words the user's items do
not hold, which is a model's job at write time (cards, intent) or at ask time (D89's model-written `bridgeQuery`,
deleted by D112, which F10's verifier put at about 1.07–1.15x fewer misses).
