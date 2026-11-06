# RealUse-1: a benchmark of Eden as it is really used (design)

Status: design, 2026-11-06. Executed by parallel sessions; results in `benchmark-realuse-1-results.md`. Every paid call
goes to the Anthropic API with `HAIKU_API_KEY` (`claude-haiku-5-5` for every role: agent, grader, Eden's cards,
intent and reader) through the lab provider (D97), metered by a spend ledger with a hard cap. This is a lab transport:
the servers ship Haiku through OpenRouter (D12), so live figures are labelled "Anthropic-direct".

## What "real use" means here

A tenant's personal agent works through a user's day. Most requests need nothing from Eden. Some need a fact the
user's mail, calendar, docs, chat or CRM holds and the agent would not think to look for. Some look like they do but
must not trigger a warning (a resolved issue, another person's deadline). Sources change and delete things during the
day, connectors are slow, rate-limited and sometimes down, and many users share one server. Eden is judged on what the
agent does with it against the same agent without it, at the same price and latency, without leaking anything.

The benchmark therefore measures seven things at once, on one tree, with one ledger:

| Tier | Question | How | Paid |
| --- | --- | --- | --- |
| T1 Outcomes | Does the agent do better work with Eden, at what cost and latency? | Live Pi and Hermes A/B on blind suites | yes |
| T2 Decisions | Is each delivery right, at $0, deterministic? | `bun run eval` (31 scenarios), the funnel on train (stub and paid-reader replay), `--ask-diag`, blind funnel on the new suite | no |
| T3 Freshness | Is what Eden says current after changes and deletions? | `quality-cli.ts --updates --deletes --push none|signals|payload` | no |
| T4 Speed and scale | How fast, how much memory, how many users per core? | `pipeline.bench`, `ingest.bench` (shipped), `index-memory`, `router-sim.bench` (REALISTIC, hosted), `sim:perf` (HTTP load, soak, faults), `reader-time.ts` on Anthropic | reader-time only |
| T5 Robustness | What happens when connectors fail? | `quality-cli.ts` on the ZOO profiles (errors, 429s, outages), `sim:perf` faults, the router's crash/restart | no |
| T6 Privacy and safety | Does anything leak or act as an instruction? | eval privacy block (secrets planted, leaked, injections not inert), redact gate bench, ReDoS probe over crafted 1 MB inputs, isolation tests | no |
| T7 Shipped wiring | Does the shipped reader path behave as measured? | `eval-live.ts` on Anthropic (the servers' wiring, reader on Haiku) | yes, about $0.001 |

## T1 design (the headline)

- **A new blind suite, `heldout14`.** Every earlier held-out suite has been read (LAB.md), so T1's headline runs on a
  suite written for this benchmark by an author who sees no engine, ranking or prompt code: only the suite format
  (`hidden-heldout13.ts` as a format example), the sim world API and this document. 32 templates spread over every life
  area (work, family, health, money, travel, home, admin, social), phrased as real requests to a personal agent.
  Three variants per template:
  - `hidden`: the planted fact the agent should raise;
  - `control`: a near-miss decoy that must not be raised (resolved, another entity, condition already met);
  - `neutral` (new): the same request with nothing planted, which is what most real turns look like. It measures
    Eden's cost, latency and noise when it has nothing to add.
- **Continuity suites:** held-out 10–13 (read before, so labelled "read"), for comparison with earlier runs.
- **Conditions:** `tools` (the agent alone with read-only source tools), `eden` (the default, Eden as context and an
  `ask_context` tool), `both` (Eden beside the tools). Attribution on held-out 13 only: `eden` minus each part
  (`minus-reader`, `minus-intent`, `minus-sync`, `minus-grounds`, `minus-graph`), presets from `PARTS`.
- **Connectors:** the market `direct` profile for every arm; `hosted` for `tools` and `eden` on held-out 13 and 14.
  Change notifications on (`--push signals`, LAB.md 5b).
- **Seeds:** 41–44 for heldout14 and held-out 13, 41–42 for held-out 10–12 and the ablations.
- **Harnesses:** Pi for everything; Hermes for `hermes` vs `hermes+eden` on heldout14 and held-out 13, seeds 41–42.
- **Metrics per arm,** paired by task, bootstrap 95% intervals on differences:
  - hidden facts raised (share of must-facts), false concerns on `control`, any concern on `neutral`;
  - task wall time p50, p90, mean; Eden's share of the critical path;
  - agent tokens (input, cache read, cache write, output) and $; Eden's $ (reader, cards, intent, background);
  - connector calls (the agent's and Eden's, by kind: search, list, fetch);
  - reader calls per task, packet bytes per task, packets per task;
  - cost per 1,000 tasks re-priced per connector plan (`market.py`), and a **traffic-weighted** figure:
    1 hidden, 1 control and 8 neutral tasks in 10 (an assumption, labelled so).

## Gates for calling a result

Nothing here changes the product. The benchmark reports; any default it suggests changing goes through D112 later.
A difference is reported as a difference only when its 95% interval excludes zero. Every number in the results file
comes from a command run for this benchmark, and estimates are labelled.

## Budget

A hard cap of $30 for the whole benchmark across all sessions (each session its own ledger and cap; the sum is
reported). Estimate: Pi main arms on held-out 10–14 about $8, ablations about $3, hosted arms about $1.5, Hermes
about $3, heldout14 cards and intent enrichment about $0.5, reader-time and eval-live under $0.5 (about $16.5,
estimates from LAB.md's $0.13 per seed and arm on held-out 13).
