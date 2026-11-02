# packages/sim/src/lab — the benchmarks

Every number Eden is judged by comes from here: the hidden-context suites, the no-model funnel, the live agent A/Bs
on Pi and Hermes, the connector lab, and their reports. The runbook with copy-paste recipes and costs is
[docs/LAB.md](../../../../docs/LAB.md); this file is the map and the rules.

**Another session may be editing** `hidden-funnel, pi-ab, hermes-ab, hermes-host, hermes-proxy, hermes-worker,
cards-enrich, bridge-enrich, presets, suites, free, spend` (`.ts`): check `git log origin/main` before changing them.

## Key files

| File | Owns |
|---|---|
| `suites.ts` | `SUITES` by name, `parseSuites` (`all`, `heldout-all`, `train`), `UNRUN_BLIND` (left out of `all`) |
| `hidden-context.ts`, `hidden-*.ts` | The suites: each plants one item (hidden) or a near-miss decoy (control) per template in a world |
| `presets.ts` | `PRESETS`: H (D55), ALL3 (D80), ALL5 (D92), NEW (D96, recommended D98) |
| `hidden-funnel.ts` | The no-model funnel: each task through Eden alone; returned/cached/delivered, decoys, calls, ms; `--ask`, `--cards`, `--intent`, `--bridge`, `--reader`, `--timeline`, `--json` |
| `funnel.ts` | `bun run funnel`: the funnel with a preset, replayed cards and `--ask`, and the funnel score; refuses held-out suites without `--blind` |
| `pi-ab.ts`, `pi-conditions.ts`, `pi-timeline.ts`, `pi-ab-report.ts` | The live A/B on the Pi harness (the standard agent): conditions `none,tools,eden,both[-judge][~variant][+flag][@w<ms>]`, per-task timelines, report |
| `hermes-ab.ts` + `hermes-{conditions,host,proxy,worker,anthropic}.ts` | The same A/B on Hermes Agent (Python workers, `../../lab/hermes/`), Eden as MCP server + plugin |
| `ab-common.ts` | Tasks, prompts, tools, grader and results format shared by every A/B (comparable results) |
| `agent-ab.ts`, `agent-ab-report.ts` | The older in-house loop (label its results as such) and the shared report |
| `free.ts`, `spend.ts`, `free-smoke.ts` | Lab access: pacer, `--allow-logging`, `--rpm`, `--max-requests`, keys; the Anthropic spend ledger and cap |
| `cards-enrich.ts`, `cards-disk.ts`, `bridge-enrich.ts`, `bridge-disk.ts`, `reader-disk.ts` | Make once, replay free: cards (+ `--intent` requests), bridge queries, reader calls |
| `timeline.ts`, `timeline-report.ts` | `--timeline` spans, CPU% and RSS per second; where the time went |
| `ledger.ts`, `bench.ts`, `bench-compare.ts` | The benchmark ledger (`bench/ledger.jsonl`, `bench/runs/`) |
| `regrade.ts`, `reprice.ts`, `act*.ts`, `firewall-replay.ts`, `uptake.ts` | Re-grading, fixed-price re-costing (D71), action mode and firewall (D69), uptake |
| `rank-fit.ts`, `decide-fit.ts`, `cards-census.ts`, `*-reach.ts`, `graph-bench.ts`, `sync-*.ts` | Offline instruments for one track each |
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
- **Keys** are read by `keyFor`, never printed or put in results.
- **Budgets:** every live run passes `--budget` (a hard cap per process on everything it spends).
- **Record honestly:** funnel and `bench.ts` record to `bench/ledger.jsonl` unless `--no-record` (`bun run funnel`
  does not record unless `--record`); a run on a dirty tree is marked `dirty`.

## Pitfalls seen in this repo

- **One seed per `pi-ab.ts` process.** One process for four seeds over nine suites was killed for memory (14 GB;
  docs/research/pi-full-benchmark.md); the Haiku campaign ran three processes at once, RSS up to 3.35 GB each.
- NEW needs `--cards`, `--intent` (requests replayed) and a reader model; the harnesses wait 3,000 ms on the first
  observe (`@w<ms>` changes it; 1 s lost 7.6–18.1 points, D98).
- Pi's `both` arm gets no `ask_context` (only `eden` does); Hermes gets both.
- `--cards FILE` is only read; new cards go to `--cards-out` (default `<out>.cards.jsonl`): name it in later runs.
- Hermes needs a hermes-agent checkout with `<src>/.venv` (`uv sync --frozen --no-install-project`); the first task
  of each stream pays worker start-up (exclude it from wall times).
- Free and paid runs (and different graders) are not comparable: compare conditions within one run.
- Funnel decoys surfaced overstate harm: live agents reject most decoys (docs/research/broad-set.md).

## Test

```bash
bun run test:pkg sim                                 # includes the lab's unit tests
bun test ./packages/sim/src/lab/suites.test.ts       # the suite registry (ids unique per variant)
bun run funnel --suite train1 --seeds 41             # a quick end-to-end smoke (no model)
```
