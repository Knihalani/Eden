# Eden before and after the 2026-11-02..04 campaign: the same lab, two engines

## In plain words

We ran the same benchmark on two versions of Eden. **Before** is the engine as it stood on 2026-11-02 (commit
18366d039, PR #198), before this campaign started. **After** is the engine on main today (bf2fc13, PR #222). Each run
used the same harness, prompts, grader, model and tasks. Only the engine changed. The tasks were 32 blind held-out
tasks (held-out 13) in four generated worlds. In each world the agent had 32 tasks where a hidden fact mattered and
32 look-alike tasks where nothing should be raised. Every model involved was Claude Haiku 5.5: the agent, the grader
and Eden's own model roles. We ran on both standard agent harnesses, Pi and Hermes Agent.

- **Eden now finds 1.6 to 6.6 times as many hidden facts as it did before** (2.7× the old default and 1.6× old ALL3
  on Pi; 6.6× and 2.1× on Hermes). On Pi the agent raised the hidden fact
  in 72.7% of tasks with today's Eden. It raised 27.3% with the old built-in default and 45.3% with the old
  recommended lab configuration (ALL3). On Hermes the figures were 67.2%, 10.2% and 32.0%. Agents with no Eden raised
  7.0% (Pi) and 4.7% (Hermes). All four after-versus-before gains are well outside the noise (paired 95% intervals
  +18 to +66 points).
- **It still does not cry wolf.** On the look-alike tasks, today's Eden raised a false concern once in 256 runs
  (Pi 1/128, Hermes 0/128). Old ALL3 raised 2/128 on Pi; the old default raised none.
- **It is faster than the old default when there is something to find, and a little slower than old ALL3.** On hidden
  tasks the median answer took 3.4 s on Pi, against 5.0 s for the old default and 3.9 s for old ALL3. Paired, that is
  1.0 s faster than the old default and 0.3 s slower than ALL3. On look-alike tasks today's Eden is slower:
  1.3 s more than ALL3 on Pi. It reads the candidates with a model before answering (the reader). Neither old
  configuration did that.
- **It costs more per task, but still well under a tenth of a cent.** Agent plus Eden came to $0.61–0.83 per 1,000
  tasks on Pi, against $0.33–0.40 for the old configurations and $0.33–0.35 with no Eden. Of that, Eden's reader is
  $0.30–0.44 per 1,000. Today's Eden also makes cards in the background. In this run that was a one-time catch-up of
  $0.90 per 1,000 tasks, an upper bound (see "Costs" below).
- **It holds 30% less memory per user** (1,276 KB against 1,825 KB for a synced user with 500 items).
- **It calls the user's sources a quarter as often as the old default** (3.6 calls per task against 14.4 on Pi). That
  is about the same as old ALL3, which also synced in the background.
- **The test suite grew from 1,270 to 1,499 tests and runs in 50 s instead of 57 s.**

Total spent: **$2.21** of the $12 cap, including $0.34 on a discarded first BEFORE run (see "What went wrong").

## What was compared

| Arm | Engine | Configuration |
|---|---|---|
| AFTER | main at bf2fc13 (D112, D119–D124) | `--config default`: the one shipped default (`DEFAULT_CONFIG`, cards, intent, sync, the reader with its gate) |
| BEFORE-default | 18366d039 | `--config default` = `{}`: that engine's built-in `DEFAULT_CONFIG` (every experimental flag off), what shipped then |
| BEFORE-ALL3 | 18366d039 | ALL3 (D80), that tree's recommended lab configuration, copied verbatim from its `presets.ts` (H + cards, sync, graph, …) |
| agent alone | — | Pi with its search tools (`tools`) / Hermes with its MCP search tools (`hermes`); run in both trees as a check |

**Method.** The BEFORE tree is a worktree of 18366d039. Main's lab (bf2fc13) is laid over it: `packages/sim`,
`packages/llm` (the Anthropic provider, D97), `packages/eval`, `ingest.bench.ts` and the root package files. A lab-only
shim (`packages/sim/src/before-engine.ts`) stubs the few names the lab imports that the old engine lacked: the reader
classes, `PARTS`, `CORE_CONFIG` and `checkEngineConfig`. Neither old configuration reaches them, because neither has
`askReader`. `git diff 18366d039 -- packages/{engine,graph,sources,primitives,redact,protocol,client}` is empty in that
tree, so every product package is the old one. `packages/sim/lab/before-after/make-before-tree.sh` rebuilds the tree.
`analyze.py` in the same directory makes the tables. Its rates, walls, critical path and source calls match
`pi-ab-report.ts` on the same files.

**Same flags for every arm:** suite `heldout13` (blind, never tuned on), seeds 41–44 (one process per seed and tree),
`--variants hidden,control`, `--time-scale 1` (sources take their profiles' assumed latency), `--config default`, and
for BEFORE-ALL3 `--variant-config '{"A":<ALL3>}'`. Agent, grader, card and reader models are all `claude-haiku-5-5`
through the lab's Anthropic provider, on one spend ledger (`--spend-cap 12`). Cards are replayed from
`packages/sim/lab/cards/cards-v2.jsonl` (4,634 cards), and misses are made live. Intent requests are made live with the
cards: no `--intent` replay file was given to either tree. Hermes Agent ran at commit 06433066 with
`--concurrency 3`. Each harness ran 128 hidden and 128 control tasks per arm.

**What differs between the trees besides the engine:**
- The product packages the engine depends on (`graph`, `sources`, `primitives`, `redact`, `protocol`) and `client`
  (the lab uses its `heldResult`) are the old ones in BEFORE. These count as "the engine" here.
- The lab-only shim and the old `presets.ts` (above).
- **Card replay is not equally warm.** The old ALL3 card prompt matches the checked-in `cards-v2.jsonl`, so it made
  only 34–46 cards live per seed. Today's card prompt differs (intent requests, card version 2 and the date fix of
  `datedOf`), so it made 1,354–1,385 live per seed. Quality is unaffected, because cards are made live on a miss.
  AFTER's background cost is therefore a cold-cache figure (see "Costs").
- **Held-out 13 is blind for both engines but not unseen:** D112 and D123 ran today's default on it before (its
  hidden rate there: 73.4%), and D98 had a strong model read it. Nothing was tuned on it.
