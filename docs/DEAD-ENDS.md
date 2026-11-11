# Dead ends

Generated from [DECISIONS.md](DECISIONS.md) by `bun run decisions:index` (scripts/decision-index.ts, D812). Do not
edit: change DECISIONS.md and regenerate. **Read this before proposing an idea**: it may have been tried, measured
and killed already.

Each line is one idea: a decision whose status in [DECISION-INDEX.md](DECISION-INDEX.md) is `rejected` or
`superseded` by a deletion ("killed by Dn": the row that deleted it, which has no line of its own), or the rejected
or deleted part of an adopted decision or a finding (marked "part of"). The last column says why it ended when the
text says so briefly; a bare gain ("measured hidden +x") means it died for another reason, so read the row. Topics
come from a keyword map, so an idea can sit under a neighbouring topic: search the page for its switch name.

## Push and candidates

| # | What was tried | Why it ended |
|---|---|---|
| D70 | One-turn packets are rejected: the proactive packet does not carry the no-model gate's held-back candidates or a coverage line (the… | hidden +0.000 (−0.049..+0.050) |
| D73 | `askVerdicts`, off by default: an ask gathers what a lookup gathers (the consequence probe's finds, the graph walk, the card finds) and… | killed by D226: Paid replay (as D225): minus-askVerdicts 312/128 against 314/132 (−2 hidden, −4 decoys), pool 282/249, the… |
| D81 | `supersede`, off by default: candidates are grouped by matter (subject without "Re:"/"Fwd:" per source, or a title identifier), ordered by… | killed by D112: no measurement favoured them on |
| D82 | `askRank` (with `askRankMargin` 5), off by default: an ask's pool (the verdict hits, the grounded items, the lexically likely) is ordered… | killed by D112: no measurement favoured them on |
| D116 | Rejected: An explicit ask does not reuse the push's verdict. | Paid, Haiku 5.5, both arms on one cache: reader calls 1,171 → 1,079, hidden surfaced 279 → 277, decoys 130 →… |
| D129 | `readerPushQuestions` (push-read every user message, past `readerGate`) is not reopened as a trial | A new trial needs evidence D99's NEW2 run did not have (a question-form train suite, or a reader cheap… |
| D147 | The reader is not streamed to settle the push early, and a local distilled reader is not built |  |
| D156 | part of: `lat-speculative-first-call` (start the agent's first model call speculatively and keep it only if Eden's push stays silent) is… | Under the 1.5x bar, and it adds tenant paid cost |
| D166 | Moving the push reading off the agent's start is not built |  |
| D191 | Rejected: no blocking `observe` wait when the push's pool is weak. | $0 screen identical (replayed readings take no time). |
| D246 | The push's "nothing found" note (`pushChecked`, CL4 H8) is a trial switch, off, recommended for the cost-and-latency combine stage | killed by D257: It saved cost and time where the agent would otherwise ask (signals, short: mix −$0.031/1k, −0.053..−0.011… |
| D247 | An ask answering from the push's search (`askFromPush`, CL4 H9) is rejected and deleted |  |
| D248 | Not waiting for the push (speculation on the agent's first model request, CL4 H10) is rejected and deleted |  |
| D249 | Re-reading ahead after the push (`pushVerifyAhead`, CL4) is rejected and deleted | re-reading the push's first-ranked items ahead cut 0.25 s an ask but the agent's question cites other items… |
| D250 | A closing "this is what bears on it" line on the push's packet (`pushCovered`, CL4 H13) is rejected and deleted | hidden +0.000 |
| D258 | Smaller candidate packets by excerpt size (`pushCandidateBytes`), by not repeating an item within a request (`pushCandidateDedup`) or by a… | −10.7 (−18.0..−3.3) against `pushCandidateDedup` alone, and cost more one request at a time (+$0.025/1k on… |
| D259 | part of: `pushCandidates` stays 5: three candidates, and three on a session's later requests only (`pushCandidatesLater`), are rejected | hidden −1.6 |
| D266 | Rejected and deleted: re-ranking the push's candidates with no model. | Pi, Haiku agent and grader (lab, D97), payload notices: the planted item reached the packet more often on… |
| D267 | Rejected and deleted: asks that go past the candidates the agent holds. | hidden −0.7 (−6.9..+6.2) |
| D268 | Rejected and deleted: candidate excerpts that keep the constraint sentence first. | hidden −2.7 (−8.2..+2.7) |
| D273 | Four ways to send fewer packet or ask bytes are rejected at $0; the trial switch `pushCandidatesAnchor` is deleted with its code |  |
| D274 | Rejected: telling the agent the candidates are what an ask would return. | hidden −2.8 points (−9.7..+4.2) |
| D286 | Card tags on the push's candidates (trial `pushCandidateCards`, A6) are rejected and deleted | measured hidden +1.2 points (−4.8..+7.2, n 167); killed for another reason (read the row) |
| D288 | Not built, on $0 evidence: (1) an entity census line ("no item names X"): it is D257's "nothing found" narrowed and fires where the… |  |
| D300 | Answer-ahead (trial `pushAhead`, A9) is rejected and deleted | hidden −1.8 points (−8.4..+4.8, n 167) |
| D330 | Rejected and deleted: two extra push slots for facts that share few words with the request. | A push that handed candidates added up to two items its pool did not hold: the best intent hit holding two… |
| D331 | Not built, on $0 evidence: (1) name-free ("general") intent requests written at ingest beside an item's own ("pay a plumber for a… |  |
| D340 | Trial `pushReshow`: a push candidate the agent took for an earlier request of the session is handed again when it ranks among this… | killed by D380: measured hidden raised +2.7 points (−1.8..+7.3, n 110); killed for another reason (read the row) |
| D360 | Rejected and deleted: trial `linkLine`, a no-model line on each push candidate saying what it shares with the request | hidden raised −1.3 points (−4.5..+1.9, n 531) |
| D472 | Rejected and deleted: `pushCheck`, the checker choosing the push's candidates | With the checker's passes (score ≥ 0.5) as the candidates in pool order and no packet when none passes, the… |
| D492 | Rejected: the distilled checker in the push |  |
| D506 | Trial `pushLazy`, opened and closed 2026-11-10: not promoted, deleted. Finding: the push's background searches buy facts one request a… | hidden −2.3 points |
| D512 | Rejected and deleted: `pushCheckReshow`, a re-show gated by the check. | Over a user's days it lost hidden facts against the check alone: −10.9 points (−22.7..+0.0, n 46, Sonnet)… |
| D526 | Rejected and deleted: the check's question answered when the item is stored, read by a no-model push | Funnel, fit split, 608 a variant: `act` alone 387 → 406 planted handed, 334 → 276 decoys, neutral packets… |
| D529 | Trial `pushCheckGate`, opened and closed 2026-11-10: measured live, not kept, deleted | because the stored answers cost an ingest call for every item (about +$0.06–0.12 per 1,000 tasks at 36 new… |
| D700 | Trial `pushCheckBehind`: the push check runs behind the default's packet | killed by D704: With one more agent turn after the answer for what was queued (`+amend`): hidden +3.9 (+1.4..+6.5), but… |
| D703 | Trial `candidatesSpecifics`: the candidates' lead asks for the item's specifics once it applies | killed by D705: The line raised hidden facts +2.0 points (+0.2..+3.7) on eight seeds (bar: +4.0) for +$0.013 per 1,000… |
| D708 | Trial `pushPointer`: the candidates' lead names the items of this request's candidates that the agent was handed for an earlier request | killed by D711: Against the default: hidden −1.2 points (52.4% against 53.6%; −4.8..+2.3) where the rule asked for +4.0 with… |
| D855 | Trial `leadShort`: the candidates' lead and the ask nudge in fewer words, same three instructions | killed by D859: Hidden facts raised −1.4 points (−3.8..+0.9 clustered by template; by seed −2.3..−0.5), below the rule's −3… |

## Reader

| # | What was tried | Why it ended |
|---|---|---|
| D110 | Rejected, lab only: The ask-time reader (D95/D96) is not distilled into a local no-model scorer used as a cascade. | at the pre-registered loss limit it decided 2.5% of calls (train CV 1.03× fewer reader calls), and the one… |
| D115 | Rejected: The reader's pool is not widened with the user's constraint items. | A card-based universe was tried first and found little: 88 of the 129 train tasks whose hidden item missed… |
| D118 | Rejected: The reader's wait stays at the agent's start (D98, D112's 3,000 ms `waitMs`). |  |
| D122 | Rejected: opening `readerGate` for arranged visits. | Pre-registered bar: at most 5 more reader calls (the landlord calls the gate skipped) and no other row of… |
| D126 | part of: re-reading by age and age labels are rejected |  |
| D130 | A broad reader veto over rule-path deliveries is rejected; a veto by name waits for a live reader eval |  |
| D151 | The reader veto by name over rule-path deliveries (D130's remaining item, `quality-reader-veto-rule-path`) is not built |  |
| D152 | Stage 2 of `fresh-checkahead-speculative-rereads` (start re-reads from a streamed reader as it names items) is not built |  |
| D157 | `cost-reader-pool-gate-learned` (a learned gate that skips reader calls that would bind nothing) is closed by D110 and not built | because it cannot tell a planted item from its decoy (AUC 0.544) |
| D164 | Prompt-caching the reader's items across calls is not built |  |
| D167 | Overlapping the ask's reader with its poll and live search is not built; the 2026-11-05 audit's O9 item `lat-ask-reader-overlap-poll` is… |  |
| D168 | The closed-class "action unless it looks like a question" rule for the reader's request gate is rejected; widening the gate comes back as… | because their first verb is not in `LEADING`/`MORE_VERBS` (`probes.ts:24-31`, `:80-86`; `partner.ts:668`… |
| D174 | Ranking an agent-worded ask on its question plus the session's request is not built, and changes to the ask's cue are screened with a paid… | measured hidden +1.6 points; killed for another reason (read the row) |
| D186 | F6 enters as trial `readerVerbGate` (package `action-gate-verbs-trial`): the reader's request gate recognises verbs, as D168 asked | killed later: Recipe 2a replay on the topped-up cache (ledger run `close3-verbgate-topup`, 119 calls, $0.03306): hidden… |
| D190 | Rejected: an evidence gate on the reader's call. | the loosest bar (top 8, coverage 0, matched 1) 642 calls, 308/138 |
| D194 | Rejected: a shorter reader output schema. |  |
| D195 | The reader veto over rule-path deliveries (D151's hold, built as trial `ruleVeto`/`ruleVetoNamed`) is rejected and deleted | hidden −1.6 (−5.6..+2.5) |
| D230 | Noting ask items the reader read and did not flag (trial `askUnflaggedNote`) is rejected and deleted | hidden −0.4 (−3.5..+2.7) |
| D234 | Not built: reader verdict reuse across a user's sessions. |  |
| D235 | Not built: a local yes/no model in place of the reader (CL1 H15, research only; confirms D147). | D147's bar 0.85 |
| D239 | Compact item fences for the reader are rejected |  |
| D241 | A per-user cached item prefix for the reader is not built |  |
| D345 | A complete poll after a change signal does not stand in for re-reading the doubted copies (`verifyByPoll`, A18): built as a trial… |  |
| D346 | An ask does not re-read its likely citations beside its poll and live search (`askVerifyEarly`, A18): built as a trial, measured, deleted. |  |
| D840 | Not kept: re-reading by id the items the agent holds from quiet sources (`heldReread`, P4; weak point 4), built, screened at $0 and deleted. | It costs more per recovered update than D606's poll in every form: a session holds about 11 due copies (up… |

## Cards and intent

| # | What was tried | Why it ended |
|---|---|---|
| D90 | The active-constraints digest, `constraintDigest` (needs `cards`; `digest.ts`, `ContextPartner.digest`, `POST /v1/digest`, client… | killed by D112: no measurement favoured them on |
| D170 | Trial `intentConstraintOnly`: with `intent` on, an item the card prefilter rejects is not sent to the card model for its requests alone | killed by D177: hidden -1.30 points (95% CI -4.17..+1.56) |
| D201 | Rejected: intent requests worded as an agent's user delegates. |  |
| D242 | Rejected: a user's card backlog through Anthropic's Message Batches API. |  |
| D243 | Rejected: fewer intent requests per item. | hidden −3.6 points |
| D318 | Not built, on $0 evidence: intent requests for more item kinds. | `funnel --set` runs `.local/a12/f3-*`; numbers in docs/research/a12-quality.md. |
| D446 | Not promoted: the distilled model's intent requests fail the pre-registered bar. | The bar, committed before the first funnel run, was hidden ≥ 312 and decoys ≤ 273 (and parse ≥ 0.95, flag… |
| D449 | What a distilled card model would need before production (M2, written, not built). |  |
| D480 | Trial `intentPrune` (pruning an item's intent requests by a no-model score against the item) is rejected and deleted | Four rules (`share:x` of the request's terms in the item, `names` the item does not hold, the closest N, the… |
| D523 | Rejected without a paid run: a card-only (distilled) model reading the rest of a new user's backfill | the bar was +10 (D361), written after the screen was read |

## Check

| # | What was tried | Why it ended |
|---|---|---|
| D528 | Rejected and deleted: thinking on I3's short reply, and a check that reads only stored-`act` items |  |

## Sync, sources and scale

| # | What was tried | Why it ended |
|---|---|---|
| D132 | Agent-stream replay in the Pi lab is not built as proposed (replay at `--time-scale 0` until the first differing Eden output) |  |
| D142 | Backfill and sweeps may list big pages, min(`syncBigPageSize`, `Source.listPageMax`), only where the source declares a max; off in the… | killed by D143: A failed big page retries at `syncPageSize` (100) within the sync budget, and that (user, source) asks 100… |
| D146 | part of: a batch tier (Message Batches) or a cheaper endpoint for request-only items is rejected for now | Batching halves token prices, but cache hits inside a batch are best-effort, so the card part gains… |
| D153 | part of: removing it (`r2-anticipate-redundant-under-sync`) is rejected | With the Haiku reader replay the first minus-anticipate run missed 88 of its reader prompts (fail open) and… |
| D213 | Rejected: a per-(user, source) poll window. |  |
| D214 | Rejected: per-source recency caps for synced items. |  |
| D262 | part of: a first page sized to the source's share of the user's cap (`syncBackfillShare`) is rejected and deleted with its code and tests… |  |
| D297 | Trial `syncCarriedSweepMs` (a weekly sweep for sources whose notices carry their changes) opened and deleted the same day: it lets deleted… |  |
| D337 | Not built, on $0 evidence or a $0.06 smoke: (1) the proxy running `ask_context` itself and continuing the model call: the tokens are the… | Pilots `a16-pilot-41`, `a16-pilot2-41`, smokes `a16-smoke-41`, `a16-smoke2-41` ($0.126). |
| D390 | A per-lookup budget for live searches of cut copies at 1,000 sources (`syncCutLive`, trial, A28) was measured and deleted; D264 stands. | Funnel 995, seeds 41/42: calls a task 49.8 → 22.1 and 51.1 → 22.5, hidden 77 → 77 and 76 → 77. |
| D475 | Trial (off): a cold tier for the synced copy (`syncCold`, `syncColdMaxItems` 30,000, `syncColdVerify`). | killed by D495: The owner judged a complete local copy not practical |
| D476 | Trial (off): change feeds (`syncDelta`; `Source.changes`, `ChangePage`, `SourceFanout.changes`). | killed by D495: The owner judged a complete local copy not practical |
| D477 | Not built: a timer that polls every source by its change rate. |  |
| D479 | `syncCold` and `syncDelta` are not promoted; they stay trial switches, off. | because the same runs measured tasks slower by 1.2 s of wall at 5/5/90 (+0.85..+1.58; 2.1 s at 30/30/40) and… |
| D508 | Rejected at $0 and deleted: one search of a source a lookup |  |
| D602 | Not kept: dormant sources (`syncDormantMs`), built, screened at $0 and removed after two reviews. | because nothing can end the trial (D112): the lab's noise connectors never hold a fact and `--days` never… |
| D606 | part of: no fix holds polls level, and `syncOwedPollMs` (built to test it) is deleted | because the item's source was not polled |

## Ask

| # | What was tried | Why it ended |
|---|---|---|
| D43 | `ask` returns the cited items with no model call by default; `askWithModel` (`EDEN_ASK_MODEL=1`) restores the model-composed prose answer. | killed by D112: no measurement favoured them on |
| D74 | `askCompact` (with `askItemBytes` 320, `askFullItems`, `askLineBytes`, `askMaxBytes`), off by default: the answer is compacted as a packet… | killed by D112: no measurement favoured them on |
| D83 | `askContext` ranks an `ask` for its question and for the session's latest user request (the lookup's own cue, kept on the session), fused… | killed by D112: no measurement favoured them on |
| D88 | The guided `ask_context` description is Eden's own (`ASK_CONTEXT_GUIDED` in `@eden/protocol`, exported by the client SDK, read by the… | killed by D112: no measurement favoured them on |
| D125 | part of: ask coalescing is rejected |  |
| D134 | part of: narrowing the ask's own delivery checks is rejected |  |
| D140 | part of: answering an ask from a warm index before its poll is done stays rejected (D65 holds) | because it bounds a wait the config already names (`sourceTimeoutMs` is the lookup's budget), with this… |
| D184 | F10, request-side query expansion (`moonshot-ask-query-expansion-ceiling`), is closed and not built |  |
| D189 | Rejected: request-side query expansion with no model for the ask. |  |
| D231 | Noting ask answers no reading checked (trial `askUnreadNote`) is rejected and deleted | Aimed at D230's finding: an answer with items no reader reading checked (an unread information question, a… |
| D485 | Trial `askMulti`, opened and closed 2026-11-10: not promoted, deleted. | hidden −0.4 points (−2.8..+2.1, n 813) |
| D518 | Trial `askReinvite`, opened and closed 2026-11-10: not promoted, deleted. | Same runs as D517. |

## Delivery and packet

| # | What was tried | Why it ended |
|---|---|---|
| D67 | A found conflict is delivered whatever path spoke first. | killed by D112: no measurement favoured them on |
| D68 | Packets say dates whole. | killed by D112: no measurement favoured them on |
| D197 | Labelling rule-path packets (trial `ruleLabel`: the envelope says the items were matched on shared names, dates or wording, not read) is… | hidden −1.3 (−5.3..+2.8) |
| D341 | Rejected and deleted: re-sending every item a session was sent an "updated:" packet for, in its current version, on a recap- or… |  |
| D401 | Rejected at $0: moving the agent's cache mark off the first request's user turn so a one-call task pays 1x, not 1.25x, for the packet. |  |
| D517 | Rejected: shortening earlier requests' packets in the transcript | hidden −16.0 points (−23.3..−8.1 by day) |

## Lab and eval

| # | What was tried | Why it ended |
|---|---|---|
| D154 | Request replay for the live agent harnesses is not built |  |
| D185 | F25's unordered subset replay (`devloop-retrieval-screen-set-subset-replay`) is not built; D117 stands |  |
| D701 | Lab only: `pi-ab`'s `+amend` condition flag | killed by D704: With one more agent turn after the answer for what was queued (`+amend`): hidden +3.9 (+1.4..+6.5), but… |

## Other

| # | What was tried | Why it ended |
|---|---|---|
| D51 | A per-user standing-constraints register, behind `register`, off by default. | killed later: The sweep breaks the calls bar (8.66 per lookup) |
| D58 | A per-user knowledge graph over every cached item, with graph-walk retrieval and no model, behind `graph` and `graphMerge`, off by default. | killed by D225 |
| D60 | Anticipation, behind `anticipate`, off by default. | killed by D227 |
| D89 | The request-time bridging query, `bridgeQuery` (`bridge.ts`, `PartnerDeps.bridge`: a `QueryBridge` with its own `BridgeMaker`, model and… | killed by D112: no measurement favoured them on |
| D102 | `slowPathQueue`: a request that reaches the slow path while the session's slow path is busy is kept in a one-slot per-session queue (the… | killed by D228: The queued lookups' deliveries were almost all rule paths (hidden 23 → 2, decoys 67 → 4 by rule path), and… |
| D107 | The knowledge graph (D58) costs less to hold and to build, with the same results. | killed by D225: hidden +0 |
| D121 | Four switches that never helped are deleted with their code and tests. |  |
| D136 | part of: a byte-capped cache and statement dropping are rejected |  |
| D137 | part of: a keyword-output trial (`intentTerse`) is not run | But the saving is too small to pay a re-enrichment for: on the committed intent-v2 replay (6,771 items)… |
| D141 | part of: deleting the graph's code is rejected | because no switch exists yet |
| D196 | Retiring rule paths (trial `rulesOff`) is rejected and deleted | hidden −2.3 (−6.6..+2.0) |
| D216 | Rejected: ingest off the event loop. | hidden +0 |
| D233 | Rejected: read at ingest, not per request. | It fails on the same wall: the match back to the request is lexical, and the model judging an item without… |
| D238 | part of: trimming it by what cannot bind is rejected | a 160-character item window (`askReaderItemChars` 240 → 160) costs more |
| D308 | `senderDomains` (a compacted From line keeping its address's domain) measured and deleted with its code and tests |  |
| D335 | Rejected and deleted: a search-like `ask_context` question. | measured hidden +5.6 points (n.s.); killed for another reason (read the row) |
| D507 | Rejected at $0 and deleted: reusing a search's answer across a user's day | A user's searches do not repeat: about one search a task matches an earlier (source, text) of the same user… |
| D515 | Trial `takeSettleMs`, opened and closed 2026-11-10: not promoted, deleted. | measured hidden +1.4 points (−4.2..+6.9); killed for another reason (read the row) |
