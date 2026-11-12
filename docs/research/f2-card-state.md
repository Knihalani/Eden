# F2-state: a state on the card, and look-alikes filtered by it

Status: 2026-11-12, branch `claude/f2-card-state` (from main), session F2. Pre-registered (§2) before any state is
labelled or any filtered run. $0: no-model funnel at shipped coverage; states labelled by Haiku subagents per item
("served by subagents per item", as D1102's cards).

## 1. Why (D1143's numbers, read again)

D1143 counted 421 of 700 handed decoys as "uncarded". Most of them were carded `none`: the enricher stores a `none`
card as nothing (`cards.ts`, `card: card.kind === "none" ? null : card`). The card prompt already tells the model that
"a constraint lifted or cleared" is `none`. Of the planted items the push hands (base runs of D1143, the shipped card
replay):

| suite    | decoys: constraint / none / never carded | facts: constraint / none / never carded |
| -------- | ---------------------------------------- | --------------------------------------- |
| train    | 144 / 122 / 10                           | 271 / 17 / 8                            |
| reworded | 134 / 106 / 10                           | 249 / 16 / 8                            |
| longtail | 15 / 4 / 3                               | 30 / 0 / 2                              |
| dev20    | 80 / 60 / 12                             | 120 / 29 / 61                           |

So the card model already reads most decoys and calls them no constraint. `none` is too broad to filter on, though:
it is also news and background, and 17 to 29 handed facts a suite are carded `none`. A **state** says why: in force,
lifted, met or superseded. Prefilter widening is not needed for the decoys: only 10–12 handed decoys a suite were
never carded.

## 2. Pre-registration

**The field.** `Card.state`: `in_force`, `lifted` (a hold, restriction, requirement or problem lifted, cancelled,
cleared, resolved or settled), `met` (a condition already met, the thing allowed or approved), or `superseded` (the
item withdraws or replaces an earlier instruction or version). Absent means unknown. The card call writes it with
`cardsState` (trial, off), and a `none` item with a non-`in_force` state is kept as a card. The model judges the state
from the item; no word list is involved.

**The filter.** `pushStateFilter` (trial, off): the push's pool less the items whose card's state is `lifted`, `met`
or `superseded`. An unknown state stands.

**The lab run.** The recorded cards and requests are replayed as shipped, and each carded item's state is overlaid
from a per-item label file (`packages/sim/lab/f2-state/`). Haiku subagents judge each item alone from its source,
date, title and text and the world's day, with the instruction the card prompt gains (§3), never with the request.
The items labelled are every carded item in the first 10 seats of a hidden, control or neutral pool on train,
reworded and longtail seeds 41–42 and dev20 41–44: 2,109 unique items.

**Bar** (pooled over train, reworded, longtail and dev20; the push's candidates, no check, as `score.py` counts
handed):

- decoys handed at most 70% of the base;
- facts handed at least 99% of the base;
- the card call's cost within +15%: added output tokens (the state on every card, plus the new `none` cards that carry
  a state) priced against the replay's own output tokens per call.

Pass: both switches go to F12's candidate the same day (off until the final run). Fail: deleted, findings kept.
