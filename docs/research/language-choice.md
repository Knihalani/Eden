# Language choice for Eden's hot kernels: measured

Should Eden's per-event CPU work (secret redaction, tokenization, hashing) stay in TypeScript on Bun, use Bun's
native built-ins, or move to Rust through `bun:ffi`, WebAssembly or Node-API? This note answers with numbers from
`native/` (a Rust crate, a napi-rs crate and TypeScript harnesses; see [native/README.md](../../native/README.md)).
Every number below was printed by a command run in the session that wrote this note; anything not measured is
labelled **unmeasured**.

## Summary

| Kernel | Recommendation | Why (median of 3 runs, 2 KiB email) | Break-even input size |
|---|---|---|---|
| Secret gate (`secretHits` / `sanitizeForStore`) | **Move to Rust** behind **Node-API (napi-rs)**; WASM as the portable fallback. Meanwhile, a one-regex keyword gate in TS halves the cost | TS full gate 96.7 µs, TS gitleaks rules 80.0 µs, TS with one-regex keyword gate 46.6 µs, Rust FFI 8.0 µs, Rust WASM 14.4 µs | Rust wins at every measured size (256 B: 1.8 µs vs 27.9 µs); below 256 B not measured |
| Tokenize + murmur3 | **Stay TS** for now; put it in the Rust module only if the secret gate moves there anyway | TS 15.1 µs, Rust FFI 4.1 µs, napi 6.2 µs, WASM 7.2 µs (ASCII); non-ASCII TS 22.9 µs vs FFI 13.6 µs. Saving ≈ 10 µs per 2 KiB event | ≈ 93 B ASCII, ≈ 290 B ~10% non-ASCII (linear fit from two measured sizes, **not measured directly**) |
| Whole-string hash | **Bun built-in**: `Bun.hash` (wyhash) when any 64-bit hash will do; murmur3 via `Bun.hash.murmur32v3(bytes)` or TS | 2 KiB ASCII: wyhash 0.155 µs, `murmur32v3(bytes)` 0.924 µs, TS murmur3 1.218 µs, Rust FFI murmur3 1.115 µs | Rust never wins by more than ~1.6x; not worth a boundary |
| NFKC normalisation | **Bun built-in** (`String.prototype.normalize`) | ASCII 0.043 µs (fast path), non-ASCII 2.113 µs | no native alternative measured |
| String marshalling into native code | `TextEncoder.encodeInto` a reused buffer for UTF-8; `Buffer.write(str, "utf16le")` for UTF-16 when the text is non-ASCII; never a `charCodeAt` loop | 16 KiB ASCII: encodeInto 0.345 µs, utf16le 0.853 µs, charCodeAt loop 18.3 µs | — |

`target-cpu=native` only helps loops the compiler can vectorise (byte sum over 16 KiB: 1926.5 ns → 708 ns); it
made no consistent difference to the tokenizer or the scanner, and it ties the binary to this CPU (AVX-512), so
ship the portable build.

## Environment

- 4 vCPU Intel Xeon @ 2.10 GHz (AVX2, AVX-512F/BW, BMI2), L2 8 MiB, 15 GiB RAM, Linux 6.18.44, shared VM.
- Bun 1.4.4 (JavaScriptCore), Node v22.22.0 (V8), rustc/cargo 1.97.0, clang 18.1.3.
- Rust release profile: `opt-level = 3`, `lto = "fat"`, `codegen-units = 1`, `panic = "abort"`; a second build
  with `RUSTFLAGS="-C target-cpu=native"`. Crates: `regex` 1.13.1, `aho-corasick` 1, `toml` 0.8, `serde` 1;
  `napi` 3 / `napi-derive` 3 for the Node-API crate. `wasm32-unknown-unknown` installed from rustup over the
  network without trouble; no wasm-bindgen or wasm-opt (raw exports).
- Artifacts: cdylib 2,545,176 B (2,555,336 B with target-cpu=native), WASM 1,630,832 B, napi addon 2,519,520 B.

## Method

- **Text.** `native/bench/lib/gen.ts`: a fixed-seed (mulberry32) generator of email-like sentences with common
  words, names ("Dana Lee", "Priya Raman", "Globex"), ticket ids (OPS-142), emails, URLs, dates and amounts,
  trimmed to 256 B, 2 KiB and 16 KiB of UTF-8. The non-ASCII variant swaps in accented and CJK names and phrases
  ("José Muñoz", "山田太郎", "会議の資料"): measured non-ASCII share of characters 12.3% / 8.1% / 8.2% at the three
  sizes.
- **Timing.** `native/bench/lib/harness.ts`: 150 ms (≥ 200 calls) warm-up, then 2000 samples; a sample repeats the
  op until it lasts ≥ 5 µs (≥ 50 µs for the call-overhead rows), so p50/p99 for sub-5 µs ops are over small
  batches (the `ops/sample` column). Results are folded into a sink so nothing is dead-code eliminated.
- **Every op is end to end** from a JS string to a JS-visible result: marshalling is always included.
- **Runs.** `native/run-all.sh` was run three times back to back (runs A, B, C). The machine is noisy: single cells
  swing 1.5-2x between runs (for example TS tokenize of 256 B ASCII: 1.534 / 2.106 / 1.945 µs). Tables in the
  body give the **median across the three runs of each run's mean** (from `bench/summarize.ts`); Appendix A has
  every run's mean and p50 for every row; Appendix B is run A's output verbatim, with p99.

## Correctness cross-checks

`bun native/bench/verify.ts` (run A output in Appendix B; runs B and C printed the same counts and verdict):

- **Tokenizer.** TS, Rust via FFI (UTF-8 and UTF-16 entry points) and Rust via WASM produce **identical hash
  arrays** on 9 texts (3 edge-case strings with final sigma, `İ`, supplementary letters, combining marks, Arabic
  digits, emoji; plus the 6 benchmark texts). `bench/napi.ts` checks the napi addon on the 6 benchmark texts, and
  `verify.ts` the TS-scan-plus-`Bun.hash.murmur32v3` variant: also identical.
- **murmur3.** 5270 words: TS = Rust = `Bun.hash.murmur32v3` (which hashes a string's UTF-8 bytes).
- **Secret scanning.** On 23 texts (6 benign texts at 3 sizes × 2 scripts, the three-secret text, one text per
  secret shape for 15 providers, and one text with all 15 shapes), the Rust scanner via FFI, via FFI with a
  RegexSet pre-pass, and via WASM fire **exactly the same gitleaks rules** as the TS gate's gitleaks rules:
  **0 disagreements**. The comparison is restricted to gitleaks rules because Eden's own `eden-*` rules were not
  ported (they use `(?!...)` lookaheads, which Rust `regex` lacks); they fired on 5 of the 23 texts in TS only.
- **Keyword gate.** The one-regex TS keyword gate (below) selects the same rules as `includes` and yields the same
  hits on all 23 texts: 0 mismatches.

Secret-shaped strings are assembled at run time from split prefixes and a seeded PRNG (`bench/lib/corpus.ts`); no
literal in the tree is a secret.

## 1. bun:ffi call overhead

Median of the three runs' means, ns per call:

| Case | portable build | target-cpu=native build |
|---|---:|---:|
| JS empty function (baseline) | 3.1 | 3.7 |
| `ffi noop()` | 8.5 | 6.6 |
| `ffi sum_bytes(Uint8Array, 256)` | 58 | 16.5 |
| `ffi sum_bytes(cached ptr number, 256)` | 41.1 | 16.7 |
| `ffi sum_bytes(ptr(arr) per call, 256)` | 44.4 | 26.5 |
| JS loop summing 256 bytes | 192 | 145.6 |
| `ffi sum_bytes(Uint8Array, 2048)` | 318.6 | 84.4 |
| `ffi sum_bytes(Uint8Array, 16384)` | 1926.5 | 708 |
| napi-rs `noop()` on Bun (p50) | 138.6 (55.2) | — |
| napi-rs `noop()` on Node 22 (p50) | 26.4 (23.1) | — |
| napi-rs `sumBytes(Uint8Array 256)` on Bun (p50) | 466.2 (344.8) | — |
| napi-rs `sumBytes(Uint8Array 256)` on Node 22 (p50) | 263.4 (236.7) | — |

- **A `bun:ffi` call costs ≈ 4-6 ns over a JS call** (noop 6.6-8.5 ns vs 3.1 ns). Passing a `Uint8Array` is
  handled in-engine; with the native build, where the byte loop is vectorised, a 256-byte call totals 16.5 ns, so
  argument conversion is at most ~10 ns. Calling `ptr(arr)` per call adds ~10 ns.
- **Node-API is an order of magnitude more per call**: 23-55 ns p50 for a noop, and 237-345 ns p50 to accept one
  typed array (napi's typed-array argument path). It only matters for calls on tiny inputs.
- The portable build's byte sum is not vectorised for AVX2 (baseline x86-64 is SSE2), which is the 58 vs 16.5 ns
  difference; it is the only kernel where `target-cpu=native` clearly mattered.

## 2. String marshalling

JavaScriptCore stores a string either as 8-bit Latin-1 or as 16-bit UTF-16. ASCII text is 8-bit, so UTF-8 encoding
it is a copy; non-ASCII text is 16-bit, so `Buffer.write(str, "utf16le")` is a copy. Median of means, µs per
16 KiB, with ns per KiB of UTF-8:

| Method | ASCII 16 KiB µs | ns/KiB | non-ASCII 16 KiB µs | ns/KiB |
|---|---:|---:|---:|---:|
| `TextEncoder.encodeInto` into a reused `Uint8Array` | 0.345 | 22 | 3.245 | 203 |
| `Buffer.write(str, "utf16le")` into a reused Buffer | 0.853 | 53 | 0.759 | 47 |
| `Buffer.from(str)` (allocates; p50 in brackets) | 10.816 (0.892) | 676 | 13.009 (3.737) | 813 |
| `TextEncoder.encode(str)` (allocates; p50 in brackets) | 11.473 (0.904) | 717 | 13.06 (2.83) | 816 |
| `charCodeAt` loop into a reused `Uint16Array` | 18.291 | 1143 | 17.596 | 1100 |

- **Cheapest per KB:** `encodeInto` for ASCII, `utf16le` for non-ASCII (it never transcodes). The allocating
  methods have a fine p50 but a 10x worse mean from GC tails (p99 414-548 µs at 16 KiB across the three runs).
- A hand-written UTF-16 copy loop is the slowest option by 20-50x. That is also why the "Rust FFI (UTF-16
  charCodeAt loop)" tokenizer rows below lose to the UTF-8 path.
- End to end into Rust at 256 B (encode + call + sum), ASCII: 0.169 µs via encodeInto, 0.081 µs via utf16le.

## 3. Tokenize + murmur3

Spec (identical in `bench/lib/tokenize.ts` and `eden-native/src/tokenize.rs`): a token starts at a letter (Unicode
`Alphabetic`) or digit (category N), continues over letters, digits, `'`, `_`, `-`; it is lowercased
(`toLowerCase` / `str::to_lowercase`, final sigma included); a trailing `'s` is stripped; tokens of ≤ 1 code
point are dropped; each yields murmur3 x86_32 (seed 0) of its UTF-8 bytes into a caller's `Uint32Array`. The TS
version is a `charCodeAt` scanner with an ASCII fast path that hashes code units directly; Rust hashes ASCII tokens
with an in-register lowercase and reuses one buffer for non-ASCII tokens.

Median of the three runs' means, µs per text, end to end:

| Input | TS (Bun) | TS scan + `Bun.hash.murmur32v3` per token | Rust FFI (encodeInto) | Rust FFI (UTF-16 loop) | Rust WASM (Bun) | napi-rs (Bun, string arg) | TS (Node 22) | Rust WASM (Node 22) | napi-rs (Node 22, string arg) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| ASCII 256 B | 1.945 | 6.053 | 1.03 | 1.811 | 1.663 | 1.187 | 2.793 | 1.52 | 0.951 |
| ASCII 2 KiB | 15.076 | 36.941 | 4.119 | 9.384 | 7.194 | 6.16 | 13.373 | 5.874 | 7.192 |
| ASCII 16 KiB | 127.488 | 349.905 | 45.956 | 82.658 | 96.877 | 42.422 | 167.888 | 73.83 | 53.479 |
| non-ASCII 256 B | 2.946 | 5.678 | 3.108 | 3.583 | 4.072 | 2.232 | 10.14 | 3.077 | 2.514 |
| non-ASCII 2 KiB | 22.9 | 38.375 | 13.633 | 17.567 | 20.364 | 12.737 | 70.955 | 19.217 | 15.21 |
| non-ASCII 16 KiB | 212.301 | 381.705 | 121.327 | 158 | 194.984 | 116.666 | 719.772 | 184.21 | 165.429 |

The target-cpu=native FFI build gave 1.082 / 4.28 / 39.297 µs (ASCII) and 2.206 / 15.648 / 130.086 µs
(non-ASCII): within run-to-run noise of the portable build.

- **Rust FFI is 1.9-3.7x faster than TS on ASCII and ~1.7x on non-ASCII from 2 KiB**; at 256 B non-ASCII it is a tie
  (3.108 vs 2.946 µs). In absolute terms it saves about 11 µs per 2 KiB ASCII event.
- **napi-rs matches bun:ffi** for this kernel (6.16 vs 4.119 µs at 2 KiB ASCII, 42.4 vs 46.0 µs at 16 KiB) because
  napi's own string conversion is efficient and one call per text amortises its higher call cost. It also runs on
  Node at the same speed.
- **WASM is 1.5-2x slower than native** (2 KiB ASCII: 7.194 vs 4.119 µs on Bun) but still beats TS on Bun from 2 KiB,
  and on Node it beats TS everywhere: Node's TS non-ASCII path is 3-4x slower than Bun's (70.955 vs 22.9 µs at
  2 KiB); the likely cause (**not profiled**) is V8's per-token `TextEncoder.encode` on non-ASCII tokens.
- **Using `Bun.hash.murmur32v3` per token is 1.7-3.1x slower than hand-hashing in TS**: slicing and lowercasing each
  token allocates, which costs more than the hash it saves.
- The Rust tokenizer looks branch-bound (≈ 2.8 ns/byte, ≈ 17 ns/token at 16 KiB ASCII, **not profiled**): every token boundary is a hard-to-
  predict branch. A SIMD classifier could go further; **unmeasured**.
- **Break-even** (linear fit through the measured 256 B and 2 KiB means, **not measured directly**): TS ≈ 0.07 µs
  + 7.33 ns/B, Rust FFI ≈ 0.59 µs + 1.72 ns/B for ASCII, crossing at ≈ 93 B; for non-ASCII TS ≈ 0.10 µs +
  11.13 ns/B, Rust ≈ 1.61 µs + 5.87 ns/B, crossing at ≈ 290 B.

## 4. Secret scanning

The Rust scanner (`eden-native/src/secrets.rs`) embeds the vendored gitleaks v8.30.1 `gitleaks.toml`, parses it with
`toml`, and applies rules as `packages/redact/src/secrets.ts` does: an Aho-Corasick automaton over all 244
distinct keywords (ASCII case-insensitive, overlapping matches) picks candidate rules; each candidate's regex runs;
the secret is the rule's `secretGroup`, else the first non-empty group, else the match (after trimming line breaks
and re-matching); the entropy floor and the global and per-rule allowlists (regex target, stopwords, AND/OR, path
conditions never holding) apply. A second mode runs one `RegexSet` over all 221 rule regexes first.

### Regex compatibility with Rust `regex`

From `verify.ts`:

| Regexes | Total | Compile unchanged with `regex::Regex` defaults | Need brace translation | Compile in scanner mode | Of which with Unicode off |
|---|---:|---:|---:|---:|---:|
| rule | 221 | 218 | 0 | 221 | 221 |
| allowlist | 49 | 45 | 4 | 49 | 49 |

- **218 of 221 rule regexes compile unchanged.** The three that do not (`generic-api-key`, `pypi-upload-token`,
  `vault-batch-token`) only exceed the default 10 MiB compiled-size limit: Unicode-aware `\w` inside large bounded
  repetitions (`{50,1000}`, `{138,300}`). They compile unchanged once Unicode is off or the limit is raised.
- **4 of 49 allowlist regexes fail to parse**: Go reads a `{` that starts no valid repetition as a literal, Rust
  rejects it. Affected: two global allowlist entries (`^\$(?:\d+|{\d+})$`, `^\${(?:[A-Z_]+|[a-z_]+)}$`),
  `curl-auth-user` (`{{[^}]+}}`) and `generic-api-key` (`import[ \t]+{[ \t\w,]+}…`). `translate()` escapes such braces
  outside classes; all 49 then compile.
- **Scanner mode** compiles with `regex::bytes` and Unicode off, so `\w`, `\d`, `\s`, `\b` are ASCII as in Go's RE2
  (Rust's Unicode defaults would match more than gitleaks does and run slower). All 270 regexes compile that way.
  Compile time for all 270: 72.9 / 54.6 / 41.7 ms in runs A / B / C.
- Semantic differences that remain (none showed on the corpus): JavaScript's `\s` is Unicode-aware while Go and the
  Rust scanner's are ASCII; the TS gate's spans are UTF-16 offsets, Rust's are byte offsets (redaction would need
  a mapping); Rust `regex` is linear-time, JavaScript's backtracking engine is not (Rust is ReDoS-proof by design).

### Speed: which gitleaks rules fire

Median of the three runs' means, µs, portable build (the target-cpu=native build is in Appendix A and is within
noise). "One-regex gate" comes from `bench/secrets-profile.ts`, a separate process.

| Input | TS `secretHits` (full gate incl. `eden-*`) | TS gitleaks rules only | TS gitleaks rules, one-regex keyword gate | Rust FFI prefilter + regex | Rust FFI RegexSet + prefilter | Rust WASM prefilter + regex |
|---|---:|---:|---:|---:|---:|---:|
| benign ASCII 256 B | 27.899 | 23.099 | 12.379 | 1.776 | 2.582 | 2.153 |
| benign ASCII 2 KiB | 96.669 | 80.009 | 46.572 | 8.041 | 17.606 | 14.434 |
| benign non-ASCII 2 KiB | 124.931 | 130.782 | 38.013 | 9.957 | 19.135 | 14.209 |
| benign ASCII 16 KiB | 1419.386 | 1134.816 | 337.272 | 137.048 | 183.936 | 265.757 |
| 3 secrets, ~2 KiB | 106.116 | 77.576 | 67.357 | 16.237 | 24.202 | 32.892 |

Cold start (one-off, ms; runs A / B / C, portable build):

