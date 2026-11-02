# The lab: a runbook

How to measure a change to Eden, cheapest first. The code is `packages/sim/src/lab/` (its
[CLAUDE.md](../packages/sim/src/lab/CLAUDE.md) maps every file); the benchmark ledger is [bench/](../bench/README.md);
what was tried before is [research/INDEX.md](research/INDEX.md). Every cost and time below is cited; "measured
2026-11-02" means run while writing this runbook on a 4-core container, other sessions sharing it.

## The ladder

1. `bun run test:changed` and `bun run eval`: seconds, no model.
2. **No-model funnel on train** (`bun run funnel`): under a minute, $0. Most changes stop here or go back.
3. **Funnel with Eden's models live** (judge, reader) on train: cents to about a dollar.
4. **Blind funnel check**, once, pre-registered: the held-out suites, no model.
5. **Live agent A/B** on Pi (and Hermes): dollars, hours.
6. **Full benchmark**: tens of dollars, a day.

## Suites (`suites.ts`)

Every suite plants one item per template into a seeded world (~1,500 items); the hidden variant plants the fact the
agent should raise, the control variant a near-miss decoy (resolved, another entity, prerequisite met). 32 templates
per suite for train1–6 and held-out 10–12.

| Name | Use | Status |
|---|---|---|
| `train` = `train1`–`train6` | **Tune here.** Six authors, written blind, one life area each (broad-set.md) | Tuning set |
| `dev6a`, `dev6b` | Development suites (after D72); two authors, so rules overfit their wording (broad-set.md) | Tuning, with care |
| `hidden`, `heldout`, `heldout2`–`heldout4` | The old in-sample suites; every configuration since D47 was tuned on them | In-sample |
| `heldout5`–`heldout8` | Blind, measurement only | Run many times; contaminated by dev6a/6b templates (D80) |
| `heldout9` | Blind (econ tracks) | Run in D72; contaminated (D80) |
| `heldout10`, `heldout11` | Blind | Run in D80, D85, and several times in the Haiku campaign's funnel (haiku-benchmark.md) |
| `heldout12` | Blind | First run with a strong model in D98 |

- **Never tune on `heldout*`.** `bun run funnel` refuses them without `--blind`. A new blind round needs a new suite
  written by an author who saw no engine code.
- `UNRUN_BLIND` (heldout9–12) keeps them out of `--suite all`, but every one has been run since: treat the list as
  "not in `all`", not as "fresh".
- Seeds: 41–44 for funnel work (41–42 on train), 41–48 for the Haiku benchmark. Same seed, same world, same tasks.

## Configurations (`presets.ts`)

| Preset | What | Decision | Needs |
|---|---|---|---|
| `H` | Probes, grounds, conflict, probe economy, dense packets, `quietNameOnly`, `judgeTied` | D55 | — |
| `ALL3` | H + consequence/role probes, graph, cards, anticipation, sync, ask verdicts, conflict vocabulary, compaction, ask dedup, `cardsEconomy` | D80 | `--cards` (replayed) |
| `ALL5` | ALL3 + intent, bridging query, `askGuard`, `packetBearing` | D92 (open) | `--cards`, `--intent`, `--bridge` (funnel) or a bridge model (live) |
| `NEW` | ALL3 + intent + `askReader` + `askReaderDrop` + `readerPush` — **recommended** | D96, D98 | `--cards`, `--intent`, a reader model (`--reader-model`, or `--reader replay --reader-cache F` in the funnel) |

Every flag is off by default in production; presets exist only in the lab. `--set '{"flag":true}'` (funnel) or
`--variant-config '{"X":{...}}' --conditions eden,eden~X` (pi-ab, hermes-ab) adds flags; `eden+flag` is shorthand
for one.

## Harnesses

| Harness | Command | What it measures |
|---|---|---|
| No-model funnel | `hidden-funnel.ts` (`bun run funnel` wraps it) | Per task: planted item returned, cached, delivered; with `--ask`, cited by an ask; decoy delivered on controls; source calls and ms per task. Deterministic at `--time 0` |
| Pi (standard agent) | `pi-ab.ts` | A live agent (pi-agent-core 1.3.0) under conditions `none, tools, eden, both[-judge][~variant][+flag][@w<ms>]`, graded by a second model; per-task timelines |
| Hermes | `hermes-ab.ts --hermes-src DIR` | Hermes Agent alone (`hermes`) vs with Eden as MCP server + plugin (`hermes+eden[~variant]`); same tasks, grader and results format as Pi |
| In-house loop | `agent-ab.ts` | The pre-Pi loop; label any result from it as such (CLAUDE.md) |
| Simulation | `bun run sim`, `bun run sim:perf` | Generated sessions (recall, precision, false fires) and the real server under load |
| Connector lab | `bun run sim:lab:build && bun run sim:lab` | Real MCP servers in Docker over seeded backends |

Reports: `pi-ab-report.ts` (critical path, per-second profile, CPU; Hermes too), `agent-ab-report.ts` (shared tables,
`--record <label>` into the ledger), `act-report.ts` (`--act` runs), `timeline-report.ts` (funnel timelines),
`bench-compare.ts` (ledger entries).

