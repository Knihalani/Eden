# Dedup primitives: reply stripping, fingerprints, MinHash, SimHash, sketches

What `@eden/primitives` adds for "do not deliver near-duplicates" (quoted replies, forwarded threads, synced copies
of one document), what was measured to choose it, which libraries were evaluated and why none was adopted, and which
probabilistic structures were left out because the plain `Map` won. Every number below is copied from a command run
in this session; anything not measured is labelled.

Environment: Bun 1.4.4 (JavaScriptCore), 4 vCPU Intel Xeon @ 2.10 GHz shared VM, 2026-10-27. Expect ±30% (sometimes
±2x) run to run on this VM: the reference MinHash finalizer measured 63.54 µs in one run and 67.07 µs in another,
and 101.84 µs in an earlier scratch run. Ratios are steadier than absolute numbers.

## What shipped

| File | Exports | For |
|---|---|---|
| `reply.ts` | `splitReply`, `ReplyLines`, `PART_*`, `stripReply`, `dedupText`, `countTerms` | Per-line kinds of an email (own, quote, header, forward, signature, greeting); the text to compare for dedup |
| `dedup.ts` | `TextSketcher` (`load`, `fingerprint`, `minhash`, `simhash`, `numberKey`, `copyShingles`), `minhashSimilarity`, `hamming64`, `popcount32`, `MinHashIndex`, `lshCandidateProbability`, `isUnsegmented`, `MAX_PERMUTATIONS` | Exact and near-duplicate detection over the shared tokenizer's terms |
| `sketch.ts` | `ExpiringSet` | "Seen in the last N windows" over 64-bit keys (delivered history) |

Reply stripping lives in its own file (`reply.ts`) rather than in `dedup.ts`: it is a different concern (message
structure, regexes, per message) from the hashing (per term, typed arrays), and either is useful without the other.

The pipeline the numbers support, per item at cache-insert time:

1. `dedupText(text, 6)`: the sender's own words; for an acknowledgement or a bare/"FYI" forward (fewer than 6 own
   terms), the message it carries, reduced the same way.
2. `TextSketcher.load` + `fingerprint`: exact duplicates (synced copies, bare forwards). 16.84 µs per 2 KB.
3. `simhash` (8 bytes) and a linear scan at Hamming ≤ 8 for stores up to ~10k items per user, or `minhash` (512
   bytes) + `MinHashIndex` at estimated Jaccard ≥ 0.8 when edited documents matter most or the store is too large to
   scan.

## Method

**Corpus** (`bench/dedup-corpus.ts`). A synthetic mailbox: 150 email threads (1–6 messages; English 60%, French,
German, Spanish 10–12% each, Japanese 6%), replies quoted as Gmail, Outlook (separator + header block),
Outlook "-----Original Message-----", Apple Mail, Thunderbird write them, plus interleaved and bottom-posted replies;
acknowledgements ("Thanks!", "Passt, danke."), forwards (bare, "FYI", with a real note) in Gmail, Apple and Outlook
style; signatures, closings and mobile footers by sender habit; synced copies (CRLF, rewrapped, NFD accents, smart
quotes, a Google Groups footer, a CRM log header); 60 documents with minor edits (one sentence changed or added, or a
word) and major rewrites (~half the sentences); 48 templated notifications that differ only in facts (order numbers,
amounts, times). Text comes from ~180 hand-written sentences with slots plus an English phrase grammar. Seed 2 has
883 items and 296 duplicate pairs; seed 1 has 879 items and 301 pairs.

**Ground truth.** Items share a `group` when they carry the same information: a synced copy, a bare or "FYI"
forward, an acknowledgement and the message it quotes, a minor edit. A reply with its own words, a forward with a
real note, a major rewrite and every notification are their own group. That is a policy: it says an "FYI" forward
is a duplicate and an updated invitation is not.