| Step | Run A | Run B | Run C |
|---|---:|---:|---:|
| TS: build + first run (compiles) of every rule regex, incl. `eden-*` (231 rules) | 19.0 | 13.9 | 20.5 |
| Rust FFI: parse TOML, compile rule + allowlist regexes, Aho-Corasick (221 rules) | 49.4 | 43.4 | 69.0 |
| Rust FFI: RegexSet over every rule | 24.0 | 22.8 | 35.4 |
| Rust WASM: instantiate + parse, compile, Aho-Corasick | 99.1 | 123.4 | 122.0 |

- **Rust is ~10x faster than the TS gitleaks rules** (2 KiB benign: 8.0 vs 80.0 µs; 16 KiB: 137 vs 1135 µs) and
  10-16x faster than the full TS gate, at every size including 256 B.
- **Why TS is slow: the keyword gate, not the regexes.** On the 2 KiB benign email *no gitleaks rule passes the
  keyword gate* (only the 10 keyword-less `eden-*` rules run, costing ≈ 26 µs together; `eden-entropy-keyword`
  9.3 µs and `eden-url-userinfo` 6.3 µs are the largest). The rest is `toLowerCase()` plus one `includes()` per
  keyword per rule (244 distinct keywords), ≈ 91 µs at 2 KiB and ≈ 1.15 ms at 16 KiB.
- **A one-regex keyword gate in TS** (a lookahead alternation of all keywords, longest first, plus prefix closure;
  `bench/secrets-profile.ts`) cuts the TS gitleaks path 1.5-4x against the `includes` gate in the same process
  (2 KiB: 97.4 → 46.6 µs; 16 KiB: 1091 → 337 µs) with 0 mismatches. It is a pure-TS improvement available
  today; Rust FFI stays 2.5-7x ahead of it.
- **RegexSet does not pay**: the keyword prefilter already removes almost every rule, so running all 221 regexes as
  a set first is slower (17.6 vs 8.0 µs at 2 KiB) and adds 23-35 ms of compile time.
- **WASM keeps most of the win** (14.4 µs at 2 KiB, 5.5x faster than TS) but is 1.2-2x slower than native and
  has the slowest cold start (99-123 ms).
- Cold start is not a concern for a long-lived server, but Rust's 43-69 ms is 2-5x TS's 14-21 ms.

## 5. Bun built-ins for reference

Median of the three runs' means, µs:

| Case | ASCII 256 B | ASCII 2 KiB | ASCII 16 KiB | non-ASCII 256 B | non-ASCII 2 KiB | non-ASCII 16 KiB |
|---|---:|---:|---:|---:|---:|---:|
| `Bun.hash(str)` (wyhash) | 0.063 | 0.155 | 1.675 | 0.097 | 0.41 | 2.753 |
| `Bun.hash.murmur32v3(str)` | 0.163 | 0.997 | 14.067 | 0.304 | 1.802 | 8.956 |
| `Bun.hash.murmur32v3(bytes)` | 0.137 | 0.924 | 7.488 | 0.134 | 1.264 | 8.294 |
| TS `murmur3(bytes)` | 0.195 | 1.218 | 8.719 | 0.152 | 1.521 | 8.563 |
| TS `encodeInto` + `murmur3` | 0.406 | 1.431 | 9.561 | 0.384 | 1.44 | 15.057 |
| Rust FFI `encodeInto` + `murmur3` | 0.25 | 1.115 | 8.032 | 0.249 | 1.245 | 10.621 |
| `str.normalize("NFKC")` | 0.027 | 0.043 | 0.216 | 0.295 | 2.113 | 22.392 |
| `str.toLowerCase()` | 0.298 | 3.193 | 26.005 | 0.666 | 7.219 | 39.132 |

- murmur3 is a serial dependency chain: TS on JavaScriptCore, Bun's native murmur and Rust are all ≈ 0.5 ns/byte
  at 16 KiB. **No reason to cross a boundary to hash.** wyhash (`Bun.hash`) is 3-6x faster than any murmur3 when the
  algorithm is free to choose. `Bun.hash.murmur32v3(str)` at 16 KiB ASCII was bimodal across runs (6.867 / 14.067 /
  15.886 µs); pass bytes when they exist.
- **NFKC is ~100x cheaper on ASCII than on non-ASCII text** (16 KiB: 0.216 vs 22.392 µs, ≈ 13 ns vs ≈ 1.4 µs per
  KiB): JavaScriptCore returns 8-bit strings quickly. No native replacement was measured (**unmeasured**:
  `unicode-normalization` crate).
- `toLowerCase()` allocates and is costlier than either hash (2 KiB ASCII 3.193 µs); the TS gate calls it once per
  text and the tokenizer avoids it on ASCII tokens.

## Recommendation per kernel

1. **Secret gate: move to Rust when its cost matters, via napi-rs, with WASM as fallback.** It is the one kernel
   where native code is an order of magnitude faster (≈ 80-97 µs → 8 µs per 2 KiB event, ≈ 1.1-1.4 ms → 0.14 ms per
   16 KiB). Before moving: port the `eden-*` rules (lookaheads become post-checks), return spans and map byte
   offsets to UTF-16 for `sanitizeForStore`, keep `verify.ts`-style differential tests against the TS gate in CI,
   and never panic on caller input (`panic = "abort"` would take the server down; fail open instead). **Do now, in
   TS:** replace the per-keyword `includes` gate with one compiled keyword regex (2-3x, measured, 0 mismatches).
2. **Tokenize + hash: stay TS.** Rust saves ≈ 11 µs per 2 KiB event (ASCII) and ≈ 9 µs non-ASCII; that does not
   justify a native build on its own. If the secret gate moves to a native module, add the tokenizer to it (the
   marginal cost is small and it gains 1.9-3.7x on ASCII). Do not hash tokens with `Bun.hash.murmur32v3(token)`.
3. **Hashing whole texts: Bun built-ins.** `Bun.hash` (wyhash) for dedup or cache keys; murmur3 only where its
   values must be stable across runtimes, through `Bun.hash.murmur32v3(bytes)` or the TS implementation.
4. **NFKC: Bun built-in.** It is effectively free on ASCII; on non-ASCII it costs ≈ 1.4 µs/KiB.
5. **Crossing the boundary:** one call per text, never per token; UTF-8 via `encodeInto` into a reused buffer.

**Why napi-rs over `bun:ffi` for production**, although `bun:ffi` has the cheapest calls (≈ 4-6 ns vs 23-55 ns p50
for a noop): (a) Bun's own docs for 1.4.4 say "`bun:ffi` is **experimental**, with known bugs and limitations. Do
not rely on it in production. The most stable way to interact with native code from Bun is to write a Node-API
module" (`docs/runtime/ffi.mdx` in the bun-types 1.4.4 package, read in this session); (b) a napi addon loads in
Node 22 and Bun unchanged (both measured), `bun:ffi` is Bun-only; (c) for one call per text the call cost is noise
next to the work (napi 6.16 µs vs FFI 4.119 µs for a 2 KiB tokenize).

## Risks

- **`bun:ffi` stability:** experimental per Bun's docs (above); raw pointers and lengths are unchecked, so a JS bug
  becomes memory corruption, not an exception.
- **Build and deploy:** a Rust toolchain in the build, one binary per target (linux-x64-gnu, linux-arm64,
  darwin-arm64, ...) or a single 1.6 MB WASM file; 2.5 MB per native artifact; Docker images must match the
  target. napi-rs has its own CLI for prebuilt per-platform packages (**unmeasured**; this experiment loaded the
  `.so` with `process.dlopen`).
- **Node portability:** `bun:ffi` does not exist on Node; WASM and napi-rs both ran on Node 22 here.
- **Two implementations drift:** regex dialects differ (Unicode `\s` in JS; Go-style braces; Rust has no
  look-around), offsets differ (UTF-16 vs bytes). Keep a differential test over a growing corpus.
- **Dependencies:** CLAUDE.md keeps them deliberately few. Rust adds `regex`, `aho-corasick`, `toml`, `serde`
  (+ `napi`, `napi-derive`, `napi-build`); each needs a justification in its PR.
- **Measurement noise:** a shared 4-vCPU VM; single cells moved 1.5-2x between runs. Conclusions above rely only on
  gaps that held in all three runs (Appendix A).

## Not measured

napi-rs prebuilt packaging and its CLI; a SIMD tokenizer; a hand-written Aho-Corasick in TS; porting the `eden-*`
rules and span mapping to Rust; `unicode-normalization` in Rust; inputs below 256 B; multi-threaded throughput
(all runs are single-threaded); memory use; `bun build --compile` single-file executables with a native addon.

## Reproduce

```bash
bun install                      # repo root, once
cd native && ./run-all.sh /tmp/runA && ./run-all.sh /tmp/runB && ./run-all.sh /tmp/runC
bun bench/summarize.ts tokenize-bun /tmp/runA /tmp/runB /tmp/runC
```

## Appendix A: every row, three runs

Generated by `bun native/bench/summarize.ts <bench> runA runB runC` over this session's runs. "mean per run" and
"p50 per run" are runs A / B / C. Units are the source table's: ns for the call-overhead rows (`noop`,
`sum_bytes`, JS baselines, napi `noop`/`sumBytes`), µs for everything else. Cold-start rows are in section 4 and
Appendix B.

### ffi

| case | mean per run | median mean | p50 per run | median p50 |
|---|---|---:|---|---:|
| JS empty function (baseline) | 3.1 / 5 / 2.7 | 3.1 | 3.6 / 4.8 / 3.3 | 3.6 |
| ffi noop() | 7.7 / 12.1 / 8.5 | 8.5 | 6.1 / 10.5 / 6.5 | 6.5 |
| ffi sum_bytes(Uint8Array, 256) | 46.9 / 62 / 58 | 58 | 33.6 / 60.1 / 57.7 | 57.7 |
| ffi sum_bytes(cached ptr number, 256) | 40.5 / 57.9 / 41.1 | 41.1 | 33.1 / 55.8 / 36.6 | 36.6 |
| ffi sum_bytes(ptr(arr) per call, 256) | 44.4 / 39.4 / 75 | 44.4 | 42.8 / 37.8 / 74.4 | 42.8 |
| JS sum of 256 bytes (loop) | 259.4 / 192 / 187.8 | 192 | 252.3 / 187.8 / 183.8 | 187.8 |
| ffi sum_bytes(Uint8Array, 2048) | 378.7 / 318.6 / 187 | 318.6 | 370.2 / 325.1 / 178.5 | 325.1 |
| ffi sum_bytes(Uint8Array, 16384) | 1576.2 / 2649.4 / 1926.5 | 1926.5 | 1497.7 / 2454.7 / 1707.9 | 1707.9 |
| ASCII 256 B: encodeInto reused Uint8Array | 0.195 / 0.132 / 0.172 | 0.172 | 0.119 / 0.064 / 0.063 | 0.064 |
| ASCII 256 B: Buffer.from(str) | 0.287 / 0.33 / 0.349 | 0.33 | 0.087 / 0.09 / 0.12 | 0.09 |
| ASCII 256 B: TextEncoder.encode(str) | 0.162 / 0.218 / 0.284 | 0.218 | 0.044 / 0.065 / 0.072 | 0.065 |
| ASCII 256 B: UTF-16 charCodeAt loop into reused Uint16Array | 0.241 / 0.283 / 0.329 | 0.283 | 0.199 / 0.277 / 0.314 | 0.277 |
| ASCII 256 B: UTF-16 Buffer.write(str, 'utf16le') reused | 0.066 / 0.073 / 0.092 | 0.073 | 0.054 / 0.068 / 0.089 | 0.068 |
| ASCII 256 B: encodeInto + ffi sum_bytes (end to end) | 0.208 / 0.169 / 0.105 | 0.169 | 0.147 / 0.125 / 0.078 | 0.125 |
| ASCII 256 B: Buffer.write utf16le + ffi sum_u16 (end to end) | 0.123 / 0.081 / 0.069 | 0.081 | 0.118 / 0.066 / 0.063 | 0.066 |
| ASCII 2048 B: encodeInto reused Uint8Array | 0.213 / 0.134 / 0.195 | 0.195 | 0.12 / 0.074 / 0.133 | 0.12 |
| ASCII 2048 B: Buffer.from(str) | 1.636 / 1.059 / 1.381 | 1.381 | 0.295 / 0.188 / 0.29 | 0.29 |
| ASCII 2048 B: TextEncoder.encode(str) | 1.918 / 1.142 / 0.94 | 1.142 | 0.21 / 0.158 / 0.144 | 0.158 |
| ASCII 2048 B: UTF-16 charCodeAt loop into reused Uint16Array | 2.295 / 1.499 / 3.292 | 2.295 | 2.042 / 1.357 / 3.112 | 2.042 |
| ASCII 2048 B: UTF-16 Buffer.write(str, 'utf16le') reused | 0.187 / 0.124 / 0.171 | 0.171 | 0.19 / 0.101 / 0.168 | 0.168 |
| ASCII 2048 B: encodeInto + ffi sum_bytes (end to end) | 0.387 / 0.401 / 0.61 | 0.401 | 0.281 / 0.265 / 0.524 | 0.281 |
| ASCII 2048 B: Buffer.write utf16le + ffi sum_u16 (end to end) | 0.31 / 0.253 / 0.448 | 0.31 | 0.252 / 0.234 / 0.438 | 0.252 |
| ASCII 16384 B: encodeInto reused Uint8Array | 0.345 / 0.348 / 0.258 | 0.345 | 0.246 / 0.238 / 0.227 | 0.238 |
| ASCII 16384 B: Buffer.from(str) | 10.816 / 10.602 / 12.391 | 10.816 | 0.759 / 0.892 / 1.344 | 0.892 |
| ASCII 16384 B: TextEncoder.encode(str) | 10.609 / 11.712 / 11.473 | 11.473 | 0.704 / 1.134 / 0.904 | 0.904 |
| ASCII 16384 B: UTF-16 charCodeAt loop into reused Uint16Array | 12.448 / 19.741 / 18.291 | 18.291 | 11.189 / 19.22 / 15.935 | 15.935 |
| ASCII 16384 B: UTF-16 Buffer.write(str, 'utf16le') reused | 0.853 / 0.875 / 0.819 | 0.853 | 0.836 / 0.795 / 0.8 | 0.8 |
| ASCII 16384 B: encodeInto + ffi sum_bytes (end to end) | 1.753 / 3.142 / 1.925 | 1.925 | 1.685 / 2.93 / 1.685 | 1.685 |
| ASCII 16384 B: Buffer.write utf16le + ffi sum_u16 (end to end) | 1.791 / 3.167 / 1.767 | 1.791 | 1.68 / 2.999 / 1.698 | 1.698 |
| non-ASCII 256 B: encodeInto reused Uint8Array | 0.142 / 0.138 / 0.154 | 0.142 | 0.079 / 0.081 / 0.082 | 0.081 |
| non-ASCII 256 B: Buffer.from(str) | 0.6 / 0.344 / 0.413 | 0.413 | 0.126 / 0.115 / 0.121 | 0.121 |
| non-ASCII 256 B: TextEncoder.encode(str) | 0.338 / 0.237 / 0.277 | 0.277 | 0.126 / 0.07 / 0.084 | 0.084 |
| non-ASCII 256 B: UTF-16 charCodeAt loop into reused Uint16Array | 0.215 / 0.24 / 0.241 | 0.24 | 0.208 / 0.226 / 0.23 | 0.226 |
| non-ASCII 256 B: UTF-16 Buffer.write(str, 'utf16le') reused | 0.041 / 0.045 / 0.044 | 0.044 | 0.04 / 0.038 / 0.041 | 0.04 |
| non-ASCII 256 B: encodeInto + ffi sum_bytes (end to end) | 0.149 / 0.168 / 0.172 | 0.168 | 0.106 / 0.106 / 0.109 | 0.106 |
| non-ASCII 256 B: Buffer.write utf16le + ffi sum_u16 (end to end) | 0.054 / 0.111 / 0.068 | 0.068 | 0.053 / 0.11 / 0.061 | 0.061 |
| non-ASCII 2048 B: encodeInto reused Uint8Array | 0.331 / 0.361 / 0.329 | 0.331 | 0.258 / 0.263 / 0.261 | 0.261 |
| non-ASCII 2048 B: Buffer.from(str) | 1.455 / 1.636 / 2.227 | 1.636 | 0.372 / 0.399 / 0.66 | 0.399 |
| non-ASCII 2048 B: TextEncoder.encode(str) | 2.139 / 1.525 / 1.847 | 1.847 | 0.496 / 0.376 / 0.408 | 0.408 |
| non-ASCII 2048 B: UTF-16 charCodeAt loop into reused Uint16Array | 1.673 / 1.713 / 2.608 | 1.713 | 1.638 / 1.792 / 2.603 | 1.792 |
| non-ASCII 2048 B: UTF-16 Buffer.write(str, 'utf16le') reused | 0.069 / 0.11 / 0.094 | 0.094 | 0.065 / 0.103 / 0.093 | 0.093 |
| non-ASCII 2048 B: encodeInto + ffi sum_bytes (end to end) | 0.488 / 0.985 / 0.82 | 0.82 | 0.459 / 0.704 / 0.741 | 0.704 |
| non-ASCII 2048 B: Buffer.write utf16le + ffi sum_u16 (end to end) | 0.247 / 0.317 / 0.35 | 0.317 | 0.236 / 0.307 / 0.349 | 0.307 |
| non-ASCII 16384 B: encodeInto reused Uint8Array | 3.384 / 1.959 / 3.245 | 3.245 | 3.055 / 1.836 / 3.007 | 3.007 |
| non-ASCII 16384 B: Buffer.from(str) | 16.236 / 12.878 / 13.009 | 13.009 | 4.313 / 3.737 / 2.696 | 3.737 |
| non-ASCII 16384 B: TextEncoder.encode(str) | 13.06 / 12.401 / 16.842 | 13.06 | 2.83 / 2.479 / 4.953 | 2.83 |
| non-ASCII 16384 B: UTF-16 charCodeAt loop into reused Uint16Array | 20.111 / 15.514 / 17.596 | 17.596 | 18.96 / 14.676 / 17.715 | 17.715 |
| non-ASCII 16384 B: UTF-16 Buffer.write(str, 'utf16le') reused | 0.759 / 0.744 / 0.777 | 0.759 | 0.741 / 0.742 / 0.765 | 0.742 |
| non-ASCII 16384 B: encodeInto + ffi sum_bytes (end to end) | 3.246 / 3.637 / 3.605 | 3.605 | 2.983 / 3.281 / 3.329 | 3.281 |
| non-ASCII 16384 B: Buffer.write utf16le + ffi sum_u16 (end to end) | 1.356 / 1.894 / 1.307 | 1.356 | 1.325 / 1.375 / 1.258 | 1.325 |

### ffi-native-cpu