## Replay caches: make once, replay free

| Cache | Made by | Replayed with | Checked in |
|---|---|---|---|
| Cards (dev/held-out worlds) | `cards-enrich.ts` | `--cards packages/sim/lab/cards/cards-v2.jsonl` | yes |
| Cards (train worlds, 746 items, 75 calls, $0.0233 on glm-5.3-flash; broad-set.md) | `cards-enrich.ts --funnel train --seeds 41,42` | `cards-train.jsonl` (merge with v2: `bun run funnel` does) | yes |
| Cards, price-routed batch 20 | `cards-enrich.ts --sort price --batch 20` | `econ-price20-v2.jsonl` (econ-background.md) | yes |
| Intent requests (D87) | `cards-enrich.ts --intent --dir D` | `--intent D/intent-v2.jsonl` (needs `--cards`) | no (`.local/haiku/intent/`) |
| Bridge queries (D89) | `bridge-enrich.ts --out F` | `--bridge F` | no |
| Reader calls (D95) | `--reader live --reader-cache F` | `--reader replay --reader-cache F` (a prompt not cached fails open) | no |

`pi-ab.ts`/`hermes-ab.ts` read `--cards FILE` and write cards they had to make live to `--cards-out` (default
`<out>.cards.jsonl`); name that file in later runs. Keep run outputs under `.local/` (git ignores it).

## Scorers (`packages/sim/lab/scripts/`, run with `python3 -I`)

| Script | Input | Output |
|---|---|---|
| `funnel-score.py F.json …` | funnel `--json` files | per suite: hidden surfaced (delivered or ask-cited) and decoys surfaced. `bun run funnel` prints the same |
| `reader-score.py BASE.json RUN.json` | two funnel files on the same tasks | the reader's effect: surfaced base → reader, 2.5 s-capped, flags, latency p50/p90, flag kinds |
| `haiku-bench.py LEDGER.jsonl RUN.json …` | pi-ab/hermes-ab results + timelines + spend ledger | rates per harness, suite group and condition; paired bootstrap CIs; tokens, cache shares; cost by role |

## Providers and money

