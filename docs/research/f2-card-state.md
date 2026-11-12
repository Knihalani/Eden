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

## 2. Arm 1 (as registered): fails the facts bar

`pushStateFilter` dropped every pool item whose state was lifted, met or superseded. Handed, base → arm (no model,
shipped coverage, states overlaid from subagent labels; `.local/f2s-run`):

| suite | decoys | facts |
|---|---|---|
| train 41–42 | 276 → 150 | 296 → 273 |
| reworded 41–42 | 250 → 132 | 273 → 252 |
| longtail 41–42 | 22 → 15 | 32 → 32 |
| dev20 41–44 | 152 → 120 | 210 → 205 |
| pooled | 700 → 417 (−40.4%) | 811 → 762 (−6.0%) |

The facts lost on train are items that announce the new state of affairs: a race postponed to a new date, a flight
retimed, an expense already paid, a template withdrawn for a new one. Labelled alone, each says an earlier
constraint was superseded or a condition met, but the item is the fact in force. The card model already tells the
two apart: it cards these items already-done, status-change or limit, and it cards a decoy (a lifted hold, a cleared
approval) none, per its prompt.

**Arm 2, registered here before its run.** Same labels, same suites, same bar. `pushStateFilter` drops an item only
when its card is kind none and its state is lifted, met or superseded: the model said nothing constrains, and why.

## 3. Arm 2: facts kept, decoys short of the bar

Same runs, the filter on none cards only (`.local/f2s-run2`). Handed, base → arm 2:

| suite | decoys | facts |
|---|---|---|
| train 41–42 | 276 → 198 | 296 → 294 |
| reworded 41–42 | 250 → 180 | 273 → 271 |
| longtail 41–42 | 22 → 18 | 32 → 32 |
| dev20 41–44 | 152 → 139 | 210 → 208 |
| pooled | 700 → 535 (−23.6%) | 811 → 805 (−0.7%) |

Surfaced counts (any path, the ask included) and neutral packets are unchanged on every suite: the dropped decoys
were handed by the push and are still listed or cited by the ask, so this changes what the agent is told to check, not
what it can find. dev20's kinds: a (a constraint lifted) 48 → 35, b 41 → 43, c 63 → 61.

**Against the bar:** decoys −23.6% (bar −30%: fails), facts −0.7% (bar ≤ −1%: passes), card cost about +7%
(estimate below; bar +15%: passes). By the registered rule the trial fails.

**Why it stops near −24%.** Of the handed decoys whose item is labelled lifted, met or superseded, the rest are
carded status-change or already-done, the same kinds the facts it must keep are carded (train: 19 decoys
status-change/superseded against 10 facts). Read alone, an item cannot tell an old change from the one that bears on
the request; that needs the request (the push check, or the agent). Dropping cleared items of the standing kinds too
(freeze, deadline, limit, absence, dependency, prohibition) would add about 46 decoys and lose about 4 facts on these
suites (counted from the base pools, not run): −30.2% and −1.2%, failing the facts bar instead.

**Uncarded decoys (step 2).** Handed decoys never carded: train 10, reworded 10, longtail 3, dev20 12 (§1). Carding
every one, and every one judged cleared, would move the pooled cut by at most 35 of 700 (5 points), so the prefilter
was not widened and its added calls were not measured.

**Card cost (estimate, not a measured run).** Over the 1,210 labelled items with a replayed card: the replay's output
is about 109,000 tokens (characters / 3.5); a state on 1,011 cards and 176 new none cards add about 10,600 (+9.7%);
the longer clause adds about 130 input tokens a call. At Haiku's 1:5 input:output price, with about 3,700 input and
900 output tokens a 10-item call, that is about +7% a card call.

**What is not measured.** The states came from Haiku subagents judging each item alone with `build.py`'s instruction,
standing in for the card call's own clause; the card call judges the item among nine others and also writes its card.
No paid card call was made (no Anthropic credit). Before a promotion the recommended check is a re-card of dev20
41–44 in form 3 + 16 through the queue, then the same screen.

## 4. Review fixes, and arm 2 on current main

