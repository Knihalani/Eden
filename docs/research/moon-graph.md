# A per-user knowledge graph with graph-walk retrieval (track graph, flags off)

Status: 2026-10-31. Two flags, `graph` and `graphMerge`, off by default (proposed D56); no model call, no source call,
no dependency. State is per user, inside the item cache's per-user entry, bounded, and dropped with the items. Every
number below comes from commands run in this work, on the final code unless a row says otherwise. Development used
the dev suites only (hidden, held-out 1–4), the realistic simulation and zoo-a and zoo-b; held-out 5–8 were neither run
nor read. **The funnel numbers are in-sample**: the planted items of the dev suites were read while designing the
extraction and the guards (see "How it was built"). The simulation (which no part of the design read) is the
out-of-sample check, and it moves much less.

`H` is D55's recommended configuration. `HG` is `H` plus `{"graph":true,"graphMerge":true}` (the recommendation);
`H+graph` is `H` plus `{"graph":true}` alone.

## The problem

With `--sync` (every source item already in Eden's cache), H on the dev suites returns 118 of 268 planted facts to its
own search and delivers 147, with 18 decoys. What it still misses is mostly not coverage: the planted item is cached,
and nothing in the request's words reaches it. A good share of those misses are tied to the request by *things*
rather than words:

- "Reply to Ahmed Hassan …" and Legal's "do not commit delivery dates to Umbrella Health": Ahmed's address is at
  umbrellahealth.com, which another mail shows.
- "Give Łukasz Nowak the first draft …" and "#team: Łukasz: I'm fully offline from Mon 26 Oct": the user's mail shows
  Łukasz Nowak goes by Łukasz.
- "Send Ingrid the Q4 roadmap deck" and the Globex account record ("Primary contact: Ingrid Berg … the mutual NDA
  expired … do not share confidential material").
- "Send the Globex contract to my manager" and "I'm on leave 26 Oct to 6 Nov … Mark (your manager)".
- "schedule the billing service release for thursday 2pm" and "No production changes from Wednesday 28 October to
  Tuesday 3 November": the day.
- "find me flights … weekend of the 21st of november" and "Robin's passport … expires 2 Nov 2026": every day after it.

## What was built

`packages/engine/src/kg.ts` (one file, ~750 lines with comments), wired into `ItemCache` and `ContextPartner`.

**Nodes.** One namespace for named things, a name squashed to its lower-case letters and digits, so the domain label
`umbrellahealth` and the name "Umbrella Health" are one node: people (header names, chat speakers), organisations (an
address's domain, minus the top-level and second-level labels; free mail names none), projects and systems
(capitalised runs, a number continuing a run: "SOC 2", "H1 2027"; a title's first word counts, a sentence's does not
unless it is a known name). Besides: addresses, identifiers ("INV-7174", "SEC-373", IBAN-like numbers), channels
(`#legal`), roles named as someone's ("your manager", "the CFO", "(Legal)"; never "my X", which in someone else's mail
is theirs), and days.

**Edges.** Item to node, typed: `about` (in its title), `authored` (From, organiser, owner, chat speaker), `attended`
(To, Cc, attendees, `meta.people`), `mentions`, `ref`, `channel`, `role`, `on` (an event's day) and `constrains`: a
node named in a sentence that blocks, moves or settles something (`conflict.ts` `constrains`, the conflict test's
own vocabularies); when an item has such a sentence, its author and title subject constrain too; a day is linked only
as `constrains`, for each day of a span such a sentence states (spans of 21 days or more, and every day after an
expiry, are kept whole and scanned). Node to node: `alias` (a person to their address and first name; a role to the
person it names) and `member` (a person to the organisation their address is at).

**Bounds and lifecycle.** At most 48 nodes and 4 long spans an item, 64 links a node, 120,000 nodes a user; the first
4,000 characters of an item are read, every pattern linear and bounded (hostile-input tests for each: 400 KB inputs
in under 250 ms). The graph lives in the cache's per-user entry: added on `put`, removed on eviction, expiry, a
forgotten source or user (a link survives while some item still states it; orphan nodes go). It is built on first use
when the flag is turned on for a cache already holding items. Items are stored redacted (`sanitizeItem`) before the
graph reads them, so no secret becomes a node (a test checks an AWS key). Item text is matched against fixed
patterns, never followed.

**Walk.** Seeds: the request's names (as extracted, plus capitalised runs the user's items know, plus the words of a
longer name that is no node, weaker and without link hops), identifiers, roles and, with `graphDays`, its days.
Spreading activation: two hops of node links (first name → person → organisation; the second hop at 0.6), a first name
several people go by divided between them, an organisation's many people sharing its activation; then each node
spreads to its items divided by log2(2 + its degree), weighted by the edge's type (priors: ref 1.2, about 1, authored
0.9, alias 0.8, role 0.8, mentions 0.7, member 0.7, attended 0.6, on 0.5, channel 0.5; an edge that constrains ×3).
An item's score from one seed is the best of the nodes that seed reached it through (a person's name, address and
first name are one vote), summed across seeds. Hubs (more than 400 items) spread nothing, and the user's own name,
addresses and organisation (`selfOf` and their links) are kept out: in a small cache they are not yet hubs. A day
seed reaches only what constrains that day. Hard bound `graphBudgetMs` (2 ms), checked every 128 steps.