**No tuning to the reported numbers.** Every parameter (shingle size 3, `minOwnTerms` 6, k = 128, thresholds) was
chosen on seed 1; tables report seed 2. The generator itself was fixed during development in two places, both
found as artifacts while inspecting false pairs on seed 1: versions of a document kept the first
version's group after a major rewrite, and one-sentence messages drawn from slot-free sentences repeated word for
word across unrelated threads (real short mail mentions a name, day or amount), so every message now starts with a
slot-bearing sentence. Remaining identical one-sentence messages across threads are counted as false pairs for every
method alike.

**What the corpus cannot show.** The stripper and the generator were written by the same author, so the stripper's
100% on the corpus means only that it handles the formats the generator writes. Real-email evidence comes from other
projects' fixtures (below). The corpus has no HTML mail, no attachments, no calendar ICS bodies, no chat messages.

## Reply stripping (`reply.ts`)

### Quality

On the corpus, line level (`bench/dedup.bench.ts`, seed 2: 580 labelled emails; seed 1: 608), and the libraries on
the same lines (`bench/compare/dedup.compare.ts`; forwards scored apart because planer and talon keep forwarded text
on purpose):

| Stripper | Replies: own lines kept | Quote/header/signature lines removed | Emails exactly right | Forwards: removed |
|---|---|---|---|---|
| ours, `stripReply` | 100.0% | 100.0% | 100.0% | 100.0% |
| email-reply-parser 2.3.9 | 100.0% | 99.2% | 94.0% | 77.8% |
| planer 1.2.0 (talon port) | 99.4% | 92.1% | 38.3% | 54.9% |
| talonjs 1.0.28 | 99.9% | 91.4% | 39.8% | 34.3% |
| node-email-reply-parser 0.1.4 | 100.0% | 97.5% | 67.3% | 97.1% |
| parse-reply 0.0.4 | 92.5% | 70.7% | 28.7% | 100.0% |

Greetings, closings and acknowledgements are scored as don't-care (keeping or dropping them are both defensible).

Real emails, not generated (`bench/compare/reply-fixtures.compare.ts`):

- **email-reply-parser's 90 fixtures** (crisp-oss/email-reply-parser@340eff4). Our output equals email-reply-parser's
  on 78 of 90. I reviewed the 12 differences by hand: 7 are only our greeting/closing removal (email_1, email_2,
  email_customer_quote_header_3, email_not_a_signature, email_not_a_signature_2, email_tricky_2_url_with_wrote,
  email_with_regards); 1 is our forward stripping (email_tricky_17_forward_header); in 4 email-reply-parser is wrong
  (email_2_1 and email_thread: it keeps an Outlook block or a wrapped header; email_custom_quote_header: it keeps the
  header; email_tricky_7_multiple_dashes: it cuts content at a `----` markdown rule). These fixtures are not a
  held-out score: they are that library's own regression suite, and before they were run against reply.ts only 59 of
  90 matched (first scratch run). The gaps they exposed were real client formats and were fixed: French Outlook
  "Envoyé le :", Danish "Oprindelig besked", Zoho's dashed header, "On … wrote" without a colon, verb-less
  "date <email>:" headers over an unmarked quote, headers wrapped inside the address (`<a@b.c` / `>:`), Mailman
  footers under `__`, long disclaimers under `-- `, "Sent from <anything>" footers, labels above header blocks.
