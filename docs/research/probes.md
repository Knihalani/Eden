# Probes: the checks a request implies (D46, PoC)

Status: 2026-10-30. A proof of concept behind `config.probes` (off by default). Every number here is in the benchmark
ledger ([bench/](../../bench/README.md)) with its commit, config and per-task rows.

## The problem

On tasks where the right answer depends on something the request does not mention ([agent-hidden.md](agent-hidden.md):
a calendar clash, an invoice already paid, a friend's allergy), an agent with plain search tools raised the hidden
fact more often than the same agent with Eden. A trace of each lost task through the engine (no model, no agent)
showed where:

| Where it was lost | Example |
|---|---|
| The whole request sent as one query; all-words connectors return nothing | "set dinner jamie fox thursday 29 october 19 00 send invite" → 0 |
| A sentence's leading verb glued to the name | entities "Send Rose Kimura", "Offer Globex" |
| Names starting with a non-ASCII capital never extracted | "Łukasz" |
| A weekday written with its date read as two days | "Wednesday 4 November" → 28 Oct and 4 Nov; the day's listing paged out |
| The day an action names never looked at | no listing of "Thursday 29 October" before setting up dinner then |
| Probes reaching only the request's routed sources | a person's mail never asked |
| Fetched but never shown to the judge | 44 of 72 held-out planted items cached, 21 shown |

## What probes do

Besides the request itself, a lookup sends a few short queries (`probes.ts`, at most `probeCalls` = 8 source calls):

- **People**: each person the request names, cleaned of the verb that starts the sentence, to the three sources the
  source map says mention them most.
- **Organisations**: a person's organisation, read from what came back for them (an address at
  umbrellahealth.com and the name "Umbrella Health" in the same results); what is said of the organisation applies.
- **Day**: for an action on a named day (scheduling, accepting, booking), that day listed whole from sources that
  list by time.
- **Topic**: the request's content words that are neither people, days nor the action (two at most).

Delivery adds a **clash** ground (an event within ±3 h of the time a scheduling request names, on its day) and
**judge seats**: up to three of the probes' finds join the judge's candidates beyond the best scored, since they
share few of the request's words by design. The judge is told to pick what would change the action (a clash, a
constraint, a rule, something already done), not what merely mentions the same person. A per-user memo (D47; per
session before) skips re-probing what the user's lookups probed recently. `probeWhen: "actions"` probes only
requests to act. No probe calls a model.

Two general fixes ship regardless of the flag: any capital letter starts a name, and a weekday written with its
date is that date.

## The benchmark it was measured on

The earlier benchmark only rewarded finding things. It now has:

- **A blind held-out suite**: twelve templates written by a separate agent that never read the engine, the docs or
  the dev templates (`hidden-heldout.ts`). The design was frozen before it was run; its template names were seen
  (not its code) before the design, and its aggregate funnel was used once to find the judge-seat bottleneck
  (nothing was tuned on it).
- **Decoy controls**: every template has a near-miss twin (an event the next week, a different invoice paid, an
  out-of-office that ended) graded for a false concern, so a system that cries wolf is penalised.
- **Fair worlds**: planted items in the world's own formats (mail headers, event blocks), and the requested slot
  cleared of other events (`clearSlot`). Without the latter, decoy tasks counted real clashes in the generated
  calendar as false alarms (the first live run, recorded as `probes-v1-unclearedslots`).
- **Three tiers**: the free funnel (engine only), the free simulation and eval, the live agent.

## Results

### Live agent (GLM 5.3 Flash agent, Claude Haiku 5.5 grader; 6 worlds; hidden and control tasks)

Held-out suite, never tuned on (72 hidden, 72 control tasks), final code (ledger `probes-final2`, commit
a4bf2b2f8):

| Condition | Hidden fact raised | False concern (control) | Cost / 1k tasks | Agent input tokens | p50 / p95 |
|---|---|---|---|---|---|
| tools | 0.264 | 0.028 | $0.354 | 3,091 | 6.6 / 12.1 s |
| eden-judge (today) | 0.389 | 0.083 | $0.336 | 2,136 | 7.9 / 20.6 s |
| eden-judge + probes | 0.403 | 0.069 | $0.327 | 1,888 | 7.7 / 24.1 s |
| both-judge + probes | 0.444 | 0.042 | $0.355 | 2,790 | 7.3 / 16.2 s |

Paired against tools on the same tasks (bootstrap 95% interval): eden-judge +0.125 (+0.014…+0.236); eden-judge +
probes +0.139 (+0.028…+0.264), false concerns +0.042 (−0.014…+0.111); both-judge + probes +0.181 (+0.069…+0.292),
false concerns +0.014 (−0.028…+0.069). **Probes over the judge alone: +0.014 (−0.083…+0.111), not distinguishable
from zero on the held-out suite**; the earlier run of the same comparison (ledger `probes-v2`, before the review
fixes) gave +0.042 (−0.069…+0.153). On held-out tasks most of Eden's lead over tools is the judge's (D45), and the
configuration that is robustly ahead is Eden with its judge and probes beside the agent's own tools. The false
concerns are mostly one decoy ("September retainer paid, October invoice to follow" read as paid), which the judge
misreads with or without probes.

Dev suite (60 hidden, 60 control; ledger `probes-v2`, commit aaffc32c2, which still had a meeting-change ground
removed since): eden-judge + probes − tools +0.250 (+0.133…+0.367), false concerns −0.017 (−0.083…+0.050);
eden-judge + probes − eden-judge +0.183 (+0.067…+0.300). Probes help most where the dev suite's failures were
(clashes, people named by first name), which the design targeted.

### Free tiers (engine only and simulation)

