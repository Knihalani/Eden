# The secret gate, faster and leaner, with identical results

Decision: D1841. Owner's brief of 2026-11-14: make `packages/redact` faster and leaner without changing a single
detection. No model call was made. Every number below comes from a command run in this session on the shared 4-core
development VM (another agent's work ran beside it), with `env -u BUN_OPTIONS`; timings are medians of interleaved
rounds unless a line says otherwise, and vary about ±30% run to run on this VM.

## Profile: where the time went

`sanitizeForStore` on realistic text (`packages/redact/bench/corpus.ts`: the sim worlds' mail, chat and documents for
seeds 41–42, the eval scenarios' texts, the repo's own TypeScript, generated service logs and Gmail-shaped JSON tool
results), each piece of the gate timed on its own over the same text (one run of a component profiler; µs a call):

| Text, 16 KB | Whole gate | Prefilter | Candidate rules (the largest) | Assignment spans | Structural redactor |
|---|---:|---:|---|---:|---:|
| mail | 788 | 71 | 394 (generic-api-key 370) | 54 | 112 |
| chat | 986 | 144 | 657 (generic-api-key 499, eden-entropy-keyword 80, eden-keyword 31) | 170 | 264 |
| doc | 1,472 | 133 | 743 (generic-api-key 369, atlassian-api-token 354) | 66 | 122 |
| eval | 1,599 | 138 | 1,405 (generic-api-key 788, linkedin-client-secret 206, linkedin-client-id 205) | 60 | 209 |
| code | 1,379 | 83 | 685 (generic-api-key 556, eden-entropy-keyword 73, eden-keyword 41) | 43 | 140 |
| log | 638 | 69 | 346 (generic-api-key 226, eden-entropy-keyword 90) | 172 | 190 |
| json | 714 | 69 | 446 (generic-api-key 428) | 33 | 95 |

| Text, 1 MB (ms) | Whole gate | Prefilter | Candidate rules (the largest) | Assignment spans | Structural redactor |
|---|---:|---:|---|---:|---:|
| mail | 36.7 | 5.0 | 25.4 (generic-api-key 23.2) | 3.5 | 8.0 |
| chat | 74.6 | 4.6 | 41.6 (generic-api-key 17.7, gocardless-api-token 7.3, lob-api-key 5.6) | 6.7 | 11.1 |
| doc | 91.1 | 4.6 | 64.7 (generic-api-key 23.9, atlassian-api-token 20.1, hashicorp-tf-password 13.4) | 3.3 | 6.8 |
| eval | 110.1 | 4.9 | 91.1 (generic-api-key 37.3, hashicorp-tf-password 16.2, linkedin-client-id 9.8) | 2.8 | 9.7 |
| code | 132.8 | 9.7 | 120.5 (generic-api-key 36.3, atlassian-api-token 23.2, linear-client-secret 12.7) | 5.3 | 18.6 |
| log | 47.9 | 7.2 | 26.9 (generic-api-key 16.6, eden-entropy-keyword 6.8) | 7.4 | 12.2 |
| json | 101.6 | 7.5 | 76.5 (generic-api-key 28.3, atlassian-api-token 18.8, hashicorp-tf-password 13.6) | 2.2 | 11.8 |

The components are timed apart, so they do not add up to the whole: the assignment spans run only when a rule finds
something, and the redactor runs on the gated text. At 256 B and 2 KB no rule dominates (a 2 KB mail: 35 µs in all,
prefilter 10, rules 3, redactor 15): the fixed costs do.

What the profile says, in order of size:

1. **The keyword-assignment rules, run by JavaScript's engine.** 101 gitleaks rules start with this shape
   `(?i)[\w.-]{0,50}?(?:KEYWORD|…)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|:|…)…`. Once the prefilter lets one through
   (its keyword occurs once anywhere in the text), the engine tries the lazy 0–50 character prefix at every position
   of the text. `generic-api-key` alone, whose keywords (`key`, `token`, `access`, `auth`, `api`, `secret`,
   `password`, `credential`) are in most texts, was 47% of the whole gate on a 16 KB mail and 25–60% on the other
   kinds; `atlassian-api-token`, `linkedin-client-*` and `hashicorp-tf-password` added as much on texts holding
   their words.
2. **The structural redactor** (`redact(gated)`, run on every text): its inline token regex (nine alternatives under
   `i`, tried at every position) cost 36–120 µs per 16 KB and its assignment pass 38–265 µs (a `charCodeAt` loop over
   every character, then `slice` and a memo lookup per key).
3. **The prefilter** (one Aho–Corasick pass): 4–9 ns a character, 9–15% of the gate at 16 KB, more on short texts.
4. **Rule (d)** (`eden-entropy-keyword`): `/\S{32,}/g` re-reads every short token up to 32 times: 70–90 µs per 16 KB
   of code or logs. `eden-keyword` (an alternation of eight words at every position) 20–55 µs.
5. **Allowlists**: generic-api-key's 1,477 stopwords, each an `includes` on every finding, were 13% of the gate on
   chat text that held findings. The allowlist DFAs, entropy (`shannon`) and the AWS rule's walk were 1–3% each.
6. **Strings and UTF-16**: the gate makes few strings (a slice per finding); text with non-ASCII characters takes the
   prefilter's slow path per such character, which the profile does not show as a cost at 10% non-ASCII. Ropes
   (a text built by concatenation) are flattened once by the first `indexOf` (15 µs per 16 KB), not per call.

## Changes

Each is exact (the same rule ids, spans and stored text on every input) by an argument in the code and by the
differential fuzz below.

1. **Anchored rules** (`src/anchor.ts`). `anchorsOf` reads, once per regex, every way a match can begin: up to N
   code units from a known class, then one of a few literals (two or more characters) the match must hold. The
   prefilter pass also records where those literals occur (`MultiMatcher.scan`), and the rule's regex, made sticky,
   is tried only at the positions from which the prefix can reach an occurrence (walking back over the prefix class
   from each occurrence), in increasing order, going on from each match's end as `matchAll` does. A scan from L finds
   the least start ≥ L where the regex matches; every such start is a candidate, so the first sticky success is the
   same match. 210 of the 214 gitleaks rules left on JavaScript's engine are anchored (`ghp_`, `ATATT3`, keyword
   alternations; the four left are `azure-ad-client-secret`, `facebook-access-token`, `slack-webhook-url`,
   `sourcegraph-access-token`, whose matches begin with a class), and so are eleven of Eden's own regex rules (their
   lookarounds dropped for the analysis: they are zero-width). When the candidates exceed 1/32 of the text plus
   64 positions (a text made of keywords) the rule scans the whole text as before, which bounds the cost on crafted
   input; the occurrences of the rule's literals are counted first, so a dense text falls back without walking any,
   and past that limit a literal's occurrences are only counted, not kept. The seven scanned rules (D1705) are linear already and are left alone.
