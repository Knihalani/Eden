# Haiku phase 3: what moved cost, speed and quality, and what did not

Status: 2026-11-02. Phase 3 of the Haiku campaign (lab only, simulated data, D97), on its own spend ledger capped at
$30. Haiku 5.5 is the agent, the grader and Eden's models, as in docs/research/haiku-benchmark.md. Every number below
comes from a command run in this session. The committed outputs are in `packages/sim/lab/haiku/phase3/`.

## Summary

- **NEW holds on a suite no one had read.** Held-out 13 was written for this phase by an author who saw only the
  world generator, the text helpers and the task interface. It was registered unread and run once, at the end
  (seeds 41–44, 128 hidden and 128 control tasks per condition).

  | Harness | Agent alone (tools) | + ALL3 | + NEW | NEW − ALL3 (95% CI) |
  |---|---|---|---|---|
  | Pi (eden-only arm) | 8.6% | 53.1% | **78.9%** | +25.8 (+16.4..+35.2) |
  | Hermes | 8.6% | 33.6% | **71.9%** | +38.3 (+28.1..+47.7) |

  False concerns stayed at or below 2.3% in every NEW-family condition but Hermes + NEW2 (3.9%).
- **No order-of-magnitude cut in Eden's cost or latency held quality.** The reader's reading is what moves the hidden
  fact, and it must land before the agent's first answer.
  - **No wait:** the reader runs beside the agent and its packet is taken at the next model request. Hidden facts
    fell 18 to 32 points on train (Pi both arm −32.3, Pi eden arm −18.2, Hermes −18.2). Agents mostly answer before
    a late packet can land.
  - **The relational judgement can't move to ingest time:** "is this the same account, date, person?" is what the
    reader adds over ALL3's ingest-time cards. ALL3 already joins cards to requests with no model at request time.
- **What did move:**
  - **A cheaper operating point, NEWL.** NEWL is NEW with a gate (skip the reader when no candidate could
    constrain), a 15-item pool and 240-character snippets.
    - Cost and wall time on held-out 13:
      - Eden's own cost per task: −30% (Pi), −32% (Hermes);
      - total task cost: −22% (Pi), −16% (Hermes);
      - wall p50: 0.3 s lower in both, which brings Hermes to ALL3's wall time (3.05 s vs 3.09 s).
    - Hidden fact against NEW (held-out 13):
      - Pi: −3.9 points (−12.5..+4.7);
      - Hermes: −0.8 (−8.6..+7.0).
    - On train it cost −8.3 points (−14.1..−2.6) in Pi's eden arm, 0 in the both arm and −3.1 in Hermes.
  - **NEW2: more reading, a little more found.** NEW2 is NEW plus the reader reading every request (not only
    imperatives) plus the user's standing constraints in its pool as a cached prefix.
    - Train: +6.2 points (+1.6..+10.9) in Pi's both arm and +6.8 (+1.8..+11.7) in Hermes.
    - Blind: +1 on seed 49. Held-out 13: +3.1 Pi both arm, +0.8 Pi eden arm, +6.2 Hermes (−0.8..+14.1), all
      inside noise.
    - Cost: 8–13% more Eden cost and 0.15–0.2 s more Eden time. False concerns slightly up (Hermes +3.1 points on
      held-out 13).
    - Not adopted.
- **Measured and dropped:**
  - reader notes inside pushed packets (+3.6 points, noise);
  - intent hits leading the pool (+8 hidden and +2 decoys against NEW2 v7: the pool already held them, so a
    reordering; the flag was removed);
  - standing items of every card kind (more decoys flagged);
  - a 40-item standing list (worse);
  - a line-format reply in place of JSON. Without JSON mode Haiku rambled and mislabelled, and NEW2's hidden fell
    from 291 (JSON, prompt v7) to 198–210 on train.
- **Spend:** $18.04 of the phase's $30 cap. The campaign total is $42.40 across both ledgers: $24.36 for Phases 1 and
  2 (cap $40) and $18.04 here (cap $30).

