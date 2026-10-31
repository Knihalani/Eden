# Moonshots combined: sync, graph, cards, anticipation, Pi and telemetry on one tree

Status: 2026-10-31, branch `moon/combined` (base `5ce8f93de`, D55's H). Six track branches merged, every flag off by
default; proposed decisions D56–D62. Every number below was produced in this session on the final tree unless a row
says otherwise, and is labelled **in-sample** (suites hidden and held-out 1–4, the realistic and zoo simulations: all
used while the tracks were built) or **blind** (held-out 5–8, run once, after the configuration was chosen). No live
agent run was made in this session; the only live spend here was $0.0087 of card enrichment for the blind suites.

## What was merged

| Track | Branch | Decision | Flags (all off by default) | Kept as |
|---|---|---|---|---|
| Telemetry | `moon/telemetry` | D56 | `spans`, `PartnerDeps.onSpan` | the one span design every other track now reports into |
| Sync ("Eden Atlas") | `moon/sync` | D57 | `sync` and its `sync*` settings; `McpSource.listTool`; cache `maxSyncedPerUser`, `syncTtlMs` | as built |
| Knowledge graph | `moon/graph` | D58 | `graph`, `graphMerge`, `graph*` settings | as built |
| Implication cards | `moon/cards` | D59 | `cards`, `cardItems`; `PartnerDeps.cards` | plus: synced items are carded too |
| Anticipation | `moon/anticipate` | D60 | `anticipate`, `anticipate*`; protocol `user_message.draft` | plus: prefetches answer synced sources locally |
| Pi harness | `moon/pi` | D61 | none (lab only) | its span sink replaced by D56's |

Every track's code was sound and flag-gated; none was left out. What the merge had to reconcile:

- **Two span designs.** `moon/pi` added its own `Span {sessionId, name, start, end, calls}` sink to the engine;
  `moon/telemetry` added the full tracer (`spans.ts`). The combined tree keeps telemetry's only. `pi-ab.ts` now routes
  each engine span to its task by the span's root session (`spanRouter` in `pi-timeline.ts`, which waits for a root
  that closes after its children) and maps the names onto its timeline's (`probe.person` → `probe:person`,
  `probes.grace` → `probe-wait`, `model` → `judge` or `answer`). Pi's lab `timeline.ts` became `pi-timeline.ts`
  beside telemetry's `timeline.ts`. New tests cover both.
- **Spans in the new subsystems.** `sync.freshen` (a lookup's on-demand poll) and `sync.list` (every listing call, by
  phase: backfill, poll, demand, sweep); `graph.walk`; `cards.match` (request time) and `cards.make` (each background
  enrichment call); `anticipate.prefetch` and `anticipate.early`. All content-free (D19). The source wrapper used when
  tracing now passes `list` through.
