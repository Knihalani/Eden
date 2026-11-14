# The secret gate's last weak points, and the gate against the open-source alternatives

Decision: D1850. Owner's brief of 2026-11-14: fix the gate's remaining weak points (redact-perf.md, "What was not
done"), make `packages/redact` usable on its own, and benchmark it head to head against the common open-source
secret scanners and redactors. No model call was made. Every number below comes from a command run in this session
on the shared 4-core VM, with another agent's work beside it (load 2–8): timings vary ±30% run to run, and the
tables say which are medians of interleaved rounds. The comparison's scripts and inputs lived in the session's
scratchpad (`cmp/`); they are described below closely enough to rebuild, and were deleted with the downloaded tools.
An independent review of the first version (34a11308f) asked for changes: one secret it left in clear (§7), its
false positives (§8), the crafted worst cases (§9), the literal-dense residue and Node (§10). Sections 7–10 are that
second round; where a table of Part 2 was not measured again, it says so.

## Part 1: the weak points

### 1. The keyword-dense worst case: 1,052 → 45 ms a megabyte

A profile per rule (each rule's `spans` timed inside the gate) on the crafted inputs put all of the cost in one
family: the 96 gitleaks rules shaped `(?i)[\w.-]{0,50}?(?:KEYWORD|…)REST`. On `tokentoken…` (1 MB) generic-api-key
took 1,039 of the gate's 1,052 ms. D1841's anchors could not help there: every position near a keyword is a
candidate start, so the rule fell back to JavaScript's own scan, which tries the lazy prefix's 0–50 lengths and REST
after each, at every position.

A sweep of crafted 64 KB texts built from every JavaScript-engine rule's keywords (14 units each, 3,941 texts) then
found worse: **main was quadratic** on one of them. `bedrock-api-key-='` repeated took 3.4 s at 64 KB and 13.2 s at
128 KB (4 KB to 128 KB: 86, 66, 252, 934, 3,378, 13,164 ms). The cause was not a regex: generic-api-key has an
allowlist that targets the whole line, and the gate (and the reference) tested it once a finding, so a long line with
many findings was read once for each. The redos tests never built a line with thousands of findings. Twitter's,
jfrog's, dropbox's and discord's rules were linear but slow, 2–4 µs a character on their own keywords.

Fixes, each exact:

- **The lazy prefix read by hand** (`LazyPrefixRegex`, anchor.ts). REST (the regex after the prefix) runs once,
  sticky, at each keyword occurrence k. From a start s the engine tries k = s, s+1, … while `[s, k)` is prefix
  characters and k − s ≤ 50, and the first k where REST matches gives the match; REST's match from k does not depend
  on s. The starts that reach k form an interval from start(k), so the leftmost match starts at the least start(k)
  over the k where REST matches, and its k is the least one with that start. The search stops 50 past the best start;
  matches go on from each one's end, as `matchAll` does. A later top-level branch (atlassian-api-token's
  `|\b(ATATT3…)`) runs as one regex; at an equal start the first branch wins, as in the engine. Occurrences come from
  the prefilter's lists; when a literal passed the dense limit (its list is incomplete) the rule finds them itself
  with an empty-match regex, a window at a time (a first version listed every occurrence and held 137 MB at its peak
  on 16 MB of `apiapi…`; the window holds 16 MB, main 3 MB). All 96 rules qualify (95 patterns: bittrex's two share
  one).
- **A line allowlist's verdict once a line** (`Lines`): findings come in increasing order, so the line breaks are
  found by one forward walk and each line-targeted allowlist is tested once a line.

| Crafted, 256 KB (interleaved medians, 7 rounds) | reference | main | now |
|---|---:|---:|---:|
| keywords back to back (`tokentoken…`) | 308.0 ms | 344.4 ms | 15.5 ms |
| the longest prefix before each keyword | 63.0 ms | 61.9 ms | 1.7 ms |
| the longest prefix, no space | 102.4 ms | 101.5 ms | 1.4 ms |
| two-character anchors | 181.3 ms | 182.0 ms | 8.4 ms |
| keyword then an operator (`key=`) | 59.2 ms | 61.8 ms | 69.3 ms |
| prefix, keyword, operator, value | 15.6 ms | 9.8 ms | 9.1 ms |
| generic-api-key, matching | 19.3 ms | 19.4 ms | 17.0 ms |

`key=` stays where it was: every `key` is followed by an operator, so REST runs its secret part (`[\w.=-]{10,150}`,
greedy, then a terminator that never comes) at each one, about 0.65 µs an attempt in JavaScript's engine whether
sticky or scanning. It is linear, 0.25 µs a character.

The same 3,941-text sweep after the change: the worst text 19.5 ms at 64 KB (main: 3,603 ms), the whole sweep 7 s
(main: 48 s). A random hunt over 20,000 units of 1–4 pieces (the gate's literals, punctuation, marks, ligatures),
each timed at 16 KB and 128 KB, flagged nothing super-linear (no unit over 12x for 8x the text). One linear cost it
did show was in the prefilter: a text of ligatures (`ﬁ`) cost 0.4–0.5 µs a character, because each ligature's fold
was made afresh (`normalize` and a new string). `MultiMatcher` now memoises it (the primitive's own benchmark below).

At 16 MB (one process each, peak RSS growth over the call): `tokentoken…` 20.3 s → 0.76 s (13 → 17 MB), `apiapi…`
24.6 s → 1.1 s (3 → 16 MB), `key=…` 3.4 s → 3.3 s (41 → 46 MB).

### 2. Literal-dense input: 0.85–2.2x of the reference (D1841's review: 0.61–1.35x; after the review 1.02–1.97x, §10)

The residue was the prefilter's work per occurrence of a literal that some rule anchors on. Once a literal passes
the dense limit its occurrences are no longer kept, but each was still counted through a call. Now a literal past
the limit leaves the matcher's `keep` mask for the rest of the text (restored by the next `clear`), so the matcher
stops reporting it. Interleaved medians, 7 rounds, 1 MB, two runs (load 2–4):

| Unit repeated to 1 MB | reference | main | now | reference / now |
|---|---:|---:|---:|---:|
| `a3tzzzzzz ` | 4.4 / 7.0 ms | 3.8 / 4.3 ms | 3.6 / 4.9 ms | 1.20 / 1.42x |
| `sk-` | 6.3 / 8.2 ms | 9.7 / 11.3 ms | 7.5 / 8.5 ms | 0.85 / 0.97x |
| `<add key="zz ` | 25.5 / 20.8 ms | 20.9 / 18.6 ms | 20.2 / 18.7 ms | 1.26 / 1.11x |
| `gho_zzzzz ` | 34.0 / 52.4 ms | 28.4 / 57.6 ms | 35.0 / 45.5 ms | 0.97 / 1.15x |
| `akiazzzzz ` | 7.8 / 13.1 ms | 7.6 / 11.8 ms | 7.8 / 12.0 ms | 1.01 / 1.10x |
| `glpat-zzz ` | 6.1 / 9.5 ms | 7.2 / 9.4 ms | 6.4 / 9.5 ms | 0.96 / 1.00x |
| `xoxe-zzzz ` | 10.7 / 8.9 ms | 13.7 / 10.6 ms | 12.0 / 10.5 ms | 0.89 / 0.85x |
| `kind:zzzz ` | 21.3 / 26.5 ms | 11.3 / 15.6 ms | 10.2 / 14.0 ms | 2.10 / 1.90x |
| `eyzzzzzzz ` | 5.7 / 10.2 ms | 4.2 / 7.8 ms | 4.1 / 7.3 ms | 1.38 / 1.39x |

Not 1.0x everywhere: `xoxe-` (0.85–0.89x) and `sk-` (0.85–0.97x) stay under, within this VM's noise but the same
sign twice for `xoxe-`. A CPU profile puts 60% of such a call in the prefilter's loop and 20% in the structural
pass's token regex (which the reference runs too); the gap is the prefilter's larger automaton (the anchor literals
are extra patterns, so more positions emit) and about 10 ns an occurrence kept, up to the limit. Lowering the limit
to 1/64 halved the kept occurrences but moves the trade-off D1841's review measured (sticky tries against the scan)
for texts between the two densities, so it was not taken. Measured and not taken either: growing the lists four times
at a time (slower: zero-filling the larger arrays).

### 3. First-call cost: +20–40 ms over the reference → +2–5 ms

The first call parsed every rule's regex for its anchors. Now `generate.ts` works every analysis out ahead into
`src/rules.generated.json`, with the gitleaks config as JSON (which the gate imports instead of the TOML, so Node can
load it too); `generated.test.ts` regenerates it in memory and fails when the committed file differs (a gitleaks
update, an Eden regex or the analysis changed). The allowlist syntax check (`checkAllowlists`) moved there as well,
and the gate no longer imports @eden/primitives' index (whose module set cost about a third of the first call).

| Three processes each | import + rules + gate + first text |
|---|---|
| main | 63.2, 87.9, 77.6 ms (rule building 36–54 ms) |
| now | 44.1, 37.5, 34.7 ms (rule building 9–16 ms) |

`bench/gate-startup.bench.ts`, three processes each: the reference's first call 15.3–20.8 ms, now 20.0–23.0 ms (main,
the same bench at the start of the session: 43.1–58.1 ms); import 4.4–6.5 against 7.0–8.9 ms (the JSON is 155 KB
to parse); heap held once warm 2.03–2.05 against 2.57–2.58 MB.

### 4. The rules not anchored

D1841 left four gitleaks rules unanchored. The analysis now also takes a bounded group or alternation as part of the
prefix (`(?:https?://)?` is at most 8 characters of `[htps:/]`, `(?:^|[\s=:(,])` at most one), which anchors two:

- **azure-ad-client-secret** on `q~` (5 characters before it), **slack-webhook-url** on `hooks` (8 before it).
- **facebook-access-token** is not anchored: its only literal is one character, `|` or `%`, after 15–16 digits. A
  one-character literal in the prefilter would report every `%` of every URL-encoded text. It scans only when
  "facebook" occurs, at 0.11–0.52 ms a MB of the corpus.
- **sourcegraph-access-token** is not anchored: one alternative is a bare 40-hex string (no literal at all). It scans
  only when `sgp_` or "sourcegraph" occurs, at 0.77–4.25 ms a MB.

The other whole-text paths are hand-written walks, linear by construction: rule (d)'s long tokens, the AWS secret
key walk, the presigned-URL value walk; and a rule anchored on a literal past the dense limit scans the text (D1841),
which for those rules (a literal at the start of the regex) is JavaScript's own literal search.

### 5. Standalone packaging

- **No dependency.** `MultiMatcher` and its fold tables (`matcher.ts`, `charclass.ts`, and the test-only
  `matcher.reference.ts`) are vendored into `src/primitives/`, byte for byte; `generated.test.ts` fails when they
  differ from @eden/primitives' (skipped where the package stands alone). The package.json has no `dependencies`.
- **Node.** Imports carry their `.ts` extension, and the three parameter properties became plain fields, so Node 24
  (tested: 24.22.3, downloaded for this) strips the types and runs the sources with no flag and no build.
  `node --test packages/redact/src/node.check.ts`: 4 of 4 pass. `node-parity.test.ts` compares Node with Bun on 3,000
  fuzz texts and the crafted inputs in the suite; a wider run here, 20,000 fuzz texts and the corpus's 4,869 pieces
  (24,869 texts, 12,600 with a finding): 0 differences.
- **Node 22 refused.** The gitleaks rules use RegExp modifiers (`(?-i:[Aa]pi|API)`). Node 22.22 rejects them; with
  `--js-regexp-modifiers` it runs them wrongly (`/(?:(?-i:a)|b)/i.test("B")` is false: the modifier leaks into the
  rest of the alternation), and generic-api-key then missed `GITHUB_TOKEN=ghp_…`. `rulesWith` now tests the engine
  and throws a plain error instead of building a gate that would miss secrets; the parity test expects that error from
  a Node older than 24.
- **Tests alone.** A copy of `packages/redact` outside the repository, `bun install` (re2js only) and `bun test ./src`:
  201 pass, 3 skip (the primitives sync, the eval scenarios, the Node comparison with Node 22 on the PATH), 0 fail. The
  benchmarks and `gate-differential.ts --corpus` need the Eden repository (they read the sim worlds).

### 6. Three misses the comparison found, now caught

The planted set (Part 2) found three shapes the gate left in clear, all in the gate before D1841 as well:

-  "API key is &lt;32 random characters&gt;" and "Datadog API key is &lt;32 hex&gt;": no rule reads `api key` with a
  space.
- "bearer token is Bearer &lt;token&gt;": the keyword rule took `Bearer` as the value and redacted it alone, and the
  structural pass, which runs after it, no longer saw a bearer credential.
- An Azure storage connection string whose key starts with `/` or `+`: gitleaks has no rule for it and its generic
  rule needs the value to start alphanumeric.

Each is now an Eden rule of its own, run after main's pipeline (§7): `eden-api-key-phrase` and its legacy form (`api
key` with a space, then `is`, `=` or `:` and a value, with the keyword rule's value shapes), `eden-entropy-api-key`
(rule (d)'s long mixed token near `api key`), `eden-auth-scheme-value` (`bearer` or `basic` and the credential after it,
as the value of a secret word) and `eden-azure-storage-key` (`AccountKey=` and 86 base64 characters then `==`). Each
changes what the gate finds, so it is made in the reference too, in the same commit (CLAUDE.md), and the fuzz generates
all three shapes. Before these, the gate removed 466 of the 480 planted secrets (97.1%).

### 7. The review's blocking finding: a secret left in clear, and why every new rule now runs after main's

The first version (34a11308f) put the bearer fix inside the keyword rule (D13): its value could be `bearer` or `basic`
then the credential. The independent review of 2026-11-14 found that branch swallowing the next keyword:
`the token is Bearer secret is correcthorsebattery` matched `Bearer secret` as one value, the match ended there, and
`is correcthorsebattery` was no longer after a keyword: main redacted the passphrase, the branch stored it. Its five
failing inputs (`my token is Bearer pwd is swordfish99x`, `token is basic credential is 'correct horse battery'`,
a tab and `BASIC` in upper case, `auth token=Bearer  credential = "…`) are tests now (`secrets.test.ts`).

The fix: the keyword rule is main's again, character for character, in the gate and the reference; the scheme value
is `eden-auth-scheme-value`, with its own `matchAll` (flags `dgi`), prefilter (`bearer`, `basic`) and anchors. Adding
it as one more rule was not enough: any span added before the structural pass changes what that pass sees (a
sentinel where it expected a key, a value cut short), and the fuzz found texts where main's pass then removed more.
So `compose.ts` runs main's pipeline unchanged (main's rules' spans, the assignment pass's spans when any fired, the
structural pass on the gated text) and D1850's rules (`post: true`) add their spans afterwards, on a mask over the
input: main's removals traced back through the gating (`structuralMask` in redact.ts reports, per character of the
gated text, what each structural pass took) plus the post rules' spans, one sentinel a run. When neither the post
rules nor an excused value (§8) changes anything, main's output is returned as it is.

