# Deep audit: 3x-and-bigger levers (2026-11-03b)

The second deep audit of 2026-11-03, run with the revised `/deep-audit` skill: security is out of scope (use
`/security-review` for that), and the six finders hunted for improvements of 3x or more in cost, latency, quality,
scale and the dev loop, plus first-principles redesigns ("moonshots"), correctness bugs and pain points. Every
finding below survived two adversarial verifiers. Numbers are labelled: "measured" means a command run in this audit
(named in the finding); "estimate" means arithmetic, shown. No paid model call was made.

## Summary in plain language

Written for the repo owner. Three terms: the **reader** is Eden's one model call that reads the user's request and
picks the facts that matter; **ALL3** is the recommended no-model lab setting, and **NEW** is ALL3 plus the reader
(the recommended experimental setting, D98). Everything below is off by default in production unless it says so.

**The single biggest measured lever is a flag that already exists.** At realistic connector latency, 91% of Eden's
time on a request is spent waiting for an on-demand sync poll of the user's sources. Turning on `syncPollBehind`
(answer from the warm copy, poll behind) cut Eden's time per task 11.4x (414 ms to 36 ms) with identical deliveries
on the no-model screen. It was left untested on its own in D72. The lab's live agent benchmarks hide this cost
completely, because they run connectors at 0 ms; their "Eden on the critical path" numbers understate realistic
latency by about 14-22x for ALL3 (estimate across harnesses; 33x within one harness, measured).

**Other measured or near-measured 3x+ levers:**
- **Dev loop.** Typing `bun test` at the root runs 530 archived test files: 215 s and 487 false failures instead of
  about 31 s green (7x, measured). One line in bunfig.toml fixes it.
- **Dev loop.** The NEW family cannot be screened without paying for reader calls. A stub reader that reports
  whether the planted fact reached the reader's pool would make every change upstream of the reader screenable in
  about 20 s for $0 (estimate: about 60x faster than a live screen, which costs about $0.3-0.5).
- **Request path.** On-demand sync polls list 100 items to find the 5 or fewer that changed (about 20x over-read).
- **Memory.** Expired items and idle users are never freed until that user writes again; with an expiry sweep,
  resident memory tracks active users instead of every user seen since restart (5-10x, estimate, depends on the
  share of idle users).
- **Cost (NEW only).** The intent index sends 16.9x more items (6.1x more calls) to the background model under NEW
  (measured). That is about half of NEW's per-user model bill (estimate), but whether NEW needs it with the reader on
  has never been measured, and measuring it needs paid reader calls.

**Bugs and pain points worth fixing now:** a user message that arrives while the slow path is busy is silently
dropped; dates without a time zone are read in the server's local zone; the client SDK hides the server's error
text and the user-id rules are undocumented (5 of 6 common misconfigurations look exactly like Eden staying silent);
the shipped server cannot load the measured configuration without code.

**Ambitious redesigns that were checked and did not hold up as 3x wins on today's evidence:** letting the agent's
own model do the reading (a wide no-model packet loses an estimated 25-35 points of hidden facts on Hermes), a
distilled local reader (the repo already rejected this twice; unproven), moving the reader's wait to the agent's
answer (about 2x on measured mixes, not 3x), compressed text plus a cold tier (under 2x for active users), a compact
knowledge graph (1.2-1.9x), a test-result cache (about 1.4x over today's `check:fast`, and it would skip a privacy
guard test as written), item-level reader replay (would erase the effects it is meant to screen). Each is recorded
below with what would make it worth doing.

**What happens next.** Eight work packages go to parallel fixers (Round 1 below). Twelve findings, plus the MCP half
of a thirteenth, are deferred: seven of these items need a decision from you (listed with the decision); the rest
are sequenced behind round 1 or need rework.

**Round 2.** After round 1 merged, a full re-audit verified 24 more findings. Six packages are dispatched, and
nine findings (plus the default-flip stages of four packaged ones) are deferred. See "Round 2" at the end.

## Scoreboard

| Dimension | Verified | Packaged in round 1 | Deferred |
|---|---|---|---|
| Latency | 6 | 4 (`lat-sync-poll-on-critical-path`, `lat-lab-hides-connector-latency`, `gate-cold-compile-on-live-traffic`, `lat-reader-faster-endpoint-no-reasoning` Stage 1) | 2 |
| Scale and memory | 5 | 2 (`scale-idle-users-never-freed`, `sync-poll-page-overread`) | 3 |
| Dev loop | 4 | 2 (`bare-bun-test-runs-archived`, `devloop-oracle-reader-free-new-screens`) | 2 |
| Quality and correctness | 3 | 2 (`slow-path-busy-drops-cue`, `corr-tz-local-date-parse`) | 1 |
| Pain points | 2 | 2 (`sdk-silent-misconfig-and-id-rules`, `integrator-server-...` in part) | 0 |
| Cost | 1 | 0 | 1 |
| Moonshots | 3 | $0 diagnostics of 2 folded into a lab package | 3 |
| **Total** | **24** | **12** (+ 2 partial diagnostics) | **12** |

The "Deferred" column counts a finding as deferred when its main fix waits; a $0 diagnostic half may still ship in
round 1 (noted per finding). Severities are the verified ones; verifiers lowered several from high to medium.

## Findings, ranked by value

