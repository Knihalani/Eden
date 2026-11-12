# B19 final: raw agent, Eden before the wave, Eden final, on blind heldout19

Status: 2026-11-12, branch `claude/b19-final-bench`. Decisions D1040–D1048. Methods, the pre-registration (D1043,
amended by D1045–D1047 before the go) and the dry runs are in [b19-final-bench.md](b19-final-bench.md).

**Every number here is lab-provider.** All paid calls went to Anthropic's API through the lab transport (D97), not
the shipped OpenRouter route, and none went to OpenRouter. The agent is `claude-haiku-5-5` and the grader
`claude-sonnet-5-5`, so every answer is Sonnet-graded in-run. Eden's card, intent, reader and push-check roles are
`claude-haiku-5-5`. Each table names its harness: Hermes Agent at 06433066, or Pi (pi-agent-core 1.3.0).

**The arms:**
- `raw`: the agent with its `search_<source>` tools and no Eden;
- `before`: Eden at `main` 5026ba512 (2026-11-11 13:57, before the wave);
- `final`: Eden at `main` 93b1a1f3, the parent's final commit.

Both Eden arms are the integrators' shape: `hermes+eden` on Hermes and `both+ask` on Pi.

**The run:** heldout19, read once, seeds 41–44 (40 templates; hidden, control and neutral variants), on the parent's
go at 00:24 UTC. `go.sh` ran from 00:25 to 01:06: 27 processes, 0 ungraded, 0 stopped streams, no restart.

**Spend:** $6.06 for the final run, against a $25 cap. That includes $0.128 to record the final default's card
coverage (below). The session total is $9.96 of the $40 cap. Modal was not used.

## In plain words

- **The night's wave raised hidden facts on the blind suite on both harnesses, one request a session.**

  | harness | before | final | final − before | 95% CI |
  | ------- | -----: | ----: | -------------: | ------ |
  | Hermes  |  30.0% | 46.2% |   +16.3 points | +5.0 to +28.1 |
  | Pi      |  30.0% | 47.5% |   +17.5 points | +6.3 to +29.4 |

  Each is 160 hidden tasks an arm, template-clustered over 40 templates. This is the pre-registered headline, and
  both intervals exclude 0.
- **Over a user's days the direction is the same, but it is not established.** 16 hidden tasks an arm, user-day
  clustered over 8 clusters:
  - Hermes: 8/16 against 7/16, +6.3 points (−12.5 to +25.0).
  - Pi: 9/16 against 6/16, +18.8 points. Its clustered interval (+6.3 to +37.5) is narrower than the task-level one
    (−6.3 to +43.8). With 8 clusters the bootstrap undercovers, so read it as a direction.
- **Eden against the agent alone:**
  - Hermes short +33.1 points (+21.9 to +45.0); Hermes days +43.8 (+18.8 to +68.8).
  - Pi short +31.9 (+20.0 to +44.4); Pi days +50.0 (+25.0 to +75.0).
- **No false concerns.** Sonnet flagged 2 of the 2,784 control and neutral answers across the arms, both in
  Pi short's final arm. Read by hand, neither names a false problem (below). Confirmed concerns are 0 in every arm.
- **Silence improved.** The final arm hands a packet on fewer neutral turns: on Hermes short 64/160 against 92/160
  (−17.5 points, −32.5 to −1.9), with about half the items. That is the push check (D828), which 5026ba512's
  default did not have.
- **Cost:**
  - Eden's own spend rises from $0.07 to $0.24 per 1,000 tasks on Hermes short, and $0.08 to $0.25 on Pi short. The
    push check is the new line at $0.16.
  - The agent's spend is level (Hermes −$0.01 per 1,000 tasks, −0.04..+0.02), and so are its tokens.
- **Wall time:** the final arm is slower by about half a second to a second a task against before (Hermes short
  +0.58 s, +0.18 to +0.99; Pi short +0.86 s, +0.64 to +1.09). That is the push check's call on the request
  path. Against raw the mean is level on Hermes (+0.09 s, −0.37..+0.51) and +0.39 s on Pi (+0.17..+0.60).
- **Connectors:** with Eden, the agent searches less. Hermes short has 0.70 fewer connector calls a task than raw
  (−1.10 to −0.34), counting Eden's own. The final and before arms are level.
- **Asks:** the agent calls `ask_context` about 0.12 times a task on Hermes short, the same in both Eden arms.

## Coverage

Both Eden arms replayed one file: the shipped cards (`cards-shipped.jsonl.gz`) plus 1,934 lines that the final
tree's own enricher recorded for heldout19. That recording covered seeds 41–44, the hidden, control and neutral worlds
and the days users (16 `cold-start` users, $0.128).

