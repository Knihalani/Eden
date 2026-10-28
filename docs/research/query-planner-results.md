# The query planner: results

Status: built and measured, 2026-10-28; **on by default in the server** since D33 (`EDEN_QUERY_PLANNER=0` turns it
off). Plan: docs/plans/query-planner.md. Code: `packages/sources/src/{shapes,planner,schema-args}.ts`, wired through
`PartnerDeps.planner`. The tables before "Iterations" describe the planner as first built.

## What it does

For each lookup and each connector, the planner chooses what to send. The options are query shapes: the cue's terms
(what Eden always sent), its entities joined, one call per entity, an entity plus the cue's rarest term, and quoted
entities where an operator says the connector takes phrases. It learns per (tenant, user, connector), separately for
cues with and without an entity, with Thompson sampling over Beta posteriors (`BetaBandit`). The reward is
immediate: how much of the cue the best returned item covers, as whole words; nothing returned scores 0. When the
chosen shape returns nothing, one other shape is tried in the same lookup (the cascade), unless the connector has
taught the planner that its cascades find nothing (iteration 1, below; D30). Up to 3 calls per lookup per connector.

It is conservative. The cue's terms are the incumbent, with a stronger prior (mean 0.75, 8 pseudo-observations). The
planner sends another shape only when that shape's posterior mean beats the incumbent's by 0.1, plus 5% exploration.
That rule came from the lab (below): without it the planner lost reach on OR and vector search, where every shape
returns something and the reward barely tells shapes apart.

What it stores: two numbers per (user, connector, bucket, shape), in memory and in the source map's SQLite. Both are
cleared by `forget`. It never stores query text. Traces record each lookup's shapes and call counts, never the query.
Every extra call takes its own token from the connector's per-user rate limit, so the limit counts calls, not lookups. A
store that fails costs persistence, not the lookup. Queries are built from untrusted text, so every shape drops
search-syntax characters and operator words (fuzzed: 3,000 random inputs, no operator survives).

## Tier 2: the simulation's connector zoo

The same world behind connectors with different search semantics, all passing Eden's query through unchanged:
- The tune set (`zoo-tune`) was used to choose settings.
- Held-out sets A (`zoo-a`) and B (`zoo-b`) give each source a semantics it never had in tuning.
- `realistic` is the earlier hosted-product profile.

Six simulated users with 15 sessions each, per seed; 95% Wilson intervals over facts. Raw:
[query-planner-sim.jsonl](query-planner-sim.jsonl), produced by [query-planner-sim.sh](query-planner-sim.sh).
"Retrieved or already cached" counts needed facts that some lookup returned or the user's cache already held.

| Connector mix | Judge | Planner | Seeds | Needed facts retrieved or already cached | Recall (needed facts delivered) | Precision | False fires / silent turns | Source calls per lookup |
|---|---|---|---|---|---|---|---|---|
| zoo-a | none | off | 5 | 17% (15–19) | 9.0% (7–11) | 0.563 (134/238) | 1/713 | 4.11 |
| zoo-a | none | on (up to 3 calls) | 5 | 41% (38–44) | 17.6% (15–20) | 0.598 (223/373) | 1/713 | 6.28 |
| zoo-a | none | on (1 call) | 5 | 21% (18–23) | 10.6% (9–13) | 0.560 (155/277) | 1/713 | 4.11 |
| zoo-a | perfect | off | 3 | 17% (14–20) | 14.8% (12–18) | 0.698 (162/232) | 1/398 | 4.12 |
| zoo-a | perfect | on (up to 3 calls) | 3 | 45% (41–49) | 39.6% (36–44) | 0.790 (362/458) | 1/398 | 6.34 |
| zoo-b | none | off | 5 | 61% (57–64) | 21.5% (19–24) | 0.535 (292/546) | 1/713 | 4.13 |
| zoo-b | none | on (up to 3 calls) | 5 | 64% (60–67) | 23.9% (21–27) | 0.560 (317/566) | 1/713 | 6.06 |
| zoo-b | none | on (1 call) | 5 | 60% (56–63) | 21.6% (19–24) | 0.547 (294/537) | 1/713 | 4.13 |
| zoo-tune | none | off | 5 | 23% (21–26) | 14.0% (12–16) | 0.567 (183/323) | 1/713 | 4.11 |
| zoo-tune | none | on (up to 3 calls) | 5 | 45% (41–48) | 18.9% (16–22) | 0.588 (234/398) | 1/713 | 6.04 |
| realistic | none | off | 5 | 19% (17–22) | 13.1% (11–15) | 0.634 (170/268) | 1/713 | 4.11 |
| realistic | none | on (up to 3 calls) | 5 | 42% (39–45) | 18.9% (16–22) | 0.613 (246/401) | 1/713 | 6.52 |
| realistic | none | on (1 call) | 5 | 23% (20–26) | 14.5% (12–17) | 0.645 (196/304) | 1/713 | 4.11 |

- **Held-out A** (mostly substring and AND search): with no model, recall rose from 9.0% to 17.6%. With a perfect
  judge in the model's place it rose from 14.8% to 39.6%, and precision from 0.70 to 0.79. The intervals do not
  overlap.
- **Held-out B** (mostly OR and ranked search): recall moved from 21.5% to 23.9%, within noise. Little is lost there
  to begin with.
- **False fires:** unchanged in every configuration (1 or fewer in 398–713 silent turns).
- **Cost:** source calls per lookup rose by about 50% (4.1 to 6.0–6.5), within each connector's per-user rate
  limit, which counts every call. Capped at one call, the planner costs no
  more calls, but its gain mostly disappears (held-out A: 10.6%, within noise of 9.0%). Today's query stays the
  first choice until it fails, and with one call there is no cascade to rescue the lookup meanwhile.

## Tier 3: real MCP servers in the connector lab

Eight open-source servers in ten configurations (docs/research/connector-lab.md), seeded with world 1000; 196 cases
(73 for CalDAV, 154 for IMAP). Each planner run starts from nothing and learns online over the cases in order, so its
reach includes the cost of learning. "Best fixed" is the best of five fixed variants chosen in hindsight; no
deployment can know it in advance. Raw: [query-planner-lab.jsonl](query-planner-lab.jsonl) (conservative, the
default) and [query-planner-lab-thompson.jsonl](query-planner-lab-thompson.jsonl) (plain Thompson sampling, and every
fixed variant). Reproduce: `bun run sim:lab --sessions 120 [--only-planner]`.

