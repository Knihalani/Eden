# Architecture alternatives: CPU off the event loop, and a linear-time regex engine

Earlier work made single-threaded TypeScript kernels fast ([primitives.md](primitives.md)) and kept them in
TypeScript rather than Rust ([language-choice.md](language-choice.md), D22). Two structural alternatives were never
measured; this note measures both:

1. **CPU off the event loop.** One server process serves many users; every live lookup gates (and tokenizes) ~32
   items on the event loop, so one user's lookup delays every other user's request.
2. **A different regex engine for the secret gate.** JavaScript's regexes backtrack. Can a crafted email make the
   gate run for seconds, and would a linear-time engine (RE2) fix that at an acceptable cost?

Every number below was printed by a command run in the session that wrote this note, on Bun 1.4.4
(JavaScriptCore), 4 vCPU Intel Xeon @ 2.10 GHz, shared cloud VM, 2026-10-27. Expect ±30% run to run on this VM; where
two runs exist both are given. Numbers from scripts outside the repo (in a scratch directory, with libraries that are
not dependencies) are labelled **scratch**; everything else is reproducible with the commands at the end.

## Summary

| Question | Finding | Recommendation | Done here |
|---|---|---|---|
| Can crafted input stall the gate? | **Yes.** The event path gates up to 1,000,000 characters (`checkEvent`), items up to 8,000. On the gate as it was, 1 MB of `a-a-…://` took **216 s** (eden-url-userinfo, quadratic); 128 KB of `okta0…` 8.0 s and of `sumox-…` 6.8 s (~60 µs a character); 32 KB of `curl curl …` 2.1 s (quadratic, then a plateau near 2 s). Seven gitleaks rules, Eden's URL rule and several allowlists are affected. | Fix (D24). | Yes |
| Linear-time engine? | re2js (pure-JS port of Go's regexp) compiles all 270 gitleaks regexes, gives **identical results** to the current gate once `\s` and `.` are given JavaScript's meaning (0 mismatches on 20,000 texts), and turns the worst inputs into 1–25 ms per MB. But on every rule it costs ~2x on 16 KB benign text and ~3.5x on text with secrets, holds **242 MB** of DFA cache after 3 MB of crafted text (JavaScript: 3.8 MB), and per match it is slow on large programs. node `re2` does not load in Bun; re2-wasm has no group offsets; Rust/WASM stays out under D22. | **Targeted RE2**: the 7 rules that backtrack, and every allowlist, on re2js; the rest on JavaScript (D24). | Yes |
| Does that hold up? | Identical findings to the old gate on 50,000 texts (stricter on 35 of 10,000 texts with Unicode case-fold characters, never looser). Typical cost unchanged. Heap 20.6 MB after crafted text. Worst crafted 1 MB costs 0.8–3.0 s, all linear. | Bound input size or run large texts with a deadline (below). | Gate only |
| Offload to workers? | Yes, for lookups. At 150 lookups/s, inline gating gave small-request p99 **23.8 ms** and event-loop lag p99 10.2 ms; a 3-worker pool, **2.7–3.2 ms** and 1.6–2.1 ms, with main-thread CPU 32% → 15–18%. At 480 lookups/s, inline p99 was 429 ms, pooled 3–7 ms. | Wire `WorkerPool` into the lookup path (D25). | Primitive, tests, benches; not wired |
| Library or own pool? | tinypool and piscina work on Bun but send one message per task: 6–9x the main-thread CPU per task of a batching pool; workerpool 10 never completed a task on Bun 1.4.4. | Own `WorkerPool` (~330 lines, no dependency). | Yes |

## Part 2 first: the gate can be stalled

### Where untrusted text reaches the gate

`sanitizeForStore` runs on the event's text on the fast path (`ContextPartner.observe`), and on every field of every
item a lookup returns (`ItemCache.put`). `checkEvent` accepts text up to 1,000,000 characters (a `tool_result` can
hold a fetched web page or email); item text is cut to 8,000 characters, but `ref`, `url` and `meta` values are not
cut. Source text is attacker-controllable: anyone can email the user.

### How the inputs were found

`bench/redos.scan.ts` (committed) times every rule's `spans` (matches, the re-match for the secret group, entropy,
allowlists), every allowlist regex on its own (a "line" target can be a whole line), and `redact()`. Each target gets
input families built from its first keywords and 47 units (characters and fragments the rules' classes take, PEM
banners, URL and token prefixes), timed at 2,000 and 8,000 characters (linear grows ~4x, quadratic ~16x). It is a
search, not a proof.

