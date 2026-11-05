# Testing

## Commands

| Command | What it runs | When |
|---|---|---|
| `bun run test` | Every `*.test.ts` under packages/, examples/, scripts/, in parallel (`scripts/test.sh`) | Before a merge (part of `check`) |
| `bun run test:changed` | Packages touched since the merge base with origin/main, plus their dependents | The inner loop |
| `bun run test:pkg engine sim` | Named packages | Working inside one package |
| `bun run check:fast` | format:check + typecheck:fast (tsgo) + test:changed | Before pushing a work-in-progress commit |
| `bun run typecheck:fast` | The typecheck on tsgo, TypeScript 7's native preview (about 5x faster) | The inner loop |
| `bun run typecheck:parity` | tsc and tsgo one after the other; fails when their errors differ | After bumping either checker |
| `bun run check` | format:check + typecheck + every test | Before every merge (CLAUDE.md) |
| `CHECK_COLD=1 bun run check` | The same, without the Prettier and tsc caches | When a cache is in doubt |
| `bun test ./packages/x/src/y.test.ts` | One file | Debugging; **from the repo root only** |

`bunfig.toml`'s preload (`scripts/test-preload.ts`: temp `HOME` and `EDEN_HOME`, `EDEN_*` and `OPENROUTER_*`
cleared) is read from the working directory, so `bun test` started inside a package skips it. `test:changed` treats
a change outside packages/ and examples/ (scripts, bun.lock, tsconfig, bunfig) as "run everything", and skips
Markdown-only changes. `TEST_SERIAL=1 bun run test` runs in one process, as before parallelism.

A bare `bun test` at the repo root skips `archived/` through `pathIgnorePatterns` in `bunfig.toml`, so it runs the
same 102 files as `scripts/test.sh`, but serially: 1,362 pass, 0 fail in 30.0 s (Bun 1.4.4, 2026-11-03). Before the
ignore it also ran archived/'s 530 test files: 687 files, 487 fail, about 215 s. `bun run test` stays the parallel
path (about 16 s). The key was checked on Bun 1.3.13 (`packageManager`) too: 102 files and a planted failing test
under archived/ not run. On 1.3.13 three tests in those files fail (`utf8.test.ts` astral/lone-surrogate length, also
failing with the old bunfig, and two `redos.test.ts` timing tests), and the run took 107 s; the gate is measured on
1.4.4.

## Caches in format:check and typecheck (measured 2026-11-03, 4-core container, Bun 1.4.4)

`scripts/format.sh` runs Prettier with `--cache --cache-strategy content`, and `scripts/typecheck.sh` runs `tsc
--incremental` with one build-info file per `tsconfig.json` (named from its path). Both caches live under
`node_modules/.cache/`, which git ignores. Prettier's cache skips only files whose content matches a run that found
them formatted, and its key covers the Prettier version and options; tsc re-checks whatever an edit can reach.
`scripts/check-line-length.ts` has no cache and still reads every file, so an overlong comment is always caught.
`CHECK_COLD=1 bun run check` (or `format:check`, `typecheck`) drops both caches: use it when a cache is in doubt.

| Step | Before (no cache, 2 runs) | Cold cache | Warm cache |
|---|---|---|---|
| `bun run format:check` | 11.8 s, 10.7 s | 10.6 s | 2.4 s, 2.7 s, 2.1 s |
| `bun run typecheck` | 9.8 s, 8.6 s | 9.9 s | 3.8 s, 3.0 s, 3.2 s |
| `bun run check` | | 39.8 s (`CHECK_COLD=1`) | 21.1 s |

On a warm cache, each of these still failed the check: a new untracked misformatted file (format:check, 2.6 s), a
type error appended to `packages/engine/src/anticipate.test.ts` (typecheck, 3.4 s), and a 143-column comment
(format:check, 2.6 s). A warm typecheck after an edit to a widely imported file costs close to a cold one (about
8 s in the audit that proposed the caches; not re-measured here). Tests now dominate the check: 15.7 s of the warm
21.1 s.

## tsgo in the fast loop (measured 2026-11-03b, 4-core container shared with other agents, Bun 1.4.4)

