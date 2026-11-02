# Research index

Every note in this directory, newest work last within each group, with what it found and where it stands. Status
words:

- **adopted**: in production defaults, or in the recommended experimental configuration (NEW, D98: ALL3 + `intent` +
  `askReader` + `askReaderDrop` + `readerPush`). Experimental flags stay off by default until the owner turns them on.
- **adopted (tooling)**: a lab instrument, harness or method in use.
- **rejected**: measured and not taken; the code was removed or the flag left out of every recommended set.
- **superseded**: was adopted, then replaced by a later decision.
- **open**: proposed or partly measured; a decision is pending or a fresh pre-registered run is needed.

Dates are each note's status date, or its decision's date in docs/DECISIONS.md. DECISIONS wins any conflict with this
table. The recommended configurations by name: H (D55) ⊂ R (D62) ⊂ ALL (D64) ⊂ ALL3 (D80) ⊂ NEW (D98); ALL5 (D92)
and ALL4 (D84) branch off ALL3 (`packages/sim/src/lab/presets.ts`).

## Foundations: primitives, language, architecture

| Note | Date | Decisions | Summary | Status |
|---|---|---|---|---|
| [primitives.md](primitives.md) | 2026-10-27 | D20 | Every `@eden/primitives` choice with its benchmark table (tokenizer, interner, hashing, top-k, S3-FIFO, BM25F) | adopted |
| [primitives-decision.md](primitives-decision.md) | 2026-10-27 | D20, D23 | Calibration, Thompson-sampling source selection and budgeted packing, checked against scipy/scikit-learn | adopted |
| [primitives-dedup.md](primitives-dedup.md) | 2026-10-27 | D20 | Reply stripping, SimHash/MinHash and sketches for near-duplicates; no library adopted, Bloom filters not shipped | adopted |
| [fast-primitives.md](fast-primitives.md) ([notes](fast-primitives-notes/)) | 2026-10-27 | D20 | Deep research: typed arrays and calibrated silence decide in well under a millisecond without a model | adopted (as the plan behind primitives) |
| [language-choice.md](language-choice.md) | 2026-10-27 | D22 | TS on Bun vs Bun built-ins vs Rust (bun:ffi, WASM, napi-rs): hot kernels stay TypeScript | adopted |
| [architecture-alternatives.md](architecture-alternatives.md) | 2026-10-27 | D24, D25, D26 | Worker pool for CPU off the event loop (opt-in), RE2 for the secret gate's backtracking rules (ReDoS) | adopted (RE2); pool opt-in |
| [simulation.md](simulation.md) | 2026-10-27 | D27 | `packages/sim`: generated worlds, realistic connectors, oracle judge, the real server under simulated agents | adopted (tooling) |
| [eval-suite.md](eval-suite.md) | 2026-10-28 | — | What each of the hand-written `bun run eval` scenarios covers | adopted (tooling) |

## Connectors and the query planner

| Note | Date | Decisions | Summary | Status |
|---|---|---|---|---|
| [connectors.md](connectors.md) | 2026-10-27 | D28 | Source-level reading of what real MCP connectors do with a query (AND, substring, OR, vector) | adopted (input to the planner) |
| [connector-lab.md](connector-lab.md) | 2026-10-27 | D28 | Real MCP servers over seeded backends: the cue's terms reach 0% on substring connectors, one call per entity 27–77% | adopted (tooling) |
| [query-planner-results.md](query-planner-results.md) (+ `query-planner-*.jsonl/.sh/.py`) | 2026-10-28 | D28–D33, D38, D39 | The planner built, its iterations, shadow phase and default-on gate | adopted (on by default, D33) |

## No-model paths, grounds and the judge (October)

