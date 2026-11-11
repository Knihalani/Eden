# Dead ends

Generated from [DECISIONS.md](DECISIONS.md) by `bun run decisions:index` (scripts/decision-index.ts, D812). Do not
edit: change DECISIONS.md and regenerate. **Read this before proposing an idea**: it may have been tried, measured
and killed already.

Each line is a decision whose status in [DECISION-INDEX.md](DECISION-INDEX.md) is `rejected` or `superseded` by a
deletion, or the rejected part of an adopted one (marked "part of"), with what was tried and, when the text gives it
briefly, the measured reason. Topics come from a keyword map, so an idea can sit under a neighbouring topic: search
the page for its switch name.

133 dead ends.

## Push and candidates

| # | What was tried | Why it ended |
|---|---|---|
| D70 | One-turn packets are rejected: the proactive packet does not carry the no-model gate's held-back candidates or a coverage line (the… | hidden +0.000 (−0.049..+0.050) |
| D73 | `askVerdicts`, off by default: an ask gathers what a lookup gathers (the consequence probe's finds, the graph walk, the card finds) and… | deleted by D226: No-model funnel, ALL, seeds 41–44, $0. |
| D81 | `supersede`, off by default: candidates are grouped by matter (subject without "Re:"/"Fwd:" per source, or a title identifier), ordered by… | deleted by D112 |
| D82 | `askRank` (with `askRankMargin` 5), off by default: an ask's pool (the verdict hits, the grounded items, the lexically likely) is ordered… | deleted by D112 |
| D116 | Rejected: An explicit ask does not reuse the push's verdict. |  |
| D129 | `readerPushQuestions` (push-read every user message, past `readerGate`) is not reopened as a trial |  |
| D147 | The reader is not streamed to settle the push early, and a local distilled reader is not built |  |
| D156 | part of: `lat-speculative-first-call` (start the agent's first model call speculatively and keep it only if Eden's push stays silent) is… |  |
| D166 | Moving the push reading off the agent's start is not built |  |
| D191 | Rejected: no blocking `observe` wait when the push's pool is weak. | $0 screen identical (replayed readings take no time). |
| D246 | The push's "nothing found" note (`pushChecked`, CL4 H8) is a trial switch, off, recommended for the cost-and-latency combine stage | deleted by D257: hidden facts: −5.1 points |
| D247 | An ask answering from the push's search (`askFromPush`, CL4 H9) is rejected and deleted |  |
| D248 | Not waiting for the push (speculation on the agent's first model request, CL4 H10) is rejected and deleted |  |
| D249 | Re-reading ahead after the push (`pushVerifyAhead`, CL4) is rejected and deleted |  |
| D250 | A closing "this is what bears on it" line on the push's packet (`pushCovered`, CL4 H13) is rejected and deleted | hidden +0.000 |
| D257 | The push's "nothing found" note (`pushChecked`, D246) is deleted with its code and tests (`push-checked.test.ts`, render.ts's… | hidden facts: −5.1 points |
| D258 | Smaller candidate packets by excerpt size (`pushCandidateBytes`), by not repeating an item within a request (`pushCandidateDedup`) or by a… | hidden facts: −12.8 points |
| D259 | part of: `pushCandidates` stays 5: three candidates, and three on a session's later requests only (`pushCandidatesLater`), are rejected | hidden −1.6 |
| D266 | Rejected and deleted: re-ranking the push's candidates with no model. |  |
| D267 | part of: Rejected and deleted: asks that go past the candidates the agent holds (trial `askPastShown`; A2; code in commit `d096b7ba`) | hidden −0.7 (−6.9..+6.2) |
| D268 | Rejected and deleted: candidate excerpts that keep the constraint sentence first. | hidden −2.7 (−8.2..+2.7) |
| D273 | Four ways to send fewer packet or ask bytes are rejected at $0; the trial switch `pushCandidatesAnchor` is deleted with its code |  |
| D274 | Rejected: telling the agent the candidates are what an ask would return. | hidden −2.8 points (−9.7..+4.2) |
| D286 | Card tags on the push's candidates (trial `pushCandidateCards`, A6) are rejected and deleted | hidden +1.2 points (−4.8..+7.2, n 167) |
| D288 | Not built, on $0 evidence: (1) an entity census line ("no item names X"): it is D257's "nothing found" narrowed and fires where the… |  |
| D300 | Answer-ahead (trial `pushAhead`, A9) is rejected and deleted | hidden −1.8 points (−8.4..+4.8, n 167) |
| D330 | Rejected and deleted: two extra push slots for facts that share few words with the request. | hidden −1.4 points (−7.6..+4.9) |
| D331 | Not built, on $0 evidence: (1) name-free ("general") intent requests written at ingest beside an item's own ("pay a plumber for a… |  |
| D340 | Trial `pushReshow`: a push candidate the agent took for an earlier request of the session is handed again when it ranks among this… | deleted by D380: hidden +6.8 points (−0.5..+14.1) |
| D360 | Rejected and deleted: trial `linkLine`, a no-model line on each push candidate saying what it shares with the request | hidden raised −1.3 points (−4.5..+1.9, n 531) |
| D380 | Deleted: `pushReshow` (D340's trial) with its code and tests, under D112. |  |
| D472 | Rejected and deleted: `pushCheck`, the checker choosing the push's candidates | hidden +4 |
| D492 | Rejected: the distilled checker in the push |  |
| D506 | Trial `pushLazy`, opened and closed 2026-11-10: not promoted, deleted. Finding: the push's background searches buy facts one request a… | hidden −2.3 points |
| D512 | Rejected and deleted: `pushCheckReshow`, a re-show gated by the check. |  |
| D526 | Rejected and deleted: the check's question answered when the item is stored, read by a no-model push |  |
| D529 | Trial `pushCheckGate`, opened and closed 2026-11-10: measured live, not kept, deleted | hidden +5.3 points |
| D700 | Trial `pushCheckBehind`: the push check runs behind the default's packet | deleted by D704: hidden +0.0 points (−2.5..+2.6) |
| D703 | Trial `candidatesSpecifics`: the candidates' lead asks for the item's specifics once it applies | deleted by D705: hidden facts +2.0 points (+0.2..+3.7) |
| D708 | Trial `pushPointer`: the candidates' lead names the items of this request's candidates that the agent was handed for an earlier request | deleted by D711: hidden −1.2 points |
| D711 | `pushPointer` (D708) failed its rule and is deleted with its code and tests | hidden −1.2 points |

## Reader

| # | What was tried | Why it ended |
|---|---|---|
| D110 | Rejected, lab only: The ask-time reader (D95/D96) is not distilled into a local no-model scorer used as a cascade. |  |
| D115 | Rejected: The reader's pool is not widened with the user's constraint items. |  |
| D118 | Rejected: The reader's wait stays at the agent's start (D98, D112's 3,000 ms `waitMs`). |  |
| D122 | Rejected: opening `readerGate` for arranged visits. |  |
| D126 | part of: re-reading by age and age labels are rejected |  |
| D130 | A broad reader veto over rule-path deliveries is rejected; a veto by name waits for a live reader eval |  |
| D151 | The reader veto by name over rule-path deliveries (D130's remaining item, `quality-reader-veto-rule-path`) is not built |  |
| D152 | Stage 2 of `fresh-checkahead-speculative-rereads` (start re-reads from a streamed reader as it names items) is not built |  |
| D157 | `cost-reader-pool-gate-learned` (a learned gate that skips reader calls that would bind nothing) is closed by D110 and not built |  |
| D164 | Prompt-caching the reader's items across calls is not built |  |
| D167 | Overlapping the ask's reader with its poll and live search is not built; the 2026-11-05 audit's O9 item `lat-ask-reader-overlap-poll` is… |  |
| D168 | The closed-class "action unless it looks like a question" rule for the reader's request gate is rejected; widening the gate comes back as… | hidden +2 |
| D174 | Ranking an agent-worded ask on its question plus the session's request is not built, and changes to the ask's cue are screened with a paid… | hidden +1.6 points |
| D190 | Rejected: an evidence gate on the reader's call. |  |
| D194 | Rejected: a shorter reader output schema. |  |
| D195 | The reader veto over rule-path deliveries (D151's hold, built as trial `ruleVeto`/`ruleVetoNamed`) is rejected and deleted | hidden −1.6 (−5.6..+2.5) |
| D230 | Noting ask items the reader read and did not flag (trial `askUnflaggedNote`) is rejected and deleted | hidden −0.4 (−3.5..+2.7) |
| D234 | Not built: reader verdict reuse across a user's sessions. |  |
| D235 | Not built: a local yes/no model in place of the reader (CL1 H15, research only; confirms D147). |  |
| D239 | Compact item fences for the reader are rejected |  |
| D241 | A per-user cached item prefix for the reader is not built |  |
| D345 | A complete poll after a change signal does not stand in for re-reading the doubted copies (`verifyByPoll`, A18): built as a trial… |  |
| D346 | An ask does not re-read its likely citations beside its poll and live search (`askVerifyEarly`, A18): built as a trial, measured, deleted. |  |

## Cards and intent

| # | What was tried | Why it ended |
|---|---|---|
| D90 | The active-constraints digest, `constraintDigest` (needs `cards`; `digest.ts`, `ContextPartner.digest`, `POST /v1/digest`, client… | deleted by D112: Dev (complete dev cards): hidden either 129 → 145, decoys 100 → 108. |
| D170 | Trial `intentConstraintOnly`: with `intent` on, an item the card prefilter rejects is not sent to the card model for its requests alone | deleted by D177: hidden -1.30 points (95% CI -4.17..+1.56) |
| D201 | Rejected: intent requests worded as an agent's user delegates. |  |
| D242 | Rejected: a user's card backlog through Anthropic's Message Batches API. |  |
| D243 | Rejected: fewer intent requests per item. | hidden −3.6 points |
| D318 | Not built, on $0 evidence: intent requests for more item kinds. |  |
| D446 | Not promoted: the distilled model's intent requests fail the pre-registered bar. |  |
| D449 | What a distilled card model would need before production (M2, written, not built). |  |
| D480 | Trial `intentPrune` (pruning an item's intent requests by a no-model score against the item) is rejected and deleted |  |
| D523 | Rejected without a paid run: a card-only (distilled) model reading the rest of a new user's backfill |  |

## Check

| # | What was tried | Why it ended |
|---|---|---|
| D528 | Rejected and deleted: thinking on I3's short reply, and a check that reads only stored-`act` items |  |

## Sync, sources and scale

| # | What was tried | Why it ended |
|---|---|---|
| D132 | Agent-stream replay in the Pi lab is not built as proposed (replay at `--time-scale 0` until the first differing Eden output) |  |
| D142 | Backfill and sweeps may list big pages, min(`syncBigPageSize`, `Source.listPageMax`), only where the source declares a max; off in the… | deleted by D143 |
| D143 | The big-pages trial ends: `syncBigPageSize`, `Source.listPageMax` and the big-page code are deleted (ends D142's trial early) |  |
| D146 | part of: a batch tier (Message Batches) or a cheaper endpoint for request-only items is rejected for now |  |
| D153 | part of: removing it (`r2-anticipate-redundant-under-sync`) is rejected | hidden +0 |
| D213 | Rejected: a per-(user, source) poll window. |  |
| D214 | Rejected: per-source recency caps for synced items. |  |
| D262 | part of: a first page sized to the source's share of the user's cap (`syncBackfillShare`) is rejected and deleted with its code and tests… |  |
| D297 | Trial `syncCarriedSweepMs` (a weekly sweep for sources whose notices carry their changes) opened and deleted the same day: it lets deleted… |  |
| D337 | Not built, on $0 evidence or a $0.06 smoke: (1) the proxy running `ask_context` itself and continuing the model call: the tokens are the… |  |
| D477 | Not built: a timer that polls every source by its change rate. |  |
| D479 | `syncCold` and `syncDelta` are not promoted; they stay trial switches, off. |  |
| D508 | Rejected at $0 and deleted: one search of a source a lookup |  |
| D602 | Not kept: dormant sources (`syncDormantMs`), built, screened at $0 and removed after two reviews. |  |

## Ask

| # | What was tried | Why it ended |
|---|---|---|
| D74 | `askCompact` (with `askItemBytes` 320, `askFullItems`, `askLineBytes`, `askMaxBytes`), off by default: the answer is compacted as a packet… | deleted by D112: Track: bytes per ask dev 1,195.5 → 715.7, in-sample 1,253.6 → 716.6 (ALL + it alone). |
| D83 | `askContext` ranks an `ask` for its question and for the session's latest user request (the lookup's own cue, kept on the session), fused… | deleted by D112 |
| D88 | The guided `ask_context` description is Eden's own (`ASK_CONTEXT_GUIDED` in `@eden/protocol`, exported by the client SDK, read by the… | deleted by D112: Dev (dev6a+dev6b, seeds 41–42, ALL3, no model): delivered and ask-cited unchanged; bytes +6.9%. |
| D125 | part of: ask coalescing is rejected |  |
| D134 | part of: narrowing the ask's own delivery checks is rejected |  |
| D140 | part of: answering an ask from a warm index before its poll is done stays rejected (D65 holds) |  |
| D184 | F10, request-side query expansion (`moonshot-ask-query-expansion-ceiling`), is closed and not built |  |
| D189 | Rejected: request-side query expansion with no model for the ask. |  |
| D226 | `askVerdicts` (D73) is deleted with its code and tests |  |
| D231 | Noting ask answers no reading checked (trial `askUnreadNote`) is rejected and deleted | No fall in false concerns; deleted (code in commit 14968b2b). |
| D485 | Trial `askMulti`, opened and closed 2026-11-10: not promoted, deleted. | hidden −0.4 points (−2.8..+2.1, n 813) |
| D518 | Trial `askReinvite`, opened and closed 2026-11-10: not promoted, deleted. | Same runs as D517. |

## Delivery and packet

| # | What was tried | Why it ended |
|---|---|---|
| D67 | A found conflict is delivered whatever path spoke first. | deleted by D112 |
| D68 | Packets say dates whole. | deleted by D112: hidden raised +0.038 |
| D197 | Labelling rule-path packets (trial `ruleLabel`: the envelope says the items were matched on shared names, dates or wording, not read) is… | hidden −1.3 (−5.3..+2.8) |
| D341 | Rejected and deleted: re-sending every item a session was sent an "updated:" packet for, in its current version, on a recap- or… |  |
| D401 | Rejected at $0: moving the agent's cache mark off the first request's user turn so a one-call task pays 1x, not 1.25x, for the packet. |  |
| D517 | Rejected: shortening earlier requests' packets in the transcript |  |

## Lab and eval

| # | What was tried | Why it ended |
|---|---|---|
| D154 | Request replay for the live agent harnesses is not built |  |
| D185 | F25's unordered subset replay (`devloop-retrieval-screen-set-subset-replay`) is not built; D117 stands |  |
| D701 | Lab only: `pi-ab`'s `+amend` condition flag | deleted by D704: hidden +0.0 points (−2.5..+2.6) |

## Other

| # | What was tried | Why it ended |
|---|---|---|
| D51 | A per-user standing-constraints register, behind `register`, off by default. | deleted later: Alone on F it delivers 79 hidden funnel facts against 58 at equal decoys (40). |
| D58 | A per-user knowledge graph over every cached item, with graph-walk retrieval and no model, behind `graph` and `graphMerge`, off by default. | deleted by D225 |
| D60 | Anticipation, behind `anticipate`, off by default. | deleted by D227 |
| D89 | The request-time bridging query, `bridgeQuery` (`bridge.ts`, `PartnerDeps.bridge`: a `QueryBridge` with its own `BridgeMaker`, model and… | deleted by D112 |
| D102 | `slowPathQueue`: a request that reaches the slow path while the session's slow path is busy is kept in a one-slot per-session queue (the… | deleted by D228 |
| D107 | The knowledge graph (D58) costs less to hold and to build, with the same results. | deleted by D225: hidden +0 |
| D121 | Four switches that never helped are deleted with their code and tests. |  |
| D136 | part of: a byte-capped cache and statement dropping are rejected |  |
| D137 | part of: a keyword-output trial (`intentTerse`) is not run |  |
| D141 | part of: deleting the graph's code is rejected |  |
| D177 | Trial D170 (`intentConstraintOnly`) ends without promotion: the switch, its `constrain()` path, the `intentSkipped` stat and their tests… | hidden -1.30 points (95% CI -4.17..+1.56) |
| D196 | Retiring rule paths (trial `rulesOff`) is rejected and deleted | hidden −2.3 (−6.6..+2.0) |
| D216 | Rejected: ingest off the event loop. | hidden +0 |
| D225 | The knowledge graph (`graph`, `graphMerge` and every `graph*` setting; D58, D107) is deleted with its code and tests |  |
| D227 | Anticipation (`anticipate`, `anticipateCalls`, `anticipateSessionCalls`, `anticipateOff`; D60) is deleted with its code and tests |  |
| D228 | `slowPathQueue` (D102) is deleted with its code and tests |  |
| D233 | Rejected: read at ingest, not per request. |  |
| D238 | part of: trimming it by what cannot bind is rejected | hidden −6.7 points |
| D308 | `senderDomains` (a compacted From line keeping its address's domain) measured and deleted with its code and tests |  |
| D335 | Rejected and deleted: a search-like `ask_context` question. | hidden +5.6 points (n.s.) |
| D507 | Rejected at $0 and deleted: reusing a search's answer across a user's day |  |
| D515 | Trial `takeSettleMs`, opened and closed 2026-11-10: not promoted, deleted. | hidden +1.4 points (−4.2..+6.9) |
| D705 | `candidatesSpecifics` is rejected and deleted with its code and tests | hidden facts +2.0 points (+0.2..+3.7) |
