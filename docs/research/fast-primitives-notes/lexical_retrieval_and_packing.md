# Fast top-k lexical retrieval and budgeted context packing for an in-memory, per-user index (Bun/TypeScript)

Note on local measurements: the numbers labelled "local benchmark" were measured in this research session with
Bun 1.4.4 on a 4-vCPU Intel Xeon @ 2.10 GHz container, using synthetic data (Zipf(1.0) vocabulary of 50k terms, docs of
10-70 tokens, avg 39.5 tokens). Scripts: `bench.ts` and `bench2.ts` in the session scratchpad
(`/tmp/claude-0/-home-user-Eden/934a81f4-56d6-5053-a3cb-bb5257f049bb/scratchpad/`); they are not checked in (a `.ts`
file under `research_notes/` would be picked up by `scripts/format.sh`). They measure speed only, not relevance.
Repeated runs varied by roughly 1.5x (e.g. the stopword-heavy dense case came in at 1124 us once and 740 us once).

## Inverted index layout, scoring strategy and accumulators in V8/JavaScriptCore; what makes JS search libraries fast

### Takeaway
At 1k-100k short docs, the simplest fast design wins: intern terms to integer ids, keep each term's postings as
parallel typed arrays (docIds `Uint32Array`, tf `Uint16Array`/`Uint8Array`), score term-at-a-time (TAAT) into a
dense `Float32Array` accumulator sized to the doc count plus a "touched" list, and select top-k with a small
insertion buffer or heap. In the local benchmark that ran 3-15-term queries in 27-112 us at 100k docs, against
200-865 us for a `Map` accumulator. The time goes on the number of postings scanned, so stopword-heavy queries are the
real risk. No compression is needed at this scale. The published JS library benchmarks are self-reported, and the
fastest library (FlexSearch) gets its speed by not doing BM25.

### Cited Findings
- Local benchmark (TAAT BM25, k=10, 500 queries per row, terms with Zipf rank below 50 excluded unless stated).
  At **100k docs**:
  - 3 terms (about 2.9k postings): dense Float32Array + touched list **26.7-28.0 us**; Map + full sort 808-1349 us;
    Map + insertion top-k 200.9 us.
  - 8 terms (about 7.4k postings): dense **45.4-55.8 us**; Map + insertion top-k 499.5 us.
  - 15 terms (about 14.7k postings): dense **97.1-111.5 us**; Map + insertion top-k 865 us.
  - 8 terms *with* stopword-like terms (about 162k postings): dense **740-1124 us**; Map + insertion top-k 7874 us.

  At **10k docs**, dense took 7.5 / 15.9 / 26.6 us for 3 / 8 / 15 terms and 113.9 us with stopwords.
  At **1k docs**, dense took about 5 us and Map + insertion 6-13 us.
  — Local benchmark (bench.ts, this session)
