# @eden/redact

A secret gate for text that an application stores, indexes, logs or sends to a language model. It finds credentials
(API keys, tokens, passwords, private keys, URLs that carry a password or a signature) and replaces each one with
`[REDACTED]`, keeping the words around it: "the staging password is [REDACTED]" still says what the value was for.

It runs the [gitleaks](https://github.com/gitleaks/gitleaks) default rules (v8.30.1, vendored byte for byte with
their MIT licence in `src/vendor/gitleaks/`) as gitleaks applies them, plus rules of its own for shapes gitleaks
misses or gates on context: provider tokens without their provider's name nearby, AWS secret keys beside a key id,
`password is …` in prose, URL userinfo, presigned object URLs, long random tokens near a secret word, and a structural
pass over `key = value` assignments whose key names a credential.

It has no runtime dependencies, and its time is linear in the length of the text for every input.

## Use

```ts
import { redact, sanitizeForStore, secretHits, warmGate } from "@eden/redact";

sanitizeForStore("db: postgres://admin:hunter22@db.internal/app");
// "db: postgres://admin:[REDACTED]@db.internal/app"

secretHits("export GITHUB_TOKEN=ghp_…"); // with a real 36-character token: the ids of the rules that fire,
// ["eden-keyword", "eden-legacy-token", "generic-api-key", "github-pat"]

redact({ user: "dana", password: "x", note: "Bearer abc.def" }); // structural: JSON values of any shape
// { user: "dana", password: "[REDACTED]", note: "[REDACTED]" }

warmGate(); // optional: build and compile everything now, so the first real call pays nothing
```

- `sanitizeForStore(text)`: the text with every secret replaced. Overlapping finds become one `[REDACTED]`.
- `secretHits(text)`: the sorted ids of the rules a text hits; empty when it holds no secret.
- `redact(value)` / `redactString(s)`: structural redaction of arbitrary JSON (tool inputs and outputs): values under
  credential-named keys, bearer and basic credentials, private-key blocks, provider token shapes.
- `gateOf(rules)` builds a gate over any rule list (`secretRules()` is the full set), for tests and benchmarks.

Text has no file path, so where gitleaks keys a rule or an allowlist to a path the gate is stricter: a rule with a
path condition runs on every text, a path-only rule never fires, and an allowlist's path condition never holds.

## How it is fast

A gate runs on every item an application touches, so it is built for typical text that holds no secret at all:

1. **One prefilter pass.** Every rule names literals that each of its matches contains (gitleaks' keywords, or a
   provider prefix such as `ghp_`). One Aho–Corasick automaton over all of them, folded for case and accents, reads
   the text once (about one table load a character) and selects the rules whose literals occur. The same pass records
   where the anchoring literals occur and whether any of the structural pass's token literals do.
2. **Anchored rules.** Most gitleaks rules have the shape `[\w.-]{0,50}?(?:keyword|…)…`: a bounded prefix from a
   known class, then a literal. The gate reads that from each regex once (`src/anchor.ts`) and tries the regex, made
   sticky, only at the positions a few characters before an occurrence of the literal, instead of letting the engine
   try its lazy prefix at every position of the text. The result is the same list of matches, argued in the file and
   checked by the differential fuzz. When candidates are dense (a text made of keywords) the rule scans as before.
3. **Linear matchers where JavaScript backtracks.** Seven gitleaks rules backtrack badly in JavaScript's engine
   (quadratic or worse on crafted input). They run on hand-written matchers (`src/scanners.ts`) that report what RE2
   reports, and every allowlist regex runs on a small lazily built DFA (`src/automaton.ts`).
4. **Less work around the rules.** Rule (d)'s long tokens are found by reading each window from its far end; the
   allowlist's 1,477 stopwords are looked up by their first two characters; the structural pass skips its regex
   passes when the prefilter saw none of their literals, and reads keys without making strings.

## Tested how

- **Against an oracle.** `src/secrets.reference.ts` and `src/redact.reference.ts` are the gate before the speed-ups,
  kept unchanged. `src/gate-differential.ts` builds texts from samples of every rule's regex, the gate's literals in
  random case, provider shapes, prose and the characters engines disagree on, and requires identical rule ids, spans,
  stored text and structural redaction; one million texts pass with no difference, and so does a realistic corpus
  (mail, chat, documents, code, logs, JSON) from 256 bytes to 1 MB.
- **Against RE2.** The hand-written matchers and the allowlist DFA are fuzzed against re2js (a development dependency,
  never shipped): `src/differential.ts`.
- **Linear time.** Crafted inputs for every rule left on JavaScript's engine, for each hand-written matcher and for
  each fast path, under CPU-time ceilings (`redos*.test.ts`, `own-matchers-linear.test.ts`, `gate-linear.test.ts`).

```bash
bun test packages/redact                                  # the tests
bun packages/redact/src/gate-differential.ts 1000000      # the full differential fuzz
bun packages/redact/src/gate-differential.ts --corpus     # the realistic corpus, 256 B to 1 MB
env -u BUN_OPTIONS bun packages/redact/bench/gate.bench.ts --re2   # before / after / re2js, interleaved
```

Numbers and the profile behind the design: `docs/research/redact-perf.md` in the Eden repository.

## Upgrading the rules

Replace `src/vendor/gitleaks/gitleaks.toml` with a newer release's and follow `src/vendor/gitleaks/README.md`. A rule
whose regex has no bounded prefix before a literal is simply not anchored; a change to one of the seven scanned rules
throws until its matcher is updated; allowlist syntax the DFA does not parse throws when it compiles.