Ranked by severity, then effort, then measured size of the gain. "Clears 3x?" says whether the verified gain (not
the finder's first claim) reaches the user's 3x bar.

| # | ID | Sev | Effort | Clears 3x? | Status |
|---|---|---|---|---|---|
| 1 | lat-sync-poll-on-critical-path | medium | S | yes, 11.4x measured (no-model) | round 1 `lab-connector-latency` |
| 2 | bare-bun-test-runs-archived | medium | S | yes, 6.6-7.0x measured | round 1 `bunfig-ignore-archived` |
| 3 | sync-poll-page-overread | medium | S | yes on items listed (about 20x, inferred) | round 1 `engine-request-path` |
| 4 | scale-idle-users-never-freed | medium | S | estimate (1/f idle share) | round 1 `cache-expiry-and-dates` |
| 5 | lat-lab-hides-connector-latency | medium | S | yes, 33x within harness | round 1 `lab-connector-latency` |
| 6 | cost-intent-in-new-background | medium | S | 16.9x items; about 2x whole bill | deferred: paid run, decision |
| 7 | sdk-silent-misconfig-and-id-rules | medium | S | n/a (pain point) | round 1 `sdk-errors-and-ids` |
| 8 | slow-path-busy-drops-cue | medium | S | n/a (quality bug) | round 1 `engine-request-path` |
| 9 | devloop-oracle-reader-free-new-screens | medium | M | yes, estimate (about 60x) | round 1 `lab-reader-stub` |
| 10 | quality-reader-pool-universe | medium | M | 6x on retrieval; 2.4x end to end (est.) | deferred: round 2 |
| 11 | integrator-server-cannot-run-real-sources-... | medium | M | n/a (pain point) | round 1 `server-startup-config` (part) |
| 12 | lat-draft-speculative-read | medium | M | unproven (low confidence) | Stage 1 in `lab-reader-stub` |
| 13 | lat-ask-waits-poll | medium | M | tail only, about 4.3x p95 (est.) | deferred: decision (D65) |
| 14 | moon-agent-is-the-reader | medium | M | no: quality regression likely | Stage 1 diag in `lab-reader-stub` |
| 15 | lat-reader-faster-endpoint-no-reasoning | medium | M | no (1.9-2.9x at best) | round 1 `reader-reasoning-option` (Stage 1) |
| 16 | scale-compressed-text-cold-tier | medium | M | no as written (<2x hot) | deferred: rework |
| 17 | graph-memory-and-ingest | medium | M | no (1.2-1.9x) | deferred: decision (D63) |
| 18 | devloop-test-closure-cache | medium | M | no (about 1.4x over `check:fast`) | deferred: decision |
| 19 | devloop-reader-replay-item-level-key | medium | M | no as written | deferred: rework |
| 20 | lat-answer-gate-not-start-gate | medium | L | no on measured mix (about 2x) | deferred: design, round 2 |
| 21 | moonshot-distilled-reader | medium | L | unproven | deferred: decision |
| 22 | gate-cold-compile-on-live-traffic | low | S | yes on first event, 3x measured | round 1 `server-startup-config` |
| 23 | ingest-skip-unchanged-redaction | low | S | yes on the sub-part, 8-10x measured | deferred: round 2 (shared files) |
| 24 | corr-tz-local-date-parse | low | S | n/a (correctness) | round 1 `cache-expiry-and-dates` |

### 1. At realistic connector latency the sync poll is 91% of Eden's critical path (medium, S)

- **Evidence.** `searchLive` awaits the on-demand poll unless `behind` (packages/engine/src/partner.ts:3122-3134);
  defaults `syncOnDemand` true, `syncPollBehind` false (packages/engine/src/config.ts:705-706); ALL3 does not set it
  (packages/sim/src/lab/presets.ts:28-43). Measured by both verifiers, train1 seed 41, ALL3, `-- --time 1`:
  `bun run funnel --suite train1 --seeds 41 --json base.json -- --time 1 --timeline T`, then the same with
  `--set '{"syncPollBehind":true}' --baseline base.json`: ms/task 414.2-414.5 → 36.4-36.9, hidden 22/32 and decoys
  22/32 both ways, "hidden +0 −0, decoys +0 −0". timeline-report: critical path p95 897 → 234 ms, sync.freshen
  self time 91.6% of it; observe p95 809 → 109 ms; slow-path p50 450 → 4.6 ms.
- **Impact.** Eden time per task 11.4x lower, measured, no model. Caveats: one task's "returned" changed (1/1 → 0/1);
  D72's ALL2 (which bundled this flag) matched on the no-model funnel yet lost −0.042 hidden live on blind suites;
  the flag departs from D57/D40 (a warm stale copy can answer first, corrected on the next request), which the
  static sim worlds never exercise. Not new: D72 left "syncPollBehind alone" to a fresh pre-registered run.
- **Fix.** Stage 1 ($0): run the full train screen (train1-6, seeds 41-42, `-- --time 1`) with and without the flag
  and record the task-by-task diff; add presets `ALL3B` and `NEWB` (NEW is the recommended configuration, D98) with
  `syncPollBehind`. Stage 2 (paid, deferred): the pre-registered blind live run D72 left open. Production defaults
  unchanged until a decision row.
- **Status.** Stage 1 in round 1 package `lab-connector-latency`; Stage 2 deferred (needs owner-approved spend).

### 2. Bare `bun test` at the root runs archived/: 215 s and 487 false failures (medium, S)

- **Evidence.** bunfig.toml:1-4 sets only `preload` under `[test]`; scripts/test.sh:21-26 finds test files only
  under packages/, examples/ and scripts/; 530 `*.test.ts` under archived/. Measured on Bun 1.4.4: `bun test` at
  the root, 4,290 pass, 487 fail, 306 errors, 687 files, 215.5 s, exit 1. With
  `pathIgnorePatterns = ["archived/**", "**/node_modules/**"]` in a temporary bunfig: 1,362 pass, 0 fail,
  102 files, 30.8-32.6 s.
- **Impact.** 6.6-7.0x faster (measured) and 487 false failures → 0 for any agent that types `bun test`. The 14.2x
  first claimed needs `--parallel` as well. Not verified on the pinned Bun 1.3.13 (package.json:4).
- **Fix.** Add the key; check it on 1.3.13 if available, else document the minimum Bun version; a TESTING.md note.
  Drop the finder's "750,035 expects" note (a verifier counted 1,111,899 in total; re-measure before writing).
- **Status.** Round 1 package `bunfig-ignore-archived`.

### 3. On-demand sync polls list 100 items to find the 5 or fewer that changed (medium, S)

- **Evidence.** `poll` (packages/engine/src/sync.ts:560-604) lists pages of `this.o.pageSize` and stops at the first
  page holding a known, unchanged item (:593); backfill (:478), poll (:575) and sweep (:635) share `syncPageSize`
  100 (config.ts:697); `freshen` (:341-361) runs on the lookup's path with `syncCatchupPages` 2 (config.ts:707).
  Measured (`bun run funnel --jobs 4`): default demand polls 2,048, backfill 432, 214/211; `syncPageSize` 5: demand
  2,041, backfill 7,401, 214/211. Each listed item is sanitized before the boundary check
  (packages/sources/src/guarded.ts:262), about 10.5 µs per item (measured, sim items).
- **Impact.** Items listed on the request path about 20x fewer (inferred from the unchanged demand-call count; the
  funnel has no listed-items counter, and the page-5 run also shrank backfill, so it is not a clean A/B). No
  latency gain measured: sim listing cost does not depend on page size. Real gain depends on the connector.
- **Fix.** Flag `syncPollPageSize` (default 0 = use `syncPageSize`), better an adaptive first page
  `clamp(ceil(2 * rate * hoursSinceLastPoll), 5, syncPageSize)` from the rate posterior (`s.alpha/s.beta`, :382),
  doubling while no boundary is found. Backfill and sweep keep `syncPageSize`. Add a listed-items counter.
- **Status.** Round 1 package `engine-request-path`.

### 4. Expired items and idle users stay resident until that user writes again (medium, S)

- **Evidence.** `ItemCache.sweep` (packages/engine/src/cache.ts:482) runs only from `put` (cache.ts:332) and only
  for that user. A user is dropped only by `touch` at `maxUsersPerTenant` 10,000 (cache.ts:221-229) or by `forget`.
  packages/server/src/build.ts:46 builds `new ItemCache()` with defaults; nothing caps memory across tenants.
  Measured by a verifier (scratch script): 20 users × 500 items = 32.5 MB heap; after another user's `put` 48 h
  later (past the 24 h `ttlMs`), heap stayed at 32.6 MB. Correction: sync already evicts synced items of users idle
  past 7 days (`SyncEngine.evict`, sync.ts:386-409), so what stays is lookup items (at most 2,000 per user) and
  empty shells.
- **Impact.** Estimate: resident memory falls by 1/f for an active fraction f (5x at f = 0.2), only if the process
  lives much longer than 24 h. Worst case about 70 GB per capped tenant (10,000 users × 7 MB). No measured f exists.
- **Fix.** `ItemCache.expireIdle(now)` walking users least-recently-written first (it can stop at the first user
  with a fresh item), dropping users whose newest item is past `ttlMs` and who hold no synced item within
  `syncTtlMs`, calling `dropped(scope, null)` (already routed to `cards.forget`, partner.ts:587). An unref'd timer
  owned by the cache, interval in `CacheLimits`. Stage 2 (process-wide byte cap) needs a decision; not in round 1.
- **Status.** Round 1 package `cache-expiry-and-dates`.

### 5. Pi/Hermes latency numbers come from instant connectors (medium, S)

- **Evidence.** packages/sim/src/lab/pi-ab.ts:150 and hermes-ab.ts:118 default `--time-scale` to 0; pi-ab.ts:56-57
  says sources run instantly. docs/research/haiku-phase3.md:134,142 reports ALL3 Eden critical path 30 ms (Pi) and
  19 ms (Hermes) with no label. The poll is on Pi's path: pi-ab.ts:636-637 awaits `partner.observe(..., {waitMs})`.
  Measured: the funnel at `-- --time 1` gives 414-416 ms/task, at `--time 0` 11.7-12.6 ms/task, same score.
- **Impact.** 33x within one harness (measured); 14-22x against the published Pi/Hermes numbers (estimate, across
  suites and harnesses). The "below 100 ms on the critical path" bar (haiku-phase3.md:60) is judged without the
  dominant cost.
- **Fix.** Default `--time-scale 1` in pi-ab and hermes-ab, print it in every results header, relabel the existing
  haiku-phase3 latency rows "connectors at 0 ms". Old and new tables are not comparable (tool conditions also get
  latency and errors), so the relabel is required. Adds wall time to paid runs, no extra model calls.
- **Status.** Round 1 package `lab-connector-latency`.

### 6. The intent index in NEW sends 16.9x more items to the background model (medium, S)

- **Evidence.** Measured, no model: `bun run funnel --jobs 4` (ALL3): card calls 300, items sent 2,113.
  `--preset NEW -- --reader replay --reader-cache <empty> --allow-misses`: calls 1,833, sent 35,702 (requestOnly
  33,589). NEW sets `intent` (presets.ts:56-61). Intent left packets unchanged without the reader
  (docs/research/haiku-opt.md:41-42) but added +33 hidden and +23 decoys on the ask path (haiku-opt.md:104-105).
  No NEW-minus-intent row exists.
- **Impact.** Estimate: about $0.075 per user backfill and $0.075 per user-month ongoing ($0.0000501 per item,
  docs/COST-MODEL.md:95; that row's own arithmetic gives $0.0000531, a 6% inconsistency to fix), about half of NEW's
  per-user bill, so dropping it saves about 2x on the whole bill (below 3x), 16.9x on background items.
- **Fix.** Stage 1: NEW vs NEW with `intent: false` on train with live reader calls (about $0.5), then a NEWX preset
  and a decision row if recall holds. Drop the finder's Stage 2 (intent only on `worthCardingStrict` items is in
  effect intent off). Stage 3 (batch endpoint) depends on D98's open provider decision.
- **Status.** Deferred. Decision needed: approve about $0.5 of live reader calls for the NEW-minus-intent screen.

### 7. SDK misconfiguration looks the same as Eden's normal silence (medium, S)

- **Evidence.** packages/client/src/client.ts:56-57 throws `eden ${path}: ${res.status}` and drops the body, which
  names the reason (packages/server/src/http.ts:95: "userId must be 1-128 characters of [A-Za-z0-9._:@-]");
  `onError` is optional with no default (client.ts:24-25). `isId` (packages/protocol/src/validate.ts:12) refuses
  `alice+work@x.com`, `chat/123` and `a b`; the rule is in neither docs/INTEGRATION.md nor README.md. Reproduced with
  a stub fetch: `observe` returned `{injection:null, pending:false}` and onError saw only "...: 400".
- **Impact.** Likely first-day integration failure with no signal. "5 of 6 setups" not re-verified.
- **Fix.** Within D14 (never throw) and packages/client/CLAUDE.md:17-18 (errors go to onError only): carry the
  server's `error` string (type-checked, length-capped) in the Error; validate ids in the constructor and report
  once through onError; a non-throwing `health()`; document the id rule; an injective `edenId(raw)` helper with a
  collision test. Not in round 1: a console.warn default (needs a decision amending the client rule) and a throwing
  `strict` mode (breaks D14).
- **Status.** Round 1 package `sdk-errors-and-ids`.

### 8. A user message that arrives while the slow path is busy is dropped (medium, S)

- **Evidence.** packages/engine/src/partner.ts:885-889: `if (s.inflight) { trace("silent", "slow path busy");
  return reply(queued); }` before any record of the cue. Reproduced by a verifier with a throwaway test (judge
  wrapped in a 300 ms sleep): the second message's cue was traced "slow path busy" and never looked up. No decision
  makes this deliberate (D47 covers probe slots).
- **Impact.** Any second cue-bearing message inside a slow-path window gets no context. Real-traffic size
  unmeasured; the funnel at `--time 0` never overlaps requests.
- **Fix.** Flag `slowPathQueue` (off): one slot per session holding the latest dropped cue, drained after
  `s.inflight` settles, serialized like `afterPoll` (partner.ts:955-969), re-checking cooldown, `s.closed` and a
  staleness bound, delivering through `s.pending`. Cost note in docs/COST-MODEL.md (at most one extra slow-path run,
  so possibly one judge call, per busy window, under Budget).
- **Status.** Round 1 package `engine-request-path`.

### 9. The NEW family cannot be screened at $0 (medium, M)

- **Evidence.** `env -u OPENROUTER_API_KEY bun run funnel --preset NEW --suite train1 --seeds 41` stops at once
  (packages/sim/src/lab/funnel.ts:66-68); hidden-funnel.ts:202 accepts only none, live or replay; `soloReasons`
  (funnel.ts:125-131) forces live runs to one job; the replay key is the whole prompt (reader-disk.ts:25-37), so an
  empty cache gave 1,280 misses on train (measured, exit 3). gate-traffic.ts already drives a real partner with a
  no-call reader and joins `r.pool` to `must` facts (gate-traffic.ts:85,139-140,206-207); hidden-funnel.ts:480
  already records `onReader` reports.
- **Impact.** Estimate: a live NEW screen costs about $0.3-0.5 and runs serially; a stub screen would shard and take
  about 20 s at $0. Corrections: pool recall is a measurement of pool content, not a strict upper bound (rule paths
  and push can deliver an item that was not in the pool); in stub mode NEW collapses to rule paths, so only the pool
  metrics are meaningful; an oracle reader fitted to three aggregate rows is a proxy, not a predictor.
- **Fix.** `--reader stub` printing per suite "hidden in pool X/N, decoy in pool Y/N, mean pool items"; allow it to
  shard; funnel-score.py prints pool recall. Optional `--reader oracle[:p_hit,p_false]` keyed on (seed, task, item
  id), labelled proxy in every output. Never reads held-out suites without `--blind`.
- **Status.** Round 1 package `lab-reader-stub` (with the $0 diagnostics of findings 12 and 14).

### 10. Most of NEW's misses come from retrieval, not reading (medium, M)

- **Evidence.** Measured (`bun run funnel --json all3.json -- -- --ask-diag diag.jsonl`, ALL3, train): the planted
  hidden item is never a candidate in 92/384, ranks under 30 in 286/384. Scratch: `worthCardingStrict`
  (packages/engine/src/cards.ts:183) passes hidden 310/384; the union of a 30-item pool and the prefiltered set
  holds it in 368/384 (366 at pool 15); decoys rise too (control 294 → 346 at pool 30). The standing list takes only
  carded DIGEST_KINDS (partner.ts:1599-1623): 51/384 cited. The reader caps input at 60 items (reader.ts:34).
- **Impact.** Retrieval miss rate 25.5% → 4.2% (6.1x, measured on pool content). End to end about 2.4x (estimate);
  the 368 union does not fit the 60-item cap, and capped variants reach 284-345.
- **Fix.** Flag `askReaderUniverse` building the standing prefix from prefiltered items, measured first with the
  round-1 stub reader; then a paid screen and a decision (it adds decoys to the pool: precision over recall).
- **Status.** Deferred to round 2: needs the `lab-reader-stub` package first, and it edits partner.ts, which
  `engine-request-path` owns this round.

### 11. The shipped server serves only static JSON sources and production defaults (medium, M)

- **Evidence.** packages/server/src/connectors.ts:5-6,15-20 builds only `StaticSource` (per-user MCP is a TODO);
  build.ts:33-35 "The environment sets none of them"; no `EDEN_ENGINE_CONFIG`/`EDEN_PRESET` anywhere; mcp-stdio.ts
  keeps its source map in memory (mcp-stdio.ts:24-28). Measured: `bun run funnel --preset none --jobs 4` 122/384
  hidden, 127 decoys; ALL3 214/211 (1.75x hidden, but decoys 1.66x too).
- **Impact.** An integrator following the README cannot use a real connector or the measured configuration without
  forking.
- **Fix (round 1 part).** `EDEN_ENGINE_CONFIG` (a JSON file of EngineConfig keys, unknown keys refused, process-wide,
  production defaults unchanged, D12) with a new decision row; presets stay in the lab (the server must not import
  sim); persist mcp-stdio's source map under `EDEN_HOME`, keyed by tenant/user. **Deferred part:** MCP entries in
  `EDEN_SOURCES_FILE`. `staticResolver` returns one list to every tenant and user, so a credentialed MCP source there
  would let every user read one account's mail (isolation rule).
- **Status.** Round 1 package `server-startup-config` (config and persistence); MCP sources deferred (decision).

### 12. Read speculatively on the draft event (medium, M, low confidence)

- **Evidence.** The push skips drafts (`event.draft !== true`, partner.ts:706); drafts only feed `anticipate`
  (partner.ts:745-755); `readerKey` hashes the request text (reader.ts:262-270), so a draft's verdict never serves
  the final request. The lead-in draft is a simulation assumption: no suite carries drafts (sim/src/drafts.ts:1-10).
- **Impact.** Unproven. A verifier estimates at most about 45% of sim tasks qualify (about 1.8x on mean reader
  wait); a draft read is a per-event model call (needs a decision and a COST-MODEL row); reusing a verdict made on a
  truncated request risks precision.
- **Fix.** Stage 1 ($0, round 1): with `--reader stub` and `--lead-in`, log draft and final pool ids and report
  Jaccard and subset rates. Stage 2 deferred.
- **Status.** Stage 1 in `lab-reader-stub`; Stage 2 deferred (decision: a per-draft model call).

### 13. Asks, and so the reader push, still wait for the sync poll (medium, M)

- **Evidence.** `ask()` calls `searchLive` without `behind` (partner.ts:1237), so it awaits the poll (:3134); the
  push is an ask (partner.ts:700-713) and `readAsk` starts after `searchLive` (partner.ts:1349). Measured with
  `syncPollBehind` at `--time 1`: ask p50 10.3 / p95 466 / p99 908 ms vs slow-path p95 108 ms; sync.freshen p50 203
  / p95 933 ms.
- **Impact.** Tail only: ask p95 about 4.3x lower (estimate, slow path as proxy); reader push 1.17x p50, 1.5x tail
  (estimates). D65 chose on purpose that the explicit ask waits.
- **Fix.** `askPollBehind`, or a bounded wait (about 100 ms) then warm copies plus a follow-up with dedup and
  corrected-copy handling. Validation needs a changing world: the static sim never stores anything on a poll.
- **Status.** Deferred. Decision needed: may an explicit `ask_context` answer from a possibly stale warm copy
  (amending D65/D40)?

### 14. Let the agent's own model do the reading (medium, M, moonshot)

- **Evidence.** Measured (`--ask-diag`, ALL3, train): planted hidden in top-15 of the ask candidates 272/384, but
  decoys 275/384; NEW's reader delivers 258/91 (packages/sim/lab/haiku/phase3/funnel-train.txt:10).
- **Impact.** Latency 50-75x and $0 Eden spend (estimates) would be real, but quality is likely worse: Hermes takes
  up only about 0.6 of what reaches it (haiku-phase3.md:132,140), giving about 42% vs NEW's 71.9% (estimate), and a
  15-item packet on every message cuts against "silence by default".
- **Fix.** Only a $0 diagnostic now: `--packet-k` (hidden/decoy in packet at K = 10/15/20, bytes, position).
- **Status.** Diagnostic in `lab-reader-stub`; the `widePacket` flag deferred (decision: silence by default).

### 15. Reader time is TTFT plus output tokens (medium, M, low confidence)

- **Evidence.** Production asks `reasoning: "low"` (reader.ts:473) and OpenRouter sends it with `exclude: true`,
  billed but unseen (packages/llm/src/openrouter.ts:73-74); the lab's Anthropic provider defaults thinking off
  (packages/llm/src/anthropic.ts:62-68), so lab latency and cost omit production reasoning.
- **Impact.** Terse ids-only output: 1.9-2.5x (estimate) but it removes the `why`/`same`/`binds` fields D96 found
  essential to decoy rejection; fast endpoints at measured spreads reach about 2.9x at best. Below 3x.
- **Fix (round 1).** Stage 1 only: a `reasoning` option on `ModelReaderMaker` (default "low", unchanged) including
  "off", and record reasoning tokens where the provider reports them, so production's reasoning share can be
  measured. Terse schema and endpoint screens deferred (paid; conflicts with D96).
- **Status.** Round 1 package `reader-reasoning-option`.

### 16. Compressed text plus a cold tier for idle users (medium, M)

- **Evidence.** An Entry holds the whole sanitized item (cache.ts:26-36); 31.5% of sim items hold a non-Latin-1
  char; deflate 2.9x per item, 10.4x per 16-item block (template text). Verifier measurements: text 2.0 KB/item of
  about 4.1 KB (defaults) and 6.8 KB (ALL3, graph on).
- **Impact.** Hot users 1.35-1.9x (measured shares, estimate); cold users about 2.1x under ALL3 unless the graph is
  released too. Inflate 46-51 µs per block against a fast-path p50 of 97 µs. Below 3x as written.
- **Status.** Deferred: rework after `cache-expiry-and-dates` lands (a timer sweep first; release graph and cards
  state; stable inflated objects; measure the cold-user share).

### 17. The knowledge graph doubles memory and makes ingest 3.3-4.6x slower (medium, M)

- **Evidence.** ALL3 sets `graph: true` (presets.ts:32); `put` adds every item (cache.ts:359); measured 1.96 → 4.49
  KB/item and 115 → 383 µs/item put. D63 recorded the same cost and deferred it.
- **Impact.** The proposed fixes give 1.2-1.3x (runsOf) and 1.7-1.9x (compact graph), estimates. Below 3x; graph
  off by default.
- **Status.** Deferred. Decision needed: will ALL3/NEW's graph become a production default? Only then is the compact
  graph worth its risk.

### 18. A content-hash test-result cache (medium, M)

- **Evidence.** `check` always runs every test (package.json:18; scripts/test.sh:23,41). Measured: 102 files, 15.2 s
  wall, 36.9 s user; test CPU depending on a sim/src file mean 1.8 s, engine 21.3 s.
- **Impact.** About 1.4x over today's `check:fast` (which already selects by package). As written it is harmful:
  packages/llm/src/pacing.test.ts:192-206 (the "nothing sets allowLogging" privacy guard) reads other packages'
  sources from disk, outside its import closure, so a cached pass would skip it.
- **Status.** Deferred. Decision needed: may the pre-merge gate (`bun run check`, CLAUDE.md) skip cached passes? If
  yes, tests that read files or spawn processes must always run.

### 19. Item-level reader replay (medium, M)

- **Evidence.** `promptKey` hashes the whole prompt (packages/sim/src/lab/reader-disk.ts:25-38); items render by
  position (packages/engine/src/reader.ts:276-305).
- **Impact.** As written it treats verdicts as independent of neighbours, so order and distractor effects (what the
  levers act through) vanish by construction; the proposed key omits `today` and `question`; `parseReaderFull`
  keeps only 5 binding entries (reader.ts:428), so "silent" labels are unreliable.
- **Status.** Deferred: rework into a narrow subset-lever lower bound keyed on rendered item text, today and question.

### 20. Move the reader's wait from the agent's start to its answer (medium, L)

- **Evidence.** observe waits on the push (partner.ts:722-729); `pending()` is a plain poll (client.ts:82-84);
  `/v1/pending` returns no verdict (http.ts:93-97). `clear` exists only with `askReaderClear` (partner.ts:1762).
- **Impact.** About 2.3x on Eden's critical path at the measured flag rate, about 2.0x with residual waits, about
  1.2x on wall (estimates). Below 3x. The design must also hold tool execution, not only abort the model request.
- **Status.** Deferred to round 2 design (shares client.ts and partner.ts with round-1 packages).

### 21. Distil the reader into a local scorer (medium, L, moonshot)

- **Evidence.** A scratch rule scorer gave AUC 0.512 (unreproduced); docs/research/haiku-phase3.md:187-191 and
  docs/research/econ-judge.md:121-124 (D65) already rejected a distilled cascade.
- **Status.** Deferred. Decision needed: reopen a direction the repo has rejected twice? If yes, Stage 1 (labels
  from sim ground truth, leave-one-suite-out, gate AUC ≥ 0.85) costs $0.

### 22. The secret gate compiles 232 rules lazily on live traffic (low, S)

- **Evidence.** `secretRules()` builds lazily (packages/redact/src/secrets.ts:579-584); each rule compiles on first
  use (:421-438); packages/server/src/main.ts starts `Bun.serve` with no warm-up. Measured
  (`bun packages/engine/bench/pipeline.bench.ts 1500 300`, 3 runs each): event #0 35.5-42.0 ms cold vs 11.2-14.0 ms
  with a warm preload; warm-up lag max 56-72 ms vs 31-42 ms.
- **Impact.** About 3x on the first event per process; no steady-state change.
- **Fix.** Export `warmGate()` from @eden/redact (rules, patterns, allowlists, gate); call it in main.ts before
  `Bun.serve`. Not in engine/src/gate.ts at top level (would add about 100 ms to every importer); warming pool
  workers needs an init hook in primitives' WorkerPool (pool-worker.ts:20), deferred.
- **Status.** Round 1 package `server-startup-config`.

### 23. Unchanged re-listed items are fully re-redacted (low, S)

- **Evidence.** `SourceFanout.list` sanitizes every page (guarded.ts:261-262) before `ItemCache.put` notices an item
  is unchanged (cache.ts:342-353), which still runs `tally` twice. Measured: `sanitizeItem` 16.7-90.6 µs per item vs
  a raw-field hash 1.3-8.3 µs; unchanged `put` 8.2-16.5 µs.
- **Impact.** About 8-10x per unchanged re-listed item (estimate from measured parts); about 0.08-0.3 s CPU per
  synced user per day.
- **Status.** Deferred to round 2: it edits guarded.ts's hook signature, partner.ts, cache.ts and sync.ts, all owned
  by round-1 packages.

### 24. Zone-less dates are parsed in the server's local time zone (low, S)

- **Evidence.** `Date.parse` on zone-less strings in `sentAt` (packages/engine/src/conflict.ts:857-861), `datedOf`
  (cards.ts:226-230), `startMs` (grounding.ts:135-137; used by partner.ts) and `timed`'s sort (cache.ts:592).
  Measured: "Wed 14 Oct 2026 23:30" parses to 23:30Z (UTC), 06:30Z next day (LA), 14:30Z (Tokyo); "14 Oct 2026"
  in Tokyo dates the previous day. scripts/test-preload.ts does not pin TZ. Bare ISO dates are unaffected.
- **Impact.** Card dates (and so replay hashes), supersede order and next-event picks can differ by host; most real
  inputs carry an offset; lab unaffected today.
- **Fix.** `parseWhen(s)` in grounding.ts reading zone-less strings as UTC (leave date-only and offset strings
  alone), used by all four sites; pin `TZ=UTC` in test-preload; a regression test that spawns a subprocess under
  Asia/Tokyo and America/Los_Angeles (TZ must be set before the first Date use).
- **Status.** Round 1 package `cache-expiry-and-dates`.

## Round 1

Eight packages. No two share a file; every file a package may edit is listed. Every package branches from
`audit/2026-11-03b-integration`, ends with `bun run check` green, and keeps production defaults unchanged (new
flags are off). Engine packages also paste `bun run eval` JSON (it must be identical except latency) and run the
`reviewer` subagent, per CLAUDE.md. No package makes a paid model call.

| Package | Findings | Files (exclusive) |
|---|---|---|
| `engine-request-path` | 3, 8 | packages/engine/src/partner.ts, sync.ts, config.ts, sync.test.ts, new engine test file(s), docs/COST-MODEL.md |
| `cache-expiry-and-dates` | 4, 24 | packages/engine/src/cache.ts, cache.test.ts, grounding.ts, conflict.ts, cards.ts, new tz test, scripts/test-preload.ts, docs/ARCHITECTURE.md |
| `lab-connector-latency` | 1 (Stage 1), 5 | packages/sim/src/lab/presets.ts, pi-ab.ts, hermes-ab.ts, packages/sim/src/lab/CLAUDE.md, docs/research/haiku-phase3.md |
| `lab-reader-stub` | 9, 12 (Stage 1), 14 (diag) | packages/sim/src/lab/hidden-funnel.ts, funnel.ts, gate-traffic.ts, reader-disk.ts, packages/sim/lab/scripts/funnel-score.py, lab tests, docs/LAB.md |
| `bunfig-ignore-archived` | 2 | bunfig.toml, docs/TESTING.md |
| `sdk-errors-and-ids` | 7 | packages/client/src/client.ts, index.ts, client.test.ts, docs/INTEGRATION.md |
| `server-startup-config` | 11 (part), 22 | packages/redact/src/secrets.ts, packages/redact/src/index.ts, a redact test, packages/server/src/main.ts, build.ts, mcp-stdio.ts, a server test, packages/server/CLAUDE.md, docs/DECISIONS.md, README.md |
| `reader-reasoning-option` | 15 (Stage 1) | packages/engine/src/reader.ts, reader.test.ts, packages/llm/src/openrouter.ts, types.ts, llm.test.ts, packages/engine/CLAUDE.md |

Notes on boundaries:
- `cache-expiry-and-dates` must not touch partner.ts: the `dropped(scope, null)` hook is already wired
  (partner.ts:587), the expiry timer lives in `ItemCache` (interval in `CacheLimits`), and partner.ts reaches the
  date fix through `startMs`. If partner.ts needs a change, stop and report it.
- `engine-request-path` adds one line at partner.ts:633 to pass the poll page size to `SyncEngine`.
- `lab-connector-latency` documents in packages/sim/src/lab/CLAUDE.md; `lab-reader-stub` owns docs/LAB.md and adds
  the one-line "Pi/Hermes default to `--time-scale 1`" note there too.
- Only `server-startup-config` adds a decision row (D101); others need none because their flags stay off.

### Deferred this round

| # | Finding | Why | Decision needed from the owner |
|---|---|---|---|
| 6 | cost-intent-in-new-background | needs live reader calls | approve about $0.5 for the NEW-minus-intent train screen |
| 10 | quality-reader-pool-universe | needs `lab-reader-stub`; edits partner.ts | none now (round 2) |
| 11 | integrator-server (MCP sources part) | shared static list breaks isolation | how per-user MCP credentials are provisioned |
| 12 | lat-draft-speculative-read (Stage 2) | per-draft model call | allow a model call per draft event (cost row) |
| 13 | lat-ask-waits-poll | departs from D65/D40 | may an explicit ask answer from a stale warm copy |
| 14 | moon-agent-is-the-reader (`widePacket`) | likely quality loss; silence by default | none unless the diagnostic surprises |
| 16 | scale-compressed-text-cold-tier | under 3x as written; needs rework | none now (round 2 rework) |
| 17 | graph-memory-and-ingest | under 3x; graph off by default (D63) | will the graph become a production default |
| 18 | devloop-test-closure-cache | harmful as written | may the merge gate skip cached test passes |
| 19 | devloop-reader-replay-item-level-key | fix erases the effects it screens | none now (round 2 narrow rework) |
| 20 | lat-answer-gate-not-start-gate | about 2x; shares files; needs a tool-gate design | none now (round 2 design) |
| 21 | moonshot-distilled-reader | rejected twice before (D65, haiku-phase3) | reopen it? |
| 23 | ingest-skip-unchanged-redaction | shares four files with round 1 | none (round 2, after round 1 merges) |

## Round 2

Round 1's eight packages are merged on `audit/2026-11-03b-integration` (merge commits 069b12cb8 to 14104e523). The
re-audit ran the same six finders on that tree, security still out of scope, with the bar "at least 3x, or a
verified correctness or pain-point fix". Each finding below survived two adversarial verifiers; where a verifier
corrected a number or a severity, the corrected value is the one given. No paid model call was made.

### Round 2 in plain language

**What is worth doing now.**

- **Faster latency screens (5x, measured).** The realistic-latency funnel screen (`-- --time 1`) is forced into one
  process: 435 s, where the same 12 shards run at once in 82-87 s with identical rows. The time is connector sleeps,
  not CPU, so shards do not slow each other.
- **Sessions use 4-5x less memory (estimate from measured parts).** An open session holding big tool results is
  about 1.86 MB, 88% of it JavaScript Sets of numbers; sorted typed arrays hold the same data in about an eighth of
  the space.
- **No more 33-300 ms stalls from a user's vocabulary (estimate: well over 3x on the worst stall).** Term ids are
  never freed, so heavy users eventually trigger a synchronous whole-user reindex that pauses every user on the
  process. Releasing dead terms makes that reindex a rare fallback. Off behind a flag until a decision.
- **Eden's own wait under the "poll behind" presets falls 9x (measured, stub reader).** The reader push still waits
  for the sync poll that round 1 took off the lookup path, and a fixed 100 ms probe grace is then most of what is
  left (p90 about 8x lower without it). With a live reader the whole wait improves only about 1.4x (estimate),
  because the reader dominates.
- **Quickstart integrators lose the first turn.** With the SDK's default (no wait), a slow connector's answer lands
  after the agent's first model call; INTEGRATION.md says no wait is needed, which is wrong.
- **The $0 NEW screens silently ran without intent.** Intent was inert in every round-1 stub/oracle screen
  (identical results with intent on or off), so those numbers describe "NEW minus intent". The result lines will
  say so until a replay file is committed.
- **Paid agent A/B reruns pay for everything again.** Replaying the reader and grader and reusing the
  Eden-independent arms makes a variant rerun about 4-5x cheaper (estimate from the committed ledger).
- **Smaller fixes.** EDEN_ENGINE_CONFIG has no measured profile and accepts seven settings that do nothing or break
  sync; gate-pool workers start cold (32-56 ms first batch); round 1's new tests made `test:pkg sim` up to 2x slower;
  one planner test fails under load (7 of 20 runs); per-task Eden cost columns omit card spend (Eden understated
  1.25-1.57x); the lab cannot see two round-1 flags; cache maintenance walks every synced item.

**What did not clear the bar, recorded so nobody re-tries it blindly.** Widening the lexical search cannot cut
hidden-fact misses 3x (1.27x at twice the prompt); no prompt-side lever cuts the reader's per-call cost 3x (only
call count can); an ask after the push mostly brings items the push never read, so reusing the push verdict saves
little; making the reader the sole deliverer gives 1.4-1.6x fewer decoys as specified, not 3.4x; one worker per
core is about 2x on a shared 4-vCPU host (3x+ only on 6+ dedicated cores, estimate).