- The FlexSearch README's self-reported ops/sec benchmark (on *Gulliver's Travels*; hardware and methodology not stated)
  covers single / multi / large / not-found queries:

  | Library | Single | Multi | Large | Not found |
  |---|---:|---:|---:|---:|
  | flexsearch | 50,955,718 | 11,912,730 | 13,981,110 | 51,706,499 |
  | minisearch | 30,589 | 191,657 | 5,849 | 304,233 |
  | orama | 29,445 | 170,231 | 4,454 | 225,491 |
  | lunr | 11,527 | 51,476 | 88,858 | 103,386 |
  | elasticlunr | 14,326 | 48,558 | 101,206 | 95,840 |
  | js-search | 22,982 | 383,775 | 426,609 | 994,803 |
  | npm "bm25" | 3,903 | 4,777 | 12,657 | 12,471 |
  | fuse | 422 | 321 | 337 | 329 |

  — [FlexSearch README](https://raw.githubusercontent.com/nextapps-de/flexsearch/HEAD/README.md). A mirror of the
  README shows different figures for the same libraries, so the numbers depend on the run, and no independent
  third-party comparison was found — [search summary / bestofjs mirror](https://bestofjs.org/projects/flexsearch).
- FlexSearch's speed comes from "resolution" slot scoring and a contextual (term-proximity) index, not BM25. It trades
  memory for speed: the `full` tokenizer costs n(n−1) memory per term, and the context index needs extra memory that
  grows with `depth`. `remove` and `update` exist; `fastupdate: true` makes them faster for about 30% more index size,
  and `cleanup()` clears empty slots — [FlexSearch README](https://raw.githubusercontent.com/nextapps-de/flexsearch/HEAD/README.md);
  InfoQ also notes the contextual scoring "comes at the expense of the memory footprint" —
  [InfoQ](https://www.infoq.com/news/2019/03/flexsearch-fast-full-text-search).
- How MiniSearch scores:
  - Index: a `SearchableMap` keyed by term string.
  - Per-field postings: `Map<docId, tf>`.
  - Results accumulate in a `Map<docId, {score, terms[], match{}}>`, which allocates one object per matched doc.
  - Scoring is per field, then summed and multiplied by a field boost (so not true BM25F).
  - Deleted ids are checked on every posting at query time.

  — [MiniSearch source](https://github.com/lucaong/minisearch/blob/master/src/MiniSearch.ts) (read in this session).
  This per-match allocation pattern is the same one the local Map baseline shows to be 7-10x slower than a typed-array
  accumulator at 100k docs (inference from the local benchmark).
- MiniSearch's BM25+ defaults are `{ k: 1.2, b: 0.7, d: 0.5 }`. Its IDF is `ln(1 + (N − n + 0.5)/(n + 0.5))`, and its
  default tokenizer is `text.split(/[\n\r\p{Z}\p{P}]+/u)` followed by `toLowerCase()` —
  [MiniSearch source](https://github.com/lucaong/minisearch/blob/master/src/MiniSearch.ts).
- turbopuffer describes the two main dynamic-pruning families:
  - **MaxScore** is term-centric: it sorts query terms by maximum score and uses only the "essential" terms to find
    candidates. It "skips fewer documents but has higher throughput".
  - **WAND** is document-centric: it skips more documents, but each step costs more and the overhead scales with the
    number of terms.

  — [turbopuffer FTS v2 blog](https://turbopuffer.com/blog/fts-v2-maxscore)

### Inferences
- **Recommended layout (per tenant/user index):**
  - `termId: Map<string, number>` interning, plus `df: Int32Array` (grown by doubling).
  - Per term, an append-only `docIds: Uint32Array` and `tf: Uint8Array` (clamp at 255) with a length counter, grown by
    doubling. Docs get monotonically increasing internal ids, so appends keep postings sorted.
  - Per doc: `len: Uint16Array`, a precomputed `norm[d] = k1·(1 − b + b·len/avgdl)` as a `Float32Array`, and a
    `live: Uint8Array` tombstone bitmap.
  - A dense `Float32Array(capacity)` accumulator and a `Uint32Array` touched list, reused across queries. Single-threaded
    JS makes the reuse safe, but it needs re-entrancy care if scoring is ever made async.
  - Recompute `norm` lazily when avgdl drifts by more than a few percent, rather than on every add.
- **TAAT vs DAAT:** at these sizes TAAT with a dense accumulator is simpler and fast enough. DAAT is needed only for
  pruning (below). Dense beats `Map` at 10k-100k docs by 7-30x in the local test. At 1k docs the gap is small, but a dense
  array still costs only 4 KB.
- **Compression:** raw typed arrays at 100k docs × 40 tokens come to roughly 4M postings, about 20 MB with
  `Uint32 + Uint8`. That is acceptable per active user but adds up across many tenants. Delta + varint decoding in JS
  adds branchy per-posting work; use it only for cold or serialized snapshots, not the hot path. A middle ground is
  `Uint16Array` deltas with escape codes (unmeasured).
- **Biggest lever:** cap the postings scanned. Drop query terms whose df/N exceeds a threshold (for example 0.3), or
  treat them as boost-only on already-touched docs. That turned an approximately 1 ms query back into about 50 us in the
  local data.

### Gaps
- No independent, reproducible benchmark of MiniSearch / FlexSearch / Orama / wink-bm25 on the same corpus and hardware
  was found. Orama's and wink-bm25's internals were not inspected.
- Memory footprint per 100k docs for each library was not measured.
- Delta/varint decode speed in JSC was not measured.

## Dynamic pruning (WAND, Block-Max WAND, MaxScore) for short queries on small corpora; deletes

### Takeaway
Below about 100k short docs, exhaustive TAAT over typed arrays already finishes in 30-110 us for 3-15 rare-ish terms
(local benchmark), so WAND, BMW and MaxScore add complexity for little gain. The exception is queries containing
high-df terms. If pruning is wanted, MaxScore (term-centric, essential/non-essential split) is the easiest to retrofit
onto TAAT and is what Lucene moved to. Handle deletes with a tombstone bitmap, plus compaction when the deleted
fraction passes about 10%.

### Cited Findings
- MaxScore marks a term "non-essential" once its upper bound, plus the bounds of all lower-scored terms, cannot reach
  the current top-k threshold. Example: once the heap minimum reaches 6.0, a term with max 2.0 becomes non-essential —
  [turbopuffer](https://turbopuffer.com/blog/fts-v2-maxscore).
- turbopuffer reports MaxScore speedups over its earlier engine on about 5M Wikipedia docs at k=100: "lord of the rings"
  75.4 → 6.3 ms; a 13-term query 174.4 → 20.1 ms; the smallest gain, "search" at k=1000, 5.9 → 4.6 ms. It says Lucene
  moved from WAND to a vectorized MaxScore after users hit queries where WAND was slower than exhaustive evaluation —
  [turbopuffer](https://turbopuffer.com/blog/fts-v2-maxscore). These are vendor numbers on a corpus 50x larger than
  Eden's top end.
- Elastic/Lucene added block-max MaxScore changes that borrow WAND's tendency to become more conjunctive as the
  threshold rises. They report +11% and +6% on two nightly tasks, mostly for two-term queries or queries with stopwords —
  [Elastic Search Labs](https://www.elastic.co/search-labs/blog/more-skipping-with-bm-maxscore).
- Block-Max WAND (Ding & Suel, SIGIR 2011) splits postings into fixed-size blocks, stores a per-block maximum score so
  whole blocks can be skipped, and is "safe" (same results as exhaustive scoring) —
  [Ding & Suel PDF](https://research.engineering.nyu.edu/~suel/papers/bmw.pdf);
  [ParadeDB explainer](https://www.paradedb.com/learn/search-concepts/block-wand). Variable-sized blocks (Mallia et al.
  2017) report about 2x over the prior state of the art — [arpi.unipi.it](https://arpi.unipi.it/handle/11568/887216).
- MiniSearch's deletes:
  - `discard(id)` marks a document discarded; queries skip it (and lazily remove its postings).
  - Auto-vacuum runs when `dirtCount >= 20` **and** `dirtFactor >= 0.1`, in batches of 1000 with a 10 ms wait between
    batches.

  — [MiniSearch source](https://github.com/lucaong/minisearch/blob/master/src/MiniSearch.ts)

### Inferences
- **Skip pruning initially.** Fast-path budget math: 100 us for a 15-term query at 100k docs leaves plenty of headroom
  under 1 ms. Revisit only if p99 queries regularly touch more than 100k postings.
- **Cheap safe pruning that fits TAAT (term-level MaxScore):**
  1. Keep `maxImpact[term]`, the maximum BM25 contribution in that postings list. It is an upper bound; update it on
     add, and leave it unchanged on delete.
  2. Sort query terms by `maxImpact` descending and score the high-impact terms first.
  3. Once the k-th best accumulated score exceeds the sum of the remaining terms' `maxImpact`, stop admitting new docs.
     For the remaining terms, update only docs already in the touched set, through a lookup in a sorted postings array
     or by scanning only if the list is short.
- **Deletes:**
  - Check `live[d]` (`Uint8Array`) during top-k selection, not per posting.
  - Decrement df and doc count immediately, so IDF and avgdl stay correct.
  - Compact a term's postings lazily, when that term's dead ratio exceeds about 20%, or run a global rebuild when the
    deleted fraction passes about 10%. This mirrors MiniSearch's 0.1 factor.
  - Updates are delete plus add under a new internal id, with an `externalId → internalId` map.
- **Isolation:** one index object per (tenant, user). Never share accumulators across indexes of different sizes
  without resizing.

### Gaps
- No published benchmark of WAND/BMW/MaxScore on corpora under 100k docs or in JS was found. The claim that pruning is
  not worth it below 100k rests on the local exhaustive-scan timings, not on a measured pruning implementation.

## BM25 variants (BM25F, BM25+), k1/b for short documents, and calibrated query-comparable confidence

### Takeaway
Use BM25+ (δ≈0.5-1) or plain BM25 with a lower b (about 0.3-0.5) and k1 about 0.9-1.2 for short items, because length
normalization actively hurts on very short docs (tweets). Use simple BM25F: per-field tf weighted (for example title or
subject ×2-3) before saturation. Raw BM25 is not comparable across queries. For a "should I speak" gate, use a
normalized score: score divided by the query's maximum achievable score, together with idf-weighted query-term coverage.
Both are bounded to [0,1] and comparable across queries.

### Cited Findings
- Standard BM25 and IDF: `IDF = ln((N − n + 0.5)/(n + 0.5) + 1)`. BM25+ adds δ inside the sum:
  `IDF · [tf(k1+1)/(tf + k1(1−b+b·|D|/avgdl)) + δ]`, with δ default 1.0. Typical values are k1 ∈ [1.2, 2.0] and
  b = 0.75; b=1 gives BM11 and b=0 gives BM15 — [Wikipedia: Okapi BM25](https://en.wikipedia.org/wiki/Okapi_BM25).
- Lv & Zhai (CIKM 2011) show that BM25's length normalization lacks a proper lower bound, so long docs are
  over-penalized. Adding a lower bound (BM25+) is cheap and improves average precision, especially for verbose queries —
  [CUHK slides](https://www.cse.cuhk.edu.hk/irwin.king/_media/presentations/2011_cikm_lower-bounding_term_frequency_normalization.pdf);
  [Illinois news](https://grainger.illinois.edu/news/stories/2011-12-02-breakthrough-work-improve-search-engine-algorithms).
- Ferguson et al., ECIR 2012, on TREC 2011 Microblog (tweets):
  - "Document length normalisation always harms performance."
  - Default k1=1.2, b=0.75 gave P@30 = 0.3435 (all relevant), against **0.4211 with k1=b=0**. The difference was
    significant (p=0.0013).
  - k1=0.1 gave a small, non-significant further gain (0.4259).
  - The k1=b=0 baseline ranked 5th of 59 groups.

  — [Ferguson et al. 2012 PDF](https://dcu-test.eprints-hosting.org/16770/1/ecir2012_camera_v3.pdf) (read in this
  session)
- A vendor explainer recommends b of about 0.2-0.4 for short texts and k1 of 1.0-2.0 —
  [Zilliz FAQ](https://zilliz.com/ai-faq/how-can-developers-tune-bm25-for-better-lexical-search-results) (not a
  controlled experiment).
- BM25F treats each field as a stream with its own weight, saturation and length normalization —
  [Wikipedia](https://en.wikipedia.org/wiki/Okapi_BM25). MiniSearch instead sums per-field BM25 scores times a boost —
  [MiniSearch source](https://github.com/lucaong/minisearch/blob/master/src/MiniSearch.ts).
- Elastic normalizes BM25 for hybrid fusion using min/max taken from the top-1000 scores of representative queries per
  dataset, because raw score scales differ. This makes calibration "more robust", but one blend weight did not transfer
  across datasets —
  [Elastic hybrid retrieval blog](https://www.elastic.co/search-labs/blog/improving-information-retrieval-elastic-stack-hybrid).

### Inferences
- **Starting parameters** (all to be tuned on Eden eval scenarios):
  - Emails, notes and doc snippets: k1=1.2, b=0.5, δ=0.5.
  - Calendar titles and CRM one-liners (under 15 tokens): k1=0.9, b=0.3, or even b=0.
- **BM25F:** `tf' = Σ_f w_f · tf_f / (1 − b_f + b_f·len_f/avglen_f)`, then `IDF · tf'(k1+1)/(tf'+k1)`. Suggested
  weights: subject/title w=2.5, participants/entities w=2, body w=1. Store per-field tf in the postings, or keep one
  postings list per (term, field).
- **Calibrated confidence** (cheap, computed from data already present in TAAT):
  - `cov = Σ_{q∈Q∩D} idf(q) / Σ_{q∈Q} idf(q)`, the idf-weighted fraction of the query matched.
  - `sNorm = score(D) / Σ_q idf(q)·(k1+1+δ)`, the score as a fraction of the maximum achievable for this query. It is
    bounded in (0,1].
  - `margin = (s1 − s2)/s1`, the gap to the next-best result, which separates ambiguous from clear-cut hits.
  - Gate on `cov ≥ θc ∧ sNorm ≥ θs`, with thresholds fitted on eval labels. Optionally fit a 3-feature logistic
    regression offline to get a probability. Keep the thresholds per source type, because doc-length distributions
    differ.
- Exclude query terms with idf below a floor from the denominator, or `cov` becomes dominated by noise terms.

### Gaps
- No published k1/b values specific to emails, calendar events or CRM notes were found. The microblog result is the
  closest analogue.
- No literature was retrieved on calibrating BM25 into probabilities. The normalization scheme above is design inference.

## Tokenization: Unicode-aware, stemming and stopwords; cost per KB in JS

### Takeaway
A single Unicode regex (`/[\p{L}\p{N}]+/gu` match, or split on `[\p{Z}\p{P}]+`) after `toLowerCase()` costs about
12-17 us per KB in Bun, so tokenization is not the bottleneck. `Intl.Segmenter` is about 3x slower; reserve it for
CJK/Thai. Prefer a light suffix stripper, or no stemmer plus a small stopword list. Stopword handling matters mainly
for latency (postings scanned), not for relevance.

### Cited Findings
- Local benchmark on about 1 MB of mixed English and accented text:
  - `toLowerCase().split(/[\n\r\p{Z}\p{P}]+/u)`: **13.7-16.5 us/KB** (about 175k tokens/MB).
  - `toLowerCase().match(/[\p{L}\p{N}]+/gu)`: **11.5 us/KB**.
  - `Intl.Segmenter('en', {granularity:'word'})` with `isWordLike`: **37.0 us/KB**.

  — Local benchmark (bench.ts, this session)
- MiniSearch's default tokenizer is the `[\n\r\p{Z}\p{P}]+` split followed by `toLowerCase` —
  [MiniSearch source](https://github.com/lucaong/minisearch/blob/master/src/MiniSearch.ts).
- Local benchmark: an 8-term query with stopword-like (top-50 Zipf) terms scanned about 162k postings at 100k docs, against
  7.4k without them, raising latency from about 50 us to about 0.74-1.1 ms — Local benchmark (bench.ts, this session).

### Inferences
- Tokenizer plan:
  1. Take the text after `sanitizeForStore`.
  2. Apply NFKC normalization (optionally strip diacritics with NFD followed by removing `\p{M}`).
  3. Lowercase, then match `/[\p{L}\p{N}]+(?:[._'@-][\p{L}\p{N}]+)*/gu`, so emails, `invoice#`-style ids,
     `follow-up` and dates stay intact.
  4. Also emit sub-parts (for example `follow`, `up`) as extra tokens, accepting a small cost in index size.
  5. Cap token length at about 40 characters and tokens per doc at about 2k.
- Stemming: Porter/Snowball in JS is a per-token chain of suffix rules. Its cost was not measured here. An "s-stemmer"
  (plural folding) recovers most of the benefit for short business text at near-zero cost (a judgement, unmeasured).
  Apply the same function at index and query time.
- Stopwords: drop about 100 English function words at query time only, and keep them in the index so phrases and
  idf can still use them. Also apply a dynamic df cutoff, which handles domain stopwords such as the user's own name or
  company.

### Gaps
- No published per-KB cost for Snowball stemmers in JS (for example `natural`, `snowball-stemmers`, `wink-porter2-stemmer`)
  was found or measured.

## Learned sparse (SPLADE/uniCOIL) and static or tiny embeddings (Model2Vec/potion, MiniLM) as background index steps

### Takeaway
SPLADE and uniCOIL need a transformer pass per document: about 158-167 ms per document on CPU in one self-reported
study, and no JS runtime without ONNX/WASM. That is too costly for a per-user background step relative to its small
nDCG gain. Static embeddings (Model2Vec potion) are a table lookup plus mean pooling. In plain TS this costs about 30 us
per 60-token doc at 256 dimensions (local benchmark), and cosine re-ranking of 20-200 candidates is microseconds. That
makes them a viable background step for semantic recall and MMR similarity, provided the 8-32 MB table and the
tokenizer are shipped. Brute-force dense search over 100k docs (about 32 ms) is not fast-path material.

### Cited Findings
- potion-retrieval-32M has 32.3M parameters (F32) and Matryoshka dims of 32-512. It scores 35.06 on MTEB retrieval
  against 42.92 for all-MiniLM-L6-v2, about 82% of MiniLM. It claims "orders of magnitude faster on both GPU and CPU" —
  [HF model card](https://huggingface.co/minishlab/potion-retrieval-32M).
- Model2Vec claims "up to 500 times faster on CPU" than the source sentence transformer, and models up to 50x smaller.
  Model sizes: potion-base-8M (7.5M params), potion-base-32M, potion-retrieval-32M (distilled from bge-base-en-v1.5),
  and potion-multilingual-128M. The best model is about 30 MB on disk and the smallest about 8 MB. No JS integration is
  listed — [Model2Vec GitHub](https://github.com/MinishLab/model2vec).
- The Rust port reports about 8,000 samples/s against 4,650 in Python on potion-base-2M, single-threaded on CPU —
  [docs.rs model2vec](https://docs.rs/crate/model2vec/latest) (search summary).
- A community project runs a static multilingual embedding model with a JS tokenizer, exporting the embedding table from
  Python ("Tokenizer in JS is working") —
  [gregtatum/static-embeddings](https://huggingface.co/gregtatum/static-embeddings/commit/6af7a6847498f0733766158757ec1934d51b99dd).
- SPLADE costs:
  - AgentIR (self-reported, arXiv 2026) puts SPLADE++ (110M parameters) at about **158-167 ms per document** and 17-150
    ms per query on CPU, against 0.04-0.35 ms for its C++ BM25. The nDCG@10 gain over BM25 was 0.002-0.105 across
    seven BEIR sets — [arXiv 2605.25092](https://arxiv.org/pdf/2605.25092).
  - NAVER (billion-scale titles) found SPLADE more effective than BM25 but about 1.9x slower on long queries —
    [arXiv 2511.22263](https://arxiv.org/html/2511.22263v1).
- Local benchmark:
  - Static-embedding lookup plus mean pooling plus L2-normalize, 60 tokens × 256 dims from a 32k×256 `Float32Array`
    table: **29.5 us/doc**. This excludes subword tokenization.
  - Brute-force dot product over 100k × 256 floats: **31.7 ms/query**.

  — Local benchmark (bench2.ts, this session)

### Inferences
- At about 30 us per doc, embedding 100k items in the background takes about 3 s of CPU, plus tokenizer time. Cheap
  enough to run on ingest. Memory is 100k × 256 × 4 B ≈ 100 MB per user at F32. Use Matryoshka 64-128 dims and/or
  `Int8Array` quantization (an inference, unmeasured) to get to roughly 6-25 MB.
- Use static embeddings (a) to re-rank and expand BM25's top 50-200, and (b) as the similarity function inside MMR.
  Do not use them as a standalone first-stage index on the fast path. This keeps Eden's "model last" rule, since a
  static-embedding lookup involves no LLM or `Budget` call. It does add a dependency/asset (the model table), which
  CLAUDE.md requires justifying.
- Running the WordPiece/BPE tokenizer in JS is the integration risk, not the math. Pre-tokenize with the same token
  ids, or port the tokenizer.json greedy longest-match logic in plain TS (unmeasured).
- SPLADE/uniCOIL do not fit: they need ONNX or WASM (a native-like runtime), and about 160 ms/doc × 100k docs is
  about 4.5 CPU-hours per user.

### Gaps
- No independent benchmark of Model2Vec running in JS or Bun was found. The 29.5 us figure is a synthetic lookup kernel.
- No direct measurement of potion against BM25 on email or calendar-like data was found.
- Whether "late 2026" brought a maintained JS Model2Vec package is unverified.

## Packing under a byte/token budget with diversity: MMR, budgeted submodular greedy, dedup

### Takeaway
For k ≤ 20 candidates, a cost-aware greedy MMR (or the Lin-Bilmes budgeted submodular greedy) is O(k²) similarity
evaluations, about 27 us in the local benchmark, so take the better-quality option. The sequence is:
1. Exact and near dedup (normalized hash, then Jaccard on token-id sets or embedding cosine, threshold about 0.8).
2. Greedy selection by `[λ·rel − (1−λ)·max sim to chosen] / cost^r`, honouring the budget.
3. A final check that compares against the single best item that fits, which keeps the knapsack approximation guarantee.

Use λ of about 0.7 for an agent context packet. Precision matters more than spread, and LangChain's default is 0.5.

### Cited Findings
- MMR (Carbonell & Goldstein, SIGIR 1998) reranks by combining query relevance with novelty relative to items already
  selected —
  [MMR paper PDF](https://blog.langchain.com/content/files/~jgc/publication/the_use_mmr_diversity_based_ltmir_1998.pdf).
  It is commonly written as `λ·Sim1(D,Q) − (1−λ)·max_{Dj∈S} Sim2(D,Dj)`; a higher λ favours relevance and a lower λ
  favours diversity — [arXiv 2211.10808](https://arxiv.org/pdf/2211.10808);
  [MathWorks mmrScores](https://www.mathworks.com/help/textanalytics/ref/mmrscores.html).
- LangChain's `max_marginal_relevance_search` defaults to `k=4`, `fetch_k=20` and `lambda_mult=0.5`, where 0 means
  maximum diversity —
  [LangChain reference (FAISS)](https://reference.langchain.com/python/langchain-community/vectorstores/faiss/FAISS/max_marginal_relevance_search).
- Lin & Bilmes (ACL 2011) build monotone submodular objectives (coverage plus a diversity reward) for which greedy
  selection has a constant-factor guarantee. They beat the prior state of the art on DUC 2004-2007 —
  [ACL Anthology P11-1052](https://aclanthology.org/P11-1052/). The budgeted, cost-scaled greedy details were not
  retrieved in this session (see Gaps).
- Local benchmark: greedy MMR with a byte budget over 20 candidates, using Jaccard on 30-token-id sets and a 4 KB budget,
  took **26.6 us per pack** — Local benchmark (bench2.ts, this session).

### Inferences
- **Recommended packer:**
  1. Candidates: the top 20 from BM25, after dedup.
     - Exact dedup: hash of the normalized text, plus thread or event id collapsing (keep only the latest email in a
       thread unless the earlier ones add new tokens).
     - Near-dup: drop a candidate if it has Jaccard ≥ 0.8 on token-id sets, or cosine ≥ 0.9 on static embeddings, with
       an already-kept item.
  2. Costs: each item's cost is its rendered byte length, or its token estimate (bytes/4 is the usual approximation,
     unverified here). Pre-truncate long items to a per-item cap (for example 25% of the budget) using a snippet
     centred on matched terms, so one long email cannot crowd out the rest.
  3. Greedy: pick `argmax (λ·relNorm(i) − (1−λ)·max_{j∈S} sim(i,j)) / cost(i)^r` with r ≈ 0.3-0.5 (r=0 is pure MMR;
     r=1 is pure value per byte). Take λ=0.7. Stop when nothing fits, or when the marginal gain falls to 0 or below.
     This keeps silence by default: never pad the packet.
  4. Guarantee fix: compare the greedy set against the best single item that fits, and return whichever has the
     higher objective. This is the standard budgeted-submodular trick (stated from general knowledge; not sourced this
     session).
- Use the calibrated `sNorm`/`cov` (from the BM25 section), not raw BM25, as `rel`, so λ means the same thing across
  queries.
- Complexity: O(k²·s), where s is the cost of one similarity call. With k=20 and Jaccard on small sets, that is tens of
  microseconds. An exact 0/1 knapsack DP over a byte budget is O(k·B) and unnecessary.

### Gaps
- Lin & Bilmes' exact budgeted greedy (the cost-scaling exponent r and the "best singleton" guarantee) was not verified
  from the full paper in this session.
- No source recommends λ specifically for LLM context packing. The 0.7 is a judgement call to be tuned with Eden's eval
  (`falseFireRate` and recall).
- The bytes/4 token approximation was not verified against the target model's tokenizer.