- **OpenRouter, paid** (`OPENROUTER_API_KEY`): production routing (no data collection, ZDR, D12). Eden's default
  model `z-ai/glm-5.3-flash`. pi-ab's default grader is `anthropic/claude-haiku-5.5`, which this account was refused
  (pi-full-benchmark.md): pass `--grader deepseek/deepseek-v4.1-flash` (D64's grader).
- **OpenRouter, free** (`<id>:free`, D91, edge-freelab.md): needs `--allow-logging` (prompts logged; sim data only);
  every request through one pacer, default 18/min (`--rpm`); about 20/min and 1,000/day for the whole account,
  retries counted; cap a run with `--max-requests`. A capped run is PARTIAL and not recorded. Free grader:
  `dots-studio/dots-3-note-preview:free`. Free and paid results are not comparable.
- **Anthropic direct** (`claude-*`, D97): key from `HAIKU_API_KEY`, else `ANTHROPIC_API_KEY`; requires
  `--spend-ledger FILE --spend-cap USD` (one ledger for all parallel processes; `--spend-headroom` each,
  `--run-label` per run). Prompt caching on, thinking off.
- **Budgets:** every live runner takes `--budget` (USD, hard, per process: each call reserves its worst case).
- Never print a key; never put one in a results file or a PR.

## Measurement

- Funnel: `--timeline out.jsonl` records every engine span, each task, and CPU%/RSS per second;
  `bun packages/sim/src/lab/timeline-report.ts out.jsonl` says where the time went. `--spans noop` measures the
  tracer's own cost; `--serial` runs seeds one after another (per-task wall is then its own); `--cpu` prints CPU.
- Pi/Hermes: `--timeline DIR` (tasks.jsonl, samples.jsonl) then `pi-ab-report.ts results.json`: Eden's time on the
  agent's critical path, per-second profile (moon-pi.md, haiku-benchmark.md "Where the time goes").
- `--time 0` (default) answers sources instantly; `--time 1` / `--time-scale 1` uses the profiles' assumed latency.
- Engine spans (`config.spans`, D56) are content-free and change no decision.

## Recipes

### 1. Screen a change on train, no model (measured 2026-11-02)

```bash
bun run funnel --json .local/base.json                       # ALL3, train1-6, seeds 41,42: 36 s
# ... change the engine, or add a flag:
bun run funnel --set '{"myFlag":true}' --baseline .local/base.json --json .local/new.json
```

ALL3 on train, seeds 41–42: hidden 214/384, decoys 211/384 (the same as broad-set.md's "cards for every prefiltered
item" row). `--preset H` takes 9 s; `--suite train1 --seeds 41` takes 3 s; `--suite dev6a,dev6b --seeds 41,42,43,44`
takes 22 s (122/240 hidden, 91/240 decoys). The `--baseline` diff lists every task that moved. A gain that is a
coin flip between hidden and decoys (broad-set.md: rules on unseen writing) is not a gain.

### 2. The same with Eden's reader live (NEW)

```bash
H=.local/haiku   # intent requests and cards as in docs/research/haiku-opt.md "Reproduce"
bun run funnel --preset NEW --json $H/new.json -- --intent $H/intent/intent-v2.jsonl --reader live \
  --reader-model claude-haiku-5-5 --reader-cache $H/reader-cache-v5.jsonl \
  --spend-ledger $H/ledger.jsonl --spend-cap 40 --spend-headroom 3
python3 -I packages/sim/lab/scripts/reader-score.py .local/base.json $H/new.json
```

Cost: one reader call per acting ask, about $0.0004 on Haiku (haiku-benchmark.md); Phase 1 of the Haiku campaign,
reader and intent requests for train and held-out 10–11 included, spent $1.39 (haiku-opt.md). Reruns replay from the
reader cache at $0. The haiku-opt.md command sets `askReaderWaitMs: 60000` so latency does not decide what is read.

### 3. Blind check (once, pre-registered)

Write the bar down first (econ-synthesis.md, gen-combined.md and smart-combined.md are the pattern), then:

```bash
bun run funnel --blind --suite heldout5,heldout6,heldout7,heldout8 --seeds 41,42,43,44 --json .local/blind.json
```

No model, $0; time scales with tasks (estimate from recipe 1: well under a minute per suite and four seeds). Report
the result whatever it says, and do not tune afterwards on what you read.

### 4. Live A/B on Pi

One seed per process (a single process for four seeds over nine suites was killed at 14 GB; pi-full-benchmark.md).

```bash
bun packages/sim/src/lab/pi-ab.ts --suite train --seeds 41 --variants hidden,control \
  --conditions tools,eden,eden~X --config ALL3 --variant-config '{"X":{"myFlag":true}}' \
  --cards packages/sim/lab/cards/cards-train.jsonl --grader deepseek/deepseek-v4.1-flash --budget 1 \
  --timeline .local/pi-41 --out .local/pi-41.json
bun packages/sim/src/lab/pi-ab-report.ts .local/pi-41.json
bun packages/sim/src/lab/agent-ab-report.ts .local/pi-41.json
```

Expectations from past runs: on glm-5.3-flash, one seed over dev and held-out 1–4 cost $0.12–0.13 per process
(econ-uptake.md) and about four minutes (econ-oneturn.md); D64's full benchmark was 16,346 runs for $8.75. On Haiku 5.5,
an agent task plus Eden NEW is $0.79 per 1,000 hidden tasks in Pi, ALL3 $0.36 (haiku-benchmark.md); wall p50 about
4 s a task. Free models: a 4-task smoke took 16 requests and 20.8 s (edge-freelab.md); add `--allow-logging
--max-requests N` and free model ids.

### 5. Live A/B on Hermes

```bash
bun packages/sim/src/lab/hermes-ab.ts --hermes-src $HERMES --concurrency 6 --suite train --seeds 41 \
  --variants hidden,control --conditions hermes,hermes+eden,hermes+eden~X --config ALL3 \
  --variant-config '{"X":{"myFlag":true}}' --cards packages/sim/lab/cards/cards-train.jsonl \
  --grader deepseek/deepseek-v4.1-flash --budget 1 --timeline .local/h-41 --out .local/h-41.json
bun packages/sim/src/lab/pi-ab-report.ts .local/h-41.json
```

`$HERMES` is a hermes-agent checkout with `<src>/.venv` (`uv sync --frozen --no-install-project`). Hermes' prompt is
about 3× Pi's input tokens per request; on free models tasks after a stream's first averaged 22–26 s, and the full
nine-suite bench was estimated at 2.6 h at concurrency 6 if the rate limit does not bind, 7.6 h at 18 requests a
minute on free models (hermes-lab.md, estimates).

### 6. Full benchmark (blind, both harnesses)

The Haiku benchmark's commands, one seed and suite group per process, at most three processes at once
(haiku-benchmark.md "Reproduce"; `packages/sim/lab/haiku/run.sh` and `queue.sh` drive them):

```bash
H=.local/haiku; HC=6 HAIKU_DIR=$H bash packages/sim/lab/haiku/queue.sh 3 jobs.txt   # lines: "pi|hermes SUITES SEED LABEL"
python3 -I packages/sim/lab/scripts/haiku-bench.py $H/ledger.jsonl $H/p2/runs/*.json
```

Its scale: blind held-out 5–8 and 10–12, seeds 41–48, 1,400 hidden and 1,400 control tasks per condition, five Pi and
three Hermes conditions; $18.46 for the main matrix and $24.36 for the whole campaign (haiku-benchmark.md).

## Recording

- Funnel and `bench.ts` runs go to `bench/ledger.jsonl` unless `--no-record` (`bun run funnel` records only with
  `--record`). Live runs are recorded with `agent-ab-report.ts --record <label>`. A dirty tree is marked `dirty`.
- Every number in a PR or doc comes from a command run in that session (CLAUDE.md); say in-sample or blind.
