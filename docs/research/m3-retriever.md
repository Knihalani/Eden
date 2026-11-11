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
