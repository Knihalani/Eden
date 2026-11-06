# Deep audit (2026-11-06)

## Summary (for the owner, read this first)

Written on 2026-11-06 from `main` a8747e057. Every number below comes from a command that the finder or one of the
two independent verifiers ran (named in each finding), or is labelled an estimate with its arithmetic. Paid calls go
only to Anthropic (`HAIKU_API_KEY`, `claude-haiku-5-5` for every role), metered with `--spend-ledger
.local/mkt/ledger.jsonl --spend-cap 18 --spend-headroom 0.3`. The ledger summed to $11.49 (45,072 rows, a `bun -e`
sum run while writing this report), so about $6 is left under the cap.

What this audit found, in plain words:

- **The test bench was measuring a product that does not ship.** The shipped default turns on "intent" (Eden guesses,
  ahead of time, which requests each item could answer). The $0 screen and the checked-in paid replay both ran with
  intent switched off, because the funnel never loads the intent file that is already in the repo. The shipped
  default really finds about 278 of 384 hidden facts on train, not the 247 every recent decision quotes, and the
  "facts the ask never ranks" gap is 64, not 92. Fix: load intent by default in the funnel and record a matching
  replay cache (about $0.07-0.19).
- **A free quality gain is on the table.** Loosening intent's three match thresholds (coverage 0.35 to 0.2, matched
  terms 2 to 1, hits 6 to 12) raised hidden facts found by 17-21 of 384 in three independent paid train runs, with
  decoys flat (-4 to +1), the same number of reader calls, and gains on unseen seeds and a blind held-out suite. It
  costs nothing extra. Decision D159 promotes it, after one live Pi confirmation.
- **One correctness bug.** If a connector sends an edit and then a delete close together, the delete can be undone:
  the deleted item comes back and can be delivered until the next sweep. Reproduced twice in a scratch test. Fix is
  small and adds no cost.
- **The developer loop.** After an engine edit, `bun run test:changed` runs 84% of the whole suite because six
  end-to-end simulation files ride along. Deferring them to `bun run check` halves the inner loop (18.0 to 8.9 s,
  measured). Diagnostic funnel runs are forced onto one process (2.2-2.4x slower); that fix waits for round 2 because
  it edits the same file as the intent fix.
- **Scale.** The server still runs every user on one core: the multi-process router D113 decided on was never built.
  Four processes measured 1.8-2.2x the throughput of one on a 4-core box. A struct-of-arrays graph would cut memory per
  user, but a verifier's breakdown puts it at about 1.6x on the graph's share, not the 2.5-2.9x claimed.
- **Ceilings, recorded so nobody chases them again.** Eden's time on the agent's path is about 94% reader model time;
  no change below the model can give 1.5x on task wall time. Caching the reader's items across calls gives at most
  about 1.17-1.28x on reader cost. Moving the push reading off the agent's start loses most useful pushes. Overlapping
  the ask's poll with the reader gives at most 1.13x on asks.

Seven work packages go to parallel fixers in round 1 (below). Three findings wait for round 2 because they edit files
a round 1 package owns or need its output: the action-request gate (needs the intent-on cache and edits `config.ts`),
parallel funnel diagnostics (edits `funnel.ts` and `hidden-funnel.ts`), and request-side query expansion (needs the
new baseline and the new diagnostics).

## Findings, ranked by value

Severity first, then effort. "Status" is where the finding stands after this round's planning.

