# Primitives: measured choices

What `@eden/primitives` is built from and why, with every number as the benchmark printed it. Environment: Bun 1.4.4
(JavaScriptCore) and Node 22.22.0 (V8), 4 vCPU Intel Xeon @ 2.10 GHz, shared cloud VM; 2026-10-27. Benchmarks are in
`packages/primitives/bench/` (harness: warmup, 200 timed batches, mean / p50 / p99 per op). Text is a deterministic
email-like corpus (`corpus()` in the harness), made flat (not a rope) as JSON or network input would be. Expect ±30%
run to run on this VM; the ratios are stable, the absolute numbers less so.

## Where the time went before

Per event, the engine tokenizes and extracts entities from the event text and redacts it; per live lookup, it does
the same for each of ~32 returned items. On a benign 2 KB email (first measurement, before any change):

| Step | µs/op |
|---|---|
| `sanitizeForStore` (secret gate) | 107.4 |
| `contentTerms` (engine tokenizer, Unicode regex) | 75.3 |
| `extractEntities` | 85.2 |
| `String.prototype.normalize("NFKC")` | 0.1 |
| `toLowerCase` | 3.8 |
| `Bun.hash` (wyhash) | 0.2 |
| `TextEncoder.encode` | 3.1 |

So ~270 µs of CPU per item, ~8.5 ms per 32-item lookup: tokenizing and redaction were the targets, not hashing or
normalization (native and nearly free).

## JavaScriptCore findings that shaped the code

| Finding | Measurement (2 KB) |
|---|---|
| A default parameter (`end = s.length`) in a hot loop function | 14.12 µs vs 2.82 µs without (5x) |
| Hoisting `length` and fusing the multiply | 3.66 → 2.82 µs |
| Floor for any JS scan: reading every char with `charCodeAt` | 2.10 µs (~1 ns/char) |
| Strings built with `+=` are ropes; `charCodeAt` over a rope | ~6 ns/char until flattened |
| `TopK.push` per candidate is not inlined into the caller's loop | 47.8 µs vs 14.2 µs with a bulk `pushDense` (10k candidates) |
| Returning `{ value, stale }` from a cache `get` | allocation per hit; p99 GC spikes (5.6 µs) |

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

4.8x faster at 2 KB, 5.1x at 16 KB, and accented text costs the same as ASCII. How it got there, measured on the same
2 KB text (298 terms): scan + hash alone 4.2–4.6 µs; + interning against string objects 13.4 µs; against a character
arena 12.1 µs; with a 64-bit two-lane fingerprint and no character comparison 8.6 µs. Accented terms first went
through `normalize` + regex per term (29.95 µs for the 10% non-ASCII text); a lazily filled per-character fold table
(NFKD, marks dropped, lowercased, cached per code unit) brought that to 11.54 µs.

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

| Text | before (`includes` per keyword) | after (Aho–Corasick prefilter) |
|---|---|---|
| 256 B | 36.33 µs | 7.33 µs |
| 2 KB | 124.53 µs (p50 127.82) | 15.11 µs (p50 13.21) |
| 16 KB | 1638.95 µs | 195.35 µs |

What remains at 2 KB is the matcher (~6 µs) and the structural redactor `redact()` (~9 µs).

## Top-k (`topk.ts`)

| 10k candidates, k = 10 | Bun | Node 22 |
|---|---|---|
| `push` per candidate | 55.07 µs | 57.46 µs |
| `pushDense` | 16.00 µs | 54.33 µs |
| `Array.sort` + `slice` | 1844.13 µs | 2906.23 µs |

(Node runs: same code bundled with `bun build --target=node`.) An earlier Node run measured 17.25 µs per-candidate;
Node's numbers were the noisier of the two here.

## Cache (`cache.ts`): S3-FIFO vs LRU

Hit ratio, 400k requests:

| Trace | `S3FifoCache` | `Map` LRU | `lru-cache@11` |
|---|---|---|---|
| Zipf 0.8, 100k keys, cache 10k | 0.5347 | 0.4658 | 0.4658 |
| Zipf 1.0, 100k keys, cache 1k | 0.5964 | 0.5068 | 0.5068 |
| 50% one-hit wonders + Zipf hot set, cache 1k | 0.3659 | 0.2721 | 0.2721 |

Throughput (get, set on miss; Zipf 0.9, cache 10k): `S3FifoCache` mean 176.2 ns (p50 116.6, p99 2.22 µs);
`lru-cache@11` 181.1 ns (p50 150.8, p99 1.16 µs); a `Map` LRU 4.59 µs. The first object-per-entry version was 255 ns
with 4.6 µs p99; struct-of-arrays slots and ring buffers removed the allocation. `lru-cache` stays a fine choice where
LRU is enough; S3-FIFO is kept for its 15–35% relative hit-ratio gain on skewed and one-hit-heavy traffic, which is
what lookup results look like.

## Bun vs Node for the same TypeScript

| Primitive | Bun 1.4.4 | Node 22 |
|---|---|---|
| `tokenizeInto` 2 KB ASCII | 13.42 µs | 11.93 µs |
| `tokenizeInto` 2 KB +10% non-ASCII | 11.83 µs | 12.02 µs |
| `MultiMatcher.markHits` 244 kw, 2 KB | 7.32 µs | 9.27 µs |
| `S3FifoCache` get/set | 383.9 ns | 328.5 ns |

Within noise of each other for this code: the runtime is not the lever; algorithms and data layout are. Bun stays
(native hashing, `bun:sqlite`, test runner, no build step). Native code (Rust) is evaluated separately in
[language-choice.md](language-choice.md).

## Library choices

| Need | Considered | Chosen | Why |
|---|---|---|---|
| Hashing | JS murmur/FNV, `Bun.hash.*` | native for whole strings, JS FNV for ranges | table above |
| Tokenizing | Unicode regex, `Intl.Segmenter` (~37 µs/KB per the research notes) | hand-written scanner | 4.8x over regex |
| Multi-pattern | `includes` loop, regex alternation, npm Aho–Corasick packages | own dense DFA | 5.5x over the best alternative; no dependency |
| Cache | `lru-cache`, `mnemonist` LRU, `Map` LRU | own S3-FIFO | hit ratio; equal throughput to `lru-cache` |
| Resilience | `opossum` (breaker), `p-limit`, `bottleneck` | own, small | each is <150 lines; time-windowed breaker for low per-user volume; GCRA instead of timers |
| Top-k | sort, `heap-js` | own typed-array heap | 115x over sort; bulk API for JavaScriptCore |

Not measured: `mnemonist` and the npm Aho–Corasick packages (installed, not benchmarked for lack of time), `heap-js`,
`opossum`, `bottleneck`.