On every regex in JavaScript (as before D24), `bun packages/primitives/bench/redos.scan.ts js` printed
`281 targets, js engines, 467 s; flagged: 19`; the top of the list:

| Target | Worst family | 2 KB | 8 KB |
|---|---|---:|---:|
| okta-access-token | `("okta" + "A")*` | 106.62 ms | 562.56 ms |
| cohere-api-token | `("cohere" + "f")*` | 113.37 ms | 555.43 ms |
| sumologic-access-id | `("sumo" + "_")*` | 110.65 ms | 472.90 ms |
| cisco-meraki-api-key | `("meraki" + "_")*` | 131.99 ms | 440.40 ms |
| privateai-api-token | `("privateai" + "0")*` | 80.18 ms | 262.31 ms |
| allowlist of curl-auth-user (`['"]?[^:]+['"]?:['"]?\$…`) | `("" + "'")*` | 9.11 ms | 181.08 ms |
| allowlist of generic-api-key | `""= + "A"* + !` | 13.80 ms | 125.84 ms |
| allowlist of aws-access-token (`.+EXAMPLE$`) | `"-"* + ""` | 6.90 ms | 112.61 ms |
| curl-auth-user | `("curl" + "=")*` | 3.45 ms | 72.95 ms |
| curl-auth-header | `("curl" + "@")*` | 3.04 ms | 50.77 ms |

(The rest: four more curl-auth-user and kubernetes-secret-yaml allowlist regexes at 25–40 ms, then rules under 6 ms.)
Eden's own `eden-url-userinfo` and `redact()` were found by an earlier, uncommitted run of the same search
(**scratch**; it differs from the committed one only in reporting).

The two shapes: `[\w.-]{0,50}?(?i:[\w.-]{0,50}?(?:(?-i:[Ss]umo|SUMO))…` nests two optional 0–50 runs, so every start
position tries up to 2,500 splits (linear, ~60 µs a character); `\bcurl\b(?:.*|.*(?:[\r\n]{1,2}.*){1,5})[ \t\n\r]…`
re-scans the rest of the line from every `curl` (quadratic). `\b[a-z][a-z0-9+.-]*:\/\/…` (eden-url-userinfo)
re-scans a run of scheme characters from every word start in it (quadratic).

Growth on single calls, before any change (**scratch** `redos-curve.ts`, one call each):

| Input | 2 KB | 8 KB | 32 KB | 128 KB | 1 MB |
|---|---:|---:|---:|---:|---:|
| curl-auth-user `spans`, `curl ` repeated | 6.4 ms | 89.0 ms | 1155.2 ms | 943.4 ms | 971.6 ms |
| sumologic-access-id `spans`, `sumox-` repeated | 96.4 ms | 532.6 ms | 1509.3 ms | 6327.1 ms | not run |
| eden-url-userinfo `spans`, `a-` repeated + `://` | 1.0 ms | 11.2 ms | 177.5 ms | 3791.8 ms | 216304.5 ms |
| `redact()`, `-----BEGIN PRIVATE KEY-----` repeated | 1.0 ms | 2.2 ms | 35.6 ms | 374.2 ms | 24978.0 ms |
| `sanitizeForStore`, `curl ` repeated | 16.0 ms | 114.3 ms | 1862.1 ms | 1818.7 ms | 1882.3 ms |
| `sanitizeForStore`, `sumox-` repeated | 89.2 ms | 491.1 ms | 1502.4 ms | 6796.4 ms | not run |
| `sanitizeForStore`, PEM banners repeated | 2.0 ms | 0.8 ms | 2.0 ms | 7.8 ms | 103.6 ms |
| `sanitizeForStore`, benign prose | 0.1 ms | 0.1 ms | 0.4 ms | 1.3 ms | 11.2 ms |