`scripts/typecheck.sh` takes `TYPECHECK=tsc` (the default), `tsgo` or `parity`. tsgo is TypeScript 7's native
checker, `@typescript/native-preview` pinned to `7.0.0-dev.20260707.2` as a devDependency (dev only: nothing in
`packages/` imports it). `bun run check:fast` and `bun run typecheck:fast` use it; **`bun run check` keeps tsc 5.9.3
as the gate** until TypeScript 7 is stable. Each checker keeps its own build-info file (`*.tsgo.tsbuildinfo` for
tsgo), so switching between them never reads the other's format. `bun run typecheck:parity` runs both with
`--pretty false` and fails, printing both outputs, when their errors differ by file, line, column or code (message
wording may differ between versions) or one passes where the other fails.

Two rounds of `scripts/typecheck.sh` (wall, user CPU; the edit appends an exported const to
`packages/protocol/src/index.ts`, which most of the repo imports):

| Run | tsc | tsgo | Ratio (wall) |
|---|---|---|---|
| Cold (`CHECK_COLD=1`) | 13.3 s / 17.1 s; 9.1 s / 17.2 s | 1.57 s / 4.2 s; 1.61 s / 4.3 s | 5.7-8.5x |
| First incremental run (builds the cache) | 14.0 s; 9.5 s | 2.04 s; 1.72 s | 5.5-6.9x |
| Warm, no edit | 5.3 s; 4.5 s | 2.18 s; 1.72 s | 2.4-2.6x |
| After the edit | 10.6 s / 16.5 s; 13.0 s / 17.0 s | 1.89 s / 4.3 s; 3.22 s / 3.9 s | 4.0-5.6x |

Parity (`bun run typecheck:parity`): the clean tree gave 0 errors from both; six planted errors in
`packages/protocol/src/index.ts` each gave the same single error from both checkers: TS2322 (string to number),
TS2307 (missing module), TS7006 (implicit any), TS2353 (excess property), TS2532 (`Map.get(...).n`) and TS2339
(missing property). Make tsgo the gate after about a month of parity runs that agree.

## Parallel runs (measured 2026-11-02, 4-core container, Bun 1.4.4)

`scripts/test.sh` passes `--parallel` to `bun test` when the installed Bun has it: one worker per core, each file in
a fresh global (`--isolate`), each worker with its own preload and temp HOME.

| Run | Wall | Result |
|---|---|---|
| Serial, before (main) | 32.3 s | 1,308 pass, 99 files |
| Parallel, `linear.test.ts` unchanged | 21.6 s | 1 fail: the RE2 equivalence test timed out at Bun's 5 s default under contention |
| Parallel, after (3 runs) | 12.5 s, 13.4 s, 13.5 s | 1,308 pass, 100 files |
| Serial, after (`TEST_SERIAL=1`) | 32.2 s | 1,308 pass |

The fix that made parallel pass and balance: the redact timing tests moved from `linear.test.ts` to `redos.test.ts`
(so two workers share the 10 s that file took alone), and the RE2 equivalence test got an explicit 30 s timeout like
its neighbour's 60 s. The `expect()` count was 1,111,674 in both serial runs and in one of the three passing
parallel runs, 1,111,669 in the other two. Traced in the 2026-11-03b audit: `spans.test.ts`'s "every phase" test
used an unseeded `SourceMap`, whose routing draw (Thompson sampling seeded from `Math.random`) set the order the
sources were asked in, and so whether one probe page was stored on its own: one `cache.put` span (five `expect()`
calls) more or less per run. Its map is seeded now, and a test asserts the same spans across five plays. Five
consecutive `bun run test` runs then gave 1,112,544 `expect()` calls each, and two junit runs
(`./scripts/test.sh --reporter=junit`) the same assertion count for every one of the 1,431 tests.

## Sleep-free timing tests (2026-11-03b, 4-core container shared with other agents, Bun 1.4.4)

Tests that slept past a delay now hold the call and release it: `slow-path-queue.test.ts` (a judge and a slow
search whose calls the test answers, in the order the interleaving needs), `source-calls.test.ts` (waits until no
search is in flight and nothing changes for 50 event-loop turns, instead of 200 ms per request), and
`reader.test.ts`'s "readerPushWaitMs 0" (a held reading). `QueryPlanner` takes an optional `now` (default
`performance.now`), so its deadline tests run on a fake clock the connector advances. `reader-stub.test.ts` starts
its three funnel processes at once in `beforeAll` (same `--limit 2`, same assertions). The ReDoS sweep is split by
rule index over `redos.test.ts` and `redos-{1,2,3}.test.ts` (`redos-sweep.ts`), and times each run as the lesser
of wall and CPU time: split, a wall-clock-only timing failed 4 of 5 `test:pkg redact` runs beside 8 busy loops
(rules at 40–59 ms), where the unsplit file passed 5 of 5; with the lesser of the two, 6 of 6 passed (one failure
in `warm.test.ts`, which also failed once in 5 on the old files). A test checks the measure still flags
`curl-auth-header` on JavaScript's engine (about 78 ms against the 40 ms ceiling).

