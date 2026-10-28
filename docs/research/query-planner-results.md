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

What it stores: two numbers per (user, connector, bucket, shape) in the source map's SQLite, deleted by `forget`.
It never stores query text. Queries are built from untrusted text, so every shape drops search-syntax characters
and operator words (fuzzed: 3,000 random inputs, no operator survives).

## Tier 2: the simulation's connector zoo

The same world behind connectors with different search semantics, all passing Eden's query through unchanged:
- The tune set (`zoo-tune`) was used to choose settings.
- Held-out sets A (`zoo-a`) and B (`zoo-b`) give each source a semantics it never had in tuning.
- `realistic` is the earlier hosted-product profile.

Six simulated users with 15 sessions each, per seed; 95% Wilson intervals over facts. Raw:
[query-planner-sim.jsonl](query-planner-sim.jsonl). Reproduce: `bun run sim --profile zoo-a --seed 1 --planner`.

| Connector mix | Judge | Planner | Seeds | Needed facts retrieved | Recall (needed facts delivered) | Precision | False fires / silent turns | Source calls per lookup |
|---|---|---|---|---|---|---|---|---|
| zoo-a | none | off | 5 | 17% (15–19) | 9.0% (7–11) | 0.563 (134/238) | 1/713 | 4.11 |
| zoo-a | none | on (up to 3 calls) | 5 | 42% (39–45) | 17.2% (15–20) | 0.610 (222/364) | 1/713 | 6.30 |
| zoo-a | none | on (1 call) | 5 | 21% (18–23) | 10.6% (9–13) | 0.560 (155/277) | 1/713 | 4.11 |
| zoo-a | perfect | off | 3 | 17% (14–20) | 14.8% (12–18) | 0.698 (162/232) | 1/398 | 4.12 |
| zoo-a | perfect | on (up to 3 calls) | 3 | 47% (42–51) | 40.9% (37–45) | 0.791 (356/450) | 1/398 | 6.41 |
| zoo-b | none | off | 5 | 61% (57–64) | 21.5% (19–24) | 0.535 (292/546) | 1/713 | 4.13 |
| zoo-b | none | on (up to 3 calls) | 5 | 63% (60–66) | 23.5% (21–26) | 0.562 (314/559) | 1/713 | 6.05 |
| zoo-b | none | on (1 call) | 5 | 60% (56–63) | 21.6% (19–24) | 0.547 (294/537) | 1/713 | 4.13 |
| zoo-tune | none | off | 5 | 23% (21–26) | 14.0% (12–16) | 0.567 (183/323) | 1/713 | 4.11 |
| zoo-tune | none | on (up to 3 calls) | 5 | 46% (42–49) | 18.3% (16–21) | 0.580 (220/379) | 1/713 | 6.05 |
| realistic | none | off | 5 | 19% (17–22) | 13.1% (11–15) | 0.634 (170/268) | 1/713 | 4.11 |
| realistic | none | on (up to 3 calls) | 5 | 42% (38–45) | 17.9% (16–21) | 0.624 (231/370) | 1/713 | 6.54 |
| realistic | none | on (1 call) | 5 | 23% (20–26) | 14.5% (12–17) | 0.645 (196/304) | 1/713 | 4.11 |

- **Held-out A** (mostly substring and AND search): with no model, recall rose from 9.0% to 17.2%. With a perfect
  judge in the model's place it rose from 14.8% to 40.9%, and precision from 0.70 to 0.79. The intervals do not
  overlap.
- **Held-out B** (mostly OR and ranked search): recall moved from 21.5% to 23.5%, within noise. Little is lost there
  to begin with.
- **False fires:** unchanged in every configuration (1 or fewer in 398–713 silent turns).
- **Cost:** source calls per lookup rose by about 50% (4.1 to 6.0–6.5). Capped at one call, the planner costs no
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
- **No real regression:** on mcpvault (OR) and Chroma (vector), today's query was already best. The conservative
  planner stays within noise of it (81% vs 83%, 86% vs 88%). Plain Thompson sampling lost 11 and 9 points there,
  which is why the incumbent rule exists.
- **Cost of conservatism:** it learns slower than plain Thompson on some substring connectors (IMAP subject 44% vs
  53%). The cascade rescues most lookups while today's query is being disproven.
- **Calls per case:** 1.01–1.63. They are highest where today's query fails and per-entity calls take over.

## Gates in the plan, and where they stand

- **Tier 2:** met for recall and false fires on held-out connectors. Not met for "source calls no worse": the default
  makes about 50% more calls. The one-call setting meets the call budget, but its recall gain is within noise.
- **Tier 3:**
  - Met for reach on more than five services with different search behaviour, with no regression beyond noise.
  - Not measured: false fires, 429s and timeouts on real servers. The lab measures reach only.
  - The capability probe is not built (see D28); its role is played by the cascade and the conservative bandit.
- **Tier 4 (shadow on consenting real accounts):** not started. It needs the owner's consent and a decision on what
  may be kept.
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