**What needs you.** Six decisions, listed under "Deferred in round 2" below; none blocks the round 2 packages.

### Round 2 findings, ranked by value

Ranked by severity, then effort, then size of the verified gain. Line numbers are on the integration tree unless
marked "main"; several findings were written against older lines and the verifiers' corrected locations are used.

| # | ID | Sev | Effort | Clears 3x? | Status |
|---|---|---|---|---|---|
| R2-1 | devloop-funnel-time-forced-serial | medium | S | yes, 5.0-5.3x measured | round 2 `lab-funnel-screens` |
| R2-2 | sdk-default-waitms-loses-first-turn | medium | S | n/a (pain point) | round 2 `server-config-sdk-wait` + `lab-funnel-screens` |
| R2-3 | devloop-intent-replay-not-committed | medium | S | n/a (screen correctness) | Stage 1 `lab-funnel-screens`; Stage 2 deferred |
| R2-4 | scale-session-held-sets | medium | S | yes, 4.1-5.4x per heavy session (est.) | round 2 `engine-session-and-push` |
| R2-5 | integrator-engine-config-no-validated-profile | medium | S | n/a (doc error, pain point) | round 2 `server-config-sdk-wait` |
| R2-6 | scale-vocab-term-release | medium | M | yes on worst stall (est.); 1.7x memory | round 2 `cache-terms-and-expiry` |
| R2-7 | devloop-ab-request-replay-all-roles | medium | M | variant reruns about 4-5x (est.) | Stage 1 `ab-replay-and-cost-columns` |
| R2-8 | lat-ask-rereads-after-push | medium | M | no as written | deferred: rework |
| R2-9 | scale-single-core-server | medium | M | about 2x measured; 3x+ est. on 6+ cores | deferred: decision |
| R2-10 | lat-push-read-waits-poll | low | S | 9x on Eden's own time; 1.39x end to end (est.) | round 2 `engine-session-and-push` |
| R2-11 | lat-probe-grace-floor | low | S | tail only, after R2-10 | round 2 `engine-session-and-push` |
| R2-12 | devloop-round1-tests-sleep-bound | low | S | one file about 9x (est.) | round 2 `test-determinism` |
| R2-13 | lat-gate-pool-workers-cold | low | S | yes on each worker's first batch | round 2 `server-config-sdk-wait` |
| R2-14 | lab-blind-to-round1-flags | low | S | n/a (lab visibility) | round 2 `lab-funnel-screens` |
| R2-15 | cost-cards-zero-on-all3-funnel | low | S | ratio only; fractions of a cent | Stage 1 `ab-replay-and-cost-columns` |
| R2-16 | cost-eden-column-omits-background-spend | low | S | n/a (reporting accuracy) | round 2 `ab-replay-and-cost-columns` |
| R2-17 | scale-expireidle-full-scan | low | S | per heavy put about 4x (measured) | round 2 `cache-terms-and-expiry` |
| R2-18 | cost-per-task-reader-floor-measured | low | S | n/a (negative result) | deferred: round 3 |
| R2-19 | quality-pool-recall-lexical-ceiling | low | S | no (1.27x); diagnostic | deferred: round 3 |
| R2-20 | devloop-planner-deadline-test-flaky | low | S | n/a (flaky test) | round 2 `test-determinism` |
| R2-21 | corr-engine-config-accepts-silent-noops | low | S | n/a (correctness) | round 2 `server-config-sdk-wait` |
| R2-22 | corr-spans-test-count-varies-wallclock-probe-reput | low | S | n/a (test noise) | round 2 `test-determinism` |
| R2-23 | cost-restart-repays-backfill | low | M | 2-5x only with NEW + sync + restarts (est.) | deferred: round 3 + decision |
| R2-24 | quality-reader-is-the-only-deliverer | low | M | no as written (1.4-1.6x) | deferred: decision |