- **The machine:** Pi ran both trees at once (8 processes on 4 cores). Hermes ran two seeds at a time, both trees at
  once. Wall times are comparable within a harness, not across harnesses.

## Pi (the standard agent): held-out 13, seeds 41–44

| Arm | Hidden raised | False concerns | Wall p50/p90 hidden (s) | Wall p50/p90 control (s) | Eden on the critical path, mean ms | TTFT p50 ms | Agent tokens in/out per task | Cache-read share | Agent + Eden live $/1k hidden / control | Background $/1k | All-in $/1k | Eden source calls/task | Agent search calls/task | Peak RSS / heap MB (process) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **AFTER (default, now)** | **72.7% (93/128)** | **0.8% (1/128)** | **3.42 / 6.27** | 5.27 / 7.11 | 1,655 | 544 | 1,550 / 420 | 70.4% | 0.605 / 0.827 | 0.899 | 1.615 | 3.61 | 0.87 | 352 / 180 |
| BEFORE-default | 27.3% (35/128) | 0.0% (0/128) | 5.04 / 6.03 | 5.06 / 5.90 | 1,556 | 537 | 2,310 / 492 | 51.0% | 0.403 / 0.395 | 0 | 0.399 | 14.41 | 1.46 | 455 / 276 |
| BEFORE-ALL3 | 45.3% (58/128) | 1.6% (2/128) | 3.85 / 4.86 | 3.91 / 4.82 | 461 | 528 | 1,891 / 487 | 65.5% | 0.327 / 0.348 | 0.047 | 0.384 | 3.75 | 1.26 | 455 / 276 |
| Pi alone (`tools`) | 7.0% (9/128) | 0.0% (0/128) | 4.11 / 5.87 | 4.17 / 5.89 | 0 | 551 | 2,600 / 516 | 81.5% | 0.333 / 0.345 | 0 | 0.339 | 0 | 3.41 | 352 / 180 |
| Pi alone, BEFORE tree | 7.0% (9/128) | 0.0% (0/128) | 4.04 / 5.90 | 4.06 / 6.05 | 0 | 540 | 2,641 / 523 | 82.1% | 0.332 / 0.353 | 0 | 0.342 | 0 | 3.40 | 455 / 276 |

