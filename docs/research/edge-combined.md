# Edge tracks combined: ALL5

Status: 2026-11-01. Branch `edge/combined`. Proposed decision D92 (proposed until the live measure below passes).
Every number below comes from a command run in this session unless marked otherwise. Development suites (dev6a,
dev6b) and the old in-sample suites (hidden, heldout, heldout2–4) only; held-out 5–12 were not run or read
(`blind/heldout12` was merged unread: its three files were not opened).

## What was merged

`origin/main` (`486a26b84`) plus five edge tracks and the blind suite:

| Branch | What | Decision |
|---|---|---|
| `edge/secret` | `eden-aws-secret` rule in the secret gate, always on | D86 |
| `edge/freelab` | Lab-only free-model access: `allowLogging`, one `Pacer` per run, `--allow-logging --rpm --max-requests` | D91 |
| `edge/intent` | The intent index (`intent`): synthetic requests per item, fused at request time with no model | D87 |
| `edge/ask` | `askGuard`, `packetBearing`, `ASK_CONTEXT_GUIDED` | D88 |
| `edge/bridge` | `bridgeQuery` (one model call per acting request, slow path), `constraintDigest` | D89, D90 |
| `blind/heldout12` | A blind hidden-context suite, registered in `suites.ts` | (unread) |

Every track numbered its own row D86; they are renumbered D86–D91 in merge order, and each branch's doc says so.

### Conflicts and how they were resolved

- **Three free-model mechanisms became one.** `edge/intent` had its own `free-model.ts` (a fetch wrapper with a
  ledger file), `edge/ask` an `OpenRouterOptions.dataCollection` and `request-cap.ts` (`--lab-routing open`,
  `--min-gap-ms`), and `edge/bridge` an `OpenRouterOptions.labDataCollection` (`--free --cap --meter`). All three are
  replaced by freelab's `free.ts`: `OpenRouterOptions.allowLogging` (the only switch in `@eden/llm`), one `Pacer` per
  run (rate, cap counting retries, 429/5xx backoff honouring Retry-After), and the same three flags in every lab
  runner (`cards-enrich`, `bridge-enrich`, `hidden-funnel --judge live`, `pi-ab`, `free-smoke`). The tests that pin
  production routing were kept and merged: `fromEnv` sends `deny` whatever the environment says, and no product
  package names `allowLogging`.
- **`ask()` and the lookup.** Intent hits and bridge finds both join the candidates (`extra`); in an `ask` the bridge's
  seats follow the verdict hits, and the rest is then fused with the intent list (`fuseIntent`).
- **Config, COST-MODEL, DECISIONS**: union.

### A bug the merge exposed, fixed (test first)