**Use.** On the slow path, after the lookup's items are cached: the top `graphItems` (16) walked items are ranked
(they never enter the other paths' candidates: the confident path, the fallback and every other ground read exactly
what they read without the graph). The best `graphSeats` (1) the judge would not otherwise see gets a seat, and walked
items count as tied for `judgeTied`. With `groundConflict` and no model's say, a walked item is set against the
request by `conflict.ts` with the labels of the nodes it was reached through as extra ties ("umbrella", "health") and,
when its author is a seed or one of the seed's own names or role holder, as speaking for the request's party (its
"I" is them: `assess`'s new `speaks`). It is delivered (grounded "graph", the best walked first, `graphGround` 1) only
when the request acts or asks or arrived from outside, the item binds (it has a constraining sentence), it is not a
system notification reached by a person's name, it states no amount limit a request without an amount cannot be set
against (`unmeasuredLimit`, as for the consequence probe), and `quietNameOnly` passes. Without `graphMerge` this runs
only when the request's own conflict ground found nothing; with it, the walk's best conflict joins the request's own.

**Learning.** Each injection carries the mask of edge types its walked items were reached by; when usage tracking
records it used or unused (or explicit feedback corrects it), the user's Beta(α, β) per edge type is updated (evidence
decaying 0.995 per update) and the walk weights each type by its posterior mean over the prior's, clamped to
[0.25, 2] (`graphLearn`, on with the graph). The funnel has no usage signal, and turning learning off changed no
funnel number (below): its effect is not measured here.

## How it was built (and what each guard is for)

Iterations on the `--sync` funnel (dev suites, no model), each change kept only if it raised hidden deliveries
without raising decoys, and checked for "noise" (items delivered that are neither the planted fact nor its decoy):

| Step | Delivered / decoys | Noise items | What changed |
|---|---|---|---|
| H (`--sync`) | 147 / 18 | 189 | |
| first walk, graph finds appended to conflict hits | 171 / 17 | 255 | the walk's finds leaked into every path's candidates (an entity bonus made them eligible) |
| graph only when the own ground finds nothing; walked items read only by the graph path | 164 / 17 | 197 | |
| two link hops; roles linked to the person in apposition; `(your manager)` | 174 / 17 | 205 | |
| user's own neighbourhood excluded; graph ground needs a binding item; word-of-name seeds without hops | 168 / 18 | 197 | from the realistic simulation: small caches made the user's own name no hub |
| top-level domain label dropped (`hooli.xyz` is Hooli); addresses tie nothing; amount limits not raised | 170 / 18 | 190 | |
| an item binds when any sentence of it does; a title's first word is its subject | 180 / 18 | 187 | |
| long spans and expiries kept whole | 181 / 18 | 187 | |
| only for a request that acts, asks or arrives (`engaged`) | 181 / 18 | 187 | "haha Lucía sent me a meme" had raised a payment notice |
| `graphMerge` | 192 / 18 | 203 | |

Guards came from the realistic simulation's `grounded-graph` deliveries, which no funnel item motivated: the user's
own name and organisation spreading in a small cache, a first name of an unknown "Sam Ortiz" standing for Sam Patel,
a Jira notification "Status: Blocked" raised for "move my lunch with Bill", "travel over £500 needs pre-approval"
raised for an organisation's call, and a remark naming someone.

## Results

### Funnel, no model (dev suites hidden, held-out 1–4, seeds 41–44; returned / delivered / decoys of 268)

| Run | H | H + `graph` | HG |
|---|---|---|---|
| `--sync` (every source item cached) | 118 / 147 / 18 | 118 / 181 / 18 | 118 / 189 / 18 |
| no sync (cache holds what lookups returned) | 148 / 128 / 21 | 148 / 132 / 21 | 148 / 132 / 21 |

Other items delivered (neither the planted fact nor its decoy), `--sync`: H 189, HG 203. With `graphWordTies` on as
well (the request's own words tie a walked item reached by a name), `--sync` reaches 192 / 18 (duplicate-invoice 0→3:
"re-issued the same invoice by mistake" is tied by "invoice"); the simulation does not move with it (realistic and
synced rows identical), so it stays off by default and out of the recommendation.

