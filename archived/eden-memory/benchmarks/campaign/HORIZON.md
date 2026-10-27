# Horizon campaign

New domains so compiling is not scored on a retune of desk / orders / etl / incident / research / thrash / CRM / calendar / payments / cart / github-pr / terraform / flags / dns / inventory / tenant / map-reduce.

| World | Shape | Goal | Why it is not desk/moonshot |
|---|---|---|---|
| `createGraphqlRelay` | Relay connection loop `{ edges: [{ node: { id, title, number } }] }` width 3 | `{ repo }` | listIssues → updateIssue ×3 from **node.*** (no top-level id on the edge) → publishDigest. Not github-pr's `{ path, sha }` files. |
| `createSsoProvision` | nested-object body, two-key linear seqLen 4 | `{ orgId, email }` | getOrg → createUser(`{ body: { user: { email, name }, orgId } }`) → grantRole → sendInvite. Body is an **object**, not a string and not tenant's flat keys. |
| `createSearchRank` | prefix top-k of 10 | `{ q }` | searchHits returns 10 `{ id, score, rank }` (rank 1..10, score descending); takeHit on the **first 3 only**; writeDigest. Not a full-width foreach. `createSearchRandomSubset` takes 3 non-prefix ids and **must refuse**. |
| `createK8sRollout` | same-args poll | `{ deploy }` | getDeploy → listPods → getRollout `{ ready: false }` ×2 then `{ ready: true }` (identical args) → verifyRollout. Poll is 3 getRollout + 1 verify; prefix reads remain after poll-strip. Not thrash-enforce. |
| `createSagaHold` | two-arm saga, ≥3 witnesses/arm | `{ holdId }` | getHold `{ state: ok\|fail }` (pool 50/50) → captureFunds **or** cancelHold → notifyLedger both arms. Not a linear CRM pipeline. |
| `createBlobPipeline` | sequential seqLen 4 | `{ blob }` | fetchBlob `{ blob, sha, bytes }` → hashObject `{ sha }` → putObject → notifyStore. Hash-then-put, not payments nested billing. |
| `createSqlReport` | SQL string template | `{ report }` | runQuery(`SELECT * FROM events WHERE report = 'R-1'`) → fetchRows → writeCsv → mailReport. SQL **varies with report**; cannot be a literal. |
| `createWebhookFanout` | three distinct writes, not a foreach | `{ hook }` | receiveEvent → notifySlack → writeAudit → ackEvent. Three **different** tools, not a loop over an array. check() each write exactly once. |
| `createInboxTriage` | island in the middle | `{ thread }` | fetchThread → **draftReply** (island) → archiveThread → ackInbox. Judgment sits between reads and the mutating tail. |
| `createHorizonNoise` | unique-work / hostile empty | `{ id }` | shuffled graphql/sso/sql/blob-flavoured reads (`fetchBlob`, `showDiff`, `listHosts`, `runQuery`, `grantRole`, …); nothing to mine. `check()` empty. compile 0 programs. |

## Expect (pre-registered)

| Scenario | Expect |
|---|---|
| `short-graphql` / `short-sso` | **WIN on turns** (program already live). goLive failure is FAIL, not skip-as-win. |
| `horizon-unique` | **parity ±1%** (no LOSS). Unique work must not get more expensive. |
| `long-sql` / `long-blob` / `long-inbox` / `long-webhook` | **WIN on turns**. goLive failure is FAIL. |
| `search-topk` / `saga-hold` / `k8s-poll` | **WIN on turns**. If goLive fails, the scenario **FAIL**s loudly and prints goLive notes. |

`--fast`: 13 witnesses, 3 live, `CAMPAIGN_THINK_MS=1`. Full: think 120ms, 6 live.
`--short`: already-live graphql + sso plus unique-work parity. Writes `.gauntlet/captures/compile/bench-horizon-short.txt`.

```bash
bun test benchmarks/campaign/horizon.test.ts
bun run benchmarks/campaign/bench-horizon.ts --short --fast
bun run bench:horizon-short
bun run benchmarks/campaign/bench-horizon.ts --fast
```

GraphQL items are Relay `{ node: { id, title, number } }` edges, not github-pr `{ path, sha }`. SSO `createUser.body` is a nested **object**. Search returns **10** hits and takes a **prefix of 3**. Unique-work must compile 0 programs.

## More worlds (`horizon-more-worlds.ts`)

TLS / CDN / LDAP — not github path/sha, not extra's email timezone drip.

| World | Shape | Why more |
|---|---|---|
| `createCertRenew` | foreach `{ host }` | TLS hosts, not dns-tls moonshot flags |
| `createCdnPurge` | foreach `{ path }` | Edge paths, not github files |
| `createLdapMail` | foreach `{ email }` | Directory DN groups, not CRM drip |

CI: `bun test benchmarks/campaign/horizon-more.test.ts`.

## Extra worlds (`horizon-extra-worlds.ts`)

Shapes the first nine do not cover. CI: `bun test benchmarks/campaign/horizon-extra.test.ts`.

| World | Shape | Why extra |
|---|---|---|
| `createK8sNested` | foreach-in-foreach, `patchPod.ns` from outer item | Not k8s-rollout (poll). Pods do not echo ns. |
| `createEmailDrip` | `{ email, segment, tz }` foreach | Timezone field; not CRM, not cart. |
| `createS3Restore` | `{ key, versionId, size }` foreach | versionId is not a sku. |
| `createSevTriage` | 3-way fork on `sev` | Not saga's 2-arm ok/fail. |
| `createDelta` | foreach over `except(desired, current)` | Not a full-width returned array. |
| `createDeepBill` | `org.billing.card.token` (four levels) | Not payments' two-level billing.id. |

## Measured (`--short --fast`, 2026-08-30)

Simulator turns are exact arithmetic. File: `.gauntlet/refs/01-horizon-short.txt`.

| Scenario | Turns | Wall | Cents |
|---|---|---|---|
| short-graphql (foreach live) | **5.00×** (5.0→1.0, p=0.0078 n=8) | 3.57× | **5.00×** |
| short-sso (seqLen 4 live) | **4.00×** (4.0→1.0, p=0.0078 n=8) | 3.00× | **4.00×** |
| horizon-unique | 0.0% | +0.1% (within ±1%) | 0.0% parity |

CI: `bun test benchmarks/campaign/horizon.test.ts` — graphql / sso / sql / blob / inbox / webhook + poll / saga / topk goLive PASS. Extra: nested / email / s3 / delta / deep-bill goLive PASS (`horizon-extra.test.ts`).