Paired differences (a − b) over the same 128 task ids, bootstrap 95% interval (4,000 resamples):

| a − b | kind | hidden fact / false concern (points) | wall (s) | agent + Eden live $/1k |
|---|---|---|---|---|
| AFTER − BEFORE-default | hidden | **+45.3 (+35.2..+54.7)** | −1.03 (−1.31..−0.73) | +0.201 (+0.148..+0.260) |
| AFTER − BEFORE-default | control | +0.8 (+0.0..+2.3) | +0.16 (−0.12..+0.44) | +0.432 (+0.377..+0.489) |
| AFTER − BEFORE-ALL3 | hidden | **+27.3 (+18.0..+36.7)** | +0.29 (+0.02..+0.56) | +0.278 (+0.222..+0.334) |
| AFTER − BEFORE-ALL3 | control | −0.8 (−3.9..+1.6) | +1.27 (+1.03..+1.53) | +0.479 (+0.424..+0.535) |
| AFTER − Pi alone | hidden | **+65.6 (+57.0..+74.2)** | −0.15 (−0.46..+0.16) | +0.272 (+0.215..+0.333) |
| AFTER − Pi alone | control | +0.8 (+0.0..+2.3) | +0.83 (+0.51..+1.16) | +0.481 (+0.421..+0.544) |
| AFTER − Pi alone (BEFORE tree) | hidden | +65.6 (+56.2..+74.2) | −0.12 (−0.45..+0.21) | +0.273 (+0.218..+0.332) |
| AFTER − Pi alone (BEFORE tree) | control | +0.8 (+0.0..+2.3) | +0.89 (+0.56..+1.23) | +0.474 (+0.414..+0.536) |

**The two trees' labs are the same.** Pi alone raised 9/128 hidden facts in each tree, with the same tokens, calls and
walls within noise. Both results files carry the same `promptsHash` (00a17863458a8419) and harness version
(`@earendil-works/pi-agent-core@1.3.0`).

From `pi-ab-report.ts` (hidden tasks only; the table above pools hidden and control where marked):

| Arm | Agent tokens in / out (hidden) | Model calls | Eden slow path p50 / p90 ms | Ask p50 ms | Items injected/task | Critical path: Eden / model / tool (mean ms, all tasks) |
|---|---|---|---|---|---|---|
| AFTER | 1,293 / 389 | 1.34 | 16 / 31 | 1,004 | 0.97 | 1,655 (37%) / 2,853 / 0 |
| BEFORE-default | 2,314 / 500 | 1.92 | 668 / 1,179 | 746 | 0.14 | 1,556 (31%) / 3,387 / 0 |
| BEFORE-ALL3 | 1,834 / 479 | 1.74 | 472 / 934 | 19 | 0.65 | 461 (12%) / 3,266 / 0 |
| Pi alone | 2,523 / 506 | 2.07 | — | — | — | 0 / 3,452 / 715 |

Reading:
- **Quality.** AFTER's 72.7% on Pi matches its D123 record on the same suite (73.4%, seeds 41–42) and its D112 record.
  So today's figure is stable. The old default's 27.3% comes from a few asks answered from live searches: 14.4 source
  calls per task and 0.14 items injected. Old ALL3's 45.3% comes from rules, cards and the background sync.
- **Speed.** Old ALL3 had Eden on the critical path least (461 ms). Its background sync answered asks from the local
  index (ask p50 19 ms), and it ran no model on the path. AFTER spends 1,655 ms there, mostly the reader's call
  (ask p50 1,004 ms). That call is what makes hidden tasks raise their fact, and on control tasks it is the 1.3 s cost
  over ALL3. AFTER's slow path itself is 40 times quicker (16 ms against 668 ms for the old default). On hidden tasks
  the agent then needs fewer turns (1.34 model calls against 1.92), which is why AFTER beats the old default's wall
  time.