2. **One prefilter scan that does more, and cheaper** (`MultiMatcher`, a primitive). The transition table now holds,
   per (state, column), the next state's row offset shifted left with the output bit in bit 0: one load per character
   and no multiply, and the output lists are read only when the bit is set (it replaces the old table; memory is
   unchanged). `scan` adds, in the same pass, the list of patterns hit (so the gate resets and walks only those, not
   all 300 words) and the start of each occurrence of the patterns asked for (exact: counted back over folded
   characters only when a mark or ligature lies inside the window).
3. **Token passes skipped by literal** (`src/redact.ts`, `TOKEN_PASSES`). `redactString` is now `redactAssignments`
   after `redactTokensIn` (PEM blocks, dashed `sk-` keys, Basic credentials, the inline shapes). Each pass needs one
   of its literals (`-----begin `, `sk-`, `basic`, or the inline shapes' prefixes), its regexes fold ASCII case only,
   and a pass only puts in `[REDACTED]`, which holds no literal nor makes one across its brackets; so the gate, whose
   prefilter already saw which literals the text holds, leaves out the passes that would return their input. The
   standalone `redactString` and `redact` run every pass as before.
4. **The assignment pass** finds `=` and `:` with `indexOf` and reads a key's credential noun backwards from its last
   alphanumerics by char code (`secretKeyAt`, bucketed by last letter), with no `slice`, `replace` or memo lookup;
   `isSecretKey` itself is unchanged.
5. **Rule (d)'s tokens** are found by a walk that reads each 32-unit window from its far end: the last space in it
   moves the start past it, so prose is read about once per word; `isSpace` is a range test (checked against `/\s/`
   on all 65,536 code units).
6. **Stopwords** are looked up by their first two characters, and only when the regex half of an allowlist did not
   already decide it.
7. **Leaner**: anchors share their prefix tables (most are `[\w.-]`), occurrence lists and interval scratch that a
   dense text grew are let go after it, anchor analyses are memoised per pattern, and the sticky regexes are compiled
   by `warmGate` with the rest.

## Results

### Typical text

`env -u BUN_OPTIONS bun packages/redact/bench/gate.bench.ts --re2`: the reference gate (before), the gate now
(after), and as the re2js oracle's cost the reference gate on D24's engines (re2js for the seven rules and every
allowlist) and on re2js for everything. µs or ms a call; the last column is before / after.

**256 characters**

| Text | before | after | D24 (re2js) | all re2js | before / after |
|---|---:|---:|---:|---:|---:|
| mail | 4.6 µs | 1.9 µs | 10.3 µs | 4.0 µs | 2.46x |
| chat | 4.1 µs | 1.8 µs | 4.2 µs | 3.9 µs | 2.27x |
| doc | 4.3 µs | 1.6 µs | 4.9 µs | 4.0 µs | 2.74x |
| eval | 7.7 µs | 3.5 µs | 7.5 µs | 15.2 µs | 2.19x |
| code | 3.6 µs | 1.2 µs | 3.2 µs | 3.4 µs | 3.02x |
| log | 3.8 µs | 1.7 µs | 3.5 µs | 3.6 µs | 2.24x |
| json | 4.4 µs | 2.1 µs | 4.1 µs | 4.7 µs | 2.04x |

**2,048 characters**

| Text | before | after | D24 (re2js) | all re2js | before / after |
|---|---:|---:|---:|---:|---:|
| mail | 24.9 µs | 10.3 µs | 24.8 µs | 40.9 µs | 2.43x |
| chat | 212.1 µs | 57.5 µs | 126.7 µs | 235.4 µs | 3.69x |
| doc | 26.7 µs | 9.9 µs | 26.4 µs | 40.0 µs | 2.71x |
| eval | 24.3 µs | 8.9 µs | 24.9 µs | 40.6 µs | 2.74x |
| code | 125.4 µs | 43.4 µs | 121.5 µs | 1.20 ms | 2.89x |
| log | 66.3 µs | 17.7 µs | 67.6 µs | 52.8 µs | 3.75x |
| json | 84.8 µs | 19.1 µs | 86.7 µs | 87.9 µs | 4.45x |

**16,384 characters**

| Text | before | after | D24 (re2js) | all re2js | before / after |
|---|---:|---:|---:|---:|---:|
| mail | 931.2 µs | 106.3 µs | 800.8 µs | 10.34 ms | 8.76x |
| chat | 1.01 ms | 397.4 µs | 1.02 ms | 10.38 ms | 2.55x |
| doc | 1.01 ms | 97.3 µs | 1.02 ms | 572.2 µs | 10.38x |
| eval | 1.46 ms | 101.1 µs | 1.46 ms | 982.3 µs | 14.47x |
| code | 1.24 ms | 118.0 µs | 1.17 ms | 757.1 µs | 10.51x |
| log | 636.6 µs | 142.4 µs | 714.0 µs | 507.3 µs | 4.47x |
| json | 746.1 µs | 112.6 µs | 791.1 µs | 9.03 ms | 6.63x |

**1,048,576 characters**

| Text | before | after | D24 (re2js) | all re2js | before / after |
|---|---:|---:|---:|---:|---:|
| mail | 40.41 ms | 6.30 ms | 39.59 ms | 610.04 ms | 6.41x |
| chat | 75.63 ms | 20.23 ms | 74.49 ms | 627.98 ms | 3.74x |
| doc | 85.85 ms | 7.80 ms | 81.71 ms | 65.38 ms | 11.01x |
| eval | 108.19 ms | 11.09 ms | 102.44 ms | 79.81 ms | 9.76x |
| code | 151.61 ms | 24.24 ms | 151.16 ms | 796.58 ms | 6.25x |
| log | 42.28 ms | 7.82 ms | 41.36 ms | 46.21 ms | 5.40x |
| json | 90.51 ms | 16.41 ms | 91.61 ms | 727.24 ms | 5.52x |

Before / after: 2.0–3.0x at 256 B, 2.4–4.5x at 2 KB, 2.6–14.5x at 16 KB, 3.7–11.0x at 1 MB. Chat gains least: its
items hold planted tokens, so a rule finds something, the assignment pass runs twice and the token passes run. The
re2js columns are the oracle's cost: D24's mix is as fast as the gate was (both run the same JavaScript rules), re2js
for everything is slower than the gate now on every typical text (up to 100x: mail, chat, code and JSON at 1 MB) and
faster only where JavaScript's engine works hardest (below).

### Crafted input

The same command's crafted rows, 256 KB each (`src/gate-crafted.ts`):

| Text | before | after | D24 (re2js) | all re2js | before / after |
|---|---:|---:|---:|---:|---:|
| keyword then an operator | 37.28 ms | 39.45 ms | 39.09 ms | 668.04 ms | 0.94x |
| keywords back to back | 201.47 ms | 204.01 ms | 203.22 ms | 5.28 ms | 0.99x |
| the longest prefix before each keyword | 72.32 ms | 69.91 ms | 75.37 ms | 4.18 ms | 1.03x |
| the longest prefix, no space | 116.37 ms | 114.52 ms | 118.24 ms | 3.93 ms | 1.02x |
| prefix, keyword, operator, value | 13.22 ms | 9.52 ms | 12.05 ms | 1224.13 ms | 1.39x |
| combining marks inside a keyword | 4.16 ms | 5.13 ms | 3.94 ms | 7.72 ms | 0.81x |
| marks before a keyword | 4.12 ms | 4.49 ms | 4.18 ms | 6.11 ms | 0.92x |
| ligatures beside a keyword | 32.26 ms | 34.87 ms | 35.18 ms | 35.74 ms | 0.93x |
| two-character anchors | 127.65 ms | 130.19 ms | 133.09 ms | 8.22 ms | 0.98x |
| one non-space run after a keyword | 42.00 ms | 1.29 ms | 43.25 ms | 4.92 ms | 32.44x |
| separators | 3.02 ms | 2.14 ms | 3.49 ms | 3.57 ms | 1.41x |
| quoted values | 19.92 ms | 20.51 ms | 19.08 ms | 20.21 ms | 0.97x |
| eden-keyword | 24.10 ms | 20.75 ms | 27.03 ms | 14.65 ms | 1.16x |
| url userinfo | 4.64 ms | 4.08 ms | 4.87 ms | 4.85 ms | 1.14x |
| token literals | 8.46 ms | 11.20 ms | 8.03 ms | 11.53 ms | 0.75x |
| generic-api-key, matching | 24.29 ms | 19.21 ms | 21.75 ms | 819.71 ms | 1.26x |

The crafted inputs cost what they cost before, within 0.75–1.4x (ms-scale differences; dense candidates fall back to
the scan after the walk that found them dense), except rule (d)'s long run, 32x faster. "Keywords back to back" is the
worst for both, about 0.8 µs a character, linear: every position a candidate, JavaScript's engine trying the lazy prefix
there. `gate-linear.test.ts` holds each of these, at 256 KB, under 1.5 s of CPU.

### One-time costs and memory

`env -u BUN_OPTIONS bun packages/redact/bench/gate-startup.bench.ts before|after`, three processes each:

| Process | Import | First call | `warmGate` | Heap held, warm |
|---|---:|---:|---:|---:|
| before (three runs) | 6.9–11.3 ms | 32.1–51.2 ms | 17.0–31.1 ms | 1.85–1.86 MB |
| after (three runs) | 6.7–9.5 ms | 55.1–75.9 ms | 15.4–28.2 ms | 2.39–2.45 MB |

The first call pays for parsing every rule's regex for its anchors (`warmGate` takes it before a server listens), and
the warm gate holds about 0.55 MB more: the anchors (about 100 KB of objects), the analysis's code, the packed
scratch. The occurrence lists and interval scratch a megabyte of keywords grows are let go after that text.

### The prefilter (a primitive)

`env -u BUN_OPTIONS bun packages/primitives/bench/matcher-ab.bench.ts` (the reference matcher and the packed one in
one process, the gitleaks keywords; medians of 9 alternating rounds):

| Text (harness corpus) | markHits before | markHits after | scan (every occurrence kept) |
|---|---:|---:|---:|
| 256 B | 1.33 µs | 1.17 µs | 0.75 µs |
| 2 KB | 10.99 µs | 9.54 µs | 5.68 µs |
| 16 KB | 109.99 µs | 92.96 µs | 55.56 µs |
| 2 KB, 10% non-ASCII | 8.97 µs | 7.83 µs | 4.98 µs |

The primitives' own benchmarks, origin/main's tree (packages/primitives and packages/redact at 9edd7f198) and this
branch run alternately, twice each (separate processes, so ±30% and more between runs):

| Benchmark, p50 | main, run 1 / 2 | branch, run 1 / 2 |
|---|---|---|
| `matcher.bench.ts` markHits 256 B | 1.12 / 1.35 µs | 1.39 / 1.42 µs |
| `matcher.bench.ts` markHits 2 KB | 6.26 / 6.46 µs | 5.84 / 9.28 µs |
| `matcher.bench.ts` markHits 16 KB | 92.72 / 60.02 µs | 44.39 / 47.28 µs |
| `gate.bench.ts` the gate, 256 B | 3.44 / 3.11 µs | 1.63 / 1.06 µs |
| `gate.bench.ts` the gate, 2 KB | 13.18 / 12.96 µs | 6.63 / 5.47 µs |
| `gate.bench.ts` the gate, 16 KB | 164.61 / 127.76 µs | 53.76 / 46.98 µs |

The interleaved table above is the one to trust for the matcher. `bench/matchers.bench.ts` (the seven own matchers
against re2js) is unaffected: `scanners.ts` and `automaton.ts` did not change.

## Differential results

- `bun packages/redact/src/gate-differential.ts 250000 <seed>` for seeds 101, 202, 303 and 404 (one million texts,
  each built from samples of every rule's regex, mutated or not, the gate's literals in random case, Eden's shapes,
  prose, separators and the characters engines disagree on; 5% of them repeated up to 20 times): no difference in
  any of the four (607,152 of the million texts had a finding, so spans were compared, not only empty results;
  109–127 s a shard, four at once; run twice, the second time on the final commit).
- `bun packages/redact/src/gate-differential.ts --corpus` (every sim item of seeds 41 and 42, every eval text, every
  source file of eight packages, and each corpus kind at 256 B, 2 KB, 16 KB and 1 MB, two seeds each): 4,925 texts,
  no difference (7.2 s).
- `gate-differential.test.ts` (in the gate): 4,000 fuzz texts, every eval text, the crafted inputs at 16 KB, and
  the pieces the speed-ups rest on (`isSpace` on every code unit, random credential keys, each token pass's literals
  sampled from its regexes, the anchor analysis, the anchored scan against `matchAll` and its dense fallback).
- `matcher.test.ts`: the packed matcher against `matcher.reference.ts` (forEach, markHits, any; whole-word or not)
  and `scan` against `markHits` and `forEach` on random text with marks, ligatures, final sigma and surrogates.

The checks were checked to catch planted faults (during development, on an earlier build): capping the anchors'
prefix at 5 characters failed the fuzz within 5,000 texts, and always taking `start = end - length` in `scan` failed
`matcher.test.ts`.

## Gates

- `env -u OPENROUTER_API_KEY CHECK_COLD=1 FORMAT_COLD=1 bun run check`: passed in 89 s (2,746 tests in 274 files and
  477 in the 27-file tail). A first run failed one tail test, `router-processes.test.ts` "a restarted child that
  hangs before listening…", whose child is a stub that imports nothing of the gate (a 500 ms start deadline at load
  average 16, another agent's work beside it); the file passed three times alone and the whole gate passed when re-run.
- `bun run eval`: precision 0.65, recall 0.52, falseFireRate 0; acting: packets on 19 of 28 neutral turns (1.18 items
  each), facts handed 10 of 11, a look-alike handed on 3 of 10 owed turns: main's numbers.
- `bun run funnel` on origin/main's tree (9edd7f198) with `--json`, then on this branch with `--baseline`: hidden
  323/384, decoys 294/384 both, "hidden +0 −0, decoys +0 −0".

## Review follow-up (2026-11-14)

The independent review found no missed or extra secret in about 850,000 adversarial texts of its own, and three
things to fix:

- **Inputs packed with one literal, just under the fallback.** At the first threshold (an eighth of the text) a
  literal every 10 characters (`a3tzzzzzz `, `sk-` repeated) ran up to about 3.5x slower than before at 1 MB (16.8
  against 4.8 ms; 37.9 against 14.9 for `sk-`, the review's figures): a sticky try costs about 20 positions of the
  engine's own scan. Now the threshold is 1/32, each literal's occurrences are counted in the prefilter pass and
  checked before any walk, and past the threshold a literal's occurrences are counted but not kept. Interleaved
  medians of 7 rounds, 1 MB, the gate after against the reference (on a quiet VM, load 0.7):

  | Unit repeated to 1 MB | after | before | after / before |
  |---|---:|---:|---:|
  | `a3tzzzzzz ` | 6.8 ms | 7.5 ms | 0.90 |
  | `sk-` | 14.6 ms | 10.9 ms | 1.35 |
  | `<add key="zz ` | 19.6 ms | 22.8 ms | 0.86 |
  | `gho_zzzzz ` | 43.3 ms | 48.3 ms | 0.90 |
  | `akiazzzzz ` | 13.3 ms | 15.8 ms | 0.84 |
  | `glpat-zzz ` | 10.2 ms | 10.0 ms | 1.02 |
  | `xoxe-zzzz ` | 14.2 ms | 11.8 ms | 1.21 |
  | `kind:zzzz ` | 16.6 ms | 27.0 ms | 0.61 |
  | `eyzzzzzzz ` | 7.6 ms | 10.7 ms | 0.71 |

  The bound measured: 0.61–1.35x of the reference on these, the residue being the prefilter's counting of every
  occurrence. Typical text keeps its gain (the same A/B on the corpus, 1/32: 2.3–3.8x at 2 KB, 4.6–13.3x at 16 KB,
  3.8–14.8x at 1 MB; single runs, ±30%).
- **Memory peak.** Occurrence lists cost 8 bytes an occurrence kept (a start and a link; now at most 1/32 of the
  text's length per literal) and are held until the next call. On a 7 MB literal-dense text (`token` a million times,
  then `ghp_zzzzz ` 200,000 times), two processes each: heap held after the call 36.9–37.1 MB against 31.3–32.2 MB on
  the reference, peak RSS growth 64–65 MB against 59–71 MB, and back to the warm size (2.25 against 1.75 MB) after the
  next small text.
- **A test-order fault.** `gate-linear.test.ts` called `warmGate()` at module scope, which marked the module's gate
  warm and failed `warm.test.ts` whenever both ran in one process; it now warms the rules and builds a gate of its
  own. `bun test ./packages/redact ./packages/primitives`: 456 pass, 0 fail.

The decision is D1841 (D1840 went to the MCP change on main).

## What was not done, and next

- **The keyword-dense worst case.** On 256 KB of keywords back to back the gate takes about as long as before
  (~200 ms; JavaScript's engine on the lazy prefixes, every position a candidate), where re2js for everything takes
  ~5 ms. It is linear and under the ReDoS ceilings, and re2js is 10–100x slower on typical text; a linear matcher
  for the `[\w.-]{0,50}?(?:KEYWORD)…` family (as `scanners.ts` has for five rules) would remove it, but it is about
  200 rules of one shape with per-rule secret classes: a separate piece of work.
- **The assignment pass** is now the largest part on typical text (two passes when a rule finds something); it walks
  each value to know where to resume, so it cannot skip non-credential keys without changing results.
- **Typed-array copies of the text** were measured and not taken: copying 16 KB into a `Uint16Array` and reading it
  cost more than `charCodeAt` (37 vs 17–22 µs for one table lookup per character).
