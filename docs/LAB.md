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

| Name                                       | Use                                                                                                   | Status                                                                                                                   |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `train` = `train1`–`train6`                | **Tune here.** Six authors, written blind, one life area each (broad-set.md)                          | Tuning set                                                                                                               |
| `dev6a`, `dev6b`                           | Development suites (after D72); two authors, so rules overfit their wording (broad-set.md)            | Tuning, with care                                                                                                        |
| `hidden`, `heldout`, `heldout2`–`heldout4` | The old in-sample suites; every configuration since D47 was tuned on them                             | In-sample                                                                                                                |
| `heldout5`–`heldout8`                      | Blind, measurement only                                                                               | Run many times; contaminated by dev6a/6b templates (D80)                                                                 |
| `heldout9`                                 | Blind (econ tracks)                                                                                   | Run in D72; contaminated (D80)                                                                                           |
| `heldout10`, `heldout11`                   | Blind                                                                                                 | Run in D80, D85, and several times in the Haiku campaign's funnel (haiku-benchmark.md)                                   |
| `heldout12`                                | Blind                                                                                                 | First run with a strong model in D98                                                                                     |
| `heldout14`                                | Blind, RealUse-1's (benchmark-realuse-1.md); 32 templates over 8 life areas, with a `neutral` variant | Run once for RealUse-1 (realuse-1/A-heldout14.md)                                                                        |
| `heldout15`                                | Blind, the weak-points plan's (fix-s3b-lab.md); 32 new templates, same areas, with `neutral`          | **Read** (RealUse-2, 2026-11-07: Pi seeds 41–44, Hermes 41–42, the blind funnel); spent                                  |
| `heldout16`                                | Blind, the CL wave's (cl-cl5.md); 32 new templates over the same 8 areas, with `neutral`              | **Read** (RealUse-3 Pi, 2026-11-07, realuse-3/pi-heldout16.md): no longer blind; cards and intent cached for seeds 41–44 |
| `heldout17` | Blind, the end-of-day confirmation's (a19-heldout17.md, D350); 32 new templates over the same 8 areas, with `neutral`; 8 late-arrival templates (`HELDOUT17_LATE`, for `--late`) | **Unrun**; cards and intent cached for seeds 41–44 |

**The `neutral` variant** (held-out 14–17 and, since CL5, train1–6; `neutral.ts`, `NEUTRAL_SUITES`): the same request
as `hidden` and `control` with nothing planted. The train suites get it from `withNeutral` in suites.ts (the control
planted and taken out again, ids `<suite>-neutral`), so tuning can measure nothing-to-add turns without a held-out
suite; their neutral worlds add no item the hidden and control worlds lack, so the card and intent replays cover them
as they cover the rest, and the paid reader replay covers seeds 41–42 (recipe 2a). `bun run funnel ... -- --neutral` prints NEUTRAL lines (any packet delivered, items,
bytes, ask items, calls, ms per task) and a JSON `neutral` block, never mixed into the score; `pi-ab.ts` and
`hermes-ab.ts` take `--variants hidden,control,neutral` (other suites skip neutral), the grader counts any concern on
a neutral task as a false one, and `pi-ab-report.ts` adds a `neutral` table and the RealUse-1 traffic mix (1 hidden,
1 control, 8 neutral in 10; an assumption). An older suite asked for `neutral` throws.

- **Never tune on `heldout*`.** `bun run funnel` refuses them without `--blind`. A new blind round needs a new suite
  written by an author who saw no engine code.
- `UNRUN_BLIND` (held-out 9–16) keeps them out of `--suite all` so a tuning command cannot spend them, but all five
  have been read (D72, D80, D85, D98, D112), 14 by RealUse-1 and 15 by RealUse-2: treat the list as "not in `all`",
  not as "fresh". Held-out 16 is the one unread suite: running it at all (funnel or agent) spends it.
- Seeds: 41–44 for funnel work (41–42 on train), 41–48 for the Haiku benchmark. Same seed, same world, same tasks.

## Configurations (`presets.ts`)

One product (D112): the engine's `DEFAULT_CONFIG` is the configuration, and the presets are made from it, never
written by hand.