| Connector | Cases | terms (today) | best fixed (hindsight) | planner, plain Thompson | planner, conservative (default) | calls per case | second half |
|---|---|---|---|---|---|---|---|
| memory | 196 | 0% (0–2) | each-entity 71% (65–77) | 69% (63–75) | 69% (62–75) | 1.48 | 63% |
| mcpvault | 196 | 83% (77–87) | terms 83% (77–87) | 72% (66–78) | 81% (75–86) | 1.01 | 81% |
| basic-memory | 196 | 63% (56–70) | terms 63% (56–70) | 72% (65–78) | 72% (65–78) | 1.15 | 74% |
| meilisearch | 196 | 30% (24–37) | each-entity 64% (57–70) | 66% (59–72) | 62% (55–69) | 1.30 | 57% |
| caldav | 73 | 0% (0–5) | each-entity 77% (66–85) | 73% (61–82) | 70% (59–79) | 1.48 | 75% |
| imap-body | 154 | 0% (0–2) | each-entity 38% (31–46) | 36% (29–44) | 32% (25–40) | 1.53 | 34% |
| imap-subject | 154 | 0% (0–2) | each-entity 55% (47–63) | 53% (45–61) | 44% (37–52) | 1.52 | 43% |
| chroma | 196 | 88% (82–92) | question 91% (87–95) | 79% (72–84) | 86% (81–90) | 1.01 | 87% |
| gitea-db | 196 | 0% (0–2) | each-entity 27% (21–33) | 24% (19–30) | 23% (18–29) | 1.63 | 19% |
| gitea-bleve | 196 | 0% (0–2) | each-entity 27% (21–34) | 24% (19–30) | 24% (19–31) | 1.63 | 21% |

- **Today's query reaches nothing** on six configurations: the reference memory server, CalDAV, IMAP body and
  subject, and Gitea with either indexer. There the conservative planner reaches 23–70%, a few points below the best
  fixed variant in hindsight; the gap is what learning costs.
- **Gains elsewhere:** on Basic Memory the planner beats every fixed variant (72% against 63%) by mixing shapes per
  cue. On Meilisearch it reaches 62% against today's 30%.
