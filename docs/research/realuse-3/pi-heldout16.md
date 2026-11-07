# RealUse-3 on Pi: the CL wave's blind check on heldout16

Status: 2026-11-07, branch `claude/realuse3-pi` (from `claude/lucid-hypatia-v9wqk5` at `37b968513`). **Measurement
only: no engine file changed.** heldout16 was unrun before this session and is **read** after it. Every paid call went
to the Anthropic API with `HAIKU_API_KEY`, `claude-haiku-5-5` in every role (agent, grader, cards, intent, reader),
through the lab provider (D97), `OPENROUTER_API_KEY` unset, on one spend ledger (`.local/ru3/ledger.jsonl`, hard cap
$4); concern regrades also used `claude-sonnet-5-5`. **Anthropic-direct lab figures.** **Spent: $1.064.**

## Pre-registered rule (written and committed before any heldout16 result was read)

The final product keeps `pushCandidates` 5 unless, pooled over the short and long payload runs (seeds 41–44),
`eden − eden~reader` hidden raised has a 95% interval entirely below zero with a point estimate worse than −5 points,
or the regraded false + neutral concerns (`eden − eden~reader`, pooled over control and neutral tasks, paired by task)
rise with a 95% interval excluding zero. In either case the recommendation is to revert to `pushCandidates` 0. The
rule is applied mechanically.

Arms: `tools` (the agent alone with its source tools), `eden` (the default: candidates, D237), `eden~reader`
(`pushCandidates` 0: the reader's push with D240's stop-early). Long mode: `--days 2 --day-size 16` (heldout16 holds
32 templates and pi-user draws each once per user: 4 hidden, 4 control, 24 neutral a user).

## In plain words

- **Does Eden now cost less than the agent alone?** Over a user's days, yes: on the assumed 1:1:8 traffic the agent
  with Eden costs **$0.352 per 1,000 tasks against $0.391** for the agent with its own search tools (paired
  −$0.049, 95% −0.069..−0.029). One request per session it is **level**: $0.378 against $0.357 with payload notices
  (paired +$0.021, −0.000..+0.043) and $0.344 against $0.363 with signal notices (−$0.020, −0.051..+0.011; tools
  from the payload runs). Eden itself makes no model call per task any more; what it costs now is the agent reading
  five candidate excerpts (about +$0.02/1k on the short horizon) and, long, its background cards ($0.021/1k).
- **How much faster?** With payload notices the agent answers **2.0 s sooner a request** one request per session
  (wall mean 2.91 s against 4.92 s, paired −2.01 s, −2.26..−1.75; p50 2.90 against 4.84) and **0.93 s sooner** over a
  user's days (2.56 against 3.49 s; −1.12..−0.74). Eden's time on the agent's path is about 10 ms a task (short,
  payload) and 420 ms (long). With signal notices it is 0.44 s faster (−0.84..−0.03): each candidate set is
  re-checked at the sources (about 9 connector calls a task), which puts Eden at 1.6 s on the path.
- **Hidden facts.** Eden raises the hidden fact in **80% of hidden tasks (102/128) one request per session and 12 of 16
  over days**, against 11% (14/128) and 4 of 16 for the agent alone (pooled +66.7 points, +58.3..+74.3). The previous
  default (the reader, `eden~reader`) raised 108/128 and 13/16: candidates are **−4.9 points pooled (−11.1..+1.4)**,
  not a significant loss, the same size as CL6 measured on train (−4.8, −10.8..+1.2).
- **Concerns.** Haiku graded 25 control and neutral answers as concerns in the payload runs (eden 11, eden~reader 8,
  tools 6 of 368 each). Regraded (Haiku again, Sonnet on the disputed ones) and read by hand, **one** survived, in
  `eden~reader` (a generic "check he is insured" hedge, which the other two arms also wrote without being flagged).
  No `eden` answer on a look-alike or nothing-to-add task named a planted fact.
- **The pre-registered rule: keep `pushCandidates` 5.** Neither condition fires (§4). Applied mechanically.

## 1. Runs