#### R2-1. The realistic-latency funnel is forced to one process (medium, S)

- **Evidence.** packages/sim/src/lab/funnel.ts:130-141 puts `--time` in `soloReasons` ("--jobs 4 ignored, running
  one job"); hidden-funnel.ts runs the hidden and control variants one after the other (around :300-306; seeds
  already run via Promise.all). SimSource latency and rate-limit state is per instance (sources.ts:378-400), so
  shards are independent. Measured: forced solo `bun run funnel --jobs 4 -- --time 1` 435.5 s; the 12 shards started
  directly at once 81.7-86.5 s, same totals (delivered 97 hidden, 72 control). Verifiers compared 256 and 128
  perTask rows: identical once `ms`, `askMs` and `deliveryMs` are left out; ms/task +0.2% to +2.9%.
- **Impact.** 5.0-5.3x on every `--time 1` screen (measured; full-train solo scaled from a 2-suite run). Concurrent
  variants: about 2x more, unmeasured.
- **Fix.** Drop `--time` from `soloReasons`; keep honouring `--jobs` as typed (do not force it to the shard count);
  print shard concurrency in the header; rewrite the rationale at funnel.ts:116-117 and docs/LAB.md:158. Optional:
  run the two variants concurrently at `--time > 0` (keep `--serial`).