| #   | Finding                                     | Severity | Effort | Status                                                                            |
| --- | ------------------------------------------- | -------- | ------ | --------------------------------------------------------------------------------- |
| F1  | `quality-intent-thresholds-unranked`        | medium   | S      | Round 1, package `intent-shipped-baseline`; D159                                  |
| F2  | `quality-o7-measured-intent-inert`          | medium   | S      | Round 1, package `intent-shipped-baseline`; D158                                  |
| F3  | `correctness-pushed-items-undo-deletion`    | medium   | S      | Round 1, package `sourceitems-removal-race`; D160                                 |
| F4  | `devloop-test-changed-engine-runs-e2e`      | medium   | S      | Round 1, package `test-changed-defer-e2e`; D161                                   |
| F5  | `devloop-ask-diag-forces-one-process`       | medium   | S-M    | Deferred to round 2 (waits for `intent-shipped-baseline` and `ask-diag-coverage`) |
| F6  | `quality-push-skipped-imperative-list`      | medium   | S      | Deferred to round 2 (waits for `intent-shipped-baseline`); D168                   |
| F7  | `quality-o7-remaining-gap-not-candidates`   | medium   | M      | Round 1 stage 1, package `ask-diag-coverage`; D162                                |
| F8  | `scale-multi-process-router-unbuilt`        | medium   | M      | Round 1, package `server-router`; D163                                            |
| F9  | `scale-graph-soa-and-compact-text`          | medium   | L      | Round 1 stage 1, package `graph-soa`; D169; stage 2 deferred                      |
| F10 | `moonshot-ask-query-expansion-ceiling`      | medium   | L      | Deferred to round 2 (waits for `intent-shipped-baseline` and `ask-diag-coverage`) |
| F11 | `lat-eden-path-is-reader-floor`             | low      | S      | Round 1, package `close-docs-ceilings`; D165                                      |
| F12 | `cost-reader-prompt-cache-items-impossible` | low      | S      | Round 1, package `close-docs-ceilings`; D164                                      |
| F13 | `lat-push-off-path-kills-hidden`            | low      | S      | Round 1, package `close-docs-ceilings`; D166                                      |
| F14 | `lat-ask-reader-overlap-poll-closed`        | low      | S      | Round 1, package `close-docs-ceilings`; D167                                      |

### F1. Looser intent thresholds recover unranked facts at no extra cost

- **Evidence.** The thresholds are `intentHits: 6`, `intentMinCoverage: 0.35`, `intentMinMatched: 2`
  (`packages/engine/src/config.ts:576-578`), applied per request at `packages/engine/src/partner.ts:4473` and capped at
  :4475. Of the 64 hidden facts the ask never ranks with intent on, 54 were not among the top 6 intent hits. Example:
  `contents-cover-switched` ("Accept Harbourside's renewal quote for my contents insurance") shares "contents" and
  "insurance" with the item's intent requests but misses the per-request bar. Decoys use the same wording
  (`packages/sim/src/lab/hidden-train1.ts:249-275`).
  - $0 stub screen, train1-6 seeds 41-42, intent replayed (`bun run funnel --jobs 4 -- --intent F [--set
'{"intentMinCoverage":0.2,"intentMinMatched":1,"intentHits":12}']`): reader pool 257/240 to 270/246
    (hidden/decoys). Reproduced exactly by both verifiers.
  - Paid Haiku pairs, fresh cache per arm (three independent runs): 277/135 to 296/132 (finder; paired hidden +4.95
    points, 95% CI +2.05..+7.84; decoys -0.78, CI -3.80..+2.24; 653 vs 655 calls); 274/136 to 295/132 (verifier 1,
    about $0.37); 277/133 to 294/134 (verifier 2, about $0.37). Run-to-run spread is about ±3 tasks.
  - Unseen seeds 43-44 (finder only, not re-run): 275/147 to 292/137. Blind held-out 10-11 (finder only): 77/44 to
    85/39.
  - `bun run eval` unchanged with the loose config (precision 0.8276, recall 0.48, falseFireRate 0; verifier 2): intent
    is inert in eval. The no-model path does not move (stub JSON: hidden delivered 98, decoys delivered 72 in both
    arms).
- **Impact.** Misses 107 to 88-90 on seeds 41-42 (about 1.2x fewer), same reader calls and cost. The 1.64x unranked
  and 1.32x decoy figures belong to a wider variant (hits 40, coverage 0, matched 1) combined with F6's gate; that
  variant alone raised decoys on never-read tasks (35 to 41), so it waits for F6.
- **Fix.** Promote 0.2/1/12 into `DEFAULT_CONFIG` (D159) after one live Pi held-out 13 pair confirms it; unit tests that
  a one-term intent hit can enter an ask's pool but is never a no-model delivery.
- **Status.** Round 1, package `intent-shipped-baseline`.

### F2. The $0 screen and the replay cache measure the default with intent off