A permanent test now holds the gate to main: `never-less.test.ts` against a frozen copy of main's gate before D1850
(`secrets.baseline.ts`, `redact.baseline.ts`, which never move with the gate). On each text it checks that every
baseline span lies inside the gate's spans or ones it excused, that the gate's own account of main's pipeline equals the
frozen baseline's mask character for character, that the stored text is the gate's mask rendered, and that every
character main removed and the gate keeps belongs to an excused value that `notSecret` or `placeholderToken` accepts.
Texts: the gate's fuzz (`gateText`) and chains of keywords (`chainText`: secret words, `is`/`=`/`:`, schemes, quotes,
tabs and upper case in random order, the review's shape); in the suite 4,000 of them, the crafted inputs at 16 KB and
the review's inputs; as a command (`bun packages/redact/src/never-less.ts N seed`) 200,000 texts on two seeds (7 and
20261114) and the review's own fuzz (20,000 texts), no failure.

API key with a space (the review's low finding): main's keyword rule takes `api[_-]?key`, so "the API key is
hunter2xyz" was left by the keyword rule and caught only at 32 characters by rule (d). `eden-api-key-phrase` takes
it with the keyword rule's value shapes, so a short API key after `API key is` is caught too (a test).

### 8. False positives on code: values that cannot be a secret

The comparison's loss (Part 2) was the keyword rule on code and docs: `maxTokens: 2_000`, `apiKey: string;`,
`token = this.options.token`, `${API_KEY}`. `not-secret.ts` names shapes no secret is written in, each with a test
that the nearest real secret of its shape is still caught (`not-secret.test.ts`):

| Shape left in place | Still redacted (the test beside it) |
|---|---|
| a TypeScript type, generic or typed array (`string`, `Set<number>`, `Uint8Array`) | `str1ngPass`, `Set<x>9Kq2`, `Uint8Array77x` |
| a member chain on a known receiver (`process.env.X`, `this.options.apiKey`, `res.usage.inputTokens`) | `processenv9Kq`, `"dragon.fire99"`, `res9.usage.x` |
| a reference: `${X`, `$(…`, `$UPPER_WITH_UNDERSCORE`, `%X%`, `{{`, `<your-key>` | `${hunter22`, `$ALES2024`, `$xKq2pd8sZ`, `<9Kq2pd8sZ>` |
| digits grouped as code groups them (`2_000`) | `200048` |
| a mask (`xxxxxxxx`, `****`, `hf_xxxx…`) | `xxxxKq2p` |
| one character 16+ times to the end (`AIzaaaa…`, `AKIAXXXX…`) | `aaaaaaaaaaaaaaaHunter2` |

Not excused, on purpose: a plain word (`password is sunshine` is a real, weak password), a short value, a digit run
(a PIN), a call, upper case, `changeme`, and any value with a space or a quote inside. A value is excused only as a
whole (its trailing `,;):]}` and one pair of quotes aside), and at most 512 characters. Every check is linear (a
regex for a run backtracked quadratically on `=`, a trailing-punctuation regex on `)))…`; both are loops now).

The excused values are taken back after main's pipeline (§7), not before it: dropping a span before the gating
changed what the passes saw beside it. On the benign corpus (13.6 MB, 5,609 files after the merge of origin/main)
and gitleaks' 357 false-positive examples, the frozen main against now:

| | main before D1850 | the first version (34a11308f) | now |
|---|---:|---:|---:|
| rule findings on the benign corpus | 266 | 273 | 177 |
| …of them eden-keyword | 222 | | 132 |
| sentinels in the stored benign corpus | 435 | | 313 |
| …in source code (155 files) | 239 | | 121 |
| gitleaks' false-positive examples flagged | 93 (26.1%) | 94 (26.3%) | 80 (22.4%) |
| planted secrets removed | 466 / 480 | 480 / 480 | 480 / 480 |
| gitleaks' true-positive examples flagged | 6,040 | 6,040 | 6,040 |
| sim worlds' planted secrets | 12 / 12 | 12 / 12 | 12 / 12 |

No secret is lost for it: the planted set, gitleaks' true positives and the sim worlds are all still found, and
never-less (§7) checks every character the gate keeps that main removed. What remains is mostly prose that names a
password (docs explaining the keyword rule itself) and gitleaks' examples that are placeholders in a shape this
gate cannot tell from a key (`sk-ant-api03-abc123xyz…`), which the brief's rule (a missed secret is worse than a false
redaction) leaves redacted.