- **No real regression:** on mcpvault (OR), today's query was the best fixed variant; on Chroma (vector) it was
  within noise of the best (88% against the raw question's 91%, which the planner cannot send). The conservative
  planner stays within noise of today's query on both (81% vs 83%, 86% vs 88%). Plain Thompson sampling lost 11
  and 9 points there, which is why the incumbent rule exists.
- **Cost of conservatism:** it learns slower than plain Thompson on some substring connectors (IMAP subject 44% vs
  53%). The cascade rescues most lookups while today's query is being disproven.
- **Calls per case:** 1.01–1.63. They are highest where today's query fails and per-entity calls take over.

## Phase 5, in simulation: shadow mode

The plan's phase 5 ran the planner in shadow on consenting real accounts. By the owner's decision it runs in
simulation instead. In shadow mode (`planner.mode = "shadow"`, `EDEN_QUERY_PLANNER=shadow`), the engine serves
exactly as without a planner and runs the planner's lookup beside it, and nothing it finds is cached or delivered:
- it runs only for connectors that served the lookup normally, so it adds no load to one skipped as open, busy or
  limited;
- its calls draw on their own rate bucket per (user, connector), at half serving's rate and burst, and wait while
  serving's bucket is empty; they never take serving's tokens, so serving loses no call (an engine test sends every
  lookup of a burst of 10 with no planner and in shadow). The cost is upstream load: a shadowing deployment can send a
  connector up to 1.5x what serving alone may. Rerunning the experiment below after this change gave byte-identical
  results: no shadow call was ever rate-limited in it;
- it runs one shadow lookup per session at a time;
- it learns from what comes back;
- it reports a content-free record to `onShadow`: shapes, calls, sanitized item ids, and the served item ids.

The simulation adds what real accounts could not: labels, to check what the content-free records say. Held-out sets
A and B and the realistic mix, five seeds each, 6 users with 15 sessions. "Shadow, then serve" runs in shadow for
the first 5 sessions per user, then serves with what it learned. Raw:
[query-planner-shadow.jsonl](query-planner-shadow.jsonl), from [query-planner-shadow.sh](query-planner-shadow.sh).

| Mix | Run | Recall, all sessions | Recall, sessions 6–15 | Precision | False fires / silent turns | Source calls per lookup | Errors (simulated) |
|---|---|---|---|---|---|---|---|
| zoo-a | off | 9.0% (7–11) | 9.3% (7–12) | 0.563 | 1/713 | 4.11 | 44 |
| zoo-a | shadow | 9.0% (7–11) | 9.3% (7–12) | 0.569 | 1/713 | 10.36 | 130 |
| zoo-a | serve | 17.6% (15–20) | 17.6% (15–21) | 0.598 | 1/713 | 6.28 | 76 |
| zoo-a | shadow-then-serve | 15.5% (13–18) | 18.9% (16–22) | 0.637 | 1/713 | 6.74 | 83 |
| zoo-b | off | 21.5% (19–24) | 23.5% (20–27) | 0.535 | 1/713 | 4.13 | 43 |
| zoo-b | shadow | 21.7% (19–24) | 23.8% (21–27) | 0.537 | 1/713 | 10.12 | 130 |
| zoo-b | serve | 23.9% (21–27) | 25.5% (22–29) | 0.560 | 1/713 | 6.06 | 63 |
| zoo-b | shadow-then-serve | 23.4% (21–26) | 26.3% (23–30) | 0.561 | 1/713 | 6.49 | 72 |
| realistic | off | 13.1% (11–15) | 13.5% (11–16) | 0.634 | 1/713 | 4.11 | 43 |
| realistic | shadow | 13.2% (11–15) | 13.7% (11–17) | 0.635 | 1/713 | 10.60 | 137 |
| realistic | serve | 18.9% (16–22) | 18.7% (16–22) | 0.613 | 1/713 | 6.52 | 86 |
| realistic | shadow-then-serve | 18.7% (16–21) | 21.7% (19–25) | 0.651 | 1/713 | 6.97 | 90 |

What a deployment would see, and what the labels say about it:
- "Would add" counts need turns where the shadow lookup returned a needed fact that serving did not.
- The signal is the content-free one: a connector that served nothing while the shadow lookup found something.
- Precision and recall are pooled over turns.

| Mix | Run | Shadow records | Skipped, rate-limited | Calls per record | Need turns | Shadow would add | Shadow would lose | Signal precision | Signal recall |
|---|---|---|---|---|---|---|---|---|---|
| zoo-a | shadow | 3240 | 0 | 1.47 | 698 | 176 (25.2%) | 2 | 0.599 (176/294) | 1.000 (176/176) |
| zoo-a | shadow-then-serve | 1085 | 0 | 1.49 | 233 | 50 (21.5%) | 2 | 0.575 (50/87) | 1.000 (50/50) |
| zoo-b | shadow | 3116 | 0 | 1.30 | 654 | 16 (2.4%) | 3 | 0.200 (16/80) | 1.000 (16/16) |
| zoo-b | shadow-then-serve | 1067 | 0 | 1.32 | 227 | 3 (1.3%) | 3 | 0.115 (3/26) | 1.000 (3/3) |
| realistic | shadow | 3239 | 0 | 1.47 | 695 | 153 (22.0%) | 1 | 0.627 (151/241) | 0.987 (151/153) |
| realistic | shadow-then-serve | 1081 | 0 | 1.48 | 232 | 51 (22.0%) | 1 | 0.600 (51/85) | 1.000 (51/51) |

- **Serving does not change in shadow.** Pooled recall, precision and false fires match planner-off within noise in
  every mix (held-out A: 9.0% and 9.0%). Seed by seed, needed facts delivered with planner off and in shadow were
  A (16, 17), (9, 10), (21, 19), (15, 15), (22, 22); B (39, 38), (52, 52), (28, 28), (38, 41), (42, 42); realistic
  (28, 28), (20, 21), (22, 22), (20, 20), (31, 31). The differences come from the simulator, not the engine: its
  connectors draw latency and errors from one random stream, so the shadow's extra calls shift which served calls
  fail (simulated errors 43–44 with planner off, 130–137 in shadow). On the `ideal` profile, which has no errors,
  the two are identical: seeds 1–3 gave the same deliveries, precision, false fires and funnel counts (run by hand
  with `--profile ideal`, not in the JSONL).
- **Calls:** shadow costs 10.1–10.6 calls per lookup against 4.1, because it repeats the lookup. No shadow call was
  skipped for lack of spare rate in these runs: simulated time between turns refills the limit.
- **The shadow lookup would add a needed fact** on 25.2% of need turns in held-out A and 22.0% in the realistic
  mix, and on 2.4% in held-out B. It would lose one that serving found on at most 3 turns of about 650–700.
- **The content-free signal is honest.** It flagged 176 of 176 real gains in A, 151 of 153 in the realistic mix and
  16 of 16 in B. When it fired, it was right in 60% of turns in A (176/294) and 63% in realistic, but only 20% in B,
  where gains were rare. No threshold for switching to serving is calibrated yet. Two things separate the mixes:
  the signal's rate per need turn (42% in A against 12% in B) and its precision.
- **Shadow learning carries over.** After 5 shadow sessions, sessions 6–15 reached 18.9% recall on held-out A
  (serving from the start: 17.6%; off: 9.3%) and 21.7% on the realistic mix (18.7%; 13.5%). Precision was the
  highest of any run (0.637, 0.651). The intervals overlap with serving from the start, so the claim is "at least as
  good, with no exposure while learning", not "better".

## Iterations

The plan's post-ship loop: one measured change at a time, tuned on `zoo-tune`, reported on held-out sets, kept only if
its target improves and no guardrail regresses. Raw: [query-planner-iterations.jsonl](query-planner-iterations.jsonl),
produced by [query-planner-iterations.sh](query-planner-iterations.sh) and summarised by
[query-planner-iterations.py](query-planner-iterations.py). The tables above were measured before these changes.

### 1. A learned cascade gate (kept, D30)

**Target:** source calls per lookup, the gate that keeps the planner off. The quality report now breaks each
connector's lookups down by path, with how many came back empty (`plans`: "drive:terms>entities", for a cascade). On
held-out A, before this change and pooled over 5 seeds, the cascade after an empty answer from the cue's terms came
back empty in 777 of 781 lookups on the OR connector and 694 of 706 on the ranked one: there an empty answer means
nothing is there, and every narrower shape is empty too. On the substring CRM, 817 of 1,125 were empty.

**Change:** whether to cascade is learned per (user, connector, bucket): a Beta posterior on "the cascade step found
something" (cue coverage above 0), decayed like the arms and stored with them. The cascade runs when a draw from it is
at least `cascadeMin` (default 0.05), or on an ε step, so a closed gate is re-tried now and then. A cascade step cut
short by the rate limit teaches nothing, to the gate or to its shape's arm.

**Tuning** (`zoo-tune`, 5 seeds). Recall and calls per lookup by `cascadeMin`:

| `cascadeMin` | 0 | 0.05 | 0.1 | 0.2 | 0.3 | 0.4 |
|---|---|---|---|---|---|---|
| Recall, no model | 18.9% | 20.4% | 18.9% | 19.1% | 18.3% | 18.7% |
| Recall, perfect judge | 39.1% | 40.0% | 38.1% | 36.6% | 34.5% | 31.0% |
| Calls per lookup | 6.04 | 5.66–5.71 | 5.46–5.48 | 5.21–5.22 | 5.04–5.05 | 4.87–4.89 |

With no model every threshold was within noise. With a judge (how a deployment runs), recall fell steadily from
0.1 up. 0.05 was chosen on the tune set as the highest threshold whose recall was not below always cascading in
either judge setting.

**Held-out** (5 seeds with no model, 3 with a perfect judge):

| Judge | Mix | Run | Needed facts retrieved or cached | Recall | Precision | False fires | Source calls per lookup |
|---|---|---|---|---|---|---|---|
| none | zoo-a | off | 16.8% (15–19) | 9.0% (7–11) | 0.563 | 1/713 | 4.11 |
| none | zoo-a | before (always cascade) | 41.1% (38–44) | 17.6% (15–20) | 0.598 | 1/713 | 6.28 |
| none | zoo-a | after (`cascadeMin` 0.05) | 44.9% (42–48) | 18.8% (16–21) | 0.624 | 1/713 | 6.01 |
| none | zoo-b | off | 60.6% (57–64) | 21.5% (19–24) | 0.535 | 1/713 | 4.13 |
| none | zoo-b | before | 63.5% (60–67) | 23.9% (21–27) | 0.560 | 1/713 | 6.06 |
| none | zoo-b | after | 62.0% (59–65) | 23.3% (21–26) | 0.558 | 1/713 | 5.79 |
| none | realistic | off | 19.4% (17–22) | 13.1% (11–15) | 0.634 | 1/713 | 4.11 |
| none | realistic | before | 41.7% (39–45) | 18.9% (16–22) | 0.613 | 1/713 | 6.52 |
| none | realistic | after | 41.3% (38–45) | 19.1% (17–22) | 0.627 | 1/713 | 6.22 |
| perfect | zoo-a | off | 16.7% (14–20) | 14.8% (12–18) | 0.698 | 1/398 | 4.12 |
| perfect | zoo-a | before | 44.8% (41–49) | 39.6% (36–44) | 0.790 | 1/398 | 6.34 |
| perfect | zoo-a | after | 45.9% (42–50) | 39.3% (35–43) | 0.792 | 1/398 | 6.06 |
| perfect | zoo-b | off | 66.1% (62–70) | 55.7% (52–60) | 0.781 | 1/398 | 4.14 |
| perfect | zoo-b | before | 66.5% (62–70) | 56.3% (52–60) | 0.790 | 0/398 | 6.07 |
| perfect | zoo-b | after | 66.1% (62–70) | 56.7% (52–61) | 0.786 | 0/398 | 5.81 |
| perfect | realistic | off | 20.0% (17–24) | 18.9% (16–22) | 0.776 | 1/398 | 4.11 |
| perfect | realistic | before | 45.2% (41–49) | 38.7% (35–43) | 0.782 | 1/398 | 6.56 |
| perfect | realistic | after | 42.6% (38–47) | 36.9% (33–41) | 0.817 | 1/398 | 6.21 |

- **Calls:** the planner's extra calls fell by 12–14% (no model: A from 2.17 to 1.90 extra per lookup, B 1.93 to
  1.66, realistic 2.41 to 2.11; perfect judge: 2.22 to 1.94, 1.93 to 1.67, 2.45 to 2.10). On held-out A the OR and
  ranked connectors' empty cascades fell from 1,471 to 1,021.