The final default's `cardsRequestsFix` (#268, D1060) keys its cards apart (`:f3`), so this was needed (D1046). Each
arm found what its own enricher writes:
- Hermes short: intent replayed for 511 of 6,163 items in `before` (old keys) and 539 in `final` (`:f3`);
- the other steps alike.

## Concerns read by hand (pre-registered; `.local/b19/report/h19-concerns.txt`)

1. **Pi short, final, control `claims-cutoff-early`** ("I'll submit my receipts from the Leeds trip on Friday").
   The answer asks whether the user claims as an employee or a contractor, then states the cut-off only for
   contractors ("If you're a contractor, October invoices are due by Wednesday 28 October…"). It is a conditional
   hedge, not a false claim. **Not confirmed.**
2. **Pi short, final, neutral `freeze-over-month-end`** ("…give Zoë the go-ahead to start moving the Atlas data
   across on Monday"). The answer never mentions the change freeze; it raises an open Jira ticket. This is a grader
   error. **Not confirmed.**

## Results

### Hermes, one request a session — `hermes-short`

Anthropic direct (lab transport, D97), Haiku 5.5 agent, Sonnet 5.5 grader.

| | raw | before (5026ba512) | final (93b1a1f3) |
|---|---:|---:|---:|
| tasks | 480 | 480 | 480 |
| hidden facts raised (Sonnet) | 21/160 (13.1%) | 48/160 (30.0%) | 74/160 (46.2%) |
| control (look-alike) concerns, as graded | 0/160 | 0/160 | 0/160 |
| neutral concerns, as graded | 0/160 | 0/160 | 0/160 |
| neutral turns handed a packet | 0/160 (0.00 items) | 92/160 (2.17 items) | 64/160 (0.99 items) |
| agent tokens a task | 10,065 | 10,212 | 10,023 |
| agent $ per 1k tasks | 0.41 | 0.43 | 0.42 |
| Eden $ per 1k tasks (all roles) | 0.000 | 0.067 | 0.240 |
| — cards / check | 0.000 / 0.000 | 0.067 / 0.000 | 0.080 / 0.160 |
| asks a task | 0.000 | 0.123 | 0.119 |
| connector calls a task: agent / Eden on task / backfill | 3.00 / 0.00 / 0.00 | 2.27 / 0.07 / 1.35 | 2.22 / 0.07 / 1.36 |
| wall s a task p50 / p90 | 4.8 / 8.0 | 4.5 / 7.7 | 5.1 / 7.9 |

Paired differences, 95% intervals (template-clustered bootstrap, 5,000 draws; task-level in brackets):

| metric | final − before | final − raw | before − raw |
|---|---|---|---|
| hidden raised (pts) | +16.25 (+5.00..+28.12) [+8.75..+24.38] | +33.12 (+21.88..+45.00) [+25.00..+41.25] | +16.88 (+8.12..+27.50) [+10.62..+23.12] |
| control concerns (pts) | +0.00 (+0.00..+0.00) [+0.00..+0.00] | +0.00 (+0.00..+0.00) [+0.00..+0.00] | +0.00 (+0.00..+0.00) [+0.00..+0.00] |
| neutral concerns (pts) | +0.00 (+0.00..+0.00) [+0.00..+0.00] | +0.00 (+0.00..+0.00) [+0.00..+0.00] | +0.00 (+0.00..+0.00) [+0.00..+0.00] |
| neutral packets (pts) | -17.50 (-32.50..-1.88) [-26.25..-8.75] | +40.00 (+27.50..+53.12) [+32.50..+47.50] | +57.50 (+43.12..+71.25) [+50.00..+65.00] |
| agent tokens/task | -188.79 (-811.43..+455.91) [-562.36..+189.50] | -42.11 (-582.95..+467.88) [-376.45..+294.38] | +146.68 (-573.45..+806.40) [-206.70..+493.79] |
| agent $/1k | -0.01 (-0.04..+0.02) [-0.03..+0.01] | +0.01 (-0.02..+0.04) [-0.01..+0.03] | +0.02 (-0.01..+0.05) [+0.00..+0.04] |
| connector calls/task (agent+Eden) | -0.05 (-0.37..+0.29) [-0.23..+0.14] | -0.70 (-1.10..-0.34) [-0.90..-0.51] | -0.65 (-1.10..-0.24) [-0.86..-0.46] |
| asks/task | -0.00 (-0.05..+0.04) [-0.04..+0.03] | +0.12 (+0.06..+0.19) [+0.09..+0.15] | +0.12 (+0.07..+0.18) [+0.09..+0.15] |
| wall s/task (mean) | +0.58 (+0.18..+0.99) [+0.34..+0.81] | +0.09 (-0.37..+0.51) [-0.16..+0.35] | -0.49 (-1.01..-0.02) [-0.77..-0.22] |

### Hermes, a user's days (2 × 20) — `hermes-days`

Anthropic direct (lab transport, D97), Haiku 5.5 agent, Sonnet 5.5 grader.

| | raw | before (5026ba512) | final (93b1a1f3) |
|---|---:|---:|---:|
| tasks | 160 | 160 | 160 |
| hidden facts raised (Sonnet) | 1/16 (6.2%) | 7/16 (43.8%) | 8/16 (50.0%) |
| control (look-alike) concerns, as graded | 0/16 | 0/16 | 0/16 |
| neutral concerns, as graded | 0/128 | 0/128 | 0/128 |
| neutral turns handed a packet | 0/128 (0.00 items) | 77/128 (2.04 items) | 52/128 (1.00 items) |
| agent tokens a task | 11,131 | 15,037 | 14,879 |
| agent $ per 1k tasks | 0.24 | 0.34 | 0.33 |
| Eden $ per 1k tasks (all roles) | 0.000 | 0.204 | 0.382 |
| — cards / check | 0.000 / 0.000 | 0.204 / 0.000 | 0.217 / 0.164 |
| asks a task | 0.000 | 0.050 | 0.031 |
| connector calls a task: agent / Eden on task / backfill | 0.88 / 0.00 / 0.00 | 0.75 / 0.00 / 0.65 | 0.85 / 0.00 / 0.65 |
| wall s a task p50 / p90 | 1.1 / 4.6 | 1.5 / 4.3 | 2.4 / 5.2 |

Paired differences, 95% intervals (user-day-clustered bootstrap, 5,000 draws; task-level in brackets):

| metric | final − before | final − raw | before − raw |
|---|---|---|---|
| hidden raised (pts) | +6.25 (-12.50..+25.00) [-12.50..+25.00] | +43.75 (+18.75..+68.75) [+18.75..+68.75] | +37.50 (+0.00..+75.00) [+12.50..+62.50] |
| control concerns (pts) | +0.00 (+0.00..+0.00) [+0.00..+0.00] | +0.00 (+0.00..+0.00) [+0.00..+0.00] | +0.00 (+0.00..+0.00) [+0.00..+0.00] |
| neutral concerns (pts) | +0.00 (+0.00..+0.00) [+0.00..+0.00] | +0.00 (+0.00..+0.00) [+0.00..+0.00] | +0.00 (+0.00..+0.00) [+0.00..+0.00] |
| neutral packets (pts) | -19.53 (-28.91..-10.94) [-29.69..-8.59] | +40.62 (+34.38..+46.88) [+32.81..+49.22] | +60.16 (+53.91..+67.97) [+51.56..+67.97] |
| agent tokens/task | -157.73 (-4821.41..+5427.13) [-1660.41..+1339.99] | +3747.75 (+1071.70..+6712.22) [+2630.53..+4886.18] | +3905.48 (+790.26..+6504.03) [+2815.90..+5065.89] |
| agent $/1k | -0.01 (-0.10..+0.10) [-0.04..+0.02] | +0.09 (+0.03..+0.15) [+0.06..+0.11] | +0.10 (+0.02..+0.16) [+0.07..+0.13] |
| connector calls/task (agent+Eden) | +0.10 (-0.37..+0.66) [-0.12..+0.33] | -0.03 (-0.34..+0.31) [-0.26..+0.19] | -0.12 (-0.56..+0.21) [-0.35..+0.10] |
| asks/task | -0.02 (-0.09..+0.06) [-0.06..+0.03] | +0.03 (+0.01..+0.07) [+0.01..+0.06] | +0.05 (+0.01..+0.11) [+0.02..+0.09] |
| wall s/task (mean) | +0.66 (-0.03..+1.43) [+0.37..+0.96] | +0.95 (+0.50..+1.43) [+0.67..+1.24] | +0.29 (-0.31..+0.78) [+0.01..+0.57] |

### Pi, one request a session — `pi-short`

Anthropic direct (lab transport, D97), Haiku 5.5 agent, Sonnet 5.5 grader.

| | raw | before (5026ba512) | final (93b1a1f3) |
|---|---:|---:|---:|
| tasks | 480 | 480 | 480 |
| hidden facts raised (Sonnet) | 25/160 (15.6%) | 48/160 (30.0%) | 76/160 (47.5%) |
| control (look-alike) concerns, as graded | 0/160 | 0/160 | 1/160 |
| neutral concerns, as graded | 0/160 | 0/160 | 1/160 |
| neutral turns handed a packet | 0/160 (0.00 items) | 93/160 (2.16 items) | 64/160 (0.94 items) |
| agent tokens a task | 5,307 | 5,274 | 5,376 |
| agent $ per 1k tasks | 0.26 | 0.26 | 0.26 |
| Eden $ per 1k tasks (all roles) | 0.000 | 0.078 | 0.250 |
| — cards / check | 0.000 / 0.000 | 0.078 / 0.000 | 0.088 / 0.162 |
| asks a task | 0.000 | 0.065 | 0.094 |
| connector calls a task: agent / Eden on task / backfill | 2.77 / 0.00 / 0.00 | 1.91 / 0.08 / 1.38 | 2.05 / 0.08 / 1.38 |
| wall s a task p50 / p90 | 3.2 / 4.7 | 2.9 / 4.8 | 3.6 / 5.6 |

Paired differences, 95% intervals (template-clustered bootstrap, 5,000 draws; task-level in brackets):

| metric | final − before | final − raw | before − raw |
|---|---|---|---|
| hidden raised (pts) | +17.50 (+6.25..+29.38) [+8.75..+26.25] | +31.88 (+20.00..+44.38) [+24.38..+40.00] | +14.38 (+3.75..+25.62) [+8.12..+21.25] |
| control concerns (pts) | +0.62 (+0.00..+1.88) [+0.00..+1.88] | +0.62 (+0.00..+1.88) [+0.00..+1.88] | +0.00 (+0.00..+0.00) [+0.00..+0.00] |
| neutral concerns (pts) | +0.62 (+0.00..+1.88) [+0.00..+1.88] | +0.62 (+0.00..+1.88) [+0.00..+1.88] | +0.00 (+0.00..+0.00) [+0.00..+0.00] |
| neutral packets (pts) | -18.12 (-33.12..-2.50) [-27.50..-8.75] | +40.00 (+28.12..+52.50) [+32.50..+47.50] | +58.12 (+43.75..+71.88) [+50.00..+65.62] |
| agent tokens/task | +101.68 (-138.11..+348.03) [-92.42..+292.22] | +68.67 (-189.18..+332.36) [-100.19..+236.24] | -33.00 (-340.22..+272.77) [-205.14..+147.93] |
| agent $/1k | +0.00 (-0.01..+0.02) [-0.01..+0.01] | +0.00 (-0.01..+0.02) [-0.01..+0.01] | +0.00 (-0.02..+0.02) [-0.01..+0.01] |
| connector calls/task (agent+Eden) | +0.13 (-0.19..+0.42) [-0.03..+0.30] | -0.64 (-0.95..-0.35) [-0.79..-0.49] | -0.78 (-1.08..-0.48) [-0.92..-0.63] |
| asks/task | +0.03 (-0.01..+0.07) [+0.00..+0.06] | +0.09 (+0.05..+0.16) [+0.07..+0.12] | +0.06 (+0.03..+0.10) [+0.04..+0.09] |
| wall s/task (mean) | +0.86 (+0.64..+1.09) [+0.70..+1.01] | +0.39 (+0.17..+0.60) [+0.25..+0.53] | -0.47 (-0.70..-0.24) [-0.61..-0.32] |

### Pi, a user's days (2 × 20) — `pi-days`

Anthropic direct (lab transport, D97), Haiku 5.5 agent, Sonnet 5.5 grader.

| | raw | before (5026ba512) | final (93b1a1f3) |
|---|---:|---:|---:|
| tasks | 160 | 160 | 160 |
| hidden facts raised (Sonnet) | 1/16 (6.2%) | 6/16 (37.5%) | 9/16 (56.2%) |
| control (look-alike) concerns, as graded | 0/16 | 0/16 | 0/16 |
| neutral concerns, as graded | 0/128 | 0/128 | 0/128 |
| neutral turns handed a packet | 0/128 (0.00 items) | 77/128 (2.02 items) | 53/128 (1.02 items) |
| agent tokens a task | 9,679 | 8,337 | 10,055 |
| agent $ per 1k tasks | 0.23 | 0.20 | 0.24 |
| Eden $ per 1k tasks (all roles) | 0.000 | 0.194 | 0.374 |
| — cards / check | 0.000 / 0.000 | 0.194 / 0.000 | 0.210 / 0.164 |
| asks a task | 0.000 | 0.013 | 0.056 |
| connector calls a task: agent / Eden on task / backfill | 1.43 / 0.00 / 0.00 | 0.45 / 0.00 / 0.65 | 0.79 / 0.00 / 0.65 |
| wall s a task p50 / p90 | 2.4 / 3.5 | 1.2 / 2.8 | 2.4 / 4.2 |

Paired differences, 95% intervals (user-day-clustered bootstrap, 5,000 draws; task-level in brackets):

| metric | final − before | final − raw | before − raw |
|---|---|---|---|
| hidden raised (pts) | +18.75 (+6.25..+37.50) [-6.25..+43.75] | +50.00 (+25.00..+75.00) [+25.00..+75.00] | +31.25 (+6.25..+56.25) [+12.50..+56.25] |
| control concerns (pts) | +0.00 (+0.00..+0.00) [+0.00..+0.00] | +0.00 (+0.00..+0.00) [+0.00..+0.00] | +0.00 (+0.00..+0.00) [+0.00..+0.00] |
| neutral concerns (pts) | +0.00 (+0.00..+0.00) [+0.00..+0.00] | +0.00 (+0.00..+0.00) [+0.00..+0.00] | +0.00 (+0.00..+0.00) [+0.00..+0.00] |
| neutral packets (pts) | -18.75 (-26.56..-11.72) [-28.91..-8.59] | +41.41 (+36.72..+46.09) [+32.81..+50.00] | +60.16 (+53.12..+67.97) [+51.56..+68.75] |
| agent tokens/task | +1717.68 (+291.84..+3415.18) [+1057.33..+2399.86] | +375.57 (-2976.40..+3843.90) [-625.80..+1378.86] | -1342.11 (-3726.72..+1061.43) [-2130.62..-593.89] |
| agent $/1k | +0.04 (+0.01..+0.07) [+0.02..+0.05] | +0.01 (-0.07..+0.09) [-0.02..+0.03] | -0.03 (-0.09..+0.03) [-0.05..-0.01] |
| connector calls/task (agent+Eden) | +0.34 (+0.06..+0.78) [+0.17..+0.53] | -0.63 (-1.34..+0.19) [-0.86..-0.39] | -0.97 (-1.48..-0.46) [-1.16..-0.78] |
| asks/task | +0.04 (+0.01..+0.08) [+0.01..+0.08] | +0.06 (+0.03..+0.09) [+0.03..+0.09] | +0.01 (+0.00..+0.03) [+0.00..+0.03] |
| wall s/task (mean) | +1.10 (+0.84..+1.43) [+0.90..+1.29] | +0.42 (-0.12..+1.03) [+0.19..+0.64] | -0.68 (-1.07..-0.27) [-0.86..-0.51] |

## Caveats

- **Days power.** Each days arm has 16 hidden tasks over 8 user-days. A user-day bootstrap with 8 clusters
  undercovers, so the days rows give a direction, and the short runs give the sizes.
- **Wall time** was measured with the three arms of a step side by side on one 4-core machine. On Hermes that is 12
  Python workers. Compare the arms within a step, not across steps or with earlier runs.
- **Eden's $/1k:**
  - It counts the arm's `eden.*` ledger lines (cards made live beyond the replayed file, and the push check) over
    the tasks that finished, recap turns included.
  - The one-time coverage recording ($0.128) is not in any arm's figure.
  - A real user's backfill would pay for cards the replay gives here for free (B18: about $0.006 a user).
- **The before arm** runs 5026ba512's product packages exactly (arm-tree.sh; its index has no diff against that
  commit), beside the final harness. Two harness imports that the old engine lacks are read with their "off" values
  (D1041, D1047). Task, world and prompt hashes were identical in both trees on heldout19 (`tasks-hash-*.txt`).
- **Comparing with earlier Hermes runs.** Before D1042, Hermes runs had no push check. These Hermes figures are the
  first with the whole default.

## Raw files

- Results: `.local/b19/runs/h19-{h,hd}-{raw,before,final}.json` (Hermes) and
  `h19-{ps,pd}-{raw,before,final}-{41..44}.json` (Pi), each with its `.tl/tasks.jsonl` timeline.
- Reports: `.local/b19/report/h19-{hermes-short,hermes-days,pi-short,pi-days}.{txt,json}` (`analyze.sh`).
- Concerns: `.local/b19/report/h19-concerns.txt` (`concerns.py`).
- Ledger: `.local/b19/ledger.jsonl`. Logs: `.local/b19/go.log`, `starts.log` and one log a process.
- Coverage: `.local/b19/h19-coverage-final.{json,jsonl}`.

Reproduce: `FINAL=93b1a1f3 bash packages/sim/lab/b19/go.sh`, then `bash packages/sim/lab/b19/analyze.sh`, on this
branch at the commit below.