| case | mean per run | median mean | p50 per run | median p50 |
|---|---|---:|---|---:|
| JS empty function (baseline) | 2.9 / 3.7 / 4.4 | 3.7 | 3 / 1.4 / 6.4 | 3 |
| ffi noop() | 6.9 / 6.6 / 6.5 | 6.6 | 6.7 / 5.3 / 5.5 | 5.5 |
| ffi sum_bytes(Uint8Array, 256) | 16.5 / 17.1 / 16.1 | 16.5 | 16.3 / 15.9 / 15.6 | 15.9 |
| ffi sum_bytes(cached ptr number, 256) | 16.6 / 18.5 / 16.7 | 16.7 | 16.4 / 15.2 / 16.4 | 16.4 |
| ffi sum_bytes(ptr(arr) per call, 256) | 26.5 / 35.1 / 26.4 | 26.5 | 26 / 30.5 / 26 | 26 |
| JS sum of 256 bytes (loop) | 182.4 / 145.6 / 137.3 | 145.6 | 181.2 / 145 / 133.7 | 145 |
| ffi sum_bytes(Uint8Array, 2048) | 82.6 / 84.4 / 105.9 | 84.4 | 79.3 / 80.5 / 99.2 | 80.5 |
| ffi sum_bytes(Uint8Array, 16384) | 713 / 700.8 / 708 | 708 | 676.3 / 675.7 / 677.1 | 676.3 |
| ASCII 256 B: encodeInto reused Uint8Array | 0.113 / 0.167 / 0.11 | 0.113 | 0.066 / 0.071 / 0.063 | 0.066 |
| ASCII 256 B: Buffer.from(str) | 0.352 / 0.418 / 0.368 | 0.368 | 0.158 / 0.145 / 0.125 | 0.145 |
| ASCII 256 B: TextEncoder.encode(str) | 0.204 / 0.226 / 0.142 | 0.204 | 0.069 / 0.068 / 0.04 | 0.068 |
| ASCII 256 B: UTF-16 charCodeAt loop into reused Uint16Array | 0.359 / 0.313 / 0.207 | 0.313 | 0.338 / 0.283 / 0.194 | 0.283 |
| ASCII 256 B: UTF-16 Buffer.write(str, 'utf16le') reused | 0.047 / 0.043 / 0.048 | 0.047 | 0.045 / 0.041 / 0.046 | 0.045 |
| ASCII 256 B: encodeInto + ffi sum_bytes (end to end) | 0.12 / 0.114 / 0.155 | 0.12 | 0.063 / 0.064 / 0.106 | 0.064 |
| ASCII 256 B: Buffer.write utf16le + ffi sum_u16 (end to end) | 0.052 / 0.054 / 0.098 | 0.054 | 0.049 / 0.053 / 0.093 | 0.053 |
| ASCII 2048 B: encodeInto reused Uint8Array | 0.13 / 0.112 / 0.13 | 0.13 | 0.073 / 0.072 / 0.075 | 0.073 |
| ASCII 2048 B: Buffer.from(str) | 0.987 / 1.164 / 1.397 | 1.164 | 0.189 / 0.253 / 0.213 | 0.213 |
| ASCII 2048 B: TextEncoder.encode(str) | 1.27 / 0.968 / 1.46 | 1.27 | 0.191 / 0.154 / 0.213 | 0.191 |
| ASCII 2048 B: UTF-16 charCodeAt loop into reused Uint16Array | 2.824 / 2.161 / 1.413 | 2.161 | 2.512 / 2.084 / 1.364 | 2.084 |
| ASCII 2048 B: UTF-16 Buffer.write(str, 'utf16le') reused | 0.165 / 0.122 / 0.103 | 0.122 | 0.154 / 0.101 / 0.101 | 0.101 |
| ASCII 2048 B: encodeInto + ffi sum_bytes (end to end) | 0.217 / 0.323 / 0.277 | 0.277 | 0.152 / 0.246 / 0.152 | 0.152 |
| ASCII 2048 B: Buffer.write utf16le + ffi sum_u16 (end to end) | 0.182 / 0.324 / 0.262 | 0.262 | 0.176 / 0.312 / 0.264 | 0.264 |
| ASCII 16384 B: encodeInto reused Uint8Array | 0.305 / 0.535 / 0.533 | 0.533 | 0.234 / 0.457 / 0.413 | 0.413 |
| ASCII 16384 B: Buffer.from(str) | 11.496 / 12.344 / 9.186 | 11.496 | 1.096 / 1.204 / 0.749 | 1.096 |
| ASCII 16384 B: TextEncoder.encode(str) | 9.791 / 11.805 / 12.214 | 11.805 | 0.753 / 0.817 / 1.056 | 0.817 |
| ASCII 16384 B: UTF-16 charCodeAt loop into reused Uint16Array | 21.371 / 19.819 / 19.617 | 19.819 | 21.623 / 16.461 / 19.235 | 19.235 |
| ASCII 16384 B: UTF-16 Buffer.write(str, 'utf16le') reused | 0.954 / 1.276 / 1.184 | 1.184 | 0.907 / 1.156 / 1.175 | 1.156 |
| ASCII 16384 B: encodeInto + ffi sum_bytes (end to end) | 0.929 / 1.013 / 0.991 | 0.991 | 0.819 / 0.923 / 0.926 | 0.923 |
| ASCII 16384 B: Buffer.write utf16le + ffi sum_u16 (end to end) | 1.724 / 1.609 / 2.274 | 1.724 | 1.387 / 1.528 / 2.203 | 1.528 |
| non-ASCII 256 B: encodeInto reused Uint8Array | 0.169 / 0.251 / 0.23 | 0.23 | 0.082 / 0.161 / 0.152 | 0.152 |
| non-ASCII 256 B: Buffer.from(str) | 0.356 / 0.493 / 0.653 | 0.493 | 0.115 / 0.135 / 0.279 | 0.135 |
| non-ASCII 256 B: TextEncoder.encode(str) | 0.224 / 0.337 / 0.364 | 0.337 | 0.076 / 0.079 / 0.128 | 0.079 |
| non-ASCII 256 B: UTF-16 charCodeAt loop into reused Uint16Array | 0.292 / 0.267 / 0.241 | 0.267 | 0.246 / 0.237 / 0.23 | 0.237 |
| non-ASCII 256 B: UTF-16 Buffer.write(str, 'utf16le') reused | 0.045 / 0.047 / 0.078 | 0.047 | 0.041 / 0.046 / 0.076 | 0.046 |
| non-ASCII 256 B: encodeInto + ffi sum_bytes (end to end) | 0.144 / 0.181 / 0.251 | 0.181 | 0.088 / 0.092 / 0.173 | 0.092 |
| non-ASCII 256 B: Buffer.write utf16le + ffi sum_u16 (end to end) | 0.089 / 0.061 / 0.063 | 0.063 | 0.086 / 0.057 / 0.06 | 0.06 |
| non-ASCII 2048 B: encodeInto reused Uint8Array | 0.363 / 0.389 / 0.49 | 0.389 | 0.254 / 0.255 / 0.403 | 0.255 |
| non-ASCII 2048 B: Buffer.from(str) | 2.543 / 1.836 / 1.64 | 1.836 | 0.706 / 0.427 / 0.407 | 0.427 |
| non-ASCII 2048 B: TextEncoder.encode(str) | 1.972 / 1.57 / 2.087 | 1.972 | 0.471 / 0.382 / 0.524 | 0.471 |
| non-ASCII 2048 B: UTF-16 charCodeAt loop into reused Uint16Array | 1.8 / 3.433 / 1.719 | 1.8 | 1.796 / 3.406 / 1.633 | 1.796 |
| non-ASCII 2048 B: UTF-16 Buffer.write(str, 'utf16le') reused | 0.06 / 0.104 / 0.065 | 0.065 | 0.058 / 0.101 / 0.059 | 0.059 |
| non-ASCII 2048 B: encodeInto + ffi sum_bytes (end to end) | 0.664 / 0.591 / 0.433 | 0.591 | 0.503 / 0.477 / 0.329 | 0.477 |
| non-ASCII 2048 B: Buffer.write utf16le + ffi sum_u16 (end to end) | 0.222 / 0.151 / 0.186 | 0.186 | 0.216 / 0.14 / 0.149 | 0.149 |
| non-ASCII 16384 B: encodeInto reused Uint8Array | 1.864 / 2.3 / 2.126 | 2.126 | 1.823 / 1.915 / 1.903 | 1.903 |
| non-ASCII 16384 B: Buffer.from(str) | 16.057 / 16.025 / 14.702 | 16.025 | 4.149 / 4.147 / 4.749 | 4.149 |
| non-ASCII 16384 B: TextEncoder.encode(str) | 15.046 / 14.807 / 14.573 | 14.807 | 3.908 / 2.7 / 4.331 | 3.908 |
| non-ASCII 16384 B: UTF-16 charCodeAt loop into reused Uint16Array | 23.138 / 17.927 / 27.407 | 23.138 | 23.765 / 14.702 / 25.627 | 23.765 |
| non-ASCII 16384 B: UTF-16 Buffer.write(str, 'utf16le') reused | 0.916 / 0.786 / 0.803 | 0.803 | 0.874 / 0.752 / 0.764 | 0.764 |
| non-ASCII 16384 B: encodeInto + ffi sum_bytes (end to end) | 2.715 / 2.849 / 2.645 | 2.715 | 2.494 / 2.585 / 2.525 | 2.525 |
| non-ASCII 16384 B: Buffer.write utf16le + ffi sum_u16 (end to end) | 1.117 / 1.582 / 1.161 | 1.161 | 1.097 / 1.53 / 1.101 | 1.101 |

### tokenize-bun

| case | mean per run | median mean | p50 per run | median p50 |
|---|---|---:|---|---:|
| ASCII 256 B: TS | 1.534 / 2.106 / 1.945 | 1.945 | 1.151 / 2.017 / 1.922 | 1.922 |
| ASCII 256 B: TS scan + Bun.hash.murmur32v3(token) | 6.053 / 6.789 / 5.989 | 6.053 | 5.026 / 5.351 / 4.776 | 5.026 |
| ASCII 256 B: Rust FFI (encodeInto UTF-8) | 1.03 / 0.627 / 1.151 | 1.03 | 1.044 / 0.546 / 1.062 | 1.044 |
| ASCII 256 B: Rust FFI (UTF-16 charCodeAt loop) | 2.203 / 1.234 / 1.811 | 1.811 | 2.141 / 1.167 / 1.714 | 1.714 |
| ASCII 256 B: Rust WASM (encodeInto) | 1.699 / 1.139 / 1.663 | 1.663 | 1.604 / 1.041 / 1.597 | 1.597 |
| ASCII 2048 B: TS | 14.483 / 17.249 / 15.076 | 15.076 | 13.924 / 16.56 / 14.469 | 14.469 |
| ASCII 2048 B: TS scan + Bun.hash.murmur32v3(token) | 52.576 / 36.738 / 36.941 | 36.941 | 48.208 / 31.521 / 32.551 | 32.551 |
| ASCII 2048 B: Rust FFI (encodeInto UTF-8) | 4.119 / 3.851 / 6.629 | 4.119 | 3.762 / 3.651 / 5.865 | 3.762 |
| ASCII 2048 B: Rust FFI (UTF-16 charCodeAt loop) | 12.428 / 9.384 / 8.914 | 9.384 | 13.02 / 8.271 / 8.241 | 8.271 |
| ASCII 2048 B: Rust WASM (encodeInto) | 7.645 / 7.194 / 6.334 | 7.194 | 6.805 / 6.541 / 6.073 | 6.541 |
| ASCII 16384 B: TS | 109.903 / 149.869 / 127.488 | 127.488 | 106.052 / 152.849 / 113.669 | 113.669 |
| ASCII 16384 B: TS scan + Bun.hash.murmur32v3(token) | 324.651 / 349.905 / 400.237 | 349.905 | 288.665 / 297.795 / 423.104 | 297.795 |
| ASCII 16384 B: Rust FFI (encodeInto UTF-8) | 37.7 / 45.956 / 57.568 | 45.956 | 33.84 / 38.328 / 55.532 | 38.328 |
| ASCII 16384 B: Rust FFI (UTF-16 charCodeAt loop) | 80.949 / 82.658 / 87.132 | 82.658 | 71.757 / 75.016 / 75.2 | 75.016 |
| ASCII 16384 B: Rust WASM (encodeInto) | 109.202 / 93.44 / 96.877 | 96.877 | 108.778 / 89.31 / 84.995 | 89.31 |
| non-ASCII 256 B: TS | 4.635 / 2.946 / 2.92 | 2.946 | 4.183 / 2.461 / 2.41 | 2.461 |
| non-ASCII 256 B: TS scan + Bun.hash.murmur32v3(token) | 4.021 / 7.21 / 5.678 | 5.678 | 3.385 / 6.03 / 5.208 | 5.208 |
| non-ASCII 256 B: Rust FFI (encodeInto UTF-8) | 3.157 / 3.108 / 2.744 | 3.108 | 2.976 / 2.977 / 2.595 | 2.976 |
| non-ASCII 256 B: Rust FFI (UTF-16 charCodeAt loop) | 3.583 / 3.819 / 3.507 | 3.583 | 2.499 / 3.686 / 3.397 | 3.397 |
| non-ASCII 256 B: Rust WASM (encodeInto) | 4.451 / 4.072 / 2.86 | 4.072 | 4.221 / 4.027 / 2.705 | 4.027 |
| non-ASCII 2048 B: TS | 23.713 / 22.9 / 20.421 | 22.9 | 19.107 / 18.328 / 17.329 | 18.328 |
| non-ASCII 2048 B: TS scan + Bun.hash.murmur32v3(token) | 38.375 / 56.563 / 33.472 | 38.375 | 32.703 / 51.641 / 30.846 | 32.703 |
| non-ASCII 2048 B: Rust FFI (encodeInto UTF-8) | 13.633 / 16.468 / 13.233 | 13.633 | 12.814 / 16.94 / 12.915 | 12.915 |
| non-ASCII 2048 B: Rust FFI (UTF-16 charCodeAt loop) | 17.567 / 17.649 / 15.961 | 17.567 | 16.254 / 16.621 / 15.887 | 16.254 |
| non-ASCII 2048 B: Rust WASM (encodeInto) | 20.364 / 22.129 / 19.598 | 20.364 | 19.296 / 18.719 / 19.523 | 19.296 |
| non-ASCII 16384 B: TS | 212.301 / 270.817 / 202.381 | 212.301 | 193.811 / 224.907 / 192.915 | 193.811 |
| non-ASCII 16384 B: TS scan + Bun.hash.murmur32v3(token) | 393.578 / 381.705 / 330.78 | 381.705 | 336.355 / 336.672 / 315.878 | 336.355 |
| non-ASCII 16384 B: Rust FFI (encodeInto UTF-8) | 162.494 / 120.99 / 121.327 | 121.327 | 165.185 / 116.074 / 117.658 | 117.658 |
| non-ASCII 16384 B: Rust FFI (UTF-16 charCodeAt loop) | 184.243 / 149.56 / 158 | 158 | 159.982 / 146.579 / 151.57 | 151.57 |
| non-ASCII 16384 B: Rust WASM (encodeInto) | 232.79 / 194.984 / 189.58 | 194.984 | 241.478 / 184.811 / 186.385 | 186.385 |

### tokenize-bun-native-cpu

| case | mean per run | median mean | p50 per run | median p50 |
|---|---|---:|---|---:|
| ASCII 256 B: TS | 1.017 / 2.018 / 2.021 | 2.018 | 0.966 / 1.925 / 1.97 | 1.925 |
| ASCII 256 B: TS scan + Bun.hash.murmur32v3(token) | 3.407 / 6.175 / 6.602 | 6.175 | 2.924 / 4.959 / 5.322 | 4.959 |
| ASCII 256 B: Rust FFI (encodeInto UTF-8) | 0.625 / 1.082 / 1.088 | 1.082 | 0.499 / 0.975 / 1.028 | 0.975 |
| ASCII 256 B: Rust FFI (UTF-16 charCodeAt loop) | 1.511 / 1.481 / 1.865 | 1.511 | 1.411 / 1.365 / 1.604 | 1.411 |
| ASCII 256 B: Rust WASM (encodeInto) | 1.105 / 0.982 / 1.451 | 1.105 | 0.935 / 0.939 / 1.348 | 0.939 |
| ASCII 2048 B: TS | 9.166 / 9.924 / 13.891 | 9.924 | 8.092 / 9.147 / 12.616 | 9.147 |
| ASCII 2048 B: TS scan + Bun.hash.murmur32v3(token) | 34.609 / 51.748 / 34.129 | 34.609 | 28.996 / 44.948 / 30.383 | 30.383 |
| ASCII 2048 B: Rust FFI (encodeInto UTF-8) | 4.054 / 6.86 / 4.28 | 4.28 | 3.629 / 6.662 / 3.737 | 3.737 |
| ASCII 2048 B: Rust FFI (UTF-16 charCodeAt loop) | 11.086 / 12.254 / 18.588 | 12.254 | 10.298 / 10.646 / 18.321 | 10.646 |
| ASCII 2048 B: Rust WASM (encodeInto) | 9.334 / 7.473 / 10.415 | 9.334 | 8.914 / 6.954 / 9.879 | 8.914 |
| ASCII 16384 B: TS | 139.897 / 156.642 / 162.467 | 156.642 | 143.561 / 134.485 / 164.597 | 143.561 |
| ASCII 16384 B: TS scan + Bun.hash.murmur32v3(token) | 353.989 / 417.57 / 352.855 | 353.989 | 296.03 / 360.056 / 298.696 | 298.696 |
| ASCII 16384 B: Rust FFI (encodeInto UTF-8) | 35.719 / 40.842 / 39.297 | 39.297 | 34.676 / 37.151 / 36.408 | 36.408 |
| ASCII 16384 B: Rust FFI (UTF-16 charCodeAt loop) | 94.024 / 135.668 / 98.449 | 98.449 | 90.66 / 134.132 / 93.797 | 93.797 |
| ASCII 16384 B: Rust WASM (encodeInto) | 123.036 / 96.265 / 92.77 | 96.265 | 123.035 / 93.089 / 87.402 | 93.089 |
| non-ASCII 256 B: TS | 5.69 / 5.165 / 3.089 | 5.165 | 4.454 / 4.202 / 2.394 | 4.202 |
| non-ASCII 256 B: TS scan + Bun.hash.murmur32v3(token) | 7.973 / 6.719 / 4.111 | 6.719 | 5.757 / 5.566 / 3.401 | 5.566 |
| non-ASCII 256 B: Rust FFI (encodeInto UTF-8) | 2.206 / 2.978 / 2.161 | 2.206 | 1.925 / 2.708 / 1.948 | 1.948 |
| non-ASCII 256 B: Rust FFI (UTF-16 charCodeAt loop) | 2.784 / 4.145 / 2.83 | 2.83 | 2.68 / 3.997 / 2.596 | 2.68 |
| non-ASCII 256 B: Rust WASM (encodeInto) | 2.915 / 4.296 / 4.805 | 4.296 | 2.813 / 4.143 / 4.464 | 4.143 |
| non-ASCII 2048 B: TS | 37.166 / 21.325 / 20.981 | 21.325 | 33.772 / 17.881 / 18.092 | 18.092 |
| non-ASCII 2048 B: TS scan + Bun.hash.murmur32v3(token) | 47.567 / 38.032 / 44.327 | 44.327 | 38.912 / 32.474 / 38.381 | 38.381 |
| non-ASCII 2048 B: Rust FFI (encodeInto UTF-8) | 21.468 / 15.648 / 13.791 | 15.648 | 20.44 / 13.395 / 13.005 | 13.395 |
| non-ASCII 2048 B: Rust FFI (UTF-16 charCodeAt loop) | 19.223 / 25.537 / 20.488 | 20.488 | 18.515 / 26.295 / 18.738 | 18.738 |
| non-ASCII 2048 B: Rust WASM (encodeInto) | 22.173 / 29.278 / 19.558 | 22.173 | 18.469 / 28.243 / 19.002 | 19.002 |
| non-ASCII 16384 B: TS | 282.104 / 255.544 / 291.477 | 282.104 | 234.783 / 212.284 / 303.204 | 234.783 |
| non-ASCII 16384 B: TS scan + Bun.hash.murmur32v3(token) | 366.95 / 404.986 / 332.911 | 366.95 | 326.371 / 353.624 / 316.884 | 326.371 |
| non-ASCII 16384 B: Rust FFI (encodeInto UTF-8) | 130.086 / 196.248 / 122.367 | 130.086 | 116.91 / 194.57 / 113.428 | 116.91 |
| non-ASCII 16384 B: Rust FFI (UTF-16 charCodeAt loop) | 193.739 / 255.775 / 163.336 | 193.739 | 182.225 / 252.793 / 159.333 | 182.225 |
| non-ASCII 16384 B: Rust WASM (encodeInto) | 186.297 / 248.664 / 205.024 | 205.024 | 183.911 / 258.384 / 188.575 | 188.575 |

