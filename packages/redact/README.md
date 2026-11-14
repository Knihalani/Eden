# @eden/redact

A secret gate for text that an application stores, indexes, logs or sends to a language model. It finds credentials
(API keys, tokens, passwords, private keys, URLs that carry a password or a signature) and replaces each one with
`[REDACTED]`, keeping the words around it: "the staging password is [REDACTED]" still says what the value was for.

It runs the [gitleaks](https://github.com/gitleaks/gitleaks) default rules (v8.30.1, vendored byte for byte with
their MIT licence in `src/vendor/gitleaks/`) as gitleaks applies them, plus rules of its own for shapes gitleaks
misses or gates on context: provider tokens without their provider's name nearby, AWS secret keys beside a key id,
Azure storage account keys, `password is …` in prose, URL userinfo, presigned object URLs, long random tokens near a
secret word, and a structural pass over `key = value` assignments whose key names a credential.

It has no dependencies, runs on Bun and on Node 24 or later, and its time is linear in the length of the text for
every input it has been tested on (below).

## Install

Not published to a registry. Copy this directory into your project (or depend on it by path); it needs nothing else.
The entry point is `src/index.ts`: Bun runs it as it is, and so does Node 24 or later, which strips TypeScript types
itself (no build step, no flags).

Node 22 is refused with an error when the gate is first used: the gitleaks rules use RegExp modifiers (`(?-i:…)`),
which Node 22 rejects, and with `--js-regexp-modifiers` runs wrongly (a modifier leaks into the rest of its
alternation, and gitleaks' `generic-api-key` then misses `GITHUB_TOKEN=…`). A gate that would miss secrets does not
build.

## Use

```ts
import { redact, sanitizeForStore, secretHits, warmGate } from "@eden/redact"; // or "./redact/src/index.ts"

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
- `containsSecret(value)`: whether `redact` would change anything.
- `gateOf(rules)` builds a gate over any rule list (`secretRules()` is the full set), for tests and benchmarks.

All of it is synchronous and keeps no state between calls beyond reusable scratch; one gate serves a process.

Text has no file path, so where gitleaks keys a rule or an allowlist to a path the gate is stricter: a rule with a
path condition runs on every text, a path-only rule never fires, and an allowlist's path condition never holds.

It errs towards redacting: a missed secret is worse than a false redaction. Its keyword rule takes the value after
`password`, `token`, `secret`, `api_key` and the like whatever its entropy. Values that cannot be a secret are left
(`src/not-secret.ts`: a type such as `apiKey: string`, `process.env.TOKEN`, `${API_KEY}`, `maxTokens: 2_000`, a mask
or a run such as `AKIAXXXXXXXXXXXXXXXX`), each beside a test that the nearest real secret of its shape is still
redacted. A plain word stays redacted (`password is sunshine` is a real password), so on gitleaks' own false-positive
examples it fires on 22% where gitleaks fires on 6%. For text bound for storage or a model that is the trade it is
built for; as a CI scanner over source code it would be noisy. It never redacts less than the gate before these
changes did (`src/never-less.test.ts`, against a frozen copy of it).

## Against the alternatives

Measured on one machine with each tool's recommended configuration (gitleaks 8.30.1, trufflehog 3.99.9 with
verification off, detect-secrets 1.5.0, secretlint 13.1.0 with the recommended preset, redact-pii 3.4.0); details,
inputs and the cases where this gate loses are in `docs/research/redact-vs-alternatives.md` in the Eden repository.

| | this gate | gitleaks | trufflehog | detect-secrets | secretlint | redact-pii |
|---|---:|---:|---:|---:|---:|---:|
| 480 real-format secrets planted in mail, chat, code, logs, JSON: removed or flagged | 100% | 73.3% | 59.0% | 64.2% | 41.3% | 21.7% |
| gitleaks' own 6,040 true-positive examples (216 rules) flagged | 100% | 99.7% | 24.5% | 48.5% | 12.5% | 11.9% |
| gitleaks' own 357 false-positive examples flagged (lower is better) | 22.4% | 6.2% | 7.3% | 22.4% | 7.3% | 24.1% |
| findings on 13.5 MB of text with no planted secret (lower is better; this gate: 13.6 MB) | 177 | 4 | 1 | 11 | 1 | 4,987 |
| in process, 16 KB of mixed text, a call | 0.31 ms (Bun), 0.49 ms (Node) | n/a | n/a | 87 ms | 0.51 ms | 2.3 ms |
| one command on a 1 MB file, startup included | 0.18 s (Bun) | 0.70 s | 2.5 s | 6.7 s | 0.33 s | n/a |
| slowest of 24 crafted 1 MB inputs, as a command (redact-pii: in process) | 0.37 s | 17.0 s | 3.2 s | >30 s on 3 | 0.46 s | >30 s on 9 |
| slowest of the 24 in process | 0.15 s (Bun), 0.18 s (Node) | n/a | n/a | >30 s on 2 | 23 ms | >30 s on 9 |

Where it loses:

- **False positives.** The 177 benign findings are mostly its keyword rule on documentation and code that names a
  password or token (132 of them; 250 before the values above were left). On the 4,460 simulated mail, chat and
  document items without a planted secret it flagged none, and on the evaluation scenarios' texts two, each holding a
  credential-shaped value (a wifi password, a database URL with a password).
- **Crafted input.** secretlint runs 27 provider rules and finds nothing in text built from keywords; this gate is
  within 2x of it on 14 of the 24 crafted inputs and 2–15x slower on the rest (25–152 ms at 1 MB against 7–17 ms),
  where a finding every 10–20 characters each pays for the allowlists and the structural pass. All stay linear.
- **Node** runs the same code 1.0–2.5x slower than Bun.

The benign corpus figures for this gate are on the repository after a later merge (13.6 MB, 5,609 files); the other
tools' were measured once, on 13.5 MB.

## How it is fast

A gate runs on every item an application touches, so it is built for typical text that holds no secret at all:

1. **One prefilter pass.** Every rule names literals that each of its matches contains (gitleaks' keywords, or a
   provider prefix such as `ghp_`). One Aho–Corasick automaton over all of them, folded for case and accents, reads
   the text once (about one table load a character) and selects the rules whose literals occur. The same pass records
   where the anchoring literals occur and whether any of the structural pass's token literals do.
2. **Anchored rules.** Most gitleaks rules have a bounded prefix from a known class before a literal. The gate reads
   that from each regex (`src/anchor.ts`) and tries the regex, made sticky, only a few characters before an
   occurrence of the literal, instead of letting the engine try every position of the text.
3. **The lazy prefix read by hand.** 96 rules have the shape `[\w.-]{0,50}?(?:KEYWORD|…)REST`. JavaScript's engine
   tries the 0–50 character prefix and REST after each length at every position; on text dense in keywords that was
   about 1 µs a character. The gate instead tries REST once, sticky, at each keyword occurrence and works out the
   leftmost start by hand (argued in `src/anchor.ts`): the same matches, linear. For generic-api-key, the rule that
   fires most, REST itself is read by hand too (`src/generic-rest.ts`), each candidate decided by the length of a run.
4. **Linear matchers where JavaScript backtracks.** Seven gitleaks rules backtrack badly in JavaScript's engine
   (quadratic or worse on crafted input). They run on hand-written matchers (`src/scanners.ts`) that report what RE2
   reports, and every allowlist regex runs on a small lazily built DFA (`src/automaton.ts`), its verdict on a line
   worked out once a line.
5. **Less work around the rules, and at start.** Rule (d)'s long tokens are found by reading each window from its far
   end; the allowlist's 1,477 stopwords are looked up by their first two characters; the structural pass skips its
   regex passes when the prefilter saw none of their literals. Every regex's anchor analysis is worked out ahead into
   `src/rules.generated.json` (with the gitleaks config as JSON), so the first call parses no rule.

## Tested how

- **Against an oracle.** `src/secrets.reference.ts` and `src/redact.reference.ts` are the gate without its speed
  paths. `src/gate-differential.ts` builds texts from samples of every rule's regex, the gate's literals in random
  case, provider shapes, prose and the characters engines disagree on, and requires identical rule ids, spans, stored
  text and structural redaction; one million texts pass with no difference, and so does a realistic corpus (mail,
  chat, documents, code, logs, JSON) from 256 bytes to 1 MB.
- **Against RE2.** The hand-written matchers and the allowlist DFA are fuzzed against re2js (a development dependency,
  never shipped): `src/differential.ts`.
- **Linear time.** Crafted inputs for every rule left on JavaScript's engine, for each hand-written matcher and for
  each fast path, under CPU-time ceilings (`redos*.test.ts`, `own-matchers-linear.test.ts`, `gate-linear.test.ts`).
- **Never less than before.** `src/never-less.test.ts` holds the gate to a frozen copy of itself before the values
  that cannot be a secret were left and the newest rules added: every character the old gate removed is removed, or
  belongs to a value `src/not-secret.ts` accepts. The new rules run after the old pipeline (`src/compose.ts`), so they
  cannot change what it sees.
- **Bun and Node agree.** `node-parity.test.ts` runs the gate on Node over fuzz texts and the crafted inputs and
  requires Bun's findings, text for text; `node-linear.test.ts` holds the crafted inputs under the same CPU ceiling
  on Node; `src/node.check.ts` is the API under `node --test`.

```bash
bun test ./src                                            # the tests (from this directory)
node --test src/node.check.ts                             # the API on Node 24+
bun src/gate-differential.ts 1000000                      # the full differential fuzz
bun src/gate-differential.ts --corpus                     # the realistic corpus (needs the Eden repository)
env -u BUN_OPTIONS bun bench/gate.bench.ts --re2          # before / after / re2js (needs the Eden repository)
```

Numbers and the profile behind the design: `docs/research/redact-perf.md` and `docs/research/redact-vs-alternatives.md`
in the Eden repository.

## Upgrading the rules

Replace `src/vendor/gitleaks/gitleaks.toml` with a newer release's, follow `src/vendor/gitleaks/README.md`, and run
`bun src/generate.ts` (it writes `src/rules.generated.json`, which the gate imports; a test fails while it is stale).
A rule whose regex has no bounded prefix before a literal is simply not anchored; a change to one of the seven
scanned rules throws until its matcher is updated; allowlist syntax the DFA does not parse throws in `generate.ts`.