- **Status.** Round 2 package `lab-funnel-screens`.

#### R2-2. With the SDK default, slow-connector context misses the first model call (medium, S)

- **Evidence.** packages/client/src/client.ts:75 sends `?waitMs=` only when passed; packages/server/src/http.ts:78-79
  reads a missing value as 0; packages/engine/src/partner.ts:917-920 then queues the answer and returns at once.
  docs/INTEGRATION.md:35-36 says the opposite ("observe returns as soon as its lookup is done"). Measured:
  `bun run funnel --preset none --suite train1,train2 --seeds 41 --json F -- --time 1` (193 s): 11 deliveries (4
  hidden, 7 control), all at 631-1,336 ms; they count as immediate only because the harness waits 3,000 x TIME
  (hidden-funnel.ts:568, :575). A live server with static in-process sources missed only the cold first call.
- **Impact.** With wait 0 all 11 would go to `pending` (inferred from the timings); a 1.5 s wait would catch all 11.
  The loss is a deferral to the next model call, total only for one-turn answers. The finder's ALL3 5/28 is
  unverified.
- **Fix.** Correct INTEGRATION.md:35-36 and the integration snippets; recommend 1,500 ms on `user_message` (as
  examples/personal-agent/agent.ts:60); opt-in client option `defaultWaitMs` (user_message only, default unchanged)
  with a proposed decision row; lab flag `-- --wait-ms N` and a "delivered before first model call" count.
