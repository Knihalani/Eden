# Deep audit (2026-11-05)

## Summary (read this first)

This audit ran on `main` at 6911f514d (after D126, freshness). It found 20 problems that survived adversarial
verification: each one was re-checked by two independent verifiers, who re-ran the cited command or wrote a scratch
reproduction. Below, every finding gives its evidence, what it costs users or developers, the fix, and its status.
Numbers come from the verifiers' runs; anything not measured is labelled an estimate.

In plain terms:

- **One serious answer bug.** When every connected source is down or times out, `ask` replies "Nothing in the
  connected sources." That is the same text as a real empty result, so an agent can act on an outage as if it were an
  all-clear. Fixed in package P1 (decision D127).
- **A second answer bug.** An `ask` can say an item was "(shown above)" when the agent has not received that packet
  yet: it is still waiting in the pending queue. Agents that only call `ask` never see the fact. Package P1.
- **The docs steer integrators below the measured default.** README, the integration guide and the example agent set
  a 1.5 s wait, which overrides the client's measured 3 s default, and one sentence contradicts the code. Package P2.
- **Memory and CPU problems that grow with users:**
  - The fan-out's results cache charges an empty page 1 byte, so its 32 MB budget does not bound real memory.
  - Every cache drop scans the whole results cache.
  - A burst of deletion notices for unknown users evicts real users' caches.
  - About half of fast-path CPU repeats the same conflict analysis on the same items.

  Packages P3, P4 and P5.

- **A measurement gap.** `bun run eval --live`, the merge gate's paid check, measures a configuration that does not
  ship (judge on, reader off), and the shipped reader path through OpenRouter has never been timed. With this
  session's key, every call to it returns 403. Package P6 (decision D128).
- **A slow dev loop.** The freshness simulation spends about half its time rebuilding its search index. A memo makes
  it about 1.65x faster. Package P7.
- **Five proposals rejected or deferred with evidence:**
  - Reader push on question turns: D129.
  - Broad reader veto: D130.
  - Per-item change signals: D131.
  - Agent replay at time scale 0: D132.
  - Bigger sweep pages: deferred behind P3.

Seven work packages (P1 to P7) share no files and can run in parallel. Fixers do not edit `docs/DECISIONS.md`: where a
package needs a new decision, its commit message carries the proposed row under `Decision row:`, and the integrator
appends it as D133 (P3) or D134 (any other).

Terms used here:

- **Eval**: the free scenario test (precision, recall, false-fire rate).
- **Funnel**: the free screen of Eden on the training tasks (hidden facts found, decoys delivered).
- **Reader**: the small model that reads candidates before delivery; each call costs money.
- **Oracle reader**: a stand-in reader that flags exactly the right items; it gives an upper bound.

