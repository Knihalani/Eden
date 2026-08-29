# Compile-quality corpus

Pinned programs and named refusals for Wave 3. Each fixture is a test whose
**name is the fixture name** — a regression prints that name, not a line number
in a helper.

## CI

```bash
bun test packages/compile/src/corpus
```

Wired into `scripts/test.sh` (discovers `*.test.ts`). Same command from the
repo root:

```bash
bun run test:corpus
```

## Shapes

| Fixture | Pin |
|---|---|
| `mixed-width-fanout` | foreach `over` = `from findOrder.items` |
| `period-loop` | period body mines a loop; `listItems` is a **tool**, not an island |
| `nested-loop` | inner loop inside an outer loop; `listOrgs` / `listItems` are **tools**, not islands |
| `branch-ci-gate` | branched program (`hasBranch`) of ≥3 steps |
| `island-before-write` / `island-between` / `island-tail` | witnessed island placement |
| `shell-kubectl-logs` | generic shell stretch |
| `retry-variants-shape-vote` | retries vote for shape; envelope keeps `K-0..K-3`, not `K-r*` |
| `pagination-cursor-refuse` | `listPage` + `without a bindable foreach` |
| `pagination-bindable-foreach` | `listAll` mines foreach |
| `read-set-mismatch` | code `read_set_mismatch`, 6 of 12 |
| `etl-width-18-default` | seqLen 20 at the auto `maxGram` default |
| `desk-short-unfragmented` | short stretch stays one program |
| `underdetermined-write` | fail closed on unbound write |
