# M3: a retriever trained on Eden's own question

Status: 2026-11-11, branch `claude/m3-retriever`, session M3. Decisions D900–D909. Train suites only; held-out 17–19
are not run or read. Anthropic: $0 so far (cap $30, ledger `.local/m3/ledger.jsonl`). Modal: Volume
`eden-retriever`, cap $300. Numbers marked **[EST]** are arithmetic or judgement; every other number comes from a
command in this note.

## 0. Why

Over 32 users' days the fact a hidden request needs is not in that day's transcript in 134 of 433 tasks (D712), and
at $0 the misses are mostly facts outside the push's 15-item pool (o3-pointer.md §3.2, o3-pool-recall.md). Lexical
levers are spent (D713, D715, D266, D330), and general-purpose embeddings bring in decoys as fast as facts (D450,
D451). The bet: a small retriever trained for exactly "which held item bears on this request?", with the hard
negatives Eden meets over days (the fact's all-clear twin, other templates' facts and decoys in the same world,
lexical look-alikes), run at ingest or on CPU in the request path.

## 1. Pre-registration (committed before any trained model's result was read)

**Baseline, measured at $0** (`days-calls.ts --pool-diag` with the dump's new `pool` and `planted` fields, users
w41–w72, 8 days, no cards, so no intent requests; `m3r/daysstat.py`): the planted item is at the push pool's rank
< 5 for 250 of 433 hidden requests, < 15 for 285, and in the lexical top 50 for 291. On w41–w44 with the checked-in
cards and intent requests (full coverage, D714): 38 and 43 of 46.

**Two consequences, fixed before any training:**

- With an intent index the pool already holds about 86–93% of facts (O3: 16 of 113 outside on w45–w52 at shipped
  coverage), so +15 points at @15 is out of reach there by arithmetic. The bar is therefore read against the
  **no-model lexical path** (no intent requests): the items the shipped pipeline never cards (about 86% of a user's,
  D714) are ranked by it alone, and a learned ingest-time expansion is a $0 stand-in for Haiku's requests.
- A reranker over the lexical top 50 alone can add at most 6 of 433 at @15 (291 against 285): ruled out by its
  ceiling. The reranker family is scored over the lexical pool joined with a learned first stage.

