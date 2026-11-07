# CL7: the "nothing found" note (`pushChecked`) decided on the current default, and the CL reference runs

Status: 2026-11-07, branch `claude/cl7-combine` (from `claude/lucid-hypatia-v9wqk5` at `dd11693cd`: the default with
D240 `readerStopEarly` and D244 `cardsLeanDays` 7). Decision D257. Every paid call went to the Anthropic API with
`HAIKU_API_KEY`, `claude-haiku-5-5` in every role (agent, grader, cards, intent, reader), through the lab provider
(D97), `OPENROUTER_API_KEY` unset, on one spend ledger (`.local/cl7/ledger.jsonl`) with a hard cap of $3; concern
regrades used `claude-sonnet-5-5`. **Anthropic-direct lab figures.** **Spent: $2.457.**

## In plain words

- **`pushChecked` is deleted (D257).** When the push's reading found nothing for a request, the trial told the agent
  "Eden read your sources; nothing bears on this". The agent then asked Eden less often, which saved money and time
  where asking is slow, but it also stopped asking in the cases where the push had missed the fact and the ask would
  have found it. Pooled over all eight paired runs, **hidden facts raised fell 5.1 points (95% −9.1..−1.2)**, so the
  trial fails D112's bar (no significant hidden loss). Not all of that is the note: hidden tasks the note never
  reached drifted −4.2 points between arms that treated them alike (the runs' sampling noise), while tasks that got
  the note lost 8 of 99 (−8.1 points, not significant alone). The note's own cost is about 2 points of all hidden
  tasks; it was not shown neutral, and its mechanism (fewer asks) is real.
- **What it saved.** With change signals (`--push signals`, where each ask re-reads items and takes about 1 s):
  about $0.03 per 1,000 tasks and 0.3–0.5 s a task on the assumed 1:1:8 traffic, both significant, short and long.
  With payload notices (D210's integration default, where the ask is already fast): nothing significant one request
  per session, $0.02 per 1,000 and 0.18 s over a user's eight days.
- **False concerns did not decide it.** Haiku graded 19 concerns for the default and 6 for the note; Sonnet's regrade
  kept 4 and 0, out of about 1,200 control and neutral tasks an arm. Too few to weigh against the hidden loss.
- **The current default against the agent alone** (these runs are the CL wave's reference for it): Eden raises the
  hidden fact in 65–75% of hidden tasks against 4–16% for the agent with its own tools, and costs $0.17–0.22 more
  per 1,000 tasks on the 1:1:8 mix (agent + Eden per task + the run's background cards). One request per session it
  is not slower (wall −0.5..−0.7 s, intervals across zero); over a user's days it is 0.4 s (payload) to 0.8 s
  (signals) slower a task. Steady state per 1,000 tasks on the mix: short $0.597 (payload) and $0.580 (signals) against
  $0.383; long $0.470 and $0.515 against $0.301.
- **Found, not fixed:** the shipped per-session cap of 20 reader calls (`DEFAULT_LIMITS.callsPerSession`) refused 10
  reader calls on one long-horizon user's 17–19-request day: with one Eden session per day (the integration shape
  CL5's long mode models), a busy day runs out of reader calls and its later requests get the no-model path.
- **Lab fix:** `cold-start.ts` now writes the user shape `pi-cost-report.ts --lifetime` checks (CL5's review added the
  check; the script never wrote it, so every new cold start was refused).

## 1. Runs

All Pi (`@earendil-works/pi-agent-core`), `--config default`, train1–6, the market `direct` profile, time scale 1,
default wait, cards replayed from `cards-v2` + `cards-train` + `cards-train-4344` (as CL5), intent replayed (D158),
one process per seed (`packages/sim/lab/cl7/run.sh LABEL PUSH ARMS ...`). Short: `--variants hidden,control,neutral
--limit 16` (CL5's shape: 288 tasks a seed and arm, n = 192 a kind). Long: `--days 8` (one user a seed, 116 and 118
requests, 12/12/90 and 11/11/96 hidden/control/neutral). Arms: `tools`, `eden`, `eden+pushChecked`.

| run | push | arms | seeds | $ | notes |
| --- | --- | --- | --- | --- | --- |
| `cl7-short-pay-41/42` | payload | tools, eden, eden+pushChecked | 41, 42 | 1.018 | 8 errors, 1 ungraded of 1,728; four processes at once: 330 and 46 Anthropic 429 retries |
| `cl7-short-sig-41/42` | signals | eden, eden+pushChecked | 41, 42 | 0.725 | 0 errors |
| `cl7-long-pay-41/42` | payload | tools, eden, eden+pushChecked | 41, 42 | 0.357 | 0 errors |
| `cl7-long-sig-41/42` | signals | eden, eden+pushChecked | 41, 42 | 0.287 | 10 reader calls refused by the per-session cap (seed 42, §5) |
| `cl7-cold`, `cl7-cold2` | | cold start, user:41 and user:42 | | 0.029 | the second after the user-shape fix: $0.0075 a user |
| `cl7-regrade-*` | | Sonnet regrade of concerns only | | 0.041 | |

**The signals runs have no `tools` arm of their own.** The push mode reaches only Eden's partner
(`connector-options.ts`, `pushNotifier` returns before any call without a partner), so the payload runs' `tools`
answers stand for both (same tasks and worlds, paired by task id; `arms.py STEM:tools`). Pairing is valid; the two
arms were not run at the same moment.

**Latency caveat.** The short payload runs shared the API with three other processes; Anthropic's 429s were retried
(330 in seed 41), which inflates means and tails (reader mean 1,887 ms against p50 925). Use p50 and the paired
differences (both arms of a task ran together, so both saw the same congestion).

## 2. Results on the 1:1:8 mix (assumed traffic)

Rates: hidden raised (graded by Haiku); false concerns on look-alikes (control) and any concern on nothing-to-add tasks
(neutral), Haiku-graded, with Sonnet's regrade (confirmed) in brackets. Cost from `pi-cost-report.ts`, $ per 1,000
tasks: agent and Eden per task, Eden's background while working (bg), one-time backfill per user, steady state (agent
+ Eden + bg) and all-in (steady + one-time spread over the user's tasks in the run), both weighted 1:1:8. One-time:
short, the run's own backfill (cards made live, in-run); long, the measured cold start (`cold-user.json`, $0.0075 a
user, D244's lean window). Wall: p50/p90 pooled over the mix (`pi-ab-report.ts`), mean weighted (`arms.py`). Eden
path: the union of the observe and every `ask_context` on the critical path, ms a task. Calls a task: the agent's
`ask_context`, Eden's reader, connector calls (the agent's search tools plus Eden's source calls).

### Short horizon (one request per session)

| push | arm | hidden | control | neutral | agent | Eden | bg | one-time $/user | steady | all-in | wall p50/p90/mean s | Eden ms | asks | reader | conn |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| — | tools | 31/191 (16.2%) | 1/191 [0] | 0/190 | 0.383 | — | — | — | 0.383 | 0.383 | 5.56 / 8.96 / 6.55 | 0 | 0 | 0 | 3.56 |
| payload | eden | 144/191 (75.4%) | 1/192 [0] | 1/189 [0] | 0.351 | 0.237 | 0.000 | 0.0023 | 0.597 | 0.605 | 4.67 / 7.25 / 5.89 | 1,177 | 1.30 | 1.02 | 0.00 |
| payload | eden+pushChecked | 138/192 (71.9%) | 1/191 [0] | 0/192 | 0.340 | 0.237 | 0.000 | 0.0015 | 0.587 | 0.592 | 4.59 / 7.68 / 6.08 | 1,193 | 1.16 | 1.09 | 0.00 |
| signals | eden | 141/192 (73.4%) | 4/192 [0] | 4/192 [1] | 0.329 | 0.238 | 0.000 | 0.0023 | 0.580 | 0.588 | 6.14 / 8.15 / 6.03 | 2,372 | 1.31 | 1.05 | 7.72 |
| signals | eden+pushChecked | 127/192 (66.1%) | 0/192 | 1/192 [0] | 0.304 | 0.232 | 0.000 | 0.0015 | 0.548 | 0.553 | 5.47 / 8.30 / 5.52 | 2,102 | 1.07 | 1.04 | 7.05 |

(The agent and Eden columns are plain means over the arm's tasks; steady and all-in are the 1:1:8 weighting, as
`pi-cost-report.ts` prints them. With payload notices Eden made no connector calls: nothing put a copy in doubt.)

### Long horizon (`--days 8`: one user a seed, eight days of 12–20 requests, Eden kept, the agent's transcript reset daily)

| push | arm | hidden | control | neutral | agent | Eden | bg | one-time $/user | steady | all-in | wall p50/p90/mean s | Eden ms | asks | reader | conn |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| — | tools | 1/23 (4.3%) | 0/23 | 3/186 [1] | 0.301 | — | — | — | 0.301 | 0.301 | 1.83 / 4.94 / 2.71 | 0 | 0 | 0 | 1.51 |
| payload | eden | 16/23 (69.6%) | 0/23 | 2/186 [0] | 0.263 | 0.200 | 0.006 | 0.0075 | 0.470 | 0.534 | 2.69 / 5.05 / 3.09 | 1,077 | 0.21 | 0.89 | 1.13 |
| payload | eden+pushChecked | 14/23 (60.9%) | 0/23 | 0/186 | 0.253 | 0.189 | 0.013 | 0.0075 | 0.455 | 0.519 | 2.66 / 4.53 / 2.91 | 975 | 0.12 | 0.84 | 0.96 |
| signals | eden | 15/23 (65.2%) | 1/23 [1] | 6/186 [2] | 0.298 | 0.213 | 0.003 | 0.0075 | 0.515 | 0.579 | 2.89 / 5.88 / 3.49 | 1,319 | 0.33 | 0.95 | 4.94 |
| signals | eden+pushChecked | 15/23 (65.2%) | 1/23 [0] | 3/186 [0] | 0.284 | 0.205 | 0.016 | 0.0075 | 0.504 | 0.568 | 2.88 / 5.36 / 3.22 | 1,109 | 0.22 | 0.90 | 4.52 |

All-in over the run spreads the cold start over 116–118 tasks (+$0.064/1k); over a user's lifetime of 1,000 tasks it
would add $0.0075/1k, so the steady state is the figure the CL goal is about. Recap probes (not tasks): $0.008–0.010
an arm.

### Paired differences on the mix (bootstrap 95%, 5,000 draws, each kind resampled on its own, paired by task)

`arms.py` ($/1k here = agent + Eden per task + the run's background cards spread over its Eden task runs; it is not
the cost report's steady state). `*` the interval excludes zero.

| horizon, push | pair | raised (share of all tasks) | hidden rate | wrong (Haiku) | $/1k | wall mean s | Eden path ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| short, payload | pushChecked − eden | −0.003 (−0.009..+0.003) | −0.032 (−0.089..+0.026) | −0.004 (−0.013..+0.000) | −0.008 (−0.029..+0.012) | +0.19 (−0.44..+0.85) | +17 (−82..+117) |
| short, signals | pushChecked − eden | **−0.007 (−0.014..−0.001)\*** | **−0.073 (−0.136..−0.010)\*** | −0.015 (−0.031..−0.002)\* | **−0.031 (−0.053..−0.011)\*** | **−0.50 (−0.75..−0.27)\*** | −270 (−396..−141)\* |
| long, payload | pushChecked − eden | −0.009 (−0.026..+0.009) | −0.087 (−0.261..+0.087) | −0.009 (−0.022..+0.000) | **−0.021 (−0.041..−0.001)\*** | **−0.18 (−0.34..−0.01)\*** | −102 (−196..−10)\* |
| long, signals | pushChecked − eden | +0.000 | +0.000 (all 23 pairs agree) | −0.013 (−0.043..+0.013) | **−0.024 (−0.042..−0.004)\*** | **−0.27 (−0.44..−0.11)\*** | −210 (−320..−101)\* |
| short, payload | eden − tools | +0.059 (+0.051..+0.067)\* | +0.589 (+0.511..+0.668)\* | +0.004 (−0.001..+0.014) | +0.220 (+0.197..+0.242)\* | −0.66 (−1.59..+0.31) | +1,177 |
| short, signals | eden − tools | +0.057 (+0.049..+0.064)\* | +0.571 (+0.497..+0.644)\* | +0.018 (+0.005..+0.036)\* | +0.203 (+0.181..+0.227)\* | −0.52 (−1.25..+0.14) | +2,372 |
| long, payload | eden − tools | +0.065 (+0.043..+0.083)\* | +0.652 (+0.435..+0.826)\* | −0.004 (−0.022..+0.013) | +0.174 (+0.150..+0.197)\* | +0.38 (+0.17..+0.59)\* | +1,077 |
| long, signals | eden − tools | +0.061 (+0.039..+0.078)\* | +0.609 (+0.391..+0.826)\* | +0.017 (−0.004..+0.043) | +0.222 (+0.197..+0.247)\* | +0.78 (+0.58..+0.99)\* | +1,319 |
| short, payload | pushChecked − tools | +0.056 (+0.048..+0.063)\* | +0.558 (+0.479..+0.637)\* | +0.000 (−0.002..+0.002) | +0.211 (+0.186..+0.236)\* | −0.47 (−1.58..+0.75) | +1,193 |
| short, signals | pushChecked − tools | +0.050 (+0.042..+0.058)\* | +0.497 (+0.419..+0.576)\* | +0.004 (−0.002..+0.013) | +0.172 (+0.148..+0.197)\* | −1.02 (−1.74..−0.36)\* | +2,102 |
| long, payload | pushChecked − tools | +0.057 (+0.035..+0.078)\* | +0.565 (+0.348..+0.783)\* | −0.013 (−0.030..+0.000) | +0.152 (+0.125..+0.180)\* | +0.20 (−0.03..+0.43) | +975 |
| long, signals | pushChecked − tools | +0.061 (+0.043..+0.083)\* | +0.609 (+0.391..+0.783)\* | +0.004 (−0.017..+0.026) | +0.198 (+0.170..+0.226)\* | +0.51 (+0.30..+0.74)\* | +1,109 |

The "wrong" column is Haiku's grading; §3 regrades it. Per kind (in `*-arms.txt`): signals short, pushChecked cut
neutral wall −0.54 s (−0.83..−0.26) and control −0.45 s (−0.74..−0.18); long, neutral −0.22..−0.24 s in both push
modes. Per-kind cost pairs from `pi-ab-report.ts` agree in sign (`*-report.txt`).

## 3. Hidden facts and concerns, pooled and regraded

**Pooled hidden** (`packages/sim/lab/cl4/pooled.py`, paired by task, each run resampled on its own; `pooled.txt`):

| pair, 8 runs | n | difference (95%) |
| --- | --- | --- |
| pushChecked − eden, hidden raised | 429 | **−0.051 (−0.091..−0.012)** |
| pushChecked − eden, control concern (Haiku) | 429 | −0.009 (−0.021..+0.000) |
| pushChecked − eden, neutral concern (Haiku) | 753 | −0.012 (−0.023..−0.003) |

The six runs without the long signals pair gave −0.054 (−0.096..−0.012). CL4's three runs of the switch alone pooled
to −0.005 (−0.064..+0.053), n = 188, on the default before D240 and D244.

**Where the loss is** (`notes.py`, `notes.txt`; hidden tasks split by whether the pushChecked arm handed out the note,
an injection citing no item):

| hidden tasks | n | eden raised | pushChecked raised |
| --- | --- | --- | --- |
| the note handed out | 99 | 64 | 56 |
| no note | 330 | 252 | 238 |

Where the note went out, the push's reading had flagged nothing, so the default's agent found the fact (when it did)
through `ask_context`; with the note it asked less (short signals, hidden asks a task 0.52 → 0.43; payload 0.56 →
0.51) and raised it 8 fewer times (−8.1 points). Tasks without a note lost too (−4.2 points); in the short horizon the
note cannot reach them (one request a session), so that part is the reader's and agent's sampling (each arm reads
anew: packets carrying the planted item 141 → 134 short payload, 136 → 131 short signals). The note group's loss is
the mechanism the trial risks; the pooled interval is what D112 reads.

**Concerns regraded** (`regrade.ts --only-concerns --graders claude-sonnet-5-5`, every run; `regrade-summary.txt`):

| arm | Haiku: control + neutral concerns | Sonnet kept |
| --- | --- | --- |
| tools | 4 (long payload neutral 3, short payload control 1) | 1 |
| eden | 19 | 4 (short signals neutral 1; long signals control 1, neutral 2) |
| eden+pushChecked | 6 | 0 |

Most Haiku concerns were the grader's misreadings (as fix-w2b found). 4 against 0 out of about 1,200 control and
neutral tasks an arm is not a difference to set against a significant hidden loss.

## 4. Decision (D257)

D112: promote if better or neutral at no extra cost, without a significant hidden loss or a concern rise. The note is
cheaper and faster where the ask is slow (signals) and over a user's days, never dearer, and its concerns did not rise;
but hidden facts fell significantly, pooled (−5.1, −9.1..−1.2) and in the short signals run alone (−7.3, −13.6..−1.0),
so it was not shown neutral. Of the pooled loss, 14 of 22 tasks are ones the note never reached (sampling: exact
McNemar p ≈ 0.08 for 34 against 20 discordant pairs) and 8 are note tasks (15 against 7, p ≈ 0.13): the note's own
effect is about −8/429 ≈ −1.9 points of hidden tasks, with a mechanism (fewer asks after a missed reading). **Deleted** with its code and tests (commit `4a9a688e`): `config.ts` and
`config-check.ts`'s switch, partner.ts's note path (`note`, `dropChecked`, `answeredAll`, `Session.builtRequest`,
`ReadOpts.outcome`, the fast path's skip), render.ts's `CHECKED_NONE`, `CHECKED_MORE`, `renderNote`, `EDEN_NOTE` and
`shownText`'s filter, `push-checked.test.ts`; the trials table row is gone. PARTS is unchanged (the switch was never
in it). A later "nothing found" signal would need a reading that rarely misses (H1's no-model verdict was not built,
D233) or wording that does not discourage the ask.

`bun run eval`: unchanged in every quality metric (precision 0.8276, recall 0.48, falseFireRate 0); `plannedLookups`
read 122 in every run after; before, this session read 121, 121, 122 and the reviewer 122 twice (a counter that varies
run to run on the same tree; the 121 readings are this session's only).

## 5. Found, not fixed: a busy day runs out of reader calls

`cl7-long-sig-42` ended `overBudget: reader 10 ... REFUSED at the Budget`. The lab wires each partner's reader with
`new Budget()`, i.e. `DEFAULT_LIMITS` (`callsPerSession` 20, `usdPerSession` $0.02), the shipped limits. In the long
mode one Eden session is one user's day (CL5's model of a day-long integration session): seed 42's days of 17 and 19
requests reached the cap in both arms (each arm counted 20 reader calls on its busiest day), so the later requests
of that day got the no-model path. The other seven runs refused none. If integrations keep one session per day,
the per-session reader cap (`DEFAULT_LIMITS`) costs recall on busy days; a per-request or per-user-day cap
may suit better. Not changed here (it is the budget's policy, not this trial's); flagged for the combine.

## 6. Reproduce

On `dd11693cd` (the arm `eden+pushChecked` needs the switch, which this branch deletes):

```bash
cat packages/sim/lab/cards/cards-v2.jsonl packages/sim/lab/cards/cards-train.jsonl \
  packages/sim/lab/cards/cards-train-4344.jsonl > .local/cl7/cards-all.jsonl
L=packages/sim/lab/cl7/run.sh; A=tools,eden,eden+pushChecked
$L cl7-short-pay-41 payload $A --seeds 41 --variants hidden,control,neutral --limit 16 --budget 0.7   # and 42
$L cl7-long-pay-41 payload $A --seeds 41 --days 8 --budget 0.4                                       # and 42
$L cl7-short-sig-41 signals eden,eden+pushChecked --seeds 41 --variants hidden,control,neutral --limit 16 --budget 0.6
$L cl7-long-sig-41 signals eden,eden+pushChecked --seeds 41 --days 8 --budget 0.3
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/cold-start.ts --users user:41,user:42 --days 8 \
  --spend-ledger .local/cl7/ledger.jsonl --spend-cap 3 --spend-headroom 0.1 --run-label cl7-cold2 \
  --out .local/cl7/runs/cold-user.json
R=.local/cl7/runs
python3 -I packages/sim/lab/cl7/arms.py --arms tools,eden,eden+pushChecked $R/cl7-short-pay-4{1,2}       # short-pay-arms
python3 -I packages/sim/lab/cl7/arms.py --arms tools,eden,eden+pushChecked \
  $R/cl7-short-pay-41:tools $R/cl7-short-pay-42:tools $R/cl7-short-sig-4{1,2}                            # short-sig-arms
bun packages/sim/src/lab/pi-cost-report.ts $R/cl7-long-sig-4{1,2}.json --lifetime $R/cold-user.json     # *-cost
bun packages/sim/src/lab/pi-ab-report.ts $R/cl7-long-sig-4{1,2}.json                                     # *-report
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/regrade.ts --results $R/cl7-long-sig-41.json \
  --graders claude-sonnet-5-5 --only-concerns --spend-ledger .local/cl7/ledger.jsonl --spend-cap 3 \
  --spend-headroom 0.1 --run-label cl7-regrade-long-sig-41 --out $R/regrade-long-sig-41.json
python3 -I packages/sim/lab/cl4/pooled.py eden+pushChecked eden $R/cl7-{short,long}-{pay,sig}-4{1,2}
python3 -I packages/sim/lab/cl7/notes.py $R/cl7-{short,long}-{pay,sig}-4{1,2}
python3 -I packages/sim/lab/cl7/regr.py $R/regrade-*.json
```

## Spend (`spend.txt`, ledger `.local/cl7/ledger.jsonl`)

| What | $ |
| --- | --- |
| short, payload (3 arms, 2 seeds) | 1.018 |
| short, signals (2 arms) | 0.725 |
| long, payload (3 arms) | 0.357 |
| long, signals (2 arms) | 0.287 |
| cold starts (one refused by the report before the fix, one after) | 0.029 |
| Sonnet regrades of concerns | 0.041 |
| **Total** | **2.457** |