The curl rules level off near 1–2 s from 32 KB up; the result stayed correct there (**scratch** `jsc-limit.ts`: a
real `curl -u` secret after 128,000 characters of padding was still found and redacted, in 1708.0 ms).
`redact()`'s PEM pattern is quadratic on its own, but through `sanitizeForStore` the gitleaks private-key rule
redacts the banners first (103.6 ms at 1 MB); no input tried reached it, so it is listed under "remains" below.

## Part 2: linear-time engines

### Candidates

| Engine | Loads in Bun 1.4.4 | Compiles the 221 rule / 49 allowlist regexes | Notes |
|---|---|---|---|
| re2js 2.9.0 (pure JS port of Go's regexp, MIT, no dependencies) | yes | 221/221 in 69.1 ms, 49/49 in 13.0 ms | Go syntax as gitleaks writes it, UTF-16 offsets (checked on `Zoë 東京 abc`) |
| re2-wasm 1.0.2 (RE2 C++ in WASM) | yes | 221/221 in 1071.7 ms, 49/49 in 23.5 ms | No `d` flag: group offsets are not available, so the secret's span cannot be found; only one published 1.x version |
| `re2` 1.27.0 (node binding) | **no** | — | The prebuilt binary is for Node's ABI 127, Bun wants 147; built from source it fails at load: `undefined symbol: …v8::Object::SetNativeDataProperty…` |
| Rust `regex` via WASM (`native/eden-native`) | yes | 221/221 (language-choice.md) | Gitleaks rules only, returns rule ids not spans; Eden's rules use lookaheads Rust lacks |

(**scratch** `probe.ts`, `re2-compile.ts`.)

Speed of each engine running every gitleaks rule, behind the same prefilter, Eden rules and `redact()` (**scratch**
`engine-speed.ts`; the Rust column is the gitleaks scan alone, so it does less work):

| Text | JavaScript (gate as it was) | re2js | re2-wasm | Rust WASM (gitleaks only) |
|---|---:|---:|---:|---:|
| benign 2 KB | 27.31 µs | 21.84 µs | 16.32 µs | 15.25 µs |
| benign 16 KB | 205.84 µs | 419.38 µs | 351.28 µs | 251.37 µs |
| keyword-dense 2 KB | 160.68 µs | 171.18 µs | 283.81 µs | 62.86 µs |
| 3 secrets ~2 KB | 82.14 µs | 310.13 µs | 504.92 µs | 33.69 µs |
| 128 KB of `okta0` (one call) | 8914.6 ms | 2.0 ms | 3.8 ms | 1.5 ms |
| 128 KB of `curl ` (one call) | 1978.8 ms | 0.8 ms | 4.0 ms | 1.9 ms |

Rust is fastest on every row, as language-choice.md found; D22's reasons (two implementations, per-platform builds,
`eden-*` rules and span mapping not ported) still hold, and re2js gives the robustness in TypeScript. re2-wasm is out
for the missing group offsets and its 1 s compile.

### Correctness: re2js against the gate

Go's `\s` is ASCII and its `.` excludes only `\n`; JavaScript's `\s` includes NBSP, U+2028 and the other Unicode
spaces, and its `.` also excludes `\r`, U+2028, U+2029. Run as written, re2js disagreed with the gate on 865 of
20,000 texts (`generic-api-key` 308, `stripe-access-token` 220, `jwt` 202, `gcp-api-key` 195, …), always where a
separator was NBSP or U+2028. `re2Source` rewrites `\s`, `\S` and `.` to JavaScript's sets. Then (**scratch**
`engine-diff.ts`, a seeded corpus of every gitleaks keyword in eight assignment shapes with values from five
alphabets and ten lengths, provider shapes, curl, URL, JWT and PEM forms, prose, mixed and joined by ASCII and
Unicode separators; 74 rules fire at least once):

```
re2js: fired-rule mismatches 0/20000, sanitized-output mismatches 0
```