**Data.** Training: `m3-export.ts` worlds, seeds 100–399, every template of the named suites with its fact and its
decoy twin in one world (simulated). Eval (`m3r/prep.py`): the days users w41–w72 (requests, corpus, lexical pools
at 15 and 50) and the short worlds of train1–6 seeds 41–44 (the funnel's corpus and pools). **Held-out families:
suites train5 and train6**: no model is trained on them; models train on train1–4 (and M2's worlds when they come).

**The rule (stop or go).** Over the held-out families' days requests (157 hidden, 148 control):

- **Go** only if one family's best variant (the model's own ranking, or its hybrid with the lexical pool: RRF c 60,
  the model's top k for k in {5, 10, 15}, first 15 kept) raises hidden recall@15 by **at least +15 points** over the
  lexical pool (113 of 157 → at least 137), **and** decoys at @15 rise by no larger ratio than hidden facts
  (decoys_after / decoys_before ≤ hidden_after / hidden_before).
- Because three k and several variants are tried, a pass at one setting with its neighbours far below is reported as
  fragile, and a go is confirmed on the second fold (train on train3–6, held-out train1–2) before any wiring.
- Otherwise **stop**: no engine trial; the note says what each family reached.

Reported beside the bar, not part of it: recall@5, the short worlds, the trained-on templates, ms a request and
memory a user at 3,000 items on one CPU core, and ingest cost an item. On a go: the funnel on train (hidden facts and
decoys against main's 315/276) and `days-calls` against D712's misses, then a pre-registered Pi pair (short and
days) behind a trial switch.

### 1b. Amendment (the parent's review, committed before any result against these bars was read)

The parent approved §1 with changes, which replace §1's single bar:

- **Two primary bars; either passes**, on the held-out families' (train5–6) days requests:
  1. **@15 against the no-intent lexical path:** hidden recall@15 at least +15 points (§1's bar, its decoy clause
     included: decoys at @15 rise by no larger ratio than facts).
  2. **@5 against the shipped default:** hidden recall@5 at least +10 points over the pool of the shipped pipeline
     (lexical plus the intent requests its own card calls write, the shipped coverage: `days-calls.ts --cards-live
     claude-haiku-5-5 --intent none`, cards recorded; not the full replay), with the same decoy clause at @5.
- **Promotion needs a gain over the shipped default on Pi**, not only over the lexical path. A second route is the
  $0 stand-in: if a model matches shipped intent's recall at $0 a request, it can replace or cut intent calls, and
  the saving is reported explicitly.
- The held-out split stays by family (train5–6, second fold train1–2). Results are also reported on M2's synthetic
  held-out families when its data lands.
- The reranker over the lexical top 50 alone is dropped (its ceiling, §1).

## 2. The pipeline

- `packages/sim/src/lab/m3-export.ts`: the training worlds.
- `days-calls.ts --pool-diag` rows carry `planted`, `request`, `template` and `pool` (ids); `--corpus-dump` writes
  each user's items as the cache holds them.
- `packages/sim/lab/m3r/`: `prep.py` (the eval file), `score.py` (recall of lexical, model and hybrid by fold),
  `poolstat.py`, `daysstat.py`.
- `packages/sim/modal/m3_retriever.py`: training (`dense`, `sparse`) on a Modal GPU, data on the Volume
  `eden-retriever`, each eval request's top 100 ids back to `.local/m3/runs/<run>/`.

Zero-shot (no training), held-out days hidden @15: lexical 113; bge-small-en-v1.5 alone 78, hybrid 117–118;
opensearch-neural-sparse-encoding-doc-v2-mini (inference-free) alone 103, hybrid 115–116. Decoys @15 (control):
lexical 85; dense hybrid 87, sparse hybrid 93–95.

## 3. Results on fold A (train on train1–4, held out train5–6), as they land

Held-out days requests: 157 hidden, 148 control. Lexical pool: facts @15 113, @5 102; decoys @15 85. The bar: facts
@15 ≥ 137 and decoys' ratio ≤ facts' ratio (`m3r/score.py --brief`, "BAR" lines). Each run: 300 export worlds,
train1–4 tasks (38,400 examples, 4 hard negatives each), one epoch unless said, on a Modal A10.

| run | family, base | variant | facts @15 | decoys @15 | facts @5 | bar |
|---|---|---|---|---|---|---|
| dense-zs | dense, bge-small-en-v1.5, untrained | hybrid k 15 | 118 | 87 | 104 | fail |
| sparse-zs | sparse, opensearch doc-v2-mini, untrained | model alone | 103 | 87 | 95 | fail |
| dense-a1 | dense, bge-small-en-v1.5 | hybrid k 10 / 15 | 137 / 138 | 104 / 104 | 123 / 124 | fail (decoy ratio 1.224 against 1.212 / 1.221) |
| dense-a2 | the same, 0.3 epoch | hybrid k 15 | 136 | 104 | 121 | fail |
| dense-a3 | dense, all-MiniLM-L6-v2 | hybrid k 15 | 132 | 112 | 118 | fail |
| sparse-a1 | sparse (inference-free), FLOPS 0.001 | model alone | 129 | 97 | 103 | fail (+10.2 points; decoy ratio 1.141 against 1.142) |
| asym-a1 | dense items, token-table query (lr 5e-5) | hybrid k 15 | 123 | 90 | 108 | fail |
| rerank-a1 | cross-encoder MiniLM-L2 over lexical 50 ∪ dense-a1's 15 | hybrid k 10 / 15 | 138 / 138 | 99 / 98 | 113 / 107 | **pass** (k 5: 134, 97: fail; fragile) |

| dense-a4 | dense, bge-base-en-v1.5 | hybrid k 5 / 10 / 15 | 137 / 137 / 137 | 106 / 109 / 108 | 128 / 126 / 124 | fail |
| asym-a2 | dense items, token-table query (table lr 2e-3, 2 epochs) | hybrid k 10 / 15 | 137 / 138 | 100 / 100 | 125 / 124 | **pass** (k 5: 127, 98: fail; fragile) |

**Fold B** (trained on train3–6, held out train1–2: 118 hidden, 146 control; a lower lexical start, facts @15 76, decoys 107):

| run | variant | facts @15 | decoys @15 | facts @5 (lexical 68) | bar |
|---|---|---|---|---|---|
| dense-b1 (bge-small) | model alone / hybrid k 15 | 104 / 110 | 127 / 132 | 100 / 100 | pass (every variant) |
| sparse-b1 (inference-free) | model alone / hybrid k 15 | 101 / 104 | 109 / 117 | 89 / 88 | pass (every variant; decoys nearly flat alone) |

On the trained-on templates every trained model reaches 276 of 276 facts: they learn the templates, and only the
held-out rows say anything.

**CPU, one thread, ONNX dynamic int8** (`m3r/cpu_bench.py`, this container's 4-core CPU): dense-a1 (bge-small)
query 7.1 ms, scoring 3,000 int8 vectors 1.1 ms (numpy), item encoding at ingest 23 ms (256 tokens), 1.15 MB a
user at 3,000 items; fp32 19 ms and 58 ms. rerank-a1 (MiniLM-L2): **652 ms a request** for 60 pairs (fp32 1.19 s):
two orders of magnitude over the request path's few milliseconds.

**The @5 bar against the shipped default (§1b).** The shipped pipeline's own coverage, made live and recorded
(`days-calls.ts --cards-live claude-haiku-5-5 --intent none`, users w41–w72 in four processes; cards in
`.local/m3/d/cards-ship-*.jsonl`): over all 433 hidden requests the planted item is in the pool's first 5 for 319
and its 15 for 362 (decoys 296 and 326); pushed at its own request 204, handed earlier that day 141. On the held-out
families' days requests: facts @5 123 of 157, decoys @5 83 of 148. Each model fused with the shipped pool (the
hybrid's lexical list is the shipped pool here):

| run | best variant at @5 | facts @5 | decoys @5 | bar (+10 points, decoys no faster) |
|---|---|---|---|---|
| dense-a1 | hybrid k 15 | 135 (+7.6) | 92 | fail |
| dense-a4 | hybrid k 5 | 136 (+8.3) | 98 | fail |
| sparse-a1 | hybrid k 15 | 132 (+5.7) | 91 | fail |
| asym-a2 | hybrid k 10 | 137 (+8.9) | 81 | fail (decoys down 2) |
| rerank-a1 | hybrid k 5 | 131 (+5.1) | 89 | fail |
