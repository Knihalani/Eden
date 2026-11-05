# packages/sim/src/lab — the benchmarks

Every number Eden is judged by comes from here: the hidden-context suites, the no-model funnel, the live agent A/Bs
on Pi and Hermes, the connector lab, and their reports. The runbook with copy-paste recipes and costs is
[docs/LAB.md](../../../../docs/LAB.md); this file is the map and the rules.

**Another session may be editing** `hidden-funnel, pi-ab, hermes-ab, hermes-host, hermes-proxy, hermes-worker,
cards-enrich, presets, suites, free, spend` (`.ts`): check `git log origin/main` before changing them.

## Key files

| File | Owns |
|---|---|
| `suites.ts` | `SUITES` by name, `parseSuites` (`all`, `heldout-all`, `train`), `UNRUN_BLIND` (left out of `all`) |
| `hidden-context.ts`, `hidden-*.ts` | The suites: each plants one item (hidden) or a near-miss decoy (control) per template in a world |
| `presets.ts` | `PRESETS`: only `default`, `minus-<part>` (one per `PARTS` entry) and `minus-all` (the core), made from @eden/engine (D112); `effective(override)` reads what a preset runs |
| `hidden-funnel.ts` | The no-model funnel: each task through Eden alone; returned/cached/delivered, decoys, calls, ms; `--ask`, `--cards`, `--intent`, `--reader`, `--timeline`, `--json` |
| `funnel.ts` | `bun run funnel`: the funnel with a preset, replayed cards and `--ask`, and the funnel score; refuses held-out suites without `--blind` |
| `funnel-merge.ts` | funnel.ts's arithmetic, tested in-process: `defaultJobs` (one process per core at `--time 0`, D139; `--time` > 0 shards concurrently), `groupShards` (blocks of suites × seeds per process at `--time 0`), `mergeParts` (parts to the one-process JSON, perTask from each row's own suite and seed), `amortisedCalls` (merged connector calls), `callMismatches` (processes whose traces miss calls) |
| `flags.ts` | Strict flags for the $0 CLIs (funnel, hidden-funnel, quality-cli): unknown flag, stray argument or missing value exits 2, `--help` prints usage; `labConfig` checks `--config`/`--set` with @eden/engine's `checkEngineConfig` |
| `pi-ab.ts`, `pi-conditions.ts`, `pi-timeline.ts`, `pi-ab-report.ts` | The live A/B on the Pi harness (the standard agent): conditions `none,tools,eden,both[-judge][~variant][+flag][@w<ms>]`, per-task timelines, report |
| `hermes-ab.ts` + `hermes-{conditions,host,proxy,worker,anthropic}.ts` | The same A/B on Hermes Agent (Python workers, `../../lab/hermes/`), Eden as MCP server + plugin |
| `ab-common.ts` | Tasks, prompts, tools, grader and results format shared by every A/B (comparable results) |
| `connector-options.ts` | `--source-profile` (market latency profiles), `--push signals\|payload` and `--push-rates` for both live harnesses (docs/LAB.md 5b) |
| `agent-ab.ts`, `agent-ab-report.ts` | The older in-house loop (label its results as such) and the shared report |
| `eval-live.ts` | `bun run eval --live` on Anthropic (claude-haiku-5-5, `HAIKU_API_KEY`, ledger role `eden.reader`): the eval's `liveWiring` (D128) with a `make` that returns `labModel`; `--thinking off\|adaptive`, `--usd-cap` (default 0.05), `--wait`; a lab transport, not what ships |
| `free.ts`, `spend.ts`, `free-smoke.ts` | Lab access: pacer, `--allow-logging`, `--rpm`, `--max-requests`, keys; the Anthropic spend ledger and cap |
| `cards-enrich.ts`, `cards-disk.ts`, `reader-disk.ts` | Make once, replay free: cards (+ `--intent` requests), reader calls; `SubsetReplay` (`--reader-subset`, D117: a missed prompt answered from a recorded superset pool, approximate and labelled) |
| `gate-traffic.ts`, `reader-latency-fit.ts` | No-model reader instruments: calls, gating and oracle-gate ceilings per preset (`--reuse`: cross-session verdict reuse); the reader latency fit (floor, ms per token) |
| `timeline.ts`, `timeline-report.ts` | `--timeline` spans, CPU% and RSS per second; where the time went |
| `ledger.ts`, `bench.ts`, `bench-compare.ts` | The benchmark ledger (`bench/ledger.jsonl`, `bench/runs/`) |
| `regrade.ts`, `reprice.ts`, `act*.ts`, `firewall-replay.ts`, `uptake.ts` | Re-grading, fixed-price re-costing (D71), action mode and firewall (D69), uptake |
| `distilled-reader.ts`, `distilled-fit.ts` | `--distill record\|labels\|cascade`: record the reader's verdicts as labels, replay them at $0, or put a no-model scorer in front of the reader (rejected, D110); `../../lab/distilled/run.sh` |
| `decide-fit.ts`, `cards-census.ts`, `graph-bench.ts`, `graph-memory.ts`, `sync-*.ts` | Offline instruments for one track each |
| `lab.ts`, `lab-cli.ts`, `connectors.ts`, `build.ts`, `capture.ts` | The connector lab: real MCP servers in Docker over seeded backends (`bun run sim:lab`) |

