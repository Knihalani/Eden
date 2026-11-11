# M3-arch: TwinSlot, a retrieval network built for Eden's question

Status: 2026-11-11, branch `claude/m3-retriever`, session M3 (decisions D900–D909). A design written before the
network is trained (the owner's direction, relayed by the parent): a new network whose internals are built for
"which held item bears on this request?", trained mostly from scratch on M2's `eden-synth` worlds, M3's generated
families and the train exports, evaluated on held-out families (folds A and B, m3-retriever.md §1, §1b) and on M2's
test split. Numbers marked **[EST]** are design arithmetic; results go in m3-retriever.md as they read.

## 0. The problem it is shaped around

- A fact and its all-clear twin share almost every word ("Strike on Thursday 05/11: no services" against "Strike
  called off: Thursday 05/11 services will run"). One vector per item, scored by a dot product, cannot tell them
  apart reliably (D450, D491); a cross-encoder can, but costs 650 ms a request on CPU (§3 of m3-retriever.md).
- What separates them is small and typed: a status or polarity word, a date, an amount, who replied, which item
  came later. Those are comparisons, between the item and the request and between the item and its neighbours.
- Facts that share no word with the request (60 of 112 misses) are reached only through structure: the same
  person, thread, entity or day as items the request does reach.
- Serving runs on CPU: the heavy part runs at ingest, once an item; the request side must be a few milliseconds in
  TypeScript over stored numbers, with no new heavy dependency.

## 1. The network

Shapes for one user's world of N items (N about 1,500–3,000), tokens T ≤ 128 an item, width d = 192 [EST, chosen].

**Token input (the one pretrained piece).** WordPiece ids with bge-small-en-v1.5's input embeddings (30,522 × 384,
projected to d) plus five per-token feature channels computed by rules: a date token, a time, an amount, a
negation or status word (closed list: cancelled, called off, resolved, paid, postponed, not, no longer, on hold,
suspended, …), a capitalised name. Everything after this is trained from scratch.

**L1. Item encoder (ingest).** 3 transformer layers (d 192, 4 heads, FFN 384) over the item's tokens.

**L2. Typed slot memory (ingest).** Six learned slot queries, one per type (person, thing, date/time, amount,
status/polarity, obligation), cross-attend over L1's tokens (one attention, per-type keys): each item becomes six
d-vectors plus a presence logit each. The status slot reads the negation channel; the date and amount slots read
theirs. Item = 6 × d.

**L3. Twin-contrast layer (ingest, per user).** For each item, its m = 4 nearest neighbours in the user's corpus by
the thing and person slots (cosine). Per slot type, the item attends over the differences (item slot − neighbour
slot): c_t = Σ_j softmax(a_t · [s_t, s_t − n_jt]) · W_t (s_t − n_jt). Slots are updated s_t ← s_t + MLP_t(c_t). An
item that matches its neighbours everywhere but the status slot gets a contrast vector that says so; that is the
fact-against-twin signal, built into the representation rather than left to a dot product.

**L4. Supersession gate (ingest, per user).** For each neighbour pair (i, j) from L3 with j dated after i (the item's
date header or `at`): g_ij = σ(MLP([s_i, s_j, s_i − s_j, Δdays])). An item's "cleared" score is max_j g_ij; it is
stored as one number and enters scoring as a learned penalty (L6). "This later item replaces or clears that one" is
learned from twins whose clearing item is the later one.

**L5. Graph message passing (ingest, per user).** Edges: shared e-mail address or person name, the same thread (title
with Re:/Fwd: stripped), the same calendar day named. One message-passing step over the thing and person slots
(mean of neighbours, gated): items inherit what their thread and people are about, so a fact that names "the Audi"
carries "car" from its thread. At request time a second, request-dependent step (L6) spreads score along the same
edges.

**L6. Request side and scoring (request time, CPU).** The request's tokens through a learned token table (the
asym query of m3-retriever.md, no network) give a bag vector; six linear heads write six query slots and a
presence each. Rule features from the request: the dates and amounts it names. Score of item i:

  s_i = Σ_t presence_q,t · C_t(q_t, s_i,t, φ_t)  −  λ · cleared_i,

with C_t a per-type comparator: a low-rank bilinear form (q_t W_t s_t) plus, for date and amount, a small MLP over
symbolic features φ (same day named; days apart, bucketed; amount equal / above / below). Then one hop of graph
propagation: s ← s + α · mean_{j∈N(i)} s_j (α learned, ≥ 0). A learned NULL score (a bias plus a function of the
query slots) is the "nothing here" option.

**Training objective.** Listwise over the whole world: softmax over [NULL, all N items], cross-entropy against the
fact. Every request appears twice: with its fact present and its twin removed (target: the fact), and with its fact
removed and its twin present (target: NULL), mirroring the days runs, where a hidden request's world holds the fact
and a control request's holds the twin. Hard negatives are therefore the whole world, the twin and every other
template's facts and decoys included. Data: M2's v0 train split (227 worlds, every request style and language),
M3's generated families (fold-appropriate themes) and the train exports (fold's suites), base items as distractors.