- **talon's 12 standard replies** (mailgun/talon@44d1fa5, held out: first run after the rewrite above; later changes
  were performance gates and one corpus regression fix, and the score did not change). Equal to talon's expected
  text: ours with boilerplate stripping off 11/12, planer 11/12, talonjs 11/12, email-reply-parser 9/12. `stripReply`
  scores 0/12 here only because it drops the greeting "Hello", which is the whole expected text; that is its dedup
  policy. sparrow.eml fails for every parser (talon's expected text keeps the signature).

### Speed

| Input | ours | email-reply-parser | planer | talonjs | node-email-reply-parser | parse-reply |
|---|---|---|---|---|---|---|
| 2 KB reply | 5.99 µs | 984.18 µs | 158.97 µs | 193.41 µs | 2198.31 µs | 14.47 µs |
| 2000 lines ending ':' (84 KB) | 3264.70 µs | 15023.59 µs | 5307.58 µs | 11384.33 µs | 48734.02 µs | 2159.14 µs |
| one 95 KB line ending "wrote:" | 3.37 µs | 8801.42 µs | **2143979.87 µs** | 3378.95 µs | 9284.47 µs | 59.61 µs |

(`bench/compare/dedup.compare.ts`, means.) planer spends 2.1 s on one long line: catastrophic regex backtracking on
input any sender controls. Ours on its own worst cases (`bench/dedup.bench.ts`): 2000 `>` lines (102889 B) 69.43 µs,
2000 lines ending ':' 3935.06 µs, 2000 "From:" lines 75.48 µs, one 95006 B line 3.06 µs; `dedupText` 8.39 µs on a
2 KB reply, 16.41 µs on an acknowledgement (it descends into the quoted message), 31.58 µs on a 16 KB thread.

The ':'-line case is the slowest per byte (each candidate header line is sliced, NFC-normalized and tested). It is
linear and a test asserts no input in a set of adversarial shapes takes more than 2 s; Eden caps item text at
8000 characters, so the worst realistic input is ~0.4 ms. An earlier version without character gates took 15.8 ms on
the same input and 12 µs on a normal 2 KB reply; the gates (an opener's first letter and a verb's last letter before
any regex, a colon in the first 24 characters before a field regex, a reply verb or "<email>:" before joining
wrapped lines) brought those to the numbers above.

### Library decision: write our own

- **email-reply-parser** (crisp-oss, MIT; npm entry modified 2026-07): the best of the libraries on quality, but
  164x slower per 2 KB, returns text only (no per-line kinds), has no notion of "this reply adds nothing, compare
  what it carries", and treats a `Regards`/`Cheers` line or a bare `--`/`____` line as a signature start
  (email_tricky_7 above). Its regexes optionally use the `re2` native module to bound backtracking; without it the
  one-line case costs 8.8 ms.
- **planer / talonjs** (talon ports, MIT; npm entries last modified 2023 and 2022): keep forwards and "short" quotes
  as content by design (talon shows replies, it does not dedup them), and planer backtracks for seconds.
- **node-email-reply-parser, parse-reply**: older ports; parse-reply's `^on[\s\S]*wrote.*:$` (flags `im`) matches
  across lines.
- **Vendoring** email-reply-parser and improving it would mean rewriting its core loop (it reverses the text and
  each line to run its regexes), its signature heuristics and its output: a rewrite either way.

Ours is 593 lines with comments, no dependency, gives per-line kinds, and was cross-checked against the fixtures of
two of these projects. The cost: the header phrasings are ours to maintain; the fixture runs above are its
regression set.

## Exact fingerprint

`TextSketcher.fingerprint`: two independent 32-bit lanes over the term-hash sequence (FNV-style and murmur-style
mixing, each finalized with `mix32`), so equal means the same terms in the same order: case, accents (NFC or NFD),
punctuation, whitespace and line endings never matter. A test hashes 20,000 distinct random texts without a
collision. Term hashes come from the folded term string, not the vocabulary id, so fingerprints agree across
processes and vocabularies (tested).

On the stripped corpus it is the precise tier: seed 2 P 1.000 R 0.797 (it misses the 53 minor edits and 7 copies of
edited documents); seed 1 P 0.989 R 0.860 (3 false pairs; those inspected were identical one-sentence messages in
unrelated threads, the corpus artifact described above).
Without stripping first: R 0.314 (seed 2), because a reply, its acknowledgement and a forward all differ in their
quoted part.

## Near-duplicates: MinHash and SimHash (`dedup.ts`)

### Design

Both read the same units: the shared tokenizer's terms (`tokenizeInto` + `Vocab`, no second tokenizer), each term's
hash computed once per vocabulary id and cached in a typed array; terms in scripts written without spaces (Chinese,
Japanese, Thai: the tokenizer keeps a whole sentence as one term) are expanded into character bigrams, once per id,
so an edited character changes a few shingles instead of the whole sentence. Shingles are hashes of w consecutive
units (w = 3), finished with `mix32`. All arithmetic is 32-bit `Math.imul`; no BigInt, no per-call allocation, no
default parameters.

- MinHash: k = 128 values, one seeded xor-multiply-xorshift per value over the mixed shingle hashes, seeds from a
  fixed splitmix stream (signatures are stable and can be stored). `MinHashIndex`: LSH banding (16 bands × 8 rows
  recommended) in one open-addressed table of (band key, id) with linear probing and backward-shift deletion, so a
  TTL cache's constant churn leaves no tombstones.
- SimHash: 64 bits as two 32-bit lanes, each shingle counted as often as it occurs, Hamming distance by popcount.

### Quality (seed 2, stripped with `dedupText(text, 6)`, w = 3 unless noted)

| Decision | P | R | F1 | false pairs | missed |
|---|---|---|---|---|---|
| exact fingerprint | 1.000 | 0.797 | 0.887 | 0 | 60 |
| exact Jaccard ≥ 0.8 (oracle, no sketch) | 0.983 | 0.990 | 0.987 | 5 | 3 |
| MinHash ≥ 0.6 | 0.934 | 1.000 | 0.966 | 21 | 0 |
| MinHash ≥ 0.7 | 0.977 | 0.997 | 0.987 | 7 | 1 |
| **MinHash ≥ 0.8** | 0.983 | 0.976 | **0.980** | 5 | 7 |
| MinHash ≥ 0.9 | 1.000 | 0.922 | 0.960 | 0 | 23 |
| SimHash ≤ 3 bits | 1.000 | 0.868 | 0.929 | 0 | 39 |
| SimHash ≤ 6 bits | 0.978 | 0.922 | 0.950 | 6 | 23 |
| **SimHash ≤ 8 bits** | 0.966 | 0.959 | **0.963** | 10 | 12 |
| SimHash ≤ 10 bits | 0.960 | 0.976 | 0.968 | 12 | 7 |
| SimHash ≤ 12 bits | 0.907 | 0.990 | 0.947 | 30 | 3 |
| exact or (MinHash ≥ 0.8 and same numbers) | 0.982 | 0.926 | 0.953 | 5 | 22 |
| exact or (SimHash ≤ 8 and same numbers) | 0.978 | 0.912 | 0.944 | 6 | 26 |

MinHash ≥ 0.8 misses 5 minor edits and 2 copies of edited documents; its 5 false pairs are, by item kinds,
message/reply, reply/CRM copy, acknowledgement/message, acknowledgement/CRM copy and one notification pair. SimHash
≤ 8 misses 10 minor edits and 2 copies.

Choices, on seed 1 (`SEED=1`), with seed 2 alongside:

| Variant | seed 1: MinHash ≥ 0.8 F1 | seed 1: SimHash ≤ 8 F1 | seed 2: MinHash ≥ 0.8 F1 | seed 2: SimHash ≤ 8 F1 |
|---|---|---|---|---|
| no stripping, w=3 | 0.666 | 0.607 | 0.684 | 0.633 |
| w=1 | 0.946 | 0.043 | 0.967 | 0.064 |
| w=2 | 0.974 | 0.965 | 0.985 | 0.967 |
| **w=3** | 0.975 | 0.965 | 0.980 | 0.963 |
| w=4 | 0.983 | 0.965 | 0.981 | 0.975 |
| w=3, `minOwnTerms` 3 | 0.796 | 0.784 | 0.894 | 0.878 |
| w=3, `minOwnTerms` 10 | 0.974 | 0.963 | 0.965 | 0.948 |

- **Stripping first is the largest effect**: MinHash precision 0.580 → 0.983 on seed 2. Without it every reply looks
  like its parent.
- **w = 3**: w = 1 (bag of words) wrecks SimHash and costs MinHash precision; w = 2, 3, 4 are within a few pairs of
  each other (w = 4 was 0.008 better for MinHash on seed 1, 3 false pairs). I kept 3, the common default, which is
  more tolerant of short texts; w = 4 is a defensible alternative.
- **`minOwnTerms` 6**: at 3, "FYI, see the thread below." and "Sounds good, see you then." count as content and
  collide across threads (seed 1 exact-fingerprint precision 0.762); 6 and 10 are close (seed 1: 0.989 and 0.985).
  Earlier scratch sweeps on seed 1: before the CJK fix, exact-fingerprint precision was 0.957 / 0.935 / 0.918 /
  0.828 at 6 / 8 / 10 / 12; after it, 6 and 8 gave identical results. Japanese is counted at two characters per
  word (`countTerms`); before that, a two-sentence Japanese reply counted as ~2 terms and was replaced by the
  message it quoted.
- **Same-numbers guard** (`numberKey`, an order-independent key of the terms containing digits): on seed 2 it
  removes none of MinHash's 5 false pairs and 4 of SimHash's 10, and misses 15 and 14 more duplicate pairs (recall
  0.976 → 0.926 and 0.959 → 0.912), because minor document edits often change a number. It ships as an optional
  signal for callers that treat a changed number as news (an updated meeting time, a new order), not as part of
  the default decision.

### LSH banding (seed 2, the 883 items indexed, every item queried)

| Bands × rows | P(candidate) at s = 0.8 (theory) | pairs with MinHash ≥ 0.8 found | true duplicate pairs found | candidates per query |
|---|---|---|---|---|
| **16 × 8** | 0.947 | 1.000 | 0.997 | 0.69 |
| 32 × 4 | 1.000 | 1.000 | 1.000 | 1.41 |
| 20 × 6 | 0.998 | 1.000 | 0.993 | 0.80 |
| 12 × 10 | 0.744 | 0.993 | 0.986 | 0.67 |

16 × 8 finds every pair the scan would flag at ≥ 0.8 here (duplicates sit well above 0.8); 32 × 4 is the safer
setting if a corpus has many pairs right at the threshold, at twice the candidates. A fuzz test checks the index
against a naive Map-of-bands model through 5,000 random adds, removes and queries with forced resizes.

### The MinHash permutation family

`bench/dedup.bench.ts` (perm section), k = 128, 400 set pairs per cell, bias and RMSE of the estimate:

| Input | n | J | shipped xor-mul-xorshift | full fmix32 (reference) | linear a·x+b mod 2^32 | theory RMSE |
|---|---|---|---|---|---|---|
| random | 20 | 0.8 | bias -0.0001, RMSE 0.0355 | 0.0004, 0.0332 | -0.0013, 0.0346 | 0.0354 |
| random | 200 | 0.8 | 0.0009, 0.0359 | 0.0013, 0.0354 | -0.0026, 0.0360 | 0.0354 |
| random | 200 | 0.95 | -0.0003, 0.0185 | -0.0008, 0.0188 | 0.0009, 0.0194 | 0.0193 |
| structured | 20 | 0.5 | **0.0497**, 0.0645 | 0.0001, 0.0426 | 0.0105, 0.0403 | 0.0442 |
| structured | 200 | 0.8 | -0.0007, 0.0396 | -0.0008, 0.0347 | **-0.0533**, 0.0632 | 0.0354 |

Cost for 300 shingles: shipped 39.42 µs, reference 67.07 µs, linear 45.75 µs (another run: 41.43, 63.54, 46.35; a
scratch run: 37.13, 101.84, 50.86). On mixed inputs, which is all the sketcher ever feeds it (every shingle hash ends
in `mix32`), the cheap family is as good as the reference at 1.5–2.7x less cost. On raw consecutive integers it is
biased by up to +0.05, so it must not be reused on unmixed values; the comment in `minhash` says so and a test
compares it with the reference on real shingles. The common linear family is biased on structured input too.

### Cost

Per item (`bench/dedup.bench.ts`, warm vocabulary, means):

| | 300 B | 2 KB | 16 KB |
|---|---|---|---|
| `load` (tokenize + shingles) | 330.3 ns | 16.97 µs | 106.13 µs |
| `load` + `fingerprint` | 142.2 ns | 16.84 µs | 113.40 µs |
| `load` + `minhash` k=128 | 439.6 ns | 59.97 µs | 512.89 µs |
| `load` + `simhash` | 230.2 ns | 33.76 µs | 208.77 µs |

(The 300 B text is a stripped acknowledgement of a few terms; `load` alone and `load + fingerprint` differ by noise.)

Lookup against a user's store (4,595 distinct corpus items, then random signatures up to N):

| | N = 2,000 | N = 100,000 |
|---|---|---|
| SimHash scan, Hamming ≤ 8 | 7.44 µs | 459.36 µs |
| MinHash scan, k = 128 | 2383.81 µs | 17114.04 µs |
| LSH 16 × 8 candidates + verify | 1.29 µs | 1.49 µs |

LSH remove-oldest + add-new with 2,000 live items: 1.79 µs. Memory per item, computed from array sizes: SimHash 8
bytes; MinHash signature 512 bytes plus the index's 16 entries in a power-of-two table at load ≤ 1/2 (8 bytes a
slot: 256–512 bytes an item); the fingerprint 8 bytes.