Each file alone (`bun test ./file`; CPU is user time):

| File | Before | After |
|---|---|---|
| packages/engine/src/slow-path-queue.test.ts | 5,468 ms (CPU 0.35 s) | 214–286 ms (CPU 0.25–0.28 s) |
| packages/engine/src/source-calls.test.ts | 1,782 ms (CPU 0.33 s) | 379–460 ms (CPU 0.27–0.33 s) |
| packages/engine/src/reader.test.ts | 3,198 ms | 2,187–2,286 ms (the rest are wait-bound tests, real delays by design) |
| packages/sim/src/lab/reader-stub.test.ts | 6,117 ms (CPU 8.6 s) | 2,896–5,280 ms (CPU 8.2–8.6 s) |
| packages/redact/src/redos.test.ts | 5,966 ms | four files, 1,526–1,930 ms each |
| packages/sources/src/planner.test.ts | 602 ms | 72–138 ms |

`bun run test:pkg`, base and new files alternated three times on the same machine (load average 3.4–4.6 from
other work): engine 6.6, 7.5, 7.3 s → 6.5, 5.7, 6.1 s; sim 7.9, 8.4, 9.6 s → 6.9, 6.1, 6.5 s; redact 7.8, 7.1,
8.1 s → 5.8, 4.8, 5.4 s; sources about the same (1.2–1.6 s → 1.4 s). The whole suite, alternated twice: 16.9,
19.5 s → 16.4, 17.9 s (1,425 → 1,431 tests). The gate is CPU-bound (about 63 s of CPU over 4 cores), so removing
sleeps shortens the package loops more than the full run; `reader-stub.test.ts` still spends 8.6 s of CPU in its
three funnel processes and is what keeps sim above its earlier 4–4.5 s.

## The sim lab's subprocess tests (2026-11-03b, round 3)

Round 2's `funnel-flags.test.ts` ran its funnel processes one after another and left a scratch directory in /tmp per
run, as did `reader-stub.test.ts`. Now:

- The NEWL stub run's checks (inert stamp, label, reader log, sync item counters) read `reader-stub.test.ts`'s
  first stub run, which also writes the reader log: one `hidden-funnel.ts` process fewer, same assertions.
- `funnel-flags.test.ts` starts its three runs (the `--overlap` run and the two `--time` shard runs) together in
  `beforeAll`; each test awaits its own.
- The `--time` shards test runs two seeds (two shards, so the "2 at a time" assertion still means sharding) at
  `--limit 1` instead of 2. It stays at `--time 0.05`: at 0.005 the connector sleeps are as short as a loaded
  machine's scheduling jitter, and one run in three gave a task different call counts in the two runs.
- Every funnel run in both files caps the preset's sync at 100 items a user (`syncMaxItems: 100`, `--set` for
  `funnel.ts`; 3,000 by default). The sync still backfills, polls and fills both item counters, and every check
  still holds; storing 3,000 items was 0.8 s of each NEWL run's 2.5 s user CPU (`bun --cpu-prof`), and one NEWL stub
  run drops from 2.5 s to 1.7 s user CPU, the `--time` solo run from 3.3 s to 2.3 s wall.
- Both files remove every directory they make (`afterAll`).
- `sim.test.ts`'s "a run without updates scores exactly as before" (two full `runQuality` runs, 2.1-2.5 s alone)
  has a 20 s timeout; it hit bun's 5 s default under the parallel gate in the audit.

