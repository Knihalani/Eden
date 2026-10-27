# Primitives: measured choices

What `@eden/primitives` is built from and why, with every number as the benchmark printed it. Environment: Bun 1.4.4
(JavaScriptCore) and Node 22.22.0 (V8), 4 vCPU Intel Xeon @ 2.10 GHz, shared cloud VM; 2026-10-27. Benchmarks are in
`packages/primitives/bench/` (harness: warmup, 200 timed batches, mean / p50 / p99 per op). Text is a deterministic
email-like corpus (`corpus()` in the harness). Expect ±30% run to run on this VM (an independent reviewer re-ran
them and saw that much); the ratios are stable, the absolute numbers less so. Every table names its benchmark.

## Where the time went before

Per event, the engine tokenizes and extracts entities from the event text and redacts it; per live lookup, it does
the same for each of ~32 returned items. On a benign 2 KB email (`bench/baseline.bench.ts`; the gate "before" is
reconstructed from the same rules with the old per-keyword filter):

| Step | mean | p50 |
|---|---|---|
| Secret gate, before | 131.49 µs | 137.22 µs |
| `contentTerms` (engine tokenizer, Unicode regex) | 51.51 µs | 52.01 µs |
| `extractEntities` (engine) | 48.15 µs | 41.04 µs |
| `String.prototype.normalize("NFKC")` | 48.9 ns | 34.3 ns |
| `toLowerCase` | 3.36 µs | 2.81 µs |
| `Bun.hash` (wyhash) | 163.4 ns | 135.8 ns |
| `TextEncoder.encode` | 1.18 µs | 349.1 ns |

So ~230 µs of CPU per item, ~7 ms per 32-item lookup: the gate and tokenizing were the targets; hashing and
normalization are native and nearly free. (`extractEntities` is retrieval-specific and was left alone.)

## JavaScriptCore findings that shaped the code

`bench/jsc.bench.ts`, one 2 KB string:

| Variant of the same FNV loop | mean |
|---|---|
| Default parameters (`start = 0, end = s.length`) | 13.49 µs |
| Length hoisted, no defaults | 3.50 µs |
| Explicit range, fused `Math.imul(h ^ c, p)` | 2.72 µs |
| Floor: read every char, sum only | 1.94 µs |
| Same read over a string built with `+=` (a rope) | 1.69 µs |

A default parameter cost 5x; ropes cost nothing measurable once read (JavaScriptCore flattens them). Two more, from
the benchmarks below: a per-candidate `TopK.push` is not inlined into the caller's loop (bulk `pushDense` is 3.4x
faster on Bun), and allocating per cache entry and per hit showed up as multi-microsecond p99 spikes that the
allocation-free version does not have (cache section below; not isolated by its own benchmark).

## Hashing (`hash.ts`)

| Hash | 8 B | 64 B | 2 KB |
|---|---|---|---|
| FNV-1a, JS, in place over a string range | 22.2 ns | 82.4 ns | 2.56 µs |
| murmur3, JS, over bytes | 24.7 ns | 63.0 ns | 994.5 ns |
| `Bun.hash` wyhash (native, 64-bit BigInt) | 87.1 ns | 44.3 ns | 172.2 ns |
| `Bun.hash.xxHash32` (native) | 23.5 ns | 24.3 ns | 381.8 ns |
| wyhash truncated to 32 bits via BigInt | 86.9 ns | 67.6 ns | 246.5 ns |

Choice: whole strings → native `xxHash32` (`hashString`; a number, no BigInt). Ranges of a string (tokens) → JS
FNV-1a computed inline while scanning, since a native call would need a `slice` first (`slice` + native murmur:
56.0 ns at 8 B, slower than FNV in place).

## Tokenizer + interner (`charclass.ts`, `vocab.ts`, `tokenize.ts`)