**Round 2** (after round 1's deferred list) re-audited the merged integration branch. It found one high privacy
bug (a re-read in flight brings a deleted item back and delivers it), a hole in round 1's freshness fix, a 3 s
worst-case wait before an ask's reader, and memory and dev-loop costs: 16 findings, 8 packages (R2-P1 to R2-P8),
decisions D133-D140. Its own plain-language summary is under "Round 2 in plain terms".

## Findings, ranked by value (severity, then effort)

Status key:

- **P1-P7**: packaged this round (see "Work packages").
- **Rejected**: not fixed, with the decision that records why.
- **Deferred**: waiting, with the reason.

### 1. `ask-false-all-clear`: ask says "Nothing in the connected sources." when every source failed (high, S)

- **Evidence.**
  - partner.ts:1359 picks the phrase whenever `items` is empty. AskResponse (protocol/src/types.ts:87-94) has no
    source status.
  - The per-source outcomes exist inside `searchLive` (partner.ts:2751) but are not returned (2767-2771).
  - The D93/D114 guard (partner.ts:1620-1623) covers only the reader-drop case.
  - Two scratch tests, DEFAULT_CONFIG and CORE_CONFIG, with one source throwing `503 upstream down` and one never
    answering, both returned `{"answer":"Nothing in the connected sources.","citations":[],...}` (latencyMs
    1,512-1,562). A healthy empty source returns the same answer in 2 ms.
  - http.ts:100 and mcp.ts:21 pass the answer through unchanged.
- **Impact.** Every connector outage becomes a confident false all-clear. Integrators cannot tell "empty" from
  "unreachable".
- **Fix.**
  - Carry outcome statuses out of `searchLive` and `freshen`.
  - In the answer text, name sources that could not be reached and say this is not an all-clear. MCP callers see
    only text.
  - Add optional `sources?: {sourceId, status}[]` to AskResponse.
  - Count as answered: ok, cached, stale, and a local-index answer. Busy, limited and open count as not answered.
- **Status.** P1. Decision D127.

### 2. `scale-results-cache-unbounded`: the results cache budget is not real memory (medium, S)

- **Evidence.**
  - guarded.ts:596-601 `sizeOf` is `Math.max(1, title+text length)`, and the key is never charged. Empty pages are
    cached (guarded.ts:421, :563).
  - Expiry is lazy (primitives/src/cache.ts:117-126), and `evict` runs only under byte pressure.
  - Scratch script (S3FifoCache, 32e6 bytes, 200,000 empty pages with ~120-char keys over 2,000 simulated s): size
    200,000, bytes counted 200,000, heap +66.7 MB = 334 B/entry. 140,000 of those entries were past expiry.
  - A second run measured 340 B/entry.
- **Impact.** Under a workload of mostly empty results, the cache grows with no practical bound. With a realistic mix,
  heap is bounded at a few times maxBytes (estimate). The original finding said critical and ~10 GB; verifiers
  downgraded it, because that figure assumes every page is empty.
- **Fix.**
  - Charge `key.length*2` plus a measured per-entry overhead (~340 B) in `sizeOf`. This alone is the real bound.
  - `expireSome` at the FIFO heads is optional and weaker (re-set keys and main-ring reinsertions stall it), so it is
    not required.
- **Status.** P4.

### 3. `eval-live-measures-unshipped`: `eval --live` measures judge on, reader off (medium, S-M)

- **Evidence.**
  - cli.ts:45 builds `OpenRouterModel.fromEnv()` (default `z-ai/glm-5.3-flash`), and run.ts:191-198 passes it as the
    judge.
  - `parseReaderOption` refuses a live reader (reader-stub.ts:23-27).
  - The server wires no judge and AskReader over ModelReaderMaker on `anthropic/claude-haiku-5.5` (build.ts:67-69,
    :76; models.ts:16).
  - The eval wires no cards either.
  - `bun run eval --reader stub`: precision 0.828, recall 0.48, falseFireRate 0, 6 reader calls.
- **Impact.**
  - The merge gate's paid number (D119: 0.923/0.72/0.0147) describes a configuration that does not ship.
  - No reader-side change can be screened live in the eval.
  - Not user-facing: the Pi lab measures the shipped path (D112, D125).
- **Fix.**
  - `--live` wires what `buildPartner` wires (no judge, live reader on the shipped role model), with cards labelled
    inert.
  - `--live --judge` keeps the old shape.
  - The run refuses to start without a hard dollar cap. The lab `SpendLedger` is in `@eden/sim`, which the eval may
    not import, and it meters only `claude-*` ids.
- **Status.** P6. Decision D128. The paid run itself is deferred (see "Deferred").

### 4. `painpoint-prod-reader-unmeasured`: shipped reader path untimed; 403 with this key (medium, S)

- **Evidence.**
  - Production reader: OpenRouter, Haiku 5.5, throughput sort, ZDR, reasoning "low" (models.ts:16, :48-55;
    reader.ts:479-485).
  - Lab readers are Anthropic-direct with thinking off (free.ts:103-112). In the ledger, 7,356 `eden.reader` rows
    are all `claude-haiku-5-5` direct, and 0 carry reasoningTokens.
  - Decode is 3.62 ms/token at p50 (6,831 rows).
  - A probe of three arms (ZDR+throughput, no-ZDR+throughput, ZDR default) all returned `openrouter 403: "...
violation of provider Terms Of Service."`, $0 booked. The key is valid (limit 100, not free tier). The model has
    healthy endpoints.
- **Impact.**
  - Reasoning "low" may add about 1,024 × 3.62 ≈ 3.7 s (estimate, assuming Anthropic's thinking floor), past the
    3,000 ms wait.
  - If the 403 is not account-specific, the shipped reader fails open on every call.
  - Quality under "low" is also unmeasured: D96's "reason first" is the prompt's field, not model reasoning.
- **Fix.**
  - Now ($0): log the reader's first failure reason, and the provider error text, once per process. Use no extra
    model call; a startup probe would be a model call outside the "Model last" rule.
  - Later (paid): 20 production-shaped calls per arm with a key OpenRouter serves.
- **Status.** P6 for the $0 part. The paid timing is deferred.

### 5. `ask-shown-before-handed-out`: ask says "(shown above)" for a packet still pending (medium, S)

- **Evidence.**
  - `build()` calls `noteShown` at build time (partner.ts:4547-4551; `askDedup` on in DEFAULT_CONFIG,
    config.ts:571).
  - The slow path only queues into `s.pending` (partner.ts:829, 890, 953, 1327). takePending and handOut
    (1037-1043, 1863) never mark shown words.
  - Two scratch tests (DEFAULT_CONFIG, 300 ms source, observe with waitMs 0, ask before takePending) gave
    `- [drive] Procurement policy v4: (shown above)`. The full text arrived only afterwards via takePending.
- **Impact.**
  - An agent that asks while a reading is in flight gets only a title.
  - An agent that never polls pending never sees the fact.
- **Fix.**
  - Note shown words at hand-out: observe's returned injection at :721, :1179, :1384, and takePending. Do it before
    handOut's early returns.
  - In ask, drop from pending an untaken packet only when the answer cites all its items. Otherwise leave it queued.
    `withdraw` is not usable: it acts only on `undoable` entries.
  - Regression test with a two-item pending packet where the answer cites one.
- **Status.** P1.

### 6. `docs-wait-1500-degrades`: docs hard-code a 1.5 s wait over the 3 s default (medium, S)

- **Evidence.**
  - client.ts:123 sets `DEFAULT_WAIT_MS = 3_000`, applied at :196.
  - README.md:38 and docs/INTEGRATION.md:15 set `defaultWaitMs: 1500`.
  - examples/personal-agent/agent.ts:82-87 defaults to 1,500 and calls the reader "experimental (NEW, D98)".
  - INTEGRATION.md:48 says the client sends none by default, which contradicts :53 and the code.
  - README.md:50-51 is also stale.
- **Impact.** Copy-paste integrators wait less than the reader's p90 (1,768 ms). A 1 s wait lost 7.6 and 18.1 Pi
  points (INTEGRATION.md:66-70). The loss at 1.5 s is inferred, not measured.
- **Fix.**
  - Drop the overrides.
  - agent.ts passes waitMs only when EDEN_WAIT_MS is set (0 still turns the wait off).
  - Fix lines 47-49 and README 50-51.
- **Status.** P2.

### 7. `source-removed-evicts-users`: deletion notices for unknown users evict real users (medium, S)

- **Evidence.**
  - sourceRemoved (partner.ts:1727-1734) checks only `syncPush`.
  - dropGone calls `cache.removeItems(..., GONE_HOLD_MS)`, which calls `touch(scope)` (cache.ts:639-655). touch
    creates a UserCache and, at 10,000 users per tenant, evicts the least recently written one (cache.ts:360-382).
  - Repro (maxUsersPerTenant 3): three ghost removals evicted the real user.
  - 10,000 ghost removals: 202-246 ms and 27.8 KB heap per user (≈278 MB per tenant, estimate).
  - The "returns how many were held" doc is wrong: the method returns the number of dropped items.
- **Impact.** A mailbox-wide deletion feed silently cold-starts active users within the tenant.
- **Fix.**
  - Keep gone-holds in a separate bounded per-tenant map in ItemCache that never allocates a UserCache and never
    counts toward maxUsersPerTenant. "Return 0 for unknown pairs" would reopen D126's in-flight race.
  - Fix the doc.
- **Status.** P3. The `dropResults` cost on the same path is fixed by P4.

### 8. `ingest-lazy-sketch`: near-duplicate sketch computed for every stored item (medium, S)

- **Evidence.**
  - `sketchOf` runs eagerly at cache.ts:557. Sketches are read only by hit builders (cache.ts:769, 805, 833, 867)
    and partner's near-duplicate checks.
  - `ingest.bench.ts` with `sketch: null`: backfill 98.4/104.4 → 58.0/58.7 µs/item, and 96.2/92.1 → 56.9/56.0 at
    100x2000.
  - A real lazy prototype: 59.2/60.6 µs/item (1.57x). Engine tests 674/674. Eval and funnel identical.
- **Impact.** Backfill and lookup put cost about 1.5x less CPU per item. The cost moves to first read, once per item.
- **Fix.**
  - `Entry.sketch` holds undefined until computed, which is distinct from null ("no own words").
  - Compute it after `searchIn`'s per-source filter and after `timed`'s slice, not for all 400 depth hits.
  - Report ask or delivery latency before and after.
- **Status.** P3.

### 9. `deliver-reparses-item-text`: fold re-tokenizes items with no repeated anchor (medium, S)

- **Evidence.**
  - Profile (pipeline bench): observe 5,955 ms, deliver/build 1,675 ms, foldEchoes 926 ms (tokensOf 418 ms
    inclusive).
  - Counter in a scratch copy: 621 foldEchoes calls, 0 with any repeated anchor, 0 items folded.
  - Corrections: the three messageParts calls in a delivery use different arguments, so they cannot share a parse.
    render.ts:61 also has a stateful `known` closure. compactText (475-595 ms) belongs to `assess`, not delivery.
  - Prototype early exit plus memo: 674 engine tests pass, and eval output is byte-identical except latency.
- **Impact.** About 560 ms of profile time, ~9-10% of observe on the bench. It is smaller on calendar-heavy packets,
  which do repeat anchors.
- **Fix.**
  - In foldEchoes, compute ownText and anchors first and return the input unchanged when no anchor repeats. This is
    exact.
  - No messageParts memo on the render path.
- **Status.** P5 (the fold.ts part). The memo part is replaced by finding 15's conflict analysis cache.

### 10. `scale-dropresults-full-scan`: every drop scans the whole results cache (medium, M)

- **Evidence.**
  - `dropResults` and `forget` (guarded.ts:321-339) call `deleteWhere`. That copies and tests every key
    (primitives/src/cache.ts:197-208, whose own comment says "not for the hot path").
  - Callers: partner.ts:1698, :1717, :3448, :3465.
  - Bench: 1k entries 0.244 ms/drop, 10k 1.586 ms, 50k 6.19 ms (linear).
- **Impact.** At ~10k entries (32 MB of ~2-5 KB pages, estimate), 30 drops/s ≈ 5% of the event loop (estimate). Each
  stall is ~9x a fast-path event. The original 16% was revised down.
- **Fix.**
  - Option (a): `S3FifoCache` gets an optional group function, a `Map<group, Set<key>>` maintained in set and kill,
    and `deleteGroup`.
  - SourceFanout groups by `${scopeKey}|${sourceId}`.
  - Option (b), an epoch, is rejected: an evicted epoch that resets would revalidate stale pages.
  - Re-run the cache bench before and after (primitives README rule).
- **Status.** P4.

### 11. `fresh-readat-race`: a copy read before a signal is stamped after it (medium, M)

- **Evidence.**
  - `doubted` (partner.ts:3342) uses `signalledSince` (sync.ts:295-298, strict `noticedAt > readAt`).
  - readAt is the put-completion time (partner.ts:3230, sync.ts:698-701; cache.ts:525/543/557).
  - Two repros (freshness.test.ts harness, CORE_CONFIG + sync + syncPush + verifyDelivery, change signalled during
    the verify fetch): a minute later fetches stayed 1 → 1 and the answer said "Lisbon". The control with the signal
    after the fetch re-read and answered "Porto".
- **Impact.** A change notified while a read is on the wire is missed until the next signal or a poll that lists the
  item. A same-millisecond signal is also missed.
- **Fix (chosen to stay inside sync.ts and cache.ts, so it does not collide with P1's partner.ts).**
  - `signalledSince` treats a signal as possibly after the read when `noticedAt >= readAt - slack`. `slack` is the
    longest a source read can be on the wire: the fan-out's call timeout, or `verifyTimeoutMs` if longer.
  - The cost is extra re-reads only for copies read within `slack` after a signal. Measure it.
  - The exact alternative (record the per-source notice sequence per copy) needs partner.ts's `store` and can follow
    later.
- **Status.** P3. Proposed decision row D133 (amends D126).

### 12. `fastpath-assess-eager-unmemoized`: conflict.assess runs on every candidate, re-parsing the same items (medium, M)

- **Evidence.**
  - Profile: observe 6,208-6,454 ms. assess (conflict.ts:331) is 50.3-50.7% inclusive. confident (partner.ts:2022)
    is 49-50%.
  - 727 confident() calls, 4,105 cleared() calls, 5,156 verdict() calls over 325 distinct items (~16x).
  - Lazy stop-at-cap loop: identical output on all 727 calls. Verdict calls 5,095 → 2,137. ms/event 3.20 → 2.37-2.62
    (two runs per arm) and 3.39/3.15 → 2.44/2.48 (second verifier, ~1.33x). Eval identical.
  - COST-MODEL.md:221 (104.8 µs p50, 848 µs p99, 0.389 ms/event) is stale. Runs today give p50 160-190 µs, p99
    10-17 ms and 2.8-3.8 ms/event.
- **Impact.** About 1.33x events per core from the lazy loop (measured). An item-analysis cache may bring assess to
  about 0.9-1.2 s from ~3.7 s (estimate).
- **Fix.**
  - (1) confident(): one loop with the cheap tests first, stopping at the cap.
  - (2) conflict.ts: an item-only `analyse` cached in a WeakMap on the stored item, keyed also by vocab and
    hasDomain. Frame-dependent work stays uncached.
  - Update the COST-MODEL row.
- **Status.** Split: (1) goes in P1, which owns partner.ts. (2) and the COST-MODEL row go in P5.

### 13. `sim-reindex-memo-and-user-shards`: freshness sim rebuilds its index on every update (medium, M)

- **Evidence.**
  - quality.ts:554, :562 call `reindex()`, which builds a new SimIndex (sources.ts:496-499) over every item.
  - quality-cli `--updates 0.6 --deletes 0.05 --push signals`: 20.9-21.6 s, against 10.1-10.4 s without updates.
  - A full per-item memo (with a content check) ran in 12.7 s with JSON identical except timing (1.65x).
  - deletes.test.ts 4.08 → 1.91 s.
  - applyUpdate mutates items in place (updates.ts:92-94), so a WeakMap keyed only on the object would serve stale
    terms.
- **Impact.** Freshness-arm comparisons run about 1.65x faster (measured). `--jobs 4` sharding at ~3.9x is an
  estimate.
- **Fix.**
  - Stage 1: memo keyed by item object with stored title and text, recomputed on mismatch; df and postings rebuilt.
  - Stage 2 (optional, same package): `--jobs N --user-range a:b`, merging counters and raw latencies as
    funnel-merge.ts does.
  - Update LAB.md.
- **Status.** P7.

### 14. `sync-sweep-backfill-big-pages`: sweeps and backfill list 100 items per call (medium, M)

- **Evidence.**
  - config.ts:545 `syncPageSize: 100`. Backfill and sweep use it (sync.ts:465, :659).
  - sync-econ (`--days 6 --seed 1`) at 500 per page: background 33.8 → 9.2 calls/user-day, backfill 33 → 9,
    freshAtLookup 0.999 both, deletedStillHeld 0.4492 → 0.4453. A weekly sweep doubles deletedStillHeld (0.8324).
- **Impact.** On per-call platforms in payload mode, about 0.61-0.78 → 0.27-0.45 connector calls per task (estimate
  from cost-fixes.md:134's 0.46 sweep share).
- **Problem with the fix as proposed.**
  - Offset-paged MCP tools end on a short page (mcp-source.ts:276-278). A server that silently caps pages at 100
    would end every sweep after page 1.
  - Two missed sweeps then drop the unseen items (sync.ts:677-685).
  - A server that rejects big pages fails every sweep.
- **Status.** Deferred until P3 lands, because both change sync.ts. The safe design is recorded for it:
  - a trial switch;
  - big pages only for token-paged lists or a declared schema maximum;
  - on error, retry at 100;
  - offset lists end only on an empty page.

### 15. `quality-reader-ceiling-gated`: the eval's oracle ceiling is recall 0.52 (medium, M)

- **Evidence.** `bun run eval --reader oracle`: calls 6, pool 15/50, recall 0.52. With push on every message and the
  gate off: calls 45, recall 0.82, falseFires 0. That zero is built into the oracle.
- **Impact.** This is a ceiling on the eval suite, not a measured live gain. D99 measured the same change live
  (NEW2): small, CIs including 0, and +3.1 false-concern points. D112 deleted it.
- **Status.** Rejected for now: D129.

### 16. `quality-reader-veto-rule-path`: rule-path lookalikes ship next to the reader's push (medium, M)

- **Evidence.**
  - Eval: 5 of 29 delivered items are wrong, all from slow-path `deliverChecked` on cues the push read.
  - On the default, the broad veto trades 5 wrong items for 4 right ones even with a perfect reader. Recall
    0.52 → 0.44, and 0.36-0.42 with a reader that flags 90% of right items.
- **Status.** Broad veto rejected: D130. The by-name veto waits for P6's live reader eval and paid spend.

### 17. `fresh-per-ref-signals`: a change signal doubts every earlier-read item of its source (medium → low, M)

- **Evidence.** quality-cli `--push signals`: 575 re-reads, 94% unchanged. `--push payload`: 0 re-reads, same
  staleness.
- **Impact.** Re-reads cost read-only connector calls, not paid model spend. The integrators who could name refs can
  already use the payload path.
- **Status.** Rejected: D131. P2 adds a line to the integration guide recommending `sourceItems`/`sourceRemoved`.

### 18. `devloop-agent-replay-identical-eden`: replay the agent's own calls in the Pi lab (medium, M)

- **Evidence.**
  - The agent always runs live (pi-ab.ts:53, :230-237).
  - Funnel default vs minus-graph: 533/768 rows identical.
- **Problem.** At time scale 0 it scores timing-driven regressions as neutral (D126's by-age arm: −10.2 hidden points
  from awaited re-reads).
- **Status.** Rejected as specified: D132.

### 19. `fanout-drop-evicted-state`: a drop is lost when its pair's state is LRU-evicted mid-call (low, S)

- **Evidence.**
  - `dropResults` bumps `drops` only on an existing PerSource (guarded.ts:333-339). `dropsOf` returns 0 for a missing
    state. `state()` evicts at MAX_STATES 100,000 (:133, :483-497).
  - Two repros: slow search, then 100,000 other pairs touched (638-1,444 ms), then a drop. The next lookup returned
    `cached` with the old text. The control was honoured.
- **Impact.** It needs 100k distinct pair touches inside one in-flight call, which is rare. When it happens, a changed
  page is served for up to 60 s fresh and 600 s as stale fallback.
- **Fix.** A fanout-wide drop epoch that one() and planCalls compare alongside `forgets`, bumped when the pair has no
  state. Make MAX_STATES injectable for the test.
- **Status.** P4 (same file as findings 2 and 10).

## Round 1

Round 1 is this audit's first pass:

- 20 findings were verified, each by two verifiers.
- Severities after verification:

  | Severity | Findings | Notes                                                                                                               |
  | -------- | -------: | ------------------------------------------------------------------------------------------------------------------- |
  | High     |        1 |                                                                                                                     |
  | Medium   |       17 | Includes the downgraded `scale-results-cache-unbounded` (was critical) and `scale-dropresults-full-scan` (was high) |
  | Low      |        1 | `fanout-drop-evicted-state`                                                                                         |
  | Rejected |        1 | `fresh-per-ref-signals`, as an API change (D131)                                                                    |

- What happened to the findings:
  - 13 are packaged into P1-P7. Two findings are split across packages.
  - 4 are rejected with decisions (D129-D132).
  - 1 is deferred behind P3.
  - The paid parts of 2 findings are deferred.
- Decisions recorded by this audit: D127 (honest empty ask), D128 (eval `--live` is the shipped wiring), D129, D130,
  D131, D132.
- Reserved for fixers: D133 (P3's change to D126's read-time rule) and D134.

## Work packages (round 1)

No two packages share a file. Each runs from `audit/2026-11-05-integration`, commits on its own branch, and does not
edit `docs/DECISIONS.md` (it puts a proposed row in its commit message). Every package ends with `bun run check`
green. A package that changes engine behaviour also pastes `bun run eval` JSON before and after.

| Package                      | Findings         | Files                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1 `ask-honest-answers`      | 1, 5, 12(1)      | packages/engine/src/partner.ts, packages/protocol/src/types.ts, packages/engine/src/review-regressions.test.ts, packages/engine/src/reader.test.ts, packages/protocol/CLAUDE.md, packages/engine/CLAUDE.md                                                                                                                               |
| P2 `docs-integration-wait`   | 6, 17 (doc line) | README.md, docs/INTEGRATION.md, examples/personal-agent/agent.ts                                                                                                                                                                                                                                                                         |
| P3 `engine-cache-sync-holds` | 7, 8, 11         | packages/engine/src/cache.ts, packages/engine/src/sync.ts, packages/engine/src/cache.test.ts, packages/engine/src/freshness.test.ts, packages/engine/bench/ingest.bench.ts                                                                                                                                                               |
| P4 `fanout-results-cache`    | 2, 10, 19        | packages/sources/src/guarded.ts, packages/primitives/src/cache.ts, packages/primitives/README.md, packages/primitives/bench/runtime.bench.ts (the S3FifoCache bench), packages/primitives/src/cache.test.ts, packages/sources/src/regressions.test.ts                                                                                    |
| P5 `fastpath-analysis-cache` | 9, 12(2)         | packages/engine/src/conflict.ts, packages/engine/src/fold.ts, packages/engine/src/conflict.test.ts, packages/engine/src/fold.test.ts (new), packages/engine/bench/pipeline.bench.ts, docs/COST-MODEL.md                                                                                                                                  |
| P6 `shipped-reader-path`     | 3, 4 ($0 part)   | packages/eval/src/cli.ts, packages/eval/src/run.ts, packages/eval/src/reader-stub.ts, packages/eval/src/run.test.ts, packages/eval/CLAUDE.md, packages/engine/src/reader.ts, packages/engine/src/reader-failure.test.ts (new), packages/server/src/build.ts, packages/server/src/models.ts, packages/server/src/reader-log.test.ts (new) |
| P7 `sim-reindex-memo`        | 13               | packages/sim/src/sources.ts, packages/sim/src/quality.ts, packages/sim/src/quality-cli.ts, packages/sim/src/sim.test.ts, packages/sim/src/deletes.test.ts, docs/LAB.md                                                                                                                                                                   |

The plan and acceptance checks for each package are in the run's structured output and are summarised here:

- **P1.**
  - Plumb per-source outcomes out of `searchLive` and `freshen` into ask.
  - Empty and partial answers name the unreachable sources, with an optional `AskResponse.sources` (D127).
  - Note shown words at hand-out, not at build.
  - Drop a pending packet only when it is fully cited.
  - Turn confident() into a lazy stop-at-cap loop.
  - Acceptance:
    - tests for all-failed, partial-failure and healthy-empty asks;
    - a two-item pending regression test;
    - eval: precision 0.8276, recall 0.48, falseFireRate 0, unchanged;
    - funnel TOTAL 214/211, unchanged;
    - pipeline bench ms/event lower.
- **P2.**
  - Drop the 1,500 ms overrides.
  - Fix INTEGRATION.md:47-49 and README.md:50-51.
  - The example agent defers to the client default.
  - Add a payload-path recommendation (D131).
  - Acceptance:
    - `grep -n "1500\|1_500" README.md docs/INTEGRATION.md examples/personal-agent/agent.ts` finds no wait override;
    - `bun run check` passes.
- **P3.**
  - Separate bounded gone-hold map.
  - Correct the `removeItems` doc.
  - Lazy sketch.
  - `signalledSince` slack, with `>=`.
  - Acceptance:
    - 10k ghost removals leave the user count flat and the real user present;
    - a known user's removal still holds the id;
    - the race repro passes;
    - ingest.bench backfill µs/item before and after (expect about 1.5x);
    - quality-cli `--push signals` freshness.checked before and after, with staleDelivered and deletedDelivered not
      worse;
    - eval and funnel identical.
- **P4.**
  - `sizeOf` charges the key plus measured overhead.
  - Group index and `deleteGroup`, used by `dropResults`.
  - Fanout-wide drop epoch.
  - Acceptance:
    - cache bench set/get before and after, and deleteGroup vs deleteWhere at 1k/10k/50k;
    - 200k empty pages stay under maxBytes of heap;
    - a drop removes only the named pair;
    - the eviction repro with injectable MAX_STATES passes.
- **P5.**
  - foldEchoes early exit.
  - Item-analysis WeakMap cache in conflict.ts.
  - COST-MODEL row refreshed.
  - Acceptance:
    - pipeline bench before and after on the same machine;
    - conflict and fold tests;
    - eval and funnel identical.
- **P6.**
  - `--live` uses the shipped wiring, `--judge` keeps the old shape, and a dollar cap is required (D128).
  - The reader's first failure reason is logged once.
  - Acceptance:
    - run.test asserts the eval's live wiring matches buildPartner's (judge null, reader present);
    - `bun run eval --live` without a cap exits non-zero with a message;
    - a server test shows a failing reader logs its reason once and the ask still answers;
    - no paid call.
- **P7.**
  - Per-item memo with a content check.
  - Optional `--jobs`.
  - LAB.md.
  - Acceptance:
    - quality-cli JSON identical except timing for `--push signals`, `--push payload` and
      `--config '{"verifyDelivery":false}'`;
    - wall time before and after;
    - `bun run test:pkg sim`.

## Deferred

| Item                                                             | Why                                                                                                                                                          |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sync-sweep-backfill-big-pages` (14)                             | Waits for P3, which owns sync.ts. The safe design is in finding 14.                                                                                          |
| Paid timing of the shipped reader (4, stage 1)                   | Needs paid OpenRouter calls the lab ledger cannot meter, and a key OpenRouter serves for Anthropic: this session's key gets 403. That is an external action. |
| Live reader eval run (3) and the by-name reader veto screen (16) | Wait for P6's capped `--live`. They are paid.                                                                                                                |
| Exact per-copy notice sequence for `fresh-readat-race` (11)      | Needs partner.ts, held by P1. P3's slack window closes the hole first.                                                                                       |

## Round 2

Round 2 re-audited the integration branch after round 1's seven packages merged (tip 006b1694b). 16 findings
survived verification, each re-checked by two verifiers who re-ran the cited command or wrote a scratch reproduction.
Numbers below are the verifiers' unless marked; where the two verifiers disagreed, the lower figure is used.

### Round 2 in plain terms

- **One privacy bug.** If a deletion notice arrives while Eden is re-reading the same item to check it is current,
  the re-read puts the deleted item back and delivers it. A verifier reproduced it with a recalled message. Package
  R2-P1.
- **A hole in round 1's freshness fix.** Two lookups for the same words share one source call. If the source changes
  while that call is running, the second lookup stores the old copy as if it were current, and nothing re-reads it
  until the next change. Package R2-P2.
- **An explicit ask can wait 3 s before the reader starts**, because the sync poll and the live search each get a
  full 1.5 s. One shared deadline caps that at about 1.5 s (D140). Package R2-P1.
- **Wasted connector calls.** An ask that the reader gate stops still re-reads up to 3 items for a reading that never
  happens (D134). Package R2-P1.
- **A large tenant forgets deletions early.** Past about 33 deletions a second per tenant, deletion holds expire
  after 2-4 minutes instead of 10. Package R2-P3.
- **Memory.** Round 1's conflict-analysis cache stores an empty array for almost every mark; sharing one empty array
  halves its memory (D136). Package R2-P4.
- **The knowledge graph costs about half of ingest CPU and 1.45x memory per user**, and the free screens show no gain
  from it. Whether it stays needs a paid reader comparison (about $0.3 estimated, inside the run's budget). The ingest
  benchmark also measures only part of what ships. Package R2-P8.
- **A slower dev loop.** `bun run funnel` can be 1.6-2.4x faster (D139, R2-P5). Every new worktree pays about 25-30 s
  of cold format and type checks (R2-P6). Round 1 added about 6.6 s of test time, mostly fixed sleeps (R2-P7). The
  documented `bun run eval --live` now exits 2 without `--usd-cap` (R2-P7).
- **D133 had no row.** The read-mark rule from round 1 was cited by code and docs but never written into the decision
  log. Written in this commit.
- **Rejected with evidence:**
  - Removing the fan-out results cache (D135).
  - Keyword-only intent requests (D137).
  - Warming a cold user's sources in the background (D138).
  - A byte-capped conflict cache (D136).
  - Fewer re-reads ahead of the reader (D134).

### Round 2 findings, ranked by value (severity, then effort)

Status key as in round 1: R2-P1 to R2-P8 are this round's packages; "Rejected" names its decision; "Deferred" says
why; "Fixed" means fixed in this commit.

#### R2-1. `fresh-recheck-revives-deleted`: a re-read in flight when `sourceRemoved` lands brings the item back (high, S)

- **Evidence.**
  - `recheck` (packages/engine/src/partner.ts:3509-3547) awaits `fanout.fetchChecked`. On an ok status it calls
    `this.deps.cache.revive(s.scope, [item.id])` (:3533), then `store(...)`, without checking whether a removal
    landed during the fetch.
  - `sourceRemoved` (:1768) goes through `dropGone` (:3553-3557). `Sync.removed` does not advance the mark, so the
    `readMark` passed to `store` cannot see the removal. `ItemCache.put` already skips held-gone ids (cache.ts:611);
    the explicit `revive` lifts the hold first. main has the same revive (main partner.ts:3443).
  - Repro (both verifiers, scratch test built on freshness.test.ts helpers): the source's `fetch` snapshots q1,
    yields, deletes q1 and calls `partner.sourceRemoved`, then returns the snapshot. After `sourceChanged` and with
    search failing, "Remind me where the quarterly offsite is" gives `removed 1`, then `delivered ["notes:q1"]`, and
    the cache holds the Lisbon text. `expect(cited).not.toContain('notes:q1')` fails.
- **Impact.** D126 promises that a deleted item is not delivered after its deletion notice. That breaks whenever the
  notice lands during the re-read, which `checkAhead` widens by starting re-reads early. The item stays cached and
  deliverable and its 10-minute hold is lifted. On the default path; privacy-relevant (recalled messages).
- **Fix.** Before `revive`, return "gone" when `this.deps.cache.isHeldGone(s.scope, item.id, this.now())` (cache.ts:775
  already has it). A verifier applied exactly this: the repro passed and `bun test packages/engine/src/` gave 706
  pass, 0 fail. A live hold at that point can only come from a removal during the fetch, since `removeItems` drops the
  id from the cache; a push that re-adds the item (`sourceItems`) revives it itself.
- **Status.** R2-P1.

#### R2-2. `fresh-joined-flight-unmarked`: a lookup joining a call begun before a signal stores the old copy as current (medium, S)

- **Evidence.**
  - guarded.ts:586-593: `one()` joins `flights.run(cacheKey, ...)` and returns ok, `joined: true`, with the
    leader's items, whatever `dropResults` happened since the leader started. `dropResults` (:371-379) only bumps
    `running.drops`; the `undropped` check (:619-621) only stops the leader writing back. `planCalls` (:450-480) has
    the same shape.
  - partner.ts:2676 takes the read mark at lookup start and :2868 stores joined items under it; cache.ts:624/643 keep
    `Math.max(old.readMark, readMark)` for unchanged copies, so the joiner's later mark replaces the leader's earlier
    one and `doubted` (partner.ts:3428) is false.
  - Fan-out repro: leader A starts, the text changes, `dropResults`, B searches the same query: `A ok B ok true budget
is old calls 1`.
  - Engine repro (freshness.test.ts helpers, synced with syncPush and verifyDelivery, listing failing): s1 asks with
    its search held, the doc changes to Porto, `sourceChanged`, s2 asks. With s2 joining: 1 search, both answered
    Lisbon, readMark 2 = sync mark 2, not doubted, and a later ask made 0 fetches and answered Lisbon. Without s2:
    s1's delivery check re-read and answered Porto.
- **Impact.** The exact race D133 was written to close, through a different door. Joins are common by design
  (partner.ts:2826-2829: the slow path and the reader push's ask search the same words at once); crossing a signal
  is rarer and its frequency is unmeasured. When it happens the stale copy is delivered and stays undoubted until
  the next signal.
- **Fix.** A call that started before the pair's latest drop is not joinable: put the pair's drop count (and the
  fan-out-wide drop epoch round 1 added) into the flight key, or keep the leader's drop mark beside the flight and
  refuse the join when `undropped` fails. A lookup arriving after a drop then leads a fresh call. This costs at most
  one extra connector call per drop that lands during a flight and needs no engine change (the joiner's own read
  mark was taken before its search). Do not change `Singleflight` or `cache.ts`'s `Math.max`: with only post-drop
  joins, a later mark is true.
- **Status.** R2-P2.

#### R2-3. `fresh-checkahead-speculative-rereads`: re-reads ahead of the reader are paid even when the reader is not called (medium, S)

- **Evidence.** readAsk calls `this.checkAhead(s, pool)` (partner.ts:1531) before the empty-pool return and before
  the `readerGate` return (:1558-1571). checkAhead (:3564-3573) re-reads the first `VERIFY_AHEAD` = 3 doubted pool
  items, one connector fetch each. Verifier runs of a scratch-patched quality-cli (`--users 8 --sessions 20 --updates
0.6 --deletes 0.05 --push signals`, stub reader): 885 / 674 / 574 re-reads at ahead 3 / 1 / 0 (flag-nothing
  reader), 882 vs 593 at ahead 3 vs 0 (flag-first reader). staleDelivered and deletedDelivered never changed;
  deletedCited moved ±1 in both directions across seeds 1-3. Narrowing the delivery's own `verifyItems` to 3 items:
  574 -> 430 re-reads but +2 deleted cited.
- **Impact.** At most 1.34x fewer connector calls (upper bound, stub reader), under the audit's 1.5x bar, and the
  stub cannot price the latency the re-reads ahead buy (docs/research/freshness.md: -10.2 points of hidden facts
  raised and +0.68 s when re-reads waited for delivery). The gated asks are the clear waste; how many there are was
  not measured.
- **Fix.** Decided in D134: keep `VERIFY_AHEAD` at 3; move `checkAhead` below the empty-pool and `readerGate`
  returns. Do not narrow `verifyItems`.
- **Status.** R2-P1 (the move). Lowering the count: rejected, D134.

#### R2-4. `ask-poll-serial-double-deadline`: an ask's poll and search each get a full 1.5 s (medium, S)

- **Evidence.** partner.ts:2690 gives the poll `AbortSignal.timeout(sourceTimeoutMs)`; an ask awaits it (:2727,
  D65); `deadlineAt` is computed only after the poll (:2766); the search gets a fresh `timeoutMs` (:2801) and the
  probes their own (:2931). `Sync.freshen` (sync.ts:376-383) polls a source again after its poll timed out. Verifier
  spans over 51 recorded `.local/**/tasks.jsonl` files (3,725 explicit asks): pre-reader p95 1,741, p99 2,656, max
  3,042 ms; 207 asks had poll and search both over 200 ms in series. Worked example (.local/mkt/hosted-42,
  board-pack-deadline): gmail and slack `list` time out at 1,500 ms, then a slack `search` times out at 1,500 ms; the
  reader starts about 3,042 ms after the ask.
- **Impact.** One shared deadline caps the wait before the reader at about 1.5 s: verifier recomputation gives
  pre-reader p99 2,584 -> 1,520 ms (.local/fresh) and p95 2,306 -> 1,520 ms (.local/mkt); whole-ask p95 1.06-1.23x.
  The finding's larger figures (2.1x at p95) assume the poll is skipped altogether, which is Stage 2.
- **Fix.** Decided in D140: compute `deadlineAt` once before the poll and give poll, search and probes the time
  left; `Sync.freshen` does not poll again a source whose on-demand poll timed out within `sourceTimeoutMs`. Lands in
  the default if `funnel -- --ask` and eval counts are unchanged, otherwise as the trial switch `askSharedDeadline`.
  Stage 2 (answer from the warm index after a short grace) is not taken (D65 holds).
- **Status.** R2-P1.

#### R2-5. `devloop-ingest-bench-not-shipped-path`: ingest.bench measures under a third of shipped ingest work (medium, S)

- **Evidence.** packages/engine/bench/ingest.bench.ts builds `ItemCache` without `enableGraph()` and `SyncManager`
  without `onStored`. Shipped: `graph: true` (config.ts:514), the partner calls `enableGraph` and wires `onStored` to
  `enqueueCards` and `recordMentions` (partner.ts:522-608). Verifier scratch variants of the bench (200 x 500): core
  115-120 us/item and 2,614 B/item; with graph 283-290 us/item and 5,200 B/item; with graph and mentions 395-410
  us/item and 5,243 B/item.
- **Impact.** Shipped ingest is about 3.3-3.6x the reported CPU per item and about 2x the memory (the finding said
  4.3x and missed memory). Scale decisions quoting this bench understated both, and finding R2-8 needs a true
  figure.
- **Fix.** Add a `shipped` line driven through `ContextPartner` with `DEFAULT_CONFIG` and no model deps, so it
  follows future `onStored` changes; keep today's line as `core`; report per-stage us/item and B/item, and a separate
  line with raw items released.
- **Status.** R2-P8.

#### R2-6. `devloop-funnel-grouped-shards`: `bun run funnel` runs one process at `--time 0` (medium, S)

- **Evidence.** `defaultJobs` returns 1 at `--time 0` (packages/sim/src/lab/funnel-merge.ts:17-19); `--jobs N`
  starts one hidden-funnel.ts process per suite x seed shard (12 on train; funnel.ts:213, 255-260). Verifier runs on
  4 cores under load: default 31.2-33.5 s wall, 39-41 s CPU; four hand-grouped processes (3 suites x 1 seed) 14.2-19.0
  s wall, about 50 s CPU; `--jobs 4` 23.0-35.2 s wall, 68-72 s CPU. perTask rows without timing fields: 768 of 768
  identical.
- **Impact.** Each funnel screen 1.6-2.4x faster in wall; about 1.35x less CPU than `--jobs 4`. It costs about 1.3x
  the CPU of one process, and ms/task becomes a contended figure.
- **Fix.** Decided in D139. Default jobs at `--time 0` to min(shards, cores), each job a contiguous group of shards;
  keep one shard per process at `--time > 0` and when `soloReasons` apply. `mergeShards` must read each row's own
  suite and seed (it assumes one suite per part today, funnel.ts ~333-351). Label ms/task CONTENDED (funnel.ts:363);
  LAB.md says latency comes from `--jobs 1`.
- **Status.** R2-P5.

#### R2-7. `devloop-fresh-worktree-caches`: every new worktree pays a cold format check and type check (medium, S)

- **Evidence.** scripts/format.sh:18 keeps Prettier's cache in `node_modules/.cache/prettier/.prettier-cache`,
  keyed by absolute path (389 entries under `/home/user/Eden/`); scripts/typecheck.sh:39 keeps tsc's buildinfo in
  `node_modules/.cache/tsc` per checkout. In a fresh worktree: format:check 14.0-14.8 s cold, 4.8 s warm; typecheck
  11.5-16.5 s cold, 5.9 s warm. Copying the main checkout's cache: typecheck 3.8-3.9 s (tsc's paths are relative),
  format:check unchanged at 13.5-18.3 s. deep-audit SKILL.md:36,57 gives every fixer, reviewer and integrator a new
  worktree.
- **Impact.** First format plus type check in a new worktree 30.5 s -> about 8.7 s (3.5x, verifier). The whole first
  `bun run check` was estimated 1.47x and not re-run.
- **Fix.** format.sh: a set of known-formatted (path, content hash) pairs under the git common dir, keyed by
  Prettier's version and the hashes of .prettierrc.json, .prettierignore and .editorconfig; hash the working tree
  (`git hash-object`), not the index; write atomically (temp file and rename); call Prettier only on unknown files
  and not at all when none are left. Line length stays uncached unless its key includes the hash of
  check-line-length.ts. typecheck.sh: copy (not link) the main worktree's tsc cache when missing. `CHECK_COLD=1`
  bypasses both.
- **Status.** R2-P6.

#### R2-8. `scale-graph-dominates-ingest`: the knowledge graph is most of ingest CPU and memory, with no $0 gain (medium, M)

- **Evidence.** `graph: true` (config.ts:514); `put` calls `graphOf(u, now)?.add(item, now)` on every new or changed
  item (cache.ts:654). `bun packages/sim/src/lab/graph-memory.ts` (20 users x 2,000 items): put 41-45 -> 99-105
  us/item, heap per user 2.68-2.69 -> 3.90-3.91 MB. Funnel default vs `--preset minus-graph --baseline`: hidden 214
  -> 215 of 384, decoys 211 -> 211, pool hidden 230 -> 226; task by task +3/-2 hidden, +2/-2 decoys. `bun run eval`
  with and without graph: 0.828 / 0.48 / 0 both. Not re-run by a verifier: the scratch stage bench (6x on put) and
  the concurrent.bench and storm profiles.
- **Impact.** Ingest CPU about 2.0-2.3x and memory 1.45x per user (realistic), 2.07x (bench workload). Ingest is
  background work, so this matters at scale and in cold-start storms. The $0 screens use a stub reader, so they
  cannot show whether the graph's extra pool items become reader wins; D58's gain was measured with the reader off.
- **Fix.** Stage 1 (paid, about $0.3 estimated, inside the run's budget): a live-reader funnel, default against
  minus-graph, through the spend ledger with the cap, plus quality-cli with and without the graph. The package writes
  the result and a proposed decision (D141): remove the graph from the default under D112 if neutral, or keep it.
  Stage 2 if it stays: extract only headers and the first ~1,000 characters.
- **Status.** R2-P8 (measurement and decision proposal). Deleting the code, if decided, is deferred to round 3.

#### R2-9. `mem-conflict-analysis-weakmap`: round 1's analysis cache keeps 6.5-8.6 KB per assessed item (medium, M)

- **Evidence.** `ANALYSES = new WeakMap<ContextItem, AnalysisEntry>()` (conflict.ts:543), filled from `assess`
  (:334-343); each entry keeps `whole`, every lowered statement and about 5 mark arrays per statement (:376-387,
  :525-537). Verifier micro-benches: 7,743-8,598 B per item (4.7-4.8x the text); 99.93% of mark arrays empty; first
  pass 1,793-1,899 ms, second 190-289 ms. pipeline.bench (2,000 events) heap: cache on 55.8-57.5 MB, bypassed
  57.5-58.8 MB, so the claimed +12-17% did not reproduce.
- **Impact.** Bounded by item lifetime and the cache's item limits, not by session length. A constant multiplier on
  the items actually assessed (about 200 per 2,000 events).
- **Fix.** Decided in D136: one shared frozen empty array for empty marks (verifier: 8,598 -> 3,956 B/item, 2.17x,
  second pass 119-154 ms); optionally drop `whole` once refs are read. No byte cap, no statement dropping.
- **Status.** R2-P4 (shared empty array). The rest: rejected, D136.

#### R2-10. `cost-intent-requests-keyword-output`: ask the cards role for keywords instead of sentences (medium, M; rejected)

- **Evidence.** Requests are used only as stemmed terms (intent.ts:64-74, :106-109; partner.ts:4365). Ledger
  (.local/mkt/ledger.jsonl): eden.cards 5,158 calls, 625 output tokens, $0.000445 per call, $2.298 total. Funnel with
  intent-v2 rewritten to distinct content words: 244/229 surfaced against 243/228.
- **Impact.** The 1.53x is a ratio of request characters, not of output tokens. On the committed intent-v2 replay a
  keyword block is 1.22x fewer tokens per item, so a call would fall an estimated 1.06-1.13x (arithmetic in D137),
  under the trial's own 1.25x bar.
- **Status.** Rejected, D137.

#### R2-11. `r2-results-cache-dead-weight`: remove the fan-out results cache (low, S; rejected)

- **Evidence.** 1 hit in about 860 lookups across eval, funnel and quality-cli; turning it off changes no output.
  But the harnesses never repeat a key: the eval builds a new partner per scenario (packages/eval/src/run.ts:188),
  funnel tasks are one-shot, and stale-on-failure needs a cached key to fire.
- **Status.** Rejected, D135. Reopen with a multi-turn replay hit counter and outages injected after warm-up.

#### R2-12. `holds-tenant-cap-drops-early`: past ~33 deletions/s per tenant, holds expire after 2-4 minutes (low, S)

- **Evidence.** `MAX_HOLDS_PER_TENANT` 20,000 (cache.ts:327) evicts the least recently held user's oldest hold,
  expired or not (cache.ts:334-401); `GONE_HOLD_MS` is 10 minutes (partner.ts:5032). Two verifiers' scratch runs of
  `TenantHolds`: 10,000 users x 5 removals over 10 minutes leaves 20,000 held; survival by age falls from 1.00 at 0-1
  minute to 0.32 (one verifier) or 0.00 (the other) at 4 minutes. 10,000 users x 2 (33.3/s): all held. Heap per hold
  101-290 B.
- **Impact.** A tail risk for very large, deletion-heavy tenants: a source index lagging more than a few minutes can
  store a deleted item back. Not on main yet (round 1 code).
- **Fix.** Raise the tenant cap to 100,000 (covers about 167/s for 10 minutes; an estimated 10-29 MB per tenant at
  the measured bytes per hold), evict expired holds tenant-wide before live ones, and count early evictions
  (`freshness.holdsEvicted`). Test: 10,000 users x 5 removals within the window all held; heap per hold <= 600 B.
- **Status.** R2-P3.

#### R2-13. `d133-no-decision-row`: D133 cited by code and docs but missing from DECISIONS.md (low, S)

- **Evidence.** `grep -c '^| D133 ' docs/DECISIONS.md` was 0 on 006b1694b; D133 is cited at sync.ts:301,
  cache.ts:40, partner.ts (4 places), freshness.test.ts:286 and ARCHITECTURE.md:162.
- **Fix.** The row, with the evidence from commit c9ee1f304's message and this round's re-run on 006b1694b
  (`bun packages/eval/src/cli.ts`: precision 0.8276, recall 0.48, falseFireRate 0;
  `bun test packages/engine/src/freshness.test.ts`: 15 pass, 0 fail), and the joined-flight caveat (R2-2).
- **Status.** Fixed in this commit (D133).

#### R2-14. `docs-eval-live-uncapped`: the documented `bun run eval --live` exits 2 since D128 (low, S)

- **Evidence.** On the integration branch packages/eval/src/cli.ts:35-36 refuses `--live` without `--usd-cap`
  (exit 2 through `fail`, :25). Bare `eval --live` remains in CLAUDE.md:51, README.md:25, .claude/commands/eval.md:6,
  docs/research/econ-synthesis.md:150,189, docs/research/live-judge.md:77 and docs/research/model-calls.md:52. Only
  packages/eval/CLAUDE.md has the new form.
- **Impact.** The merge-gate instruction is wrong; the error is loud and suggests a cap, so nothing fails silently.
- **Fix.** `bun run eval --live --usd-cap 0.05` in CLAUDE.md, README.md and the /eval command (D125 recorded $0.0147
  for a live eval); `--live --judge --usd-cap 0.05` where the old judge shape is meant; annotate, do not rewrite,
  dated research notes and the D43/D125 rows. `--ask-model` (model-calls.md:52) is parsed by neither cli.ts: mark it
  stale.
- **Status.** R2-P7. Must reach main together with D128 (main's cli.ts has no `--usd-cap`).

#### R2-15. `devloop-round1-tests-sleep`: round 1 added about 6.6 s of test time (low, S)

- **Evidence.** junit per-file sums: main 88.7 s, integration 95.2-95.3 s (1,536 -> 1,588 tests). Integration
  per-test: sim.test.ts "user-range tallies merge" 5.8-6.4 s; review-regressions.test.ts's `queue` helper
  `await Bun.sleep(1_500)` (:384), called by two tests (1.51 s each); sources/regressions.test.ts's 200,000-page heap
  test 2.3-2.4 s; eval run.test "the cap is hard" 1.2-1.3 s.
- **Impact.** An estimated 1.5-1.8 s of wall per full `bun run test` (the suite is throughput-bound: about 6.5 s of
  sum over 4 cores) and about 3 s on every engine `test:changed`; sim.test.ts (9.3 s) sets `test:pkg sim`'s critical
  path. Full-suite wall noise was about 4 s, so the full-suite gain is not separately measured.
- **Fix.**
  - Replace the sleep with a held promise, as slow-path-queue.test.ts:20-58 does (a verifier's polling version took
    the file from 4.00 to 1.63 s).
  - Heap test: more than 60,000 pages, or a larger simulated step, so it still passes the 600 s expiry and the byte
    budget. A verifier's 50,000-page run took 0.6 s and still failed on the pre-fix guarded.ts, but no longer reached
    the expiry.
  - Sim shard test: 2 users x 2 sessions (verifier: 3.9-4.6 s; the finding's < 2 s target is not reachable because
    each run has a large fixed cost).
- **Status.** R2-P7. Target: junit sum at most 90 s; TESTING.md updated with measured numbers.

#### R2-16. `cold-user-sources-on-path`: warm a cold user's sources before the first lookup (low, M; rejected)

- **Evidence.** partner.ts:2678 awaits `deps.sources` with no deadline; user-sources.ts:237 waits up to
  `directoryTimeoutMs` 5,000; McpSource connects inside its first search (mcp-source.ts:125-196). A scratch McpSource
  over stdio: first search 125-185 ms, later 0.8-2.3 ms.
- **Status.** Rejected, D138: the shipped directory is a file, the connect already runs inside the 1,500 ms source
  timeout, no whole first-lookup time was measured, and warming every session costs a connection per user.

### Round 2 tally

| Severity (after verification) | Findings | Of which                                                         |
| ----------------------------- | -------: | ---------------------------------------------------------------- |
| High                          |        1 | R2-1                                                             |
| Medium                        |        9 | R2-2 to R2-10 (R2-10 rejected)                                   |
| Low                           |        6 | R2-11 to R2-16 (R2-11 and R2-16 rejected; R2-13 fixed in commit) |

- 12 findings packaged into R2-P1 to R2-P8; 2 of them only in part (R2-3, R2-9).
- 3 rejected with decisions: D135, D137, D138. Parts of R2-3 and R2-9 rejected: D134, D136.
- 1 fixed in this commit: R2-13 (D133).
- Decisions written this round: D133 to D140. D141 (R2-P8's graph verdict) is now written in docs/DECISIONS.md; D142
  is the big-pages package's (`lc-sync-big-pages`), written at integration with its trial row. Fixers do not edit docs/DECISIONS.md; a proposed row goes in the commit message under `Decision row:`.

## Work packages (round 2)

No two packages share a file. Each starts from `audit/2026-11-05-integration` at the commit that carries this
report, commits on its own branch, and ends with `bun run check` green. A package that changes engine behaviour
pastes `bun run eval` JSON before and after. A behaviour change comes with a test that fails before it.

| Package                       | Findings     | Files                                                                                                                                                                                                                                                                               |
| ----------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R2-P1 `engine-fresh-ask`      | R2-1, 3, 4   | packages/engine/src/partner.ts, packages/engine/src/sync.ts, packages/engine/src/freshness.test.ts, packages/engine/src/ask-deadline.test.ts (new), docs/research/freshness.md, docs/ARCHITECTURE.md, packages/engine/CLAUDE.md                                                     |
| R2-P2 `fanout-joined-flights` | R2-2         | packages/sources/src/guarded.ts, packages/sources/src/joined-flight.test.ts (new), packages/engine/src/joined-flight.test.ts (new), packages/sources/CLAUDE.md                                                                                                                      |
| R2-P3 `tenant-holds-cap`      | R2-12        | packages/engine/src/cache.ts, packages/engine/src/cache.test.ts                                                                                                                                                                                                                     |
| R2-P4 `conflict-empty-marks`  | R2-9         | packages/engine/src/conflict.ts, packages/engine/src/conflict.test.ts                                                                                                                                                                                                               |
| R2-P5 `funnel-grouped-shards` | R2-6         | packages/sim/src/lab/funnel.ts, packages/sim/src/lab/funnel-merge.ts, packages/sim/src/lab/funnel-merge.test.ts, packages/sim/src/lab/CLAUDE.md, docs/LAB.md                                                                                                                        |
| R2-P6 `worktree-check-caches` | R2-7         | scripts/format.sh, scripts/typecheck.sh, scripts/check-line-length.ts (only if it joins the shared set), .claude/skills/deep-audit/SKILL.md                                                                                                                                         |
| R2-P7 `devloop-tests-docs`    | R2-14, R2-15 | CLAUDE.md, README.md, .claude/commands/eval.md, docs/research/econ-synthesis.md, docs/research/live-judge.md, docs/research/model-calls.md, packages/engine/src/review-regressions.test.ts, packages/sim/src/sim.test.ts, packages/sources/src/regressions.test.ts, docs/TESTING.md |
| R2-P8 `graph-ablation`        | R2-5, R2-8   | packages/engine/bench/ingest.bench.ts, docs/research/graph-ablation.md (new), docs/research/INDEX.md, docs/COST-MODEL.md                                                                                                                                                            |

Plans and acceptance checks (the run's structured output has the same):

- **R2-P1.** An `isHeldGone` check before `revive` in `recheck`; `checkAhead` below the empty-pool and `readerGate`
  returns (D134); one `deadlineAt` before the poll, shared by poll, search and probes, and no re-poll of a source
  whose poll timed out within `sourceTimeoutMs` (D140). Acceptance:
  - freshness.test.ts: the removal-during-re-read repro fails before and passes after;
  - a gated-ask test: zero `fetch` calls on a doubted pool item when the gate returns;
  - ask-deadline.test.ts: a source whose list and search both hang; the ask's time before the reader is under
    `sourceTimeoutMs` + 250 ms (about 3 s before);
  - `bun run eval` precision 0.8276, recall 0.48, falseFireRate 0; `bun run funnel -- --ask` counts unchanged
    (otherwise the deadline goes behind `askSharedDeadline`, D140); quality-cli `--push signals` staleDelivered and
    deletedDelivered not worse.
- **R2-P2.** A flight started before its pair's latest `dropResults` (or the fan-out-wide drop epoch) is not
  joinable, in `one()` and `planCalls`. Acceptance:
  - sources joined-flight.test.ts: leader starts, `dropResults`, a second caller gets the new text and the connector
    sees 2 calls; with no drop in between the second caller still joins (1 call);
  - engine joined-flight.test.ts: the s1/s2 repro; s2 does not deliver Lisbon, and a later ask fetches and answers
    Porto;
  - `bun run eval` and `bun run funnel` unchanged.
- **R2-P3.** Tenant cap 100,000; tenant-wide expired-first eviction; a `freshness.holdsEvicted` counter. Acceptance:
  cache.test.ts 10,000 users x 5 removals within the window all held; heap per hold <= 600 B; an isolation test for
  the counter; round 1's 25,000-id and ghost-user tests still pass.
- **R2-P4.** One frozen shared empty array for empty marks (D136). Acceptance: verdicts identical on the
  conflict.test.ts fixtures and a test that empty marks share one frozen array; a scratch heap measure under 4.5 KB
  per assessed item (from about 8.6 KB); pipeline.bench ms/event within 10% of before on the same machine; eval and
  funnel identical.
- **R2-P5.** Grouped shards at `--time 0` (D139); `mergeShards` keyed by each row's suite and seed. Acceptance:
  funnel-merge.test.ts covers a group spanning suites; `bun run funnel` perTask rows without timing equal
  `bun run funnel --jobs 1`'s; three timed runs per arm; LAB.md and the comments at funnel-merge.ts:15 and
  funnel.ts:20-22 say ms/task is contended and `--jobs 1` gives latency.
- **R2-P6.** Shared formatted set and tsc seed. Acceptance: in a fresh worktree the first `bun run format:check` and
  `bun run typecheck` together take under 10 s (from about 30 s), three runs; a planted misformatted file and an
  overlong comment are still caught; `CHECK_COLD=1` ignores both caches; two worktrees running format:check at once
  leave a readable set.
- **R2-P7.** Docs and test time. Acceptance: `grep -rn 'eval --live' CLAUDE.md README.md .claude/commands` shows only
  `--usd-cap` forms; the held promise replaces the sleep; the heap test still fails against the pre-round-1
  guarded.ts; junit per-file sum at most 90 s (`./scripts/test.sh --reporter=junit`), and TESTING.md updated from
  that run.
- **R2-P8.** ingest.bench `core` and `shipped` lines, then the paid graph ablation. Acceptance: ingest.bench prints
  both lines with per-stage us/item and B/item; the paid funnel uses `--spend-ledger .local/mkt/ledger.jsonl
--spend-cap 25 --spend-headroom 0.3` with Haiku 5.5 and costs under $1 (ledger delta reported); graph-ablation.md
  gives default vs minus-graph hidden and decoys task by task, quality-cli with and without the graph,
  graph-memory.ts, and a D141 row to propose (remove under D112 if neutral at no extra paid cost, else keep and plan
  Stage 2). D141 is now written: keep.

## Deferred (round 2)

| Item                                                            | Why                                                                                                                 |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Deleting the graph's code (R2-8)                                | Rejected by D141: the graph stays in the default (+4 hidden, +2 decoys of 384 on the paid funnel).                  |
| Graph Stage 2, lighter extraction (R2-8)                        | D141 keeps the graph; Stage 2 is its recorded next step, the `graphLite` trial (gate in D141), not yet built.       |
| Starting re-reads when the reader's stream names an item (R2-3) | Needs reader-stream plumbing in partner.ts (held by R2-P1) and a live latency run; D134 keeps the count until then. |
| A cheaper endpoint for intent-only card items (R2-10, Stage 2)  | An owner decision under D12/D98 about a new model endpoint: external.                                               |

## Where everything is

- This file: `docs/audits/2026-11-05-deep-audit.md`.
- Decisions D127-D132 (round 1) and D133-D140 (round 2): `docs/DECISIONS.md`.
- Integration branch: `audit/2026-11-05-integration`, branched from main 6911f514d.

## Closing the run (loose ends)

Checked on `audit/2026-11-05-integration` at 7d10b8ae3: every `audit/2026-11-05-*` branch is merged into it. Every
item this run deferred or left to a decision, with its final status and where it is recorded:

| Item (finding id) | Final status | Recorded in | Next step |
| --- | --- | --- | --- |
| `sync-sweep-backfill-big-pages` (14) | Built behind a trial (D142), measured, deleted (D143): not neutral (reader-screen pool 230/229 to 228/228 at $0; a reproducible -2 hidden of 384 on the paid reader), from the ask's tie order among equal-score candidates following ingest order | D142, D143; docs/research/econ-background.md | Reopen only with a measured, ingest-order-independent tie-break for equal-score ask candidates (D143) |
| `painpoint-prod-reader-unmeasured` (4), stage 1: paid timing of the shipped reader | Blocked externally. The $0 part (the reader's first failure logged once per process, `readerFailureLog` in packages/server/src/build.ts) shipped in round 1 | This file, finding 4 and "Deferred" | This environment's OpenRouter key gets 403 "violation of provider Terms Of Service" for Anthropic models, and the lab `SpendLedger` meters only `claude-*` ids. The owner supplies a key OpenRouter serves for `anthropic/claude-haiku-5.5`; then a ledger entry type for OpenRouter ids before any reader timing run |
| `eval-live-measures-unshipped` (3): the paid `--live` run | Wiring fixed (D128); the paid run is blocked externally (same key block) | D128 | With a served key: `bun run eval --live --usd-cap 0.05` (D128) |
| `quality-reader-veto-rule-path` (16): the by-name veto screen | Broad veto rejected (D130); the by-name screen is blocked externally (same key block) | D130 | Run after the live reader eval above, as D130 says |
| `quality-reader-ceiling-gated` (15) | Rejected | D129 | None |
| `fresh-per-ref-signals` (17) | Rejected | D131 | None |
| `devloop-agent-replay-identical-eden` (18) | Rejected as proposed; open with the Hermes request-replay item (audit 2026-11-04, section 5) | D132 | That Hermes request-replay item |
| `fresh-readat-race` (11), exact per-copy variant | Closed: read marks are stored per copy (`ItemCache.put`'s `readMark`, `Entry.readMark`) | D133 | None |
| `d133-no-decision-row` (R2-13) | Closed: the D133 row is written | D133, commit 463f6fdfc | None |
| `scale-graph-dominates-ingest` (R2-8): deleting the graph's code | Rejected: the graph stays in the default | D141 | None |
| `scale-graph-dominates-ingest` (R2-8): Stage 2, a lighter graph | Off for now | D141 | The `graphLite` trial (owner: repo owner, ends 2026-12-17): `ingest.bench.ts` `+graph` stage at least 2x cheaper per item and the 5 pool tasks of docs/research/graph-ablation.md still in the pool on the $0 stub screen (`bun run funnel --json F` against `--baseline`); a loss goes back to the paid screen. Trials-table row added with the switch |
| `fresh-checkahead-speculative-rereads` (R2-3), stage 2 | `VERIFY_AHEAD` stays 3; re-reads start only once the reader is called | D134 | Starting re-reads when the reader's stream names an item needs reader-stream plumbing and a live latency run (paid, same key block) |
| `cost-intent-requests-keyword-output` (R2-10) | Rejected | D137 | A cheaper endpoint for intent-only card items is an owner decision under D12/D98 (external) |
| `r2-results-cache-dead-weight` (R2-11) | Rejected: the results cache stays | D135 | None |
| `cold-user-sources-on-path` (R2-16) | Rejected | D138 | None |
| `mem-conflict-analysis-weakmap` (R2-9) | WeakMap kept, shared frozen empty array shipped (R2-P4); byte cap rejected | D136 | None |

The run added no `TODO`/`FIXME`. It added one `EngineConfig` key, `syncBigPageSize` (D142, a trial), and D143
deleted it with its code and tests, so the run ends with no new key. The 41 stale `origin/claude/r10-*` remote
branches and the Hermes live check of the default (owner approval for a checkout) stay open from the 2026-11-04
audit.

Checked again at cf59967f1 (before D143): every `audit/2026-11-05-*` branch is merged (`git branch --no-merged
audit/2026-11-05-integration` lists none), no `TODO`/`FIXME` added, `bun run check` green twice (1639 pass), and
no named preset beats the default (presets are only `default` and `minus-<part>`; D141 measured `minus-graph`
worse).
