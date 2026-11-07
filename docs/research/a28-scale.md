# A28: Eden at 1,000 sources, part 5 (a budget for live searches of cut copies)

Status: measured 2026-11-07 on branch `claude/a28-scale5` (from `claude/lucid-hypatia-v9wqk5` at ed75fa41, A21 merged),
A21's next step ([a21-scale.md](a21-scale.md) §6). Decisions D390–D391. Paid calls: Anthropic API only,
`HAIKU_API_KEY`, `claude-haiku-5-5` in every role, lab provider (D97), `OPENROUTER_API_KEY` unset, own ledger
(`.local/a28/ledger.jsonl`, hard cap $1.5): **Anthropic-direct lab figures**. **Spent: $0.3659.** Every other figure
is a $0 run. Machine: 4 vCPU, 15 GiB, Bun 1.4.4. Summaries of every run are in `packages/sim/lab/a28/`. The trial's code
is in commit def8c153 (deleted in the next commit).

## In plain words

- **The problem.** A21 measured a 1,000-source user live: Eden made ~39 connector calls a task (5 sources: 0), most of
  them live searches of noise connectors whose synced copy the user's cap had cut (D264 searches such a copy live), and
  spent ~2.2 s a task on the agent's critical path (5 sources: 17 ms).
- **What was tried (D390).** A budget: over the poll width, a lookup searches live (and polls) at most 4 cut copies of
  sources the user does not use, those with the most routing evidence (names they mention, the request's words among
  their held items or in their sketch), and only with some evidence. Every other cut copy answers from what it holds,
  as before D264. A source the user uses keeps D264.
- **What it did.** Connector calls fell by half: live, **39.5 → 21.1 calls a task** (paired −19.7 a task on the mix,
  −22.9..−16.6), which on Zapier MCP is **$1,178 → $669 per 1,000 tasks** on the mix. On the $0 funnel calls fell
  49.8 → 22.1 a task with no hidden fact lost.
- **What it did not do.** Eden's time on the agent's path did **not** move (2,169 → 2,135 ms a task): a lookup's live
  searches run in parallel and the push waits for the slowest, and the world's own cut copies (the user's mail above
  all: 3.7 → 4.5 searches a task, `pi-sources.txt`) are still searched live. And the agent raised **fewer hidden
  facts in both seeds: 50/72 → 46/72** (paired −0.056, −0.125..+0.014). Eden handed the planted item over about as
  often (53 → 52 of 72, in a packet or an ask answer), but in a packet less often (45 → 42), and the agent took up
  packets less well in seed 41.
- **Decision: deleted.** The brief's rule (promote only if hidden is not worse and calls or path time fall) is not met:
  the path did not get faster, and hidden is lower in both seeds with an interval that does not rule out a real loss.
  The half of the call bill it saves is recorded here for a rerun on more seeds.
- **A finding that moves the next step (D391).** At 1,000 sources the path's 2.2 s is not the number of live calls.
  Halving them changed nothing. What is left on the path is one live search of a cut copy that matters (any one
  live search costs a connector's latency), and a process at ~300% CPU on 4 cores with a 10.1–10.6 GB heap (seed 41,
  `pi-memory-regrade.txt`). A lever for path time has to take every live search off the push, not most of them.

## 1. The trial and its rule

`syncCutLive` (D390; owner A28, opened and deleted the same day). In `searchLive`, only where D263's pre-route already
runs (more sources than `syncPollWidth`, 8): the route ranks every source (its Thompson draws are the same whatever the
limit), then of the warm cut copies (`Sync.complete` false) of sources not `Sync.engaged`, the N with the largest
evidence (`entityHits` + the `routeLocalHits`/`routeSketch` boost), and only those with evidence above 0, are polled and
searched; the rest are added to the lookup's `local` set, so the lookup and its probes answer them from the index. At
or under the poll width the trial does nothing by construction; the 5-source funnel (314/273, `funnel-5.txt`) and
`bun run eval` (0.5909/0.52/0, `eval.txt`) have the same totals as D356 (no task-by-task diff was run).

Three forms were screened at $0 before the budget:

| Form | Funnel 995, seed 41 / 42: hidden, calls a task (2 shards) | Lost |
| --- | --- | --- |
| Default (D264 for every cut copy) | 77/96, 49.8 · 47.2 / 76/96, 51.1 · 47.6 | – |
| Threshold: evidence ≥ 0.01 | 77, 31.5 · 27.6 / – | none |
| Threshold ≥ 0.5 | 77, 28.7 · 26.6 / 76, 29.1 · 25.6 | none |
| Threshold ≥ 0.75 | 76, 11.3 · 16.7 / 76, 12.5 · 15.4 | train5 `us-travel-authorisation-refused` (41) |
| Threshold ≥ 1 | 76, 6.7 · 11.2 / 76, 8.4 · 10.8 | the same (42: +1 decoy) |
| Threshold ≥ 1, used sources exempt | 76, 7.1 · 13.1 / 76, 9.2 · 12.8 | the same (42: +1 decoy) |
| Budget 2 | 76, 16.1 · 19.0 / 76, 14.8 · 18.4 | the same (42: +1 decoy) |
| **Budget 4 (measured live)** | **77, 22.1 · 25.0 / 77, 22.5 · 24.9** | none (+1 hidden, +1 decoy on 42) |

The lost task: a flight booking whose planted ESTA refusal sat behind the world's `crm` source, whose evidence for the
request was its sketch alone (0.85: common words such as "book" and "summit"); a fixed threshold cannot tell it from
the noise, a budget ranks it among the top few. Seed 41 at budget 4: connectors received 9,312 → 4,626 calls in the
tasks' windows, on-demand listings 2,808 → 1,413; funnel card calls 508 → 478 (seed 42: 534 → 475). Decoys delivered
69/64 → 69/65.

## 2. Live: Pi, train, seeds 41–42 (one arm per process)

`pi-ab --noise-sources 995`, train1–6, `--limit 6`, hidden/control/neutral, `--push payload`, direct profile, time
scale 1, the shipped default against the default with `syncCutLive` 4, Haiku in every role. One Eden arm per process:
two 1,000-source arms in one process passed 12.8 GB RSS and were stopped (seen with `ps`, not saved); seed 42 as a
whole was killed for memory in both arms, one process each, so it ran as two processes an arm (train1–3, train4–6).
216 tasks an arm, paired by task (`a8/pair.py`).

| Arm | Hidden | Planted item handed over (packet / ask only / neither) | Concerns control / neutral (regraded) | Eden calls a task (+ bg) | Eden on the path | Mix $/1k (first-party) | Mix $/1k Zapier MCP |
| --- | --- | --- | --- | --- | --- | --- | --- |
| default | 50/72 | 45 / 8 / 19 | 1 / 0 (1 / 0 confirmed) | 39.48 (+3.01) | 2,169 ms | 0.747 | 1,177.86 |
| `syncCutLive` 4 | 46/72 | 42 / 10 / 20 | 2 / 1 (2 / 0 confirmed) | 21.13 (+2.93) | 2,135 ms | 0.781 | 668.86 |

Paired, `syncCutLive` − default (bootstrap 95%): hidden −0.056 (−0.125..+0.014); control +0.014 (−0.028..+0.069);
connector calls on the mix −19.65 (−22.88..−16.60); mix $/1k +0.034 (+0.005..+0.065), the agent's own tokens (agent
$0.425 → $0.480 per 1,000 tasks; Eden's background $0.331 → $0.303). By seed: hidden 24 → 21 (41), 26 → 25 (42).
Seed 41's planted item reached a packet in 21 and 20 tasks, and the agent raised it from a packet in 19 and 16. Eden's
path by run: 2,170 / 2,195 / 2,140 ms (default) and 2,163 / 2,021 / 2,192 ms (budget). The process ran at CPU p50
291–314% of a core (of 4), RSS 13.2–13.7 GB and heap 10.1–10.6 GB for seed 41 whole (7.6–7.7 GB RSS a seed-42 half);
Eden's path per task is a contended figure. Regraded concerns (Haiku, concerns only) and memory per run are in
`pi-memory-regrade.txt`; per-run spend is the ledger's (`spend.txt`; the reports' own sums differ by under $0.0005).

Priced on market.py's connector plans (list prices, assumed), steady on the 1:1:8 mix, $ per 1,000 tasks:

| Plan | default | `syncCutLive` 4 |
| --- | --- | --- |
| First-party APIs | 0.747 | 0.781 |
| Composio | 14.43 | 8.55 |
| Unified.to | 34.97 | 20.20 |
| Arcade.dev | 456.99 | 259.73 |
| Pipedream Connect | 548.24 | 311.51 |
| Zapier MCP | 1,177.86 | 668.86 |

The default arm's figures match A21's (hidden 52/72, 38.85 calls, 2,258 ms, Zapier $1,178.62) within run noise.

## 3. Calls per user per day (`source-days.bench.ts 1000 300 10`)

