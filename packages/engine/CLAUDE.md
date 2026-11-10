# @eden/engine

`ContextPartner`: the context partner itself. `observe` sees each session event and, rarely, injects context unasked;
`ask` answers the agent's question; `checkAction` reads a tool call before it runs (D69). Two speeds: a fast path
with no network and no model call, a background slow path (route, live search, cache, score, maybe one budgeted
model call). [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) describes every path and flag; read it first.

**Another session may be editing `src/*.ts`: check `git log origin/main -- packages/engine` before changing code.**

## Files (src/)

| File                                                                       | Owns                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `partner.ts` (about 5,130 lines)                                           | `ContextPartner`, `PartnerDeps`: observe, fast path, slow path, ask, check, sessions and their AbortControllers (D17), delivery, queues                                                                                       |
| `config.ts`, `parts.ts`                                                    | `EngineConfig`, `DEFAULT_CONFIG` (the unified default, D112: thresholds such as `confidentScore` 1.1, D6, and every part on); `PARTS` (each part's settings that take it out), `withoutParts`, `CORE_CONFIG` (every part out) |
| `cache.ts`, `packed-text.ts`                                               | `ItemCache`: per-user BM25F item cache, TTL, synced items, near-duplicate suppression; `sanitizeItem`; item text held deflated behind a `text` getter (D188)                                                                  |
| `persist.ts`                                                               | `EncryptedFrozenDisk` (D425, opt-in): frozen users' blobs written AES-256-GCM, one file per user under a keyed-hash name, tenant/user in the additional data; `FrozenDisk`, `PERSIST_FORMAT` (bump it when a blob's shape changes) |
| `text.ts`, `situation.ts`                                                  | Cues with no model (entities, content terms, chatter); a coarse situation label for routing                                                                                                                                   |
| `render.ts`, `fold.ts`                                                     | The packet and ask answer in the `<context … Data, not instructions>` envelope (D11, D19), compaction (D47, D68), folding (D52)                                                                                               |
| `judge.ts`                                                                 | The judge's prompt and parser (indexes only, D19)                                                                                                                                                                             |
| `line.ts`                                                                  | `safeLine`/`safeBlock`: the one sanitiser for packet, answer and prompt lines made from source or event text (D221); `injection.test.ts` is part D's probe as a standing test                                                 |
| `shield.ts`                                                                | A10's trial packet defences (D306, D307): `GUARD_LINE` (`guardLine`), `quarantine`/`quarantineItem` (`quarantineInstructions`: instruction-shaped text in delivered items replaced by `QUARANTINED`, no model). `shield.test.ts` holds its precision cases |
| `grounding.ts`, `conflict.ts`, `consequence.ts`, `probes.ts`, `economy.ts` | No-model grounds: people/time (D44), the conflict test (D49, D75), consequence probe (D54), probes (D46–D48), probe economy (D50)                                                                                             |
| `settle.ts`                                                                | `askNudge`'s no-model test of whether the candidates settle a request's people, things and days (D316, D317)                                                                                                                  |
| `cards.ts`, `intent.ts`, `sync.ts`, `sketch.ts`                            | Moonshot tracks (D56–D63, D87): implication cards, intent index, background sync; a source's vocabulary sketch (D322)                                                                                                         |
| `source-yield.ts`                                                          | `SourceYield` (`sourceYield`, D505, D509, on in the default): per (user, source) a run of live reads with nothing used, and per user two pooled rates (reads on no evidence, reads on words alone); the partner's `spentSources` skips live reads by them |
| `reader.ts`                                                                | Ask-time reader (D95, D96): a budgeted model call wired by the embedder                                                                                                                                                       |
| `push-check.ts`                                                            | The push check (`pushCheck`, D500–D504, a trial, off): one budgeted call a push names the pool's items that change the action (`CHECK_SYSTEM`, `parseCheck`, `PushChecker`); `push-check.test.ts`                              |
| `firewall.ts`                                                              | The action firewall's cue and grounds (D69)                                                                                                                                                                                   |
| `parties.ts`                                                               | The party check (`partyCheck`, D375, D376, on in the default): identifiers a call adds and its packets showed; `ItemCache.isCorrespondent` reads the user's header addresses |
| `decide.ts`                                                                | Per-candidate facts for the lab's candidate dump (`onCandidates`)                                                                                                                                                             |
| `ledger.ts`, `usage.ts`                                                    | Not-twice ledger; usage inference for learning (D13, D18)                                                                                                                                                                     |
| `spans.ts`, `trace.ts`                                                     | Span tracing (off by default, content-free, D56); decision traces, `explainTrace` (a sentence per trace, D277); `UsageRecord` for the optional `onUsage` sink (whether the agent used each injection, content-free, D293); `ContextPartner.explain` keeps a session's last `EXPLAIN_TRACES` (32) |
| `gate.ts`                                                                  | Redaction off the event loop through the worker pool (D25, D26)                                                                                                                                                               |

`bench/`: `pipeline.bench.ts` (the end-to-end anchor for performance work), `ingest.bench.ts` (memory per synced
user, ingest µs/item; the scale anchor, docs/TESTING.md), `users.bench.ts` (many users: memory live and frozen, thaw,
D325), `storm.bench.ts` (a cold-start storm with warm users' p99, D328), `index-memory` (the per-user index's heap per
item and per user, put/search latency, D111), `concurrent`, `put`, `churn`, `workload.ts`; `many-sources` (one user,
~1,000 connectors, a session) and `source-days` (the same over whole days with changing sources: listing and card
calls per user per day, D324).

## Invariants (with the decisions)

- **Model last (D4, D5, D45).** No model call and no network call on the fast path. Every model call (judge,
  cards, reader) goes through its own `Budget`, has bounded input, and fails open to the no-model path
  (D41). A new per-event call needs a decision and a cost estimate in docs/COST-MODEL.md.