Calls per task are unchanged (the graph makes no call). Ablations on the `--sync` funnel (H + `graph`, before
`graphMerge`, 181/18/187): no day seeds 176/18; `graphWordTies` (the request's words as ties for walked items) on or
off 181/18 (so it is off by default); `graphGround` 2: 183/18 with 193 noise items; `graphItems` 8: 180, 32: 181;
`graphLearn` off: 181; `quietNameOnly` off: 180/17 (189 noise); `groundConflict` off: 59/19 (the graph's ground lives
inside the conflict ground).

Where H + graph + merge delivers what H did not (`--sync`, of 4 seeds each): legal-hold 0→4, colleague-on-leave 0→4,
roadmap-confidential 0→4, manager-on-leave 0→4, school-pickup-inset-day 0→4, trip-passport-expiry 0→4, nda-lapsed
0→4, change-freeze 0→4, counsel-on-leave 0→4, rfp-deadline-passed 1→4, duplicate-invoice 0→3, allergy 0→1,
vendor-access-suspended 0→1, confidential-reference 3→4; no template lost a delivery, no decoy was added. Still
missed with everything local: the semantic gaps the graph cannot see ("open a req" against "net-new headcount",
"announcing the new pricing" against "the change slips", "flights to Singapore" against "no international trips until
it arrives", a 15% discount against "discounts above 10% need CFO sign-off" where no name ties them), a person the
user's items never name (Kofi Boateng: no item says where he works), and conflicts `conflict.ts` does not read
("no walking more than a couple of hundred metres").

### Simulation (4 seeds; no judge and the perfect judge)

| Profile | Config | No judge: recall / precision / soft fire | Perfect: recall / precision | Calls / lookup | Model $ / 1k turns |
|---|---|---|---|---|---|
| realistic | H | 0.407 / 0.639 / 0.086 | 0.645 / 0.952 | 7.78 | $0.0172 |
| realistic | HG | 0.407 / 0.639 / 0.086 | 0.654 / 0.955 | 7.80 | $0.0178 |
| realistic `--sync` | H | 0.421 / 0.601 / 0.121 | 0.724 / 0.807 | 6.66 | $0.0172 |
| realistic `--sync` | HG | 0.427 / 0.602 / 0.121 | 0.734 / 0.810 | 6.62 | $0.0179 |
| zoo-a | H | 0.400 / 0.637 / 0.090 | 0.613 / 0.954 | 7.55 | $0.0174 |
| zoo-a | HG | 0.403 / 0.638 / 0.090 | 0.624 / 0.956 | 7.56 | $0.0179 |
| zoo-b | H | 0.435 / 0.627 / 0.178 | 0.738 / 0.969 | 7.84 | $0.0209 |
| zoo-b | HG | 0.435 / 0.627 / 0.178 | 0.742 / 0.969 | 7.84 | $0.0214 |

Seeds 41–44 for every profile; calls per lookup are the perfect-judge runs'. No hard false fire in any run. Bytes per
needed fact: realistic 432 → 431, zoo-a 429 → 428, zoo-b 421 → 423. Two judge seats (`graphSeats` 2) gave the same
realistic recall at $0.0182.

The realistic simulation without sync caches only what lookups return: the graph there has little to walk, and its no
judge row is unchanged. With `--sync` (lab-only, new: every source item put in the cache before each session), the
graph's no-model deliveries in the realistic profile were 8 of 9 relevant in the run before the `engaged` guard (the
ninth was the remark above). The perfect judge gains from the graph's seat in every profile: it shows the judge an item
the request is tied to by a name or a day. That seat costs input tokens: with one seat (`graphSeats` 1) the realistic
model cost rises $0.0172 → $0.0178 per 1,000 turns.

### Cost of the walk

`bun packages/sim/src/lab/graph-bench.ts --reps 30` (4 seeds' worlds, every dev suite planted, 6,187 items synced;
8,040 walks of the dev requests; a shared 4-CPU machine, wall times noisy): building the graph 0.095 ms per item
(the difference between `put` with and without it), about 1,100 nodes per user, a walk p50 30 µs, p95 118 µs, p99
430 µs, max 9.0 ms (wall; an outlier on the shared machine: the 2 ms bound is checked every 128 steps), mean CPU 71 µs
per walk. End to end (process CPU of the held-out 4 funnel with `--sync`, 8 worlds × 15 tasks, two runs each): H 3.46
and 3.44 s user, H + graph 4.97 and 4.90 s; about 1.1 s of the difference is building the graphs at sync time
(8 × 1,500 items × 0.095 ms), which leaves about 3 ms of CPU per lookup for the walk, the extraction of new items and
the conflict test on walked items (derived, not measured directly).

## Risks and what is not known

- In-sample: the funnel gain is on suites whose planted items shaped the design (the extraction of "(your manager)",
  first names from chat speakers, title subjects, expiries). Held-out 5–8 decide; they were not run.
- Precision: the realistic simulation's precision does not fall, but its no-model graph deliveries are few (it is not
  a world of constraints). The funnel's other items delivered rise 189 → 203 with `graphMerge` (187 without).
- Org-wide constraints reached through a person's organisation ("do not commit delivery dates to Umbrella Health") are
  raised for any act on anyone there: right for a hold, wrong for a thank-you note, which the conflict test cannot tell
  apart (the partner test's question form is quiet; an imperative is not).
- Model cost per 1,000 turns rises 2.5–4.5% across profiles (one more judge candidate).
- Without sync, the graph only knows what lookups and probes brought in: no-model funnel +4.
- Not done: co-reference of systems through shared channels or projects ("billing migration" and "production" in one
  channel), item-to-item hops, and anything live.