Simulation (4 seeds, 589 silent turns per row; ledger `baseline-final` and, on the final code, `probes-final2`;
`probes-final-actions` ran before the review fixes). Recall and precision; the perfect judge stands in for a model
that judges well:

| Mix | Judge | Off | Actions only (pre-fix) | Always (final) | Source calls / lookup (off / actions / always) |
|---|---|---|---|---|---|
| realistic | none | 0.238, 0.595 | 0.276, 0.581 | 0.308, 0.595 | 5.6 / 9.1 / 11.8 |
| realistic | perfect | 0.447, 0.804 | 0.571, 0.842 | 0.620, 0.822 | 5.6 / 8.9 / 11.7 |
| held-out A | none | 0.242, 0.587 | 0.266, 0.579 | 0.289, 0.591 | 5.5 / 8.9 / 11.6 |
| held-out A | perfect | 0.448, 0.800 | 0.540, 0.827 | 0.576, 0.824 | 5.5 / 8.8 / 11.6 |
| held-out B | none | 0.281, 0.559 | 0.306, 0.557 | 0.314, 0.557 | 5.4 / 8.7 / 11.5 |
| held-out B | perfect | 0.579, 0.780 | 0.666, 0.809 | 0.688, 0.814 | 5.4 / 8.7 / 11.4 |

No hard false fire in any row. Ask recall@5 0.85–0.88 off, 0.86–0.90 with probes. With the perfect judge, model
calls per turn 0.19–0.23 off, 0.21–0.24 on. The eval is identical under all of them (recall 0.444, precision 1, no
false fire). The simulation's tasks were not used to design probes: these rows are out of sample.

Funnel (engine only, no model; 4 seeds; final code, `probes-final2` at a4bf2b2f8): the planted item reached the
agent on dev 0.125 → 0.55 of tasks, held-out 0.042 → 0.146; decoys delivered on dev 0.075 → 0.25, held-out 0.104 →
0.0625; source calls per task 3 → 9–10. Before the review fixes (one deadline for all probes, run in parallel) the
same funnel gave dev 0.625 and held-out 0.167: the shared deadline cuts some probes short.

Ablation (each part switched off with the rest on; ledger `ablate-*`, run on the code before the review fixes, a
dirty tree of 1f2ddd5d43; realistic simulation and both funnels; the "(nothing)" row is that code's own):

| Off | Dev delivered | Held-out delivered | Sim recall (none / perfect) | Calls per funnel task |
|---|---|---|---|---|
| (nothing) | 0.625 | 0.167 | 0.305 / 0.618 | 9.4 |
| people | 0.475 | 0.125 | 0.251 / 0.535 | 6.3 |
| topic | 0.625 | 0.167 | 0.292 / 0.565 | 6.8 |
| day listing | 0.400 | 0.083 | 0.306 / 0.610 | 9.2 |
| clash ground | 0.425 | 0.083 | 0.305 / 0.618 | 9.4 |
| organisation | 0.550 | 0.167 | 0.305 / 0.608 | 9.3 |
| judge seats | 0.625 | 0.167 | 0.305 / 0.606 | 9.4 |

People probes carry most of the general gain; the topic probe matters for the simulation's lookups, not for hidden
context; the day listing and clash ground carry the scheduling clashes; organisations and seats are small. A
meeting-change ground was built too and removed: it changed nothing measurable.

## Costs

- Source calls per lookup roughly double (simulation 5.4–5.6 → 11.4–11.8; `probeWhen: "actions"` 8.7–9.1).
- No probe calls a model. With the perfect judge, model calls per turn rise slightly (0.19–0.23 → 0.22–0.24: more
  lookups have candidates); judge input grows by up to three candidates.
- Latency. The agent's path (`observe`) is unchanged (p50 0.3 ms). Delivery of the slow path is not: in the
  simulation run in real time (realistic connector latencies, perfect judge, 3 users × 6 sessions), delivery p50
  2.6 → 5.3 s and p95 21.5 → 38.8 s, recall 0.379 → 0.483. Probes ran within one `sourceTimeoutMs` deadline after the
  lookup's own calls (`ask` waited for them); since D47 they run beside it and the lookup waits at most `probeGraceMs`
  for them. Engine time with instant sources 3 → 5 ms on this machine (machine-dependent: an independent rerun
  measured 4.5–5.1 → 5.9–6.7 ms).
- No-model decoy deliveries rise on the dev funnel (0.075 → 0.25: a mail confirming the 3pm call, a Q2 report
  sent): the probes fetch items about the right people and topic that change nothing. With a judge the live false
  concerns did not rise on dev.
- For the agent, Eden in place of tools is cheaper than tools: fewer agent model calls and 39% fewer input tokens
  (held-out, final code: 1,888 against 3,091).

## Limits

- Ten dev and twelve held-out templates, six worlds, one agent model, one run each: per-template counts are rough.
- Some hidden facts no condition finds: a synonym ("15% off" against "discounts above 10%"), a moved launch date, a
  passport away. Those need a judge that reads more, or semantics, not more queries.
- The extra source calls are real connector calls: on rate-limited connectors they compete with the lookup's own.

## Reproduce

```bash
bun packages/sim/src/lab/bench.ts --label probes --config '{"probes":true}'     # free tiers, recorded
bun packages/sim/src/lab/hidden-funnel.ts --suite heldout --config '{"probes":true}'
bun packages/sim/src/lab/agent-ab.ts --suite heldout --variants hidden,control --seeds 41,42,43,44,45,46 \
  --conditions tools,eden-judge,eden-judge+p,both-judge+p --out h.json
bun packages/sim/src/lab/agent-ab-report.ts h.json --record mylabel
bun packages/sim/src/lab/bench-compare.ts --latest baseline-final probes-final
```
