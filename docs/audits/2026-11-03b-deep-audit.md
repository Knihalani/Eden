# Deep audit: 3x-and-bigger levers (2026-11-03b)

## Final summary, after three rounds (read this first)

Written for the repo owner, in plain words. Four terms used below:

- **Connector**: a link to one of the user's sources, such as mail or a calendar. Eden only reads them.
- **Sync poll**: Eden asking a connector "what changed since last time?" before it answers.
- **Reader**: Eden's one model call that reads the user's request and picks the facts that matter.
- **ALL3 / NEW**: lab settings. ALL3 is the best no-model setting; NEW is ALL3 plus the reader.

### 1. The bottom line

Three rounds of audit found 106 candidate problems or ideas; 84 survived two independent checks. The biggest problem
was speed: at realistic connector speed, Eden spent most of its time waiting for connectors, and the lab's benchmarks
hid that because their connectors answered instantly. Fixes for 54 of the 84 are merged on one branch: faster
request paths behind new switches, two bugs that silently lost facts, a much faster and less flaky test loop, and lab
screens that can no longer run the wrong setting because of a typo. Production behaviour is unchanged by default:
every new engine switch ships off, so users see no change until you turn one on. No paid model call was made. The
largest measured gains (for example 11.4x less Eden time per task) need a decision from you to reach users.

### 2. Scoreboard

"Fixed" means the finding is marked done in the audit ledger and its branch is merged into
`audit/2026-11-03b-integration` (checked with `git branch --merged`: all 22 package branches are merged). "Fixed"
includes 9 findings where only a first stage shipped, and 5 that are measured limits ("ceilings") rather than code
fixes; both groups are named in section 4.

| Dimension | Found | Verified | Fixed and reviewed | Still open |
|---|---|---|---|---|
| Latency (speed) | 16 | 13 | 9 | 4 |
| Scale and memory | 19 | 16 | 7 | 9 |
| Dev loop (tests, lab tools) | 23 | 18 | 14 | 4 |
| Correctness (bugs) | 12 | 14 | 11 | 3 |
| Cost | 13 | 7 | 3 | 4 |
| Quality (right facts delivered) | 7 | 6 | 3 | 3 |
| Pain points (integrators, users) | 8 | 5 | 4 | 1 |
| Moonshots (redesigns) | 6 | 4 | 3 | 1 |
| Inefficiency | 2 | 1 | 0 | 1 |
| **Total** | **106** | **84** | **54** | **30** |

The checkers rejected 22 findings (claim not reproduced, or gain under 3x). They re-filed two dev-loop findings as
correctness, which is why correctness has more verified (14) than found (12).

Where the ledger and git disagree, or the ledger disagrees with itself:

- The ledger marks `devloop-planner-deadline-test-flaky` resolved, but the verified finding is named
  `devloop-planner-deadline-test-flaky-under-load`. Its fix (round 2 `test-determinism`, planner.ts) is merged, so the
  table counts it as fixed.
- `sdk-default-waitms-loses-first-turn` and `corr-poll-behind-calls-untraced` are listed twice as resolved; each is
  counted once.
- The ledger lists no unresolved items, but 30 verified findings are neither resolved nor rejected. They are open.
- Round 3's text says R3-20 closes `cost-per-task-reader-floor-measured` (R2-18); the ledger still has it open. The
  table follows the ledger.
- Round 1's merge record names merge commits (such as 069b12cb8), not branch tips. The current branch tips are all
  ancestors of the integration tip, so nothing is missing.

### 3. The most important fixes

Numbers come from the audit's own records. "Measured" means a command was run; "estimate" means arithmetic.

- **Eden stops waiting for the sync poll (`syncPollBehind`, in lab presets).** Eden's time per task fell 11.4x with
  the same deliveries (measured, no model). Off by default in production.
- **Sync polls read only what they need (`syncPollPageSize`).** About 20x fewer items listed per poll on the request
  path, same score (measured counts). Off by default.
- **The lab now shows realistic connector speed.** Live agent benchmarks had understated Eden's wait 13.8x and 21.8x
  for ALL3 (measured); Pi and Hermes runs now default to realistic connector timing.
- **Answering from a warm synced copy would be about 640x faster at the median** (715 ms to 1.11 ms, measured in the
  lab), but it also raises decoys. Only the docs and a startup refusal shipped; turning it on is your decision.
- **Under the reader push, Eden's own (non-reader) wait fell 9x at the mean and 13.7x at the median** (measured with
  a stub reader). With a live reader the whole wait improves about 1.4x (estimate). Behind switches, off by default.
- **Two bugs that silently lost facts are fixed.** A withdrawn reader push no longer hides its items for 40 turns. A
  connector page cut short no longer loses the rest of that page until the next daily sweep.
- **First event after start: median 40.5 to 11.7 ms (3.5x).** The secret-scanning rules are now compiled at startup,
  not on the first live request; round 2 extended this warm-up to the worker threads.
- **Integrators get context on the first turn.** With the client's old default (no wait), 0 of 11 lookups reached the
  agent's first model call; with about 1.5 s of wait, 11 of 11 (measured in the simulator). Client errors and
  refused user ids are no longer silent.
- **Memory (behind switches; estimates).** Idle users are freed (5-10x less resident memory, depending on the share
  of idle users); an open session needs about 4-6x less memory; the worst pause from vocabulary clean-up falls from
  57-340 ms to about 10-17 ms.
- **Dev loop (measured).** Typing `bun test` at the root: 214 s with 487 false failures, now 15 s green (14.2x). The
  realistic-latency lab screen: 435 s to 86.5 s, and 222 s to 44 s with the new default (5.0x each). Type-checking
  with the new native checker is 5.1-5.6x faster (fast loop only; the merge gate still uses `tsc`). The full gate
  went from 38.3 s (after round 1) to 18.1 s (after round 3) while tests grew from 1,425 to 1,562 (single runs;
  machine load varied).
- **The lab refuses typos.** A misspelled flag or config key used to run the wrong setting and report "no effect";
  every $0 screen now refuses it.
- **Honest cost columns.** Live reports understated Eden's cost per task 1.25-1.57x by leaving out background card
  and intent spend; they now include it.

Checks on the final tree (a2c3d6fe0, all at $0): `bun run check` green (1,562 tests, 0 failures); the no-model funnel
unchanged at 214/384 hidden facts and 211/384 decoys. `bun run eval` now reports precision 0.889 and recall 0.48
(was 1 and 0.444) because round 3 added harder look-alike scenarios, not because the engine changed. Still owed:
`bun run eval --live` (paid) for the engine branches, which change delivery when their switches are on.

### 4. What is still open, and the next step

**Needs a decision from you.** Each question is in the "Deferred" table of its round.

- **Turn the measured speed switches on by default**: poll behind, poll page size, session memory, vocabulary
  release, push wait, probe grace; and `sync` with the warm copy, which first needs connectors the server can list,
  and raises decoys along with recall. Next step: a paid live Pi/Hermes run, then one decision row each.
