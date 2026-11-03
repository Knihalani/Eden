# Testing

## Commands

| Command | What it runs | When |
|---|---|---|
| `bun run test` | Every `*.test.ts` under packages/, examples/, scripts/, in parallel (`scripts/test.sh`) | Before a merge (part of `check`) |
| `bun run test:changed` | Packages touched since the merge base with origin/main, plus their dependents | The inner loop |
| `bun run test:pkg engine sim` | Named packages | Working inside one package |
| `bun run check:fast` | format:check + typecheck + test:changed | Before pushing a work-in-progress commit |
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
parallel runs, 1,111,669 in the other two: some test's number of assertions depends on timing or order (not traced).
Every test passed each time; worth pinning down.

## The slowest files (each alone, `bun test <file>`, wall incl. ~70 ms start-up)

| File | ms | Where the time goes | Proposal |
|---|---|---|---|
| packages/redact/src/linear.test.ts (before the split) | 9,541 | "every gitleaks rule outside RE2_RULES" 6.5 s; RE2 vs JS equivalence 3.7 s | Done: split into `linear.test.ts` + `redos.test.ts` |
| packages/sim/src/sim.test.ts | 3,542 | "a run without updates scores exactly as before" 2.1 s (two `runQuality` runs) | Share one `runQuality` result between the tests that read it, or 3 sessions instead of 6 |
| packages/server/src/http.test.ts | 2,671 | the 60,000-deep body test 2.5 s | See validate below |
| packages/protocol/src/validate.test.ts | 2,305 | 60,000-deep array: `JSON.stringify` throwing RangeError costs 2.3 s in JSC (20,000 deep: 2 ms, no throw) | Find the smallest depth that still overflows on Linux and macOS and use it; keep one deep case |
| packages/primitives/src/sparse-index.test.ts | 1,349 | randomized index checks | Fewer iterations behind a constant, full count in a bench |
| packages/primitives/src/bandit.test.ts | 1,268 | statistical convergence runs | as above |
| packages/sim/src/lab/suites.test.ts | 1,213 | builds worlds for every suite | One world per seed shared by the registry tests |
| packages/engine/src/partner.test.ts | 1,143 | 74 tests | (protected while the engine is being edited) |
| packages/engine/src/reader.test.ts | 1,138 | reader prompts over many items | (protected) |
| packages/sim/src/lab/hermes-host.test.ts | 1,117 | starts servers and stub workers | (protected) |

Per package, summing each file alone: engine 14.6 s, redact 10.1 s, sim 9.2 s, primitives 5.0 s, server 2.9 s,
sources 2.8 s, protocol 2.3 s, eval 0.6 s, graph 0.3 s, client 0.1 s, llm 0.1 s (47.8 s in all, start-ups included).

## Rules for new tests

- Behaviour changes get a test first (CLAUDE.md); a regression found in review gets its own test.
- New state gets an isolation test (two users, two tenants or two sessions).
- No real network, no real keys: fake `fetch`, `FakeModel`, injected clocks (`pacing.test.ts`).
- Wall-clock ceilings only for ReDoS-style guards, best of three, with headroom for a parallel run.
- A test over 5 s gives its own timeout and says why.