- **Tokens.** With Eden today the agent reads 1,293 prompt tokens per hidden task, against 2,523 with no Eden and
  2,314 with the old default. It searches less because Eden has already answered.

## Hermes Agent: held-out 13, seeds 41–44

| Arm | Hidden raised | False concerns | Wall p50/p90 hidden (s) | Wall p50/p90 control (s) | Eden on the critical path, mean ms | TTFT p50 ms | Agent tokens in/out per task | Cache-read share | Agent + Eden live $/1k hidden / control | Background $/1k | All-in $/1k | Eden source calls/task | Agent search calls/task |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **AFTER (default, now)** | **67.2% (86/128)** | **0.0% (0/128)** | **3.25 / 8.18** | 5.43 / 9.15 | 1,313 | 521 | 7,032 / 413 | 87.2% | 0.624 / 0.726 | 0.886 | 1.561 | 3.61 | 1.88 |
| BEFORE-default | 10.2% (13/128) | 0.0% (0/128) | 5.34 / 9.00 | 5.19 / 8.18 | 1,040 | 534 | 7,922 / 429 | 87.7% | 0.413 / 0.400 | 0 | 0.406 | 6.93 | 2.48 |
| BEFORE-ALL3 | 32.0% (41/128) | 0.0% (0/128) | 3.74 / 7.44 | 4.67 / 7.08 | 431 | 516 | 7,526 / 424 | 87.5% | 0.376 / 0.416 | 0.046 | 0.442 | 3.73 | 2.16 |
| Hermes alone | 4.7% (6/128) | 0.0% (0/128) | 4.06 / 6.62 | 4.12 / 6.20 | 0 | 510 | 6,868 / 399 | 89.1% | 0.363 / 0.346 | 0 | 0.354 | 0 | 2.50 |
| Hermes alone, BEFORE tree | 5.5% (7/128) | 0.0% (0/128) | 4.13 / 6.13 | 4.13 / 6.21 | 0 | 526 | 6,883 / 398 | 89.9% | 0.344 / 0.351 | 0 | 0.347 | 0 | 2.44 |

| a − b | kind | hidden fact / false concern (points) | wall (s) | agent + Eden live $/1k |
|---|---|---|---|---|
| AFTER − BEFORE-default | hidden | **+57.0 (+47.7..+65.6)** | −0.83 (−1.28..−0.40) | +0.211 (+0.161..+0.261) |
| AFTER − BEFORE-default | control | +0.0 (+0.0..+0.0) | +0.46 (+0.08..+0.86) | +0.326 (+0.283..+0.372) |
| AFTER − BEFORE-ALL3 | hidden | **+35.2 (+25.8..+44.5)** | +0.40 (+0.04..+0.75) | +0.248 (+0.200..+0.297) |
| AFTER − BEFORE-ALL3 | control | +0.0 (+0.0..+0.0) | +0.84 (+0.46..+1.23) | +0.310 (+0.264..+0.359) |
| AFTER − Hermes alone | hidden | **+62.5 (+53.9..+71.1)** | +0.35 (−0.08..+0.78) | +0.261 (+0.208..+0.316) |
| AFTER − Hermes alone | control | +0.0 (+0.0..+0.0) | +1.40 (+1.03..+1.78) | +0.380 (+0.331..+0.430) |
| AFTER − Hermes alone (BEFORE tree) | hidden | +61.7 (+53.1..+70.3) | +0.49 (+0.08..+0.90) | +0.280 (+0.228..+0.333) |
| AFTER − Hermes alone (BEFORE tree) | control | +0.0 (+0.0..+0.0) | +1.56 (+1.23..+1.89) | +0.375 (+0.327..+0.424) |

Notes:
- Hermes alone raised 6/128 in one tree and 7/128 in the other, which is within noise. Hermes ran in its own Python
  workers (one per stream). The first task of each stream pays the worker's start-up, and these walls include it in
  every arm alike. Hermes has no per-second process samples, so it has no memory column.
- Hermes's own prompt is about 7,000 tokens, so the agent's tokens hardly move with Eden. 87–90% of them are read from
  the prompt cache in every arm.
- The old default does worse on Hermes than on Pi (10.2% against 27.3%), and AFTER keeps most of its Pi figure
  (67.2%). Today's default reaches the agent through the plugin's packets as well as through asks.