- **Recall:** within noise of before in every mix and judge setting, and still above off on A and realistic with
  intervals apart. The largest drop is realistic with a judge (38.7% to 36.9%).
- **Guardrails:** false fires unchanged; precision within noise (zoo-b 0.002–0.004 lower, the others higher); no
  planted secret leaked (0 of 120 per mix and run with no model, 0 of 72 with a judge).
- **Not enough on its own:** the planner still makes 40–51% more calls than off. A higher threshold saves more
  (0.2 cut extra calls by 42–43% on the tune set, against
  4.11 with the planner off) but cost recall there with a judge (39.1% to 36.6%), so it was not
  taken.
- **Real servers** (the connector lab, world 1000, planner only, measured at `cascadeMin` 0.2, which closes the gate
  sooner than the default; raw: [query-planner-lab-cascade.jsonl](query-planner-lab-cascade.jsonl)): reach and calls
  per case within noise of before on all ten configurations. Every lab case has a needed item to find, so the cascade
  there often finds something and the gate stays open:

| Connector | Cases | Reach before | Calls per case before | Reach after | Calls per case after |
|---|---|---|---|---|---|
| memory | 196 | 69% | 1.48 | 69% | 1.43 |
| mcpvault | 196 | 81% | 1.01 | 81% | 1.01 |
| basic-memory | 196 | 72% | 1.15 | 72% | 1.15 |
| meilisearch | 196 | 62% | 1.30 | 63% | 1.35 |
| caldav | 73 | 70% | 1.48 | 68% | 1.42 |
| imap-body | 154 | 32% | 1.53 | 33% | 1.51 |
| imap-subject | 154 | 44% | 1.52 | 47% | 1.48 |
| chroma | 196 | 86% | 1.01 | 88% | 1.01 |
| gitea-db | 196 | 23% | 1.63 | 21% | 1.67 |
| gitea-bleve | 196 | 24% | 1.63 | 21% | 1.67 |

**Tried and dropped:** choosing the cascade's shape by the highest posterior mean, or by mean per call, instead of a
Thompson draw (tune set, no model, at 0.2): recall 18.2% and 17.8% against 19.1%, calls 5.33 and 5.19 against 5.22.
These came from a scratch build that was not kept, so they are not in the raw data (unverified by the committed
scripts).

**On the held-out discipline:** a first version of this change used 0.2 and was measured on the held-out sets, where
recall came out lower in every mix (within noise). 0.05 was then added to the tune grid and chosen on the tune set
alone, by a criterion written after that look. Every held-out gap is inside its interval, but those sets are no
longer fresh for this parameter; the next review checkpoint rotates the held-out seeds (the plan's step 6).

### 2. Reuse a shape's recent answer (kept)

**Target:** source calls per lookup. One call per entity repeats across a session's lookups ("Dana Lee" is searched
for every cue that names her), but the planner's calls bypassed the fan-out's result cache, which only held whole
lookups. Up to 13% of the planner's calls on held-out A repeated an earlier query text on the same connector (scratch
measurement, seed 1; not in the raw data).

**Change:** the planner's calls go through the fan-out (`SourceFanout.planCalls`). A shape's query answered within
the cache's fresh window (60 s) is served from the cache, at no call and no rate token; others are made once
(singleflight), sanitized before they are held, and cached under their own key, so a lookup never joins its own
call. `forget` drops them with the rest. A planned source whose calls went through this fan-out is not sanitized a
second time; one whose calls came from anywhere else still is. Shadow lookups keep calling the connector directly,
so nothing they find is cached (D29). `QueryPlanner`'s `reuse` (default on) exists to measure the saving.

**Measured** on the tune set (identical recall and precision, calls per lookup 5.66 to 5.47 with no model and 5.71 to
5.51 with a judge), then on fresh held-out seeds 6–10 (6–8 with a judge), because seeds 1–5 had been looked at in
iteration 1:

| Judge | Mix | Off | Before (no reuse) | After | Recall off / before / after |
|---|---|---|---|---|---|
| none | zoo-a | 4.10 | 5.93 | 5.73 | 9.0% / 18.4% / 18.4% |
| none | zoo-b | 4.10 | 5.77 | 5.60 | 18.2% / 19.7% / 19.7% |
| none | realistic | 4.09 | 6.16 | 5.99 | 10.6% / 17.6% / 17.6% |
| perfect | zoo-a | 4.09 | 5.96 | 5.73 | 18.2% / 38.9% / 38.2% |
| perfect | zoo-b | 4.10 | 5.71 | 5.57 | 54.1% / 56.2% / 56.2% |
| perfect | realistic | 4.09 | 6.13 | 5.98 | 16.8% / 35.4% / 36.3% |

(Source calls per lookup; the full rows, with intervals, precision, false fires and secrets, are in the raw data.)

- **Calls:** the planner's extra calls fell 7–12% (no model: A 1.83 to 1.63, B 1.67 to 1.50, realistic 2.07 to 1.90;
  with a judge: 1.87 to 1.64, 1.61 to 1.47, 2.04 to 1.89).
- **Quality:** with no model, recall, precision and false fires are identical before and after: reuse returns what
  the call would have. One retrieved fact differs (realistic, seed 7), from the simulator's shared error stream,
  which draws differently when fewer calls are made. With a judge, recall moved within noise both ways.
- **Guardrails:** false fires equal; no planted secret leaked (0 of 120 per run set, 0 of 72 with a judge).

### Lab, second world (world 2000)

The connector lab on a second seeded world, every variant; reach is over all cases, as in the world-1000 table
(raw: [query-planner-lab-world2000.jsonl](query-planner-lab-world2000.jsonl); reproduce: `bun run sim:lab --world
2000 --sessions 120`). The planner column ran with iteration 1 at `cascadeMin` 0.2 and without reuse, the code at the
time of the run; the JSONL does not record that configuration (unverified from the raw data alone).

| Connector | Cases | terms (today) | best fixed (hindsight) | planner | calls per case |
|---|---|---|---|---|---|
| memory | 202 | 0% | each-entity 71% | 71% | 1.45 |
| mcpvault | 202 | 84% | terms 84% | 84% | 1.00 |
| basic-memory | 202 | 62% | each-entity 63% | 69% | 1.12 |
| meilisearch | 202 | 31% | each-entity 68% | 61% | 1.32 |
| caldav | 69 | 0% | each-entity 72% | 68% | 1.51 |
| imap-body | 161 | 0% | each-entity 50% | 44% | 1.64 |
| imap-subject | 161 | 0% | each-entity 39% | 29% | 1.66 |
| chroma | 202 | 85% | question 86% | 85% | 1.00 |
| gitea-db | 202 | 0% | each-entity 27% | 23% | 1.72 |
| gitea-bleve | 202 | 0% | each-entity 29% | 25% | 1.71 |