- **Status.** Docs and client in `server-config-sdk-wait`; lab flag in `lab-funnel-screens`.

#### R2-3. The $0 NEW screens run with intent inert (medium, S)

- **Evidence.** `bun packages/sim/src/lab/funnel.ts --preset NEWL --jobs 4 -- --reader stub` with and without
  `--set '{"intent":false}'`: identical lines (hidden in pool 230/384, decoy 229/384, 656 reader calls); only
  background card counts change. The only signal is one stderr line (funnel.ts:75). No intent replay is committed
  (`packages/sim/lab/cards/` holds cards only). Paid evidence that intent matters: ALL3 214/211 vs ALL3+intent
  247/234 (docs/research/haiku-opt.md:104-105).
- **Impact.** Every round-1 $0 NEW/NEWL pool number is "NEW minus intent"; numbers copied out of a run lose the
  caveat that docs/LAB.md:209 states.
- **Fix.** Stage 1 ($0): stamp `[intent inert: no replay]` on every TOTAL and pool line and the JSON label when intent
  is on and the replay is missing or misses the current items; `--reader stub|oracle` refuse a `--baseline` whose
  intent state differs. Stage 2: commit a sanitized train-only replay and default `--intent` to it for NEW presets.
- **Status.** Stage 1 in `lab-funnel-screens`. Stage 2 deferred: no replay file exists on this machine, so it must be
  regenerated (paid; estimate $0.17-0.35 at $0.0000501/item, COST-MODEL.md:95).

#### R2-4. An open session holds about 1.86 MB, mostly Sets of numbers (medium, S)

- **Evidence.** `remember` pushes `heldOf(text, s.vocab)` (partner.ts:2156-2157, main); `heldOf` builds a Set of up
  to 512 term ids and a Set of pair keys `a*2^32+b` over 8,000 chars (main :5581-5609); 12 kept per session
  (config.ts:629), up to 5,000 sessions per tenant (:633). Verifier RSS measurement, 200 sessions x 12 entries: Sets
  1,802-1,805 KB per session vs Uint32Array + Float64Array 142-145 KB; a second verifier measured the held part
  770 KB vs 95 KB (8.1x).
- **Impact.** About 1,858 to 344-454 KB per heavy session, 4.1-5.4x (estimate from measured parts); small-event
  sessions (19-165 KB) gain well under 3x.
- **Fix.** `Held` as sorted unique typed arrays; `alreadyHas` by binary search; the rebuildVocab remap re-sorts and
  dedupes. Exact Float64 pair keys. Uint32 pair hashes are out: a collision could suppress a delivery.
- **Status.** Round 2 package `engine-session-and-push`.

#### R2-5. EDEN_ENGINE_CONFIG has no measured profile, and D103/README imply the gap needs cards (medium, S)

- **Evidence.** README.md:47-53 and D103 (docs/DECISIONS.md:109) say ALL3 is not runnable because `cards` is
  refused, and the gap "needs cards". Measured, `bun run funnel --jobs 4`: ALL3 214/211; cards and cardsEconomy off
  214/210; `--preset none` 122/127; also groundConflict and groundOccasion off 213/210. `bun run eval --config`:
  cards-off ALL3 precision 0.909, falseFireRate 0.0167, recall 0.444; minus the two ground flags precision 1, recall
  0.467; the README example `{"probes":true,"compactAsk":true}` equals defaults.
- **Impact.** Integrators who copy ALL3 minus the refused flags get an eval precision regression (1 to 0.909); hidden
  and decoys rise together (1.75x and 1.65x).
- **Fix.** Correct D103 and README (no-model train funnel: cards add about 0; no live-parity claim); checked-in
  profiles under docs/profiles/, each with its funnel and eval numbers, validated by a test calling
  `parseEngineConfig`. No profile is "recommended" without a decision row and a held-out check.
- **Status.** Round 2 package `server-config-sdk-wait`.

#### R2-6. A user's vocabulary never frees an evicted term (medium, M)

- **Evidence.** Only `rebuild` frees term ids, when vocab > max(50,000, 4 x baseline) (packages/engine/src/cache.ts:
  60-61); `forget(scope, sourceId)` always rebuilds; `compact` zeroes postLen but keeps dead keys' arrays
  (packages/primitives/src/sparse-index.ts:357-381). Verifiers reproduced rebuild stalls of 33-300 ms and 1.7x
  churned-vs-fresh memory at 7,000 items (finder: 2.3x); at 30,000 items no overhead, because rebuild resets it. About
  one rebuild per 11k lookup items per heavy user.
- **Impact.** Worst put about 300 ms to near p99 (about 12 ms, estimate); forget(source) stops stalling; 1.7x memory.
- **Fix.** Shared module-level SparseIndex scratch; `Vocab.release(id)` (backward-shift delete, free list, clear the
  string and hash slots, separate live count and id capacity); release ids at `compact()` time, not when df reaches
  0; invalidate TextSketcher's per-id hash memo on reuse; `CacheLimits.releaseTerms` off; rebuild kept as fallback.
  A test that no term of a revoked source survives `forget` without a rebuild.
- **Status.** Round 2 package `cache-terms-and-expiry`.

#### R2-7. Paid agent A/B reruns pay again for every role (medium, M)

- **Evidence.** Only cards replay. `ReplayModel` (packages/sim/src/lab/reader-disk.ts:40) is used only by
  hidden-funnel.ts; pi-ab.ts's reader (:500), grader (:250-255, :990-992) and agent (:793-812) are live;
  hermes-proxy.ts:167 forwards everything. Ledger (docs/research/haiku-benchmark.md:207-214, summed by hand): agent
  $10.23, reader $4.49 (24.3%), grader $1.80, cards $1.94, total $18.46.
- **Impact.** Variant rerun with reused none/tools arms and reader/grader replay: about 4-5x cheaper (estimate);
  first screen of a new variant about 2.1x; reader replay alone about 1.3x.
- **Fix.** Stage 1: `--replay DIR` wraps pi-ab's reader and grader in `ReplayModel`, keyed on the exact prompt, model
  id, provider prefs, harness version and grader; `--reuse-arms F` copies Eden-independent arms when those keys
  match; "replayed/live" counts on the spend line; a note that variance estimates need `--replay` off. Stage 2
  (agent stream and Hermes proxy replay; the API key is never stored) in round 3.
- **Status.** Stage 1 in `ab-replay-and-cost-columns`; Stage 2 deferred.

#### R2-8. An explicit ask after the push re-runs the reader (medium, M, deferred)

- **Evidence.** readerKey hashes the question and focus-dependent item text (packages/engine/src/reader.ts:262-270);
  readAsk sets `question: cue.raw`. Reproduced with the stub: 111 reader calls (request-worded asks) vs 215 (narrow)
  over 128 tasks.
- **Why not packaged.** The same run shows mean reader pool 17.0 items for narrow asks vs 12.7, so about 4.3 items per
  task the push never read: the "pool is a subset" fast path mostly misses, and a delta read is still a round trip.
  The 50x and 1.6x figures mix runs. Rework: first measure how often the subset holds (round 3 diagnostic).

#### R2-9. The server uses one core (medium, M, deferred)

