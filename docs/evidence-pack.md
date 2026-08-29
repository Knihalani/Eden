# Evidence pack

Aligned, not certified.

This binder maps four controls to files an auditor can open. It is not a SOC 2 report. There is no attestation. There is no letter to request.

Isolation tests remain the shipped truth. A claim that cannot open a test does not belong here.

## Five minutes

1. Read this index.
2. Open `/pack` or `docs/isolation.md` or `/isolation`. Every claim pins a test file that exists.
3. Run `eden audit review --format jsonl` (same bytes as `GET /v1/audit/review`). Who approved what, when, which version. Wrong org is 403. Then `eden audit verify` on that file. Flip a byte — verify fails closed.
4. Run `eden audit export --format jsonl` for the full chain (approvals, versions, executions, refusals). Same verify.
5. Confirm human Approve: a composed handoff, a canary recompile, and a drift replacement all stay off until a person Approves. Nothing goes live without it.
6. Run `eden doctor`. The `net-allow` line names `EDEN_NET_ALLOW` or says empty — piped network binaries stay refused. Empty is not “all hosts.”
7. Open `docs/ROADMAP.md` §15. Grep `process.env.EDEN_`. A switch without a row is a review blocker.
8. Open `docs/zdr.md` (guidance, not a badge) and `docs/marketplace-draft.md` (unpublished; numbers from `PUBLIC_CLAIMS` only).

Landing and `/proof` stay silent on SOC 2. That is a test, not a policy footnote.

## Binder

| Control | Proves | Open |
|---|---|---|
| Isolation | Workspace tenancy, SSRF, cache keys, org binding, fleet, remainder. Each line is a fact. | `docs/isolation.md` · `/isolation` · `apps/web/app/(notes)/isolation/copy.ts` |
| Audit export | Approvals, versions, executions, refusals. sha256 chain. Verify fails closed. | `packages/cli/src/audit.ts` · `packages/cli/src/audit.test.ts` · `apps/control/src/audit-export.ts` · `apps/control/src/api.ts` (`GET /v1/audit`) |
| Access-review | Who approved what, when, which version. Tenant-bound. Tamper still fails verify. | `apps/control/src/access-review.ts` · `apps/control/src/access-review.test.ts` · `GET /v1/audit/review` · `eden audit review` |
| Human Approve | Nothing goes live without it. Canary and drift never auto-On. | `apps/control/src/handoff-approve.test.ts` · `apps/site/src/canary.test.ts` · `apps/control/src/refresh.test.ts` |
| Kill switches | Operator can refuse a behavior. Inventory is grep-verifiable `EDEN_*`. | `docs/ROADMAP.md` §15 |
| Doctor allowlist | `EDEN_NET_ALLOW` named, including empty. | `packages/cli/src/doctor.ts` · `packages/cli/src/doctor.test.ts` |
| ZDR guidance | PTC / island / prompt-cache: what Eden records vs what the provider retains. | `docs/zdr.md` |
| Marketplace draft | Unpublished. Numbers from `PUBLIC_CLAIMS` only. Customer n = 0. | `docs/marketplace-draft.md` · `packages/measure/src/listing.ts` |

Related notes: `docs/logging.md`, `docs/owasp-mcp.md`, `docs/zdr.md`. Public-pool cadence lives in `docs/isolation.md`.

### Isolation

The live table is `/isolation`. The markdown table is `docs/isolation.md`. Claims are not restated here so they cannot drift from the tests.

Pin files (each exists): `apps/site/src/tenancy.test.ts`, `apps/site/src/cache.test.ts`, `apps/site/src/ssrf.test.ts`, `apps/control/src/org-binding.test.ts`, `packages/cli/src/remainder.test.ts`, `packages/wrap/src/arming-redteam.test.ts`, `benchmarks/campaign/fleet-dedupe.test.ts`, `apps/control/src/handoff-approve.test.ts`, `apps/site/src/canary.test.ts`, `apps/control/src/refresh.test.ts`, `apps/web/app/v1/auth.test.ts`.

### Audit export

```
eden audit export --format jsonl
eden audit export --format csv
eden audit verify <file>
```