- **Evidence.** `intent: true` is in `DEFAULT_CONFIG` (`packages/engine/src/config.ts:573`, D87/D125).
  `packages/sim/src/lab/funnel.ts:154-163` merges only the cards caches; `funnel.ts:24-25` and `:134-138` only warn
  when intent is on and no file is given, so every TOTAL line reads "[intent inert: no replay]". `docs/LAB.md:302`
  says the intent file is "not checked in"; `docs/LAB.md:89` and the file itself say otherwise
  (`packages/sim/lab/distilled/intent-v2.jsonl.gz`, 6,771 lines, train seeds 41-44 and held-out 10-11).
  - Stub funnel, `bun run funnel --suite train --seeds 41,42 --jobs 4 -- --packet-k 15,30,60`, without and with
    `--intent F` (verifier 1): pool hidden 230 to 257, decoys 229 to 240; top-15 hidden 265 to 275; top-30 287 to 309;
    top-60 hidden 292 to 320, decoys 299 to 307. Unranked hidden 92 to 64.
  - Replay of the committed reader cache (`--reader replay --reader-model claude-haiku-5-5 --allow-misses --jobs 4`):
    intent off replays 648 and misses 5 (TOTAL 247/127, 13.4 s); intent on replays 396 and misses 489.
  - Paid top-up with intent on (verifier 1, ledger-metered, $0.0743, 257 calls): hidden 279/384, decoys 133/384, 0
    misses. The finder's runs gave 276-279 / 133-137 (e.g. ledger run `audit3-intent-default-topup`, 255 calls,
    $0.0735). Paired against the inert replay (finder, not re-run): hidden +31, CI [+19.1, +42.9].
- **Impact.** Every reader or retrieval change is screened against a configuration that does not ship: it understates
  the shipped hidden score by about 31 tasks and overstates the unranked gap 1.44x (92 vs 64). Nothing that ships
  behaves differently, hence medium. Dev loop: an intent-on answer costs about 205 s and $0.07 today; with a committed
  intent-on cache it is a 10-13 s replay at $0 (estimate from the measured replay time).
- **Fix.** Funnel loads the committed intent replay by default when the config has intent and the file covers the
  run's suites and seeds (`--intent none` opts out; the header prints the state); record and commit an intent-on Haiku
  reader cache; relabel (not rewrite) intent-inert numbers in LAB.md and the root CLAUDE.md funnel line. The existing
  `intentMismatch` baseline check (`funnel.ts:143-151`) already refuses old inert `--baseline` files. Note for the
  fixer: the run label flag is `--run-label` (`free.ts:87`), not `--spend-run`.
- **Status.** Round 1, package `intent-shipped-baseline` (with F1, since both change what the cache must hold).

### F3. A deletion that lands while pushed items are being redacted is undone

- **Evidence.** `packages/engine/src/partner.ts:1767-1781` (`sourceItems`): `await this.redact(own)`, then
  `cache.revive(scope, ids)` and `sync.ingest(...)` with no check that the id was removed during the await.
  `sourceRemoved` (:1789) runs `dropGone` (:3604), which sets the gone-hold; the later `revive` lifts it. The re-read
  path does check (`partner.ts:3576-3584`). Both verifiers reproduced it in a scratch bun test (`p =
sourceItems(edited q1); sourceRemoved(['q1']); await p`), printing `removed 1 cached after The quarterly offsite
moved to Porto on 19 November. heldGone false`, with an async gate pool and also with the inline sanitizer.
- **Impact.** Deleted content stays cached and deliverable until the next sweep; breaks D126. Over HTTP with the
  default 0 gate workers the continuation runs as a microtask before the next request, so in practice it needs
  `EDEN_GATE_WORKERS > 0` or an embedder calling the methods without awaiting.
- **Fix.** `sync.mark()` cannot be used: it counts change signals and `sync.removed()` / `dropGone` never bump it
  (`sync.ts:305-321`, verifier 2). Before the await, note which sanitized ids are already held gone; after it, drop from
  `clean` any id held gone now but not before; revive and ingest the rest. A push after an earlier deletion still
  revives (the source sent it again). Regression tests with and without an async gate pool; update the engine
  CLAUDE.md pitfall.
- **Status.** Round 1, package `sourceitems-removal-race`.

### F4. `test:changed` after an engine edit runs most of the suite

