# @eden/redact

The secret gate (salvaged from the memory era, D16): vendored gitleaks v8.30.1 rules plus Eden's own rules,
prefiltered by one Aho–Corasick pass (D21) that also says where each rule's anchoring literals occur, so most rules
try their regex only just before those (D1841, docs/research/redact-perf.md). The seven rules that backtrack in
JavaScript run on hand-written linear matchers and every allowlist regex on the gate's own lazy DFA (D1705; D24 ran
both on re2js); the gate has no npm dependency. Every text Eden stores, indexes, logs or sends to a model passes
`sanitizeForStore` first (D10). See [README.md](README.md).

## Files

| File | Owns |
|---|---|
| `src/secrets.ts` | The rule set (`secretRules`, `LINEAR_RULES`, `GATE_ENGINES`, `checkScanners`), Go-to-JS regex translation (`goRegex`, `backtrackingEngine`), the gate (`gateOf`: one `MultiMatcher.scan` for hits, anchor occurrences and token literals), `secretHits`, `sanitizeForStore`; Eden's extra rules (URL userinfo, `eden-aws-secret` D86, bare provider shapes such as `eden-discord-webhook`, `eden-new-relic` and `eden-presigned-url` D220); allowlist `Stopwords` |
| `src/anchor.ts` | D1841: `anchorsOf` (a Go regex's bounded prefix and literals, from `parseRegex`), `anchorsOfRegex` (Eden's JavaScript regexes, lookarounds dropped), `Occurrences`, `anchoredMatches`/`AnchoredRegex` (sticky tries where a match can start; `matchAll`'s matches; dense candidates fall back to the scan) |
| `src/scanners.ts` | `SCANNERS`: the linear matchers for the seven rules in `LINEAR_RULES` (five keyword-assignment rules, two curl rules), each with the exact regex it implements; `SCANNER_CLASSES` for the class tests (D1705) |
| `src/automaton.ts` | The allowlist engine: an RE2-subset parser, a Thompson NFA, a lazily built DFA (`test` only, at most 2,000 states a pattern), `compileAllowlistRegex` (D1705) |
| `src/redact.ts` | Structural redaction of JSON (`redact`, `redactString` = `redactAssignments(redactTokensIn(s, ALL_TOKEN_PASSES))`, `isSecretKey`, PEM blocks), `TOKEN_PASSES` (D1841: the gate leaves out a token pass whose literals its text lacks), `REDACTED`/`CYCLE`/`TRUNCATED` markers |
| `src/secrets.reference.ts`, `src/redact.reference.ts` | Test support (D1841): the gate before D1841, unchanged, the oracle (with `packages/primitives/src/matcher.reference.ts`); never imported by the gate |
| `src/gate-differential.ts` | Test support: the whole-gate fuzz against the reference (rule ids, spans, `secretHits`, `sanitizeForStore`, `redactString`, `redact`); also a command (below) |
| `src/gate-crafted.ts` | Test support: inputs built against the fast paths, for `gate-linear.test.ts` and `bench/gate.bench.ts` |
| `src/re2-oracle.ts` | Test support: re2js (a devDependency) as the oracle, `re2Source`, `linearEngine`, `D24_ENGINES` (the gate D24 shipped); not in the image |
| `src/differential.ts` | Test support: the seeded differential fuzz of every scanned rule and allowlist regex against re2js; also a command (below); not in the image |
| `src/vendor/gitleaks/` | `gitleaks.toml` byte for byte, its LICENSE and pinned hash ([upgrade steps](src/vendor/gitleaks/README.md)) |
| `bench/matchers.bench.ts` | Each own matcher against re2js, typical and crafted input |
| `bench/gate.bench.ts`, `bench/gate-startup.bench.ts`, `bench/corpus.ts` | The whole gate before/after (and re2js with `--re2`), interleaved medians on realistic text (sim worlds, eval, code, logs, JSON; 256 B to 1 MB) and crafted input; one-time costs and heap per process |

## Rules that apply here

- **The prefilter may only add candidates, never drop them (D21);** `prefilter.test.ts` enforces it.
- **Anchors only skip positions where no match can start (D1841).** An anchor is read from the regex (a bounded
  prefix from a known class, then a literal of 2+ characters every match holds), never written by hand; a regex
  without one scans as before. Any change to the gate's speed paths runs `gate-differential.test.ts` and the full
  fuzz below. The reference files are the gate without its speed paths: a change meant to change what the gate
  finds (a new rule; not a gitleaks update, which both read from the same TOML) makes the same change there, in the
  same commit, so the fuzz keeps comparing like with like.
- **Linear time (D24, D1705).** Any rule that backtracks on crafted input gets a linear matcher in `scanners.ts` and
  joins `LINEAR_RULES`. `redos.test.ts` and `redos-{1,2,3}.test.ts` (the sweep in `redos-sweep.ts`, split by rule
  index) fail when a gitleaks update adds one (rules left on JavaScript must stay under 40 ms on 8 KB crafted runs,
  best of three, each run timed as the lesser of wall and CPU time) and check 128 KB attacks stay under 1 s.
  `own-matchers-linear.test.ts` holds each own matcher under a CPU-time ceiling on 1 MB crafted runs.
- **Exact against RE2 (D1705).** The own matchers report what re2js reports on D24's patterns (`re2Source`'s
  meanings: JavaScript's `\s` and `.`, Unicode case folding, code points): `own-matchers.test.ts` checks every
  character class on every code point, a seeded fuzz and the whole gate's output. A gitleaks update that changes a
  scanned rule's regex makes `rulesWith` throw (`checkScanners`), and one that adds allowlist syntax the automaton
  lacks throws when it compiles: update the matcher or the parser, then run the full fuzz. Never fall back to a
  backtracking regex.
- **Never weaken the gate to fix a false positive in a test**: make the test text not secret-shaped. Secret-shaped
  test values are assembled from parts (`"AK" + "IA" + …`) so no literal in the repo is one.
- **Dependencies (D15, D1705):** none in production. `re2js` (pinned 2.9.0) is a devDependency, the oracle, imported
  only by `re2-oracle.ts`; `scripts/dockerfile.test.ts` fails if a server imports any npm package.
- The engine and sources call this on every item: a slower gate is a slower fast path. Measure with
  `bench/gate.bench.ts` (interleaved against the reference gate), `packages/primitives/bench/gate*.bench.ts` and
  `bench/matchers.bench.ts` before and after.

## Test

```bash
bun run test:pkg redact          # 16 files, ~12 s wall cold (2026-11-13, 4 at once): linear.test.ts ~10 s,
                                 # own-matchers.test.ts ~8 s, own-matchers-linear.test.ts ~7 s, redos* 4-6 s each
bun packages/redact/src/differential.ts 50000   # the full fuzz: 50,000 texts per matcher, ~5 min
bun packages/redact/src/gate-differential.ts 250000 101   # the whole gate against the reference: 4 seeds of 250,000
                                                          # (101, 202, 303, 404) at once, ~110 s each
bun packages/redact/src/gate-differential.ts --corpus     # the realistic corpus, 256 B to 1 MB
env -u BUN_OPTIONS bun packages/redact/bench/gate.bench.ts --re2   # before / after / re2js
```

## Pitfalls

- The timing tests use ceilings. The sweep's ignores waiting for a core (the lesser of wall and CPU time, best of
  three, 40 ms vs 13 ms measured); the own matchers' and the 128 KB attacks' are CPU time. If one flakes, investigate
  before raising a ceiling: that ceiling is the ReDoS guard.
- re2js keeps state per input string: a second call on the same string returns in about 0 ms. Benchmarks against it
  use a fresh string per call.
- The vendored README mentions memory-era file names (`memory-secrets.ts`); today's equivalents are `secrets.ts` and
  its tests.

## Where next

`docs/research/architecture-alternatives.md` (ReDoS and RE2), `docs/research/edge-secret.md` (D86),
`docs/PRIVACY.md`, `packages/engine/src/gate.ts` (gating off the event loop, D25/D26).