| 2 KB email | mean | p50 | p99 |
|---|---|---|---|
| Engine `contentTerms` (Unicode regex, today) | 64.74 µs | 58.99 µs | 178.10 µs |
| Regex match + `toLowerCase` + `Map` interning | 62.82 µs | 59.75 µs | 124.54 µs |
| `tokenizeInto` (fused, steady state) | 13.53 µs | 12.82 µs | 27.56 µs |
| Same text with 10% accented / CJK words: `contentTerms` | 72.33 µs | 64.71 µs | 262.28 µs |
| … `tokenizeInto` | 13.79 µs | 11.71 µs | 34.48 µs |
| 16 KB: `contentTerms` | 650.67 µs | 609.50 µs | 1684.63 µs |
| 16 KB: `tokenizeInto` | 127.29 µs | 121.93 µs | 200.33 µs |

4.8x faster at 2 KB, 5.1x at 16 KB, and accented text costs the same as ASCII. How it got there
(`bench/vocab.bench.ts`, same 2 KB text, 298 terms):

| Interning design | mean |
|---|---|
| Scan + hash only | 4.56 µs |
| + intern, comparing against string objects | 17.15 µs |
| + intern, comparing against a character arena | 15.31 µs |
| + intern, two-lane fingerprint, no comparison (`Vocab`) | 6.30 µs |

Across three independent re-runs the fingerprint was always fastest (6.5–8.6 µs), but only 1.3–1.7x faster than the
other two, which came out about equal: treat the table's 2.7x as one run's figure.

Accented terms first went through `normalize` + regex per term (29.95 µs for the 10% non-ASCII text, an earlier run);
a lazily filled per-character fold table (NFKD, marks dropped, lowercased, cached per code unit) brought that to the
ASCII cost.

Semantics (one definition for every consumer): a term starts with a letter or digit, continues through letters,
digits, combining marks, `'`, `_`, `-`; folded; trailing possessive and punctuation trimmed; one-character terms
dropped. CJK runs are one term (no word segmentation); emoji separate terms.

## Multi-pattern matching (`matcher.ts`)

244 gitleaks keywords (1,281 DFA states):

| Text | `includes` loop | one regex alternation (`/k1\|k2…/gi`) | `MultiMatcher` |
|---|---|---|---|
| 256 B | 10.18 µs | 4.47 µs | 1.44 µs |
| 2 KB | 53.71 µs | 34.76 µs | 6.29 µs |
| 16 KB | 1001.68 µs | 327.24 µs | 61.94 µs |

A dense DFA with a compressed alphabet (one column per character that occurs in a pattern) beats JavaScriptCore's
JIT-compiled regex alternation by 5.5x at 2 KB.

## The secret gate (`packages/redact`)

Same rules, same findings (`prefilter.test.ts` compares every rule's result against the old per-keyword filter on
318 texts with and without secrets). Keyword-less rules got literals every match contains (`sk-`, `://`, …):

| Text | before (`includes` per keyword) | after (Aho–Corasick prefilter) | speed-up |
|---|---|---|---|
| 256 B | 36.33 µs | 7.33 µs | 5.0x |
| 2 KB | 124.53 µs (p50 127.82) | 15.11 µs (p50 13.21) | 8.2x |
| 16 KB | 1638.95 µs | 195.35 µs | 8.4x |

(`bench/gate.bench.ts`.) The reviewer's independent run measured 2 KB 110.4 → 20.6 µs (5.4x), 256 B 4.4x, 16 KB 11.2x:
the gain is 4–11x depending on run and size, not one number.

What remains at 2 KB is the matcher (~6 µs) and the structural redactor `redact()` (~9 µs).

## Top-k (`topk.ts`)

| 10k candidates, k = 10 | Bun | Node 22 |
|---|---|---|
| `push` per candidate | 55.07 µs | 57.46 µs |
| `pushDense` | 16.00 µs | 54.33 µs |
| `Array.sort` + `slice` | 1844.13 µs | 2906.23 µs |