### tokenize-node

| case | mean per run | median mean | p50 per run | median p50 |
|---|---|---:|---|---:|
| ASCII 256 B: TS | 1.863 / 3.434 / 2.793 | 2.793 | 1.772 / 3.333 / 2.881 | 2.881 |
| ASCII 256 B: Rust WASM (encodeInto) | 1.52 / 1.799 / 0.976 | 1.52 | 1.503 / 1.69 / 0.774 | 1.503 |
| ASCII 2048 B: TS | 12.821 / 17.388 / 13.373 | 13.373 | 12.233 / 13.971 / 13.071 | 13.071 |
| ASCII 2048 B: Rust WASM (encodeInto) | 5.874 / 6.587 / 5.066 | 5.874 | 5.215 / 5.556 / 4.797 | 5.215 |
| ASCII 16384 B: TS | 167.888 / 187.386 / 155.253 | 167.888 | 150.282 / 154.841 / 146.792 | 150.282 |
| ASCII 16384 B: Rust WASM (encodeInto) | 73.83 / 87.795 / 69.011 | 73.83 | 67.305 / 83.896 / 64.733 | 67.305 |
| non-ASCII 256 B: TS | 10.079 / 15.035 / 10.14 | 10.14 | 7.231 / 12.095 / 7.948 | 7.948 |
| non-ASCII 256 B: Rust WASM (encodeInto) | 3.077 / 5.613 / 2.862 | 3.077 | 2.852 / 4.752 / 2.624 | 2.852 |
| non-ASCII 2048 B: TS | 70.955 / 71.822 / 64.054 | 70.955 | 55.231 / 56.008 / 51.628 | 55.231 |
| non-ASCII 2048 B: Rust WASM (encodeInto) | 19.217 / 21.695 / 18.612 | 19.217 | 18.25 / 19.442 / 18.191 | 18.25 |
| non-ASCII 16384 B: TS | 719.772 / 622.816 / 726.149 | 719.772 | 704.38 / 511.229 / 663.661 | 663.661 |
| non-ASCII 16384 B: Rust WASM (encodeInto) | 180.187 / 217.336 / 184.21 | 184.21 | 177.819 / 191.832 / 182.023 | 182.023 |

### secrets

| case | mean per run | median mean | p50 per run | median p50 |
|---|---|---:|---|---:|
| benign ASCII 256 B: TS secretHits (full gate, incl. eden-*) | 20.59 / 27.899 / 31.648 | 27.899 | 17.632 / 27.186 / 29.409 | 27.186 |
| benign ASCII 256 B: TS gitleaks rules only | 23.099 / 25.109 / 16.301 | 23.099 | 22.859 / 22.81 / 14.065 | 22.81 |
| benign ASCII 256 B: Rust FFI prefilter + regex | 1.776 / 2.018 / 1.569 | 1.776 | 1.749 / 1.838 / 1.266 | 1.749 |
| benign ASCII 256 B: Rust FFI RegexSet + prefilter | 2.476 / 3.224 / 2.582 | 2.582 | 2.41 / 3.074 / 2.359 | 2.41 |
| benign ASCII 256 B: Rust WASM prefilter + regex | 2.153 / 2.324 / 2.118 | 2.153 | 2.021 / 2.054 / 1.99 | 2.021 |
| benign ASCII 2 KiB: TS secretHits (full gate, incl. eden-*) | 96.669 / 125.243 / 96.334 | 96.669 | 91.013 / 129.961 / 87.146 | 91.013 |
| benign ASCII 2 KiB: TS gitleaks rules only | 80.009 / 85.96 / 61.685 | 80.009 | 79.793 / 81.39 / 57.225 | 79.793 |
| benign ASCII 2 KiB: Rust FFI prefilter + regex | 8.139 / 8.041 / 7.889 | 8.041 | 7.717 / 7.407 / 7.638 | 7.638 |
| benign ASCII 2 KiB: Rust FFI RegexSet + prefilter | 17.606 / 20.079 / 16.095 | 17.606 | 15.761 / 19.149 / 15.129 | 15.761 |
| benign ASCII 2 KiB: Rust WASM prefilter + regex | 14.293 / 14.434 / 14.772 | 14.434 | 13.689 / 13.892 / 14.425 | 13.892 |
| benign non-ASCII 2 KiB: TS secretHits (full gate, incl. eden-*) | 142.64 / 124.931 / 116.945 | 124.931 | 126.749 / 112.355 / 111.972 | 112.355 |
| benign non-ASCII 2 KiB: TS gitleaks rules only | 155.056 / 130.782 / 97.154 | 130.782 | 150.037 / 125.158 / 91.663 | 125.158 |
| benign non-ASCII 2 KiB: Rust FFI prefilter + regex | 9.957 / 11.427 / 7.835 | 9.957 | 9.495 / 10.901 / 7.363 | 9.495 |
| benign non-ASCII 2 KiB: Rust FFI RegexSet + prefilter | 19.135 / 19.511 / 14.99 | 19.135 | 15.273 / 18.648 / 14.55 | 15.273 |
| benign non-ASCII 2 KiB: Rust WASM prefilter + regex | 15.927 / 14.209 / 13.229 | 14.209 | 15.233 / 13.516 / 12.85 | 13.516 |
| benign ASCII 16 KiB: TS secretHits (full gate, incl. eden-*) | 1427.647 / 1419.386 / 1397.051 | 1419.386 | 1364.151 / 1347.934 / 1333.594 | 1347.934 |
| benign ASCII 16 KiB: TS gitleaks rules only | 1246.557 / 1134.816 / 1040.38 | 1134.816 | 1246.602 / 1083.409 / 989.837 | 1083.409 |
| benign ASCII 16 KiB: Rust FFI prefilter + regex | 164.768 / 131.502 / 137.048 | 137.048 | 165.034 / 121.711 / 124.442 | 124.442 |
| benign ASCII 16 KiB: Rust FFI RegexSet + prefilter | 179.565 / 183.936 / 199.448 | 183.936 | 175.634 / 173.404 / 180.566 | 175.634 |
| benign ASCII 16 KiB: Rust WASM prefilter + regex | 265.757 / 230.197 / 292.735 | 265.757 | 254.67 / 229.55 / 285.543 | 254.67 |
| 3 secrets ~2 KiB: TS secretHits (full gate, incl. eden-*) | 169.068 / 103.787 / 106.116 | 106.116 | 166.635 / 97.98 / 98.355 | 98.355 |
| 3 secrets ~2 KiB: TS gitleaks rules only | 107.426 / 73.476 / 77.576 | 77.576 | 109.745 / 67.058 / 65.523 | 67.058 |
| 3 secrets ~2 KiB: Rust FFI prefilter + regex | 20.618 / 16.237 / 15.798 | 16.237 | 20.309 / 15.073 / 15.309 | 15.309 |
| 3 secrets ~2 KiB: Rust FFI RegexSet + prefilter | 35.11 / 24.026 / 24.202 | 24.202 | 33.341 / 23.351 / 23.293 | 23.351 |
| 3 secrets ~2 KiB: Rust WASM prefilter + regex | 35.955 / 27.268 / 32.892 | 32.892 | 34.619 / 25.523 / 33.396 | 33.396 |

### secrets-native-cpu

| case | mean per run | median mean | p50 per run | median p50 |
|---|---|---:|---|---:|
| benign ASCII 256 B: TS secretHits (full gate, incl. eden-*) | 26.641 / 20.204 / 20.762 | 20.762 | 23.244 / 17.192 / 17.528 | 17.528 |
| benign ASCII 256 B: TS gitleaks rules only | 25.483 / 21.719 / 15.959 | 21.719 | 22.454 / 21.924 / 14.364 | 21.924 |
| benign ASCII 256 B: Rust FFI prefilter + regex | 2.165 / 1.548 / 1.44 | 1.548 | 1.815 / 1.206 / 1.112 | 1.206 |
| benign ASCII 256 B: Rust FFI RegexSet + prefilter | 2.631 / 3.748 / 2.484 | 2.631 | 2.228 / 3.454 / 2.193 | 2.228 |
| benign ASCII 256 B: Rust WASM prefilter + regex | 2.139 / 2.73 / 1.979 | 2.139 | 1.972 / 2.624 / 1.876 | 1.972 |
| benign ASCII 2 KiB: TS secretHits (full gate, incl. eden-*) | 105.285 / 92.976 / 93.157 | 93.157 | 89.242 / 87.33 / 85.439 | 87.33 |
| benign ASCII 2 KiB: TS gitleaks rules only | 60.252 / 60.231 / 58.523 | 60.231 | 57.368 / 57.122 / 55.48 | 57.122 |
| benign ASCII 2 KiB: Rust FFI prefilter + regex | 7.687 / 8.092 / 7.285 | 7.687 | 7.683 / 7.724 / 7.036 | 7.683 |
| benign ASCII 2 KiB: Rust FFI RegexSet + prefilter | 14.492 / 15.98 / 18.35 | 15.98 | 13.722 / 15.538 / 15.552 | 15.538 |
| benign ASCII 2 KiB: Rust WASM prefilter + regex | 14.652 / 15.087 / 15.215 | 15.087 | 14.185 / 14.642 / 13.762 | 14.185 |
| benign non-ASCII 2 KiB: TS secretHits (full gate, incl. eden-*) | 114.341 / 115.104 / 114.045 | 114.341 | 110.991 / 111.093 / 111 | 111 |
| benign non-ASCII 2 KiB: TS gitleaks rules only | 102.902 / 97.427 / 89.963 | 97.427 | 98.662 / 91.056 / 87.478 | 91.056 |
| benign non-ASCII 2 KiB: Rust FFI prefilter + regex | 10.055 / 7.945 / 8.693 | 8.693 | 9.26 / 7.397 / 7.42 | 7.42 |
| benign non-ASCII 2 KiB: Rust FFI RegexSet + prefilter | 20.386 / 15.655 / 20.365 | 20.365 | 18.757 / 14.923 / 19.932 | 18.757 |
| benign non-ASCII 2 KiB: Rust WASM prefilter + regex | 18.434 / 13.787 / 15.081 | 15.081 | 15.769 / 13.273 / 14.519 | 14.519 |
| benign ASCII 16 KiB: TS secretHits (full gate, incl. eden-*) | 1468.072 / 1524.293 / 1533.781 | 1524.293 | 1371.109 / 1388.721 / 1427.462 | 1388.721 |
| benign ASCII 16 KiB: TS gitleaks rules only | 1060.795 / 990.765 / 1085.467 | 1060.795 | 1001.622 / 962.364 / 1007.242 | 1001.622 |
| benign ASCII 16 KiB: Rust FFI prefilter + regex | 130.813 / 158.972 / 111.727 | 130.813 | 120.16 / 157.584 / 108.646 | 120.16 |
| benign ASCII 16 KiB: Rust FFI RegexSet + prefilter | 192.339 / 245.553 / 179.62 | 192.339 | 174.335 / 238.294 / 170.34 | 174.335 |
| benign ASCII 16 KiB: Rust WASM prefilter + regex | 241.109 / 269.813 / 241.444 | 241.444 | 236.245 / 264.066 / 238.639 | 238.639 |
| 3 secrets ~2 KiB: TS secretHits (full gate, incl. eden-*) | 108.429 / 164.418 / 104.933 | 108.429 | 98.936 / 161.965 / 97.816 | 98.936 |
| 3 secrets ~2 KiB: TS gitleaks rules only | 80.396 / 88.921 / 69.783 | 80.396 | 69.602 / 70.488 / 65.772 | 69.602 |
| 3 secrets ~2 KiB: Rust FFI prefilter + regex | 17.953 / 16.269 / 14.777 | 16.269 | 15.759 / 14.789 / 13.897 | 14.789 |
| 3 secrets ~2 KiB: Rust FFI RegexSet + prefilter | 27.876 / 26.569 / 23.315 | 26.569 | 23.933 / 23.528 / 22.755 | 23.528 |
| 3 secrets ~2 KiB: Rust WASM prefilter + regex | 29.393 / 38.377 / 26.208 | 29.393 | 26.938 / 36.529 / 25.092 | 26.938 |

### secrets-profile

| case | mean per run | median mean | p50 per run | median p50 |
|---|---|---:|---|---:|
| eden-cfat.spans() | 0.601 / 0.504 / 0.352 | 0.504 | 0.383 / 0.358 / 0.213 | 0.358 |
| eden-openai.spans() | 0.621 / 0.495 / 0.503 | 0.503 | 0.364 / 0.327 / 0.341 | 0.341 |
| eden-mailgun.spans() | 0.554 / 0.78 / 0.575 | 0.575 | 0.287 / 0.29 / 0.321 | 0.29 |
| eden-telegram.spans() | 1.507 / 1.653 / 1.391 | 1.507 | 1.229 / 1.422 / 1.079 | 1.229 |
| eden-aws-key-id.spans() | 0.414 / 0.398 / 0.375 | 0.398 | 0.203 / 0.213 / 0.194 | 0.203 |
| eden-keyword.spans() | 4.241 / 4.113 / 3.96 | 4.113 | 3.445 / 3.752 / 3.394 | 3.445 |
| eden-url-userinfo.spans() | 6.331 / 8.303 / 5.703 | 6.331 | 5.656 / 8.091 / 5.475 | 5.656 |
| eden-entropy-keyword.spans() | 9.318 / 9.809 / 9.269 | 9.318 | 8.697 / 9.129 / 8.703 | 8.703 |
| eden-legacy-keyword.spans() | 1.454 / 1.174 / 1.303 | 1.303 | 1.121 / 0.921 / 1.029 | 1.029 |
| eden-legacy-token.spans() | 0.926 / 1.245 / 1.017 | 1.017 | 0.778 / 0.971 / 0.785 | 0.785 |
| benign ASCII 256 B: keyword gate, includes per keyword (as secrets.ts) | 16.027 / 25.446 / 16.603 | 16.603 | 12.239 / 21.343 / 12.048 | 12.239 |
| benign ASCII 256 B: keyword gate, one regex | 10.038 / 10.438 / 10.259 | 10.259 | 5.658 / 6.077 / 5.814 | 5.814 |
| benign ASCII 256 B: TS gitleaks rules, includes gate | 22.897 / 20.613 / 21.895 | 21.895 | 13.852 / 13.523 / 13.932 | 13.852 |
| benign ASCII 256 B: TS gitleaks rules, one-regex gate | 11.3 / 13.64 / 12.379 | 12.379 | 6.669 / 8.45 / 7.745 | 7.745 |
| benign ASCII 2 KiB: keyword gate, includes per keyword (as secrets.ts) | 76.833 / 96.863 / 90.825 | 90.825 | 59.162 / 90.789 / 94.824 | 90.789 |
| benign ASCII 2 KiB: keyword gate, one regex | 47.032 / 44.186 / 36.755 | 44.186 | 44.661 / 39.999 / 32.308 | 39.999 |
| benign ASCII 2 KiB: TS gitleaks rules, includes gate | 112.733 / 97.417 / 69.635 | 97.417 | 100.325 / 92.13 / 57.389 | 92.13 |
| benign ASCII 2 KiB: TS gitleaks rules, one-regex gate | 53.912 / 46.572 / 37.945 | 46.572 | 47.25 / 39.445 / 32.486 | 39.445 |
| benign non-ASCII 2 KiB: keyword gate, includes per keyword (as secrets.ts) | 123.316 / 110.726 / 110.614 | 110.726 | 94.945 / 94.852 / 101.216 | 94.945 |
| benign non-ASCII 2 KiB: keyword gate, one regex | 33.259 / 44.629 / 37.531 | 37.531 | 27.136 / 40.319 / 29.118 | 29.118 |
| benign non-ASCII 2 KiB: TS gitleaks rules, includes gate | 160.341 / 157.04 / 153.35 | 157.04 | 145.938 / 147.089 / 146.67 | 146.67 |
| benign non-ASCII 2 KiB: TS gitleaks rules, one-regex gate | 38.013 / 31.701 / 39.238 | 38.013 | 33.084 / 27.056 / 34.968 | 33.084 |
| benign ASCII 16 KiB: keyword gate, includes per keyword (as secrets.ts) | 1113.375 / 1167.799 / 1154.519 | 1154.519 | 1029.317 / 1147.856 / 1097.836 | 1097.836 |
| benign ASCII 16 KiB: keyword gate, one regex | 397.494 / 412.626 / 306.893 | 397.494 | 387.722 / 402.655 / 288.124 | 387.722 |
| benign ASCII 16 KiB: TS gitleaks rules, includes gate | 1091.245 / 1162.258 / 1091.468 | 1091.468 | 1011.261 / 1058.074 / 1003.089 | 1011.261 |
| benign ASCII 16 KiB: TS gitleaks rules, one-regex gate | 318.043 / 353.739 / 337.272 | 337.272 | 289.749 / 308.368 / 302.845 | 302.845 |
| 3 secrets ~2 KiB: keyword gate, includes per keyword (as secrets.ts) | 63.349 / 90.248 / 60.377 | 63.349 | 55.272 / 84.252 / 54.751 | 55.272 |
| 3 secrets ~2 KiB: keyword gate, one regex | 46.077 / 48.09 / 37.198 | 46.077 | 34.748 / 33.828 / 32.449 | 33.828 |
| 3 secrets ~2 KiB: TS gitleaks rules, includes gate | 99.357 / 107.384 / 94.966 | 99.357 | 66.112 / 94.019 / 68.665 | 68.665 |
| 3 secrets ~2 KiB: TS gitleaks rules, one-regex gate | 67.357 / 85.043 / 60.613 | 67.357 | 44.242 / 65.719 / 44.233 | 44.242 |

