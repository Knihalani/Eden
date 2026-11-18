# Testing

## Commands

| Command | What it runs | When |
|---|---|---|
| `bun run test` | Every `*.test.ts` under packages/, examples/, scripts/, in parallel, slowest first, then the real-time tail (`scripts/test.sh`, D811) | Before a merge (part of `check`) |
| `bun run test:changed` | Packages touched since the merge base with origin/main, plus their dependents, minus six end-to-end files of packages that are only dependents (D161, below) | The inner loop |
| `bun run test:pkg engine sim` | Named packages | Working inside one package |
| `bun run check:fast` | format:check + typecheck:fast (tsgo) + test:changed | Before pushing a work-in-progress commit |
| `bun run typecheck:fast` | The typecheck on tsgo, TypeScript 7's native preview (the gate's checker since D816) | The inner loop |
| `bun run typecheck:parity` | tsc and tsgo one after the other; fails when their errors differ | After bumping either checker |
| `bun run check` | format:check + typecheck + the tests whose inputs changed (D650) | While developing |
| `CHECK_COLD=1 bun run check` | The same with every test and no Prettier, tsc or test-result cache | Before every merge and in every review (D657) |
| `TEST_CACHE=0 bun run test` | Every test file, whatever passed before | When a skipped test is in doubt |
| `bun scripts/test-cache-audit.ts --write` | Each test file under strace: what it reads against what its key covers; rewrites `scripts/test-cache-verified.txt` | After changing `scripts/test-cache.ts`; when a test reads files in a new way |
| `bun test ./packages/x/src/y.test.ts` | One file | Debugging; **from the repo root only** |

**Screens, not tests: the retrieval screen (audit 2026-11-06 F25, docs/LAB.md recipe 1d).** Before the $0 funnel on all
of train, a change to retrieval, ranking, intent, probes or sync can be screened on half of it: `bun
packages/sim/src/lab/retrieval-screen.ts run --set '{...}' --baseline .local/screen-base.json` (train1–6, seed 41;
6.0–6.4 s against `bun run funnel`'s 10.0–10.5 s on 4 cores, 11.8–12.5 s against 22.1 s at `--jobs 1`; measured
2026-11-06, load 1.4–3.4). Its rows equal the funnel's for the same tasks; its totals can show the wrong sign for a
change that moves only a few tasks, so `bun run funnel --baseline` still gates. Its unit tests
(`retrieval-screen.test.ts`, 14 ms) and the router-on-sim bench's (`router-sim.test.ts`, 0.42–0.47 s, builds three
worlds) are in `test:pkg sim`.

`bunfig.toml`'s preload (`scripts/test-preload.ts`: temp `HOME` and `EDEN_HOME`, `EDEN_*` and `OPENROUTER_*`
cleared) is read from the working directory, so `bun test` started inside a package skips it. `test:changed` treats
a change outside packages/ and examples/ (scripts, bun.lock, tsconfig, bunfig) as "run everything", and skips
Markdown-only changes. `TEST_SERIAL=1 bun run test` runs in one process, as before parallelism.

### End-to-end files deferred by `test:changed` (D161, measured 2026-11-06, 4-core container, Bun 1.4.4)

`DEFERRED` in `scripts/test-select.ts` lists six end-to-end files: `packages/sim/src/sim.test.ts`,
`packages/sim/src/lab/funnel-flags.test.ts`, `packages/sim/src/lab/reader-stub.test.ts`,
`packages/sim/src/deletes.test.ts`, `packages/sim/src/lab/gate-traffic.test.ts` and `packages/eval/src/run.test.ts`.
When `test:changed` (and so `check:fast`) selects sim or eval only because it depends on what changed, it skips these
files, passing `--path-ignore-patterns` to `bun test` through `scripts/test.sh`, and prints them with a `bun test`
command that runs them. When sim or eval itself changed, its files run. `test:pkg` and `bun run check` run every file;
`test:changed` still runs everything when a change is outside the packages. A package left with no other test file
drops out of the run (eval, whose only test file is `run.test.ts`, after an engine edit). A Bun without
`--path-ignore-patterns` runs the files rather than fail. The cost: an engine change that only the end-to-end
simulation catches passes the fast loop and fails at `check` (or in `bun run eval`, which engine behaviour changes run
anyway).

A one-line comment appended to `packages/engine/src/text.ts`, `bun run test:changed` (selects engine, server, sim and
eval), wall time of the whole command:

| | Wall | Tests | Files |
|---|---|---|---|
| Before (integration tip 46285584e) | 18.50 s, 18.24 s | 1,062 pass, 0 fail | 93 |
| After (`--base HEAD` over the committed change, so the selection is the same) | 9.26 s, 9.48 s | 991 pass, 0 fail | 87 |
| The printed command for the six, serial | 15.00 s | 71 pass, 0 fail | 6 |

About 1.9-2.0x on the engine inner loop; 991 + 71 = 1,062, so nothing is lost, only moved to `check`.

### The graph's differential test at 25 seeds in `test:changed` (D176, measured 2026-11-06, 4-core container)

History: `kg.test.ts` and `kg-store.test.ts` were deleted with the knowledge graph (D225, 2026-11-07;
docs/research/fix-w2a-parts.md), and `scripts/test-select.ts`'s `FAST_ENV` (`KG_DIFF_SEEDS=25` under
`test:changed`) went with them. What follows is the record of the time it saved.

`packages/engine/src/kg.test.ts` checks `UserGraph` against an in-file copy of the storage before D169
(`PreviousGraph`) over `KG_DIFF_SEEDS` seeds, 200 by default. `test:changed` (and so `check:fast`) sets
`KG_DIFF_SEEDS=25` (`FAST_ENV` in `scripts/test-select.ts`) and prints it; `test:pkg`, `bun run check` and a plain
`bun test` run 200. A value the caller sets stands (`KG_DIFF_SEEDS=200 bun run test:changed` runs the full oracle).
The variable has no `EDEN_` prefix because `scripts/test-preload.ts` clears those. The same edit to `text.ts` as
above, committed, `bun scripts/test-select.ts changed --base HEAD`, three alternating pairs (load average 2.4-4.2):

| | Bun's [s] | Wall | Tests | expect() calls |
|---|---|---|---|---|
| 200 seeds (`KG_DIFF_SEEDS=200` set by the caller) | 12.04, 13.01, 12.35 s | 12.15, 13.13, 12.49 s | 1,034 in 89 files | 212,066 |
| 25 seeds (what `test:changed` sets) | 10.19, 10.52, 10.27 s | 10.31, 10.64, 10.39 s | 1,034 in 89 files | 112,032 |

About 2 s (1.2x) per engine edit. The run stays above D161's 9.26-9.48 s; where the rest went was not measured. A one-line
change in `packages/sim/src/world.ts` defers nothing: `test:changed` ran 229 tests in 34 files, the same as
`bun run test:pkg sim` (12.53 s and 12.45 s).

A bare `bun test` at the repo root skips `archived/` through `pathIgnorePatterns` in `bunfig.toml`, so it runs the
same 102 files as `scripts/test.sh`, but serially: 1,362 pass, 0 fail in 30.0 s (Bun 1.4.4, 2026-11-03). Before the
ignore it also ran archived/'s 530 test files: 687 files, 487 fail, about 215 s. `bun run test` stays the parallel
path (about 16 s). The key was checked on Bun 1.3.13 (`packageManager`) too: 102 files and a planted failing test
under archived/ not run. On 1.3.13 three tests in those files fail (`utf8.test.ts` astral/lone-surrogate length, also
failing with the old bunfig, and two `redos.test.ts` timing tests), and the run took 107 s; the gate is measured on
1.4.4.

## Test files that already passed are skipped (D650, 2026-11-10)

`scripts/test.sh` skips a test file that passed before on exactly the inputs it has now, and prints how many it
skipped (`test cache: 194 of 230 files passed on these inputs and are skipped, 36 run`). **It is for the loop, not
the gate: before a merge, and in a review, run `CHECK_COLD=1 bun run check`** (D657), which runs every file. A pass
is shared by every worktree of the repository, so one lucky run of a flaky test would otherwise stand for a day.

