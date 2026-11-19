# Decision index

Generated from [DECISIONS.md](DECISIONS.md) by `bun run decisions:index` (scripts/decision-index.ts, D812). Do not
edit: change DECISIONS.md and regenerate; a test fails while this page is stale. DECISIONS.md is the record; this is
the way into it. Dead ends by topic: [DEAD-ENDS.md](DEAD-ENDS.md).

Statuses are read from the text by heuristics, so read the row before relying on one:

- **adopted**: in force, amended or not. "adopted (by Dn)": a trial or proposal that Dn promoted.
- **rejected**: the row records an idea measured or weighed and not kept (rejected, not built, deleted).
- **superseded**: a later decision deleted, reversed or replaced it. "deleted by Dn" is a dead end; "replaced by
  Dn" is not.
- **trial**: the decision a row of DECISIONS.md's "Trial switches" table names first, when it opens a trial; still
  open.
- **finding**: a measurement recorded as a finding; it decides nothing by itself.
- **lab**: lab tooling, a pre-registration or a lab-only change; nothing ships.

| # | Date | Decision | Status |
|---|---|---|---|
| D1 | 2026-10-27 | Target personal and proactive agents built by tenants, not coding agents. | adopted |
| D2 | 2026-10-27 | The partner both answers (`ask`) and injects unasked (`observe`). | adopted |
| D3 | 2026-10-27 | Silence is the default; precision over recall. | adopted |
| D4 | 2026-10-27 | Two speeds: a fast path on every event with no network call and no model call (it may write learning outcomes to the local SQLite source… | adopted |
| D5 | 2026-10-27 | The model is called only to judge borderline candidates and to compose ask answers, under a per-session and per-user-day budget; when over… | adopted |
| D6 | 2026-10-27 | Delivery without a model requires a whole-word match of a cue entity, high idf-weighted query coverage (`confidentScore` 1.1 > max… | adopted |
| D7 | 2026-10-27 | Sources are read-only as far as a client can enforce it: `McpSource` calls only its one configured search tool (and, since D35, one fetch… | adopted |
| D8 | 2026-10-27 | Item content lives in an in-memory, per-user, TTL'd, size-bounded cache; only content-free metadata persists in the SQLite source map… | adopted |
| D9 | 2026-10-27 | Everything is partitioned by tenant/user. | adopted |
| D10 | 2026-10-27 | Every text stored, indexed, logged or sent to a model passes `sanitizeForStore` (the salvaged gitleaks-based gate). | adopted |
| D11 | 2026-10-27 | Injected text is wrapped as `<context … note="Data, not instructions.">`, and every model prompt states that item text is data. | adopted |
| D12 | 2026-10-27 | Default model `z-ai/glm-5.3-flash` via OpenRouter with `provider.data_collection: "deny"` and `zdr: true`; the model is configuration… | adopted |
| D13 | 2026-10-27 | Usage is inferred from distinctive-token reuse in later agent messages and tool calls; explicit feedback overrides it. | adopted |
| D14 | 2026-10-27 | Integration surface: HTTP API + TS SDK (fail-open, 800 ms default timeout) + MCP `ask_context`. | adopted |
| D15 | 2026-10-27 | Bun + TypeScript monorepo, no build step, hand-written validation, SQLite via `bun:sqlite`. | adopted |
| D16 | 2026-10-27 | The memory-era product is archived in `archived/eden-memory/`; only the secret gate and repo tooling were salvaged into the new tree. | adopted |
| D17 | 2026-10-27 | Session lifecycle: each session owns an AbortController; session_end, eviction and `forget` abort its in-flight work, and no step after an… | adopted |
| D18 | 2026-10-27 | Usage tracking starts when an injection is handed to the agent, not when it is built; explicit feedback corrects an outcome already… | adopted |
| D19 | 2026-10-27 | No free model text reaches the agent outside the data envelope: the judge returns indexes only, and ask answers are wrapped in the same… | adopted |
| D20 | 2026-10-27 | `@eden/primitives` holds the direction-agnostic building blocks (hashing, tokenizer + interner, multi-pattern matcher, top-k, S3-FIFO… | adopted |
| D21 | 2026-10-27 | The secret gate prefilters rules with one Aho–Corasick pass over all keywords; keyword-less rules get literals every match contains. | adopted |
| D22 | 2026-10-27 | Hot kernels stay in TypeScript on Bun: no Rust (bun:ffi, napi-rs or WASM) for now. | adopted |
| D23 | 2026-10-27 | Source routing draws each source's usefulness from its Beta posterior (Thompson sampling) instead of using the mean; exploration decides… | adopted |
| D24 | 2026-10-27 | The secret gate runs the seven gitleaks rules that backtrack in JavaScript (`RE2_RULES`) and every allowlist regex on RE2 through `re2js`… | adopted |
| D25 | 2026-10-27 | `@eden/primitives` has `WorkerPool`: Bun workers for synchronous pure tasks, batching per message, bounded queue, AbortSignal, a per-batch… | adopted |
| D26 | 2026-10-27 | The gate pool (D25) is wired but opt-in: `EDEN_GATE_WORKERS` defaults to 0, and lookup results are redacted on the event loop. | adopted |
| D27 | 2026-10-27 | Claims about quality and performance cite `packages/sim` (generated worlds with fact-level labels, realistic and ideal connectors, the… | adopted |
| D28 | 2026-10-28 | A query planner chooses what each lookup sends to each connector (`QueryPlanner`, `PlannedSource`). | adopted |
| D29 | 2026-10-28 | The query planner's shadow phase (plan phase 5) runs in simulation, not on real accounts. | adopted |
| D30 | 2026-10-28 | The query planner's cascade (D28: "tries one other shape when the first returns nothing") is learned rather than always on. | adopted |
| D31 | 2026-10-28 | Default-on criteria for the query planner (plan phase 6), chosen by the owner: a cost-normalised gate instead of the plan's "source calls… | adopted |
| D32 | 2026-10-28 | D31's condition (4), "source calls per point of recall no worse than planner-off", is read pooled over the held-out simulation sets… | adopted |
| D33 | 2026-10-28 | The query planner is on by default in the server (plan phase 6): `EDEN_QUERY_PLANNER` unset or 1 serves through it, `shadow` runs it… | adopted |
| D34 | 2026-10-28 | Two conditions are added to D6's no-model delivery. | adopted |
| D35 | 2026-10-28 | `McpSource` may call a second tool: an operator-configured fetch tool (`fetchTool`) that reads one record by its id, for `Source.fetch`. | adopted |
| D36 | 2026-10-28 | When there is no model to judge (none configured, or over budget: D5's no-model path), the slow path's best-scored candidate is delivered… | adopted |
| D37 | 2026-10-28 | A capitalised word that is a weekday or month name, in any casing, as a plural weekday, or with a possessive or hyphenated tail (`Sunday`… | adopted |
| D38 | 2026-10-28 | The query planner's cascade step sends the remaining shape with the best posterior mean (`cascadeGreedy`; a Thompson draw on an ε step, so… | adopted |
| D39 | 2026-10-28 | When the agent receives an injection (hand-out, as D18 starts usage tracking), the query planner credits the shape that retrieved each of… | adopted |
| D40 | 2026-10-29 | A cached item last fetched or seen in a lookup more than `refreshAfterMs` ago (2 hours) is never delivered from the fast path: its cue… | adopted |
| D41 | 2026-10-29 | When the judge's model call fails (an error, a timeout, a provider refusing a key over its spend limit), the slow path applies D36's… | adopted |
| D42 | 2026-10-29 | Engine fixes from the 2026-10-29 audit that change behaviour: (1) a cue still in its cooldown (D37's key) is not looked up again, but the… | adopted |
| D43 | 2026-10-29 | `ask` returns the cited items with no model call by default; `askWithModel` (`EDEN_ASK_MODEL=1`) restores the model-composed prose answer. | superseded (deleted by D112) |
| D44 | 2026-10-29 | With no model (none, over budget, or failing: D36, D41), the slow path and `ask` first ground the request in the candidates' structure… | adopted |
| D45 | 2026-10-30 | The judge and the ask answer leave room for a reasoning model: they ask for low reasoning effort (`ChatRequest.reasoning`, sent to… | adopted |
| D46 | 2026-10-30 | Probes, a proof of concept behind `config.probes`, off by default (`probes.ts`): besides the request itself a lookup sends, within… | adopted |
| D47 | 2026-10-30 | Lean probes and dense packets, every part behind a flag, off by default. | adopted |
| D48 | 2026-10-30 | Sharper no-model grounds, shared calls and denser packets, behind flags, off by default. | adopted |
| D49 | 2026-10-30 | A structural conflict test for no-model delivery, behind flags, off by default. | adopted |
| D50 | 2026-10-30 | A learned probe economy, per user and with no model, behind two flags, off by default. | adopted |
| D51 | 2026-10-30 | A per-user standing-constraints register, behind `register`, off by default. | superseded (deleted) |
| D52 | 2026-10-30 | Dense packets and the event a request names, behind flags, off by default. | adopted |
| D53 | 2026-10-30 | The recommended experimental configuration is F (D48's best) plus `groundConflict`, `quietClear` (D49), `probeFresh`, `probeYield` (D50)… | superseded (replaced by D54) |
| D54 | 2026-10-30 | Three flags, each off by default, and a new recommended configuration: D53's set plus all three. | superseded (replaced by D55) |
| D55 | 2026-10-30 | After review, the recommended experimental configuration is H: D53's set plus `quietNameOnly` and `judgeTied` (D54); `consequenceProbe`… | superseded (replaced by D64) |
| D56 | 2026-10-31 | Engine-wide span tracing, off by default: each phase of each event (observe, the fast path's rank and confident filter; the slow path's… | adopted |
| D57 | 2026-10-31 | Background connector sync behind `sync`, off by default: `Source.list` (recent-first pages; `McpSource.listTool` passes D7's read-only… | adopted |
| D58 | 2026-10-31 | A per-user knowledge graph over every cached item, with graph-walk retrieval and no model, behind `graph` and `graphMerge`, off by default. | superseded (deleted by D225) |
| D59 | 2026-10-31 | Implication cards behind `cards`, off by default: items entering a user's cache that pass a no-model deontic prefilter are read in the… | adopted |
| D60 | 2026-10-31 | Anticipation, behind `anticipate`, off by default. | superseded (deleted by D1301) |
| D61 | 2026-10-31 | Live agent results come from the Pi harness: `pi-ab.ts` runs pi-agent-core's loop (`@earendil-works/pi-agent-core` and `pi-ai` 1.3.0… | adopted |
| D62 | 2026-10-31 | D56–D61 are merged on one tree, every flag off by default, telemetry's spans the one span design (Pi's harness reads them; sync, graph… | adopted |
| D63 | 2026-10-31 | Fixes from the review of `moon/combined`; where they depart from D57, D59, D60 or D8 this records it. | adopted |
| D64 | 2026-10-31 | The first full live benchmark on the Pi harness over all nine suites, 4 seeds, 16,346 agent runs, $8.75, graded by deepseek-v4.1-flash… | superseded (replaced by D79) |
| D65 | 2026-10-31 | No model judge on the critical path, and Eden's lookup stops waiting for the sync's poll. | adopted |
| D66 | 2026-10-31 | A cheaper background, behind flags, off by default. | adopted |
| D67 | 2026-10-31 | A found conflict is delivered whatever path spoke first. | superseded (deleted by D112) |
| D68 | 2026-10-31 | Packets say dates whole. | superseded (deleted by D112) |
| D69 | 2026-10-31 | The action firewall behind `actionCheck`, off by default (`firewall.ts`, `ContextPartner.checkAction`, `POST /v1/check`… | adopted |
| D70 | 2026-10-31 | One-turn packets are rejected: the proactive packet does not carry the no-model gate's held-back candidates or a coverage line (the… | rejected |
| D71 | 2026-10-31 | Agent cost in a live comparison is reported twice: as billed, and re-priced at fixed endpoint prices (Z.AI's list price and Wafer-us for… | adopted |
| D72 | 2026-10-31 | The pre-registered blind evaluation of the econ work is recorded and its bars applied: ALL2 (ALL plus `syncPollBehind`, `decideConflict`… | adopted |
| D73 | 2026-11-01 | `askVerdicts`, off by default: an ask gathers what a lookup gathers (the consequence probe's finds, the graph walk, the card finds) and… | superseded (deleted by D226) |
| D74 | 2026-11-01 | `askCompact` (with `askItemBytes` 320, `askFullItems`, `askLineBytes`, `askMaxBytes`), off by default: the answer is compacted as a packet… | superseded (deleted by D112) |
| D75 | 2026-11-01 | `conflictVocab`, off by default: the conflict test (`conflict.ts`) reads a wider, general vocabulary of blocks, lifts and standing… | adopted |
| D76 | 2026-11-01 | `compactAsk` (with `askItemBytes` 320), off by default: `ask` answers compacted as packets are, dates kept as written with their year… | adopted |
| D77 | 2026-11-01 | `askDedup`, off by default: an `ask` answer says an item this session's packets and answers already showed by its new parts only, or… | adopted |
| D78 | 2026-11-01 | `compactParts`, off by default: compaction (packets and compacted answers) reads a quoted thread past a quoted signature, cuts a table… | adopted |
| D79 | 2026-11-01 | ALL3 = ALL (D64) + `askVerdicts` (D73) + `conflictVocab` (D75) + `compactAsk` (D76) + `askDedup` (D77) + `compactParts` (D78) +… | superseded (replaced by D80) |
| D80 | 2026-11-01 | The pre-registered last measure is applied: ALL3 (ALL plus `askVerdicts`, `conflictVocab`, `compactAsk`, `askDedup`, `compactParts`… | superseded (replaced by D98) |
| D81 | 2026-11-01 | `supersede`, off by default: candidates are grouped by matter (subject without "Re:"/"Fwd:" per source, or a title identifier), ordered by… | superseded (deleted by D112) |
| D82 | 2026-11-01 | `askRank` (with `askRankMargin` 5), off by default: an ask's pool (the verdict hits, the grounded items, the lexically likely) is ordered… | superseded (deleted by D112) |
| D83 | 2026-11-01 | `askContext` ranks an `ask` for its question and for the session's latest user request (the lookup's own cue, kept on the session), fused… | superseded (deleted by D112) |
| D84 | 2026-11-01 | ALL4 = ALL3 (D80) + `supersede` (D81) + `askRank` (D82) + `askContext` (D83), chosen on the development suites and the old in-sample… | superseded (replaced by D85) |
| D85 | 2026-11-01 | The pre-registered live A/B on held-out 11 is applied: ALL4 (ALL3 plus `supersede`, `askRank`, `askContext`) does not replace ALL3; ALL3… | superseded (replaced by D92) |
| D86 | 2026-11-01 | The secret gate adds `eden-aws-secret`, always on: a maximal run of exactly 40 characters of `[A-Za-z0-9/+]`, not pure hex, mixing upper… | adopted |
| D87 | 2026-11-01 | the intent index. | adopted |
| D88 | 2026-11-01 | The guided `ask_context` description is Eden's own (`ASK_CONTEXT_GUIDED` in `@eden/protocol`, exported by the client SDK, read by the… | superseded (deleted by D112) |
| D89 | 2026-11-01 | The request-time bridging query, `bridgeQuery` (`bridge.ts`, `PartnerDeps.bridge`: a `QueryBridge` with its own `BridgeMaker`, model and… | superseded (deleted by D112) |
| D90 | 2026-11-01 | The active-constraints digest, `constraintDigest` (needs `cards`; `digest.ts`, `ContextPartner.digest`, `POST /v1/digest`, client… | superseded (deleted by D112) |
| D91 | 2026-11-01 | LAB ONLY: Lab runs may use OpenRouter's free models, on sim data only: `--allow-logging` (`OpenRouterOptions.allowLogging`, which… | lab |
| D92 | 2026-11-01 | ALL5 = ALL3 (D80) + `intent` (D87) + `bridgeQuery` with `bridgeQuestions` and `bridgeAskSeats` 2 (D89) + `askGuard` and `packetBearing`… | superseded (replaced by D98) |
| D93 | 2026-11-01 | Proposed with D92, review of `edge/combined`; amends D88, D89, D90 and D92. | adopted |
| D95 | 2026-11-02 | The ask-time model reader, `askReader` (`reader.ts`, `PartnerDeps.reader`: an `AskReader` with its own `ReaderMaker`, model and `Budget`… | adopted |
| D96 | 2026-11-02 | off by default; amends D95. | adopted |
| D97 | 2026-11-02 | LAB ONLY. | lab |
| D98 | 2026-11-02 | NEW (D96: ALL3 + `intent` + `askReader` + `askReaderDrop` + `readerPush`) replaces ALL3 (D80) as the recommended experimental configuration. | superseded (replaced by D99) |
| D99 | 2026-11-02 | Haiku phase 3: NEW (D98) stays the recommended experimental configuration; NEWL (NEW + `readerGate` + `askReaderPool` 15 +… | superseded (replaced by D112) |
| D100 | 2026-11-03 | Two input tightenings on the HTTP API. | adopted |
| D101 | 2026-11-03 | `syncPollPageSize` (0 = off): an incremental poll's first page is twice the changes the source's learned rate (`alpha/beta`) expects since… | adopted |
| D102 | 2026-11-03 | `slowPathQueue`: a request that reaches the slow path while the session's slow path is busy is kept in a one-slot per-session queue (the… | superseded (deleted by D228) |
| D103 | 2026-11-03 | `EDEN_ENGINE_CONFIG`: the HTTP server and the stdio MCP server read engine settings from a JSON file of `EngineConfig` keys… | adopted |
| D104 | 2026-11-03 | Corrects D103: (1) D103's rationale said the funnel gap between the defaults and ALL3 "needs `cards`". | adopted |
| D105 | 2026-11-03 | `EdenClient` option `defaultWaitMs`: the `waitMs` sent on each sent `user_message` observe (not a draft) that passes none of its own; an… | adopted |
| D106 | 2026-11-03 | D104 follow-up. | adopted |
| D107 | 2026-11-03 | The knowledge graph (D58) costs less to hold and to build, with the same results. | superseded (deleted by D225) |
| D108 | 2026-11-03 | Per-user sources in the shipped servers. | adopted |
| D109 | 2026-11-03 | The intent index (D87) stays in NEW (D98) and NEWL (D99); no intent-free preset (NEWX/NEWLX) is added. | adopted |
| D110 | 2026-11-03 | Rejected, lab only: The ask-time reader (D95/D96) is not distilled into a local no-model scorer used as a cascade. | rejected |
| D111 | 2026-11-03 | The per-user search index (`SparseIndex`, the engine's item cache) is packed, with identical results. | adopted |
| D112 | 2026-11-03 | One product: the default is the best measured configuration | adopted |
| D113 | 2026-11-03 | The owner's standing calls on the 2026-11-03b audit's open questions, recorded so later work follows them. | adopted |
| D114 | 2026-11-03 | Amends D93 and D96: With `askReaderDrop`, a reading that rejects by name every item of an ask's answer may now empty it, but only when the… | adopted |
| D115 | 2026-11-03 | Rejected: The reader's pool is not widened with the user's constraint items. | rejected |
| D116 | 2026-11-03 | Rejected: An explicit ask does not reuse the push's verdict. | rejected |
| D117 | 2026-11-03 | Lab only: `--reader-subset LOG[,LOG]` (`SubsetReplay`, reader-disk.ts; with `--reader replay`): a reader prompt the cache misses is… | lab |
| D118 | 2026-11-03 | Rejected: The reader's wait stays at the agent's start (D98, D112's 3,000 ms `waitMs`). | rejected |
| D119 | 2026-11-03 | `groundOccasion` no longer takes a participant's name for an occasion word. | adopted |
| D120 | 2026-11-03 | The packed index's merges are incremental, and a purge no longer rewrites it. | adopted |
| D121 | 2026-11-04 | Four switches that never helped are deleted with their code and tests. | rejected |
| D122 | 2026-11-04 | Rejected: opening `readerGate` for arranged visits. | rejected |
| D123 | 2026-11-04 | The current default is live-checked on held-out 13; D114 and D119 need no further live run | adopted |
| D124 | 2026-11-04 | Arranged visits open `readerGate`: `readerGateVisits` is in the default. | adopted |
| D125 | 2026-11-04 | Eden's cost cut at no measured quality loss: `cardsLean` and `syncPush` join the default; ask coalescing is rejected | adopted |
| D126 | 2026-11-05 | Freshness: a copy its source signalled a change to is re-read before delivery (`verifyDelivery`, in the default); deletions are forwarded… | adopted |
| D127 | 2026-11-05 | An `ask` whose sources failed does not answer "Nothing in the connected sources." | adopted |
| D128 | 2026-11-05 | `bun run eval --live` measures the shipped wiring | adopted |
| D129 | 2026-11-05 | `readerPushQuestions` (push-read every user message, past `readerGate`) is not reopened as a trial | rejected |
| D130 | 2026-11-05 | A broad reader veto over rule-path deliveries is rejected; a veto by name waits for a live reader eval | rejected |
| D131 | 2026-11-05 | Change signals stay source-wide: no per-ref `sourceChanged`, and no "explained signal" rule | adopted |
| D132 | 2026-11-05 | Agent-stream replay in the Pi lab is not built as proposed (replay at `--time-scale 0` until the first differing Eden output) | rejected |
| D133 | 2026-11-05 | Freshness doubt is judged by read marks, not read times. | adopted |
| D134 | 2026-11-05 | Re-reads ahead of the reader stay at 3 (`VERIFY_AHEAD`), but start only once the reader will actually be called; narrowing the ask's own… | adopted |
| D135 | 2026-11-05 | The fan-out results cache stays | adopted |
| D136 | 2026-11-05 | The per-item conflict analysis cache (round 1 P5) keeps its WeakMap and shares one frozen empty array for empty marks; a byte-capped cache… | adopted |
| D137 | 2026-11-05 | Intent requests stay sentences; a keyword-output trial (`intentTerse`) is not run | adopted |
| D138 | 2026-11-05 | A cold user's first lookup is not warmed in the background, and `deps.sources` stays unbounded in `searchLive` | adopted |
| D139 | 2026-11-05 | `bun run funnel` at `--time 0` runs one process per core with a contiguous group of suite x seed shards in each; ms/task from it is… | adopted |
| D140 | 2026-11-05 | An explicit ask's on-demand poll and live search share one deadline (`sourceTimeoutMs` from the lookup's start); answering an ask from a… | adopted |
| D141 | 2026-11-05 | `graph` stays in `DEFAULT_CONFIG`; deleting the graph's code is rejected; a cheaper graph (Stage 2) is off for now, with a trial switch… | adopted |
| D142 | 2026-11-05 | Backfill and sweeps may list big pages, min(`syncBigPageSize`, `Source.listPageMax`), only where the source declares a max; off in the… | superseded (deleted by D143) |
| D143 | 2026-11-05 | The big-pages trial ends: `syncBigPageSize`, `Source.listPageMax` and the big-page code are deleted (ends D142's trial early) | rejected |
| D144 | 2026-11-05 | The reader's reasoning defaults to "off" (`ModelReaderMaker`), so the shipped reader is the measured one; amends the `reader.ts` comment… | adopted |
| D145 | 2026-11-05 | OpenRouter's `anthropicCache` option becomes a trial; until it ends, every reader and card cost figure in COST-MODEL.md is labelled "lab… | adopted |
| D146 | 2026-11-05 | Cards and intent stay on the synchronous model endpoint; a batch tier (Message Batches) or a cheaper endpoint for request-only items is… | adopted |
| D147 | 2026-11-05 | The reader is not streamed to settle the push early, and a local distilled reader is not built | rejected |
| D148 | 2026-11-05 | A change notice drops the source's held search pages whether or not it is synced; an ignored notice says why; a lookup whose poll used up… | adopted |
| D149 | 2026-11-05 | Cards and intent requests send no reasoning by default (`ModelCardMaker`'s `reasoning` defaults to "off"); amends D59 | adopted |
| D150 | 2026-11-05 | The graph reads each item's first 1,000 characters, not 4,000 (`kg.ts` `READ_CHARS`); D141's Stage 2 is promoted with no switch, which… | adopted |
| D151 | 2026-11-05 | The reader veto by name over rule-path deliveries (D130's remaining item, `quality-reader-veto-rule-path`) is not built | rejected |
| D152 | 2026-11-05 | Stage 2 of `fresh-checkahead-speculative-rereads` (start re-reads from a streamed reader as it names items) is not built | rejected |
| D153 | 2026-11-05 | Anticipation (D60) stays in `DEFAULT_CONFIG`; removing it (`r2-anticipate-redundant-under-sync`) is rejected | adopted |
| D154 | 2026-11-05 | Request replay for the live agent harnesses is not built | rejected |
| D155 | 2026-11-05 | `ModelReaderMaker` and `ModelCardMaker` lose their `reasoning` option: both makers send no reasoning field, with no way to ask for one… | adopted |
| D156 | 2026-11-05 | `lat-speculative-first-call` (start the agent's first model call speculatively and keep it only if Eden's push stays silent) is rejected | adopted |
| D157 | 2026-11-05 | `cost-reader-pool-gate-learned` (a learned gate that skips reader calls that would bind nothing) is closed by D110 and not built | rejected |
| D158 | 2026-11-06 | The lab screens the shipped default: the funnel replays the committed intent file by default, and an intent-on Haiku reader cache replaces… | adopted |
| D159 | 2026-11-06 | Intent's match thresholds loosen to `intentMinCoverage` 0.2, `intentMinMatched` 1, `intentHits` 12 (from 0.35, 2, 6) in `DEFAULT_CONFIG`… | adopted |
| D160 | 2026-11-06 | A removal that lands while `sourceItems` is redacting wins: ids that become held gone during the redaction await are not revived or ingested | adopted |
| D161 | 2026-11-06 | `test:changed` and `check:fast` defer six end-to-end files when their package is only a dependent of what changed; `bun run check` and… | adopted |
| D162 | 2026-11-06 | The ask's lexical depth stays at BM25F's top 12 (`partner.ts:2039`) and `askReaderPool` stays at 15 | adopted |
| D163 | 2026-11-06 | D113's multi-process router is built, and its first stage divides per-tenant caps and separates source maps (amends D113's "per-tenant… | adopted |
| D164 | 2026-11-06 | Prompt-caching the reader's items across calls is not built | rejected |
| D165 | 2026-11-06 | Eden's latency on the agent's path is bounded by the reader: no change below the model can give 1.5x on task wall time; quality changes… | adopted |
| D166 | 2026-11-06 | Moving the push reading off the agent's start is not built | rejected |
| D167 | 2026-11-06 | Overlapping the ask's reader with its poll and live search is not built; the 2026-11-05 audit's O9 item `lat-ask-reader-overlap-poll` is… | rejected |
| D168 | 2026-11-06 | The closed-class "action unless it looks like a question" rule for the reader's request gate is rejected; widening the gate comes back as… | rejected |
| D169 | 2026-11-06 | The graph moves to struct-of-arrays only if `+graph` memory per item halves; compressed item text stays out (D111) until a trial | adopted |
| D170 | 2026-11-06 | Trial `intentConstraintOnly`: with `intent` on, an item the card prefilter rejects is not sent to the card model for its requests alone | superseded (deleted by D177) |
| D171 | 2026-11-06 | D112's "no extra paid cost" check on a paired Pi run reads Eden's own cost plus the agent's cost repriced cache-neutral; the billed cost… | adopted |
| D172 | 2026-11-06 | D163's router trial is decided on the median of at least 3 repetitions per arm (median ratio at least 1.5x, lowest at least 1.2x), on the… | adopted |
| D173 | 2026-11-06 | `--ask-diag` and the funnel's score lines split surfaced items into reader-flagged, rule-path and listed-only; the O7 precision gates are… | adopted |
| D174 | 2026-11-06 | Ranking an agent-worded ask on its question plus the session's request is not built, and changes to the ask's cue are screened with a paid… | rejected |
| D175 | 2026-11-06 | StaticSource builds each document's term set once, lazily on its first search, and `fetch` uses a ref map | adopted |
| D176 | 2026-11-06 | The graph's old-storage differential test runs 200 seeds in `bun run check` and `test:pkg`, and 25 in `test:changed`; a removal during… | adopted |
| D177 | 2026-11-06 | Trial D170 (`intentConstraintOnly`) ends without promotion: the switch, its `constrain()` path, the `intentSkipped` stat and their tests… | rejected |
| D178 | 2026-11-06 | `EDEN_PROCESSES` defaults to the core count (`min(os.availableParallelism(), 64)`, so one process and no router on a one-core machine)… | adopted |
| D179 | 2026-11-06 | D159 is re-decided by one Pi held-out 13 pair, seeds 41-44, intent replayed, judged on D171's cost, under a three-part rule fixed before… | adopted |
| D180 | 2026-11-06 | The 2026-11-05 audit's open items O5, O8 and O9 are closed with no code change | adopted |
| D181 | 2026-11-06 | F9 stage 2 (deflated `item.text`) is not built; D111 stands | superseded (replaced by D188) |
| D182 | 2026-11-06 | F6, F10 (request-side query expansion, `moonshot-ask-query-expansion-ceiling`) and F25 (unordered subset replay… | superseded (replaced by D186) |
| D183 | 2026-11-06 | `fallbackAsks` stays in `DEFAULT_CONFIG`; the `fallback` part is not removed | adopted |
| D184 | 2026-11-06 | F10, request-side query expansion (`moonshot-ask-query-expansion-ceiling`), is closed and not built | rejected |
| D185 | 2026-11-06 | F25's unordered subset replay (`devloop-retrieval-screen-set-subset-replay`) is not built; D117 stands | rejected |
| D186 | 2026-11-06 | F6 enters as trial `readerVerbGate` (package `action-gate-verbs-trial`): the reader's request gate recognises verbs, as D168 asked | superseded (deleted) |
| D187 | 2026-11-06 | The secret gate redacts a bare Discord webhook URL (`eden-discord-webhook`); the client checks the shape of every 2xx answer it hands the… | adopted |
| D188 | 2026-11-06 | The item cache holds item text deflated (`CacheLimits.packText`, on by default; `packed-text.ts`); reopens D111's compressed text tier as… | adopted |
| D189 | 2026-11-06 | Rejected: request-side query expansion with no model for the ask. | rejected |
| D190 | 2026-11-07 | Rejected: an evidence gate on the reader's call. | rejected |
| D191 | 2026-11-07 | Rejected: no blocking `observe` wait when the push's pool is weak. | rejected |
| D192 | 2026-11-07 | Re-reads of doubted items start only after the reader names an item: `readerVerifyAfter` is on in `DEFAULT_CONFIG` (reopens D134 on cost… | adopted |
| D193 | 2026-11-07 | An `ask` in the request the reader's push read reuses the push's reading: `readerReuse` is on in `DEFAULT_CONFIG` (fix S1). | adopted |
| D194 | 2026-11-07 | Rejected: a shorter reader output schema. | rejected |
| D195 | 2026-11-07 | The reader veto over rule-path deliveries (D151's hold, built as trial `ruleVeto`/`ruleVetoNamed`) is rejected and deleted | rejected |
| D196 | 2026-11-07 | Retiring rule paths (trial `rulesOff`) is rejected and deleted | rejected |
| D197 | 2026-11-07 | Labelling rule-path packets (trial `ruleLabel`: the envelope says the items were matched on shared names, dates or wording, not read) is… | rejected |
| D200 | 2026-11-07 | `intentByKind` joins the default: an intent hit whose item holds a constraint card counts from a coverage floor of 0.1… | adopted |
| D201 | 2026-11-07 | Rejected: intent requests worded as an agent's user delegates. | rejected |
| D202 | 2026-11-07 | No change for the "no intent requests" bucket, and none beyond D200 for "past the intentHits cut" | adopted |
| D205 | 2026-11-07 | Promoted: an item a session was handed that changes at its source is sent again as an "updated:" packet. | adopted |
| D210 | 2026-11-07 | Change notices that carry their items are the documented integration default; the client's `sourceChanged(sourceId, { items, removed })`… | adopted |
| D211 | 2026-11-07 | An ask leaves out a citation that a change signal doubted and no re-read confirmed, and says so | adopted |
| D212 | 2026-11-07 | A connector's own 429 is "throttled" in the fan-out and reads "rate-limited" in an ask's answer, not "failed" | adopted |
| D213 | 2026-11-07 | Rejected: a per-(user, source) poll window. | rejected |
| D214 | 2026-11-07 | Rejected: per-source recency caps for synced items. | rejected |
| D215 | 2026-11-07 | The graph's sentence and person memo serves one put: `UserGraph.rest()` empties it after every `ItemCache.put` and after a graph is built… | adopted |
| D216 | 2026-11-07 | Rejected: ingest off the event loop. | rejected |
| D220 | 2026-11-07 | The secret gate redacts a bare New Relic user key (`eden-new-relic`) and the signature of a presigned or signed object URL… | adopted |
| D221 | 2026-11-07 | One line sanitiser for every packet, answer and prompt line made from source or event text (`safeLine`, `safeBlock` in… | adopted |
| D225 | 2026-11-07 | The knowledge graph (`graph`, `graphMerge` and every `graph*` setting; D58, D107) is deleted with its code and tests | rejected |
| D226 | 2026-11-07 | `askVerdicts` (D73) is deleted with its code and tests | rejected |
| D227 | 2026-11-07 | Anticipation (`anticipate`, `anticipateCalls`, `anticipateSessionCalls`, `anticipateOff`; D60) is deleted with its code and tests | rejected |
| D228 | 2026-11-07 | `slowPathQueue` (D102) is deleted with its code and tests | rejected |
| D229 | 2026-11-07 | Every part of the default was ablated with the paid reader replayed; the rest are kept, and `judge` leaves `PARTS` | adopted |
| D230 | 2026-11-07 | Noting ask items the reader read and did not flag (trial `askUnflaggedNote`) is rejected and deleted | rejected |
| D231 | 2026-11-07 | Noting ask answers no reading checked (trial `askUnreadNote`) is rejected and deleted | rejected |
| D232 | 2026-11-07 | Two amendments from the review of the wave-1 merge (D211, D205). | adopted |
| D233 | 2026-11-07 | Rejected: read at ingest, not per request. | rejected |
| D234 | 2026-11-07 | Not built: reader verdict reuse across a user's sessions. | rejected |
| D235 | 2026-11-07 | Not built: a local yes/no model in place of the reader (CL1 H15, research only; confirms D147). | rejected |
| D236 | 2026-11-07 | Trial `pushCandidates` (CL6 H19, "the agent is the reader"), opened and closed 2026-11-07: its variants are deleted, its measured shape… | adopted (by D237) |
| D237 | 2026-11-07 | `pushCandidates` 5 is in `DEFAULT_CONFIG`: the push and the ask make no reader call; the agent judges the push's candidates (CL6, promoted… | adopted |
| D238 | 2026-11-07 | The reader's pool stays at 15 items; trimming it by what cannot bind is rejected | adopted |
| D239 | 2026-11-07 | Compact item fences for the reader are rejected | rejected |
| D240 | 2026-11-07 | The reader's reply stops at the first entry not about the request's own thing (`readerStopEarly`, in the default and `PARTS.reader`) | adopted |
| D241 | 2026-11-07 | A per-user cached item prefix for the reader is not built | rejected |
| D242 | 2026-11-07 | Rejected: a user's card backlog through Anthropic's Message Batches API. | rejected |
| D243 | 2026-11-07 | Rejected: fewer intent requests per item. | rejected |
| D244 | 2026-11-07 | `cardsLeanDays` 30 → 7 (CL3, H7; amends D125's window). | adopted |
| D245 | 2026-11-07 | No engine change for connector calls: most of Eden's are change signals that carry no items. | adopted |
| D246 | 2026-11-07 | The push's "nothing found" note (`pushChecked`, CL4 H8) is a trial switch, off, recommended for the cost-and-latency combine stage | superseded (deleted by D257) |
| D247 | 2026-11-07 | An ask answering from the push's search (`askFromPush`, CL4 H9) is rejected and deleted | rejected |
| D248 | 2026-11-07 | Not waiting for the push (speculation on the agent's first model request, CL4 H10) is rejected and deleted | rejected |
| D249 | 2026-11-07 | Re-reading ahead after the push (`pushVerifyAhead`, CL4) is rejected and deleted | rejected |
| D250 | 2026-11-07 | A closing "this is what bears on it" line on the push's packet (`pushCovered`, CL4 H13) is rejected and deleted | rejected |
| D251 | 2026-11-07 | The CL wave measures a long horizon as one user's days (`pi-ab --days`), and books a user's one-time backfill apart from the steady state | adopted |
| D252 | 2026-11-07 | The train suites build the `neutral` variant (`withNeutral`), and the combination search screens Eden's per-task spend at $0 with the paid… | adopted |
| D253 | 2026-11-07 | `heldout16` is the CL wave's blind suite, reserved for the combination's final check | adopted |
| D257 | 2026-11-07 | The push's "nothing found" note (`pushChecked`, D246) is deleted with its code and tests (`push-checked.test.ts`, render.ts's… | rejected |
| D258 | 2026-11-07 | Smaller candidate packets by excerpt size (`pushCandidateBytes`), by not repeating an item within a request (`pushCandidateDedup`) or by a… | rejected |
| D259 | 2026-11-07 | `pushCandidates` stays 5: three candidates, and three on a session's later requests only (`pushCandidatesLater`), are rejected | adopted |
| D260 | 2026-11-07 | On Pi, Eden's billed cost above the agent alone one request at a time is prompt-cache writes on a fixed prefix that was not cached, not… | adopted |
| D261 | 2026-11-07 | Per-source work and state at scale, with no output change (ships directly, as D215 did) | adopted |
| D262 | 2026-11-07 | The backfill reads 8 sources' pages at once (`syncBackfillLanes` 8, in the default); a first page sized to the source's share of the… | adopted |
| D263 | 2026-11-07 | A lookup polls at most its 8 best-routed stale sources (`syncPollWidth` 8, in the default; A1) | adopted |
| D264 | 2026-11-07 | A synced copy the user's cap cut does not answer for its source; the source is searched live (`syncLocalComplete`, in the default; A1) | adopted |
| D265 | 2026-11-07 | Routing adds, per source, log2(1 + its items among the request's 40 best matches in the user's own index) (`routeLocalHits`, in the… | adopted |
| D266 | 2026-11-07 | Rejected and deleted: re-ranking the push's candidates with no model. | rejected |
| D267 | 2026-11-07 | Rejected and deleted: asks that go past the candidates the agent holds. | rejected |
| D268 | 2026-11-07 | Rejected and deleted: candidate excerpts that keep the constraint sentence first. | rejected |
| D269 | 2026-11-07 | Where hidden facts are lost under the candidates default, and how the lab measures it (A2; no engine behaviour change). | adopted |
| D270 | 2026-11-07 | A stronger agent judges the candidates as well (A2, one small check; no engine change). | adopted |
| D271 | 2026-11-07 | D260's mechanism is proven, and Pi cost comparisons need an agent prompt that caches in every arm: pi-ab gets `--tenant-prompt` | adopted |
| D272 | 2026-11-07 | The long-horizon harness sends payload notices under `--push payload`; every earlier long payload latency carries ~650 ms of re-reads | adopted |
| D273 | 2026-11-07 | Four ways to send fewer packet or ask bytes are rejected at $0; the trial switch `pushCandidatesAnchor` is deleted with its code | rejected |
| D274 | 2026-11-07 | Rejected: telling the agent the candidates are what an ask would return. | rejected |
| D276 | 2026-11-07 | The push's candidates run on a server with no model key. | adopted |
| D277 | 2026-11-07 | `POST /v1/explain` and the clients' `explain()`: why Eden spoke or stayed silent, per session, content-free. | adopted |
| D278 | 2026-11-07 | A Python client, `packages/client-python` (`eden_client`), standard library only. | adopted |
| D279 | 2026-11-07 | `bun run trace-report`: an integrator's self-check on their own traffic. | adopted |
| D280 | 2026-11-07 | Hosting and the one-line integration: a server `Dockerfile`; `@eden/proxy`, an OpenAI-compatible proxy in front of the agent's model with… | adopted |
| D281 | 2026-11-07 | The MCP server moves to a new session after 2 h with no ask or at UTC midnight, ending the old one | adopted |
| D282 | 2026-11-07 | Shadow traffic teaches Eden nothing: `?shadow=1` on `/v1/events` and `/v1/pending` returns what Eden decided without handing it to an agent | adopted |
| D283 | 2026-11-07 | Sync listings are not wasted: a lookup stops waiting for its on-demand listing at its deadline without cancelling it, and the daily sweep… | adopted |
| D286 | 2026-11-07 | Card tags on the push's candidates (trial `pushCandidateCards`, A6) are rejected and deleted | rejected |
| D287 | 2026-11-07 | Lab only: dressed worlds (`pi-ab --dress`, `worldOf(…, { dress: true })`, `dress-entities.ts`) are kept as an instrument for levers on… | lab |
| D288 | 2026-11-07 | Not built, on $0 evidence: (1) an entity census line ("no item names X"): it is D257's "nothing found" narrowed and fires where the… | rejected |
| D291 | 2026-11-07 | D276's owed live check: the default on a server with no model key, on Pi; and pi-ab's `+nokey` harness flag. | adopted |
| D292 | 2026-11-07 | `bun run demo`: the newcomer's first run. | adopted |
| D293 | 2026-11-07 | "Eden caught this": `bun run digest` and content-free usage records. | adopted |
| D294 | 2026-11-07 | Connector presets and a per-user OAuth directory. | adopted |
| D295 | 2026-11-07 | docs/THREAT-MODEL.md (A7, docs only). | adopted |
| D296 | 2026-11-07 | A6's long-horizon connector re-reads under payload notices were the harness's recap signal (D272), not the engine; A8 confirms it task by… | adopted |
| D297 | 2026-11-07 | Trial `syncCarriedSweepMs` (a weekly sweep for sources whose notices carry their changes) opened and deleted the same day: it lets deleted… | rejected |
| D298 | 2026-11-07 | A re-read whose null proves nothing ("unverifiable") stands for the user until the source's next signal | adopted |
| D299 | 2026-11-07 | The other connector calls stay: the daily sweep, the 24 h poll of a quiet notifying source, the one-time backfill, signals' re-reads and… | adopted |
| D300 | 2026-11-07 | Answer-ahead (trial `pushAhead`, A9) is rejected and deleted | rejected |
| D301 | 2026-11-07 | Promoted: plan-conflict proactivity (`planConflict`, on in the default, part `plans`; A9). | adopted |
| D302 | 2026-11-07 | Lab only: `pi-ab --day K --late` (`pi-late.ts`) is kept as the instrument for facts that arrive after the agent acted | lab |
| D305 | 2026-11-07 | A10's prompt-injection suite, live and at $0. | adopted |
| D306 | 2026-11-07 | `guardLine` (trial, off): a fixed Eden line after every packet's and answer's header | adopted |
| D307 | 2026-11-07 | `quarantineInstructions` (trial, off): text written for an AI is replaced by Eden's marker in every rendered item and citation title | adopted |
| D308 | 2026-11-07 | `senderDomains` (a compacted From line keeping its address's domain) measured and deleted with its code and tests | rejected |
| D309 | 2026-11-07 | docs/THREAT-MODEL.md's T1 and open items carry A10's measured numbers | adopted |
| D310 | 2026-11-07 | Server input edges under abuse (A11; amends D100 and D163). | adopted |
| D311 | 2026-11-07 | The reports read only the engine's traces; a push's trace names its request's turn (A11; amends D277, D279, D293). | adopted |
| D312 | 2026-11-07 | The proxy cancels the model call when the agent hangs up, and cuts long text to the API's cap (A11; amends D280). | adopted |
| D313 | 2026-11-07 | The Python client follows no redirect and keeps the TypeScript client's edges; `McpSource.fetch` looks for the record where replies put it… | adopted |
| D314 | 2026-11-07 | A slow path's delivery leaves out what the fast path handed out during its re-reads; a verify trace counts only its own calls. | adopted |
| D315 | 2026-11-07 | A powered, Sonnet-graded hidden-fact measurement on train is the lab's yardstick for request-path quality levers. | adopted |
| D316 | 2026-11-07 | Trial `askNudge`, opened and closed 2026-11-07, promoted by D317. | adopted (by D317) |
| D317 | 2026-11-07 | `askNudge` is in `DEFAULT_CONFIG` | adopted |
| D318 | 2026-11-07 | Not built, on $0 evidence: intent requests for more item kinds. | rejected |
| D320 | 2026-11-07 | Cards only for the sources a user uses, past 32 sources. | adopted |
| D321 | 2026-11-07 | The sync keeps a user to its cap after the backfill (`syncKeepCut`, in the default; A13). | adopted |
| D322 | 2026-11-07 | A per-source vocabulary sketch for routing (`routeSketch`, in the default; A13). | adopted |
| D323 | 2026-11-07 | A used source's cut copy is read whole again and kept first (`syncEngagedDeep`, in the default; A13). | adopted |
| D324 | 2026-11-07 | `bench/source-days.bench.ts`, and the daily sweep's floor accepted for now. | adopted |
| D325 | 2026-11-07 | Idle users are frozen in memory and thawed exactly on next use (`CacheLimits.freezeIdleMs` 30 min, on by default; pure memory compaction… | adopted |
| D326 | 2026-11-07 | `POST /v1/usage`: a tenant's own usage today, summed over the router's children (A14; A4's blocker 10). | adopted |
| D327 | 2026-11-07 | Trial `EDEN_SPEND_LEASES` (off): a tenant's daily model-spend cap holds across router children without being divided by N (amends D163 for… | adopted |
| D328 | 2026-11-07 | Trial `syncIngestTurns` (off): a page the background sync listed is redacted and stored at its turn, one per turn of the event loop. | adopted (by D370) |
| D329 | 2026-11-07 | Memory per user is measured as JS heap plus `external`, and as RSS once it stops falling, at the sync cap; machines are sized on RSS. | adopted |
| D330 | 2026-11-07 | Rejected and deleted: two extra push slots for facts that share few words with the request. | rejected |
| D331 | 2026-11-07 | Not built, on $0 evidence: (1) name-free ("general") intent requests written at ingest beside an item's own ("pay a plumber for a… | rejected |
| D332 | 2026-11-07 | The intent requests are one noisy sample; screen intent levers over two. | adopted |
| D333 | 2026-11-07 | Lab only: the corpus dump keyed like the cache, and A15's offline retrieval screens. | lab |
| D335 | 2026-11-07 | Rejected and deleted: a search-like `ask_context` question. | rejected |
| D336 | 2026-11-07 | Eden's packets stay where the agent saw them: `@eden/proxy` keeps each turn's packet in place on every later request (`keepPackets`… | adopted |
| D337 | 2026-11-07 | Not built, on $0 evidence or a $0.06 smoke: (1) the proxy running `ask_context` itself and continuing the model call: the tokens are the… | rejected |
| D340 | 2026-11-07 | Trial `pushReshow`: a push candidate the agent took for an earlier request of the session is handed again when it ranks among this… | superseded (deleted by D380) |
| D341 | 2026-11-07 | Rejected and deleted: re-sending every item a session was sent an "updated:" packet for, in its current version, on a recap- or… | rejected |
| D342 | 2026-11-07 | Promoted: an "updated:" line names the times and dates the session was shown for the item that the new version no longer has. | adopted |
| D343 | 2026-11-07 | What a user's day does to Eden's value, measured. | adopted |
| D345 | 2026-11-07 | A complete poll after a change signal does not stand in for re-reading the doubted copies (`verifyByPoll`, A18): built as a trial… | rejected |
| D346 | 2026-11-07 | An ask does not re-read its likely citations beside its poll and live search (`askVerifyEarly`, A18): built as a trial, measured, deleted. | rejected |
| D347 | 2026-11-07 | A change notice may name the refs it changed, without their content: Eden reads those refs itself and puts nothing else of the source in… | adopted |
| D348 | 2026-11-07 | Eden's time on the agent's path is measured piece by piece at $0, and the pieces other than the freshness re-reads need no lever. | adopted |
| D350 | 2026-11-07 | Lab only: `heldout17` is the blind suite for the end-of-day confirmation | lab |
| D351 | 2026-11-07 | A key-less request from another site's browser page is refused (A20; amends D280, the dev mode of D9). | adopted |
| D352 | 2026-11-07 | The keyword rule takes a single- or typographically-quoted value whole (A20; extends D13 and A5's fix). | adopted |
| D356 | 2026-11-07 | Sources the user does not use are swept weekly, and their unswept copies are re-read before delivery. | adopted |
| D357 | 2026-11-07 | Lab: `pi-ab --noise-sources N [--noise-items 20]`, `quality-cli --never-used`, and fetch counts in `source-days.bench.ts`. | lab |
| D358 | 2026-11-07 | The 1,000-source default checked live on Pi; the request path's live searches of cut noise copies are the next cost. | adopted |
| D360 | 2026-11-07 | Rejected and deleted: trial `linkLine`, a no-model line on each push candidate saying what it shares with the request | rejected |
| D361 | 2026-11-07 | The intent requests' sampling noise, measured with the shipped prompt; D332 is no longer provisional; a second sample is kept | adopted |
| D362 | 2026-11-07 | Lab only: A22's scripts | lab |
| D365 | 2026-11-07 | Onboarding: each adopter path installs from outside the repo, says what is wrong in one line, and has a smoke test in `bun run check` | adopted |
| D370 | 2026-11-07 | The card drain gathers what waits its turn, and `syncIngestTurns` (D328) is promoted into the default. | adopted |
| D371 | 2026-11-07 | The sync's per-source ids are an `IdSet` (`@eden/primitives`; A24). | adopted |
| D372 | 2026-11-07 | Memory is reported as `heapUsed`, `external` and RSS each on its own, never heap + external (A24; corrects D329's reason). | adopted |
| D373 | 2026-11-07 | Sizing at the sync cap after D370 and D371: ~2,280 users on a 4-core 16 GB box, ~$65 per 1,000 users a month (A24; supersedes D329's and… | adopted |
| D374 | 2026-11-07 | Fixes from the review of A14. | adopted |
| D375 | 2026-11-07 | The party check: `checkAction` holds a call adding a recipient, guest or payee account that only Eden's packets showed | adopted |
| D376 | 2026-11-07 | Promoted: `partyCheck` is on in the default, part `parties`. | adopted |
| D377 | 2026-11-07 | docs/THREAT-MODEL.md T1 and its open item carry A25's check | adopted |
| D380 | 2026-11-07 | Deleted: `pushReshow` (D340's trial) with its code and tests, under D112. | rejected |
| D385 | 2026-11-07 | The Hermes plugin keeps its placement; INTEGRATION.md's Hermes advice is corrected. | adopted |
| D386 | 2026-11-07 | Lab only: hermes-ab records Eden's connector calls and the backfill split as pi-ab does. | lab |
| D387 | 2026-11-07 | The Hermes agent-cost gap with Eden (0.610 against 0.440 $/1k) stays open, now without the per-call-break explanation. | adopted |
| D390 | 2026-11-07 | A per-lookup budget for live searches of cut copies at 1,000 sources (`syncCutLive`, trial, A28) was measured and deleted; D264 stands. | rejected |
| D391 | 2026-11-07 | At 1,000 sources Eden's path time is not the count of live calls; lab: one 1,000-source Pi arm per process, a seed split by suite. | adopted |
| D395 | 2026-11-07 | The default on heldout17, blind: it beats the agent alone on hidden facts and speed on both horizons, with no rise in false concerns, and… | adopted |
| D396 | 2026-11-07 | askNudge (D316) holds up blind. | adopted |
| D397 | 2026-11-07 | A server with no model key still beats the agent alone on heldout17, blind, but the cards are worth about 22 points. | adopted |
| D398 | 2026-11-07 | Notices on heldout17: payload stays the main path; refs (D347) keep the agent faster than the agent alone at a few connector calls… | adopted |
| D399 | 2026-11-07 | heldout17 is read. | adopted |
| D400 | 2026-11-07 | Trial `pushCandidatesSettled` (number, 0 off): a request whose anchors the push's candidates settle gets fewer candidates. | adopted (by D404) |
| D401 | 2026-11-07 | Rejected at $0: moving the agent's cache mark off the first request's user turn so a one-call task pays 1x, not 1.25x, for the packet. | rejected |
| D402 | 2026-11-07 | No byte-stable-packet lever to build: the packet is already byte-stable across a session's requests. | adopted |
| D403 | 2026-11-07 | The agent-bill gap to the agent alone, by token class (Pi, `--tenant-prompt`, train): one request a session +$0.054/1k = packet written on… | adopted |
| D404 | 2026-11-07 | `pushCandidatesSettled` 2 is in `DEFAULT_CONFIG` | adopted |
| D405 | 2026-11-07 | `pushCutBehind`: the push stops waiting on live searches of cut copies | adopted |
| D406 | 2026-11-07 | `pushCutBehind` is in `DEFAULT_CONFIG` | adopted |
| D407 | 2026-11-07 | A28's ~300% CPU and 10 GB heap at 995 noise sources is mostly the lab, not Eden. | adopted |
| D408 | 2026-11-10 | Lab only: the lab on Modal, and a card transport for a distilled card model. | lab |
| D415 | 2026-11-10 | No connector preset names a fetch tool; each says why. | adopted |
| D420 | 2026-11-10 | Check before acting is one line in both clients: `guardTools`/`guardTool` (`@eden/client`) and `guard_tools`/`guard_tool` (`eden_client`)… | adopted |
| D421 | 2026-11-10 | Ref notices are the documented default for a change notice that names ids (`sourceChanged(id, {refs})`, Python `source_changed(refs=)`)… | adopted |
| D422 | 2026-11-10 | Hermes Agent ships as a plugin built on the `hermes-eden` arm: `eden_client.hermes` (installed by `examples/hermes/eden`) registers… | adopted |
| D425 | 2026-11-10 | Frozen users may be persisted to disk, encrypted, as an operator opt-in (C3; departs from D8). | adopted |
| D426 | 2026-11-10 | A user read back from disk takes back their sync state, conservatively. | adopted |
| D427 | 2026-11-10 | Persisted users under the router (C3; D163's rule for per-user files). | adopted |
| D428 | 2026-11-10 | A persisted user's file is deleted when its newest item expires, not only at 7 days (C3; amends D425). | adopted |
| D430 | 2026-11-10 | `askBehind`: the explicit ask stops waiting on its poll and on live searches of cut copies | adopted |
| D431 | 2026-11-10 | `askBehind` (wait 0) is in `DEFAULT_CONFIG` | adopted |
| D432 | 2026-11-10 | `bun run eval` depends on the wall-clock date. | adopted |
| D435 | 2026-11-10 | The eval runs on the scenario's clock, never the wall clock. | adopted |
| D436 | 2026-11-10 | Noted, not changed: the push's lookup is timed at the partner's `now()`, not the event's `at`. | adopted |
| D440 | 2026-11-10 | Lab only: the parts measured at eight seeds on Modal. | lab |
| D441 | 2026-11-10 | No part of the default measurably hurts at eight seeds; nothing is changed. | adopted |
| D442 | 2026-11-10 | `askNudge` (D317) and `freshness` (D342) are flagged "a cost without a measured gain" (M1's rule); a re-measurement is recommended, no… | adopted |
| D443 | 2026-11-10 | At 1,000 sources the default holds hidden facts but sits on the agent's path, and its connector calls price it out of per-call plans. | adopted |
| D444 | 2026-11-10 | Seeds with cards made in-run score lower than seeds with replayed cards, in every Eden arm (lab note). | adopted |
| D445 | 2026-11-10 | Lab finding: Haiku's constraint cards can be distilled into a small open model. | adopted |
| D446 | 2026-11-10 | Not promoted: the distilled model's intent requests fail the pre-registered bar. | rejected |
| D447 | 2026-11-10 | Cost: a GPU card model is cheaper than Haiku only as a busy shared service (M2, measured). | adopted |
| D448 | 2026-11-10 | Lab tooling for the distillation, amending D408. | adopted |
| D449 | 2026-11-10 | What a distilled card model would need before production (M2, written, not built). | rejected |
| D450 | 2026-11-10 | No engine trial for embedding retrieval: a hybrid of the lexical pool and an open embedding model's top k raises decoys as much as planted… | adopted |
| D451 | 2026-11-10 | Finding: a larger embedding model does not separate a fact from its look-alike. | finding |
| D452 | 2026-11-10 | Finding: embeddings do not reach the facts that share no word with the request (A15's target set). | finding |
| D453 | 2026-11-10 | Adopted (tooling): the embedding screen scores a hybrid. | adopted |
| D455 | 2026-11-10 | Kept: `askNudge` (D316, D317), overriding M4's pre-registered delete rule. | adopted |
| D456 | 2026-11-10 | Finding: Sonnet does not grade the nudge's gain higher on the whole train suites. | finding |
| D457 | 2026-11-10 | Finding: the nudge's gain is on A12's targeted templates only. | finding |
| D460 | 2026-11-10 | Trial `askNudgeDeep`: the ask nudge fires only when the push pool past the handed candidates holds an anchored item. | adopted (by D461) |
| D461 | 2026-11-10 | `askNudgeDeep` is in `DEFAULT_CONFIG` (D112; part `nudge`, and the `reader` and `candidates` parts, take it out with `askNudge`). | adopted |
| D462 | 2026-11-10 | Finding: the ask nudge helps where the planted fact is past the handed candidates, and fires for nothing where it is handed. | finding |
| D465 | 2026-11-10 | `heldout18`, a fresh blind suite, registered unread | adopted |
| D466 | 2026-11-10 | The askNudge subset of heldout18 is fixed before any run. | adopted |
| D470 | 2026-11-10 | Finding: Opus 5.5, asked whether an item is about the request's own person, thing and date and bears on it, does not separate the train… | finding |
| D471 | 2026-11-10 | Finding: a small cross-encoder distils Opus's relevance well on CPU, and inherits its blindness to decoys. | finding |
| D472 | 2026-11-10 | Rejected and deleted: `pushCheck`, the checker choosing the push's candidates | rejected |
| D473 | 2026-11-10 | Finding: the checker is a strong silence switch, but silences facts with the noise. | finding |
| D474 | 2026-11-10 | Adopted (lab tooling): the pair labeller and the checker's training and CPU evaluation. | lab |
| D475 | 2026-11-10 | Trial (off): a cold tier for the synced copy (`syncCold`, `syncColdMaxItems` 30,000, `syncColdVerify`). | superseded (deleted by D495) |
| D476 | 2026-11-10 | Trial (off): change feeds (`syncDelta`; `Source.changes`, `ChangePage`, `SourceFanout.changes`). | superseded (deleted by D495) |
| D477 | 2026-11-10 | Not built: a timer that polls every source by its change rate. | rejected |
| D478 | 2026-11-10 | Lab: connector kinds and event-trigger prices. | lab |
| D479 | 2026-11-10 | `syncCold` and `syncDelta` are not promoted; they stay trial switches, off. | rejected |
| D480 | 2026-11-10 | Trial `intentPrune` (pruning an item's intent requests by a no-model score against the item) is rejected and deleted | rejected |
| D481 | 2026-11-10 | Finding: the intent requests that share least with their item are the ones that reach hidden facts; the intent index cannot be shrunk by… | finding |
| D482 | 2026-11-10 | Trial `cardsOrder`: the card queue is read best first, not as it filled | adopted (by D483) |
| D483 | 2026-11-10 | `cardsOrder` is in `DEFAULT_CONFIG` | adopted |
| D484 | 2026-11-10 | Not run in F2: embedding reach behind a checker, a checker-scored pruning rule, and the card order with M2's distilled card model. | adopted |
| D485 | 2026-11-10 | Trial `askMulti`, opened and closed 2026-11-10: not promoted, deleted. | rejected |
| D486 | 2026-11-10 | Finding: batching the agent's questions saves almost no time and adds tokens. | finding |
| D487 | 2026-11-10 | Adopted (lab tooling): a powered bench. | lab |
| D488 | 2026-11-10 | Findings from the bench's first run at scale (Pi, train, 28 seeds, 5,153 hidden pairs; Anthropic-direct lab figures, Haiku 5.5). | finding |
| D489 | 2026-11-10 | A real-data pilot kit, built and not run; a stated departure from D8 for it alone. | adopted |
| D490 | 2026-11-10 | Finding: asked whether an item changes what the assistant should do for the request, Opus 5.5 separates the train suites' planted facts… | finding |
| D491 | 2026-11-10 | Finding: no small cross-encoder distilled from those labels learns the distinction on templates it was not trained on. | finding |
| D492 | 2026-11-10 | Rejected: the distilled checker in the push | rejected |
| D493 | 2026-11-10 | Finding: a teacher-quality check in the push would cut look-alikes from the packet without losing facts | finding |
| D494 | 2026-11-10 | Adopted (lab tooling): the "changes the action" labeller and the teacher-as-checker sidecar. | lab |
| D495 | 2026-11-10 | Deleted at the repo owner's decision: `syncCold` and `syncDelta`, F1's two off trials | rejected |
| D500 | 2026-11-10 | Trial `pushCheck`: one budgeted model call a push asks, over the whole push pool at once, whether each item changes what the assistant… | adopted |
| D501 | 2026-11-10 | The push check's operating point: 200 characters × 15 items | adopted |
| D502 | 2026-11-10 | Pre-registered: the live Pi measurement of `pushCheck` and its promotion rule | lab |
| D503 | 2026-11-10 | Finding: the push check raises more hidden facts live, leaves concerns where they were, and costs +$0.11 per 1,000 tasks and +0.8 s a task | finding |
| D504 | 2026-11-10 | `pushCheck` stays an off trial; the trade goes to the owner | adopted |
| D505 | 2026-11-10 | Trial `sourceYield`: each of a user's sources earns its live reads. | adopted (by D509) |
| D506 | 2026-11-10 | Trial `pushLazy`, opened and closed 2026-11-10: not promoted, deleted. Finding: the push's background searches buy facts one request a… | rejected |
| D507 | 2026-11-10 | Rejected at $0 and deleted: reusing a search's answer across a user's day | rejected |
| D508 | 2026-11-10 | Rejected at $0 and deleted: one search of a source a lookup | rejected |
| D509 | 2026-11-10 | `sourceYield` is in `DEFAULT_CONFIG` | adopted |
| D510 | 2026-11-10 | Finding: a "changes the action" check without thinking is lenient on look-alikes; with thinking at effort low it is not. | finding |
| D511 | 2026-11-10 | Trial `pushWiden`: the check reads items past the lexical pool. | adopted |
| D512 | 2026-11-10 | Rejected and deleted: `pushCheckReshow`, a re-show gated by the check. | rejected |
| D513 | 2026-11-10 | Finding: silence when the check names nothing loses no planted fact from the packet | finding |
| D514 | 2026-11-10 | Finding: the careful check's price. | finding |
| D515 | 2026-11-10 | Trial `takeSettleMs`, opened and closed 2026-11-10: not promoted, deleted. | rejected |
| D516 | 2026-11-10 | Finding: plan alerts (`planConflict`, D301) hold on eight users; nothing tuned. | finding |
| D517 | 2026-11-10 | Rejected: shortening earlier requests' packets in the transcript | rejected |
| D518 | 2026-11-10 | Trial `askReinvite`, opened and closed 2026-11-10: not promoted, deleted. | rejected |
| D519 | 2026-11-10 | Adopted (lab tooling) and a finding: N3's reports, and day-level noise in `--days` runs. | lab |
| D520 | 2026-11-10 | Finding: Eden's lift holds when the agent is a stronger model, and its packet costs that agent the same ~500 cache-written tokens at that… | finding |
| D521 | 2026-11-10 | Trial `cardsLanes`: one user's card calls run in up to K lanes while full batches wait | adopted (by D522) |
| D522 | 2026-11-10 | `cardsLanes` is 4 in `DEFAULT_CONFIG` | adopted |
| D523 | 2026-11-10 | Rejected without a paid run: a card-only (distilled) model reading the rest of a new user's backfill | rejected |
| D524 | 2026-11-10 | Adopted (lab tooling): stronger models as the Pi agent, priced per token class. | lab |
| D525 | 2026-11-10 | Pre-registered: N2's widened pool behind a check the owner can ship, target at most +$0.10 per 1,000 tasks and +0.3 s a task | lab |
| D526 | 2026-11-10 | Rejected and deleted: the check's question answered when the item is stored, read by a no-model push | rejected |
| D527 | 2026-11-10 | Trial `pushCheckForm`: 2 is a compare-first reply for the push check, with no thinking. | adopted |
| D528 | 2026-11-10 | Rejected and deleted: thinking on I3's short reply, and a check that reads only stored-`act` items | rejected |
| D529 | 2026-11-10 | Trial `pushCheckGate`, opened and closed 2026-11-10: measured live, not kept, deleted | rejected |
| D530 | 2026-11-10 | Adopted (lab tooling, N5). | lab |
| D531 | 2026-11-10 | Finding (N5, round 1; Pi on Modal at acf6f34f, train seeds 41–48, all 192 templates, hidden, control and neutral, 4,608 task runs an arm… | finding |
| D532 | 2026-11-10 | Finding: a silent push makes the agent ask, and that is part of the gain and most of the extra wait. | finding |
| D533 | 2026-11-10 | Trial `pushCheckSilent`. | adopted |
| D534 | 2026-11-10 | Trial `pushCheckAnchored`: the check is called only when a constraint-like item in the pool names one of the request's anchors. | adopted |
| D535 | 2026-11-10 | Finding: arm N (`pushCheck`, `pushCheckForm` 2, `pushCheckAnchored`, `pushCheckSilent` off; no widening) raises hidden facts +2.7 points… | finding |
| D536 | 2026-11-10 | Nothing from N5 is promoted; `pushCheckForm` 2, `pushCheckAnchored` and `pushCheckSilent` stay off trials with `pushCheck` and… | adopted |
| D540 | 2026-11-10 | `sourceYield` is re-tested on the powered bench, with the rule written first | adopted |
| D541 | 2026-11-10 | `sourceYield` stays in `DEFAULT_CONFIG` | adopted |
| D542 | 2026-11-10 | Finding: N1's call and cost figures hold at 28 seeds. | finding |
| D543 | 2026-11-10 | Adopted (lab tooling): the `bench-yield` preset and N1b's scripts; and how to size a fan-out's cap. | lab |
| D544 | 2026-11-10 | Finding: the sign of a part's effect on seeds 41–44 is not evidence. | finding |
| D600 | 2026-11-10 | Trial `sourceYieldEarn`: a source earns its live reads on weak evidence. | adopted (by D603) |
| D601 | 2026-11-10 | Trials `sourceYieldNames` (4) and `sourceYieldEngage`. | adopted |
| D602 | 2026-11-10 | Not kept: dormant sources (`syncDormantMs`), built, screened at $0 and removed after two reviews. | rejected |
| D603 | 2026-11-11 | `sourceYieldEarn`, `sourceYieldNames` (4) and `sourceYieldEngage` are in `DEFAULT_CONFIG` | adopted |
| D604 | 2026-11-11 | Trial `syncSweepSpread`: an unused source is swept at its own point in the week | superseded (deleted by D817) |
| D605 | 2026-11-11 | Finding: fewer on-demand polls of sources that send no notice is not free; `syncStaleChance` stays 0.15 | finding |
| D606 | 2026-11-11 | Finding: with no change notice, a third of the updates owed to the agent are lost, all because the item's source was not polled; no fix… | finding |
| D650 | 2026-11-10 | A test file that passed on exactly the inputs it has now is not run again | adopted |
| D651 | 2026-11-10 | Finding: the capacity bench's "quarter active" steady state was half active; a 4-core 16 GB box holds about 3,460 synced users at a… | finding |
| D652 | 2026-11-10 | Trial (off): with frozen users persisted (D425), the memory's copy of a frozen user's blob is let go once the file is written | adopted |
| D653 | 2026-11-10 | The proxy serves Anthropic's Messages API | adopted |
| D656 | 2026-11-10 | The proxy serves OpenAI's Responses API | adopted |
| D657 | 2026-11-10 | The test-result cache (D650) is for the loop, never the gate, and fails closed | adopted |
| D658 | 2026-11-10 | The test cache gives a narrow key only to tests the audit has traced on these bytes | adopted |
| D700 | 2026-11-10 | Trial `pushCheckBehind`: the push check runs behind the default's packet | superseded (deleted by D704) |
| D701 | 2026-11-10 | Lab only: `pi-ab`'s `+amend` condition flag | superseded (deleted by D704) |
| D702 | 2026-11-10 | Trial `pushOpen`: with `pushCandidates` and without `pushCheck`, the push also runs for a message that opens like an instruction, not only… | adopted (by D710) |
| D703 | 2026-11-10 | Trial `candidatesSpecifics`: the candidates' lead asks for the item's specifics once it applies | superseded (deleted by D705) |
| D704 | 2026-11-10 | Finding: a push check that runs behind the packet keeps nothing of arm K's gain; `pushCheckBehind`, `pushCheckAskWaitMs` and pi-ab's… | finding |
| D705 | 2026-11-10 | `candidatesSpecifics` is rejected and deleted with its code and tests | rejected |
| D706 | 2026-11-10 | Finding: `pushOpen` (D702) passes its pre-registered rule and goes to the owner; it stays an off trial | finding |
| D707 | 2026-11-10 | Finding: over a user's days `pushOpen` (D702) fails its pre-registered hidden clause; it is not promoted | finding |
| D708 | 2026-11-10 | Trial `pushPointer`: the candidates' lead names the items of this request's candidates that the agent was handed for an earlier request | superseded (deleted by D832) |
| D709 | 2026-11-10 | `pushOpen` (D702) is kept off as a trial until its end date instead of being deleted on D707, and one powered days run decides it | adopted |
| D710 | 2026-11-11 | `pushOpen` (D702) is promoted into the default as the part `open` | adopted |
| D711 | 2026-11-11 | `pushPointer` (D708) failed its rule and is deleted with its code and tests | rejected |
| D712 | 2026-11-11 | Finding: over a user's days the largest hidden gap is the fact missing from the request's candidates, not a fact handed and forgotten | finding |
| D713 | 2026-11-11 | A measurement is pre-registered: what a full intent index is worth to the push over a user's days | lab |
| D714 | 2026-11-11 | Finding: the lab's replayed intent requests cover about seven times more of a user's items than the shipped pipeline writes, so figures on… | finding |
| D715 | 2026-11-11 | Finding: intent requests for every item of a user move 2 of 113 hidden facts into the push over days; no paid run is made on it | finding |
| D750 | 2026-11-10 | Finding: the segment redesign's three $0 screens say stop | finding |
| D751 | 2026-11-11 | Trial `syncKick` (off): a new user's backfill starts with their first event, runs to its end without waiting for the sync's ticks, and… | adopted (by D755) |
| D752 | 2026-11-11 | Finding: a 1,000-source user's memory is mostly its items, and `IdSet` gives back the room of deleted ids | finding |
| D753 | 2026-11-11 | `syncKick`'s review is closed: its waits are on the engine's clock, kicks are bounded across users and stopped by `stopSync`, and a first… | adopted |
| D754 | 2026-11-11 | A (user, source) pair's fan-out guards are parked once they are idle and empty | adopted |
| D755 | 2026-11-11 | `syncKick` is promoted into the default (part `sync`): the paid check pre-registered in o4-new-user.md §6 passed on every condition | adopted |
| D756 | 2026-11-11 | Finding: holding fewer items of the sources a user never uses does not make a 1,000-source user smaller | finding |
| D800 | 2026-11-11 | Lab only: the blind confirmation of tonight's wave on `heldout18` is pre-registered | lab |
| D801 | 2026-11-11 | Finding: tonight's wave (#235–#243) did not lower quality on blind `heldout18`, and on Sonnet's grade raised it; `pushOpen` stays in the… | finding |
| D802 | 2026-11-11 | Lab only: `heldout18` has been run once and is read; `UNREAD_BLIND` is empty | lab |
| D820 | 2026-11-11 | Trial `pushIndirect` (P2; promoted by D828): a request phrased as a need, a plan, a wish or a question about acting starts the push, read… | adopted (by D829) |
| D821 | 2026-11-11 | Rejected: narrowing the default's packet with no model (`pushNarrow`, P2; deleted). | rejected |
| D822 | 2026-11-11 | Rejected: the push check's short compare-first reply. | rejected |
| D823 | 2026-11-11 | Trial `pushCheckOpen` (P2; folded into the default's check by D828, the switch deleted): with `pushCheck`, the open shape's pushes… | adopted |
| D824 | 2026-11-11 | Rejected at $0: opening arm N's anchored gate only on the pool's first few items | rejected |
| D810 | 2026-11-11 | The no-model eval gains an acting suite, so the merge gate sees the default's push of candidates | adopted |
| D811 | 2026-11-11 | The merge gate runs its three steps at once, runs the tests that wait on real time in a tail after the rest, bounds work in CPU time, and… | adopted |
| D812 | 2026-11-11 | The decision log gets a generated way in: `bun run decisions:index` (`scripts/decision-index.ts`) writes docs/DECISION-INDEX.md and… | adopted |
| D813 | 2026-11-11 | Lab only: paid lab runs write each finished unit as it lands and resume without paying for it again | lab |
| D814 | 2026-11-11 | A trial is decided in the branch or session that opened it, as soon as its evidence is in. | adopted (by D1180) |
| D815 | 2026-11-11 | Deleted: the action firewall (`actionCheck`, D69, D72), the packet guard line (`guardLine`, D306) and the instruction quarantine… | rejected |
| D816 | 2026-11-11 | tsgo is the merge gate's checker: `scripts/typecheck.sh` defaults to tsgo (TypeScript 7's native preview, pinned), `TYPECHECK=tsc` and… | adopted |
| D817 | 2026-11-11 | Deleted: `syncSweepSpread` (D604), `EDEN_SPEND_LEASES` (D327) and `EDEN_PERSIST_DISK_ONLY` (D652); `anthropicCache` (D145) is a… | rejected |
| D818 | 2026-11-11 | Lab scripts refuse to start while `OPENROUTER_API_KEY` is set, unless `EDEN_ALLOW_OPENROUTER=1` | adopted |
| D819 | 2026-11-11 | The cold gate trusts the content-addressed Prettier set, and five heavy end-to-end tests share their work | adopted |
| D830 | 2026-11-11 | Lab only: Sonnet 5.5 as the Pi agent on train, short and days, the default against tools, is pre-registered | lab |
| D831 | 2026-11-11 | Finding (lab only): Eden's selection against plain retrieval | finding |
| D832 | 2026-11-11 | `pushPointer` tried again on today's default and deleted for good | rejected |
| D833 | 2026-11-11 | Rejected: a per-user alias table for the push's recall. | rejected |
| D834 | 2026-11-11 | Finding: "a handed fact not raised" (weak point 6) is the agent model and the grade's every-clause rule, not Eden | finding |
| D840 | 2026-11-11 | Not kept: re-reading by id the items the agent holds from quiet sources (`heldReread`, P4; weak point 4), built, screened at $0 and deleted. | rejected |
| D841 | 2026-11-11 | Lab: `days-calls.ts --move-after N` and owed updates by source. | lab |
| D842 | 2026-11-11 | The `caldav` preset names a fetch tool, `caldav_get_event_by_uid`; the sim's calendar never changes in the future; mcpvault keeps no fetch… | adopted |
| D850 | 2026-11-11 | Both clients have a default `onError`: misuse is printed with its fix in development and once per kind in production; calls still fail open | adopted |
| D851 | 2026-11-11 | Trial `askTool` in the proxy: the proxy offers Eden's `ask_context` to the model and answers its calls itself | adopted |
| D852 | 2026-11-11 | `eden doctor` checks an integration against its obligations, from content-free counters the server now keeps per tenant | adopted |
| D853 | 2026-11-11 | Every artifact Eden would publish builds and passes its registry's dry run: `bun run publish:check`; nothing is published | adopted |
| D854 | 2026-11-11 | The framework adapter is for the Vercel AI SDK: `examples/ai-sdk/eden-ai-sdk.ts` does every in-loop obligation with three calls, with a… | adopted |
| D855 | 2026-11-11 | Trial `leadShort`: the candidates' lead and the ask nudge in fewer words, same three instructions | superseded (deleted by D859) |
| D856 | 2026-11-11 | First-run fixes from four fresh-eyes walkthroughs: both clients read `EDEN_URL` and `EDEN_API_KEY` when no base URL or key is passed, and… | adopted |
| D857 | 2026-11-11 | `askTool` (D851) is a documented opt-in proxy flag, not a trial: `EDEN_PROXY_ASK=1`, off unless set, labelled "not measured through the… | adopted |
| D858 | 2026-11-11 | A dev-mode server refuses to start with `OPENROUTER_API_KEY` in its environment unless `EDEN_ALLOW_MODEL_ROLES=1` | adopted |
| D859 | 2026-11-11 | `leadShort` (D855) failed its pre-registered rule and is deleted with its code and tests | rejected |
| D825 | 2026-11-11 | Finding (P2, pre-registered B; Pi on Modal at 1927cc19, Haiku 5.5 in every role, train seeds 41–48 short and users w41–w48 over 8 days… | finding |
| D826 | 2026-11-11 | Finding (P2, pre-registered E): with a Sonnet 5.5 agent the silent check lowers the whole bill. | finding |
| D827 | 2026-11-11 | P2's recommendation to the parent (nothing promoted by this session): promote the silent check (S: `pushCheck`, form 2, `pushCheckOpen`… | adopted |
| D860 | 2026-11-11 | A second frozen form, "warm", that thaws without rebuilding | adopted |
| D861 | 2026-11-11 | Idle compaction, in the default (`idleCompact`) | adopted |
| D862 | 2026-11-11 | Two frozen tiers, in the default | adopted |
| D863 | 2026-11-11 | Finding and recommendation, not a change: persistence (D425) as the documented production default | finding |
| D864 | 2026-11-11 | Finding: what a second machine needs, nothing built. | finding |
| D870 | 2026-11-11 | Lab only: `heldout19` is the end-of-wave blind suite, registered unread | lab |
| D871 | 2026-11-11 | Lab only: `train1r`–`train6r` (`--suite reworded`), train with every request reworded | lab |
| D872 | 2026-11-11 | Lab only: shipped-coverage card and intent caches, and every funnel run labelled with its coverage | lab |
| D873 | 2026-11-11 | Lab only: eight rarely used connectors and the `longtail` suite | lab |
| D874 | 2026-11-11 | Lab only: weeks-long days plans | lab |
| D875 | 2026-11-11 | Lab only: `days-calls.ts` for weeks, more users and the long tail | lab |
| D876 | 2026-11-11 | Lab only: the benchmark map in docs/LAB.md: each benchmark's question and known biases | lab |
| D877 | 2026-11-11 | Lab only: the funnel's default coverage is shipped | lab |
| D878 | 2026-11-11 | Lab only: pi-ab and hermes-ab default to shipped coverage too (amends D877's "keep replaying the full index") | lab |
| D879 | 2026-11-11 | Finding: at 1,000 connectors over four weeks, the weekly sweep of unused sources (D356) costs no fact against a daily sweep, at 18% of its… | finding |
| D880 | 2026-11-11 | Lab only: a synthetic-world factory turns the train suites' format into thousands of labelled worlds | lab |
| D881 | 2026-11-11 | Synth labels come from construction, never from a model. | adopted |
| D882 | 2026-11-11 | Synth splits are by family cluster, and families are deduped against each other and the train suites. | adopted |
| D883 | 2026-11-11 | Synth quality: a revision pass by the writer, a blind critic, a hand audit. | adopted |
| D884 | 2026-11-11 | Lab only: the `synth` suite family runs the generated worlds as hidden-context suites. | lab |
| D828 | 2026-11-11 | The push check and indirect requests join the default. | adopted |
| D829 | 2026-11-11 | Precision over recall, an explicit exception: `pushIndirect` is in the default with one more Sonnet-confirmed false concern | adopted |
| D900 | 2026-11-11 | Lab only: a retriever trained on Eden's own question, "which held item bears on this request?", with its tooling and pre-registered bars | lab |
| D901 | 2026-11-11 | Finding, then withdrawn by the owner's scope: asymmetric dense retrieval with generated families passed both bars on two folds | finding |
| D902 | 2026-11-11 | Stopped: query-side expansion learned as a lookup table | adopted |
| D903 | 2026-11-11 | Stopped: setrank, an abstaining set-level ranker over asym's vectors | adopted |
| D904 | 2026-11-11 | Finding: serving an ingest-side encoder in TypeScript | finding |
| D905 | 2026-11-11 | Stopped: `bag`, a ranker with no transformer on either side | adopted |
| D906 | 2026-11-11 | Stopped: FrameRank, frames, five symbolic candidate channels and LightGBM over 48 integer pair features | adopted |
| D907 | 2026-11-11 | Lab only: the binarised track, end-to-end networks over hashed n-grams with ternary/binary internals | lab |
| D908 | 2026-11-11 | Rejected (stopped on its pre-registered rules; deleted with its code, weights and tests): `constraintTag`, a small binarised item tagger's… | rejected |
| D909 | 2026-11-11 | Rejected: H1, a learned request–item ranker, scrapped; no variant came near its pre-registered bar. | rejected |
| D910 | 2026-11-11 | Rejected (stopped on its pre-registered rule): a per-user standing-constraint ledger, typed records a cheap model writes when each item… | rejected |
| D911 | 2026-11-11 | Adopted (lab tooling, M5): `m5-ledger.ts extract` (typed constraint records per item content, pay once, redacted with `sanitizeForStore`… | lab |
| D912 | 2026-11-11 | Rejected (stopped on its pre-registered rule, 3e05b16d): M5's ledger with typed comparisons at match time | rejected |
| D890 | 2026-11-11 | Lab only: M1's distilled "changes the action" student and its stop rule are pre-registered | lab |
| D891 | 2026-11-11 | Adopted (lab tooling, M1): the student pipeline. | lab |
| D892 | 2026-11-11 | Finding: a 4B–8B decoder learns "changes the action" on templates it never saw; smaller ones do not | finding |
| D893 | 2026-11-11 | Finding: the student needs a datacentre GPU; CPU is out. | finding |
| D894 | 2026-11-11 | Trial `pushCheckLocal`: the push check's verdict from a distilled student's scores instead of a model call | superseded (deleted by D983) |
| D895 | 2026-11-11 | Finding: in the funnel the student's check is as good as D493's Opus oracle. | finding |
| D896 | 2026-11-11 | With `pushCheckLocal`, `pushOpen` (D702) opens the push and the check reads it. | adopted |
| D897 | 2026-11-11 | Finding (M1, Pi round 1, pre-registered §2c): the student's check fails live. | finding |
| D898 | 2026-11-11 | Lab only: Pi round 2 is pre-registered | lab |
| D899 | 2026-11-11 | Stopped by the owner's decision (through the parent): the LLM-sized local checker; Pi round 2 (D898) is cancelled before any shard ran. | adopted |
| D980 | 2026-11-11 | Finding (M1 micro track, gate G0): the 8B teacher does not agree with Haiku's push check as closely as Haiku agrees with itself, because… | finding |
| D981 | 2026-11-11 | Lab only: the micro checker's bar is pre-registered: better than Haiku, not within its noise | lab |
| D982 | 2026-11-11 | Rejected (stopped on its pre-registered rule, D981): a micro CPU push check distilled from the 8B. | rejected |
| D983 | 2026-11-11 | Rejected and deleted: the `pushCheckLocal` trial (D894) with its code and tests. | rejected |
| D913 | 2026-11-11 | Rejected (stopped on its pre-registered rule, M3, D908 rule 1): `pushSupersede`, a binarised pair model handing a newer pooled item in… | rejected |
| D914 | 2026-11-11 | Rejected (stopped on its pre-registered hand-written gate, M3b): `pushSupersede` with H10 retrained and compressed; findings and lab kit… | rejected |
| D920 | 2026-11-11 | Rejected (stopped on its pre-registered rule, a3faa15a): `packetTrim`, a learned packet trimmer | rejected |
| D921 | 2026-11-11 | Adopted (lab tooling, M6): `hidden-funnel --packet-parts` (each delivered item's parts as compaction reads them, re-rendered from the… | lab |
| D930 | 2026-11-11 | Rejected (stopped on its offline bar): a no-model pre-screen in front of the push check, `pushPrescreen` | rejected |
| D931 | 2026-11-11 | Finding: the push check does not repeat itself closely. | finding |
| D932 | 2026-11-11 | Adopted (lab tooling, M7): the funnel's `--check-dump F` (`check-dump.ts`): one row a push-check call (the request head, day and pool… | lab |
| D950 | 2026-11-11 | Rejected (stopped on its ceiling, before any candidate was frozen): a per-user alias resolver | rejected |
| D951 | 2026-11-11 | Adopted (lab tooling, M9): `packages/sim/lab/m9/` (`links.py` per-user link state, `screen.py` fronting screen, `oracle.py` and… | lab |
| D960 | 2026-11-11 | Rejected: `cardsMicro`, a micro card tagger at ingest in place of the card model's cards | rejected |
| D961 | 2026-11-11 | Finding: what the engine consumes of a card, at $0. | finding |
| D962 | 2026-11-11 | Adopted (lab tooling, M10): `packages/sim/src/lab/m10/` (`export.ts` items with the tagger's candidates from the train and longtail… | lab |
| D963 | 2026-11-11 | Not taken: dropping the card fields from the card call (cards off, the call writing requests only). | rejected |
| D970 | 2026-11-11 | Rejected (stopped on its pre-registered rule, ee079a30, amended before selection by 61f5130b and 4539fab1): `intentMicro`, an intent… | rejected |
| D971 | 2026-11-11 | Finding: Haiku's intent value is its bridge terms, and a $0 item-side model does not learn them for new families. | finding |
| D972 | 2026-11-11 | Adopted (lab tooling, M11): `m11-export.ts` (items, worlds, tasks, twins and the checked-in Haiku requests by card key), `m11-enrich.ts`… | lab |
| D990 | 2026-11-11 | Fix: the server image started nothing. | adopted |
| D991 | 2026-11-11 | Persistence on by default. | adopted |
| D992 | 2026-11-11 | More than one machine, built (D864's design, refreshed). | adopted |
| D993 | 2026-11-11 | Per-tenant caps across machines: held whole at the cluster router, divided below it. | adopted |
| D994 | 2026-11-11 | Readiness, metrics and a draining shutdown. | adopted |
| D995 | 2026-11-11 | Fencing and forget across machines (the reviewer's findings on D992-D994). | adopted |
| D1030 | 2026-11-11 | Finding and lab tooling: where a user's day of packet bytes goes, and `days-calls --packets` to read it | finding |
| D1031 | 2026-11-11 | Rejected and deleted: `leadOnce`, the candidates' lead said whole once a session and pointed back to after | rejected |
| D1032 | 2026-11-11 | Rejected and deleted: `leanItems`, deterministic boilerplate rules in compaction | rejected |
| D996 | 2026-11-11 | Rejected (stopped on its pre-registered rule, 327c9fb2): a shorter warm-to-compact window for daily agents' peak hour. | rejected |
| D997 | 2026-11-11 | The kit's configs are checked statically, since the tools could not run here. | adopted |
| D998 | 2026-11-11 | A heavy user's memory, cut where it was exact to cut; card state frozen with its user rejected. | adopted |
| D1050 | 2026-11-11 | Rejected (stopped on its pre-registered screen): a leaner push-check pool | rejected |
| D1051 | 2026-11-11 | Rejected, not built: a no-model skip rule and a speculative start for the push check | rejected |
| D1052 | 2026-11-11 | Rejected (stopped on its pre-registered screen): more items a card call and a compact card reply; the Message Batches API stays rejected | rejected |
| D1053 | 2026-11-11 | Finding: the shipped card-and-intent prompt leaves the whole requests list out of about a quarter of its replies; a fix is recommended as… | finding |
| D1054 | 2026-11-11 | Finding: full intent coverage adds no facts over the lean selection when the requests are the same | finding |
| D1055 | 2026-11-11 | Adopted (lab tooling, H2): `h2-cards-screen.ts` (the card call's shapes on fixed items, `--arms`, `--show`), `packages/sim/lab/h2/skip.py`… | lab |
| D1000 | 2026-11-11 | Rejected (deleted with its code): `pushWide`, the push's lexical search read 60 deep with a re-ranker for the pool's tail seats | rejected |
| D1001 | 2026-11-11 | Rejected (deleted with its code): `poolExpand`, a query-side expansion distilled from M1's 8B teacher | rejected |
| D1002 | 2026-11-11 | Rejected (stopped on the round-3 rule before any held-out read; deleted with its engine code): `poolScan`, a request × item scorer… | rejected |
| D1003 | 2026-11-11 | Finding: distilling the 8B teacher did not reach facts the pool misses on the sim. | finding |
| D1004 | 2026-11-11 | Adopted (lab tooling, M12): `packages/sim/lab/m12/` (expansion and pair-scorer trainers, re-rank, PRF and ceiling screens, `poolscore.py`… | lab |
| D1010 | 2026-11-11 | Rejected: `pushGate`, a tiny learned turn gate in place of `pushStart`'s verb lists and lead-ins | superseded (replaced by D1014) |
| D1011 | 2026-11-11 | Finding: a learned gate transfers to hand-written text only beside the rule, as a union with a veto. | finding |
| D1012 | 2026-11-11 | Finding: what generated training text teaches a gate besides the task. | finding |
| D1013 | 2026-11-11 | Adopted (lab tooling, M13): `packages/sim/lab/m13/`: contrastive data generators (`gen_train.py`, `gen_logs.py`, `gen_extra.py`)… | lab |
| D1014 | 2026-11-11 | The owner's decision: `pushGate` (M13's turn gate, round 3's frozen model, the union with `pushStart` at veto 0.25) is in… | adopted |
| D1015 | 2026-11-11 | Stopgap on D1014's gate: no start by the gate alone for a turn of fewer than three words (`MIN_ADD_WORDS`, `turn-gate.ts`); round 4's… | adopted |
| D1060 | 2026-11-11 | Trial `cardsRequestsFix`: the card prompt's first example reply shows the requests list, and a batch whose reply still drops it is asked… | adopted (by D1062) |
| D1061 | 2026-11-11 | Precision over recall, an explicit exception (the parent's decision): `cardsRequestsFix` goes ahead with funnel decoys +11 of 608. | adopted |
| D1062 | 2026-11-11 | `cardsRequestsFix` joins the default (closes D1060's trial; parts `cards` and `intent`). | adopted |
| D1063 | 2026-11-11 | Adopted (lab tooling): the card prompt's form in replay. | lab |
| D940 | 2026-11-11 | Rejected (deleted by D948): trial `routerGate`, a learned connector router. | superseded (deleted by D948) |
| D941 | 2026-11-11 | Adopted (lab tooling, M8), at commit d42d30b9 with the engine hooks it needs; the Python trainers stay in `packages/sim/lab/m8/`… | lab |
| D942 | 2026-11-11 | Pre-registered rule for D940 | lab |
| D943 | 2026-11-11 | Rejected (deleted with the router, D949): trial `routerDormantMs`: a source on D356's weekly sweep that the router has not found likely… | superseded (deleted by D949) |
| D944 | 2026-11-11 | Finding: the router's frozen model and its parity (c2923a86; deleted with the router, D948). | finding |
| D945 | 2026-11-11 | Approved for the trial, then deleted with it (D948), so D603 stands unchanged: a departure from D603's "a read on strong evidence is never… | adopted |
| D946 | 2026-11-11 | Finding: rare-connector facts are lost after fetching, not before. | finding |
| D947 | 2026-11-11 | The parent's decisions on D942's rule (recorded with their reasons). | adopted |
| D948 | 2026-11-11 | Rejected and deleted (stopped on its Pi clause, D814): `routerGate`, its model, asset, hooks and tests; D603 stands. | rejected |
| D949 | 2026-11-11 | `routerDormantMs` passed its powered re-test but is deleted with the router (D948) | rejected |
| D1070 | 2026-11-11 | Release readiness: the deploy kit's correctness fixes; amends D994 and D995. | adopted |
| D1020 | 2026-11-11 | Adopted (lab tooling, M14): two more task generators on M2's schema and labels, G2 and G3. | lab |
| D1021 | 2026-11-11 | Adopted (lab tooling, M14): the leave-one-generator-out screen is the standard transfer check for a micro model. | lab |
| D1022 | 2026-11-11 | Finding: M2's fact-versus-twin separation is mostly length. | finding |
| D1023 | 2026-11-11 | Finding: no transfer recipe closes the gap to the sim's hand-written families; mixing generators does not beat M2 alone. | finding |
| D1024 | 2026-11-11 | Adopted (lab data, M14): a length-debiased M2 (`m2lb`), the M2 slice a micro model is screened on. | lab |
| D1025 | 2026-11-11 | Rejected: the recipes that did not help on the held-out sources. | rejected |
| D1071 | 2026-11-11 | A persistence key that opens none of the persisted users stops the start (the parent's decision on R1's finding; amends D425 and D991). | adopted |
| D1072 | 2026-11-11 | Finding: the push check's wait is mostly fixed, and neither concurrent split calls nor a line reply cut it | finding |
| D1073 | 2026-11-11 | Rejected (stopped on its pre-registered Pi clause): `pushCheckDedupe`, the check reading the pool's head less same-titled copies, ten… | rejected |
| D1074 | 2026-11-12 | Rejected again on the powered re-test (the parent's call after D1073): `pushCheckDedupe` 10 is deleted | rejected |
| D1040 | 2026-11-11 | Adopted (lab tooling, B19): an Eden arm at any commit beside a pinned harness. | lab |
| D1041 | 2026-11-11 | Lab only: pi-ab loads P3's `hits` helper (`lexical-hits.ts`) only for the `hits` arm | lab |
| D1042 | 2026-11-11 | Lab fix: hermes-ab wires the push check | adopted |
| D1043 | 2026-11-11 | Lab only: B19's final run is pre-registered | lab |
| D1044 | 2026-11-11 | Adopted (lab tooling, B19): `hermes-ab --days`, pi-ab's user days on Hermes, with the D813 journal and `--resume`. | lab |
| D1045 | 2026-11-11 | Lab only: B19's pre-registration amended before the go | lab |
| D1046 | 2026-11-11 | Lab only: B19's coverage when the final default keys its cards apart | lab |
| D1047 | 2026-11-11 | Lab only: B19's harnesses load against an older engine through `compat.py`, and `go.sh` checks it before spending. | lab |
| D1048 | 2026-11-12 | Finding (B19, blind heldout19, read once): the night's wave raised hidden facts on both harnesses with no confirmed concern. | finding |
| D1075 | 2026-11-12 | Finding: the smallest recommended box holds its sizing; a restart of a full box keeps only the users its shutdown budget writes. | finding |
| D1076 | 2026-11-12 | Rejected: a shutdown's flush writing the most recently used users first. | rejected |
| D1080 | 2026-11-12 | Lab only: `heldout20` is the blind suite for the F1–F3 fixes, registered unread | lab |
| D1120 | 2026-11-12 | Trial `packetWhy` (F3, off): each item a packet or ask answer hands over gets Eden's own note on why it bears on the request, when the… | superseded (deleted by D1121) |
| D1121 | 2026-11-12 | Rejected (stopped on its pre-registered rule, D1120): `packetWhy`, Eden's no-model note on why an item bears on the request; deleted (code… | rejected |
| D1100 | 2026-11-12 | Lab only: `dev20a`–`dev20d` (`--suite dev20`), four tuning suites on the weak points | lab |
| D1140 | 2026-11-12 | Finding (F2, train, reworded and longtail seeds 41–42; Anthropic-direct lab $1.00 before the credit ran out, then a subagent-simulated… | finding |
| D1141 | 2026-11-12 | Rejected: trial `pushCheckRecall`. | rejected |
| D1102 | 2026-11-12 | Lab only: shipped coverage re-recorded on the world's clock, served by subagents per item; the old shipped baselines were pessimistic | lab |
| D1103 | 2026-11-12 | Lab only: `--realism heavy`, a heavy real user's sources | lab |
| D1104 | 2026-11-12 | Finding (lab): no subagent recipe gives an API-faithful read of a push-check prompt arm; check-prompt arms need the API | finding |
| D1101 | 2026-11-12 | Lab only: the queue transport (`EDEN_LAB_QUEUE=DIR`): every lab model call answered by Claude Code subagents through files, at $0 | lab |
| D1122 | 2026-11-12 | Trial `packetWhy` (v2; F3, off; re-opens D1120's switch after D1121, for a suite that can show it): the note with D1121's two parser… | superseded (deleted by D1126) |
| D1123 | 2026-11-12 | Trial `packetChanges` (F3, off): Eden keeps what changed in an item at its source and says it when it hands the item over; with it, silent… | superseded (deleted by D1126) |
| D1124 | 2026-11-12 | Lab only: the pre-registered rule for D1122 and D1123 | lab |
| D1125 | 2026-11-12 | Lab only: D1124's run moves to subagents, with unrelated silent edits in every variant | lab |
| D1126 | 2026-11-12 | Rejected (stopped on D1125's pre-registered rule): `packetChanges` (D1123) and `packetWhy` v2 (D1122, deleted by D1126); both deleted with… | rejected |
| D1127 | 2026-11-12 | Trial `freshenAgeMs` (F3, 0 = off): with `verifyDelivery`, a cached copy no read has refreshed for longer than this is re-read by its ref… | superseded (deleted by D1130) |
| D1128 | 2026-11-12 | Lab only: D1127's pilot read out under its rule, and a powered re-test is pre-registered (before any of its answers is made). | lab |
| D1129 | 2026-11-12 | Trial `freshenBehind` (F3, off; with `freshenAgeMs`): the aged copies' re-reads run beside the delivery instead of before it. | superseded (deleted by D1130) |
| D1130 | 2026-11-12 | Rejected (stopped on D1128's pre-registered rule): `freshenAgeMs` (D1127, deleted by D1130) and `freshenBehind` (D1129, deleted by D1130)… | rejected |
| D1131 | 2026-11-12 | Trial `syncActivePollMs`: a background poll floor for active users, so a silent edit is stored before the request that needs it and no… | adopted |
| D1132 | 2026-11-12 | Promoted: the freshness floor (`syncActivePollMs` 2 h, D1131) into the default, with two cost guards: `syncActivePollBackoff` (on in the… | adopted |
| D1133 | 2026-11-12 | Amends D1132 (the parent's fail-safe condition): the freshness floor polls only a source marked first-party or flat-rate… | adopted |
| D1190 | 2026-11-12 | Finding: the push check's own bill has little left that keeps its replies; its wait is the larger prize, and neither skipping nor… | finding |
| D1191 | 2026-11-12 | Deleted unmeasured (D814; the integrator's decision): F7's trials `pushCheckLeanStop` (the check's yeses first and its reply stopped at… | rejected |
| D1160 | 2026-11-12 | Rejected and deleted (stopped on the pre-registered rule of 56b375d9): F6's uptake levers, `checkedLead` (a checked packet led by "a check… | rejected |
| D1250 | 2026-11-12 | Finding: with Eden the agent takes fewer turns and connector calls, and the calls it still makes are on the turns Eden stays silent. | finding |
| D1251 | 2026-11-12 | Rejected and deleted (F11, pre-registered rules of 6b40a740, 7f705cf6 and 0170bc89): `ask_context` as the agent's first search. | rejected |
| D1252 | 2026-11-12 | Rejected, not promoted: `pushLookup`, `pushLookupAny` and `pushLookupQuiet`, off in the default. | rejected |
| D1192 | 2026-11-12 | Rejected (stopped on its pre-registered rule, F7 §10): `pushSearchedLead`, a checked candidates packet saying Eden searched the user's… | rejected |
| D1150 | 2026-11-12 | Finding (F1, subagent-simulated; rejected as built, no engine trial): an encoder's candidates added to the push check's pool. | finding |
| D1151 | 2026-11-12 | Finding (F1, subagent-simulated; not built): the narrow encoder variant in the push check fails its rule by one neutral task. | finding |
| D1152 | 2026-11-12 | Finding (F1, served by subagents, D1101): the request glossary's queue pair fails its neutral bar. | finding |
| D1153 | 2026-11-12 | Promoted (F1, served by subagents, D1101; D814; rule b5b6b58b, the integrator's English-parity bar): `requestGloss` is in the default. | adopted |
| D1180 | 2026-11-12 | Promoted on subagent evidence; the API confirmation is owed when credit returns (F5, D814, the integrator's decision): the rule sheet… | adopted |
| D1181 | 2026-11-12 | Deleted: `cardsKeepOnly` and `pushCheckSheetAlways`. | rejected |
| D1182 | 2026-11-12 | Rejected and deleted (F5 with F10, D814; the integrator's bar): `pushCheckSheetSelect`, the rule sheet picked per request by F10's rule… | rejected |
| D1183 | 2026-11-12 | Guard on D1180 (F5, the integrator's question): a user with more active rule cards than `pushCheckSheet` (80) gets no rule sheet. | adopted |
| D1197 | 2026-11-12 | Adopted (F7; the integrator's decision to keep the rule sheet and make it as cheap as it can be): the push check's rule sheet (D1180) is… | adopted |
| D1300 | 2026-11-12 | Finding: in the sim, nothing in a world foreshadows its requests, so plan-driven anticipation cannot be measured there; constraint-driven… | finding |
| D1301 | 2026-11-12 | Rejected: `anticipate`, a background pass per user that writes, for each rule on the user's sheet, the requests it bears on, their days… | rejected |
| D1302 | 2026-11-12 | Finding: on train and dev20 the hidden facts never retrieved are a meaning gap between twins, and no lever with no model (or within +2 ms… | finding |
| D1154 | 2026-11-12 | Rejected and deleted (F1, served by subagents, D1101; stopped on the pre-registered rule of 606571ee/89d98a27): `cardsRequestsWide`, the… | rejected |
| D1270 | 2026-11-12 | Finding: a CPU-only band on the push check (a semantic rule index) cannot take the model off the request path at facts in the 90s | finding |
| D1271 | 2026-11-12 | Rejected: `pushCheckView`, the check reading the pool's first 8 items and the 3 rules nearest the request by meaning | rejected |
| D1272 | 2026-11-12 | Finding: a learned no-model skip of the push check reaches about 20% of calls at 1% of facts lost, not the 40% asked | finding |
| D1273 | 2026-11-12 | Promoted by the integrator: the turn goes upstream during Eden's wait and its held answer is used when the request after the wait is byte… | adopted |
| D1274 | 2026-11-12 | Rejected before building: trial `pushCheckSkip`, a no-model skip of the push check at the integrator's second bar (≥ 18% of the 1:1:8 mix… | rejected |
| D1550 | 2026-11-12 | Finding: the agent's wait, read task by task, puts the default level with the agent alone at the lab's connector latency and slower at 0.3… | finding |
| D1552 | 2026-11-12 | Rejected: `pushLookupUnchecked`, the lookup's reference records on turns whose pool holds nothing constraint-like (no check is asked). | rejected |
| D1155 | 2026-11-12 | Lab only: pi-ab and hermes-ab place the packet a tool result's observe hands out. | lab |
| D1500 | 2026-11-12 | Finding (G3, served by subagents, D1101; every $ and second [EST]): no lever makes agent + Eden no dearer than the agent alone at the… | finding |
| D1156 | 2026-11-12 | Rejected before any live run: `freshenHanded`, re-reading the push gate's first constraint-like items beside the check so a silent edit… | rejected |
| D1193 | 2026-11-12 | Promoted (F2, the integrator's decision): `cardsState` + `pushStateFilter`, on in the default: the card says whether its constraint still… | adopted |
| D1455 | 2026-11-12 | Finding: most look-alikes reach the agent round the push check, not through it. | finding |
| D1450 | 2026-11-12 | Promoted: `packetHeedsCheck`, on in the default: a rule path's proactive packet is not handed when the request's push check read every… | adopted |
| D1451 | 2026-11-12 | Rejected and deleted: `stateFilterWide`, F2's cleared-state test (D1193) on rule-path packets and on an explicit ask in a request the push… | rejected |
| D1452 | 2026-11-12 | Rejected and deleted: `askHeedsCheck`, an ask that leaves out what its request's push check turned down. | rejected |
| D1453 | 2026-11-12 | Rejected and deleted: a `why` field on the check's ruled-out entries (clear, other, background), the ask leaving out only go-aheads. | rejected |
| D1454 | 2026-11-12 | Finding: `pushCheckItemChars` 400 is not a facts lever. | finding |
| D1456 | 2026-11-12 | Adopted: `pushStateFilter` keeps a lift notice in the push's pool when the user has a constraint card it could clear. | adopted |
| D1400 | 2026-11-12 | Trial opened (G1, target 2: hidden facts found and given): `pushDaySeats` 3, a plan with a day is an action on that day. | superseded (deleted by D1402) |
| D1401 | 2026-11-12 | Trial opened: `pushDayStartSeated`, a third arm of D1400's pair, registered before any live result of that pair was read. | adopted |
| D1402 | 2026-11-12 | Promoted by the integrator, below G1's own ship rule, as a strict gain: `pushDaySeats` 3 in `DEFAULT_CONFIG` (part `days`) with D1401's… | adopted |
| D1196 | 2026-11-12 | Trial `EDEN_MODEL_CACHE=on`: the servers' roles send Anthropic `cache_control` breakpoints on their stable system prefix through OpenRouter | adopted |
| D1690 | 2026-11-12 | Adopted: model-call failures are counted by role and kind on `/metrics` (`eden_model_failures_total{role="reader"\|"check",kind="error"\|"unr…` | adopted |
| D1600 | 2026-11-12 | The server image runs on Bun's distroless image. | adopted |
| D1700 | 2026-11-12 | The server image leaves out the lab, tests and benches. | adopted |
| D1701 | 2026-11-12 | Finding: every technical choice reviewed; two switches (D1600, D1700), the rest kept or left as candidates with what each needs. | finding |
| D1702 | 2026-11-12 | A node drops port 8790 from outside the private range in DOCKER-USER. | adopted |
| D1703 | 2026-11-12 | Finding: every file and every product design choice reviewed; no further switch clears the bar. | finding |
| D1704 | 2026-11-12 | Adopted: Eden speaks MCP through its own minimal client, streamable HTTP transport and `ask_context` server; `@modelcontextprotocol/sdk`… | adopted |
| D1705 | 2026-11-13 | Adopted: Eden has no production npm dependency. The seven gitleaks rules that backtrack in JavaScript run on hand-written linear matchers… | adopted |
| D1710 | 2026-11-13 | Adopted: the request glossary is answered from its file's bytes, and a process reads its lexicons only when a request could be read as… | adopted |
| D1715 | 2026-11-13 | Rejected: a binary layout specialised to a frozen user's structures, in place of the compact form's zstd JSON and the warm form's ("EDF2")… | rejected |
| D1720 | 2026-11-13 | Rejected: a specialised store for the source map (an in-memory map per user with an append-only log and compaction) in place of… | rejected |
| D1721 | 2026-11-13 | Adopted (a profiling survey's first lever): `ItemCache.dated` reads each item's date facts, not its text, on every request that names a day. | adopted |
| D1722 | 2026-11-13 | Adopted (a profiling survey's second lever): a re-stored copy equal in every field keeps the object the cache holds, so the conflict… | adopted |
| D1723 | 2026-11-13 | Adopted (a profiling survey's third lever): the conflict test's analysis tests each sentence against one union of its mark lists first… | adopted |
| D1730 | 2026-11-13 | Rejected: specialising the per-user search index for an order-of-magnitude gain on any axis (a persisted or viewed index in the compact… | rejected |
| D1740 | 2026-11-13 | Adopted (the inference and tokens survey): `readSse` (`packages/llm/src/anthropic.ts`, the lab's Anthropic transport and… | adopted |
| D1741 | 2026-11-13 | Rejected: `pushCheckSheetAppend`, the push check's rule sheet in the order its cards were made, one text block a rule, the breakpoint on… | rejected |
| D1742 | 2026-11-13 | Finding: no output-invariant cut of 10% or more is left in any model role; the push check's price is its rule sheet's cache writes, its… | finding |
| D1746 | 2026-11-13 | Finding, with a lab instrument: connector calls by cause. | finding |
| D1747 | 2026-11-13 | Promoted (opened and decided the same session, D814): `syncActivePollCap` 40, a per-user allowance on the freshness floor's polls of… | adopted |
| D1748 | 2026-11-13 | Finding: no lever decidable at $0 cuts the push's modelled wait by 15% with outputs identical; the wait is the check, and under bare… | finding |
| D1770 | 2026-11-13 | Finding: on train (seeds 41–42, shipped coverage) the default leaves 62 of 384 hidden facts unsurfaced: 29 never reach the push's pool and… | finding |
| D1771 | 2026-11-13 | Rejected at $0 on train: seating constraint cards in the push's and the ask's order. | rejected |
| D1772 | 2026-11-13 | Rejected at $0 on train for this bar: day seats ordered constraint-carded first, and day ranges read whole. | rejected |
| D1773 | 2026-11-13 | Adopted (a correctness fix, D1772's finding): `timeWindow` reads a day range whole. | adopted |
| D1781 | 2026-11-13 | Finding: no lever lowers a server process's memory floor by the bar (10 MB or 15% a process, first request within noise); kept as it is. | finding |
| D1782 | 2026-11-13 | Finding: the cold gate cannot be made 20% faster by the listed levers (fuzz counts behind a deep switch, serial bottlenecks in… | finding |
| D1790 | 2026-11-13 | Adopted: the servers send Anthropic `cache_control` breakpoints on the roles' stable prefix through OpenRouter by default… | adopted |
| D1780 | 2026-11-13 | Adopted (D1720's candidate): the source map writes mentions behind, as it writes outcomes (D4): summed in memory per (user, entity… | adopted |
| D1800 | 2026-11-13 | Adopted: the push check's rule sheet carries its 1-hour cache breakpoint only when caching it is likely to pay for that user… | adopted |
| D1810 | 2026-11-14 | Rejected: the push check's fixed instructions sent with no cache breakpoint at all, as a third choice of `SystemTtlPolicy` beside the hour… | rejected |
| D1830 | 2026-11-14 | Adopted (eval tooling; no engine change): `bun run eval --live` reports the push check and fails loudly when it measured no model. | adopted |
| D1840 | 2026-11-14 | Adopted: the MCP client reads replies faster. `bodyShapeUnder` crosses strings with the native `indexOf`, the SSE parser finds line ends… | adopted |
| D1841 | 2026-11-14 | Adopted: the secret gate runs each gitleaks and Eden regex rule only where its matches can start, and does less around the rules, with… | adopted |
| D1850 | 2026-11-14 | Adopted: the secret gate's remaining weak points fixed, the package made standalone, and a head-to-head with the open-source alternatives. | adopted |
| D1860 | 2026-11-14 | Adopted: the MCP client reads a JSON reply natively when its only framing is a declared length under the cap, carries its shape check with… | adopted |
| D1870 | 2026-11-14 | Adopted: the shape scan finds a string's end by its next quote, and a JSON reply's long plain strings are spliced out of the parse as… | adopted |
| D1871 | 2026-11-14 | Rejected: reading a JSON reply with `res.json()` and checking its depth and size after the parse. | rejected |
| D1872 | 2026-11-14 | Adopted: the per-reply caps on server requests and bad messages become budgets, settable per transport. | adopted |
| D1873 | 2026-11-14 | Adopted (opt-in, off on Eden's path): SSE resumption by `Last-Event-ID` and the standalone GET stream. | adopted |
| D1874 | 2026-11-14 | Adopted (opt-in, never imported by Eden's path): the client side of MCP's authorization spec, `src/mcp/oauth.ts`. | adopted |
| D1875 | 2026-11-14 | Adopted (opt-in; Eden sets none): handlers for the server's requests. | adopted |
| D1880 | 2026-11-14 | Adopted: the reader gate reads each item's words once. | adopted |
| D1881 | 2026-11-14 | Adopted (same brief): packet compaction does less per item with the same output. | adopted |
| D1882 | 2026-11-14 | Adopted (same brief): the packet's parts of recent items are read once. | adopted |
| D1883 | 2026-11-14 | Adopted (same brief): `datesOf` skips its month patterns on a sentence that holds no figure beside a month's name. | adopted |
| D1884 | 2026-11-14 | Adopted (same brief): the known test and `pick`'s score read a part's words in place. | adopted |
| D1885 | 2026-11-14 | Adopted (same brief): an item's version and times are read once per item object; a lookup hashes only items the ledger holds a version of. | adopted |
| D1886 | 2026-11-14 | Adopted (same brief): the sync's per-item readings by code unit. | adopted |
| D1887 | 2026-11-14 | Adopted (same brief): `sketchTerms` tests stopwords and repeats where the word lies. | adopted |
| D1888 | 2026-11-14 | Adopted (same brief; amends D1721's "not frozen or persisted"): a freeze carries each entry's date facts. | adopted |
| D1889 | 2026-11-14 | Adopted (same brief): `assess` reads a statement's mark extremes by loops (`maxOf`, `minOf`, `maxBelow`), not spreads into `Math.max`. | adopted |
| D1890 | 2026-11-14 | Adopted: the turn gate reads a turn 3.0x faster. | adopted |
| D1891 | 2026-11-14 | Adopted: the glossary's English path 2.6x faster. | adopted |
| D1892 | 2026-11-14 | Adopted: the HTTP handler parses less a request. | adopted |
| D1893 | 2026-11-14 | Finding: the model call path has no CPU or token lever worth its risk. | finding |
| D1894 | 2026-11-14 | Rejected (measured beside D1890–D1892): the turn gate's int8 table copied biased at load, the hidden layer transposed, a dim-specific… | rejected |
| D1900 | 2026-11-15 | Adopted: a long reply's long string with escapes is read once, its end guessed from the back and proven by reading it. | adopted |
| D1901 | 2026-11-15 | Adopted (Bun only): a long string with an escape every dozen bytes or closer is unescaped by a byte loop, not `JSON.parse`. | adopted |
| D1902 | 2026-11-15 | Adopted: an array of plain numbers is read as the scan reaches it. | adopted |
| D1903 | 2026-11-15 | Adopted: a reply that is mostly structure is bounded by counting brackets and commas, not scanned. | adopted |
| D1904 | 2026-11-15 | Adopted: `parseJsonBytes` decodes a long body first and takes the same path, so Node, SSE and stdio get D1870-D1903; ASCII is decoded by… | adopted |
| D1905 | 2026-11-15 | Bench: the MCP benches take the result's text shape. | adopted |
| D1906 | 2026-11-15 | Rejected: reading Bun's JSON replies as bytes (`res.bytes()`, a byte scan with the same readers, pieces decoded apart). | rejected |
| D1907 | 2026-11-15 | Rejected (measured beside D1900-D1904): other ways to the same values. | rejected |
| D1908 | 2026-11-15 | Adopted (D1900's independent review, every finding fixed; no answer changed: 0 differences from main's shape check and `JSON.parse` on… | adopted |
| D1909 | 2026-11-15 | Adopted (D1908's independent review, REQUEST_CHANGES on cost only; every finding fixed, no answer changed: 0 differences from main's real… | adopted |
| D1910 | 2026-11-14 | Adopted: `pick`'s focus count searches each focus word with `indexOf`. | adopted |
| D1911 | 2026-11-14 | Adopted (same brief): `sketchTerms` skips `stopwordAt` where the word's FNV-1a hash has no stopword's mark. | adopted |
| D1912 | 2026-11-14 | Rejected (measured): a packed text deflated by libdeflate (`Bun.deflateSync`'s `library: "libdeflate"`, level 6) in place of zlib. | rejected |
| D1913 | 2026-11-14 | Adopted (same brief): `packItem` notes the text it deflated in the decode memo. | adopted |
| D1914 | 2026-11-14 | Rejected (measured): `extractTypedEntities` reading a one-word capitalised run without its split, join and three `isCalendar` calls. | rejected |
| D1915 | 2026-11-14 | Adopted (same brief; no `await` added or removed, card bytes unchanged): the card queue reads the strict prefilter's own text once. | adopted |
| D1916 | 2026-11-14 | Adopted (same brief; date facts unchanged, so `PERSIST_FORMAT` stays 6): `SPAN_HINT`'s month alternative and `MONTH_DAY` are tried only… | adopted |
| D1917 | 2026-11-14 | Rejected (measured beside D1910-D1916): an in-place JS xxHash32 so `sketchTerms` makes no string a word, and one-class lookahead prefixes… | rejected |
| D1918 | 2026-11-14 | Finding (measured beside D1910-D1917): the rest of the second brief's scope has no lever worth its risk at today's shares. | finding |
| D1919 | 2026-11-15 | Adopted (D1909's independent review, REQUEST_CHANGES on the number reader's cost; every finding fixed, no answer changed: 0 differences… | adopted |
| D1920 | 2026-11-15 | Adopted (a third low-level brief; outputs unchanged): the rule paths' repeated per-item and per-name readings are memoised per item object… | adopted |
| D1925 | 2026-11-15 | Adopted (a profiling survey's brief; routing unchanged): the router reads a body's top-level `userId` by one scan, not a decode and… | adopted |
| D1926 | 2026-11-15 | Adopted (same brief; pre-registered in 86c1645bc: promote if ingest process CPU paired ≤ 0.92 and live heap a user ≤ +3%, else delete): a… | adopted |
| D1927 | 2026-11-15 | Adopted (a profiling survey's brief; pre-registered in ef7f794d3: adopt if the shipped ingest.bench sweep's process CPU, 200 × 500, paired… | adopted |
| D1930 | 2026-11-15 | Adopted (a fourth low-level brief, on the ask path; outputs unchanged): the conflict analysis's per-object entry never reads a packed… | adopted |
| D1931 | 2026-11-15 | Adopted (same brief): `renderPacket` compacts an item only when its size loop reaches it. | adopted |
| D1932 | 2026-11-15 | Adopted (same brief; D1918 had not built a `datesOf` memo because its days depend on the instant): a statement's date patterns are read… | rejected |
| D1933 | 2026-11-15 | Adopted (same brief): the ask path's smaller repeats. | adopted |
| D1934 | 2026-11-15 | Adopted (same brief): `mentionsAny` searches the item's lowercased text in place. | adopted |
| D1935 | 2026-11-15 | Adopted (a fourth low-level brief, the graph and index layer; every answer unchanged): the source map's reads are memoised, exactly. | adopted |
| D1936 | 2026-11-15 | Adopted (same brief; answers unchanged): a new source-map file makes its three tables `WITHOUT ROWID`. | adopted |
| D1937 | 2026-11-15 | Adopted (same brief; keys unchanged): `normalizeEntity` reads plain names in one pass. | adopted |
| D1938 | 2026-11-15 | Finding (measured beside D1935-D1937): the rest of the graph and index layer has no lever worth its risk at today's shares. | finding |
| D1940 | 2026-11-15 | Adopted: the proxy reads a request's history once, the server's shape check counts brackets before it scans, and a tool call's check skips… | adopted |
| D1941 | 2026-11-15 | Finding (measured beside D1940): the rest of the edge has no lever. | finding |
| D1945 | 2026-11-15 | Adopted (a dev-loop brief; no test weakened, every test still run): the gate spends about 7% less CPU, its main-run test limit is 60 s… | adopted |
| D1950 | 2026-11-15 | Adopted (same brief): `assess` reads only the statements that can move its verdict. | adopted |
| D1951 | 2026-11-15 | Adopted (same brief): an equal re-put tallies the held copy's people out and in from one reading. | adopted |
| D1952 | 2026-11-15 | Finding (measured beside D1930-D1934, D1950 and D1951): the ask path's end to end, and what was left. | finding |
| D1960 | 2026-11-15 | Adopted (closes D1936's open item; every row, value and answer unchanged): a source-map file made before D1936 is moved to the WITHOUT… | adopted |
| D1965 | 2026-11-15 | Adopted (a test-robustness brief; no test deleted, skipped or run on less input): the load-sensitive guards read what they guard instead… | adopted |
| D1966 | 2026-11-18 | Adopted (Hermes local): the Hermes plugin starts a private, volatile Eden sidecar on demand. | adopted |
| D1967 | 2026-11-18 | Adopted: the source map writes planner arms behind with mentions (D4, D1780). | adopted |
| D1968 | 2026-11-18 | Adopted (outputs unchanged): `namesRequestDay` builds its day patterns once per `Anchors` (`DAY_TESTS`, via `dayNamer`), rather than once… | adopted |
| D1969 | 2026-11-18 | Adopted (Hermes local; hosted serving unchanged): the compiled local binary ships `--bytecode`, and local mode warms the secret gate after… | adopted |
| D1970 | 2026-11-18 | Adopted: the no-model paths drop a look-alike that contradicts the request's anchors, and an asking request's fallback hands every early… | adopted |
| D1971 | 2026-11-18 | Adopted: D1970's `contradicts` is narrowed to a stricter reading of the request's anchors — independent review of the merged change found… | adopted |
| D1972 | 2026-11-18 | Adopted (Hermes local onboarding): the release installer verifies the installed sidecar and can write a first source, and every archive… | adopted |
| D1973 | 2026-11-18 | Adopted: questions carry their request's topic, recurring items cover their weekdays, and the asks' name check yields to questions. | adopted |
| D1974 | 2026-11-18 | Adopted: Eden is released under the Apache License 2.0. | adopted |
| D1975 | 2026-11-18 | Adopted: a follow-up also carries what the previous turn delivered, not only the request's words. | adopted |
| D1976 | 2026-11-18 | Adopted: `groundSubject` — a request about a subject it names is grounded in the context around it, not the best match alone. | adopted |
| D1977 | 2026-11-18 | Adopted: `companions` — a delivered item pulls its cross-source companions. | adopted |
| D1978 | 2026-11-18 | Adopted: a request naming days is looked up by day, and the day's items ground it. | adopted |
| D1979 | 2026-11-18 | Adopted: a clash ask resolves "that time" from the last turns, and a bare weekday weakly names a day. | adopted |
| D1980 | 2026-11-18 | Adopted: a wh-question about a thing of the user's own opens the push and its subject answers. | adopted |
| D1982 | 2026-11-18 | Adopted: last year's same-subject record is a sibling, not a second pick — and it stays stale once the newer one was handed. | adopted |
| D1983 | 2026-11-18 | Adopted: a pronoun-person follow-up carries the last request's name, and the person's own record answers it. | adopted |
| D1984 | 2026-11-18 | Adopted: a request may re-search its sources once, bounded and counted, for companions the cache never saw — `companionSearch`. | adopted |