(`bench/topk.bench.ts`; Node: the same file bundled with `bun build --target=node`.) An earlier Node run measured
17.25 µs per candidate: Node's numbers were the noisier of the two here.

## Cache (`cache.ts`): S3-FIFO vs LRU

Hit ratio, 400k requests:

| Trace | `S3FifoCache` | `Map` LRU | `lru-cache@11` |
|---|---|---|---|
| Zipf 0.8, 100k keys, cache 10k | 0.5347 | 0.4658 | 0.4658 |
| Zipf 1.0, 100k keys, cache 1k | 0.5964 | 0.5068 | 0.5068 |
| 50% one-hit wonders + Zipf hot set, cache 1k | 0.3659 | 0.2721 | 0.2721 |

(`bench/compare/cache.compare.ts`, which needs `lru-cache` installed outside the repo.) Throughput (get, set on miss;
Zipf 0.9, cache 10k): `S3FifoCache` mean 176.2 ns (p50 116.6, p99 2.22 µs);
`lru-cache@11` 181.1 ns (p50 150.8, p99 1.16 µs); a `Map` LRU 4.59 µs. The first object-per-entry version was 255 ns
with 4.6 µs p99; struct-of-arrays slots and ring buffers removed the allocation. `lru-cache` stays a fine choice where
LRU is enough; S3-FIFO is kept for its 15–35% relative hit-ratio gain on skewed and one-hit-heavy traffic, which is
what lookup results look like.

## Bun vs Node for the same TypeScript

`bench/runtime.sh` (the same file under both runtimes; Node runs a `bun build --target=node` bundle):

| Primitive | Bun 1.4.4 | Node 22.22.0 |
|---|---|---|
| `tokenizeInto` 2 KB ASCII | 15.69 µs | 13.94 µs |
| `tokenizeInto` 2 KB +10% non-ASCII | 10.61 µs | 14.32 µs |
| `MultiMatcher.markHits` 11 keywords, 2 KB | 6.86 µs | 9.55 µs |
| `S3FifoCache` get/set | 476.1 ns | 376.3 ns |
| `TopK(10)` `pushDense` over 10k | 20.18 µs | 68.20 µs |

Neither runtime wins across the board; differences are within 1.5x except top-k. The runtime is not the lever;
algorithms and data layout are. Bun stays (native hashing, `bun:sqlite`, test runner, no build step). Native code
(Rust) is evaluated separately in [language-choice.md](language-choice.md).

## Engine integration: measured end to end

Primitives are judged by what they do to the engine, not by their own microbenchmarks. Two anchors in
`packages/engine/bench/`: `pipeline.bench.ts` (one user, 6,000 items across 4 sources, 2,000 events, instant sources,
sequential) and `concurrent.bench.ts` (200 users with cold caches, events open-loop at 400/s, sources answering in
50–250 ms, so lookups overlap the way they do in production). Both use the real `ContextPartner` with no model.

