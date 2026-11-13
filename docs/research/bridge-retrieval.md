# Bridge retrieval: the hidden facts the default never retrieves on train, and five no-model levers

Status: 2026-11-13, branch `claude/bridge-retrieval` (from main 766516f6d). $0, simulated worlds only (train1–6,
seeds 41–42, shipped card and intent coverage replayed, reader stub, no checker). Every number below comes from the
commands at the end. No blind suite was read: nothing cleared the train bar, so none was spent (docs/LAB.md: blind
once, and only for something that holds on train).

Decisions: D1770 (finding: the diagnosis), D1771 (rejected: constraint-card seats in the push's pool), D1772
(rejected: day seats ordered by card, and day ranges read whole).

## 0. The question and the bar

heldout20's final (f-wave-final.md) raised 73.4% of hidden facts; 22% were never retrieved. F13 (D1302) called them
world-knowledge bridges: the fact shares no word or day with the request, and every meaning bridge tried so far also
pulled in the look-alike twin. This note asks what separates the fact from its twin, and whether any no-model
mechanism in retrieval (query building, lookup, ranking, the candidate pool) reaches facts without twins.

The bar, set by the parent before any run: on train, hidden retrieved or surfaced up at least 8 of 384, with decoys
surfaced not up; then once on a blind suite. Main on train: **hidden surfaced 322/384, decoys surfaced 294/384**
(the funnel's score); the push's pool (its first 15 items, what the push check reads) holds **hidden 350/384,
decoys 242/384**; handed (the first 5, the candidates) 296 and 208.

## 1. The diagnosis

Main leaves **62 of 384 hidden facts unsurfaced** on train. They split in two:

| Stage                                       | Tasks | Templates | What it means in production                                       |
| ------------------------------------------- | ----: | --------: | ----------------------------------------------------------------- |
| Not in the push's pool (never retrieved)    |    29 |        18 | The check never reads the item; only the rule sheet could name it |
| In the pool, past the 5 handed (ranks 5–14) |    33 |        21 | The check reads it; only the no-checker funnel counts it as lost  |

The second group is in the push check's view: a no-model reorder that hands it (D266) already raised the funnel
(+11) and not the agent live (−0.6 points). A strict-card lift into the head, simulated on the pool dump, hands
fewer facts, not more (planted in the pool's first five: hidden 308 → 306, 294, 288 for one, two, three lifts;
decoys 215 → 208, 201, 196): the
planted fact is often uncarded (already-done notes, plain records) and is pushed out by other rules. So this note is
about the first group.

### 1a. How each never-retrieved request relates to its fact (29 tasks)

Classed by hand from the request, the fact and the shipped card (`miss.py`). Primary class first; a day phrased
differently is a second reason in five tasks.

| Class                                                           | Tasks | Templates (seeds)                                                                                                                                                                               | The bridge the request needs                                                                                                                                                      | The twin                                                                                                                                                                   |
| --------------------------------------------------------------- | ----: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| World knowledge or cause                                        |    10 | broadband-already-switched (2), car-finance-outstanding (2), apex-ttl-not-lowered (1), gpu-spend-needs-cfo (2), dinner-guests-vegetarian (1), car-hire-licence-expired (2)                      | A new provider's order ends the old contract; "the car" is "the Audi"; a CDN cutover repoints DNS; A100 nodes are recurring cloud spend; lamb is meat; hiring a car means driving | The same item's other state: the order is for someone else, the HPI is clear, the TTL is done, the budget exception is approved, the guests eat meat, the new licence came |
| Hypernym (the request names an instance of what the rule names) |     6 | expenses-need-signoff (2), discretionary-spend-freeze (2), vendor-security-review (2)                                                                                                           | Expenses over £1k are spend over £1k; an expo exhibitor package is a sponsorship; a data-enrichment service is a vendor touching customer data                                    | Costs approved; the package approved by name; the review complete                                                                                                          |
| Synonym or domain term                                          |     6 | balance-via-tax-code (1), helpdesk-records-legal-hold (2), repo-app-needs-vendor-review (1), signing-authority-limit (2)                                                                        | Self-assessment balance = the computation; support tickets = helpdesk records; a GitHub org = repositories; sign an order form = execute customer paper                           | The tax-code option unavailable; another hold released; the review approved; the restriction withdrawn                                                                     |
| Place                                                           |     4 | travel-needs-preapproval (2), conference-hotel-already-booked (1), entebbe-yellow-fever-shortage (1)                                                                                            | Toronto is outside the UK; Edinburgh is "heading north"; Entebbe is in Uganda                                                                                                     | Pre-approval came through (and names Toronto); rooms booked for others; the vaccination is done                                                                            |
| A person's role or alias                                        |     3 | neighbour-away-for-parcel (2), oncall-swap-incoming (1)                                                                                                                                         | "The neighbour at number 14" is Marek's household; "Jen" is Jennifer Walsh                                                                                                        | The neighbour is home; the swap is another week                                                                                                                            |
| Another language                                                |     0 |                                                                                                                                                                                                 | train's requests are English                                                                                                                                                      |                                                                                                                                                                            |
| (Second reason) a day phrased differently                       |     5 | dinner ("the 7th"), conference ("on the 12th" against "12–14 November"), neighbour ("Wednesday 28th … back Monday 9 November" against 29 October), oncall ("tomorrow" against "28 Oct – 3 Nov") |                                                                                                                                                                                   |                                                                                                                                                                            |

Five of the 29 had no card when the request came though the shipped replay holds one (helpdesk ×2, neighbour ×2,
apex): the funnel's cards drain while tasks run and theirs landed after the request. A lab timing effect, not a
retrieval one; a real user's fact usually arrived days before.

### 1b. What separates fact from twin

Read from a per-push dump of every card and every intent match (`dumpjoin.py`, 764 pushes):

| Signal                                                                                                                       |                                                                                Facts (29) | Twins (29) | Whole train (382 pushes a variant) |
| ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------: | ---------: | ---------------------------------- |
| An in-force constraint card (prohibition, freeze, limit, dependency, absence; not lifted, met or superseded) at request time |                                                                                    **17** |      **2** | hidden 208, control 59             |
| No card at all                                                                                                               |                                                                                        11 |         26 |                                    |
| The card's actions meet the request's (`requestActions`)                                                                     |                                                                                         6 |            |                                    |
| Intent match ahead of the other in the intent list                                                                           | twin ahead in most: the twin names the request's own words (Toronto, SaaS Expo, Pipewell) |            |                                    |

The separating signal is the card's state, as the parent guessed: the twin says the constraint is lifted, met or
about someone else, and the card model writes it `none`. Topic and intent rank go the other way: the twin is written
to share the request's surface, so it ranks above the fact.

**But card state does not separate the fact from the user's other rules.** At request time each user holds 54–67
in-force constraint cards (median 59). Among them, by its intent match, the fact ranks 5th, 6th, 14th, 19th, 20th,
22nd, 25th, 26th, 32nd, 37th and 39th in 11 of the 17, and has no intent match at all in 6. By action class it does
no better: a travel request meets 22–35 in-force cards (the worlds' standing travel and spend policies), and the fact
is one of them with nothing to tell it apart. The remaining gap is the instance (Toronto is outside the UK; this hire
car means driving): a reading of the request beside the rule, which is the push check's job, not retrieval's.

## 2. The levers tried (train 41–42, $0)

Each was built behind a prototype switch in the engine (code in commit 537f711a4, reverted in the next commit) and run
through `bun run funnel`. Columns: hidden surfaced / in pool (first 15) / handed (first 5); the same for decoys.

| Lever                                                                                                                | Hidden surf | Hidden pool | Hidden handed | Decoy surf | Decoy pool | Decoy handed |
| -------------------------------------------------------------------------------------------------------------------- | ----------: | ----------: | ------------: | ---------: | ---------: | -----------: |
| main                                                                                                                 |         322 |         350 |           296 |        294 |        242 |          208 |
| A. Violated constraint cards (`cardVerdict`) seated at place 3, two seats                                            |         317 |         348 |           292 |        292 |        244 |          211 |
| B. In-force strict cards whose actions meet the request's, seated at place 3, two seats                              |         317 |         348 |           292 |        292 |        242 |          210 |
| B'. The same seated after the handed five (pool only), three seats                                                   |         323 |         348 |           297 |        295 |        242 |          209 |
| B''. The same, six seats                                                                                             |         323 |         350 |           297 |        295 |        242 |          209 |
| C. The intent index's carded pass narrowed to in-force strict cards (`intentByKind`), reach 3×                       |         319 |         347 |           293 |        295 |        242 |          207 |
| C'. The same at reach 8× (and 8 kept hits)                                                                           |         319 |         347 |           293 |        295 |        242 |          207 |
| C''. Only more carded hits kept (`intentCardHits` 8)                                                                 |         322 |         350 |           296 |        294 |        242 |          208 |
| D. Day seats (`pushDaySeats`) ordered constraint-carded first, from the day's first 30 or 300 items                  |         320 |         347 |           296 |        294 |        243 |          208 |
| E. Day ranges read whole ("12–14 November", "30 November to 4 December"; `timeWindow` reads only the last day today) |         323 |         350 |           296 |        294 |        240 |          208 |
| B'' + E                                                                                                              |         324 |         350 |           297 |        295 |        240 |          209 |

**None clears the bar** (+8 hidden with decoys surfaced not up): the best, B'' with E, is +2 hidden surfaced and +1
decoy. Why each falls short:

- **A and B** reach a fact only when its card is the user's best match for the request's action, which §1b shows it
  rarely is; seated in the head, they push planted facts at places 3–4 out of the handed five (contents-cover,
  nursery-paid, lunch-order and recruitment-pause each lost). Entebbe (seed 42) is the one never-retrieved fact
  reached.
- **C** pulls more of the user's other rules in ahead of the fact; narrowing "carded" to strict kinds also drops
  already-done and status-change facts the pass found before (−3).
- **D** is the right idea for the five day-phrased misses, but the reading fails before the ordering matters: the
  request's day is read wrong (conference: "12–14 November" is read as the 14th only), the item's span is not read
  (neighbour: "Wednesday 28th … back Monday 9 November"), or the window is too wide for seats (oncall's "this week").
  Ordering by card displaced day seats that held facts (leaver-already-offboarded ×2).
- **E** is a real query-building defect (a range is read as its last day; ten distinct train requests write one) and
  reading it whole moves five tasks: christmas-club ×2 handed (pool 11 and 12 → 5), the support-cover-clash
  look-alike out of the pool ×2, and conference seed 41 no longer cited by the ask (pool 10 → 11): hidden surfaced
  +1, decoys in pool −2. Too small for this bar on its own; see §3.

## 3. What would close the gap, and what a paid run would need

- The class mix is the answer to "why no lexical or card lever": 17 of 29 need knowledge of the instance (a cause,
  a place, who someone is), and the other 12 a hypernym or synonym that a lexicon would have to be written for, per
  domain. The cards already carry
  a world-knowledge bridge (their action classes, written by Haiku) and the state that separates fact from twin;
  what they cannot carry is which of the user's ~60 rules this request's instance falls under.
- A per-request selection of rules by a model is the push check over the rule sheet (D1180), which already reads every
  in-force card for a user with at most 80 (D1183); a user with more gets no sheet. Retrieval cannot do better
  without a model; a no-model pre-selection of the sheet was rejected (D1182). So the open lever is on the check's
  side (a sheet for heavy users), not retrieval's, and outside this session's scope.
- E (day ranges) is worth its own small change with its own screen: it fixes a reading the conflict test, the
  grounding and the day seats all share. It needs `bun run eval` and the train funnel (+1 hidden surfaced, decoys in
  pool −2 here), then dev20 and reworded at $0, since the gain is too small for train alone to show it.
- A paid Pi run would need to show, for any future lever here, that the agent raises the added facts (D266's lesson:
  a fact in the packet is not a fact raised) with confirmed concerns and neutral concerns not up, on dev20 or reworded
  single-shot (shipped coverage, Haiku agent, Sonnet regrade), then once on a fresh blind suite.

## Reproduce

```bash
S=.local/bridge
env -u OPENROUTER_API_KEY bun run funnel --json $S/base.json -- --pool-dump $S/pool.jsonl --corpus-dump $S/corpus.jsonl
python3 -I packages/sim/lab/bridge/miss.py $S packages/sim/lab/distilled/cards-shipped.jsonl.gz   # needs 537f711a4
env -u OPENROUTER_API_KEY bun run funnel --json $S/diag.json -- --ask-diag $S/askdiag.jsonl
# The levers (on 537f711a4, which carries the switches and the lab scripts):
EDEN_CS_DUMP=$S/csdump.jsonl env -u OPENROUTER_API_KEY bun run funnel --jobs 1 --json $S/dumprun.json
python3 -I packages/sim/lab/bridge/dumpjoin.py $S
env -u OPENROUTER_API_KEY bun run funnel --set '{"cardSeats":2}' --json $S/cs2.json                       # A
EDEN_CS_MODE=act EDEN_CS_KINDS=prohibition,freeze,limit,dependency,absence EDEN_CS_AT=3 \
  env -u OPENROUTER_API_KEY bun run funnel --set '{"cardSeats":2}' --json $S/act-3-2.json                 # B (AT=5: B', B'')
EDEN_IK_STRICT=1 EDEN_IK_REACH=3 env -u OPENROUTER_API_KEY bun run funnel --json $S/ik.json               # C, C'
EDEN_DS_WIDE=10 env -u OPENROUTER_API_KEY bun run funnel --jobs 2 --json $S/ds10.json                     # D
EDEN_RANGE=1 env -u OPENROUTER_API_KEY bun run funnel --jobs 2 --json $S/range.json                       # E
python3 -I packages/sim/lab/bridge/sum.py $S/base.json $S/range.json
```