### builtins

| case | mean per run | median mean | p50 per run | median p50 |
|---|---|---:|---|---:|
| ASCII 256 B: Bun.hash(str) (wyhash) | 0.089 / 0.063 / 0.052 | 0.063 | 0.066 / 0.035 / 0.033 | 0.035 |
| ASCII 256 B: Bun.hash.murmur32v3(str) | 0.291 / 0.14 / 0.163 | 0.163 | 0.274 / 0.13 / 0.135 | 0.135 |
| ASCII 256 B: Bun.hash.murmur32v3(bytes) | 0.137 / 0.27 / 0.137 | 0.137 | 0.131 / 0.26 / 0.131 | 0.131 |
| ASCII 256 B: TS murmur3(bytes) | 0.137 / 0.239 / 0.195 | 0.195 | 0.129 / 0.225 / 0.188 | 0.188 |
| ASCII 256 B: TS encodeInto + murmur3 | 0.406 / 0.428 / 0.267 | 0.406 | 0.343 / 0.345 / 0.194 | 0.343 |
| ASCII 256 B: Rust FFI encodeInto + murmur3 | 0.231 / 0.303 / 0.25 | 0.25 | 0.185 / 0.237 / 0.191 | 0.191 |
| ASCII 256 B: str.normalize('NFKC') | 0.025 / 0.044 / 0.027 | 0.027 | 0.024 / 0.042 / 0.026 | 0.026 |
| ASCII 256 B: str.toLowerCase() | 0.257 / 0.298 / 0.306 | 0.298 | 0.221 / 0.236 / 0.228 | 0.228 |
| ASCII 2048 B: Bun.hash(str) (wyhash) | 0.162 / 0.155 / 0.148 | 0.155 | 0.131 / 0.135 / 0.133 | 0.133 |
| ASCII 2048 B: Bun.hash.murmur32v3(str) | 0.997 / 0.981 / 1.086 | 0.997 | 0.897 / 0.923 / 0.925 | 0.923 |
| ASCII 2048 B: Bun.hash.murmur32v3(bytes) | 0.924 / 1.148 / 0.844 | 0.924 | 0.873 / 0.9 / 0.795 | 0.873 |
| ASCII 2048 B: TS murmur3(bytes) | 1.218 / 1.072 / 1.849 | 1.218 | 1.077 / 1.037 / 1.744 | 1.077 |
| ASCII 2048 B: TS encodeInto + murmur3 | 1.86 / 1.156 / 1.431 | 1.431 | 1.797 / 1.102 / 1.106 | 1.106 |
| ASCII 2048 B: Rust FFI encodeInto + murmur3 | 1.115 / 1.082 / 1.202 | 1.115 | 1.053 / 0.973 / 1.143 | 1.053 |
| ASCII 2048 B: str.normalize('NFKC') | 0.039 / 0.047 / 0.043 | 0.043 | 0.039 / 0.039 / 0.041 | 0.039 |
| ASCII 2048 B: str.toLowerCase() | 3.666 / 3.193 / 2.31 | 3.193 | 2.978 / 2.05 / 1.4 | 2.05 |
| ASCII 16384 B: Bun.hash(str) (wyhash) | 0.919 / 1.675 / 1.818 | 1.675 | 0.9 / 1.493 / 1.764 | 1.493 |
| ASCII 16384 B: Bun.hash.murmur32v3(str) | 6.867 / 14.067 / 15.886 | 14.067 | 6.842 / 13.48 / 15.65 | 13.48 |
| ASCII 16384 B: Bun.hash.murmur32v3(bytes) | 6.931 / 7.488 / 7.572 | 7.488 | 6.691 / 6.924 / 6.695 | 6.695 |
| ASCII 16384 B: TS murmur3(bytes) | 9.475 / 8.719 / 8.625 | 8.719 | 8.403 / 8.393 / 8.389 | 8.393 |
| ASCII 16384 B: TS encodeInto + murmur3 | 10.054 / 9.561 / 8.946 | 9.561 | 8.407 / 8.598 / 8.608 | 8.598 |
| ASCII 16384 B: Rust FFI encodeInto + murmur3 | 8.032 / 7.787 / 8.05 | 8.032 | 7.782 / 7.536 / 7.524 | 7.536 |
| ASCII 16384 B: str.normalize('NFKC') | 0.218 / 0.216 / 0.204 | 0.216 | 0.183 / 0.188 / 0.187 | 0.187 |
| ASCII 16384 B: str.toLowerCase() | 26.005 / 26.388 / 24.754 | 26.005 | 11.278 / 11.57 / 12.027 | 11.57 |
| non-ASCII 256 B: Bun.hash(str) (wyhash) | 0.176 / 0.092 / 0.097 | 0.097 | 0.137 / 0.081 / 0.084 | 0.084 |
| non-ASCII 256 B: Bun.hash.murmur32v3(str) | 0.333 / 0.304 / 0.201 | 0.304 | 0.318 / 0.313 / 0.17 | 0.313 |
| non-ASCII 256 B: Bun.hash.murmur32v3(bytes) | 0.153 / 0.134 / 0.127 | 0.134 | 0.126 / 0.129 / 0.125 | 0.126 |
| non-ASCII 256 B: TS murmur3(bytes) | 0.152 / 0.211 / 0.136 | 0.152 | 0.147 / 0.203 / 0.132 | 0.147 |
| non-ASCII 256 B: TS encodeInto + murmur3 | 0.321 / 0.523 / 0.384 | 0.384 | 0.219 / 0.426 / 0.334 | 0.334 |
| non-ASCII 256 B: Rust FFI encodeInto + murmur3 | 0.294 / 0.249 / 0.247 | 0.249 | 0.222 / 0.212 / 0.204 | 0.212 |
| non-ASCII 256 B: str.normalize('NFKC') | 0.295 / 0.309 / 0.236 | 0.295 | 0.231 / 0.328 / 0.192 | 0.231 |
| non-ASCII 256 B: str.toLowerCase() | 0.666 / 1.178 / 0.532 | 0.666 | 0.349 / 0.781 / 0.31 | 0.349 |
| non-ASCII 2048 B: Bun.hash(str) (wyhash) | 0.385 / 0.582 / 0.41 | 0.41 | 0.35 / 0.511 / 0.301 | 0.35 |
| non-ASCII 2048 B: Bun.hash.murmur32v3(str) | 1.802 / 1.975 / 1.046 | 1.802 | 1.784 / 1.928 / 1.003 | 1.784 |
| non-ASCII 2048 B: Bun.hash.murmur32v3(bytes) | 1.264 / 1.803 / 0.945 | 1.264 | 1.186 / 1.755 / 0.906 | 1.186 |
| non-ASCII 2048 B: TS murmur3(bytes) | 1.521 / 1.697 / 1.256 | 1.521 | 1.473 / 1.635 / 1.081 | 1.473 |
| non-ASCII 2048 B: TS encodeInto + murmur3 | 1.586 / 1.44 / 1.427 | 1.44 | 1.388 / 1.338 / 1.298 | 1.338 |
| non-ASCII 2048 B: Rust FFI encodeInto + murmur3 | 1.471 / 1.245 / 1.101 | 1.245 | 1.327 / 1.196 / 1.053 | 1.196 |
| non-ASCII 2048 B: str.normalize('NFKC') | 1.994 / 2.341 / 2.113 | 2.113 | 1.622 / 1.515 / 2.36 | 1.622 |
| non-ASCII 2048 B: str.toLowerCase() | 7.219 / 7.731 / 6.429 | 7.219 | 4.411 / 4.509 / 3.121 | 4.411 |
| non-ASCII 16384 B: Bun.hash(str) (wyhash) | 4.138 / 2.711 / 2.753 | 2.753 | 3.933 / 2.61 / 2.534 | 2.61 |
| non-ASCII 16384 B: Bun.hash.murmur32v3(str) | 16.024 / 8.956 / 8.776 | 8.956 | 15.485 / 8.468 / 8.483 | 8.483 |
| non-ASCII 16384 B: Bun.hash.murmur32v3(bytes) | 7.193 / 8.294 / 9.056 | 8.294 | 6.922 / 7.161 / 7.163 | 7.161 |
| non-ASCII 16384 B: TS murmur3(bytes) | 12.848 / 8.563 / 8.055 | 8.563 | 12.584 / 8.223 / 8.086 | 8.223 |
| non-ASCII 16384 B: TS encodeInto + murmur3 | 14.214 / 15.335 / 15.057 | 15.057 | 16.235 / 14.794 / 14.633 | 14.794 |
| non-ASCII 16384 B: Rust FFI encodeInto + murmur3 | 10.735 / 10.621 / 10.028 | 10.621 | 9.916 / 9.96 / 9.247 | 9.916 |
| non-ASCII 16384 B: str.normalize('NFKC') | 23.912 / 22.002 / 22.392 | 22.392 | 23.751 / 20.395 / 21.703 | 21.703 |
| non-ASCII 16384 B: str.toLowerCase() | 36.159 / 40.728 / 39.132 | 39.132 | 23.054 / 22.456 / 22.369 | 22.456 |

### napi-bun

| case | mean per run | median mean | p50 per run | median p50 |
|---|---|---:|---|---:|
| napi noop() | 138.6 / 138.6 / 154.3 | 138.6 | 55.7 / 54.7 / 55.2 | 55.2 |
| napi sumBytes(Uint8Array 256) | 575.4 / 439 / 466.2 | 466.2 | 365.8 / 342.9 / 344.8 | 344.8 |
| ASCII 256 B: napi tokenizeHash(string) | 1.045 / 1.187 / 3.436 | 1.187 | 0.907 / 0.865 / 0.887 | 0.887 |
| ASCII 256 B: napi encodeInto + tokenizeHashBytes | 1.121 / 1.768 / 2.048 | 1.768 | 0.973 / 1.589 / 1.719 | 1.589 |
| ASCII 2048 B: napi tokenizeHash(string) | 4.016 / 6.379 / 6.16 | 6.16 | 3.817 / 6.486 / 5.477 | 5.477 |
| ASCII 2048 B: napi encodeInto + tokenizeHashBytes | 4.247 / 4.201 / 7.037 | 4.247 | 3.816 / 3.804 / 6.461 | 3.816 |
| ASCII 16384 B: napi tokenizeHash(string) | 42.422 / 41.537 / 59.537 | 42.422 | 39.087 / 37.477 / 57.554 | 39.087 |
| ASCII 16384 B: napi encodeInto + tokenizeHashBytes | 42.035 / 38.968 / 50.929 | 42.035 | 39.882 / 37.252 / 51.595 | 39.882 |
| non-ASCII 256 B: napi tokenizeHash(string) | 2.232 / 3.377 / 2.014 | 2.232 | 2.149 / 2.059 / 2.01 | 2.059 |
| non-ASCII 256 B: napi encodeInto + tokenizeHashBytes | 2.605 / 2.283 / 2.322 | 2.322 | 2.39 / 2.038 / 2.214 | 2.214 |
| non-ASCII 2048 B: napi tokenizeHash(string) | 12.737 / 15.886 / 11.627 | 12.737 | 12.105 / 15.568 / 11.282 | 12.105 |
| non-ASCII 2048 B: napi encodeInto + tokenizeHashBytes | 13.819 / 12.971 / 13.183 | 13.183 | 12.856 / 12.235 / 12.246 | 12.246 |
| non-ASCII 16384 B: napi tokenizeHash(string) | 116.666 / 159.461 / 103.39 | 116.666 | 106.581 / 162.411 / 100.803 | 106.581 |
| non-ASCII 16384 B: napi encodeInto + tokenizeHashBytes | 121.302 / 128.96 / 108.645 | 121.302 | 114.379 / 117.645 / 107.365 | 114.379 |

### napi-node

| case | mean per run | median mean | p50 per run | median p50 |
|---|---|---:|---|---:|
| napi noop() | 45.9 / 26.4 / 25.3 | 26.4 | 40.7 / 23.1 / 23.1 | 23.1 |
| napi sumBytes(Uint8Array 256) | 263.4 / 356.4 / 250.7 | 263.4 | 236.7 / 387.5 / 220.4 | 236.7 |
| ASCII 256 B: napi tokenizeHash(string) | 1.397 / 0.951 / 0.874 | 0.951 | 1.417 / 0.86 / 0.777 | 0.86 |
| ASCII 256 B: napi encodeInto + tokenizeHashBytes | 1.583 / 1.633 / 0.827 | 1.583 | 1.519 / 1.58 / 0.774 | 1.519 |
| ASCII 2048 B: napi tokenizeHash(string) | 4.673 / 7.394 / 7.192 | 7.192 | 4.096 / 7.271 / 7.108 | 7.108 |
| ASCII 2048 B: napi encodeInto + tokenizeHashBytes | 7.044 / 6.643 / 7.064 | 7.044 | 6.796 / 6.352 / 6.875 | 6.796 |
| ASCII 16384 B: napi tokenizeHash(string) | 53.479 / 54.538 / 48.47 | 53.479 | 42.12 / 46.026 / 42.248 | 42.248 |
| ASCII 16384 B: napi encodeInto + tokenizeHashBytes | 52.125 / 39.94 / 45.652 | 45.652 | 56.005 / 38.855 / 39.357 | 39.357 |
| non-ASCII 256 B: napi tokenizeHash(string) | 3.874 / 2.349 / 2.514 | 2.514 | 3.825 / 2.293 / 2.325 | 2.325 |
| non-ASCII 256 B: napi encodeInto + tokenizeHashBytes | 3.933 / 3.246 / 3.487 | 3.487 | 3.789 / 3.127 / 3.205 | 3.205 |
| non-ASCII 2048 B: napi tokenizeHash(string) | 32.512 / 15.21 / 14.448 | 15.21 | 18.56 / 14.012 / 13.887 | 14.012 |
| non-ASCII 2048 B: napi encodeInto + tokenizeHashBytes | 26.254 / 20.633 / 13.829 | 20.633 | 22.066 / 20.087 / 13.232 | 20.087 |
| non-ASCII 16384 B: napi tokenizeHash(string) | 165.429 / 168.363 / 151.886 | 165.429 | 148.733 / 151.603 / 140.651 | 148.733 |
| non-ASCII 16384 B: napi encodeInto + tokenizeHashBytes | 147.752 / 141.932 / 119.675 | 141.932 | 135.835 / 131.008 / 116.107 | 131.008 |

## Appendix B: run A, verbatim

The output of `native/run-all.sh` run A, file by file, exactly as printed.

### verify

lib: /home/user/Eden/.claude/worktrees/agent-ab79e21ddb8b65076/native/eden-native/target/release/libeden_native.so

| text | UTF-8 bytes | non-ASCII share | tokens TS | Rust FFI | Rust FFI (UTF-16) | Rust WASM |
|---|---:|---:|---:|---:|---:|---:|
| edge-0 | 63 | 0.0% | 8 | 8 | 8 | 8 |
| edge-1 | 107 | 41.8% | 10 | 10 | 10 | 10 |
| edge-2 | 76 | 20.7% | 8 | 8 | 8 | 8 |
| ascii-256 | 256 | 0.0% | 45 | 45 | 45 | 45 |
| nonascii-256 | 256 | 12.3% | 36 | 36 | 36 | 36 |
| ascii-2048 | 2048 | 0.0% | 334 | 334 | 334 | 334 |
| nonascii-2048 | 2048 | 8.1% | 293 | 293 | 293 | 293 |
| ascii-16384 | 16384 | 0.0% | 2675 | 2675 | 2675 | 2675 |
| nonascii-16384 | 16382 | 8.2% | 2373 | 2373 | 2373 | 2373 |

murmur3: 5270 words checked (TS = Rust = Bun.hash.murmur32v3)

Rust scanner: 221 rules, 244 distinct keywords, RegexSet built: true

Rust regex compile time, all 270 regexes: 72.9 ms; slowest:
- rule `grafana-api-key`: 5.5 ms
- rule `bittrex-secret-key`: 4.4 ms
- rule `anthropic-api-key`: 4.2 ms
- rule `curl-auth-user`: 2.0 ms
- allowlist `generic-api-key`: 1.0 ms
- rule `generic-api-key`: 0.9 ms

| regexes | total | compile unchanged (regex::Regex defaults) | need brace translation | compile in scanner mode | of which Unicode off |
|---|---:|---:|---:|---:|---:|
| rule | 221 | 218 | 0 | 221 | 221 |
| allowlist | 49 | 45 | 4 | 49 | 49 |

Not compilable unchanged with regex::Regex defaults, or translated:
- allowlist `(global)`: `^\$(?:\d+|{\d+})$` — error: repetition operator missing expression; compiles in scanner mode
- allowlist `(global)`: `^\${(?:[A-Z_]+|[a-z_]+)}$` — error: repetition quantifier expects a valid decimal; compiles in scanner mode
- allowlist `curl-auth-user`: `['"]?\$?{{[^}]+}}['"]?:['"]?\$?{{[^}]+}}['"]?` — error: repetition quantifier expects a valid decimal; compiles in scanner mode
- rule `generic-api-key`: `(?i)[\w.-]{0,50}?(?:access|auth|(?-i:[Aa]pi|API)|credential|creds|key|` — Compiled regex exceeds size limit of 10485760 bytes.; compiles in scanner mode
- allowlist `generic-api-key`: `import[ \t]+{[ \t\w,]+}[ \t]+from[ \t]+['"][^'"]+['"]` — error: repetition quantifier expects a valid decimal; compiles in scanner mode
- rule `pypi-upload-token`: `pypi-AgEIcHlwaS5vcmc[\w-]{50,1000}` — Compiled regex exceeds size limit of 10485760 bytes.; compiles in scanner mode
- rule `vault-batch-token`: `\b(hvb\.[\w-]{138,300})(?:[\x60'"\s;]|\\[nr]|$)` — Compiled regex exceeds size limit of 10485760 bytes.; compiles in scanner mode