- **Evidence.** `scripts/test-select.ts:83-108` adds every dependent of a touched package: engine pulls in server,
  eval and sim (`examples/personal-agent` depends only on `@eden/client`, so it is not included). Verifier 1 (4 cores):
  `bun scripts/test-select.ts pkg engine sim server eval` 17.96 s, 1,062 pass, 93 files; without `sim.test.ts`,
  `funnel-flags.test.ts`, `reader-stub.test.ts`, `deletes.test.ts`, `gate-traffic.test.ts` and
  `packages/eval/src/run.test.ts`: 8.91 s, 991 pass, 87 files.
- **Impact.** Engine inner loop 2.0x faster. `bun run check` unchanged and still runs every file. Cost: an engine
  change only the end-to-end simulation catches is found at `check`, not at `test:changed`.
- **Fix.** A deferred list in `test-select.ts` (not a rename: package CLAUDE.md files and docs name these files). Skip
  them only when their package is a dependent, never when it changed; print the skipped files and the command to run
  them. Test case in `scripts/test-select.test.ts`; document in docs/TESTING.md.
- **Status.** Round 1, package `test-changed-defer-e2e`.

### F5. Diagnostic outputs and live top-ups force the funnel onto one process

- **Evidence.** `packages/sim/src/lab/funnel.ts:213-218` builds `soloReasons` from `--packets`, `--card-log`,
  `--reader-log`, `--ask-diag`, `--candidates`, `--timeline`, `--record`, `--judge live` and `--reader live`; `:224-227`
  forces `jobs=1`. `hidden-funnel.ts:423-424` truncates the diag file at start, so shards would clobber each other as
  the code stands. Replay with `--ask-diag`: 24.4 s; without: 10.1 s (verifier 1, 2.4x; finder 2.15x). Ledger:
  `audit3-intent-default-topup` 255 calls over 181 s with 299 s summed latency (1.65 in flight).
- **Impact.** Diagnostics 2.2-2.4x faster (measured). Paid top-ups 3-4x faster is an estimate nobody measured; rate
  limits may bound it.
- **Fix.** Per-shard outputs (`<out>.part-N`, `<cache>.part-i`) merged afterwards like `mergeParts`; spend shared
  through the ledger with headroom covering N processes. Keep solo for `--record` and `--timeline` (per-process CPU and
  RSS would be contended); treat `--judge live` like `--reader live`. Proof compares diag files under one canonical
  sort, not the one-process order.
- **Status.** Deferred to round 2: it edits `funnel.ts` (owned by `intent-shipped-baseline`) and `hidden-funnel.ts`
  (owned by `ask-diag-coverage`).

### F6. The reader never reads one action request in six

- **Evidence.** The push starts only if `isImperative(event.text, MORE_VERBS)` (`packages/engine/src/partner.ts:668`);
  `readAsk` returns null unless imperative or `ASKS_BLOCKERS` (`partner.ts:1519-1521`); `isImperative`
  (`packages/engine/src/probes.ts:63-75`) accepts only `LEADING` or `MORE_VERBS` verbs. Both verifiers counted 124 of
  768 train tasks `readerOutcome: "skipped"` (62 hidden, 62 control, 31 templates, 38 distinct requests) from `bun run
funnel --json`. Openers include Switch, Cash in, Open, RSVP, Agree, Spin up, Promote, Export. Finder's paid runs
  (not reproduced): hidden +2 to +5 of 384 with intent on, CIs including zero; decoys -6 to -8.
- **Counter-evidence (verifier 2).** The proposed closed-class rule (an action unless it ends in "?" or starts with a
  pronoun, determiner, wh-word, auxiliary or preposition) treats "thanks!", "ok sounds good", "Lol", "Yes", "Done",
  "Got it", "Sam says hi" and "Good news: the offsite is on" as actions, and misses "When you do ...". Each would start
  a paid reader push from observe and use up the session Budget (20 calls, $0.02), which the funnel does not apply.
  The train funnel has one request per task, so it cannot see that cost.
- **Impact.** A correctness gap (16% of action requests not treated as actions) with an end-to-end gain of about 1-2
  points; real but small.
- **Fix.** D168: reject the closed-class rule; recognise verbs instead (wider verb list or a first-word verb check),
  block a short list of chat replies, measure on a suite with non-request messages and the Budget on, behind a trial
  switch with a COST-MODEL.md line.