## What the order-of-magnitude targets ran into

The parent's targets were:
- Eden's request-time cost per task at or below ALL3's;
- Eden on the critical path below 100 ms;
- hidden fact at or above NEW's.

Three measured facts bound what is possible here:

1. **The agent's own model is most of the bill and most of the wall time.** In Phase 2's Pi matrix:
   - the agent was $5.71, the reader $3.19 and the cards $1.01 (the grader is lab-only);
   - wall p50 is 3.2 s with ALL3, where Eden's critical path is 36 ms.

   So Eden alone cannot cut total cost or wall time tenfold. It can only get back to ALL3's.
2. **The reading has to land before the agent answers.**
   - With no wait (NEWA), the packet reaches the agent's next model request, and many tasks have none.
   - A 1 s wait lost 7.6 and 18.1 points in Phase 2; no wait loses 18–32 here.
   - A fast enough reader would need its answer in well under the agent's own first-token time (about 0.5 s). Haiku's
     reader is 1.1–1.4 s at p50, most of it output.
3. **The reader's cost is mostly input, and the gate cannot be shown on these suites.**
   - Per call, about 2,800 uncached input tokens (the request's candidates) cost about $0.00028; about 200 output
     tokens cost about $0.0001.
   - Fewer and shorter candidates (NEWL) cut 28%. A cached per-user prefix helps only for what repeats across
     requests (with a 20-item standing list, 55–68% of the prompt was read from the cache; 74% with 40 items).
   - The gate skips a request whose candidates hold nothing constraint-like. Every simulated request has such
     candidates by design, so it skipped 2–10 of 768 on train. Its saving on real traffic, where most requests have
     no constraint, is not measured here.

## Train screens (no-model funnel with the reader live; packets alone, as a tool-using agent sees them)

Train1–6, seeds 41–42, 384 hidden and 384 control tasks. "Decoy flagged" counts control tasks whose planted decoy the
reader flagged.

| Configuration | Hidden delivered | Decoys delivered | Decoy flagged | Reader in / out tokens | p50 / p90 ms | $ / call |
|---|---|---|---|---|---|---|
| NEW (prompt v5) | 249 | 89 | 20 | 3,878 / 234 | 1,385 / 1,946 | 0.000424 |
| NEW, prompt v7 (shorter reasons, ≤ 4 entries) | 258 | 91 | 24 | 3,921 / 188 | 1,190 / 1,768 | 0.000401 |
| + standing 20 (uncached) | 261 | 90 | 20 | 7,401 / 269 | 1,540 / 2,094 | 0.000794 |
| + standing 20, cached prefix (v6; questions read in asks only) | 269 | 88 | 19 | 7,128 / 263 | 1,508 / 2,038 | 0.000469 |
| + every request read (NEW2, v6) | 299 | 96 | 29 | 7,063 / 259 | 1,501 / 2,020 | 0.000473 |
| NEW2, prompt v7 | 291 | 94 | 26 | 7,062 / 204 | 1,302 / 1,818 | 0.000427 |
| NEW2 (v6), push only blocks/limits/done: compare with the v6 row (299) | 276 | 86 | 29 | (replayed) | | |
| NEW2 + intent hits lead the pool | 299 | 96 | 28 | 7,064 / 204 | 1,265 / 1,742 | 0.000424 |
| NEW2, standing of every card kind, 20 / 30 | 287 / 291 | 101 / 100 | 34 / 32 | 6,851 / 209 | 1,277 / 1,745 | 0.000421 |
| NEW2, line-format reply (v8), 3 pool sizes | 198–210 | 96–98 | 32–34 | 5,582–7,047 / 180–204 | 1,329–1,410 | 0.000295–0.000427 |
| NEW + gate (v7) | 261 | 91 | 24 | (replayed) | | |
| NEWL: NEW + gate, pool 15, 240 chars | 254 | 93 | 24 | 2,876 / 177 | 1,119 / 1,522 | 0.000291 |
| NEW2 + pool 15, 240 chars | 286 | 99 | 31 | 6,074 / 196 | 1,203 / 1,552 | 0.000340 |

Prompt v7 (reasons of at most 8 words, at most 4 entries) is now the reader's prompt in every configuration: it cut
output tokens by a fifth at the same quality.

## Live agent runs on train (Pi and Hermes, Haiku agent)

| Comparison (train) | Pi eden arm | Pi both arm | Hermes |
|---|---|---|---|
| NEW2 − NEW, seeds 41–42 | +2.9 (−1.8..+7.6) | +6.2 (+1.6..+10.9) | +6.8 (+1.8..+11.7) |
| NEW2 + notes − NEW2, seed 41 | 0.0 (−5.7..+5.2) | +3.6 (−1.6..+8.9) | |
| NEWL − NEW, seed 41 | −8.3 (−14.1..−2.6) | 0.0 (−4.7..+4.7) | −3.1 (−8.9..+2.1) |
| NEWA (no wait) − NEW, seed 41 | −18.2 (−25.0..−12.0) | −32.3 (−39.6..−25.0) | −18.2 (−25.5..−10.9) |

False concerns moved by at most 1.6 points in any of these.

NEWA's wall p50 was 3.34 s against NEW's 4.24 s (Pi both arm), at half the hidden-fact rate. The harness books every
reader span as critical-path time, so the critical-path column overstates NEWA's Eden time. Its wall time is the
honest measure.

## Blind

- **Seed 49:** held-out 5–8 and 10–12 in Pi; held-out 5–8 in Hermes. Run once for NEW2, then stopped to keep budget
  for the end. NEW2 − NEW: +1.1 (Pi eden), +0.6 (Pi both), +3.8 points (Hermes, held-out 5–8 only). The CIs span
  about ±6 points.
- **Held-out 13:** seeds 41–44, Pi and Hermes, the final check.

| Condition (held-out 13) | Hidden | False concern | Wall p50 / p90 s | Eden on critical path ms | Eden $ / 1k tasks | Agent + Eden $ / 1k tasks |
|---|---|---|---|---|---|---|
| Pi none | 0.0% | 0.0% | 2.21 / 3.09 | 0 | 0 | 0.184 |
| Pi tools | 8.6% | 0.0% | 3.39 / 4.82 | 0 | 0 | 0.345 |
| Pi eden (ALL3) | 53.1% | 0.0% | 3.29 / 4.38 | 30 | 0 | 0.374 |
| Pi eden~NEW | 78.9% | 0.8% | 3.72 / 6.72 | 1,857 | 0.553 | 0.814 |
| Pi eden~NEW2 | 79.7% | 1.6% | 3.65 / 7.19 | 1,999 | 0.596 | 0.861 |
| Pi eden~NEWL | 75.0% | 2.3% | 3.39 / 6.76 | 1,711 | 0.388 | 0.638 |
| Pi both~NEW | 67.2% | 0.8% | 4.10 / 5.56 | 1,114 | 0.332 | 0.659 |
| Pi both~NEW2 | 70.3% | 2.3% | 4.36 / 5.84 | 1,266 | 0.374 | 0.693 |
| Hermes alone | 8.6% | 0.0% | 3.08 / 4.14 | 0 | 0 | 0.358 |
| Hermes + ALL3 | 33.6% | 0.8% | 3.09 / 4.75 | 19 | 0 | 0.396 |
| Hermes + NEW | 71.9% | 0.8% | 3.34 / 6.99 | 1,344 | 0.403 | 0.750 |
| Hermes + NEW2 | 78.1% | 3.9% | 3.79 / 7.08 | 1,548 | 0.456 | 0.830 |
| Hermes + NEWL | 71.1% | 0.0% | 3.05 / 6.44 | 1,236 | 0.276 | 0.628 |

- The critical-path column is the mean over hidden and control tasks.
- The cost columns are per thousand hidden tasks.
- Paired differences, held-out 13:
  - NEW − ALL3: +25.8 (Pi), +38.3 (Hermes);
  - NEW2 − NEW: +0.8 (Pi eden), +3.1 (Pi both), +6.2 (Hermes, −0.8..+14.1);
  - NEWL − NEW: −3.9 (Pi eden, −12.5..+4.7), −0.8 (Hermes, −8.6..+7.0).

  The full tables and intervals are in `agg-h13.txt`.

## The frontier, and the recommendation

Points, held-out 13: hidden fact raised, and agent + Eden cost per 1k hidden tasks.

| Point | Pi hidden | Pi $ / 1k | Hermes hidden | Hermes $ / 1k |
|---|---|---|---|---|
| ALL3 | 53.1% | 0.374 | 33.6% | 0.396 |
| NEWL | 75.0% | 0.638 | 71.1% | 0.628 |
| NEW | 78.9% | 0.814 | 71.9% | 0.750 |
| NEW2 | 79.7% | 0.861 | 78.1% | 0.830 |

- **NEW stays the recommended configuration (D98).**
- **NEWL is the cheaper point.** It gives up a few points (0–4 on blind, up to 8 on train in one arm) for about 30%
  less Eden cost and 0.3 s less wall time. It is the better choice where cost or latency matters more than the last
  few points.
- **NEW2** is not recommended: its gain over NEW did not separate from noise on blind suites, at higher cost and
  latency.
- **Every flag added in this phase stays off by default:**
  - `askReaderStanding` (with the cached standing prefix);
  - `askReaderStandingKinds`, `askReaderItemChars`;
  - `readerPushKinds`, `readerPushNotes`, `readerPushWaitMs`;
  - `readerGate`.

  `askReaderIntent` (intent hits leading the pool) was tried and removed.

  `askReaderQuestions` now also widens `readerPush` to every request.

## Not done, and why

- **Held-out 13 is still listed in `UNRUN_BLIND`** beside held-out 9–12, all now run. The registry tests rely on
  that list, so moving them out is a separate change.

- **The ingest-time cascade:** sync-time constraint records, a distilled scorer, batch backfill. Its first tier is
  what ALL3's cards already do with no model at request time (ALL3: 53.1% on held-out 13). The tier above it is the
  relational reading NEW does at request time. The measurements above say the reading must land before the agent
  answers, so a cascade can save calls (like the gate) but cannot move the reader off the critical path without
  losing quality. Its call saving cannot be measured on suites where every request is constraint-laden.
- **Cross-session verdict reuse:** every lab task is its own session with its own request, so reuse cannot show here.
- **Phase 3's own blind validation of NEW2:** only seed 49 ran; held-out 13 answered the question at the end.

## Reproduce

```bash
H=.local/haiku; L3="--spend-ledger $H/ledger-p3.jsonl --spend-cap 30 --spend-headroom 2"
V='{"NEW":{...PRESETS.NEW},"NEW2":{...,"askReaderQuestions":true,"askReaderStanding":20},
    "NEWL":{...NEW,"readerGate":true,"askReaderPool":15,"askReaderItemChars":240}}'   # as in phase3 run3.sh
bun packages/sim/src/lab/pi-ab.ts --suite heldout13 --seeds 41 --variants hidden,control --config ALL3 \
  --variant-config "$V" --cards $H/cards/cards-v2.jsonl --intent $H/intent/intent-v2.jsonl \
  --card-model claude-haiku-5-5 --reader-model claude-haiku-5-5 --model claude-haiku-5-5 --grader claude-haiku-5-5 \
  --conditions none,tools,eden,eden~NEW,eden~NEW2,eden~NEWL,both~NEW,both~NEW2 $L3 --out p3-pi-h13-s41.json
python3 -I packages/sim/lab/scripts/haiku-bench.py $H/ledger-p3.jsonl p3-*-h13-*.json
```
