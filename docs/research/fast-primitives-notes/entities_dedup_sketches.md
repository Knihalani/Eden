# Fast model-free primitives: entity/cue detection, near-duplicate detection, probabilistic sketches

Scope: plain TypeScript, single process, no native addons, a few ms per event. Some numbers below are **local
measurements** from a micro-benchmark run in this session. It ran on Bun 1.4.4 on a 4-vCPU Intel Xeon @ 2.10GHz and
used a synthetic gazetteer of 100k names (1 to 3 words built from random syllables) and synthetic 2 KB events.
The script is at `/tmp/claude-0/-home-user-Eden/934a81f4-56d6-5053-a3cb-bb5257f049bb/scratchpad/bench/b.ts`, with
LSH and sketch-size arithmetic in `lsh.ts` beside it. These numbers are labelled "[local bench]". They come from
synthetic data. The vocabulary was made of a few syllables, so the gazetteer collides with ordinary words far more
than real text would. Treat them as upper bounds on matching cost, not as accuracy figures.

## Q1. Multi-pattern gazetteer matching (Aho-Corasick vs Commentz-Walter vs token n-gram Map vs FlashText); incremental insertion

### Takeaway
For word-boundary, case-insensitive matching of 1k–100k names in JS, use a token-level approach. Normalize and
tokenize once, then look up either (a) token windows of length 1..L in a `Map<string, EntityId[]>` or (b) a trie keyed
by token ids (the spaCy PhraseMatcher design). Each option costs roughly 0.2–0.3 ms per 2 KB event at 100k names
[local bench]. Both support O(len) incremental insertion, so a new entity never forces a rebuild. Character-level
Aho-Corasick or double-array tries pay off only for substring matching, which is not needed here. In JS a
double-array trie mainly saves memory; it does not save latency at this scale.

