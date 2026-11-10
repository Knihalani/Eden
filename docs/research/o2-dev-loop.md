# O2: the repo's own loop — a result cache for test files

Status: built and measured 2026-11-10 on branch `claude/o2-test-cache` (from `claude/lucid-hypatia-v9wqk5` at
3ee07ac65). Decision D650. Paid spend: $0. Machine: 4 vCPU, 15 GB, Bun 1.4.4, one run at a time.

## In plain words

- **What it is.** `bun run test` (and so `check`, `check:fast`, `test:changed`, `test:pkg`) now skips a test file that
  already passed on exactly the inputs it has now. The inputs are the file, every file it imports (followed through the
  whole chain), the lockfile and the test configuration. A test that starts other programs or looks around the
  repository is treated as depending on every code file, so it is skipped only when no code changed.
- **Why.** The suite grew to 227 files and 53-55 s on this 4-core box (docs/TESTING.md recorded about 16-20 s a week
  ago), and the time is a long tail: no file is above 9.5 s, the slowest 15 hold half. Every reviewer, integrator and
  audit fixer runs `bun run check` again in its own worktree on a tree someone else already checked.
- **What it gains (measured).** The same tree checked again: tests 55 s to 0.45 s, the whole `bun run check` 58 s to
  5.4 s. A research note or decision edited: 55 s to 10 s. One file edited in a leaf package: 55 s to 27 s. An engine
  file edited: 55 s to 45 s (nearly everything imports the engine, so nearly everything runs, as it should).
- **Is a skip safe?** A skipped file is one whose every reachable input is byte-identical to a run in which it passed.
  That is checked, not assumed: `scripts/test-cache-audit.ts` runs each test file under `strace` and compares the
  files it really opened with the files its key covers. On this tree: 227 files traced, none read a file outside its
  key. A planted read of `LICENSE` in a test with no sign of it was reported.
- **What it cannot see.** A test that depends on the date, the network or files outside the repository. None should;
  a pass is trusted for at most 7 days. `CHECK_COLD=1 bun run check` runs everything, as it already ignores the
  Prettier and tsc caches.

## 1. Where the time was

`./scripts/test.sh --reporter=junit` on the base commit: 2,541 tests in 227 files, 54.1 s wall, 154 s user, the files'
own times summing to 201.8 s. By package: sim 61.7 s, engine 59.0 s, primitives 17.5 s, onboarding 12.4 s, redact
11.5 s, server 10.9 s, sources 7.9 s, proxy 7.3 s, client-python 7.0 s, eval 4.4 s. The slowest five:
`examples/onboarding/client-package.test.ts` 9.4 s, `primitives/sparse-index-packed.test.ts` 8.8 s,
`sim/lab/funnel-flags.test.ts` 7.8 s, `sim/sim.test.ts` 7.6 s, `engine/source-refs.test.ts` 7.2 s. No single fix
gives a large factor; not re-running what cannot have changed does.

## 2. Design (D650)

`scripts/test-cache.ts`. A test file's key is a SHA-256 over:

1. **The run's environment**: Bun's version and revision, platform, core count, `python3 --version`, `bun.lock`,
   `bunfig.toml`, `scripts/test-preload.ts`, `scripts/test.sh`, `scripts/test-cache.ts`, every `package.json` and
   `tsconfig*.json` outside archived/, and the variables a test can see (`BUN_*`, `NODE_*`, `TEST_*`, `EDEN_*`,
   `OPENROUTER_*`, `HAIKU_*`, `ANTHROPIC_*`, `MODAL_*`, `TZ`, `CI`, locale), names and values.
2. **The import closure**: the file and every repository file it reaches through static imports, literal dynamic
   imports and `new URL("./x", import.meta.url)` (how workers and child scripts are named), resolved with
   `Bun.resolveSync`. Imports into node_modules are covered by the lockfile.
