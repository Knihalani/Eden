# A29: the end-of-day blind check of the default on heldout17

Status: 2026-11-07, branch `claude/a29-heldout17` (from `claude/lucid-hypatia-v9wqk5` at
`ed93f3365e3b8bd1e3539ec1f80063f1a4c89746`). Decisions D395–D399. **Measurement only: no engine file changes.**

## 0. Pre-registration (committed and pushed before any paid call; nothing on heldout17 had been run or read)

**Question.** Does today's shipped default still beat the agent alone on hidden facts, cost and speed, one request a
session and over a user's days, on a suite nobody has run?

**Suite.** `heldout17` (A19, D350): 32 templates, hidden / control / neutral variants, 8 late-arrival templates
(`HELDOUT17_LATE`). Cards and intent replayed (cached for seeds 41–44; cards from `cards-v2` + `cards-train` +
`cards-train-4344`, as RealUse-3 did).

**Harness.** Pi (`pi-ab.ts`), `--config default`, `--tenant-prompt` (D271) in every arm, market `direct` source
profile, `claude-haiku-5-5` in every role (agent, grader, cards, intent, reader), `claude-sonnet-5-5` only to regrade
concerns (`regrade.ts --only-concerns --graders claude-haiku-5-5,claude-sonnet-5-5`). Anthropic only, via
`HAIKU_API_KEY`, `env -u OPENROUTER_API_KEY`, one ledger `.local/a29/ledger.jsonl` with a hard cap of **$6** for the
whole session. One seed per pi-ab process. Script: `packages/sim/lab/a29/run.sh`.

**Arms.**

| arm            | what                                                                         |
| -------------- | ---------------------------------------------------------------------------- |
| `tools`        | the agent alone with its source search tools                                 |
| `eden`         | the shipped default (candidates, askNudge, payload notices in the main runs) |
| `eden+nokey`   | the default on a server with no model key (D291: no cards, no reader)        |
| `eden~nonudge` | the default minus `askNudge` (D316), a variant, run in the same processes    |

**Runs (each once).**

1. Short (one request a session), payload: all four arms, seeds 41 and 42, hidden + control + neutral (96 tasks a
   seed an arm).