### Ship both, with different jobs

- **SimHash** for Eden's resident per-user stores: 8 bytes an item against 768–1,024, and a linear scan of today's
  2,000-item cache costs 7.44 µs. Quality F1 0.963 (≤ 8 bits) against MinHash's 0.980; the gap is minor document
  edits (10 missed against 5).
- **MinHash + LSH** where edits matter most or N is large: at 100,000 items a SimHash scan is ~0.5 ms per check,
  ~15 ms for a 32-item lookup, while LSH stays ~1.5 µs. A SimHash index that avoids the scan would need permuted
  tables for a Hamming radius of 8, which pigeonholes into 9 blocks of ~7 bits each: candidate lists too long to be
  useful; at a radius it can index (3) recall falls to 0.868.
- Keeping one would mean either ~100x the memory for every user (MinHash only) or a linear scan and weaker edit
  recall for large stores (SimHash only).

### Library decision: write our own

`bench/compare/dedup.compare.ts`, the same 3-word shingle strings fed to each MinHash, corpus pairs with exact
Jaccard ≥ 0.3:

| | pairs | bias | RMSE | 2 KB reply (55 shingles) |
|---|---|---|---|---|
| ours | 691 | -0.0028 | 0.0328 | 16.89 µs (`load` + `minhash`) |
| minhash 0.0.9 | 691 | -0.0834 | 0.1814 | 754.10 µs |
| minhashjs 1.0.1 (first 300 items) | 123 | -0.0315 | 0.1107 | 1010.84 µs |