### Cited Findings
- FlashText (Singh 2017) builds a trie of keywords, character by character, with a terminal key holding the
  standardized name. It matches whole words only ("Apple" does not match in "Pineapple"), prefers the longest match,
  and scans the document once. The paper claims O(N) time in document length, independent of keyword count M, against
  O(M×N) for regex — [arXiv 1711.00046 (ar5iv)](https://ar5iv.arxiv.org/html/1711.00046)
- FlashText benchmark: with 15K keywords, regex took ~0.165 s and FlashText ~0.002 s (~82x). FlashText time stays
  nearly flat as keywords grow. The benchmark used synthetic random lowercase words. Word boundaries are a fixed
  character set (space, `.`, `,`, tab, newline), not Unicode `\b` — [ar5iv FlashText](https://ar5iv.arxiv.org/html/1711.00046)
- spaCy PhraseMatcher stores phrases in a trie of hash maps (preshed `MapStruct`). Each node maps a token attribute
  value (default `ORTH`; configurable to `LOWER` via `attr`) to a child, and a reserved terminal hash marks phrase
  end. `find_matches` tries every start token, walks the trie as far as it can, and records every terminal hit. It
  does **not** filter overlaps; the caller resolves them — [spaCy phrasematcher.pyx](https://github.com/explosion/spaCy/blob/master/spacy/matcher/phrasematcher.pyx)
- spaCy's EntityRuler wraps a PhraseMatcher (exposing `phrase_matcher_attr`, e.g. to match lowercased text). It can run
  alone as a purely rule-based recognizer or alongside a statistical one. Each token can carry only one entity label —
  [spaCy EntityRuler docs](https://spacy.io/api/entityruler)
- JS Aho-Corasick packages exist. `aho-corasick-node` is a double-array-trie AC with export/import of the built
  automaton and no published benchmarks — [GitHub petetnt/aho-corasick-node](https://github.com/petetnt/aho-corasick-node).
  `@stll/aho-corasick` is a Rust NAPI binding claiming ~13–31x over the best pure JS/TS result in its own harness. It
  is a native addon, so the constraints exclude it — [@stll/aho-corasick README](https://cdn.jsdelivr.net/npm/@stll/aho-corasick@1.0.4/README.md)
- daachorse (Rust) is a compact double-array AC whose authors report it beating other AC implementations. It is not an
  npm package — [daachorse on PyPI](https://pypi.org/project/daachorse/0.1.2/)
- [local bench] 100k names, 200 synthetic 2 KB events, Bun 1.4.4:
  - Normalize (NFKD, strip marks, lowercase) and tokenize: ~0.026 ms/event.
  - Token n-gram Map (windows 1–4, string keys built by concatenation): build 90 ms; match ~0.30 ms/event.
  - Token-id trie (spaCy style: `Map<token,id>` vocab plus `Map<number,node>` children): build 148 ms; match
    ~0.21 ms/event.
  - FlashText-style char trie (nested objects keyed by char, boundary check): build 93 ms; match ~0.26 ms/event.
  - The heap measurement for the n-gram Map was ~5 MB for 100k entries. This was a single rough `heapUsed`
    measurement, so treat it as approximate.

### Inferences
- **Recommendation:** use a token-id trie or a window Map over a shared normalizer/tokenizer.
  - *Window Map* is the simplest. Key = normalized tokens joined by a space; L = max alias length in tokens (cap at
    ~5); value = candidate entity ids. Per event: O(T·L) lookups. Add an entity with one `map.set`, remove with one
    `delete`. No rebuild is needed, which fits "entities learned continuously".
  - *Token-id trie* avoids building concatenated strings for long windows. It stops early when there is no child, so
    it was ~30% faster in the bench, at the cost of a vocab map. Insertion is also O(alias length).
  - Commentz-Walter / Boyer-Moore-style skipping helps when patterns are long and sparse. Its benefit disappears with
    short names and 100k patterns, because the shortest pattern bounds the shift. I found no JS benchmark of it; this
    is an inference.
  - Character Aho-Corasick only adds value for matching inside tokens (e.g. CJK text without spaces, or code
    identifiers like `danaLeeReport`). For CJK, fall back to a char trie or to n-gram lookup over characters.
- Overlap policy: collect all hits, then resolve greedily by longest span, then by highest alias score (FlashText
  semantics). Keep shorter sub-hits as secondary evidence (spaCy semantics: return all, resolve later).
- Budget: 0.2–0.3 ms/event even with a pathological, collision-heavy synthetic vocabulary. Real gazetteers will hit
  far less often, so matching fits well inside a few ms. Rebuild cost (~0.1–0.15 s for 100k) matters only on cold
  start. Persist the alias list, not the structure.
- Per-tenant isolation: one structure per (tenant, user). At ~5 MB per 100k aliases, a process holding thousands of
  large users must load lazily and use LRU eviction; most users will have 1k–10k aliases (~0.05–0.5 MB, scaled
  linearly — inference).

### Gaps
- I found no published head-to-head benchmark of JS Aho-Corasick (object trie vs double-array) against token Map
  lookup. The local bench is synthetic and single-run.
- Commentz-Walter has no maintained JS implementation that I could find.

## Q2. Normalization and alias handling; ambiguity suppression

### Takeaway
Normalize both gazetteer and text with one function: NFKC (or NFKD), then strip combining marks, then
`toLowerCase()` (approximately Unicode case folding), then strip possessive `'s`/`’s`. Unify apostrophes and dashes.
Generate aliases deterministically: full name, first name, last name, `first.last`/`flast` email local parts,
nicknames from a small table, and company names with legal suffixes removed. Score each alias, and suppress
ambiguous aliases (single tokens that are common words) unless the text gives a capitalization or context cue.

### Cited Findings
- spaCy matches on a configurable token attribute (ORTH vs LOWER), so the same pattern set can be case-sensitive or
  case-insensitive by changing the key attribute, not the patterns — [spaCy phrasematcher.pyx](https://github.com/explosion/spaCy/blob/master/spacy/matcher/phrasematcher.pyx)
- FlashText lowercases both keywords and text by default, and its boundary set is limited to a fixed list of
  characters — [ar5iv FlashText](https://ar5iv.arxiv.org/html/1711.00046)
- Capitalization strongly affects gazetteer-based recognition. In one podcast study, a gazetteer system found 16 of
  33 film-title mentions in capitalized transcripts and 0 in uncapitalized ones — [Recognizing Film Entities in
  Podcasts, arXiv 1809.08711](https://arxiv.org/pdf/1809.08711)
- A comprehensive gazetteer with basic rules gives a reasonable baseline mainly on recall. Precision suffers where
  person/organization names are highly ambiguous — [GATE gazetteer collection, LREC 2004](https://gate.ac.uk/sale/lrec2004/gazcollector.pdf)
- [local bench] `s.normalize("NFKD").replace(/\p{M}/gu,"").toLowerCase()` plus a Unicode-aware regex tokenizer cost
  ~0.026 ms per 2 KB event.

### Inferences
- **Normalizer** (one function, used for both index and query):
  1. `NFKC` folds compatibility forms (full-width letters, ligatures); then `NFKD` and remove `\p{M}`. "José" becomes
     "jose". Keep the original span offsets for display.
  2. `toLowerCase()`. JS has no full case-fold API. `toLowerCase` covers nearly all cases; special-case `ß`→`ss` and
     Turkish dotted/dotless i only if needed.
  3. Map `’ ‘ ʼ` to `'` and the dash variants to `-`. Drop a trailing `'s` / `s'`. Split on non-letter/digit, but keep
     intra-token `-`, `.`, `_` for ids and emails (or tokenize those with dedicated regexes first; see Q3).
- **Alias generation and scoring** (per entity):
  - People: "Dana Lee" gives full name (weight 1.0), "lee" (0.5), "dana" (0.3), email local parts `dana.lee`,
    `dlee`, `danalee` (1.0 when the event is an email address; 0.6 as bare tokens), and nicknames from a static table
    ("Robert" to "Bob", "Rob") at 0.3.
  - Companies: strip `Inc, Inc., LLC, Ltd, Ltd., GmbH, S.A., PLC, Corp, Co.` and a leading "The". Keep the
    domain (`acme.com` → `acme`) as an alias.
  - Projects and tickets: exact key `ENG-123`. Project codenames are often common words (e.g. "Phoenix"), so give them
    low base weight.
- **Ambiguity suppression:**
  - Keep a static English frequency list of ~20–50k words, or compute document frequency over the user's own corpus.
    Give an alias's idf a floor: a single-token alias whose lowercase form is a common word ("will", "may", "mark",
    "apple", "amazon") counts only if (a) it is capitalized and not sentence-initial, or (b) another alias of the same
    entity, or a co-occurring linked entity, appears in the same event.
  - Score = alias weight × idf-ish factor × cue bonus (capitalized mid-sentence, preceded by `@`, inside an email
    header, near "with/from/cc/meeting"). Fire only above a threshold. This follows "precision over recall".
  - When a first name maps to several entities ("Dana" → 3 people), resolve by recency or interaction count from the
    user's sources. If it stays ambiguous, stay silent.
- The window Map key should be the normalized form, while the stored value keeps the alias's original casing. That
  allows a cheap "was this mention capitalized like a name" check per hit.

### Gaps
- I found no published precision numbers for idf-thresholded alias suppression in personal-data gazetteers. Tune it
  via Eden's eval (falseFireRate).
- I did not fetch a canonical nickname table source (e.g. the open "nicknames" CSV datasets); this needs a follow-up
  check of its license.

## Q3. Model-free entity extraction for unseen names; JS NLP options

### Takeaway
For unseen names, use regexes for structured cues (emails, @handles, URLs, ticket ids, dates, money; precision near
100% by construction) plus a capitalization-run heuristic for proper nouns. The heuristic is a recall-oriented
candidate generator with weak precision; use it to *propose* entities for later confirmation, not to fire on. Rule-based
NER reaches ~90% F1 in narrow, well-formed domains but degrades on informal or lowercase text. JS options
(wink-nlp, compromise) are fast enough (sub-ms per event) but still rule- or small-model-based.

### Cited Findings
- Knowledge-based NER systems have three parts: hand-written rules, optional gazetteers, and an engine that applies
  them — [NER survey, arXiv 2401.10825](https://arxiv.org/pdf/2401.10825)
- Rule-based systems need no training data and are interpretable, but rules take expertise to write and they do best
  on well-formed text. In one historical-newspaper system recall was systematically lower than precision (best F 89%)
  — [NER on historical documents survey, arXiv 2109.11406](https://arxiv.org/pdf/2109.11406)
- Reported rule-based results are domain-specific: Classical Arabic P 90.2 / R 89.3 / F 89.5; Malay P 90.23 / R 92.13
  — [J. Mathematics 2022 (DOAJ)](https://doaj.org/article/519164d77a2048efb7692e4a59f54c81),
  [APJITM 2019 (DOAJ)](https://doaj.org/article/00e6c294d928488996ca49623ce680c0)
- Early rule-based company-name extraction relied on capitalization patterns and lexical markers — [arXiv 2401.10825](https://arxiv.org/pdf/2401.10825)
- wink-nlp claims over 650k tokens/s for the full pipeline (tokenization through entity extraction) on an M1 MacBook
  Pro in Node.js 16/18, and ~4M tokens/s for the tokenizer alone. It has no external dependencies, models start at
  ~1 MB gzipped, and it is MIT licensed. It offers NER and custom entity recognition (pattern-based) — [winkjs/wink-nlp](https://github.com/winkjs/wink-nlp)
- compromise exposes `.people()` and `.organizations()` (e.g. "Google, Inc") and is rule-based. Third-party pages
  claim ~1 MB/s and ~0.1 ms for most sentences in the lightweight build; the project itself admits it is not the most
  accurate — [compromise (sourcepulse summary)](https://www.sourcepulse.org/projects/1671417), [compromise README mirror](https://github.com/emileae/compromise)

### Inferences
- **Regex layer** (run first; consume matched spans so the name heuristic does not re-see them):
  - Email: `/[\w.+-]+@[\w-]+(\.[\w-]+)+/` → map the local part to a person alias and the domain to an org.
  - Handle: `/(?<![\w@])@[A-Za-z0-9_][\w.-]{1,38}/`
  - Ticket ids: `/\b[A-Z][A-Z0-9]{1,9}-\d{1,6}\b/` (Jira/Linear style), `#\d+`, plus GitHub `owner/repo#123`.
  - URL: `/https?:\/\/[^\s<>"]+/`. Canonicalize host + path; strip the fragment and tracking params (`utm_*`).
  - Dates and times, and money (`/[$€£]\s?\d[\d,]*(\.\d+)?\s?(k|m|bn)?/i`, ISO codes): cues for "deadline" and
    "amount" context, not entities.
  - Each regex is linear in text length with a fixed small count, so cost is µs per KB (inferred from the
    tokenize-regex timing above).
- **Capitalization-run heuristic** for candidate names:
  - Take maximal runs of Title-case tokens, allowing connectors `de, van, von, of, &, and` and initials `J.`.
  - Drop the run if it is a single sentence-initial token that also occurs lowercase in the user's corpus or a common
    word list, if it is a weekday or month, or if it sits in an all-caps or all-title-case line (headers, subjects).
  - Classify: org if the run ends with a company suffix or contains a known org head word; person if the first token
    is in a first-name list (US SSA/census lists); otherwise unknown.
  - Store unseen candidates with a counter (see Q5's count-min). Promote one to the gazetteer only after it recurs
    across ≥2 sources or sessions. This keeps precision high without a model.
- A small CRF in JS is possible but would need training data and labelled personal text. wink-nlp already offers a
  ~1 MB model at 650k tokens/s (~0.5 ms for a 300-token event, inferred from the claimed rate). It is the fallback if
  heuristics prove too weak. Adding it would need a dependency justification per CLAUDE.md.

### Gaps
- I found no published precision/recall for capitalization-run heuristics on informal English (chat or email), and no
  independent wink-nlp NER accuracy numbers. Measure on Eden's eval set.

## Q4. Near-duplicate detection (MinHash+LSH, SimHash, quoted replies, hashing in JS)

### Takeaway
Strip quoted reply text and signatures first, then canonicalize whitespace and case. Then use two tiers: (1) an exact
hash of the canonical text to catch synced copies, and (2) MinHash over word 3-shingles with 128 32-bit
permutations and LSH banding for Jaccard ≈0.8 (b=12, r=10 or b=16, r=8). The alternative is a 64-bit SimHash with
Hamming ≤3, computed as two 32-bit halves. Use 32-bit `Math.imul` hashes (murmur3_32), never BigInt. Measured cost:
~0.33 ms per 2 KB doc for MinHash128 and ~0.19 ms for SimHash64 [local bench].

### Cited Findings
- MinHash estimates Jaccard similarity with expected error O(1/√k) for k hashes (e.g. 400 hashes ≤0.05 error). A
  single hash with bottom-k (keep the k smallest) has the same O(1/√k) error. It was published by Broder in 1997 ("On
  the resemblance and containment of documents") — [Wikipedia: MinHash](https://en.wikipedia.org/wiki/MinHash)
- MinHash collision probability equals the Jaccard index. LSH amplification by AND (r rows) then OR (b bands) gives a
  collision probability of 1−(1−p^r)^b — [Wikipedia: Locality-sensitive hashing](https://en.wikipedia.org/wiki/Locality-sensitive_hashing)
- For SimHash (Charikar random hyperplanes), Pr[h(u)=h(v)] = 1 − θ/π — [Wikipedia: LSH](https://en.wikipedia.org/wiki/Locality-sensitive_hashing)
- Manku, Jain & Das Sarma (WWW 2007) showed Charikar's fingerprint suits near-duplicate detection. For 8 billion web
  pages, 64-bit fingerprints with k=3 differing bits are reasonable. They give an algorithm for finding all stored
  fingerprints within k bits of a query — [Manku et al. 2007](https://www.www2007.cpsc.ucalgary.ca/papers/paper215.pdf)
  (the full PDF returned 503 when fetched; claims come from the abstract as shown in search results).
- Sood & Loguinov (CIKM 2011) propose probabilistic SimHash Hamming search, reporting 4–14x faster lookup at 95% recall
  on 70M pages — [Sood & Loguinov 2011](https://s1.irl.cs.tamu.edu/people/sadhan/papers/cikm2011.pdf)
- In JS, only 32-bit-designed hashes perform well; emulating 64-bit arithmetic can cut speed by 80–90%, and BigInt is
  not considered performant. MurmurHash3_32 is fast with good quality (0 collisions in the author's test), FNV is
  similar in speed, and xxHash32 is "not as fast as you'd think". For more than 32 bits, MurmurHash3_x86_128 yields
  four 32-bit words — [bryc/code jshash README](https://github.com/bryc/code/blob/master/jshash/hashes/README.md)
- `Math.imul` is required for correct 32-bit multiplication. A plain `*` loses low bits past 2^53 — [mojoauth MurmurHash in Node.js](https://mojoauth.com/security-guides/murmurhash-in-nodejs)
- [local bench] 100k short keys: murmur3_32 9.8 ms, FNV-1a_32 10.4 ms (~0.1 µs/key each), `Bun.hash` (wyhash, returns
  BigInt) 8.1 ms, BigInt FNV-1a-64 160.9 ms (~16x slower). MinHash128 (word 3-shingles, murmur3, then
  `(a·h+b) mod 2^32` permutations via `Math.imul`): ~0.33 ms per 2 KB doc. SimHash64 (two murmur3 seeds, 64 counters):
  ~0.19 ms per 2 KB doc.
- [local arithmetic, `lsh.ts`] Banding curves P(candidate | Jaccard s) for 120–128 hashes:
  - b=16, r=8 (threshold ≈ (1/b)^(1/r) = 0.707): s=0.6 → 0.24, s=0.7 → 0.61, s=0.8 → 0.95, s=0.9 → 1.00.
  - b=12, r=10 (≈0.78): s=0.7 → 0.29, s=0.8 → 0.74, s=0.9 → 0.99.
  - b=10, r=12 (≈0.83): s=0.7 → 0.13, s=0.8 → 0.51, s=0.9 → 0.96.
  - b=20, r=5 (≈0.55) is too loose for 0.8 (s=0.5 → 0.47).

### Inferences
- **Pipeline per retrieved item:**
  1. Strip quoted content: lines beginning with `>`; everything after `On … wrote:`, `-----Original Message-----`,
     `From: … Sent: …` blocks; and signatures after `-- ` or common mobile footers. Normalize whitespace, lowercase,
     and remove URL tracking params.
  2. Compute an exact 32-bit (or 2×32) hash of the canonical body to catch exact syncs (Gmail and a forwarded copy
     in Slack). Look it up in a Set.
  3. Bodies under ~20 tokens: exact hash only, since MinHash is noisy on tiny sets (error ~1/√k on few shingles).
  4. Otherwise compute MinHash with k=128, word 3-shingles (5-char char shingles for short or CJK text). Band b=16,
     r=8 if the recall target at J≥0.8 is high (0.95), then verify candidates by estimated Jaccard ≥0.8 from the full
     signature. The verification step removes false candidates from the low threshold.
- **Choose MinHash for "same thread, different quoting"**, since it works on sets and survives reordering.
  **Choose SimHash** (64-bit as `[lo, hi]` uint32, popcount via bit tricks, Hamming ≤3) when memory per item matters
  (8 bytes vs 512 bytes for 128×uint32) and weighting by term frequency is wanted. Manku's k=3/64-bit setting came
  from web pages; for short emails, validate the threshold on Eden data.
- At per-user scale (≤ ~100k items) LSH tables are just `Map<bandKey, id[]>`. Build `bandKey` by hashing the r
  uint32s of a band with murmur3 over the Uint32Array. Memory ≈ items × b × (key + id) ≈ 100k × 16 × ~16 B ≈ 25 MB
  (rough estimate, not measured). For retrieval-time dedup among, say, 20–50 results, skip LSH and compare signatures
  pairwise: 50²/2 × 128 compares is ~160k ops, sub-ms.
- Never use BigInt or `Bun.hash` on the hot path if portability to Node matters. Plain murmur3_32 is within 20% of
  native wyhash in Bun.

### Gaps
- I could not fetch MMDS ch. 3 (Leskovec/Rajaraman/Ullman; 503) for its shingle-size guidance (k≈5 chars for emails,
  ≈9 for long docs, from memory, unverified). The banding formula above is sourced from Wikipedia's LSH page instead.
- I found no published study of MinHash/SimHash thresholds specifically on email reply chains.

## Q5. Probabilistic sets/counters (Bloom, cuckoo, count-min, HyperLogLog) vs exact Set in JS

### Takeaway
At per-user scales (≤ ~1M items) an exact `Set` of 32- or 64-bit hashes is the default for "already delivered". It is
exact for deletion, and 100k entries cost ~5 MB [local bench]. Use a Bloom filter (9.6 bits/item at 1% FPR, ~117 KB
per 100k) when you need many per-user filters resident or persisted cheaply. A cuckoo filter fits only if deletion is
needed. Use a count-min sketch for frequencies of unbounded keys (unseen-name counting), and HyperLogLog only for
dashboard-style distinct counts.

### Cited Findings
- Bloom filter: optimal k = (m/n)·ln2; bits per element m/n = −ln ε / (ln2)² ≈ 1.44·log2(1/ε). That is ≈9.6
  bits/element at 1% FPR, and each 10x reduction in FPR adds ~4.8 bits/element. Hash independence can be relaxed (the
  double-hashing literature: Kirsch & Mitzenmacher 2006; Dillinger & Manolios 2004) with negligible loss — [Wikipedia:
  Bloom filter](https://en.wikipedia.org/wiki/Bloom_filter)
- Cuckoo filter (Fan, Andersen, Kaminsky, Mitzenmacher, CoNEXT 2014): supports deletion, stores fingerprints in a table
  ~95% full, and uses less space than Bloom when target ε < 3% — [Fan et al. 2014](https://sigcommconfs.hosting2.acm.org/co-next/2014/CoNEXT_papers/p75.pdf).
  Minimum fingerprint f = ⌈log2(1/ε) + log2(2b)⌉ for bucket size b — [cuckoo filter workshop paper](https://people.bu.edu/staro/cuckoo_filter_workshop_paper.pdf).
  Load factors are 84% / 95% / 98% for b = 2 / 4 / 8, and semi-sorting saves 1 bit/item at b=4 (per a Go library's
  docs, secondary) — [linvon/cuckoo-filter](https://pkg.go.dev/github.com/linvon/cuckoo-filter)
- Conflicting evidence: a 2020 workshop paper finds Bloom filters *more* space-efficient than cuckoo below 3% FPR for
  most sizes — [people.bu.edu workshop paper](https://people.bu.edu/staro/cuckoo_filter_workshop_paper.pdf). A 2025
  paper says the power-of-2 bucket restriction can add large overhead — [arXiv 2505.05847](https://arxiv.org/abs/2505.05847v3)
- Count-min sketch (Cormode & Muthukrishnan): width w = ⌈e/ε⌉, depth d = ⌈ln(1/δ)⌉. Estimates never undercount, and
  â ≤ a + εN with probability 1−δ (N = stream total). Conservative update (raise each row only to min+c) reduces
  overestimation and stays mergeable — [Wikipedia: Count–min sketch](https://en.wikipedia.org/wiki/Count%E2%80%93min_sketch)
- HyperLogLog: standard error ≈ 1.04/√m. Estimates below 5/2·m are biased, so use linear counting m·ln(m/V) there.
  HLL++ uses a sparse representation at small cardinalities — [Wikipedia: HyperLogLog](https://en.wikipedia.org/wiki/HyperLogLog)
- [local bench] Bloom filter, n=100k, ε=1%: m=958,506 bits (117 KB), k=7, Kirsch-Mitzenmacher double hashing from two
  murmur3 seeds (`h1 + i·h2`). Add 100k took 40 ms (0.4 µs/op); query 100k absent took 32 ms (0.32 µs/op);
  **measured FPR 0.97%**. `Set<string>` with 100k entries took ~5.2 MB of extra heap and `.has` cost ~0.023 µs/op
  (~14x faster than this Bloom). `Set<number>` of 100k uint32 hashes also took ~5.3 MB.
- [local arithmetic] Cuckoo b=4: ε=1% → f=10 bits → ~10.5 bits/item at 95% load; ε=0.1% → 13 bits → ~13.7. CMS:
  ε=0.001, δ=0.01 → w=2719, d=5 → 54 KB as uint32; ε=0.0005, δ=0.001 → w=5437, d=7 → 152 KB.

### Inferences
- **Delivered/seen tracking:** key = hash(tenant, user, session?, itemId or contentHash). Use an exact `Set` with
  time-bucketed rotation (e.g. one Set per day, keep the last N days) for TTL semantics without deletion support. A
  Bloom false positive means a *missed* delivery, so it fails silent, which matches "silence by default". Still keep
  ε ≤ 0.1% (14.4 bits/item) if Bloom is used. Persisted Bloom bytes (Uint32Array) are compact and mergeable by OR,
  but cannot delete; that is the cuckoo filter's sole advantage.
- **Below ~10^5–10^6 entries per user**, an exact Set wins on simplicity and speed, and its memory (~50 B/entry) is
  acceptable. Bloom wins ~45x on memory (≈1.2 B/entry), which matters only with thousands of resident users or when
  persisting per-session filters.
- **Count-min** for "how often has this unseen capitalized run appeared" or alias frequency. Use ε≈0.001 and
  δ≈0.01 (~54 KB per user as Uint32Array, conservative update) and keep a small exact top-K heap for promotion
  candidates. At small cardinalities a `Map<string, number>` with a size cap and LRU eviction is simpler and exact;
  prefer it until the map exceeds ~50k keys.
- **HyperLogLog** (m=2^12 → 1.04/64 ≈ 1.6% error, ~3–4 KB with 6-bit registers in a byte array) only for metrics
  like distinct entities per user per day; not needed for correctness.
- All sketches must be keyed per tenant/user (CLAUDE.md isolation rule), and their hash inputs should be redacted or
  hashed ids, not raw text.
- Hash function for every structure: murmur3_32 with two seeds (or one murmur3_x86_128 for four words). Derive k
  indexes by double hashing. Avoid `%` bias on non-power-of-two m by using power-of-two sizes and `& (m-1)`.

### Gaps
- I did not benchmark a JS cuckoo filter or published npm packages (`bloom-filters`, `@thi.ng/bloom`). No independent
  JS benchmarks of those packages were found in this session.
- The Set memory figure is a single `heapUsed` delta under Bun/JavaScriptCore; V8 (Node) will differ.
