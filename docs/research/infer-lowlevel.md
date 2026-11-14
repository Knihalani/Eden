# Low-level pass over inference, model calls and serving (D1890–D1894)

2026-11-14, $0, no model call. Branch `claude/infer-lowlevel` from origin/main 60712533a. Every change is
output-identical by construction and by a differential test against the code it replaced; nothing model-facing
moved (prompt text, cache fields, request bodies).

Machine: the shared 4-core VM, with other agents' work running beside it (load average 2–6 throughout), so every
figure is the median of at least three interleaved rounds (old, new, old, new, …) in the same session, and spreads
are wide. Profiles: `bun --cpu-prof`, summed by self time (`top.py`-style script in the scratchpad, not kept).

## Ranking (where the time was)

| Path                                   | Before                       | Hot spots (self time)                                                                                                                                                       |
| -------------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Turn gate, a turn (`TurnGate.read`)     | 63 µs (mixed turns)          | `gateFeatures` 50 µs of it: a 16 KB `Int32Array` zeroed a turn (17%), the typed-array sort of ~550 ids (17%), the unique pass into a `number[]` (17%), `Array.from` cuts in `gateNorm` (10% + 8%), word arrays and spread bigrams; the forward about 10 µs (int8 rows into doubles, then 3,584 MACs) |
| Gloss, an English request (`glossOf`)  | 8.6 µs                       | the function-word test, one `Set.has` a word a language (26 languages × ~12 words, 39%); `isCapital`'s `toLowerCase` (11%); the English-table search repeated per language     |
| Push check, a call's CPU               | 120–145 µs (24 KB body)      | `JSON.stringify` of the body 37%, sha256 updates (the kept-check key, the sheet hash) 28%; the call itself is 600–1,000 ms                                                    |
| HTTP handler, an event (stub partner)  | 7.6 µs in process            | building the bench's `Request` 15–18%, `Response.json` 12–13%, `JSON.parse` 9%, the body read 9%, two `new URL` a request 5%, `toISOString` a request 3%, `keyOf`'s regex 2–3% |

## Adopted

### D1890: the turn gate, 3.0x a turn, outputs bit-identical

`packages/engine/src/turn-gate.ts`. Features are hashed straight from code points held in module scratch arrays
(the call is synchronous, so one set a process): no word strings or arrays, no `[...a, 32, ...b]` bigrams (FNV runs
over the two spans in place), and ids are made unique with a bitset (8 KB at 16 bits) instead of a sort; the public
`gateFeatures` returns them sorted by scanning that bitset. A head made only of ASCII and the six typographic
characters NFKC and lower-casing leave alone (‘ ’ “ ” – —) is normalised in one pass with words found by char code;
anything else takes the old regex pipeline, with `Array.from` cuts replaced by a code point count. The forward sums
the int8 rows in Int32 (sums of small integers are exact either way, and order-free), four dims a word with two
16-bit lanes an add (SWAR, flushed every 256 rows, `v XOR 0x80` = `v + 128` made unsigned, `128 × n` taken off),
read through a `Uint32Array` view of the file's bytes (the shipped table sits 4-aligned; an unaligned one is copied
once). The float arrays are read as `Float64Array`s held in fields, with the hidden layer and heads summed in the
same order as before (so the same doubles). The stopgap's word count is the one `encode` already made, not a second
normalisation.

Oracle: `turn-gate-oracle.test.ts` keeps the earlier code verbatim and compares, on 4,000 fuzzed turns by default
(`GATE_FUZZ`), the normalised text, the feature ids at 16, 12 and 22 bits (a skeleton at 12), and `read`'s verdict
with `Object.is` on the logit, under every rule reading, on the shipped weights (and the same file a byte off
alignment), and on generated weights that reach the other paths (int8 by words and by bytes, a float table, the rule's
ids, the clause gate). Turns mix ASCII, every white space the normaliser folds, typographic punctuation, accents,
combining marks, ligatures, full-width forms, Turkish İ, Devanagari, CJK, emoji, lone surrogates and lengths past the
1,200- and 2,400-unit cuts, plus fixed cut cases. Of 15 mutations of the new code (the fast path's alphabet, white
space, the 300 and 1,200 cuts, the SWAR flush, lane shifts, bias, the rule ids), 10 fail it; of the 5 that pass, 4
are equivalent (`acc -= -v`; a sign extension the lane mask removes; the sorted order of a float table's ids, which
cannot move a sum of a few hundred float32 values in a double; the bitset's size bound) and one is weak coverage (the
rule ids' duplicate test starting at the second id: a rule id equal to the first unique id is rare in the fuzz). `turn-gate.test.ts` (feats.py's sums and
ids, the hard gates) passes unchanged; `parity.ts` needs export.py's parity file, which is not on this machine: the
oracle test checks the same logits against the code that passed parity 64/64, to the bit rather than within 1e-4.