Days 2–8, one user, 1,000 sources: all connector calls **1,013.1 → 974.4** a day (sweeps and deep reads 291.9 →
281.3, on-demand polls 199.7 → 176.0, searches 521.6 → 517.1), card calls 195.4 → 171.0. The bench's requests are
about the sources the user uses, whose copies the budget never touches; it is not the funnel's workload.

## 4. Why cards for noise items still cost (A21: $0.319 of $0.794 per 1,000 tasks)

Not measured item by item here. Two paths let a noise item past `cardsSourceAware` (D320): a source `engage`s on
`routeLocalHits` evidence, so a noise connector whose held items share a request's common words becomes "used" and all
its held items go to the card model; and an item naming one of the user's requested people is carded whatever its
source (the sim puts a world person's name in 3% of noise items). The budget cut Eden's live background a little
($0.331 → $0.303 per 1,000 tasks; funnel card calls −6% and −11%). Counting carded items by source and by the
reason they passed the defer is the next measurement.

## 5. What is left

- **Path time at 1,000 sources (D391).** Take every live search off the push: answer the push from the index (cut
  copies as they stand) and run the cut copies' searches behind it, replacing an untaken packet if they find something,
  as `readerPushBehind` does for the poll. The ask, which waits, would keep D264. Hidden facts that live behind a cut
  copy (the ESTA task) are the risk to watch.
- **The budget on more seeds.** Its hidden loss is −4 of 72 with an interval from −9 to +1; a third and fourth seed (or
  `pi-ab --days`) would tell whether it is real. The code is in def8c153. If rebuilt: gate only the push (the trial
  also gated asks and probes; ask-only handovers went 8 → 10, so whether the loss came through asks is not known); an
  ask must not report a gated copy as `"local"` (answered, D127: `localOf` lets an ask answer only from a current,
  whole copy); pick the budget from the searched head of the ranking (the trial picked it from every source, so a
  kept copy outside the head took a slot unsearched: "at most 4" was a bound); and test two synced users.
- **The world's mail is still searched live** (gmail searches a task, both seeds: 3.66 default, 4.50 budget;
  `pi-sources.txt`): its copy stays cut within a short session; `syncEngagedDeep` (D323) reads it whole over time.
- **Memory.** A 1,000-source Pi arm held 13.2–13.7 GB RSS for one seed's six suites: one arm per process, and a seed
  split by suite.

## Reproduce

```bash
unset BUN_OPTIONS
F="bun run funnel --jobs 2 --suite train1,train2,train3,train4,train5,train6"
$F --seeds 41 --json n995-41.json -- --noise-sources 995 --limit 16      # and 42; then, on def8c153:
$F --seeds 41 --set '{"syncCutLive":4}' --baseline n995-41.json -- --noise-sources 995 --limit 16
bun packages/engine/bench/source-days.bench.ts 1000 300 10 [--config='{"syncCutLive":4}']
bun run funnel --jobs 2; bun run eval
R=packages/sim/lab/a28/run.sh; C="--limit 6 --variants hidden,control,neutral --noise-sources 995 --budget 0.3"
$R a28-base-41 eden --seeds 41 $C
$R a28-cut-41 eden~cut --seeds 41 $C --variant-config '{"cut":{"syncCutLive":4}}'
SUITE=train1,train2,train3 $R a28-base-42a eden --seeds 42 $C   # and train4,5,6 as 42b; cut too
S=.local/a28/runs
python3 -I packages/sim/lab/a8/pair.py base=$S/a28-base-41:eden,$S/a28-base-42a:eden,$S/a28-base-42b:eden \
  cut=$S/a28-cut-41:eden~cut,$S/a28-cut-42a:eden~cut,$S/a28-cut-42b:eden~cut --pair base,cut
bun packages/sim/src/lab/pi-cost-report.ts $S/a28-base-41.json $S/a28-base-42a.json $S/a28-base-42b.json  # and cut
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/regrade.ts --results $S/a28-cut-41.json --graders claude-haiku-5-5 \
  --only-concerns --spend-ledger .local/a28/ledger.jsonl --spend-cap 1.5 --spend-headroom 0.1 --out $S/regrade.json
```

## Spend

| Run | $ |
| --- | --- |
| default, seed 41 / 42 (halves) | 0.0869 / 0.0392 + 0.0543 |
| `syncCutLive` 4, seed 41 / 42 (halves) | 0.0859 / 0.0401 + 0.0591 |
| regrades (concerns only) | 0.0003 |
| **Total** | **0.3659** |
