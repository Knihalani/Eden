# Apex campaign

New domains so compiling is not scored on a retune of desk / CRM / cart / github / graphql / k8s / saga / horizon-extra.

| World | Shape | Goal | Why new |
|---|---|---|---|
| `createStripeInvoices` | cursor pages then flatten foreach | `{ merchant }` | Invoices + `nextCursor`, not coverage `PAGE_ITEMS` names |
| `createHrisJoin` | lookup join | `{ org }` | people.deptId → teams.name |
| `createSentryFilter` | filter `level == "error"` | `{ q }` | Not prefix top-k |
| `createCmsFlatten` | nested flatten sections.blocks | `{ site }` | One page, nested arrays |
| `createTranscodeChunk` | chunk(files, 4) | `{ job }` | Batches, not foreach file |
| `createCatalogZip` | zip skus × prices | `{ cat }` | Lockstep two arrays |
| `createOauthSession` | token carry seqLen 5 | `{ user }` | login.token on later calls |
| `createLogGroup` | group-by level then flush | `{ svc }` | Not foreach event |
| `createApexNoise` | unique-work | `{ id }` | 0 programs |

```bash
bun test benchmarks/campaign/apex.test.ts
```

goLive is FAIL-not-skip. Unique work must compile 0 programs.
