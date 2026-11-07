# Research index

Every note in this directory, newest work last within each group, with what it found and where it stands. Status
words:

- **adopted**: in the default. Since D112 the engine's `DEFAULT_CONFIG` is the unified default the servers run (NEWL,
  D99, plus the measured speed and memory switches); new behaviour enters behind a trial switch and is then promoted
  into the default or deleted (DECISIONS, "Trial switches").
- **adopted (tooling)**: a lab instrument, harness or method in use.
- **rejected**: measured and not taken; the code was removed or the flag left out of every recommended set.
- **superseded**: was adopted, then replaced by a later decision.
- **open**: proposed or partly measured; a decision is pending or a fresh pre-registered run is needed.

Dates are each note's status date, or its decision's date in docs/DECISIONS.md. DECISIONS wins any conflict with this
table. The historical recommended configurations by name: H (D55) ⊂ R (D62) ⊂ ALL (D64) ⊂ ALL3 (D80) ⊂ NEW (D98) ⊂
NEWL (D99) ⊂ the unified default (D112); ALL5 (D92) and ALL4 (D84) branched off ALL3. The named presets were deleted by
D112: the lab's presets are only `default`, `minus-<part>` and `minus-all` (`packages/sim/src/lab/presets.ts`).

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
| [moon-cards.md](moon-cards.md) | 2026-10-31 | D59 | Implication cards made in the background by a model, matched at request time with no model; negative result (2026-11-03b): card action triggers, kind gating and age cuts cannot reach 3x (the action lexicon is the limit) | adopted (ALL3); triggers rejected |
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
| [edge-bridge.md](edge-bridge.md) | 2026-11-01 | D89, D90, D93, D184 | Request-time bridging query (`bridgeQuery`); constraints digest (`constraintDigest`) | bridge deleted (D112); request-side expansion closed, not rebuilt (D184); digest left out (decoys) |
| [edge-freelab.md](edge-freelab.md) | 2026-11-01 | D91 | The lab on OpenRouter free models: `--allow-logging`, one pacer, request caps; free grader choice | adopted (tooling, lab only) |
| [edge-combined.md](edge-combined.md) | 2026-11-01 | D92, D93 | ALL5 = ALL3 + intent + bridge + guard + bearing, chosen on dev only | open (needs its pre-registered live A/B) |

## Broad tuning set and the Haiku campaign (2026-11-02)