| text | chars | TS secretHits (gitleaks rules) | Rust FFI | Rust RegexSet | Rust WASM | eden-* (TS only) |
|---|---:|---|---|---|---|---|
| benign-ascii-256 | 256 | — | — | — | — | — |
| benign-nonascii-256 | 212 | — | — | — | — | — |
| benign-ascii-2048 | 2048 | — | — | — | — | — |
| benign-nonascii-2048 | 1820 | — | — | — | — | — |
| benign-ascii-16384 | 16384 | — | — | — | — | — |
| benign-nonascii-16384 | 14608 | — | — | — | — | — |
| three-secrets-2k | 2042 | aws-access-token, github-pat, slack-bot-token | aws-access-token, github-pat, slack-bot-token | aws-access-token, github-pat, slack-bot-token | aws-access-token, github-pat, slack-bot-token | eden-aws-key-id, eden-legacy-token |
| shape:github-pat | 653 | github-pat | github-pat | github-pat | github-pat | eden-legacy-token |
| shape:aws-access-token | 633 | aws-access-token | aws-access-token | aws-access-token | aws-access-token | eden-aws-key-id, eden-legacy-token |
| shape:slack-bot-token | 668 | slack-bot-token | slack-bot-token | slack-bot-token | slack-bot-token | — |
| shape:stripe-access-token | 653 | stripe-access-token | stripe-access-token | stripe-access-token | stripe-access-token | — |
| shape:gitlab-pat | 639 | gitlab-pat | gitlab-pat | gitlab-pat | gitlab-pat | — |
| shape:npm-access-token | 653 | npm-access-token | npm-access-token | npm-access-token | npm-access-token | — |
| shape:gcp-api-key | 652 | gcp-api-key | gcp-api-key | gcp-api-key | gcp-api-key | — |
| shape:shopify-access-token | 651 | shopify-access-token | shopify-access-token | shopify-access-token | shopify-access-token | — |
| shape:digitalocean-pat | 684 | digitalocean-pat | digitalocean-pat | digitalocean-pat | digitalocean-pat | — |
| shape:huggingface-access-token | 650 | huggingface-access-token | huggingface-access-token | huggingface-access-token | huggingface-access-token | — |
| shape:sendgrid-api-token | 682 | sendgrid-api-token | sendgrid-api-token | sendgrid-api-token | sendgrid-api-token | — |
| shape:anthropic-api-key | 721 | anthropic-api-key | anthropic-api-key | anthropic-api-key | anthropic-api-key | eden-legacy-token |
| shape:jwt | 734 | jwt | jwt | jwt | jwt | — |
| shape:private-key | 804 | private-key | private-key | private-key | private-key | — |
| shape:generic-api-key | 657 | generic-api-key | generic-api-key | generic-api-key | generic-api-key | eden-entropy-keyword, eden-keyword, eden-legacy-keyword |
| all-shapes | 4824 | anthropic-api-key, aws-access-token, digitalocean-pat, gcp-api-key, generic-api-key, github-pat, gitlab-pat, huggingface-access-token, jwt, npm-access-token, private-key, sendgrid-api-token, shopify-access-token, slack-bot-token, stripe-access-token | anthropic-api-key, aws-access-token, digitalocean-pat, gcp-api-key, generic-api-key, github-pat, gitlab-pat, huggingface-access-token, jwt, npm-access-token, private-key, sendgrid-api-token, shopify-access-token, slack-bot-token, stripe-access-token | anthropic-api-key, aws-access-token, digitalocean-pat, gcp-api-key, generic-api-key, github-pat, gitlab-pat, huggingface-access-token, jwt, npm-access-token, private-key, sendgrid-api-token, shopify-access-token, slack-bot-token, stripe-access-token | anthropic-api-key, aws-access-token, digitalocean-pat, gcp-api-key, generic-api-key, github-pat, gitlab-pat, huggingface-access-token, jwt, npm-access-token, private-key, sendgrid-api-token, shopify-access-token, slack-bot-token, stripe-access-token | eden-aws-key-id, eden-entropy-keyword, eden-keyword, eden-legacy-keyword, eden-legacy-token |

ALL CROSS-CHECKS AGREE

### ffi

lib: /home/user/Eden/.claude/worktrees/agent-ab79e21ddb8b65076/native/eden-native/target/release/libeden_native.so

### bun:ffi call overhead (bun 1.4.4)

| case | mean ns/op | p50 ns | p99 ns | ops/sample |
|---|---:|---:|---:|---:|
| JS empty function (baseline) | 3.1 | 3.6 | 13.8 | 1190 |
| ffi noop() | 7.7 | 6.1 | 22.6 | 1137 |
| ffi sum_bytes(Uint8Array, 256) | 46.9 | 33.6 | 152.0 | 619 |
| ffi sum_bytes(cached ptr number, 256) | 40.5 | 33.1 | 96.2 | 572 |
| ffi sum_bytes(ptr(arr) per call, 256) | 44.4 | 42.8 | 84.2 | 522 |
| JS sum of 256 bytes (loop) | 259.4 | 252.3 | 383.6 | 184 |
| ffi sum_bytes(Uint8Array, 2048) | 378.7 | 370.2 | 570.1 | 115 |
| ffi sum_bytes(Uint8Array, 16384) | 1576.2 | 1497.7 | 2410.0 | 30 |

### String marshalling: JS string to native-readable memory (bun 1.4.4)

| case | mean µs/op | p50 µs | p99 µs | ops/sample | ns/KiB (UTF-8 bytes) |
|---|---:|---:|---:|---:|---:|
| ASCII 256 B: encodeInto reused Uint8Array | 0.195 | 0.119 | 0.850 | 27 | 779.0 |
| ASCII 256 B: Buffer.from(str) | 0.287 | 0.087 | 0.200 | 14 | 1146.9 |
| ASCII 256 B: TextEncoder.encode(str) | 0.162 | 0.044 | 0.615 | 21 | 648.2 |
| ASCII 256 B: UTF-16 charCodeAt loop into reused Uint16Array | 0.241 | 0.199 | 0.453 | 16 | 963.7 |
| ASCII 256 B: UTF-16 Buffer.write(str, 'utf16le') reused | 0.066 | 0.054 | 0.124 | 49 | 263.2 |
| ASCII 256 B: encodeInto + ffi sum_bytes (end to end) | 0.208 | 0.147 | 0.466 | 19 | 832.2 |
| ASCII 256 B: Buffer.write utf16le + ffi sum_u16 (end to end) | 0.123 | 0.118 | 0.271 | 35 | 494.0 |
| ASCII 2048 B: encodeInto reused Uint8Array | 0.213 | 0.120 | 0.728 | 24 | 106.4 |
| ASCII 2048 B: Buffer.from(str) | 1.636 | 0.295 | 3.148 | 4 | 818.1 |
| ASCII 2048 B: TextEncoder.encode(str) | 1.918 | 0.210 | 7.096 | 4 | 958.8 |
| ASCII 2048 B: UTF-16 charCodeAt loop into reused Uint16Array | 2.295 | 2.042 | 5.382 | 3 | 1147.7 |
| ASCII 2048 B: UTF-16 Buffer.write(str, 'utf16le') reused | 0.187 | 0.190 | 0.348 | 20 | 93.3 |
| ASCII 2048 B: encodeInto + ffi sum_bytes (end to end) | 0.387 | 0.281 | 0.814 | 10 | 193.4 |
| ASCII 2048 B: Buffer.write utf16le + ffi sum_u16 (end to end) | 0.310 | 0.252 | 0.656 | 17 | 155.2 |
| ASCII 16384 B: encodeInto reused Uint8Array | 0.345 | 0.246 | 0.690 | 14 | 21.6 |
| ASCII 16384 B: Buffer.from(str) | 10.816 | 0.759 | 474.951 | 1 | 676.0 |
| ASCII 16384 B: TextEncoder.encode(str) | 10.609 | 0.704 | 463.838 | 1 | 663.1 |
| ASCII 16384 B: UTF-16 charCodeAt loop into reused Uint16Array | 12.448 | 11.189 | 26.005 | 1 | 778.0 |
| ASCII 16384 B: UTF-16 Buffer.write(str, 'utf16le') reused | 0.853 | 0.836 | 1.362 | 6 | 53.3 |
| ASCII 16384 B: encodeInto + ffi sum_bytes (end to end) | 1.753 | 1.685 | 2.997 | 3 | 109.6 |
| ASCII 16384 B: Buffer.write utf16le + ffi sum_u16 (end to end) | 1.791 | 1.680 | 4.921 | 3 | 111.9 |
| non-ASCII 256 B: encodeInto reused Uint8Array | 0.142 | 0.079 | 0.302 | 25 | 569.6 |
| non-ASCII 256 B: Buffer.from(str) | 0.600 | 0.126 | 1.659 | 11 | 2400.8 |
| non-ASCII 256 B: TextEncoder.encode(str) | 0.338 | 0.126 | 0.787 | 13 | 1350.5 |
| non-ASCII 256 B: UTF-16 charCodeAt loop into reused Uint16Array | 0.215 | 0.208 | 0.232 | 15 | 860.6 |
| non-ASCII 256 B: UTF-16 Buffer.write(str, 'utf16le') reused | 0.041 | 0.040 | 0.068 | 66 | 165.5 |
| non-ASCII 256 B: encodeInto + ffi sum_bytes (end to end) | 0.149 | 0.106 | 0.292 | 26 | 597.9 |
| non-ASCII 256 B: Buffer.write utf16le + ffi sum_u16 (end to end) | 0.054 | 0.053 | 0.106 | 52 | 215.2 |
| non-ASCII 2048 B: encodeInto reused Uint8Array | 0.331 | 0.258 | 0.621 | 14 | 165.3 |
| non-ASCII 2048 B: Buffer.from(str) | 1.455 | 0.372 | 4.961 | 3 | 727.5 |
| non-ASCII 2048 B: TextEncoder.encode(str) | 2.139 | 0.496 | 9.474 | 3 | 1069.5 |
| non-ASCII 2048 B: UTF-16 charCodeAt loop into reused Uint16Array | 1.673 | 1.638 | 2.808 | 3 | 836.7 |
| non-ASCII 2048 B: UTF-16 Buffer.write(str, 'utf16le') reused | 0.069 | 0.065 | 0.099 | 46 | 34.6 |
| non-ASCII 2048 B: encodeInto + ffi sum_bytes (end to end) | 0.488 | 0.459 | 0.969 | 10 | 243.9 |
| non-ASCII 2048 B: Buffer.write utf16le + ffi sum_u16 (end to end) | 0.247 | 0.236 | 0.498 | 17 | 123.7 |
| non-ASCII 16384 B: encodeInto reused Uint8Array | 3.384 | 3.055 | 7.514 | 2 | 211.5 |
| non-ASCII 16384 B: Buffer.from(str) | 16.236 | 4.313 | 521.962 | 1 | 1014.8 |
| non-ASCII 16384 B: TextEncoder.encode(str) | 13.060 | 2.830 | 444.905 | 1 | 816.4 |
| non-ASCII 16384 B: UTF-16 charCodeAt loop into reused Uint16Array | 20.111 | 18.960 | 39.482 | 1 | 1257.1 |
| non-ASCII 16384 B: UTF-16 Buffer.write(str, 'utf16le') reused | 0.759 | 0.741 | 1.208 | 7 | 47.4 |
| non-ASCII 16384 B: encodeInto + ffi sum_bytes (end to end) | 3.246 | 2.983 | 9.418 | 2 | 202.9 |
| non-ASCII 16384 B: Buffer.write utf16le + ffi sum_u16 (end to end) | 1.356 | 1.325 | 2.135 | 4 | 84.8 |

### ffi-native-cpu

lib: /home/user/Eden/.claude/worktrees/agent-ab79e21ddb8b65076/native/eden-native/target-native/release/libeden_native.so

### bun:ffi call overhead (bun 1.4.4)

| case | mean ns/op | p50 ns | p99 ns | ops/sample |
|---|---:|---:|---:|---:|
| JS empty function (baseline) | 2.9 | 3.0 | 8.1 | 1341 |
| ffi noop() | 6.9 | 6.7 | 15.2 | 1270 |
| ffi sum_bytes(Uint8Array, 256) | 16.5 | 16.3 | 34.7 | 858 |
| ffi sum_bytes(cached ptr number, 256) | 16.6 | 16.4 | 31.0 | 796 |
| ffi sum_bytes(ptr(arr) per call, 256) | 26.5 | 26.0 | 45.5 | 641 |
| JS sum of 256 bytes (loop) | 182.4 | 181.2 | 251.0 | 233 |
| ffi sum_bytes(Uint8Array, 2048) | 82.6 | 79.3 | 120.0 | 378 |
| ffi sum_bytes(Uint8Array, 16384) | 713.0 | 676.3 | 954.3 | 71 |

### String marshalling: JS string to native-readable memory (bun 1.4.4)

| case | mean µs/op | p50 µs | p99 µs | ops/sample | ns/KiB (UTF-8 bytes) |
|---|---:|---:|---:|---:|---:|
| ASCII 256 B: encodeInto reused Uint8Array | 0.113 | 0.066 | 0.238 | 30 | 450.5 |
| ASCII 256 B: Buffer.from(str) | 0.352 | 0.158 | 0.405 | 12 | 1408.9 |
| ASCII 256 B: TextEncoder.encode(str) | 0.204 | 0.069 | 0.531 | 21 | 817.9 |
| ASCII 256 B: UTF-16 charCodeAt loop into reused Uint16Array | 0.359 | 0.338 | 0.698 | 12 | 1434.1 |
| ASCII 256 B: UTF-16 Buffer.write(str, 'utf16le') reused | 0.047 | 0.045 | 0.057 | 51 | 188.0 |
| ASCII 256 B: encodeInto + ffi sum_bytes (end to end) | 0.120 | 0.063 | 0.213 | 31 | 478.4 |
| ASCII 256 B: Buffer.write utf16le + ffi sum_u16 (end to end) | 0.052 | 0.049 | 0.105 | 46 | 209.1 |
| ASCII 2048 B: encodeInto reused Uint8Array | 0.130 | 0.073 | 0.260 | 29 | 65.2 |
| ASCII 2048 B: Buffer.from(str) | 0.987 | 0.189 | 3.306 | 4 | 493.3 |
| ASCII 2048 B: TextEncoder.encode(str) | 1.270 | 0.191 | 76.772 | 5 | 635.0 |
| ASCII 2048 B: UTF-16 charCodeAt loop into reused Uint16Array | 2.824 | 2.512 | 5.881 | 2 | 1411.8 |
| ASCII 2048 B: UTF-16 Buffer.write(str, 'utf16le') reused | 0.165 | 0.154 | 0.319 | 23 | 82.4 |
| ASCII 2048 B: encodeInto + ffi sum_bytes (end to end) | 0.217 | 0.152 | 0.304 | 18 | 108.3 |
| ASCII 2048 B: Buffer.write utf16le + ffi sum_u16 (end to end) | 0.182 | 0.176 | 0.313 | 22 | 91.1 |
| ASCII 16384 B: encodeInto reused Uint8Array | 0.305 | 0.234 | 0.518 | 15 | 19.0 |
| ASCII 16384 B: Buffer.from(str) | 11.496 | 1.096 | 465.240 | 1 | 718.5 |
| ASCII 16384 B: TextEncoder.encode(str) | 9.791 | 0.753 | 396.397 | 1 | 612.0 |
| ASCII 16384 B: UTF-16 charCodeAt loop into reused Uint16Array | 21.371 | 21.623 | 50.346 | 1 | 1335.7 |
| ASCII 16384 B: UTF-16 Buffer.write(str, 'utf16le') reused | 0.954 | 0.907 | 1.750 | 5 | 59.6 |
| ASCII 16384 B: encodeInto + ffi sum_bytes (end to end) | 0.929 | 0.819 | 1.478 | 5 | 58.1 |
| ASCII 16384 B: Buffer.write utf16le + ffi sum_u16 (end to end) | 1.724 | 1.387 | 4.044 | 4 | 107.7 |
| non-ASCII 256 B: encodeInto reused Uint8Array | 0.169 | 0.082 | 0.367 | 24 | 674.5 |
| non-ASCII 256 B: Buffer.from(str) | 0.356 | 0.115 | 0.258 | 11 | 1424.5 |
| non-ASCII 256 B: TextEncoder.encode(str) | 0.224 | 0.076 | 1.005 | 19 | 894.6 |
| non-ASCII 256 B: UTF-16 charCodeAt loop into reused Uint16Array | 0.292 | 0.246 | 1.081 | 18 | 1166.2 |
| non-ASCII 256 B: UTF-16 Buffer.write(str, 'utf16le') reused | 0.045 | 0.041 | 0.089 | 59 | 178.2 |
| non-ASCII 256 B: encodeInto + ffi sum_bytes (end to end) | 0.144 | 0.088 | 0.226 | 24 | 577.1 |
| non-ASCII 256 B: Buffer.write utf16le + ffi sum_u16 (end to end) | 0.089 | 0.086 | 0.185 | 50 | 356.8 |
| non-ASCII 2048 B: encodeInto reused Uint8Array | 0.363 | 0.254 | 0.667 | 13 | 181.4 |
| non-ASCII 2048 B: Buffer.from(str) | 2.543 | 0.706 | 9.683 | 3 | 1271.4 |
| non-ASCII 2048 B: TextEncoder.encode(str) | 1.972 | 0.471 | 10.620 | 3 | 985.8 |
| non-ASCII 2048 B: UTF-16 charCodeAt loop into reused Uint16Array | 1.800 | 1.796 | 4.455 | 3 | 900.2 |
| non-ASCII 2048 B: UTF-16 Buffer.write(str, 'utf16le') reused | 0.060 | 0.058 | 0.065 | 48 | 30.0 |
| non-ASCII 2048 B: encodeInto + ffi sum_bytes (end to end) | 0.664 | 0.503 | 2.824 | 10 | 332.0 |
| non-ASCII 2048 B: Buffer.write utf16le + ffi sum_u16 (end to end) | 0.222 | 0.216 | 0.457 | 19 | 111.2 |
| non-ASCII 16384 B: encodeInto reused Uint8Array | 1.864 | 1.823 | 3.569 | 3 | 116.5 |
| non-ASCII 16384 B: Buffer.from(str) | 16.057 | 4.149 | 523.873 | 1 | 1003.7 |
| non-ASCII 16384 B: TextEncoder.encode(str) | 15.046 | 3.908 | 531.457 | 1 | 940.5 |
| non-ASCII 16384 B: UTF-16 charCodeAt loop into reused Uint16Array | 23.138 | 23.765 | 43.453 | 1 | 1446.3 |
| non-ASCII 16384 B: UTF-16 Buffer.write(str, 'utf16le') reused | 0.916 | 0.874 | 1.691 | 6 | 57.3 |
| non-ASCII 16384 B: encodeInto + ffi sum_bytes (end to end) | 2.715 | 2.494 | 5.103 | 2 | 169.7 |
| non-ASCII 16384 B: Buffer.write utf16le + ffi sum_u16 (end to end) | 1.117 | 1.097 | 1.807 | 5 | 69.8 |