2. Long (a user's days), payload: all four arms, users 41 and 42, `--days 2 --day-size 16` (heldout17's 32 templates
   bound a user, as heldout16's did). Backfill per user: `cold-start.ts --suite heldout17 --days 2 --day-size 16`,
   reported apart.
3. Secondary rows on the `eden` arm: short `--push signals` and `--push refs` (D347), seeds 41 and 42 (their
   `eden − tools` pairs use run 1's `tools` arm, cross-run).
4. Late arrivals: `tools,eden`, `--day 4 --late --templates <HELDOUT17_LATE>`, hidden + control, seeds 41 and 42,
   payload, its own row.

If budget or time runs short, runs are dropped in the order 3 (refs), 3 (signals), the `eden~nonudge` arm (it is in
the same process, so it is kept unless the cap forces a rerun without it), 4; runs 1 and 2 are never dropped.

**Metrics.** Hidden facts raised; false concerns on control and neutral tasks, Haiku-graded and after the regrade
(kept when both regraders keep it, Sonnet's verdict counting on disagreement), each read by hand; $ per 1,000 tasks
steady on the assumed 1:1:8 mix (agent + Eden per task + background; backfill per user apart) and with connector plan
pricing (`pi-cost-report.ts`'s rows: first-party, Composio, Unified.to, Arcade, Pipedream, Zapier MCP); wall p50 and
mean; Eden on the critical path (ms a task); connector calls a task. Paired differences with bootstrap 95% intervals
(5,000 draws), as `pi-heldout16.md` did (`arms.py` for the mix pairs, `pooled.py` for hidden and concerns pooled over
short and long payload runs).

**Rules (applied mechanically).** For `eden − tools`, pooled over the short and long payload runs where pooled, else
per horizon:

- Hidden facts: **beats** if the 95% interval is entirely above zero; else **does not beat**.
- False concerns (regraded, control + neutral pooled): **no worse** unless the interval is entirely above zero.
- Cost ($/1k steady, mix): **cheaper** if the interval is entirely below zero, **dearer** if entirely above, else
  **level**, per horizon.
- Speed (wall mean, mix): **faster** if the interval is entirely below zero, **slower** if entirely above, else
  **level**, per horizon.
- The default is **confirmed** if it beats on hidden facts, is no worse on concerns, and is not dearer and not slower
  on either horizon. Otherwise the note says which claim failed; nothing is tuned here.
- `eden+nokey` and `eden~nonudge` are reported with the same pairs (against `tools` and against `eden`); they change
  no default in this session. A result for either would need its own trial.
- heldout16's numbers (cl-results.md, realuse-3/pi-heldout16.md) are compared side by side; differences in
  harness (`--tenant-prompt` was not on in RealUse-3) are named, not adjusted for.

Afterwards heldout17 leaves `UNREAD_BLIND` and is marked read in LAB.md.

## In plain words

**Spent: $0.487** of the $6 cap (3,941 calls, `spend.txt`), Anthropic-direct lab figures (D97). Every run went once;
no harness bug, no rerun, 0 errors, 0 ungraded, 0 Anthropic retries.

- **Hidden facts: yes, by a wide margin, blind.** With the default the agent raises the hidden fact in **47 of 64**
  hidden tasks one request a session (73.4%) and **7 of 8** over a user's days, against **3 of 64** and **0 of 8** for
  the agent alone. Pooled, **+70.8 points (+59.7..+81.9)**.
- **False concerns: no rise.** Haiku flagged 2 of 184 control and neutral answers in `eden` and 1 in `tools`; after
  the Haiku + Sonnet regrade one `eden` answer is kept (+0.5 points, 0.0..+1.6), and read by hand it is not a false
  alarm (§5). No answer on a look-alike task named the decoy, in any arm or run.
- **Speed: yes.** The agent with Eden answers **0.62 s sooner** a request one request a session (mix wall mean 2.37
  against 2.99 s; p50 2.41 against 3.03) and **0.45 s sooner** over days (1.42 against 1.86 s; p50 1.22 against 2.02).
  Eden's own time on the agent's path is 12 ms a task (short) and 11 ms (long).
- **Cost: no, at first-party connector prices.** On the billed agent bill the default costs **$0.305 against $0.218**
  per 1,000 tasks one request a session (+$0.087, +0.067..+0.107) and **$0.243 against $0.191** over days (+$0.059,
  +0.031..+0.088). Eden itself spends nothing per task (cards and intent replayed, no reader on the path); the gap is
  the agent's bill: re-priced cache-neutral the short difference is −$0.009 (−0.035..+0.019), level, so the agent
  alone is cheaper because more of its prompt is served from Anthropic's cache. With any priced connector plan the
  agent alone pays for its own source calls (2.15 a task short, 1.07 long, against 0 for Eden's agent) and Eden is
  far cheaper: Composio −$0.39/1k short, −$0.27 long; Zapier MCP −$40.8 and −$27.6.
- **The pre-registered verdict: not confirmed, on cost alone.** The default beats the agent alone on hidden facts, is
  no worse on concerns and is faster on both horizons; it is dearer on billed first-party cost on both horizons, so
  the rule's "not dearer" clause fails. Nothing was tuned.
- **What changed since heldout16:** the house rules (`--tenant-prompt`, D271) are now on in every arm; RealUse-3 ran
  without them. They make the agent alone cheaper and quicker (mix $0.218 against 0.357, wall 2.99 against 4.92 s,
  2.15 against 3.29 tool calls). So Eden's speed edge shrinks (−0.62 s against −2.01 s short) and heldout16's "level
  short, cheaper long" becomes "dearer by $0.06–0.09/1k". This is the shape A3 measured on train with the same flag
  (+$0.060 short, +$0.080 long, D271); heldout17 confirms it blind. Hidden facts barely move (73.4% against 79.7%
  short; the agent alone 4.7% against 10.9%). The default itself also changed between the two runs (askNudge, D316,
  and the A-wave), and the suites differ, so the deltas are not attributed to one cause.
- **The variants.** A server **with no model key** (`eden+nokey`) still raises **+48.6 points** over the agent alone
  (+36.1..+61.1), but **22.2 fewer than the default** (−34.7..−11.1): the cards matter. **Without askNudge**
  (`eden~nonudge`) the default loses **12.5 points** (−23.6..−1.4) for $0.031/1k and 0.19 s less: askNudge (D316)
  holds up blind.
- **Notices.** Refs notices (D347) keep the speed (−0.68 s against tools, Eden 76 ms on the path, 0.58 connector calls
  a task more than tools) and raise 40 of 64; signals raise 41 of 64 but are **1.04 s slower** than the agent alone
  (8.9 connector calls a task, Eden 1.76 s on the path). Payload stays the main path (47 of 64).
- **Late arrivals** (8 late templates, `--day 4 --late`): neither arm can raise a fact that does not exist yet (0 of
  16 each), but the agent with Eden brings it up in a **later reply the same day 7 of 16** times against 0 of 16
  (+43.8 points, +18.8..+68.8), with 0 false alarms on the look-alikes, for +$0.059/1k agent cost.

## 1. Runs

Pi, `--config default`, `--suite heldout17`, `--tenant-prompt`, market `direct` profile, time scale 1, cards replayed
from the three checked-in card files (5,956 items), intent replayed (1,476–1,532 of 1,482–1,539 items); no live card
was made in any run. `packages/sim/lab/a29/run.sh LABEL PUSH ARMS [flags]`, one seed a process, at most three at once.

| run                    | push    | arms                                       | seeds | tasks an arm                                  | $      |
| ---------------------- | ------- | ------------------------------------------ | ----- | --------------------------------------------- | ------ |
| `a29-short-pay-41,42`  | payload | tools, eden, eden+nokey, eden~nonudge      | 41–42 | 96 a seed (32 hidden, 32 control, 32 neutral) | 0.242  |
| `a29-long-pay-41,42`   | payload | tools, eden, eden+nokey, eden~nonudge      | 41–42 | 32 a user: `--days 2 --day-size 16` (4/4/24)  | 0.079  |
| `a29-short-sig-41,42`  | signals | eden                                       | 41–42 | 96 a seed                                     | 0.059  |
| `a29-short-refs-41,42` | refs    | eden                                       | 41–42 | 96 a seed                                     | 0.055  |
| `a29-late-41,42`       | payload | tools, eden (`--day 4 --late`, 8 late)     | 41–42 | 16 a seed (8 hidden, 8 control)               | 0.029  |
| `a29-cold`             |         | cold start, user:41–42 (heldout17, 2 × 16) |       |                                               | 0.014  |
| `a29-regrade-*`        |         | Haiku + Sonnet regrade of concerns only    |       |                                               | 0.009  |

The long horizon is two days of 16 (heldout17's 32 templates bound a user), 0 slot clashes; its hidden and control
rates rest on 8 tasks an arm. The one-time backfill is the cold start of the same user shape: **$0.0072 a user** (6.5
card calls, 18 connector calls), reported apart.

## 2. Results (1:1:8 mix, assumed traffic)

Cost: $ per 1,000 tasks, billed, steady = agent + Eden per task + background while working (`pi-cost-report.ts`;
first-party connectors, quota only). Wall: p50/p90 pooled over the mix (`pi-ab-report.ts`), mean weighted
(`arms.py`). Eden ms: union of Eden's spans on the critical path, a task. Conn: connector calls a task (the agent's
search tools + Eden's in the task's window + Eden's background), mix. Concerns: Haiku-graded [regraded].

### Short horizon (one request a session), payload, seeds 41–42

| arm          | hidden             | control | neutral   | steady $/1k | wall p50/p90/mean s    | Eden ms | asks | conn |
| ------------ | ------------------ | ------- | --------- | ----------- | ---------------------- | ------- | ---- | ---- |
| tools        | 3/64 (4.7%)        | 0/64    | 1/64 [0]  | **0.218**   | 3.03 / 4.91 / 2.99     | 0       | 0    | 2.15 |
| **eden**     | **47/64 (73.4%)**  | 0/64    | 0/64      | 0.305       | **2.41 / 2.98 / 2.37** | 12      | 1.06 | 0.56 |
| eden+nokey   | 33/64 (51.6%)      | 0/64    | 0/64      | 0.283       | 2.39 / 2.93 / 2.27     | 10      | 1.09 | 0.56 |
| eden~nonudge | 39/64 (60.9%)      | 0/64    | 1/64 [0]  | 0.274       | 2.31 / 2.97 / 2.18     | 11      | 0.85 | 0.56 |

### Long horizon (two days of 16 a user, Eden kept, the agent's transcript reset daily), payload, users 41–42

| arm          | hidden       | control | neutral  | steady $/1k | one-time $/user | wall p50/p90/mean s    | Eden ms | asks | conn |
| ------------ | ------------ | ------- | -------- | ----------- | --------------- | ---------------------- | ------- | ---- | ---- |
| tools        | 0/8          | 0/8     | 0/48     | **0.191**   | —               | 2.02 / 3.06 / 1.86     | 0       | 0    | 1.07 |
| **eden**     | **7/8**      | 0/8     | 2/48 [1] | 0.243       | 0.0072          | **1.22 / 2.23 / 1.42** | 11      | 0.15 | 0.00 |
| eden+nokey   | 5/8          | 0/8     | 1/48 [0] | 0.234       | 0.0072          | 1.07 / 2.52 / 1.36     | 8       | 0.21 | 0.00 |
| eden~nonudge | 6/8          | 0/8     | 1/48 [0] | 0.230       | 0.0072          | 1.16 / 1.72 / 1.25     | 9       | 0.07 | 0.00 |

All-in over the run (the backfill spread over 32 tasks a user) adds $0.225/1k; over 1,000 tasks a user it adds
$0.007/1k. The backfill's 18 connector calls a user are booked to it, not to tasks.

### Secondary rows (eden only; `tools` from the short payload runs, same tasks, cross-run)

| push     | hidden            | control | neutral | steady $/1k | wall p50/p90/mean s | Eden ms | conn |
| -------- | ----------------- | ------- | ------- | ----------- | ------------------- | ------- | ---- |
| payload  | 47/64 (73.4%)     | 0/64    | 0/64    | 0.305       | 2.41 / 2.98 / 2.37  | 12      | 0.56 |
| refs     | 40/64 (62.5%)     | 0/64    | 0/64    | 0.244       | 2.40 / 3.19 / 2.31  | 76      | 2.73 |
| signals  | 41/64 (64.1%)     | 0/64    | 0/64    | 0.254       | 4.08 / 5.87 / 4.03  | 1,761   | 8.93 |

### Connector plans (`pi-cost-report.ts`, list prices, assumed), mix steady $/1k, eden − tools

| plan                        | short: tools | short: eden | short: eden − tools | long: tools | long: eden | long: eden − tools |
| --------------------------- | ------------ | ----------- | ------------------- | ----------- | ---------- | ------------------ |
| first-party (quota only)    | 0.218        | 0.305       | +0.087              | 0.191       | 0.243      | +0.052             |
| Composio (overage)          | 0.863        | 0.474       | −0.389              | see file    | see file   | −0.269             |
| Unified.to (Pro)            | 1.830        | 0.727       | −1.103              |             |            | −0.751             |
| Arcade.dev (Team)           | 21.703       | 5.930       | −15.773             |             |            | −10.656            |
| Pipedream Connect (overage) | 26.000       | 7.055       | −18.945             |             |            | −12.798            |
| Zapier MCP (10k tasks)      | 55.648       | 14.818      | −40.830             |             |            | −27.576            |

(Long per-plan levels are in `long-pay-cost.txt`. Short eden's 0.56 calls a task are background ticks booked to the
mix; on the long horizon Eden makes none in-run.)

## 3. Paired differences (bootstrap 95%, 5,000 draws; `*` the interval excludes zero)

Mix pairs from `arms.py` (billed $; wall mean). Hidden and concerns pooled over the four payload runs (`pooled.py`,
`concerns.py`, each run resampled on its own; n = 72 hidden, 184 control + neutral).

| horizon, push  | pair                        | hidden (points)             | $/1k mix                     | wall mean s, mix           | Eden path ms |
| -------------- | --------------------------- | --------------------------- | ---------------------------- | -------------------------- | ------------ |
| short, payload | eden − tools                | +68.8 (+56.2..+79.7)\*      | +0.087 (+0.067..+0.107)\*    | **−0.62 (−0.88..−0.35)\*** | +12          |
| short, payload | eden+nokey − tools          | +46.9 (+34.4..+59.4)\*      | +0.065 (+0.047..+0.082)\*    | −0.72 (−0.94..−0.50)\*     | +10          |
| short, payload | eden~nonudge − tools        | +56.2 (+42.2..+70.3)\*      | +0.056 (+0.035..+0.076)\*    | −0.81 (−1.09..−0.54)\*     | +11          |
| short, payload | eden+nokey − eden           | −21.9 (−34.4..−9.4)\*       | −0.022 (−0.044..+0.001)      | −0.10 (−0.24..+0.05)       | −3           |
| short, payload | eden~nonudge − eden         | −12.5 (−25.0..−1.6)\*       | −0.031 (−0.051..−0.012)\*    | −0.19 (−0.32..−0.06)\*     | −1           |
| long, payload  | eden − tools                | +87.5 (mix +0.088, +0.062..+0.100)\* | +0.059 (+0.031..+0.088)\* | **−0.45 (−0.69..−0.20)\*** | +11          |
| long, payload  | eden+nokey − tools          | (mix +0.062, +0.025..+0.088)\* | +0.050 (+0.015..+0.087)\* | −0.50 (−0.79..−0.22)\*     | +8           |
| long, payload  | eden~nonudge − tools        | (mix +0.075, +0.038..+0.100)\* | +0.024 (+0.002..+0.046)\* | −0.61 (−0.84..−0.38)\*     | +9           |
| short, refs    | eden − tools (cross-run)    | +59.4 (+46.9..+71.9)\*      | +0.026 (+0.003..+0.048)\*    | −0.68 (−0.93..−0.43)\*     | +76          |
| short, signals | eden − tools (cross-run)    | (mix +0.058, +0.044..+0.072)\* | +0.036 (+0.014..+0.059)\* | +1.04 (+0.77..+1.30)\*     | +1,761       |
| late, payload  | eden − tools, later replies | +43.8 (+18.8..+68.8)\*      | agent +0.059 (+0.026..+0.092)\* | hidden −0.56 (−1.02..−0.08)\* | +26       |

Short-horizon billed against cache-neutral (`pi-ab-report.ts`, all 192 tasks): eden − tools billed +0.061
(+0.043..+0.078), cache-neutral −0.009 (−0.035..+0.019); on the report's same-ask subset (tasks where `eden` made
no `ask_context` call, n 66), billed −0.040 (−0.060..−0.020). Long: billed +0.053 (+0.025..+0.081), cache-neutral +0.100 (−0.005..+0.214).

Pooled over the four payload runs:

| pair                 | hidden raised            | control + neutral concern, Haiku | regraded              |
| -------------------- | ------------------------ | -------------------------------- | --------------------- |
| **eden − tools**     | **+70.8 (+59.7..+81.9)** | +0.5 (−1.1..+2.7)                | +0.5 (0.0..+1.6)      |
| eden+nokey − tools   | +48.6 (+36.1..+61.1)     | 0.0 (−1.6..+1.6)                 | 0.0 (0..0)            |
| eden~nonudge − tools | +58.3 (+45.8..+70.8)     | +0.5 (−1.1..+2.2)                | 0.0 (0..0)            |
| eden+nokey − eden    | −22.2 (−34.7..−11.1)     |                                  |                       |
| eden~nonudge − eden  | −12.5 (−23.6..−1.4)      | 0.0 (−2.2..+2.2)                 | −0.5 (−1.6..0.0)      |

## 4. The rule, applied

1. Hidden, `eden − tools` pooled: **+70.8 (+59.7..+81.9)**, entirely above zero. **Beats.**
2. Regraded concerns, `eden − tools` pooled: **+0.5 (0.0..+1.6)**, not entirely above zero. **No worse.**
3. Cost, $/1k steady mix (billed, first-party): short **+0.087 (+0.067..+0.107)**, long **+0.059 (+0.031..+0.088)**:
   both entirely above zero. **Dearer on both horizons.**
4. Speed, wall mean mix: short **−0.62 (−0.88..−0.35)**, long **−0.45 (−0.69..−0.20)**. **Faster on both.**

**Outcome: not confirmed**, because of clause 3 alone. The default beats the agent alone on hidden facts, is no worse
on concerns and is faster, but its agent bill is higher than the agent alone's when the house rules are cached and
connector calls cost nothing. That is the condition A3 (D271) already found on train; heldout17 shows it blind. Under
every priced connector plan in `pi-cost-report.ts` the default is the cheaper arm on both horizons.

## 5. Concerns, regraded and read

`regrade.ts --only-concerns --graders claude-haiku-5-5,claude-sonnet-5-5` on every run (kept when both keep it; on a
disagreement Sonnet decides; `concerns.py`). The signals, refs and late runs had no concern to regrade.

| runs          | tools | eden    | eden+nokey | eden~nonudge |
| ------------- | ----- | ------- | ---------- | ------------ |
| short payload | 0 / 1 | 0 / 0   | 0 / 0      | 0 / 1        |
| long payload  | 0 / 0 | 0 / 2   | 0 / 1      | 0 / 1        |
| regraded      | 0 / 0 | 0 / 1   | 0 / 0      | 0 / 0        |

(control / neutral, Haiku-graded counts.) Read by hand: the one kept (`eden`, long 41,
`onboarding-call-vs-warden-course`, neutral) says the user's calendar has an unrelated meeting that morning and the
15:00 slot looks free, then drafts the invite. Nothing is planted on a neutral task; the answer names no false
conflict. I count it as a grader artefact, not a false concern. The five Sonnet dropped (one `tools`, two `eden~nonudge`, one
`eden`, one `eden+nokey`) mention real, unrelated world items or gaps (the date arithmetic, a nearby school trip, a
CRM deal stage, a missing budget): none names a planted fact. No control answer in any arm raised its decoy.

## 6. Against heldout16 (RealUse-3, cl-results.md)

| figure                           | heldout16 (no house rules) | heldout17 (`--tenant-prompt`) |
| -------------------------------- | -------------------------- | ----------------------------- |
| hidden, eden / tools, short      | 79.7% / 10.9%              | 73.4% / 4.7%                  |
| hidden, eden / tools, long       | 12/16 / 4/16               | 7/8 / 0/8                     |
| $/1k mix, eden / tools, short    | 0.378 / 0.357 (level)      | 0.305 / 0.218 (dearer)        |
| $/1k mix, eden / tools, long     | 0.352 / 0.391 (cheaper)    | 0.243 / 0.191 (dearer)        |
| wall mean s, eden / tools, short | 2.91 / 4.92 (−2.01)        | 2.37 / 2.99 (−0.62)           |
| wall mean s, eden / tools, long  | 2.56 / 3.49 (−0.93)        | 1.42 / 1.86 (−0.45)           |
| Eden ms on path, short / long    | 10 / 420                   | 12 / 11                       |
| regraded concerns, eden − tools  | 0.0                        | +0.5 (0.0..+1.6), by hand 0   |

Both arms are cheaper and faster today; the agent alone gains more. Eden's long-horizon path time fell from 420 ms
to 11 ms (consistent with removing the harness re-reads A3 named, D272; not separately measured here). Seeds 41–42 here against 41–44 there: heldout17's intervals are wider.

## 7. Hermes

Hermes Agent on heldout17, run by the coordinator (not pre-registered in section 0; same seeds, kinds and notices as
the Pi payload run; Haiku-graded, not regraded). Files: `packages/sim/lab/a29/hermes/`.

Run on the coordinator's machine, 2026-11-07 16:50–16:55 UTC, tree ed93f3365, `run.sh` here (Hermes Agent at
06433066f4, Haiku 5.5 in every role, Anthropic-direct lab provider, payload notices, direct profile, time scale 1,
seeds 41–42, 32 templates × hidden/control/neutral). Spend $0.288. Reports: `hermes-heldout17-report.txt`,
`hermes-heldout17-cost.txt`. Haiku-graded concerns (not regraded).

| | hermes (alone) | hermes-eden (Eden in place of its source tools) | hermes+eden (both) |
| --- | --- | --- | --- |
| Hidden raised | 4/64 (6.3%) | 45/64 (70.3%) | 41/64 (64.1%) |
| False concern: control / neutral | 0 / 0 | 0 / 0 | 1 / 2 of 64 |
| Wall p50, 1:1:8 mix | 4.23 s | 3.26 s | 4.56 s |
| Connector calls a task (agent + Eden) | 2.21 | 0.56 (+18 a user once) | 2.32 |
| $/1k tokens, mix steady | 0.334 | 0.501 | 0.470 |
| $/1k mix with Composio | 0.996 | 0.670 (0.839 with the backfill) | 1.165 |
| $/1k mix with Zapier MCP | 57.3 | 15.0 (29.5 with the backfill) | 60.2 |

- hermes-eden − hermes: hidden +64.1 points (+53.1..+76.6); wall −1.04 s hidden (−1.61..−0.52), −0.89 s neutral.
- Tokens: +$0.155/1k billed over all kinds (+0.128..+0.182), +$0.088 cache-neutral (+0.033..+0.144): Eden's packet is
  new input each task, mostly written to the cache (A27). On tasks where both arms asked the same, +$0.008 billed.
- With connectors priced per call, Eden in place of the tools is cheaper on every paid plan (Composio, Unified.to,
  Arcade, Pipedream, Zapier) and dearer only with first-party connectors (quota only).

On Hermes the same shape as on Pi: far more hidden facts and faster, dearer in tokens at first-party connector
prices (+$0.155/1k billed), cheaper with every priced connector plan. Eden in place of Hermes's own source tools is
the better arm (+6.3 hidden points over keeping both, 1.3 s faster on the mix, no concerns).

## 8. Reproduce

```bash
cat packages/sim/lab/cards/cards-v2.jsonl packages/sim/lab/cards/cards-train.jsonl \
  packages/sim/lab/cards/cards-train-4344.jsonl > .local/a29/cards-all.jsonl
L=packages/sim/lab/a29/run.sh; A=tools,eden,eden+nokey,eden~nonudge
LATE=partner-mailout-embargo,sleepover-vs-parents-evening,trainer-cancels-week,accountant-corrected-bill,early-flight-retimed,plumber-vs-water-off,council-tax-dd-set-up,birthday-drinks-moved
$L a29-short-pay-41 payload $A --seeds 41 --variants hidden,control,neutral --budget 1           # and 42
$L a29-long-pay-41 payload $A --seeds 41 --days 2 --day-size 16 --budget 0.6                     # and 42
$L a29-short-sig-41 signals eden --seeds 41 --variants hidden,control,neutral --budget 0.5       # and 42
$L a29-short-refs-41 refs eden --seeds 41 --variants hidden,control,neutral --budget 0.5         # and 42
$L a29-late-41 payload tools,eden --seeds 41 --variants hidden,control --day 4 --late --templates $LATE --budget 0.4
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/cold-start.ts --users user:41,user:42 --suite heldout17 \
  --days 2 --day-size 16 --spend-ledger .local/a29/ledger.jsonl --spend-cap 6 --spend-headroom 0.1 \
  --run-label a29-cold --out .local/a29/runs/cold-user.json
R=.local/a29/runs
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/regrade.ts --results $R/a29-short-pay-41.json \
  --graders claude-haiku-5-5,claude-sonnet-5-5 --only-concerns --spend-ledger .local/a29/ledger.jsonl \
  --spend-cap 6 --spend-headroom 0.1 --run-label a29-regrade-a29-short-pay-41 --out $R/a29-short-pay-41.regrade.json
bun packages/sim/src/lab/pi-ab-report.ts $R/a29-short-pay-4{1,2}.json                        # short-pay-report.txt
bun packages/sim/src/lab/pi-cost-report.ts $R/a29-long-pay-4{1,2}.json --lifetime $R/cold-user.json  # long-pay-cost.txt
python3 -I packages/sim/lab/cl7/arms.py --arms $A $R/a29-short-pay-4{1,2}                    # short-pay-arms.txt
python3 -I packages/sim/lab/cl7/arms.py --arms tools,eden $R/a29-short-pay-4{1,2}:tools $R/a29-short-refs-4{1,2}
python3 -I packages/sim/lab/a9/late.py eden tools $R/a29-late-4{1,2}                          # late.txt
python3 -I packages/sim/lab/cl4/pooled.py eden tools $R/a29-{short,long}-pay-4{1,2}           # pooled.txt
python3 -I packages/sim/lab/realuse-3/pi/concerns.py eden tools $R/a29-{short,long}-pay-4{1,2}  # concerns.txt
```

Summaries: `packages/sim/lab/a29/` (`*-report.txt`, `*-cost.txt`, `*-arms.txt`, `late*.txt`, `pooled.txt`,
`concerns.txt`, `cold-user.json`, `spend.txt`).

## Check

`bun run check`: format and typecheck pass; the test stage has 1 failure of 2,351, `packages/sources/src/regressions.test.ts`
("50,000 empty pages … under a 4 MB cache budget": 4.48 MB). It fails the same way on the base commit `ed93f336`
with this branch's changes stashed, and passes run alone (21 of 21): a heap bound sensitive to full-suite load, not
touched here.

## Caveats

- One blind suite, two seeds, Haiku as the agent; the long horizon is two days and rests on 8 hidden and 8 control
  tasks an arm (its hidden pair is a mix share, not a per-kind interval).
- Refs and signals pair against the payload runs' `tools` arm (cross-run, same tasks).
- The late row's 8 templates run as days of 4; `--templates` filters the tasks, not the world, so the other 24
  templates' items stay planted (a19-heldout17.md §2). No false alarm appeared.
- Cost is billed Anthropic-direct prices with prompt caching; the cache-neutral pair is reported beside it. The
  connector plan rows are list prices (assumed), and the agent's search calls are its only priced connector use.