- **Silence by default; precision over recall (D3, D6).** A change that raises recall by raising false fires needs a
  decision. Check `bun run eval` (falseFireRate 0 on main) and the lab's decoy counts.
- **Isolation (D9, D17).** Cache, ledger, budgets, memos, cards, intent and reader caches are keyed by
  tenant/user, session state by `tenant/user#session`. After any await, check the session is still live: nothing is
  cached, learned, charged or queued for a closed session. A new piece of state gets an isolation test.
- **Redact (D10).** Item text is redacted before it is cached, indexed, rendered or sent to a model
  (`sanitizeForStore`); model output that reaches the agent (the reader's bearing, D95) is redacted and made inert.
- **Untrusted text (D11, D19).** Source and event text are data in every prompt (fenced, labelled), and everything
  delivered is inside the data envelope.
- **Item content stays in memory (D8):** only content-free metadata goes to the source map. The one exception is
  opt-in (D425): `ItemCache.persist(disk)` writes frozen users' blobs encrypted (`persist.ts`); nothing else may write
  item content to disk.
- **One product (D112).** `DEFAULT_CONFIG` is the best measured configuration and what ships. A new behaviour lands
  as a trial switch in `config.ts` (off), with an owner and an end date in DECISIONS.md's trials table; at the end it
  joins the default (and a part in `parts.ts`) or is deleted with its code and tests. A part whose model role is not
  wired (no `cards`, no `reader` dep) is inert: the default runs its no-model path (`default.test.ts`).
- **Unit tests start from the core.** A test of one mechanism builds its partner on `{ ...CORE_CONFIG, ...what it
tests }`, so the other parts do not move its result; the default as a whole is `default.test.ts`, the eval and the
  funnel.

## Test

```bash
bun run test:pkg engine          # 49 files, 8-10 s wall (two runs, shared 4-core box, 2026-11-05); partner and reader lead
bun test ./packages/engine/src/conflict.test.ts      # one file, from the repo root (the preload is read from cwd)
bun run eval                     # the scenario metrics; paste the JSON in the PR when behaviour changes
bun run funnel --jobs 4          # the lab's $0 screen of the default on train (reader stub; docs/LAB.md)
bun packages/engine/bench/pipeline.bench.ts          # performance anchor
```

## Pitfalls

- Tests that need a clock pass one; a test that reads the wall clock breaks near midnight or month ends (one was made
  clock-independent in D58).
- Regressions found in reviews go to `regressions.test.ts`, `review-regressions.test.ts` or the track's own
  `*-review.test.ts`; add to them rather than editing an old expectation.
- `ModelReaderMaker` sends no reasoning field and has no option to send one (D144 made "off" the default, D155
  deleted the option): that is the request every lab quality figure measured. D96's decoy cut came from the prompt
  writing `why` before `binds` (READER_SYSTEM v4/v5), not from provider reasoning. On Haiku 5.5 (Anthropic-direct,
  default pool) effort "low" was 2.38x slower at p50, 1.59x dearer, and 38 of 60 calls ran past `askReaderWaitMs`
  (docs/COST-MODEL.md, `reader-time.ts`). The lab's "low" arms add the effort through a model wrapper
  (`eval-live.ts`), never through the maker. If a wrapped model asks for reasoning, OpenRouter excludes it from the
  reply but bills it as output; `usage.reasoningTokens` (from `completion_tokens_details.reasoning_tokens`, unset when
  not reported) shows that share. The lab's reader replay key treats a `claude-*` reader request with no reasoning as
  the pre-D144 "low" line (`reader-disk.ts`, `keyedReasoning`), so recorded caches still replay; keep that mapping
  when touching the request. Sending reasoning again needs a decision and a decoy measurement, as a trial (D112).
- `Held` (what a tool result or agent message holds, for `alreadyHas`) is two sorted unique typed arrays, searched by
  binary search: a remap (`rebuildVocab`) must sort and dedupe again, since new ids do not keep the old order. Pair
  keys stay exact Float64 (`pairKey`): a hashed key could hold back a delivery on a collision. `held.test.ts` measures
  a session with 12 mail listings of 8 KB (311 KB; 2,096 KB with Sets).
- `readerPushBehind` (on in the default; needs `readerPush`, `syncOnDemand`, `syncPollBehind`): the push's lookup reads the index
  before the poll is done; a poll that stores something gets one more ranking and reading, no new source call, a
  reader cache hit when the pool is unchanged, and its packet replaces one the agent has not taken
  (`push-behind.test.ts`). A packet withdrawn untaken has its ledger entries restored (`Ledger.entry`/`restore`, not
  a bare unmark) and its sketches dropped from `s.delivered`, so what the second reading does not deliver again stays
  deliverable. On in the default (D112). With `syncPollBehind` a lookup's trace leaves out the poll it did not wait for; the
  poll gets its own "skipped" trace (reason "sync poll behind", `sourceCalls` = `syncCalls`) when it settles, even
  after the session closed, so traces sum to what the connectors received. A lookup whose poll waits on a read
  already running (`SourceSync.busy`, which resolves to what that read stored) counts what it stored, not one, and
  `freshen` returns only its own calls. `probeGraceMs` is 0 in the default (D112): a lookup no longer waits for its
  probes (D47's grace), so a slow probe's finds only reach later turns.
- `syncPush` (D125) polls on a notice only for sources whose `notifies` is true. Any wrapper around a `Source`
  (tracing, timing, a lease) must copy `notifies` as it copies `listsByTime`, or notifications are silently ignored
  and the source is polled on its learned rate. Every notice (and every `sourceItems` call with items of that source)
  still drops the source's held search pages, notifying or not (D148): a search-only notifying source has no sync
  state, and its held page would answer with the old copy. `sourceNotice` gives the reason a notice did not act
  ("push-off", "not-synced", "not-notifying"; no I/O, so an unknown id is "not-synced"). `sourceItems` redacts before
  storing (D10); `ingest` stores only items of that source.
- **The enricher's drain timing is part of the default's behaviour.** In the funnel cards drain while tasks run, so a
  change that adds an `await` or an async helper to `CardEnricher.drain`'s live path moves which items land before
  which request (CL3 measured 822 calls becoming 732 and 86 reader replay misses from one extra async hop). Re-run the
  default funnel after touching it (since D244: `cards use` 504 calls; recipe 2a, now `--preset minus-candidates`
  since D237, 643 replayed, 0 misses). D242's
  bulk round (Message Batches) and D243's request cap were deleted; their code is in commit 4e072585.
- `ModelCardMaker` sends no reasoning field and has no option to send one (D149 made "off" the default, amending
  D59; D155 deleted the option): the request every lab card and intent figure measured (all 5,158 `eden.cards` ledger
  rows ran with thinking off). Effort "low" was 1.82x slower at p50 and 1.54x dearer on Haiku 5.5 (docs/COST-MODEL.md,
  run `close-cards-reasoning`). Sending it again needs a decision, as for the reader. The judge (`partner.ts`, lab-only:
  the servers wire none) still sends "low"; changing that needs a judge measurement (D155).
- **The card queue is read best first (`cardsOrder`, D482, D483, on in the default; `orderQueue`).** Constraint-worded
  items first, then events ahead, senders the user writes to and the last three days. The read order depends on what
  has arrived when a batch is taken, so nothing downstream may depend on it: equal-score intent hits are ordered by
  `Queued.seq` (arrival), not by when their card was made (`IntentIndex.set`, 16 past the cut). A new structure filled
  as cards land must not break ties by insertion order, or the funnel's output varies with machine load
  (`funnel-flags.test.ts`'s sharded-files test caught it). Pruning an item's requests by word overlap with the item
  was measured and deleted (D480, D481): the requests that look least like their item reach the hidden facts.
- **A user's card calls run in up to four lanes (`cardsLanes`, D521, D522, 4 in the default; `drainLanes`).** A lane
  starts another only when it has taken a batch and a full batch still waits, so steady-state trickles stay on one
  lane with the batches they had. One lane (`cardsLanes: 1`, part `cards`) is `drain` itself with no wrapper: keep it
  so, or the single-lane timing moves. The lanes take from the queue synchronously and share `UserCards.flying` (the
  sentence keys in flight): a new await between taking a batch and the maker call would let two lanes send the same
  sentence. Re-run the default funnel after touching it (314 / 274, card calls 382–392 by load).
- `cardsLean` (D125; window `cardsLeanDays` 7 since D244, 30 before) only narrows what the intent index reads
  (`readForIntent`): constraint-worded items are carded whatever their sender or age. `automated` reads a `From:` line
  in the text or a `meta.from`/`meta.sender` field (connectors differ: `toItems` keeps whatever text the tool
  returned) and bulk footers; a connector giving neither is judged on its footers alone.
- **Deliveries go through `deliverChecked` (D126)** in every async path, so `verifyDelivery` can re-read copies a signal put in doubt;
  only the fast path calls `deliver` directly, and it hands a doubted item (`doubted`) to the slow path instead. The
  reader's push runs `verifyItems` itself, re-checks that no newer user message came during the re-reads, then calls
  `deliver`: a packet marked delivered and not queued would be lost. A re-read started ahead (`checkAhead`) makes the
  cached copy current, so `verifyItems` also applies a session's recent re-reads, not only doubted items. A new
  delivery path uses `deliverChecked`, never `deliver`, or it can send a stale copy. `deliverChecked` itself calls
  `deliver` (a bulk rename of `return this.deliver(` once made it call itself forever: the tests hung, not failed).
- **`revisionNotice` (D205) notes copies in `handOut`, from what the text rendered** (`renderedCount`, as `noteShown`
  reads lines): an item the size cut left out was not shown and gets no update. Stores that announce a changed copy call
  `queueRevised`: the sync's `onStored` and `recheck`, for every watching session, the re-reading one too (its delivery
  may cut or fold the item). A packet queued untaken when its item is revised is checked at hand-out (`watchCopies`,
  D232): a copy the cache has since replaced is followed by an update; a withdrawn packet announces nothing;
  `takePending` orders its batch by which copy is current (`currentLast`), so the last word on an item is current. A
  queued update is dropped only when a handed packet renders the same version (`watchCopies`, `withoutCoveredUpdates`);
  never by citation alone (an ask's removal of covered packets skips updates). A live search page's store (`store`) does
  not announce yet: a handed item a lookup's search finds changed is delivered only if it ranks. Do not filter doubted
  copies in `queueRevised`: a later signal during the poll would leave the stored copy unannounced forever
  (`revision-notice.test.ts`). `pollRevised` is the only I/O a notice starts; keep it off the observe path.
- **An ask says "Nothing in the connected sources." only when its sources answered (D127).** `searchLive` returns
  each chosen source's status (`sources`: the fan-out's, or "local" for a synced source answered from the index);
  `honestAnswer` names any that did not answer (error, timeout, circuit open, busy, limited, throttled: the
  connector's own 429, worded "rate-limited", D212) and says the empty answer is not an all-clear, and
  `AskResponse.sources` carries the statuses. A new lookup path an ask answers from must return statuses too, or an
  outage reads as "nothing". A failed on-demand sync poll (`freshen`) feeds the status
  through `localOf`, not a status of its own: it leaves the copy not current, so the source is searched live and that
  search's status stands. With `askBehind` off an ask never passes `behind`, so a warm-but-stale copy is not "local"
  there (`review-regressions.test.ts`). With it on (D431, the default) the ask's lookup is `behind`, and
  `behindStatuses` rewrites every copy it answered before it was whole or current (`SearchedLive.behindLocal`): its
  live search's outcome, "local" once its poll made it current, "searching" while the work runs, and "error" (a cut
  copy never searched: "timeout") once the work is done and the copy is still not current, so a failed poll is
  never an all-clear (the 2026-11-05 audit's case, both waits tested). A session that ends before the
  search runs returns `closed`, and the answer says so rather than "nothing". Probes are extra queries
  beside a chosen source's own search, whose outcome gives the source's status.
- **An ask cites no doubted copy that no re-read confirmed (D211).** The ask's `verifyItems` runs `strict`: a doubted
  item whose re-read failed with a plain error ("flaked") is read once more, and one still not confirmed is left out and
  named in the answer ("Left out items from mail (1): their source reported changes and they could not be re-checked"),
  never an all-clear. A re-read our own guard skipped ("skipped": the per-source concurrency limit while the other re-
  reads hold its slots) is retried too, two at a time, and cited as held if still skipped. A refusal by an open breaker
  or by a rate limit the connector's 429 pushed back is "failed", not "skipped" (`FetchFailed.guard`, `pushedBack`,
  D232): the item is left out and named. The rate limit's ordinary spend stays "skipped". "unverifiable" (no fetch tool,
  or a null from a source without `fetchReportsGone`) is cited as held, as D126 delivers it. Proactive deliveries keep
  D126's rule (a failed re-read is delivered as held). A null "unverifiable" outcome is held per user
  (`ContextPartner.unverifiable`, the read mark the re-read began under) and `doubted` is false for the item until
  the source's next signal or `UNVERIFIABLE_HOLD_MS` (10 min) (D298): before, every delivery past `CHECK_REUSE_MS` and
  every other session re-fetched an MCP item for the same held answer. Only `why: "null"` is held: an MCP error
  result (`why: "error-result"`) may pass, so holding it would pin a changed item's old copy. `forget` drops it; a
  failed, flaked or skipped re-read is never held.
- **Shown means handed out.** With `askDedup`, what an injection showed is noted (`noteShown`) in `handOut`, which
  every path that gives the agent an injection calls (observe's reply, `takePending`, the firewall's finding, the
  ask's own answer), not when `deliver` builds it: a queued packet the agent has not taken was shown nothing, so an
  ask before `takePending` says its items in full. The ask then drops from `s.pending` a packet whose every item it
  cited; one cited in part stays queued (`review-regressions.test.ts`).
- The reader's request gate (the push in `observe`, `readAsk`'s "acts") is `isImperative(raw, MORE_VERBS)`. D168's
  verb-recognising widening (a trial switch with wider verbs and a chat-reply blocklist) was measured and deleted on
  2026-11-06 (+17% reader calls, hidden 311 to 310, decoys 137 to 121; the code is in commit 3fa94529f): widening it
  again needs a decision that accepts the extra calls.
- `confident()` is one loop that stops at the cap, cheap tests first; every test in it must judge one item alone (no
  state across items), or stopping early would change its output.
- **A re-read never revives a held-gone id (D126).** `recheck` checks `ItemCache.isHeldGone` after its fetch and
  before `revive`/`store`: a `sourceRemoved` can land while the fetch is on the wire, and reviving would lift the
  hold and deliver the deleted item. Any new path that stores a re-read or pushed copy must not `revive` an id a
  removal holds unless that copy is itself newer than the removal. `sourceItems` is newer only than a removal that
  was held before it began: one that lands during its redaction await wins, so it snapshots each id's
  `ItemCache.heldGoneSeq` before the await and drops any whose sequence changed after it (D160, D176). A sequence, not
  `isHeldGone` (a second removal of an id already held leaves that true) nor the hold's end (two removals in one
  millisecond give the same end); every hold, a re-hold included, takes a new number. `sync.mark()` cannot tell
  either: removals never bump it.
