# Memory scale benches

## Locked 2k bench (regression floor)

`locked-2k.ts` and `locked-contract.test.ts` are byte-for-byte copies of the locked `whatever` harness. That
harness lived only in the main checkout's git-excluded `.whatever/` directory, so it was not in git.

| File here | Source | sha256 of the source (= this file) |
|---|---|---|
| `locked-2k.ts` | `.whatever/benches/scale.ts` | `606edb61a5211fa8753e1254e39baff2d5b59dcdaa86231dde051d0c39b51b07` |
| `locked-contract.test.ts` | `.whatever/benches/contract.test.ts` | `3eb31afebbcc76b570d4695337be74c40a255e9247a813b71379f10ba56afcc8` |

- The harness config was `.whatever/harness.json` (sha256
  `153fe4a8b2d9057d90329c2dfb3a1935928ff272d4816e0d9e5fa4e6095a3924`). Its primary was
  `bun .whatever/benches/scale.ts` → `metric:` (misses, lower is better). Its guards were `ms:`, `bytes:` and the
  contract test plus five memory test files.
- The loop's baseline commit was `8a6b4705f`, where the bench scored 1 miss. Experiment 1 (`e52050501`) took it
  to 0, and it stayed at 0 for the remaining 320 experiments (`.whatever/results.tsv`, `.whatever/best.json`).
- The import paths needed no change: `benchmarks/memory-scale/` has the same depth as `.whatever/benches/`.

**It is a regression floor.** It must stay at `metric: 0` on `main`. It is saturated, so it cannot show an
improvement. Its blind spots are listed in `docs/memory-ship/A5-EVALUATION.md` §1.

```bash
bun benchmarks/memory-scale/locked-2k.ts        # metric: 0, ms, bytes, n
bun test benchmarks/memory-scale/locked-contract.test.ts
```

Do not edit these two files. If the product's API changes under them, fix the import only and say so here.