### tokenize-bun


### Tokenize + murmur3 (end to end, incl. marshalling) (bun 1.4.4)

| case | mean µs/op | p50 µs | p99 µs | ops/sample | ns/KiB | tokens |
|---|---:|---:|---:|---:|---:|---:|
| ASCII 256 B: TS | 1.534 | 1.151 | 3.089 | 3 | 6136.5 | 45 |
| ASCII 256 B: TS scan + Bun.hash.murmur32v3(token) | 6.053 | 5.026 | 16.303 | 1 | 24211.6 | 45 |
| ASCII 256 B: Rust FFI (encodeInto UTF-8) | 1.030 | 1.044 | 2.154 | 6 | 4120.0 | 45 |
| ASCII 256 B: Rust FFI (UTF-16 charCodeAt loop) | 2.203 | 2.141 | 7.663 | 3 | 8810.6 | 45 |
| ASCII 256 B: Rust WASM (encodeInto) | 1.699 | 1.604 | 3.941 | 3 | 6797.9 | 45 |
| ASCII 2048 B: TS | 14.483 | 13.924 | 34.667 | 1 | 7241.5 | 334 |
| ASCII 2048 B: TS scan + Bun.hash.murmur32v3(token) | 52.576 | 48.208 | 106.954 | 1 | 26287.8 | 334 |
| ASCII 2048 B: Rust FFI (encodeInto UTF-8) | 4.119 | 3.762 | 12.777 | 1 | 2059.4 | 334 |
| ASCII 2048 B: Rust FFI (UTF-16 charCodeAt loop) | 12.428 | 13.020 | 32.659 | 1 | 6213.8 | 334 |
| ASCII 2048 B: Rust WASM (encodeInto) | 7.645 | 6.805 | 24.172 | 1 | 3822.7 | 334 |
| ASCII 16384 B: TS | 109.903 | 106.052 | 164.435 | 1 | 6868.9 | 2675 |
| ASCII 16384 B: TS scan + Bun.hash.murmur32v3(token) | 324.651 | 288.665 | 857.426 | 1 | 20290.7 | 2675 |
| ASCII 16384 B: Rust FFI (encodeInto UTF-8) | 37.700 | 33.840 | 76.619 | 1 | 2356.3 | 2675 |
| ASCII 16384 B: Rust FFI (UTF-16 charCodeAt loop) | 80.949 | 71.757 | 153.990 | 1 | 5059.3 | 2675 |
| ASCII 16384 B: Rust WASM (encodeInto) | 109.202 | 108.778 | 163.363 | 1 | 6825.1 | 2675 |
| non-ASCII 256 B: TS | 4.635 | 4.183 | 21.868 | 1 | 18539.7 | 36 |
| non-ASCII 256 B: TS scan + Bun.hash.murmur32v3(token) | 4.021 | 3.385 | 11.859 | 2 | 16085.4 | 36 |
| non-ASCII 256 B: Rust FFI (encodeInto UTF-8) | 3.157 | 2.976 | 5.681 | 2 | 12627.4 | 36 |
| non-ASCII 256 B: Rust FFI (UTF-16 charCodeAt loop) | 3.583 | 2.499 | 8.673 | 2 | 14332.9 | 36 |
| non-ASCII 256 B: Rust WASM (encodeInto) | 4.451 | 4.221 | 13.856 | 2 | 17803.7 | 36 |
| non-ASCII 2048 B: TS | 23.713 | 19.107 | 56.216 | 1 | 11856.5 | 293 |
| non-ASCII 2048 B: TS scan + Bun.hash.murmur32v3(token) | 38.375 | 32.703 | 87.212 | 1 | 19187.4 | 293 |
| non-ASCII 2048 B: Rust FFI (encodeInto UTF-8) | 13.633 | 12.814 | 32.502 | 1 | 6816.6 | 293 |
| non-ASCII 2048 B: Rust FFI (UTF-16 charCodeAt loop) | 17.567 | 16.254 | 41.763 | 1 | 8783.6 | 293 |
| non-ASCII 2048 B: Rust WASM (encodeInto) | 20.364 | 19.296 | 41.129 | 1 | 10182.0 | 293 |
| non-ASCII 16384 B: TS | 212.301 | 193.811 | 719.716 | 1 | 13270.4 | 2373 |
| non-ASCII 16384 B: TS scan + Bun.hash.murmur32v3(token) | 393.578 | 336.355 | 1061.057 | 1 | 24601.6 | 2373 |
| non-ASCII 16384 B: Rust FFI (encodeInto UTF-8) | 162.494 | 165.185 | 272.989 | 1 | 10157.1 | 2373 |
| non-ASCII 16384 B: Rust FFI (UTF-16 charCodeAt loop) | 184.243 | 159.982 | 314.394 | 1 | 11516.6 | 2373 |
| non-ASCII 16384 B: Rust WASM (encodeInto) | 232.790 | 241.478 | 340.287 | 1 | 14551.2 | 2373 |

### tokenize-bun-native-cpu


### Tokenize + murmur3 (end to end, incl. marshalling) (bun 1.4.4)

| case | mean µs/op | p50 µs | p99 µs | ops/sample | ns/KiB | tokens |
|---|---:|---:|---:|---:|---:|---:|
| ASCII 256 B: TS | 1.017 | 0.966 | 1.997 | 4 | 4068.7 | 45 |
| ASCII 256 B: TS scan + Bun.hash.murmur32v3(token) | 3.407 | 2.924 | 8.899 | 2 | 13629.9 | 45 |
| ASCII 256 B: Rust FFI (encodeInto UTF-8) | 0.625 | 0.499 | 2.199 | 7 | 2501.8 | 45 |
| ASCII 256 B: Rust FFI (UTF-16 charCodeAt loop) | 1.511 | 1.411 | 2.780 | 4 | 6042.1 | 45 |
| ASCII 256 B: Rust WASM (encodeInto) | 1.105 | 0.935 | 3.150 | 5 | 4419.9 | 45 |
| ASCII 2048 B: TS | 9.166 | 8.092 | 21.436 | 1 | 4582.9 | 334 |
| ASCII 2048 B: TS scan + Bun.hash.murmur32v3(token) | 34.609 | 28.996 | 82.702 | 1 | 17304.5 | 334 |
| ASCII 2048 B: Rust FFI (encodeInto UTF-8) | 4.054 | 3.629 | 10.671 | 2 | 2026.9 | 334 |
| ASCII 2048 B: Rust FFI (UTF-16 charCodeAt loop) | 11.086 | 10.298 | 23.686 | 1 | 5542.8 | 334 |
| ASCII 2048 B: Rust WASM (encodeInto) | 9.334 | 8.914 | 22.663 | 1 | 4667.0 | 334 |
| ASCII 16384 B: TS | 139.897 | 143.561 | 220.700 | 1 | 8743.6 | 2675 |
| ASCII 16384 B: TS scan + Bun.hash.murmur32v3(token) | 353.989 | 296.030 | 1138.229 | 1 | 22124.3 | 2675 |
| ASCII 16384 B: Rust FFI (encodeInto UTF-8) | 35.719 | 34.676 | 59.445 | 1 | 2232.4 | 2675 |
| ASCII 16384 B: Rust FFI (UTF-16 charCodeAt loop) | 94.024 | 90.660 | 156.141 | 1 | 5876.5 | 2675 |
| ASCII 16384 B: Rust WASM (encodeInto) | 123.036 | 123.035 | 170.823 | 1 | 7689.8 | 2675 |
| non-ASCII 256 B: TS | 5.690 | 4.454 | 20.577 | 1 | 22762.0 | 36 |
| non-ASCII 256 B: TS scan + Bun.hash.murmur32v3(token) | 7.973 | 5.757 | 36.557 | 1 | 31892.2 | 36 |
| non-ASCII 256 B: Rust FFI (encodeInto UTF-8) | 2.206 | 1.925 | 7.325 | 3 | 8822.9 | 36 |
| non-ASCII 256 B: Rust FFI (UTF-16 charCodeAt loop) | 2.784 | 2.680 | 5.282 | 2 | 11137.3 | 36 |
| non-ASCII 256 B: Rust WASM (encodeInto) | 2.915 | 2.813 | 5.959 | 2 | 11658.4 | 36 |
| non-ASCII 2048 B: TS | 37.166 | 33.772 | 72.656 | 1 | 18583.2 | 293 |
| non-ASCII 2048 B: TS scan + Bun.hash.murmur32v3(token) | 47.567 | 38.912 | 115.347 | 1 | 23783.5 | 293 |
| non-ASCII 2048 B: Rust FFI (encodeInto UTF-8) | 21.468 | 20.440 | 42.296 | 1 | 10734.2 | 293 |
| non-ASCII 2048 B: Rust FFI (UTF-16 charCodeAt loop) | 19.223 | 18.515 | 33.258 | 1 | 9611.4 | 293 |
| non-ASCII 2048 B: Rust WASM (encodeInto) | 22.173 | 18.469 | 51.456 | 1 | 11086.6 | 293 |
| non-ASCII 16384 B: TS | 282.104 | 234.783 | 928.504 | 1 | 17633.7 | 2373 |
| non-ASCII 16384 B: TS scan + Bun.hash.murmur32v3(token) | 366.950 | 326.371 | 1012.576 | 1 | 22937.2 | 2373 |
| non-ASCII 16384 B: Rust FFI (encodeInto UTF-8) | 130.086 | 116.910 | 204.107 | 1 | 8131.3 | 2373 |
| non-ASCII 16384 B: Rust FFI (UTF-16 charCodeAt loop) | 193.739 | 182.225 | 320.814 | 1 | 12110.2 | 2373 |
| non-ASCII 16384 B: Rust WASM (encodeInto) | 186.297 | 183.911 | 259.009 | 1 | 11645.0 | 2373 |

### tokenize-node


### Tokenize + murmur3 (end to end, incl. marshalling) (node v22.22.0)

| case | mean µs/op | p50 µs | p99 µs | ops/sample | ns/KiB | tokens |
|---|---:|---:|---:|---:|---:|---:|
| ASCII 256 B: TS | 1.863 | 1.772 | 3.700 | 3 | 7453.7 | 45 |
| ASCII 256 B: Rust WASM (encodeInto) | 1.520 | 1.503 | 5.733 | 5 | 6078.9 | 45 |
| ASCII 2048 B: TS | 12.821 | 12.233 | 23.790 | 1 | 6410.4 | 334 |
| ASCII 2048 B: Rust WASM (encodeInto) | 5.874 | 5.215 | 12.567 | 1 | 2937.2 | 334 |
| ASCII 16384 B: TS | 167.888 | 150.282 | 276.490 | 1 | 10493.0 | 2675 |
| ASCII 16384 B: Rust WASM (encodeInto) | 73.830 | 67.305 | 114.892 | 1 | 4614.4 | 2675 |
| non-ASCII 256 B: TS | 10.079 | 7.231 | 35.796 | 1 | 40315.5 | 36 |
| non-ASCII 256 B: Rust WASM (encodeInto) | 3.077 | 2.852 | 5.255 | 2 | 12307.7 | 36 |
| non-ASCII 2048 B: TS | 70.955 | 55.231 | 262.071 | 1 | 35477.4 | 293 |
| non-ASCII 2048 B: Rust WASM (encodeInto) | 19.217 | 18.250 | 36.527 | 1 | 9608.7 | 293 |
| non-ASCII 16384 B: TS | 719.772 | 704.380 | 1603.443 | 1 | 44991.3 | 2373 |
| non-ASCII 16384 B: Rust WASM (encodeInto) | 180.187 | 177.819 | 225.461 | 1 | 11263.0 | 2373 |

### secrets

lib: /home/user/Eden/.claude/worktrees/agent-ab79e21ddb8b65076/native/eden-native/target/release/libeden_native.so

| cold start | rules | ms |
|---|---:|---:|
| TS: build + first run (compiles) of every rule regex, incl. eden-* | 231 | 19.0 |
| Rust FFI: parse TOML, compile rule + allowlist regexes, Aho-Corasick | 221 | 49.4 |
| Rust FFI: RegexSet over every rule (built: true) | 221 | 24.0 |
| Rust WASM: instantiate + parse, compile, Aho-Corasick (no RegexSet) | 221 | 99.1 |

### Secret scanning: which gitleaks rules fire (bun 1.4.4)

| case | mean µs/op | p50 µs | p99 µs | ops/sample | ns/KiB | rules fired |
|---|---:|---:|---:|---:|---:|---:|
| benign ASCII 256 B: TS secretHits (full gate, incl. eden-*) | 20.590 | 17.632 | 48.135 | 1 | 82360.6 | 0 |
| benign ASCII 256 B: TS gitleaks rules only | 23.099 | 22.859 | 62.117 | 1 | 92396.6 | 0 |
| benign ASCII 256 B: Rust FFI prefilter + regex | 1.776 | 1.749 | 4.947 | 4 | 7104.5 | 0 |
| benign ASCII 256 B: Rust FFI RegexSet + prefilter | 2.476 | 2.410 | 4.679 | 2 | 9902.2 | 0 |
| benign ASCII 256 B: Rust WASM prefilter + regex | 2.153 | 2.021 | 6.075 | 3 | 8610.5 | 0 |
| benign ASCII 2 KiB: TS secretHits (full gate, incl. eden-*) | 96.669 | 91.013 | 161.046 | 1 | 48334.4 | 0 |
| benign ASCII 2 KiB: TS gitleaks rules only | 80.009 | 79.793 | 139.931 | 1 | 40004.3 | 0 |
| benign ASCII 2 KiB: Rust FFI prefilter + regex | 8.139 | 7.717 | 19.998 | 1 | 4069.7 | 0 |
| benign ASCII 2 KiB: Rust FFI RegexSet + prefilter | 17.606 | 15.761 | 37.615 | 1 | 8803.2 | 0 |
| benign ASCII 2 KiB: Rust WASM prefilter + regex | 14.293 | 13.689 | 26.342 | 1 | 7146.7 | 0 |
| benign non-ASCII 2 KiB: TS secretHits (full gate, incl. eden-*) | 142.640 | 126.749 | 227.529 | 1 | 71320.0 | 0 |
| benign non-ASCII 2 KiB: TS gitleaks rules only | 155.056 | 150.037 | 202.805 | 1 | 77528.0 | 0 |
| benign non-ASCII 2 KiB: Rust FFI prefilter + regex | 9.957 | 9.495 | 30.126 | 1 | 4978.7 | 0 |
| benign non-ASCII 2 KiB: Rust FFI RegexSet + prefilter | 19.135 | 15.273 | 64.071 | 1 | 9567.4 | 0 |
| benign non-ASCII 2 KiB: Rust WASM prefilter + regex | 15.927 | 15.233 | 38.043 | 1 | 7963.7 | 0 |
| benign ASCII 16 KiB: TS secretHits (full gate, incl. eden-*) | 1427.647 | 1364.151 | 1952.782 | 1 | 89227.9 | 0 |
| benign ASCII 16 KiB: TS gitleaks rules only | 1246.557 | 1246.602 | 2750.756 | 1 | 77909.8 | 0 |
| benign ASCII 16 KiB: Rust FFI prefilter + regex | 164.768 | 165.034 | 224.528 | 1 | 10298.0 | 0 |
| benign ASCII 16 KiB: Rust FFI RegexSet + prefilter | 179.565 | 175.634 | 207.183 | 1 | 11222.8 | 0 |
| benign ASCII 16 KiB: Rust WASM prefilter + regex | 265.757 | 254.670 | 368.131 | 1 | 16609.8 | 0 |
| 3 secrets ~2 KiB: TS secretHits (full gate, incl. eden-*) | 169.068 | 166.635 | 279.077 | 1 | 84782.5 | 5 |
| 3 secrets ~2 KiB: TS gitleaks rules only | 107.426 | 109.745 | 196.869 | 1 | 53870.6 | 3 |
| 3 secrets ~2 KiB: Rust FFI prefilter + regex | 20.618 | 20.309 | 52.254 | 1 | 10339.3 | 3 |
| 3 secrets ~2 KiB: Rust FFI RegexSet + prefilter | 35.110 | 33.341 | 76.157 | 1 | 17606.7 | 3 |
| 3 secrets ~2 KiB: Rust WASM prefilter + regex | 35.955 | 34.619 | 62.549 | 1 | 18030.1 | 3 |

### secrets-native-cpu

lib: /home/user/Eden/.claude/worktrees/agent-ab79e21ddb8b65076/native/eden-native/target-native/release/libeden_native.so

| cold start | rules | ms |
|---|---:|---:|
| TS: build + first run (compiles) of every rule regex, incl. eden-* | 231 | 19.3 |
| Rust FFI: parse TOML, compile rule + allowlist regexes, Aho-Corasick | 221 | 51.1 |
| Rust FFI: RegexSet over every rule (built: true) | 221 | 26.1 |
| Rust WASM: instantiate + parse, compile, Aho-Corasick (no RegexSet) | 221 | 127.1 |

### Secret scanning: which gitleaks rules fire (bun 1.4.4)

