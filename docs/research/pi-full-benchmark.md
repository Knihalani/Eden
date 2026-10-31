# The full Pi-harness benchmark (D64)

Status: 2026-10-31. The first full live benchmark on the Pi harness (D61, CLAUDE.md's standard agent), over all nine
hidden-context suites, after the moonshots (D56–D63) and their reviews. Every number below comes from the runs recorded
in the ledger as `pi-full-H`, `pi-full-R` and `pi-full-ALL` (`bench/runs/…pi-full-*.jsonl.gz`); the commands are at the
end.

## Setup

- **Agent:** the Pi agent loop (`@earendil-works/pi-agent-core` 1.3.0) on `z-ai/glm-5.3-flash`.
- **Grader:** `deepseek/deepseek-v4.1-flash`. Claude Haiku 5.5 is refused for this account with a 403 (checked this
  session). The grader agrees with the lexical cross-check on 0.852–0.887 of facts. **These numbers compare only with
  each other, not with the Haiku-graded runs in earlier notes.**
- **Sources:** at their profiles' latency (`--time-scale 1`).
- **Tasks:** all nine suites (dev, held-out 1–8), seeds 41–44, both variants. That is 584 hidden tasks and 584 control
  tasks per condition:
  - in-sample: dev and held-out 1–4 (268 + 268), the suites every configuration was tuned on;
  - blind: held-out 5–8 (316 + 316), written by agents that never saw the engine, never tuned on.
- **Conditions:**
  - `none`: no tools, no Eden;
  - `tools`: read-only search tools over the user's sources;
  - `eden`: Eden's packet plus its `ask_context` tool;
  - `both`: tools and Eden;
  - `-judge`: Eden's model judge on.
- **Configurations:** H (D55), R (D62: H plus graph, cards, anticipation, consequence and role probes), and ALL (R plus
  sync). `none` and `tools` ran once, in the H runs; the R and ALL rows are paired with them task by task.
- **Instrumentation:**
  - every task's timeline on a monotonic clock: Eden's spans, each agent model request (first token and end), each
    tool call, grading;
  - process CPU and RSS sampled every second;
  - the per-second profiles below come from it.
- **Scale and spend:** 16,346 agent runs, 6 errors (connection resets, excluded), 0 ungraded. Spend $8.75 (agent
  $4.84, Eden $1.32, grader $2.59). One process per seed: a single process for all four seeds was killed for memory
  (14 GB).

A bug was found and fixed before these runs. Held-out 7 and 8 gave both variants of a task the same id, and the
runners key results by id, so their hidden tasks were reported as control. A registry test now guards this, and the
runs below are on the fixed tree.

## Results

### Hidden fact raised and false concerns

Rates by suite group (hidden tasks: the planted fact raised; control: a false concern from the decoy):

| Condition | In-sample hidden | Blind hidden | In-sample false | Blind false |
|---|---|---|---|---|
| none | 0.000 | 0.013 | 0.015 | 0.016 |
| tools | 0.422 | 0.269 | 0.030 | 0.025 |
| eden (H) | 0.571 | 0.424 | 0.045 | 0.016 |
| eden (R) | 0.631 | 0.440 | 0.034 | 0.013 |
| **eden (ALL)** | **0.784** | **0.538** | 0.037 | 0.019 |
| both (H) | 0.504 | 0.348 | 0.037 | 0.028 |
| both (ALL) | 0.731 | 0.441 | 0.015 | 0.009 |
| eden-judge (ALL) | 0.757 | 0.566 | 0.049 | 0.038 |

Paired against tools, same tasks (hidden), with bootstrap 95% intervals:

| Comparison | In-sample | Blind |
|---|---|---|
| eden (H) − tools | +0.149 (+0.082..+0.220) | +0.155 (+0.108..+0.209) |
| eden (R) − tools | +0.209 (+0.138..+0.284) | +0.171 (+0.114..+0.228) |
| eden (ALL) − tools | +0.362 (+0.291..+0.429) | +0.269 (+0.206..+0.329) |
| both (ALL) − tools | +0.310 (+0.246..+0.381) | +0.171 (+0.114..+0.225) |

On the blind suites, the agent with Eden (ALL) raises the hidden fact 2.0× as often as the agent with its own search
tools (0.538 against 0.269), with fewer false concerns (0.019 against 0.025). Beside its tools it reaches 1.64× (0.441).
The judge adds nothing measurable to the hidden rate here (eden-judge − eden in H: +0.010, −0.024..+0.046) and costs
time and money.

### Cost, latency and tokens

All nine suites, hidden and control together. All-in $ per 1,000 tasks counts the agent and Eden's judge. For R and
ALL it also counts card enrichment spread over the tasks:

| Condition | All-in $ / 1k | Card share | Wall p50 / p90 / p99 s | Agent input / output tokens | Packet chars |
|---|---|---|---|---|---|
| none | 0.097 | | 4.12 / 8.08 / 15.26 | 114 / 487 | 0 |
| tools | 0.320 | | 9.04 / 15.83 / 27.83 | 3,579 / 922 | 0 |
| eden (H) | **0.291** | | 9.49 / 15.34 / 24.16 | 2,314 / 886 | 139 |
| eden (R) | 0.389 | 0.080 | 8.91 / 14.36 / 23.57 | 2,228 / 845 | 185 |
| eden (ALL) | 0.474 | 0.156 | **8.55** / 17.54 / 31.17 | 2,234 / 869 | 260 |
| both (ALL) | 0.477 | 0.156 | 9.42 / 18.00 / 31.05 | 3,169 / 821 | 238 |

How to read the card share:
- Cards cost $0.00506 per simulated user in ALL: a one-time backfill of about 1,500 items, made by every condition's own
  partner.
- The benchmark spreads that over only about 32 tasks per user.
- In steady state (50 new items a day) cards cost $0.003–0.004 per user-month (COST-MODEL.md).
- Without the one-time backfill, Eden (ALL) is about $0.318 per 1,000 tasks, level with tools ($0.320).
- Eden (H), with no cards, costs 9% less than tools.

### Where the time goes

Critical path, mean ms per task (share of wall time):

| Condition | Eden on the critical path | Model | Tools | Eden in the background |
|---|---|---|---|---|
| tools | 0 | 8,588 (87%) | 1,324 (13%) | 0 |
| eden (H) | 1,903 (19%) | 8,155 (81%) | 0 | 2,090 |
| eden (R) | 1,776 (19%) | 7,642 (81%) | 0 | 4,007 |
| eden (ALL) | **530 (5%)** | 9,499 (95%) | 0 | 727 |
| eden-judge (ALL) | 1,657 (15%) | 9,290 (85%) | 0 | 1,872 |

Per lookup:

| Condition | Source calls per task | Ask p50 | Slow path p50 / p90 | Cache hits per task |
|---|---|---|---|---|
| eden (H) | 24.09 | 794 ms | 689 / 1,154 ms | 0.02 |
| eden (ALL) | 3.66 | **5 ms** | 552 / 963 ms | 0.24 |

With sync, Eden answers from its local index: the agent's `ask_context` returns in 5 ms at the median, not 794 ms,
and source calls per task fall 85%.

Per second of task time (mean ms of each second spent in each phase, eden condition):

| Second | H: Eden / model | ALL: Eden / model | tools: model / tool |
|---|---|---|---|
| 0 | 699 / 301 | 436 / 563 | 922 / 73 |
| 1 | 120 / 879 | 32 / 966 | 745 / 253 |
| 2 | 231 / 763 | 17 / 975 | 728 / 267 |
| 3 | 243 / 747 | 17 / 959 | 762 / 222 |
| 5 | 152 / 811 | 8 / 923 | 833 / 124 |
| 8 | 59 / 869 | 3 / 937 | 852 / 68 |

In H, Eden holds 12–24% of seconds 1–5 (the agent's `ask_context` calls going to sources). In ALL it is under 3% after
the first second, and the model is the critical path.

### Process

| Run | Sampled | CPU p50 / p90 of a core | CPU per run | RSS max |
|---|---|---|---|---|
| H | 1,172 s | 27.0% / 48.2% | 58 ms | 5,455 MB |
| R | 1,117 s | 24.8% / 43.5% | 71 ms | 3,854 MB |
| ALL | 1,618 s | 18.7% / 42.5% | 108 ms | 4,568 MB |

These are one process per seed, holding 36 simulated users times the conditions. ALL's extra CPU per run is the sync
backfill, the graph and redaction of every listed item (moonshots.md).

## Against the targets set earlier

| Target | Result | Status |
|---|---|---|
| Bar 1: Eden ≥ 1.7× tools on hidden facts, live; beside tools ≥ 1.55×; false concerns ≤ tools + 2 points | ALL, blind: 2.00× (0.538 / 0.269); beside tools 1.64× (0.441); false concerns 0.019 against 0.025 | met (ALL), this grader |
| Bar 5: Eden's cost per task ≤ tools' while meeting Bar 1 | Within this run's ~32 tasks per user, $0.474 against $0.320 counting the one-time card backfill. Without the backfill, $0.318 against $0.320. H alone: $0.291 | met in steady state; not when a new user's backfill counts against their first tasks |

## Limits

- **Grader:** deepseek, not Haiku. Its agreement with the lexical check is 0.85–0.89, against 0.98 for Haiku in
  earlier notes.
- **Sync reads the whole simulated mailbox:** about 1,500 items per user, synced before the first task. A real account
  is larger and arrives over time.
- **Same simulated sources:** tools and Eden read the same simulated sources. Real connectors' search quality and
  latency will differ.
- **Configuration choice:** H, R and ALL were chosen on the in-sample suites only. ALL's no-model soft fire rate
  (0.121) is over the 0.10 preference in D62, which leaves ALL to the owner.
- **One run:** one run per configuration, four seeds. Tools' rate varies between runs (earlier harnesses: 0.38–0.43).
  Only same-run, paired comparisons are quoted.

## Reproduce

```bash
for c in H R ALL; do for sd in 41 42 43 44; do
  bun packages/sim/src/lab/pi-ab.ts --suite hidden,heldout,heldout2,heldout3,heldout4,heldout5,heldout6,heldout7,heldout8 \
    --seeds $sd --variants hidden,control --conditions <none,tools,eden,both,eden-judge,both-judge for H; eden,both,eden-judge,both-judge else> \
    --config "$CFG_$c" --time-scale 1 --grader deepseek/deepseek-v4.1-flash --budget 1.6 --out pi-$c-$sd.json
done; done
bun packages/sim/src/lab/pi-ab-report.ts pi-ALL-4[1-4].json
bun packages/sim/src/lab/agent-ab-report.ts pi-ALL-4[1-4].json --record pi-full-ALL
```

The H, R and ALL configurations are D55's H, D62's R, and R with `"sync": true`.
