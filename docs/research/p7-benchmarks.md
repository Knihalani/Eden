# P7: the benchmark gaps (heldout19, reworded train, the long tail, shipped coverage, weeks)

2026-11-11. Lab only: no engine change. Decisions D870–D876. It answers B3, B4, B5, B7 and B8 of
[weak-points-1111.md](weak-points-1111.md) §3. Every number below comes from a command run in this session. Paid
calls went to Anthropic only (the card role, Haiku 5.5, lab transport, D97), to build caches.

## 1. What was built

| Piece                                                                                             | Where                                                                              | Gap      | Decision |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------- | -------- |
| `heldout19`, the end-of-wave blind suite (40 templates, unread)                                   | `hidden-heldout19.ts`                                                              | B3       | D870     |
| `train1r`–`train6r`: train with every request reworded, 36 of 192 in eight other languages        | `reworded.ts`, `suites.ts`                                                         | B4, Q6   | D871     |
| Shipped-coverage caches: the cards and requests `buildPartner`'s own enricher writes              | `cold-start.ts --cards-out`, `funnel --coverage shipped`, `cards-shipped.jsonl.gz` | B8, D714 | D872     |
| `longtail`: 24 templates, every fact in one of eight rarely used connectors                       | `hidden-longtail.ts`, `rare-sources.ts`                                            | B5       | D873     |
| Weeks-long plans (`planWeeks`: planted templates first, neutral ones never planted)                       | `pi-user.ts`                                                                       | B7       | D874     |
| `days-calls.ts`: `--suite`, `--day-size`, `--mix`, seed ranges, `--arrive-days` (silent arrivals) | `days-calls.ts`                                                                    | B5, B7   | D875     |
| The benchmark map: each benchmark's question and known biases                                     | docs/LAB.md                                                                        | all      | D876     |

### heldout19 (D870)

An isolated Opus subagent wrote it. It read only these:

- a format scaffold: heldout18's helpers and planting function, with one example template invented for the scaffold
  and none of heldout18's own;
- the HiddenTask interface;
- the sim world API (`world.ts`, `names.ts`, `text.ts`, `rng.ts`);
- `rare-sources.ts`.

It ran no funnel, eval or model. Its report, by count only:

- **Areas:** 40 templates, five in each of the eight areas.
- **Phrasing:** 11 plain imperatives and 29 indirect forms or questions. Seven requests are not in English (German,
  Spanish, French, Italian, Portuguese, Dutch, Hindi in Latin script).
- **Categories:** 16 anchored requests, 12 facts in rare connectors (all eight used) and 10 silent edits (each with
  its `before` copy, from `heldout19Before`).
- **Decoys:** 13 resolved, 17 another entity or date, 10 condition met.

P7 has not read its templates. Only its tests (counts, ids, refs and the category lists, in `suites.test.ts`) and
the line check were run on it.

It is registered `UNREAD_BLIND`. Its cards and intent requests exist only at shipped coverage (§3), so its read
measures what a deployment would hold. Nobody may run it before the parent's end-of-wave call.

### Rare connectors

`rare-sources.ts` adds eight connectors to a world: notes, whatsapp, bank, health, school, trips, residents and
tasks. Each holds 6–8 old filler items and borrows the search and latency profile of the world source it is most like.

The harnesses line planted items up with tasks by `world.items.slice(before)`, so the filler must exist before that
snapshot. `prepareWorld(suite, world, seed)` adds it, and every harness calls it right after `buildWorld`. Planting
heldout19 or longtail without it throws rather than misaligning.

### Reworded train (D871)