| case | mean µs/op | p50 µs | p99 µs | ops/sample | ns/KiB | rules fired |
|---|---:|---:|---:|---:|---:|---:|
| benign ASCII 256 B: TS secretHits (full gate, incl. eden-*) | 26.641 | 23.244 | 75.079 | 1 | 106564.9 | 0 |
| benign ASCII 256 B: TS gitleaks rules only | 25.483 | 22.454 | 78.844 | 1 | 101932.0 | 0 |
| benign ASCII 256 B: Rust FFI prefilter + regex | 2.165 | 1.815 | 8.612 | 3 | 8660.3 | 0 |
| benign ASCII 256 B: Rust FFI RegexSet + prefilter | 2.631 | 2.228 | 5.909 | 2 | 10523.7 | 0 |
| benign ASCII 256 B: Rust WASM prefilter + regex | 2.139 | 1.972 | 4.024 | 2 | 8554.3 | 0 |
| benign ASCII 2 KiB: TS secretHits (full gate, incl. eden-*) | 105.285 | 89.242 | 185.393 | 1 | 52642.4 | 0 |
| benign ASCII 2 KiB: TS gitleaks rules only | 60.252 | 57.368 | 82.945 | 1 | 30125.9 | 0 |
| benign ASCII 2 KiB: Rust FFI prefilter + regex | 7.687 | 7.683 | 16.373 | 1 | 3843.4 | 0 |
| benign ASCII 2 KiB: Rust FFI RegexSet + prefilter | 14.492 | 13.722 | 26.540 | 1 | 7245.8 | 0 |
| benign ASCII 2 KiB: Rust WASM prefilter + regex | 14.652 | 14.185 | 26.379 | 1 | 7326.2 | 0 |
| benign non-ASCII 2 KiB: TS secretHits (full gate, incl. eden-*) | 114.341 | 110.991 | 150.190 | 1 | 57170.5 | 0 |
| benign non-ASCII 2 KiB: TS gitleaks rules only | 102.902 | 98.662 | 159.575 | 1 | 51451.2 | 0 |
| benign non-ASCII 2 KiB: Rust FFI prefilter + regex | 10.055 | 9.260 | 31.148 | 1 | 5027.5 | 0 |
| benign non-ASCII 2 KiB: Rust FFI RegexSet + prefilter | 20.386 | 18.757 | 46.641 | 1 | 10193.1 | 0 |
| benign non-ASCII 2 KiB: Rust WASM prefilter + regex | 18.434 | 15.769 | 42.960 | 1 | 9217.1 | 0 |
| benign ASCII 16 KiB: TS secretHits (full gate, incl. eden-*) | 1468.072 | 1371.109 | 1875.231 | 1 | 91754.5 | 0 |
| benign ASCII 16 KiB: TS gitleaks rules only | 1060.795 | 1001.622 | 1421.418 | 1 | 66299.7 | 0 |
| benign ASCII 16 KiB: Rust FFI prefilter + regex | 130.813 | 120.160 | 212.219 | 1 | 8175.8 | 0 |
| benign ASCII 16 KiB: Rust FFI RegexSet + prefilter | 192.339 | 174.335 | 534.732 | 1 | 12021.2 | 0 |
| benign ASCII 16 KiB: Rust WASM prefilter + regex | 241.109 | 236.245 | 332.772 | 1 | 15069.3 | 0 |
| 3 secrets ~2 KiB: TS secretHits (full gate, incl. eden-*) | 108.429 | 98.936 | 201.744 | 1 | 54373.7 | 5 |
| 3 secrets ~2 KiB: TS gitleaks rules only | 80.396 | 69.602 | 155.882 | 1 | 40316.0 | 3 |
| 3 secrets ~2 KiB: Rust FFI prefilter + regex | 17.953 | 15.759 | 48.203 | 1 | 9003.1 | 3 |
| 3 secrets ~2 KiB: Rust FFI RegexSet + prefilter | 27.876 | 23.933 | 71.263 | 1 | 13979.1 | 3 |
| 3 secrets ~2 KiB: Rust WASM prefilter + regex | 29.393 | 26.938 | 54.945 | 1 | 14739.8 | 3 |

### secrets-profile

single-regex keyword gate vs includes gate on 23 corpus texts: 0 mismatches
10 of 231 rules pass the keyword gate on the 2 KiB benign ASCII email

### TS gate profile: rules that run on benign ASCII 2 KiB (bun 1.4.4)

| case | mean µs/op | p50 µs | p99 µs | ops/sample | keyword hit |
|---|---:|---:|---:|---:|---:|
| eden-cfat.spans() | 0.601 | 0.383 | 1.328 | 7 | (none: always runs) |
| eden-openai.spans() | 0.621 | 0.364 | 1.064 | 7 | (none: always runs) |
| eden-mailgun.spans() | 0.554 | 0.287 | 0.662 | 7 | (none: always runs) |
| eden-telegram.spans() | 1.507 | 1.229 | 2.465 | 4 | (none: always runs) |
| eden-aws-key-id.spans() | 0.414 | 0.203 | 0.433 | 11 | (none: always runs) |
| eden-keyword.spans() | 4.241 | 3.445 | 11.547 | 2 | (none: always runs) |
| eden-url-userinfo.spans() | 6.331 | 5.656 | 13.757 | 1 | (none: always runs) |
| eden-entropy-keyword.spans() | 9.318 | 8.697 | 33.343 | 1 | (none: always runs) |
| eden-legacy-keyword.spans() | 1.454 | 1.121 | 3.539 | 4 | (none: always runs) |
| eden-legacy-token.spans() | 0.926 | 0.778 | 3.187 | 5 | (none: always runs) |

### TS keyword gate: includes per keyword vs one regex (bun 1.4.4)

| case | mean µs/op | p50 µs | p99 µs | ops/sample | ns/KiB |
|---|---:|---:|---:|---:|---:|
| benign ASCII 256 B: keyword gate, includes per keyword (as secrets.ts) | 16.027 | 12.239 | 37.796 | 1 | 64109.9 |
| benign ASCII 256 B: keyword gate, one regex | 10.038 | 5.658 | 28.672 | 1 | 40151.7 |
| benign ASCII 256 B: TS gitleaks rules, includes gate | 22.897 | 13.852 | 411.524 | 1 | 91587.7 |
| benign ASCII 256 B: TS gitleaks rules, one-regex gate | 11.300 | 6.669 | 39.244 | 1 | 45200.4 |
| benign ASCII 2 KiB: keyword gate, includes per keyword (as secrets.ts) | 76.833 | 59.162 | 236.346 | 1 | 38416.4 |
| benign ASCII 2 KiB: keyword gate, one regex | 47.032 | 44.661 | 88.490 | 1 | 23515.8 |
| benign ASCII 2 KiB: TS gitleaks rules, includes gate | 112.733 | 100.325 | 706.207 | 1 | 56366.4 |
| benign ASCII 2 KiB: TS gitleaks rules, one-regex gate | 53.912 | 47.250 | 94.218 | 1 | 26956.2 |
| benign non-ASCII 2 KiB: keyword gate, includes per keyword (as secrets.ts) | 123.316 | 94.945 | 271.442 | 1 | 61657.8 |
| benign non-ASCII 2 KiB: keyword gate, one regex | 33.259 | 27.136 | 91.888 | 1 | 16629.4 |
| benign non-ASCII 2 KiB: TS gitleaks rules, includes gate | 160.341 | 145.938 | 777.343 | 1 | 80170.3 |
| benign non-ASCII 2 KiB: TS gitleaks rules, one-regex gate | 38.013 | 33.084 | 92.215 | 1 | 19006.7 |
| benign ASCII 16 KiB: keyword gate, includes per keyword (as secrets.ts) | 1113.375 | 1029.317 | 2028.447 | 1 | 69586.0 |
| benign ASCII 16 KiB: keyword gate, one regex | 397.494 | 387.722 | 539.163 | 1 | 24843.4 |
| benign ASCII 16 KiB: TS gitleaks rules, includes gate | 1091.245 | 1011.261 | 2081.166 | 1 | 68202.8 |
| benign ASCII 16 KiB: TS gitleaks rules, one-regex gate | 318.043 | 289.749 | 890.174 | 1 | 19877.7 |
| 3 secrets ~2 KiB: keyword gate, includes per keyword (as secrets.ts) | 63.349 | 55.272 | 125.419 | 1 | 31767.4 |
| 3 secrets ~2 KiB: keyword gate, one regex | 46.077 | 34.748 | 91.045 | 1 | 23106.2 |
| 3 secrets ~2 KiB: TS gitleaks rules, includes gate | 99.357 | 66.112 | 649.412 | 1 | 49824.7 |
| 3 secrets ~2 KiB: TS gitleaks rules, one-regex gate | 67.357 | 44.242 | 467.328 | 1 | 33777.4 |

### builtins


### Bun built-ins and reference hashes (bun 1.4.4)

| case | mean µs/op | p50 µs | p99 µs | ops/sample | ns/KiB |
|---|---:|---:|---:|---:|---:|
| ASCII 256 B: Bun.hash(str) (wyhash) | 0.089 | 0.066 | 0.498 | 38 | 354.4 |
| ASCII 256 B: Bun.hash.murmur32v3(str) | 0.291 | 0.274 | 0.635 | 16 | 1163.5 |
| ASCII 256 B: Bun.hash.murmur32v3(bytes) | 0.137 | 0.131 | 0.225 | 17 | 548.0 |
| ASCII 256 B: TS murmur3(bytes) | 0.137 | 0.129 | 0.257 | 25 | 547.8 |
| ASCII 256 B: TS encodeInto + murmur3 | 0.406 | 0.343 | 1.551 | 18 | 1624.3 |
| ASCII 256 B: Rust FFI encodeInto + murmur3 | 0.231 | 0.185 | 0.409 | 17 | 924.5 |
| ASCII 256 B: str.normalize('NFKC') | 0.025 | 0.024 | 0.031 | 75 | 98.8 |
| ASCII 256 B: str.toLowerCase() | 0.257 | 0.221 | 1.594 | 15 | 1028.5 |
| ASCII 2048 B: Bun.hash(str) (wyhash) | 0.162 | 0.131 | 0.269 | 21 | 81.0 |
| ASCII 2048 B: Bun.hash.murmur32v3(str) | 0.997 | 0.897 | 1.823 | 4 | 498.4 |
| ASCII 2048 B: Bun.hash.murmur32v3(bytes) | 0.924 | 0.873 | 1.658 | 5 | 461.9 |
| ASCII 2048 B: TS murmur3(bytes) | 1.218 | 1.077 | 2.284 | 4 | 608.9 |
| ASCII 2048 B: TS encodeInto + murmur3 | 1.860 | 1.797 | 5.001 | 4 | 929.8 |
| ASCII 2048 B: Rust FFI encodeInto + murmur3 | 1.115 | 1.053 | 2.058 | 5 | 557.5 |
| ASCII 2048 B: str.normalize('NFKC') | 0.039 | 0.039 | 0.052 | 58 | 19.7 |
| ASCII 2048 B: str.toLowerCase() | 3.666 | 2.978 | 11.105 | 2 | 1833.2 |
| ASCII 16384 B: Bun.hash(str) (wyhash) | 0.919 | 0.900 | 1.163 | 4 | 57.5 |
| ASCII 16384 B: Bun.hash.murmur32v3(str) | 6.867 | 6.842 | 11.127 | 1 | 429.2 |
| ASCII 16384 B: Bun.hash.murmur32v3(bytes) | 6.931 | 6.691 | 10.591 | 1 | 433.2 |
| ASCII 16384 B: TS murmur3(bytes) | 9.475 | 8.403 | 25.329 | 1 | 592.2 |
| ASCII 16384 B: TS encodeInto + murmur3 | 10.054 | 8.407 | 26.944 | 1 | 628.4 |
| ASCII 16384 B: Rust FFI encodeInto + murmur3 | 8.032 | 7.782 | 22.836 | 1 | 502.0 |
| ASCII 16384 B: str.normalize('NFKC') | 0.218 | 0.183 | 0.368 | 19 | 13.6 |
| ASCII 16384 B: str.toLowerCase() | 26.005 | 11.278 | 490.330 | 1 | 1625.3 |
| non-ASCII 256 B: Bun.hash(str) (wyhash) | 0.176 | 0.137 | 0.304 | 20 | 703.2 |
| non-ASCII 256 B: Bun.hash.murmur32v3(str) | 0.333 | 0.318 | 0.798 | 13 | 1333.9 |
| non-ASCII 256 B: Bun.hash.murmur32v3(bytes) | 0.153 | 0.126 | 0.303 | 23 | 610.6 |
| non-ASCII 256 B: TS murmur3(bytes) | 0.152 | 0.147 | 0.219 | 24 | 606.7 |
| non-ASCII 256 B: TS encodeInto + murmur3 | 0.321 | 0.219 | 0.588 | 13 | 1283.7 |
| non-ASCII 256 B: Rust FFI encodeInto + murmur3 | 0.294 | 0.222 | 0.364 | 12 | 1176.3 |
| non-ASCII 256 B: str.normalize('NFKC') | 0.295 | 0.231 | 0.623 | 15 | 1179.1 |
| non-ASCII 256 B: str.toLowerCase() | 0.666 | 0.349 | 2.108 | 9 | 2665.6 |
| non-ASCII 2048 B: Bun.hash(str) (wyhash) | 0.385 | 0.350 | 0.719 | 12 | 192.4 |
| non-ASCII 2048 B: Bun.hash.murmur32v3(str) | 1.802 | 1.784 | 6.089 | 4 | 900.8 |
| non-ASCII 2048 B: Bun.hash.murmur32v3(bytes) | 1.264 | 1.186 | 3.097 | 5 | 632.1 |
| non-ASCII 2048 B: TS murmur3(bytes) | 1.521 | 1.473 | 3.368 | 4 | 760.3 |
| non-ASCII 2048 B: TS encodeInto + murmur3 | 1.586 | 1.388 | 2.921 | 3 | 793.1 |
| non-ASCII 2048 B: Rust FFI encodeInto + murmur3 | 1.471 | 1.327 | 2.960 | 4 | 735.4 |
| non-ASCII 2048 B: str.normalize('NFKC') | 1.994 | 1.622 | 4.484 | 3 | 997.0 |
| non-ASCII 2048 B: str.toLowerCase() | 7.219 | 4.411 | 21.982 | 1 | 3609.6 |
| non-ASCII 16384 B: Bun.hash(str) (wyhash) | 4.138 | 3.933 | 12.495 | 2 | 258.7 |
| non-ASCII 16384 B: Bun.hash.murmur32v3(str) | 16.024 | 15.485 | 32.435 | 1 | 1001.6 |
| non-ASCII 16384 B: Bun.hash.murmur32v3(bytes) | 7.193 | 6.922 | 15.990 | 1 | 449.6 |
| non-ASCII 16384 B: TS murmur3(bytes) | 12.848 | 12.584 | 31.406 | 1 | 803.1 |
| non-ASCII 16384 B: TS encodeInto + murmur3 | 14.214 | 16.235 | 32.718 | 1 | 888.5 |
| non-ASCII 16384 B: Rust FFI encodeInto + murmur3 | 10.735 | 9.916 | 27.397 | 1 | 671.0 |
| non-ASCII 16384 B: str.normalize('NFKC') | 23.912 | 23.751 | 38.391 | 1 | 1494.7 |
| non-ASCII 16384 B: str.toLowerCase() | 36.159 | 23.054 | 409.471 | 1 | 2260.2 |

### napi-bun

napi tokenize hashes equal the TS tokenizer's on all 6 texts

### Node-API (napi-rs) call overhead (bun 1.4.4)

| case | mean ns/op | p50 ns | p99 ns | ops/sample |
|---|---:|---:|---:|---:|
| napi noop() | 138.6 | 55.7 | 2489.5 | 220 |
| napi sumBytes(Uint8Array 256) | 575.4 | 365.8 | 5968.6 | 90 |

### Tokenize + murmur3 via napi-rs (end to end) (bun 1.4.4)

| case | mean µs/op | p50 µs | p99 µs | ops/sample | ns/KiB |
|---|---:|---:|---:|---:|---:|
| ASCII 256 B: napi tokenizeHash(string) | 1.045 | 0.907 | 2.082 | 5 | 4179.4 |
| ASCII 256 B: napi encodeInto + tokenizeHashBytes | 1.121 | 0.973 | 2.181 | 5 | 4484.7 |
| ASCII 2048 B: napi tokenizeHash(string) | 4.016 | 3.817 | 9.335 | 2 | 2007.9 |
| ASCII 2048 B: napi encodeInto + tokenizeHashBytes | 4.247 | 3.816 | 9.790 | 2 | 2123.7 |
| ASCII 16384 B: napi tokenizeHash(string) | 42.422 | 39.087 | 74.287 | 1 | 2651.4 |
| ASCII 16384 B: napi encodeInto + tokenizeHashBytes | 42.035 | 39.882 | 70.067 | 1 | 2627.2 |
| non-ASCII 256 B: napi tokenizeHash(string) | 2.232 | 2.149 | 4.150 | 3 | 8926.9 |
| non-ASCII 256 B: napi encodeInto + tokenizeHashBytes | 2.605 | 2.390 | 4.421 | 2 | 10419.4 |
| non-ASCII 2048 B: napi tokenizeHash(string) | 12.737 | 12.105 | 29.420 | 1 | 6368.3 |
| non-ASCII 2048 B: napi encodeInto + tokenizeHashBytes | 13.819 | 12.856 | 27.102 | 1 | 6909.4 |
| non-ASCII 16384 B: napi tokenizeHash(string) | 116.666 | 106.581 | 221.188 | 1 | 7292.5 |
| non-ASCII 16384 B: napi encodeInto + tokenizeHashBytes | 121.302 | 114.379 | 197.837 | 1 | 7582.3 |

### napi-node

napi tokenize hashes equal the TS tokenizer's on all 6 texts

### Node-API (napi-rs) call overhead (node v22.22.0)

| case | mean ns/op | p50 ns | p99 ns | ops/sample |
|---|---:|---:|---:|---:|
| napi noop() | 45.9 | 40.7 | 138.9 | 358 |
| napi sumBytes(Uint8Array 256) | 263.4 | 236.7 | 572.2 | 105 |

### Tokenize + murmur3 via napi-rs (end to end) (node v22.22.0)

| case | mean µs/op | p50 µs | p99 µs | ops/sample | ns/KiB |
|---|---:|---:|---:|---:|---:|
| ASCII 256 B: napi tokenizeHash(string) | 1.397 | 1.417 | 3.697 | 5 | 5589.0 |
| ASCII 256 B: napi encodeInto + tokenizeHashBytes | 1.583 | 1.519 | 6.532 | 5 | 6330.8 |
| ASCII 2048 B: napi tokenizeHash(string) | 4.673 | 4.096 | 8.504 | 1 | 2336.4 |
| ASCII 2048 B: napi encodeInto + tokenizeHashBytes | 7.044 | 6.796 | 15.140 | 2 | 3522.1 |
| ASCII 16384 B: napi tokenizeHash(string) | 53.479 | 42.120 | 103.989 | 1 | 3342.4 |
| ASCII 16384 B: napi encodeInto + tokenizeHashBytes | 52.125 | 56.005 | 92.491 | 1 | 3257.8 |
| non-ASCII 256 B: napi tokenizeHash(string) | 3.874 | 3.825 | 10.219 | 2 | 15497.3 |
| non-ASCII 256 B: napi encodeInto + tokenizeHashBytes | 3.933 | 3.789 | 11.120 | 2 | 15731.1 |
| non-ASCII 2048 B: napi tokenizeHash(string) | 32.512 | 18.560 | 39.053 | 1 | 16255.9 |
| non-ASCII 2048 B: napi encodeInto + tokenizeHashBytes | 26.254 | 22.066 | 50.092 | 1 | 13126.9 |
| non-ASCII 16384 B: napi tokenizeHash(string) | 165.429 | 148.733 | 260.047 | 1 | 10340.6 |
| non-ASCII 16384 B: napi encodeInto + tokenizeHashBytes | 147.752 | 135.835 | 296.613 | 1 | 9235.6 |