What remains different: RE2's `(?i)` folds by Unicode simple case folding (`s` also matches U+017F, `k` U+212A), and
RE2 reads code points where JavaScript reads UTF-16 units. On 10,000 texts sprinkled with ſ, K, İ, ǅ and lone
surrogates, every rule on re2js fired more often on 180 texts and less often on none, and no character the old gate
redacted was left (**scratch** `re2js-edge-dir.ts`). With only emoji and other astral characters: no difference.

### Cost: why not every rule on RE2

From `bench/gate-engine.bench.ts` (final tree), all three gates give identical output on every text below:

| Text | all JavaScript (before) | all RE2 | D24 (targeted) |
|---|---:|---:|---:|
| benign 256 B | 9.30 µs | 6.01 µs | 3.11 µs |
| benign 2 KB | 13.96 µs | 13.59 µs | 14.49 µs |
| benign 16 KB | 178.18 µs | 320.74 µs | 175.34 µs |
| benign 2 KB, 10% non-ASCII | 35.07 µs | 18.69 µs | 19.18 µs |
| keyword-dense 2 KB | 103.31 µs | 96.95 µs | 101.58 µs |
| 2 secrets ~2 KB | 33.17 µs | 116.96 µs | 33.43 µs |
| compile every rule (first use) | 20.3 ms | 119.9 ms | 13.2 ms |

(Means; a second run of the same bench, before generic-api-key moved back to JavaScript, gave the same picture:
16 KB 152.25 / 278.23 µs, 2 secrets 33.90 / 128.25 µs for all-JavaScript / all-RE2.)

All-RE2 is ~2x on 16 KB benign text (one rule's keyword, `s.`, is common in prose, and re2js's DFA runs at
~8 ns a character where JavaScriptCore's search is ~0.6) and ~3.5x on text holding secrets (capture groups:
**scratch** `re2js-split.ts`, `aws-access-token` on the secrets text: DFA test 25.39 µs, capturing find 85.12 µs).

Memory, `bench/gate-memory.bench.ts` (one process per choice; 5,000 emails of 256 B–8 KB, then 3 MB of random text
over the rules' class characters with 5% gitleaks keywords, so every rule runs):

| Choice | heap after 5,000 emails | heap after crafted text | time for the crafted 3 MB | rss |
|---|---:|---:|---:|---:|
| all JavaScript | 3.1 MB | 3.8 MB | 10.8 s | 52.6 MB |
| all RE2 | 11.0 MB | 242.5 MB | 19.9 s | 438.8 MB |
| D24 | 4.4 MB | 20.6 MB | 9.2 s | 93.1 MB |

re2js keeps a lazy DFA per pattern, budgeted at 8 MB of its own accounting each. The budget is not exposed by
`RE2JS.compile`; setting it through internals (**scratch** `dfa-budget.ts`, 60 × 50 KB of the same crafted text,
all-RE2) trades memory for time, badly:

| DFA budget per pattern | crafted 3 MB | heap after | 128 KB of `sumox-` |
|---|---:|---:|---:|
| 8 MB (default) | 19484 ms | 243.6 MB | 6.1 ms |
| 1 MB | 43464 ms | 89.4 MB | 5.2 ms |
| 256 KB | 166347 ms | 34.9 MB | 7.4 ms |
| 64 KB | 218560 ms | 19.5 MB | 1149.6 ms |

re2js also pays per match for the capture groups, in proportion to the program's size. On match-dense crafted input,
128 KB, one call (**scratch** `match-dense.ts`):

| Rule | JavaScript | re2js |
|---|---:|---:|
| sumologic-access-id | 20.2 ms | 227.2 ms |
| cohere-api-token | 14.8 ms | 258.0 ms |
| cisco-meraki-api-key | 8.7 ms | 288.6 ms |
| curl-auth-user | 20.8 ms | 89.3 ms |
| curl-auth-header | 6.9 ms | 55.2 ms |
| okta-access-token | 59.4 ms | 0.9 ms |
| privateai-api-token | 35.5 ms | 0.9 ms |
| generic-api-key | 3.7 ms | 664.0 ms |

For the seven backtracking rules re2js's worst (~2 µs a character) is far below JavaScript's (~60 µs a character, or
quadratic). For generic-api-key it is the reverse: JavaScript's worst found is linear (883.5 ms at 1 MB, below),
re2js's ~5 µs a character (431 matches in 32 KB: 58.9 ms to find and 103.8 ms to re-match on re2js, 0.9 and 0.4 ms
on JavaScript; **scratch** `count-matches.ts`).

