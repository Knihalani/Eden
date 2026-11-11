# M11: intent micro-expansion, a $0 model in place of Haiku's intent requests

Status: 2026-11-11, branch `claude/m11-intent`, session M11. Decisions D970–D979. Train suites, reworded train,
longtail and held-out 10/11/13/14 only; held-out 15–19 not read or run. Numbers marked **[EST]** are arithmetic or
judgement; every other number comes from a command in this note.

## 0. Why

The intent index (D87) finds an item by the requests it would answer, written by Haiku in the card call. Full
coverage roughly doubles Eden's edge over a top-5 retrieval push (D831: +25.8 points against +13.5 at shipped
coverage), but shipped coverage reads only part of a user's items (D877) because every request costs a call. The bet:
a tiny learned model that, for every item at ingest on CPU, predicts weighted request-vocabulary terms to index in
its place. It generates no text: hashed n-grams in, weighted terms out (learned sparse expansion without pretrained or
dense embeddings). Earlier kills this must not repeat: a distilled generative intent model (D446), pruning requests by
overlap with the item (D480), a query-side expansion table that lifted look-alikes faster than facts (M3, §3c of
m3-retriever.md), and a tagger whose wins came from "short = unimportant" (D908).

## 1. Pre-registration (committed before any trained model's funnel result was read)

**Data and split** (`packages/sim/lab/m11/data.py`, fixed now). Items and their recorded Haiku requests come from
`m11-export.ts` over train1–6, train1r–6r, longtail (seeds 41–44) and held-out 10, 11, 13, 14 (seeds 41–44), joined
to `intent-v2.jsonl.gz` (every item read) and `cards-shipped.jsonl.gz`. Held out from training: every item planted
in a train5, train6, train5r, train6r or longtail world (any seed), and every item of a seed 41 or 42 world (the
funnel's seeds, so no screened world's background was trained on). M2 v2's train split joins training when it is
here; its test split is screened, never trained or tuned on.

**Reference points, measured at $0 on main (`bun run funnel --jobs 4 --suite S -- --neutral`, seeds 41–42).**
Held-out families: train5 + train6 hidden 100 / decoys 82 of 128; train5r + train6r 96 / 77 of 128; longtail
30 / 28 of 64; pooled **226 / 187 of 320**, neutral packets 149 + 139 + 44 = 332. A ceiling: Haiku's own every-item
requests replayed as the expansion (`intentMicro` 1, `oracle-haiku.json`) read hidden 300 / decoys 252 on all of
train against main's 281 / 264 (train5–6: 110 / 80 against 100 / 82).

**The bar (arm A: `intentMicro` 1, the expansion on every item, no requests from the card calls)**, against main at
shipped coverage, pooled over the held-out families above (n = 320 hidden tasks), all of:

1. hidden surfaced at least **+16** (+5.0 points);
2. decoys rising no faster than facts: decoys_after / decoys_before ≤ hidden_after / hidden_before;
3. neutral packets on the held-out families' neutral variants not above main's (332).

The same three are reported on M2 v2's test split (`synth-test`) when its data is here, and on train1–4 (trained-on
families) apart. Arm B (`intentMicro` 2: the expansion only where the card calls gave no requests) is reported
beside A for the parent; the bar is read on A, and B is promoted instead only if it passes the same three clauses.

**Hard gates (any arm):**

- **Twins.** On the held-out families' twin pairs (hidden fact and control look-alike of the same template and seed,
  screen seeds; 304 pairs), a pair fails when the look-alike's expansion holds a request term that is not in its own
  text and not in its fact's expansion. At most **1% of pairs (3 of 304)** may fail. For reference Haiku's own
  requests fail 36 of 304 this way (`screen.py`).
- **Short items.** Of the 52 short constraints of `packages/sim/lab/m3r/short-constraints.jsonl`, at least 50 get
  three expansion terms or more, and their mean term count is at least half the mean of held-out items of 400
  characters or more.
- **Size, speed, growth.** At most 1 ms an item at ingest in the TypeScript forward (one core), at most 4 MB of shared
  model, and expansion terms (repeats counted) at most the item's own distinct terms on average over held-out items
  (the index at most 2x).