- **`checkAhead` is off in the default (D192, `readerVerifyAfter`)**: re-reads start only for what a delivery cites,
  after the reader named it (Pi: 1.6-2.6 fewer fetches a task). With the switch off it runs only once the reader will
  be called (D134), after `readAsk`'s empty-pool and `readerGate` returns, and never for an ask that reuses the push.
- **`readerReuse` (D193, on in the default):** an ask in the push's request reads `Session.pushRead` (the push's
  request text, its pool's content hashes, its verdict) with no call; it must match the push's own request (`main`),
  or an ask that acts on its own would get the push's verdict on another request (`reader-s1.test.ts`); and an item
  the push flagged must still have the content it read, or the ask reads anew (`freshness-push.test.ts`). The fix-S1
  trials that failed (D190 evidence gate, D191 no wait on a weak pool, D194 short schema) are deleted: rebuilding one
  needs a new decision.
- **The reader's reply stops early (D240, `readerStopEarly`, on in the default).** `ModelReaderMaker` sends
  `READER_STOP` (`"same":false`) as a stop sequence; a stopped reply is closed by `closeStopped` (the entry being
  written reads as rejected) only when it does not parse on its own. Rejections after the first look-alike are lost by
  design, so `askReaderDrop` keeps those items in ask answers (funnel decoys listed rise; live false concerns did
  not, docs/research/cl-cl2.md). A stopped reading is another verdict: `readerKey` adds "stop" when on. A smaller pool
  (`askReaderPool` 10), a 160-character item window, compact item fences, trimming the pool by `constraintLike` or by
  the card pass's `none` mark, and a per-user cached item prefix were measured and not taken (D238, D239, D241): the
  trims drop planted items (lean carding leaves most of them uncarded).