### The decision (D24)

- **RE2 for the seven rules that backtrack** (`RE2_RULES`: cisco-meraki-api-key, cohere-api-token, curl-auth-header,
  curl-auth-user, okta-access-token, privateai-api-token, sumologic-access-id) **and for every allowlist regex** (they
  run only on findings, but on a whole match or line, and several are quadratic there in JavaScript).
- **JavaScript for every other rule.** `linear.test.ts` holds them under 40 ms on crafted 8 KB inputs (they took at
  most 13 ms; with every rule on JavaScript the seven took 81–755 ms), so a gitleaks update that adds a backtracking
  rule fails a test.
- **eden-url-userinfo** rewritten with the scheme in a lookbehind: same group, same spans (a test compares both forms
  on 20,000 URL-shaped strings), one scan per `://`.
- **Linear by construction where the old code was not**: the match's line breaks are trimmed by index (the regex trim
  can be quadratic on a long run of them; not measured) and the line an allowlist reads is cached per line.

Results against the gate as it was (**scratch** `final-diff.ts`, the HEAD `secrets.ts` copied aside):

```
ASCII/BMP corpus: 20000 texts; new gate fires fewer rules on 0, more on 0; sanitized output differs on 0, leaving a character the old gate redacted on 0
+ astral (emoji, math letters): 10000 texts; new gate fires fewer rules on 0, more on 0; sanitized output differs on 0, leaving a character the old gate redacted on 0
+ case-fold specials, lone surrogates: 10000 texts; new gate fires fewer rules on 0, more on 35; sanitized output differs on 12, leaving a character the old gate redacted on 0
URL-shaped fragments: 20000 texts; new gate fires fewer rules on 0, more on 0; sanitized output differs on 0, leaving a character the old gate redacted on 0
```

Worst cases after (`bench/gate-engine.bench.ts`, one call each, ms):

| Input built against | Gate | 8 KB | 32 KB | 128 KB | 1 MB |
|---|---|---:|---:|---:|---:|
| sumologic-access-id | all JavaScript | 439.5 | 1807.0 | 6811.2 | skipped |
| | D24 | 8.2 | 28.1 | 106.4 | 1044.1 |
| okta-access-token | all JavaScript | 546.7 | 1893.7 | 8042.1 | skipped |
| | D24 | 0.2 | 0.5 | 1.9 | 14.7 |
| curl-auth-user | all JavaScript | 178.3 | 2067.0 | 1969.6 | 2092.9 |
| | D24 | 0.1 | 0.2 | 0.8 | 6.9 |
| curl-auth-header | all JavaScript | 115.5 | 1838.6 | 1835.4 | 2131.4 |
| | D24 | 0.1 | 0.3 | 1.6 | 11.6 |
| generic-api-key (`token0-`) | all JavaScript | 5.8 | 23.3 | 110.6 | 883.5 |
| | D24 | 6.6 | 25.7 | 103.7 | 817.6 |
| eden-url-userinfo (`a-…://`) | D24 (both forms of the gate run the new regex here) | 0.1 | 0.5 | 2.7 | 14.4 |
| keyword-saturated random text | all JavaScript | 23.9 | 108.1 | 436.3 | 4000.3 |
| | all RE2 | 691.8 | 1040.1 | 1093.6 | 8114.9 |
| | D24 | 94.5 | 160.4 | 397.5 | 2985.8 |

(D24's sumologic row is sumologic-access-token, a different rule with the same keyword, running on JavaScript at ~1 µs
a character; sumologic-access-id itself is on RE2.) `bench/redos.scan.ts d23` on the final tree:
`281 targets, d23 engines, 59 s; flagged: 6`, all under 8 ms at 8 KB; the three that grew over 8x (netlify,
bittrex, linkedin-client-id) were linear at larger sizes (**scratch**: netlify 32 KB 28.19 ms, 128 KB 59.71 ms,
512 KB 251.44 ms).