The key (`scripts/test-cache.ts`): the file and everything it imports; the lockfile, `bunfig.toml`, the preload and
what it imports, every `package.json` and `tsconfig`, the root's `.env*` files; Bun's, Node's and Python's versions;
and every environment variable but the shell's own (`FUZZ_SEEDS=1` is a different key). A file is keyed on every
file in the repository as well when it, or a module it reaches:

- starts a process (then prose counts too: a child can read anything), learns its location (`import.meta.dir`,
  `import.meta.require`), reads the working directory, or imports a name made at run time (a variable, a template);
- reads a path that is not absolute (`readFileSync("x")`, `Bun.file("x")`), or names a repository path in a string: a
  top-level directory and a slash, a root file's name, `join("packages", …)`, anything through docs/ or ending `.md`;
- or has not been traced by the audit on these bytes (D658). Signs are a heuristic: two reviews found forms that
  pass every sign (`globalThis.Bun`, `Bun.mmap`, a Worker by a built path, an import the transpiler folds), so a test
  keeps a narrow key only while `scripts/test-cache-verified.txt` holds it with its closure's hash. The audit writes
  that file for tests with no sign that it traced reading nothing outside their closure (182 of 230 on 2026-11-10).
  An edit in a test's closure sends it to the whole tree until `bun scripts/test-cache-audit.ts --write` runs again.

Signs are looked for in the transpiler's output (comments gone, strings whole). Bun's module reached other than as
`Bun.x` (`import { file } from "bun"`, `= Bun`, `Bun[…]`, `process.getBuiltinModule`) counts as both spawning and
reading files. Files outside the repository or ignored by git (`.local/`) are in no key and the audit
skips them: a test must not read them. A pass is kept for 24 hours; a file
whose tests were all skipped is not a pass. `CHECK_COLD=1`, `TEST_CACHE=0`, or any extra `bun test` argument runs
every file. `bun scripts/test-cache.ts why <test file>` prints what a file's key covers.

`bun scripts/test-cache-audit.ts [--write]` runs each test file under strace (opens, stats, access checks, of files
and of directories) and fails when a test read something its key does not cover; `--write` refreshes
`scripts/test-cache-verified.txt`. Run it after changing the cache, when a test reads files in a new way, and now
and then to bring edited closures back (230 traced, 0 missed, 182 verified; 87–106 s). It joins the two halves strace
prints for a call another thread interrupts (`<unfinished ...>` / `resumed`), which Bun's thread-pool reads produce.

What the audit cannot see, so the key does not cover either: a test that depends on a file being absent (failed
lookups are not traced), an `openat` relative to an open directory, a child that changes directory, and a read on a
code path the traced run did not take. Each needs a path no sign sees (`Bun.main`, a stack trace) first; the gate
runs cold (D657) for this reason too.

Measured on a 4-core container after D657 and before D658 (docs/research/o2-dev-loop.md): the same tree again 51 s
to 0.5 s; a docs edit 24 s; a leaf-package edit 27 s; an engine edit 45 s. D658 keeps the same 48 of 230 files on the
tree, but a file whose closure was edited now re-runs on any change until the audit runs again.

## Bun's unref'd-timer spin (Bun 1.4.4, 2026-11-05)

Bun 1.4.4 busy-polls a core while the only pending timers are unref'd ones (an `unref()`'d `setTimeout`,
`AbortSignal.timeout`). The engine and sources unref their deadline timers so they never hold a process open
(`guarded.ts`, `partner.ts`, `cache.ts`), and some tests wait on those deadlines for real. Repro: a test that awaits an
unref'd 1.5 s `setTimeout` used 1,443 ms of CPU over 1,500 ms of wall; with any ref'd `setInterval` alive (periods
1 s, 60 s and 2^31-1 ms tried) it used 3-4 ms. `scripts/test-preload.ts` therefore keeps one ref'd interval (period
one hour, never fires in a run) and clears it in its global `afterAll`; checked under `--parallel` (each worker loads
the preload: 3-5 ms CPU per waiting file, the run exits at once) and in one process across three files. Remove it once
a Bun release stops spinning (re-run the repro). One-shot lab CLIs that wait on `AbortSignal.timeout` with nothing else
ref'd would spin the same way; not checked.

`bun test packages/engine/src/ask-deadline.test.ts` (`time`, 4-core shared box):

| | real | user |
|---|---|---|
| Before: `TIMEOUT` 1,500 ms, no keep-alive | 7.77 s | 7.65 s |
| Keep-alive only (two runs) | 7.74, 7.73 s | 0.27, 0.28 s |
| Keep-alive and `TIMEOUT` 500 ms (two runs) | 2.71, 2.75 s | 0.27, 0.31 s |

The test's bound is now `TIMEOUT * 1.5` (750 ms) instead of `TIMEOUT + 250`: one deadline must land under it and a
regression to two deadlines (D140) lands at 1,000 ms, 250 ms clear. A cut to 300 ms with the fixed +250 ms would have
left 50 ms between the two. Observed time before the reader at 500 ms: 501-601 ms (three runs, five asks each). Under
load (four busy-loop processes on the 4 cores) the file passed 20 of 20 runs, 2.83-3.14 s each.

## The cold gate at once, a tail for real-time tests, CPU-time bounds (D811, 2026-11-11, 4-core container, Bun 1.4.4)