| Note | Date | Decisions | Summary | Status |
|---|---|---|---|---|
| [no-model-fallback.md](no-model-fallback.md) | 2026-10-28 | D36 | Deliver the best candidate alone with no model when it holds ≥ 3 query terms and scores ≥ 0.8 | adopted |
| [refresh.md](refresh.md) | 2026-10-29 | D40 | Cached copies older than 2 h are not delivered from the fast path; the slow path delivers the current copy | adopted |
| [model-calls.md](model-calls.md) | 2026-10-29 | D43 | `ask` returns cited items with no model call by default | adopted |
| [grounding.md](grounding.md) | 2026-10-29 | D44 | Ground requests in people and time from item structure, before the word fallback | adopted |
| [live-judge.md](live-judge.md) | 2026-10-30 | D45 | Judge and ask answer with low reasoning effort and a cap that leaves room for a reasoning model | adopted |
| [agent-ab.md](agent-ab.md) | 2026-10-30 | — | First live A/B (in-house loop): tools vs Eden vs both on tasks that name what they need | superseded (Pi harness, D61) |
| [agent-hidden.md](agent-hidden.md) | 2026-10-30 | — | The same on hidden-context tasks, the case Eden is for (in-house loop) | superseded (Pi harness, D61) |
| [probes.md](probes.md) | 2026-10-30 | D46 | Probes: the checks a request implies (people, organisation, topic, day) | adopted (H) |
| [lean-probes.md](lean-probes.md) | 2026-10-30 | D47 | Probes start with the lookup's own search, bounded grace; compaction of injected items | adopted (H) |
| [sharper-grounds.md](sharper-grounds.md) | 2026-10-30 | D48 | Clash on overlap, absence ground, quiet on settled items, shared source calls | adopted (H) |
| [conflict-ground.md](conflict-ground.md) | 2026-10-30 | D49 | A structural conflict test (days, amounts, references) for no-model delivery; `quietClear` | adopted (H) |
| [probe-economy.md](probe-economy.md) | 2026-10-30 | D50 | `probeFresh`, `probeYield`: skip probes whose answer likely did not change or does not pay | adopted (H) |
| [dense-packets.md](dense-packets.md) | 2026-10-30 | D52 | Fold repeated occurrences, ground the event a request names | adopted (H) |
| [combined-config.md](combined-config.md) | 2026-10-30 | D51, D53 | The four flag sets on one tree; the standing-constraints register (D51) measured and removed | D51 rejected; D53's set superseded by H |
| [consequence-probe.md](consequence-probe.md) | 2026-10-30 | D54 | One query of an action class's fixed constraint vocabulary bridges the word gap with no model | adopted (in R/ALL3; left out of H by D55) |
| [name-only.md](name-only.md) | 2026-10-30 | D54 | A name alone is not a need: `quietNameOnly` | adopted (H) |
| [judge-tied.md](judge-tied.md) | 2026-10-30 | D54 | Judge only candidates tied to the request: `judgeTied` | adopted (H) |
| [serverless-bridge.md](serverless-bridge.md) | 2026-10-30 | D54, D55 | The three D54 flags combined; H chosen after review | adopted (H) |

## Moonshots (2026-10-31)

| Note | Date | Decisions | Summary | Status |
|---|---|---|---|---|
| [moon-telemetry.md](moon-telemetry.md) | 2026-10-31 | D56 | Engine-wide span tracing, a run recorder and report; two optimisations | adopted (spans off by default) |
| [moon-sync.md](moon-sync.md) | 2026-10-31 | D57, D63 | "Eden Atlas": background sync into a per-user local index | adopted (ALL3) |
| [moon-graph.md](moon-graph.md) | 2026-10-31 | D58 | Per-user knowledge graph with a 2 ms graph walk, no model | adopted (ALL3) |
| [moon-cards.md](moon-cards.md) | 2026-10-31 | D59 | Implication cards made in the background by a model, matched at request time with no model | adopted (ALL3) |
| [moon-anticipate.md](moon-anticipate.md) | 2026-10-31 | D60 | Read each event for what the agent will need next and prefetch it | adopted (ALL3) |
| [moon-pi.md](moon-pi.md) | 2026-10-31 | D61 | The Pi harness as the standard live agent, with a per-task timeline | adopted (tooling) |
| [moonshots.md](moonshots.md) | 2026-10-31 | D62, D63 | The six tracks on one tree; configuration R; review fixes | superseded (R → ALL → ALL3) |
| [pi-full-benchmark.md](pi-full-benchmark.md) | 2026-10-31 | D64 | First full Pi benchmark, 16,346 runs, $8.75: ALL raises the hidden fact 2.0× tools on blind suites | superseded (ALL → ALL3, D80) |

## Economics tracks (2026-10-31)

| Note | Date | Decisions | Summary | Status |
|---|---|---|---|---|
| [econ-lab.md](econ-lab.md) | 2026-10-31 | — | The shared lab base for the seven econ tracks (conditions grammar, timelines, re-pricing) | adopted (tooling) |
| [econ-judge.md](econ-judge.md) | 2026-10-31 | D65 | No judge on the critical path; `syncPollBehind`, `judgeBehind` | rejected in the blind run (D72); `syncPollBehind` alone open |
| [econ-background.md](econ-background.md) | 2026-10-31 | D66 | Cheaper cards (`cardsEconomy`) and sync (`syncPush`) | `cardsEconomy` adopted (ALL3); push open |
| [econ-decide.md](econ-decide.md) | 2026-10-31 | D67 | A found conflict always speaks (`decideConflict`) | rejected (D72: not in ALL3) |
| [econ-uptake.md](econ-uptake.md) | 2026-10-31 | D68 | Packets say dates whole (`packetDates`); what the agent does with a delivered item | rejected (D72: not in ALL3) |
| [econ-firewall.md](econ-firewall.md) | 2026-10-31 | D69 | The action firewall (`checkAction`, `POST /v1/check`) | open (opt-in, not recommended; D72) |
| [econ-oneturn.md](econ-oneturn.md) | 2026-10-31 | D70 | Can the first packet replace the ask round trip? No | rejected |
| [econ-research.md](econ-research.md) ([scripts](econ-research-scripts/)) | 2026-10-31 | D71 | Survey of facts found, cost and time; agent cost reported billed and re-priced | adopted (reporting method) |
| [econ-synthesis.md](econ-synthesis.md) | 2026-10-31 | D72 | Pre-registered blind evaluation of the econ tracks: ALL2 does not replace ALL | adopted (as the record of D72) |