Pi (`@earendil-works/pi-agent-core`), `--config default`, `--suite heldout16`, market `direct` profile, time scale 1,
default wait, cards replayed from `cards-v2` + `cards-train` + `cards-train-4344` (as CL5 and CL7 build
`cards-all.jsonl`; heldout16's cards are in `cards-v2`), intent replayed (1,529–1,541 of 1,539–1,544 items). One seed
per process, at most three at once: **0 Anthropic 429 retries in every run**, 0 errors, 0 ungraded.
`packages/sim/lab/realuse-3/pi/run.sh LABEL PUSH ARMS [flags]`.

| run                    | push    | arms                                       | seeds  | tasks an arm                                  | $     |
| ---------------------- | ------- | ------------------------------------------ | ------ | --------------------------------------------- | ----- |
| `ru3-short-pay-41..44` | payload | tools, eden, eden~reader                   | 41–44  | 96 a seed (32 hidden, 32 control, 32 neutral) | 0.587 |
| `ru3-long-pay-41..44`  | payload | tools, eden, eden~reader                   | 41–44  | 32 a user: `--days 2 --day-size 16` (4/4/24)  | 0.202 |
| `ru3-short-sig-41,42`  | signals | eden, eden~reader                          | 41, 42 | 96 a seed                                     | 0.202 |
| `ru3-cold`             |         | cold start, user:41–44 (heldout16, 2 × 16) |        |                                               | 0.026 |
| `ru3-regrade-*`        |         | Haiku + Sonnet regrade of concerns only    |        |                                               | 0.048 |

**Long mode.** pi-user draws each template once per user, and heldout16 holds 32 templates, so a user can have at most
32 requests: `--days 2 --day-size 16` uses all of them (days of 16, `dayKinds` gives 2 hidden, 2 control, 12 neutral a
day), 0 slot clashes. This is a shorter long horizon than CL5–CL7's eight days on train (two days, 128 tasks an arm
over four users); its hidden and control rates rest on 16 tasks an arm. The one-time backfill is the measured cold
start of the same user shape (`cold-start.ts --suite heldout16 --days 2 --day-size 16`): $0.0065 a user (7 card calls).

**Signals runs** have no `tools` arm of their own (the push mode reaches only Eden's partner, as CL7 notes): their
`eden − tools` pairs use the payload runs' `tools` arm for seeds 41–42 (same tasks, paired by task id, not run at the
same moment).

## 2. Results (1:1:8 mix, assumed traffic)