## Costs: dollars per 1,000 tasks, labelled

| Arm | Agent | Eden per task (the reader) | Background (cards, intent), spread over the arm's tasks | All-in |
|---|---|---|---|---|
| Pi AFTER | 0.278 | 0.438 | 0.899 (cold-cache upper bound) | 1.615 |
| Pi BEFORE-default | 0.399 | 0 | 0 | 0.399 |
| Pi BEFORE-ALL3 | 0.337 | 0 | 0.047 (warm replay) | 0.384 |
| Pi alone | 0.339 | 0 | 0 | 0.339 |
| Hermes AFTER | 0.380 | 0.295 | 0.886 (cold-cache upper bound) | 1.561 |
| Hermes BEFORE-default | 0.406 | 0 | 0 | 0.406 |
| Hermes BEFORE-ALL3 | 0.396 | 0 | 0.046 (warm replay) | 0.442 |
| Hermes alone | 0.354 | 0 | 0 | 0.354 |

The agent and Eden per-task columns are pooled over hidden and control tasks.

**Background** is what the cards (and their intent requests) cost in this run, divided over the arm's 256 task runs.
It is mostly a one-time backfill of each world's items. AFTER missed the checked-in card cache on almost every item
(its prompt changed since the cache was made, see above), so it paid for about 1,370 cards per seed. Old ALL3 hit the
cache and paid for about 40. In a deployment, each item is carded once in its lifetime, not once per task. So the
steady-state background cost per task is far below either figure (D123 recorded $0.459 per 1k for the same default).
This run measured it only as an upper bound. Eden's own spend on Pi AFTER was $0.230 for cards and $0.112 for the
reader over 512 task runs (four seeds). On Hermes AFTER it was $0.227 and $0.076.

## The $0 checks, both trees

| Check | BEFORE (18366d039) | AFTER (bf2fc13) | Notes |
|---|---|---|---|
| `bun run eval` (no model), each tree's own eval | 27 scenarios: precision 1.000, recall 0.444, false-fire 0 | 31 scenarios: precision 0.828, recall 0.480, false-fire 0 | Different scenario sets: main added four "large look-alike" scenarios |
| main's eval (31 scenarios) on the old engine, default | precision 0.889, recall 0.480, false-fire 0 | precision 0.828, recall 0.480, false-fire 0 | The eval wires no reader or cards, so AFTER's reader, cards and intent are inert here (it says so). This is the no-model fast path, not the product |
| main's eval on the old engine, ALL3 | precision 0.800, recall 0.480, false-fire 0.0147 | — | cards inert (no card maker) |
| `bun run funnel` train1–6, seeds 41–42 (TOTAL hidden / decoys surfaced of 384) | default 122 / 127; ALL3 214 / 211 | default 214 / 211 (658 reader calls) | `--reader stub` for AFTER (the reader says nothing binds), so AFTER's funnel shows its rule paths only, which equal old ALL3's here. The live runs above are the measure |
| funnel: delivered hidden / decoys before the first model call | default 24 / 42; ALL3 97 / 72 | 97 / 72 | same caveat |
| funnel: source calls per task (merged) | default 9.2; ALL3 3.2 | 3.1 (amortised total 4.33) | |
| `ingest.bench.ts 200 500`: memory per synced user | **1,825 KB** (3,737 B/item), 3 runs identical | **1,276 KB** (2,614 B/item), 3 runs identical | −30%: the packed index (D111, D120) and the cheaper graph (D107) |
| `ingest.bench.ts`: backfill CPU per item | 121.9–126.6 µs | 131.0–141.2 µs | AFTER 7–11% slower to ingest. BEFORE's copy counts items per tick, which costs it a little, so the gap may be slightly larger than shown. The unchanged sweep was not measured on BEFORE (the old sync has no listing counter) and is 4.5–4.9 µs/item on AFTER |
| `bun run check` (format, types, all tests) | 57.3 s wall, 1,270 tests, 0 fail | 50.1 s wall, 1,499 tests, 0 fail | Same container, one at a time |

## What went wrong, and other honesty notes