- **minhash 0.0.9** (duhaime, MIT; npm entry last modified 2022): computes `(a * hash + b) % prime` with 32-bit `a` and
  `hash` in doubles, past 2^53, so low bits are lost and the estimate is biased by -0.08; it also rehashes the string
  once per permutation.
- **minhashjs 1.0.1** (datasketch port, ISC): BigInt arithmetic and a SHA-1 per update; permutations drawn from
  `crypto.randomBytes` per process, so signatures cannot be stored or compared across processes; its ESM entry
  re-exports the CommonJS module object instead of the class (it had to be loaded by file path). The RMSE of 0.11
  is measured; its cause is not (a plausible one, unverified: it reads the first word of a pooled `Buffer`'s
  underlying `ArrayBuffer`, not of the digest).
- **simhash-js 1.0.0** (32-bit, keeps only the 128 smallest shingles): best F1 0.810 at ≤ 2 bits; 320.56 µs per
  2 KB. **simhash 0.1.0** (crc32 per token, 32-bit): best F1 0.939 at ≤ 4 bits; 21.92 µs on shingle strings. Ours
  (64-bit): F1 0.963 at ≤ 8 bits, 0.968 at ≤ 10; 8.77 µs (`load` + `simhash` on the same stripped reply).
- No LSH package was usable (minhash's `LshIndex` builds on its biased signatures; minhashjs ships an LSH forest on
  its non-portable ones).