- **Evidence.** One partner and one Bun.serve (packages/server/src/main.ts:10, :19, main). Re-measured
  `bun packages/engine/bench/concurrent.bench.ts 800 6 0 400`: CPU 100%, p99 36.5 ms; at 1,600/s p99 134.7 ms, lag
  max 1,350 ms; four processes at 600/s each p99 142-308 ms.
- **Why not packaged.** About 2x measured on this shared VM; 3x+ only on 6+ dedicated cores (estimate). Sharding
  changes the D26 topology and divides tenant-wide caps (maxSessionsPerTenant, MAX_RECORDED_USERS, the anticipate
  and bridge user caps) across shards. Needs a decision; the zero-code alternative (N processes behind a router that
  hashes tenant/user) should be compared.

#### R2-10. The reader push still waits for the poll under NEWB (low, S)

- **Evidence.** ask() calls searchLive with no `behind` (partner.ts:1318), so the push awaits the poll even with
  `syncPollBehind`; only the lookup passes it (:4445). NEWB `train1` timeline: push spans sync.freshen p50 470 ms,
  route/search/rank under 1.5 ms. Two verifier A/Bs (train1-2 seed 41, `--reader stub --time 1`): ms/task 503 to
  54-55 with the push behind; pools and deliveries identical; reader calls 119 to 117.
- **Impact.** Eden's non-reader time 9x lower (measured, stub); end to end with a live reader about 1.39x (estimate,
  reader p50 1,190 ms).
- **Fix.** Flag `readerPushBehind` (off), push only; preset NEWBB. If the late poll changes the pool by id or hash,
  at most one re-read (readerKey makes unchanged pools a cache hit), with a COST-MODEL line; a packet already queued
  from stale data is replaced, not duplicated (test). Stage 2 (paid Pi/Hermes) deferred.
- **Status.** Round 2 package `engine-session-and-push`.

#### R2-11. With the poll off the path, the 100 ms probe grace is most of the tail (low, S)

- **Evidence.** A lookup awaits `Promise.race([probing, setTimeout(probeGraceMs)])` (partner.ts:3279-3287, main) and
  probe() waits up to the grace for a prefetch (main :3322-3329); default 100 (config.ts:644, D47). Verifier A/B,
  `bun run funnel --preset ALL3 --set '{"syncPollBehind":true[,"probeGraceMs":0]}' --suite trainN --seeds 41,42 --json
  F -- --time 1` over 6 suites: mean 56.4 to 15.5 ms, p90 217.5 to 27.3, p99 252.7 to 56.3; 0 of 384 cells changed.
  Under plain ALL3 (poll on the path) no gain, and one row changed.
- **Impact.** Tail only (p90 about 8x, measured), and only with a poll-behind preset.
- **Fix.** Presets ALL3BG/NEWBG using a plain `probeGraceMs` override, measured exactly as shipped; drop the
  latency-EWMA branch (no per-source estimate exists).
- **Status.** Round 2 package `engine-session-and-push`.

#### R2-12. Round 1's new tests sleep or spawn serially (low, S)

- **Evidence.** Per file: packages/engine/src/slow-path-queue.test.ts 5,483 ms wall / 0.34 s CPU (sleeps at :24,
  :44, :68-69, :83, :257, :262); packages/sim/src/lab/reader-stub.test.ts 6.7-8.0 s (serial `spawnSync` at :150,
  CPU-bound); packages/redact/src/redos.test.ts 6.4 s (predates round 1); reader.test.ts 3.1 s. `bun run test:pkg`:
  engine 5.7 to 6.9 s, sim 4.2-4.5 to 7.1-8.5 s.
- **Impact.** Package inner loops 1.2-2x slower; slow-path-queue alone about 9x faster after the fix (estimate). The
  full gate is CPU-bound and moves about 1.2x at most.
- **Fix.** Deferred-promise judge released in a controlled order (keep the interleaving the tests at :248-262 check;
  the clock is already injected); reader-stub spawns run concurrently in `beforeAll` (keep `--limit 2`); redos split
  across files by rule index with the same ceiling; TESTING.md table. No test skipped, every assertion kept.
- **Status.** Round 2 package `test-determinism`.

#### R2-13. Gate-pool workers start cold (low, S)

- **Evidence.** packages/server/src/main.ts:26 warms the gate on the main thread only; workers only import the module
  (packages/primitives/src/pool-worker.ts:18-21). Measured with `startGatePool(2)`: first batch 32-56 ms vs 0.3-5.6
  ms later; warming each worker first gives 1.6-4.4 ms first batches; warming costs 26-143 ms at start.
- **Impact.** Each worker's first batch 13-40x slower, replacement workers included; only with `EDEN_GATE_WORKERS > 0`.
- **Fix.** Optional `warm` task name in `PoolOptions`, run by pool-worker after import and before `ready` (covers
  replacements); gate.ts exports the warm task; never warm at import time. Deterministic test, not a ratio. Re-run
  the pool benchmark before/after.
- **Status.** Round 2 package `server-config-sdk-wait`.

#### R2-14. The lab cannot see two round-1 flags (low, S)

- **Evidence.** slowPathQueue acts only when a request arrives while `s.inflight` is set (partner.ts:894-902); the
  funnel never overlaps requests, so `--set '{"slowPathQueue":true}'` gives identical output (verifier: train1 22/32
  both ways). `SyncStats.demandItems` exists (packages/engine/src/sync.ts:177-178, :613-614) but the sync line prints
  calls only (hidden-funnel.ts:916-929); D101's 18.1x was measured with an uncommitted edit. `--reader-log` is
  written only in `laneModel.chat` (:471-477), so stub and oracle runs leave it empty.
- **Fix.** Print and JSON `demandItems`/`backgroundItems`; opt-in `--overlap` lead-in that sends a second request
  while a lookup is in flight (scores not comparable with standard baselines); stub and oracle readers write
  `--reader-log` lines from `readerMessages(input)`.
- **Status.** Round 2 package `lab-funnel-screens`.

#### R2-15. ALL3's cards move the no-model train funnel by zero (low, S)

- **Evidence.** `bun run funnel --jobs 4`: cards calls 300, hidden 214, decoys 211; with cards and cardsEconomy off
  214/210 (+2 −2, +3 −4); delivered decoys 72 vs 75; warmMs 39,291 to 21,684. docs/research/econ-judge.md:126
  records +14 under a different preset and suite set.