## Generalisation, smarter asks, edge tracks (2026-11-01)

| Note | Date | Decisions | Summary | Status |
|---|---|---|---|---|
| [gen-ask.md](gen-ask.md) | 2026-11-01 | D73, D74 | Ask answers lead with what the question runs into (`askVerdicts`); `askCompact` | `askVerdicts` adopted (ALL3); `askCompact` open (not in ALL3) |
| [gen-proactive.md](gen-proactive.md) | 2026-11-01 | D75 | A wider conflict vocabulary (`conflictVocab`) | adopted (ALL3) |
| [gen-tokens.md](gen-tokens.md) | 2026-11-01 | D76–D78 | Fewer agent input tokens: `compactAsk`, `askDedup`, `compactParts` | adopted (ALL3) |
| [gen-combined.md](gen-combined.md) | 2026-11-01 | D79, D80 | ALL3 chosen and measured blind on held-out 10; held-out 5–9 recorded as contaminated | adopted (ALL3 is NEW's base; superseded as the recommendation by D98) |
| [smart-supersede.md](smart-supersede.md) | 2026-11-01 | D81 | Drop an item a newer one of its matter settles (`supersede`) | rejected (D85) |
| [smart-rank.md](smart-rank.md) | 2026-11-01 | D82 | A learned no-model ranker (`askRank`); `rankTies` rejected | rejected (D85) |
| [smart-askctx.md](smart-askctx.md) | 2026-11-01 | D83 | Rank an ask for its question and the session's request (`askContext`) | rejected (D85) |
| [smart-combined.md](smart-combined.md) | 2026-11-01 | D84, D85 | ALL4 vs ALL3 live on held-out 11: −0.019, below the bar | rejected (ALL3 stays) |
| [path-to-90.md](path-to-90.md) | 2026-11-01 | — | Where facts are lost; hypotheses ranked for reaching 90% of facts found | open (research note) |
| [edge-secret.md](edge-secret.md) | 2026-11-01 | D86 | An AWS secret access key passed the gate; `eden-aws-secret` rule, always on | adopted |
| [edge-intent.md](edge-intent.md) | 2026-11-01 | D87 | Intent index: synthetic requests per item, matched with no model | adopted (NEW) |
| [edge-ask.md](edge-ask.md) | 2026-11-01 | D88, D93 | Guided asking with a precision guard (`askGuard`), answer-shaped packets (`packetBearing`) | open (ALL5, not measured live) |
| [edge-bridge.md](edge-bridge.md) | 2026-11-01 | D89, D90, D93 | Request-time bridging query (`bridgeQuery`); constraints digest (`constraintDigest`) | bridge open (ALL5); digest left out (decoys) |
| [edge-freelab.md](edge-freelab.md) | 2026-11-01 | D91 | The lab on OpenRouter free models: `--allow-logging`, one pacer, request caps; free grader choice | adopted (tooling, lab only) |
| [edge-combined.md](edge-combined.md) | 2026-11-01 | D92, D93 | ALL5 = ALL3 + intent + bridge + guard + bearing, chosen on dev only | open (needs its pre-registered live A/B) |

## Broad tuning set and the Haiku campaign (2026-11-02)

| Note | Date | Decisions | Summary | Status |
|---|---|---|---|---|
| [broad-set.md](broad-set.md) | 2026-11-02 | — | train1–6 written blind; four rule-based tracks (ledger, ranker/gate, lexical bridge, validity) do not generalise; misses are reading, not retrieval | train adopted (tooling); the four tracks rejected |
| [hermes-lab.md](hermes-lab.md) | 2026-11-02 | — | Hermes Agent with and without Eden: harness, smoke and a blind free-model run; full-bench estimates | adopted (tooling) |
| [haiku-opt.md](haiku-opt.md) | 2026-11-02 | D95, D96, D97 | The ask-time reader on Haiku 5.5; prompt v5 labels lookalikes; `askReaderDrop`, `readerPush` | adopted (NEW) |
| [haiku-benchmark.md](haiku-benchmark.md) | 2026-11-02 | D97, D98 | NEW vs ALL3 vs tools in Pi and Hermes, blind held-out 5–8 and 10–12: +22.8 / +23.9 points hidden raised, $24.36 | adopted (NEW is the recommendation) |

Not in this directory: [../RESEARCH.md](../RESEARCH.md) (the Meta PMA paper and open questions),
[../plans/](../plans/) (the query-planner plan and `next.md`), [../LAB.md](../LAB.md) (how to run the lab).
