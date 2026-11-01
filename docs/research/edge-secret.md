# Edge track "secret": an AWS secret access key passed the gate

Proposed decision: D86 (below). No model call was made for this track (its free-request cap was 0).

## The gap

The sim world's "AWS access" mail (`packages/sim/src/world.ts`, `secretsAndInjections`) reads
`here you go: AKIA… / <40 letters and digits>`. The gate redacted the key id (`eden-aws-key-id`,
`eden-legacy-token`) and stored the secret access key in the clear:

```
"[REDACTED] / ecmkge7ZUCcmbps0qxbq4MrLXouAu7TKSguT6TzJ"   secretHits → []
```

Why each existing rule missed it:

- gitleaks v8.30.1 has a rule for AWS key ids, none for the 40-character secret beside one;
- rule (d), entropy with a keyword, wants a secret keyword within 40 characters; "here you go" and a key id are none.
  It also skips any token holding `/`, which most real AWS secrets do (`wJalr…/K7MDENG/…`), so even
  `aws secret key wJalrXUtnFEMI/K7MDENG/…` passed;
- the structural redactor only sees `key = value` with a credential-noun key.

The sim's own leak check missed it too: the item's planted `secret` is the key id alone, so the tail was never checked.

## The rule: `eden-aws-secret` (packages/redact/src/secrets.ts, rule (a″))

A token is redacted when all hold:

1. it is a maximal run of exactly 40 characters of `[A-Za-z0-9/+]` (AWS's alphabet, unpadded base64), so a token
   inside a longer run never qualifies;
2. it is not pure hex (git SHAs and SHA-1 digests, in either case);
3. it mixes upper and lower case (a random key fails that about once in 10^9);
4. its Shannon entropy is at least 4.0 bits a character, and it is not a file path (two or more `/`, no `+`, every
   segment a word or CamelCase words then digits);
5. within 40 characters before or after it there is an anchor: an `AKIA`/`ASIA` key id, the `[REDACTED]` sentinel (a
   key id an earlier pass, or the source, already replaced), or the word "secret" in any case (`SecretAccessKey`,
   `AWS_SECRET_ACCESS_KEY`).

The entropy floor was measured: over 10^6 random 40-character keys in AWS's alphabet the minimum was 4.04 bits
(10^-5 quantile 4.17, median 4.78); `SecretsManagerGetSecretValueRequestInput` is 3.76, a 40-character source path
3.77. 240 of the 10^6 random keys lacked one of upper case, lower case, or a digit/symbol, which is why condition 3
asks for both cases only and not for a digit.

The prefilter words are `akia`, `asia`, `[redacted]`, `secret`: every anchor holds one, so a text without them never
runs the rule (prefilter.test.ts checks equivalence with a sample).

## Tests (packages/redact/src/aws-secret.test.ts, plus the existing suites)

Positives (each redacted, a `secretHits` hit, and a second `sanitizeForStore` pass changes nothing): beside a
redacted key id (the reported text), beside an `AKIA` id, beside an `ASIA` id, id after the secret, after "secret",
an env line, an `~/.aws/credentials` block, a secret holding `/` and `+`, a CSV row, YAML, a secret starting with `/`.
Negatives: a git SHA beside a key id, an upper-case hex digest beside "secret", no anchor, an anchor 60 characters
away, 39 and 41 characters, an absolute and a relative 40-character path, a low-entropy CamelCase name, all lower
case, all upper case, "Asia" in prose, prose about secrets. `linear.test.ts` holds the new rule under the crafted-input
ceiling and adds a 128 KB input where every token is a candidate.

## Scan of the sim worlds (`packages/sim/src/lab/secret-scan.ts`)

Every distinct item (title and text) of the base world and of the suites `hidden`, `heldout`–`heldout4`, `dev6a`,
`dev6b` (both variants), through the gate, then detectors looser than the gate (prefixed tokens, AWS key ids, JWTs,
PEM banners, `key: value` assignments, URL userinfo, 20+ character tokens with entropy ≥ 3.5 that are not hex, UUIDs,
ULIDs or sim links). No blind suite is loaded.

| Seeds | Items | Survivors before | Survivors after | Items the rule changed | Planted secrets leaked |
| --- | ---: | ---: | ---: | ---: | ---: |
| 41, 42, 43 | 5,063 | 3 (the AWS secret, one per seed) | 0 | 3 (the "AWS access" mail) | 0 |
| 44, 45, 46, 47 | 6,711 | not run | 0 | 4 (the "AWS access" mail) | 0 |

"Before" is the same gate without `eden-aws-secret`. No other secret shape survives in the sim worlds: the Stripe,
GitHub and wifi-password items were already redacted. The rule changed no other item, so it adds no false positives
there. Over the repo's own text (8,183 `.md`, `.ts`, `.json`, `.toml` files outside tests and blind suites, 71.8 MB,
full of the word "secret", hashes and paths) it found nothing.