| Note | Date | Decisions | Summary | Status |
|---|---|---|---|---|
| [broad-set.md](broad-set.md) | 2026-11-02 | — | train1–6 written blind; four rule-based tracks (ledger, ranker/gate, lexical bridge, validity) do not generalise; misses are reading, not retrieval | train adopted (tooling); the four tracks rejected |
| [hermes-lab.md](hermes-lab.md) | 2026-11-02 | — | Hermes Agent with and without Eden: harness, smoke and a blind free-model run; full-bench estimates | adopted (tooling) |
| [haiku-opt.md](haiku-opt.md) | 2026-11-02 | D95, D96, D97 | The ask-time reader on Haiku 5.5; prompt v5 labels lookalikes; `askReaderDrop`, `readerPush` | adopted (NEW) |
| [new-minus-intent.md](new-minus-intent.md) | 2026-11-03 | D109 | NEW and NEWL without the intent index on train: −8.6 and −8.3 points of hidden for 16.9× fewer background items; intent kept | rejected (dropping intent) |
| [haiku-benchmark.md](haiku-benchmark.md) | 2026-11-02 | D97, D98 | NEW vs ALL3 vs tools in Pi and Hermes, blind held-out 5–8 and 10–12: +22.8 / +23.9 points hidden raised, $24.36 | adopted (NEW is the recommendation) |
| [distilled-reader.md](distilled-reader.md) | 2026-11-03 | D110 | A no-model cascade in front of the reader, trained on Haiku labels from train1–6: planted-vs-decoy AUC 0.544; blind 1.09× fewer reader calls at equal hidden, decoys +2.3 points | rejected (`--distill` kept as lab tooling) |
| [wave2-reader.md](wave2-reader.md) | 2026-11-03 | D115–D118, D184, D185 | Four audit leftovers on the reader: a constraint-item pool universe (+4.7 hidden, +4.7 false concerns on held-out 13), reusing the push's verdict (fewer calls, fewer facts), gating actions instead of the start (−6.2 hidden), and a subset replay for $0 screens (matches a real 15-item reading exactly on 82% of calls over train, 87% on a shard where a same-prompt rerun matches 88%) | rejected (D115, D116, D118); adopted (tooling, D117) |
| [live-checks-1104.md](live-checks-1104.md) | 2026-11-04 | D123, D124 | The current default live on blind held-out 13 (Pi, Haiku 5.5): 73.4% hidden, 0 false concerns, as D112, minus-reader −18.8 points; the landlord gate trial (R3-19) live on train: hidden 262 → 256 of 384, false concerns 4 → 4, reader calls +0.2% (+9.1% in gate-traffic, every missed landlord binding fixed), promoted | adopted (D123, D124) |
| [final-before-after.md](final-before-after.md) | 2026-11-04 | — | The engine before the campaign (18366d039: its default with and without its judge, and ALL3) against today's default, same lab, Haiku 5.5, blind held-out 13, seeds 41–44: hidden facts Pi 29.7% (keyed old product) / 45.3% (ALL3) → 72.7%, Hermes 10.2% / 32.0% → 67.2%; false concerns 1 of 256; no-key eval precision 0.889 → 0.828; memory per user −30%; agent + Eden $0.6–0.8 per 1k tasks, $1.6 with the cold card backfill | measurement (no decision) |
| [eden-market-effect.md](eden-market-effect.md) | 2026-11-04 | — | Eden against the agent alone at market connector latency (estimated direct-API and hosted-platform profiles) and market prices (Haiku/Sonnet/Opus 5.5 agents; first-party APIs, Composio, Unified.to, Arcade, Pipedream, Zapier MCP): hidden facts 9.4% → 80.5% (direct) and 5.5% → 77.3% (hosted); hidden tasks 0.8–1.5 s faster, control within noise; agent prompt −43%; cost +5% (Opus) to +382% (Haiku) on free APIs and +38–77% on per-call platforms, where Eden's background sync polls dominate (−43 to −49% if sync used change notifications, not built) | measurement (no decision) |
| [cost-fixes.md](cost-fixes.md) | 2026-11-04 | D125 | `cardsLean` and `syncPush` into the default, ask coalescing rejected: Eden's model spend $1.67 → $1.17 per 1k tasks (cards $0.90 → $0.39), Eden's connector calls 3.8–5.1 → 0.6–0.8 per task with item-carrying notifications (agent + Eden now 38–61% below the agent alone), hidden facts +0.0 / −0.4 points against the old default rerun (n = 256); on Pipedream with Haiku the agent + Eden cost goes from +54% over the agent alone to −43% | adopted |
| [freshness.md](freshness.md) | 2026-11-05 | D126 | Re-read on a change signal joins the default (sim: stale updates 7/44 → 1/43, deleted deliveries 19 → 1, 0.48 re-reads per turn, nothing without signals); deletion notifications; re-reading by age (+4.6 connector calls and +0.33 s per task live, no measured gain) and age labels deleted |
| [graph-ablation.md](graph-ablation.md) | 2026-11-05 | D141, D150 | The knowledge graph against its cost, with the paid reader (Haiku 5.5, train1–6, seeds 41–42, $0.43): minus-graph loses 5 hidden facts from the reader's pool that both paid default runs surfaced and gains 1 (net +4 hidden, +2 decoys surfaced with the graph, of 384); totals 247/127 and 247/132 (default, two reads) vs 243/129; no change with no judge in the realistic sim or the eval. `ingest.bench.ts` now measures the shipped path: 358–381 µs/item backfill (5.2–5.4x the old line's 66–73), the graph's add 182–192 µs/item and 2.0x the heap; stage 2 (D150) reads 1,000 characters per item, `+graph` 2.1–2.3x cheaper with every train screen identical | decided (graph kept, D141; stage 2 promoted with no switch, D150) |
| [final-live-2026-11-05.md](final-live-2026-11-05.md) | 2026-11-05 | — | The shipped default (integration + D149, D150, timed-zone-day; dc0015f20) live on blind held-out 13, Haiku 5.5, Anthropic-direct lab transport: Pi seeds 41–44 hidden 77.3% vs tools 9.4% (+68.0, +59.4..+75.8), 0/128 false concerns, −3.1 (−10.2..+4.7) against the 2026-11-04 direct-4N run; Hermes seeds 41–42 70.3% vs 4.7%, 1/64 false concerns; Eden $0.834 per 1k tasks on Pi (cards $0.388, cold-cache upper bound; reader $0.445) against $1.325 before D125; $0.516 spent | measurement (no decision) |
| [graph-soa.md](graph-soa.md) | 2026-11-06 | D169 | The knowledge graph's storage as struct-of-arrays (typed columns per node, open-addressing tables in place of the key and item-id Maps, shared arenas, keys and labels copied into a character arena): `ingest.bench.ts` full `+graph` 1,703 → 719 B/item released (2.37x), backfill unchanged (70.1 → 70.0–72.2 µs/item); walks identical to the old storage over 200 seeds; funnel +0 −0 and eval unchanged. Adds `--world` (sim-world text) to the bench | adopted (stage 1, no behaviour change) |
| [compact-text.md](compact-text.md) | 2026-11-06 | D188 | Cached item text held deflated (`CacheLimits.packText`): `ingest.bench.ts --world` shipped 3,799-3,953 → 2,368-2,543 B/item released (1.55-1.60x), backfill 1.17-1.30x CPU; `pipeline.bench.ts` 1.01-1.04x; eval and funnel identical. A `TextDecoder` decode of Latin-1 text gives two-byte strings that slowed every regex 1.17x | adopted (trial promoted the same day) |
| [pi-cache-neutral-cost.md](pi-cache-neutral-cost.md) | 2026-11-06 | D171 | Paired Pi cost repriced cache-neutral beside billed (`pi-ab-report.ts`, `reprice.ts` with Haiku 5.5's cache-write price): on D159's pair the 47 identical-ask pairs read billed agent+Eden +0.0461 $/1k (CI +0.0194..+0.0724) but cache-neutral −0.0002 (−0.0212..+0.0177), the concurrent arms racing for one prompt cache; hidden-task cache-neutral +0.0305 (−0.0292..+0.0938) against billed +0.070 | adopted (tooling) |
| [ask-expansion.md](ask-expansion.md) | 2026-11-06 | D189 | No-model query expansion for the ask (audit F10): pseudo-relevance feedback over the user's own index added 130 items to 62 reader pools on train1–6 seeds 41–42 and no planted fact or decoy (pool 262/246 both arms; eval unchanged); 31 of the 58 never-ranked facts share no word with the request, whose distinctive words no item of the user holds, so every arm (PRF settings, verb synonyms) reached as many decoys as hidden facts | rejected |
| [realuse-1/A-heldout14.md](realuse-1/A-heldout14.md) | 2026-11-06 | – | RealUse-1 part A: the blind held-out 14 (32 templates, 8 life areas, new `neutral` variant) on Pi with Haiku 5.5 Anthropic-direct: hidden raised tools 0.203, eden 0.656, both 0.570 (eden − tools +0.453, CI +0.352..+0.555); false concerns on control 0/0/2 of 128, any concern on neutral 2/7/3 of 128 (no difference passes the gate); 1:1:8 mix all-in +0.499 $/1k and +0.60 s (eden − tools); blind funnel hidden 100/128, decoys 84/128, neutral any packet 55/128; $1.1087 | results |
| [benchmark-realuse-1-results.md](benchmark-realuse-1-results.md) | 2026-11-06 | — | RealUse-1, a benchmark of real use on Anthropic Haiku (design: benchmark-realuse-1.md; parts in realuse-1/): blind heldout14 with neutral tasks, Pi hidden 20.3% → 65.6% (+45.3), held-out 10–13 13.1% → 74.4% (false concerns 0.6% → 3.1%), Hermes +51.6 and +78.1; mix cost $0.35 → $0.85 per 1k, +0.6 s; freshness, robustness, privacy (a forged-line fix), speed and scale (5,100–7,400 users per 4-core box); $3.72 |
| [fix-s6-privacy.md](fix-s6-privacy.md) | 2026-11-07 | D220, D221 | RealUse-1 weak point 10: the secret gate redacts a bare New Relic key and presigned URL signatures (probe 48 → 49 of the original 50, presigned 1 → 5 of 5, plain, JSON-escaped and percent-encoded; 1 MB crafted worst 68-77 ms, linear); one line sanitiser (`safeLine`) for packets, answers and prompts, a forgeable judge prompt fixed, part D's injection probe a standing test; render.ts and reader.ts call sites listed for the merge; $0 | done |

Not in this directory: [../RESEARCH.md](../RESEARCH.md) (the Meta PMA paper and open questions),
[../plans/](../plans/) (the query-planner plan and `next.md`), [../LAB.md](../LAB.md) (how to run the lab).