| Turn gate, µs a turn (CPU, median of 3 interleaved runs of 15 rounds) | Before | After | Speed-up |
| --------------------------------------------------------------------- | -----: | ----: | -------: |
| 3,000 turns: the m13 fixtures, the test's turns and seeded joins of them (101 code points on average) | 63.2 | 21.0 | 3.0x |
| the 144 fixture and test turns alone (short)                            | 54.4 | 16.3 | 3.3x |

Load (a fresh process, `new TurnGate` on the file's bytes, 5 runs each, interleaved): 3.99 ms against 4.43 ms
(medians, runs 3.7–5.0 and 3.9–6.6), RSS after load 7.84 against 7.42 MB (the file buffer and the module). From the
code, not measured: no allocation a turn but the verdict object (and, on the slow path, the normalised string), where
the old code made a 16 KB `Int32Array`, a `number[]` of ids and an array a word.

The M13 docs' "43 µs a turn" is `packages/sim/lab/m13/bench.ts` over `.local/m13/sets/dev.jsonl`, which is not on
this machine; the table's corpus is the closest available.

### D1891: the glossary's English path, 2.6x

`packages/engine/src/gloss.ts`. `languagesOf` reads a request's candidate languages from one map of function word →
bitmask of languages (built once a language map, 4,438 words, kept in a `WeakMap` on `g.langs` so a copy of a
glossary shares it), and walks only the set bits; whether each word is English (`isStopword` or the English table)
is read once a request, not once a language; `isCapital` answers an ASCII word by char code. The order languages are
read in, the bounds `couldWin` uses and every count are unchanged. A first cut keyed the map on the `Glossary` object:
`gloss-packed.test.ts` builds a fresh copy a call, so it rebuilt the map every call and that test went 1.1 s → 7.0 s;
keyed on `g.langs` it is 1.0–1.1 s. The differential test against version 1 passes at `GLOSS_FUZZ=50000`.

| `bench/gloss.bench.ts 1 20000`, 3 interleaved runs | Before (p50 / p99 µs) | After          |
| --------------------------------------------------- | --------------------- | -------------- |
| English request                                     | 7.2 / 30.9            | 3.4 / 19.8     |
| request in another language                         | 43.0 / 223.6          | 34.9 / 155.2   |
| load, ms (medians; runs 3.8–5.6 and 4.3–6.4)        | 3.8                   | 5.9            |

The load is untouched by the change (the mask map is built at the first request, not at load), so its difference is
the machine's noise. (`gl-prof.ts`, 300,000 English requests in one process, 3 interleaved runs: 8.5–8.7 µs → 2.7–3.9
µs.)

### D1892: the server's own path a request, 10–15% in process

`packages/server/src/http.ts`, `ops.ts`, `auth.ts`. `pathOf` slices the path of an http(s) URL whose path holds only
letters, digits, `/`, `_` and `-` (nothing `new URL` rewrites), checking the authority with `new URL` once per
distinct authority; anything else is parsed as before. `queryOf` gives the query to `URLSearchParams` directly when it
holds no character the URL parser strips first (≤ 0x20), keeping a leading `?` (URLSearchParams drops one; the fuzz
caught it). `Ops` uses `pathOf` too, so a request is no longer parsed twice, and keeps each `route`/`status` counter
name instead of building it a request. The handler's day is formatted once a UTC day (`utcDay`), not a request.
`keyOf` slices `Bearer <key>` when the key starts and ends with printable ASCII (the regex and trim would leave it
so). `req.bytes()` replaces `new Uint8Array(await req.arrayBuffer())` (neutral, simpler). `path-of.test.ts` fuzzes
`pathOf` and `queryOf` against `new URL` on 30,000 URLs (special characters, bad hosts, ports past 65,535, IPv4 past
255, backslashes, dot segments, escapes, white space; the same throw where it throws), `keyOf` against the regex on
20,000 headers, `utcDay` against `toISOString` across day ends. Of 7 mutations of the guards, 6 fail it; the seventh
(no stop at `#` in the path scan) is equivalent, since a `#` is not a path character and falls back to `new URL`.

`packages/server/bench/http.bench.ts` is new: the handler under `Ops.wrap` with a stub partner, so the server's own
work is timed apart from the engine (`router.bench.ts` and `sim:perf` time the engine through it).