Scorers: `packages/sim/lab/scripts/funnel-score.py`, `reader-score.py`, `haiku-bench.py` (run with `python3 -I`).

## Rules

- **Never tune on held-out suites.** `heldout*` are measurement only; tune on `train` (the broad set) or
  `dev6a`/`dev6b`. Held-out 5–9 are contaminated (D80); 10 and 11 were run several times in the funnel (Haiku
  campaign); 12 was first read by a strong model in D98. A new blind round needs a new suite.
- **UNRUN_BLIND** keeps unrun blind suites out of `all`; the first run that names one spends it. The list in
  `suites.ts` still names heldout9–12 although D72, D80, D85 and D98 ran them: do not trust it as a "fresh" list.
- **Free models (D91):** `<id>:free` needs `--allow-logging` (prompts are logged; sim data only); every request goes
  through one `Pacer` (default 18/min with a free model; the account allows about 20/min and 1,000/day, retries
  count); `--max-requests` caps a run, and a capped run is PARTIAL and not recorded.
- **Anthropic (D97):** a `claude-*` model needs `HAIKU_API_KEY` (or `ANTHROPIC_API_KEY`) and `--spend-ledger FILE
  --spend-cap USD`, else the run stops before any call; parallel processes share one ledger, each keeping
  `--spend-headroom` clear. `--run-label` names a run's lines.
- **Live eval on Anthropic (`eval-live.ts`).** The shipped wiring (no judge, the servers' reader role from
  `modelRolesFromEnv`, `DEFAULT_CONFIG`) with only the transport swapped: Anthropic's Messages API direct instead of
  OpenRouter (D12's ZDR route, D95's throughput sort). Output says `provider: "anthropic-direct (lab, D97)"`; quote
  it as the same model family on another transport, never as production. The env handed to `modelRolesFromEnv`
  carries a placeholder OpenRouter key (its gate), never the real one, and `make` refuses any other. `--thinking off`
  (default) is how the lab's readers ran; `adaptive` sends the reader's "low" as effort low, nearer production, but
  is slower: at the eval's default `--wait 2000` it lost 2 of 6 calls to the wait (counted as reader failures, none
  logged; 0 at `--wait 10000`, 2026-11-05). About $0.001 a run (6 reader calls).
- **Keys** are read by `keyFor`, never printed or put in results.
- **Budgets:** every live run passes `--budget` (a hard cap per process on everything it spends).
- **Strict CLIs (audit 2026-11-03b).** funnel.ts, hidden-funnel.ts and quality-cli.ts parse through `flags()`; a new
  flag is added to the CLI's `known` list or it exits 2. Engine settings (`--config`, `--set`, the preset merged with
  them) go through `labConfig`/`checkEngineConfig`: unknown keys, wrong types, out-of-range numbers and a child flag
  whose parent flag the merged configuration has off (`PARENTS`, e.g. `syncPollBehind` without `sync`) exit 2.
  gate-traffic.ts, the A/B harnesses and eval's cli.ts do not use it yet; eval-live.ts does.
- **Record honestly:** funnel and `bench.ts` record to `bench/ledger.jsonl` unless `--no-record` (`bun run funnel`
  does not record unless `--record`); a run on a dirty tree is marked `dirty`.

## Pitfalls seen in this repo

- **One seed per `pi-ab.ts` process.** One process for four seeds over nine suites was killed for memory (14 GB;
  docs/research/pi-full-benchmark.md); the Haiku campaign ran three processes at once, RSS up to 3.35 GB each.