`CHECK_COLD=1 bun run check` took 83.1 s and 85.3 s on a quiet machine (format:check 16.6 and 16.9 s, typecheck 12.3
and 12.4 s, tests 54.2 and 56.0 s, one after another), and failed under load: `rare-terms.test.ts` "bounded…" timed
out in the weak-point analysis's run, again in two of this session's cold runs at load 15-18, and in the base tree with
four busy loops beside it (142.0 s, red). Profile (each of the 235 files alone, `bun test <file>`): 191.8 s of wall
time and 208.4 s of CPU in all. The tests are CPU-bound: four workers cannot go under about 52 s, and the parallel run
was within a few seconds of that. Neither `--smol` (the container's `BUN_OPTIONS`; 54.0-58.5 s either way) nor
`--no-isolate` (about 10% less CPU, but files would see each other's leftovers) was taken.

What changed (`scripts/check.sh`, `scripts/test.sh`, `scripts/test-tail.txt`, `scripts/test-report.ts`):

- **The three steps run at once.** Prettier and tsc are single processes; one after another they left cores idle.
- **The slowest files start first** (`bun test --timings`, last run's durations under the git common dir; an order,
  never a result): 51.7-51.9 s against 54-56 s for the tests alone.
- **A tail.** 25 files that wait on real time and assert on it (a deadline met, a sleeping connector overtaken, a
  child process started within a bound), or spend at least three times their CPU waiting for a second or more, run
  after the rest, eight at a time, on a machine nothing else loads: 8.1-9.2 s. Before, they flaked under contention
  and held a worker while idle (52.6 s of wall, 19.3 s of CPU).
- **Bounds on work are CPU time.** 22 wall-clock ceilings around synchronous code (ReDoS and linearity guards in
  engine, primitives, redact, protocol and sim) read `process.cpuUsage()` (`cpuMs`): the same bound on the same work,
  not on how long the scheduler kept the test waiting.
- **120 s a test in the main run unless it names its own** (`TEST_TIMEOUT_MS`; 20 s before D1945, 60 s until D1965):
  the limit catches a hang; Bun's 5 s default failed CPU-bound tests under load.
  The tail keeps 5 s (`TEST_TAIL_TIMEOUT_MS`): deadline tests there that
  assert nothing about time relied on it, and the tail runs unloaded. A name filter (`bun run test -- -t X`) runs one
  invocation, unsplit, since a part it matched nothing in would fail. The run ends with the ten slowest files and every test over 3.5 s, so slowness stays
  visible. `rare-terms.test.ts`'s two full-table tests fill 300,000 words, not 400,000 (still 38,000 past the table's
  cap; about 0.5 s less), and carry 30 s.

| `CHECK_COLD=1 bun run check` | Quiet | Four busy loops beside it |
|---|---|---|
| Before (the base tree, steps one after another) | 83.1 s, 85.3 s | 142.0 s, 1 fail (rare-terms timeout) |
| After | 64.2 s, 62.9 s | 92.4 s, 0 fail |

1.33x, not the 3x aimed at. The rest is CPU: about 242 s of it (tests 195-208 s, Prettier about 29 s, tsc about
15 s) on four cores. Further gains need one of these, each an owner's call: tsgo as the gate's checker (about 5x faster
than tsc, `typecheck:parity` checks they agree); Prettier's content-addressed known-formatted set trusted by the cold
gate (the key is the content, Prettier's version and its configuration); or smaller end-to-end tests. The heaviest by
CPU alone: `funnel-flags.test.ts` 21.7 s (thirteen funnel processes), `injection-suite` 9.0, `sim.test` 8.8,
`cards-disk` 8.2 (24 worlds' intent coverage), `client-package` 7.5, `router-processes` 7.0, `reader-stub` 5.8,
`pilot` 5.2, `neutral` 4.9, `days-calls` 4.6, `linear` 4.2, `fuzz` 4.0.

### D819: slimmer end-to-end tests (2026-11-11, 4-core container shared with other agents, Bun 1.4.4)

Part 1 of D819 is the Prettier set the cold gate now trusts (`scripts/format.sh`, `scripts/format-key.test.ts`). Part
2 shares work inside five heavy test files; no `expect` was removed, and each runs on the same or a smaller input:

- `funnel-flags.test.ts`: one pair of `funnel.ts` runs (`--time 0.05`, `--jobs 1` and `2`) now writes the per-task
  output files too, and the output-file test reads them; the second pair at `--time 0` (two processes, about 6.5 s of
  CPU) is gone. The merge code (`partFiles`, `partArgs`, `mergeOutputs`) does not read `--time`, and the five files
  were byte for byte the same between the two runs in three of three trials at load 7-10. The `--time 0` grouping
  still runs end to end in the SIGTERM run, and `groupShards` keeps its unit tests (funnel-merge.test.ts).
- `cards-disk.test.ts` (the coverage claim over held-out 13-18, seeds 41 and 44): every suite and seed is still
  covered. One base world per seed is built and shared by its twelve suite-variant worlds (own lists and maps, the
  same item objects), so the sources' per-item analysis, memoised on the object, runs once a seed. All 24 worlds' item
  lists and coverage counts were identical to fresh builds; a new check fails if a suite or `clearSlot` changes a
  base item.
- `injection-suite.test.ts` (quarantine over the train suites): every item still counts, but each distinct title,
  text and branch is checked once (18,124 items, 1,871 distinct); `quarantineItem` reads only the title and text. D815
  then deleted `quarantineInstructions` and this test with it (shield.ts; M8 and M9 below were run before that).
  The `expect()` count falls from 18,241 to 1,978 for this reason.
- `days-calls.test.ts`: the plain payload run and the `onPlanted` run are one run (the callback only observes; the two
  reports were identical).
- `neutral.test.ts`: the two `--neutral` runs cap the sync at 100 items a user (`syncLocalComplete: false`), as
  funnel-flags.test.ts and reader-stub.test.ts do.

Each file alone, base version then new version, back to back (`TIMEFORMAT='%R %U %S'; time bun test ./file`; CPU =
user + sys, children included; load is the 1-minute average at the start of each run; the machine was shared):

| File | Base CPU (s) | New CPU (s) | Base wall (s) | New wall (s) | Load base / new |
|---|---|---|---|---|---|
| `funnel-flags.test.ts` | 20.70, 22.80 | 15.03, 15.47 | 15.7, 19.7 | 13.5, 13.6 | 16.8-26.0 / 36.4-41.4 |
| `cards-disk.test.ts` | 8.60, 9.22 | 5.03, 5.54 | 12.1, 11.2 | 7.5, 6.5 | 38.4-41.8 / 36.2-36.8 |
| `injection-suite.test.ts` | 8.90, 8.62 | 7.23, 6.83 | 10.8, 10.7 | 9.4, 6.9 | 34.6-35.6 / 31.4-33.5 |
| `days-calls.test.ts` | 7.78, 8.00 | 7.36, 6.83 | 7.9, 5.9 | 5.3, 4.8 | 23.0-25.7 / 19.7-21.3 |
| `neutral.test.ts` | 5.86, 5.63 | 4.47, 4.63 | 4.0, 4.0 | 3.8, 3.9 | 17.2-18.3 / 16.5-17.2 |
| Sum of the means | 53.1 | 39.2 | | | |

About 13.9 s of CPU less, about 7% of the 208 s the tests take. At lower load earlier in the session: funnel-flags
23.08 and 22.50 s (load 6.8-7.9) against 15.34 and 14.42 (1.5-4.0); cards-disk 9.19 and 9.39 (8.8-9.6) against
4.68 and 4.84 (3.5-3.6).

`CHECK_COLD=1 bun run check`, total CPU of the command and wall (load: 1, 5, 15-minute averages before and after):

| | CPU (s) | Wall (s) | Load before → after | Result |
|---|---|---|---|---|
| Before 1 | 222.7 | 64.7 | 2.8, 6.1, 7.0 → 7.4, 7.0, 7.2 | 1 fail (`pilot-review.test.ts`, below) |
| Before 2 | 230.0 | 149.4 | 3.8, 6.1, 6.9 → 30.3, 15.4, 10.2 | 2 fail (a WorkerPool and a D100 test, under load) |
| Before 3 | 240.0 | 137.9 | 30.3, 15.4, 10.2 → 19.7, 18.9, 12.4 | 2 fail (sim.test, linear: 20 s timeouts under load) |
| After 1 | 230.4 | 100.6 | 14.5, 18.3, 13.6 → 17.2, 17.7, 13.9 | green |
| After 2 | 233.6 | 97.6 | 17.2, 17.7, 13.9 → 15.8, 17.6, 14.3 | green |
| After 3 (the committed tree) | 219.0 | 85.0 | 7.7, 14.3, 13.4 → 12.3, 14.7, 13.7 | green |

The gate's figures do not resolve a 14 s change: other agents kept the load between 3 and 41, and CPU time itself
grows under that contention (the same file's CPU varies by 10-20% between loads). The per-file pairs above are the
measure. A quiet-machine gate figure is still owed.

`pilot-review.test.ts` failed on the base (D818's guard refused the placeholder key its pi-ab child is given): the
test now sets `EDEN_ALLOW_OPENROUTER=1` for that child, whose key is a placeholder and whose run is `--dry`.

Mutation spot-check: each edit made to the source under test, the file's tests run, the edit reverted.

| # | Source edit | Test file | Result |
|---|---|---|---|
| M1 | funnel.ts merges only the first process's part | funnel-flags | fails: output files shard |
| M2 | funnel-merge.ts `mergeLines` keeps arrival order | funnel-flags | fails: output files shard |
| M3 | funnel.ts at `--time` > 0: one process a suite, not a shard | funnel-flags | fails: output files shard |
| M4 | funnel.ts does not delete parts after the merge | funnel-flags | passes: equivalent, the exit handler deletes them |
| M4b | M4 and no deletion at exit either | funnel-flags | fails: output files shard; SIGTERM leaves no part |
| M5 | cards-disk.ts `intentCoverage` counts 50 items too many | cards-disk | fails: coverage claim; `--intent none` header |
| M6 | cards-disk.ts `loadRequests` drops one key in sixteen | cards-disk | fails: coverage claim |
| M7 | hidden-context.ts `clearSlot` edits a base item | cards-disk | fails: coverage claim (the shared-world check) |
| M8 | shield.ts `quarantine` removes nothing | injection-suite | fails: guardLine and quarantineInstructions |
| M9 | shield.ts `quarantineItem` always copies | injection-suite | fails: quarantine leaves planted facts alone |
| M10 | days-calls.ts `onPlanted` skips each kind's first request | days-calls | fails: onPlanted rows |
| M11 | hidden-funnel.ts keeps one neutral row | neutral | fails: `--neutral` block |

M7 passes on the base test (it built every world afresh); the check that catches it is new. A first M6, `dress` doing
nothing, passed on both the base and the new test: the coverage claim does not see undressed planted items.

Left alone: `client-package` (packs the client, runs Node and tsc: the cost is the code under test),
`router-processes` (each test starts and stops a two-process router; sharing one would couple tests that kill
processes), `reader-stub` (its three runs already go out together and share their checks), `pilot` (a dozen short CLI
calls, each its own assertion), `sim.test` (its two-user merge run is already the smallest with a shard boundary;
three sessions instead of six in the updates test measured no difference and was reverted), `linear` and `fuzz`
(differential and fuzz corpora: seeds × inputs kept), and the smaller files (`sparse-index-packed`, `deletes`,
`cache-freeze`, `unused-sweep`, `eval/run.test`), not reached.

### The `--neutral under --jobs` flake: the card drain's wall-clock gather cut (2026-11-14, 4 cores, Bun 1.4.4)

`funnel-flags.test.ts` compares the merged `neutral` block of a sharded `funnel.ts --neutral` run with one process's,
card counters included. Under load it read 25 card calls and 74 items carded against 24 and 57. Cause: the card
drain waits for stores still waiting their turn (`CardEnricher.gather`, D370) for at most 250 ms of wall time
(`GATHER_MS`). On a loaded machine the stores took longer, the cut fell at another store, a batch went out with 4
items where it would have held 20, and the replayed cards followed the new batches (an instrumented run logged the
cut 12-16 times a run, at different stores). Reproduced with 6 one-process and 6 sharded runs at once on 4 cores: 1
of the 6 one-process runs moved. The `idle()` before the neutral counters are read (already there) was not enough:
the cut happens earlier, inside each task.

Fix: `CardLimits.gatherMs` (a lab hook; the partner never sets it, so the default's 250 ms is unchanged), and the
funnel's `--card-limits '{"gatherMs":null}'` lifts the cut (JSON has no Infinity). The test's two compared pairs (the
`--time 0.05` pair and the `--neutral` pair) pass it, and the comparison stays exact. Proof: 16 runs of those
funnels at once (8 one-process, 8 sharded) gave the same block; `funnel-flags.test.ts` passed 18 of 18 runs, two at
a time beside two loops of `bun run test:pkg engine` (`--timeout=20000`, the main run's limit). A merge that keeps
the larger of the shards' card calls instead of their sum fails the test (24 against 12). `cards.test.ts` checks the
hook: a 50 ms cut splits the first batch, `Infinity` gives `[10, 10, 10]`.

## Caches in format:check and typecheck

Both caches carry to a fresh git worktree (each audit fixer, reviewer and integrator gets one), and
`CHECK_COLD=1 bun run check` (or `format:check`, `typecheck`) ignores both: use it when a cache is in doubt, and for a
final run that trusts nothing earlier.

**Prettier: a shared known-formatted set.** `scripts/format.sh` keeps one `<blob id> <path>` line per file content
that Prettier passed, in `$(git rev-parse --git-common-dir)/eden-check-cache/prettier-<key>`, which every worktree of
the repo shares. Prettier's own `--cache` could not: it keys absolute paths, so each new worktree ran cold.

- The key is a hash of the Prettier version and of every Prettier config, `.prettierignore`, `.editorconfig` and
  `package.json` file (outside `archived/`). A change to any of them starts a new, empty set.
- An entry is a (path, blob) pair: the blob id is `git hash-object --no-filters` of the working-tree file, so unstaged
  and untracked edits count, and the path is part of it because Prettier picks its parser from the path.
- Only files whose pair is not in the set go to Prettier; when none remain Prettier is not run at all.
- Entries come only from Prettier's exit status and bare paths, never from its log: `--check` runs Prettier as
  `--list-different --no-color`. Exit 0 records every file checked; exit 1 records those not listed, and only when
  every listed line is exactly a checked path; exit 2 (a syntax error) records nothing. A checked file is recorded
  only if its content hashes the same before and after Prettier ran. `format` (write) records only on exit 0, with the
  formatted content.
- Writes are a temp file renamed into place, so concurrent worktrees can lose each other's additions (re-checked next
  time) but never corrupt the set; malformed lines are ignored. The set is capped at 50,000 lines. Every read touches
  it, and only sets for other keys (and leftover temp files) are pruned after 14 days.

`scripts/check-line-length.ts` has no cache and still reads every file, so an overlong comment is always caught,
whatever the set holds.

**Per-worktree build info, seeded.** `scripts/typecheck.sh` runs its checker (tsgo since D816, or tsc) with
`--incremental` and one build-info file per `tsconfig.json` and checker under the gitignored
`node_modules/.cache/tsc/`. A worktree with no such directory is seeded with a copy (never a link: two checkouts
writing one file would race) from the other worktree, holding that checker's build info, whose HEAD is closest: the
same commit first, else the fewest `*.ts`/`*.tsx`/`*.mts`/`*.json` files in `git diff --name-only` between the two
HEADs, ties to the most recently written. The checker trusts nothing in the copy: each file's recorded version is its content
hash, so it re-checks whatever differs.

Measured 2026-11-05 (4-core container shared with other agents, Bun 1.4.4), in a worktree after `bun install` with
`node_modules/.cache` removed before each run, and sibling worktrees on several other branches present. The newest
build info was a sibling at another commit; the closest, which was chosen, differed only in these shell scripts.

| Step | First run in the worktree (3 runs) | `CHECK_COLD=1` |
|---|---|---|
| `bun run format:check` | 1.8 s, 1.4 s, 1.4 s | 13.5 s |
| `bun run typecheck` (seeded from a sibling 0 TS/JSON files apart) | 4.0 s, 3.6 s, 3.8 s | 11.1 s |

Seeding by closeness, not recency: in the same session tsc seeded from a sibling 2 files apart (`conflict.ts` and its
test) took 8.7 s, from a same-commit sibling 3.1 s, and cold 9.6 to 9.9 s. Each of these still failed the check with
the set warm: a misformatted untracked `.ts` file, with and without `FORCE_COLOR=1`, on the first and second run (it
never entered the set); a file with a syntax error; and a 133-column comment in a Prettier-formatted file (the set
holds that file; the line-length check fails it every run). Three concurrent `format:check` runs, twice, against a new
key left a 392-line set with no malformed line.

Earlier, with Prettier's own cache (2026-11-03): format:check 11.8 s and 10.7 s with no cache, 2.4 s warm; typecheck
9.8 s and 8.6 s with no cache, 3.0 to 3.8 s warm; `bun run check` 39.8 s cold, 21.1 s warm, of which tests were
15.7 s. A warm typecheck after an edit to a widely imported file costs close to a cold one (about 8 s in the audit
that proposed the caches; not re-measured).


## tsgo, the gate's checker (D816; measured 2026-11-03b, 4-core container shared with other agents, Bun 1.4.4)

`scripts/typecheck.sh` takes `TYPECHECK=tsgo` (the default since D816), `tsc` or `parity`. tsgo is TypeScript 7's
native checker, `@typescript/native-preview` pinned to `7.0.0-dev.20260707.2` as a devDependency (dev only: nothing in
`packages/` imports it). `bun run typecheck` (so `bun run check`) and `bun run typecheck:fast` use it; tsc 5.9.3
stays for a second opinion (`TYPECHECK=tsc`) and for `typecheck:parity`. Each checker keeps its own build-info file
(`*.tsgo.tsbuildinfo` for tsgo), so switching between them never reads the other's format. `bun run typecheck:parity` runs both with
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
(missing property). On D816's base (b4848545), `CHECK_COLD=1 bun run typecheck:parity`: "tsc and tsgo agree (0
errors)". No recorded parity run has disagreed, so tsgo became the gate (D816); run `typecheck:parity` after bumping
either checker. On that branch, cold, on a box at load average 19-36: tsc 42.4 s wall, tsgo 12.6 s.

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

Tests that slept past a delay now hold the call and release it: `slow-path-queue.test.ts` (deleted by D228) (a judge and a slow
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
| packages/engine/src/slow-path-queue.test.ts (deleted by D228) | 5,468 ms (CPU 0.35 s) | 214–286 ms (CPU 0.25–0.28 s) |
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
`store` → `cache.put`, the knowledge graph's `extract` (deleted by D225) and the secret gate) and 0.36 s in building the simulated
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
  `slow-path-queue.test.ts` (deleted by D228) did; the test then turns the event loop until the session's queue holds the packet
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

## The cold gate at 20% faster: not reachable with the listed levers (D1782, 2026-11-13, 4 cores shared, Bun 1.4.4)

The ask: `CHECK_COLD=1 bun run check` at least 20% faster (interleaved medians of 3), every test file still run, no
assertion weakened. Measured first, on a machine two other agents kept at load 8-30.

**Profile** (each of the 294 files alone, `TIMEFORMAT='%R %U %S'; time bun test ./file`, CPU = user + sys, children
included; scratch script): 287.7 s of wall and 268.5 s of CPU in all. The main run's 268 files are 249.3 s of CPU
(34.0 s of it waiting: wall past CPU), the tail's 26 files 19.2 s of CPU in 67.9 s of wall. 224 files take under
0.6 s of CPU (46.7 s in all, median 0.18 s: start-up, the preload and imports). By CPU: `funnel-flags` 23.8 s,
`pi-ab-resume` 15.7, `days-calls` 11.4, `suites` 11.0, `sim.test` 8.5, `router-processes` 7.7, `client-package` 7.5,
`gloss-packed` 6.3, `reader-stub` 5.8, `test-cache` 5.7, `own-matchers` 5.2, `injection-suite` 5.2: the end-to-end
simulation files hold about 100 s of the 268, and D819 already slimmed them. On four cores the tests cannot go under
about 62 s of CPU-bound wall, and the tail (8 at a time) follows.

**The levers, each measured:**

| Lever | Measured | What it could save of the gate |
|---|---|---|
| Fuzz counts behind `TEST_DEEP=1` (gloss 10,000 → 3,000, day-facts 40,000 → 10,000, conflict-memo 60,000/3,000/3,000 → 15,000/1,000/1,000, linear 400 → 150 texts) | those tests 3.18 → 1.02 s, 2.08 → 0.48, 2.32 → 0.74, 3.53 → 2.56 (linear's time is mostly building both rule sets) | about 6.3 s of CPU, under 2 s of wall (2%) |
| `proxy-speculate.test.ts`: its ten independent turns at once, each counting its own user's upstream calls (kept) | the file 13.0 s → 7.0-7.1 s alone (3 runs each) | none: the tail is bound by its throughput at 8 jobs, not by one file (tail alone, interleaved: 14.4, 14.5, 13.2 s before; 13.7, 14.3, 13.9 after, load 17-19) |
| `card-queue.test.ts` to the tail (kept: 8.7 s of wall, 1.5 of CPU, D811's rule) | frees about 7 s of a main-run worker | under 2 s of wall |
| `cluster.test.ts` to the tail (8.4 s of wall, 0.55 of CPU) | its three machines' start-up in the tail; a router-processes deadline test failed beside it at load 30 | reverted |
| The tail at 16 or 32 jobs | 11.3-11.8 s and 10.8-13.1 s against 13.6-14.3 s at 8 (load 17-26, 3 rounds each), with 1 and 2-4 deadline tests failing a run at 16 and 32, and 0-1 at 8 | not taken: D811 made the tail for exactly these flakes |

Together the zero-coverage levers save about 2 s of a 65-100 s gate, and the fuzz cuts about 2 s more at a quarter of
the inputs: far from 20%, so the fuzz counts are left as they were. Interleaved cold gates (base, then the first
candidate with every lever above) read 197.5, 138.7, 152.2 s on the base and 193.3, 91.9, 184.8 s on the candidate
at load 8-30: the load moved each run by more than any lever could, and the candidate run had a fault of its own (a
constant out of scope in `conflict-memo.test.ts`, caught by its typecheck), so those runs decide nothing. The base's
own runs failed `funnel-flags`'s `--neutral` merge and `http.test.ts`'s D100 timing test under that load, as other
sessions' gates did.

What would reach 20%: fewer, cheaper end-to-end processes (`funnel-flags` starts thirteen, `pi-ab-resume` four), a
shared module graph across files (`--no-isolate`, which D811 declined), or more cores. Each is a decision of its own.

## D1945: less CPU in the gate, two load flakes made deterministic (2026-11-15, 4 cores shared, Bun 1.4.4)

The brief: the dev loop and the cold gate faster, no test weakened, every test still run. Measured on a machine other
agents kept at load 8-36 (the 1-minute average; four cores), so wall times there say more about the load than about
the change, and CPU (user + sys, children included) is the steadier figure.

**Profile** (each of the 330 files alone, `TIMEFORMAT='%R %U %S'; time bun test --timeout=60000 ./file`): 390.2 s of
wall, 352.3 s of CPU. The tail's 31 files are 84.3 s of wall and 27.5 s of CPU (card-queue 9.0 s of wall, 1.8 of
CPU: `cold-start.ts`'s `warmAll` sleeps 250 ms between idle sync ticks). 237 files take under 0.6 s of CPU (53.2 s in
all). By package: sim 136.5 s, engine 71.3, redact 36.3, sources 30.5, server 27.3, primitives 19.3. Cold
format:check was 33.8 s of wall and 45.1 s of CPU (Prettier on Node over 874 files) plus the line check's 5.0 s;
typecheck (tsgo) 9.6 s and 9.4 s. The cold gate is CPU-bound: about 420 s of CPU on four cores.

**What changed** (no `expect` removed; fuzz counts, seeds and inputs as they were):

- `suites.test.ts` built about 600 worlds at ~25 ms each. One base world per seed is built once and each test gets
  its own lists and maps over it, as `cards-disk.test.ts` does (D819); a check after the file fails if a suite or
  `prepareWorld` changed a base item (a planted edit to a base item's title fails it). 8.24 s of wall and 10.07 s of
  CPU alone to 1.12 and 1.50; the same 23 tests and 5,695 `expect()` calls.
- `pi-user.test.ts`'s thirty four-week users took their templates from `suiteTemplates`, six worlds a seed; they now
  plant into one world a seed (checked equal to `suiteTemplates` on seed 41, base items checked unchanged): the test
  3.7 s to 1.5 s, 1,875 `expect()` calls to 1,907.
- Prettier runs on Bun (`bun node_modules/prettier/bin/prettier.cjs`): all 874 files, their indentation stripped and
  every other line joined, formatted byte for byte the same on Node 22 and on Bun; cold, 33.8 s and 45.1 s of CPU on
  Node against 25.6 s and 35.5 s on Bun (load 2-3). Bun's version joins the known-formatted set's key
  (`format-key.test.ts`, a new case). A misformatted file still fails `format:check`, cold and warm.
- `check-line-length.ts` parses only a file with a line over the width in UTF-16 units (a line's code points are at
  most that): 315 of 874 files have one; 6.1 s and 5.0 s of CPU to 3.6 s and 3.8 s. A 133-column comment still fails.
- The main run's per-test limit is 60 s, not 20 s: at load 18-36 `long-reply.test.ts`'s fuzz tests (3 s alone) ran
  21-32 s and failed on the limit, as did `differential.test.ts`'s stream fuzz (24 s). The limit only catches a hang.

**The two load flakes.** sse-drip (`adversarial.test.ts`) bounded the parser's CPU at 1,500 ms and failed in three of
four base gates here (2,806, 10,462 and 4,100 ms). It now counts what the parser does while 3,000,000 one-byte reads
drip in: bytes copied by `set` and `slice` (10,194,047, 3.4 per byte held; bound 4 per byte) and `indexOf` searches
(6,000,006, two a read; bound two a read plus 8), beside its count of arrays held. Planted regressions fail it: one
array a read (D1860's original: 3,000,001 arrays held against at most 9) and a buffer grown by a constant 256 bytes
instead of doubling (17,516,772,356 bytes copied). The D100 test (`http.test.ts`) asserted a 400 within 100 ms (150 ms
seen); it now takes the fastest of three sends against a `JSON.parse` of the same body in the same process, under a
third of it (quiet: 5-10 ms against 91-122 ms for the wide body, 1-2 ms against 482-625 ms for the nested one);
parsing before the shape scan fails it (83-95 ms against a bound of 35-40). Neither failed in the branch's three
gates; beside four busy loops, alone, both passed 12 of 12 runs (load 9.7-11.3), as did the old versions (the flake
needs the gate's own contention).

**Cold gates**, `env -u OPENROUTER_API_KEY CHECK_COLD=1 FORMAT_COLD=1 bun run check`, interleaved (base 7bca42093,
then the branch at 8ba6fe6c0, three times; load is the 1, 5, 15-minute average before → after):

| Run | Wall (s) | CPU (s) | Load | Tests (pass / skip / fail) |
|---|---|---|---|---|
| Base 1 | 435.0 | 438.8 | 11.2, 19.1, 15.5 → 36.0, 31.9, 22.8 | 3,494 / 2 / 5 |
| Branch 1 | 330.3 | 393.3 | 36.0, 31.9, 22.8 → 18.2, 26.4, 23.4 | 3,496 / 2 / 4 |
| Base 2 | 229.3 | 410.9 | 18.2, 26.4, 23.4 → 16.9, 21.8, 22.2 | 3,498 / 2 / 1 |
| Branch 2 | 309.5 | 381.0 | 16.9, 21.8, 22.2 → 23.6, 24.3, 23.3 | 3,498 / 2 / 2 |
| Base 3 | 233.6 | 390.8 | 23.6, 24.3, 23.3 → 12.6, 19.4, 21.7 | 3,498 / 2 / 1 |
| Branch 3 | 318.4 | 377.0 | 12.6, 19.4, 21.7 → 28.4, 25.7, 23.9 | 3,496 / 2 / 4 |

Every file and test ran in every run: 3,501 tests in 330 files on the base, 3,502 on the branch (the new
`format-key.test.ts` case). CPU fell from 413.5 s to 383.8 s on the means (7%). The wall times moved with the other
agents' load by more than that (229-435 s on one tree), so they show nothing about the change; the branch's fails
were the 20 s limit on `long-reply.test.ts` (fixed after these runs) and deadline tests in the tail (`ask-behind`,
`push-cut-behind`, `router-processes`' hanging restart, `hermes-worker`), which D811 runs on the assumption that
nothing else loads the machine; the base's were the same plus sse-drip and `differential.test.ts`. On a quiet
machine a CPU-bound gate's wall is about its CPU over four cores, so about 7 s less.

Not taken: a shared transpiler cache for the processes tests start (each test file's children start with the
preload's fresh `HOME`; about 0.3 s of CPU a file, within the noise of three tries); `--parallel` above the core
count to fill the main run's waiting files (38.7 s of wall past CPU summed, chiefly `cluster.test.ts` 8.5 s): on a
shared machine more workers take a larger share from the other agents, which would flatter it; `BUN_OPTIONS` without
`--smol` (gate-differential, long-reply, render-fast: no less CPU). The end-to-end process tests (funnel-flags'
thirteen funnel runs, pi-ab-resume's ten pi-ab runs, days-calls) hold most of sim's CPU and D819 already shared what
they can.

## D1965: the remaining load flakes (2026-11-15, 4 cores shared, Bun 1.4.4)

The brief: every test that failed in a loaded cold gate and passed alone made robust, none deleted, skipped or run on
less input, each changed guard shown to fail on the regression it was written for. Four busy loops beside a whole
gate did not reproduce them on this machine (base 2deecc12d: 0 load failures in one run), so each file ran in a
harsher harness: six copies of it at once beside eight busy loops (`while :; do :; done`), as the gate's tail starts
eight files at once on a machine other agents load (on the base, `router-processes` ran one copy beside twelve
loops). Base runs as counted in the table (load 11-31); after, 18 runs of each on the branch (load 10-48):

| File | Base fails | After | What it guards, and what it reads now |
|---|---|---|---|
| `ask-deadline.test.ts` | 6 of 18 (777-921 ms against 750) | 0 of 18 | D140, one deadline for the poll and the search: `TIMEOUT` 1,500 ms, not 500, keeping the bound at 1.5x and the regression at 2x (gap 750 ms, not 250). Up to 442 ms landed past the deadline under load, most of it after it |
| `ask-behind.test.ts` | 1 of 18 (192 ms against 150) | 0 of 18 | D430, the ask does not wait for its cut copies' searches: they wait on a promise the test releases after the ask returns, and the ask must return with them still running (neither answered nor aborted by a deadline) |
| `push-cut-behind.test.ts` | 1 of 18 (197 ms against 150) | 0 of 18 | D405, the same for the push: no search answered and some still running at the reply; its limit 30 s (3.7 s seen under load against the tail's 5) |
| `http.test.ts` D100 | 12 of 12 (13-19 s against the tail's 5 s) | 0 of 18 | Timed against an in-process `JSON.parse` (D1945), both sides now in this thread's CPU: in this branch's loaded gate the fastest of three sends read 33.5 ms of wall against a bound of 30; the limit is 30 s |
| `stdio.test.ts` drip | 2 of 12 (the tail's 5 s) | 0 of 18 | D1860, arrays held per dripped line: counted already; the test's own wait is bounded at 20 s, its limit 30 s |
| `server-messages.test.ts` ping flood | 1 of 12 (the error not seen in 100 x 5 ms) | 0 of 18 | D1873's budget: polled up to 10 s for the failure, limit 30 s; its CPU bound stays |
| `deadlines.test.ts` | 1 of 12 ("added" not fired in 40 ms) | 0 of 18 | Adds and cancels during a fire, and the 1 ms clamp: polled until the entries fire (2 s bound) |
| `router-processes.test.ts` D172 | 1 of 5 ("child 0 did not start in 500 ms") | 0 of 18 | A hanging restart is killed: the first start gets 4,000 ms (the restart hangs however long it is given) |

The rest of the brief's list, one at a time beside six busy loops: `client.test.ts`'s "plus the wait" read 242 ms
against `< 190` in a gate; which timeout a call got is now read from its error ("no answer within 200 ms" and "50 ms",
the value `AbortSignal.timeout` was made with), and only lower bounds and a hang bound stay on time.
`proxy-speculate.test.ts` read 614 ms against 500: the scripted Eden and upstream log their events, and the upstream
call must arrive while Eden still holds its answer. `hermes-worker.test.ts` slept 100 ms for the killed worker's exit:
it polls up to 5 s. The pool's abort test (`regressions.test.ts`) held its one worker with a 300 ms spin, which a
descheduled main thread could outlive: the worker now blocks on `Atomics.wait` (`pool.fixture.ts`'s `hold`) until the
test lets it go, after the next task is asked. `long-reply.test.ts`'s gap series read 0.87 against 0.85 once in a
gate: its ratio now collects garbage before each timed call (9 runs), so neither side pays for what the fuzz tests
before it left. It reads the process clock: the thread clock (`process.threadCpuUsage`) first used here steps by up
to 4 ms on Bun 1.4.4 and under-reads, and with D1919's regression planted let the ratio through (D1965's review);
with the process clock the regression reads 0.96-1.47 (failed 6 of 6 here) and the reader 0.48-0.72 (8 of 8 passed
beside six busy loops). The D100 test reads the process clock for the same reason. Found in this branch's own loaded gate (444 ms against 300):
`deadline-unwatched.test.ts`'s fan-out deadlines (audit A5), whose source slept 800 ms; it now holds each call until
the test releases it, and the search and `fetchChecked` must return with the call still held (0 of 28 failed after,
10 beside six loops and 18 in the harsh harness). Every changed file passed 10 of 10 beside six busy loops.

**Planted regressions** (each restored after; every one fails its test):

| Regression | Test | Fails with |
|---|---|---|
| The ask waits for its work behind (`within(cue.polled, 60_000)`) | ask-behind "short wait" | 0 searches still running at the answer |
| Cut copies searched in the push's path (`pushCutBehind`'s branch off) | push-cut-behind | 0 still running at the reply |
| A fresh deadline after the poll (pre-D140) | ask-deadline | 3,003-3,017 ms against 2,250 (two of three tests) |
| No start deadline on a restart | router-processes D172 | 2 spawns, not 3 |
| An external event gets the wait too / no event does | client "plus the wait" | `["200","200"]`; 51 ms against >= 190 |
| No speculative call | proxy-speculate | five tests, "sent during the wait" false among them |
| A timeout leaves the worker running | hermes-worker | `alive` true after 5 s |
| An aborted queued task keeps its place (the original bug) | regressions WorkerPool | `queued` 2, not 0 |
| A cancel during a fire ignored; a 2^40 ms delay kept | deadlines | entries missing; 3 of 4 fired |
| No server-request budget | server-messages ping flood | no failure in 10 s |
| One array a dripped read (D1860) | stdio drip | 29,728 arrays held against 9 |
| The body parsed before the shape scan | http D100 | 51.8-55.8 ms of CPU against 21.3-25.0, 3 of 3 |
| The number reader gives up at a `null` (D1919) | long-reply gap | 23.8-36.0 against 19.0-23.8, 3 of 3 |
| `fetchChecked` not raced against its deadline; a search's flight not raced | deadline-unwatched | the source no longer holds the call (0, not 1), each |

**Limits.** The main run's per-test limit is 120 s (`TEST_TIMEOUT_MS`, was 60): the brief reports render-fast,
opt-round3 and test-cache failing on timeouts in this session's gates at load 10-35 (not reproduced here: 8 of 8
passed, four copies at once beside six loops), and beside four busy loops the slowest main-run tests already took
17-21 s (pi-ab-resume, client-package, gloss-packed). CPU-bound equivalence tests that named a
shorter limit of their own now name 120 s: `gate-differential` (14.6 s under four loops, limit 30 s), `linear` (13.8,
30), `own-matchers` (7.7, 30), `deletes` (6.6, 20), `injection-suite` (6.1, 30), `differential` (5.3, 30) and
`sim.test`'s two quality-run tests (the brief's "user-range tallies merge", 20 s). Limits that guard a complexity
class (the ReDoS and linear tests) were left alone.

**Cold gates** (`env -u OPENROUTER_API_KEY CHECK_COLD=1 FORMAT_COLD=1 bun run check`; load is the 1, 5, 15-minute
average before → after; every run 3,536 passed and 2 skipped of 3,538 in 333 files, as on the base):

| Run | Tree | Wall (s) | Load | Failures |
|---|---|---|---|---|
| Quiet | base 2deecc12d | 131 | 2.9 → 8.6 | 0 |
| Four busy loops | base 2deecc12d | 224 (tests) | 8.6 → 13.6 (read mid-run) | 1: `pi-ab-resume`, refused its resume because this branch's files changed under it mid-run (its key holds the code), not load |
| Four busy loops, x3 | the branch before `deadline-unwatched` and the D100 thread clock | 314, 193, 437 | 16.5 → 24.5 | gate 2: `partner.test.ts`'s planner timeout (left, above); gate 3: `deadline-unwatched` (fixed) |
| Four busy loops, x3 | the branch before the D100 thread clock | 248, 165, 151 | 6.9 → 12.9 | gate 1: the D100 400, 33.5 ms of wall against 30 (fixed) |
| Quiet | final | 96 | 8.2 → 7.2 | 0 |
| Four busy loops, x3 | final | 147, 152, 144 | 7.2 → 11.2 | 0, 0, 0 |

`bun run eval` on the final tree: precision 0.84, recall 0.62, falseFireRate 0; acting packets on 8 of 28 neutral
requests (0.43 items each), facts handed 10 of 11, a look-alike on 3 of 10, as on main.

**Found after the brief:** `partner.test.ts`'s "serving and shadow lookups start no call their source timeout would
cut off" (a 60 ms source timeout around a 40 ms search, then 20 x 10 ms for the shadow record; 2 of 12 failed in the
harsh harness and 1 of this branch's loaded gates) now polls for the record up to 5 s (10 of 10 beside six busy
loops; commit e5ce94ed6). Left: `rare-terms.test.ts`'s full-table
tests (5.4-6.5 s against 30 s beside four loops). `proxy-a11`'s hang-up choreography and `python.test.ts` passed 12 of
12 in the harsh harness.

## The slowest files (each alone, `bun test <file>`, wall incl. ~70 ms start-up)

| File | ms | Where the time goes | Proposal |
|---|---|---|---|
| packages/redact/src/linear.test.ts (before the split) | 9,541 | "every gitleaks rule outside RE2_RULES" 6.5 s; RE2 vs JS equivalence 3.7 s | Done: split into `linear.test.ts` + `redos.test.ts` |
| packages/engine/src/kg.test.ts (deleted by D225) | 6,100 (200 seeds); 1,950 (`KG_DIFF_SEEDS=25`) (bun's [s], 2026-11-06) | "the same walks" against `PreviousGraph` (115,853 expects at 200 seeds, 15,819 at 25) | Done: 25 seeds in `test:changed`, 200 in `check` and `test:pkg` (D176, above) |
| packages/sim/src/sim.test.ts | 3,542 (6,625-7,246 on 2026-11-05, above) | "a run without updates scores exactly as before" 2.1 s (two `runQuality` runs) | Share one `runQuality` result between the tests that read it, or 3 sessions instead of 6 (it has a 20 s timeout now) |
| packages/server/src/http.test.ts | 2,671 | the 60,000-deep body test 2.5 s | See validate below |
| packages/protocol/src/validate.test.ts | 2,305 | 60,000-deep array: `JSON.stringify` throwing RangeError costs 2.3 s in JSC (20,000 deep: 2 ms, no throw) | Find the smallest depth that still overflows on Linux and macOS and use it; keep one deep case |
| packages/primitives/src/sparse-index.test.ts | 1,349 | randomized index checks | Fewer iterations behind a constant, full count in a bench |
| packages/primitives/src/bandit.test.ts | 1,268 | statistical convergence runs | as above |
| packages/sim/src/lab/suites.test.ts | 1,213 | builds worlds for every suite | Done: one base world per seed shared by the whole file (D1945) |
| packages/engine/src/partner.test.ts | 1,143 | 74 tests | (protected while the engine is being edited) |
| packages/engine/src/reader.test.ts | 2,187 | wait-bound tests with real delays (300–400 ms readings) | Sleep-free where the test is not of a wait bound (2026-11-03b) |
| packages/sim/src/lab/reader-stub.test.ts | 3,340 | three `hidden-funnel.ts` processes (5.5 s CPU), run at once; also holds the NEWL flag checks | Done: sync capped at 100 items (was 8.4 s CPU); next, build the simulated sources once per seed |
| packages/redact/src/redos*.test.ts | 1,526–1,930 each | the crafted-input sweep, split over four files | Done (2026-11-03b) |
| packages/sim/src/lab/hermes-host.test.ts | 1,117 | starts servers and stub workers | (protected) |

Per package, summing each file alone: engine 14.6 s, redact 10.1 s, sim 9.2 s, primitives 5.0 s, server 2.9 s,
sources 2.8 s, protocol 2.3 s, eval 0.6 s, graph 0.3 s, client 0.1 s, llm 0.1 s (47.8 s in all, start-ups included).

## Many sources per user (2026-11-07, A1, D261–D265)

`bun packages/engine/bench/many-sources.bench.ts [sources=1000] [itemsPerSource=20] [events=300] [asks=40]
[latencyMs=0] [--config=<json>]`: one user with that many in-memory connectors (four with the workload's requests, the
rest unrelated), the shipped wiring with no key, a simulated clock; cold start, calls and CPU per event and ask, heap.
`bun run funnel ... -- --noise-sources 995 --limit 16` screens quality at that size (`--jobs 2`: memory). Figures in
docs/research/a1-scale.md. A change to sync, routing or per-(user, source) state reports both.
`bun packages/engine/bench/source-days.bench.ts [sources=1000] [itemsPerSource=20] [days=2] [--churn=1]
[--mail-per-day=40] [--config=<json>]` (A13, D324) runs the same user over whole simulated days with sources that
gain items (the sync ticking every minute, a working day of requests and asks, a stub card model under the servers'
budget) and prints listing, search and card calls per day: the instrument for the sweep, the polls and per-day card
cost (docs/research/a13-scale.md). 1,000 sources × 20 items × 3 days runs in ~10 s; × 300 items in ~2 min.

## Many users per process (2026-11-07, A14, D325–D329)

`bun packages/engine/bench/users.bench.ts [users=1000] [itemsPerUser=500] [--world] [--no-freeze] [--waves=K]`: the
shipped wiring over N users with three instant connectors each; backfill CPU, memory per user live and frozen (D325;
JS heap plus `external`, which `heapUsed` alone leaves out: typed-array stores, most of an index and every packed
text; and RSS read once it stops falling), thaw time per user, the sliced freeze and thaw's event-loop lag.
`--waves=4` is the steady state where three quarters of the users are idle; `--warm-waves=J` holds the J waves before the
live one warm (D862), `--prose` takes item text from docs/ instead of the sim's templates, `--cache=<json>` sets cache
limits (`'{"warmIdleMs":0,"expireEveryMs":600000}'` is the cache before D862). `restart.bench.ts --warm` writes and reads
warm files (docs/research/p6-scale.md). `bun packages/engine/bench/storm.bench.ts
[users=300] [itemsPerUser=1000] [--config=<json>] [--tick-ms=N]`: a cold-start storm on the wall clock with 20-80 ms
connectors while warm users send events (open loop): storm time and their `observe` p99. With
the default each storm user is kicked as their first event would (D753, D755; `--config='{"syncKick":false}'` is
the storm before it); `--tick-ms=60000` ticks
as the servers' timer does instead of back to back (`packages/sim/lab/o5/storm.txt`, `storm-paced.txt`). Figures:
docs/research/a14-scale-users.md. A change to the cache, the sync's ingest or per-user state reports both.

## Scale anchors: memory per user and ingest cost (2026-11-03, 4-core container shared with other agents, Bun 1.4.4)

`bun packages/engine/bench/ingest.bench.ts [users=200] [itemsPerUser=500]` syncs that many users through the real path
(`SyncManager` → `SourceFanout.list` with `sanitizeItem` as the redaction hook → `ItemCache.put`), each with their own
copy of the workload's items (1,599 chars of text on average), then sweeps every user once with nothing changed. It
prints the heap per user after a full GC and the CPU per item of the backfill (every item new) and of the sweep (every
item unchanged). A change to the cache, the index, redaction or the sync reports these before and after. Since D188
the cache holds item text deflated; `--plain` runs the old layout (plain strings) for a before figure, and `--world`
uses the sim world's text, whose typographic characters make plain strings two bytes a character.

| 100 users × 500 items | memory per user | backfill µs/item | unchanged sweep µs/item |
|---|---|---|---|
| Before skipping unchanged items (main at 926b094), 5 runs | 1,812 KB (3,711 B/item) | 111.2-117.3 | 41.3-44.4 |
| Unchanged items reuse their redacted copy, 5 runs | 1,833 KB (3,754-3,755 B/item) | 110.4-118.4 | 3.6-4.8 |

The default size (200 × 500) took 20 s wall and gave 1,794 KB per user, 153 µs/item backfill and 45 µs/item sweep
before the change (a busier machine at the time). The reuse adds 43-44 B/item (measured); what makes it up (the
hash field on each entry, a `madeFrom` WeakMap entry per held copy) is not measured apart.

The bench runs two modes, each in its own process, and the table above is its `core` line: `shipped` runs a
`ContextPartner` on `DEFAULT_CONFIG` with no model (`onStored` mention recording on), which is what the servers run.
It also prints the stages (the differences between modes) and the heap with the sources' raw items released; a fourth
argument (`core`, `shipped`) runs one mode. Its `graph` mode went with the knowledge graph (D225, 2026-11-07); the
figures below that name it, and the `shipped` figures before that date (graph on), are history. 200 × 500, two runs
(2026-11-05): `core` 66.1–73.4 µs/item, `shipped` 357.6–380.6 µs/item (5.2–5.4x) and 2.0x the heap
per item; about 75 s wall in all (docs/research/graph-ablation.md).

`--quick` (2026-11-05) runs 40 × 500 for a screen while iterating; the default stays 200 × 500, the size every
recorded figure uses. One run of each, the same session, load about 2.2: the default took 76.5 s wall (core 82.4,
graph 274.5, shipped 367.3 µs/item; held 2,595 / 5,225 / 5,234 B/item; `+graph` 192.1 µs/item; shipped/core 4.46x),
`--quick` 16.9 s (core 91.0, graph 275.5, shipped 398.6 µs/item; held 2,734 / 5,363 / 5,380 B/item; `+graph`
184.5 µs/item; shipped/core 4.38x). Its µs/item came within 0.4-10.4% of the full size, but its held memory per item
reads 3-5% higher (a fixed per-user cost over fewer items), so a quick memory figure is never set against a 200 × 500
one; the bench prints that note under its header. The modes still run one after another: run at once on a 4-core box
they would contend for CPU and GC, and the stage differences are per-mode subtractions.

## Rules for new tests

- Behaviour changes get a test first; a regression found in review gets its own test.
- New state gets an isolation test (two users, two tenants or two sessions).
- No real network, no real keys: fake `fetch`, `FakeModel`, injected clocks (`pacing.test.ts`).
- A ceiling on work (a ReDoS or linearity guard) measures CPU time (`cpuMs`, D811), not wall time. A test that must
  measure a wait in wall time goes in `scripts/test-tail.txt`. To show that
  work was done ahead of time, count the work (`warm.test.ts` counts pattern compilations and first runs through
  counting engines) rather than timing the call. CPU time still grows under a loaded gate (sse-drip's 1,500 ms bound
  read 2,806-10,462 ms there): where the work can be counted, count it (sse-drip counts the bytes copied and the
  searches started, D1945), and where it cannot, time it against a reference workload in the same process (the D100
  400 against a `JSON.parse` of the same body). Prove the guard by planting the regression it was written for.
- A test over 5 s alone gives its own timeout and says why (the run's default is 120 s, D1965; 60 s and 20 s before;
  the report at the end of `bun run test` lists every test over 3.5 s). A limit only ever raises the wait: a CPU-bound
  test in the main run names none below the run's own (D1965), and slowness is caught by CPU bounds and work counts.
- "It did not wait for X" is shown by holding X (a promise the test releases, `Atomics.wait` on a shared flag) and
  checking that X was still running, neither answered nor called off by a deadline, when the call returned; not by a
  wall-clock bound around a sleep (D1965: `ask-behind`, `push-cut-behind`, the pool's abort test). "It happened in
  this order" is read from a log of the events (`proxy-speculate`), and "it happened" by polling for it under a bound
  only a hang reaches (`deadlines`, `hermes-worker`). A deadline that must hold in wall time keeps a bound in
  proportion to the deadline with a gap that load does not close (`ask-deadline`: 1.5x against a regression at 2x).
- A heap bound measures in a process of its own (`Bun.spawn` of a scenario script, as
  `packages/sources/src/cache-heap.scenario.ts`): under `--parallel` a file shares its worker's heap with the files
  run before it, whose leftovers moved one reading by 1.2 MB (docs/research/b2-deflake.md).
