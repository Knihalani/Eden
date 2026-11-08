# B2: tests that failed once under load (2026-11-07)

Session B2. Goal: `bun run check` passes reliably on a loaded 4-core box. No decision needed (test-only change, no
engine behaviour moved). Load for every "loaded" run below: four busy-loop shell burners (`while :; do :; done`, one per
core) beside the run, load average 9-10; 4-core container, Bun 1.4.4.

## Results cache heap bound (`packages/sources/src/regressions.test.ts`, "50,000 empty pages …")

**Cause: a shared heap, not CPU load.** `bun test --parallel` runs many files one after another in each worker
process: each file gets a fresh global (`--isolate`) but the worker's one JSC heap. The test's baseline heap in the
suite was 262-298 MB (other files' state), and whatever those files left behind (timers, servers, caches) was freed or
allocated between the test's two readings. Logging the readings in four unloaded `bun run test` runs: `heldByCache`
3.45, 4.19, 3.02, 3.40 MB (bound 4 MB: **1 fail in 4**), `grew` 2.82, 2.91, 1.82, 1.79 MB (below the scenario's real
growth: other files' garbage freed in the window). The same scenario alone in a process read `grew` 3.23-3.26 MB and
`heldByCache` 3.00 MB in 12 of 12 runs under the four burners, with the test's own settle and with a variant that
waits for a later `AbortSignal.timeout` (no difference): load was never the cause.

**Fix:** the scenario moved to `packages/sources/src/cache-heap.scenario.ts`, unchanged (same settle, same
inputs); the test spawns it with `process.execPath`, reads its one JSON line and asserts the same four bounds (cache
bytes <= 4,000,000, entries < 10,000, held < 4 MB, growth < 5 MB). Margin now: held 3.00 MB against 4 MB (1.0 MB
headroom, against a run-to-run spread of under 0.01 MB alone), growth 3.23 MB against 5 MB. Cost: the test took
4.8-8.5 s in the suite before (the settle loop ran long while other files' garbage fell); now one child of about 4 s.

| | Failures, full suite unloaded | Failures, full suite loaded |
|---|---|---|
| Before | 3 of 7 `bun run test` runs: this test in 2 (named), 1 run's failing test not captured | 0 of 4 |
| After | 0 of 7 `bun run test` runs | 0 of 3 (`bun run check` beside four burners, 75-87 s each) |

## Router start test (`packages/server`, a child "exited with code 2 before listening")

**Not reproduced.** 12 loops of `router.test.ts` and `router-processes.test.ts` together (`--parallel`) beside four
burners, 10 loops of those plus `connectors.test.ts` and `regressions.test.ts` beside twelve burners, and the 4 loaded
plus 7 unloaded full suites: 0 failures. Exit code 2 is `main.ts`'s configuration or startup failure path (D365), which
prints one `eden: …` line naming the cause; the only such lines in the loaded suite logs were the expected ones
of "a child that cannot start" (`EDEN_SOURCES_FILE … is not valid JSON`). Without the failing run's `eden:` line the
cause is unknown; nothing was changed. If it recurs, the child's line just above the failure names it.

## The others named in the brief

Heap test (the same as above), sim rate, probes `judgeItemBytes` and a shapes fuzz were fixed earlier (audit A5/A11:
`probes.test.ts`'s generous source deadline, the heap test's settle loop). None failed in the loaded or unloaded runs
here.

## Gate on the final tree

`bun run check` three times in a row beside four burners: 2,377 pass, 0 fail each (87, 75, 76 s). A fourth beside a
`bun run funnel` started with it passed too (the funnel finished early in that run, so it overlapped only part of it).
`bun run eval` unchanged: precision 0.65, recall 0.52, falseFireRate 0.
