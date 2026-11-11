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

`days-calls.ts --seeds 41-64 --days 28 --night-h 20 --suite train,longtail --arrive-days 0-10` with
`--cards cards-train.jsonl` and the checked-in requests. The run has 24 users and 10,668 requests. Each planted item
appears at its connector with no notice 0–10 days before its request.

| Arm                                               | Hidden handed, all | Rare connectors | Common sources | Background listings a user-day | Request-time calls a request |
| ------------------------------------------------- | ------------------ | --------------- | -------------- | ------------------------------ | ---------------------------- |
| default (push payload)                            | 437/1106           | 33/134          | 404/972        | 17.96                          | 0.163                        |
| `syncUnusedSweepMs: 0` (every source swept daily) | 437/1106           | 33/134          | 404/972        | 17.98                          | 0.161                        |
| `--push none` (no source notifies)                | 454/1106           | 35/134          | 419/972        | 17.90                          | 1.186                        |

Three readings:

1. **Weekly against daily sweeps changed nothing in these worlds.** Each rare connector was listed about 0.69 times
   a user-day in the background in every arm. That is the daily sweep. The likely reason (not verified) is that no
   connector here sits on the weekly sweep. Either a lookup engages it on evidence, or with 13 connectors the long
   sweep never applies. Pricing D356, and any dormancy rule, needs many connectors (`--noise-sources`) beside the
   long tail, and that is the next run.
2. **Facts in rare connectors reach the agent less often: 25% (33/134) against 42% (404/972).** This holds even when
   the fact was there from the backfill: 8/27 against 98/222.
   - Part of the gap is the lab's own: the replayed card file has no cards for longtail items, while train's are
     carded.
   - The shipped-coverage caches for the 24 weeks users (§3) remove that confound.
3. **Quiet sources cost about 7x the request-time calls** (1.186 against 0.163 a request): every request polls every
   connector. They handed 17 more hidden facts, mostly same-day arrivals (`0d`: 33/80 against 17/80 on common
   sources).

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

`bun run funnel --seeds 41,42,43,44 --coverage full|shipped` (default, stub reader; `-- --neutral` on train):

| Suite    | Coverage         | Hidden surfaced | Decoys surfaced | Hidden via candidates | Neutral: any packet |
| -------- | ---------------- | --------------- | --------------- | --------------------- | ------------------- |
| train    | full (intent-v2) | 635/768         | 554/768         | 582                   | 741/768             |
| train    | shipped          | 575/768         | 528/768         | 525                   | 746/768             |
| reworded | full             | 579/768         | 504/768         | 232                   | (not run)           |
| reworded | shipped          | 519/768         | 479/768         | 188                   | (not run)           |

The full index lifts train's hidden level by 60 of 768 (7.8 points) and its decoys by 26. This matches D714's reading
of seeds 41–44 against 45–48. The reworded gap is the same under both coverages (−56 and −56 hidden).

**Recommendation: make shipped coverage the default for train seeds, and keep the label on every run.**

- The funnel's headline should be the level a deployment would see. The full index is the generous case (D714,
  D715), and D715 found full coverage not worth its cost as a product lever, so it should not set the lab's level.
- Paired deltas inside one run are unaffected either way.
- Switching mid-wave would move the 315/276 baseline (seeds 41–42) that every open branch compares against. So:
  1. Today every run prints and records its coverage. The funnel prints `coverage:` beside the score and the TOTAL
     line and writes it in the JSON; pi-ab and hermes-ab's intent note says "coverage full".
  2. `--coverage shipped` is available now.
  3. The parent flips the funnel's default to `shipped` (and pi-ab's `--intent default` to the shipped file) at the
     start of the next wave, re-recording the main baseline in one commit.

## 4. Costs

Anthropic, all on the card role (Haiku 5.5, lab transport), from the spend ledger `.local/p7/ledger.jsonl`:

| Run | Worlds | USD |
| --- | --- | --- |
| Smoke runs | 2 | 0.018 |
| train1–6 × 41–44 × three variants | 72 | 0.501 |
| longtail and heldout19 × 41–44 × three variants | 24 | 0.171 |
| The 24 weeks users | 24 | WEEKS_USD |
| **Ledger total** | | LEDGER_USD |

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
