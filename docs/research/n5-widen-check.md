# N5: N2's "widen + check" at a cost and wait that can ship

Status: 2026-11-10, branch `claude/n5-widen-check` (from `claude/lucid-hypatia-v9wqk5` at 97b216a6, N2 and I3
merged), session N5. Decisions D525–D539. Train suites only (train1–6); heldout18 is not dumped, labelled or run.
Numbers marked **[EST]** are arithmetic or judgement; every other number comes from a command in this note. Every paid
call goes to Anthropic directly with `HAIKU_API_KEY` through the lab (D97): **Anthropic-direct lab figures**. Caps:
Anthropic $25 (ledger `.local/n5/ledger.jsonl` and the shards' ledgers), Modal $20.

## 0. Where this starts

- N2 (D510–D514): a push whose pool is widened (embedding neighbours, raw intent hits) and read by Haiku 5.5 with
  thinking at effort low ("does this item change what the agent should do for this request?") raised hidden facts
  +12.5 points live (short) and +10.9 over days, with look-alikes in the packet 418 → 195 and neutral packets
  617 → 150 at $0. Its price: $0.00115 and 5–7 s a push, +$0.98 per 1,000 tasks, +5 s wall. Without thinking the
  widening lets one look-alike in per fact.
- I3 (D500–D504): the same question with no thinking over the lexical pool: +4.0 points for +$0.11–0.13 per 1,000
  tasks and +0.8 s a task.
- **Targets (the brief's):** N2's quality or better at **≤ +$0.10 per 1,000 tasks in total** (agent + Eden, the
  days shape's steady state decides) and **≤ +0.3 s wall a task**, short and long horizon.
- **What the targets rule out before any run [EST].** A Haiku call the push waits for costs about 0.85 s at no
  thinking (I3: p50 0.89 s) and 0.82 calls a task, so any variant that calls on most pushes fails the wall target
  whatever its tokens. A variant can pass only if the push's decision needs **no model call** (the question is asked
  when the item is stored), or a call on **few** pushes (under about a third of them at no thinking, a twentieth
  with thinking), or a call the agent does not wait for. The order below follows from that.
- The base funnel on this tree (`bun run funnel --suite train --seeds 41,42,43,44 --jobs 4 -- --neutral`): hidden
  634/768, decoys 552/768, as N2's C0.

## 1. Pre-registration A: the question asked once, when the item is stored (hypothesis 4)

Written and committed before any paid call of this session.

### What a look at the pools showed ($0, before writing the prompt)

Six planted facts and their look-alikes read from seed 41's pool dump (train templates, not the held-out 40). Three
look-alikes are the fact's all-clear twin ("printing approved"). Two are a real constraint about **another person or
place** (the ramp closed at Fishbourne, not Lymington; Fatima off sick, not Bo). A label that says only "this item
states a constraint" cannot remove those; the request has to be compared with **what the constraint is about**. So
the stored answer holds that too.

### The stored answer (`n5-label.ts`, lab only at this stage)

Haiku 5.5 (`claude-haiku-5-5`), thinking adaptive at effort low (ingest is not on the agent's path), batches of at
most 12 items of a user's world, each item's title and first 900 characters (the card call's `READ_CHARS`), the items
fenced as data. No request is shown. Per item it writes:

- `act`: does this item, read by a careful assistant before acting on something it bears on, give a reason to stop,
  check first or do it another way (a limit, rule, clash, absence, deadline, hold, something already done or decided,
  a changed date, place, price or person)? An all-clear (approved, lifted, settled, called off, finished), background,
  chatter, a receipt or notice with no consequence, and bulk mail are `false`.
- for `act` items only: `about` (at most 6 short names: the specific people, organisations, places, accounts,
  things and kinds of thing the constraint applies to, **not** everyone the item mentions; a generic word for each
  specific thing, as a user would say it), `from`/`to` (the dates it holds over, when it states them), and `q` (at
  most 4 short requests a user might give that this item would change, in a user's words).

One label per item content (title and text hash), kept in a JSONL cache and replayed at $0.

### The push's rule (trial `pushActs`, D525; no model call on the push)

With `pushActs` on and an `acts` dependency (the lab's label table; a product build would keep the answer on the
item's card), the push's candidates are the pool's items (and, with `pushWiden`, the widened items) that the stored
answer passes **for this request**, in pool order, the first `pushCandidates`; none passing sends no packet (N2's
H3). The pass test is a function of the request and the stored answer only (no model, no network):

- **R0:** `act`.
- **R1:** `act`, and the request agrees with what the constraint is about. Candidate forms, to be chosen by the
  fitting rule below: (a) a named entity or content word of the request appears in `about` or `q` (stemmed tokens);
  (b) when the request names a day and the answer has `from`/`to`, the day falls inside them; (c) a lexical score of
  the request against `q` above a mark.
- An item with no stored answer (not yet read) is treated as the default treats it: a lexical-pool item passes, a
  widened item does not.

### Fitting and testing (no rule is fitted on the data that tests it)

- **Fit:** seeds 41–44, the 152 train-split templates (`splitOf`, share 0.2: I1/I2's split), at $0 on the cached
  labels. The prompt may be revised **once** after reading labels of fit-split items only; a revision re-labels
  everything and is reported with both versions' figures.
- **Screen:** seeds 41–44, the 40 held-out templates, the rule frozen.
- **Confirmation:** seeds 45–48, the 40 held-out templates (fresh worlds; intent replay does not cover 45–48, so the
  intent index is inert there in every arm, as in N2).
- **Arms** (funnel, `-- --neutral`): C0 the default; A1 `pushActs` (lexical pool only); A3 `pushActs` + `pushWiden`
  with the embedding table (`pushWidenEmbed` 5, `pushWidenIntent` 6: N2 §1's values, since no call's item cap binds);
  A3i `pushActs` + `pushWiden` with **no embedding** (`pushWidenEmbed` 0: the stored requests `q` indexed and matched
  lexically; this arm needs nothing at push time that the product does not have today).
- **Label gate, read first (held-out templates, seeds 41–44):** of the planted items, `act` for ≥ 85%; of the
  decoys, R1 passes ≤ 45% for their own request (I2's effort-low Haiku with the request in hand passed 42% of
  held-out decoys). Failing the gate, the arms are still screened (it costs $0) and reported.
- **Bars (N2 §1's H1+H3 bar, each arm against C0, screen and confirmation; every clause):** planted handed ≥ C0's;
  decoy handed ≤ C0's − 10%; hidden surfaced ≥ C0's; neutral packets at least halved. Reported beside it, not a bar:
  N2's C4L on the same tasks (41–44 all templates: hidden 690, planted handed 584, decoy handed 195, neutral packets
  150; 45–48 held-out: 124 / 112 / 42 / 22).
- **Cost of the labels:** $ per item from the ledger, and per 1,000 tasks at the cost model's items per user-day
  (docs/COST-MODEL.md), reported for direct calls and **[EST]** for the Message Batches price.

## 2. Pre-registration B: what a thinking check on the push costs at its cheapest (hypotheses 1, 2, 5)

Only as a component: §0's arithmetic says a call on every gated push cannot meet the wall target. Measured on a
fixed sample (seed 41, every 4th gated push of the hidden and control tasks, widened pool as A3 reads it), Haiku 5.5:

- T0: I3's request as shipped (no thinking), the reference.
- T1: I3's request with thinking adaptive at effort low, the reply unchanged (N2 §8's first thing to measure).
- T2: T1 over only the items the stored answer passes at R0 (fewer items; the others cannot be handed).
- T3: T2 with each item cut to its constraint sentence (`about`, dates and the 200-character excerpt).

Reported per arm: $ a call, input (cached) and output tokens, p50 and p90 seconds, planted yes, decoy yes. No bar:
these figures decide whether a two-stage arm (§3) is worth a funnel screen, by the rule there.

## 3. Pre-registration C: the call made rarely or behind (hypotheses 3, 5, 6)

Screened only if §1's best arm misses N2's C4L on the screen by more than 10 planted handed or 40 decoys handed (so
there is something left for a call to buy):

- **S1 (two-stage):** §1's rule decides; one thinking call (§2's cheapest arm that keeps planted yes ≥ 90% and decoy
  yes ≤ 50% on the sample) is made only when the items R1 passes include two or more that share an `about` name and
  differ in `act`'s grounds... **in short: only when the stored answers disagree about the same subject**, and at
  most on 15% of pushes (the bound that keeps a 2 s call inside +0.3 s a task). The exact trigger is fitted on the
  fit split and frozen before the screen, as §1.
- **S2 (behind):** the push hands §1's packet at once; the call of S1 runs behind and a correction (items to add) is
  queued for the agent's next take. Live only, and only if S1's screen passes: N3 (D515) found late packets rarely
  land, so its bar is hidden not lower than S1's waiting form.

## 4. Pre-registration D: live, and the promotion rule

For the best arm that passes §1's (or §3's) screen and confirmation, and A1 beside it if it passes too:

- **Harness:** Pi on Modal (`lab_fanout.py --preset bench-tools`, the F3/I3 bench recipe: `--tenant-prompt`, payload
  notices, direct profile, Haiku 5.5 agent and grader, cards and intent replayed where covered), the Modal Secret
  `HAIKU_API_KEY`, at most two Anthropic shards at a time, from the commit that holds the arm's code.
- **Short:** train seeds 41–48, `--variants hidden,control,neutral`, all templates if the cap allows (decided by seed
  41's measured spend, as I3 §3), else the 40 held-out templates.
- **Days:** `--days 8`, users w41–w48; the stored answers and (for an embedding arm) the embedding table made for
  those users' worlds beforehand.
- **Regrade:** every hidden answer and every control or neutral concern of the paired arms by Sonnet 5.5.
- **Intervals:** the powered bench's template-clustered bootstrap (`bench_report.py --sonnet`); for days also
  clustered by user (D519: day-level task intervals are too narrow).
- **Cost:** `pi-cost-report.ts` on connector-plan pricing, agent + Eden + background, steady state, 1:1:8; the
  stored answers' calls counted as background at their measured $ per item (direct price; batch price beside it).
- **Promotion rule (the brief's):** into `DEFAULT_CONFIG` only if hidden is better (short: the clustered interval
  above zero), Sonnet-confirmed concerns are not up, total $ per 1,000 tasks rises by at most $0.10 (days, steady
  state) and wall by at most 0.3 s a task (both shapes), **and** everything the arm needs at push time exists in the
  product (an arm that needs an embedding of the request has no shipped embedder: it can be recommended, not
  promoted, by this session). Otherwise the best arm stays an off trial and the trade (facts per dollar, per second)
  goes to the owner.

No arm, seed, split, bar or rule above changes after its first paid call; anything added later is labelled as an
addendum written before its own run.

## 5. Results of §1 (the question asked at ingest): it fails, and why

Labels: every item of train seeds 41–44 (6,891 distinct contents) and 45–48 (6,635), Haiku 5.5 at effort low, 12 items
a call: **$0.000053–0.000055 an item** direct (ledger runs `n5-label`, `n5-label-v2`, `n5-label-v2-45`; p50 1.9 s a
call). The prompt was revised once after reading fit-split labels, as §1 allowed (v2: `keys`, one to three words each,
in place of `about`; a `dated` flag; a settled debt or cancelled fine is `act`). **By mistake the first fitting table
also printed the screen split's rows for the v1 rules**; the v2 rules below were fitted on the fit split alone, and the
confirmation worlds (45–48) were not read.

- **Label gate (v2, fit split; the screen split reads the same):** planted `act` 439 of 439; decoys `act` 319 of 397
  (80%). Of the pools' other items 67% are `act` (every calendar entry is a possible clash). So "this item is a
  constraint" removes a fifth of the look-alikes and nothing else: most look-alikes are a real constraint about
  **another** venue, invoice, person or day.
- **No pass rule read from the stored answer separates them.** Fit split, offline on the dumped features
  (`.local/n5/acts-dump.jsonl`, 608 tasks a variant): requiring one stored key in the request passes 304 of 472
  planted facts in the read set and 232 of 438 decoys; every threshold of the rarity-weighted overlap moves both
  together (planted to decoy pass ratio 1.2–1.6 throughout; N2's thinking check: 3.0). The facts it loses reach the
  request by a leap the stored words do not hold ("Will is off sick" for "get Will to sign off": the request never
  says sick, leave or approvals).
- **In the funnel** (seeds 41–44, `compare.py`; R0 = `act`; R1 = `act` and (a key in the request or weighted overlap
  ≥ 8) and not a dated answer outside the request's days):

| Arm (fit split, 608 a variant)          | Hidden surfaced | Decoys surfaced | Planted handed | Decoy handed | Neutral packets |
| --------------------------------------- | --------------- | --------------- | -------------- | ------------ | --------------- |
| C0 default                              | 498             | 448             | 387            | 334          | 482             |
| A1 stored, R0                           | 506             | 452             | 406            | 276          | 496             |
| A3 stored, R0, widen (embedding)        | 506             | 452             | 406            | 276          | 499             |
| A3i stored, R0, widen (stored requests) | 506             | 453             | 406            | 277          | 499             |
| A1 stored, R1                           | 505             | 452             | 344            | 208          | 188             |
| A3 stored, R1, widen (embedding)        | 519             | 467             | 357            | 221          | 206             |
| A3i stored, R1, widen (stored requests) | 520             | 463             | 358            | 217          | 230             |

On the screen split (160 a variant): C0 104 planted handed, 84 decoys, 135 neutral packets; A1 R0 105 / 61 / 135;
A1 R1 90 / 59 / 55; A3 R1 93 / 66 / 58.

- **Against §1's bars: every arm fails.** R0 keeps the facts (+19) and cuts decoys 17% but leaves neutral packets
  where they were (bar: halved). R1 halves them and cuts decoys 34–38% but hands 11% fewer planted facts (bar: not
  fewer). The stored answer does not keep I2's separation without the request in hand: hypothesis 4 is rejected
  (D526). No confirmation run was made (the screen failed); the 45–48 labels were made before the screen was read and
  are used only by §7's gate.

## 6. Pilot of §2 (seed 41), and an arm §2 did not have: the reply compares first

§2's sample was to be every 4th gated push of seed 41; the funnel runs a whole seed as cheaply, so **all of seed 41**
(473 calls an arm) was run instead, every arm with `pushWiden` and the embedding table, `pushCheckWaitMs` 60,000:

| Arm (seed 41, 192 a variant)                  | Planted handed | Decoy handed | Neutral packets | $ a call     | in (cached) / out tokens | p50 / p90 s     | failed |
| --------------------------------------------- | -------------- | ------------ | --------------- | ------------ | ------------------------ | --------------- | ------ |
| C0 default                                    | 121            | 110          | 156             |              |                          |                 |        |
| T0 I3's reply, no thinking                    | 139            | 70           | 67              | 0.000237     | 2,772 (892) / 79         | 0.87 / 1.18     | 0      |
| T1 I3's reply, thinking low                   | 108            | 14           | 15              | 0.000358     | 2,598 (836) / 346        | 2.05 / 3.47     | 30     |
| T1a T1 over stored-`act` items only           | 103            | 15           | 18              | 0.000318     | 2,236 (840) / 340        | 2.16 / 3.36     | 28     |
| T2c compare-first, first wording (`same`)     | 125            | 26           | 24              | 0.000253     | 2,905 (1,025) / 110      | 0.89 / 1.22     | 3      |
| T2a T2c over stored-`act` items only          | 125            | 31           | 21              | 0.000213     | 2,504 (1,027) / 109      | 0.88 / 1.22     | 1      |
| T3c compare-first, second wording             | 132            | 31           | 31              | 0.000262     | 3,030 (1,150) / 126      | 0.95 / 1.28     | 3      |
| **T4c compare-first, third wording (`hits`)** | **138**        | **36**       | **45**          | **0.000269** | 3,056 (1,180) / 140      | **0.98 / 1.41** | 5      |

- **Thinking on I3's short reply is not N2's check** (T1): 2.0 s and $0.00036 a call, close to N2's guess, but it hands
  fewer planted facts than the default (108 against 121) and 30 replies were unreadable. Reading only the
  stored-`act` items (T1a, T2a: hypothesis 2's "fewer items") saves 14% of the input and changes nothing else. Both
  switches are deleted (D528).
- **A reply that compares before it decides does what thinking did, without thinking** (`pushCheckForm` 2, D527): per
  listed item it writes what the item's point applies to, then what of the request's own that point lands on (or
  "none"), then the verdict. The wording was revised twice on seed 41 after reading fit-split replies: `same`
  (true or false) rejected facts that bear on the request without sharing its names (an all-hands on the request's
  evening, an allowance its amount counts against); `hits` names the link instead. With it the check hands as many
  planted facts as I3's reply (138 against 139), half its look-alikes (36 against 70) and fewer neutral packets, at
  I3's price and wait. N2's thinking check on the same seed's scale handed 146 / 49 / 37 for $0.00115 and 6.8 s.

## 7. Pre-registration E (addendum): the compare-first check, its screen, a gate, and the live arms

Committed after §6's pilot and **a few minutes after the seeds 42–44 runs below were started; none of their output had
been read**. The wording (`CHECK_SYSTEM_COMPARE`, commit 9968cb8e) is frozen from here.

- **Arm K:** `pushCheck`, `pushCheckForm` 2, `pushWiden` (the tree's `pushWidenEmbed` 3, `pushWidenIntent` 2, the
  embedding table), Haiku 5.5, no thinking, I3's other settings.
- **Screen:** seeds 42–44, all templates (seed 41 chose the wording, so it is reported apart), `pushCheckWaitMs`
  60,000. **Confirmation:** seeds 45–48, the 40 held-out templates (intent inert in every arm).
- **Bars (N2 §1's H1+H3 bar, K against C0, screen and confirmation, every clause):** planted handed ≥ C0's; decoy
  handed ≤ C0's − 10%; hidden surfaced ≥ C0's; neutral packets at least halved. Beside it: N2's C4L on the same tasks.
- **Arm G, the gate (hypothesis 3), only if K passes:** K's call is made only when a stored answer of some read item
  scores at least a mark for the request (weighted overlap + 6 × keys in the request); otherwise no call. Two forms,
  both screened at $0 on K's recorded replies: Gd (no call → the default's candidates) and Gs (no call → no packet).
  The mark is the one, fitted on the fit split of seeds 41–44, that keeps the call rate on the 1:1:8 mix at or under
  **0.33** (a 0.9 s call then adds under 0.3 s a task); the form is the one with more planted handed on the fit
  split. G goes live if, on the screen split and the confirmation, planted handed ≥ C0's and decoy handed ≤ C0's.
- **Live (§4's harness, regrade, intervals and rule), arms `eden`, `eden~K` and, if it qualifies, `eden~G`.** K's
  wait: the shipped `pushCheckWaitMs` 2,500 inside the harness's 3,000 ms observe wait (I3's shape). Short: seeds
  41–48, hidden, control and neutral, all templates if seed 41's measured spend projects the whole plan under $14,
  else the 40 held-out templates. Days: `--days 8`, users w41–w48. The embedding table is keyed by item content for
  both shapes, so (unlike N2) a days user's world is covered; the share of requests it finds is reported.
- **What can be promoted:** K needs nothing at push time the product lacks except the `widen` dependency (no shipped
  embedder), so by §4's rule `pushWiden` can be recommended only; `pushCheck` with `pushCheckForm` 2 can be promoted
  if the live rule holds for it. Since K as run includes the widening, a promotion of the check alone would need K
  without `pushWiden` measured too: **arm `eden~Kp`** (`pushCheck`, `pushCheckForm` 2, no widening) runs beside K
  for that. G needs the stored answers (an ingest call the product does not make): recommended only.

## 8. Screen and confirmation of §7 (funnel, Haiku 5.5 live, every decision the check's)

`bun run funnel --suite train --seeds S -- --neutral --check live --check-cache F --widen-table …`, one process a
seed; `compare.py`. K's calls: 470–473 a seed (0.82 a task), **$0.000268–0.000272 a call, p50 0.97–1.00 s, p90
1.40–1.47 s**, 3,049–3,076 input tokens (1,185 cached) and 139–145 output tokens a call; 9–13 replies a seed
unreadable (2%, the default's candidates go).

| Arm                                  | Tasks                      | Hidden surfaced  | Decoys surfaced | Planted handed    | Decoy handed | Neutral packets |
| ------------------------------------ | -------------------------- | ---------------- | --------------- | ----------------- | ------------ | --------------- |
| C0 default                           | 42–44, all (576 a variant) | 480              | 411             | 370               | 308          | 461             |
| Kp compare-first, no widening        | 42–44, all                 | 497              | 413             | 403               | 112          | 135             |
| **K compare-first, widened**         | 42–44, all                 | **510 (+33 −3)** | 426             | **419 (+60 −11)** | **125**      | **140**         |
| C0                                   | 41–44, all (768)           | 634              | 552             | 491               | 418          | 617             |
| K (seed 41 chose the wording)        | 41–44, all                 | 677              | 571             | 557               | 161          | 185             |
| N2's C4L (thinking, $0.00115, 6.8 s) | 41–44, all                 | 690              | 585             | 584               | 195          | 150             |
| C0 (intent inert)                    | 45–48, held-out (160)      | 82               | 83              | 64                | 66           | 107             |
| **K**                                | 45–48, held-out            | **119 (+37 −0)** | 84              | **103 (+42 −3)**  | **27**       | **21**          |
| N2's C4L                             | 45–48, held-out            | 124              | 86              | 112               | 42           | 22              |

- **K passes every bar on the screen and on the confirmation** (planted handed not lower, decoy handed at least 10%
  lower, hidden surfaced not lower, neutral packets at least halved): 370 → 419, 308 → 125 (−59%), 480 → 510,
  461 → 140 on seeds 42–44; 64 → 103, 66 → 27, 82 → 119, 107 → 21 on the fresh worlds.
- **Against N2's thinking check on the same tasks** it hands 27 fewer planted facts of 768 and 34 fewer look-alikes
  on 41–44, and 9 fewer and 15 fewer on 45–48, for **23% of the price and 14% of the wait** a call.
- **The reply carries most of it; the widening adds a little** (Kp against K, 42–44): +33 planted handed without
  the widening, +16 more with it (and +13 look-alikes).

**The gate (arm G).** Fitted on the fit split of seeds 41–44 at $0 on K's recorded replies (`--check replay`,
`pushCheckGate` 1 or 2, `--acts-rule {"mode":"match","minScore":M}`; the call rate by variant from each task's
`pushCheckCalled`):

| Mark M, form                   | Call rate on the 1:1:8 mix (hidden / control / neutral) | Planted handed | Decoy handed | Neutral packets |
| ------------------------------ | ------------------------------------------------------- | -------------- | ------------ | --------------- |
| no gate (K), fit split (608)   | 0.82 (the default's own gate)                           | 435            | 136          | 152             |
| 10, default's candidates       | 0.397 (0.71 / 0.65 / 0.33)                              | 428            | 174          | 364             |
| 11, default's candidates       | 0.331 (0.65 / 0.61 / 0.26)                              | 425            | 185          | 394             |
| 11, no packet                  | 0.331                                                   | 364            | 113          | 68              |
| **11.5, default's candidates** | **0.289 (0.61 / 0.56 / 0.22)**                          | **422**        | **191**      | **407**         |
| 12, default's candidates       | 0.253 (0.57 / 0.53 / 0.18)                              | 420            | 201          | 423             |

The rule picks the mark at or under 0.33 (11 reads 0.331: over) and the form with more planted handed: **Gd at
11.5**. On the screen split (160): planted handed 104 → 120 (K 122), decoy handed 84 → 43 (K 25), neutral packets
135 → 116 (K 33), call rate 0.265. On the confirmation: 64 → 95 (K 103), 66 → 40 (K 27), 107 → 91 (K 21), call
rate 0.221. **G qualifies for the live run.** What the gate gives up is the silence: where it makes no call the
default's packet goes, so a neutral request still gets one four times in five.

## 9. Pre-registration F (addendum): a gate that needs no stored answer, and a check that never silences

Written after round 1's short run was read (§10: K +7.9 points for +$0.21 per 1,000 tasks and +1.06 s; G +5.3 for
+$0.054 and +0.33 s) and before round 1's days run finished; committed before round 2 started.

**Two things round 1 showed.**

- **Silence is not free one request at a time.** K and Kp send no packet on most neutral requests, and the agent then
  asks: `ask_context` +0.30 a task on the 1:1:8 mix, agent turns +0.15, so wall rises 1.06 s for 0.81 calls of
  0.95 s. G, which leaves the default's packet where it makes no call, shows neither (+0.04 asks).
- **G's stored answers cost an ingest call for every item** ($0.054 per 1,000 items; at the cost model's 36 new items
  and about 16 requests a day that is about +$0.12 per 1,000 tasks direct, +$0.06 by batch **[EST]**), which is most
  of the budget G saved.

**So two switches, screened at $0 on recorded replies before this was written** (seeds 42–44, the no-widening arm's
replies, 576 a variant; C0 370 planted handed, 308 decoys, 461 neutral packets; Kp 403 / 112 / 135 at 0.82 calls):

| Arm (no widening)                                                                                   | Calls a task, 1:1:8 mix | Planted handed | Decoy handed | Neutral packets |
| --------------------------------------------------------------------------------------------------- | ----------------------- | -------------- | ------------ | --------------- |
| gate: a constraint-like pool item names a request anchor (`pushCheckAnchored`)                      | 0.291                   | 393            | 198          | 378             |
| the same within the first five pool items                                                           | 0.242                   | 381            | 212          | 395             |
| `pushCheckAnchored`, and a check naming nothing leaves the default's packet (`pushCheckSilent` off) | 0.291                   | 399            | 285          | 461             |
| no gate, `pushCheckSilent` off                                                                      | 0.806                   | 411            | 278          | 461             |

With the widening on the fit split of 41–44, the anchored gate reads planted handed 418 against the stored-answer
gate's 422 at the same call rate (0.289): the stored answers buy nothing the default's own constraint test and
anchors do not.

**Arm N (round 2):** `pushCheck`, `pushCheckForm` 2, `pushCheckAnchored`, `pushCheckSilent` off, **no widening**: the
check is called on about three pushes in ten and only ever replaces the default's packet with the items it named.
It needs nothing the product lacks (the servers wire the checker on the reader's model), so it can be promoted.

- **Runs:** Pi on Modal, §4's harness, arms `eden` and `eden~N`, short (seeds 41–48, hidden, control, neutral, all
  templates) and `--days 8` (users w41–w48); every hidden answer and every concern Sonnet-regraded.
- **Rule (the brief's, §4's):** N is promoted into `DEFAULT_CONFIG` only if hidden is better (short, the
  template-clustered interval above zero), Sonnet-confirmed concerns are not up (short and days), total $ per 1,000
  tasks rises by at most $0.10 (days, steady state, `pi-cost-report.ts`; the short shape's 1:1:8 figure beside it)
  and wall rises by at most 0.3 s a task on both shapes (paired mean on the 1:1:8 mix, `mix.py`). Otherwise it stays
  an off trial and the trade is reported.
- **Budget:** about $5.8 **[EST]** (short $3.0, days $0.9, regrades $1.9) of the $8 left under the $25 cap.
- The top-five gate, the stored-answer gate with no packet, and N with the widening are not run live (the cap).