- **No "nothing found" note after the push (D257).** `pushChecked` (D246) told the agent when the push's reading
  flagged nothing; it saved an ask and a model turn, but the agent then skipped the `ask_context` that finds what the
  push missed (hidden −5.1 points pooled, −9.1..−1.2, about −1.9 of it the note's own; CL7), so it was deleted. CL4's
  other path levers (speculation D248, re-reading ahead D249, `askFromPush` D247, a packet closing line D250) were
  measured and deleted too: an ask's time is its strict re-reads (D211) under signal-only notices, not its search or
  its reader.
- **`pushCandidates` (D236, D237: 5 in the default) skips `readAsk` on the push and on every ask:** no reader call,
  so no `pushRead` (D193 has nothing to reuse), no `onReader` report and no `checkAhead`. The push's candidates go
  through `verifyItems` and `deliver` (reason `candidates:`), framed by `CANDIDATES_LEAD`, with no "nothing found"
  note when there are none (D257). A `readerPushBehind` second pass replaces an untaken first packet only with
  candidates of its own. It does not need the reader dependency (D276): with no reader wired (a no-key server) the
  push still runs when `pushCandidates` > 0; only the reader's own push (`pushCandidates: 0`) needs one. Tests
  of the reader's own wiring set `pushCandidates: 0` (the core, the `reader` and `candidates` parts all do); the lab's
  reader screens run `--preset minus-candidates`.
- **`planConflict` (D301, on in the default, part `plans`) is checked at the take, not at the store.** The sync's
  `onStored` only records the ids per session with acting requests (`queuePlanConflicts`); `takePending` and an
  observe that starts no push run `checkPlans`, so a new item's card (made in the background as it was stored) can
  count; at the store it has none yet. The rule is
  `candidatesOf`'s (first `pushCandidates` of the ranked pool, a constraint-like pool), not "the item itself is a
  constraint": most planted facts carry no constraint card or wording. Built from the cached copy (the source just
  gave it) with `deliver`, not `deliverChecked`: a copy a change signal has put in doubt (`doubted`) is not sent but
  kept waiting for a later take, and `planSent` keeps each item to one plan packet a session, past the ledger's
  cooldown. The lead quotes the user's own request (redacted, one line, double quotes made single, D301). Answer-ahead (records about the request's names and day in the push, A9)
  was measured and deleted (D300): it cut asks only on the quarter of requests it reached and moved no mix figure.