- The default needs `--cards`, `--intent` (requests replayed) and a reader for its model parts; without them they are
  inert (the funnel screens with `--reader stub` when none is named). Read settings through `effective()`: a preset
  is an override, and `default` is `{}`. The harnesses wait 3,000 ms on the first observe (`@w<ms>` changes it; 1 s
  lost 7.6–18.1 points, D98).
- Pi's `both` arm gets no `ask_context` (only `eden` does); Hermes gets both.
- **pi-ab and hermes-ab default to `--time-scale 1`** (since 2026-11-03): sources take their profiles' assumed
  latency, so the "Eden on the critical path" column includes the on-demand sync poll. Earlier results (every
  haiku-phase3 row) ran at 0, connectors instant; compare like with like. Use 0 only for a stated quality-only rerun.
  In the funnel the poll was about 91% of ALL3's critical path at `--time 1`; ALL3B cut ms/task 481.8 to 26.5 on
  train1–6 seeds 41–42 with an empty task-by-task diff (docs/research/haiku-phase3.md, note of 2026-11-03).
  Any pi-ab/hermes-ab Reproduce command dated before 2026-11-03 (hermes-lab.md, haiku-benchmark.md, edge-combined.md,
  edge-freelab.md and the rest) needs `--time-scale 0` added to reproduce its numbers: at 1 the tools conditions
  also get connector errors and per-second rate limits (sources.ts). `lab/haiku/run.sh` and `run-w.sh` pin 0.
- `--cards FILE` is only read; new cards go to `--cards-out` (default `<out>.cards.jsonl`): name it in later runs.
- Hermes needs a hermes-agent checkout with `<src>/.venv` (`uv sync --frozen --no-install-project`); the first task
  of each stream pays worker start-up (exclude it from wall times).
- Free and paid runs (and different graders) are not comparable: compare conditions within one run.
- **Pay once (`pi-ab.ts`):** `--replay DIR` replays the reader's and grader's calls (`DIR/{reader,grader}.jsonl`,
  keyed on the exact prompt, model, harness version, provider preferences and role) and appends new ones;
  `--replay-only` exits 3 on a miss; `--replay-timing` sleeps the recorded latency (without it, replayed calls take
  no time and the critical path understates Eden). `--reuse-arms F` copies `none`/`tools` from a matching earlier
  run (same model, grader, harness version, agent and grader prompts, time scale, seeds, suites, task wording; else
  it refuses). The prompts are checked by `promptsHash` (`armPromptsHash` in ab-common.ts: the system prompt, user
  turn, search tool, caps and grader prompt on a fixed probe); a results file without one cannot be reused. Both
  freeze one sample: fine for paired comparisons, but a variance estimate needs them off. The agent itself still runs
  live, and Hermes has neither yet (ab-replay.test.ts).
- **Report cost columns:** `(Eden)` is per-task calls only (reader, judge). Cards and bridge are booked to Eden's
  total but to no task: `bkfill` spreads each seed's background spend over its task runs with cards or bridge on,
  and `all-in` adds it. A stream's background spend is recorded as it happens, so a stream stopped early (budget,
  request cap) still counts. Reports from before 2026-11-03 lack it: `pi-ab-report.ts --reconcile report.txt
  --ledger ledger-summary.jsonl --run PREFIX` recomputes it from the spend ledger (docs/research/haiku-phase3.md)
  and exits 1 when the columns miss the header's Eden total by more than $0.01.
- Funnel decoys surfaced overstate harm: live agents reject most decoys (docs/research/broad-set.md).
- **`bun run funnel`'s ms/task is CONTENDED by default** (D139, since 2026-11-05): at `--time 0` it runs one process
  per core over blocks of suites × seeds. Quote latency, or diff ms/task against a `--baseline`, only from `--jobs 1`
  on both sides; the counts and the score do not depend on it (768 of 768 perTask rows identical).
- A wrapper around a sim source must copy `notifies` (and `listsByTime`) or `--push` silently does nothing: pi-ab's
  timing wrapper dropped it once, and the run polled as if no source notified.
- Hermes needs its `mcp` extra (`uv sync --frozen --no-install-project --extra mcp`), else "Hermes has no ask_context".

## Test

```bash
bun run test:pkg sim                                 # includes the lab's unit tests
bun test ./packages/sim/src/lab/suites.test.ts       # the suite registry (ids unique per variant)
bun run funnel --suite train1 --seeds 41             # a quick end-to-end smoke (no model)
```