### 9. The crafted worst cases, after the review

The review measured the first version at 221 ms a megabyte of `key=` against secretlint's 7–23 ms on every crafted
input, and asked for within about 2x of secretlint with every rule kept. What dominated, and what changed:

- **generic-api-key's REST read by hand** (`generic-rest.ts`). On `key=…` and the line of findings JavaScript's
  engine spent about 0.2 µs a character backtracking the secret part `[\w.=-]{10,150}` from 150 down at every
  operator. The reader decides each candidate by the length of one run (only the whole run of `[\w.=-]` can be
  followed by the terminator, and only when 10 to 150 long; likewise the second branch), reads each run once a text,
  and tries the operators and the quote run in the regex's own order. `generic-rest.test.ts` compares it with the
  sticky regex at every position of 4,000 seeded texts built from the regex's boundaries (1,387 matches; four
  planted faults, an off-by-one in the run limit, the colons, the quotes and the `=` count, each fail it).
- **The occurrence finder by hand** (`compileFinder`): the empty-match lookahead regex cost 50 ms a megabyte of
  `<add key="zz `.
- **Lazy-only literals stream sooner.** A literal only lazy-prefix rules anchor on (`key`, `token`…) keeps a list of
  at most length/256 + 64 occurrences (`Occurrences.small`); past it those rules find occurrences themselves, a
  window at a time, instead of the prefilter filling a list no rule then read.