World 1000's findings hold on a second world:
- today's query reaches nothing on the same six connectors, and one call per entity is the best fixed variant on
  most of them;
- the planner matches today's query where it already worked (mcpvault, Chroma);
- it beats every fixed variant on Basic Memory again (69% against 63%);
- elsewhere it trails the best fixed variant (chosen in hindsight) by 0–10 points, its learning cost, as on world
  1000.

### 3. No call the deadline will cut off (kept)

**Target:** source timeouts, which D31 requires checking at real pacing. A timed run
([query-planner-timed.sh](query-planner-timed.sh): latency, agent pacing, the connectors' rate limits of 5–10 calls/s
per user and the engine's 1.5 s source timeout all live, at 1/10 of real time; seeds 11–13, 6 users, 4 sessions; raw:
[query-planner-timed.jsonl](query-planner-timed.jsonl)) showed the planner's calls after a lookup's first running into
the deadline: 81–123 calls given up on per mix, against 6 with the planner off. Each one costs the connector a call,
returns nothing, and counts as a timeout against it (its circuit breaker).

**Change:** a call after a lookup's first is started only if the lookup's slowest call so far, times a margin (2),
still fits before the fan-out's deadline (`deadlineMargin`). A shape cut short this way is not credited. Shadow
lookups apply the same check to their own timeout. Runs without real latency are unchanged: rerun iteration-2 rows
are identical apart from the new `sources.aborted` field (0).

| Mix | Run | Source calls per lookup | Calls given up (timeouts and session ends) | 429s | Needed facts delivered |
|---|---|---|---|---|---|
| zoo-a | off | 4.62 | 6 | 0 | 14/165 |
| zoo-a | before | 6.63 | 81 | 0 | 30/165 |
| zoo-a | margin 1.25 | 6.49 | 39 | 0 | 27/165 |
| zoo-a | margin 2 (default) | 6.28 | 17 | 0 | 26/165 |
| zoo-b | off | 4.62 | 6 | 0 | 35/165 |
| zoo-b | before | 6.47 | 123 | 0 | 38/165 |
| zoo-b | margin 1.25 | 6.25 | 59 | 0 | 35/165 |
| zoo-b | margin 2 (default) | 6.08 | 36 | 0 | 36/165 |
| realistic | off | 4.61 | 6 | 0 | 20/165 |
| realistic | before | 7.01 | 91 | 0 | 31/165 |
| realistic | margin 1.25 | 6.83 | 33 | 0 | 32/165 |
| realistic | margin 2 (default) | 6.65 | 22 | 0 | 31/165 |

- **Calls given up** (timeouts and session ends) fell 71–79% from before, but are still 3–6x planner-off's (17–36
  against 6). The rest are calls slower than the lookup's slowest so far (latency is heavy-tailed).
- **429s:** none, with or without the planner.
- **Recall:** the samples are small (165 facts per mix); delivered facts were 0–4 lower than before (still 11–12
  above off on A and realistic, 1 above on B).
- **Calls** at real pacing are 1.32–1.44x off. Calls per lookup are higher than at time 0 for both the planner and
  off (off: 4.62 against 4.10), and the ratio is lower (1.36–1.47x at time 0, on other seeds); why is not measured.
- **How the margin was chosen:** on these same timed seeds, from 1.25 and 2; there is no separate timed tune set, so
  the timeout reduction is an in-sample number. "Before" is main at commit 4c2b0ea; the script builds a worktree of
  it with only the sim's stats files (which add the `aborted` count) copied in.
- At 1/50 of real time the deadline is 30 ms of wall clock and timer jitter inflates timeouts, so the check runs at
  1/10.

### Lab at the current settings

The lab reran with the current planner on both worlds (`cascadeMin` 0.05; the lab calls the planner directly, so reuse
and the deadline check do not apply; raw:
[query-planner-lab-iter3-world1000.jsonl](query-planner-lab-iter3-world1000.jsonl),
[query-planner-lab-iter3-world2000.jsonl](query-planner-lab-iter3-world2000.jsonl)). Against the earlier runs
(`cascadeMin` 0.2, iteration 1's first version, on both worlds, which on world 2000 the JSONL does not record:
unverified from the raw data alone; on world 1000 also before iteration 1; reproduce: `bun run sim:lab --world N
--sessions 120 --only-planner`), reach is
within noise on all twenty configurations, and higher on IMAP subject search (world 1000: 47% to 52% against 0.2,
44% to 52% against before iteration 1; world 2000: 29% to 37%) and IMAP body (world 2000: 44% to 50%). Calls per case
moved by at most 0.06.

### 4. Expect the connector's recent latency (kept)

**Target:** the calls iteration 3 still gave up on: calls slower than anything earlier in the same lookup, which one
lookup's own calls cannot predict.

**Change:** the fan-out records the latency of planner calls per (user, connector), in a rolling histogram that
answers over the last 10–20 minutes. A call cut off by its timeout counts with its time so far (a lower bound); one
abandoned for another reason (session end, forget) or failing fast is not counted, and a call still running when the
user is forgotten records nothing. The deadline check expects a call to take at least the 0.9 quantile of that
history (`latencyQuantile`) once 5 calls are known, as well as the lookup's slowest call so far. Shadow lookups,
which do not go through the fan-out's planner calls, keep the lookup-only estimate. A first version kept one minute
of history: in simulated time a user's calls to one connector are sparse, the history rarely held 5 calls, and on
the tune seeds no quantile helped (realistic gave up 44 calls at 0.9 against 39 at 0, within noise; its rows are in
the JSONL, labelled "one-minute window"; the report seeds 31–33 were not run with it). The report rows were rerun
after a review fix that stopped counting calls abandoned for reasons other than their timeout; "before" moved with
timing (seeds 31–33 gave up 39, 54 and 47 calls in the first run, 35, 51 and 40 in this one).

**Tuned** on timed seeds 21–23 (quantile 0 is iteration 3; these rows predate the review fix that stopped counting
calls abandoned for other reasons, so 0.9 was chosen under the earlier recording), then **reported** on fresh seeds
31–33 ([query-planner-timed.sh](query-planner-timed.sh) `4-tune` and `4-report`; raw rows with `"iteration": 4` in
[query-planner-timed.jsonl](query-planner-timed.jsonl)). Calls given up are timeouts and session ends:

| Seeds | Mix | Run | Source calls per lookup | Calls given up | Per 1,000 calls | 429s | Needed facts delivered |
|---|---|---|---|---|---|---|---|
| 21–23 (tune) | zoo-a | off | 4.60 | 27 | 5.8 | 0 | 9/157 |
| 21–23 (tune) | zoo-a | quantile 0 / 0.5 / 0.9 | 6.19 / 6.17 / 5.77 | 45 / 42 / 28 | 7.2 / 6.7 / 4.8 | 0 | 20 / 19 / 20 |
| 21–23 (tune) | zoo-b | off | 4.60 | 27 | 5.8 | 0 | 32/157 |
| 21–23 (tune) | zoo-b | quantile 0 / 0.5 / 0.9 | 6.04 / 5.98 / 5.63 | 49 / 50 / 31 | 8.0 / 8.3 / 5.5 | 0 | 33 / 33 / 33 |
| 21–23 (tune) | realistic | off | 4.60 | 26 | 5.6 | 0 | 15/157 |
| 21–23 (tune) | realistic | quantile 0 / 0.5 / 0.9 | 6.53 / 6.54 / 6.10 | 43 / 39 / 30 | 6.5 / 5.9 / 4.8 | 0 | 28 / 30 / 30 |
| 31–33 | zoo-a | off | 4.65 | 25 | 5.5 | 0 | 9/130 |
| 31–33 | zoo-a | before (quantile 0) | 6.23 | 35 | 5.7 | 0 | 14/130 |
| 31–33 | zoo-a | after (0.9) | 5.88 | 32 | 5.5 | 0 | 14/130 |
| 31–33 | zoo-b | off | 4.65 | 25 | 5.5 | 0 | 27/130 |
| 31–33 | zoo-b | before | 6.13 | 51 | 8.5 | 0 | 31/130 |
| 31–33 | zoo-b | after | 5.72 | 29 | 5.2 | 0 | 31/130 |
| 31–33 | realistic | off | 4.65 | 26 | 5.7 | 0 | 11/130 |
| 31–33 | realistic | before | 6.60 | 40 | 6.2 | 0 | 16/130 |
| 31–33 | realistic | after | 6.15 | 30 | 5.0 | 0 | 16/130 |

- **Calls given up** on the fresh seeds: 9–43% fewer than before (35 to 32, 51 to 29, 40 to 30). Per 1,000 calls,
  within noise of planner-off's: lower on realistic (4.96 against 5.69) and zoo-b (5.17 against 5.47), level on
  zoo-a (5.53 against 5.48). Each figure rests on 25–51 events, with no intervals. In absolute numbers 1.15–1.28x
  planner-off's, for 1.23–1.32x its calls.
- **Calls per lookup** fell 6–7%, since fewer doomed calls are started.
- **Recall:** delivered facts equal to before in every mix (small samples); false fires equal to planner-off's (one
  on zoo-b in all three runs).
- 0.9 was the highest quantile tried and the best on the tune seeds in every mix; nothing above it was tried.
- Seeds differ a lot: planner-off gave up 6 calls per mix on seeds 11–13 and 25–27 on seeds 21–33.

### 5. A greedy cascade with a runner-up prior (kept, D38)

**Target:** plan item 4, the planner's learning cost: in the lab it trailed the best fixed shape (chosen in
hindsight) by 0–10 points on the connectors where the cue's terms fail. While little is known, the cascade's second
shape was a Thompson draw among near-uniform priors, so early cascades were often spent on shapes that rarely help.

**Change:** the cascade step sends the remaining shape with the best posterior mean (a Thompson draw on an ε step),
and one call per entity (the best fixed shape on most such connectors, in both lab worlds) starts with a prior mean
of 0.7 at strength 4: below the incumbent's 0.75, so the cue's terms are still sent first on a fresh connector.

**Tuning (zoo-tune, seeds 1–10, no model):** needed facts retrieved or held (`funnel.retrievedOrCached`, the
planner's own job), paired per-seed gain with a 95% t-interval (df 9):

| Variant | Retrieved | Gain per seed | Calls per lookup |
|---|---|---|---|
| main | 0.444 | — | 5.48 |
| runner-up prior 0.65, strength 4 | 0.469 | +4.7 (−1.0–10.4) | 5.44 |
| runner-up prior 0.7, strength 4 | 0.471 | +5.0 (0.3–9.7) | 5.45 |
| greedy cascade step | 0.471 | +5.0 (−3.1–13.1) | 5.58 |
| greedy + prior 0.65 | 0.507 | +11.9 (7.1–16.7) | 5.58 |
| **greedy + prior 0.7** | **0.517** | **+13.7 (7.9–19.5)** | **5.58** |

Each part alone was at most marginally better than main (the prior alone: 0.3–9.7); together they were clearly
better. Chosen: the highest tune retrieval. (A prior of 0.6 at strength 2 scored below main on seeds 1–5, 0.434
against 0.443.) The tuning ran before D37; the results below are against main with D37.

**Held out, against main with D37 (weekday and month names no longer entities), planner on, seeds 1–20 (the
same seeds D37 was measured on, and D37 was written after seeing this change's false fires on seeds 6 and 17, so
fresh seeds 21–30 follow below); paired per-seed gain, 95% t-interval with df 9's critical value (conservative for
20 seeds). At `--time 0` a run can shift slightly under CPU load; the reviewer reproduced these tables exactly with
one run at a time:**

| Mix | Judge | Retrieved | Gain per seed | Recall | Gain per seed | Calls per lookup |
|---|---|---|---|---|---|---|
| zoo-tune (1–10) | none | 0.433 → 0.495 | +11.8 (7.8–15.8) | 0.238 → 0.244 | +1.1 (−1.5–3.7) | 5.43 → 5.55 |
| held-out A | none | 0.423 → 0.478 | +10.3 (5.9–14.7) | 0.231 → 0.230 | −0.1 (−2.2–2.1) | 5.76 → 5.85 |
| held-out A | perfect | 0.425 → 0.493 | +12.8 (9.2–16.5) | 0.365 → 0.422 | +10.7 (7.0–14.4) | 5.75 → 5.84 |
| held-out B | none | 0.619 → 0.641 | +4.0 (2.2–5.8) | 0.251 → 0.262 | +2.2 (0.5–3.9) | 5.60 → 5.65 |
| held-out B | perfect | 0.633 → 0.655 | +4.3 (2.5–6.1) | 0.544 → 0.560 | +3.0 (0.8–5.3) | 5.59 → 5.63 |
| realistic | none | 0.406 → 0.473 | +12.6 (10.1–15.0) | 0.221 → 0.241 | +3.9 (2.1–5.6) | 5.98 → 6.04 |
| realistic | perfect | 0.402 → 0.476 | +13.8 (10.3–17.3) | 0.353 → 0.413 | +11.2 (7.2–15.2) | 5.97 → 6.05 |

Retrieval rose on every mix, and recall with the perfect judge on every mix, with intervals apart from 0; recall
with no model rose on B and realistic and stayed within noise on A (no-model delivery, not retrieval, bounds it).
Calls per lookup rose 0.7–2.2%.

**Fresh seeds 21–30** (no decision had used them), against main with D37:

| Mix | Judge | Retrieved | Gain per seed | Recall | Gain per seed |
|---|---|---|---|---|---|
| held-out A | none | 0.439 → 0.525 | +15.6 (10.3–20.9) | 0.218 → 0.239 | +3.9 (1.4–6.4) |
| held-out A | perfect | 0.431 → 0.532 | +18.4 (12.7–24.1) | 0.365 → 0.450 | +15.4 (10.8–20.0) |
| held-out B | none | 0.641 → 0.656 | +2.7 (0.0–5.4) | 0.264 → 0.270 | +1.1 (−1.3–3.5) |
| held-out B | perfect | 0.640 → 0.662 | +4.1 (1.5–6.7) | 0.546 → 0.567 | +3.9 (1.8–6.0) |
| realistic | none | 0.446 → 0.528 | +14.9 (10.2–19.6) | 0.229 → 0.256 | +4.9 (1.6–8.2) |
| realistic | perfect | 0.438 → 0.524 | +15.6 (9.7–21.5) | 0.384 → 0.448 | +11.8 (7.4–16.2) |

No hard false fire before or after (1,426 silent turns per row).

**D31's call conditions, re-stated** (held-out seeds 1–20, against planner-off): (3) calls per lookup 1.37–1.47x
planner-off on every set and judge setting (realistic 4.10 off, 5.98 with D37, 6.04 with this change), under 1.5x;
(4) pooled calls per point of recall (D32) 0.239 against 0.251 off with no model and 0.126 against 0.141 with the
perfect judge (D37 alone: 0.247 and 0.137). D33's timed check (calls given up per 1,000) was not re-run.

**False fires:** none, before or after, in every row above (1,414 silent turns on zoo-tune, 2,816 per held-out mix
and judge setting). Before D37, the same change measured against main raised them from 6 to 8 of 8,448 (no model)
and on seeds 11–20 from 1 to 3 (perfect judge): four new fires on seeds 6 and 17, two removed on others, all the
same turn, "Find me a yoga class on Sunday mornings in Islington", where `Sunday` was an entity and one call per
entity found an unrelated item naming the day. D37 removed that cause.