- **Intent index under NEW** (about half of NEW's per-user model bill, estimate). Next step: approve about $0.5 for
  one train screen of NEW without intent. A separate $0.17-0.35 buys the intent replay the $0 screens lack.
- **Explicit asks answering from a slightly stale copy** (`lat-ask-waits-poll`, about 4.3x on ask p95, estimate).
  It departs from D65/D40.
- **Reading on the draft event** (stage 2 of `lat-draft-speculative-read`): one model call per draft.
- **One core per server** (`scale-single-core-server`, about 2x measured on a shared VM): shard inside one process,
  or document several processes behind a router?
- **Restarts re-pay every user's backfill** (`cost-restart-repays-backfill`, 3-10x on background spend, estimate):
  may content move between processes in memory (amends D8)?
- **Reader as the only deliverer** (`quality-reader-is-the-only-deliverer`): may a reader rejection empty an answer
  (D93)?
- **Drop cards from ALL3** (stage 2 of `cost-cards-zero-on-all3-funnel`), after a held-out check.
- **Paid reader screens** for the reader's latency and call-count limits: about $0.3-0.5 each.
- **Make `tsgo` the merge gate** after a month of matching results, or wait for TypeScript 7.
- **Cap old source-map mention rows** (`scale-source-map-mentions-unbounded`; amends D8's stored metadata).
- **Per-user MCP credentials** for the shipped server (the MCP half of `integrator-server-...`).
- **Reopen the distilled local reader** (`moonshot-distilled-reader`), rejected twice before (D65, haiku-phase3).
- **Let the merge gate skip cached test passes** (`devloop-test-closure-cache`); harmful as first written.
- **Make the knowledge graph a production default?** (`graph-memory-and-ingest`, under 3x as specified).

**Needs rework (too big, or under 3x as written).** Next step: a redesigned round 4 package.

- Search-index memory: `scale-index-posting-arena` (2.1-2.8x as specified), `scale-compact-frozen-index` and
  `scale-compressed-text-cold-tier`. Next step: one frozen, packed index for synced items.
- `quality-reader-pool-universe`: adding the user's constraint items to the reader's pool cut retrieval misses about
  6x ($0, measured), but no round packaged it, and the related `quality-constraint-index-seats` was rejected.
- `lat-answer-gate-not-start-gate` (about 2x on measured mixes): needs a tool-gate design.
- `lat-ask-rereads-after-push`: the fix failed as written.
- `devloop-reader-replay-item-level-key`: as written it erases the effects it should screen; needs a narrow version.
- Landlord bindings missed by the reader gate (R3-19), and the server's config check delegating to the shared checker
  (R3-5): queued for round 4.

**Small, verified, never packaged.** Next step: one small clean-up package.
`ingest-skip-unchanged-redaction` (deferred in round 1, not picked up later), `corr-cache-offset-stale-on-refresh`,
`corr-sync-test-vacuous-guard`, `corr-searchsources-preaborted-hang`,
`example-agent-not-runnable-offline-and-wrong-description`, `dead-experimental-flags`, `scale-light-user-scan-index`
and `no-memory-bench-per-user`. Most of these are not written up in this file; their details are in the run ledger.

**Recorded limits; nothing to fix:** `cost-no-3x-areas`, `lat-wall-ceiling`, `observe-throughput-no-3x`,
`devloop-funnel-3x-not-reachable`, `cost-per-task-reader-floor-measured` and `quality-pool-recall-lexical-ceiling`,
plus round 3's five ceilings (R3-18 to R3-20, R3-22, R3-23), which the table counts as fixed. Together they say: the
remaining 3x gains on cost or speed come from moving or removing the reader's call, not from tuning it.

**Shipped as a first stage only** (counted as fixed above; the rest is in the decision list):
`lat-sync-poll-on-critical-path`, `lat-default-path-live-search-vs-warm-index`, `lat-draft-speculative-read`,
`moon-agent-is-the-reader`, `lat-reader-faster-endpoint-no-reasoning`, `integrator-server-...`,
`devloop-intent-replay-not-committed`, `devloop-ab-request-replay-all-roles` and `cost-cards-zero-on-all3-funnel`.

### 5. Where everything is

- **This file**: `docs/audits/2026-11-03b-deep-audit.md`. The original round 1 summary and findings follow; then
  "Round 2" and "Round 3", each with findings, work packages and a "Deferred" table.
- **Integration branch**: `audit/2026-11-03b-integration` holds every fix. It is not yet merged into `main`; run
  `bun run eval --live` (paid) for the engine changes first.
- **Per-package branches**, all merged into the integration branch:
  - Round 1, `audit/2026-11-03b-r1-*`: `engine-request-path`, `cache-expiry-and-dates`, `lab-connector-latency`,
    `lab-reader-stub`, `bunfig-ignore-archived`, `sdk-errors-and-ids`, `server-startup-config`,
    `reader-reasoning-option`.
  - Round 2, `audit/2026-11-03b-r2-*`: `lab-funnel-screens`, `engine-session-and-push`, `cache-terms-and-expiry`,
    `server-config-sdk-wait`, `ab-replay-and-cost-columns`, `test-determinism`.
  - Round 3, `audit/2026-11-03b-r3-*`: `engine-push-behind-accounting`, `sources-pages-and-vocab`,
    `server-config-fast-gate`, `lab-cli-strict-and-funnel`, `devloop-speed-and-flakes`, `lab-ceilings`,
    `reporting-weights-and-notes`, `eval-reader-family`.

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

**Round 3.** After round 2 merged, a deeper re-audit (security still out of scope; the bar stays at 3x, or a
verified bug) verified 24 more findings. Measured 3x+ wins: the native TypeScript checker types the repo about 5x
faster, and the realistic-latency screen runs 4.4-5x faster by default. Two bugs silently drop facts (a withdrawn
push keeps its items marked delivered; an MCP token page is cut short and its tail is never listed). The largest lab
number, about 640x on Eden's median wait from answering out of the warm synced index, cannot ship until the servers
can list sources, and it raises decoys with recall, so it is your decision. Many ambitious ideas were measured and
ruled out, with the ceilings recorded. Eight packages are dispatched; four decisions are listed. See "Round 3".

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

## Round 3

Round 2's six packages are merged on `audit/2026-11-03b-integration` (merge commits c42db27bf to e978f7266). Round 3
ran with the owner's revised brief: security is out of scope; the finders went as deep, creative and ambitious as
they could on innovations and optimisations; and a gain had to be at least 3x (or a verified correctness bug or pain
point) to count. Every finding below survived two adversarial verifiers. Where they corrected a number, a line or a
severity, the corrected value is the one given. Line numbers are on the integration tree unless marked "main". No
paid model call was made.

### Round 3 in plain language

**What is worth doing now.**

- **Type-checking about 5x faster (measured).** TypeScript's new native checker (`tsgo`) checks the repo in about
  1.6-2.0 s where `tsc` takes 9-11 s, with identical errors on six planted error kinds. It goes into the fast loop
  first; the merge gate keeps `tsc` until TypeScript 7 is stable.
- **The realistic-latency screen 4.4-5x faster (measured).** Round 2 let `-- --time 1` screens run in parallel, but
  the default is still one job: 222 s, against 44-51 s at 12 jobs with identical rows. The time is sleeps, not CPU.
- **Two bugs that silently drop facts.** (1) Under `readerPushBehind`, a push that a late poll replaces leaves its
  items marked "delivered" for 40 turns, so the agent never gets them pushed unless it asks. (2) An MCP list tool
  that pages by token but takes no page size loses rows: asking for 2 rows of a 4-row page skips the other 2 for good
  (m2, m3, m6, m7 of 10 were never listed). Round 2's small poll pages make that common.
- **The $0 screens accept typos and run the wrong thing.** `--presett NEWL` runs the default preset, `--help` runs a
  30 s screen, and a misspelled config key runs the defaults and reports "+0 -0", so the flag looks useless. Each
  screen will refuse unknown flags and keys and print usage.
- **Round 2's new lab tests made the package loop about 3x slower (measured: `test:pkg sim` 3.7-3.9 s to 11.3 s).**
  They spawn whole funnel runs. Sharing the runs and shrinking them brings it back toward 5-7 s (estimate).
- **Smaller fixes.** Connector calls made by a poll that runs behind are missing from every trace (traces count 28
  of 185 calls); the merged funnel overstates connector calls per task 1.6x for the same presets; a lookup that waits
  on someone else's empty poll runs a second slow path; the vocabulary keeps each word as an unflattened string (3.4x
  more vocabulary memory, about 1.3x per session); a 1 ms off-by-one in deadlines and a 5 ms timing bound make the
  gate flaky; the fast check skips changes to the shipped config profiles; `EDEN_ENGINE_CONFIG` still accepts five
  settings that do nothing; `bun run eval` cannot see the reader at all (NEW and ALL3 score identically).

**The biggest number this round, and why it is not simply "turn it on".** In the lab, with simulated connectors at
realistic latency, Eden's default settings spend 99.7% of their critical path in live connector searches. Answering
from the warm synced index with the poll behind (`sync` + `syncPollBehind`) cut the median about 640x (715 ms to
about 1 ms) and the ask p95 4.4x, and surfaced 1.85x more hidden facts. But it also surfaced 1.79x more decoys; the
shipped servers cannot sync at all yet (their sources are static JSON, which cannot be listed); the lab worlds never
change; and each new user first pays about 6.6 s of backfill. So this round only fixes the docs (the profiles'
latency column is in-process and will say so) and refuses a `sync` setting the servers cannot honour. Turning it on
is your decision.

**What the deep hunt ruled out, so nobody re-tries it blindly.** The finders looked hard for further 3x levers on
cost and latency and recorded where none exists. The reader's latency is a fixed floor of about 365-535 ms plus about
4.2 ms per output token, so input-side changes move it 2-4% at most. An oracle gate cuts reader calls about 2.2x
(today's gate 1.3x, and it misses every landlord binding); cross-session verdict reuse 1.4-2.2x. The engine's fast
path has a flat profile. Compute and storage are orders of magnitude below the reader's cost. Even a free Eden cuts
total task cost at most 1.8x (Hermes) or 2.6x (Pi). The 3x levers left all move or remove the read: not waiting on
it, letting the agent read, a fully cached reader input, or a distilled scorer. Card action triggers cannot fix
retrieval misses. A posting arena for the search index gives 2-2.8x as specified (3x needs a fully packed index),
and pruning the source map is under 2x.

**What needs you.** Four decisions, listed under "Deferred in round 3". None blocks the round 3 packages.

### Round 3 findings, ranked by value

Ranked by severity, then effort, then size of the verified gain.

| # | ID | Sev | Effort | Clears 3x? | Status |
|---|---|---|---|---|---|
| R3-1 | devloop-tsgo-typecheck | medium | S | yes, about 5x measured (cold, and after a shared-file edit) | Stage 1 `devloop-speed-and-flakes`; Stage 2 deferred |
| R3-2 | devloop-time-screen-jobs-default | medium | S | yes, 4.4-5.0x measured | `lab-cli-strict-and-funnel` |
| R3-3 | corr-push-behind-withdraw-leaves-ledger-marked | medium | S | n/a (correctness) | `engine-push-behind-accounting` |
| R3-4 | corr-mcp-list-truncation-skips-items-with-small-poll-page | medium | S | n/a (correctness) | `sources-pages-and-vocab` |
| R3-5 | devloop-lab-accepts-typos-silently | medium | S | n/a (screen correctness) | `lab-cli-strict-and-funnel`; gate-traffic and eval parts in their packages |
| R3-6 | lat-default-path-live-search-vs-warm-index | medium | M | about 640x p50 in the lab; not shippable today | Stage 1 `server-config-fast-gate`; Stage 2 deferred |
| R3-7 | devloop-r2-subprocess-lab-tests-break-gate | medium | M | about 3x lost on `test:pkg sim` (measured) | `devloop-speed-and-flakes` |
| R3-8 | scale-index-posting-arena | medium | M | no as specified (2.1-2.8x, estimate) | deferred: rework |
| R3-9 | corr-poll-behind-calls-untraced | low | S | n/a (accounting) | `engine-push-behind-accounting` (+ funnel check in `lab-cli-strict-and-funnel`) |
| R3-10 | lab-merged-amortised-double-counts-behind-polls | low | S | n/a (lab accounting) | `lab-cli-strict-and-funnel` |
| R3-11 | corr-shared-poll-counts-as-fresh | low | S | n/a (correctness) | `engine-push-behind-accounting` |
| R3-12 | scale-vocab-rope-terms | low | S | 3.4x on vocabulary memory; about 1.3x per session | `sources-pages-and-vocab` |
| R3-13 | devloop-gate-flakes-deadline | low | S | n/a (flaky test, real off-by-one) | `devloop-speed-and-flakes` |
| R3-14 | devloop-wallclock-microbounds-in-parallel-suite | low | S | n/a (flaky test) | `devloop-speed-and-flakes` |
| R3-15 | devloop-test-changed-skips-docs-profiles | low | S | n/a (fast-gate hole) | `server-config-fast-gate` |
| R3-16 | corr-engine-config-still-accepts-noop-flags | low | S | n/a (correctness) | `server-config-fast-gate` |
| R3-17 | eval-blind-to-new-family | low | M | n/a (CI visibility) | `eval-reader-family` |
| R3-18 | lat-reader-decode-bound-ceiling | low | S | negative result (ceiling) | Stage 1 `lab-ceilings`; Stage 2 deferred |
| R3-19 | cost-reader-call-count-no-3x-left | low | S | negative result (ceiling) | Stage 1 `lab-ceilings`; Stage 2 sequenced |
| R3-20 | redesign-no-3x-remaining-without-moving-the-read | low | S | negative result (ceiling table) | Stage 1 `lab-ceilings`; Stage 2 deferred |
| R3-21 | measure-frontier-weights-hidden-only | low | S | n/a (reporting) | `reporting-weights-and-notes` |
| R3-22 | quality-card-action-trigger-ceiling | low | S | negative result | `reporting-weights-and-notes` |
| R3-23 | scale-r3-candidates-and-3x-ceilings | low | S | negative result; two follow-ups | `reporting-weights-and-notes` (one follow-up) |
| R3-24 | scale-source-map-mentions-unbounded | low | S | no (1.84x per row) | deferred: decision |

#### R3-1. `tsgo` types the repo about 5x faster than `tsc` (medium, S)

- **Evidence.** scripts/typecheck.sh:4-24 loops over the tsconfig projects (one, ./tsconfig.json, strict). With
  @typescript/native-preview 7.0.0-dev.20260707.2 in a scratch install (repo tsc 5.9.3, 4 cores), verifiers
  measured: cold `tsc -p ./tsconfig.json --noEmit` 9.0-11.5 s against `tsgo -p` 1.55-2.0 s; after planting an error
  in packages/protocol/src/index.ts, incremental `bun run typecheck` 9.9-11.2 s against tsgo 2.2-2.3 s, both
  reporting the same TS2322; warm no-edit `bun run typecheck` 3.35-4.3 s against `tsgo --incremental` 0.72 s.
  Parity: six planted error kinds (TS2322, TS2307, TS7006, TS2353, TS18048, TS2322 on a Promise) gave identical
  sorted output; the clean tree gives 0 errors in both.
- **Impact.** About 5x cold and after editing a widely imported file; past 3x warm only with `--incremental`. The
  container was contended, so absolute values are noisy; the ratios held across runs.
- **Fix.** Pin @typescript/native-preview as a devDependency (a dev-only preview; justify it in the PR as CLAUDE.md
  requires); scripts/typecheck.sh uses it with `--incremental --tsBuildInfoFile` under `TYPECHECK=tsgo` and in
  `check:fast`; `bun run check` keeps tsc; a parity mode runs both and prints both outputs when they disagree. Record
  the timings in docs/TESTING.md.
- **Status.** Stage 1 in `devloop-speed-and-flakes`. Stage 2 (tsgo as the merge gate) deferred.

#### R3-2. The realistic-latency screen still defaults to one job (medium, S)

- **Evidence.** funnel.ts:167 defaults `--jobs` to 1; round 2 removed `--time` from the solo list (funnel.ts:155-176);
  LAB.md:163-171 documents `--jobs 4`. ALL3, train1-6, seeds 41-42, `-- --time 1`: default 222.4-222.5 s, `--jobs 4`
  112.1-112.2 s, `--jobs 12` 44.1-50.5 s (finder and verifier). All score hidden 214/384, decoys 211/384; the 768
  perTask rows match exactly once `ms`, `askMs`, `deliveryMs` and `beforeModel` are left out. ms/task rises 2.6-3.5%
  at 12 jobs against one.
- **Impact.** 4.4-5.0x over the default and 2.2-2.5x over the documented recipe on every realistic-latency screen.
  On main the speedup does not exist (main still forces `--time` to one job, funnel.ts:130 main).
- **Fix.** When `--time > 0` and `--jobs` is not given, default to min(shards, a cap near 12 scaled to cores); keep
  an explicit `--jobs` as typed; the solo reasons (`--record`, per-process logs, live judge or reader) still win;
  print the chosen concurrency and an ms/task inflation note. Update LAB.md and the funnel.ts doc comment.
- **Status.** `lab-cli-strict-and-funnel`.

#### R3-3. A withdrawn push leaves its items marked delivered (medium, S)

- **Evidence.** partner.ts:1481-1489: the re-read after a late poll (`internal.again`) splices the earlier packet out
  of `s.pending` and fills `withdrawn`, which only lets those items past the freshness filter (:1490-1495). deliver()
  already called `s.ledger.mark` (:5374) and pushed sketches into `s.delivered` (:5368); nothing reverses either.
  `Ledger.isFresh` (ledger.ts:16-18) then reports them delivered for `ledgerCooldownTurns` (40, config.ts:656).
  Scratch test on push-behind.test.ts's setup (cueCooldownTurns 0): the push reads HOLD, the re-read flags NEW, and
  takePending gives `["mail:new"]`; on the next message ("Wire the Harlow invoice payment now") the reader flags
  HOLD, but the reader-push trace itemIds are `[]` and takePending gives `[]` (1 pass, 1 fail). With
  readerPushBehind off, the same message delivers HOLD.
- **Impact.** A binding fact the reader flagged is kept out of proactive pushes for up to 40 turns whenever a late
  poll changes the verdict. An explicit ask still gets it (asks ignore the ledger). Behind readerPushBehind, off by
  default.
- **Fix.** Snapshot each withdrawn item's ledger entry (turn and version, or absence) before withdrawing and restore
  it for items the second packet does not re-deliver; a bare `unmark` would erase an earlier, still-valid delivery of
  a revised item. Drop the withdrawn sketches from `s.delivered` too (the lookup near-duplicate filter reads it at
  :2436). Add the failing case to push-behind.test.ts, and assert that only that session's ledger changes.
- **Status.** `engine-push-behind-accounting`.

#### R3-4. McpSource truncates a token page and keeps the server's cursor (medium, S)

- **Evidence.** packages/sources/src/mcp-source.ts:258-272: `listPage` cuts the page with `.slice(0, limit)` (:353,
  :367) but returns `nextCursorOf(result)` (:270), which points past the whole server page. schema-args.ts:320-325
  sends a page size only for a known limit name. Scratch `McpServer` on InMemoryTransport, `list_mail({pageToken?})`,
  10 rows, 4 per page, paged at limit 2: `SEEN ["m0","m1","m4","m5","m8","m9"]` (both verifiers). SyncManager.poll
  then reaches its boundary and treats the source as current.
- **Impact.** Silent loss of new items until the next sweep (24 h default). With D101's `syncPollPageSize` (off by
  default) the first poll page is often 5 or fewer, so any token-paged tool without a page-size argument loses rows
  routinely; on main only pages over 100 rows are hit. Sim sources honour `limit`, so the funnel and eval cannot see
  it.
- **Fix.** For a token cursor, do not truncate the page (the poll's boundary logic already handles long pages), also
  when an operator-supplied `listTool.args` function ignores `limit`. Do not return `next: null` (it cuts backfill
  short). The read-only check is untouched.
- **Status.** `sources-pages-and-vocab`.

#### R3-5. The $0 screens accept typos and run the wrong configuration (medium, S)

- **Evidence.** Hand-rolled `opt()` parsers with no unknown-flag check: funnel.ts:39-42, hidden-funnel.ts:110,
  gate-traffic.ts:58-62, packages/eval/src/cli.ts:22-24, packages/sim/src/quality-cli.ts:71; `--set`/`--config` are
  spread in unchecked (funnel.ts:86, hidden-funnel.ts:137). Measured: `bun run eval --config '{"fallbackAsk":true}'`
  (misspelled) gives recall 0.4444, the same as no config; the real key `fallbackAsks` gives 0.4667.
  `funnel.ts --presett NEWL --no-record` ran the default ALL3 screen and exited 0. `syncPollBehind` or `graphMerge`
  alone give eval output identical to defaults (their parents are off). Not re-run by the verifiers: the `--help`
  timings and the ledger row a misspelled hidden-funnel run writes (the path at hidden-funnel.ts:1089 supports it).
- **Impact.** A typo'd screen reads "the flag does nothing" and steers which paid runs ($0.3-0.5 each) get bought.
- **Fix.** A `checkEngineConfig(obj, { deps })` in @eden/engine (keys, types, ranges, and a PARENT map allowing
  several parents per key, checked on the merged preset+override with the lab's wired deps); a shared lab `flags`
  helper that exits 2 on an unknown flag and prints usage on `--help`. All 11 presets pass such a check (verified).
  The server's NEEDS_DEP refusal stays in the server (the lab wires cards, bridge and reader).
- **Status.** funnel.ts, hidden-funnel.ts and quality-cli.ts in `lab-cli-strict-and-funnel`; gate-traffic.ts in
  `lab-ceilings` and eval cli.ts in `eval-reader-family`, each after the helpers merge (see the boundary notes).

#### R3-6. On default settings live connector search is 99.7% of the critical path (medium, M)

- **Evidence.** Lab, $0, simulated connectors at profile latency, full train (768 tasks): `funnel.ts --preset none
  --jobs 12 -- --time 1 --timeline T` then timeline-report.ts, defaults against `--set
  '{"sync":true,"syncPollBehind":true}'`. Critical-path p50 715-729 ms to 0.97-1.11 ms; ask p95 1,410 to 317 ms;
  Eden ms/task 823.5 to 1.07-1.3; source.search 99.7% of the default critical path (sync.freshen 96% after);
  connector calls 8.3/task to 3.83 amortised (432 backfill calls, about 6.6 s per user); surfaced hidden 96 to 178,
  decoys 104-105 to 186. ALL3-no-cards-no-grounds profile (train1-2, seed 41): Eden ms/task 537-541 as shipped, 29
  with syncPollBehind, 5.2-5.7 with probeGraceMs 0, surfacing identical. docs/profiles/README.md's only latency
  column is the eval's p95, and the eval uses in-process StaticSource (packages/eval/src/run.ts:144). Defaults:
  config.ts:722 `sync: false`, :734 `syncPollBehind: false`; D57 and D65 are still Proposed.
- **Why it is not a straight win.** The second verifier rated it not real for production: the shipped servers build
  only StaticSources (connectors.ts:5-6, milestone M2), which have no `list`, so a sync profile loaded through
  EDEN_ENGINE_CONFIG would silently do nothing; the lab worlds are static (polls store nothing); deliveries during
  backfill are not counted; and decoys rise with recall, which CLAUDE.md says needs a decision. D57 and D65 already
  record the direction.
- **Fix (Stage 1, no default change).** Label the profiles README latency column "in-process static sources, no
  connector latency" and point to the funnel command for connector-latency numbers (labelled lab, simulated). Refuse
  `sync: true` in EDEN_ENGINE_CONFIG while the servers wire no listable source, with its own message. Stage 2:
  listable connectors (M2), a funnel count of deliveries during backfill, a blind live Pi run of defaults against
  sync + syncPollBehind, a COST-MODEL entry for backfill calls and per-user RAM, then a decision.
- **Status.** Stage 1 in `server-config-fast-gate`; Stage 2 deferred (decision).

#### R3-7. Round 2's subprocess lab tests made the sim loop about 3x slower (medium, M)

- **Evidence.** funnel-flags.test.ts alone 8.15-9.6 s wall / 15.6-18.7 s CPU (the slowest file in the repo);
  reader-stub.test.ts 3.1-3.4 s / 9-10 s CPU. `bun run test:pkg sim`: main 3.7-4.4 s, integration 11.3-17.7 s.
  `bun run test`: main 14.5-17.2 s, integration 19.5-29.1 s (about 1.37x wall, 1.9x CPU). The `--time shards` test
  (:154-178) spawns funnel.ts twice; the `funnel()` helper (:24-40) spawns hidden-funnel.ts; reader-stub.test.ts
  :162-165 spawns three NEWL runs at once. Each test's mkdtemp dir is never removed (funnel-flags.test.ts:21,
  reader-stub.test.ts:151; /tmp/funnel-flags-* grew from 288 to 330 in one verifier's runs). The sim.test.ts:198 5 s
  timeout failed in 3 of 6 gate runs for the finder and 0 of 6 for a verifier, so severity is medium, not high.
- **Correction.** One hidden-funnel stub run costs 1.7-1.8 s wall, of which loading modules is 0.31 s: the cost is
  per-run setup, not process start. Moving runs in-process (the original fix) saves little and can be slower (the
  three concurrent spawns would run one after another); "one seed" breaks the sharding assertion at :176.
- **Fix.** Share the NEWL stub runs through a `beforeAll` (kept as concurrent subprocesses); shrink `--time shards`
  to two seeds at `--limit 1 --time 0.005`; delete each mkdtemp dir; give sim.test.ts:198 an explicit timeout with a
  reason (or share one runQuality). Drop no assertion.
- **Status.** `devloop-speed-and-flakes`.

#### R3-8. The search index's per-key arrays (medium, M, deferred)

- **Evidence.** sparse-index.ts:367-377 `ensureKey` allocates a `Uint32Array(4)` and a `Uint16Array(4)` per (term,
  field) key at 74.4 B of header each (measured over 100k); :379-392 doubles them. At 3,000 docs a verifier measured
  18,180 keys (57% with one posting), 9.56 MB of heap plus 3.10 MB off-heap against about 2.95 MB packed (3.2-4.3x).
  The ratio falls with size: about 1.4x at 30,000 docs; the per-user cap is 7,000 (cache.ts:158-162 main).
- **Why deferred.** Modelled on the measured posting distribution, the proposed slab with inline singles gives about
  2.8x at 3,000 docs and 2.4x at 7,000 (estimate), 2-2.4x per user: under the 3x bar. Only a fully packed layout
  approaches the 3.8x ceiling. Round 4 rework: a frozen CSR for the synced corpus with a small mutable delta.

#### R3-9. Poll-behind connector calls appear in no trace (low, S)

- **Evidence.** partner.ts:3254-3263 (main :3134-3135): `if (behind) cue.polled = polled.then(...)` drops freshen()'s
  call count, so `calls: made + syncCalls` leaves the poll out; afterPoll runs a follow-up only when the poll stored
  something. Reproduced on main: `bun run funnel --suite train6 --seeds 41 --preset ALL3` prints "connectors received
  187 ... traces summed 187"; with `--set '{"syncPollBehind":true}'`, "connectors received 185 ... traces summed 28"
  (6.6x). hidden-funnel.ts:142 already works around it with the sync's own count.
- **Impact.** Per-trace `sourceCalls`, and every cost or rate-limit view built from traces, under-report connector
  traffic about 6x under poll-behind. Answers are unchanged.
- **Fix.** Emit a `skipped` trace (reason "sync poll behind", sourceCalls and syncCalls = freshen()'s return) when
  the behind poll settles, whether or not it stored anything and even after the session closed (the "reader-late"
  precedent); not `silent`, which means "looked, found nothing". The funnel reports a shard where traced != received.
- **Status.** Engine in `engine-push-behind-accounting`; the funnel check in `lab-cli-strict-and-funnel`.

#### R3-10. The merged funnel double-counts behind polls (low, S)

- **Evidence.** funnel.ts:321 (main :267) computes `amortised = request + sync.demandAll - sync.demand + background +
  backfill`; the per-shard formula subtracts `demandSeen` (hidden-funnel.ts:789 main, comment :788). `bun run funnel
  --suite train1,train2 --seeds 41,42 --set '{"syncPollBehind":true}' --jobs 4`: shards print 4.08-4.67/task, the
  merged line 7.04; corrected 4.43 (1.59x overstated). ALL3 without the flag is unaffected.
- **Fix.** Subtract the summed `sync.demandSeen`. Test with two synthetic shard summaries (demand < demandSeen).
- **Status.** `lab-cli-strict-and-funnel`.

#### R3-11. A lookup that waits on another's poll counts it as fresh (low, S)

- **Evidence.** sync.ts:364-368 (main :351-355): after `await s.busy`, `tally.fresh++` runs whatever that poll stored
  (the comment admits it). partner.ts:3261 turns `tally.fresh > 0` into `cue.polled`; afterPoll runs a follow-up slow
  path. Scratch test (stale source, poll stores nothing): with an ask's poll in flight, the message's lookup ran 2
  slow paths and 1 follow-up; alone, or overlapping a timed tick, 1 and 0. It happens on overlap, not on every
  message.
- **Fix.** Whatever holds the source (poll, sweep or backfill page) records what it stored on the SourceSync and the
  waiter adds that, or 0 on abort.
- **Status.** `engine-push-behind-accounting`.

#### R3-12. The vocabulary stores each word as an unflattened rope (low, S)

- **Evidence.** foldString (packages/primitives/src/charclass.ts:82-99) builds each term with `out +=
  String.fromCharCode(f)`; Vocab.add (vocab.ts:115-123) stores it unread, so the JSC rope never flattens. Finder: 238
  against 69 B/term on 147,718 real terms (3.4x). Verifiers (synthetic terms, heap slope over 100k-300k terms): 503
  against 39-40 B/term; touching the rope (`charCodeAt`) does not help, a new flat string does.
- **Impact.** 3.4x or more on vocabulary string memory; about 1.3x per session and 1.04-1.26x for heavy cache users
  (finder's scratch harness, not re-run).
- **Fix.** Fold into a reused, growable Uint16Array scratch and build the string once (`String.fromCharCode` over
  chunks), not `toLowerCase()`, which the comment at charclass.ts:78-81 avoids on purpose. The stored string must
  equal today's foldString output. Re-run vocab.bench and tokenize.bench before and after (primitives README).
- **Status.** `sources-pages-and-vocab`.

#### R3-13. `Deadline.child` can outlive its parent by 1 ms (low, S)

- **Evidence.** packages/primitives/src/deadline.ts:32-35 reads the clock in remaining() and again in after(); a
  millisecond tick between them gives child.at = parent.at + 1. A Date.now that advances on each read reproduces it
  every time; 200,000 hot calls gave 121 such children. The test flake rate at resilience.test.ts:13 is unverified
  (0 of 30 and 0 of 60 in later runs).
- **Fix.** One clock read: `at = Math.min(this.at, now + ms)`, timer on `at - now`; keep the unbounded (Infinity)
  branch returning the parent signal; an optional injected clock for the test. fraction() is covered through child().
- **Status.** `devloop-speed-and-flakes`.

#### R3-14. A 5 ms wall-clock bound in warm.test.ts fails under load (low, S)

- **Evidence.** packages/redact/src/warm.test.ts:16 (`< 5` ms after warmGate) and :24 (`< 1` ms); with 8 busy loops
  on 4 cores, 1 of 10 and 3 of 20 runs failed at :16. docs/TESTING.md:80-82 already records it.
- **Fix.** Assert work, not time: no lazy rule compile on the first call after warmGate, and the rule set is not
  rebuilt; or a CPU-time ratio against a cold control as the ReDoS sweep does. Leave client.test.ts:111 and
  reader.test.ts:709 alone (wide, justified margins; never seen failing).
- **Status.** `devloop-speed-and-flakes`.

#### R3-15. `test:changed` skips docs/profiles, which a server test reads (low, S)

- **Evidence.** scripts/test-select.ts:70 skips every path under `docs/`;
  packages/server/src/engine-config.test.ts:161-166 loads every docs/profiles/*.json. With `{"fallbakAsks":true}` in
  docs/profiles/fallback-asks.json, `bun scripts/test-select.ts changed --base HEAD --dry` printed "no package code
  changed since HEAD; nothing to test", while the full engine-config test fails on it. `bun run check` still catches
  it.
- **Fix.** A data-directory-to-package table in test-select.ts, checked before the docs skip (`docs/profiles/` to
  packages/server), with a unit case.
- **Status.** `server-config-fast-gate`.

#### R3-16. EDEN_ENGINE_CONFIG still accepts five settings that do nothing (low, S)

- **Evidence.** packages/server/src/engine-config.ts:32-64 NEEDS_DEP covers every reader, card, bridge, intent and
  digest key except `readerPushBehind` (acts only under `internal.push`, partner.ts:1337-1343, which needs the
  reader) and `syncPush`, `syncPushMaxStaleMs`, `syncPushSweepMs`, `syncPushGapMs` (act only once `sourcePushes`
  sets `s.pushed`; nothing outside engine and sim calls `sourcePushes` or `sourceChanged`). D104 says such settings
  are the misconfiguration to refuse.
- **Fix.** `readerPushBehind: "reader"`; a separate refusal kind for syncPush* ("needs a server route that relays
  source watches", not "the partner's dependency") until such a route exists; a coverage test over DEFAULT_CONFIG
  keys matching `/reader|card|bridge|intent|digest|push/i` (case-insensitive, or it misses askReader*). A D104
  follow-up row names the added keys.
- **Status.** `server-config-fast-gate`.

#### R3-17. `bun run eval` cannot see the reader family (low, M)

- **Evidence.** `bun run packages/eval/src/cli.ts --config <PRESETS.X>` for ALL3, NEW and NEW2: identical precision
  0.909, recall 0.444, falseFireRate 0.0167, delivered 22 (the diff of the JSON outputs, latency lines aside, is
  empty). packages/eval/src/run.ts:146-154 builds the partner with no reader and no card maker. The 27 scenarios
  average 2.81 docs (maximum 7).
- **Fix.** `--reader stub` in the eval (its own stub in packages/eval; the eval must not import sim/lab) reporting
  "expected in reader pool" per category; an `oracle` mode only if labelled a proxy on every line and kept out of the
  headline metrics; refuse or label config flags whose dependency is missing; 3-5 scenarios with 50+ docs and
  lookalikes. New scenarios move the baseline, so the PR pastes before/after eval JSON. Effort M (verifier).
- **Status.** `eval-reader-family`.

#### R3-18. Reader latency is a fixed floor plus output decoding (low, S, ceiling)

- **Evidence.** Two run-level fits, both reproduced. Over 10 rows of docs/research/haiku-phase3.md:89-102: p50 = 365
  ms + 0.006 ms/input token + 4.21 ms/output token (R² 0.988, max error 35 ms). Over 19 runs in
  packages/sim/lab/haiku/phase3/funnel-reader-cost.txt: p50 = 535 + 3.40/output token + 10.7 per 1k input tokens
  (the p90 fit has R² 0.164 and is weak). The output is the JSON verdict (reader.ts:340-342). `bun run gate-traffic`:
  NEW2 reads 436 of 438 messages and 199 pools hold a needed item, so a perfect gate skips at most 54.6%.
- **Impact.** 3x on reader latency needs an almost empty verdict; input-side levers move latency 24-42 ms; perfect
  gating gives at most about 2.2x on the mean and about 1x on p90. Both fits are run-level; per-call data settles
  the floor.
- **Fix (Stage 1, $0).** Record per-call input, cached input and output tokens, TTFT and ms in reader replay rows
  where the model result carries them; a refit script; floor and ms/token in COST-MODEL.md; a gate-traffic count of
  need turns among unread messages. Stage 2 (paid) deferred.
- **Status.** Stage 1 in `lab-ceilings`.

#### R3-19. No 3x cut in reader calls is left on everyday traffic (low, S, ceiling)

- **Evidence.** `bun packages/sim/src/lab/gate-traffic.ts` (deterministic, about 21 s): NEW2 436 calls on 438
  messages, 199 pools with a needed item (2.19x); NEWL 66 calls and NEWL-nogate 87 (the gate saves 1.32x); all 5
  NEWL misses are landlord (missed-binding 1.000 on 5 gated). The cross-session reuse figures (158/438 exact pool
  repeats and the rest) come from an unpublished scratch copy and are unverified.
- **Correction.** The 199 counts every `must` fact, most of which are plain information the reader is not for, so
  2.2x is a lower bound on an oracle gate that skips pools with no constraint item, not a cap.
- **Fix.** Stage 1: an oracle line over reader-relevant needs and a `--reuse` report in gate-traffic.ts; ceilings in
  COST-MODEL.md. Stage 2: why landlord binding items fail `constraintLike` (partner.ts:1657-1673 main) and
  `mayConstrain` (conflict.ts:639), fixed with a gate-traffic test; it touches askGuard (D92), so it needs the eval
  and the falseFireRate check. Do not build a cross-session verdict cache.
- **Status.** Stage 1 in `lab-ceilings`; Stage 2 sequenced behind `engine-push-behind-accounting` (partner.ts).

#### R3-20. Every remaining 3x path on cost or latency moves or removes the read (low, S, ceiling)

- **Evidence.** Checked: reader cost is about 74% input (haiku-phase3.md:74-79); prices (pricing.ts:15, :21-22: the
  cheapest glm endpoint is under 2x cheaper, glm-5.3-flash dearer than Haiku 5.5); push and ask verdicts cannot share
  a cache (readerKey, reader.ts:262-270); `bun packages/engine/bench/pipeline.bench.ts` steady observe p50 89.5 µs
  (flat profile); a free Eden cuts total cost at most 1.78x on Hermes (haiku-phase3.md:144) and 2.55x on Pi (:137). A
  fully cached reader input is about 3.0x per call by arithmetic (3,921 × $0.01/M + 188 × $0.5/M = $0.000133
  against $0.000401; ignores cache writes and focus-dependent requests). The 656 reader calls, 1,796 against 300
  background calls and $4e-8 compute per task are unverified.
- **Fix.** Stage 1: a "where 3x is impossible" section in COST-MODEL.md with this table, the fits and the reuse
  ceilings, each row naming its command or source, 2.55x as the free-Eden bound, and the terse-reply row as a
  ceiling, not a recommendation (D96). Stage 2: one pre-registered paid screen of "cached universe + at most 2
  entries" (deferred).
- **Status.** Stage 1 in `lab-ceilings` (it also closes R2-18).

#### R3-21. The NEW frontier is priced on hidden tasks only (low, S)

- **Evidence.** haiku-phase3.md:147 labels the cost columns "per thousand hidden tasks" (the label is honest).
  packages/sim/lab/haiku/phase3/report-pi-h13.txt: Eden $/1k control against hidden, NEW 0.778 against 0.553
  (1.41x), NEWL 0.532 against 0.388 (1.37x); Eden tool calls per task 1.24 against 0.63; wall p50 NEW 5.39 against
  3.72 s (ALL3 3.44 s on control). The gap to tools grows 1.62x on control. Hermes is about 1.05x. No verdict
  changes (NEW fails Bar 5 on hidden tasks alone).
- **Fix.** pi-ab-report and hermes-ab print a traffic-weighted row for w in {0.1, 0.5}: means and $/1k by
  weighting, p50/p90 from the pooled per-task samples (a weighted percentile is not a percentile). Recompute the
  haiku-phase3 frontier with weighted columns; state the w Bar 5 uses in pi-full-benchmark.md, where Bar 5 is
  defined (:145).
- **Status.** `reporting-weights-and-notes`.

#### R3-22. Card action triggers cannot fix retrieval misses (low, S, negative)

- **Evidence.** Scratch join (cards-v2.jsonl + cards-train.jsonl, train1-6, seeds 41-42): `requestActions`
  (cards.ts:1177) fires on 261/384 requests; card actions meet request actions for 52 hidden against 37 decoys; the
  ALL3 funnel surfaces hidden 214/384; gating on an active DIGEST card surfaces 60 against 25 (2.4x separation) while
  hidden falls from 214 to 60. NEW2's 83 pool misses (2 meet) are unverified (the reader cache is not checked in).
- **Fix.** Docs only: record the negative result in docs/research/moon-cards.md and update its INDEX row.
- **Status.** `reporting-weights-and-notes`.

#### R3-23. Scale: 14 candidates measured, and where 3x is impossible (low, S, note)

- **Evidence.** pipeline.bench observe p50 95-117 µs; put.bench sanitize 23-29 µs, termIds 9-10, addFields+remove
  21-38, extractTypedEntities 35-54 (no stage dominates); churn.bench releaseTerms off worst put 163-164 ms / 44.1 MB,
  on 13.6-16.2 ms / 25.9 MB. perf-cli memory builds the sim worlds in the same process (sim/src/server.ts:57) and
  records only absolute readings (perf-cli.ts:139-160). Unverified: start-up time, conjunctive search ceilings, the
  perf-cli cold hang.
- **Fix.** No build. Follow-ups: perf-cli memory reports an Eden-only per-user slope (subtract the zero-user
  reading); investigate the cold hang.
- **Status.** The slope in `reporting-weights-and-notes`; the hang stays open.

#### R3-24. Source-map mention rows are never pruned (low, S, deferred)

- **Evidence.** packages/graph/src/source-map.ts:72-77 creates `mention` as a rowid table keyed (scope, entity,
  source_id); the upsert refreshes `last_seen`, which nothing reads; the only DELETE is in forget() (:233-239).
  recordMentions (partner.ts:3793-3805 main) writes up to 20 entities per new or changed item. Measured 110-139
  B/row; WITHOUT ROWID with interned ids about 1.84x smaller (finder). Growth follows distinct (entity, source)
  pairs, so it levels off; 18 MB/user is an estimate.
- **Why deferred.** Under the 3x bar, and pruning removes routing evidence for rarely mentioned people (route()
  ranks by these rows), which the eval cannot see.

### Round 3 work packages

Eight packages. No two share a file; each lists every file it may edit, and a package that needs another file stops
and reports. Each branches from `audit/2026-11-03b-integration`, ends with `bun run check` green, keeps production
defaults unchanged (new flags off), makes no paid model call, and reports before/after numbers from commands it ran.
Engine, server and eval packages paste `bun run eval` JSON and run the `reviewer` subagent.

| Package | Findings | Files (exclusive) |
|---|---|---|
| `engine-push-behind-accounting` | R3-3, R3-9 (engine), R3-11 | packages/engine/src/partner.ts, ledger.ts, ledger.test.ts, sync.ts, sync.test.ts, push-behind.test.ts, econ-judge.test.ts, packages/engine/CLAUDE.md |
| `sources-pages-and-vocab` | R3-4, R3-12 | packages/sources/src/mcp-source.ts, mcp-source.test.ts, schema-args.ts, packages/engine/src/sync-mcp-page.test.ts (new), packages/primitives/src/charclass.ts, vocab.ts, vocab.test.ts, packages/primitives/bench/vocab.bench.ts, packages/primitives/README.md |
| `server-config-fast-gate` | R3-6 (Stage 1), R3-15, R3-16 | packages/server/src/engine-config.ts, engine-config.test.ts, packages/server/CLAUDE.md, docs/DECISIONS.md, docs/profiles/README.md, scripts/test-select.ts, scripts/test-select.test.ts (new) |
| `lab-cli-strict-and-funnel` | R3-2, R3-5 (funnel, hidden-funnel, quality-cli), R3-9 (funnel check), R3-10 | packages/engine/src/config-check.ts (new), config-check.test.ts (new), packages/engine/src/index.ts, packages/sim/src/lab/flags.ts (new), flags.test.ts (new), funnel.ts, hidden-funnel.ts, funnel-merge.test.ts (new), packages/sim/src/quality-cli.ts, docs/LAB.md, packages/sim/src/lab/CLAUDE.md |
| `devloop-speed-and-flakes` | R3-1 (Stage 1), R3-7, R3-13, R3-14 | scripts/typecheck.sh, package.json, bun.lock, docs/TESTING.md, packages/sim/src/lab/funnel-flags.test.ts, reader-stub.test.ts, packages/sim/src/sim.test.ts, packages/primitives/src/deadline.ts, resilience.test.ts, packages/redact/src/warm.test.ts |
| `lab-ceilings` | R3-18, R3-19, R3-20 (Stage 1 each), R3-5 (gate-traffic) | packages/sim/src/lab/gate-traffic.ts, reader-disk.ts, reader-latency-fit.ts (new), gate-traffic.test.ts (new), docs/COST-MODEL.md |
| `reporting-weights-and-notes` | R3-21, R3-22, R3-23 (perf-cli slope) | packages/sim/src/lab/pi-ab-report.ts, hermes-ab.ts, pi-ab-weighted.test.ts (new), docs/research/haiku-phase3.md, docs/research/pi-full-benchmark.md, docs/research/moon-cards.md, docs/research/INDEX.md, packages/sim/src/perf-cli.ts |
| `eval-reader-family` | R3-17, R3-5 (eval) | packages/eval/src/run.ts, cli.ts, run.test.ts, reader-stub.ts (new), packages/eval/scenarios/ (new files only), packages/eval/CLAUDE.md |

Notes on boundaries:

- `lab-cli-strict-and-funnel` owns `checkEngineConfig` and the `flags` helper. `lab-ceilings` (gate-traffic.ts) and
  `eval-reader-family` (eval cli.ts) do their CLI-strictness step last: they rebase on the integration branch, and if
  `lab-cli-strict-and-funnel` has merged they call its helpers; if not, they leave that step out and say so in the PR
  (no copied checker). gate-traffic has no `--config`, only flags.
- The server's NEEDS_DEP stays in engine-config.ts (`server-config-fast-gate`); making `parseEngineConfig` delegate
  key, type and range checks to `checkEngineConfig` is a round 4 follow-up once both have merged.
- `server-config-fast-gate` owns DECISIONS.md: a D104 follow-up row naming readerPushBehind, syncPush* and the sync
  refusal. Other packages add no decision row and name any decision they would need in their PR.
- New lab tests must not spawn full funnel runs (R3-7): test parsers and the merge formula in process, with at most
  one small spawned smoke test per CLI.
- `devloop-speed-and-flakes` reports the deadline change's numbers in its PR, not in packages/primitives/README.md
  (owned by `sources-pages-and-vocab`), and changes no package.json script other than the typecheck switch.
- `sources-pages-and-vocab` must not touch sync.ts; its SyncManager test lives in the new test file.
- `lab-ceilings` logs only counts and timings (no text) in replay rows; if TTFT needs a change in packages/llm or
  reader.ts, it stops and reports.

#### Acceptance checks

- **`engine-push-behind-accounting`.** The R3-3 scratch case is a test in push-behind.test.ts and passes (the second
  takePending contains `mail:hold`); a revised item withdrawn and not re-delivered keeps its earlier ledger version;
  another session's ledger is unchanged. A test sums trace.sourceCalls against a counting fake source and matches it
  with syncPollBehind on and off (econ-judge.test.ts). Two concurrent lookups on a stale static source give 0
  follow-ups and 0 push re-reads; one stored item gives exactly one follow-up; a sweep that stores an item still
  triggers it; the push-as-waiter ordering under readerPushBehind is covered. `bun run funnel --suite train6 --seeds
  41 --preset ALL3 --set '{"syncPollBehind":true}'` prints traces summed equal to connectors received. `bun run eval`
  JSON unchanged (defaults off); reviewer run.
- **`sources-pages-and-vocab`.** The InMemoryTransport server (10 rows, 4 per page, pageToken only) paged at limit 2
  lists all 10; a SyncManager poll with page size 2 over it stores every new item; a schema with a limit argument
  still gets pages of `limit`. vocab.bench and tokenize.bench before/after in the primitives README; a heap test of
  at most 80 B/term at 100k terms (heapStats slope); stored terms identical to today's foldString output.
- **`server-config-fast-gate`.** `EDEN_ENGINE_CONFIG='{"readerPushBehind":true}'`, `'{"syncPush":true}'` and
  `'{"sync":true}'` are each refused at startup with a message naming what is missing; the coverage test fails if a
  new reader, card or push key is added without a NEEDS_DEP entry or a reasoned allow-list entry; the shipped
  profiles still load. With `{"fallbakAsks":true}` written into docs/profiles/fallback-asks.json, `bun
  scripts/test-select.ts changed --base HEAD --dry` selects packages/server (then revert). The profiles README
  latency column says in-process static sources.
- **`lab-cli-strict-and-funnel`.** `funnel.ts --presett NEWL`, `hidden-funnel.ts --sed 41` and `quality-cli.ts
  --bogus` exit 2 without running; `--help` prints usage and exits 0 in under 1 s; `--set '{"fallbackAsk":true}'`
  exits non-zero naming the key; `--set '{"syncPollBehind":true}'` under a preset with sync off is refused (parent
  off) and accepted under one that turns sync on. All 11 presets pass. `bun run funnel -- --time 1` with no `--jobs`
  runs the shards concurrently and prints the concurrency; its stripped perTask rows match a `--jobs 1` run. The
  merged amortised line for `--suite train1,train2 --seeds 41,42 --set '{"syncPollBehind":true}' --jobs 4` matches
  the shard mean (about 4.4/task, not 7.0). A shard where traced != received is reported.
- **`devloop-speed-and-flakes`.** `TYPECHECK=tsgo bun run typecheck` and `bun run typecheck` agree on the clean tree
  and on five planted error kinds; cold, after-edit and warm timings recorded in TESTING.md; `bun run check` still
  uses tsc. `bun run test:pkg sim` at most 7 s over three runs (numbers reported), same pass and assertion counts; no
  /tmp/funnel-flags-* or /tmp/reader-stub-* dir left after a run. A deadline test with a clock that ticks on every
  read shows child.at <= parent.at. warm.test.ts passes 30 runs beside 8 busy loops. Five consecutive green `bun run
  test` runs.
- **`lab-ceilings`.** `bun packages/sim/src/lab/gate-traffic.ts` prints an oracle line over reader-relevant needs and
  a `--reuse` report, and its existing numbers are unchanged (NEW2 436 calls, NEWL 66); `--bogus` exits 2 if the
  flags helper has merged. The refit script reproduces fit (a) (365 ms, 4.21 ms/output token) from haiku-phase3.md's
  rows. COST-MODEL.md has the "where 3x is impossible" table with a command or source per row and unverified rows
  labelled.
- **`reporting-weights-and-notes`.** pi-ab-report on report-pi-h13's data prints a w = 0.5 row with NEW Eden cost
  $0.666/1k (to the cent fraction shown); a test checks that the weighted p50 comes from pooled samples.
  haiku-phase3.md's frontier has weighted columns; pi-full-benchmark.md states Bar 5's w; moon-cards.md records
  R3-22 and its INDEX row is updated; perf-cli memory prints an Eden-only per-user slope.
- **`eval-reader-family`.** `bun run packages/eval/src/cli.ts --config <NEW> --reader stub` reports "expected in
  reader pool" per category and differs from ALL3; the default run's JSON changes only by the new scenarios, with
  before/after pasted; any oracle line is labelled a proxy; scenario documents are synthetic.

### Deferred in round 3

Round 2's deferred items not named here (R2-3 Stage 2, R2-7 Stage 2, R2-8, R2-9, R2-15, R2-23, R2-24 and the default
flips) stand as listed under "Deferred in round 2". R2-18 is closed by R3-20's Stage 1.

| # | Finding | Why | Decision needed from the owner |
|---|---|---|---|
| R3-1 | devloop-tsgo-typecheck (Stage 2) | needs a period of parity first | make tsgo the merge gate after a month of parity, or wait for TypeScript 7? |
| R3-6 | lat-default-path-live-search-vs-warm-index (Stage 2) | the servers cannot list sources yet (M2); decoys rise with recall | after listable connectors and a blind live Pi run, turn `sync` + `syncPollBehind` on by default (a decision row; amends D57/D65)? |
| R3-8 | scale-index-posting-arena | 2.1-2.8x as specified, under the bar | none (round 4 rework: frozen packed CSR for the synced corpus) |
| R3-18, R3-20 | reader ceilings (Stage 2) | paid | approve about $0.3-0.5 each for one NEW train screen with per-call timings and one pre-registered "cached universe + at most 2 entries" screen? |
| R3-19 | landlord bindings fail constraintLike (Stage 2) | shares partner.ts with `engine-push-behind-accounting` | none (round 4; needs the eval and the falseFireRate check) |
| R3-24 | scale-source-map-mentions-unbounded | under 3x; pruning loses routing evidence | may source-map mentions be capped or aged out per tenant/user (amends D8's persisted metadata)? |
| R3-5 (server) | parseEngineConfig delegating to checkEngineConfig | needs two round 3 packages merged | none (round 4) |
| R2-19 | quality-pool-recall-lexical-ceiling | still open; diagnostic in hidden-funnel.ts | none |
