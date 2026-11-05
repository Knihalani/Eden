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

## Where everything is

- This file: `docs/audits/2026-11-05-deep-audit.md`.
- Decisions D127-D132: `docs/DECISIONS.md`.
- Integration branch: `audit/2026-11-05-integration`, branched from main 6911f514d.