### What remains (not fixed here)

- **Linear but slow is still slow at 1 MB.** Every engine choice costs 0.8–4 s on some crafted 1 MB text (keyword-
  saturated junk: 3.0 s on D24, 4.0 s on all-JavaScript, 8.1 s on all-RE2). The 1,000,000-character event limit is
  the lever: cap what the fast path gates and tokenizes, or gate large texts in a worker with a deadline (below).
  Either changes behaviour on huge tool outputs and needs its own decision and an eval run.
- `redact()`'s PEM pattern is quadratic on its own (25 s at 1 MB); not reached through `sanitizeForStore` by any
  input tried, but it should get the same treatment (a scan for `-----END` once, not per banner).
- Allowlists on RE2 could in principle excuse a finding JavaScript would not (Unicode folding); not seen in the
  10,000 case-fold texts.

## Part 1: CPU off the event loop

### Message passing

`bench/message.bench.ts` round-trips text to a worker that returns it: one request in flight; "main-thread CPU" is
`process.threadCpuUsage` per trip, the share that still lands on the event loop. Two runs:

| Payload | Transport | run 1: round trip mean / main CPU | run 2: round trip mean / main CPU |
|---|---|---:|---:|
| 1 × 200 B | clone, Bun `Worker` | 15.2 µs / 6.5 µs | 44.2 µs / 20.5 µs |
| 1 × 200 B | clone, `node:worker_threads` | 60.0 µs / 27.6 µs | 43.5 µs / 20.8 µs |
| 1 × 200 B | transferred UTF-8 buffer | 68.6 µs / 35.6 µs | 58.3 µs / 28.3 µs |
| 1 × 200 B | SharedArrayBuffer + Atomics | 41.3 µs / 21.6 µs | 43.9 µs / 21.6 µs |
| 32 × 2 KB | clone, Bun `Worker` | 209.4 µs / 93.5 µs | 206.9 µs / 104.3 µs |
| 32 × 2 KB | clone, `node:worker_threads` | 214.3 µs / 95.7 µs | 173.2 µs / 79.2 µs |
| 32 × 2 KB | transferred UTF-8 buffer | 258.0 µs / 145.6 µs | 316.7 µs / 183.7 µs |
| 32 × 2 KB | SharedArrayBuffer + Atomics | 127.1 µs / 63.3 µs | 176.6 µs / 89.8 µs |
| 32 × 8 KB | clone, Bun `Worker` | 556.8 µs / 253.8 µs | 583.6 µs / 275.2 µs |
| 32 × 8 KB | transferred UTF-8 buffer | 826.3 µs / 461.9 µs | 945.6 µs / 541.4 µs |
| 32 × 8 KB | SharedArrayBuffer + Atomics | 373.8 µs / 155.0 µs | 426.6 µs / 172.1 µs |

Worker start-up to first reply: Bun `Worker` p50 7.7 / 6.3 ms, `node:worker_threads` 20.3 / 16.1 ms (runs 1 / 2).

- Handing over 32 × 2 KB costs the main thread ~80–105 µs by clone; gating them in place costs ~32 × 14–100 µs. The
  move pays for lookups, not for one small event (clone ~7–21 µs against a ~3–14 µs gate).
- Transferring UTF-8 is slower than cloning: encoding and decoding cost more than the copy saved.
- SharedArrayBuffer saves 10–40% more main-thread CPU but allows one request in flight per buffer and needs a fixed
  size and a blocked worker; not worth it yet.
- A sequential round trip is ~40 µs on this VM even for an empty message (**scratch** `rtt2.ts`: ping 40.0 µs mean):
  it is thread wake-up, which is why the pool batches.

### `WorkerPool` (`packages/primitives/src/pool.ts`)