3. **The tree, for a file that can read the repository some other way.** Signs, looked for with comments blanked in
   the file and in every module it reaches: it imports `child_process` or uses `Bun.spawn`/`Bun.$`; it learns its
   location (`import.meta.dir`, `.path`, a bare `import.meta.url`, `__dirname`); it reads the working directory
   (`process.cwd()`, a glob); it imports or requires a name computed at run time; a string names a repository path
   (`packages/…`, `docs/…`, `scripts/…`). Such a file is keyed on every file git tracks or would track, outside
   archived/. Prose (docs/ and Markdown) is left out of that unless a string names it: a `docs/…` path, a `.md`
   literal, or a bare `"docs"` path part beside a location sign.

Two modules are trusted by name (`TRUSTED`): the worker pool and its worker import the module their caller names,
and callers name themselves or a sibling by URL, which are edges.

`scripts/test.sh` plans before the run (which files have no recorded pass on their key), runs only those with Bun's
junit reporter, and records each file that passed, after re-hashing it: an edit made while the tests ran is not
recorded as a pass. Files that passed are recorded even when another failed, so the next run is the failures and
what changed. Any extra argument for `bun test` (a name filter) turns the cache off for that run. The passed set is
one file under the git common directory, shared by every worktree, as the Prettier set is (docs/TESTING.md).

## 3. Measurements

One appended comment line (or one prose line), then `bun run test`, wall time of the command; the cache primed on the
unedited tree first.

| Edit | Before | After | Files run |
| --- | --- | --- | --- |
| none (the same tree again) | 54.2-55.5 s | 0.45 s | 0 of 227 |
| `docs/research/a14-scale-users.md` | 54.2-55.5 s | 10.3 s | 9 |
| `docs/DECISIONS.md` | 54.2-55.5 s | 10.1 s | 9 |
| `packages/client/src/index.ts` | 54.2-55.5 s | 26.8 s | 49 |
| `packages/proxy/src/main.ts` | 54.2-55.5 s | 27.6 s | 43 |
| `packages/sim/src/lab/funnel.ts` | 54.2-55.5 s | 27.4 s | 43 |
| `packages/server/src/http.ts` (before the prose rule was narrowed) | 54.2-55.5 s | 29.9 s | 52 |
| `packages/engine/src/text.ts` (same) | 54.2-55.5 s | 44.9 s | 157 |
| `packages/primitives/src/tokenize.ts` (same) | 54.2-55.5 s | 49.2 s | 181 |

`bun run check` whole: 83.0 s on a fresh checkout (no Prettier or tsc cache), 58.2 s with those caches and every test
run, 5.4 s with every test file skipped. Planning costs 0.3-0.4 s (the tree is about 2,000 files outside archived/, each hashed once).

43 of the 227 files are keyed on the tree (81 of the 202 file-seconds): they spawn servers, the funnel, Python, or
scan sources. They run on any code change, which is the 27 s floor of a leaf edit. 9 of them are keyed on prose.

## 4. The audit

`bun scripts/test-cache-audit.ts [files] [--reads out.json]`: each test file alone under
`strace -f -e trace=open,openat`, successful read-opens of tracked files collected from the process and its children,
compared with the key's files. 92 s for the suite at 4 jobs. Result on this tree: 227 traced, 0 outside their key
(`spans.test.ts`, a timing test, fails under strace; its reads are still checked).

The trace also sized the signs. The first version looked for `exec(` and `spawn(` by name and keyed 191 files on the
tree (a regular expression's `.exec(` matched). Looking for the `child_process` import instead: 43. The first prose
rule (any string with "docs", "README" or ".md") keyed 31 files on prose; the trace shows two tests read prose
(`engine-config.test.ts` reads docs/profiles, `reader-latency-fit.test.ts` reads one research note), and the narrowed
rule keys 9, those two among them.

Tried and dropped: keying a spawning test on its package's dependency closure instead of the tree. The trace shows it
is unsound (`packages/llm/src/pacing.test.ts` scans seven other packages' sources) and it gains little (most spawning
tests are in sim, which depends on 11 of the 16 packages).

## 5. Not done

- Engine edits still run about 157 files (45 s): the engine is imported by nearly every test. A further factor there
  needs cheaper tests, not fewer.
- Run the audit in `check`: 92 s, and it needs strace. It is a tool to run after changing the cache or when a test
  starts reading files in a new way.
