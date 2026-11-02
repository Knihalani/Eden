# @eden/primitives

Direction-agnostic, benchmarked building blocks (D20): hashing, one tokenizer and interner, multi-pattern matching,
top-k, BM25F sparse index, S3-FIFO cache, deadline/singleflight/GCRA/breaker/AIMD, histograms, reply stripping and
near-duplicate sketches, calibration and certification statistics, Thompson sampling, budgeted packing, worker pool
(D25). No dependencies. [README.md](README.md) has the module table and the measured rules; read it first.

## Rules that apply here

- **Measured, not folklore.** The README's rules (no default parameters in hot functions, typed arrays over objects,
  no per-call allocation, bulk calls over per-item calls, native only when it is native) each come from a benchmark.
- **A change to a primitive re-runs its benchmark** (`bun packages/primitives/bench/<name>.bench.ts`) and reports
  before/after numbers in the PR (CLAUDE.md). Numbers vary ±30% run to run on a shared VM: compare runs made back to
  back on the same machine.
- **One tokenizer.** Hot-path code everywhere uses `tokenizeInto`/`Vocab` from here; do not add a second term
  definition in another package.
- **Stay in TypeScript (D22).** `native/` is a measured Rust experiment; nothing in `packages/` imports it.
- **Direction-agnostic.** Nothing here knows about tenants, items or models; state keyed by user lives in the
  callers (engine, sources), which own isolation.
- New dependency: justify it in the PR (CLAUDE.md). Library comparisons live in `bench/compare/`.

## Files worth knowing beyond the README table

| File | Why |
|---|---|
| `bench/harness.ts` | The micro-benchmark harness the `*.bench.ts` files share (warmup, timed batches, p50/p99) |
| `bench/compare/*.compare.ts` | Head-to-heads against npm libraries that drove a choice |
| `bench/redos.scan.ts` | The search that found the secret gate's backtracking rules (D24) |
| `src/pool.fixture.ts`, `src/pool-worker.ts` | The worker pool's test fixture and worker entry (Bun workers) |
| `src/regressions.test.ts` | Bugs found in audits, one test each |

## Test

```bash
bun run test:pkg primitives          # ~5 s; sparse-index, bandit and pool are the slowest files
bun packages/primitives/bench/tokenize.bench.ts   # a benchmark (no assertions; prints a table)
```

## Pitfalls

- `pool.test.ts` starts real Bun workers: keep per-test timeouts generous, the parallel test run shares the cores.
- Statistical tests (`bandit`, `calibrate`, `pack`, `random`) use seeded `Xoshiro128`; keep seeds fixed so a failure
  reproduces.

## Where next

`docs/research/primitives.md` (every benchmark table), `docs/research/fast-primitives.md`,
`docs/research/primitives-dedup.md`, `docs/research/language-choice.md` (why not Rust, D22).
