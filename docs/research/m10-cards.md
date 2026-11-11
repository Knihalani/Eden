# M10: a micro card tagger in place of the card model's cards (D960–D969)

**Status: rejected (D960).** The trial `cardsMicro` is deleted with its code, tests and weights; the lab tooling stays (D962). The owner's goal: replace Haiku usage with hyper-specialised micro models. M10 takes **cards**:
the structured card (`Card`: kind, actions, entities, span, limit, statement) the background enricher writes for each
item the strict prefilter passes. The micro model must not generate text: it tags spans and classifies fields, once
per item at ingest, on CPU.

## Pre-registered bar (committed before any paid run)

1. **Field agreement with Haiku cards on held-out families**, no worse than Haiku's agreement with itself (a sample
   re-carded twice in other batches, as M7's `self-agree.ts`): constraint flag, kind, actions (Jaccard), span (start
   and end exact), limit (value exact), entities (token Jaccard), each at or above Haiku-vs-Haiku on the same items.
2. **Funnel ($0) with micro cards in place of Haiku cards**, against main: hidden surfaced within −1% (relative),
   decoys surfaced not up, neutral packets not up.
3. **Pi pair against main**: hidden facts' template-clustered lower bound > −2 points, concerns not up by more than 1
   per 1,000 tasks; cap $8.
4. **Size and speed**: ≤ 1 ms per item at ingest in TypeScript, ≤ 4 MB shared model.
5. **Hard gates**: M3's 52 short-constraint fixtures (`packages/sim/lab/m3r/short-constraints.jsonl`) read as
   constraints (flag) at least as often as Haiku reads them, and M10's field fixtures (dates, amounts, entities in
   short and long items) all pass.

All five hold, or the trial is deleted with its code and tests (D814).

### Amended bar (the owner's, before any held-out funnel or Pi read)

Haiku is to be cut out entirely, and a replacement must be better than Haiku, not equal. This replaces bars 1–3:

1. **Funnel ($0), micro cards against Haiku cards** (the shipped coverage's requests in both arms; arm A replays the
   shipped Haiku cards, arm B the micro tagger's cards for the same items), on the held-out families: train5 and
   train6, seeds 41–44, with `--neutral`. Hidden surfaced at least +1% (relative) over the Haiku arm, decoys surfaced
   no higher, neutral packets (any packet) no higher. train1–4 (whose planted items are in the training split) and
   M2's synth-test are reported beside it, never in the bar.
2. **Pi pair, micro against Haiku**: hidden facts point estimate ≥ +1 point, template-clustered lower bound > −1.5,
   confirmed concerns no higher; cap $8.
3. **The headline arm with M11**: micro cards plus M11's micro expansion, no Haiku call at ingest, against the shipped
   Haiku cards and intent, on the same two rules.
4. Size and speed (≤ 1 ms an item, ≤ 4 MB) and the hard gates (short constraints flagged at least as often as Haiku's
   mean over two readings, 37 of 52; every field fixture) stand.
5. **Field agreement with Haiku is a diagnostic only.** Fields are weighed by what the engine consumes.

Two development rounds; if no arm passes, M10 reports with numbers and ships nothing (no downgrade).

## Data

- **Sim items** (`packages/sim/src/lab/m10/export.ts`): every item a sync of the train and longtail worlds holds
  (hidden, control and neutral variants), read as the card prompt reads them, with the tagger's candidates
  (`readText` in `packages/engine/src/micro-cards.ts`: tokens, sentences, date mentions resolved to days, amounts).
  Only items the strict prefilter passes matter: the enricher keeps no other card. heldout19 is never built.
- **Labels**: the shipped card call on Haiku 5.5 (`label.ts`, `ModelCardMaker` with the intent instructions, batches
  of 20 within one world), plus the recorded shipped-coverage cards for seeds 41–44.
- **Haiku's self-agreement**: the 1,001 seeds 41–44 strict items re-carded in other batches (`--shuffle 2`).
- **Generated families** (`gen.ts`): Haiku-written fictional items across areas, kinds, actions and formats (short
  lines, chat, email, calendar, notifications, documents, long mail), most stating a constraint and the rest
  look-alikes; carded by the same shipped call, train only.
- **Splits**: held out are train5 and train6's planted items and 20% of the remaining families by a hash of their
  skeleton (title and opening words, digits and capitalised words masked), so a family's copies across seeds stay on
  one side.
- **Candidate coverage** of Haiku's flagged cards (seeds 41–56): span days in the mentions 89%, limit value 96.5%,
  entities aligned to tokens 74%.

## Hypotheses (round 1)

All read the item once at ingest, write no text (spans, values and classes only), and fit 4 MB and 1 ms.

| # | Architecture | Idea |
| --- | --- | --- |
| H1 | Sparse linear heads | Hashed words, bigrams and character n-grams into one linear layer per field; BIO over window features; date roles and amount flags over each mention's window. The baseline. |
| H2 | Binarised trunk (M3's kit) | Ternary hashed input into a sign code and binary layers (XNOR-popcount), shared by the item heads and by each candidate's window. |
| H3 | Sentence pointer | Each sentence encoded as a hashed bag; attention picks the constraint sentence(s); kind and actions read the pointed sentence; date and amount roles know whether their mention sits in it; the statement is the pointed sentence. |
| H4 | Conv tagger | Learned hashed token vectors (no pretrained table) and one or two dilated convolutions; BIO, mention roles and attention-pooled item heads from one token pass. |
| H5 | Lexicon trees | Gradient-boosted trees over structured features: the engine's deontic word groups, action lexicons run over the item, title and source cues, candidate positions; exported as if-trees. |
| H6 | Hamming memory | Learned 128-bit item and sentence codes; kind and actions by vote of the nearest training prototypes; roles by a small linear head. |
| H7 | Clause frames | Shallow frames of each deontic clause (modal or negation, verb, object, date word, amount word), hashed into the heads: the action is what the constrained clause does. |
| H8 | Soft-target cascade | A flag gate, then a kind-by-action factorised head and BIO with transition scores, trained on soft targets from two Haiku labellings (Haiku's own disagreement as its uncertainty). |

## Round 0 (H1 alone, seeds 41–56, 2,041 train items)

Held-out families (418 items with a second Haiku labelling):

| | flag | kind | actions | span | limit | entities |
| --- | --- | --- | --- | --- | --- | --- |
| Haiku vs Haiku | 0.876 | 0.689 | 0.573 | 0.651 | 0.952 | 0.539 |
| H1 vs Haiku | 0.651 | 0.335 | 0.216 | 0.492 | 0.895 | 0.138 |

Short constraints flagged: H1 39 of 52, Haiku 38 and 35. Field fixtures: H1 fails 18 of 24, Haiku 0.

## Ablations: what the engine consumes of a card (D961)

`make_replay.py --ablate` removes a field from every shipped Haiku card; the shipped requests are replayed in every arm
(reader stub, no checker). train1–4, seeds 41–44, 512 tasks a variant:

| Cards | Hidden | Decoys | Neutral any packet |
| --- | --- | --- | --- |
| Haiku's | 367 | 360 | 496 |
| no entities | 367 | 360 | 496 |
| no statement | 366 | 357 | 496 |
| no limit | 367 | 360 | 499 |
| no actions | 369 | 360 | 493 |
| no dates | 370 | 364 | 493 |
| every card none | 375 | 369 | 469 |

What moves the funnel is which items are flagged and their kind (the push's constraint-like pool, the intent hits
that count), a little actions and dates (`cardVerdict`). Entities and the statement feed only the reader's card line
and party ties, which the $0 funnel does not exercise.

## Round tables

**Round 1** (set-v2: seeds 41–80 sim items, 4,811 train; field diagnostic on 418 held-out items with a second Haiku
labelling; Haiku vs Haiku: flag .883, kind .694, actions .595, span .667, limit .952, entities .545):

| # | flag | kind | actions | span | limit | entities | Size | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| H1 sparse | .644 | .366 | .191 | .490 | .917 | .128 | 8 MB at 2^18 | baseline |
| H2 binarised | .723 | .409 | .228 | .455 | .917 | .147 | 3.2 MB | short 26/52 |
| H3 pointer | .754 | .347 | .223 | .510 | .914 | .180 | 10 MB | over |
| H4 conv 24ch | .751 | .402 | .267 | .506 | .920 | .145 | 2.0 MB | 0.62M MACs |
| H5 LightGBM | .849 | .438 | .310 | .446 | .917 | .134 | 1.1 MB | short 11/52 |
| H6 Hamming kNN | .754 | .433 | .272 | .484 | .926 | .167 | 18.7 MB | over |
| H7 frames | .691 | .412 | .207 | .487 | .901 | .133 | 16.5 MB | over |
| H8 cascade+CRF | .797 | .354 | .234 | .529 | .926 | .153 | 6 MB | over |

Adding 9,834 Haiku-written items (`gen.ts`, carded by the shipped call) lifted H1 to .782 / .440 / .292 on the same
items. None came near Haiku on kind, actions or entities.

**Round 2** (set-v4: + a dev fold, train3–4's planted items never trained on; the funnel on the dev fold is the
selection measure). Haiku arm: 190 / 169 / 253 (hidden, decoys, neutral any packet of 256).

| Arm | Hidden | Decoys | Packets | Size |
| --- | --- | --- | --- | --- |
| H1 sparse, 2^16 | 197 | 169 | 253 | 2.0 MB |
| R2-A LightGBM + short features | 197 | 170 | 253 | 1.7 MB |
| R2-B conv + flag gate + date keywords | 197 | 170 | 253 | 2.0 MB |
| R2-C merged sparse (hidden layer, lexicons, gate) | 197 | 169 | 253 | 2.6 MB |
| H1 + twin pairs, two seeds averaged (chosen) | 197 | 170 | 253 | 2.0 MB |
| cards off (D963) | 194 | 174 | 239 | – |

Every architecture lands on the same line: the funnel is decided by a handful of templates (the dev gain was 4 seeds
of `helpdesk-records-legal-hold` and 2 of `discretionary-spend-freeze`), and the flag threshold moves nothing (the
models are confident). The chosen model was the seed average, picked a priori over chasing the ±1 decoy.

## Results (the one held-out read, D960)

train5–6, seeds 41–44, `--neutral`, replay arms (shipped requests; Haiku's recorded cards plus the 57 strict items
its recording missed, carded by the same call; or the micro cards for the same items):

| Arm | Hidden | Decoys | Neutral any packet |
| --- | --- | --- | --- |
| Haiku cards | 208 | 168 | 250 |
| **Micro cards** | **205** | **167** | **250** |
| Micro, engine path (every strict item) | 206 | 171 | 250 |
| Cards off | 203 | 168 | 236 |

Hidden −1.4% against the +1% bar: fails. Gates on the shipped TypeScript path: short constraints 36/52 (bar 37, Haiku
38 and 35), field fixtures 4 of 24 failing (a hyphenated range's start, two entities, an already-sent contract read as
none). The Pi pair was not run: it could not change the decision ($0 of the $8 cap).

**Speed and size** (met): int8 hashed tables, 2,032,109 bytes; 0.42 ms an item warm (p50 0.44, p95 0.76; 1,058
items, Bun 1.4, one core), TypeScript parity 64/64 on cards and on the reader.

**Spend:** Anthropic $2.87 (card labels $1.84, generated families and twin pairs $1.03); Modal $0 (unreachable over
gRPC from this container; CPU training was enough). Helper sessions ran on their own machines.

## What a next attempt would need

- Not a better field tagger: the funnel does not reward field agreement (D961), and four architectures with very
  different field scores gave the same dev line.
- The decoy problem is a whole-pool one: a micro flag on any pooled item makes the pool constraint-like. A target
  built from the funnel's own outcome (which items, flagged, let a decoy through) is the lever round 2's helpers
  named and nobody built.
- The card call stays while intent requests come from it (M11's micro intent stopped): any card replacement removes
  output tokens only, not a call.

## How to re-run

```bash
bun packages/sim/src/lab/m10/export.ts --out .local/m10/items.jsonl            # seeds 41-44; --seeds for more
bun packages/sim/src/lab/m10/label.ts --items … --out … --spend-ledger … --spend-cap …   # Haiku cards (pay once)
python3 -I packages/sim/lab/m10/build_set.py --items … --labels … --self … --out set.jsonl.gz
python3 packages/sim/lab/m10/h1_sparse.py --set set.jsonl.gz --predict predict.jsonl.gz --out DIR --buckets 16
python3 -I packages/sim/lab/m10/to_cards.py --rows predict.jsonl.gz --outs DIR/predict.jsonl --out DIR/cards.jsonl
python3 -I packages/sim/lab/m10/make_replay.py --cards DIR/cards.jsonl --out rep.jsonl
packages/sim/lab/m10/arm.sh train3,train4 41,42,43,44 NAME --cards rep.jsonl --intent rep.jsonl   # dev fold
python3 packages/sim/lab/m10/export_h1.py --model DIR/model.pt --out .local/m10/micro-cards-v1.bin
bun packages/sim/src/lab/m10/gates.ts --weights .local/m10/micro-cards-v1.bin
```