Cost: $ per 1,000 tasks, steady state = agent + Eden per task + background while working, weighted 1:1:8
(`pi-cost-report.ts`; split from `arms.py`'s mix columns). One-time: per user. All-in over the run spreads it over
the user's tasks in the run. Wall: p50/p90 pooled over the mix (`pi-ab-report.ts`), mean weighted (`arms.py`). Eden
path: union of the observe and every `ask_context` on the critical path, ms a task, mix-weighted. Calls a task (mix):
`ask_context`, reader, connector (the agent's search tools + Eden's source calls). Concerns: Haiku-graded [regraded].

### Short horizon (one request per session), payload notices, seeds 41–44

| arm         | hidden              | control   | neutral   | agent | Eden  | bg    | one-time   | steady = all-in | wall p50/p90/mean s    | Eden ms | asks | reader | conn |
| ----------- | ------------------- | --------- | --------- | ----- | ----- | ----- | ---------- | --------------- | ---------------------- | ------- | ---- | ------ | ---- |
| tools       | 14/128 (10.9%)      | 0/128     | 3/128 [0] | 0.357 | —     | —     | —          | 0.357           | 4.84 / 7.12 / 4.92     | 0       | 0    | 0      | 3.29 |
| **eden**    | **102/128 (79.7%)** | 0/128     | 4/128 [0] | 0.378 | 0.000 | 0.000 | 0 (in-run) | **0.378**       | **2.90 / 4.02 / 2.91** | 10      | 0.77 | 0      | 0.61 |
| eden~reader | 108/128 (84.4%)     | 3/128 [0] | 3/128 [0] | 0.365 | 0.235 | 0.000 | 0 (in-run) | 0.600           | 4.50 / 5.97 / 4.45     | 1,145   | 1.25 | 1.12   | 0.61 |

(No live card was made in these runs: every item was in the replay, so the in-run one-time is $0.)

### Long horizon (two days of 16 a user, Eden kept, the agent's transcript reset daily), payload notices, users 41–44

| arm         | hidden    | control | neutral  | agent | Eden  | bg    | one-time $/user | steady    | all-in (run) | wall p50/p90/mean s    | Eden ms | asks | reader | conn |
| ----------- | --------- | ------- | -------- | ----- | ----- | ----- | --------------- | --------- | ------------ | ---------------------- | ------- | ---- | ------ | ---- |
| tools       | 4/16      | 0/16    | 3/96 [0] | 0.391 | —     | —     | —               | 0.391     | 0.391        | 3.59 / 4.78 / 3.49     | 0       | 0    | 0      | 2.60 |
| **eden**    | **12/16** | 0/16    | 7/96 [0] | 0.332 | 0.000 | 0.021 | 0.0065          | **0.352** | 0.554        | **2.45 / 3.38 / 2.56** | 420     | 0.07 | 0      | 1.07 |
| eden~reader | 13/16     | 0/16    | 2/96 [1] | 0.295 | 0.216 | 0.000 | 0.0065          | 0.510     | 0.712        | 3.06 / 5.31 / 3.50     | 1,316   | 0.40 | 1.01   | 0.97 |

All-in over the run spreads the cold start over 32 tasks a user (+$0.20/1k); over a lifetime of 1,000 tasks it adds
$0.0065/1k, so the steady state is the figure the CL goal is about.

### Short horizon, signal notices, seeds 41–42

| arm                        | hidden            | control  | neutral  | agent | Eden  | steady    | wall p50/p90/mean s | Eden ms | asks | reader | conn |
| -------------------------- | ----------------- | -------- | -------- | ----- | ----- | --------- | ------------------- | ------- | ---- | ------ | ---- |
| tools (payload runs 41–42) | 8/64              | 0/64     | 1/64     | 0.363 | —     | 0.363     | — / — / 5.04        | 0       | 0    | 0      | 3.43 |
| **eden**                   | **53/64 (82.8%)** | 1/64 [1] | 2/64 [0] | 0.344 | 0.000 | **0.344** | 4.35 / 6.92 / 4.60  | 1,587   | 0.82 | 0      | 9.05 |
| eden~reader                | 49/64 (76.6%)     | 0/64     | 3/64 [0] | 0.358 | 0.238 | 0.595     | 5.82 / 7.58 / 5.71  | 2,365   | 1.30 | 1.13   | 8.63 |

Agent at fixed Haiku prices (cache-neutral, `pi-ab-report.ts`): short payload tools 0.532, eden 0.389, eden~reader
0.388; long tools 1.306, eden 0.891, eden~reader 0.882. Billed, the tools agent gains most from prompt caching; at
fixed prices the agent with Eden is cheaper on both horizons. Reader calls (eden~reader): p50 906 ms, p90 1,589
(short); p50 857, p90 1,553 (long). Uptake (short payload, hidden): when the planted item was in a packet the agent
raised it 92.5% (eden, n 93) and 94.9% (eden~reader, n 99) of the time; tasks with no packet or ask carrying it: 0%.

## 3. Paired differences (bootstrap 95%, 5,000 draws; `*` the interval excludes zero)

Mix pairs from `arms.py` ($/1k there = agent + Eden per task + the run's background spread over its Eden task runs).
Hidden is the pooled pair over the runs named (`pooled.py`, each run resampled on its own).

| horizon, push  | pair                           | hidden (points)                          | $/1k mix                      | wall mean s, mix           | Eden path ms |
| -------------- | ------------------------------ | ---------------------------------------- | ----------------------------- | -------------------------- | ------------ |
| short, payload | eden − tools                   | +68.8 (+60.2..+77.3)\*                   | +0.021 (−0.000..+0.043)       | **−2.01 (−2.26..−1.75)\*** | +10          |
| short, payload | eden~reader − tools            | +73.4 (+65.6..+81.2)\*                   | +0.243 (+0.218..+0.268)\*     | −0.47 (−0.73..−0.19)\*     | +1,145       |
| short, payload | eden − eden~reader             | −4.7 (−10.9..+1.6)                       | **−0.222 (−0.247..−0.198)\*** | **−1.54 (−1.73..−1.35)\*** | −1,136       |
| long, payload  | eden − tools                   | +50.0 (+18.8..+75.0)\*                   | **−0.049 (−0.069..−0.029)\*** | **−0.93 (−1.12..−0.74)\*** | +420         |
| long, payload  | eden~reader − tools            | +56.2 (+25.0..+87.5)\*                   | +0.129 (+0.098..+0.160)\*     | +0.01 (−0.23..+0.27)       | +1,316       |
| long, payload  | eden − eden~reader             | −6.2 (−25.0..+12.5)                      | **−0.179 (−0.207..−0.149)\*** | **−0.94 (−1.17..−0.72)\*** | −896         |
| short, signals | eden − tools (tools cross-run) | +70 (mix share +0.070, +0.059..+0.081)\* | −0.020 (−0.051..+0.011)       | −0.44 (−0.84..−0.03)\*     | +1,587       |
| short, signals | eden~reader − tools            | (mix share +0.064, +0.052..+0.077)\*     | +0.232 (+0.195..+0.270)\*     | +0.67 (+0.24..+1.10)\*     | +2,365       |
| short, signals | eden − eden~reader             | +6.2 (−3.1..+17.2)                       | **−0.252 (−0.291..−0.212)\*** | **−1.11 (−1.55..−0.67)\*** | −777         |

Pooled over all eight payload runs (n = 144 hidden, 368 control + neutral):

| pair                   | hidden raised            | control + neutral concern, Haiku | regraded             |
| ---------------------- | ------------------------ | -------------------------------- | -------------------- |
| eden − tools           | **+66.7 (+58.3..+74.3)** | +1.4 (−0.8..+3.5)                | 0.0 (0..0)           |
| eden~reader − tools    | **+71.5 (+63.9..+78.5)** | +0.5 (−1.4..+2.5)                | +0.3 (0.0..+0.8)     |
| **eden − eden~reader** | **−4.9 (−11.1..+1.4)**   | +0.8 (−1.4..+3.3)                | **−0.3 (−0.8..0.0)** |

With the two signals runs added (not part of the rule): hidden eden − eden~reader −1.4 (−6.7..+3.8), n = 208;
regraded concerns 0.0 (−0.6..+0.6), n = 496.

## 4. The rule, applied

1. Hidden raised, `eden − eden~reader`, pooled short + long payload: **−4.9 points (−11.1..+1.4)**. The interval is
   not entirely below zero, and −4.9 is not worse than −5. **Does not fire.**
2. Regraded false + neutral concerns, `eden − eden~reader`, pooled: **−0.3 points (−0.8..0.0)**. No rise. **Does not
   fire.**

**Outcome: keep `pushCandidates` 5** (D237 stands). The hidden point estimate sits 0.1 point inside the rule's −5
threshold; the rule needs both the interval below zero and the point worse than −5, and the interval crosses zero.

## 5. Concerns, regraded and read

`regrade.ts --only-concerns --graders claude-haiku-5-5,claude-sonnet-5-5` on every run (a concern is kept when both
regraders keep it; where they disagree, Sonnet's verdict counts; `concerns.py`), then every answer read.

| runs          | arm                        | Haiku-graded control / neutral | regraded control / neutral |
| ------------- | -------------------------- | ------------------------------ | -------------------------- |
| short payload | tools / eden / eden~reader | 0 / 3, 0 / 4, 3 / 3            | 0 / 0, 0 / 0, 0 / 0        |
| long payload  | tools / eden / eden~reader | 0 / 3, 0 / 7, 0 / 2            | 0 / 0, 0 / 0, 0 / 1        |
| short signals | eden / eden~reader         | 1 / 2, 0 / 3                   | 1 / 0, 0 / 0               |

Read by hand:

- **Nothing-to-add (neutral) answers:** none names the planted fact (it is not in the world). Haiku flagged answers
  that mention the request's date, say nothing was found, or give generic advice ("check eligibility", "confirm
  your ISA allowance", "check he is insured"). The one the regrade kept (`eden~reader`, `named-driver-only`, long 42)
  is that generic insurance hedge; the `tools` and `eden` answers to the same request said the same thing and were
  not flagged. I count it as a grader artefact, not a false concern.
- **Look-alike (control) answers:** `rail-fare-on-company-account` is the one template where agents raise the decoy:
  `eden~reader` twice (short payload 41 and 44) and `eden` once (signals 42, which Sonnet kept). Each cites the
  #travel message, says it was addressed to someone else and may not be this ticket, and asks to check before filing:
  a hedged false concern. `reviewer-on-parental-leave` (`eden~reader`, short 44) used the look-alike correctly (the
  colleague is back) and is not a concern. By hand: eden 1 hedged (signals), eden~reader 2 hedged (payload), tools 0.

## 6. Reproduce

```bash
cat packages/sim/lab/cards/cards-v2.jsonl packages/sim/lab/cards/cards-train.jsonl \
  packages/sim/lab/cards/cards-train-4344.jsonl > .local/ru3/cards-all.jsonl
L=packages/sim/lab/realuse-3/pi/run.sh; A=tools,eden,eden~reader
$L ru3-short-pay-41 payload $A --seeds 41 --variants hidden,control,neutral --budget 0.5     # and 42, 43, 44
$L ru3-long-pay-41 payload $A --seeds 41 --days 2 --day-size 16 --budget 0.4                # and 42, 43, 44
$L ru3-short-sig-41 signals eden,eden~reader --seeds 41 --variants hidden,control,neutral --budget 0.5   # and 42
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/cold-start.ts --users user:41,user:42,user:43,user:44 \
  --suite heldout16 --days 2 --day-size 16 --spend-ledger .local/ru3/ledger.jsonl --spend-cap 4 \
  --spend-headroom 0.1 --run-label ru3-cold --out .local/ru3/runs/cold-user.json
R=.local/ru3/runs; P=packages/sim/lab/realuse-3/pi
bun packages/sim/src/lab/pi-cost-report.ts $R/ru3-long-pay-4{1,2,3,4}.json --lifetime $R/cold-user.json   # *-cost.txt
bun packages/sim/src/lab/pi-ab-report.ts $R/ru3-short-pay-4{1,2,3,4}.json                                 # *-report.txt
python3 -I packages/sim/lab/cl7/arms.py --arms $A $R/ru3-short-pay-4{1,2,3,4}                              # *-arms.txt
python3 -I packages/sim/lab/cl7/arms.py --arms $A $R/ru3-short-pay-4{1,2}:tools $R/ru3-short-sig-4{1,2}
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/regrade.ts --results $R/ru3-short-pay-41.json \
  --graders claude-haiku-5-5,claude-sonnet-5-5 --only-concerns --spend-ledger .local/ru3/ledger.jsonl \
  --spend-cap 4 --spend-headroom 0.1 --run-label ru3-regrade-short-pay-41 --out $R/ru3-short-pay-41.regrade.json
python3 -I packages/sim/lab/cl4/pooled.py eden eden~reader $R/ru3-{short,long}-pay-4{1,2,3,4}             # pooled.txt
python3 -I $P/concerns.py eden eden~reader $R/ru3-{short,long}-pay-4{1,2,3,4}                             # concerns.txt
```

Summaries and report texts: `packages/sim/lab/realuse-3/pi/` (`*-cost.txt`, `*-report.txt`, `*-arms.txt`,
`pooled*.txt`, `concerns*.txt`, `cold-user.json`, `spend.txt`).

## Spend (`spend.txt`, ledger `.local/ru3/ledger.jsonl`)

| What                                | $         |
| ----------------------------------- | --------- |
| short, payload (3 arms, 4 seeds)    | 0.587     |
| long, payload (3 arms, 4 users)     | 0.202     |
| short, signals (2 arms, 2 seeds)    | 0.202     |
| cold starts (4 users)               | 0.026     |
| Haiku + Sonnet regrades of concerns | 0.048     |
| **Total**                           | **1.064** |

## Caveats

- One blind suite, Haiku as the agent: a different agent model may judge candidates differently (CL6's caveat).
- The long horizon is two days, not eight (heldout16's 32 templates bound a user), and rests on 16 hidden and 16
  control tasks an arm; its hidden pairs are wide.
- Signals `eden − tools` pairs use the payload runs' `tools` arm (cross-run).
- regrade.ts's printed agreement between graders matches answers by task only (not task and condition); this note
  uses `concerns.py`, which matches by both.
