# Typed arrays and calibrated silence beat models

A context partner can make almost every inject-or-stay-silent decision in **well under a millisecond of CPU**, without a model. Intern terms to integer ids. Score BM25 term-at-a-time into a reusable `Float32Array` accumulator: a local benchmark put 3–15-term queries at **27–112 µs over 100k short docs**, 7–30x faster than the `Map` accumulators most JS search libraries use. Match entities against a per-user token-id trie (about **0.2–0.3 ms per 2 KB event at 100k aliases**). Then gate the result with a calibrated, per-source logistic score whose threshold is set to a target precision. An LLM is called only for events whose score falls in a narrow uncertainty band. Meta's Proactive Memory Agent (arXiv 2607.08716) is useful for its structure, not its runtime. It makes silence an explicit action, splits memory into private, knowledge and procedural parts, and injects context transiently. But it runs a frontier model on every step and reports no cost or latency. In its own ablation, "always inject" ties the full system on micro accuracy (61.5 vs 61.2), so silence pays off in false fires avoided and tokens saved, not in task success. The real latency budget is spent on slow MCP round-trips, not on scoring. The design has to stay correct under those delays, using per-user singleflight, absolute deadlines that serve stale data, GCRA rate limits and small-window circuit breakers, and it has to account for the stateless 2026-07-28 MCP revision. When the model is called, GLM 5.3 Flash costs about **$0.00014 per judge call with a cached prefix, against $0.00038 uncached**. That holds only if OpenRouter keeps routing to the same one of its 38 endpoints.

All numbers labelled "local benchmark" come from synthetic micro-benchmarks run in this research session (Bun 1.4.4, 4-vCPU Xeon 2.1 GHz, Zipf or random-syllable data). They measure speed only, not relevance, varied about 1.5x between runs, and are not checked in. Items marked "not re-verified" are canonical references that were cited from memory and not re-opened in this session. Per the repo's "honest numbers" rule, they need checking before they go into a PR or doc.

## Dense typed-array BM25 answers a 15-term query in about 100 µs

**Recommended algorithm.** Keep one index object per (tenant, user):

- **Terms.** A `Map<string, number>` interns each term to an integer id, with an `Int32Array` of document frequencies.
- **Postings.** Each term has append-only parallel arrays: `docIds: Uint32Array` and `tf: Uint8Array` (clamped at 255). Both grow by doubling. Internal doc ids only increase, so postings stay sorted.
- **Per-document arrays.** Length, a precomputed BM25 norm (`k1·(1−b+b·len/avgdl)`), and a `live` tombstone byte.
- **Scoring.** Term-at-a-time (TAAT) into a dense `Float32Array` accumulator sized to the doc count, plus a touched-docs list. Both are reused across queries. Top-k uses a small insertion buffer.