The reviewer (REQUEST_CHANGES, five findings) found side effects the overlay numbers above carried. All five are fixed,
with tests (`card-state.test.ts`, `plan-conflict.test.ts`):
- a cleared none card counted as a carded seat in the intent index (`intentFinds`' `carded`, `carded()`);
- plan alerts (`checkPlans`) built their pool without the filter (now one `pushPool` for both);
- a cleared none card that shares no word with its item (crossed indexes) is not kept (`clearedNone`);
- a constraint turned into none for want of an action drops its state;
- `pushStateFilter` needs `cardsState`.

After the fixes, and on main as of 2026-11-12 10:25 (F1's D1153 had moved the base), overlay arm 2 against a fresh base
(`.local/f2s-base3` → `.local/f2s-run3`), handed decoys / facts:

| suite | decoys | facts |
|---|---|---|
| train 41–42 | 276 → 199 | 296 → 294 |
| reworded 41–42 | 262 → 192 | 287 → 285 |
| longtail 41–42 | 22 → 18 | 32 → 32 |
| dev20 41–44 | 186 → 175 | 244 → 241 |
| pooled | 746 → 584 (−21.7%) | 859 → 852 (−0.8%) |

## 5. The re-card: the card call's own state clause (the integrator's condition)

The integrator promoted arm 2 on condition that a re-card in the state form holds on dev20 41–44: decoys handed fall at
least 20% and facts handed at most 1%. dev20 41–44, every variant (48 worlds), was re-carded in form 19 through
F8's per-item queue (D1102): `cold-start.ts --queue-dir` dumped 2,009 items, Haiku-model subagents answered them from
the card call's own system prompt with the state clause (41 batches of 50; four keys left out were answered again),
and a recording pass made 732 card calls with 0 failures and no new item pending (`--cards-out`, 1,929 lines keyed
`:f19`). Served by subagents per item, world clock: not a model's own recording.

States the card call gave (dev20, 1,929 items): cards of a constraint kind in force 834, superseded 49, met 10, no
state 88; none cards with a state 75 (lifted 49, met 23, superseded 3).

No-model funnel, dev20 41–44, the shipped replay plus the f19 lines (`.local/f2s-q`; the merged base reproduces
the shipped base exactly), handed:

| run | decoys | facts | surfaced decoys | surfaced facts | neutral any packet |
|---|---|---|---|---|---|
| base (shipped form 3) | 186 | 244 | 259 | 345 | 433/640 |
| form 19, filter off | 160 | 255 | 239 | 373 | 432/640 |
| form 19, filter on | 147 | 254 | 238 | 373 | 432/640 |

**Against the condition:** decoys 186 → 147 (−21.0%; bar −20%: holds), facts 244 → 254 (+4.1%; bar ≤ −1%: holds).
The filter alone (same cards, off → on) takes decoys 160 → 147 (−8.1%; kind a 48 → 34) for one fact. The rest is the
re-card itself (form 3 → 19 with the filter off: decoys −26, facts +11), which mixes the state clause with fresh
subagent answers against F8's (both per item): read it as noise of that size, not as the clause's effect.

**Cost.** Over the 1,929 items, the card call's output (cards and requests as the call's JSON) is 9.4% larger in form
19 than the same items' form-3 lines (cards alone +8.6%), measured from the two files; this too mixes in answer
variation. The clause adds about 140 input tokens a call. At Haiku's prices that is about +7% a card call, within D1193's
estimate.

## 6. Train and longtail re-carded; the default flipped

So that the default's lab runs stay on shipped coverage (the card prompt's form is now 19), train1–6 and longtail
seeds 41–44, every variant (84 worlds), were re-carded the same way: 2,037 items served by Haiku-model subagents per
item through the queue (D1102), then a recording pass of 1,253 card calls with 0 failures; 971 new `:f19` lines
joined `cards-shipped.jsonl.gz` (the rest were base items already recorded from dev20's worlds), and
`SHIPPED_FORM_COVERS[19]` covers train, reworded, longtail and dev20 41–44. heldout19 keeps its form-3 lines (left
alone: measurement only); heldout20's final cards each arm in its own form (F6's pipeline).

The default before and after the flip, on the same tree (main at c5d47c260 merged), no model, shipped coverage, stub
reader (`.local/f2s-old` with both switches off, `.local/f2s-new` the new default), handed:

| suite | decoys | facts | surfaced decoys | surfaced facts | neutral any packet |
|---|---|---|---|---|---|
| train 41–42 | 276 → 197 | 296 → 296 | 299 → 296 | 318 → 319 | 378 → 377 of 384 |
| reworded 41–42 | 262 → 182 | 287 → 287 | 300 → 285 | 314 → 313 | 370 → 369 of 384 |
| longtail 41–42 | 22 → 17 | 32 → 31 | 28 → 30 | 35 → 34 | |
| dev20 41–44 | 186 → 147 | 244 → 254 | 259 → 238 | 346 → 372 | 433 → 432 of 640 |
| pooled | 746 → 543 (−27.2%) | 859 → 868 (+1.0%) | | | |

On train, reworded and longtail the "off" arm replays form 3 and the "on" arm form 19, both served by subagents per
item, so each row mixes the filter with the re-card's own answer variation (§5 measured the filter alone on dev20:
−13 decoys, −1 fact). `bun run eval` is unchanged (precision 0.65, recall 0.52, falseFireRate 0): it runs no cards.