Nothing to adopt or vendor: each would need its core rewritten, and ours reuses the package's tokenizer and hashing.

## Sketches (`sketch.ts`)

`bench/sketch.bench.ts`. Workload 1, delivered history: 7 daily windows, 64-bit keys, all keys live, ~half the
lookups present. Workload 2, recurrence counting for gazetteer promotion: a Zipf(1.0) stream of candidate names,
promote at count ≥ 2. JS container memory is measured from JSC heap stats (heap + extra memory) over many live
instances; typed structures report their array bytes.

### ExpiringSet: shipped

| Live keys | Bytes per key: ExpiringSet | Map key→day | 7 Set generations | 7 Bloom @ 0.1% |
|---|---|---|---|---|
| 2,000 | 24.6 | 82.1 | 115.1 | 1.81 (false positives 1357 / 200000) |
| 100,000 | 31.5 | 68.2 | 36.7 | 1.80 (false positives 1375 / 200000) |

| Operation | 2,000 live | 100,000 live |
|---|---|---|
| ExpiringSet `has` | 25.7 ns (p99 158.6 ns) | 31.0 ns (p99 65.4 ns) |
| Map key→day `has` | 17.3 ns (p99 244.7 ns) | 31.4 ns (p99 67.9 ns) |
| 7 Set generations `has` | 57.1 ns | 140.5 ns |
| 7 Bloom generations `has` | 216.5 ns | 254.1 ns |
| ExpiringSet add + rotate per day | 58.2 ns (p99 96.5 ns) | 57.9 ns (p99 102.3 ns) |
| Map add + sweep per day | 127.5 ns (p99 273.8 ns) | 139.4 ns (p99 2.44 µs) |