With `askGuard` and `intent` (or the bridge's seats) on together, an `ask` could open with "Checked …: no rule, hold,
limit, absence or change found" while the answer cited the decisive item, which a model-made path had found and no
verdict had read as a block. On dev, 8 of 240 hidden asks did this (fixed-saver ×4: "Withdrawals aren't possible
before maturity", read as clear by the date test; talk-deadline ×4). The guard's line is a claim about the whole
answer, so `mayBlock` now also counts any item the intent index or the bridging queries chose for the request.
`combined.test.ts` reproduces it (fails without the fix, passes with it). After the fix, 0 of 240 dev hidden asks.

The price: the line becomes rare in ALL5, since a model-chosen item is in most acting answers. Dev hidden asks with the
line 29 → 4, control 74 → 17; in-sample hidden 11 → 3, control 121 → 34 (before and after the fix, ALL5). In-sample, 2
hidden asks still carry it with the planted item cited: `already-sent` ("(shown above)", a packet already gave it),
an `edge/ask` behaviour that predates this merge, left as found.

## Checks

- `bun run check`: green, 1,239 tests.
- `bun run eval` with every flag off: equal to `main`'s field by field except latency (`main` run from a `git
  archive` of `origin/main` in the scratchpad; p50 0.417 → 0.370 ms, p95 3.44 → 2.87 ms on the final tree, one run each: noise).
- The `reviewer` subagent was not run (no subagent tool in this session). Run it before merging: this branch touches
  the engine, the server and privacy code.

## Funnel (no model, replayed cards, intent requests and bridge queries)

`hidden-funnel.ts --ask --no-record`, seeds 41–44, the real sync, ALL3 (D80) plus the flags named. Dev: 240 hidden and
240 control tasks, the complete dev cards (path-to-90's `diag90/cards-all.jsonl`, scratchpad), intent requests from
path-to-90's glm doc2query file (seed-41 worlds, 1,093 items; scratchpad `intent/glm-d2q.jsonl`), bridge queries from
`edge-bridge` (`bridge-dev-v2.jsonl`). In-sample: 268 + 268 tasks, the committed `cards-v2.jsonl`, bridge
`bridge-in-v2.jsonl`; no intent requests exist for these worlds, so `intent` is inert there. "Either": a packet, the
ask's answer or the digest cited the planted item; decoys: the same on control tasks. No model call was made.

Flag groups: **I** = `intent`; **B** = `bridgeQuery`, `bridgeQuestions`, `bridgeAskSeats` 2; **G** = `askGuard`,
`packetBearing`; **D** = `constraintDigest`.

### Dev (dev6a + dev6b)

| Run | Hidden delivered | Hidden ask | Hidden digest | **Hidden either** | Decoy delivered | Decoy ask | Decoy digest | **Decoy either** | Ask B | Pkt B |
|---|---|---|---|---|---|---|---|---|---|---|
| ALL3 | 98 | 129 | | **129** | 23 | 100 | | **100** | 683 | 216 |
| + I | 98 | 140 | | **140** | 23 | 107 | | **107** | 701 | 216 |
| + B | 103 | 143 | | **144** | 20 | 106 | | **106** | 761 | 246 |
| + D | 98 | 129 | 35 | **146** | 23 | 100 | 20 | **108** | 683 | 216 |
| + G | 98 | 129 | | **129** | 23 | 100 | | **100** | 738 | 226 |
| **ALL5** (+ I, B, G) | 103 | 152 | | **153** | 20 | 110 | | **110** | 800 | 256 |
| ALL5 − I | 103 | 143 | | **144** | 20 | 106 | | **106** | 792 | 256 |
| ALL5 − B | 98 | 140 | | **140** | 23 | 107 | | **107** | 745 | 226 |
| ALL5 − G | 103 | 152 | | **153** | 20 | 110 | | **110** | 769 | 246 |
| ALL5 + D | 103 | 152 | 35 | **168** | 20 | 110 | 20 | **118** | 800 | 256 |

Seed 41 alone (the worlds the intent requests were written for, 60 + 60): ALL3 32 either / 25 decoys; + I 37 / 29;
ALL5 39 / 29; ALL5 − I 36 / 25.

### In-sample (hidden, heldout, heldout2–4)

| Run | Hidden delivered | Hidden ask | Hidden digest | **Hidden either** | Decoy delivered | Decoy ask | Decoy digest | **Decoy either** | Ask B | Pkt B |
|---|---|---|---|---|---|---|---|---|---|---|
| ALL3 | 216 | 244 | | **244** | 17 | 148 | | **148** | 638 | 278 |
| + I | 216 | 244 | | **244** | 17 | 148 | | **148** | 638 | 278 |
| + B | 215 | 246 | | **246** | 17 | 140 | | **140** | 710 | 295 |
| + D | 216 | 244 | 87 | **252** | 17 | 148 | 53 | **184** | 638 | 278 |
| + G | 216 | 244 | | **244** | 17 | 148 | | **148** | 702 | 293 |
| **ALL5** | 215 | 246 | | **246** | 17 | 140 | | **140** | 750 | 311 |
| ALL5 − I | 215 | 246 | | **246** | 17 | 140 | | **140** | 750 | 311 |
| ALL5 − B | 216 | 244 | | **244** | 17 | 148 | | **148** | 702 | 293 |
| ALL5 − G | 215 | 246 | | **246** | 17 | 140 | | **140** | 710 | 295 |
| ALL5 + D | 215 | 246 | 87 | **254** | 17 | 140 | 53 | **175** | 750 | 311 |

### Bearing marks in ALL5 (after the fix)

| | Dev hidden | Dev control | In-sample hidden | In-sample control |
|---|---|---|---|---|
| Planted item cited by the ask | 152 | 110 | 246 | 140 |
| … marked "May block or change this" | 94 | 13 | 198 | 4 |
| … marked "Says this is clear" | 5 | 31 | 0 | 52 |
| Packets carrying it | 103 | 20 | 215 | 17 |
| … marked "May block" | 75 | 8 | 151 | 1 |
| Asks with the "nothing found" line | 4 | 17 | 3 | 34 |
| … with the planted item cited | 0 | 7 | 2 | 17 |

The marks separate: a cited planted item is marked "may block" 62% of the time on dev hidden against 12% of dev
decoys (80% against 3% in-sample). The 5 dev hidden items marked clear are talk-deadline's extension mail (the
deadline is clear; the new 150-word limit is the fact): a verdict that reads only dates.

### Cost on the funnel

- Ask latency in process (p50 / p95): dev 7.75 / 26.6 ms → 8.74 / 27.7 ms; in-sample 8.62 / 21.7 → 10.06 / 28.8 ms.
- Bytes: ask answers +17% dev (683 → 800), +18% in-sample; packets +19% dev, +12% in-sample.
- Model work production would do (counted by the replaying makers, not sent): bridge calls 392 on dev (0.82 per
  task), 460 in-sample (0.86). With `intent`, the card enrichment reads every item, not only the prefilter's 5–7%:
  dev items sent to the card call 1,294 → 23,782 and calls 215 → 1,220 (16 simulated users: about 13 → 76 calls a
  user). In-sample the replay holds no requests, so its counters show the same reads with nothing returned.

## Choosing ALL5

Rule, fixed before reading the leave-one-out rows: a flag group joins if, removed from the full set, hidden either
falls on dev or in-sample, and its own decoy gain is no larger than its hidden gain on both groups; a group with no
funnel effect joins only if it carries a measured precision signal.

| Group | Leave-one-out, dev (hidden / decoys) | In-sample | Verdict |
|---|---|---|---|
| I (`intent`) | +9 / +4 | 0 / 0 (no requests) | **in** |
| B (`bridgeQuery` …) | +13 / +3 | +2 / −8 | **in** |
| G (`askGuard`, `packetBearing`) | 0 / 0 | 0 / 0 | **in**: marks separate planted from decoys (table above); bytes +4% asks |
| D (`constraintDigest`) | +15 / +8 (on top of ALL5) | +8 / +35 | **out**: in-sample decoys rise four times its hidden gain |

**ALL5 = ALL3 + `intent` + `bridgeQuery` + `bridgeQuestions` + `bridgeAskSeats: 2` + `askGuard` + `packetBearing`.**

Dev: hidden either 129 → 153 (54% → 64%) for decoys 100 → 110. In-sample: 244 → 246, decoys 148 → 140. The digest
stays a separate candidate (ALL5 + D: dev 168 / 118, in-sample 254 / 175); whether its in-force near-miss lines make
an agent more cautious needs the live arm, not the funnel.

## Caveats

- The intent requests are glm's (path-to-90's, a doc2query prompt), on seed-41 worlds only. The free model's prompt v1
  covered 6% of items; prompt v2 covered 67% of a 90-item sample (`edge-intent.md`) and 15 of 20 items here (below).
  A live run with free-model requests will reach less than the glm row.
- The bridge's queries are replayed instantly. Live, the free model took 4.4–8.8 s a request (`edge-bridge.md`),
  over `bridgeWaitMs` (4 s): packets would mostly go without it, and asks gain only once it has answered.
- The guard's go-ahead line is rare in ALL5 (above). Its live value is the marks, not the line.
- The funnel counts citations, not what the agent does with them.

## Free-model verification of the merged lab path (6 free requests)

| Step | Requests | Result |
|---|---:|---|
| `free-smoke.ts --allow-logging --max-requests 2` (nemotron-3.5-super-vl:free) | 1 | ok, 1.0 s, $0, JSON |
| `cards-enrich.ts --intent --funnel dev6a --seeds 41 --only 20 --batch 10 --model …:free --allow-logging --max-requests 6` | 3 | 20 items read, 15 with requests (prompt v2), one cut-off batch retried, $0 |
| `bridge-enrich.ts --suite dev6a --seeds 41 --batch 12 --allow-logging --max-requests 3` | 2 | 21 requests, all with queries, $0 |

`pi-ab.ts` gains `--intent FILE` (requests replayed into the card maker), `--bridge FILE` (queries replayed, misses
made live on `--bridge-model`, default `--card-model`, through the pacer), the `ALL3` and `ALL5` presets, and
`--ask-description auto` (the default: the guided description for a condition whose config has `askGuard`, as the MCP
server does; `guided` and `standard` force one). A `--dry` run of the plan's first command parsed (0 requests).

## Free-model live test plan (≤ 600 free requests, not run)

Agent `nvidia/nemotron-3.5-super-vl:free`, grader `dots-studio/dots-3-note-preview:free` (D91), Eden's judge, cards
and bridge on `nvidia/nemotron-3.5-super-vl:free`. Requests per task measured by `edge-freelab` on the `eden`
condition without cards: 4 (agent turns plus grade); budget 5 with Eden's own calls. Free limits are shared by the
whole account: check the day's usage before each step. `S` is the scratchpad holding the replay files.

```bash
S=/tmp/claude-0/-home-user-Eden/934a81f4-56d6-5053-a3cb-bb5257f049bb/scratchpad
FREE="--model nvidia/nemotron-3.5-super-vl:free --grader dots-studio/dots-3-note-preview:free \
  --card-model nvidia/nemotron-3.5-super-vl:free --allow-logging --rpm 18"

# 0. Smoke (≤ 12 requests): one hidden task, both arms, the whole path.
A5='{"A5":{"intent":true,"bridgeQuery":true,"bridgeQuestions":true,"bridgeAskSeats":2,"askGuard":true,"packetBearing":true}}'
bun packages/sim/src/lab/pi-ab.ts --suite dev6a --seeds 41 --variants hidden --limit 1 \
  --conditions eden,eden~A5 --config ALL3 --variant-config "$A5" \
  --cards $S/diag90/cards-all.jsonl --intent $S/intent/glm-d2q.jsonl --bridge $S/edge-bridge/bridge-dev-v2.jsonl \
  $FREE --max-requests 12 --out $S/live/smoke.json --timeline $S/live/smoke

# 1. Dev, paired (≤ 330 requests): the first 8 tasks of each world, ALL3 against ALL5 on the same tasks; replayed
#    cards, requests and queries, so Eden's model calls are its judge and the few misses.
bun packages/sim/src/lab/pi-ab.ts --suite dev6a,dev6b --seeds 41 --variants hidden,control --limit 8 \
  --conditions eden,eden~A5 --config ALL3 --variant-config "$A5" \
  --cards $S/diag90/cards-all.jsonl --intent $S/intent/glm-d2q.jsonl --bridge $S/edge-bridge/bridge-dev-v2.jsonl \
  $FREE --max-requests 330 --out $S/live/dev.json --timeline $S/live/dev
bun packages/sim/src/lab/pi-ab-report.ts $S/live/dev.json

# 2. Only if step 1 passes its bars: the blind suite (≤ 250 requests), everything live (requests and queries
#    made by the free model; the card call reads every item once, about 150 calls for the world).
bun packages/sim/src/lab/pi-ab.ts --suite heldout12 --seeds 41 --variants hidden,control --limit 4 \
  --conditions eden,eden~A5 --config ALL3 --variant-config "$A5" \
  --cards packages/sim/lab/cards/cards-v2.jsonl $FREE --max-requests 250 --out $S/live/blind.json
```

Total ≤ 592 requests. Pre-registered bars, ALL5 against ALL3 on the same tasks: hidden facts raised at least +0.05
(paired), false concerns on control tasks no more than +0.02, and no run cut short by the cap (`partial: false`).
Failing either bar, ALL5 is not adopted: the leave-one-out rows above say which group to drop first (G is the cheapest
to test alone: it changes only words). The samples are small (dev 32 tasks an arm, 16 hidden and 16 control; blind 8 an arm): a directional check on free
models, not a measure comparable with the paid runs (D85).

## Verdict

### Review fixes (D93)

A review of this branch found the guard's line could still sit beside the blocker it denies with no model-made path
involved: "Withdrawals from savings aren't possible before maturity", found by its words alone and read by no verdict,
under "Checked mail: no rule, hold, limit, absence or change found". The line is now withheld when any answer item, or
any candidate of the ask's pool (bulk mail aside), holds constraint wording (`mayConstrain`: the verdict paths' words,
the `conflictVocab` lists, and a few the guard adds: "must", "limit", "capped", "matures", "pending", "not yet" …), and
it now reads "Checked mail: none of the items found states a rule, hold, limit, absence or change", which is what the
engine read. The `already-sent` case above is covered by the same rule (its item states the action is done). The dev
and in-sample counts above were measured before these fixes and were not re-run; the false all-clear count after them
is a pass condition of the A/B (D93). Intent hits now count (seat, tie, fusion) only when anchored (D93), and the
bridge's queries go with the user's `forget`.

ALL5 is the dev and in-sample choice: +24 hidden facts surfaced on dev (54% → 64%) for +10 decoys, in-sample +2 for −8,
at +17% ask bytes, +1 ms ask p50, one model call per acting request (bridge) and the card call reading every item
(intent, about $0.035 per user-month estimated). ALL3 stays the recommended configuration until the plan above runs.
Every flag stays off by default.
