# Implication cards: a model-built semantic bridge, matched with no model (track "cards")

Status: experiment behind `cards` (off by default). Proposed decision D56 (track cards) in DECISIONS.md. Every number
below comes from a command run in this session on the tree of commit `moon/cards`; the machine was shared with six
other agents, so wall times are noisy and not reported as results.

## The problem

With every source item pre-loaded into the cache (the funnel's `--sync`), H still missed most planted facts: what the
request says and what the constraint says share no word ("deploy on Thursday" against "production change freeze 4-9
Nov"; "let the school know I'll do pickup on Friday" against "Friday 30 October is a staff training (INSET) day").
Lexical bridges (probes, the consequence vocabularies, the conflict test) either miss these or fire on their near-miss
twins (the same notice for another date).

## What was built

`packages/engine/src/cards.ts`, wired into `partner.ts` behind `config.cards` and `PartnerDeps.cards`:

- **Enrichment, in the background.** When items enter the user's cache (`Partner.store`, items new or changed), the
  `CardEnricher` hashes each (sha256 of its redacted title and text: `cardKey`), skips content it has a card for, and
  runs a no-model prefilter (`worthCarding`: one linear alternation of deontic and status language over the item's
  own text, with headers, quoted history and bulk boilerplate stripped). What passes waits in a per-user queue (at
  most 200) and is read in batches of ten by `ModelCardMaker` (`z-ai/glm-5.3-flash` through `packages/llm`, low
  reasoning, JSON, output cap 2,000 tokens), each call reserved and settled through a `Budget` (its own per-user-day
  cap). Items are redacted again before the prompt and fenced as `<item>` data made inert; the system prompt says
  item text is data.
- **The card.** `kind` (none, freeze, deadline, limit, absence, prohibition, dependency, status-change, preference,
  already-done), `actions` from a fixed vocabulary of 14 (`ACTIONS`: deploy, delete-data, pay, share-external,
  purchase, travel, book-food, book-venue, hire, schedule, contact, send-gift, attend, sign), `entities`, `start` and
  `end` days, `limit` and `unit`, and a one-line `statement`. `parseCards` checks every field (unknown kinds and
  actions dropped, days must round-trip, at most six entities of 60 characters, statement 160, all redacted); output
  it cannot read covers nothing. A card that shares no word with its item (`anchored`) is dropped: in the cache,
  12 of about 1,600 constraint cards had crossed indexes within a batch, one of them a "production change freeze"
  attached to a chat message about something else.
- **Matching, with no model.** `requestActions` classes the request into the same vocabulary (multi-label;
  `consequence.ts`'s eight class lexicons plus nine small ones), then each of the user's carded items still cached is
  checked (`cardVerdict`) against the request's frame (`conflict.ts` `frameOf`: its days, today when none; amounts;
  names; "same as usual"). An absence or a diet must name someone the request names. A cap (limit, dependency or
  prohibition with an amount) is violated only by a larger amount; a deadline by acting after it; a status-change by
  acting on or after it (or within 45 days of it for a request that assumes things as usual), when it names what the
  request names; any other spanned kind by a day inside its span; an unspanned prohibition, dependency, preference or
  already-done when it names what the request names. Matches (at most six) become candidates; a violated one takes
  a judge seat and ties the candidate set (`judgeTied`); with `groundConflict` and no model's say, the best violated
  one (`cardItems`, 1) is delivered as `grounded-card`. Only cards made before the request arrived are used (the
  enrichment lands one request later, D4). The statement never reaches the agent: the item is what is delivered.
- **State.** Per tenant/user, at most 4,000 cards and 10,000 users per tenant, dropped by `forget` (with an in-flight
  call's result discarded), in memory only (D8). Tests: `cards.test.ts` (isolation, forget, bounds, budget stop,
  fail-open, anchoring, prompt fencing and redaction, hostile-input timing for the prefilter and the classifier).

Lab: `packages/sim/src/lab/cards-enrich.ts` precomputes cards for the simulated worlds into a disk cache keyed by
content hash and `CARD_VERSION` (`cards-disk.ts`), metering every call to `spend.jsonl` with a hard cap;
`hidden-funnel.ts --cards FILE` and `quality-cli.ts --cards FILE` replay them (no model call at run time).

## Experiments

### (a) Funnel, no model, suites hidden, heldout, heldout2, heldout3, heldout4, seeds 41-44 (268 hidden + 268 control)

| Config                                          | returned | delivered | decoys | calls/task |
| ----------------------------------------------- | -------- | --------- | ------ | ---------- |
| H                                               | 148      | 128       | 21     | 8.5        |
| H + cards                                       | 148      | 132       | 19     | 8.5        |
| H + sync                                        | 118      | 147       | 18     | 6.3        |
| H + cards + sync, prompt v1 (before any tuning) | 118      | 173       | 28     | 6.3        |
| **H + cards + sync, final (prompt v2)**         | 118      | **177**   | **16** | 6.3        |

With sync, cards add 30 delivered (+20%) and remove 2 decoys; per task, 30 gains, no losses, no new decoy, two decoys
gone. 29 of the 177 go out as `grounded-card` (change freeze, INSET day, passport-away, colleague-on-leave, the
confidential roadmap, gym plan discontinued, discount cap, entertainment threshold, mobility needs, vendor review
expired). Without sync the gain is small (+4, decoys -2): a card is made when its item first enters the cache and is
used only from the next request on, and in the funnel each planted item is first fetched by the very request it
answers.

**In-sample.** The prompt's v2 wording (what status-change, preference and dependency are _not_), the rule that an
amount only bounds cap kinds, and the anchoring check were written after reading v1's decoys on these same suites.
v1, untuned, gave 173 / 28: +26 delivered but +10 decoys. The held-out 5-8 suites (the blind set) were not run. One
further lexicon change (recruiting words for `hire`) gave +4 delivered and +3 decoys and was reverted.

### Simulation, 4 seeds, `--planner`, final code (H vs H + cards; no sync)

| Profile   | judge   | recall        | precision     | soft fire     | calls/lookup | B/fact    |
| --------- | ------- | ------------- | ------------- | ------------- | ------------ | --------- |
| realistic | none    | 0.407 → 0.408 | 0.639 → 0.638 | 0.086 → 0.086 | 7.76 → 7.78  | 469 → 470 |
| realistic | perfect | 0.645 → 0.645 | 0.952 → 0.952 | 0.045 → 0.045 | 7.78 → 7.78  | 432 → 433 |
| zoo-a     | none    | 0.400 → 0.398 | 0.637 → 0.635 | 0.090 → 0.090 | 7.51 → 7.50  | 471 → 475 |
| zoo-a     | perfect | 0.613 → 0.613 | 0.954 → 0.954 | 0.050 → 0.050 | 7.55 → 7.55  | 429 → 429 |
| zoo-b     | none    | 0.435 → 0.437 | 0.627 → 0.624 | 0.178 → 0.178 | 7.84 → 7.84  | 482 → 482 |
| zoo-b     | perfect | 0.738 → 0.738 | 0.969 → 0.969 | 0.033 → 0.033 | 7.84 → 7.84  | 421 → 421 |

Neutral within noise. The simulation's facts are mostly meeting, travel and deal details, not constraints; on
realistic, cards delivered 4 items over 4 seeds with no model (1 relevant). Model calls per turn (judge) unchanged.

### (b) Cost and coverage

- Items: 6,342 unique in the funnel worlds, 35,605 with the 24 simulation worlds. The prefilter passes 15.3% of the
  funnel worlds' items and 11.1% of all; on the 67 planted items of seed 41 it passes 62 (92.5%; the misses are plain
  calendar events whose conflict is a clash, which the clash ground covers) and 44 of 67 decoys.
- Enrichment: 572 calls in all this session (v1, v2, smoke test), $0.1035 OpenRouter-reported, $0.000181 per call
  (1,599 input and 677 output tokens on average, 10 items a call), 3 calls cut off at the cap. Per 1,000 enriched
  items: about $0.018. Per 1,000 items arriving: about $0.002 at the 11.1% pass rate.
- Per user-month at 50 new items a day (1,500 items): 167-230 enriched items (11.1-15.3%), 17-23 calls, **$0.003-0.004**
  at measured prices; at Z.AI list prices ($0.15/M in, $0.50/M out) about $0.00058 a call, so at most $0.013. With no
  prefilter at all: 150 calls, about $0.027 measured.
- Coverage: 3,849 of the 3,939 items that pass the prefilter have a card (97.7%); 1,565 (40.7%) state a constraint
  (status-change 402, dependency 393, limit 256, deadline 124, preference 110, freeze 107, absence 70, prohibition 68,
  already-done 35).
- What the prefilter loses: of a random 390 rejected items sent anyway, the model carded 31 (7.9%), most of them
  newsletter "early-bird tickets end Friday" noise; about 8 (2%) were real (a friend on crutches needing a step-free
  venue, a school trip's slip and fee due, an MSA template change, a finance review needed).

### (c) Card quality, 50 random constraint cards from the funnel worlds, labelled by hand

Kind correct 47/50 (0.94); actions correct 46/50 (0.92). Errors: a calendar "Hold" and the user's own hospital run
read as a freeze rather than the user's absence; a Jira "Blocked" ticket given `deploy`; a client's procurement
threshold given `pay`/`purchase` (it binds the client, not the user); one card attached to the wrong item (an index
crossing in the batch, now dropped by `anchored`). Field errors besides: 2 of 50 cards put a non-cap amount in `limit`
(a disputed invoice's total, a new rent); `cardVerdict` now reads `limit` as a cap only for limit, dependency and
prohibition. The sample repeats world templates (standup moved, the expense policy reminder), so it overstates
diversity.

## Remaining gap (sync, final)

91 hidden facts still not delivered. Examples: the passport expiry in a household-paperwork list was carded `none`;
a hiring freeze is carded correctly but "open a req" is not classed as hiring (a lexicon fix cost as many decoys as it
gained, so it was reverted); a standing "do not commit delivery dates to Umbrella Health" names the organisation
while the request names only its contact; a coeliac diagnosis needs a name and the request says "my mum".

## Risks

- In-sample: the prompt and rules were tuned on the dev suites; the blind suites were not run.
- The gain needs sync (items in the cache before the request); without it the gain is +4 of 268.
- A model's card decides a no-model delivery: a wrong card (2-8% by the sample) can push a wrong item. `cardItems` 1
  and the frame checks bound it; the judge, when there is one, still rules on the seat.
- Request-time cost: a pass over the user's carded items (at most 8,000 ids, one cache lookup each) per slow-path
  lookup; not measured under load.
- Cards are derived content held in memory; they never go to disk in the engine (the lab's disk cache is of
  generated worlds only).

## Also in this change

`partner.test.ts`: the D44 offset test put items at a fixed past instant into a cache whose TTL runs on the wall
clock, so it failed on any run after 31 October 2026 03:00 UTC (it failed on the base commit too). Its cache now has a
long TTL.