`GET /v1/audit` is the same export, key-gated. JSONL opens in jq. CSV opens in a spreadsheet.

Each record carries `sha256` of the canonical payload plus `prev`. Splicing a line or flipping a byte fails verify — fail closed. A broken export never sits on the wrap/agent path — fail open for the agent.

The on-disk SQLite store is not itself an immutable log. The export is the tamper-evident artifact.

### Human Approve

Nothing goes live without it. Auto-approve is not a product path.

| Gate | Test |
|---|---|
| A composed handoff stays off until a human Approves. | `apps/control/src/handoff-approve.test.ts` |
| A canary recompile queues a draft; it never turns the live tool On. | `apps/site/src/canary.test.ts` |
| A control-plane drift replacement never auto-approves. | `apps/control/src/refresh.test.ts` |

### Kill switches

Full inventory: `docs/ROADMAP.md` §15. Defaults are the safety posture. Grep `process.env.EDEN_` in the tree, then that table.

Named here because an auditor asks in the first five minutes:

| Switch | Default | What a flip does | Code |
|---|---|---|---|
| `EDEN_ENFORCE` | off | Hard halt/block. A broken Eden must not refuse the agent. | `packages/wrap/src/guard.ts` |
| `EDEN_TRANSPARENT=0` | on for read-only serving | Kill transparent serving within one call. | `packages/cli/src/transparent.ts` |
| `EDEN_KILL_AFTER_WARNING` | off | Post-warning spend refusal is a choice. | `packages/wrap/src/guard.ts` |
| `EDEN_FLEET` | empty | Empty shares nothing. | `packages/wrap/src/fleet.ts` |
| `EDEN_STEER_HOOKS` | off | Hook-driven steering stays opt-in. | `packages/cli/src/hook.ts` |
| `EDEN_SCHEDULE_CLOCK=0` | on | Minute clock off; ticks only on `POST /v1/schedule/tick`. | `apps/control/src/schedule-clock.ts` |
| `EDEN_WEBHOOK_SECRET` | empty | Empty refuses all cache-key drops. | `apps/site/src/webhook.ts` |
| `EDEN_NET_ALLOW` | empty | Piped network binaries stay refused. Comma list is the hatch. Doctor names it. | `packages/wrap/src/coding.ts` · `packages/cli/src/doctor.ts` |
| `EDEN_PROMPT_CACHE=0` | on | No Anthropic cache breakpoints. Does not enroll provider ZDR. | `packages/wrap/src/anthropic.ts` |

The excerpt is not the inventory. The §15 table is.

### Access-review

```
eden audit review --format jsonl
eden audit verify <file>
```

`GET /v1/audit/review` is org-gated (`x-eden-org`). Wrong org is 403. `?workspace=` that is not this workspace is 0 records. `who` is the org id or `operator` — never a person invented from the request body.

### Doctor

```
eden doctor
```

Look for `net-allow`. Empty: `EDEN_NET_ALLOW empty · piped network binaries stay refused`. Count 0. That sentence is the default, not a missing config.

### ZDR and listing

`docs/zdr.md` is guidance. Eden is not ZDR. Island memo is local; island miss calls a provider. Prompt-cache breakpoints are billing, not a retention contract.

`docs/marketplace-draft.md` is unpublished. Every multiplier is a `PUBLIC_CLAIMS` row. Customer-approved studies: 0. Determinism Index stays pruned.

## Public pool

Cadence lives in `docs/isolation.md`. Current `PUBLIC_POOL_HOSTS` host is `api.github.com` (`apps/site/src/playback.ts`). A body lands in `rcp:` only when three gates hold: host allowlist, credential-free, and GET-ok (`apps/site/src/cache.ts`). An empty list means no public pool, not all hosts.

## What this is not

- Not a SOC 2 Type I or Type II report.
- Not ISO, PCI, HIPAA, or EU AI Act certification.
- Not a sales FAQ. Landing and `/proof` do not mention SOC 2.
- Not a promise that SQLite is WORM storage.

## How this pack would be wrong

- A path in the binder does not exist.
- A control is described with no test.
- Copy on `/` or `/proof` mentions SOC 2.
- This file says certified, ready, or asks anyone to request a report.