In the local benchmark at 100k docs, this layout ran 3, 8 and 15-term queries in **26.7–28.0, 45.4–55.8 and 97.1–111.5 µs**. A `Map` accumulator with insertion top-k took 200.9, 499.5 and 865 µs. MiniSearch is slow for the same reason: its source accumulates into a `Map<docId, {score, terms[], match{}}>`, allocating one object per matched doc ([MiniSearch source](https://github.com/lucaong/minisearch/blob/master/src/MiniSearch.ts)). FlexSearch's self-reported ops/sec lead (50.9M single-term ops/sec against MiniSearch's 30.6k) comes from "resolution" slot scoring and a memory-hungry contextual index, not BM25. Its README figures also differ between mirrors, and no independent benchmark exists ([FlexSearch README](https://raw.githubusercontent.com/nextapps-de/flexsearch/HEAD/README.md)). Writing the index directly is the right choice, and it adds no dependency.

**Pitfall: postings scanned, not term count.** Adding stopword-like terms to an 8-term query raised the scan from about 7.4k to 162k postings and the latency from about 50 µs to **0.74–1.1 ms** (local benchmark). The fix:

- Drop query terms whose df/N exceeds about 0.3, or score them as boost-only on docs already touched.
- Strip about 100 English function words at query time only.

Skip dynamic pruning at first. MaxScore is the variant to retrofit if p99 queries routinely touch more than 100k postings. It is term-centric and fits TAAT, and Lucene moved to it after WAND turned out slower than exhaustive evaluation on some queries. turbopuffer reports 75.4 → 6.3 ms on a 5M-doc corpus, 50x Eden's top end ([turbopuffer](https://turbopuffer.com/blog/fts-v2-maxscore)). No pruning benchmark under 100k docs exists, so "not needed" rests on the exhaustive timings above.

**Deletes.** Check `live[d]` at top-k selection, not per posting. Decrement df and N immediately. Compact when the deleted fraction passes about 10%, mirroring MiniSearch's `dirtFactor ≥ 0.1` auto-vacuum ([MiniSearch source](https://github.com/lucaong/minisearch/blob/master/src/MiniSearch.ts)).

**Parameters.** Short personal items need weaker length normalization. On TREC Microblog, "document length normalisation always harms performance": P@30 rose from **0.3435 at k1=1.2, b=0.75 to 0.4211 at k1=b=0** (p=0.0013) ([Ferguson et al. 2012](https://dcu-test.eprints-hosting.org/16770/1/ecir2012_camera_v3.pdf)). BM25+ adds a lower bound δ that fixes over-penalising long documents ([Lv & Zhai slides](https://www.cse.cuhk.edu.hk/irwin.king/_media/presentations/2011_cikm_lower-bounding_term_frequency_normalization.pdf)). Starting points, all to be tuned on Eden's eval:

| Item type | k1 | b | δ |
|---|---|---|---|
| Mail, notes, doc snippets | 1.2 | 0.5 | 0.5 |
| Calendar titles, CRM one-liners | 0.9 | 0.3 or 0 | — |

Combine fields with simple BM25F weights: subject or title 2.5, participants or entities 2, body 1.

**Tokenization** is not the bottleneck. In the local benchmark, `toLowerCase().match(/[\p{L}\p{N}]+/gu)` cost **11.5 µs/KB**, against 37 µs/KB for `Intl.Segmenter`, which should be kept for CJK and Thai. Use one tokenizer at index and query time:

1. Apply NFKC.
2. Lowercase.
3. Match `/[\p{L}\p{N}]+(?:[._'@-][\p{L}\p{N}]+)*/gu`, so emails, ticket ids and "follow-up" survive, and also emit the sub-parts.
4. Fold plurals with an s-stemmer rather than Porter (unmeasured judgement).

**Confidence that compares across queries.** Raw BM25 scores do not compare across queries. Elastic needed per-dataset min/max normalization for fusion, and found that blend weights did not transfer ([Elastic](https://www.elastic.co/search-labs/blog/improving-information-retrieval-elastic-stack-hybrid)). Three bounded features fall out of TAAT for free:

- `cov`: idf-weighted query coverage.
- `sNorm`: the score divided by the maximum achievable `Σ idf·(k1+1+δ)`.
- `margin`: `(s1−s2)/s1`.

These feed the gate described below.

**Static embeddings are optional.** A Model2Vec/potion lookup with mean pooling cost **29.5 µs per 60-token doc** at 256 dimensions (local benchmark, excluding subword tokenization). potion-retrieval-32M reaches about 82% of MiniLM on MTEB retrieval (35.06 vs 42.92) ([HF card](https://huggingface.co/minishlab/potion-retrieval-32M)). That makes it a defensible later step for reranking BM25's top 50–200 and for MMR similarity. It should not be a first-stage index: brute-force search over 100k vectors took 31.7 ms (local benchmark). It also brings an 8–32 MB asset and a JS tokenizer port that CLAUDE.md requires justifying.

SPLADE is out. One self-reported study puts it at about **158–167 ms per document on CPU**, for nDCG@10 gains of 0.002–0.105 over BM25 ([arXiv 2605.25092](https://arxiv.org/pdf/2605.25092)).

**Packing under a budget** is cheap enough to do properly. Greedy MMR with a byte budget over 20 candidates took **26.6 µs per pack** (local benchmark). The recommended packer:

1. Remove exact and near duplicates (next section).
2. Pre-truncate each item to about 25% of the budget, using a snippet centred on the matched terms.
3. Repeatedly pick `argmax [λ·rel − (1−λ)·max sim to chosen] / cost^r`, with λ=0.7 and r≈0.3–0.5. Use the calibrated `sNorm` as `rel`, never raw BM25.
4. Stop when the marginal gain reaches zero or below, so the packet is never padded.
5. Compare the result against the best single item that fits, and keep whichever scores higher.

MMR itself is from Carbonell & Goldstein ([SIGIR 1998](https://blog.langchain.com/content/files/~jgc/publication/the_use_mmr_diversity_based_ltmir_1998.pdf)). LangChain defaults to λ=0.5 ([LangChain](https://reference.langchain.com/python/langchain-community/vectorstores/faiss/FAISS/max_marginal_relevance_search)), but an agent packet should favour precision over spread. The λ=0.7 value, the singleton check in step 5 (the standard budgeted-submodular fix; Lin & Bilmes' full budgeted algorithm was not verified) and bytes/4 as a token estimate are unverified design choices.

## A token-id trie and exact sets cover entities and dedup

**Entity matching.** For whole-word, case-insensitive matching of 1k–100k aliases, character-level Aho-Corasick buys nothing in JS. spaCy's PhraseMatcher design is a trie keyed by token ids, which tries every start token and returns all hits for the caller to resolve ([spaCy phrasematcher.pyx](https://github.com/explosion/spaCy/blob/master/spacy/matcher/phrasematcher.pyx)). In the local benchmark (100k names, synthetic 2 KB events), it matched in **about 0.21 ms per event** and built in 148 ms. A token-window `Map` took 0.30 ms per event and 90 ms to build. A FlashText-style character trie took 0.26 ms. FlashText's own benchmark claims about 82x over regex at 15k keywords, with time nearly independent of keyword count ([FlashText](https://ar5iv.arxiv.org/html/1711.00046)).

Both token approaches insert an alias in O(alias length), so entities learned continuously never force a rebuild. Persist the alias list, not the structure. At about 5 MB per 100k aliases (a single rough heap reading), resident users need lazy loading and LRU eviction. The benchmark vocabulary collided with ordinary words far more than real text would, so treat these figures as cost upper bounds.

**Normalization** runs once, through one function, for both the gazetteer and the text:

1. NFKC, then NFKD, then strip `\p{M}`, then lowercase.
2. Unify apostrophes and dashes.
3. Drop possessive 's.

The local benchmark put normalization plus tokenization at 0.026 ms per event.

**Aliases** are generated deterministically, each with a weight:

| Alias kind | Example | Weight |
|---|---|---|
| Full name | "dana lee" | 1.0 |
| Surname | "lee" | 0.5 |
| First name | "dana" | 0.3 |
| Email local parts | `dana.lee`, `dlee` | 1.0 in an address, 0.6 as bare tokens |
| Nicknames (static table) | "Bob" for Robert | 0.3 |

Company aliases drop legal suffixes and add the domain stem. Project codenames get a low base weight.

**Ambiguity is the main precision risk.** A gazetteer gives a recall-oriented baseline, and its precision suffers wherever names are ambiguous ([GATE, LREC 2004](https://gate.ac.uk/sale/lrec2004/gazcollector.pdf)). Capitalization matters a great deal: one gazetteer system found 16 of 33 film mentions in capitalized transcripts and **0 in lowercase ones** ([arXiv 1809.08711](https://arxiv.org/pdf/1809.08711)). Rules for single-token aliases that are also common words (will, mark, apple, amazon):

- Count one only if it is capitalized mid-sentence, or another alias of the same entity or a linked entity co-occurs in the event.
- Score each hit as alias weight × idf factor × cue bonus. Cues include `@`, an email header, and "with/from/cc".
- If a first name maps to several people, resolve by recency or interaction count, and stay silent if it remains ambiguous.

**Unseen names, model-free.** Run regexes first and consume their spans. They are precise by construction and cost microseconds per KB:

- Email addresses
- @handles
- Jira/Linear-style ticket ids (`[A-Z][A-Z0-9]{1,9}-\d{1,6}`)
- URLs with tracking parameters stripped
- Dates and money amounts, used as context cues, not entities

Then take runs of title-case tokens as a candidate generator only, never as a trigger. Rule-based NER reaches about 89–90% F1 in narrow, well-formed domains but degrades on informal text ([arXiv 2109.11406](https://arxiv.org/pdf/2109.11406)). Count candidates and promote one to the gazetteer only after it recurs across two or more sources or sessions.

wink-nlp is the fallback if heuristics prove too weak. It claims 650k tokens/s for its full pipeline, has a model of about 1 MB, and is MIT licensed ([wink-nlp](https://github.com/winkjs/wink-nlp)). Its NER accuracy is not independently measured, and it would be a new dependency.

**Near-duplicates.** Work in this order:

1. Strip quoted replies (`>` lines, `On … wrote:`, `-----Original Message-----`) and signatures.
2. Canonicalize, and catch exact syncs with a 32-bit hash in a `Set`.
3. For bodies of about 20 tokens or more, compute **MinHash with 128 permutations over word 3-shingles**. Below that, use the exact hash only, because MinHash error is about 1/√k ([Wikipedia: MinHash](https://en.wikipedia.org/wiki/MinHash)).
4. Index the signatures with LSH bands **b=16, r=8**, then verify candidates at estimated Jaccard ≥ 0.8.

With collision probability `1−(1−s^r)^b` ([Wikipedia: LSH](https://en.wikipedia.org/wiki/Locality-sensitive_hashing)), b=16, r=8 catches 95% of pairs at s=0.8 and 24% at s=0.6. The tighter b=12, r=10 catches only 74% at 0.8 (local arithmetic). For dedup among 20–50 retrieved results, skip LSH and compare signatures pairwise, which is sub-millisecond.

SimHash is the memory-lean alternative: 64 bits as two uint32s, with Hamming distance ≤ 3, the setting Manku et al. validated on web pages ([WWW 2007](https://www.www2007.cpsc.ucalgary.ca/papers/paper215.pdf)). Validate the threshold on short email before relying on it. In the local benchmark, MinHash128 cost **0.33 ms** and SimHash64 **0.19 ms** per 2 KB document.

The decisive pitfall is hashing. Use only 32-bit `Math.imul` hashes such as murmur3_32. 64-bit emulation in JS can cut speed by 80–90% ([bryc/jshash](https://github.com/bryc/code/blob/master/jshash/hashes/README.md)), and BigInt FNV-1a-64 ran about 16x slower than murmur3 locally.

**Probabilistic sets mostly lose at per-user scale.** An exact `Set` of 100k hashes cost about 5.2 MB and **0.023 µs per lookup**. A Bloom filter at 1% false-positive rate cost 117 KB but 0.32 µs per lookup, with a measured FPR of 0.97% (local benchmark; formulas from [Wikipedia: Bloom filter](https://en.wikipedia.org/wiki/Bloom_filter)). Use exact `Set`s rotated per day for "already delivered" tracking. Switch to Bloom only when thousands of users must stay resident, or when filters are persisted. A Bloom false positive suppresses a delivery, so it fails toward silence, which is the safe direction, but keep ε ≤ 0.1% (14.4 bits per item).

A cuckoo filter is worth having only if deletion is needed, and its space advantage below 3% FPR is disputed ([Fan et al. 2014](https://sigcommconfs.hosting2.acm.org/co-next/2014/CoNEXT_papers/p75.pdf) vs [workshop paper](https://people.bu.edu/staro/cuckoo_filter_workshop_paper.pdf)). A count-min sketch with conservative update fits unseen-name counting once a capped `Map` exceeds about 50k keys ([Wikipedia: CMS](https://en.wikipedia.org/wiki/Count%E2%80%93min_sketch)). At ε=0.001 and δ=0.01 that is w=2719, d=5, about 54 KB. HyperLogLog is for dashboards only.

## Silence is a calibrated threshold, and the LLM gets only the band

**What the Meta paper establishes.** The Proactive Memory Agent runs a separate LLM beside an unchanged action agent ([arXiv 2607.08716](https://arxiv.org/html/2607.08716v1)). Each step has two phases:

1. **Bank edits.** The agent edits a bank of private status, knowledge and procedural memories through four tools: `memory_update_status`, `memory_save_knowledge`, `memory_save_procedural` and `memory_delete`.
2. **Intervene or not.** It emits either one grounded reminder or an explicit `<no_intervention/>`. The reminder is injected into the next call only, never into persistent history.

The intervention criteria are concrete, and Eden can use them as a judge rubric and as classifier labels. Intervene for:

- a requirement about to be violated
- a fact that explains the current observation
- an attempt that should not be repeated
- a diagnosis that is still relevant
- a neglected subgoal

Do not offer broad strategy, restate what is visible, or take over the action agent's planning.

Results with Opus 4.6 as the memory agent: Sonnet 4.5 improved **+8.3 pp on Terminal-Bench 2.0 and +6.8 pp on τ²-Bench**, with smaller gains for the stronger Opus action agent. The ablation is more sobering for "silence improves outcomes":

| Variant | Macro | Micro |
|---|---|---|
| Full system | **64.3** | 61.2 |
| Always inject | 63.5 | **61.5** |
| Mem0 top-10 retrieval | 62.1 | 60.8 |
| Passive full-bank exposure | 61.5 | 58.6 |

The authors call the micro gap run variance. The same configuration's retail score also differs by about 2 pp between their tables.

Other points that bear on Eden:

- Remaining failures are "primarily calibration errors": overconfident speculation, repeating known information, and unnecessary concerns that trigger extra verification.
- Helpful interventions cluster just before state-changing tool calls.
- An untrained 27B memory model *hurt* (SETA reward 0.709 → 0.693). Only SFT plus GRPO focused on "pivot turns" made it help.
- Experiments call the memory model on every step. The paper suggests, but does not test, cheaper triggers: tool errors, repeated commands, large context shifts.

For Eden, the lesson is that an uncalibrated cheap judge is worse than none. Silence must be the default until labels exist, and silence earns its keep by avoiding false-fire and token costs that the benchmark does not price.

**Twenty-five years of just-in-time retrieval agree.** Rhodes & Maes concluded that JITIR agents "should tend to favor precision over recall", should suggest no more than a few items, and should gate them with a minimum threshold that shows "No suggestion" otherwise ([IBM Systems Journal 2000](https://www.bradleyrhodes.com/Papers/rhodes-jitir-agents-ibmsj-2000.pdf)). Unthresholded Margin Notes scored 4–5 out of 5 for relevance on only about **47–54%** of annotations, and usefulness ratings were lower still. Eden's threshold must therefore cut coverage hard to reach the ≥90% precision a silent product needs. Two habits carry over directly: inject 1–3 items at most, and show the triggering cue as provenance, as the Remembrance Agent's right-click did.

**The gate.** Build about ten query-performance-prediction (QPP) features per (cue, source), all O(k) on scores already computed:

- top score s1, and s1−s2
- s1 divided by the mean of the top 5
- an NQC-like std(top 5)/s1
- number of hits above a floor
- maximum cue idf, and cue length
- recency of the top hit
- **already in the agent's recent context** (redundancy)
- the source's precision prior

Add the BM25 `cov`/`sNorm`/`margin` features from the retrieval section. Fit a Platt-style logistic regression per source, and move to isotonic regression only past about 1,000 labels per segment (Niculescu-Mizil & Caruana, [ICML 2005](https://www.cs.cornell.edu/~alexn/papers/calibration.icml05.crc.rev3.pdf), not re-verified). QPP predictors correlate only modestly with effectiveness, so they belong inside a learned gate, not as standalone thresholds.

**Setting the thresholds.** Treat injection as selective classification (Geifman & El-Yaniv, [arXiv 1705.08500](https://arxiv.org/abs/1705.08500), not re-verified):

- **τ_high** is the lowest threshold whose Clopper-Pearson upper bound on the false-fire rate meets the target. With 200 accepted examples, observed precision must be about 0.94 to certify 0.90 at 90% confidence (standard binomial arithmetic, not computed in this session).
- **τ_low** sits where fewer than about 5% of useful items fall below it.
- Events scoring in **[τ_low, τ_high)** go to the LLM judge with the Meta rubric, on bounded input, through `Budget`.
- If `Budget` is exhausted, stay silent.
- Size the band so that event rate × band mass fits `Budget`.
- Log judge verdicts as training labels, so the band narrows over time, as in FrugalGPT ([arXiv 2305.05176](https://arxiv.org/abs/2305.05176), not re-verified).

Raw LLM confidence is "a weak deferral rule". Conformal Cascade defers whenever the prediction set has more than one element ([arXiv 2607.25018](https://arxiv.org/abs/2607.25018)), a sounder pattern if Eden ever chains models. Two cautions: conformal guarantees assume exchangeability, which drifting per-user streams violate, so recalibrate per window. And the claim that 80–95% of events carry no cue at all is an expectation, not a measurement.

**Source routing.** Choosing which of 5–30 sources to query is federated resource selection. Classic methods score sources against per-source term statistics: CORI, or ReDDE's sample-index estimate ([Shokouhi & Si survey](https://www.nowpublishers.com/article/Details/INR-010), not re-verified). Learned vertical selection combines corpus, log and query-string rule features in a per-vertical classifier (Arguello et al., [SIGIR 2009](https://dl.acm.org/doi/10.1145/1571941.1571997), not re-verified). RAG-MCP shows that retrieving over tool descriptions lifts tool selection from **13.62% to 43.13%** and halves prompt tokens ([arXiv 2505.03275](https://arxiv.org/abs/2505.03275)), though that was a stress test with many tools.

Eden's router combines four signals in a logistic score and queries at most k=3 sources above a threshold:

- a ReDDE-like BM25 profile of recently read items per source (sanitized, keyed per user)
- tool-description keywords
- cue-type rules: time expression → calendar; person or email → mail and CRM; URL or filename → docs
- a learned prior

Cost per source is an MCP round-trip, so cutting fan-out matters far more than scoring speed.

**Bandits for the prior.** Use **Beta–Bernoulli Thompson sampling per (user, source, cue type)**:

- Prior strength α0+β0=4, centred on the population usage rate.
- Discount γ=0.99 per update (about 100 decisions of memory), floored at the prior.
- Semi-bandit reward: each queried source scores 1 if any of its items was used.
- Delayed rewards are batched to the end of the session. Thompson sampling tolerates this (Chapelle & Li, [NeurIPS 2011](https://papers.nips.cc/paper/2011/hash/e53a0a2978c28872a4505bdb51db06dc-Abstract.html), not re-verified).
- Move to LinTS or LinUCB only once roughly 5–15 context features have traffic behind them ([arXiv 1003.0146](https://arxiv.org/abs/1003.0146), not re-verified).

Two rules matter more than the parameters. **Explore only in which sources to query, never by injecting low-confidence items.** And "the agent reused the text" is not proof that it helped, because the Meta paper shows unnecessary reminders still get acted on. Log a propensity for every decision, and withhold 1–5% of would-fire events so replay or IPS estimates remain possible. No published study validates implicit "use" signals for an LLM consumer. The overlap-threshold proxy is unvalidated.

## Slow MCP fan-out needs deadlines, not hedges

**Fan-out.** Put one absolute deadline on each lookup and derive stage signals with `AbortSignal.any([parent, AbortSignal.timeout(stage)])`. A design split for a 1,500 ms lookup:

| Stage | Budget |
|---|---|
| Admission (cache and rate-limit check) | 50 ms |
| Fan-out | up to about 1,100 ms |
| Merge, rank, redact | 100 ms |
| Optional model call | 250 ms |

At a 500 ms deadline, drop the model call. Within the fan-out, give each source `min(remaining − reserve, cap)` rather than an equal slice, because sources run in parallel. At the deadline, return "good enough" partial results with missing sources marked `timedOut`, and let late responses fill the cache.

**Hedge sparingly.** Hedged requests, sent after the p95 delay, cut Bigtable's 99.9th percentile from 1,800 ms to 74 ms for about 2% more load ([The Tail at Scale](https://cacm.acm.org/research/the-tail-at-scale/), not re-verified). But Eden's "replicas" share one user's Google quota, and MCP servers MUST rate-limit tool calls ([MCP Tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)). Hedge only when all of these hold:

- the tool is on Eden's read-only allowlist
- that upstream's token bucket is more than half full
- the hedge delay has passed: rolling p95 per (upstream, tool), floored at 100 ms
- the remaining deadline exceeds p50
- a global hedge bucket refilled at about 5% of request rate has a token

Serving stale data at the deadline is usually the better hedge.

**Singleflight** is a `Map` deleted in `finally`, keyed by tenant, user, source, tool and the canonical argument hash. It shares both results and errors with every waiter, as Go's singleflight does ([pkg.go.dev](https://pkg.go.dev/golang.org/x/sync/singleflight)). Never coalesce across users, and add a test that two users with the same query make two upstream calls. The usual bug is letting the first caller's AbortSignal cancel everyone. Instead, the flight owns its own controller, each waiter races the shared promise against its own signal, and the flight aborts only when the waiter count reaches zero.

**Rate limiting and backoff.**

- **GCRA** stores one timestamp per key, keyed per tenant, per (user, upstream) and per host ([Wikipedia: GCRA](https://en.wikipedia.org/wiki/Generic_cell_rate_algorithm), not re-verified).
- **`Retry-After`** sets the bucket's next allowed time. Answer from stale cache rather than sleeping past the deadline.
- **Retries** happen only on background paths, with Full Jitter (base 200 ms, cap 30 s, 3–5 attempts). AWS found no-jitter backoff "the clear loser" and Full Jitter cheapest in work ([AWS](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/)).
- **Rate-limit detection** cannot rely on status codes. MCP reports tool execution errors as `isError: true` results, so a Gmail 429 can arrive as text inside a successful response, and Eden needs a per-source error classifier.

**Circuit breakers.** resilience4j's defaults (a 100-call window, 100 minimum calls, 60 s open) assume heavy traffic ([resilience4j](https://resilience4j.readme.io/docs/circuitbreaker)). Proposed, unmeasured settings for Eden:

- a 60 s time-based window with a minimum of 5 calls and a 50% failure threshold
- any call slower than the lookup deadline counts as a failure
- open for 30 s, growing exponentially per re-open up to 10 min
- one or two half-open probes

Keep two breaker scopes. A per-(user, upstream) breaker handles 401/403 and stays open until re-auth. A per-host breaker handles 5xx and timeouts.

**Concurrency limits.** Put an AIMD limit per upstream host in front of the breakers: start at 8, add 1 per good window, halve on a timeout or 429, and keep it between 1 and 32. Add a per-user cap of 4 in-flight calls per upstream. Reserve about 90% of capacity for interactive lookups and 10% for proactive refresh, following Netflix's partitioning pattern; Netflix also advises loss-based AIMD for clients ([Netflix concurrency-limits](https://github.com/Netflix/concurrency-limits)).

**Caching.** Use a byte-budgeted, per-user-keyed cache with soft and hard TTLs:

| Content | Soft TTL | Hard TTL (serve stale while revalidating) |
|---|---|---|
| Mail search | 60 s | 10 min |
| Calendar | 120 s | 30 min |
| Docs, CRM | 5 min | 1 h |
| Empty results (negative) | 30–60 s | — |
| Errors (negative) | 5–15 s | — |

All of these TTLs are design choices, not measurements. Background revalidation goes through the same singleflight. A plain LRU with a byte budget is fine to start. S3-FIFO is about 100 lines and handles scan-heavy proactive refreshes better ([SOSP 2023](https://dl.acm.org/doi/10.1145/3600006.3613147), not re-verified).

**MCP spec implications.** The **current MCP revision is 2026-07-28, and it is stateless** ([versioning](https://modelcontextprotocol.io/specification/versioning); [changelog](https://modelcontextprotocol.io/specification/latest/changelog)):

- There is no `initialize` handshake and no `Mcp-Session-Id`. Every request is its own POST carrying version and capabilities in `_meta`, and servers MUST implement `server/discover`.
- Streams are not resumable, so a broken stream must be re-issued as a new request.
- List and read results carry `ttlMs`/`cacheScope` hints, but `tools/call` results do not.
- **Closing the SSE stream is the cancellation** ([Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)), so aborting the losing `fetch` cancels it correctly.

What Eden must do:

- Keep a 2025-11-25 fallback: on a 400 response, fall back to the `initialize` handshake. Send `notifications/cancelled` best-effort to old servers.
- Cache `tools/list` and `server/discover` results per their `ttlMs`.
- Never cache across users, even under `cacheScope: "public"`.
- Fetch one page per lookup on the fast path.
- Treat `readOnlyHint` as necessary but not sufficient, because annotations from untrusted servers are untrusted.

## Cached GLM 5.3 Flash judge calls cost about 14 cents per thousand

**Caching on OpenRouter.** Z.AI-family caching is automatic, with no `cache_control` and no listed minimum. Writes are free (listed as limited-time) and reads cost about 0.2x ([OpenRouter caching](https://openrouter.ai/docs/guides/best-practices/prompt-caching)). The catch is routing. `z-ai/glm-5.3-flash` had **38 endpoints** when fetched this session, mostly with 1M-token context and many quantized to fp4 ([endpoints API](https://openrouter.ai/api/v1/models/z-ai/glm-5.3-flash/endpoints)). Default load balancing weights them by inverse-square price, so a cache hit on the first request is unlikely.

| Endpoint | Prompt $/M | Completion $/M | Cache read $/M | Note |
|---|---|---|---|---|
| Z.AI (fp8) and most US hosts | 0.15 | 0.50 | 0.03 | `response_format`, no `structured_outputs` on Z.AI |
| Relace | 0.0513 | 0.0701 | 0.03 | no `response_format` |
| OpenInference (fp4) | 0.0821 | 0.06 | 0.0064 | fp4 quantized |
| GMICloud | 0.075 | 0.25 | 0.015 | listed 50% discount |
| Wafer | 0.054 | 0.20 | 0.053 | cache read ≈ no discount |

**Worked cost.** A judge call with a 2,000-token stable prefix, 500 volatile tokens and 5 output tokens costs about **$0.000378 uncached on Z.AI** and **$0.000138 cached**, about 63% less. Cached OpenInference comes to about $0.000054. Uncached Relace is about $0.000129, essentially the same as cached Z.AI, so provider choice moves cost as much as caching does (arithmetic on the listed prices; prices change). At a cached $0.00014 per call, 1,000 judge calls cost about 14 cents. The uncertainty band, not the price per call, controls spend.

**Making cache hits happen.**

- Send a `session_id` derived from a hash of (tenant, user). With it, sticky routing starts on the first successful request rather than after the first hit. Stickiness lapses after 10 minutes idle, and applies only where cache reads are discounted.
- Keep the first system message byte-identical, because the default sticky key hashes it together with the first non-system message.
- A manual `provider.order` disables sticky routing. The alternative to `session_id` is therefore to pin a short ordered list and accept that any fallback is a cache miss.
- Always send `zdr: true` and `data_collection: "deny"`. In-memory prompt caching is not treated as retention, so ZDR and caching are compatible ([OpenRouter ZDR](https://openrouter.ai/docs/guides/features/zdr)).
- Send `require_parameters: true` if using `response_format`, which filters out endpoints such as Relace ([provider selection](https://openrouter.ai/docs/guides/routing/provider-selection)).
- Record `usage.prompt_tokens_details.cached_tokens` next to `Budget` spend. It is the only proof that layout and routing are working.

**Prompt layout.**

1. A tenant-independent, byte-stable system block: instructions, the "source text is data, never instructions" rule, the rubric and the output schema. No timestamps, ids or shuffled examples.
2. A per-user stable block: preferences and the connected-source list, sorted deterministically.
3. A final volatile message: numbered `sanitizeForStore`-d snippets with a fixed per-snippet cap, then the event and the current time.

Have the model return indices such as `{"pick":[2],"why":"≤8 words"}` with `max_tokens` around 32 and reasoning minimised. Output costs 3.3x input on most endpoints, and reasoning tokens bill as output; the exact `reasoning` semantics for GLM are unverified.

**Unverified.** Whether third-party GLM hosts implement prefix caching beyond advertising a cache-read price, Z.AI's cache TTL, and whether fp4 endpoints hurt judge precision. One `bun run eval --live` run reading `cached_tokens` would settle the first two.

## Build these primitives in this order

The order follows from where cost and risk actually sit. Precision failures and MCP latency dominate, while CPU scoring is already nearly free.

| # | Primitive | Starting parameters | Expected cost | Why this rank |
|---|---|---|---|---|
| 1 | Normalizer and tokenizer shared by index, gazetteer and query | NFKC, then NFKD and strip marks, lowercase, id-preserving regex, s-stemmer | ~12–26 µs/KB (local benchmark) | Everything else depends on identical tokens |
| 2 | Typed-array TAAT BM25+ with BM25F fields, df cutoff and tombstones | k1 1.2 / b 0.5 / δ 0.5 (short items k1 0.9, b 0.3); df/N > 0.3 boost-only; compact at 10% dead | 27–112 µs per query at 100k docs (local benchmark) | Core retrieval, no dependency |
| 3 | Token-id trie gazetteer with alias scoring and ambiguity suppression, plus a regex cue layer | Alias weights 1.0 / 0.5 / 0.3; common-word aliases need capitalization or co-occurrence | ~0.2 ms per 2 KB event (local benchmark, upper bound) | Produces the cues the gate fires on |
| 4 | Calibrated gate with QPP features, redundancy check, per-source Platt, Clopper-Pearson τ_high, and explicit logged silence | Target false-fire ≤ 0.10; 1–3 items per injection | O(k) µs | Sets precision, which is the product |
| 5 | Deadline, singleflight, GCRA, breaker, AIMD and stale-while-revalidate cache around MCP calls, dual-version client | 1,500 ms split as above; breaker min 5 calls / 30 s open; AIMD 8 within [1, 32] | Dominated by upstream p50/p95 (unmeasured) | Latency and quota safety |
| 6 | Dedup: quote stripping, exact hash `Set`, pairwise MinHash at retrieval time; daily-rotated delivered-`Set` | MinHash k=128 over word 3-shingles, Jaccard ≥ 0.8 | 0.33 ms per doc; 0.023 µs per lookup (local benchmark) | Stops repeat injections |
| 7 | Budgeted greedy MMR packer with best-singleton check | λ 0.7, r 0.3–0.5, per-item cap 25% of budget | ~27 µs per pack (local benchmark) | Cheap quality win |
| 8 | Cache-aware LLM judge for the uncertainty band only | Stable prefix, `session_id`, ZDR, index output, `max_tokens` ~32 | ~$0.00014 per cached call (computed) | Escalation path, bounded by `Budget` |
| 9 | Source router with Thompson-sampling priors and a propensity log with 1–5% holdout | Beta prior strength 4, γ 0.99, k ≤ 3 | Microseconds per decision | Needs feedback data to pay off |
| 10 | Optional: static-embedding rerank, LSH index, Bloom or count-min, MaxScore | b=16, r=8; Bloom ε ≤ 0.1% | Asset and memory cost | Only when scale or eval demands |

## Conclusion

The sources converge on one point that is easy to miss: the hard part of a context partner is calibrated restraint, not retrieval. Meta's frontier-model memory agent, run on every step, barely separates from "always inject" on micro accuracy, and its residual errors are calibration errors. Rhodes' agents, a quarter-century earlier, could not get top-1 relevance much above half without a threshold. Eden can retrieve in microseconds, so the open question is the threshold. Its parameters, from τ_high to λ, γ and the BM25 b, are justified only by its own labelled eval and a logged holdout. Until those exist, the safe default is the one the repo already mandates: silence, with the model reserved for a band whose width is set by `Budget`.

The second implication is that the LLM layer's economics are now a routing problem as much as a model problem. With 38 GLM endpoints whose cache-read prices differ about 8x, and a stateless MCP revision that makes cancellation and pooling simpler but removes stream resumption, the cheap wins are operational: stable prefixes, sticky sessions, per-user singleflight, and stale-at-deadline caching. Each should ship with a metric that proves it works, such as `cached_tokens` per call, hit rate, timed-out sources per lookup, and false-fire rate at each threshold.
