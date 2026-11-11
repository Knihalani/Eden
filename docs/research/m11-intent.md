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
