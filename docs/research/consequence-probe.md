# Consequence probes: retrieval across the semantic gap, with no model (D54)

About half of the planted hidden facts were never returned by any source call (D48): the item that decides the
action shares no word with the request. "Can you schedule the billing service release for Thursday 2pm" and "Change
freeze: quarter-end close"; "Book me flights to Singapore next week" and "Passport posted for renewal … back around
20 Nov". Pseudo-relevance feedback and a per-user co-occurrence graph failed earlier: the simulated world has no
bridging vocabulary, and Eden's cache holds only what lookups returned.

What bridges the two is general knowledge of what constrains an action, not anything in the user's data. Change
management freezes releases; litigation holds stop deletion; payment controls guard against changed bank details;
confidentiality governs sharing; budgets and approvals govern spend; documents and strikes govern travel; allergies
and diets govern food; headcount and investigations govern hiring.

## What it does (`consequence.ts`, `Partner.consequence`, flag `consequenceProbe`, off by default)

1. **Classify.** A request that acts (`isAction`, an arriving message, a verb that acts on someone, or one that starts
   with a class's own verb: "Deploy the migration") is matched against eight classes' verb lexicons, most specific
   first: delete, pay, release, people (hire/offer/terminate), travel, food (providing food or a venue, not meeting
   over a meal), spend, share. One bounded pass over the request's first 400 characters.
2. **Ask.** One query of the class's constraint vocabulary (one table, `CLASSES`, written from general practice before
   any run) to `consequenceSources` (1) source. A source learned to search any word gets every term at once; any
   other gets one term, the first not yet asked there (the next lookup of the class asks the next), so a run of
   lookups covers the vocabulary at one call each. How a source searches is learned per user, with no extra call,
   from the person probes' answers to names of several words (an answer holding an item without every word is an
   any-word search) and from an empty answer to the whole vocabulary (`ProbeEconomy.observeForm`).
3. **Recall at no call.** The user's cache is searched for the class's terms, and what the class's earlier queries
   found, still cached, joins this lookup's finds.
4. **Choose the source.** With `probeYield`, by the upper bound of the consequence arm's yield at each source (an
   untried source first), then by how many of the user's cached items holding class terms came from it, then the
   lookup's routing.
5. **Deliver only on a conflict.** A find counts (`bridged`) only when it holds a class term and the conflict test
   (`conflict.ts` `assess`, tied by the class's words as well as the request's) says it conflicts with the request,
   and it does not state a limit on an amount the request does not state (`unmeasuredLimit`). A bridged find takes
   the first of the probes' three judge seats (judge input does not grow) and, with `groundConflict`, is delivered with
   no model, for a class whose constraints bind everyone (release, people, travel, spend) whoever it names, and for one
   whose constraints bind one party (delete, pay, food, share) only when the request names no one or the find names
   someone it does.

Cost control: the probe is bounded by its own `consequenceSources`, outside `probeCalls` (it never takes the calls an
organisation probe sent after the people would need), goes last in each source's probe lane, and its query records are
kept apart from the user's own (`ProbeEconomy.side`), so they never move the pooled change rate `probeFresh` skips
by nor push the user's probes out of the economy's bounded memory. State: per user (tenant/user scope key), bounded
(`MAX_SIDE_QUERIES` 256, `MAX_FORMS` 64), dropped with the user or the source. No item text is kept; finds are cached
items, which passed `sanitizeForStore` when stored.

## Measurements (all no model; one session, commit of this change)

G is D53's configuration with `judgeContested` and `judgeItemBytes` 200 (the combined branch); "+C" is G with
`consequenceProbe`.

Funnel, suites hidden and held-out 1–4, seeds 41–44 (returned / delivered / decoys delivered / calls per task):

| | returned | delivered | decoys | calls/task |
| --- | --- | --- | --- | --- |
| G | 148/268 | 128/268 | 21/268 | 8.5 |
| G+C | 154/268 | 137/268 | 21/268 | 8.8 |

