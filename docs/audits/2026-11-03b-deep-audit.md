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