Tasks are exported functions of one module, imported by the workers and, for inline runs, the caller. Tasks queued
in the same turn go to idle workers in one message each, split evenly, at most `maxBatch`. `maxQueue` bounds waiting
tasks (`run` rejects with `PoolFullError` at once). An AbortSignal drops a waiting task, or rejects a running one at
once (its result is discarded). A batch past `taskTimeoutMs` has its worker terminated and replaced and its tasks
rejected: the only way to stop a synchronous loop. `runOrInline(fn, input, cost)` runs on the caller below
`inlineBelow` or when the queue is full. A crashed worker is replaced. `pool.test.ts` covers each of these.

### Mixed load

`bench/offload.bench.ts` (shape in `bench/load.ts`): small events at 300/s (100–1,500 characters, gated and tokenized
inline in every strategy); lookup arrivals at the given rate, one in five a burst of four (so lookups run at 1.6x the
arrival rate), 32 items each, sizes log-normal (median 1.2 KB, capped at 8,000), 10% keyword-dense, 3% with a secret;
each item gated (inline or pooled) then tokenized on the loop; a 1 ms interval timer measures lag. Final tree, 8 s
per row:

| Lookup arrivals/s | Strategy | small p99 | small max | lookup p50 | lookup p99 | lag p99 | lag max | main CPU |
|---:|---|---:|---:|---:|---:|---:|---:|---:|
| 8 | inline | 3.95 ms | 8.35 ms | 5.33 ms | 10.58 ms | 1.76 ms | 10.28 ms | 7% |
| 8 | pool 3, inline < 1 KB | 2.11 ms | 31.16 ms | 4.00 ms | 13.83 ms | 1.16 ms | 32.89 ms | 6% |
| 8 | pool 3, all offloaded | 2.12 ms | 5.71 ms | 3.07 ms | 6.33 ms | 1.05 ms | 4.53 ms | 5% |
| 32 | inline | 7.23 ms | 15.47 ms | 5.76 ms | 14.96 ms | 4.18 ms | 17.00 ms | 14% |
| 32 | pool 2, inline < 1 KB | 1.89 ms | 5.88 ms | 4.44 ms | 9.91 ms | 1.32 ms | 7.26 ms | 10% |
| 32 | pool 3, all offloaded | 4.08 ms | 57.64 ms | 3.55 ms | 11.67 ms | 1.16 ms | 63.94 ms | 9% |
| 96 | inline | 23.84 ms | 52.84 ms | 6.60 ms | 32.99 ms | 10.23 ms | 58.25 ms | 32% |
| 96 | pool 1, inline < 1 KB | 1.92 ms | 5.98 ms | 5.91 ms | 17.13 ms | 1.60 ms | 7.46 ms | 19% |
| 96 | pool 3, inline < 1 KB | 3.20 ms | 5.07 ms | 3.95 ms | 10.26 ms | 2.14 ms | 8.85 ms | 18% |
| 96 | pool 3, all offloaded | 2.69 ms | 39.40 ms | 3.09 ms | 30.92 ms | 1.56 ms | 39.55 ms | 15% |
| 300 | inline | 428.85 ms | 481.37 ms | 23.06 ms | 441.62 ms | 67.87 ms | 205.53 ms | 84% |
| 300 | pool 2, inline < 1 KB | 4.06 ms | 25.59 ms | 5.39 ms | 19.60 ms | 3.29 ms | 25.22 ms | 45% |
| 300 | pool 3, all offloaded | 4.48 ms | 12.97 ms | 3.97 ms | 14.53 ms | 3.53 ms | 13.20 ms | 40% |

(Small p50 is ~0.7 ms in every row: the arrival timer's granularity. Every strategy kept up with the offered load
below 300 arrivals/s; at 300, inline served 478.8 lookups/s with a growing queue behind it, pools 487.4–487.8.) Two
earlier runs (with generic-api-key still on RE2) agree: at 96 arrivals/s inline small p99 21.45 / 12.93 ms against
2.00–3.02 / 1.93–2.86 ms pooled. Single "max" cells of 20–64 ms appear in some pooled rows and not in others (also
inline at times); they were not traced (GC on the main thread is the likely cause).

- **What offload buys is tail latency for everyone else**, not lookup speed: small-request p99 drops 2–100x, event-loop
  lag p99 1.5–20x, main-thread CPU roughly halves. The lookup itself gets 1.3–2x faster with 2–3 workers.