**Pi pair (only if the funnel bar and the gates pass):** default against default + `intentMicro` 1 on held-out
families, pre-registered in its own commit before the run; hidden facts' clustered lower bound > 0 and confirmed
concerns not up by more than 1 per 1,000; cap $8.

**Decision (D814), the same day:** pass → `intentMicro` 1 (or 2) joins `DEFAULT_CONFIG` with a `PARTS` entry and a
COST-MODEL entry; fail → the switch, the model and their tests are deleted.

### 1a. Amendments (committed before any model was selected on a held-out read)

1. **Validation families (the parent's M6 lesson).** Planted items of train3, train4, train3r and train4r are held
   out of training too and are the selection set (`VAL_SUITES`): every round picks on them and on the offline screen
   over them, never on the held-out families. `funnel_arms.py` hides the held-out rows unless `--held`, which is
   passed once, for the bar. Read before this amendment and not used for any choice: one 2-epoch smoke model's
   held-out funnel rows and the Haiku replay ceiling (§1).
2. **The owner's bar: Haiku is cut out, and the replacement must beat it.** The funnel bar of §1 stands (arm A
   against main, which is Haiku's requests at shipped coverage). The Pi pair is **micro against Haiku**: hidden facts
   point estimate at least +1 point, clustered lower bound > 0, confirmed concerns no higher. The headline is the
   joint "no Haiku at ingest" arm with M10's micro cards, which must beat the shipped Haiku cards + intent arm. If no
   candidate beats Haiku after two development rounds, the switch is deleted and the note reports the numbers; no
   downgrade ships.
3. **M2 v2.** 600 train worlds and the val split (side branch `claude/m-synth-data`) join training and selection
   (`m11-synth.ts`: each fact with its English requests as the target, its decoy and neutrals as negatives). The
   sim's held-out families stay the bar; `synth-test` is read once at the end and reported apart.

## 2. Hypotheses (step 1, written before the round-1 results)

Shared: no text generation, no pretrained weights or embedding tables, inputs as hashed word, character 3/4-gram and
word-bigram ids (M3's `grams`), outputs as weighted engine-stemmed terms (a request term's CRC-32 bucket for the
generated part, the item's own stems for the copied part). Screened offline first (`screen.py`: fact and look-alike
at @5/@15 with the lexical list fused, the twin gate, growth), then in the funnel early (M3's lesson: offline
overstated live).

| # | hypothesis | architecture | why it could work | kills it (round 1) |
|---|---|---|---|---|
| H1 | a co-occurrence table is enough | item word → request-term lift, summed (no training loop) | doc2query's gain is mostly a few recurring bridges | fact@5 below lexical (180 of 304) on the offline screen |
| H2 | multi-label prediction over request vocabulary | hashed grams → mean table → ReLU → sigmoid over 2^14 buckets | fastText-style: learns which action terms an item's kind draws | generic terms only (the same top terms for every item) |
| H3 | **CopyGen**: requests are mostly the item's salient words plus a few action words | a copy head scoring each of the item's own stems (its hashed grams, position, title, count, the item's context) and a generation head over buckets for terms the item lacks | Haiku's requests are about half the item's own terms (15,283 of 28,990 targets) | offline fact@5 not above lexical |
| H4 | per-word sparse expansion (SPLADE without a pretrained encoder) | each word's grams + the item's context → shared head over buckets, log-saturated, max-pooled over words | each term traceable to a word of the item; twins differ by a few words | as H3 |
| H5 | items fall into a few hundred situations, each with its request vocabulary | item → one of K learned codes (straight-through), code → term-weight vector, plus H3's copy head | discrete, compact, generalises across names | as H3 |
| H6 | train for retrieval, not reconstruction | H3's heads trained by in-batch ranking of each item's own requests (and, with M2, the fact over its look-alike) with a sparsity penalty | the funnel rewards rank, not term recall; look-alikes as negatives aim at the twin gate | twin gate fails or fact@5 not above H3 |
| H7 | names and numbers block generalisation to new families | H3 with inputs delexicalised (names, numbers, dates, money as class tokens) for the generation head | bridges are about constraint wording, not names | no held-out gain over H3 |
| H8 | short items need training as short items | H3 trained on each item also as its title and title + one sentence (same targets) | D908's lesson: length as a cue | short gate fails while H3's passes |
| H9 | the copy head alone (salience, no bridge) | H3 without generation | measures how much of Haiku's value is picking the item's words | (an ablation) |
| H10 | binarised kernel for size and speed | H3 or H6 on M3's ternary table → sign code → binary layer → int8 heads | M3's kernel: 60 µs an item, 2 MB | binarisation costing more than 10% of the float model's held-out gain |

## 3. Results

Everything here is $0 except the training labels (§3c). Funnel: `bun run funnel --jobs 4 --suite S --set
'{"intentMicro":M}' -- --neutral --micro FILE`, seeds 41–42, at main's shipped coverage. `--micro` replayed the
model's own expansion by card key, and `funnel_arms.py` read the JSONs. Both were deleted with the switch; the code is
in ff961a42. Main reads train hidden 281 / decoys 264 / neutral packets 459, validation (train3–4, 3r–4r) 93 / 85 /
153, and pooled held-out 226 / 187 / 332.

### 3a. Where Haiku's intent value is (offline, validation, `screen.py`)

The planted fact at @5, with the lexical list (BM25 over the item's own terms) fused with the intent list by
reciprocal rank (c 60). The intent list is the top 12 with idf coverage ≥ 0.2, the engine's cut. 256 hidden and 256
control tasks.

| intent text | fact @5 | fact @15 | look-alike @5 |
|---|---|---|---|
| none (lexical only) | 110 | 148 | 126 |
| Haiku, every item (intent-v2) | 165 | 205 | 154 |
| Haiku, shipped coverage | 159 | 191 | 154 |
| Haiku's terms the item also holds (copied) | 122 | 159 | 124 |
| Haiku's terms the item lacks (bridges) | 159 | 190 | 162 |

The value is the bridge terms. Of 256 validation facts, 174 are reached through a bridge term the request holds,
and those 308 bridge terms are diverse. Generic verbs (send 22, sign 12, add 10, book 6, order 6) sit beside domain
words (postgres, upgrade, login, region, redline, linkedin); 70% recur in training (df ≥ 3).

A ceiling: Haiku's own every-item requests replayed as the expansion (mode 1) read 300 / 252 on train, against main's
281 / 264.

### 3b. Round 1 (three Haiku helper sessions, CPU; table as reported to the parent)

The helpers ran under the original split: train3–4 in training, and their selection read the held-out rows before
amendment 1 reached them. No choice below was made on those rows.

| hypothesis | run | mode 1 train h / d | mode 2 train h / d |
|---|---|---|---|
| H3 CopyGen | a1; a9 (+H7 +H8) | 240 / 237; 242 / 238 | 282 / 258; 287 / 257 |
| H9 copy only | a2 | 238 / 240 | 278 / 258 |
| H5 codes | b1 | 239 / 241 | 277 / 255 |
| H10 binarised context | b3; b4 | 224 / 230; 235 / 231 | 285 / 262; 285 / 257 |
| small context (d 32) | b7 | 245 / 236 | 280 / 257 |
| H6 rank loss, twins | c2 | 242 / 241 | 283 / 258 |
| H4 SPLADE-lite | c6 | 224 / 226 | 286 / 261 |
| H1 PMI table | c7 | 250 / 249 (twin gate 30 of 304: fails) | 291 / 261 |

On reworded train, mode 1 read 215–223 against main's 262. Every mode 1 run loses 31–57 hidden facts on train. Mode
2 is within noise: hidden −4..+10, decoys −2..−9.

### 3c. Round 2 (selected on validation only)

Two data levers, since round 1 pointed at bridging:

- Haiku labels, with the shipped card + intent prompt (`m11-enrich.ts`, batches of 20, $0.000084 an item), for the
  1,712 planted items of 13 suites read long ago: hidden, heldout1–9, heldout12, dev6a, dev6b. That is about 400
  hand-written families in the sim's own style.
- Haiku labels for all 31,297 items of M2 v2's first 600 train worlds, used as pretraining (2 epochs) before the sim
  rows.

Spend: $2.43 in all, on the ledger `.local/m11/ledger.jsonl`, role `m11.intent`.

| run | what changed | mode 1 val h / d | mode 2 val h / d / np | bridge terms in the generation head's top 5 / 20 (of 308) |
|---|---|---|---|---|
| diag | CopyGen on the sim rows | 68 / 73 | 93 / 78 / 153 | 6 / 36 |
| diag-pf | expansion only on prefilter-passing items | 71 / 74 | 92 / 82 / 153 | — |
| ex2 | + 400 sim families, rank loss, twins | 72 / 73 | 90 / 78 / 154 | — |
| pre1 | + M2 pretraining (24,594 labelled items with requests) | 64 / 70 | 90 / 77 / 152 | 28 / 72 |
| d | pre1 decoded with bridges only (no copy) | 68 / 71 | 92 / 81 / 149 | — |

M2 pretraining makes bridging 4–5 times better, and mode 1 still gets worse. The expansion adds its terms to every
item. Haiku's shipped requests are written for the constraint-worded items, where the facts are. Adding M2's
fact-and-request rows directly (`m11-synth.ts`, decoys and neutrals as negatives) lowered validation too (fact @5 96
→ 75 offline). That is M6's lesson: synthetic text does not transfer to the sim's hand-written families.

### 3d. The bar, read once (pooled held-out families, n = 320; main 226 / 187 / 332)

| model (best on validation) | mode 1 h / d / np | mode 2 h / d / np |
|---|---|---|
| ex2 | 195 / 179 / 323 | 234 / 193 / 333 |
| diag | 195 / 176 / 317 | 232 / 185 / 334 |

Mode 1 loses 31 hidden facts (−9.7 points) and fails. Mode 2 gains +8 and +6 against the +16 the bar asks, and its
neutral packets rise by 1 and 2: it fails both clauses. The gates did not decide it. The twin gate (at most 3 of 304 pairs; Haiku's own requests fail 36)
held for the CopyGen defaults, codes, the small context and the copy-only model. It failed for most rank-loss,
binarised, PMI and SPLADE runs (4–30 pairs). The forward met the speed gate (0.63 ms an item); its 5.8 MB at 2^16
input buckets would have needed 2^15 to meet the size gate. `synth-test` was not
read, and no Pi run was made: the funnel bar failed first.

## 4. Decision (D970–D972)

- **D970, rejected and deleted.** `intentMicro`, `micro.ts`, the hidden-funnel `--micro` replay, the pi-ab and
  `buildPartner` wiring and their tests are gone; the code is in commit ff961a42 on this branch. Haiku's intent
  requests stay what ships.
- **D971, a finding.** Haiku's intent value is the bridge terms, and a $0 item-side model cannot learn them for new
  families from this much data. A later attempt needs one of three things. Prior knowledge would break the "no
  pretrained weights" rule. Far more hand-written families in the sim's style: 400 more moved nothing. Or a
  request-side lever, M12's ground.
- **D972, lab tooling kept.** `m11-export.ts` dumps items, worlds and Haiku requests by card key, with twins.
  `m11-enrich.ts` and `stem.ts` produce Haiku intent labels for any worlds, pay once. `m11-synth.ts` produces M2
  rows. `packages/sim/lab/m11/` holds `data.py` (the split), `screen.py` (offline screen, twin gate), `copygen.py`
  and `train.py` (all ten hypotheses), `decode.py`, `bridges.py`, `export.py` and `funnel_arms.py`.

## Reproduce

```bash
unset OPENROUTER_API_KEY
bun packages/sim/src/lab/m11-export.ts --suites train,reworded,longtail --seeds 41-44 --out .local/m11/sim
bun packages/sim/src/lab/m11-export.ts --suites heldout10,heldout11,heldout13,heldout14 --seeds 41-44 --out .local/m11/ho
python3 -I packages/sim/lab/m11/screen.py --arms lexical,haiku-full,haiku-shipped          # §3a's first rows
M11_THREADS=4 python3 -I packages/sim/lab/m11/copygen.py --name diag --epochs 6 --save .local/m11/nets/diag.pt
python3 -I packages/sim/lab/m11/bridges.py .local/m11/nets/diag.pt                       # §3c's last column
# Funnel arms need the deleted switch: git checkout ff961a42, then packages/sim/lab/m11/arms.sh NAME EXP.json SUITE
```
