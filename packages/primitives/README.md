# @eden/primitives

The building blocks every direction of Eden needs, whatever retrieval or decision design wins: hashing, one shared
term definition (tokenizer + interner), multi-pattern matching, top-k, a bounded cache, and the latency/resilience
layer for slow upstreams. Each is benchmarked against the obvious alternatives (`bench/`); the measured tables and the
choices they drove are in [docs/research/primitives.md](../../docs/research/primitives.md).

| Module | What | Use it for |
|---|---|---|
| `hash.ts` | FNV-1a (in-place over a string range), murmur3 (bytes), `mix32`, `hashString` (native xxHash32) | Hash tables, sketches, dedup keys |
| `charclass.ts` | Per-code-unit class and fold tables (lowercase, accents dropped), filled lazily | Anything that scans text |
| `vocab.ts` | `Vocab`: term ↔ dense id, 64-bit fingerprint identity, range lookups without slicing, `release` (ids reused) | Indexes, sets, counters keyed by term |
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
| `sparse-index.ts` | `SparseIndex`: term-at-a-time BM25 / BM25F (per-field weights and `b`, BM25+ delta), query coverage, tombstones with compaction that reports freed terms (`onTermFreed`) | The engine's item cache |
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

## Term release (2026-11-03)

`Vocab.release` (backward-shift delete, free list), `SparseIndex`'s `onTermFreed`/`flush`/`termCount`, and
`TextSketcher` hashing an id again after its release let a per-user vocabulary follow its live items instead of growing
until the engine rebuilds it (`CacheLimits.releaseTerms` in `packages/engine/src/cache.ts`, off by default).
`SparseIndex`'s insert and query scratch (24 bytes per term id, per index before) is now one copy per process.
Before/after on the same VM, p50:

| Benchmark | Before | After |
|---|---|---|
| `vocab.bench.ts` `Vocab.lookup`, 43 known terms (median of 5 alternating runs) | 1.23 µs | 1.20 µs |
| `vocab.bench.ts` intern a new term and release the oldest, 4,096 live (new row) | – | 332 ns |
| `sparse-index.bench.ts` zipf search / remove + add (median of 5 alternating runs) | 13.33 / 9.88 µs | 12.93 / 10.98 µs |
| `sparse-index.bench.ts` dense search / remove + add (median of 5 alternating runs) | 63.99 / 3.22 µs | 75.05 / 4.23 µs |
| Old and new classes interleaved in one process (6 rounds, median): dense search | 50.48 µs | 43.31 µs |
| Same: dense remove + add (two fields, 155 terms) | 6.80 µs | 6.53 µs |
| Same: `TextSketcher` load + simhash 300 B / load 2 KB | 3.85 / 11.13 µs | 3.99 / 11.52 µs |
| `dedup.bench.ts` load rows across processes | bimodal: ≈210 or ≈420 ns at 300 B | the same two modes |

Separate processes differ by up to 2x for identical code (JIT tiering), so the interleaved rows are the comparison to
trust: no measurable change on the hot paths. The gain is in `packages/engine/bench/churn.bench.ts` (a heavy user
streaming lookups through the cap): with release on, the worst put fell from 174–208 ms (a whole-user rebuild) to
13–21 ms at Zipf s=1.3 and from 285–361 ms to 30–32 ms at s=1.15; the churned user holds 1.07x (s=1.3) and 1.21x
(s=1.15) the heap of a fresh build of the same live items, against 1.50x and 1.55x with release off.