- **Impact.** Card spend is fractions of a cent per user-month, and cards are off by default. In-sample only.
- **Fix.** Stage 1 ($0): record the ALL3-nocards row and correct econ-judge.md:126's context. Dropping cards from
  ALL3 needs a held-out check and a decision (ALL3 is D80's preset).
- **Status.** Stage 1 in `ab-replay-and-cost-columns`; the drop is deferred.

#### R2-16. The live reports' per-task Eden cost omits card spend (low, S)

- **Evidence.** packages/sim/lab/haiku/phase3/report-h-h13.txt:2 says Eden $0.4635; the (Eden) column sums to $0.2948,
  equal to the reader ledger rows; the missing $0.1688 is eden.cards (36.4%). Pi: $0.8180 vs column $0.655 (cards
  19.9%). Card calls go through `meteredModel` (pi-ab.ts:447-451, hermes-ab.ts:374) and are never charged to a task;
  ALL3 rows show $0.000. docs/research/haiku-phase3.md:130-166 copies the columns unlabelled. (Bar 5 lives in
  pi-full-benchmark.md:145 and already separates the backfill; the finder's Bar 5 citation was wrong.)
- **Fix.** "Eden backfill $/1k" and "Eden all-in" columns with the allocation rule stated; relabel the existing column
  "reader only" in haiku-phase3.md; recompute from the committed ledger-summary.jsonl at $0.
- **Status.** Round 2 package `ab-replay-and-cost-columns`.

#### R2-17. Heavy synced users pay O(items) cache walks (low, S)

- **Evidence.** `sweep` continues past every synced entry (cache.ts:505-514, called from put); `expireIdle` (round 1)
  runs it per user every 10 minutes (:748); `evictMixed` copies all entries over a cap (:409-413); `offsetOf`
  rescans after any dated put (:654). Measured on main: heavy-user put 40.6 us vs 9.3 us warm (4.4x); offsetOf on
  7,000 items 587-896 us.
- **Fix.** Break `sweep` at the first entry younger than `ttlMs` whatever its class (later entries are fresher; the
  sync TTL is longer), likewise `expireIdle`'s first-entry check; per-class order or a watermark for the rest;
  `offsetOf` as a tally that keeps userOffset's first-seen tie-break (grounding.ts:188-197), proved by a randomized
  equivalence test.
- **Status.** Round 2 package `cache-terms-and-expiry`.

#### R2-18. No prompt-side lever cuts reader cost 3x (low, S, deferred)

- **Evidence.** Reproduced: backfill depth (default 214/211 at 4.39 connector calls/task; `syncMaxItems` 250:
  185/188 at 5.43; 1000: 215/214 at 5.18). Output is 23% of a call ($0.000094 of $0.000401, haiku-phase3.md:92), so
  input-only levers cap at about 4.3x. The dedup and repeat-slot figures came from uncommitted scratch code.
- **Why deferred.** Its fix is instrumentation (`--reader-dump`, repeat-slot counters) in hidden-funnel.ts, which
  `lab-funnel-screens` owns this round; the COST-MODEL Levers text waits for committed commands. "Null" tasks belong
  in a separate suite, not train (they would break every baseline). Round 3.

#### R2-19. Widening lexical search cannot cut pool misses 3x (low, S, deferred)

- **Evidence.** NEWL stub: pool 230/384; askReaderPool 30: 242; search limit 40 with pool 60: 263/384 at 2.05x the
  prompt; limit 100: 246. ALL3 candidates plateau at 292/384 for K of 40 or more.
- **Why deferred.** A negative result plus a diagnostic: extend the existing `--ask-diag` (hidden-funnel.ts:253-256)
  with full-cache BM25, intent and graph ranks and a "pool ceiling" line. hidden-funnel.ts is owned this round.

#### R2-20. The planner deadline test fails under load (low, S)

- **Evidence.** packages/sources/src/planner.test.ts:363-397 sleeps 40 ms against deadlines `now + 60` and `+ 110`;
  planner.ts:290, 295 and 298 read `performance.now()`. 7 of 20 runs failed beside 12 busy loops; 3 of 15 beside two
  `bun run test` runs; always the "loose" assertion (Expected 2, Received 1).
- **Fix.** Optional `now` in the planner options (default `performance.now`); the test advances a fake clock; the
  latency test after it likewise if needed.
- **Status.** Round 2 package `test-determinism`.

#### R2-21. EDEN_ENGINE_CONFIG accepts settings that do nothing (low, S)

- **Evidence.** A scratch test of `parseEngineConfig` accepted all seven: `constraintDigest:true` (acts only with
  cards), `askReaderStanding:20`, `readerPushWaitMs:5`, `anticipateOff:["srve"]`, `syncPageSize:0` (limit-0 pages,
  NaN top-up, sync.ts:591-597), `syncStaleChance:7`, `askReaderPool:2.5`. The control `{cards:true}` threw.
- **Fix.** `constraintDigest` into NEEDS_DEP; non-default dep-only numbers refused (DEFAULT_CONFIG carries
  `readerPushWaitMs: 60000`); per-key range table (integer of at least 1 for true sizes only; `syncPollPageSize` 0
  means off); `anticipateOff` names checked against every `anticipateOff.includes(...)` in partner.ts (a test reads
  them from the source).
- **Status.** Round 2 package `server-config-sdk-wait`.

#### R2-22. spans.test.ts:88's assertion count varies run to run (low, S)

- **Evidence.** 8 runs: 390 vs 385 expects. The extra span is one `cache.put` (partner.ts:3723, main); deliveries are
  identical. A fixed `now` does not remove it (verifier), so the cause is async ordering between the probe lanes and
  the grace timer, not the clock.
- **Fix (re-scoped).** Find the ordering race and make it deterministic inside the test (fixed-order StaticSource
  answers, or a test config without the grace race), then assert a stable span count over repeated plays; update
  docs/TESTING.md:55-57. If it needs a partner.ts change, stop and report.
- **Status.** Round 2 package `test-determinism`.

#### R2-23. Every restart re-pays each user's backfill (low, M, deferred)

- **Evidence.** All derived per-user state is RAM-only (D8; cards.ts:575-595; the server's `new ItemCache()`); every
  synced item is enqueued for cards (partner.ts:633-635). ALL3 reproduced: 300 card calls over 24 users. The NEW
  figures (1,488 card items per user) are unverified.
- **Why deferred.** Nothing shipped pays it today (D103 refuses cards and intent; sync is off by default, D57).
  Priced on one model the gain is 2x at one restart a month and about 5.3x at weekly deploys (estimate). Stage 2
  (in-memory handoff) needs a decision amending D8 and helps only graceful same-host restarts; Stage 3 (lazy carding)
  was rejected in D66. Stage 1 (`--restart-every N` counters) touches hidden-funnel.ts: round 3.

#### R2-24. Rule paths still deliver decoys the reader rejected (low, M, deferred)

- **Evidence.** Reproduced with the oracle: 79 of 112 surfaced decoys were in the pool and unflagged; `observe` runs
  the rule paths beside the push and never consults the verdict (partner.ts:694-735).
- **Why deferred.** 36 of the 79 are ask-cited and survive D93's "do not empty the answer" guard, so the proposed veto
  gives 1.4-1.6x, not 3.4x; it fails open at the default `waitMs` 0 and holds rule packets for a 1.2 s reader. More
  needs a decision on the D93 guard.

### Round 2 work packages

Six packages. No two share a file; every file a package may edit is listed. Each branches from
`audit/2026-11-03b-integration`, ends with `bun run check` green, keeps production defaults unchanged (new flags off),
makes no paid model call, and reports before/after numbers from commands it ran. Engine and server packages paste
`bun run eval` JSON and run the `reviewer` subagent. A package that needs a file outside its list stops and reports.

| Package | Findings | Files (exclusive) |
|---|---|---|
| `lab-funnel-screens` | R2-1, R2-2 (lab flag), R2-3 (Stage 1), R2-14 | packages/sim/src/lab/funnel.ts, hidden-funnel.ts, reader-stub.ts, new lab test file(s), docs/LAB.md |
| `engine-session-and-push` | R2-4, R2-10, R2-11 | packages/engine/src/partner.ts, config.ts, partner.test.ts, new engine test file(s), packages/sim/src/lab/presets.ts, presets.test.ts, packages/engine/CLAUDE.md, docs/COST-MODEL.md |
| `cache-terms-and-expiry` | R2-6, R2-17 | packages/engine/src/cache.ts, cache.test.ts, grounding.ts, packages/primitives/src/vocab.ts, sparse-index.ts, dedup.ts and their tests, packages/primitives/bench/{vocab,sparse-index,dedup}.bench.ts, packages/primitives/README.md, packages/engine/bench/churn.bench.ts (new) |
| `server-config-sdk-wait` | R2-2 (docs, client), R2-5, R2-13, R2-21 | packages/server/src/engine-config.ts, engine-config.test.ts, main.ts, build.ts, a server test, packages/server/CLAUDE.md, packages/engine/src/gate.ts, packages/primitives/src/pool.ts, pool-worker.ts, a pool test, packages/client/src/client.ts, client.test.ts, docs/INTEGRATION.md, README.md, docs/DECISIONS.md, docs/profiles/ (new) |
| `ab-replay-and-cost-columns` | R2-7 (Stage 1), R2-15 (Stage 1), R2-16 | packages/sim/src/lab/pi-ab.ts, hermes-ab.ts, reader-disk.ts, ab-common.ts, pi-ab-report.ts, a new lab test file, packages/sim/src/lab/CLAUDE.md, docs/research/haiku-phase3.md, docs/research/econ-judge.md |
| `test-determinism` | R2-12, R2-20, R2-22 | packages/engine/src/slow-path-queue.test.ts, reader.test.ts, source-calls.test.ts, spans.test.ts, packages/sim/src/lab/reader-stub.test.ts, packages/redact/src/redos*.test.ts, packages/sources/src/planner.ts, planner.test.ts, docs/TESTING.md |

Notes on boundaries:

- `lab-funnel-screens` adds its tests in a new file, not reader-stub.test.ts (owned by `test-determinism`).
- `server-config-sdk-wait` owns DECISIONS.md: it adds the proposed `defaultWaitMs` row and corrects D103. Other
  packages add no decision row (their flags stay off) and name any decision they would need in their PR.
- `server-config-sdk-wait` checks `anticipateOff` names by reading partner.ts in a test, without editing it.
- `server-config-sdk-wait` reports the pool benchmark in its PR, not in packages/primitives/README.md (owned by
  `cache-terms-and-expiry`).
- `cache-terms-and-expiry` must not touch partner.ts; if releasing terms needs it, stop and report.

### Deferred in round 2

| # | Finding | Why | Decision needed from the owner |
|---|---|---|---|
| R2-3 | devloop-intent-replay-not-committed (Stage 2) | the replay must be regenerated (paid) | approve about $0.17-0.35 to generate and commit a sanitized train-only intent replay |
| R2-7 | devloop-ab-request-replay-all-roles (Stage 2) | agent-stream and Hermes replay, after Stage 1 | none (round 3) |
| R2-8 | lat-ask-rereads-after-push | fix fails as written; subset rate unmeasured | none (round 3 rework) |
| R2-9 | scale-single-core-server | changes the D26 topology and tenant caps | shard inside one process (`EDEN_SHARDS`), or document N processes behind a tenant/user router? |
| R2-15 | cost-cards-zero-on-all3-funnel (drop) | in-sample only; ALL3 is D80's preset | drop cards from ALL3 after a held-out check? |
| R2-18 | cost-per-task-reader-floor-measured | instrumentation lives in hidden-funnel.ts | none (round 3) |
| R2-19 | quality-pool-recall-lexical-ceiling | diagnostic lives in hidden-funnel.ts | none (round 3) |
| R2-23 | cost-restart-repays-backfill | Stage 1 in hidden-funnel.ts; Stage 2 moves content between processes | may content move process to process in memory (amends D8)? |
| R2-24 | quality-reader-is-the-only-deliverer | 1.4-1.6x as specified; the full effect needs D93's guard changed | may a reader rejection empty an ask's answer? |
| R2-4, R2-6, R2-10, R2-11 | defaults (Stage 2) | the flags ship off | turn any on by default (a decision row each, after a paid Pi/Hermes run) |