| Preset         | What                                                                                                                                                                                                                                                                                         |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `default`      | The unified default: NEWL (D99) plus poll behind, small poll pages, no probe grace, the push's reader not waiting for the poll (D112). Cards, intent and the reader need their dependencies (`--cards`, `--intent`, a reader); without them they are inert, as in a server with no model key |
| `minus-<part>` | The default with one of `PARTS` (`packages/engine/src/parts.ts`) taken out: probes, grounds, fallback, compaction, sync, freshness, cards, intent, reader, probeGrace (D229; graph, askVerdicts, anticipate and slowPathQueue were deleted by D225–D228, and judge left `PARTS`)             |
| `minus-all`    | The default with every part taken out: `CORE_CONFIG`, the no-feature core (the old production default; since D229 it keeps the judge's settings at their default values, which only a lab run with a judge wired reads)                                                                      |

A trial (DECISIONS.md, "Trial switches") is measured as `--set '{...}'` over `default` (funnel) or
`--variant-config '{"X":{...}}' --conditions eden,eden~X` (pi-ab, hermes-ab, whose `--config` defaults to `default`);
`eden+flag` is shorthand for one flag. The measured history (H, ALL3, NEW, NEWL, the B/BG variants) lives in the
decisions and research notes; their presets are gone, so commands dated before 2026-11-03 that name them need the
settings written out (`git show 926b094:packages/sim/src/lab/presets.ts`).

**The $0 CLIs are strict** (`bun run funnel`, `hidden-funnel.ts`, `bun run sim`; audit 2026-11-03b). An unknown flag,
a stray argument or a flag missing its value exits 2 before anything runs (`--presett NEWL` used to run the whole ALL3
screen and read "+0 −0", 2026-11-03b); `--help` prints the usage and exits 0 (about 0.15–0.3 s). Engine settings go through
`checkEngineConfig` (@eden/engine), on the preset and `--set` merged: an unknown key (`fallbackAsk`), a wrong type, an
out-of-range number, or a child flag set on (off the core's value) whose parent the merged configuration has off
exits 2 naming it. So `--preset minus-sync --set '{"syncPollBehind":true}'` is refused (the flag would do nothing),
while `minus-sync` itself, whose values are the core's, is accepted. The parent map (`PARENTS` in config-check.ts) allows several
parents per key (`syncPollBehind` needs `sync` and `syncOnDemand`). The lab wires every dependency (cards,
reader); `bun run sim` wires cards only with `--cards`. gate-traffic.ts, the A/B harnesses and eval's `--config` are
not strict yet.

## Harnesses

| Harness             | Command                                        | What it measures                                                                                                                                                                                                           |
| ------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No-model funnel     | `hidden-funnel.ts` (`bun run funnel` wraps it) | Per task: planted item returned, cached, delivered; with `--ask`, cited by an ask; decoy delivered on controls; source calls and ms per task. Deterministic at `--time 0`                                                  |
| Pi (standard agent) | `pi-ab.ts`                                     | A live agent (pi-agent-core 1.3.0) under conditions `none, tools, eden, both[-judge][~variant][+flag][+ask][+nokey][@w<ms>]`, graded by a second model; per-task timelines; `--day K`; `--days D` (a user's mixed days, recipe 4c) |
| Hermes              | `hermes-ab.ts --hermes-src DIR`                | Hermes Agent alone (`hermes`) vs with Eden as MCP server + plugin (`hermes+eden[~variant]`), or Eden in place of its source tools (`hermes-eden`, A16: Pi's `eden` shape); same tasks, grader and results format as Pi                                                                                   |
| In-house loop       | `agent-ab.ts`                                  | The pre-Pi loop; label any result from it as such (CLAUDE.md)                                                                                                                                                              |
| Simulation          | `bun run sim`, `bun run sim:perf`              | Generated sessions (recall, precision, false fires) and the real server under load; `sim:perf memory --synced` and `steady --synced` (A3) backfill their users first (the scenarios otherwise never sync)                  |
| Connector lab       | `bun run sim:lab:build && bun run sim:lab`     | Real MCP servers in Docker over seeded backends                                                                                                                                                                            |

Reports: `pi-ab-report.ts` (critical path, per-second profile, CPU; Hermes too), `agent-ab-report.ts` (shared tables,
`--record <label>` into the ledger), `act-report.ts` (`--act` runs), `timeline-report.ts` (funnel timelines),
`bench-compare.ts` (ledger entries).

## Replay caches: make once, replay free

| Cache                                                                             | Made by                                           | Replayed with                                                                                                                               | Checked in                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cards (dev/held-out worlds)                                                       | `cards-enrich.ts`                                 | `--cards packages/sim/lab/cards/cards-v2.jsonl`                                                                                             | yes                                                                                                                                                                                                                                                                                                                                                                                   |
| Cards (train worlds, 746 items, 75 calls, $0.0233 on glm-5.3-flash; broad-set.md) | `cards-enrich.ts --funnel train --seeds 41,42`    | `cards-train.jsonl` (merge with v2: `bun run funnel` does)                                                                                  | yes                                                                                                                                                                                                                                                                                                                                                                                   |
| Cards, price-routed batch 20                                                      | `cards-enrich.ts --sort price --batch 20`         | `econ-price20-v2.jsonl` (econ-background.md)                                                                                                | yes                                                                                                                                                                                                                                                                                                                                                                                   |
| Intent requests (D87)                                                             | `cards-enrich.ts --intent --dir D`                | `--intent D/intent-v2.jsonl` (needs `--cards`)                                                                                              | the Haiku campaign's no (`.local/haiku/intent/`); the train worlds (seeds 41–44) and held-out 10–11 (seeds 41–42), made for D110, plus held-out 13 and 14 (seeds 41–44; 14 topped up on Haiku 5.5 for RealUse-1), yes: `packages/sim/lab/distilled/intent-v2.jsonl.gz`, which `bun run funnel` unpacks and replays by default when it covers the run (D158; `--intent none` opts out) |
| Bridge queries (D89)                                                              | `bridge-enrich.ts --out F`                        | `--bridge F`                                                                                                                                | no                                                                                                                                                                                                                                                                                                                                                                                    |
| Reader calls (D95)                                                                | `--reader live --reader-model m --reader-cache F` | `--reader replay --reader-model m --reader-cache F` (the same `m`: the key hashes it; a prompt not cached fails open; misses exit 3, below) | the default on train, seeds 41–42, Haiku 5.5, cards and intent replayed (D158), yes: `packages/sim/lab/distilled/reader-haiku-train-4142-intent.jsonl.gz` (gunzip it; recipe 2a); D141's intent-inert `reader-haiku-train-4142.jsonl.gz` is history, replayed with `--intent none` (with intent on it misses most prompts); others no                                                 |

`pi-ab.ts`/`hermes-ab.ts` read `--cards FILE` and write cards they had to make live to `--cards-out` (default
`<out>.cards.jsonl`); name that file in later runs. Keep run outputs under `.local/` (git ignores it).

**The miss gate.** The reader replay cache keys each call on a hash of its whole prompt (`promptKey`,
`reader-disk.ts`): the model id, the rendered items, the pool order, the request and `READER_VERSION`. Any engine
change upstream of the reader's input therefore misses, and in `--reader replay` a miss fails open: that ask is
answered without the reader, so a NEW screen silently becomes part NEW, part ALL3. `hidden-funnel.ts` and
`bun run funnel` print `READER MISSES: n` and exit 3 when n > 0; the funnel still prints its score first, and
`hidden-funnel.ts` leaves the run out of the ledger. Pass `--allow-misses` (before or after `--`) to accept a partial
screen knowingly. Its JSON (`--json`) carries `reader: {replayed, sent, missed, failed}`. Checked on 2026-11-03 with
an empty cache file (`--suite train1 --seeds 41 --preset NEW`): 108 misses, exit 3; with `--allow-misses`, exit 0.

**Subset replay (`--reader-subset LOG[,LOG]`, D117; approximate, labelled).** With `--reader replay`, a prompt the cache
misses may be answered from a call recorded in a `--reader-log` file (same model, same reader instructions, same day,
request and question) whose pool held every item of the missed prompt, rendered identically and in the same order: that
reading's verdict on those items, renumbered (`SubsetReplay`, reader-disk.ts). It screens, at $0, changes that only take
items out of the pool (a smaller pool, a gate, a cut); a change that adds or re-renders items still misses. It assumes a
verdict on an item does not depend on the items left out: on train1–6, seeds 41–42, Haiku 5.5, restricting each
15-plus-up-to-15-item reading (the deleted trial `askReaderUniverse` 15, D115) to its first 15 items matched the real
15-item reading exactly on 493 of 600 calls, while the same prompt sent twice matched on 97 of 110 (train1–2, seed 41);
the default replayed this way scored hidden 277/384, decoys 146/384 against its real 280/143. Every shard prints `READER
SUBSET-REPLAYED: n`, the merged funnel `APPROXIMATE: n …`, and the JSON `reader.subset`. Log lines carry `model` and
`sys` (a hash of the instructions) since 2026-11-03; older logs are not read. Make the logs once at $0 by replaying the
superset run with `--reader-log`. A run with `--reader-subset` refuses `--reader-log` (an approximated verdict must
never be read back as a recorded one) and leaves its approximated calls out of the reader's latency figures; a
`--baseline` made with it is labelled too. The superset below is a wider pool (`askReaderPool` 30, whose first 15 items
are the default's 15), recorded once live (recipe 2) into `W/rc-wide.jsonl`:

```bash
bun run funnel --set '{"askReaderPool":30}' -- --reader replay --reader-model claude-haiku-5-5 \
  --reader-cache W/rc-wide.jsonl --reader-log W/log-wide.jsonl          # $0: the wide run's verdicts, logged
bun run funnel --jobs 4 --allow-misses -- --reader replay --reader-model claude-haiku-5-5 \
  --reader-cache W/rc-wide.jsonl --reader-subset W/log-wide.jsonl         # the default's pool, approximated
```

**The `overBudget:` line.** `pi-ab.ts` and `hermes-ab.ts` give each lane's reader, cards and bridge their own `new
Budget()` (production defaults: 20 calls and $0.02 a session, `packages/llm/src/budget.ts`); `hidden-funnel.ts` gives
them an uncapped one. A call refused there is skipped, and a refused read reports outcome `budget` (`readAsk` in
`partner.ts`, through `onReader`), apart from a model failure's `none`. Every run therefore ends with `overBudget:
reader n (k lanes), cards n, bridge n` (and the A/B results JSON has `overBudget`). Any non-zero count means the session
cap cut reading and those asks ran as ALL3: say so with the result. The reader calls up to once a user message
(COST-MODEL.md), or twice when push and a later ask miss its verdict cache, so a session of roughly 10 to 20 user
messages can reach the cap (an estimate, not measured in the lab). The unit test `reader-disk.test.ts` shows the count:
25 distinct reads on one default `Budget` give 20 calls and `overBudget: reader 5`.

## Scorers (`packages/sim/lab/scripts/`, run with `python3 -I`)

| Script                                   | Input                                              | Output                                                                                                                                                          |
| ---------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `funnel-score.py F.json …`               | funnel `--json` files                              | per suite: hidden surfaced (delivered or ask-cited) and decoys surfaced; with a reader, hidden and decoy in the reader's pool. `bun run funnel` prints the same |
| `reader-score.py BASE.json RUN.json`     | two funnel files on the same tasks                 | the reader's effect: surfaced base → reader, 2.5 s-capped, flags, latency p50/p90, flag kinds                                                                   |
| `haiku-bench.py LEDGER.jsonl RUN.json …` | pi-ab/hermes-ab results + timelines + spend ledger | rates per harness, suite group and condition; paired bootstrap CIs; tokens, cache shares; cost by role                                                          |

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
  With the lab-connector-latency change (audit 2026-11-03b) `pi-ab.ts` and `hermes-ab.ts` default to `--time-scale 1`;
  pass `--time-scale 0` for instant sources. The funnel's default stays `--time 0`.
- Engine spans (`config.spans`, D56) are content-free and change no decision.
- Reader call rate, no model: `bun run gate-traffic` (seeds 41–44, 40 sessions each, about 20 s) counts reader calls,
  gated and unread messages for the default and the default without `readerGate`, an oracle-gate line (calls a perfect gate
  would make over any needed fact, needed reader facts, and reader facts needed or usable, and the need turns left
  unread or gated), and with `--reuse` what reusing a verdict across one user's sessions could save (exact input, pool
  only, same type and binding set). COST-MODEL.md "Where 3x is impossible" quotes it.
- Reader latency split, no model: `bun packages/sim/src/lab/reader-latency-fit.ts` fits `floor + a·input + b·output`
  over haiku-phase3.md's train-screens table (default), `--runs FILE` (a funnel log summary) or `--replay F.jsonl …`
  (reader replay caches, one point per call, with TTFT when recorded); `--at IN,OUT` splits one call shape.

## Recipes

### 1. Screen a change on train, no model (measured 2026-11-02)

```bash
bun run funnel --json .local/base.json                       # default, train1-6, seeds 41,42, --reader stub
# ... change the engine, or add a flag:
bun run funnel --set '{"myFlag":true}' --baseline .local/base.json --json .local/new.json
```

The default on train, seeds 41–42, `--jobs 4`, cards and intent requests replayed (D158), reader stub (nothing binds),
intent thresholds 0.2/1/12 (D159's arm, promoted by D179) with D200's carded cut (`intentByKind`): hidden 281/384,
decoys 256/384; reader pool hidden 285/384, decoys 254/384 (measured 2026-11-07; before D200 281/256, pool 278/254).
The stub surfaces every pooled item as listed, so its decoys rise with the pool; the paid reader rejects them (recipe
2a: decoys 133). At the earlier thresholds, 0.35/2/6, the same screen
read 259/235 and pool 262/246 (after intent-v2 was topped up for its missing planted items; before that 243/228 and
pool 257/240). With a real reader, use recipe 2a.
`--intent none` gives the pre-D158 intent-inert screen, hidden 214/384, decoys 211/384 (pool 230/229), as ALL3's
(measured 2026-11-03, D112, and again 2026-11-06); every $0 stub number recorded before D158 is that inert shape.
Before 2026-11-03 this recipe ran ALL3, with the same numbers; `--suite train1 --seeds 41` takes 3 s;
`--suite dev6a,dev6b --seeds 41,42,43,44` takes 22 s (122/240 hidden, 91/240 decoys). The `--baseline` diff lists every task that moved. A gain that is a
coin flip between hidden and decoys (broad-set.md: rules on unseen writing) is not a gain.

**`--jobs N` at `--time 0` (default: one per core, D139)** runs N `hidden-funnel.ts` processes at once, each over a
block of suites × seeds (`groupShards` in funnel-merge.ts: train × seeds 41–42 on 4 cores is four blocks of 3 suites
× 1 seed), and merges their rows before the score (`mergeParts`: perTask laid out in the one-process order from each
row's own suite and seed); every process's output is printed whole, in order, then the merged totals (the sync, cards
and reader replay counters summed; `overBudget` and `cpu` lines stay per process). Blocks rather than one process per
shard because each process repeats its start-up (worlds, cards, backfill) in CPU: the old `--jobs 4` (12 one-shard
processes, 4 at a time) took 68–72 s of CPU against about 50 s for four blocks (audit 2026-11-05 round 2 verifiers,
not re-run here). Measured
2026-11-05 on 4 cores shared with other agents (load 1.3–5.9), `bun run funnel`, `time`, wall and user+sys CPU:
before (one process) 26.4, 24.5, 24.1 s wall and 31.7, 30.0, 31.2 s CPU; after (4 blocks) 11.7, 12.5, 15.4 s wall and
43.7, 46.4, 46.0 s CPU. Interleaved pairs, `--jobs 1` (the old default) then the new default: 24.2/16.5, 25.3/14.1,
26.0/14.0 s wall; 31.1/42.6, 32.2/40.6, 30.7/38.5 s CPU. So 1.5–2.0x faster in wall for 1.25–1.5x the CPU of one
process. `bun run funnel --json A.json` and `bun run funnel --jobs 1 --json B.json`: the 768 perTask rows identical
in order once `ms`, `askMs`, `deliveryMs` and `readerWaitMs` were removed, and rows, totals, per-suite summaries,
cards, reader and sync counters (bar `warmMs`) equal; score 214/384 hidden, 211/384 decoys both. The processes contend
for cores, so with N > 1 ms/task (and the sync's ms/user) is not a latency figure: the run says CONTENDED; **quote
latency from `--jobs 1`**, and a `--baseline` that compares ms/task needs `--jobs 1` on both sides. A `--seeds` list
that repeats a seed is refused (blocks would run it once where one process runs it twice).
The per-task output files shard (since audit 2026-11-06): with `--packets`, `--card-log`, `--reader-log`,
`--ask-diag` or `--candidates`, process i writes `<file>.part-<i>`, and after the run the parts are merged into the
named file in one canonical order (suite, seed, variant, template, then each line's own order) and deleted; the
merged file is byte for byte what one process writes, except `--card-log`, whose lines carry no task and keep part
order. The ask-diag bucket lines are printed once, from the merged file. The parts are also removed on SIGINT and
SIGTERM (the launcher stops its processes first and exits 130 or 143), not on SIGKILL. `--jobs` still falls back to
one process, and says why, with `--record` (the ledger books one entry per suite, and a seed shard would book a
partial run), with `--timeline` (per-process CPU and RSS would be contended), and with `--judge live` or
`--reader live` (one append-only cache file and one spend stream per run; a parallel live top-up is not built). A
replayed reader (`--reader replay`) and a replayed bridge shard; their reader misses are summed for the miss gate.

**`--time` shards too** (since audit 2026-11-03b round 2; it used to force one process), one process per suite × seed
shard, N at a time (not blocks: the shards sleep rather than burn CPU, so start-up is cheap beside them). At `-- --time 1` a task's
time is mostly the connectors' simulated latency, which is sleeping, not CPU, so concurrent shards barely slow each
other and ms/task stays a latency figure; inside each process the hidden and control variants also run at once at
`--time` > 0 (`-- --serial` keeps variants and seeds one after another). **Without `--jobs`, a `--time` > 0 run uses
min(shards, 12, 3 × cores) jobs** (round 3, `defaultJobs` in funnel-merge.ts) and says how many on stderr; the solo
reasons above still force one. `--jobs` is honoured as typed, so a latency study, a heavier configuration or a smaller
machine can choose one process. Measured 2026-11-03 (4 cores, ALL3, train1–6, seeds 41–42, `bun run funnel --json F
-- --time 1`): no `--jobs` (now 12 at once) 45 s against `--jobs 1` 223 s, 5.0x; the 768 perTask rows identical in
order with `ms`, `askMs`, `deliveryMs` and `beforeModel` removed; score 214/211 both; delivered 97/72 both; mean
ms/task 495.3 against 491.2 (+0.8%; the audit's verifiers measured +2.6% and +3.5% at 12 jobs on the same machine
class, so quote latency from `--jobs 1` when a few percent matter).
Measured on 4 cores, ALL3, `--suite train1,train2 --seeds 41 -- --time 1`: before (forced one process) 136.6 s,
after with `--jobs 4` (2 shards) 35.5 s, 3.8x; the 128 perTask rows identical in order with `ms`, `askMs`,
`deliveryMs` and `beforeModel` removed, score 36/64 hidden and 39/64 decoys both ways, mean ms/task 473.5 against
474.5 (+0.2%). The whole train set, `bun run funnel --jobs 4 -- --time 1` (12 shards, 4 at a time): 112 s wall
(measured while other no-model runs and `bun run check` shared the machine), delivered 97/384 hidden and 72/384
decoys, ms/task 494.2, score 214/211; the audit finding measured the forced one-process run at 435.5 s with the
same 97/72 and ms/task 481.9 (not re-run here).

**Merged sync and call counts.** The merged `amortised total` subtracts the summed `demandSeen` (on-demand listings
the connectors received in the tasks' windows, already in the request calls), as each shard does; it used to subtract
`demand` (the polls in lookups' traces), which counted twice every poll left behind under `syncPollBehind` or made by
the reader's push. `bun run funnel --suite train1,train2 --seeds 41,42 --set '{"syncPollBehind":true}' --jobs 4`:
merged 7.04/task before, 4.43/task after; the four shards print 4.67, 4.08, 4.31 and 4.64 (mean 4.43). ALL3, where
every poll is traced, is unchanged. Each shard now also prints `CALLS UNTRACED` when its traces summed other than its
connectors received, and the merged summary lists such shards: under `syncPollBehind` the poll's listings reach no
trace (train1 seed 41: 53 traced of 225 received), so per-trace `sourceCalls` undercount; under ALL3 every shard
matched (12 of 12). The engine fix (a trace when the behind poll settles) is a separate change.

### 1b. Screen the NEW family at $0: no-model readers (measured 2026-11-03)

The NEW presets read each acting request with a model, and the replay cache misses on any change upstream of the
reader (the miss gate above). Three no-model modes stand in for the model behind the engine's real `AskReader`
(`reader-stub.ts`), so the pool is built, ordered and gated exactly as with a model. They shard with `--jobs`, need no
key, and held-out suites still need `--blind`.

```bash
bun run funnel --jobs 4 -- --reader stub                  # pool recall per suite: 18 s, $0
bun run funnel --jobs 4 -- --reader oracle:0.9,0.1        # ground-truth proxy, every line labelled
bun run funnel --jobs 4 -- --packet-k 10,15,20                          # planted item in the ask's top K
bun run funnel --jobs 4 -- --reader stub --lead-in clause # draft pool against the request's
bun run funnel --jobs 4 -- --pool-dump $PWD/.local/pool.jsonl         # the push's candidate pool per task (A2)
bun run funnel --jobs 4 -- --corpus-dump $PWD/.local/corpus.jsonl     # each world's items and card keys (A15)
```

- **The default's pool (A2, D269).** With `pushCandidates` each push pass reports its pool to the lab hook
  `onPushPool` (ids, `readerGate`'s constraint test, the handed ids), not to `onReader`, so the reader pool lines above
  stay 0 under the default; each task's JSON row has `pushPoolAt` (the planted item's place in the last pass's pool,
  −1 when not in it) and `pushHanded` (train seeds 41–42: in pool 283/384 hidden, 247/384 decoys; handed 253, 219).
  `--pool-dump FILE` writes each task's last pool in order with each item's title, text, card and flags (`handed`,
  `auto` for an automated sender, `cl` for the constraint test) and the planted item's place (`at`): the input
  for re-rank screens at $0 (`packages/sim/lab/a2/sim.py`, `feat.py`). A lever that changes which items are handed on
  a few tasks is run live on those tasks first (`pi-ab --templates`, `packages/sim/lab/a2/targeted-templates.txt`).

- **`--reader stub`** says nothing binds and prints, per suite, `hidden in pool X/N, decoy in pool Y/N, mean pool
items, mean prompt chars (standing prefix)`. Pool means the ids the reader was given for the request (the push's
  read and the ask's, `ReaderReport.pool`). It measures pool content; it is **not a bound** on NEW's hidden rate: the
  rule paths, the ask's own citations and the push still deliver items the reader never read (NEWL's paid screen
  delivered 254/384 hidden, haiku-phase3.md, against 230/384 in its stub pool here, though that screen also had
  intent requests). Its hidden and decoy _delivered_ counts are not the preset's:
  with a reader that never binds, NEW falls back toward its rule paths (NEWL under stub: 214/211, ALL3's numbers). Use
  it for changes upstream of the reader: pool building, retrieval, ordering, gating, standing items.
- **`--reader oracle[:p_hit,p_false]`** (default 1,0) flags the planted hidden item as bearing with probability
  `p_hit` and the planted decoy with `p_false` (else rejects it), each draw a hash of (task, item id), so a result
  does not depend on sharding: `--jobs 1` and `--jobs 4` gave identical perTask rows and score lines. Every line says
  `oracle proxy`. Two numbers cannot model how a real reader responds to the prompt's form, length or order (v8's line
  format cut hidden from 291 to 198–210 at a similar pool, haiku-phase3.md): its deltas speak for pool-composition
  changes only, until a paid screen confirms them. It is not calibrated to the haiku-phase3 rows.
- **`--packet-k K[,K]`** (with `--ask`, any preset) prints, per K, the planted item within the ask's top K ranked
  candidates (by rank alone, and with today's delivered or cited), the mean bytes of a top-K packet at `askItemBytes`
  (320) per item, and the hidden item's mean position. A diagnostic for handing the agent a wide no-model packet
  (moon-agent-is-the-reader): in-packet is not uptake.
- **`--lead-in clause|half` with stub or oracle** asks the draft as `readerPush` asks, in a session of its own, and
  compares its pool with the request's first read: the share of tasks whose draft had a pool, mean Jaccard, final pool
  ⊆ draft pool, and the hidden item in the draft's pool (stage 1 of lat-draft-speculative-read). The draft's lookup
  is real: it caches what it finds for the request, so delivery moves slightly (NEWL stub: decoys 211 → 212).
- **`--distill labels:LABELS.jsonl,OUT.jsonl` with `--reader stub`** replays Haiku 5.5's reader verdicts for train1–6,
  seeds 41–44 (`packages/sim/lab/distilled/labels-train.jsonl`, keyed on task and `readerKey`) at $0, and writes each
  call with its items to OUT: labels for (request, candidate) pairs. It needs the committed cards and intent requests
  (`packages/sim/lab/distilled/run.sh labels` sets them up). `record:OUT` makes such labels with a live reader;
  `cascade:MODEL` puts a no-model scorer in front of the reader (rejected, D110, docs/research/distilled-reader.md).

Measured on train1–6, seeds 41–42, 4 cores, no key set:

| Run                            | Wall                                     | Result                                                                                                                                                              |
| ------------------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NEWL `--reader stub` (twice)   | 18.5 s, 18.2 s                           | hidden in pool 230/384, decoy in pool 229/384, mean pool 12.3 items, mean prompt 7,501 chars over 656 stub calls; identical perTask rows (timing removed) and score |
| NEWL `--reader oracle:0.9,0.1` | 20.7 s (`--jobs 4`), 37.4 s (`--jobs 1`) | proxy: hidden 245/384, decoys 134/384; same rows at both job counts                                                                                                 |
| ALL3 `--packet-k 10,15,20`     | 18.6 s                                   | top-10 237 (256 with delivered/cited), top-15 264 (272), top-20 279 (282) hidden of 384; decoys top-15 268 (275); top-15 packet 3,808 bytes                         |
| NEWL stub `--lead-in clause`   | 22.4 s                                   | draft pool non-empty 640/768; Jaccard mean 0.688; final ⊆ draft 237/640; hidden in draft pool 213/384 (in final pool 228)                                           |

Limits: the rows of the table above ran before D158, intent inert (the intent index finds nothing without a replay
file), so their pools lack the intent hits that the paid screens had; the prompt sizes are of the stub's reads only.
Since D158 `bun run funnel` replays the checked-in `intent-v2.jsonl.gz` by default when it covers the run's suites and
seeds (train seeds 41–44, held-out 10–11 seeds 41–42), and prints `intent: live|inert (why)` under the score header;
`--intent none` gives the old inert shape. A run says when it is inert: with `intent` on and no replayed request
found for any item (`--intent none`, an uncovered run, or a file for other items), every TOTAL and pool line and the
JSON `label` carry `[intent inert: no replay]`, the JSON has `intent: {state, asked, found}` (`off`, `inert`
or `live`), and `--reader stub|oracle` refuses a `--baseline` whose intent state differs (an inert NEWL screen reads
the same prompts as `--set '{"intent":false}'`, so a comparison across states would read as "intent does nothing").
A baseline written before the field existed, with intent configured, is `unknown` and refused. `--reader-log F` works
with stub and oracle too: one line per read (task, the prompt a model would have read, the verdict); NEWL stub on
train1 seed 41 wrote 54 lines for its 54 reader calls.

A second, independent draw of train seeds 41–42's requests with the shipped prompt is checked in as
`packages/sim/lab/distilled/intent-v2-draw2.jsonl.gz` (D361): the default reads 314/273 on the shipped sample and
307/281 on it, with 43 hidden tasks moving between them. Screen a lever on the intent index on both (`zcat` it, then
`--intent FILE`) and do not report a delta under about 10 tasks from one sample.

### 1c. Lab-only measurements of first-turn delivery, overlapping requests and sync items

- **`-- --wait-ms N`** sets the request observe's wait (the client's `waitMs`; default 3,000 × max(1, `--time`), as
  before). Each delivered task records `beforeModel`: the planted item came with the reply or was pending right
  after it, so an agent that collects before its first model call holds it. Later arrivals still count as delivered
  (collected up to the default window), so the funnel score does not move. ALL3, `--suite train1,train2 --seeds 41
--jobs 2 -- --time 1` (36 s each): wait 0 delivered 5 of 28 before the first model call (hidden 3/14, decoys 2/14),
  wait 1,500 26 of 28 (12/14, 14/14), the default 3,000 27 of 28 (13/14, 14/14); score 36/64 and 39/64 in all three.
  The client SDK and server default `waitMs` to 0 (D98).
- **`-- --overlap`** sends the suite's next request in the same session, not waited for, just before each request,
  so the request arrives while a lookup is in flight: a request that finds the slow path busy is not looked up. The
  run prints `overlap: slow path busy N times`. It changes the task shape: its scores are not comparable with a run
  without it. ALL3 train1–6 seeds 41–42 `--jobs 4`, `--time 0`: `slowPathQueue` off 214/384 hidden, 210/384 decoys
  (busy 58–64 per shard, none queued); on 216/384, 211/384 (every busy request queued). On 2026-11-07, with the paid
  Haiku reader replayed (train1–6 seeds 41–42, `--jobs 4`), the default then (with the queue) read 316/133 against
  310/85 without it (25–26 reader misses); the queue was deleted (D228).
- **Sync items.** The sync line and the JSON `sync` carry `demandItems` and `backgroundItems` (`SyncStats`, summed
  per user before each lane's sync is discarded), the counter D101 is judged on, now reproducible at $0:
  `bun run funnel --jobs 4` (ALL3, train, seeds 41–42) demand items 182,742 and background items 76,796; with
  `--set '{"syncPollPageSize":5}'` 10,080 and 77,996 (D101's 182,742 → 10,080), score 214/211 both.

### 1d. The retrieval screen: half of train, every task agreeing with the funnel (audit 2026-11-06 F25)

For a change to what reaches the reader (retrieval, ranking, intent, probes, sync), screen first on
`retrieval-screen.ts`, then gate on recipe 1 or 2a. The screen is train1–6 at seed 41 only: the part of train every
replay cache covers with no miss (cards and intent requests for seeds 41–42, every planted item with an intent line;
the Haiku reader cache of recipe 2a replays seed 41 whole, 324 calls and 0 misses, its 2 misses are seed 42's). Each
suite × seed is its own world and session, so the screen's rows are exactly the full funnel's rows for those tasks.

```bash
bun packages/sim/src/lab/retrieval-screen.ts run --json .local/screen-base.json          # the default, stub reader
bun packages/sim/src/lab/retrieval-screen.ts run --set '{"myFlag":true}' --baseline .local/screen-base.json
bun packages/sim/src/lab/retrieval-screen.ts run --json .local/screen-haiku.json -- --reader replay \
  --reader-model claude-haiku-5-5 --reader-cache .local/reader-haiku-train-4142-intent.jsonl   # the paid reading, $0
bun packages/sim/src/lab/retrieval-screen.ts agree FULL_BASE FULL_NEXT SCREEN_BASE SCREEN_NEXT  # check it
```

It runs `bun run funnel --suite train1,…,train6 --seeds 41` (any funnel flag but the grid passes through; after `--`,
hidden-funnel's), then prints `RETRIEVAL SCREEN`: per variant, planted items returned, cached, in the reader's pool
(the retrieval figure) and surfaced, over the pairs `packages/sim/lab/retrieval-screen.json` lists (`select FULL.json`
rewrites it; 192 of 192 covered), and with `--baseline` every task whose fields moved. It is a screen, not a result.

Measured 2026-11-06 (4 cores, load average 3.4 at the start of the timing runs, stub reader unless named). Time, `bun
run funnel` against the screen: 10.0–10.5 s against 6.0–6.4 s at the default jobs (3 runs each), 22.1 s against
11.8–12.5 s at `--jobs 1` (both through `bun run funnel`; `run --jobs 1` gives the same grid); with the Haiku replay
10.6 s (647 replayed, 2 missed) against 6.3 s (324 replayed, 0 missed). The default on the screen: hidden pool 130/192,
surfaced 127; decoys pool 121, surfaced 118 (full: 262/246 and 259/235). With the Haiku
replay, the screen's 384 rows equal the full replay's rows for the same tasks (0 moved). Agreement with the full
funnel on four past changes (`agree`, each change run both ways against the default):

| Change                                                                                | Tasks agreeing | Moved (full on screen / screen) | Full Δ pool, surfaced (hidden; decoys) | Screen Δ          | Signs  |
| ------------------------------------------------------------------------------------- | -------------- | ------------------------------- | -------------------------------------- | ----------------- | ------ |
| D159's looser intent `{"intentMinCoverage":0.2,"intentMinMatched":1,"intentHits":12}` | 384/384        | 42 / 42                         | +16, +22; +8, +21                      | +9, +10; +8, +14  | agree  |
| `--preset minus-probes`                                                               | 384/384        | 32 / 32                         | −10, −11; −12, −9                      | −4, −5; −5, −5    | agree  |
| `--preset minus-intent`                                                               | 384/384        | 42 / 42                         | −32, −45; −17, −24                     | −17, −20; −8, −12 | agree  |
| `--preset minus-graph` (history: the preset is gone, D225)                            | 384/384        | 6 / 6                           | −1, +3; −2, +1                         | −1, +1; −1, 0     | differ |

Every task agreed in every change, as it must (same worlds, same order): that is a determinism check, not evidence that
the screen predicts. The evidence is the verdict, the sign of the totals, which agreed on the three changes that moved
32 tasks or more and differed on minus-graph, which moves 6 of the screen's tasks and 15 of 768 in the full funnel (the
others moved 67–88). So far the sign was wrong at 6 moved screen tasks and right at 32 or more, with nothing measured
between: for a change that moves fewer than about 30 screen tasks, read the task list, not the totals. Prefixes were
tried and dropped: `-- --limit 16` and `--limit 8` per suite (4.7–4.9 s and 4.2 s) moved one default task of their 192
and 96 rows (each suite clears only its own tasks' calendar slots, `clearSlot`), so the screen's rows would no longer be
the funnel's. A change that re-renders the reader's pool still misses the reader cache; its paid top-up on the screen is
about half a full one (324 of 649 calls, about $0.09 at recipe 2a's $0.185 for 652 calls, an estimate). It does not
answer what F25's unordered subset replay would: no recorded reading is reused for a pool it was not given (D117 is
unchanged).

### 1e. Many sources per user: 1,000 connectors at $0 (A1, A13)

The lab's worlds have five sources and fit the sync's cap, so the usual screen cannot see a user with hundreds. Add
995 noise connectors per simulated user (`packages/sim/src/lab/noise-sources.ts`: real `SimSource`s with their own
work vocabulary, ~3% of items naming one of the world's people) and screen 16 tasks a suite:

```bash
bun run funnel --jobs 2 --suite train1,train2,train3,train4,train5,train6 --seeds 41 --json n995.json \
  -- --noise-sources 995 --limit 16     # ~45 s; --jobs 2: memory. --set '<arm>' for a trial
bun run funnel --jobs 2 --suite train1,train2,train3,train4,train5,train6 --seeds 41 -- --limit 16   # five sources
bun packages/engine/bench/source-days.bench.ts 1000 300 3 --config='<arm>'   # listing and card calls a day
```

Read hidden/decoys, `calls/task`, and the `merged cards use` line's `calls` and `sent` (card calls are stub-counted:
noise items are not in the replay; price them at $0.000181 a call, A1). Compare task by task against the same seed
without the arm (the JSON's `perTask`). The "hidden returned" count falls when sources answer from the index instead
of a live search: read "hidden surfaced" (`TOTAL hidden`), not it. Figures for the shipped default: a13-scale.md.

### 2. The same with Eden's reader live (NEW)

```bash
H=.local/haiku   # intent requests and cards as in docs/research/haiku-opt.md "Reproduce"
bun run funnel --json $H/new.json -- --intent $H/intent/intent-v2.jsonl --reader live \
  --reader-model claude-haiku-5-5 --reader-cache $H/reader-cache-v5.jsonl \
  --spend-ledger $H/ledger.jsonl --spend-cap 40 --spend-headroom 3
python3 -I packages/sim/lab/scripts/reader-score.py .local/base.json $H/new.json
```

Cost: one reader call per acting ask, about $0.0004 on Haiku (haiku-benchmark.md); Phase 1 of the Haiku campaign,
reader and intent requests for train and held-out 10–11 included, spent $1.39 (haiku-opt.md). Reruns replay from the
reader cache at $0. The haiku-opt.md command sets `askReaderWaitMs: 60000` so latency does not decide what is read.

### 2a. The default's paid Haiku reading, replayed at $0

**Since D237 (CL6) the default makes no reader call** (`pushCandidates` 5): its funnel replays nothing from this cache
(TOTAL hidden 305/384, decoys 267/384, 0 reader calls, train seeds 41–42 with `--neutral`). Every recipe below that
screens the reader (2a, 2b, the `minus-<part>` replays) now runs `--preset minus-candidates`, which reproduces the
pre-D237 default exactly (322/139 with D240 on, 643 replayed, 0 misses; 321/129 with `{"readerStopEarly":false}`). The neutral top-up no longer covers that
preset's neutral prompts at this tip (590 misses, answered without the reader).

The reader cache of the shipped default (D158: cards and intent requests replayed; intent thresholds 0.2/1/12 since
D179, `intentByKind` since D200) on train1–6, seeds 41–42, is checked in gzipped:
`packages/sim/lab/distilled/reader-haiku-train-4142-intent.jsonl.gz`, 6,623 lines, all `claude-haiku-5-5`, plain md5
`cf07319d4be872b1412f8f2afa80a915` (its first 5,435 lines are D244's file below, then D240's two stop top-ups;
4,377 lines, md5 `32c5fa518a67a2db657f35f981e3262a`, before D244 and D240;
1,968 lines, md5 `d0ff788fa9cbad0f3c755f043b25d43b`, before fix-w2a's top-up;
1,416 lines, md5 `47eb6393a75b49c14f0f7b802473fd59`, before D200's). It was recorded on 2026-11-06 from an empty cache by one metered live run (ledger
run `ib-reader-intent-cache-default`: 652 calls, $0.18548, 418 s, TOTAL hidden 274/384, decoys 137/384, 0 misses),
then topped up the same day for the completed intent file (ledger run `r2-intent-reader-topup`: 73 calls, $0.02102;
docs/research/edge-intent.md), and again for the D179 thresholds (ledger runs `close-d159-reader-topup`, 570 calls,
$0.16293, and `close-d159-reader-topup2`, 4 calls, $0.00109, for the prompts the first left), and once more for the
deleted verb-gate trial (D168's verb-recognising request gate; ledger run `close3-verbgate-topup`, 119 calls,
$0.03306; its 119 lines, appended after the first 1,297, are inert for the default), and for D200's carded cut
(ledger runs `s3a-bykind-reader-topup`, 499 rows, $0.15136, `s3a-default-reader-topup2`, 2 calls, $0.0007, and,
after the review's fix, `s3a-default-reader-topup3`, 53 calls, $0.01671; docs/research/fix-s3a-intent.md). The older readings stay in the file, so a `--set` back to 0.35/2/6, or
`{"intentByKind":false}` (the pre-D200 311/137), still replays. It was topped up again in fix-w2a (ledger runs
`w2a-topup-*`, `w2a-topup2-*`, `w2a-topup-slim`, `w2a-topup-overlap-*`, $0.676 in all;
docs/research/fix-w2a-parts.md) so every `--preset minus-<part>` of the current `PARTS` replays with 0 misses and
`--overlap` replays with about 25 misses.
The cache is plain JSONL that a live reader appends to, so it is unpacked under `.local/` (`--reader-cache` refuses a
`.gz`):

```bash
gunzip -c packages/sim/lab/distilled/reader-haiku-train-4142-intent.jsonl.gz > .local/reader-haiku-train-4142-intent.jsonl
bun run funnel --jobs 4 --allow-misses --preset minus-candidates --json .local/haiku-default.json -- --reader replay \
  --reader-model claude-haiku-5-5 --reader-cache .local/reader-haiku-train-4142-intent.jsonl
```

**Topped up for D244 (CL3, 2026-11-07; docs/research/cl-cl3.md):** the default's lean window became 7 days, which
re-renders most reader pools, so the cache was topped up for it (ledger runs `cl3-topup-l7`, `cl3-topup-l7-42`, and
the CL3 arms `cl3-topup-l7r2`, `cl3-topup-l7r2b`, `cl3-topup-nocards`; $0.303 in all). It now has 5,435 lines (plain
md5 `087bd902247caa5fd883f45aa04d4018`; its first 4,377 lines are the file above, unchanged). The D244 default (since D237, `--preset minus-candidates`) replays
643 prompts with 0 misses: TOTAL hidden 321/384, decoys 129/384, reader pool hidden 287/384 and decoys 251/384
(`--set '{"cardsLeanDays":30}'` replays the old default's 313/127 with 0 misses). The `--preset minus-<part>` runs of
the new default were not topped up: expect misses (answered without the reader, `--allow-misses`).

Before D244 (the old cache and the 30-day window), measured on 2026-11-07 after the deletions (D225–D228), from the committed file (no ledger flag, so no spend):
`merged reader replay {"replayed":643,"sent":0,"missed":0,"failed":0}`, TOTAL hidden 313/384, decoys 127/384, reader
pool hidden 282/384 and decoys 249/384 (before the deletions, the same day: 314/132, pool 285/254). After D200's
top-up (2026-11-07, about 10 s): 654 replayed, 0 missed, TOTAL hidden 315/384, decoys 133/384, reader pool hidden
285/384 and decoy 254/384. Before D200 (2026-11-06, after the D179 and verb-gate top-ups): 651 replayed,
0 missed, TOTAL hidden 311/384, decoys 137/384, reader pool hidden 278/384 and decoy 254/384. At 0.35/2/6 it read 647 replayed, 2 missed, 281/139, pool 262/246 (and with the older
intent file before that: 645 replayed, 5 missed, 273/137, pool 257/240). A change upstream of the reader can leave
misses (answered without the reader, fail open), which is why the recipe keeps `--allow-misses`; without it a miss
exits 3.
Since D240 the default's reader requests carry a stop sequence (`readerStopEarly`), so they key apart from the
older lines: the stopped readings were appended live, first for the 30-day window (ledger run `cl2-stop-topup`, 642
calls, $0.157: `--set '{"cardsLeanDays":30}'` replays 316/146, 0 misses), then for D244's default
(`cl2-stop-topup-merged`, 546 calls sent, $0.136; docs/research/cl-cl2.md). Measured 2026-11-07 on the merged tree:
`merged reader replay {"replayed":643,"sent":0,"missed":0,"failed":0}`, TOTAL hidden 322/384, decoys 139/384, reader
pool hidden 287/384, decoys 251/384, 91 output tokens a call (the same tree with `{"readerStopEarly":false}`: 321/129,
D244's figure above). A preset
whose stopped prompts the cache lacks (the `minus-<part>` presets) replays the line recorded without the stop, cut
where the stop would have ended it (`stopLine`, reader-disk.ts; approximate in its tokens and times, exact in its
text up to the stop): each shard prints `READER STOP-SIMULATED: n` and the JSON's `reader.stopSimulated`. It applies
only with no live model: a live run makes the stopped call for real.
A `--baseline .local/haiku-default.json` then screens a change against the paid reading at $0.

**Neutral tasks (CL5).** The train suites' `neutral` variant (seeds 41–42) has its own top-up,
`packages/sim/lab/distilled/reader-haiku-train-4142-neutral.jsonl.gz` (306 lines, plain md5
`aefb37aac34e826279f2e25db8d68b39`; ledger run `cl5-neutral-reader-topup`, $0.0765, 2026-11-07). Concatenated after the
main file it replays `-- --neutral` with 0 misses (without it, 608 neutral reader misses):

```bash
(gunzip -c packages/sim/lab/distilled/reader-haiku-train-4142-intent.jsonl.gz; \
 gunzip -c packages/sim/lab/distilled/reader-haiku-train-4142-neutral.jsonl.gz) > .local/reader-train.jsonl
bun run funnel --jobs 4 --allow-misses --preset minus-candidates --json .local/h18.json -- --neutral --reader replay \
  --reader-model claude-haiku-5-5 --reader-cache .local/reader-train.jsonl
```

### 2b. The cost screen: Eden's per-task spend at $0 (H18, CL5)

The command above, with the neutral rows, ends with `COST SCREEN` lines (`cost-screen.ts`): per kind (hidden,
control, neutral) and on the assumed 1:1:8 mix, the reader's calls a task and their dollars as made (each funnel row's
`readerCalls` and `readerUsd`: a replayed call at what it cost when it was recorded), connector calls a task and the
ask's mean wall. It is the combination search's first gate for a lever that changes how often or how expensively Eden
reads: no live agent, no grader, about 12 s at `--jobs 4`. Measured on 2026-11-07 for the shipped default (the tree
at `2c65a6f9a`):

```
COST SCREEN hidden  n 384: reader 0.84 calls/task, $0.2378/1k tasks (as made), 2.67 connector calls/task, ask 6.7 ms
COST SCREEN control n 384: reader 0.84 calls/task, $0.2422/1k tasks (as made), 2.70 connector calls/task, ask 5.8 ms
COST SCREEN neutral n 384: reader 0.80 calls/task, $0.1999/1k tasks (as made), 2.59 connector calls/task, ask 4.7 ms
COST SCREEN mix 1:1:8: reader 0.807 calls/task, $0.2079/1k tasks (Eden per-task, as made; no agent, no backfill), 2.61 connector calls/task
```

What it does not see, so what still needs the live A/B (recipe 4c's report): the agent's own tokens (a lever that
changes what the agent reads or how often it asks, H8–H13), the background cards and intent (replayed at $0; a
user's one-time backfill), and wall time beyond the recorded reader latency. The funnel asks once per task (`--ask`)
where a Pi agent asks when it chooses, so its reader calls a task are the funnel's, not Pi's (Pi's eden arm read
0.92 a task on heldout15, cost-latency-plan.md). A change upstream of the reader's input misses the cache: the top-up is metered
(`--reader live`, about $0.00029 a call), and a screen with misses says so (`COST SCREEN: N reader prompts missed`),
since a missed prompt costs $0 here and understates. A lever that changes the reader's request itself (H3–H5)
always misses: screen its token counts with a small live top-up, then replay.

**The older, intent-inert cache.** `reader-haiku-train-4142.jsonl.gz` (866 lines, plain md5
`9a492c00cf9724306e3e4743e2882982`) is D141's first paid default run (docs/research/graph-ablation.md, committed in
cea000ba6; it also holds that run's minus-graph calls), recorded with cards replayed and intent inert. It is kept for
history and replays with `--intent none` (2026-11-06: replayed 648, missed 5, TOTAL 247/127, pool 230/229; the same as
on 2026-11-05). With intent replayed it misses most prompts (the audit's run: 396 replayed, 489 missed). Every figure
below and in D141–D157 that cites 247/127 is that intent-inert reading, not the shipped default.

- **`--reader-model claude-haiku-5-5` is required.** The key hashes the model id (`promptKey`), and the default
  model is `z-ai/glm-5.3-flash`: without the flag every prompt misses, the score falls to the stub reader's, and the
  funnel prints `READER HINT` naming the cache's recorded model.
- **What it screens.** A change that only takes items out of the reader's pool (a veto, a gate, a smaller pool) at
  $0 with `--reader-subset` on a `--reader-log` made by replaying this cache (subset replay, above; approximate and
  labelled). Measured on 2026-11-05 on the intent-inert cache: replaying with `--reader-log .local/log.jsonl` (653
  lines, 247/127 again), then `--set '{"askReaderPool":10}' ... --reader-subset .local/log.jsonl` gave
  `{"replayed":17,"missed":3,"subset":602}`, hidden 230/384, decoys 140/384, labelled APPROXIMATE, at $0. A change
  that adds or re-renders pool items misses for those prompts.
- **When it goes stale.** Any change upstream of the reader's input (sync, retrieval, ranking, rendering, the intent
  requests or thresholds, the day or request text), a `READER_VERSION` bump or another reader prompt misses: the miss
  count says how much. Top the misses up with one metered live run into a copy (`--reader live --reader-model
claude-haiku-5-5 --reader-cache .local/reader-haiku-train-4142-intent.jsonl --spend-ledger .local/mkt/ledger.jsonl
--spend-cap 18 --spend-headroom 0.3 --run-label NAME`); a fresh default reading cost $0.17–0.19 (ledger runs
  ga-default, ga-default2, ib-reader-intent-cache and ib-reader-intent-cache-default).
- **How the surfaced items were surfaced (D173, reporting only).** Every run (each process's block, then the merged
  score) prints, after TOTAL, `hidden surfaced` and `decoys surfaced` split into **flagged** (the reader flagged the
  item in the request's last reading, whatever injection carried it), **rule path** (delivered without the flag, by
  the injection's `why`: grounded-conflict, fallback, sources, ...) and **listed only** (cited by the ask with no flag
  and no delivery: `readAsk`'s `rest`, chosen minus explicit rejections), and `decoys flagged in pool` beside `decoys
in pool`; `--json` carries `surfacedBy` on each perTask row. The recipe above, 2026-11-06 (16 s, $0): TOTAL 273/137
  and pool 257/240 unchanged; decoys surfaced 137 = flagged 23 + rule path 68 (grounded-conflict 28, fallback 19,
  sources 9, anticipated-conflict 4, grounded-card 3, cache 2, grounded-clash 2, grounded-graph 1) + listed only 46;
  decoys flagged in pool 23 of 240; hidden 273 = 227 + 22 + 24. **The O7 precision gates are unchanged**: decoys in
  pool and total surfaced (D165, D173). Gating on flagged plus rule path would drop the 46 listed-only decoys and
  loosen a precision guard, so it needs a new decision; the split says where a decoy came from, not that it is
  harmless.
- **Per-rule precision (S2, reporting only).** After the split, `rule precision` lines give each rule path's planted
  deliveries, hidden/decoys, three ways: all (flagged or not), unflagged (what the rule adds) and read unflagged (in
  the request's reader pool and not flagged), marking a path whose decoys outnumber its hidden finds
  (`rulePrecisionLines`, ask-coverage.ts). Recipe 2a, 2026-11-07: grounded-conflict 60/32; 12/28; 3/26, fallback
  8/19; 3/19; 0/15, sources 10/9; 2/9; 2/7; the split above printed listed only 45 that day (46 on 2026-11-06) (the full table and what was tried on it: docs/research/fix-s2-rules.md).
- **Planted coverage of the intent replay (D173).** With an intent file loaded, every run prints `planted items with
an intent replay line: hidden H/N, decoys D/N` beside `replayed requests for X of Y items asked`, with a WARNING
  below 100%. Planted items are a few percent of the items asked but most of the file's holes: on 2026-11-06
  `intent-v2` covered 13,440 of 13,604 items asked and only 286/384 hidden and 341/384 decoys (98 and 43 not in
  replay; 141 of the 164 misses), so the $0 screens run a quarter of planted hidden facts with no requests. A WARNING
  means intent and bridge screens on that run under-read intent; top the file up (`cards-enrich.ts --intent`,
  metered) before trusting a bucket split.
- **`--ask-diag F` buckets** (printed from the merged file at any `--jobs`). A planted item the ask left unranked is split into not cached; not sent,
  prefilter rejects; **not in replay** (the intent replay has no line for its content, a lab artefact, told apart
  from a line with no requests since D173); no intent requests; and requests but no match: no shared term, under
  thresholds, **passes but past the first intentHits raw hits** (it passes the thresholds but the engine never sees
  it), over thresholds (inside the engine's cut and still not a candidate). The intent hit is read as the engine
  reads it (`intentFinds` with k = `intentHits` and the ask's arrival, thresholds after; partner.ts `intentFinds`,
  cards.ts `intentFinds`), plus an unbounded call for the past-the-cut bucket; expired cards either call drops are
  counted on the `dropped` line. A last line counts every row not in replay, ranked or not. Each row's `coverage.cardKind` is the
  card the engine held for the planted item at the ask (`none` without a constraint card), for per-kind splits (D200). The recipe above with
  `-- --ask-diag F` (run then as one process; `--jobs` gives the same lines), 2026-11-06: hidden rank -1 64/384 = not in replay 18, no intent requests 3,
  requests but no match 43 (no shared term 8, under thresholds 35, past the cut 0, over 0); decoys 77/384 = not
  sent 4, not in replay 14, no match 59 (21, 38, 0, 0); not in replay over every row: hidden 98/384, decoys 43/384.
- **Changes to the ask's cue are screened with a paid reader, never the stub (D174).** The stub got the sign of an
  ask-wording effect wrong: on train1–6 seeds 41–42 it put a narrow agent-worded ask at 191/188 against 243/228
  request-worded, and a question-plus-request union back at 239/227; paid Haiku reads (ledger runs
  `audit3r2-narrow` $0.1185, `audit3r2-union` $0.1851) gave narrow 279/129 against the replay's 273/137 (paired
  hidden +1.6 points, CI -1.2..+4.4) and union 281/140 against narrow (hidden +0.5, CI -2.1..+3.1; decoys +2.9, CI
  -0.7..+6.4). These are D174's figures, not re-run here. Screen ask-cue changes with a metered live top-up of this
  cache.

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
  --conditions tools,eden,eden~X --config default --variant-config '{"X":{"myFlag":true}}' \
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

**Dressed worlds (`--dress`, D287).** Many requests name a person or firm no item of their generated world names, so
the agent's first lookups cannot succeed (`bun packages/sim/lab/a6/census.ts [--dress]` counts absent names broadly).
`pi-ab --dress` adds, per such person or firm, one ordinary message from it (no constraint wording, the same in every
variant; ids, acronyms, places and holidays are left alone; `dress-entities.ts`); short horizon only (refused with
`--days` and `--reuse-arms`). Measured on train seeds 41–42: neither arm changes significantly and eden − tools is the
same (docs/research/a6-moonshots.md §4). Use it for levers on what the agent looks up first.

### 4a. Pi: the shipped shape (`both+ask`) and a day of requests (`--day`)

- `both+ask` (fix-s3b): the agent's own source tools, Eden's injected context and `ask_context`, the shape
  integrators ship. `+ask` is a harness flag, not an engine setting, and only a `both` base takes it (`eden` already
  has the tool). The report pairs it with `both`.
- `--day K`: one agent transcript and one Eden session per K requests of a stream (template order), and a recap turn
  closing each day ("anything to watch out for, with the times"; measured, never graded). Just before the recap the
  day's planted items change (`shiftClocks` moves their clock times, `shiftMeta` their structured start; the sources
  reindexed and, with `--push`, announced: `signals` a bare `sourceChanged` per touched source, `payload` the moved
  items through `sourceItems`, as the client sends them (D210); `--recap-notice signal` keeps the bare signals every
  run sent before D272, A8): only then, so a moved item cannot land in a later graded request's slot.
  A changed item misses the replay caches (its content hash changed) and is carded live; `lateItems` is not measured
  (a late packet goes to the day's next request). The
  results gain `days` and `daysPooled` (`pi-day.ts`): repeat deliveries (and those of a changed item), `(shown
above)` marks, asks citing an item a packet already gave, stale deliveries after a change, and recaps naming a
  changed item's old time (`staleRecap`) or its new one (`freshRecap`). Each request is still graded as a task.

```bash
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/pi-ab.ts --suite heldout14 --seeds 41 \
  --variants hidden,control,neutral --conditions tools,eden,both+ask --day 4 --config default \
  --cards packages/sim/lab/cards/cards-v2.jsonl --model claude-haiku-5-5 --grader claude-haiku-5-5 \
  --card-model claude-haiku-5-5 --reader-model claude-haiku-5-5 --push signals \
  --source-profile packages/sim/lab/before-after/market-profiles/direct.json --budget 1 \
  --spend-ledger .local/ledger.jsonl --spend-cap 4 --spend-headroom 0.3 --run-label day-41 --out .local/day-41.json
```

- `--day K --late` (A9, `pi-late.ts`; docs/research/a9-ahead.md): each request's planted item (the hidden fact, or the
  control's look-alike) is held out of the world until the agent has answered that request, then arrives at its
  source as a new item (with `--push payload` its notice carries it: `sourceItems`; with `signals`, a notice), and the
  day goes on. The harness then waits for the item's card (up to 10 s, standing in for the ten minutes before the next
  request). No clock is moved before the recap. Each planted request's result gains `lateFacts` (the grader on its
  later replies that day, the next requests' answers and the recap, joined in `lateText`) and `lateTurns`: on a hidden
  day a true verdict is the agent correcting course, on a control day a false alarm. The request's own grade is
  expected to miss (the item did not exist yet). `packages/sim/lab/a9/late.py ARM BASE[,BASE] STEM…` reports it, paired.

```bash
A9_VC='{"plan":{"planConflict":true}}' packages/sim/lab/a9/run.sh a9-late-41 payload tools,eden,eden~plan \
  --seeds 41 --variants hidden,control --limit 12 --day 4 --late --budget 0.35    # ~$0.30 a seed
python3 -I packages/sim/lab/a9/late.py eden~plan eden,tools .local/a9/runs/a9-late-41
```

### 4b'. The server with no model key (`+nokey`, D291)

`eden+nokey` (or `both+ask+nokey`) runs Eden as a server with no `OPENROUTER_API_KEY` builds it: the same
`DEFAULT_CONFIG`, but no card enricher (no cards, no intent requests) and no reader. A harness flag like `+ask`, never
sent to the engine; refused on `tools`, `none` and `-judge` bases; the report pairs it with `eden`. D291's run
(`packages/sim/lab/a7/run.sh`, about $0.31 a seed for three arms on train with neutral, `--limit 12`):

```bash
packages/sim/lab/a7/run.sh a7-nokey-41 --seeds 41 --budget 0.4     # and 42; tools,eden,eden+nokey
bun packages/sim/src/lab/pi-ab-report.ts .local/a7/runs/a7-nokey-4{1,2}.json
```

### 4c. A long horizon: one user's days (`--days`, H16, CL5)

`--days D` replaces the per-suite, per-variant worlds with one world per seed: a user who brings D days of requests
(`--day-size`, default 12–20 a day), each day mixing hidden, control and neutral requests in `--mix` proportion
(default 1:1:8: a day of 12 has one hidden and one control request, a day of 20 two of each). The requests are the
named suites' templates (every suite must build `neutral`: train1–6, held-out 14–16), each used once per user, drawn
and ordered by the seed (`pi-user.ts`); every hidden request's item and every control request's decoy is planted in
the one world (refs renumbered so two suites' items cannot share an id), slots cleared as worldOf does, and the
header counts slot clashes (a planted item in another request's calendar slot; 0 on train seeds 41–42).

- **What persists.** Eden: one partner per user stream, so its sync, cache, cards and intent live across the days;
  one Eden session per day (`w<seed>:user:day<d>`). The agent: its transcript **resets each day** (a new conversation
  each morning; within a day it keeps every request, tool result and packet; nothing is compacted). Each day ends with
  pi-day.ts's recap turn (never graded, its cost kept apart) after the day's planted items change their times.
- **Clock.** The world's "now" is fixed, so Eden's clock moves `--gap-min` (10) minutes a request and `--night-h` (2)
  hours between days: 8 days of about 15 requests span about a day and a half of Eden's clock, close to the short
  horizon's 32 hours a world, instead of aging every item a week against requests written for that fixed now.
- **Cost accounting** (`pi-cost.ts`, `pi-cost-report.ts`, also for any short-horizon run): per task, the agent and
  Eden's per-task calls (the reader); Eden's background while the user works (cards and intent for new and changed
  items, `Background.cardsUsd` less `setupUsd`) spread over the user's tasks; the one-time backfill per user (the
  enrichment before the first request, `setupUsd`, or, with `--lifetime`, a measured cold start from
  `cold-start.ts --users user:41,user:42`, which builds the same users with no replay). Two totals: **steady state per
  task** (no one-time backfill) and **all-in over the run** (the backfill spread over the user's tasks in the run);
  both also weighted 1:1:8 for a short-horizon run. Plus reader and Eden connector calls a task (timeline spans), the
  agent's tool calls, wall p50 and mean, and a per-day table (the transcript's growth within a day).
- `--limit N` keeps the first N requests (the days cut to match); `--day`, `--variants`, `--templates` and
  `--reuse-arms` are refused with `--days`. One seed per process.

```bash
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/pi-ab.ts --suite train --seeds 41 --days 8 \
  --conditions tools,eden --config default --cards .local/cards-all.jsonl \
  --model claude-haiku-5-5 --grader claude-haiku-5-5 --card-model claude-haiku-5-5 --reader-model claude-haiku-5-5 \
  --source-profile packages/sim/lab/before-after/market-profiles/direct.json --push signals --budget 0.35 \
  --spend-ledger .local/ledger.jsonl --spend-cap 2 --spend-headroom 0.1 --run-label long-41 --out .local/long-41.json
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/cold-start.ts --users user:41,user:42 --days 8 \
  --spend-ledger .local/ledger.jsonl --spend-cap 2 --spend-headroom 0.1 --run-label cold --out .local/cold-user.json
bun packages/sim/src/lab/pi-cost-report.ts .local/long-41.json .local/long-42.json --lifetime .local/cold-user.json
```

`.local/cards-all.jsonl` is the checked-in card caches concatenated (`cards-v2`, `cards-train`, `cards-train-4344`),
as `bun run funnel --cards default` merges them. The CL baseline's figures and command lines are in
docs/research/cl-cl5.md.

**The agent's prompt cache (D260).** Billed agent cost on Anthropic depends on what the cache holds: Pi's agent with
Eden has a ~565-token fixed prefix that was not cached across tasks in CL8's runs (cause not established), the tools
agent an 867-token one that was, so one request at a time Eden's first prompt is written at 1.25x while the tools
agent's is read at 0.1x. Quote `python3 -I packages/sim/lab/cl8/cache.py [--prefix 565] STEM ...` (reads, writes, plain
input and output per arm and kind, from the timelines; `--prefix` adds the counterfactual with that prefix cached,
labelled so) beside billed figures, and compare arms within one run: an arm sending a task's identical prompt after
another arm reads it whole.

**Connector pricing (A3).** `pi-cost-report.ts` also counts every connector call (the agent's `tool.search_*`
calls, Eden's in each task's window, Eden's background calls between tasks and its one-time backfill, from
`Background.sourceCalls`/`setupSourceCalls`, recorded since A3) and prints every total again per plan
(`CONNECTOR_PLANS`: first-party 0, Composio 0.30, Unified.to 0.75, Arcade.dev 10, Pipedream 12, Zapier MCP 25.8 $ per
1,000 calls, from `before-after/market.py`) with eden − tools per plan. Runs recorded before it lack the background
and backfill counts (printed 0). Quote the long horizon's all-in: a short run spreads each stream's backfill over its
few tasks.

**Why, and the fix (D271).** `cache-probe.ts` (a few calls, $0.0003 an arm) sends each arm's first request as pi-ai
builds it, twice, the second with another task's user turn: the `eden` arm's tools-and-system prefix is about 500
tokens on the wire, under Haiku 5.5's 512-token minimum, so it is never read; the tools arm's 867 is. `--tenant-prompt`
adds a fixed ~550-token set of a tenant's house rules (`TENANT_GUIDE` in ab-common.ts) to every arm's system prompt,
and both arms' prefixes cache. Cost comparisons against the agent alone quote a `--tenant-prompt` run (recipe:
`packages/sim/lab/a3/run.sh`); the rules also change the agent alone (terser, fewer searches), so say the prompt is
an assumption. Measured (docs/research/a3-cost-speed.md): short mix +$0.060/1k (+0.042..+0.078), long +$0.080/1k
(+0.065..+0.095), Eden 0.96 s and 0.42 s faster.

```bash
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/cache-probe.ts --suite train1 --seed 41 \
  --spend-ledger .local/a3/ledger.jsonl --spend-cap 2 --run-label a3-cache-probe
```

**How packets stay across a session's requests (D336).** Pi keeps every request's packet in the day's transcript
(`kept`); `withContext` and an agent that does not store the message it returns send only the current packet
(`ephemeral`). On Anthropic's cache (entries end at breakpoints; pi-ai marks the last tool, the system prompt and the
last message) a dropped packet changes every later request's prefix, so the history is written again. `+ephemeral` and
`+ephemeralBp` (harness flags on a base with Eden, `--days` or `--day` only; `packet-layout.ts`) run those layouts, the
second with a breakpoint on the request's user turn. `session-cache-probe.ts` (about $0.003) shows the mechanism on the
wire over one session (`--dump` prints the bodies: pi-ai sends a system message placed before a user turn after it).
`packages/sim/lab/a16/earlier.py` says where each hidden task's planted item reached the agent (this packet, an ask,
only an earlier packet that day, nowhere). Measured (docs/research/a16-loop.md): ephemeral +$0.057/1k against kept over
days; with the breakpoint −$0.038/1k, but both lose the items first shown in an earlier packet, which Eden does not send
twice.

```bash
packages/sim/lab/a16/run.sh a16-long-41 payload tools,eden,eden+ephemeral,eden+ephemeralBp --seeds 41 --days 8 \
  --budget 0.35                                                                       # and 42
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/session-cache-probe.ts --requests 6 \
  --spend-ledger .local/a16/ledger.jsonl --spend-cap 2.5 --run-label a16-session-probe
python3 -I packages/sim/lab/a16/earlier.py .local/a16/runs/a16-long-4{1,2}
python3 -I packages/sim/lab/a16/turns.py .local/a16/runs/a16-long-4{1,2}   # output per tool turn and per final turn
```

### 4b. Regrade with another grader, and cold-start cost

- `regrade.ts --results F --graders claude-sonnet-5-5 --spend-ledger … --spend-cap …`: a `claude-*` grader goes
  through the lab provider on the ledger (no OpenRouter key needed); the summary adds `byKind` (agreement with the
  run's grader on hidden, control and neutral, and which way each disagreement went). `--only-concerns` regrades
  only the control and neutral answers the run's grader called a concern: W2b's check, 39 answers for $0.055
  (docs/research/fix-w2b-false-concerns.md). `--only-misses` regrades the hidden answers it called a miss and
  `--conditions a,b` keeps those arms (A2: Sonnet called 18 of 38 Haiku in-packet misses raised, $0.054).
  `--kinds hidden`, `--only-raised` and `--sample N` (A12) keep a kind, the hidden answers called raised, and a fixed
  pseudo-random N of what is left.
- **The powered hidden measurement (A12, D315)**: the 91 targeted train templates × seeds 41–44 on Pi
  (`packages/sim/lab/a12/run.sh`, about $0.11 an arm a seed for hidden and control), Sonnet regrading every Haiku miss
  and a sample of its "raised" (`a12/regrade.sh`, about $0.0014 an answer), pooled by `a12/hidden.py` (an answer
  Sonnet did not see counts at its arm's sampled agreement). Paired intervals about ±4 points over 364 tasks; recipe
  and costs in docs/research/a12-quality.md ($2.46 for four arms, Sonnet regrades $0.82 of it).
- **A Sonnet 5.5 agent on Pi** (`pi-ab --model claude-sonnet-5-5`): the lab sends `thinking: between_tools`
  (`anthropicThinkingOff`), as Sonnet 5.5 refuses "disabled". About 30× Haiku's agent cost a task (A2, D270).
- **Where a false concern came from** (fix-w2b): each pi-ab task line keeps its packets' ways (`ways`: the reason's
  kind and cited ids; `reader` is the reader push) and its asks' answer text (`asks[].text`, cut at 5,000
  characters; an `Eden's reader:` line is a flagged item). `python3 -I packages/sim/lab/fix-w2b/attribute.py out.json
RUN.json …` attributes each concern's decoy to push-flagged, rule-path, ask-flagged, ask-listed or none.
- `cold-start.ts --users train1:41,…`: a new user's cards and intent from an empty cache through the servers'
  `buildPartner` (default configuration and budgets), the card role on Anthropic Haiku; calls, tokens and $ per user.
  `user:SEED` is recipe 4c's long-horizon user (with its `--suite`, `--days`, `--day-size`, `--mix`).

### 5. Live A/B on Hermes

```bash
bun packages/sim/src/lab/hermes-ab.ts --hermes-src $HERMES --concurrency 6 --suite train --seeds 41 \
  --variants hidden,control --conditions hermes,hermes+eden,hermes+eden~X --config default \
  --variant-config '{"X":{"myFlag":true}}' --cards packages/sim/lab/cards/cards-train.jsonl \
  --grader deepseek/deepseek-v4.1-flash --budget 1 --timeline .local/h-41 --out .local/h-41.json
bun packages/sim/src/lab/pi-ab-report.ts .local/h-41.json
```

`$HERMES` is a hermes-agent checkout at commit 06433066 with `<src>/.venv` (`uv sync --frozen --no-install-project
--extra mcp`: without the `mcp` extra Hermes lists no MCP tools and every `hermes+eden` stream stops with "Hermes has
no ask_context"). Hermes' prompt is
about 3× Pi's input tokens per request; on free models tasks after a stream's first averaged 22–26 s, and the full
nine-suite bench was estimated at 2.6 h at concurrency 6 if the rate limit does not bind, 7.6 h at 18 requests a
minute on free models (hermes-lab.md, estimates).

`hermes-eden` (A16) gives Hermes Eden's `ask_context` and plugin with no `search_<source>` tools, as Pi's `eden` arm
has none: `hermes+eden` keeps them (Pi's `both+ask`), so a "Hermes keeps searching" comparison against Pi's `eden`
compares two arm shapes. The report pairs `hermes-eden` with `hermes` and with `hermes+eden`.

### 5b. Market connectors and change notifications (both harnesses)

`connector-options.ts` gives `pi-ab.ts` and `hermes-ab.ts` the same three flags:

- `--source-profile FILE|JSON` overrides `REALISTIC`'s latency, error rate or rate limit per source. The two market
  profiles (estimates: measured network floor plus how each API searches, docs/research/eden-market-effect.md) are
  `packages/sim/lab/before-after/market-profiles/{direct,hosted}.json`.
- `--push signals|payload`: every sim source `notifies` (the engine acts on it with `syncPush`). `signals` sends a
  change notification per source before each task with chance 1 − exp(−rate); the rates per hour come from
  `--push-rates` (default `gmail=4,slack=6,calendar=0.3,drive=0.3,crm=0.2`, assumed). `payload` models
  notifications that carry their items, which in a static world means none and no poll. With `--days`, the change
  before each day's recap is sent as the moved items (`sourceItems`) under `payload` and as a bare signal under
  `signals` (D272; before it a bare signal in every mode, which put ~650 ms of re-reads on Eden's path in every long
  payload run; `--recap-notice signal` reproduces it, A8).
- **Connector calls over a user's days at $0 (A8, `days-calls.ts`):** the `--days` user through Eden alone (no agent,
  no model, time scale 0), every connector call counted by source, operation and phase (request, notice, the sync's
  tick, the one-time backfill): `bun packages/sim/src/lab/days-calls.ts --seeds 41,42 --days 8 --push payload --ask
--cards .local/a8/cards-all.jsonl [--night-h 20] [--recap-notice signal] [--set JSON]`, about 10 s. pi-ab's 2 h
  nights put eight days in about 36 hours of Eden's clock (the daily sweep runs about once a user); `--night-h 20`
  gives 24-hour days for per-user-day figures (docs/research/a8-connector-calls.md).
- The results header records both (`sourceProfile`, `push`).

`market.py` (in `packages/sim/lab/before-after/`) prices a run's `tools` and `eden` arms per agent model and
connector plan; `--reuse-arms` copies the `tools` arm of an earlier run on the same profile, so only Eden is paid for.

### 5c. Staleness (no model, `bun run sim`)

The quality runner (`quality-cli.ts`) changes the world during a run and counts what Eden delivers stale:

- `--updates RATE`: facts with a clock time move one to three hours before a later session (`updates.ts`); a delivered
  copy still showing the old time is `updates.staleDelivered` of `updatedDelivered`.
- `--deletes RATE`: fact-stating items are deleted at the source before a later session (`planDeletes`); a packet
  item or an ask citation of one is `deletes.deletedDelivered` / `deletedCited`.
- `--push none|signals|payload`: how changes reach Eden (signals call `sourceChanged`; payload calls `sourceItems` and
  `sourceRemoved`). `--lost-notices P` (A8) loses each source's notice for a change with chance P (its own random
  stream; `lostNotices` counts them), for what a backstop such as the sweep must catch (D297).
  `--null-proves-nothing` (A8) makes the sim sources fetch as MCP connectors do: a null re-read does not prove the
  item gone (`fetchReportsGone` false, D298). `freshness` reports `verifyDelivery`'s re-reads (checked, confirmed,
  changed, gone, failed, calls).

D126's matrix: `bun packages/sim/src/quality-cli.ts --users 8 --sessions 20 --updates 0.6 --deletes 0.05
[--push signals|payload] [--config '{"verifyDelivery":false}'] [--jobs 4]`, $0 (`verifyDelivery` is in the
default and acts only on signals). Do not pass
`--sync`: it is an oracle that reloads every item each session and hides staleness.

Speed (audit 2026-11-05, sim-reindex-memo; 4 cores, wall time of one run each):

- Ranges are the signals, payload and `verifyDelivery:false` runs at load averages 1.5–4.9.
- Every update or delete rebuilds the touched connector's index (`SimSource.reindex`). Each item's words, term
  counts and folded text are memoised per item object (`analyse` in `sources.ts`), and each memo entry is recomputed
  when the item's title or text no longer match the ones it was computed from (`applyUpdate` edits items in place). A
  reindex therefore re-reads only the changed items and rebuilds df and the postings: 20.8–22.2 s → 10.6–15.4 s.
- `--jobs N` runs N processes of quality-cli.ts, each on a contiguous `--user-range A:B` with the seeds those users
  have in the whole run. Each shard prints its raw tally (`--tally`). The parent merges the tallies (`mergeTallies`:
  counts summed, latency and byte samples concatenated) before any ratio or percentile is taken, so the JSON is the
  one-process run's, byte for byte, apart from `wallSeconds`, `latency` and `cpu`. `--jobs 4`: 5.0–7.3 s.
- `--jobs` is refused with `--live` (each shard would spend on its own, outside a shared ledger) and with
  `--timeline` (one file, one writer).

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
