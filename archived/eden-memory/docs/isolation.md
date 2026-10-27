# Isolation

> **Compile era: a retired product direction.** Eden is now passive memory for coding agents ([docs/README.md](README.md)). This file stays in `docs/` because the website's `/isolation` page and its tests refer to it by path; the other compile-era documents are in [archived/compile-era/](../archived/compile-era/README.md).

Each line is a fact we can open a test for. Nothing here is a badge. This is not a SOC 2 report and not an EU AI Act certification.

The live page is `/isolation`. Graphite only.

## Published limits

Pins, not reversals. Kind and Source sit on the same row as the meter. Analogue and retired are not the same class as wrap-path. The live board is `/proof` and `eden claims`.

analogue — headless replica, not a live invoice. limit — wrap-path, host, envelope miss, cert bounds. retired — withdrawn until a file parses.

### Limits

Wrap-path loss, host limit, envelope miss, certification bounds. Not analogue cents. Not a retired invoice. JIT soak PASS lives with the wins.

| Name | Kind | Source | Printed | File |
|---|---|---|---|---|
| oblivious-long | limit | campaign | `+2.8% cents / +3.2% wall` | `benchmarks/campaign/OBLIVIOUS-LONG.md` |
| replica host-drop | limit | host-limit | `host limit (replica-only)` | `benchmarks/campaign/HOST-DROP.md` |
| ood-long | limit | campaign | `parity (miss)` | `benchmarks/campaign/bench-campaign.ts` |
| certification bounds | limit | campaign | `11/14 soak certified` | `benchmarks/campaign/WITNESS-ECON.md` |

### Analogue

Headless replica TURN_CENTS. Labeled analogue. Not a live Claude Code invoice.

| Name | Kind | Source | Printed | File |
|---|---|---|---|---|
| S1b headless analogue | analogue | analogue-headless | `−9.1% cents (analogue)` | `benchmarks/campaign/SILENT-DROP.md` |

### Retired

Withdrawn until a file parses. Retired is a result.

| Name | Kind | Source | Printed | File |
|---|---|---|---|---|
| S1b live Claude Code invoice | retired | retired | `retired` | `benchmarks/campaign/LIVE-AB.md` |

## What we can prove

| Claim | Test |
|---|---|
| Two workspaces that record the same public-API sequence keep their own cluster rows. | `apps/site/src/tenancy.test.ts` |
| One workspace’s ingest cannot reset another workspace’s stretch count. | `apps/site/src/tenancy.test.ts` |
| Crossing the knock threshold creates exactly one knock, for the workspace that crossed it. | `apps/site/src/tenancy.test.ts` |
| Compiled tools stay scoped to the workspace that recorded them. | `apps/site/src/tenancy.test.ts` |
| Event ids chosen by one workspace cannot swallow another workspace’s events. | `apps/site/src/tenancy.test.ts` |
| An approved tool’s steps stay frozen; a later ingest cannot rewrite them. | `apps/site/src/tenancy.test.ts` |
| State-changing routes refuse a POST from another origin. | `apps/site/src/tenancy.test.ts` |
| A deployment with DATABASE_URL does not hand out the public dev credential. | `apps/site/src/tenancy.test.ts` |
| A disabled API-key row stays disabled across boots. | `apps/site/src/tenancy.test.ts` |
| Eden does not synthesise requests to a host it was only shown. | `apps/site/src/tenancy.test.ts` |
| Result-cache keys include the workspace, so workspace B cannot read workspace A’s cached body. | `apps/site/src/cache.test.ts` |
| Public-pool keys (`rcp:`) differ from tenant keys (`rc:`) and ignore the workspace id. | `apps/site/src/cache.test.ts` |
| Loopback, private, and cloud-metadata hosts are blocked for egress. | `apps/site/src/ssrf.test.ts` |
| A redirect into the private network is refused; the internal hop is never issued. | `apps/site/src/ssrf.test.ts` |
| Authorization is dropped when a redirect changes origin. | `apps/site/src/ssrf.test.ts` |
| Egress connects to the pinned address while Host stays the hostname. | `apps/site/src/ssrf.test.ts` |
| A Clerk org that does not bind this workspace cannot approve, pause, or run its tools. | `apps/control/src/org-binding.test.ts` |
| A second org cannot claim a workspace that is already bound. | `apps/control/src/org-binding.test.ts` |
| Session A’s remainder does not deny session B’s same-named tool on the same entity. | `packages/cli/src/remainder.test.ts` |
| Hostile session keys (`__proto__`, empty, long) stay isolated in the arming store. | `packages/wrap/src/arming-redteam.test.ts` |
| Read-only fleet claims require an explicit `fleetId`; empty fleet shares nothing. | `benchmarks/campaign/fleet-dedupe.test.ts` |
| Mutating tools on the same fleet still write once per session. | `benchmarks/campaign/fleet-dedupe.test.ts` |
| Hostile fleet keys (`__proto__`, empty, long) stay Map keys. | `packages/wrap/src/arming-redteam.test.ts` |
| A composed handoff stays off until a human Approves. | `apps/control/src/handoff-approve.test.ts` |
| A canary recompile queues a draft; it never turns the live tool On. | `apps/site/src/canary.test.ts` |
| A control-plane drift replacement never auto-approves; the live tool stays live until a human Approves. | `apps/control/src/refresh.test.ts` |
| On a managed install, the `/v1` bearer gate refuses the public `eden_dev` credential. | `apps/web/app/v1/auth.test.ts` |

## Evidence pack

The auditor index is [evidence-pack.md](evidence-pack.md). Live binder: `/pack`. Aligned, not certified. Isolation tests remain the shipped truth.

## Public pool allowlist — review cadence

`PUBLIC_POOL_HOSTS` in `apps/site/src/playback.ts` is the host gate for shared `rcp:` result-cache keys. A response lands in the public pool only when all three hold:

1. Host allowlist — `isPublicPoolCandidate` (`PUBLIC_POOL_HOSTS`).
2. Credential-free — the request carries no `Authorization`.
3. GET-ok — non-GET is never stored (`apps/site/src/cache.ts`).

Credential-free alone is not enough. An internal no-auth API still serves per-tenant bytes.

**Current host:** `api.github.com`.

**When the list is reviewed:** on every change to that `Set`, in the same PR as the host. Adding a host must show that unauthenticated GET bodies are byte-identical for every caller. Removing a host is the same PR bar in reverse. Re-read the set before expanding it. An empty list means no public pool, not all hosts.

Related: [evidence pack](evidence-pack.md), [ZDR guidance](zdr.md), [logging](logging.md), [OWASP MCP Top 10](owasp-mcp.md).