Use: "was this item (by content fingerprint) already given to this user in the last N days", or turns in a session.
It is exact, 2.2–3.3x smaller than the Map, has no sweep (rotation is O(1); expired slots are reused by inserts and
dropped at the next rebuild, and the table shrinks after a burst), and keeps full 64-bit keys (a Map needs a 52-bit
number or a string key). It loses ~8 ns per lookup to the Map at 2,000 keys and ties at 100,000. Worth it where
a process holds history for many users (1,000 users × 2,000 keys: ~49 MB as ExpiringSets, ~164 MB as Maps,
computed from the per-key numbers above); for a session ledger of tens of items the existing `Map` in
`engine/src/ledger.ts` is simpler and should stay.

### Bloom filter: not shipped

A Bloom filter is the smallest (1.8 bytes a key at 0.1%) but: a delivered history needs windows, and 7 rotating
filters compound their error (1357 false positives in 200,000 = 0.68% measured, about 7 × 0.1%), every false positive
silently suppresses a delivery, lookups are ~8x slower than the ExpiringSet (216.5 vs 25.7 ns; 254.1 vs 31.0 ns),
and each window must be sized in advance. Its saving over the ExpiringSet (~45 KB a user at 2,000 keys) is small against what a user already costs
Eden (an item cache of up to 2,000 items of up to 8,000 characters each). No realistic Eden setting found where it
wins. Libraries (`bench/compare/sketch.compare.ts`, n = 2,000, 0.1%): `bloomfilter@1.2.0` (BSD-3, maintained) is
sound (181 / 200000 false positives, 214.9 ns per test, against 19.6 ns for a `Set<string>`); `bloom-filters@3.0.4`
had 185 / 200000 at 4.21 µs per lookup and eight runtime dependencies. If Eden ever needs one (say, shipping a compact
"already seen" summary to a client), `bloomfilter` is the one to adopt.

