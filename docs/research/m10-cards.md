# M10: a micro card tagger in place of the card model's cards (D960–D969)

Status: in progress. The owner's goal: replace Haiku usage with hyper-specialised micro models. M10 takes **cards**:
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
