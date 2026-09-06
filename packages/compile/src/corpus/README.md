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
| `pagination-cursor-pages` | cursor `until` + flatten foreach over page `items` |
| `pagination-offset-pages` | page/nextPage walk + flatten foreach |
| `pagination-random-pages-refuse` | shuffled cursors refuse |
| `pagination-bindable-foreach` | `listAll` mines foreach |
| `read-set-mismatch` | code `read_set_mismatch`, 6 of 12 |
| `etl-width-18-default` | seqLen 20 at the auto `maxGram` default |
| `desk-short-unfragmented` | short stretch stays one program |
| `underdetermined-write` | fail closed on unbound write |
| `handoff-intake-billing` | composed handoff parent, two children |
| `crm-pipeline` | seqLen 5; `getLead` / `createDeal` are tools |
| `calendar-rsvp` | minSeqLen 4 |
| `payments-nested-json` | minSeqLen 4 |
| `two-phase-reserve-confirm` | minSeqLen 4 |
| `array-of-objects-foreach` | foreach `over` = `from listCart.items` |
| `unique-work-crm` | zero programs (nothing repeats) |
| `underdetermined-charge` | fail closed `underdetermined_write` |
| `optional-enrich-majority` | one program including `enrichCompany` |
| `two-key-tenant` | input `orgId`+`plan`; envelope has both keys |
| `inventory-three-field` | foreach over `{sku,qty,warehouse}`; all three args from item |
| `map-reduce-merge` | after foreach, `writeRows.rows` binds from the loop’s collected results |
| `graphql-relay-edges` | foreach over `edges`; `updateIssue` binds `id`+`title` from `item.node.*` |
| `json-post-sso` | `createUser` nested JSON body templates; no `underdetermined_write` |
| `search-topk-prefix` | foreach over a witnessed `slice` of ranked hits, not the full array |
| `search-random-subset` | non-prefix subset refuses `read_set_mismatch` |
| `k8s-poll-ready` | poll loop with `until` on `ready`, not foreach |
| `k8s-poll-never-ready` | all-false ready refuses rather than looping forever |
| `saga-hold-compensate` | branched program (`hasBranch`) capture vs cancel |
| `unique-work-horizon` | shuffled distinct sequences; zero programs |
| `sentry-filter-level` | foreach over filter `level == "error"` |
| `hris-lookup-join` | foreach people; `teamName` lookup from teams |
| `oauth-token-carry` | seqLen 5; token from login |
| `transcode-chunk` | foreach over chunk(files, 4) |
| `catalog-zip` | foreach over zip(skus, prices) |
| `logs-group-by-level` | foreach over group(events, level) |
| `cms-flatten-blocks` | nested flatten sections.blocks |
| `unique-work-horizon` | shuffled distinct sequences; zero programs |