A Sonnet subagent wrote one rewording a template. Each rewording is a regex over the generated request (its captures
carry the seed's names), checked against seeds 41–52. The forms vary: "Can I/we", "I need to", "Should I",
"I want to", "I'd like to", "Could we", "Thinking of", "Going to", "Is it OK to", "We should", "Do you think we
could", "Let's", "Remind me to" and "Planning to". Six of each suite's 32 are in es, fr, de, pt, it, nl, hi or pl.

The calendar slot is cleared from the original request (`HiddenTask.slotText`), so the worlds are train's item for
item. The test checks this for seeds 41, 47 and 52.

Cards and intent requests are made per item from the item alone. A pipeline therefore builds the same index whatever
the user types, so replaying train's caches does not flatter the reworded suite. Only matching at request time sees
the new wording.

## 2. Measurements

### 2.1 Reworded train at $0 (Q6)

`bun run funnel --suite train|reworded --seeds 41,42` (default, `--reader stub`, coverage full):

| Suite    | Hidden surfaced | Decoys surfaced | Hidden handed by the candidates push |
| -------- | --------------- | --------------- | ------------------------------------ |
| train    | 315/384         | 276/384         | 289                                  |
| reworded | 288/384         | 249/384         | 117                                  |

The push starts on fewer than half the reworded requests that hold a fact. The funnel always asks, and the ask
recovers most of the gap, so a live agent that asks less would lose more. This sizes Q6: train's 315/276 hides it.

### 2.2 The long tail over four weeks ($0)

```bash
bun packages/sim/src/lab/days-calls.ts --seeds 41-64 --days 28 --night-h 20 --suite train,longtail \
  --arrive-days 0-10 --cards F --intent F     # F: the 24 users' shipped cards (cold-start.ts --cards-out, $0.26)
```

The run has 24 users and 10,734 requests. Each planted item appears at its connector with no notice 0–10 days before
its request. The cards are the shipped enricher's for each weeks user (`cold-start.ts --users user:41,…,user:64
--suite train,longtail --days 28 --cards-out F`), so rare-connector items are carded as a deployment would card them.

**Hidden facts handed (a packet or the ask's citations), and calls:**

| Arm | All | Rare connectors | Common sources | Background lists a user-day | Request-time calls a request |
| --- | --- | --- | --- | --- | --- |
| default (push payload) | 496/1129 | 31/105 | 465/1024 | 18.01 | 0.159 |
| `syncUnusedSweepMs: 0` (daily sweep) | 496/1129 | 31/105 | 465/1024 | 18.03 | 0.156 |
| `--push none` (no source notifies) | 511/1129 | 32/105 | 479/1024 | 18.00 | 1.183 |

**By when the fact arrived, in the default arm:**

| Arrived | Rare connectors | Common sources |
| --- | --- | --- |
| At the backfill | 9/23 | 91/208 |
| 7 days or more before its request | 7/28 | 132/260 |
| 1–6 days before | 13/43 | 226/471 |
| The same day | 2/11 | 16/85 |

Decoys handed: 9/102 from rare connectors and 441/1027 from common sources.

Three readings:

1. **Weekly against daily sweeps changed nothing in these worlds.**
   - Each rare connector was listed about 0.69 times a user-day in the background in every arm, which is the daily
     sweep.
   - The likely reason (not verified): no connector here sits on the weekly sweep. Either a lookup engages it on
     evidence, or with 13 connectors the long sweep never applies.
   - Pricing D356, and any dormancy rule, needs many unused connectors (`--noise-sources`) beside the long tail.
     That is the next run.
2. **Facts in rare connectors reach the agent less often: 30% (31/105) against 45% (465/1024).**
   - The gap is small for facts there from the backfill (9/23 against 91/208).
   - It is large for facts that arrived later: 20/71 against 358/731 for 1–10 days ahead.
   - A fact that lands quietly in a rarely used connector is the case the lab could not see before. These are
     counts over 24 users; no interval was computed.
3. **Quiet sources cost about 7x the request-time calls** (1.183 against 0.159 a request): every request polls every
   connector. They handed 15 more hidden facts, nearly all same-day arrivals on common sources (34/85 against 16/85).

A first version of this run used the superseded weeks planner (D874) and the train-only card file. It read 437/1106,
with 33/134 from rare connectors against 404/972. Its numbers are not kept.

### 2.3 The long tail one request a session

`bun run funnel --suite longtail --seeds 41,42,43,44` (stub reader):

| Coverage | Hidden | Decoys |
| --- | --- | --- |
| none (no cache covers it; intent inert) | 56/96 | 47/96 |
| shipped | 60/96 | 56/96 |

Every connector is read at the backfill, so at this horizon its question barely shows; it is a days question.

## 3. Shipped coverage (D872), and the recommendation

`cold-start.ts --cards-out F` wraps the enricher that `buildPartner` builds (DEFAULT_CONFIG, DEFAULT_LIMITS) and
records each item a card call read: `{h, c, r}`, the format `--cards` and `--intent` replay. It was run over every
world of train1–6 × seeds 41–44 × {hidden, control, neutral} (72 worlds).

The 72 runs cost $0.50 in all ($0.0070 a world, 6.8 card calls, 1,507 items at the sources). Together they wrote
lines for 1,108 distinct items, 963 of them with requests. Within one world the enricher reads about 8% of the items
(128 of 1,517 in the smoke run): the lean rule leaves the rest uncarded.

`bun run funnel --seeds 41,42,43,44 --coverage full|shipped` (default, stub reader; `-- --neutral` on train), run
again after merging main at #245. Its calendar change moved the full-coverage rows by one task (train 635/554 and
reworded 579/504 before it):

| Suite    | Coverage         | Hidden surfaced | Decoys surfaced | Hidden via candidates | Neutral: any packet |
| -------- | ---------------- | --------------- | --------------- | --------------------- | ------------------- |
| train    | full (intent-v2) | 634/768         | 553/768         | 582                   | 741/768             |
| train    | shipped          | 575/768         | 528/768         | 525                   | 746/768             |
| reworded | full             | 578/768         | 504/768         | 232                   | (not run)           |
| reworded | shipped          | 519/768         | 479/768         | 188                   | (not run)           |

The full index lifts train's hidden level by 59 of 768 (7.7 points) and its decoys by 25. This matches D714's reading
of seeds 41–44 against 45–48. The reworded gap is the same under both coverages (−56 and −56 hidden).

**Shipped coverage is now the funnel's default (D877).** The owner's directive was to ship now, so it was flipped in
this branch instead of at the next wave.

- `bun run funnel` replays the shipped caches wherever they cover the run. It falls back to the full index elsewhere,
  or when a run names its own cards or intent.
- The re-recorded baseline (train seeds 41–42, default, stub reader) reads hidden 281/384 and decoys 264/384.
  `--coverage full` still reads 315/276.
- A no-model screen refuses a `--baseline` recorded at the other coverage.
- The reader replay cache of recipe 2a and the retrieval screen were recorded at full coverage, so they pass
  `--coverage full`. Under shipped, recipe 2a misses 1,278 prompts against 417 at full.
- pi-ab and hermes-ab still replay the full index by default (their intent line says "coverage full"). Switching them
  is the parent's call.

## 4. Costs

Anthropic, all on the card role (Haiku 5.5, lab transport), from the spend ledger `.local/p7/ledger.jsonl`:

| Run | Worlds | USD |
| --- | --- | --- |
| Smoke runs | 2 | 0.018 |
| train1–6 × 41–44 × three variants | 72 | 0.501 |
| longtail and heldout19 × 41–44 × three variants | 24 | 0.171 |
| The 24 weeks users (first planner, superseded) | 24 | 0.263 |
| The 24 weeks users (`planWeeks`) | 24 | 0.265 |
| **Ledger total** | | **1.218** |

Modal: $0. Every days-calls and funnel run is $0.

## 5. Known biases of the new suites

They are in the benchmark map (docs/LAB.md). In short:

- **heldout19:** one author, 40 templates. Rare-connector filler is thin.
- **reworded:** one writer. Six non-English requests a suite are a handful per language.
- **longtail:**
  - P7 wrote it and it is not blind.
  - It has 24 templates, and its rare connectors hold only 6–8 filler items each.
  - It is easy one request a session.
- **days-calls weeks:** Eden's clock moves while the world's "now" is fixed, so items age against requests written
  for it. Past about 12 days neutral requests repeat (on templates never planted for the user).