- **A first BEFORE run was discarded.** This container's local `main` branch was stale (#214). The first lab overlay
  came from it, and its `tools` arm used different prompts (2,405 against 1,629 input tokens in the pilot). Those four
  processes were stopped and their results moved aside. That cost $0.337. Everything above uses the lab from
  bf2fc13 (origin/main).
- **Pi's wall times are under load.** Pi's eight processes (both trees, four seeds) ran at once on four cores. The
  BEFORE processes started about 15 minutes after the AFTER ones, so they overlapped only in part. Both "alone" arms
  give the same walls (4.11 against 4.04 s hidden p50), so the load did not favour either tree.
- **The peak RSS column is per process** (all of a process's arms at once), not per user. Memory per user is the
  `ingest.bench` row.
- **One harness version, one model, one suite.** Haiku 5.5 everywhere. Held-out 13 is 32 templates. Four seeds give
  128 tasks per kind and arm. A different agent model can move these figures (haiku-phase3.md).
- **No decision changes.** This is a measurement: no engine behaviour or default changed, so no decision row was added.

## Spend

| Part | $ |
|---|---|
| Pi AFTER (4 seeds: tools + default) | 0.533 |
| Pi BEFORE (4 seeds: tools + old default + old ALL3) | 0.338 |
| Hermes AFTER (4 seeds: hermes + default) | 0.520 |
| Hermes BEFORE (4 seeds: hermes + old default + old ALL3) | 0.350 |
| Pilots (Pi and Hermes, both trees) | 0.138 |
| Discarded first BEFORE run (stale lab) | 0.337 |
| **Total (spend ledger)** | **2.215** |

## Reproduce

```bash
git fetch origin main
packages/sim/lab/before-after/make-before-tree.sh ../eden-before origin/main  # BEFORE tree; empty product diff
A="{\"A\":$(cd ../eden-before && bun -e 'import {PRESETS} from "./packages/sim/src/lab/presets.ts";
  console.log(JSON.stringify(PRESETS.ALL3))')}"
W=.local/fba; L="--spend-ledger $W/ledger.jsonl --spend-cap 12 --spend-headroom 0.3"
H="--card-model claude-haiku-5-5 --reader-model claude-haiku-5-5 --model claude-haiku-5-5 --grader claude-haiku-5-5"
C="--cards $PWD/packages/sim/lab/cards/cards-v2.jsonl"
COMMON="--suite heldout13 --variants hidden,control --time-scale 1 --config default"
for S in 41 42 43 44; do   # one process per seed and tree
  bun packages/sim/src/lab/pi-ab.ts $COMMON --seeds $S $C --cards-out $W/pi/after-$S.cards.jsonl $H \
    --conditions tools,eden $L --budget 1 --timeline $W/pi/after-$S --out $W/pi/after-$S.json &
  (cd ../eden-before && bun packages/sim/src/lab/pi-ab.ts $COMMON --seeds $S --variant-config "$A" $C \
    --cards-out $OLDPWD/$W/pi/before-$S.cards.jsonl $H --conditions tools,eden,eden~A $L --budget 1 \
    --timeline $OLDPWD/$W/pi/before-$S --out $OLDPWD/$W/pi/before-$S.json) &
done; wait
# Hermes: the same with hermes-ab.ts --hermes-src $HERMES --concurrency 3, conditions hermes,hermes+eden (AFTER) and
# hermes,hermes+eden,hermes+eden~A (BEFORE), two seeds at a time.
a=$(echo $W/pi/after-4{1,2,3,4}.json | tr ' ' ,); b=$(echo $W/pi/before-4{1,2,3,4}.json | tr ' ' ,)
python3 -I packages/sim/lab/before-after/analyze.py $W/pi.md "AFTER=$a:eden" "BEFORE-default=$b:eden" \
  "BEFORE-ALL3=$b:eden~A" "Pi alone=$a:tools" "Pi alone, BEFORE tree=$b:tools"
# $0 checks: in each tree, bun run eval; bun run funnel --jobs 4 [--preset ALL3];
# bun packages/engine/bench/ingest.bench.ts 200 500; time bun run check (BEFORE: a clean worktree of 18366d039).
```
