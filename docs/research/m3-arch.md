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
