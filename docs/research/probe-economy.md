# The probe economy: learned per user, no model (D50, PoC)

Status: 2026-10-30. Follows [sharper-grounds.md](sharper-grounds.md) (D48). Both behaviours are behind flags, off by
default (`probeFresh`, `probeYield`; `packages/engine/src/economy.ts`). Numbers come from commands run in this work
(no ledger record: `--no-record`).

## What the probes were spending calls on

With F (D48's settings) in the simulation (realistic profile, perfect judge, seeds 41 and 42), each probe call was
logged with its kind, its source, the ids it returned, which of them were new to the user's cache, and whether any of
those reached the judge or were delivered and the lookup's own search had not found them (a temporary log, not kept):

- 22% of the probe calls that reached a source repeated a query the same user had already sent to the same source.
  When the previous answer had brought nothing new, the repeat brought something new 7% of the time and something
  that reached the judge 3% of the time (10 of 362); after an answer that had, 31% and 17%.
- Yield differed by kind and source as one would expect of real mail, calendars and documents: the first person at
  the mail and the calendar paid most often; the topic at the CRM, the drive and the chat almost never; the day
  listing seated something new 58% of the time.
- And the person probe went to the source map's best three sources only. Sending it to all five raised recall a lot
  (no model 0.326 → 0.359, perfect judge 0.613 → 0.651) at 8.7 calls per lookup, over the 7.9 budget.

So the calls are there to be had back, and spent where they pay.

## Two estimates, learned per user

**Has the answer changed? (`probeFresh`).** Each (query, source) a user's probes ask keeps when it was last asked
live, a hash of each item in that answer, how many times it was asked again, how many of those answers had changed (a
new item, or an item's text changed) and the time between. Its change rate is the Gamma–Poisson posterior mean, with
the user's own pooled rate (over all their queries, plus half a change) as the prior: a query asked once borrows the
user's rate. The chance it changed since last asked is 1 − e^(−λ·Δt); below `probeFreshFloor` (0.15) it is not asked
again, and its last answer stands in for the call while every item of it is still cached (else it is asked). Nothing
is skipped before the user has six re-asks behind them. This is a web crawler's revisit policy (Cho & Garcia-Molina,
"Effective page refresh policies", 2003), per person per source: time-based and unit-free, so it adapts to whatever
pace the user's own sources change at: a colleague who writes daily is asked again, a dentist who writes twice a year
is not.

**Is this kind of probe worth a call to this source? (`probeYield`).** An arm is a probe kind (first person, second
person, organisation, topic, role, day listing) at one source. A live call is booked a miss when it is made and turned
into a hit when an item it brought new to the user's cache, which the lookup's own search did not also return, is
seated with the judge or delivered, in that lookup or any later one (a probe's find often pays off turns later, from
the cache). The call is made while the upper 90% bound of the arm's Beta posterior (prior: two pseudo-calls at the
user's pooled yield for that kind) is at least `probeYieldFloor` (0.05); an arm is always called for its first four
calls. Evidence decays by 0.99 per call, and a dropped arm's by 0.99 per skip, so it is tried again after some tens of
skips: a source that starts to matter is found. With `probeYield` the first person goes to every source, best first,
and the user's own yields drop the ones where their people never are: which sources hold a user's people is learned,
not guessed at three.

Neither ever adds a call beyond what the probes would send; all state is per user (`ProbeEconomy`, keyed by the
tenant/user scope key, bounded: 512 queries, 128 arms, 2,048 finds per user, 10,000 users), dropped with the user or
one of their sources (`forget`), and holds no item text (hashes and ids only).

### Measured and changed along the way

- **Thompson sampling against the floor** (the first version): a draw drops an arm after a few misses, and the arms
  that matter here pay one call in ten. Perfect-judge recall fell 0.613 → 0.579 at 6.7 calls per lookup. An upper
  bound drops an arm only on evidence: missing a fact costs far more than a wasted call.
- **Credit only within the lookup** that made the call: perfect recall 0.613 → 0.580. Delayed credit (booked a miss,
  turned into a hit when a find reaches later) is what made the gate safe.
- **Credit only what the judge passed**, when there was a judge: it lost recall with the wider person probe (0.650 →
  0.626); being seated is the probe's part, relevance is the judge's.
- **Credit for every returned item, not only new ones**: no better (perfect 0.602 → 0.598 with the bound).
- **Decay 0.97 per call**: no arm could ever be 90% sure of a yield under 5% (it needs about 45 straight misses, and
  0.97 keeps about 33), so a source was dropped only when its kind paid badly everywhere. 0.99 per call and per skip.
- **A change floor of 0.3** instead of 0.15 changed nothing in the simulation (its sources do not change between
  sessions, so every re-ask's chance is low).

## Results

Simulation, realistic profile, 4 seeds (41–44), 6 users × 15 sessions each, planner on; F against F +
`{"probeFresh": true, "probeYield": true}` (FX). Columns as in sharper-grounds.md: recall of needed facts, precision,
hard false fires, source calls per lookup, injected bytes per needed fact delivered.

| | judge | recall | precision | hard false fires | calls/lookup | bytes/fact |
|---|---|---|---|---|---|---|
| F | none | 0.326 | 0.588 | 0 | 7.95 | 584 |
| FX | none | **0.354** | 0.589 | 0 | **7.74** | 582 |
| F | perfect | 0.613 | 0.949 | 0 | 7.86 | 484 |
| FX | perfect | **0.647** | 0.953 | 0 | **7.79** | 477 |

Model cost per 1,000 turns (perfect judge, mean of 4 seeds): F $0.02000, FX $0.02025 (the judge sees more of the
people's items). Model calls per turn 0.251 → 0.253.

Parts, same profile and seeds (no yield gate in these rows):

| | judge none: recall, calls | perfect: recall, calls |
|---|---|---|
| F + `probeFresh` | 0.326, 7.63 | 0.612, 7.52 |
| F + person to all five sources (`probePeopleSources` 5, `probeSecondSources` 5) | 0.359, 8.74 | 0.651, 8.68 |
| the same + `probeFresh` | 0.361, 8.19 | 0.653, 8.13 |

Out of sample (zoo profiles, seeds 41 and 42, nothing tuned on them):

| | judge | F recall / precision / ff / calls | FX recall / precision / ff / calls |
|---|---|---|---|
| zoo-a | none | 0.347 / 0.636 / 0 / 7.84 | 0.365 / 0.618 / 0 / 7.65 |
| zoo-a | perfect | 0.560 / 0.952 / 0 / 7.79 | 0.591 / 0.956 / 0 / 7.63 |
| zoo-b | none | 0.344 / 0.576 / 0 / 8.16 | 0.378 / 0.585 / 0 / 7.66 |
| zoo-b | perfect | 0.681 / 0.960 / 0 / 8.23 | 0.722 / 0.967 / 0 / 7.81 |

Held-out funnels with no model (`hidden-funnel.ts --suite hidden,heldout,heldout2,heldout3,heldout4`, 268 tasks):
hidden facts returned 130 → 147, delivered 58 → 67, decoys delivered 40 → 47 (0.69 → 0.70 of hidden delivered), source
calls per task 7.2 → 8.5. Each funnel task is a new engine, so nothing is learned there: this is the cold start, where
every arm is new and the first person goes to every source. A user pays it for their first few lookups per arm.

## What it does not do

- It learns nothing in a one-lookup world (the funnel): its savings are in a user's repeat traffic.
- The simulation's sources do not change between sessions, so `probeFresh` was measured only where answers are stable;
  the change-rate side is covered by unit and engine tests (an answer that keeps changing keeps being asked).
- Decoys delivered rise with retrieval at the same ratio (bar 4 stays missed).