### Count-min sketch: not shipped

| Distinct names, stream | exact Map | count-min (conservative update) | seen-once names promoted | mean overcount |
|---|---|---|---|---|
| 5,000, 20,000 | 160 KB | 1024 × 4 = 16 KB | 1108/1397 (79.3%) | 1.26 |
| 5,000, 20,000 | 160 KB | 2562 × 4 = 40 KB | 261/1397 (18.7%) | 0.14 |
| 100,000, 400,000 | 3328 KB | 21299 × 4 = 333 KB | 17653/27579 (64.0%) | 0.74 |
| 100,000, 400,000 | 3328 KB | 53249 × 4 = 832 KB | 2566/27579 (9.3%) | 0.07 |

For "promote a name seen twice", a count-min sketch at a tenth or a quarter of the Map's memory promotes 9–79% of
the names seen once: each one a false gazetteer entry, against "precision over recall". The exact Map at 3.3 MB for
a heavy user's 100,000 candidates is affordable. `count-min-sketch@0.1.1` (plain update, its own sizing) promoted
433/1374 (31.5%) at 33 KB and 72/1374 (5.2%) at 82 KB. A count-min sketch fits heavy-hitter questions over unbounded
keys; Eden has none per user today.

## Proposed exports (for `src/index.ts`)

```ts
export {
  countTerms,
  dedupText,
  PART_FORWARD,
  PART_GREETING,
  PART_HEADER,
  PART_OWN,
  PART_QUOTE,
  PART_SIGNATURE,
  ReplyLines,
  splitReply,
  stripReply,
} from "./reply";
export {
  hamming64,
  isUnsegmented,
  lshCandidateProbability,
  MAX_PERMUTATIONS,
  minhashSimilarity,
  MinHashIndex,
  popcount32,
  TextSketcher,
} from "./dedup";
export { ExpiringSet } from "./sketch";
```

## Not measured

- Real mailboxes. Quality comes from a synthetic corpus and two projects' fixture sets (90 + 12 emails); no Eden
  eval scenario exercises dedup yet.
- HTML mail (converted to text first is assumed), calendar ICS bodies, chat messages, documents with tables.
- Thresholds on languages beyond the five in the corpus; Chinese and Thai bigram expansion is tested for shape, not
  scored.
- Node / V8 numbers (only Bun was run); memory of the ExpiringSet beyond its array bytes (object headers).
- SimHash with permuted tables (the Manku et al. index) and one-permutation / densified MinHash (cheaper per item,
  weaker on short texts per the literature): neither was implemented.
- The engine and eval were not changed, so `bun run eval` was not run.

## Reproduce

```bash
bun packages/primitives/bench/dedup.bench.ts                  # seed 2; SEED=1 for the dev seed; SECTIONS=...
bun packages/primitives/bench/sketch.bench.ts
# libraries and fixtures, installed outside the repo (versions in each file's header):
LIBEVAL=/tmp/libeval bun packages/primitives/bench/compare/dedup.compare.ts
LIBEVAL=/tmp/libeval bun packages/primitives/bench/compare/sketch.compare.ts
LIBEVAL=/tmp/libeval bun packages/primitives/bench/compare/reply-fixtures.compare.ts --show
```
