# @eden/primitives

The building blocks every direction of Eden needs, whatever retrieval or decision design wins: hashing, one shared
term definition (tokenizer + interner), multi-pattern matching, top-k, a bounded cache, and the latency/resilience
layer for slow upstreams. Each is benchmarked against the obvious alternatives (`bench/`); the measured tables and the
choices they drove are in [docs/research/primitives.md](../../docs/research/primitives.md).

| Module | What | Use it for |
|---|---|---|
| `hash.ts` | FNV-1a (in-place over a string range), murmur3 (bytes), `mix32`, `hashString` (native xxHash32) | Hash tables, sketches, dedup keys |
| `charclass.ts` | Per-code-unit class and fold tables (lowercase, accents dropped), filled lazily | Anything that scans text |
| `vocab.ts` | `Vocab`: term ↔ dense id, 64-bit fingerprint identity, range lookups without slicing | Indexes, sets, counters keyed by term |
| `tokenize.ts` | `tokenizeInto`: fused scan + fold + hash + intern into a `Uint32Array` | Indexing, queries, usage tracking |
| `matcher.ts` | `MultiMatcher`: folded Aho–Corasick dense DFA, optional whole-word | Keyword prefilters, cue lists, small gazetteers |
| `topk.ts` | `TopK`: typed-array heap, `pushDense` for accumulators | Ranking |
| `cache.ts` | `S3FifoCache`: S3-FIFO eviction, byte budget, stale/expire TTLs, no per-op allocation | Item caches, MCP result caches, negative caches |
| `deadline.ts` | `Deadline`: one absolute deadline, child slices, one AbortSignal | Every multi-stage operation |
| `singleflight.ts` | `Singleflight`: coalesce identical in-flight calls; last waiter leaving aborts | Duplicate lookups to the same source |
| `gcra.ts` | `Gcra`: rate limiting, O(1) state per key, Retry-After penalties | Per tenant / user × upstream / host limits |
| `breaker.ts` | `CircuitBreaker`: time-windowed failure rate, half-open probe | Failing upstreams |
| `limiter.ts` | `AimdLimiter`: adaptive concurrency limit | Fan-out to upstreams of unknown capacity |
| `histogram.ts` | `Histogram`, `RollingHistogram`: log-linear, ~3% precision, 4 KB | p95/p99 for hedging, slow-call thresholds, metrics |
| `sparse-index.ts` | `SparseIndex`: term-at-a-time BM25 / BM25F (per-field weights and `b`, BM25+ delta), query coverage, tombstones with compaction | The engine's item cache |
| `utf8.ts` | `utf8Length`, `truncateUtf8`: byte budgets without encoding, surrogate-safe | Injection and prompt byte limits |
| `reply.ts` | `splitReply`, `stripReply`, `dedupText`: quotes, signatures, greetings and forwards marked per line | The text an item adds of its own, for dedup |
| `dedup.ts` | `TextSketcher` (shingles, SimHash, MinHash, number key), `MinHashIndex` (LSH), `hamming64` | Near-duplicate items |
| `sketch.ts` | `ExpiringSet`: windowed set of 64-bit keys in typed arrays | Seen-recently checks without a `Map` per key |
| `stats.ts` | Incomplete beta and its inverse, Clopper–Pearson bounds, `minTrialsToCertify` | Certifying a false-fire rate from counts |
| `calibrate.ts` | Platt and isotonic calibration, ECE, thresholds for a target precision or false-fire rate | Turning scores into probabilities the decision can trust |
| `random.ts` | `Xoshiro128`: seedable PRNG with normal, gamma and beta draws | Thompson sampling, reproducible tests |
| `bandit.ts` | `BetaBandit` (Thompson sampling with decay and propensities), `ipsValue` | Source routing that keeps exploring |
| `pack.ts` | `Packer`: budgeted selection with diversity (MMR-style), `jaccardMatrix` | Choosing what fits in an injection |
| `pool.ts` | `WorkerPool`: Bun workers, batching per message, bounded queue, per-batch deadline, inline below a cost | CPU-bound pure work off the event loop (D25, D26: opt-in) |

## Rules this package follows (measured, not folklore)

- **No default parameters in hot functions.** On JavaScriptCore a default parameter in a loop function cost 5x
  (13.49 µs vs 2.72 µs per 2 KB; `bench/jsc.bench.ts`).
- **Typed arrays over objects** for anything per item (heap, cache slots, interner): no GC pauses in p99.
- **No per-call allocation** on hot paths (`S3FifoCache.get` returns the value, not `{value, stale}`).
- **Bulk calls over per-item calls** where JavaScriptCore does not inline (`TopK.pushDense` is ~3.4x faster than a
  `push` per candidate).
- **Native when it is native**: `Bun.hash.xxHash32` / wyhash for whole strings; JS only where a native call cannot be
  made without allocating (hashing a range of a string).

Run a benchmark: `bun packages/primitives/bench/<name>.bench.ts`. Numbers vary ±30% run to run on a shared VM.