**Item cache on `SparseIndex`** (`sparse-index.ts`; `bench/sparse-index.bench.ts`, 2,000 docs, one user's cap):

| Corpus | `SparseIndex.search` top 24 | Map BM25 + sort | `SparseIndex` remove + add | Map remove + add |
|---|---:|---:|---:|---:|
| Zipf, 30,000 term types | 14.55 µs | 153.82 µs | 19.27 µs (p50 9.28) | 63.68 µs |
| Dense, 186 term types (worst case) | 147.96 µs | 1082.32 µs | 10.39 µs (p50 4.60) | 28.05 µs |

Top scores are checked equal before timing. The churn p99 (~100–150 µs) is compaction, amortized over ~10% of
postings. Term-at-a-time with a dense accumulator and stamp-tagged scratch beats a `Map` accumulator for the reason
fast-primitives.md gives (one object per matched doc); MiniSearch accumulates that way.

**Per-event path.** Profiling `concurrent.bench.ts` (`bun --cpu-prof`) put the usage check and session memory at 37%
of CPU: the same event text was tokenized up to four times (usage check, memory, chatter test, cue), and memory did
a `Set` delete and add per token occurrence. `distinctTermIds` tokenizes once and dedupes with a stamp array; every
consumer shares the result. `pipeline.bench.ts` fast-path `observe` p50 went from 72.0–81.2 µs to 48.0–50.0 µs,
0.311–0.371 to 0.281–0.287 ms per event, with eval metrics unchanged (precision 0.667, recall 0.667, false-fire
rate 0). Earlier in this round the same bench went from 1.218 to ~0.30 ms per event (SparseIndex cache, item terms
tokenized once at write, prepared-statement reuse, one transaction per lookup's mentions).

**Source-map writes** (scratch `sq.ts`, 4,000 upserts into `utility`):

| Store | 1 per transaction | 16 per transaction |
|---|---:|---:|
| `:memory:` | 3.0 µs | 2.4 µs |
| file, WAL, synchronous=FULL (SQLite's default) | 190.0 µs | 21.1 µs |
| file, WAL, synchronous=NORMAL | 17.9 µs | 2.1 µs |

Production uses a file, so every inferred outcome cost ~190 µs on the event loop. `SourceMap` now sets
synchronous=NORMAL and writes outcomes behind (buffered, one transaction within 10 ms or at 256 rows; every read
flushes first).

**Bounded state.** A session's vocabulary is its own (rebuilt past `maxSessionTerms`, keeping seen terms and the terms
of injections awaiting use): before, event text was interned into the user's cache vocabulary, which never shrinks,
so tool output full of ids grew it for as long as the user stayed cached (`partner.test.ts` pins it: 19 terms, not
521). The engine reads the first `maxEventChars` (32,000) of an event, cut at whitespace so half a secret is never
stored (a JWT cut before its signature escapes the redactor).

**Worker pool (D26).** With the pool wired in (`pooledSanitizer`), `concurrent.bench.ts` showed no steady-state gain:
observe p99 0.53–0.77 ms with 3 workers against 0.68–0.71 ms inline, CPU 3–8 points higher; through the cold-start
burst (every user's first lookup at once) 7.0–7.5 ms against 9.4–9.7 ms. Redacting items was ~9% of lookup CPU;
tokenizing, indexing and sketching stay on the loop because the index does. Yielding to the loop between one
lookup's sources gave a small gain in steady-state observe p99 (0.64–0.83 against 0.77–1.18 ms over three runs
each) and none in lag. Run-to-run noise on this VM is about the size of these differences.

## Library choices

| Need | Considered | Chosen | Why |
|---|---|---|---|
| Hashing | JS murmur/FNV, `Bun.hash.*` | native for whole strings, JS FNV for ranges | table above |
| Tokenizing | Unicode regex, `Intl.Segmenter` (~37 µs/KB per the research notes) | hand-written scanner | 4.8x over regex |
| Multi-pattern | `includes` loop, regex alternation, npm Aho–Corasick packages | own dense DFA | 5.5x over the best alternative; no dependency |
| Cache | `lru-cache`, `mnemonist` LRU, `Map` LRU | own S3-FIFO | hit ratio; equal throughput to `lru-cache` |
| Resilience | `opossum` (breaker), `p-limit`, `bottleneck` | own, small | each is <150 lines; time-windowed breaker for low per-user volume; GCRA instead of timers |
| Top-k | sort, `heap-js` | own typed-array heap | 115x over sort; bulk API for JavaScriptCore |
| Worker pool | tinypool, piscina, workerpool | own `WorkerPool` | batching: 7–9x less main-thread CPU per task; workerpool does not run on Bun ([architecture-alternatives.md](architecture-alternatives.md)) |

Not measured: `mnemonist` and the npm Aho–Corasick packages (installed, not benchmarked for lack of time), `heap-js`,
`opossum`, `bottleneck`.