**Lab (real servers, the planner from nothing over each connector's cases, planner only), against main with D37:**

World 1000:

| Connector | Cases | main (with D37) | this change | calls per case |
|---|---|---|---|---|
| memory | 196 | 68% (61–74) | 69% (63–75) | 1.45 → 1.42 |
| mcpvault | 196 | 82% (76–86) | 81% (75–86) | 1.01 → 1.01 |
| basic-memory | 196 | 71% (65–77) | 74% (67–79) | 1.15 → 1.19 |
| meilisearch | 196 | 59% (52–65) | 62% (55–69) | 1.33 → 1.19 |
| caldav | 73 | 67% (56–77) | 73% (61–82) | 1.33 → 1.45 |
| imap-body | 154 | 30% (23–38) | 36% (29–44) | 1.47 → 1.56 |
| imap-subject | 154 | 49% (42–57) | 53% (45–60) | 1.47 → 1.49 |
| chroma | 196 | 87% (82–91) | 87% (81–91) | 1.00 → 1.00 |
| gitea-db | 196 | 22% (17–28) | 26% (21–33) | 1.61 → 1.62 |
| gitea-bleve | 196 | 23% (18–29) | 27% (21–34) | 1.58 → 1.62 |

World 2000:

| Connector | Cases | main (with D37) | this change | calls per case |
|---|---|---|---|---|
| memory | 202 | 69% (63–75) | 70% (64–76) | 1.41 → 1.46 |
| mcpvault | 202 | 83% (77–88) | 84% (78–88) | 1.00 → 1.01 |
| basic-memory | 202 | 69% (63–75) | 71% (64–77) | 1.13 → 1.13 |
| meilisearch | 202 | 58% (51–65) | 64% (57–70) | 1.26 → 1.28 |
| caldav | 69 | 67% (55–77) | 71% (59–80) | 1.41 → 1.45 |
| imap-body | 161 | 48% (41–56) | 53% (46–61) | 1.50 → 1.57 |
| imap-subject | 161 | 38% (31–46) | 36% (29–44) | 1.62 → 1.63 |
| chroma | 202 | 85% (80–89) | 85% (80–89) | 1.00 → 1.00 |
| gitea-db | 202 | 23% (18–30) | 26% (21–33) | 1.75 → 1.69 |
| gitea-bleve | 202 | 24% (19–31) | 28% (22–35) | 1.66 → 1.71 |

No connector is lower beyond noise in either world. The largest gains are where the cue's terms fail: CalDAV
67% to 73% and 67% to 71%, IMAP body 30% to 36% and 48% to 53%, Gitea 22–24% to 26–28%, and Meilisearch 59% to
62% and 58% to 64%. Reproduce: `bun run sim:lab --world W --sessions 120 --only-planner`.

The IMAP cases vary from run to run on identical code (world 2000, two runs of main: imap-body 51.6% and 50.3%,
imap-subject 34.8% and 36.6%), so single IMAP rows move by a few points on their own.

### 6. Credit the shape that retrieved a delivered item (kept, D39)

**Target:** plan item 5, rewards at delivery and at usage. The immediate reward (cue coverage of the best returned
item) cannot tell shapes apart where every shape returns something.

**Change:** when serving, the planner remembers which shape returned each item (per tenant, user, connector and
item; at most 20,000 entries in memory; dropped by `forget`). When the agent receives an injection, the shape behind
each of its items gets one more success, once per retrieval. A usage credit (another success when the agent visibly
used the injection) was tried and not kept. Review moved the credit from when an injection is built to when it is
handed out (D18) and turned it off in shadow mode (a shadow lookup's items are raw); the tuning below used the first
version, the results after it the final one.

**Tuning (zoo-tune, seeds 1–10, before D37 and D38, against the planner with D38's logic):**

| Variant | Retrieved, no model | Recall, perfect judge | Calls per lookup, no model |
|---|---|---|---|
| no credit | 0.517 | 0.459 | 5.58 |
| delivery, weight 1 | 0.529 | 0.475 | 5.41 |
| delivery, weight 3 | 0.527 | 0.472 | 5.36 |
| usage only | 0.529 | 0.474 | 5.56 |
| delivery and usage | 0.527 | 0.469 | 5.39 |

Retrieval and recall moved within noise in every variant; calls per lookup fell with delivery credit (weight 1:
−0.17 per lookup, −0.19 to −0.14, no model; −0.21, −0.25 to −0.18, perfect judge). Usage added nothing on top.
Chosen: delivery credit at weight 1, the simplest with the fewest calls among those that kept retrieval.

**Final version against main with D37 and D38 (seeds 1–20, zoo-tune 1–10; fresh seeds 21–30), planner on;**
paired per-seed differences with 95% t-intervals (df 19 for 20 seeds, df 9 for 10):

| Seeds | Mix | Judge | Retrieved | Gain per seed | Recall | Gain per seed | Calls per lookup (paired difference) |
|---|---|---|---|---|---|---|---|
| 1–10 | zoo-tune | none | 0.495 → 0.509 | +2.5 (0.1–4.9) | 0.244 → 0.246 | +0.5 (−0.7–1.7) | 5.55 → 5.37 (−0.18, −0.21 to −0.16) |
| 1–20 | held-out A | none | 0.478 → 0.491 | +2.4 (0.8–3.9) | 0.230 → 0.239 | +1.6 (0.3–2.8) | 5.85 → 5.60 (−0.25, −0.28 to −0.23) |
| 1–20 | held-out A | perfect | 0.493 → 0.503 | +1.9 (0.3–3.4) | 0.422 → 0.429 | +1.4 (−0.1–2.9) | 5.84 → 5.56 (−0.28, −0.31 to −0.25) |
| 1–20 | held-out B | none | 0.641 → 0.640 | −0.1 (−0.9–0.6) | 0.262 → 0.261 | −0.2 (−1.2–0.8) | 5.65 → 5.49 (−0.16, −0.19 to −0.14) |
| 1–20 | held-out B | perfect | 0.655 → 0.657 | +0.3 (−0.9–1.6) | 0.560 → 0.563 | +0.5 (−0.8–1.7) | 5.63 → 5.45 (−0.18, −0.20 to −0.16) |
| 1–20 | realistic | none | 0.473 → 0.486 | +2.4 (1.2–3.6) | 0.241 → 0.246 | +0.8 (0.0–1.6) | 6.04 → 5.77 (−0.27, −0.30 to −0.24) |
| 1–20 | realistic | perfect | 0.476 → 0.494 | +3.5 (2.0–4.9) | 0.413 → 0.429 | +3.1 (1.6–4.6) | 6.05 → 5.70 (−0.35, −0.38 to −0.32) |
| 21–30 | held-out A | none | 0.525 → 0.524 | −0.2 (−2.2–1.8) | 0.239 → 0.237 | −0.3 (−1.8–1.2) | 5.86 → 5.58 (−0.28, −0.33 to −0.23) |
| 21–30 | held-out A | perfect | 0.532 → 0.541 | +1.6 (−0.9–4.1) | 0.450 → 0.457 | +1.3 (−1.0–3.6) | 5.86 → 5.57 (−0.29, −0.34 to −0.24) |
| 21–30 | held-out B | none | 0.656 → 0.656 | +0.0 (−1.4–1.4) | 0.270 → 0.273 | +0.5 (−0.5–1.5) | 5.64 → 5.48 (−0.16, −0.18 to −0.13) |
| 21–30 | held-out B | perfect | 0.662 → 0.671 | +1.6 (0.2–3.0) | 0.567 → 0.573 | +1.1 (0.2–2.0) | 5.63 → 5.45 (−0.17, −0.19 to −0.15) |
| 21–30 | realistic | none | 0.528 → 0.544 | +2.9 (0.8–5.0) | 0.256 → 0.263 | +1.2 (−0.5–2.9) | 6.06 → 5.78 (−0.28, −0.34 to −0.23) |
| 21–30 | realistic | perfect | 0.524 → 0.537 | +2.5 (0.3–4.7) | 0.448 → 0.458 | +1.7 (0.2–3.2) | 6.05 → 5.71 (−0.34, −0.41 to −0.27) |

Calls per lookup fell 3–6% on every row with intervals apart from 0; retrieval and recall rose or held (none fell
beyond noise); no hard false fire before or after on any row. The connector lab calls the planner without the
engine, so nothing is delivered there and nothing credited: lab reach is D38's by construction. Crediting at hand-out
rather than at build scored almost the same (in the simulation nearly every injection is handed out).

### The default-on gate (D31, D32)

The owner chose a cost-normalised gate (D31) and, for its fourth condition, the reading pooled over the held-out
sets (D32). Where it stands after iteration 4:
- **Recall:** higher with intervals apart on A and realistic, with and without a judge; within noise on B. Holds.
- **False fires and secrets:** unchanged and 0. Holds.
- **Calls at most 1.5x off:** 1.36–1.47x at time 0 (iteration 2) and 1.23–1.32x at real pacing (iteration 4). Holds.
- **Calls per point of recall no worse than off, pooled over the held-out sets (D32):** no model 0.311 against 0.325;
  judge 0.132 against 0.138. Holds. Read per set, it fails on B (0.284 against 0.226; judge 0.099 against 0.076),
  where planner-off already reaches most reachable facts (60–64% retrieved or held), so the extra calls add little
  recall; the pooled figure leans on B's high recall.
- **Lab reach:** within noise or higher on both worlds with `cascadeMin` 0.05 (the lab calls the planner directly, so
  reuse and the deadline check are not exercised there). Holds.
- **429s and timeouts in a timed run:** no 429s in any run. After iteration 4, calls given up per 1,000 calls are
  within noise of planner-off's on fresh seeds (4.96–5.53 against 5.47–5.69), and 1.15–1.28x planner-off's in
  absolute numbers. D31 says only that they are "checked"; the bar, per call or absolute, is the owner's call.

## Gates in the plan, and where they stand

- **Tier 2:** met for recall and false fires on held-out connectors. Not met for "source calls no worse": the default
  made about 50% more calls, and 40–51% more after iteration 1. The one-call setting meets the call budget, but its
  recall gain is within noise.
- **Tier 3:**
  - Met for reach on more than five services with different search behaviour, with no regression beyond noise.
  - Not measured: false fires, 429s and timeouts on real servers. The lab measures reach only.
  - The capability probe is not built (see D28); its role is played by the cascade and the conservative bandit.
- **Tier 4 (shadow):** run in simulation by the owner's decision, not on real accounts (above). The planner left
  serving unchanged, its content-free signal predicted real gains, and its learning carried over to serving.
- **Default on (phase 6):** done (D33). After iteration 4, D31's conditions held in simulation with D32's pooled
  reading of (4), and the owner chose the per-call reading of the timeout check (above); the server now serves
  through the planner unless `EDEN_QUERY_PLANNER=0`.

## Not done, and why

- **No capability probe.** Sending crafted probe queries to a user's real accounts costs calls and quota. The
  cascade and the conservative incumbent learn the same thing from real lookups, at no extra call when today's query
  works.
- **Quotes only by operator config (`quotes`).** No probe tests phrase support, and an unescaped quote broke a real
  server (Wiki.js, docs/research/connectors.md).
- **No usage reward.** The immediate reward and delivery credit (D39) are wired; a usage credit added nothing in
  simulation (iteration 6). The immediate reward cannot tell shapes apart on OR and vector search, so the incumbent
  rule carries that case.
- **No new `ContextualBandit` primitive.** One `BetaBandit` per (user, connector, bucket) was enough.
- **Two lab worlds.** The tier-3 tables are from world 1000; world 2000 (iterations, above) repeats them.
