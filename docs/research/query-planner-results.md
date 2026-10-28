# The query planner: results

Status: built and measured, 2026-10-28; **off by default** (D28). Plan: docs/plans/query-planner.md. Code:
`packages/sources/src/{shapes,planner,schema-args}.ts`, wired through `PartnerDeps.planner` and `EDEN_QUERY_PLANNER=1`.

## What it does

For each lookup and each connector, the planner chooses what to send. The options are query shapes: the cue's terms
(what Eden always sent), its entities joined, one call per entity, an entity plus the cue's rarest term, and quoted
entities where an operator says the connector takes phrases. It learns per (tenant, user, connector), separately for
cues with and without an entity, with Thompson sampling over Beta posteriors (`BetaBandit`). The reward is
immediate: how much of the cue the best returned item covers, as whole words; nothing returned scores 0. When the
chosen shape returns nothing, one other shape is tried in the same lookup (the cascade). Up to 3 calls per lookup
per connector.

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
exactly as without a planner and runs the planner's lookup beside it:
- every shadow call takes a rate token;
- the planner learns from what comes back;
- a content-free record (shapes, calls, item ids, the served item ids) goes to `onShadow`;
- nothing it finds is cached or delivered.

The simulation adds what real accounts could not: labels, to check what the content-free records say. Held-out sets
A and B and the realistic mix, five seeds each, 6 users with 15 sessions. "Shadow, then serve" runs in shadow for
the first 5 sessions per user, then serves with what it learned. Raw:
[query-planner-shadow.jsonl](query-planner-shadow.jsonl), from [query-planner-shadow.sh](query-planner-shadow.sh).

| Mix | Run | Recall, all sessions | Recall, sessions 6–15 | Precision | False fires | Source calls per lookup | Rate-limited calls |
|---|---|---|---|---|---|---|---|
| zoo-a | off | 9.0% (7–11) | 9.3% (7–12) | 0.563 | 1/713 | 4.11 | 0 |
| zoo-a | shadow | 9.0% (7–11) | 9.3% (7–12) | 0.569 | 1/713 | 10.40 | 0 |
| zoo-a | serve | 17.6% (15–20) | 17.6% (15–21) | 0.598 | 1/713 | 6.28 | 0 |
| zoo-a | shadow-then-serve | 15.4% (13–18) | 18.7% (16–22) | 0.634 | 1/713 | 6.75 | 0 |
| zoo-b | off | 21.5% (19–24) | 23.5% (20–27) | 0.535 | 1/713 | 4.13 | 0 |
| zoo-b | shadow | 21.7% (19–24) | 23.8% (21–27) | 0.537 | 1/713 | 10.16 | 0 |
| zoo-b | serve | 23.9% (21–27) | 25.5% (22–29) | 0.560 | 1/713 | 6.06 | 0 |
| zoo-b | shadow-then-serve | 23.3% (21–26) | 26.1% (23–30) | 0.560 | 1/713 | 6.49 | 0 |
| realistic | off | 13.1% (11–15) | 13.5% (11–16) | 0.634 | 1/713 | 4.11 | 0 |
| realistic | shadow | 13.2% (11–15) | 13.7% (11–17) | 0.635 | 1/713 | 10.66 | 0 |
| realistic | serve | 18.9% (16–22) | 18.7% (16–22) | 0.613 | 1/713 | 6.52 | 0 |
| realistic | shadow-then-serve | 18.6% (16–21) | 21.6% (19–25) | 0.656 | 1/713 | 6.99 | 0 |

What a deployment would see, and what the labels say about it ("would add": need turns where the shadow lookup
returned a needed fact that serving did not; the signal is the content-free one, a connector that served nothing
while the shadow lookup found something):

| Mix | Run | Shadow records | Limited | Shadow calls per record | Need turns | Shadow would add | Shadow would lose | Signal precision (mean of seeds) | Signal recall (mean of seeds) |
|---|---|---|---|---|---|---|---|---|---|
| zoo-a | shadow | 3258 | 0 | 1.46 | 698 | 175 (25.1%) | 2 | 0.584 | 1.000 |
| zoo-a | shadow-then-serve | 1095 | 0 | 1.48 | 233 | 52 (22.3%) | 2 | 0.574 | 1.000 |
| zoo-b | shadow | 3132 | 0 | 1.30 | 654 | 22 (3.4%) | 4 | 0.238 | 1.000 |
| zoo-b | shadow-then-serve | 1071 | 0 | 1.32 | 227 | 4 (1.8%) | 3 | 0.169 | 0.600 |
| realistic | shadow | 3255 | 0 | 1.47 | 695 | 164 (23.6%) | 2 | 0.639 | 0.990 |
| realistic | shadow-then-serve | 1089 | 0 | 1.47 | 232 | 54 (23.3%) | 1 | 0.640 | 1.000 |

- **Serving is unchanged in shadow.** Recall, precision and false fires match planner-off in every mix: 9.0% against
  9.0% on held-out A, within noise on B and the realistic mix. What it costs is calls: 10.2–10.7 per lookup against
  4.1, because the shadow lookup repeats the served one. No call was refused by the rate limit in these runs.
- **The shadow lookup would add a needed fact** on 25% of need turns in held-out A and 24% in the realistic mix,
  and on 3.4% in held-out B. It would lose one that serving found on at most 4 turns of about 650–700.
- **The content-free signal is honest.** It flagged nearly every turn where the shadow really added something (recall
  0.99–1.00, 0.60 on the one small sample of 5). Where gains were common, its precision was 0.57–0.64; on B, where
  they were rare, 0.17–0.24. A deployment can therefore read, from content-free counts alone, whether the planner
  would help its connectors. A high rate of "served nothing, shadow found something" means it would.
- **Shadow learning carries over.** After 5 shadow sessions, sessions 6–15 reached 18.7% recall on held-out A
  (serving from the start: 17.6%; off: 9.3%) and 21.6% on the realistic mix (18.7%; 13.5%). Precision was the
  highest of any run (0.634, 0.656). The intervals overlap with serving from the start, so the claim is "at least as
  good, with no exposure while learning", not "better".
- **Caveat:** signal precision and recall are means over seeds, not pooled over turns. The report gives ratios only.

## Gates in the plan, and where they stand

- **Tier 2:** met for recall and false fires on held-out connectors. Not met for "source calls no worse": the default
  makes about 50% more calls. The one-call setting meets the call budget, but its recall gain is within noise.
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
