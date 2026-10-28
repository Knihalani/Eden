# The query planner: results

Status: built and measured, 2026-10-28; **off by default** (D28). Plan: docs/plans/query-planner.md. Code:
`packages/sources/src/{shapes,planner,schema-args}.ts`, wired through `PartnerDeps.planner` and `EDEN_QUERY_PLANNER=1`.

## What it does

For each lookup and each connector, the planner chooses what to send. The options are query shapes: the cue's terms
(what Eden always sent), its entities joined, one call per entity, an entity plus the cue's rarest term, and quoted
entities where an operator says the connector takes phrases. It learns per (tenant, user, connector), separately for
cues with and without an entity, with Thompson sampling over Beta posteriors (`BetaBandit`). The reward is
immediate: how much of the cue the best returned item covers, as whole words; nothing returned scores 0. When the
chosen shape returns nothing, one other shape is tried in the same lookup (the cascade), unless the connector has
taught the planner that its cascades find nothing (iteration 1, below). Up to 3 calls per lookup per connector.

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

### 1. A learned cascade gate (kept)

**Target:** source calls per lookup, the gate that keeps the planner off. The quality report now breaks a run's
connector lookups down by path (`plans`: "terms", "terms>each-entity" for a cascade). On held-out A, seed 1, every
cascade after an empty answer from the cue's terms came back empty on the OR connector (166 of 166 lookups) and nearly
all did on the ranked one: there an empty OR answer means nothing is there, and every narrower shape is empty too.

**Change:** whether to cascade is learned per (user, connector, bucket): a Beta posterior on "the cascade step found
something" (cue coverage above 0), decayed like the arms and stored with them. The cascade runs when a draw from it is
at least `cascadeMin` (default 0.2), or on an ε step, so it is re-tried now and then.

**Tuning** (`zoo-tune`, 5 seeds): `cascadeMin` 0, 0.1, 0.2, 0.3 and 0.4 gave recall 18.9%, 18.9%, 19.1%, 18.3% and
18.7% (all within noise), at 6.04, 5.48, 5.22, 5.05 and 4.89 calls per lookup. 0.2 was chosen before looking at the
held-out sets, as the middle of the range where recall held.

| Mix | Run | Needed facts retrieved or cached | Recall | Precision | False fires | Source calls per lookup |
|---|---|---|---|---|---|---|
| zoo-a | off | 16.8% (15–19) | 9.0% (7–11) | 0.563 | 1/713 | 4.11 |
| zoo-a | before (always cascade) | 41.1% (38–44) | 17.6% (15–20) | 0.598 | 1/713 | 6.28 |
| zoo-a | after (`cascadeMin` 0.2) | 37.3% (34–40) | 16.2% (14–19) | 0.588 | 1/713 | 5.46 |
| zoo-b | off | 60.6% (57–64) | 21.5% (19–24) | 0.535 | 1/713 | 4.13 |
| zoo-b | before | 63.5% (60–67) | 23.9% (21–27) | 0.560 | 1/713 | 6.06 |
| zoo-b | after | 61.4% (58–64) | 22.4% (20–25) | 0.556 | 1/713 | 5.18 |
| realistic | off | 19.4% (17–22) | 13.1% (11–15) | 0.634 | 1/713 | 4.11 |
| realistic | before | 41.7% (39–45) | 18.9% (16–22) | 0.613 | 1/713 | 6.52 |
| realistic | after | 38.3% (35–41) | 18.4% (16–21) | 0.623 | 1/713 | 5.65 |

- **Calls:** the planner's extra calls fell by 36–46% (held-out A: from 2.17 to 1.35 extra per lookup; B: 1.93 to
  1.05; realistic: 2.41 to 1.54).
- **Recall:** within noise of before in every mix, and still above off on A and realistic with intervals apart. It is
  lower in every mix (by 0.5–1.5 points), and reach by 2–4 points: the gate also stops some cascades that would have
  found something. Calls per lookup per point of recall fell in every mix (A: 0.36 to 0.34; B: 0.25 to 0.23;
  realistic: 0.34 to 0.31).
- **Guardrails:** false fires unchanged (1/713); no secret leaked; precision within noise.
- **Real servers** (the connector lab, world 1000, planner only; raw:
  [query-planner-lab-cascade.jsonl](query-planner-lab-cascade.jsonl)): reach and calls per case within noise of
  before on all ten configurations. Every lab case has a needed item to find, so a cascade there often finds
  something, and the gate stays open:

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

**Where the rest of the extra calls go** (held-out A, seed 1, after): 41% of the planner's connector calls are the
cue's terms alone, 40% are cascades from them (to each-entity, entities, entity+term), and the rest start from an
entity shape. Most cascades are the learning cost of leaving the incumbent; the next iterations target that.

## Gates in the plan, and where they stand

- **Tier 2:** met for recall and false fires on held-out connectors. Not met for "source calls no worse": the default
  made about 50% more calls, and 25–37% more after iteration 1. The one-call setting meets the call budget, but its recall gain is within noise.
- **Tier 3:**
  - Met for reach on more than five services with different search behaviour, with no regression beyond noise.
  - Not measured: false fires, 429s and timeouts on real servers. The lab measures reach only.
  - The capability probe is not built (see D28); its role is played by the cascade and the conservative bandit.
- **Tier 4 (shadow):** run in simulation by the owner's decision, not on real accounts (above). The planner left
  serving unchanged, its content-free signal predicted real gains, and its learning carried over to serving.
- **Default on (phase 6):** not met; the planner stays opt-in.

## Not done, and why

- **No capability probe.** Sending crafted probe queries to a user's real accounts costs calls and quota. The
  cascade and the conservative incumbent learn the same thing from real lookups, at no extra call when today's query
  works.
- **Quotes only by operator config (`quotes`).** No probe tests phrase support, and an unescaped quote broke a real
  server (Wiki.js, docs/research/connectors.md).
- **Immediate reward only.** Rewards at delivery and at usage, from the plan, are not wired. The immediate reward
  cannot tell shapes apart on OR and vector search, so the incumbent rule carries that case.
- **No new `ContextualBandit` primitive.** One `BetaBandit` per (user, connector, bucket) was enough.
- **Single-world lab.** All lab numbers are from world 1000; other seeds are the next check.