## Cost (D24 and the primitives README ask for before/after numbers)

The machine was shared with other agents (4 cores), so whole-run numbers move ±25% between runs. Two kinds of run:

`bench/gate.bench.ts` (the shipped gate, the "after (Aho-Corasick prefilter)" rows), mean µs. Its corpus never holds
an anchor word, so the new rule does not run there; the differences are noise:

| Text | before | after |
| --- | ---: | ---: |
| 256 B | 6.46 | 5.57 |
| 2 KB | 18.31 | 14.64 |
| 16 KB | 157.29 | 260.06 |

`bench/gate-engine.bench.ts`, the D24 (targeted RE2) column, mean µs:

| Text | before | after |
| --- | ---: | ---: |
| benign 256 B | 3.38 | 6.76 |
| benign 2 KB | 15.92 | 24.55 |
| benign 16 KB | 232.69 | 250.61 |
| benign 2 KB, 10% non-ASCII | 21.85 | 34.14 |
| keyword-dense 2 KB | 112.56 | 109.09 |
| 2 secrets ~2 KB | 38.27 | 37.73 |

Because those runs disagree in both directions on texts the rule never sees, the rule's own cost was measured by an
interleaved A/B in one process (the gate with and without `eden-aws-secret`, five alternating rounds, medians; a
scratch script, not committed), mean µs:

| Text | without | with |
| --- | ---: | ---: |
| benign 2 KB (no anchor) | 18.13 | 22.79 |
| benign 16 KB (no anchor) | 162.35 | 161.58 |
| keyword-dense 2 KB ("secret" twice) | 111.27 | 113.82 |
| an AWS key pair in ~2 KB | 40.77 | 50.19 |

The first version scanned with `matchAll(/[A-Za-z0-9/+]+/g)`: on keyword-dense text it cost 114.51 → 155.33 µs, on the
AWS pair 32.85 → 69.12 µs (a match object per word). `/…{40,}/g` brought keyword-dense back to even but still cost
8.6 µs a 2 KB text alone; the shipped version walks char codes against a 128-entry table, 4.0 µs a 2 KB text alone
and 10.5 µs on the AWS pair (which also slices, measures and anchors the one candidate). Crafted input: 128 KB of
back-to-back candidates beside "secret" runs the whole gate in 33.8 ms, 1 MB in 164.2 ms (measured with the first
version; the walk is cheaper), linear.

## `bun run check` and `bun run eval`

`bun run check`: 1,167 pass, 0 fail. `bun run eval` (no model) equals main's except latency: precision 1, recall
0.444, falseFireRate 0, secretsLeaked 0 on both; p50 0.456 → 0.400 ms, p95 3.49 → 6.14 ms (one run each).

## Found on the way, not fixed here

- The structural redactor (`redactString`) is not idempotent on a JSON value it already redacted:
  `{"SecretAccessKey": "x"}` → `{"SecretAccessKey": [REDACTED]}` → `{"SecretAccessKey": [REDACTED]` (the unquoted
  value runs to the next space, eating `}` or `,`). It predates this change (the same happens without the new rule).
- Rule (d) redacts a 40-character git SHA next to the word "secret" (`commit 9fceb02… secret fix`). Stricter, so
  harmless to privacy, but it costs text; out of scope for a gate that must never get looser.
- The sim world records only the key id as the "AWS access" item's planted secret, so `secretsLeaked` could not see
  the tail. Recording both would make the leak check catch this class.

## Verdict

Ship: the leak is closed, with no false positive on 11,774 sim items or 71.8 MB of repo text, no eval change, and a
cost only on texts holding an anchor word (about +10 µs on a 2 KB text holding an AWS key pair).