| In process, µs a request (median of 3 runs of 3 interleaved rounds) | Before | After | Speed-up |
| ------------------------------------------------------------------- | -----: | ----: | -------: |
| `/v1/events`, a user message                                         | 7.55   | 6.89  | 1.10x    |
| `/v1/events`, a 12-message tool result (13 KB)                       | 22.62  | 20.02 | 1.13x    |
| `/v1/ask`                                                            | 8.25   | 6.83  | 1.21x    |
| `/v1/pending` (one injection back)                                   | 7.86   | 7.23  | 1.09x    |

Over HTTP (a child `Bun.serve`, keep-alive, events and asks alternating; 3 interleaved runs, each the median of 3
rounds) the change is under the noise:

| Clients | Before: rps, p50, p99 (median of runs; range of rps) | After                                   |
| ------: | ---------------------------------------------------- | --------------------------------------- |
| 1       | 9,749, 0.083 ms, 0.446 ms (9,059–12,696)             | 9,299, 0.075 ms, 0.431 ms (8,444–10,333) |
| 8       | 27,367, 0.207 ms, 2.304 ms (19,800–28,940)           | 29,950, 0.172 ms, 2.619 ms (19,375–30,828) |
| 32      | 29,160, 0.870 ms, 4.837 ms (26,124–35,159)           | 29,446, 0.843 ms, 5.571 ms (23,242–37,412) |

One client's round trip is about 100 µs (client and server on the same cores) against the handler's 7: the
in-process figure is the honest one.
`/metrics` renders in 35 µs (7.3 KB, 14 routes, 50 counters): once a scrape, not worth a change.

## Measured and not taken

### D1893: the model call path (finding)

The push check's CPU, end to end through `OpenRouterModel` with a canned `fetch` (`check-bench.ts`: 15 items of
about 70 words, a 40-card sheet; key, messages, budget, body, reply parse): 120–145 µs a call, 24 KB of body. Its
largest parts are `JSON.stringify` of the body (37%) and sha256 (28%: the kept-check key and the sheet's hash). A call
waits 600–1,000 ms for the model, so the whole of it is 0.01–0.02% of a check's wait; none of it was changed, since a
hand-built body risks the bytes the model and the prompt cache see. Other paths read: `readSse` was made linear by
D1740; the card, reader, intent and judge prompts are built once a call from strings already in hand; `Budget`
reserves and settles in O(1) Map lookups (`TenantSpend` formats a day a call: a few hundred ns). `estimateTokens`
(length / 4) underestimates prose by about 17% against D1742's 3.31 characters a token, but it only sizes
reservations and the cache-read watch's minimum prefix: changing it changes behaviour (budget refusals, the watch),
so it stays. Token efficiency: D1742 already found no output-invariant cut of 10% or more in any role, and the wire
body carries no whitespace or field that reaches the model's tokens beyond the messages; no prompt byte moved here.

### D1894: levers tried and rejected

- **The int8 table copied biased (each byte + 128) into a `Uint32Array` at load**, so the SWAR loop needs no XOR:
  load went from 3.2–6.3 ms to 8.7–34.5 ms (a 393,216-word loop run cold at startup) and RSS after load from 7.7–8.7
  MB to 11.9–16.5 MB (5 runs each).
  Replaced by a view of the file's bytes with the XOR in the loop (no measurable cost a turn).
- **The hidden layer transposed** (dims outer, units inner, the same summation order per unit, so exact): 25.7/25.3/
  18.5 µs against 29.3/25.8/15.7 a turn in three wall-clock rounds and 20.7/37.0/38.8 against 24.8/26.6/25.8 in CPU
  time: no win, dropped.
- **Unrolled specialised SWAR** (six words a row as locals, dim 24 only): 4.1 against 4.6–5.1 µs a turn for the
  generic SWAR in a micro-bench (the old byte loop 8.8–11.6): too small for a dim-specific path.
- **Skipping zero inputs in the hidden layer** (the rule2 one-hots are mostly 0): exact only when every weight is
  finite (a NaN weight times 0 is NaN), for at most 3 of 28 columns: not built.
- **Quantised activations, a reordered or blocked float sum**: change the logits' bits, which this pass forbade.
- **`Request.bytes()` for the body read**: neutral in the A/B (kept for simplicity, not as a win).
- **Server over HTTP**: no change of the handler's size can show through Bun's socket path on this machine.

## Gates

- `bun run eval` (no model): precision 0.65, recall 0.52, falseFireRate 0; acting 19 of 28 neutral requests with
  packets (1.18 items each), facts handed 10 of 11, look-alikes 3 of 10: unchanged.
- `bun run funnel --jobs 4 --baseline` (the baseline run with origin/main's `turn-gate.ts` and `gloss.ts` swapped in):
  hidden 323/384, decoys 294/384, against it hidden +0 −0, decoys +0 −0.
- `env -u OPENROUTER_API_KEY CHECK_COLD=1 FORMAT_COLD=1 bun run check`: see the branch's last commit.