Measured on the same machine: `bun run test:pkg sim` 12.3, 12.3, 12.3 s wall (33.4-33.7 s user CPU) before,
10.7, 10.6, 9.3 s (29.1-32.3 s) after, 156 pass and 3,060 `expect()` calls both times. Each file alone:
funnel-flags 8.6 s (15.4 s CPU, 10 tests, 48 `expect()`) → 5.4 s (12.8 s, 9 tests, 33), reader-stub 4.2 s
(9.0 s, 12 tests, 76) → 5.1 s (8.4 s, 13 tests, 91). The package is CPU-bound now: a profile of one NEWL
`hidden-funnel.ts` run (`bun --cpu-prof`, 2.3 s sampled) puts 0.9 s in the sync backfill (`sync.ts` `backfill` →
`store` → `cache.put`, the knowledge graph's `extract` and the secret gate) and 0.36 s in building the simulated
sources, so running the funnel in-process would save only the start-up. `bun run test`, five runs in a row after
the change: 1,489 pass, 0 fail, 1,206,716 `expect()` calls each, 18.7-22.3 s wall (load average 4-9 from other
agents).

With the sync capped (above), same machine, load average 6-7 from other agents: `bun run test:pkg sim` 6.9, 7.1,
7.5 s wall (21.0 s user CPU in one timed run, against 29.6-33.7 s before the cap and 8.9-12.0 s wall on the same
afternoon), 156 pass and 3,060 `expect()` calls; funnel-flags alone 2.7-2.8 s (7.6-8.0 s user CPU, was 4.3-5.4 s
and 13.0 s), reader-stub alone 3.3 s (5.5 s, was 3.0-3.2 s and 8.4 s). The two files passed 8 runs in a row at
load average 7-14. The 7 s target is met only on a machine no busier than that; main's 3.7-4.4 s is not reached:
the files still run seven funnel processes (three NEWL, the overlap run, three for the shards).

## Round 1's slow tests trimmed (2026-11-05, 4-core container shared with other agents, Bun 1.4.4)

The 2026-11-05 audit's first round added about 6.6 s of per-file test time; three of its tests were trimmed, with
what each proves kept:

- `review-regressions.test.ts`, "shown means handed out": the `SlowSource` (300 ms search) and the fixed
  `Bun.sleep(1_500)` gave way to a `HeldSource` whose search is held until the test releases it, as
  `slow-path-queue.test.ts` does; the test then turns the event loop until the session's queue holds the packet
  (a test-only read of the partner's private `sessions`, which `takePending` would empty).
- `sources/src/regressions.test.ts`, the results cache's heap test: 50,000 pages one every 30 simulated ms (1,500 s,
  past the 600 s expiry) instead of 200,000 every 10 ms. With `guarded.ts` from 6911f514d (before the fix) put
  back, it still fails: 50,050 entries held against the `< 10,000` bound.
- `sim.test.ts`, "user-range tallies merge": 2 users x 2 sessions, shards [0,1] and [1,2] (was 3 x 3, [0,1] and
  [1,3]). Each user costs about 0.65 s of fixed work (the simulated connectors' index and the sync backfill of
  ~1,500 items; one CPU profile), so four user-plays is the floor for a whole run plus two shards.

Each file alone (`bun test ./<file>`, wall from `date`, two alternating rounds at load average 2.7-3.9):

| File | Before (audit/2026-11-05-integration) | After |
|---|---|---|
| packages/engine/src/review-regressions.test.ts (33 tests) | 3,999 ms, 4,028 ms | 1,078 ms, 1,015 ms |
| packages/sim/src/sim.test.ts (15 tests) | 9,351 ms, 8,289 ms | 7,246 ms, 6,625 ms |
| packages/sources/src/regressions.test.ts (18 tests) | 2,681 ms, 2,354 ms | 828 ms, 753 ms |

Full suite, `./scripts/test.sh --reporter=junit`, per-file `time` summed (132 files, 1,588 tests), alternating
before and after on the same machine while other agents ran (load average 1.0-9.0):

| Run | Before | After |
|---|---|---|
| Quietest pair (load 1.0-3.0) | 95.4 s (wall 25.2 s) | 93.1 s (wall 24.1 s) |
| Other pairs | 97.9, 103.9, 126.0, 101.1, 99.9, 141.0 s | 95.3, 96.4, 96.3, 90.2, 93.8, 110.1, 132.6 s |

Junit per test (a before run at load 2.7, an after run at 4.2): the two queued-packet tests 1.51 s each → 0.015 s;
the heap test 3.25 s → 1.23 s; the user-range test 7.29 s → 5.21 s under the parallel run (3.09 s alone). The
audit's 90 s target for the sum was not reached on this shared machine: the sum swings by more than the about 7 s
these changes save (the per-test differences above). The one failure seen in these runs (after, load 9.0) was
`cards.test.ts`'s "linear on hostile input", a 50 ms wall bound outside this change.

## The slowest files (each alone, `bun test <file>`, wall incl. ~70 ms start-up)

| File | ms | Where the time goes | Proposal |
|---|---|---|---|
| packages/redact/src/linear.test.ts (before the split) | 9,541 | "every gitleaks rule outside RE2_RULES" 6.5 s; RE2 vs JS equivalence 3.7 s | Done: split into `linear.test.ts` + `redos.test.ts` |
| packages/sim/src/sim.test.ts | 3,542 (6,625-7,246 on 2026-11-05, above) | "a run without updates scores exactly as before" 2.1 s (two `runQuality` runs) | Share one `runQuality` result between the tests that read it, or 3 sessions instead of 6 (it has a 20 s timeout now) |
| packages/server/src/http.test.ts | 2,671 | the 60,000-deep body test 2.5 s | See validate below |
| packages/protocol/src/validate.test.ts | 2,305 | 60,000-deep array: `JSON.stringify` throwing RangeError costs 2.3 s in JSC (20,000 deep: 2 ms, no throw) | Find the smallest depth that still overflows on Linux and macOS and use it; keep one deep case |
| packages/primitives/src/sparse-index.test.ts | 1,349 | randomized index checks | Fewer iterations behind a constant, full count in a bench |
| packages/primitives/src/bandit.test.ts | 1,268 | statistical convergence runs | as above |
| packages/sim/src/lab/suites.test.ts | 1,213 | builds worlds for every suite | One world per seed shared by the registry tests |
| packages/engine/src/partner.test.ts | 1,143 | 74 tests | (protected while the engine is being edited) |
| packages/engine/src/reader.test.ts | 2,187 | wait-bound tests with real delays (300–400 ms readings) | Sleep-free where the test is not of a wait bound (2026-11-03b) |
| packages/sim/src/lab/reader-stub.test.ts | 3,340 | three `hidden-funnel.ts` processes (5.5 s CPU), run at once; also holds the NEWL flag checks | Done: sync capped at 100 items (was 8.4 s CPU); next, build the simulated sources once per seed |
| packages/redact/src/redos*.test.ts | 1,526–1,930 each | the crafted-input sweep, split over four files | Done (2026-11-03b) |
| packages/sim/src/lab/hermes-host.test.ts | 1,117 | starts servers and stub workers | (protected) |

Per package, summing each file alone: engine 14.6 s, redact 10.1 s, sim 9.2 s, primitives 5.0 s, server 2.9 s,
sources 2.8 s, protocol 2.3 s, eval 0.6 s, graph 0.3 s, client 0.1 s, llm 0.1 s (47.8 s in all, start-ups included).

## Scale anchors: memory per user and ingest cost (2026-11-03, 4-core container shared with other agents, Bun 1.4.4)

`bun packages/engine/bench/ingest.bench.ts [users=200] [itemsPerUser=500]` syncs that many users through the real path
(`SyncManager` → `SourceFanout.list` with `sanitizeItem` as the redaction hook → `ItemCache.put`), each with their own
copy of the workload's items (1,599 chars of text on average), then sweeps every user once with nothing changed. It
prints the heap per user after a full GC and the CPU per item of the backfill (every item new) and of the sweep (every
item unchanged). A change to the cache, the index, redaction or the sync reports these before and after.

| 100 users × 500 items | memory per user | backfill µs/item | unchanged sweep µs/item |
|---|---|---|---|
| Before skipping unchanged items (main at 926b094), 5 runs | 1,812 KB (3,711 B/item) | 111.2-117.3 | 41.3-44.4 |
| Unchanged items reuse their redacted copy, 5 runs | 1,833 KB (3,754-3,755 B/item) | 110.4-118.4 | 3.6-4.8 |

The default size (200 × 500) took 20 s wall and gave 1,794 KB per user, 153 µs/item backfill and 45 µs/item sweep
before the change (a busier machine at the time). The reuse adds 43-44 B/item (measured); what makes it up (the
hash field on each entry, a `madeFrom` WeakMap entry per held copy) is not measured apart.

## Rules for new tests

- Behaviour changes get a test first (CLAUDE.md); a regression found in review gets its own test.
- New state gets an isolation test (two users, two tenants or two sessions).
- No real network, no real keys: fake `fetch`, `FakeModel`, injected clocks (`pacing.test.ts`).
- Wall-clock ceilings only for ReDoS-style guards, best of three, with headroom for a parallel run. To show that
  work was done ahead of time, count the work (`warm.test.ts` counts pattern compilations and first runs through
  counting engines) rather than timing the call.
- A test over 5 s gives its own timeout and says why.