- **Status.** Deferred to round 2: it must be screened on the intent-on cache and thresholds that
  `intent-shipped-baseline` produces, and its trial switch edits `packages/engine/src/config.ts`, which that package
  owns.

### F7. The remaining unranked facts are not candidates at all

- **Evidence.** `rank()` takes BM25F's top 12 (`partner.ts:2039`, `cache.search(s.scope, query, query.length, 12,
...)`). Stub with intent on and `--ask-diag` (both verifiers): 64 of 384 hidden at rank -1; median candidate list 21
  (5-61). Cap 12 to 60 in a scratch copy: pool hidden 257 to 258, decoys 240 to 237, top-15 hidden 275 to 262, rank -1
  64 to 61. Intent inert: 92 at rank -1 across 50 of 192 templates. Not reproduced: the reader flag rates and prompt
  bytes.
- **Impact.** Raising the lexical cap or the pool gives no net gain; the lever is a request-to-item bridge.
- **Fix.** D162: the cap stays at 12. Stage 1 ($0): `--ask-diag` says whether the planted item has intent requests
  and whether cards lean-skipped it, separating missing coverage from a bridge that does not match. Later trials
  (`intentConstraintAll`, which does not exist yet and would need a COST-MODEL.md estimate first) wait for that answer.
- **Status.** Round 1 stage 1, package `ask-diag-coverage`.

### F8. D113's multi-process router was decided but never built

- **Evidence.** D113(1) (`docs/DECISIONS.md:119`). `packages/server/src/main.ts:17-31` builds one gate pool, one
  partner, one `Bun.serve`; grep finds no `reusePort`, `cluster`, `availableParallelism` or router in
  `packages/server/src`. `bun packages/engine/bench/ingest.bench.ts 40 500 shipped` 4.86-4.98 s in one process; four
  concurrent `... 10 500 shipped` 2.23-2.69 s (1.81x finder, 2.07-2.21x verifier 1 on clean pairs). These include Bun
  start-up, so they are a proxy, not server events per second.
- **Verifier 2's gaps.** (1) One SQLite source map (`$EDEN_HOME/source-map.db`, `config.ts:81`) assumes one process
  per file (`source-map.ts:72-75`); N children would contend and drop outcome batches on `SQLITE_BUSY`
  (`source-map.ts:130-136`). (2) `TenantSpend` is per process (`build.ts:84`), so N children raise each tenant's daily
  dollar cap N-fold, and the per-tenant rate limit too (`config.ts:82-83`). (3) The tenant is in the auth header but
  `userId` is in the JSON body (`http.ts:47-80`), so the router must parse bodies.
- **Fix.** D163: Stage 1 builds the router with one source map per child and divides per-tenant spend and rate caps by
  N in the same change (amends D113's "per-tenant caps become per-process").
- **Status.** Round 1, package `server-router`.

### F9. Memory per user is mostly graph objects and UTF-16 text

- **Evidence.** `bun packages/engine/bench/ingest.bench.ts --quick`: core 2,904 B/item, +graph 1,721, shipped 4,639
  released (both verifiers). Sim world (`buildWorld` seed 1, 6,892 items): 29.4% of items hold 74.2% of characters
  outside Latin-1; text 1,890 B/item as stored, UTF-8 1,090, deflate-6 365 (verifier 1). Verifier 2's heap breakdown of
  the graph: GNode objects and arrays 428 B/item, key and label strings 451, the `ids`/`slots` Maps 502, memo 215,
  `placedAt` 110. Every node's label differs from its key, so a sparse label map saves nothing.
- **Impact.** Verifier 2 estimates stage 1 as proposed at about 1.6x on the graph and 1.15x per user, not 2.5-2.9x and
  2.2x; the `ids`/`slots` Maps (502 B/item) are the bigger lever the finding left out.
- **Fix.** D169: stage 1 only, with the Maps replaced too (typed-array open-addressing from key to node id), gate at
  least 2x smaller `+graph` B/item with walks identical; if the gate fails, record the numbers and do not merge.
- **Status.** Round 1 stage 1, package `graph-soa`. Stage 2 (deflated `item.text`) deferred: 41 non-test reads of
  `item.text` include per-candidate reads on the ask path in `partner.ts` (owned by `sourceitems-removal-race`) and
  it reopens D111, so it waits for both packages and comes back as a trial.

### F10. Request-side query expansion for the last unranked facts

- **Evidence.** 64 hidden facts never rank in the top 60 with intent on (`bun run funnel --jobs 4 -- --reader stub
--intent F --packet-k 15,30,60`, verifier 1). D89's `bridgeQuery` was deleted by D112 (`docs/DECISIONS.md:96`,
  :118); it never fed the reader's pool (the reader came later, D95). Verifier 2: D89's measured history (+15 hidden of
  240 on dev with 2 ask seats, +4 bridge alone, +2 in-sample, all dev gain from 5 dev6a templates) points to about
  1.07-1.15x fewer misses, not 1.4-1.9x. D115 found widening the reader pool raised false concerns 0.0% to 4.7%.
  D99 found the reading must land before the agent answers.
- **Fix.** Stage 1 lab-only `--bridge F` replay screen, then a trial with its own Budget and a COST-MODEL.md entry.
- **Status.** Deferred to round 2: the unranked set it targets changes with F1's thresholds
  (`intent-shipped-baseline`), and F7's diagnostic (`ask-diag-coverage`) decides whether the gap is coverage or bridge.
  It also edits `hidden-funnel.ts`, owned by `ask-diag-coverage`.

### F11. Eden's path is reader model time

- **Evidence.** Final Pi run, held-out 13, seeds 41-44, eden arm (`.local/mkt/final-pi-4N/tasks.jsonl`, both
  verifiers' scripts). Hidden: wall mean 3,979 ms; Eden on path 1,372 ms (34.5%), cap 1.53x if Eden took no time.
  Control: wall 5,344 ms, on path 2,083 ms, cap 1.64x. Reader (441 calls): p50 998, p90 1,471, mean 1,088 ms; fit 702 ms
  - 2.60 ms per output token. Reader time is 94.5% (hidden) and 92.4% (control) of Eden's path, not 99% (verifier 2).
    A reader-only change caps at about 1.13-1.15x on task wall (verifier 2's arithmetic).
- **Fix.** D165, and the decomposition in COST-MODEL.md. `pi-ab-report.ts` already prints the critical path
  (`:237-262`); add a per-kind and observe/ask split instead of a new flag.
- **Status.** Round 1, package `close-docs-ceilings`.

### F12. Prompt-caching the reader's items cannot reach 1.5x

- **Evidence.** `bun run funnel --jobs 1 -- --reader stub --reader-log F` (verifier 1): 658 calls, mean 7,498 chars,
  standing prefix 0 everywhere, so the `standing` cache path (`reader.ts:285-303`) never fires; shared item prefix
  2.88% (1.72% sorted). Items are 56.0% of the whole prompt, not 90.2%. Ledger: reader input about 33-35% cached (the
  system block); output about 30% of reader cost. Verifier 2's bound: even with every ask reusing its push's prompt,
  at most 1.28x (estimate).
- **Fix.** D164; a row in COST-MODEL.md's "Where 3x is impossible" table, numbers labelled measured or estimate.
- **Status.** Round 1, package `close-docs-ceilings`.

### F13. Moving the push off the agent's start loses most useful pushes

- **Evidence.** Eden arm, final Pi run: hidden tasks with a useful push end in one request 66 times, two requests 9
  times; control 10 and 10 (verifier 1's join). `readerPushWaitMs: 60_000` (`config.ts:588`), observe races it
  (`partner.ts:683-688`), capped in practice by the 3,000 ms `waitMs`. D118's off-path variant measured hidden 81.3% to
  75.0%. Request count is partly caused by the push, so "88% never read" overstates the loss; D118 is the measurement
  that holds.
- **Fix.** D166, a one-line cross-reference in COST-MODEL.md.
- **Status.** Round 1, package `close-docs-ceilings`.

### F14. The ask's poll and the reader: closing O9's item

- **Evidence.** `eden.sync.freshen` spans inside asks: mean 13-17.5 ms, p90 0.1 ms, max 797 ms (verifiers' scripts).
  The reader's pool comes from the `searchLive` result (`partner.ts:1253`, `:1303-1309`), so it cannot start earlier
  without reading a different pool. Upper bound 1.13-1.14x on ask batches, about 1.01x on task wall.
- **Fix.** D167; mark `lat-ask-reader-overlap-poll` closed in the 2026-11-05 audit's open-items table (O9). The other
  two O9 items stay open.
- **Status.** Round 1, package `close-docs-ceilings`.

## Round 1

### Decisions taken in planning

The owner delegated judgement calls. Each is a row in docs/DECISIONS.md with its evidence: D158 (the lab screens the
shipped default with intent replayed), D159 (promote the looser intent thresholds, conditional on a Pi pair), D160
(how `sourceItems` respects a removal that lands during redaction), D161 (defer six end-to-end files in
`test:changed`), D162 (the ask's lexical cap stays at 12), D163 (router stage 1 splits per-tenant caps and source
maps), D164-D167 (four closed ceilings), D168 (the closed-class imperative rule is rejected), D169 (graph
struct-of-arrays gate). Packages do not edit docs/DECISIONS.md; each reports its measured outcome in its commit
message and owned docs, and the integration step appends the outcome to the row.

### Work packages

No two packages share a file. Paid spend is ledger-metered with the flags above; round 1's estimated paid total is
about $1.3 (estimate: F1/F2 package about $1.2, everything else $0).

| Package                    | Findings           | Files it owns                                                                                                                                                                                                                                                                   |
| -------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `intent-shipped-baseline`  | F1, F2             | `packages/sim/src/lab/funnel.ts`, `packages/engine/src/config.ts`, `packages/engine/src/intent.test.ts`, new `packages/sim/lab/distilled/reader-haiku-train-4142-intent.jsonl.gz`, `docs/LAB.md`, `CLAUDE.md`, `packages/sim/src/lab/CLAUDE.md`, `docs/research/edge-intent.md` |
| `sourceitems-removal-race` | F3                 | `packages/engine/src/partner.ts`, `packages/engine/src/freshness.test.ts`, `packages/engine/CLAUDE.md`                                                                                                                                                                          |
| `test-changed-defer-e2e`   | F4                 | `scripts/test-select.ts`, `scripts/test-select.test.ts`, `docs/TESTING.md`                                                                                                                                                                                                      |
| `ask-diag-coverage`        | F7 stage 1         | `packages/sim/src/lab/hidden-funnel.ts`                                                                                                                                                                                                                                         |
| `server-router`            | F8                 | new `packages/server/src/router.ts`, new `packages/server/src/router.test.ts`, new `packages/server/bench/router.bench.ts`, `packages/server/src/config.ts`, `packages/server/src/build.ts`, `packages/server/CLAUDE.md`, `docs/ARCHITECTURE.md`                                |
| `graph-soa`                | F9 stage 1         | `packages/engine/src/kg.ts`, `packages/engine/src/kg.test.ts`, `packages/engine/bench/ingest.bench.ts`, new `docs/research/graph-soa.md`                                                                                                                                        |
| `close-docs-ceilings`      | F11, F12, F13, F14 | `docs/COST-MODEL.md`, `docs/audits/2026-11-05-deep-audit.md`, `packages/sim/src/lab/pi-ab-report.ts`                                                                                                                                                                            |

### Deferred to round 2

| Finding                                    | Waits for                                      | Why                                                                                                                  |
| ------------------------------------------ | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| F5 `devloop-ask-diag-forces-one-process`   | `intent-shipped-baseline`, `ask-diag-coverage` | Edits `funnel.ts` and `hidden-funnel.ts`, which those packages own                                                   |
| F6 `quality-push-skipped-imperative-list`  | `intent-shipped-baseline`                      | Must be screened on the intent-on cache and thresholds that package produces; its trial switch edits `config.ts`     |
| F10 `moonshot-ask-query-expansion-ceiling` | `intent-shipped-baseline`, `ask-diag-coverage` | Its target set changes with the new thresholds; F7's diagnostic decides coverage vs bridge; edits `hidden-funnel.ts` |
| F9 stage 2 (deflated item text)            | `graph-soa`, `sourceitems-removal-race`        | Reads of `item.text` on the ask path are in `partner.ts`; the bench is owned by `graph-soa`; reopens D111 as a trial |