- **The dense limit 1/128, not 1/32**: keeping 32,000 occurrences a megabyte of `sk-` cost more than the rules' scans
  saved; a literal every 64 characters ran as fast either way (interleaved, three gates).
- **Exec loops instead of `[...text.matchAll()]`** for Eden's regex rules (a third of the gate's time on a megabyte
  of findings), and last-value memos where findings repeat a value (`notSecret`, an allowlist's verdict, the entropy).

CPU ms at 1 MB, median of 5 after a warm call, two runs (low–high), load 15–18 (another agent's work beside it); "first
version" is the review's (wall time, one run, load 2–8); secretlint's is from Part 2:

| Crafted input, 1 MB | first version, Bun | now, Bun | now, Node 24 | secretlint | now / secretlint (Bun) |
|---|---:|---:|---:|---:|---:|
| keyword then an operator | 221 ms | 37–50 ms | 38–50 ms | 8.5 ms | 4.4–5.9x |
| keywords back to back | 62 ms | 22–34 ms | 39–54 ms | 21 ms | 1.0–1.6x |
| the longest prefix before each keyword | 7.7 ms | 9.3–10 ms | 13–15 ms | 14 ms | 0.7–0.7x |
| the longest prefix, no space | 8.9 ms | 8.5–11 ms | 14–14 ms | 13 ms | 0.7–0.8x |
| prefix, keyword, operator, value | 55 ms | 64–67 ms | 58–64 ms | 15 ms | 4.3–4.5x |
| combining marks inside a keyword | 26 ms | 6.7–8.1 ms | 15–18 ms | 9.6 ms | 0.7–0.8x |
| marks before a keyword | 19 ms | 17–27 ms | 25–27 ms | 7.6 ms | 2.3–3.5x |
| ligatures beside a keyword | 29 ms | 17–27 ms | 30–31 ms | 7.2 ms | 2.3–3.7x |
| two-character anchors | 34 ms | 21–23 ms | 31–35 ms | 23 ms | 0.9–1.0x |
| one non-space run after a keyword | 11 ms | 9.0–12 ms | 19–21 ms | 7.2 ms | 1.3–1.7x |
| separators | 7.3 ms | 9.1–11 ms | 10.0–14 ms | 19 ms | 0.5–0.6x |
| quoted values | 129 ms | 98–152 ms | 172–181 ms | 17 ms | 5.8–8.9x |
| eden-keyword | 112 ms | 78–82 ms | 103–137 ms | 14 ms | 5.6–5.9x |
| url userinfo | 10 ms | 8.9–9.9 ms | 26–26 ms | 10 ms | 0.9–1.0x |
| token literals | 51 ms | 42–57 ms | 61–69 ms | 14 ms | 3.0–4.1x |
| generic-api-key, matching | 122 ms | 47–51 ms | 63–70 ms | 8.9 ms | 5.3–5.8x |
| findings on one long line | 219 ms | 93–145 ms | 137–141 ms | 10 ms | 9.3–14.5x |
| ligatures | 11 ms | 9.8–17 ms | 21–28 ms | 9.0 ms | 1.1–1.9x |
| password: then spaces | 53 ms | 25–36 ms | 30–34 ms | 12 ms | 2.1–3.0x |
| digits and spaces (PII patterns) | 4.1 ms | 2.5–4.1 ms | 4.3–6.5 ms | 7.3 ms | 0.3–0.6x |
| one long word line | 4.1 ms | 2.8–3.9 ms | 5.5–5.7 ms | 11 ms | 0.3–0.4x |
| slashes and colons | 11 ms | 11–15 ms | 11–14 ms | 12 ms | 0.9–1.2x |
| aws-ish base64 | 14 ms | 8.4–12 ms | 16–18 ms | 6.7 ms | 1.3–1.8x |
| high-entropy hex | 2.7 ms | 2.4–4.1 ms | 4.2–5.7 ms | 11 ms | 0.2–0.4x |

Within 2x of secretlint (or faster) on 14 of the 24 (the first version: 11). Over on 10: three at 2.1–3.7x (`password:
then spaces`, marks and ligatures beside a keyword: the prefilter's fold and Eden's entropy rule on every keyword), and
seven at 3–15x. What remains on those is not a backtracking regex: each holds a finding every 10–20 characters
(50,000–100,000 a megabyte), and every finding costs its rule's match, the allowlists (generic-api-key's line allowlists
read a 1 MB line through the DFA once each, 5 regexes), the gating, the structural pass over the gated text, and Eden's
own keyword rules (`eden-keyword`, its legacy form, the entropy rule) that fire on the same text. secretlint's 27
provider rules find nothing in these texts, so it does none of that. Every one stays linear (`gate-linear.test.ts`,
`node-linear.test.ts`).

### 10. Literal-dense input after the review, and Node

`sk-` and `xoxe-` were at 0.85–0.97x of the reference. A profile put most of `sk-…` in the prefilter calling `emit`
at every occurrence of a literal that was already hit and no longer kept. `MultiMatcher.scan` now marks such a state
quiet for the rest of the scan (a byte per transition row, stamped with the scan's generation), and the dense limit
moved (§9). Interleaved CPU medians, 9 rounds, 1 MB, three runs, reference / now (load 12–17); every unit at
1.02x or more in every run:

| Unit repeated to 1 MB | run 1 | run 2 | run 3 |
|---|---:|---:|---:|
| `a3tzzzzzz ` | 1.76x | 1.68x | 1.74x |
| `sk-` | 1.67x | 1.71x | 1.77x |
| `<add key="zz ` | 1.02x | 1.07x | 1.28x |
| `gho_zzzzz ` | 1.29x | 1.41x | 1.53x |
| `akiazzzzz ` | 1.43x | 1.26x | 1.40x |
| `glpat-zzz ` | 1.36x | 1.42x | 1.48x |
| `xoxe-zzzz ` | 1.19x | 1.19x | 1.23x |
| `kind:zzzz ` | 1.65x | 1.42x | 1.84x |
| `eyzzzzzzz ` | 1.97x | 1.77x | 1.74x |

The primitive, its scan before and after, interleaved, gitleaks' 244 keywords, CPU µs a call, median of 31: ordinary
text 0.93–1.04x (2 KB and 64 KB of the corpus, every occurrence kept or none; within the noise), 1 MB of `sk-` with
nothing kept 5,422 → 2,472 µs, 1 MB of `xoxe-zzzz ` 5,295 → 3,139 µs.

**Node.** Profiled on V8 (Node 24.22.3, downloaded for this into its own directory, deleted after), the gate's own
code had one V8-only fault: the first quiet-state version reset its list after the scan's loop, and V8 compiles that
loop on stack replacement before the code after it has ever run, so the scan deoptimized at the end of every call
(183 deopts in 61 calls); a generation stamp needs no code after the loop. Otherwise V8 runs the same code 1.0–2.5x
slower than JavaScriptCore (above; `one long word line`, the prefilter alone, 3 against 4 ms), most in
character-at-a-time loops (the prefilter, the hand-read prefixes). `node-linear.test.ts` now holds every crafted
input at 256 KB under the same 1.5 s CPU ceiling on Node 24+ (`REDACT_NODE`, skipped without one): the slowest took
55 ms. `node-parity.test.ts` with Node 24: 0 differences.

## Exactness and gates

After the review:

- `gate-differential.ts 250000 <seed>`, seeds 101–404 at once: 1,000,000 texts, 708,782 with a finding (the fuzz now
  generates the keyword chains and the three new shapes), no difference against the reference; `--corpus` (4,925
  texts): none. Run on the tree before the last speed change and again after it (the lazy-only literals' limit), both
  clean (314–339 s a shard on a loaded VM).
- `never-less.ts`: 100,000 texts on seed 7 after the last code change, 100,000 on 20261114 and 100,000 on 7 before
  it, and the review's 20,000: no failure.
- `generic-rest.test.ts`: the hand-read REST against the sticky regex at every position (4,000 texts, 1,387
  matches); four planted faults each fail it.
-  `bun test ./packages/redact ./packages/primitives` in one process: 495 pass, 2 skip (the two Node 24 tests, Node 22
  on the PATH), 0 fail; with `REDACT_NODE` at Node 24, 496 pass and 1 skip (the Node 22 refusal test). With
  `REDACT_NODE` at Node 24.22.3: `node-parity.test.ts` and `node-linear.test.ts` pass; `node --test
  packages/redact/src/node.check.ts` 4 of 4.
- `bun run eval`: precision 0.65, recall 0.52, falseFireRate 0; packets on 19 of 28 neutral turns (1.18 items each),
  facts handed 10 of 11, a look-alike on 3 of 10 owed turns: main's numbers.
- `bun run funnel` on origin/main's redact and primitives (60712533a), then this tree with `--baseline`: hidden
  323/384, decoys 294/384 both, "hidden +0 −0, decoys +0 −0".
- `CHECK_COLD=1 FORMAT_COLD=1 bun run check` (OPENROUTER_API_KEY unset): passed in 82 s (2,803 pass and 2 skip in
  282 files, and 501 in the 30-file tail).
- Typical text, `bench/gate.bench.ts` (the reference against now, interleaved): 1.4–3.0x at 256 B, 2.5–5.2x at 2 KB,
  3.3–15x at 16 KB, 2.7–11x at 1 MB; not compared with main again (the first version: 0.80–1.56x a cell against main,
  median 1.02x).

The first version's:

- `bun packages/redact/src/gate-differential.ts 250000 <seed>`, seeds 101, 202, 303, 404 at once: 1,000,000 texts,
  623,406 with a finding, no difference in rule ids, spans, stored text or `redact` (153–159 s a shard). The corpus
  (`--corpus`, 4,925 texts, 256 B to 1 MB): no difference. Both again on the final commit (after the occurrence
  window, the last code change): no difference (101–103 s a shard).
- `gate-differential.test.ts`: every one of the 96 lazy-prefix rules against `matchAll` on 61 texts each (samples of
  its own regex, its keywords, prefix and operator characters), with the prefilter's occurrences, without them, and
  dense past the limit (1,200 keywords, so the window moves); the JavaScript prefix table on all 65,536 code units,
  case folded and not; the top-level split; a literal leaving and re-entering `keep`; the committed analyses equal to
  those worked out now. Planted faults caught: the start's floor taken without the scan's position (the test fails),
  the window's shift not applied (the test hangs). Preferring the later of two keywords with the same start was not
  caught, and is not a fault: both reach the same operator, so the match is the same.
- `env -u OPENROUTER_API_KEY CHECK_COLD=1 FORMAT_COLD=1 bun run check`: passed in 88 s (2,767 tests in 277 files, 1
  skipped, and 482 in the 28-file tail); `bun test ./packages/redact ./packages/primitives` in one process: 469 pass,
  1 skip (the Node comparison, Node 22 on the PATH; with `REDACT_NODE` at Node 24 it passes).
-  `bun run eval` (final tree): precision 0.65, recall 0.52, falseFireRate 0; acting: packets on 19 of 28 neutral turns
  (1.18 items each), facts handed 10 of 11, a look-alike handed on 3 of 10 owed turns: main's numbers.
-  `bun run funnel` on origin/main's redact and primitives, then this branch (and its final tree) with `--baseline`:
  hidden 323/384, decoys 294/384 both, "hidden +0 −0, decoys +0 −0".

Typical text did not move: the corpus at 2 KB, 16 KB and 1 MB, main against now, interleaved medians: 0.80–1.56x a
cell, the 21 cells' median 1.02x (each kind within the VM's noise; at 2 KB code 0.80x and mail 1.56x).

The primitive (`MultiMatcher`, a ligature's fold memoised), main's copy against this one, interleaved, the gate's
words:

| Text | scan, main | scan, now | markHits, main | markHits, now |
|---|---:|---:|---:|---:|
| mail 2 KB | 7.8 µs | 7.9 µs | 15.5 µs | 14.0 µs |
| mail 16 KB | 48.1 µs | 46.3 µs | 85.9 µs | 82.4 µs |
| code 16 KB | 45.4 µs | 45.2 µs | 86.3 µs | 85.8 µs |
| 2 KB, 10% ligatures | 78.3 µs | 9.0 µs | 100.6 µs | 46.1 µs |
| 64 KB of ligatures | 22,426 µs | 660 µs | 21,351 µs | 1,057 µs |

`bun packages/primitives/bench/matcher.bench.ts` on this branch: markHits p50 2.51 µs (256 B), 5.95 µs (2 KB),
45.71 µs (16 KB), as redact-perf.md's branch runs (5.84–9.28 and 44.4–47.3 µs).

## Part 2: against the alternatives

### Tools and setup

| Tool | Version | How it ran | Configuration |
|---|---|---|---|
| this gate | this branch | in process (Bun 1.4.4, Node 24.22.3) and as a one-file command | as shipped (`sanitizeForStore`; findings from `gateOf(...).findings`) |
| gitleaks | 8.30.1, release binary | `gitleaks dir <path> --report-format json` | built-in default rules (the same rules this gate vendors) |
| trufflehog | 3.99.9, release binary | `trufflehog filesystem <path> --no-verification --json --no-update` | every detector, verification off |
| detect-secrets | 1.5.0, pip | in process (`SecretsCollection.scan_file` under `default_settings`) and `detect-secrets scan --all-files` | every plugin, the default filters |
| secretlint | 13.1.0 | in process (`@secretlint/core` `lintSource`) and its CLI | `@secretlint/secretlint-rule-preset-recommend` |
| redact-pii | 3.4.0, npm | in process (`SyncRedactor().redact`) | its defaults (every built-in) |

Each tool sat in its own new directory; npm installs ran with scripts off, Python with `-I`, nothing ran from inside
a tool's directory, and every process had its HTTP(S) proxy pointed at a dead port, so nothing left the machine (the
Go binaries' checksums were checked against their releases'). redact-pii is a PII redactor, not a secret scanner, and
npm marks 3.4.0 deprecated; it is here as the popular in-process JavaScript redactor the brief asked for. secretlint
is the in-process JavaScript secret linter.

### Inputs

- **gitleaks' own examples.** The true and false positives every gitleaks rule validates against, read out of its
  v8.30.1 Go sources (`cmd/generate/config/rules`, a sparse clone; nothing in it was run) by a small evaluator of the
  expressions they use (string literals, `+`, slices and maps, `append`, `GenerateSampleSecrets`'s 26 templates,
  `secrets.NewSecret(regex)` sampled with the gate's regex sampler): 6,040 true positives over 216 rules with a regex
  and 357 false positives (35 expressions it could not evaluate were skipped). The sampler is not gitleaks' `regen`:
  a few samples are not what gitleaks' own test would generate (square-secret's class `[\\-_]` sampled a backslash),
  which is why gitleaks itself finds 99.7%, not 100%.
- **Planted real-format secrets.** 32 kinds (AWS key ids and secret keys, GitHub classic and fine-grained, GitLab,
  Slack bot tokens and webhooks, Stripe, OpenAI project keys, Anthropic, Google API keys, npm, PyPI, SendGrid, Twilio,
  Mailgun, Discord webhooks, Telegram bot tokens, JWTs, PEM private keys, Postgres URLs, a password in prose, a
  generic `api_key`, Azure storage connection strings, Shopify, Hugging Face, DigitalOcean, New Relic, an S3 presigned
  URL's signature, Datadog, a bearer header, a basic-auth header), each random in its real alphabet and length, in 5
  contexts (a mail, a chat line, code, a log line, a JSON object), 3 variants: 480 texts, one secret each.
- **The sim worlds' planted secrets** (seeds 41–43): 12 items. This gate was built against these; it is its home
  ground.
- **Benign text**, 13.5 MB in 5,607 files: the sim worlds' 4,460 items without a planted secret (4.5 MB), the eval
  scenarios' texts (729), the repository's non-test TypeScript outside `packages/redact` (155 files, 2.4 MB) and its
  `docs/` and `docs/research/` prose (263 files, 6.0 MB).
- **Throughput:** every corpus kind (`bench/corpus.ts`) cut to an equal share and joined: 2 KB, 16 KB, 1 MB.
- **Crafted (ReDoS):** the gate's own crafted units (`gate-crafted.ts`) and six aimed at other engines' patterns
  (PII-style digit runs, `password: ` then spaces, one long word, `a://b/`, an AWS-like base64 run, hex), 1 MB each.

A labelled secret counts as found when a finding covers it: an overlapping span (this gate, secretlint), a reported
value that contains it or that it contains with 8+ characters (gitleaks, trufflehog, detect-secrets; for
detect-secrets also a finding on its line), or, for a redactor, its absence from the output. A gitleaks example whose
secret the evaluator does not know counts as found on any finding.

### Recall

| | this gate | gitleaks | trufflehog | detect-secrets | secretlint | redact-pii |
|---|---:|---:|---:|---:|---:|---:|
| planted, 480: removed (this gate: `sanitizeForStore`) or flagged | **480 (100%)** | 352 (73.3%) | 283 (59.0%) | 308 (64.2%) | 198 (41.3%) | 104 (21.7%) |
| planted, by a rule's span (no structural pass) | 456 (95.0%) | | | | | |
| gitleaks' 6,040 true positives | 6,040 (100%) | 6,021 (99.7%) | 1,481 (24.5%) | 2,932 (48.5%) | 752 (12.5%) | 716 (11.9%) |
| of 216 rules, every example found | 216 | 212 | 50 | 31 | 26 | 24 |
| sim worlds' 12 planted secrets | 12 | 9 | 9 | 9 | 6 | 3 |

By kind (15 each: 5 contexts × 3 variants):

| Kind | this gate (removed) | this gate (a rule's span) | gitleaks | trufflehog | detect-secrets | secretlint | redact-pii |
|---|---:|---:|---:|---:|---:|---:|---:|
| aws-access-key-id | 15 | 15 | 15 | 0 | 15 | 0 | 0 |
| aws-secret-access-key | 15 | 15 | 9 | 15 | 15 | 8 | 3 |
| github-pat | 15 | 15 | 15 | 15 | 15 | 15 | 0 |
| github-fine-grained | 15 | 15 | 15 | 15 | 6 | 15 | 0 |
| gitlab-pat | 15 | 15 | 15 | 15 | 15 | 15 | 0 |
| slack-bot-token | 15 | 15 | 15 | 15 | 15 | 15 | 15 |
| slack-webhook | 15 | 15 | 15 | 15 | 15 | 15 | 15 |
| stripe-live-key | 15 | 15 | 15 | 15 | 15 | 15 | 0 |
| openai-key | 15 | 15 | 15 | 15 | 8 | 15 | 0 |
| anthropic-key | 15 | 15 | 15 | 15 | 6 | 15 | 0 |
| google-api-key | 15 | 15 | 15 | 0 | 6 | 0 | 0 |
| npm-token | 15 | 15 | 15 | 14 | 6 | 15 | 0 |
| pypi-token | 15 | 15 | 15 | 0 | 15 | 0 | 0 |
| sendgrid-key | 15 | 15 | 15 | 14 | 15 | 10 | 0 |
| twilio-api-key | 15 | 15 | 15 | 0 | 15 | 0 | 2 |
| mailgun-key | 15 | 15 | 9 | 15 | 6 | 0 | 1 |
| discord-webhook | 15 | 15 | 0 | 0 | 0 | 0 | 15 |
| telegram-bot-token | 15 | 15 | 12 | 15 | 15 | 0 | 15 |
| jwt | 15 | 15 | 15 | 0 | 15 | 0 | 0 |
| private-key | 15 | 15 | 15 | 0 | 15 | 0 | 3 |
| postgres-url | 15 | 15 | 0 | 15 | 15 | 15 | 15 |
| prose-password | 15 | 15 | 0 | 0 | 6 | 0 | 0 |
| generic-api-key | 15 | 15 | 9 | 0 | 6 | 0 | 0 |
| azure-storage-key | 15 | 15 | 14 | 15 | 15 | 0 | 0 |
| shopify-token | 15 | 15 | 15 | 0 | 0 | 15 | 2 |
| huggingface-token | 15 | 15 | 15 | 15 | 6 | 15 | 0 |
| digitalocean-pat | 15 | 15 | 15 | 15 | 0 | 0 | 2 |
| newrelic-key | 15 | 15 | 9 | 15 | 6 | 0 | 0 |
| s3-presigned-signature | 15 | 15 | 0 | 0 | 15 | 0 | 15 |
| datadog-api-key | 15 | 15 | 5 | 15 | 6 | 0 | 1 |
| bearer-token | 15 | 3 | 0 | 0 | 0 | 0 | 0 |
| basic-auth | 15 | 3 | 0 | 0 | 0 | 0 | 0 |

By context (96 each): this gate 96 in every context; gitleaks 60 mail, 62 chat, 77 code, 76 logs, 77 JSON;
trufflehog 56–57 in each; detect-secrets 81 in code and JSON, 48–49 in mail, chat and logs; secretlint 37–42;
redact-pii 18–23. The scanners built for repositories lose most in prose (mail, chat), where a key sits after "is" or
a colon rather than in an assignment.

How fair this is: **the planted set is this session's, and three of the gate's rules were added after it found them
missing** (Part 1, §6); before those the gate removed 97.1% (466) and its rules' spans covered 92.1% (442), still
first. The trufflehog numbers are without verification, its intended mode being to verify each candidate against
the provider (off here by the brief); its detectors also demand context the planted texts lack for some kinds (an
AWS key id alone, a Google key, a JWT). gitleaks' own examples are its home ground as the sim worlds are this gate's;
this gate runs gitleaks' rules, so 100% there means its port is faithful, not that it is better.

### False positives

| | this gate | gitleaks | trufflehog | detect-secrets | secretlint | redact-pii |
|---|---:|---:|---:|---:|---:|---:|
| gitleaks' 357 false-positive examples flagged | 80 (22.4%); first version 94 (26.3%) | 22 (6.2%) | 26 (7.3%) | 80 (22.4%) | 26 (7.3%) | 86 (24.1%) |
| findings on the benign corpus | 177 (13.6 MB, 5,609 files); first version 250 (13.5 MB) | 4 | 1 | 11 | 1 | 4,987 (texts changed) |
| …in the sim worlds' 4,460 items | 0 | 0 | 0 | 0 | 0 | 4,278 |
| …in the eval scenarios' 729 texts | 2 files | 0 | 1 file | 1 file | 1 file | 321 |
| …in the source files | 23 files (first version 32) | 0 | 0 | 3 files | 0 | 125 |
| …in the docs files | 45 files (first version 43) | 2 files | 0 | 4 files | 0 | 263 |

The other tools ran on the corpus before the merge of origin/main (13.5 MB, 5,607 files) and were not run again; this
gate's numbers are on the corpus after it (13.6 MB, 5,609 files), on which main before D1850 makes 266 findings and the
first version 273. This is where the gate loses, less than it did (§8). Its keyword rule (D13: a password, token, secret
or API key after `is`, `=` or `:`, whatever its entropy) fired on placeholders (`key = AKIAXXXXXXXXXXXXXXXX`, `apiKey:
"AIzaaaa…"`) and on code (`maxTokens: 2_000`, `apiKey: string`); those shapes are left now (§8), and what remains is a
value that could be a password (`const token = find(...)`, prose naming one) or a placeholder no rule can tell from a
key (gitleaks' example Anthropic keys `sk-ant-api03-abc123xyz…`): 132 of the 177 benign findings are `eden-keyword`.
That is the trade D13 chose for text bound for storage or a model, where a leaked secret costs more than a redacted
word, and on the product's own kind of text (the sim worlds' mail, chat and documents) it flagged nothing; the two eval
texts it flagged hold a wifi password and a database URL with a password. As a scanner over a source repository it would
be noisy. redact-pii changes almost every text (names, digits, dates, URLs: its PII built-ins), so its "recall" is
mostly collateral.

### Throughput

In process, the tool already loaded and warmed, a fresh string each call, median ms a call (one run, load 2–8):

| Text | this gate, Bun | this gate, Node 24 | secretlint (Node) | redact-pii (Node) | detect-secrets (Python) |
|---|---:|---:|---:|---:|---:|
| 2 KB | 0.018 | 0.036 | 0.159 | 0.270 | 10.4 |
| 16 KB | 0.313 | 0.495 | 0.508 | 2.35 | 87.3 |
| 1 MB | 21.0 | 42.6 | 21.2 | 228 | 5,964 |

gitleaks and trufflehog have no in-process API for a JavaScript or Python caller. As one command per file, startup
included, median of 5 runs (wall), and the process's peak RSS:

| File | this gate, Bun | this gate, Node 24 | gitleaks | trufflehog | detect-secrets | secretlint |
|---|---:|---:|---:|---:|---:|---:|
| 2 KB | 80 ms, 52 MB | 160 ms, 93 MB | 528 ms, 62 MB | 2,366 ms, 209 MB | 192 ms, 31 MB | 281 ms, 79 MB |
| 16 KB | 73 ms, 53 MB | 159 ms, 94 MB | 575 ms, 62 MB | 2,329 ms, 210 MB | 323 ms, 32 MB | 272 ms, 80 MB |
| 1 MB | 178 ms, 71 MB | 393 ms, 106 MB | 697 ms, 63 MB | 2,508 ms, 229 MB | 6,681 ms, 37 MB | 334 ms, 89 MB |

Where the gate loses: secretlint matches it in process at 1 MB (21.2 against 21.0 ms) and beats it on Node there (42.6);
its recommended preset is 27 provider rules (and a comment filter) against this gate's 230-odd. detect-secrets holds the
least memory as a command. On Node the gate is about half as fast as on Bun (V8 against JavaScriptCore on these
regexes).

### Crafted input (ReDoS)

Each crafted input at 1 MB, once per tool: in process (the tool loaded and warmed, median of at least 3 calls) and as
a command (one run, startup included), each under a 30 s limit (`>30 s`: killed). One run, load 2–8. These are the
first version's numbers for this gate; after the review its in-process times are in §9 (Bun and Node), and the
command column was not run again.

| Crafted input, 1 MB | this gate, Bun | this gate, Node | secretlint | redact-pii | detect-secrets | this gate, Bun (command) | gitleaks (command) | trufflehog (command) | detect-secrets (command) | secretlint (command) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| keyword then an operator | 221 ms | 280 ms | 8.5 ms | >30 s | 3.2 s | 358 ms | 568 ms | 2.7 s | 4.1 s | 456 ms |
| keywords back to back | 62 ms | 60 ms | 21 ms | >30 s | 1.5 s | 191 ms | 984 ms | 2.9 s | 2.1 s | 397 ms |
| the longest prefix before each keyword | 7.7 ms | 18 ms | 14 ms | 286 ms | 1.4 s | 182 ms | 860 ms | 2.6 s | 1.7 s | 364 ms |
| the longest prefix, no space | 8.9 ms | 16 ms | 13 ms | >30 s | 1.4 s | 246 ms | 1.2 s | 3.2 s | 1.9 s | 368 ms |
| prefix, keyword, operator, value | 55 ms | 79 ms | 15 ms | 330 ms | 2.8 s | 211 ms | 1.5 s | 3.1 s | 3.6 s | 284 ms |
| combining marks inside a keyword | 26 ms | 37 ms | 9.6 ms | 67 ms | 2.0 s | 168 ms | 520 ms | 2.9 s | 2.3 s | 370 ms |
| marks before a keyword | 19 ms | 47 ms | 7.6 ms | 89 ms | 2.1 s | 259 ms | 562 ms | 2.5 s | 2.2 s | 379 ms |
| ligatures beside a keyword | 29 ms | 44 ms | 7.2 ms | 52 ms | 1.7 s | 160 ms | 903 ms | 2.7 s | 1.9 s | 307 ms |
| two-character anchors | 34 ms | 45 ms | 23 ms | >30 s | 1.8 s | 135 ms | 759 ms | 2.9 s | 2.2 s | 282 ms |
| one non-space run after a keyword | 11 ms | 27 ms | 7.2 ms | >30 s | 1.4 s | 151 ms | 1.0 s | 3.0 s | 1.8 s | 286 ms |
| separators | 7.3 ms | 16 ms | 19 ms | 83 ms | 3.0 s | 79 ms | 570 ms | 3.0 s | 4.6 s | 298 ms |
| quoted values | 129 ms | 159 ms | 17 ms | 65 ms | 3.4 s | 330 ms | 627 ms | 3.1 s | 4.7 s | 254 ms |
| eden-keyword | 112 ms | 141 ms | 14 ms | 88 ms | 1.6 s | 231 ms | 630 ms | 2.4 s | 2.0 s | 346 ms |
| url userinfo | 10 ms | 29 ms | 10 ms | 27 ms | >30 s | 123 ms | 521 ms | 2.5 s | >30 s | 237 ms |
| token literals | 51 ms | 64 ms | 14 ms | 95 ms | 1.6 s | 118 ms | 656 ms | 2.4 s | 1.9 s | 309 ms |
| generic-api-key, matching | 122 ms | 195 ms | 8.9 ms | 157 ms | 1.4 s | 233 ms | 1.4 s | 2.4 s | 1.8 s | 293 ms |
| findings on one long line | 219 ms | 269 ms | 10 ms | >30 s | 3.3 s | 369 ms | 17.0 s | 2.7 s | 5.2 s | 301 ms |
| ligatures | 11 ms | 36 ms | 9.0 ms | >30 s | 1.6 s | 84 ms | 682 ms | 2.6 s | 1.7 s | 283 ms |
| password: then spaces | 53 ms | 58 ms | 12 ms | 51 ms | 5.0 s | 134 ms | 636 ms | 2.7 s | 7.2 s | 304 ms |
| digits and spaces (PII patterns) | 4.1 ms | 9.3 ms | 7.3 ms | 115 ms | 1.7 s | 113 ms | 727 ms | 2.7 s | 1.8 s | 255 ms |
| one long word line | 4.1 ms | 4.8 ms | 11 ms | >30 s | 1.6 s | 91 ms | 1.2 s | 2.6 s | 1.6 s | 251 ms |
| slashes and colons | 11 ms | 29 ms | 12 ms | 28 ms | >30 s | 96 ms | 647 ms | 2.4 s | >30 s | 250 ms |
| aws-ish base64 | 14 ms | 36 ms | 6.7 ms | 255 ms | 1.3 s | 91 ms | 957 ms | 2.6 s | >30 s | 300 ms |
| high-entropy hex | 2.7 ms | 5.8 ms | 11 ms | >30 s | 1.5 s | 92 ms | 1.1 s | 2.4 s | 1.6 s | 308 ms |

No input took this gate past 0.23 s in process (0.28 s on Node) or 0.37 s as a command: its worst are `key=` repeated
and a line of findings, both linear. Where it loses: **secretlint is faster on every crafted input** (7–23 ms in
process: few rules, each a provider prefix), and this gate was 3–26x slower than it on the keyword-assignment inputs;
after the review, at most 0.15 s in process and within 2x of secretlint on 14 of the 24, 3–15x on the inputs dense in
findings (§9). gitleaks (Go's RE2, linear by construction) took 17.0 s on the same line of findings this gate was
quadratic on (`bedrock-api-key-='`); why was not investigated. trufflehog's cost is its 2.4–3.2 s start. **redact-pii
did not finish 9 of the 24 inputs in 30 s**, and **detect-secrets 2 in process and 3 as a command** (1 MB of `a-b://`
and of `a://b/` both ways; the AWS-like base64 run only as a command, 1.3 s in process).

### Memory

Per command, the peak RSS on the 1 MB file is in the table above; the most over the 24 crafted inputs: this gate 110 MB
on Bun and 172 MB on Node, gitleaks 182 MB, trufflehog 229 MB, detect-secrets 187 MB, secretlint 90 MB. In process, the
gate holds 2.6 MB of heap once warm (`gate-startup.bench.ts`); a 16 MB crafted text raised its peak RSS by 16–46 MB over
the call (main: 3–41 MB).

## What was not done, and next

- Ten crafted inputs stay over 2x of secretlint (§9): the cost there is per finding (allowlists, gating, the
  structural pass, Eden's keyword rules on the same text), on texts with 50,000–100,000 findings a megabyte. The next
  steps would be a literal prefilter for line-targeted allowlist regexes (each reads a whole long line through the
  DFA) and a hand reader for hashicorp-tf-password's REST as generic-api-key has; neither changes what is found.
- Node stays 1.0–2.5x slower than Bun on the same code (§10); V8 runs the character loops slower, with no deopt left
  in the gate's own hot paths that this profile found.
- The keyword rule still redacts prose that names a password and placeholders shaped like keys (§8); with "a missed
  secret is worse than a false redaction" as the rule, no further exemption was found that keeps every nearest real
  secret caught. A caller that scans source code might want gitleaks' rules alone (`gateOf` over a subset), which the
  package allows but does not package as a preset.
- The other tools' numbers (Part 2) are from the first round and were not run again; the downloaded tools were
  deleted.