- **The candidates nudge an ask when they do not settle the request (`askNudge`, D316, D317: on in the default;
  `settle.ts`).** When no handed candidate holds one of the request's entities and (if it names a day) one of its
  days, the lead adds `ASK_NUDGE`, and `Session.nudged` keeps the push pool's ids past the handed ones for that
  request (`internal.request`): an ask before the next user message puts those that hold an anchor (current cached
  copies) in at most half its `maxItems` seats and never its own first, so it never cites more than `maxItems`; a
  settled packet later in the request clears it. Entities match on letter boundaries (`namesEntity`). The nudge asks,
  never discourages (D257's lesson): hidden +9.2 points Sonnet-graded, the gain all through the agent's asks (A12,
  docs/research/a12-quality.md). A wording that tells the agent the candidates are wrong ("none of them matches") was
  not measured: it risks the agent dropping a planted fact already in the packet (it is there in 322 of 422 nudged (A12's screen)
  hidden tasks at $0). Its unit tests are `ask-nudge.test.ts`. **Narrowed by `askNudgeDeep` (D460, D461, on in the
  default):** the nudge fires only when the push pool past the handed candidates holds a non-bulk item that names one
  of the request's anchors (`anchoredPast`), what the deeper look would list; otherwise the packet is framed as
  settled and `Session.nudged` cleared. At $0 (M5's screen) the fact was already handed in 322 of 421 nudged hidden tasks; on Pi it
  cut asks 0.062 a task with targeted hidden +2.1 (docs/research/m5-nudge-narrow.md). Measure any change to the
  trigger live: the funnel always asks, so it cannot see it (+0 −0).
- **The candidates' packet is not smaller (D258, D259; docs/research/cl-cl8.md).** 200-byte excerpts lost hidden facts
  (−12.8 points, with the no-repeat switch on: shorter excerpts keep the items but not the fact), k 3 saved only over a
  user's days and made the agent ask more one request at a time, k 3 after a session's first request lost hidden facts,
  and removing an item repeated within a request (the push and the rule paths race on the ledger) saved nothing. A
  smaller push makes a longer ask answer (`askDedup` says in full what a packet showed in part). On Pi, Eden's billed
  cost above the agent alone was prompt-cache writes on a fixed prefix too short to cache (D260; proven by D271: ~500
  tokens on the wire, under Haiku 5.5's 512 minimum). With an agent prompt that caches in every arm (`--tenant-prompt`),
  the gap is the packet's own tokens written to the cache (+$0.047/1k short, +$0.050/1k over days on the merged tree, Eden 0.65–0.95 s faster;
  cheaper than the agent alone on every per-call connector plan), and
  no lexical cut of packet or ask bytes keeps the planted facts (D273).
- **A settled request gets fewer candidates (`pushCandidatesSettled` 2, D400, D404; part `fewer`).** Only when the
  request names an anchor and the handed candidates settle it (`settles`); the first one that settles it is always
  kept. The packet's bytes are what the agent's prompt cache is written with (D403); the cut moves 11 funnel hidden
  items from the packet to the ask, so measure any change to it live (`eden~V` on Pi), not on the funnel alone.
- **The candidates' order, a longer ask and constraint-first excerpts were measured and deleted (D266–D268, A2;
  docs/research/a2-quality.md; code in commit d096b7ba).** A no-model re-rank (one item per title, the request's date
  lifted) put the planted item in the packet more often (+11 of 384 at $0, +9 of 182 live) and raised no more facts
  live (−0.6 points, −4.6..+3.4); an ask past held items cost +$0.021/1k for no gain. Each push pass reports its pool,
  constraint test and handed ids to the lab hook `onPushPool` (ids and flags only, D269), not to `onReader`, whose
  consumers count reader readings.
- **No re-show of a candidate across requests (D340 deleted by D380).** A candidate the agent took for an earlier
  request stays behind the not-twice ledger (D13) at its own request: a fresh paired run did not show the re-show
  better (docs/research/a26-reshow.md). Measure any revival on `pi-ab --days`, never the funnel (one request a session).
  N2's re-show gated by the push check (`pushCheckReshow`, D512) was measured on `pi-ab --days` and deleted too
  (hidden −10.9 points against the check alone; code in commit 69ce1942 and, on I3's check, 00e20972).
- **`pushWiden` (N2, D511, a trial, off; docs/research/n2-recall.md).** With `pushCheck`, `widenPool` adds items past
  the lexical pool (the `widen` dependency's, raw intent hits, deeper ranks) to what the check reads, within its 20
  items, only where the check runs. They are handed only when the check names them; the nudge's deeper look,
  `anchoredPast` and the returned pool stay the lexical pool's, so an unnamed widened item never reaches an ask. Every
  route fails open to no widening.
- **Updates name the times they drop (D342, `revisionDiff`).** `buildUpdate`'s title reads `Ledger.seenTimes`; times
  are noted only when a copy is handed out (`watchCopies`, from `copiesOf`'s `times`), never when an update is queued
  (one superseded in the queue was never shown). `timesOf` compares one written form ("HH:MM", "<day> <mon>"), so a
  reworded time is the same time; a new form it reads must normalise too, or an unchanged time is called gone.
- **Framing an ask answer does not move false concerns (D230, D231).** A note on items the reader read and did not
  flag, and a closing line on answers no reading checked, were measured live and deleted: the agent reads the caveat
  and still states the item. Every listed-only false concern came from an information ask `readAsk` does not read
  (docs/research/fix-w2b-false-concerns.md); a fix belongs upstream (the reader's judgement, or what it reads).
- **One deadline per lookup (D140).** `searchLive` takes `deadlineAt` once, after resolving the sources and before
  the on-demand poll; the poll's signal, the live search's `timeoutMs`, the planner and the probes
  (`ProbeOpts.deadlineAt`) get only what is left. Do not give a later stage a fresh `sourceTimeoutMs`: with
  `askBehind` off (D430) an ask waits for its poll, so the stages add up. Under `MIN_SEARCH_MS` (50) left, the search is skipped with no call (no rate
  token or breaker failure for a call that could not answer): a source whose page for the query the fan-out holds
  answers from it (`SourceFanout.held`: "cached", or "stale" past `freshMs`), any other is a "timeout" (D148). `held`
  shares `one()`'s key (`pageKey`); a peek with its own key would silently miss. `Sync.freshen` skips a source
  whose on-demand poll gave up within `demandTimeoutMs` (= `sourceTimeoutMs`), so the next lookup searches it live
  instead of waiting on the same listing.
- **Ref notices (D347, `sourceRefs`).** A notice naming the refs that changed doubts only those items: `refreshing`
  (by user and item, with the read mark at the notice) holds each background read until it lands, `doubted` reads it,
  and `check` returns it (raced against `verifyTimeoutMs`) instead of a second call, unless a signal came after the
  notice. The read is stored through `Sync.ingest` under the read mark its call began with (D133), after the same
  removal check as `sourceItems` (`heldGoneSeq`, D160/D176), with the gated ref (never the raw one, D10), and noted in
  the user's live sessions' `checks` (`noteRefReads`, changed copies only), so a pool built before it applies it. The first ref not read
  raises `sourceNotice`'s plain signal before its item's doubt is lifted; reads stop when the user is no longer synced
  (`Sync.notifying`). A new delivery path must keep going through `check`/`verifyItems`, or a named item's old copy
  goes out.
- **Two ways to make the signal path faster were measured and deleted (A18, docs/research/a18-latency.md).** A complete
  poll after a signal standing in for re-reads (`verifyByPoll`, D345) delivered stale copies (5 → 12 of 101 updates):
  listings are not reliably newest-modified first (a calendar lists future events first, a chat edit keeps its time),
  so a poll can stop before a changed item. Re-reading an ask's likely citations beside its poll (`askVerifyEarly`,
  D346) cut the ask's p99 by about a second but read items the answer then left out (+0.06–0.09 connector calls a
  task). Under signal-only notices the agent's wait is the re-read itself (D126, D211), bounded by `verifyTimeoutMs`.
- `fetchChecked`'s `gone` needs `Source.fetchReportsGone`: an MCP tool's null fetch proves nothing, so verification
  never deletes an MCP item on its own; deletions there come from `sourceRemoved` or the sweep.
- **Cached items' `text` is a getter over deflated bytes (D188).** A stored copy is not the object `put` was given;
  spreads and `JSON` see the text, but a memo that keeps `item.text` keeps a decoded copy. Decode Latin-1 bytes with
  `latin1`, never `TextDecoder`: its output for an accented letter is a two-byte string, and every regex over it ran
  1.17x slower (`pipeline.bench.ts`). Text a new path reads in a loop should be read once into a local.
- **Ingest off the event loop was built and rejected (D216).** A worker that redacted each source page and read it for
  the cache (terms with hash lanes, graph reading, mentions, deflated text; the cache applying the reading with the
  same stored state) cut a synced item's main-thread cost 3.5x and the concurrent bench's cold-start stall from about
  1.2 s to 0.1-0.2 s, but one process's capacity inside a 100 ms p99 rose only 1.46x there and fell 3-15% on
  router-sim realistic, for 1.19x the CPU per item. The code is in commit b217ae1d (`ingest.ts`, `prepared.ts`,
  `ingest.test.ts`); building it again needs a decision that accepts those numbers.
- **Many sources (D261–D265, docs/research/a1-scale.md).** The lab's worlds have five sources and fit the sync cap, so
  the funnel cannot see a user with hundreds: screen such changes with `-- --noise-sources 995 --limit 16` (and
  `--jobs 2`: the pre-D263 default needed ~4.5 GB a process) and `bench/many-sources.bench.ts`. A synced copy the
  user's cap cut answers nothing for its source (`Sync.complete`, `syncLocalComplete`): any new path that answers from
  the local index must go through `localOf`, or it misses what is older than the cut. Routing over many sources needs
  evidence (mentions, `routeLocalHits`): with a flat prior it is a lottery. Over `syncPollWidth`, `searchLive` routes
  once, before the poll, and searches the head of that ranking: a second route would draw apart, and an ask must
  never answer a stale copy it did not poll (D127, D263's review). Per-(user, source) state is multiplied by
  the source count: keep it lazy (the fan-out's histograms were 8 KB a pair before D261).
- **Used sources (D320–D323, docs/research/a13-scale.md).** `Sync.engage` marks a source used when a lookup routes to
  it on evidence of its items (`entityHits`, or `routeLocalHits`), never on the prior's draw or a sketch match alone
  (counted, sketch matches doubled card calls for no hidden fact), the 64 most recent a user. Used sources drive two things: their cut copies are
  read whole again and kept first by the trim, up to half the cap in all (`syncEngagedDeep`; unbounded, two used
  mailboxes filled the cap and stopped every other source's stores), and, past 32 sources, only their items (and items
  naming a name the user's requests named) reach the card model (`cardsSourceAware`; `CardEnricher.enqueue`'s
  `defer`). A new path that stores synced items must pass `cardDefer`, or a 1,000-source user's cards go back to every
  item. `syncKeepCut` filters only background stores: a lookup's on-demand poll still stores past the cut (filtering it
  lost 2 of 96 hidden facts: what it stores is routing evidence), and the trim waits for 1.5x the cap (trimming the
  backfill's overshoot back to the cap also lost 2). The sketch (`sketch.ts`) is per (user, source) in `SourceSync`,
  filled from every listed item in `store`, folded at `warmUp`.
- **Which sources are read live is learned (`sourceYield`, D505, D509, on in the default; `source-yield.ts`,
  docs/research/n1-calls.md).** `spentSources` gives a lookup the warm copies it reads nothing live of: no search
  behind, no probe (they join the probes' `local` set) and, for a cut copy, no on-demand poll. A read is booked in
  `noteLiveRead` from outcomes, "ok" only, once a source a turn (`Session.liveReads`), for warm copies only: booked
  when sent, one call counted twice (the push and the ask it starts join it) and an outage read as "nothing used".
  A new path that makes live reads must book them there, or its sources never earn or lose anything; a new path
  that hands the agent an injection must go through `handOut`, which ends the sources' runs. A whole copy keeps its
  poll (dropped, an ask called it failed). An ask's status for a cut copy it did not search is "unsearched"
  (`UNSEARCHED`; `reachAnswer` names it apart from failures, never an all-clear, D127). The pools count only sources
  with nothing used yet: counting the user's own mail's reads kept the words pool alive and noise sources read
  (57 → 40 calls a request instead of 13). A read for a request that names an entity the source mentioned is never
  skipped: a cap on those lost recall where sources are few. With five sources nothing is booked (no copy is cut),
  so the usual funnel cannot see this: screen with `-- --noise-sources 995 --limit 16 --notify-share 0.05` and
  `days-calls.ts --noise-sources 995` (it learns over a user's days). Deleted beside it: a push that searches
  nothing live (`pushLazy`, D506: stale deliveries 15 → 19, hidden −2.3 points one request a session), a longer
  reuse window for search pages (D507: a user's searches do not repeat) and one search of a source a lookup (D508:
  the probes' budget goes elsewhere).
- **A budget for live searches of cut copies was measured and deleted (D390, D391, docs/research/a28-scale.md).**
  Searching live only the 4 cut copies with the most routing evidence halved Eden's calls at 1,000 sources live, but
  left its path time unchanged (one live search of a cut copy that matters costs a connector's latency) and hidden
  50 → 46 of 72; the code is in commit def8c153. A fixed evidence threshold lost a planted fact behind a world source
  whose only evidence was its sketch. A lever for path time must take every live search off the push.
- **The push never waits on a cut copy's live search (`pushCutBehind`, D405, D406, docs/research/b1-scale-path.md).**
  On a `behind` lookup a cut copy answers from the index and `searchCutBehind` sends D264's search behind it, through
  the planner (the raw query alone missed a planted fact), joining `cue.polled` so `afterPoll`/`pushAgain` run on what
  it stored; a follow-up searches nothing again, the probes keep D264. A new consumer of a `behind` lookup's `sources`
  must not read its "local" status as a whole copy (the explicit ask rewrites them, `behindStatuses`). Its calls get
  their own trace ("cut search behind").
- **The ask never waits on its poll or a cut copy's live search either (`askBehind`, D430, D431,
  docs/research/c4-ask-path.md).** The explicit ask runs its lookup `behind` and waits `askBehindWaitMs` (0) for
  `cue.polled`; for an ask, `searchCutBehind` searches source by source (`cue.cutStatus`) and stores each page before
  noting its outcome, so a source called answered was ranked on what it found. Not settled: the answer names the
  sources still being read ("searching", `reachAnswer`'s "Still reading …") and `askLater` re-ranks once the work
  stored something (`internal.late`: no second search, no `readAsk`), queuing what it would cite from the sources
  still being read (`behindLocal`) that the answer did not and the ledger still holds fresh, re-read strictly (D211:
  an item the answer left out as not re-checked is never handed over as news), as an `ask-behind:` packet
  (`ASK_LATE_LEAD`), dropped after the next user message. A cut copy no search was sent for is "timeout" at once. Do not reintroduce a wait: at market latency the work never settled within 300 ms (the wait was the
  ask's whole time), and in Pi no follow-up was ever taken (the agent's next model request starts as the tool result
  lands); the ask finds what the push missed from what the push's own searches behind stored.
- **Three levers for late packets and long days were measured and deleted (N3, D515, D517, D518;
  docs/research/n3-long.md; code in commit e1f9b213).** A bounded wait for a session's work behind before the take
  that follows a tool result (`takeSettleMs`) did hand over the ask's follow-up (0 → 14 packets in 216 tasks at 1,000
  sources) but none held the planted fact and the agent waited +746 ms a task. Shortening earlier requests' packets in
  the transcript lost the facts later requests take from them (raised from an earlier packet 16 of 32 → 2 of 33): the
  ledger hands an item once a session, so its packet is the only place it stands. A re-invitation to ask from a
  session's fifth request on (`askReinvite`) was ignored (16 asks against 12 of 568 requests). Plan alerts were
  re-measured on eight users and stand (D516: +26.9 points of late facts raised, 60% still not raised).
- **Idle users are frozen (D325, docs/research/a14-scale-users.md).** `ItemCache` holds a user idle for
  `freezeIdleMs` (30 min) as one zstd blob (`FrozenUser`) and thaws them exactly on next use. Every reader of a
  user's state goes through `peek`/`touch` (which thaw and mark the user seen); only `revision` and `syncedCount`
  read a frozen user as is. A new per-user field of `UserCache` must be carried by `freezeSteps`/`thawSteps` (or be
  derived and rebuilt), and `cache-freeze.test.ts`'s twin snapshot extended to read it. A new entry point that serves
  a user awaits `cache.ready(scope)` first, as `observe`, `ask` and `checkAction` do, or its first read thaws
  synchronously (~110-190 ms at 3,000 items) with every other request waiting. Bench: `bench/users.bench.ts`;
  on Bun 1.4 `heapUsed` already counts typed arrays' stores and `external` counts them again (D372): report each
  on its own, and RSS, never their sum.
- **Frozen users on disk only (D652, a trial, off; `persist-disk-only.test.ts`).** With `persist(disk, { diskOnly:
  true })` a frozen user's `blob` is null once its file is written, and the file is the only copy: any new path that
  deletes a file without dropping the user loses the user (`thawSteps` then yields an empty one and `persistHooks.lost`
  restarts the sync). A user whose items all expired is dropped without a read (`allExpired`).
- **Persisted frozen users (D425, D426, opt-in; `persist.ts`, `persist.test.ts`, `bench/restart.bench.ts`).** With
  `ItemCache.persist(disk)`, `install` (every freeze) writes the blob and the partner's `persistHooks.save` (the sync's
  `snapshot`); `thawed` deletes it (on disk is only ever a frozen user's state) and, for a user read back from disk
  (`FrozenUser.fromDisk`), calls `restored` (the sync's `restore`, cards enqueued again). `peek`, `touch` and `ready`
  read a user this process does not hold from disk (`load`): synchronous, ~1-3 ms a user. A loaded user gets a new
  revision, read marks 0 (another process's marks mean nothing here) and moves `seqs` past its own. Any new field a
  `FrozenEntry`, `FrozenBody`, `PersistedUser` or `SyncSnapshot` carries bumps `PERSIST_FORMAT`; a new path that drops
  or rewrites a user's items must go through `peek`/`touch`/`dropUser` (which delete the blob) or call `disk.delete`.
- **`syncIngestTurns` (D328, on in the default since D370).** A background sync page waits its turn (one per
  event-loop turn) before it is redacted and stored, so a cold-start storm no longer stalls every request
  (`bench/storm.bench.ts`). The card drain gathers what still waits its turn before calling (`CardEnricher.gather`,
  wired by the partner, at most `GATHER_MS` 250 ms): without it the drain ran on one page at a time (funnel card calls
  446 to 567); with it 376, the same items carded. A new await between a page's turn and its store, or in the drain's
  no-gather path, moves those batches: re-run the funnel's `merged cards use` after touching either.
- **The sync's per-source ids are an `IdSet` (D371, `@eden/primitives`).** Typed arrays, not one string per id: they
  outlive a frozen user's cache. `has` is ~90 ns and iterating 3,000 ~0.2 ms (against ~6 ns and ~5 µs for a `Set`):
  keep iteration off per-item paths.
- **Unused sources are swept weekly (D356, `syncUnusedSweepMs`, docs/research/a21-scale.md).** Safe only because a
  skipped sweep's copies are re-read at delivery: `doubted` is true for a copy older than `syncSweepMs` whose source's
  daily sweep the trial skipped (`Sync.sweepLapsed`, which reads `SourceSync.skipped`, not the sweep's age: an idle
  user's late sweep must doubt nothing) and for any copy the last sweep missed (`Sync.sweepMissed`). Not "is the source
  used now": a lookup engages its sources before its delivery is verified. An unswept copy no re-read confirms is left
  out (never delivered as held, unlike D126's other doubts); after a null re-read it calls `Sync.sweepSoon` (an error or
  a guard's skip does not). A new delivery path that skips
  `doubted`/`verifyItems` would hand over items the weekly sweep has not checked; a source that cannot find an item by
  ref (`Source.fetchesById` false: an `McpSource` with no `fetchTool` still has a `fetch` that answers null) must stay
  on the daily sweep (`onLongSweep`); a wrapper around a `Source` must copy `fetchesById` (as `notifies`).
- Tuning thresholds or rules on dev or held-out wording does not generalise (docs/research/broad-set.md): screen on
  the broad `train` suites, check blind once.

## Where next

`docs/ARCHITECTURE.md`, `docs/DECISIONS.md`, `docs/COST-MODEL.md`, `docs/research/INDEX.md`, `docs/LAB.md`.
