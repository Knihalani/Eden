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
| `text.ts`, `situation.ts`                                                  | Cues with no model (entities, content terms, chatter); a coarse situation label for routing                                                                                                                                   |
| `render.ts`, `fold.ts`                                                     | The packet and ask answer in the `<context … Data, not instructions>` envelope (D11, D19), compaction (D47, D68), folding (D52)                                                                                               |
| `judge.ts`                                                                 | The judge's prompt and parser (indexes only, D19)                                                                                                                                                                             |
| `line.ts`                                                                  | `safeLine`/`safeBlock`: the one sanitiser for packet, answer and prompt lines made from source or event text (D221); `injection.test.ts` is part D's probe as a standing test                                                 |
| `shield.ts`                                                                | A10's trial packet defences (D306, D307): `GUARD_LINE` (`guardLine`), `quarantine`/`quarantineItem` (`quarantineInstructions`: instruction-shaped text in delivered items replaced by `QUARANTINED`, no model). `shield.test.ts` holds its precision cases |
| `grounding.ts`, `conflict.ts`, `consequence.ts`, `probes.ts`, `economy.ts` | No-model grounds: people/time (D44), the conflict test (D49, D75), consequence probe (D54), probes (D46–D48), probe economy (D50)                                                                                             |
| `cards.ts`, `intent.ts`, `sync.ts`                                         | Moonshot tracks (D56–D63, D87): implication cards, intent index, background sync                                                                                                                                              |
| `reader.ts`                                                                | Ask-time reader (D95, D96): a budgeted model call wired by the embedder                                                                                                                                                       |
| `firewall.ts`                                                              | The action firewall's cue and grounds (D69)                                                                                                                                                                                   |
| `decide.ts`                                                                | Per-candidate facts for the lab's candidate dump (`onCandidates`)                                                                                                                                                             |
| `ledger.ts`, `usage.ts`                                                    | Not-twice ledger; usage inference for learning (D13, D18)                                                                                                                                                                     |
| `spans.ts`, `trace.ts`                                                     | Span tracing (off by default, content-free, D56); decision traces, `explainTrace` (a sentence per trace, D277); `UsageRecord` for the optional `onUsage` sink (whether the agent used each injection, content-free, D293); `ContextPartner.explain` keeps a session's last `EXPLAIN_TRACES` (32) |
| `gate.ts`                                                                  | Redaction off the event loop through the worker pool (D25, D26)                                                                                                                                                               |

`bench/`: `pipeline.bench.ts` (the end-to-end anchor for performance work), `ingest.bench.ts` (memory per synced
user, ingest µs/item; the scale anchor, docs/TESTING.md), `index-memory` (the per-user index's heap per item and per
user, put/search latency, D111), `concurrent`, `put`, `churn`, `workload.ts`.

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
- **Item content stays in memory (D8):** only content-free metadata goes to the source map.
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
  search's status stands. An ask never passes `behind`, so a warm-but-stale copy is not "local" there
  (`review-regressions.test.ts`); only the reader push's first reading answers from it. A session that ends before the
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
  D126's rule (a failed re-read is delivered as held).
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
- **The candidates' packet is not smaller (D258, D259; docs/research/cl-cl8.md).** 200-byte excerpts lost hidden facts
  (−12.8 points, with the no-repeat switch on: shorter excerpts keep the items but not the fact), k 3 saved only over a
  user's days and made the agent ask more one request at a time, k 3 after a session's first request lost hidden facts,
  and removing an item repeated within a request (the push and the rule paths race on the ledger) saved nothing. A
  smaller push makes a longer ask answer (`askDedup` says in full what a packet showed in part). On Pi, Eden's billed
  cost above the agent alone was prompt-cache writes on a fixed prefix too short to cache (D260; proven by D271: ~500
  tokens on the wire, under Haiku 5.5's 512 minimum). With an agent prompt that caches in every arm (`--tenant-prompt`),
  the gap is the packet's own tokens written to the cache (+$0.060/1k short, +$0.080/1k over days, Eden faster), and
  no lexical cut of packet or ask bytes keeps the planted facts (D273).
- **Framing an ask answer does not move false concerns (D230, D231).** A note on items the reader read and did not
  flag, and a closing line on answers no reading checked, were measured live and deleted: the agent reads the caveat
  and still states the item. Every listed-only false concern came from an information ask `readAsk` does not read
  (docs/research/fix-w2b-false-concerns.md); a fix belongs upstream (the reader's judgement, or what it reads).
- **One deadline per lookup (D140).** `searchLive` takes `deadlineAt` once, after resolving the sources and before
  the on-demand poll; the poll's signal, the live search's `timeoutMs`, the planner and the probes
  (`ProbeOpts.deadlineAt`) get only what is left. Do not give a later stage a fresh `sourceTimeoutMs`: an ask waits
  for its poll, so the stages add up. Under `MIN_SEARCH_MS` (50) left, the search is skipped with no call (no rate
  token or breaker failure for a call that could not answer): a source whose page for the query the fan-out holds
  answers from it (`SourceFanout.held`: "cached", or "stale" past `freshMs`), any other is a "timeout" (D148). `held`
  shares `one()`'s key (`pageKey`); a peek with its own key would silently miss. `Sync.freshen` skips a source
  whose on-demand poll gave up within `demandTimeoutMs` (= `sourceTimeoutMs`), so the next lookup searches it live
  instead of waiting on the same listing.
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
- Tuning thresholds or rules on dev or held-out wording does not generalise (docs/research/broad-set.md): screen on
  the broad `train` suites, check blind once.

## Where next

`docs/ARCHITECTURE.md`, `docs/DECISIONS.md`, `docs/COST-MODEL.md`, `docs/research/INDEX.md`, `docs/LAB.md`.