- One worker already removes most of the lag; 2–3 add parallelism for bursts. With 4 vCPUs, `size` = cores − 1.
- The inline threshold matters little here; 1 KB keeps a single small item off the message path.
- Tokenizing and indexing stayed on the loop (the index lives there), so pooled main CPU is 15–46%, not 0.

### Libraries

`bench/compare/pool.compare.ts` (libraries installed outside the repo), 3 workers each, every item its own task:

| Pool | start-up | no-op round trip mean / p50 / p99 | 32k no-op tasks/s | main CPU per task |
|---|---:|---:|---:|---:|
| `WorkerPool` | 27.9 ms | 29.0 / 23.5 / 104.4 µs | 361374 | 2.54 µs |
| tinypool 2.2.0 | 58.9 ms | 62.2 / 51.3 / 215.2 µs | 49491 | 18.00 µs |
| piscina 5.3.2 | 41.0 ms | 54.8 / 43.4 / 184.4 µs | 41018 | 23.28 µs |
| workerpool 10.0.3 | no result within 5 s | | | |

| Mixed load, 96 arrivals/s | small p99 | small max | lookup p50 | lookup p99 | lag p99 | main CPU |
|---|---:|---:|---:|---:|---:|---:|
| `WorkerPool` | 4.03 ms | 41.09 ms | 3.17 ms | 10.38 ms | 1.92 ms | 18% |
| tinypool | 1.72 ms | 3.30 ms | 4.31 ms | 17.09 ms | 1.16 ms | 26% |
| piscina | 2.90 ms | 7.22 ms | 6.57 ms | 20.95 ms | 2.23 ms | 29% |

(An earlier run: `WorkerPool` 253377 tasks/s at 3.10 µs, tinypool 46827 at 18.83 µs, piscina 38326 at 25.17 µs.)

- tinypool and piscina run on Bun through `node:worker_threads` and send one message per task, so the main thread
  pays 7–9x more per task and lookups finish later; tinypool's small-request tail was the best in this run. Neither
  has a per-batch deadline that terminates a stuck worker by itself, nor an inline policy (**unverified** beyond
  their READMEs).
- workerpool 10.0.3 never answered on Bun 1.4.4, with thread, process and auto workers (**scratch** `wp-probe.ts`).
- Own pool: ~330 lines, no dependency, Bun's `Worker` directly, batching, deadline, inline policy. Revisit tinypool if
  the pool grows features (resource limits, worker recycling).

### Recommendation (D25)

Wire `WorkerPool` into the lookup path: `ItemCache.put` gates each item's fields through `runOrInline` (inline below
~1 KB), `size` = cores − 1, and a deadline per batch (a few hundred ms) whose expiry drops the item rather than storing
it ungated (fail closed). That makes `put` asynchronous and adds a pool to the server's lifecycle, so it is an engine
change with its own tests and an eval run; not done here. The same pool, with the deadline, is the natural home for
gating very large event texts, the residual risk above. `extractTypedEntities` (~48 µs per 2 KB in primitives.md)
could move with the gate.

## Not measured

Bun-native alternatives to a JS pool (child processes via `Bun.spawn`); the pool under Node; worker memory (each
worker holds its own compiled rules: JavaScript ~4 MB heap, D24's RE2 caches up to ~20 MB under crafted input, by
the gate-memory figures); re-matching RE2's matches with JavaScript to avoid re2js's per-match cost; Rust's `regex`
with the `eden-*` rules and span mapping.

## Reproduce

```bash
bun packages/primitives/bench/redos.scan.ts js        # ~8 min; `d23` for the gate as it is, ~1 min
bun packages/primitives/bench/gate-engine.bench.ts
bun packages/primitives/bench/gate-memory.bench.ts js  # and re2, d23
bun packages/primitives/bench/message.bench.ts
bun packages/primitives/bench/offload.bench.ts 8 8,32,96,300
LIBEVAL=/path/with/tinypool+piscina+workerpool bun packages/primitives/bench/compare/pool.compare.ts 8
bun test packages/redact packages/primitives
```