Every change is a classed request: change-freeze 0→3 returned, 0→3 delivered (release); trip-passport-expiry 0→2,
0→2 (travel); passport-away 0→1 returned, 0→4 delivered (travel: three from the cache search, cached by an earlier
task's lookups). All by the conflict ground; no decoy delivered by it. No other template changed.

Simulation, realistic, seeds 41–44, planner on:

| | recall | stated | precision | soft fire | hard false fire | calls/lookup | bytes/fact | model calls/turn |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| G, no model | 0.408 | 0.366 | 0.601 | 0.299 | 0 | 7.76 | 496 | 0 |
| G+C, no model | 0.408 | 0.367 | 0.598 | 0.299 | 0 | 7.83 | 495 | 0 |
| G, perfect judge | 0.647 | 0.604 | 0.950 | 0.062 | 0 | 7.79 | 433 | 0.253 |
| G+C, perfect judge | 0.643 | 0.600 | 0.950 | 0.062 | 0 | 7.85 | 434 | 0.253 |

Model cost per 1,000 turns (perfect judge): the mean of the runs' rounded `costPer1kTurnsUsd` is $0.02025 (G) and
$0.0205 (G+C); unrounded, $0.020311 and $0.020336. The difference is one judge call in one seed (41).

The simulated world holds almost no constraint vocabulary (one "vegetarian"), so there the probe can only cost: no
consequence find was delivered in any realistic, zoo-a or zoo-b run (seeds 41–44, no model). The perfect-judge recall
change is perturbation, not a systematic loss: the extra calls shift the simulated sources' random latency and error
draws. Measured on earlier builds of this change (two sources per lookup, before `unmeasuredLimit` and the
class-verb start): on seed 42, making the calls but discarding their finds gave the same 118 facts as using them, and
not making them gave G's 123; on four further seeds (45–48, one source) G+C delivered 452 facts against G's 446.

Out of sample (zoo-a, zoo-b, seeds 41–42):

| | no model recall / precision / calls | perfect recall / precision / calls |
| --- | --- | --- |
| zoo-a G | 0.416 / 0.614 / 7.69 | 0.596 / 0.952 / 7.70 |
| zoo-a G+C | 0.419 / 0.611 / 7.73 | 0.596 / 0.949 / 7.82 |
| zoo-b G | 0.434 / 0.596 / 7.77 | 0.722 / 0.965 / 7.86 |
| zoo-b G+C | 0.434 / 0.598 / 7.90 | 0.728 / 0.965 / 7.93 |

No hard false fire in any run of the final code. Eval (no model) identical with every flag off.

## What is in-sample

The lexicons (`CLASSES` verbs, terms, ties) were written before anything ran and their terms were not changed. These
were changed after measuring, and are in-sample: the food class narrowed to providing food or a venue (the sim's
lunch meetings made it the costliest class); a class's `scope` (general or one party), added after seeing a passport
item that names no one the request names; the source choice by cached class terms; and `unmeasuredLimit`, added after
a hard false fire in zoo-b seed 41 ("Order more printer paper" against "travel over £500 needs pre-approval"), so
zoo-b is no longer a clean out-of-sample profile for that rule. Held-out 5–7 were not read or run.

## Limits

- One source per lookup: a constraint in the second-best source is found only on a later lookup of the class (the
  legal-hold template was delivered on two seeds with two sources and none with one, on earlier builds; two sources
  cost about 0.04 more calls per lookup with the perfect judge in the simulation, 7.89 against 7.85).
- Every-word sources get one term per lookup; the first term of each class carries most of the first lookup.
- The conflict test reads an undated block in a title ("Change freeze: quarter-end close") as covering every day when
  the body's dates are elsewhere; for consequence finds this matters more, since titles name the constraint.
- Cold start costs calls: 8.5 → 8.8 per task in the funnel, where each suite is a new user.
