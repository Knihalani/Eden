# @eden/redact

The secret gate (salvaged from the memory era, D16): vendored gitleaks v8.30.1 rules plus Eden's own rules,
prefiltered by one Aho–Corasick pass (D21) that also says where each rule's anchoring literals occur, so most rules
try their regex only just before those (D1841, docs/research/redact-perf.md), and the 96 keyword-assignment rules
read their lazy `[\w.-]{0,50}?` prefix by hand (D1850). The seven rules that backtrack in JavaScript run on
hand-written linear matchers and every allowlist regex on the gate's own lazy DFA (D1705; D24 ran both on re2js).
The package stands alone (D1850): no dependency at all (the matcher it needs is vendored from @eden/primitives), it
runs on Bun and on Node 24, and its rule config and anchor analyses are one generated JSON file. Every text Eden
stores, indexes, logs or sends to a model passes `sanitizeForStore` first (D10). See [README.md](README.md); the
comparison with gitleaks, trufflehog, detect-secrets, secretlint and redact-pii is
docs/research/redact-vs-alternatives.md.

## Files

| File | Owns |
|---|---|
| `src/secrets.ts` | The rule set (`secretRules`, `LINEAR_RULES`, `GATE_ENGINES`, `checkScanners`, `checkRegexModifiers`), Go-to-JS regex translation (`goRegex`, `backtrackingEngine`), the gate (`gateOf`: one `MultiMatcher.scan` for hits, anchor occurrences and token literals), `secretHits`, `sanitizeForStore`; Eden's extra rules (URL userinfo, `eden-aws-secret` D86, bare provider shapes such as `eden-discord-webhook`, `eden-new-relic`, `eden-azure-storage-key` and `eden-presigned-url` D220, D1850); allowlist `Stopwords`; `Lines` (a line allowlist's verdict once a line, D1850) |
| `src/anchor.ts` | D1841: `anchorsOf` (a Go regex's bounded prefix and literals, from `parseRegex`), `anchorsOfRegex` (Eden's JavaScript regexes, lookarounds dropped), `Occurrences` (a literal past the dense limit leaves `keep` for the text, D1850), `anchoredMatches`/`AnchoredRegex` (sticky tries where a match can start; `matchAll`'s matches; dense candidates fall back to the scan). D1850: `LazyPrefixRegex`/`lazyPrefixOf` (the lazy prefix read by hand, the rest of the regex tried once at each keyword, later top-level branches as one regex), `useAnalyses` (the generated tables), `analyseAnchors`/`analyseLazy` (the analyses worked out now, for `generate.ts`) |
| `src/generic-rest.ts` | D1850: generic-api-key's REST (the regex after its lazy prefix) read by hand, each candidate decided by the length of a run; `generic-rest.test.ts` checks every position of seeded texts against the sticky regex |
| `src/not-secret.ts` | D1850: values that cannot be a secret, each only as the whole value (`notSecret`: a type, `process.env.NAME`, a member chain of two or more on a known receiver, `${NAME}` without a default, `$NAME`, `%NAME%`, `{{name}}`, `<your-key>`, a mask, a run; `placeholderToken`: a mask or run), which the keyword rules and the gate's assignment pass leave in place; `excused` wraps a rule so it reports both kinds of span |
| `src/memo.ts` | D1850: memos that answer only inside an entry point (`withMemos`: `sanitizeForStore`, `secretHits`, `findings`, `explain`) and are emptied when it returns: a memo keyed by a slice kept the caller's whole text alive (`memo.test.ts` holds the retained heap flat) |
| `src/compose.ts`, `src/pieces.ts` | D1850: the stored text from the rules' spans. Main's pipeline runs as it was (every pre-D1850 span, excused ones included, gates the text; the structural pass runs on it); D1850's rules (`post`) add spans and the excused values' own characters come back. Each rewrite is kept as pieces (`pieces.ts`) and every removal traced back to the text as intervals (`structuralRemoved` in redact.ts), so the cost follows the findings; `byStart` merges the rules' spans |
| `src/generate.ts`, `src/rules.generated.json` | D1850: the vendored TOML as JSON (what the gate imports, on any runtime) and every regex's anchor analysis; `bun packages/redact/src/generate.ts` rewrites it, `generated.test.ts` fails when it is stale; it also checks every allowlist regex parses (`checkAllowlists`) |
| `src/primitives/` | D1850: `matcher.ts` and `charclass.ts` (and the test-only `matcher.reference.ts`) vendored byte for byte from @eden/primitives; `generated.test.ts` fails when they differ from the shared copies |
| `src/scanners.ts` | `SCANNERS`: the linear matchers for the seven rules in `LINEAR_RULES` (five keyword-assignment rules, two curl rules), each with the exact regex it implements; `SCANNER_CLASSES` for the class tests (D1705) |
| `src/automaton.ts` | The allowlist engine: an RE2-subset parser, a Thompson NFA, a lazily built DFA (`test` only, at most 2,000 states a pattern), `compileAllowlistRegex` (D1705) |
| `src/redact.ts` | Structural redaction of JSON (`redact`, `redactString` = `redactAssignments(redactTokensIn(s, ALL_TOKEN_PASSES))`, `isSecretKey`, PEM blocks), `TOKEN_PASSES` (D1841: the gate leaves out a token pass whose literals its text lacks), `REDACTED`/`CYCLE`/`TRUNCATED` markers |
| `src/secrets.reference.ts`, `src/redact.reference.ts` | Test support (D1841): the gate before D1841, the oracle (with `src/primitives/matcher.reference.ts`); unchanged but for D1850's detection changes (its post rules, the excused values, compose.ts), made in both; never imported by the gate |
| `src/secrets.baseline.ts`, `src/redact.baseline.ts` | Test support (D1850): main's reference gate before D1850, frozen (it never moves with the gate), for `never-less.ts` |
| `src/never-less.ts`, `src/never-less.test.ts`, `src/never-less-oracle.ts` | D1850: the gate never redacts less than main before D1850: every baseline span inside the gate's spans or excused ones, main's mask equal to the gate's own account of it, and every run of characters main removed and the gate keeps a value the independent oracle (`never-less-oracle.ts`, written apart from `not-secret.ts`) calls code; fuzz, keyword-chain and excused-shape texts (a token glued after every shape); also a command (below) |
| `src/gate-differential.ts` | Test support: the whole-gate fuzz against the reference (rule ids, spans, `secretHits`, `sanitizeForStore`, `redactString`, `redact`); also a command (below) |
| `src/gate-crafted.ts` | Test support: inputs built against the fast paths, for `gate-linear.test.ts` and `bench/gate.bench.ts` |
| `src/node.check.ts`, `src/node-parity.ts`, `src/node-linear.ts` | D1850: the gate under `node --test` (Node 24+), the Node side of `node-parity.test.ts` (Bun and Node give the same findings, text for text) and of `node-linear.test.ts` (the crafted inputs under a CPU ceiling on V8) |
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
  finds (a new rule; not a gitleaks update, which both read from the same config) makes the same change there, in the
  same commit, so the fuzz keeps comparing like with like.
- **Generated tables (D1850).** The gate imports `rules.generated.json`, never the TOML: after vendoring a gitleaks
  release, changing one of Eden's regexes or the anchor analysis, run `bun packages/redact/src/generate.ts`;
  `generated.test.ts` fails until you do. Change `src/primitives/` only by changing @eden/primitives and copying.
- **Runtimes (D1850).** Imports carry their `.ts` extension and the code uses no TypeScript-only syntax Node cannot
  strip (parameter properties, enums), so Node 24 runs the sources as they are. The gitleaks rules need RegExp
  modifiers as ES2025 defines them: `rulesWith` refuses to build on an engine that lacks them or runs them wrongly
  (Node 22 with `--js-regexp-modifiers` lets `(?-i:…)` leak into the rest of an alternation and misses secrets).
- **Linear time (D24, D1705).** Any rule that backtracks on crafted input gets a linear matcher in `scanners.ts` and
  joins `LINEAR_RULES`. `redos.test.ts` and `redos-{1,2,3}.test.ts` (the sweep in `redos-sweep.ts`, split by rule
  index) fail when a gitleaks update adds one (rules left on JavaScript must stay under 40 ms on 8 KB crafted runs,
  best of three, each run timed as the lesser of wall and CPU time) and check 128 KB attacks stay under 1 s.
  `own-matchers-linear.test.ts` holds each own matcher under a CPU-time ceiling on 1 MB crafted runs, and
  `gate-linear.test.ts` (Bun) and `node-linear.test.ts` (Node 24+) the whole gate on the crafted inputs. Work done per
  finding must not grow with the text (D1850: a line allowlist re-read its whole line for every finding on it).
- **Exact against RE2 (D1705).** The own matchers report what re2js reports on D24's patterns (`re2Source`'s
  meanings: JavaScript's `\s` and `.`, Unicode case folding, code points): `own-matchers.test.ts` checks every
  character class on every code point, a seeded fuzz and the whole gate's output. A gitleaks update that changes a
  scanned rule's regex makes `rulesWith` throw (`checkScanners`), and one that adds allowlist syntax the automaton
  lacks throws in `generate.ts`: update the matcher or the parser, then run the full fuzz. Never fall back to a
  backtracking regex.
- **Never redact less than main (D1850).** A change that lets a value through goes in `not-secret.ts`, as a whole-value
  shape, with a test that the nearest real secret of its shape is still caught, the same shape in
  `never-less-oracle.ts` written apart, and `never-less.test.ts` passing; a missed secret is worse than a false
  redaction. The public `redactString`, `redact` and `containsSecret` excuse nothing (main's behaviour). A new detection is a post rule (compose.ts): its spans join after main's pipeline, never
  before it, since spans added before it changed what the keyword rule and the structural pass saw (the review of
  2026-11-14: `token is Bearer secret is …` left the secret in clear).
- **Never weaken the gate to fix a false positive in a test**: make the test text not secret-shaped. Secret-shaped
  test values are assembled from parts (`"AK" + "IA" + …`) so no literal in the repo is one.
- **Memos last one call (D1850, D10).** State keyed by a caller's text (a slice keeps its parent alive) lives in a
  `memo.ts` memo and is emptied when the entry point returns; never keep it across calls.
- **Dependencies (D15, D1705, D1850):** none at all (the package.json has no `dependencies`). `re2js` (pinned 2.9.0)
  is a devDependency, the oracle, imported only by `re2-oracle.ts`; `scripts/dockerfile.test.ts` fails if a server
  imports any npm package.
- The engine and sources call this on every item: a slower gate is a slower fast path. Measure with
  `bench/gate.bench.ts` (interleaved against the reference gate), `packages/primitives/bench/gate*.bench.ts` and
  `bench/matchers.bench.ts` before and after.

## Test

```bash
bun run test:pkg redact          # 25 files; linear.test.ts, own-matchers*.test.ts and the redos* files lead
cd packages/redact && bun test ./src            # alone, as the package would stand in its own repository
node --test packages/redact/src/node.check.ts   # Node 24+ (REDACT_NODE=… bun test …/node-parity.test.ts compares;
                                                # …/node-linear.test.ts holds the crafted inputs to a ceiling on V8)
bun packages/redact/src/differential.ts 50000   # the full fuzz: 50,000 texts per matcher, ~5 min
bun packages/redact/src/gate-differential.ts 250000 101   # the whole gate against the reference: 4 seeds of 250,000
                                                          # (101, 202, 303, 404) at once, ~110 s each
bun packages/redact/src/gate-differential.ts --corpus     # the realistic corpus, 256 B to 1 MB
bun packages/redact/src/never-less.ts 100000 7            # never less than main: 100,000 fuzz and chain texts
env -u BUN_OPTIONS bun packages/redact/bench/gate.bench.ts --re2   # before / after / re2js
```

## Pitfalls

- The timing tests use ceilings. The sweep's ignores waiting for a core (the lesser of wall and CPU time, best of
  three, 40 ms vs 13 ms measured); the own matchers' and the 128 KB attacks' are CPU time. If one flakes, investigate
  before raising a ceiling: that ceiling is the ReDoS guard.
- re2js keeps state per input string: a second call on the same string returns in about 0 ms. Benchmarks against it
  use a fresh string per call.
- The test preload clears `EDEN_*` variables: the Node parity test reads `REDACT_NODE`, not an `EDEN_` name.
- The vendored README mentions memory-era file names (`memory-secrets.ts`); today's equivalents are `secrets.ts` and
  its tests.

## Where next

`docs/research/architecture-alternatives.md` (ReDoS and RE2), `docs/research/edge-secret.md` (D86),
`docs/research/redact-vs-alternatives.md` (D1850), `docs/PRIVACY.md`, `packages/engine/src/gate.ts` (gating off the
event loop, D25/D26).