**Parameter count [EST].** Token projection 384 × 192 ≈ 74k; L1 3 × ~0.3M ≈ 0.9M; L2 ≈ 0.15M; L3/L4 ≈ 0.3M; L5
≈ 0.1M; L6 heads and comparators ≈ 0.3M; the request token table is 30,522 × 192 (5.9M, int8 at serving 5.9 MB,
shared across users). Trained weights ≈ 1.9M besides the tables.

## 2. Serving on CPU

- **Ingest (per item, once):** L1–L2 on one core [EST: 3 layers × 128 tokens × d 192 ≈ 30 MFLOP, a few ms in
  ONNX or a hand-written TypeScript forward]; L3–L5 per user over m = 4 neighbours (an index lookup and a few small
  matrix products an item). Stored per item: six slots int8 (6 × 192 = 1,152 bytes) + presences + cleared + edges:
  about 1.2 KB, **3.6 MB a user at 3,000 items** [EST].
- **Request:** tokenise (WordPiece; the vocabulary is 30k entries), table lookup and six small heads (≈ 0.2
  MFLOP), then comparators over the candidate items. Scoring all 3,000 items with low-rank bilinear comparators
  (rank 32) is about 6 × 3,000 × 32 ≈ 0.6M int8 multiply-adds plus the graph hop: **about 1–2 ms in TypeScript
  typed arrays** [EST], no new dependency (the forward pass is small enough to write by hand, as the primitives
  package's other hot kernels are).
- **The request side never sees text beyond the request**; nothing is sent anywhere.

## 3. Ablations (each trained the same way, one component out)

1. `-contrast`: L3 off (slots go straight to scoring).
2. `-slots`: one d-vector an item and one query vector (a learned bi-encoder from scratch, same token input).
3. `-supersede`: L4 off (λ = 0).
4. `-graph`: L5 and the request-time hop off.
5. `-rules`: the five token feature channels and φ off.

The full network is compared with each on the same held-out readouts; a component that does not earn its gain is
removed before anything is wired.

## 4. The bar

Unchanged (m3-retriever.md §1b): on the held-out families' days requests, recall@5 at least +10 points over the
shipped default's pool with decoys rising no faster than facts, or recall@15 at least +15 points over the no-intent
lexical path with the same decoy clause; confirmed on fold B; reported on M2's test split. Go or stop the same day.

## 5. The owner's final scope (2026-11-11, relayed): no embeddings, so TwinSlot v1 is withdrawn

The owner ruled out dense vectors of any kind (asym, bi-encoders, token vectors, anything retrieving by vector
similarity) and asked for one novel, hyper-optimised model: far more facts handed at @5 against shipped, decoys and
neutral packets **down**, microseconds a request, negligible ingest, tiny memory a user. TwinSlot v1 (§1) carries
d-vectors in its slots and a token-embedding table, so it was stopped before its first full run read (the asym and
sparse tracks and every Modal job with them; their numbers stay in m3-retriever.md as references).

### FrameRank (D906): frames, symbolic channels and a small learned ranker over integer features

- **Ingest: a frame an item** (`m3r/frames.py`, regular expressions and closed lexicons, no model): its terms (a
  counter), title terms, normalised dates (day of year), amounts, e-mail addresses and capitalised names, a thread
  key (title without Re:/Fwd:), the sender, the header date, kind and an automated-sender flag, and two bit fields:
  **status** (cancelled, done/paid, moved, on hold, negation, cleared/resolved, away, closed) and **obligation**
  (must, approval, deadline, limit, policy, ask). Per user: inverted indexes over terms, days, names, threads and
  senders, and each item's **twin partner** (its most term-similar item, Jaccard over its 40 rarest terms).
- **Request: a frame too** (terms, days, amounts, names, a verb class, status and obligation bits).
- **Candidates from five symbolic channels** (bit per channel): BM25 over the terms (40), items naming a day the
  request names (25), items naming a person it names (25), the threads and senders of the lexical head (20), and a
  **learned term-pair table** (request word → item words with a scalar weight each, learned from the training
  pairs; m3r/qexpand.py) searched as an expanded BM25 (25). No vectors: every weight is a number on a symbol pair.
- **Ranker:** gradient-boosted trees (LightGBM, binary objective, 400 trees of 31 leaves) over 48 integer and flag
  features a (request, candidate) pair: lexical (BM25 quantised, ranks, coverage, title hits, the learned table's
  score), date comparators (same day, days apart, the item's age, future-dated), amount comparators (equal, above),
  shared people, the item's status and obligation bits crossed by the trees with the request's verb class and bits,
  **twin contrast** (the partner's overlap, the status bits that differ, which is newer, whether the partner clears
  what this item asserts or the reverse), **supersession** (a newer item in the same thread that cancels, clears or
  moves it; whether this is the thread's newest), **graph** (links to the lexical head by thread and sender, the
  channel bits). The score is an absolute probability, so a threshold can keep a request silent.
- **Request-time path:** five index lookups, then per candidate (about 95) 48 integer features and 400 trees of
  depth ≤ 9: about 4,000 comparisons a candidate, about 0.4M a request [EST], **well under a millisecond** in a
  TypeScript port (the trees are arrays of thresholds and child indices). **Ingest:** a few regular expressions an
  item and index appends. **Memory:** frames as ids and bit fields (no floats except the learned table and the
  trees, shared by all users).
- **Ablations:** each feature group out (`--ablate lex,date,amount,people,status,twin,supersede,graph,kind`) and
  the learned channel out.

## 6. The neural, binarised track (D907): TwinXor and a family of on/off networks

The owner's final form: a learned network, trained end to end, with discrete internals; explore many architectures,
each for one spot in Eden, test each cheaply on CPU (a small slice, a Haiku subagent running it) before any full
training; push the binarised (on/off) concept across several spots.

**Spots in Eden's pipeline and the network tried for each** (`m3r/binnet.py`, each with a float twin, `--float`):

| spot | where in Eden | network |
|---|---|---|
| ranking the handed five, twin rejection, silence | the push's candidates (`candidatesOf`) | `pair`: request × candidate × its corpus twin, binary layers, a NULL head |
| twin pathway's worth | the same | `notwin`: `pair` without the twin inputs |
| item understanding at ingest | the card's constraint test (`constraintLike`) | `tagger`: item alone → constraint or not, one stored bit |
| the push or silence decision | whether a candidates packet goes | `silence`: request + its first five candidates as a set (majority-vote pooling) |
| recall without shared words | the pool's reach | `keys`: K learned discrete keys an item and a request (argmax, straight-through), exact lookup |

Common to all: text as hashed word and character n-grams (2^16 buckets locally, 2^18 on Modal), no tokenizer and
no pretrained weights; a ternary first layer (weights −a/0/+a) into a sign code; binary later layers (±1, scale
folded); straight-through estimators.

**The CPU kernel, measured** (`m3r/xnor-bench.ts`, plain TypeScript, random weights of the trained shapes, this
container while three cores ran the data export, so an upper bound): an item's 128-bit code from 300 n-gram ids
through a ternary table held as two bit-planes **60 µs**; a candidate's score (640 input bits through 128 and 32
binary neurons by XNOR-popcount, an int8 head) **6.1 µs**; a request with 95 candidates **0.59 ms**. Memory: **48 KB a
user** at 3,000 items (16 bytes a code), 2.1 MB of shared model (the ternary table's two planes dominate).

## 7. Hypotheses (step 1 of the owner's process, written before the round-1 results were read)

The process: hypotheses → a first Haiku test round (each a small local training on a slice, run by a Haiku
subagent) → develop those with signal → a second round → winners → full training on Modal, wiring, funnel and Pi.
Shared ground rules for every entry: no pretrained weights, no embedding table, no vector retrieval; text as hashed
n-grams; CPU microseconds at request time. Slices: export_groups.py's fold-A groups (train1–4, generated families, M2
train), held out on train5–6's days requests (157 hidden, 148 control), unless said. "Kill" is fixed now.

| # | hypothesis | spot | architecture | why it could work | kills it (round 1) |
|---|---|---|---|---|---|
| H1 | **TwinXor**: a binarised cross-scorer picks the fact among the candidates and rejects its twin | top-5 ranking, twin rejection | request × candidate × its corpus twin as XNOR/AND bit patterns, two binary layers, a NULL head (`binnet.py pair`) | reading request and item together compares them, which a stored-vector dot cannot; the twin pathway sees what differs from the nearest look-alike | fact@5 among candidates not above the lexical order's (86 of 147 in the smoke) |
| H2 | binarisation costs little | the same | H1 with float weights and tanh codes (`--float`) | the decision depends on a few bits (status words, dates) | (a reference: H1's cost is H2 − H1) |
| H3 | the twin pathway earns its place | twin rejection | H1 without twin inputs (`notwin`) | if H1 ≈ H3 the corpus twin adds nothing | — (an ablation) |
| H4 | an item alone says whether it is a constraint (ingest understanding) | ingest; the constraint test | a binary byte-n-gram tagger, one stored bit an item (`tagger`) | facts carry constraint wording; twins carry the all-clear | AUC fact vs others < 0.75 |
| H5 | the push/silence decision can be learned from the request and its first five candidates as a set | push or silence | binarised set network, majority-vote pooling (`silence`) | a control request's five candidates hold only the all-clear twin and noise | AUC hidden vs control < 0.6 |
| H6 | learned discrete keys reach facts that share no word with the request | no-word-overlap recall | items and requests → 4 keys of 256 codes each, argmax with a straight-through estimator, exact lookup (`keys`) | a key learned from "pay"-requests and "invoice paid" facts groups them without shared words | facts keyed among those outside the lexical candidates ≤ 10% at ≤ 300 keyed items a request |
| H7 | **BloomMatch**: which request n-grams occur in an item, as a bit pattern, is enough to score | top-5 ranking, twin rejection | each item a 2,048-bit Bloom filter of its n-grams (ingest); a request's n-grams probe it, bucketed into 256 match bits; the item's twin probed too; binary layers over [match, request, match XOR twin-match] (`bloom`) | explicit term matching in bits, with the twin's difference as a learned contrast; per candidate only bit tests | fact@5 not above the lexical order's |
| H8 | request intent (which kind of constraint to look for) is predictable from the request alone, in any language and phrasing | request intent and phrasing | binary char-n-gram classifier → M2's 16 archetypes (`intent`; M2's train/val worlds, every style and language) | archetypes have phrasing tells ("book", "pay", "should I") | accuracy on M2's held-out split ≤ 2× the majority class |
| H9 | supersession and change detection need item pairs with revisions | change detection, supersession | a binary pair tagger over (older, newer) items of a thread | M2 marks `revisionOf` | **not tested in round 1**: the exported slices carry no revision pairs (M2's raw worlds do; deferred to round 2 if a slice is built) |

### 7a. Round 1 (Haiku subagents, local CPU, one thread each; fold A slice: 40 worlds, 3 epochs; held out train5–6)

Reference on the same held-out requests, the candidates in their lexical order: of 147 hidden requests with the fact
among the candidates, fact first 64, in the first five 86; of 148 control requests, the twin in the first five 66.

| # | network | held-out signal (per epoch) | reading |
|---|---|---|---|
| H1 | pair, binary | fact@5 82 / 60 / 51, fact@1 27 / 23 / 12, twin@5 **31** / 18 / 27 | **signal on twins**: after one epoch, facts in the five 82 against 86 and twins 31 against 66; then it memorises the slice. Develop: lexical prior bits, held-out checks during training |
| H2 | pair, float | fact@5 74 / 45 / 49, twin@5 24 / 11 / 23 | the same shape, no better than binary at this size |
| H3 | pair without the twin pathway | fact@5 84 / 45 / 31, twin@5 30 / 31 / 25 | epoch 0 like H1 (82, 31): no evidence yet that the twin pathway earns its place |
| H4 | tagger, binary | AUC fact against others 0.863 / 0.866 / 0.865 | signal; fact against its own twin not yet separated (round 2 reports it) |
| H5 | silence, set classifier | AUC hidden against control 0.567 / 0.532 / 0.534 | **kill** (bar 0.6): the first five lexical candidates as a set do not say whether to push; the pair scorer's NULL head carries the decision instead |
| H6 | discrete keys | facts keyed 5 / 2 / 9 of 157 at about 22–27 keyed items a request; of the 10 facts outside the symbolic candidates, 0 / 0 / 1 | **kill** (bar > 10%): and the spot has little room here (the channels hold all but 10 held-out facts) |
| H7 | BloomMatch, binary | fact@5 56 / 34 / 50, twin@5 30 / 21 / 31; loss still falling (2.2) | weak signal on twins, short of facts; develop with prior bits |
| H8 | intent → 16 archetypes (M2 v0) | accuracy 0.197 / 0.198 / 0.199 / 0.195 / 0.193 against majority 0.094; train loss → 0.02 | **marginal** (bar 2× majority = 0.188): memorises families; once more on M2 v1 (3,505 families) in round 2, else kill |
| H9 | supersession pairs | not run (no revision pairs in the slices) | deferred |

**Round 2 (developed):** H1 and H7 with prior bits (the candidate's lexical position and FrameRank's 48 comparators,
bucketed: they re-rank rather than rank from nothing), one epoch over 150 worlds, held-out checks during training (the
best kept); H4 with fact against its own twin reported apart.

### 7b. Hypotheses added after the owner's second steer (written before their first results)

Each spot gets its own metric, baseline and bar. Data: M2 v1 (1,455 / 174 / 181 worlds, split by family), held out on
its val split unless said; or fold A's groups as before.

| # | spot | network | metric and baseline | bar (keep if) |
|---|---|---|---|---|
| H10 | supersession, change detection | binary pair network over (older, newer) item texts → "newer replaces older"; positives M2's 1,536 `revisionOf` pairs, negatives the reversed pair, (fact, twin) and (fact, neutral) of the same task (same topic, no replacement) | AUC replaces against not on M2 val; baseline: the Jaccard similarity of the two texts as the score | AUC ≥ 0.85 and ≥ baseline + 0.10 |
| H13 | ingest understanding (H4's successor) | binary multi-task item tagger: one item → fact / the twin's kind (superseded, other-entity, resolved, other-period, already-met) / neutral / other | AUC fact against its own twin on M2 val (H4 could not say); baseline 0.5 | AUC fact vs twin ≥ 0.75 |
| H14 | push or silence (H5's successor) | H1's own NULL head (calibrated abstention), no separate net | silence on control requests at the margin where 95% of hidden requests with the fact in the candidates still speak | ≥ 50% of control requests silent |
| H15 | request understanding (anchors, phrasing) | — | — | **not built**: no anchor labels (person, thing, date) in M2 v1 or the exports, and P7's reworded suites are not in this tree; intent (H8) stands for it |
| H6′ | no-word-overlap recall where room exists | H6 on M2 v1 | first measure the room: M2 test facts outside BM25's top 50 | room ≥ 10% of facts, then H6's bar |
| H1+ | top-5 ranking (the owner's targets: twin@5 near 0, fact@5 high 130s of 147, silence on nearly all controls) | H1 scaled: 256 bits, wider layers, M2 v1 + generated families + train, hard-twin curriculum, multi-task with H13 | fold A held out | step 6 |

### 7c. Round 2 results so far (developed versions; fold A held out unless said)

| # | network | round-2 signal | reading |
|---|---|---|---|
| H1 | pair + prior bits (150 worlds, 1 epoch, checks every 50 steps) | fact@1 55 / 59 / **69** (lexical 64), fact@5 97 / 97 / 96 (86), twin@5 70 / 69 / 69 (66), silent controls 112–128 of 148 | facts up +10 in the five and +5 first, **twin rejection lost**: the prior bits lift a twin exactly as its fact. Developed again: a multi-task constraint head on the item codes (fact against twin on every planted item), its bit an input beside the prior (`--aux`) |
| H7 | BloomMatch + prior bits | fact@5 **100** (86), twin@5 71 (66) | facts +14, twins +5 (ratio 1.16 against 1.08); how much of it is the prior bits alone is step 6's ablation |
| H4 | tagger, 150 worlds, 3 epochs | AUC fact against **its own twin 0.72 / 0.72 / 0.73**, against other items 0.94 / 0.94 / 0.92 | **keep**: the item alone separates a fact from its all-clear twin on unseen families (D491's distilled cross-encoders: 0.45–0.55) |
| H10 | supersession (my own 18 s check: M2 v1, 1/20 of train, 1 epoch) | AUC 0.911 against the Jaccard baseline's 0.785 on M2 val | above its bar already; full test runs (binary and float) running |
| H10 | supersession, float twin (M2 v1, half of train, 4 epochs) | AUC replaces **0.968 / 0.977 / 0.983 / 0.988** against Jaccard's 0.785 on M2 val (2,996 pairs, 188 replacements); at threshold 0: precision 1.0, recall 0.44–0.49 | **keep** (bar 0.85 and baseline + 0.10); the threshold is to be set for recall; binary run pending |
| H13 | multi-task item tagger, binary (M2 v1, half of train, 3 epochs) | AUC fact against **its own twin 0.938 / 0.933 / 0.935**, against neutral 0.995, against other 0.995; per-tag accuracy fact 0.91, neutral 0.83, other 0.84, the twin kinds 0.0–0.45 | **keep** (bar 0.75), on M2's held-out families; the twin's *kind* is hard, whether an item is a constraint is not. Transfer to the sim's held-out families (fold A) is being tested |
| H1 | pair + prior bits + multi-task constraint head (`--aux`, weight 2) | fact@1 53 / 61 / 66, fact@5 98 / 100 / **107** (lexical 86), twin@5 70 / 70 / 73 (66), silent controls 110 / 108 / 132 of 148 but only 28 hidden requests speak | the best ranker: facts in the five **+21** (ratio 1.24 against twins' 1.11); twin rejection still not back and the NULL head too strong (silent on 119 hidden) |
| H10 | supersession, binary | AUC 0.934 / 0.917 / 0.927 / **0.943** (float 0.988; Jaccard 0.785), precision 0.97–1.0 at threshold 0, recall 0.37–0.45 | **keep**: binarisation costs 0.045 AUC here |
| H13 | the M2-trained tagger on the sim's held-out families (fold A, 157 facts and 148 twins) | AUC fact against twin 0.747 / 0.776 / 0.767 (the sim-trained H4: 0.73; on M2's own held-out families 0.935) | **keep**: transfers, short of its in-distribution level; train on M2 v2 + sim + generated families together |

### 7d. Step 5: the winners (each against its own bar)

| # | spot | round 1 | round 2 | keep or kill |
|---|---|---|---|---|
| H1 | top-5 ranking (fold A held out; lexical: fact@5 86, twin@5 66) | fact@5 82, twin@5 31 (no prior) | fact@5 **107**, twin@5 73, fact@1 66 (prior + multi-task) | **keep**: step 6 targets twin rejection with the prior on |
| H7 | top-5 ranking, Bloom filters (cheapest per candidate) | fact@5 56, twin@5 30 | fact@5 100, twin@5 71 (prior) | **keep** as the cheap variant; ablate the prior bits alone |
| H4 → H13 | ingest understanding (constraint or all-clear) | AUC fact vs others 0.865 | fact vs its twin **0.938** on M2's held-out families, 0.767 on the sim's (M2-trained), 0.73 (sim-trained) | **keep** |
| H10 | supersession, change detection | (deferred) | AUC **0.943** binary, 0.988 float (Jaccard 0.785) | **keep** |
| H14 | push or silence via H1's NULL head | — | silent controls 132 of 148 but 119 of 147 hidden silent too | **develop in step 6**: report silence at fixed fact recall from the margins |
| H2 | binarisation's cost | float ≈ binary (pair) | float 0.988 against binary 0.943 (supersession) | measured: about 0.05 AUC |
| H3 | the twin pathway | no gain at epoch 0 | — | dropped from step 6 (ablation only) |
| H5 | silence as a set classifier | AUC 0.567 | — | **killed** |
| H6 | discrete keys | 1 of 10 unreachable facts | — | **killed** here (no room); H6′ to test on M2's rare-source facts |
| H8 | intent from the request | accuracy 0.19–0.20 (majority 0.094) | — | **killed** for now (2.1× majority, memorises families) |

### 7e. Step 6: full trainings on Modal (8-core CPU containers, no GPU)

**H13, the ingest tagger** (M2 v2 train, 2,128 worlds, plus fold A's sim and generated-family items; 256 bits; 4
epochs; held out: M2 v2 val families and the sim's train5–6):

| version | fact vs its own twin, M2 val | fact vs twin, sim fold A | fact vs neutral / other (M2) | fact recall |
|---|---|---|---|---|
| binary | 0.947 / 0.946 / 0.947 / 0.944 | 0.731 / 0.773 / 0.759 / 0.765 | 0.995 / 0.997–0.998 | 0.91–0.93 |
| float | 0.957 / 0.957 / 0.954 / 0.953 | 0.744 / 0.756 / 0.754 / 0.750 | 0.995–0.997 / 0.997–0.998 | — |

Binarisation costs about 0.01 AUC. On M2's held-out families the item alone separates a fact from its all-clear twin at
0.95; on the sim's held-out families at about 0.76, and the sim's own items in training do not lift that (the earlier
M2-only tagger: 0.767). The sim's train5–6 twins differ from their facts in ways an item-only reading catches less often.

**H10, supersession** (M2 v2, float, 6 epochs): AUC 0.990 / 0.986 / 0.980 / 0.979 / 0.981 / 0.979 against Jaccard's
0.791 (4,662 val pairs, 297 replacements); at threshold 0 precision 0.99–1.0, recall 0.39–0.52. Rerun with recall at
fixed precision (0.95, 0.90), binary and float.

**H10 rerun with recall at fixed precision** (M2 v2, 2 epochs, 256 bits; 4,662 val pairs, 297 replacements):

| version | epoch | AUC | recall @ precision 0.95 | recall @ precision 0.90 | recall at threshold 0 |
|---|---|---|---|---|---|
| float | 0 / 1 | 0.990 / 0.986 | 0.737 / **0.815** | 0.822 / 0.842 | 0.471 / 0.465 |
| binary | 0 / 1 | 0.952 / 0.965 | 0.609 / **0.710** | 0.667 / 0.737 | 0.434 / 0.515 |

The parent's recall push: the low recall was the threshold, not the model. Set for 95% precision, the float net catches
82% of silent replacements and the binary one 71%; binarisation costs 0.10 of recall here (the tagger lost 0.01 AUC).

**H1 and H7 at full scale, fold A** (437 worlds, 2 epochs, prior bits; H1 also the multi-task head, 256 bits and width).
Counts on the held-out requests whose fact is among the candidates (147) and the 148 controls:

| run | fact@1 | fact@5 | twin@5 | silent controls | hidden that speak |
|---|---|---|---|---|---|
| lexical order | 64 | 86 | 66 | — | — |
| H7 BloomMatch, epoch 0 / 1 | — | 98 / 105 | 76 / 73 | 136 / 124 | 14 / 34 |
| H1, checks at 150 … 750 steps | 67 / 67 / 62 / 63 / 53 | 108 / 107 / 106 / 105 / 96 | 69 / 71 / 68 / 68 / 56 | 122–143 | 21–32 |
| H1, end of epoch 0 / 1 | 59 / 56 | 110 / **109** | 74 / **59** | 130 / 137 | 30 / 23 |

Against the pre-registered bar (all 157 held-out hidden requests; the shipped default's pool, `--at5 --key all`):
H1 alone holds 109 facts in its five against the shipped pool's 123 (its candidates have no intent hits) with **decoys
83 → 59 (−29%)**; fused with the shipped pool (k 5) facts 133 (+6.4 points) and decoys 87: **fail** on both bars. The
ranker hands a cleaner five than the shipped pool but not more facts; fused, it adds facts and loses the decoy cut.

**H1 with the hard-twin curriculum and a fact-over-twin margin** (40% of hidden training templates keep their twin;
margin 1.0, weight 1.0; otherwise as above):

| check | fact@1 | fact@5 | twin@5 | silent controls |
|---|---|---|---|---|
| 150 / 300 steps | 56 / 54 | 95 / 103 | 48 / 67 | 131 / 126 |
| end of epoch 0 | 53 | 98 | 54 | 140 |
| 450 / 600 / 750 steps | 56 / 47 / 52 | 99 / 83 / 93 | 62 / 47 / 50 | 122–125 |
| end of epoch 1 | 48 | 82 | 48 | 142 |

The margin moves the ranker along the same trade-off, twins down by giving up facts (47–54 twins at 82–98 facts,
against 59 at 109 without it); it does not escape it. Reading: what separates a fact from its twin on the sim's held-out
families is about AUC 0.75 even read from the item alone with all the data (§7e), and the pair net adds little to that.
The owner's targets (twin@5 near 0, fact@5 in the high 130s) are not reachable from these signals on these families.

### 7f. Pre-registered rules for wiring (committed before any of these results; decided the same day, D814)

Baseline: main e4f3649a (the push check S and `pushIndirect` in the default). Trials compare `default` against
`default + <switch>` on the same runs.

1. **Supersession (`pushSupersede`, H10).** When a handed candidate has a newer item in the user's cache, sharing one
   of the request's anchors, that H10 says replaces it, the newer item goes in its place. Measured on main's funnel
   over M2's held-out worlds (`synth-val`; its late and silent-change tasks hold a newer item replacing an older one):
   **stale versions handed down at least 50%, facts handed not down by more than 2%.** `days-calls --recap-notice none`
   is reported as a control only: its silent changes edit the same item in place, which H10 does not see.
2. **Ingest tag (`constraintTag`, H13).** The tag bit joins `constraintLike` in the push gate (a candidates packet goes
   only when a pooled item is tag-positive or card-positive). Funnel on train: **packets on control and neutral requests
   down at least 20%, hidden facts surfaced not down by more than 1%** against e4f3649a.
3. **Ranker (`pushRetrieve` successor, H1).** §1b's @5 bar against the shipped pool on fold A's held-out families: facts
   @5 at least +10 points, decoys rising no faster than facts.
4. **Supersession as a rank-time demotion (the parent's steer 2), offline screen first.** For the shipped pool's first
   five, an item a newer cached item replaces or clears (H10, anchor-sharing items only) moves behind the five: **twins
   @5 down at least 15% with facts @5 not down by more than 2**, on fold A's held-out days requests. Expected: little or
   nothing in the sim, whose twins are planted alone (no clearing item exists in the world); reported either way.

Float or binary: whichever wins held out at under 1 ms a request in TypeScript; both timings reported.

### 7g. H1's own bar (the owner's, pre-registered before any variant below is screened)

Against the shipped pool on held-out families never trained on (fold A, and fold B or M2 v2's test split, not tuned
on), all of: **facts @5 ≥ 135 of 157** (shipped 123), **decoys @5 ≤ 42** (shipped 83), **≤ 1 ms a request** in the
TypeScript forward, **≤ 4 MB of shared model**, no embeddings, and its silence head **loses at most 5** of the hidden
requests on which the shipped pool speaks. A variant that clears it on the screen goes straight to wiring and a Pi pair
against main e4f3649a.

**Amendments to §7f, before any of their results** (both found while wiring):

- **Rule 2 (ingest tag) is a veto, not an OR.** As written ("the tag bit joins `constraintLike`… a pooled item is
  tag-positive or card-positive") it could only add packets, against its own goal of fewer. The trial is
  `constraintTag` (a threshold; 0 off): a pooled item counts as constraint-like only when it passes the existing test
  **and** the tagger's constraint probability is at least the threshold. The rule's numbers stand (packets on control
  and neutral down ≥ 20%, hidden surfaced not down > 1%, funnel train against e4f3649a; the train5–6 rows, which the
  tagger never trained on, reported apart).
- **Rule 1 (supersession) cannot be read on `synth-val` as it stands.** In all 297 of M2 v2 val's silent-change
  tasks the older version is the task's decoy, and the synth suite plants the fact *or* the decoy, never both: no
  request ever meets a stale version beside its replacement. Reading the rule needs a variant that plants both (the
  older version as background beside the fact); raised with the parent before building it.

### 7h. Results of the wiring rules and of H1's screen (2026-11-11)

**Rule 2, ingest tag (`constraintTag`, D908): passes.** The fold-A binary tagger (`w-tags-bin`: M2 v2 train plus the
sim's train1–4 planted items, 3 epochs, 256 bits; fact against twin AUC 0.947 on M2 val, 0.759 on the sim's held-out
items), exported to TypeScript (`tags-bin`, max error against PyTorch 0), read in the push gate as the probability of
its `fact` tag; θ 0.5 was fixed in a commit before any funnel run (e6aef109). `bun run funnel --jobs 2 -- --neutral`
on this branch, switch off (= main e4f3649a's behaviour; no checker wired, reader stub) against
`--set '{"constraintTag":0.5}' -- --tagger .local/m3/nets/tags-bin`, train1–6, seeds 41–42, $0:

| | all (384 a variant) | train1–4 (trained on) | train5–6 (held out) |
|---|---|---|---|
| hidden surfaced | 281 → 281 | 181 → 181 | 100 → 100 |
| hidden delivered by the push | 265 → 263 | 170 → 169 | 95 → 94 |
| control packets | 490 → 343 (−30.0%) | 321 → 204 | 169 → 139 (−17.8%) |
| control tasks with a candidates packet | 380 → 134 | 254 → 44 | 126 → 90 |
| decoy delivered by the push | 243 → 125 | 167 → 70 | 76 → 55 |
| neutral packets | 459 → 150 (−67.3%) | 310 → 107 | 149 → 43 (−71.1%) |
| **control + neutral packets** | **949 → 493 (−48.1%)** | 631 → 311 (−50.7%) | **318 → 182 (−42.8%)** |

The rule's bar is −20% packets with hidden surfaced not down more than 1%: met overall and on the held-out suites
alone. The lab tagger encoded 492 distinct items in 377 ms in that run (0.77 ms an item with the funnel's lanes contending for 4 cores); the engine's own bench reads 266–307 µs an item alone (`bench/tagger.bench.ts`, D908). Not yet measured:
the pair with the push check S live in front (the shipped path with a key; pre-registered in commit after e6aef109,
running), and Pi.

**Rule 1, supersession (`pushSupersede`), amended before any result.** (a) The suite: `synth:<M2 v2 val>+stale`
(`+stale`, D884's synth family, a separate option: a hidden silent-change task's earlier revision stays as a background
item beside the fact; the default suites are unchanged, `synth.test.ts` pins it), worlds H10 never trained on. (b) The
newer item is looked for in the push pool (15), not the whole cache: both versions match the request, and a cache-wide
search per handed item would be a second lookup. (c) Arms: off, binary H10 at θ 0.5, float H10 at θ 0.5 (θ fixed
here, not read from val). Read: stale versions handed (`staleHanded`) down ≥ 50%, facts handed (`pushHanded`) not
down > 2%; recall@p0.95 of each export reported from its own offline run beside them.

**Rule 1 result: fails; `pushSupersede` deleted (code in 3a74a4c4).** `bun run funnel --suite
'synth:.local/m3/m2v2/worlds-val.jsonl+stale@4' --seeds 1..25 --jobs 2` (738 hidden tasks, 98 with a stale version;
intent inert: no card replay covers synth worlds, the same in every arm; $0):

| arm | stale handed | facts handed (`pushHanded`) | hidden surfaced | decoys handed (control) | per pair |
|---|---|---|---|---|---|
| off | 64 of 98 | 457 of 738 | 580 | 356 | |
| binary H10, θ 0.5 | 51 (−20%) | 457 | 579 | 355 | 47 µs (6,096 pairs, 285 ms) |
| float H10, θ 0.5 | 52 (−19%) | 458 | 579 | 355 | 48 µs |

The bar was −50%. In 63 of the 64 stale hand-outs the fact was in the same pool, so the newer item was there to
swap in: the pair model (with the anchor gate on the newer item) replaced 13. End to end, then, the pair reads
"replaces" on about one stale/fresh pair in five of the sim's planted worlds, far under its offline recall on M2 val
(binary recall@p0.95 0.71, AUC 0.965; float 0.815, 0.986). M3b's compression work (claude/m3b-h10) inherits this
measurement and the `+stale` suite; a better H10 re-enters as a new trial against the same rule.

**H1, set-level variant (Haiku round, local CPU slice, 150 worlds): killed.** On fold A's held-out train5–6 days
requests (`score.py --at5 --key all`, eval-ship) its own ranking hands facts@5 33 of 56 against the shipped pool's
47, and every fusion with the shipped pool is below the shipped pool (hyb10: 45 facts at 27 decoys against 47 at 26).
Far from D909's bar; not taken to Modal.