- **Probe plumbing.** Sync's `local` sources and anticipation's `ProbeOpts` are one options object (`ProbeOpts.local`);
  a probe sent offline (anticipation's read) or to a synced source answers locally first. The prefetch and the early
  decision read synced sources locally too (`localOf`).
- **Candidates.** One `eligible()` for every path (lookup, anticipation's early and served paths): the graph's own
  finds are excluded (they have their seats and ground), card finds included.
- **Cards with sync.** Items the sync stores (`SyncManager.onStored`) are queued for cards as looked-up ones are; the
  funnel and simulation wait for the enrichment after the backfill, as a long-running sync would have them.
- **Decisions renumbered** D56–D61 in merge order, plus D62 for the configuration.
- Each track had fixed the same date-dependent test (`partner.test.ts`, wall-clock TTL); one fix was kept.

Checks on the final tree: `bun run check` green (format, typecheck, tests); `bun run eval` JSON identical to
`5ce8f93de`'s except the latency fields (diffed). With spans on, the funnel's results equal spans off (H 148/128/21,
ALL 218/19).

## Experiment matrix (in-sample, free, this session)

Configurations: H (D55); H plus each helping track alone, as its track recommended — **S** = `sync` +
`consequenceProbe` + `probeRoles` (the sync track's HA), **G** = `graph` + `graphMerge`, **C** = `cards`, **A** =
`anticipate`; **ALL** = H + S + G + C + A; leave-one-out from ALL. Pi and telemetry add no behaviour flag. Every run
gives the funnel a clause lead-in draft and the simulation clause drafts (`--lead-in clause`, `--drafts clause`;
ignored with `anticipate` off: H gives D55's numbers exactly). Cards are replayed from the cards track's disk cache
(no model call at run time). "+sync" adds the real `SyncManager`; "−nosync" removes `sync` but keeps the S track's two
probe flags.

### Funnel (no model; hidden + held-out 1–4, seeds 41–44; 268 hidden + 268 control tasks) — in-sample

Delivered and decoys of 268; calls per task are request-time source calls (searches, probes, on-demand polls, a
draft's prefetch); "amortised" adds the sync's backfill (18 calls per user) and background polls.

| Config | Returned | Delivered | Decoys | Decoys / delivered | Calls / task | Amortised |
|---|---|---|---|---|---|---|
| H | 148 | 128 | 21 | 0.164 | 8.49 | – |
| H + S (HA) | 2 | 172 | 18 | 0.105 | 3.04 | 4.38 |
| H + G | 148 | 132 | 21 | 0.159 | 8.50 | – |
| H + C | 148 | 132 | 19 | 0.144 | 8.49 | – |
| H + A | 154 | 132 | 21 | 0.159 | 9.21 | – |
| **ALL** | 61 | **218** | 19 | 0.087 | 5.55 | 6.89 |
| ALL − S (G + C + A) | 154 | 136 | 19 | 0.140 | 9.21 | – |
| ALL − G | 61 | 195 | 19 | 0.097 | 5.55 | 6.89 |
| ALL − C | 61 | 203 | 18 | 0.089 | 5.55 | 6.89 |
| ALL − A | 2 | 213 | 16 | 0.075 | 3.04 | 4.38 |
| With and without the real sync | | | | | | |
| H + sync | 2 | 153 | 18 | 0.118 | 3.03 | 4.37 |
| H + S − sync | 160 | 141 | 21 | 0.149 | 9.13 | – |
| H + G + sync | 2 | 193 | 18 | 0.093 | 3.03 | 4.37 |
| H + C + sync | 2 | 184 | 16 | 0.087 | 3.03 | 4.37 |
| H + A + sync | 61 | 168 | 18 | 0.107 | 5.49 | 6.84 |
| **R** = ALL − `sync` | 168 | **152** | **18** | 0.118 | 9.94 | – |
| ALL − S + sync | 61 | 218 | 20 | 0.092 | 5.49 | 6.84 |
| R − G | 168 | 144 | 18 | 0.125 | 9.94 | – |
| R − C | 168 | 152 | 20 | 0.132 | 9.94 | – |
| R − A | 160 | 150 | 19 | 0.127 | 9.14 | – |

"Returned" counts the planted item coming back from a live search; with the sync most sources answer locally, so it
reads near 0 and says nothing about recall. Every config's decoy ratio is far under the 0.5 bar.

Per suite (delivered / decoys): H hidden 24/4, held-out 26/1, held-out 2 28/3, held-out 3 24/7, held-out 4 26/6;
R 30/4, 28/2, 34/3, 28/5, 32/4; ALL 37/4, 36/0, 50/3, 48/4, 47/8.

Decoy paths: H sources 12, fallback 9; R cache 13, fallback 5; ALL fallback 12, cache 4, sources 3.

### Realistic simulation (planner on, seeds 41–44, drafts) — in-sample

Recall and precision pooled over seeds; soft fire rate is the mean over seeds (as D53–D55 report it); calls are
request-time per lookup, in brackets with the sync's backfill and background; $ per 1,000 turns is the perfect judge's
modelled cost.

| Config | No model: recall / precision / soft | Perfect judge: recall / precision / soft | Calls / lookup | B / needed fact (perfect) | $ / 1k turns | Hard false fires |
|---|---|---|---|---|---|---|
| H | .407 / .639 / .086 | .645 / .952 / .045 | 7.78 | 432 | .0170 | 0 |
| H + S | .423 / .605 / **.121** | .779 / .951 / .017 | 0.86 (1.72) | 421 | .0220 | 0 |
| H + G | .407 / .639 / .086 | .654 / .955 / .045 | 7.80 | 431 | .0180 | 0 |
| H + C | .408 / .638 / .086 | .645 / .952 / .045 | 7.78 | 433 | .0170 | 0 |
| H + A | .424 / .642 / .057 | .654 / .972 / .017 | 7.80 | 427 | .0182 | 0 |
| ALL | .431 / .595 / **.121** | **.795 / .990 / .000** | 1.25 (2.10) | 416 | .0243 | 0 |
| ALL − S | .431 / .638 / .057 | .663 / .972 / .017 | 7.83 | 430 | .0192 | 0 |
| ALL − G | .427 / .593 / .121 | .789 / .989 / .000 | 1.24 (2.10) | 413 | .0238 | 0 |
| ALL − C | .432 / .603 / .121 | .794 / .990 / .000 | 1.25 (2.10) | 415 | .0238 | 0 |
| ALL − A | .423 / .596 / .121 | .787 / .952 / .017 | 0.86 (1.72) | 425 | .0230 | 0 |
| **R** | **.433 / .635 / .057** | **.679 / .972 / .017** | 7.88 | 421 | .0195 | 0 |
| R − G | .428 / .634 / .057 | .670 / .972 / .017 | 7.86 | 419 | .0190 | 0 |
| R − C | .431 / .638 / .057 | .679 / .972 / .017 | 7.88 | 421 | .0195 | 0 |
| R − A | .407 / .639 / .086 | .658 / .958 / .045 | 7.87 | 434 | .0185 | 0 |
| H + S − sync | .406 / .639 / .086 | .645 / .954 / .045 | 7.87 | 434 | .0178 | 0 |

No-model calls per lookup: H 7.76, H + A 8.55, R 8.76, ALL 1.26 (2.16). `bun agg2.ts` (the workflow's aggregator)
gives the same rows.

**Every configuration with the sync fails the no-model soft fire bar (≤ 0.10) at 0.121.** Per seed, H's soft fires
are 0, 3, 3, 0 of 6, 15, 21, 11 soft turns; every sync config's are 1, 2, 2, 1 — the same six fires, spread over the
two small seeds instead (pooled, both are 6 of 53 = 0.113). Six variants of ALL (no `consequenceProbe`, no
`probeRoles`, neither, `syncLocalAll` off, `syncStaleChance` 0.5, no `fallbackAsks`) all give 0.121 with the same
per-seed counts (in-sample exploration, realistic, 4 seeds × 2 judges each). The bar, read as D53–D55 read it, is not
met; whether a per-seed mean over 6-turn seeds should decide it is a question for the owner (D62).

### Zoo-a and zoo-b (seeds 41–42, never tuned on by any track, but run before the choice) — in-sample

| Config | zoo-a no model (recall / prec / soft) | zoo-a perfect (recall / prec) | zoo-b no model | zoo-b perfect | Calls / lookup (perfect, a / b) |
|---|---|---|---|---|---|
| H | .411 / .645 / .134 | .596 / .954 | .434 / .635 / .217 | .717 / .970 | 7.71 / 7.84 |
| H + S | .427 / .612 / .150 | .753 / .943 | .427 / .612 / .150 | .753 / .943 | 0.88 / 0.88 |
| H + G | .416 / .646 / .134 | .602 / .954 | .434 / .635 / .217 | .725 / .971 | 7.71 / 7.86 |
| H + C | .409 / .645 / .134 | .596 / .954 | .434 / .629 / .217 | .717 / .970 | 7.71 / 7.84 |
| H + A | .416 / .637 / .100 | .632 / .977 | .440 / .651 / .100 | .730 / .980 | 7.50 / 7.87 |
| ALL | .437 / .608 / .150 | .769 / .982 | .437 / .608 / .150 | .769 / .982 | 1.26 / 1.26 |
| R | .424 / .637 / .100 | .653 / .978 | .440 / .648 / .100 | .743 / .985 | 7.70 / 8.01 |

With the sync, zoo-a and zoo-b give the same numbers: lookups answer locally, so the connectors' search styles no
longer matter. R's zoo-b perfect-judge calls per lookup (8.01) are over D54's 7.9 bar (`consequenceProbe`'s extra
call); that bar is not among this choice's constraints.

### Latency tier (realistic, 3 users × 6 sessions, real time, drafts, seeds 41–44) — in-sample

`bench.ts --latency` shape (`quality-cli.ts --users 3 --sessions 6 --planner --time 1`, perfect judge modelled at
900 ms), 139 must facts per configuration; delivery percentiles are per-seed means. Runs went 4–5 at a time on a
shared 4-CPU machine; five ALL runs were cut by a time limit and rerun alone. Small samples: read the medians, not
the tails.

| Config | Judge | Delivery p50 / p95 (ms) | Observe p50 (ms) | Recall | Precision | Calls / lookup | Process CPU (4 seeds) |
|---|---|---|---|---|---|---|---|
| H | none | 2,725 / 5,368 | 0.31 | .338 (47) | .639 | 7.76 | 21.4 s |
| H | perfect | 3,153 / 33,769 | 0.34 | .460 (64) | .948 | 7.87 | 21.1 s |
| R | none | 8 / 5,024 | 0.46 | .381 (53) | .659 | 8.65 | 23.7 s |
| R | perfect | 2,762 / 21,560 | 0.46 | .540 (75) | .962 | 8.15 | 25.3 s |
| ALL | none | 683 / 5,153 | 0.48 | .446 (62) | .601 | 0.81 | 28.0 s |
| ALL | perfect | 2,596 / 6,261 | 0.47 | .784 (109) | .990 | 0.87 | 28.1 s |

H matches the anticipation track's tier (2,723 / 5,367 ms with no model). With no model, R's median delivery is on
the observe call itself (anticipation's early decision from what the draft's prefetch brought); with a judge the slow
path decides, and the median moves little. ALL's p95 with a judge falls 33.8 s → 6.3 s: with sources answered
locally, judged lookups no longer wait on connectors.

### Where the time goes (telemetry spans, funnel, H and ALL) — in-sample

Recorded with `hidden-funnel --timeline` and read with `timeline-report.ts` (spans on: results identical).

- **H**: 19,048 spans; lookup-to-delivery p50 16.5 ms, p95 45.9 ms (connectors answer at once in this funnel). The
  critical path is the slow path's waiting on searches and probes (73% in `slow` itself, `probe.second` 6%, `ground`
  4%); traced engine CPU 1.5 s of 7.8 s process CPU, led by mentions, grounding, cache puts and the gate.
- **ALL**: 26,707 spans; lookup-to-delivery p50 8.9 ms, p95 14.9 ms. `sync.freshen` (the on-demand poll before a
  lookup) is 64.5% of the critical path. Process CPU rises 7.8 s → 24.7 s for the 40 simulated users: the sync's
  backfill redacts (`sanitize` 2.9 s) and records mentions for (`mentions` 2.4 s) every listed item; `cards.match`
  0.2 s and `graph.walk` 0.1 s of request-time CPU (p50 0.37 ms and 0.16 ms per lookup). 2,316 listing calls
  (`sync.list`), 970 replayed card batches (`cards.make`).

## The choice (in-sample evidence only)

Constraints: hard false fires 0; no-model soft fire rate ≤ 0.10; perfect-judge precision ≥ 0.94; decoys / hidden
delivered ≤ 0.5; bytes per needed fact ≤ 455 (perfect judge, realistic).

- Every configuration has 0 hard false fires, precision ≥ 0.943, a decoy ratio ≤ 0.164 and ≤ 435 bytes per needed fact.
- Every configuration with `sync` has a no-model soft fire rate of 0.121 and is out.
- Of the rest, **R = H + `consequenceProbe` + `probeRoles` + `graph` + `graphMerge` + `cards` + `anticipate`** has the
  most funnel deliveries (152, decoys 18) and the highest recall with and without a judge (.433 / .679), at soft 0.057,
  precision .972 and 421 bytes per needed fact. Each part pays in the leave-one-out: without the graph 144 delivered,
  without cards 20 decoys (deliveries equal), without anticipation 150 and recall .658, without the two probe flags
  (ALL − S) 136 and .663.
- Its costs: calls per task 8.49 → 9.94 in the funnel (a draft's prefetch and the consequence probe's query), 7.78 →
  7.88 per lookup with a judge (8.76 with none), model cost $0.0170 → $0.0195 per 1,000 turns, and the cards'
  background enrichment (below).

```json
{"probes":true,"compactInjection":true,"quietSettled":true,"groundAway":true,"judgeContested":true,"judgeItemBytes":200,"probeShare":true,"probeTopicAlone":true,"fallbackAsks":true,"groundConflict":true,"quietClear":true,"probeFresh":true,"probeYield":true,"densePacket":true,"groundOccasion":true,"quietNameOnly":true,"judgeTied":true,"consequenceProbe":true,"probeRoles":true,"graph":true,"graphMerge":true,"cards":true,"anticipate":true}
```

R + `sync` (= ALL) is the strongest configuration measured (218 of 268 delivered, perfect-judge recall .795 at
precision .990, request-time calls 1.25 per lookup) and is reported beside R; it waits on the owner's call on the soft
fire bar (D62).

## Blind: held-out 5–8, no model, run once after the choice

Held-out 8 was copied in and registered for this run ("written after D55, blind, measurement only"); its file was not
read beyond its header. Its cards were enriched for this run ($0.0087, 41 calls; 981 of 991 prefiltered items
carded); held-out 5–7's were already on disk. Nothing was changed after these runs.

| Config | Delivered (of 316) | Decoys (of 316) | Decoys / delivered | Calls / task (amortised) |
|---|---|---|---|---|
| H | 72 | 30 | 0.417 | 8.23 |
| H + sync | 80 | 32 | 0.400 | 2.93 (4.07) |
| **R** | **91** | **27** | **0.297** | 9.95 |
| R + sync | 128 | 36 | 0.281 | 4.96 (6.12) |

Per suite, delivered / decoys (decoy ratio):

| Suite (tasks) | H | H + sync | R | R + sync |
|---|---|---|---|---|
| held-out 5 (60) | 30 / 8 (0.27) | 36 / 8 (0.22) | 31 / 8 (0.26) | 48 / 12 (0.25) |
| held-out 6 (80) | 9 / 6 (0.67) | 8 / 4 (0.50) | 11 / 4 (0.36) | 18 / 4 (0.22) |
| held-out 7 (80) | 20 / 12 (0.60) | 21 / 16 (0.76) | 22 / 10 (0.45) | 32 / 15 (0.47) |
| held-out 8 (96) | 13 / 4 (0.31) | 15 / 4 (0.27) | 27 / 5 (0.19) | 30 / 5 (0.17) |

H on held-out 5–7 reproduces D55's blind figures exactly (59 delivered, 26 decoys).

Decoy delivery paths: H sources 15, grounded-conflict 9, fallback 6; R cache 8, fallback 8, anticipated-conflict 7,
grounded-conflict 3, grounded-card 1; H + sync fallback 12, grounded-conflict 12, cache 4, sources 4; R + sync
fallback 11, sources 7, anticipated-conflict 7, grounded-conflict 5, cache 4, grounded-card 2.

Read blind: R delivers 19 more planted items than H (+26%) with 3 fewer decoys, and is under the 0.5 decoy ratio in
every suite (H is over it in held-out 6 and 7). R + sync delivers 56 more than H (+78%) at 6 more decoys. Held-out 7
is the hardest for decoys in every configuration (0.45–0.76). The in-sample gains carry over smaller: R is +24 (19%)
in-sample and +19 (26%) blind; ALL is +90 (70%) in-sample, +56 (78%) blind.

## Costs

- **Sync** (D57): 18 listing calls per user to backfill a simulated world (~1,500 items); request-time calls per
  lookup 7.78 → 0.86–1.25 (realistic, perfect judge), 1.72–2.10 with backfill and background; heap about 4 MB per
  synced user of 1,500 items (sync track's `sync-cost.ts`, not re-run). Model cost rises with it ($0.0243 for ALL),
  because the judge sees more tied candidates.
- **Cards** (D59): $0.000181 per call of 10 items in the cards track's 572 calls; $0.000212 per call in this session's
  41 (more output per batch); about $0.003–0.004 per user-month at 50 new items a day (cards track's estimate, not
  re-measured).
- **Graph** (D58) and **anticipation** (D60): no model call; request-time CPU p50 0.16 ms (walk) and the prefetch's
  source calls (funnel +0.7 calls per task with a draft lead-in).
- Telemetry (D56) off costs one null check per phase.

## What is not known

- Nothing here is live. The Pi track's live run (D61, $0.452) measured H only.
- Card coverage: the replay leaves items without a cached card uncovered (394 in the synced in-sample funnel, 80 in
  the synced blind one); zoo-a and zoo-b items were not enriched, so cards there are mostly absent.
- The soft fire bar's reading (per-seed mean over 6–21 soft turns) decides between R and ALL; pooled, ALL equals H.
- The simulated worlds are small and static; the sync's caps, staleness model and memory are not stressed (D57).
- The reviewer subagent was not run (no agent tool in this session); the merge was reviewed by hand.

## Reproduce

Scripts in the session scratchpad (`comb/exp`): `mkcfg.ts` writes the configs; `job.sh` runs one funnel or simulation
(`hidden-funnel.ts --lead-in clause`, `quality-cli.ts --planner --drafts clause`, `--cards` when the config has cards);
`funnels.sh`, `sims.sh`, `latency.sh`, `spans.sh` and `blind.sh` run the matrix; `aggf.ts`, `agg3.ts` and the workflow's
`agg2.ts` aggregate.
