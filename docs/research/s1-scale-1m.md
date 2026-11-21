# S1: one tenant from 1,000 to 1,000,000 heavy users

Status: design written 2026-11-12 (S1, started by the integrator session for the owner); fixes land on
`claude/s1-*` branches, one change each, and their numbers are added to §7 as they are measured. Paid spend: $0 (no
model call, no cloud resource created, no provider API that provisions or bills was called). Machine: 4 vCPU x86-64,
15 GB. Every measured figure names its command; **[EST]** marks arithmetic on measured inputs or on assumptions;
**[CHECK 2026-11-12]** marks a price, quota or lead time read from a provider's page that day, to be checked again
before anyone buys or relies on it.

## The question

The owner's words: "work on the scaling architecture so that it can handle a customer who goes from 1k to 1m users
super fast without breaking stride". One tenant grows 10x inside a day, and 1k to 1M within weeks. Existing users see
no errors and no latency regression; new users get useful context soon after they connect.

## In plain words

1. **Memory and machines are not the hard part.** 1M heavy users at the peak hour need about 4.7 TB of RAM: 51
   Hetzner AX102-class boxes (128 GB, 19,939 users each by sizing.py) plus spares, about $10k a month, $0.010 a user.
   The cluster code (D992-D995) already places users by bucket, moves 1/(n+1) of them when a node joins, and fails a
   dead node over in about 5 s.
2. **The hard part is everything that happens per new user, at once.** A 10x day at 100k means 900k backfills. Eden's
   own CPU for that is modest (about 1.3 core-seconds a user, measured: 325 core-hours, about 14 cores for a day
   **[EST]**), but each backfill is about 30-40 listing calls on the tenant's connectors, and those connectors share
   **one quota per tenant** (the tenant's OAuth app). Gmail's is 1.2M quota units a minute per project and 6,000 per
   user **[CHECK 2026-11-12]**: a heavy user's newest 1,000 mails cost about 20,000 units, so the project can backfill
   mail for only about 86,000 users a day **[EST]**, whatever Eden does. Eden today has no tenant-wide notion of that
   quota: every process reads its users' backfills as fast as each (user, source) budget allows, a connector's 429
   only slows that one user's pair, and the kick queue is first come, first served across tenants. In a surge the
   quota is burned on page 9 of early users while later users wait for their first page, and other tenants' new users
   queue behind the big one.
3. **So the first fix is admission control for backfill:** a tenant-and-connector pace shared by every user of the
   tenant on a process (its share of a fleet-wide rate), pushed back by the connector's own 429s, with first pages
   first. A first page per source is about a tenth of a mailbox's cost and gives most of the value (the newest
   items), so under the same quota about 860,000 users a day get their newest mail **[EST]**, not 86,000. Plus a
   kick queue that takes tenants in turn.
4. **The second is restarts and moves.** A full box writes only about 23% of its users inside its shutdown budget
   (D1075); the rest re-sync, a backfill each, on the same connector quota. At fleet scale a rolling upgrade of 51
   boxes would re-backfill most users. The fix is to make the drain's write cheap enough to cover every user (measure
   where the 26 ms a user goes first), and in a cluster to hand users over by the store, not by re-sync.
5. **The third is the fleet's own plumbing:** a burst tier that comes up in minutes (Hetzner's dedicated boxes take
   minutes to weeks and its cloud line showed every CCX type "currently unavailable" today), autoscaling driven by
   `/metrics` with a dry-run planner, a store split over several buckets (Hetzner Object Storage allows 750
   requests a second per bucket **[CHECK 2026-11-12]**, which a 1M fleet's peak and any large rebalance exceed), and
   alerts for fleet SLOs and per-tenant fairness.
6. **With a model key, the bill and the provider's rate limit dominate, not the hosting.** The push check alone is
   about 48M calls a day at 1M users (about 560 a second on average, 34,000 a minute **[EST]**), above any single
   account's requests-per-minute limit we could find, and about $11-13k a day. Every role fails open to the no-model
   path today, so users see no errors, but nothing slows the calls down: each one is sent, refused and counted. The
   default tenant cap ($25 a day) would also stop card backfill after about 3,000 users' worth. Both need an explicit
   decision (the owner is replacing paid roles with $0 CPU models; until then a 1M tenant runs without a key or on a
   negotiated provider limit).

## 1. What exists and what it measured

| Piece | Where | Measured |
| --- | --- | --- |
| Users per box | `deploy/scripts/sizing.py`, DEPLOY.md §6 | 4.71 MB a heavy user at the peak hour (the soak: 4.51 on the mean, peaks ~22% above, D1075); 8.43 MB with a model key's card state |
| Backfill CPU | `users.bench.ts`, d1-scale-out.md §1 | 431 µs an item, 1,294 s for 1,000 users (1.29 core-s a user); the soak backfilled 1,500 users in 10.9 min on 2 cores |
| Backfill calls | `restart.bench.ts` | 6,000 listing calls for 200 users (30 a user, 20 connectors, page 100) |
| Kick admission | `sync.ts` `KICKS_AT_ONCE` (D753) | 4 kicked users a process at once (32 lanes each), FIFO across tenants; ticks 16 users in batches of 8 |
| Connector guards | `sources/guarded.ts` | per (user, source): GCRA 5/s burst 10, AIMD concurrency 1-4, breaker; a 429 pushes back that pair only |
| Sync budget | `sync.ts` `syncCallsPerMin` | per (user, source); nothing per tenant or per connector across users |
| Restart | D1075, D1076 | 169-179 of 750 users a process written in 4.5 s (~26 ms a user); the rest re-sync |
| Release / move | `bench/release.bench.ts`, d1-scale-out.md §3 | 7-14 ms a user released (live ~30 ms), a new owner's fetch and warm thaw ~50 ms |
| Cluster router | `cluster.ts` | one process, +0.05-0.1 ms p50; placement table ~1 ms a node to rebuild; 60 s release bound |
| Model calls | `models.ts`, `llm/openrouter.ts` | a 429 throws, the role fails open (D41); no shared backoff in the servers (the lab's `Pacer` has one) |

## 2. Where it breaks between 1k and 1M (verified in the code; numbers as labelled)

| # | Pressure point | At what scale | Evidence | Severity |
| --- | --- | --- | --- | --- |
| B1 | **Connector quota per tenant** is shared by all its users; Eden paces per (user, source) only. A surge spends it on deep pages; 429s hit random users; no first-page priority | 10k+ new users a day on Gmail-like quotas | §3 below; `guarded.ts` keys by user | **Critical**: new users wait hours to days for first value |
| B2 | **Kick queue is FIFO across tenants**: one tenant's surge delays every other tenant's new users on the process | any surge on a shared fleet | `sync.ts` `kickQueue.shift()` | High (fairness) |
| B3 | **Restart keeps 23% of a full box's users**; the rest re-backfill on the tenant's quota | every upgrade or crash once boxes are full | D1075 | High: a rolling upgrade of the fleet costs a fleet-wide backfill |
| B4 | **No backfill or quota signals in `/metrics`**: users backfilling, kick queue, time to first value, connector 429s are invisible; nothing for an autoscaler or an SLO | from the first surge | `ops.ts` | High |
| B5 | **Provisioning lead time**: dedicated boxes minutes to weeks; Hetzner Cloud CCX "currently unavailable" | 10x in a day | §4 | High |
| B6 | **Store request rate**: one bucket, 750 req/s at Hetzner; a 1M fleet's freezes, fetches and deletes reach hundreds a second at the peak, and a rebalance moving 46% of users writes 460k blobs in its 60 s bound | 300k+ users, or any large scale-out | §5 | High at 1M |
| B7 | **Rebalance size**: adding k nodes to n moves k/(n+k) of users; doubling moves half. Each move loses sessions, the not-twice ledger, SourceYield and (with a key) cards | big scale-out steps | D992 | Medium: plan steps, never double at peak |
| B8 | **Model calls**: provider RPM, the $25 tenant-day cap divided by N x M, 429s hammered with no backoff | with a key, past ~10k users | §6 | High cost, no user-visible error (fails open) |
| B9 | **Cluster router**: one process; ~12k HTTP requests a second at 1M users' peak **[EST]** from the soak's 0.0124 a user a second | 500k+ | soak request rate | Medium: run several behind the LB (stateless) |
| B10 | **Blast radius**: one cluster, one store, one router pair; a bad config or store outage reaches every user | 100k+ | D992 | Medium: cells |
| B11 | **Monitoring**: 51+ nodes x ~300 series passes Grafana Cloud's free 10k | ~30 nodes | DEPLOY.md §8 | Low (cost) |

### 3. The connector arithmetic (B1)

Gmail **[CHECK 2026-11-12]** (developers.google.com/workspace/gmail/api/reference/quota): 1,200,000 quota units a
minute per project, 6,000 a minute per user per project; `messages.list` 5 units, `messages.get` 20 (60 for the full
or raw format), `history.list` 2. Microsoft Graph's Outlook limit is 10,000 requests per 10 minutes per app and
mailbox, 4 concurrent requests per mailbox (Microsoft's throttling page and its 2020 announcement, read through
secondary sources the same day: **[CHECK]**).

A connector that lists 100 messages and reads each one's metadata spends about 5 + 100 x 20 = 2,005 units a page
**[EST]**: the MCP server's shape decides it, not Eden. A heavy user's mail at a third of the 3,000-item cap is 10
such pages, about 20,000 units **[EST]**.

| | Units | Per-user floor (6,000/min) | Users a day at 1.2M/min (one project) |
| --- | --- | --- | --- |
| Full mail backfill (10 pages) | ~20,000 | 3.3 min | ~86,000 |
| First page only (newest 100) | ~2,005 | 20 s | ~860,000 |

**[EST]** throughout. A 10x day at 100k (900k new users) cannot backfill everyone's mail in a day under one Gmail
project, at any Eden speed; it can give nearly all of them their newest 100 mails if first pages go first. Steady
state matters too: 1M users at ~15 Gmail calls a day each, about 200 units a call **[EST]**, is ~3B units a day
against the project's ~1.7B: a 1M tenant needs a quota increase from Google or change notifications (Gmail push to
Pub/Sub, then `history.list` at 2 units), which Eden already consumes (`syncPush`, notifying sources).

What Eden can do: (a) never spend more than the tenant's quota (pace to it, and back off as a tenant when the
connector says 429, not per user); (b) spend it in value order: a new user's first page per source, then on-demand
polls of active users, then background polls, then deeper backfill pages, then sweeps; (c) keep tenants apart.

## 4. Provisioning: a burst tier beside the dedicated base (B5)

| Tier | What | Lead time | Price | API |
| --- | --- | --- | --- | --- |
| Base | Hetzner dedicated AX102 (16c, 128 GB) | "a few minutes" to "10-12 working days" by configuration and site; "several weeks" for AX102-1 in Finland on 7 July (Hetzner's order-processing page, updated weekly) **[CHECK 2026-11-12]** | €159/month + €129 setup ($177) **[CHECK]** (d1-providers.md, 2026-11-11) | Robot web service orders; no Terraform provider (DEPLOY.md §2) |
| Base, large | AX162 (48c, 512 GB: 80,223 users by sizing.py) | as above | €614 + €304 setup **[CHECK]** | as above |
| Burst A (EU and US) | Oracle A1.Flex 16 OCPU / 128 GB | minutes when capacity exists; A1 "out of host capacity" is widely reported **[unverified]**; E4/E5 Flex as fallback | ~$257/month, ~$0.35/hour **[EST from d1-providers.md's per-OCPU and per-GB list prices, CHECK]** | OCI Compute `LaunchInstance`; `deploy/tofu/oci` |
| Burst B (anywhere) | AWS EC2 r7g.4xlarge (16 vCPU, 128 GB, arm64: the image runs on arm64, D990) | minutes; needs the region's on-demand vCPU quota raised beforehand | $0.8568/hour in us-east-1 (~$625/month) **[CHECK 2026-11-12]** (holori, DoiT) | EC2 `RunInstances`; a new tofu module (plan only) |
| Not usable today | Hetzner Cloud CCX53/63 (32-48 vCPU, 128-192 GB, €0.73-1.16/hour HEL1) | every CCX type "currently unavailable" on hetzner.com, 2026-11-12 **[CHECK]** | | `deploy/tofu/hetzner` |

The plan: the base is sized for the tenant's contracted users plus one spare per cell; a surge lands on burst nodes
(they join the cluster like any node; users move 1/(n+1) at a time); dedicated boxes are ordered the same day; when
they arrive the burst nodes leave the planned way (release to the store, then destroy). The path down is the same:
remove a node's line, wait for its release, destroy. A burst node is ready in boot time plus the image: today the
image is built on the box (`docker compose up --build`), minutes of `bun install`; for burst the image must be prebuilt
into the provider's machine image (an OCI custom image or an AMI from the same Dockerfile), never pulled from a
public registry of ours (nothing is published, per the brief). Pre-arrange before a launch: provider accounts on a paid
tier, quota raised for 50+ nodes' worth of vCPU in two regions, the machine image built, a tested tofu plan.

**Autoscaling** reads `/metrics` (§8 below lists the series) and decides, with hysteresis, a node count: up when
memory per node passes 75% at the peak, or users waiting for their first page pass a bound for 10 minutes, or the
p99 SLO is burning; down only after a day under 50% and never during the tenant's peak hours. It changes the count
through tofu (`node_count`) and the nodes file, never through a provider call of its own; S1 builds it as a planner
that prints the plan (dry run).

## 5. The store and persistence at 1M users (B3, B6)

- **Objects:** one blob a persisted user: ~1M objects, ~2.7 TB at the ~2.7 MB a heavy user DEPLOY.md §6 cites
  **[EST]**; under Hetzner's 50M objects and 100 TB a bucket **[CHECK]**.
- **Requests:** compact freezes and releases write 5-10 a heavy user a day (COST-MODEL.md's **[EST]**): 58-116 PUTs a
  second on the day's average, several hundred at the peak, plus a GET for every user a node does not hold. Hetzner
  allows 750 requests a second per bucket and per source IP **[CHECK]**: the 1M peak sits near it, and a rebalance
  that moves 46% of users (adding 44 nodes to 51) writes ~460k blobs, about 10 minutes at 750 a second, against the
  router's 60 s release bound. **Fix: shard blobs over K buckets by user bucket** (K = 8 gives 6,000 a second),
  and scale out in steps that move at most ~10% of users each.
- **Cost of requests elsewhere:** Cloudflare R2 $4.50 a million writes, $0.36 a million reads **[CHECK 2026-11-12]**:
  1M users x 7.5 writes a day is ~$1,000 a month; Hetzner and OVH charge no request fees.
- **Restarts and rolling deploys:** a cluster's rolling upgrade (`rolling-upgrade.sh`) takes a node out (its users
  are released to the others through the store: warm, no re-sync) and puts it back (they move again). That works, at
  two moves a user per upgrade; a node restarted in place instead writes only what its grace allows (D1075) and
  re-syncs the rest. The fix is the drain itself: write every user, warm, inside the budget (§7 P3 measures where the
  26 ms goes), so an in-place restart keeps everyone, and a node's upgrade costs one restart, not two moves.

## 6. Model-call bursts (B8)

With `OPENROUTER_API_KEY` set, per heavy user: card and intent backfill about 7 calls and $0.0074-0.0080 (D1054); the
push check on about 0.97 of requests at $0.00023-0.00026 a call (COST-MODEL.md). At 1M users and 50 requests a day
**[EST]**: 48.5M check calls a day (~560 a second on average, 34,000 a minute), $11-13k a day; a 900k-user surge adds
6.3M card calls and ~$7k. Provider limits read today for Haiku-class models run 4,000-10,000 RPM a tier
**[CHECK 2026-11-12; sources disagree]**: the check alone is 3-8x over on the average, more at the peak.

Today every role fails open (D41: the no-model path, no error to the agent), so users see no errors. But: (a) every
call is still sent after the provider starts refusing, with no backoff shared across a process's users (the lab's
`Pacer` has one; the servers do not use it); (b) the default tenant cap ($25 a UTC day, divided by processes and
machines) runs out after about 3,000 users' card backfill, after which new users get no cards for the rest of the day.
Recommendations (the parent's call, not built here unless asked): a process-wide 429 backoff for each model role
(fail open at once while held, no call sent); the tenant's cap set from the contract (cards ~$0.008 a new user, check
~$0.012 a user-day **[EST]**); and the owner's plan of $0 CPU models in every role before a key-on tenant passes ~10k.

## 7. The plan, in priority order

| # | Change | Fixes | Branch | Status |
| --- | --- | --- | --- | --- |
| P1 | **Backfill admission**: a pace per (tenant, connector) shared by the tenant's users on a process, its rate the operator's fleet-wide figure divided by processes and machines (as D993 divides caps), pushed back by the connector's 429s for the whole tenant; background reads in value order (a user's first page per source first, then polls, deeper backfill, sweeps; a lookup's own poll and search are never held); the kick queue takes tenants in turn | B1, B2 | `claude/s1-admission` | building |
| P2 | **Backfill and fairness metrics**: users backfilling and waiting for a first page, kick queue length, time to first value (first event to first stored page) histogram, listing calls and 429s by priority, pace waits; alerts on them | B4 | `devin/eden-sync-metrics` | **shipped** (PR pending merge) |
| P3 | **A drain that writes everyone**: profile `flush` (the 26 ms a user), make it cheap enough for a full box inside the grace, measured with the soak's restart (D1076's rule: users whose first request after the restart finds their state) | B3 | `devin/eden-drain-lean` | **shipped** (D2041: recency order + lean "EDF3" blob; ~5.5 ms a user at 1,500 items) |
| P4 | **Store sharded over buckets** (`EDEN_PERSIST_STORE` naming several; a user's bucket picks one) | B6 | `claude/s1-fleet` | next |
| P5 | **Autoscale planner** (dry run): `/metrics` from every node to a node count and a tofu/nodes-file plan, with hysteresis and peak-hour guard; burst-tier tofu (OCI exists; AWS module plan-only) | B5 | `claude/s1-fleet` | next |
| P6 | **Scale-out in steps**: the planner never moves more than ~10% of users in one membership change; the router's release bound scaled to users moved | B7 | with P5 | next |
| P7 | Cluster router redundancy: several router processes behind the LB (stateless, same placement), measured throughput | B9 | with P5 | design |
| P8 | Cells: ~10-20 nodes, their own routers, store buckets and alert scope; a tenant above one cell spread over cells by bucket range, a static top table | B10 | design only | design |
| P9 | Model roles: a process-wide 429 backoff, contract-sized tenant cap | B8 | the parent's call | recommend |
| P10 | Monitoring at fleet scale: recording rules per cell, paid tier or self-hosted Prometheus | B11 | docs | design |

**Pre-registered for P1 (before any run):** in the surge harness (§9), with a connector quota per tenant that refuses
past its rate (429), P1 ships if, against main: users given their first page of every source within 5 minutes of
connecting rise at least 2x, connector 429s fall at least 5x, existing users' user-message p99 is no worse than +10%,
errors 0; and `bun run eval` and the funnel are unchanged (it changes no scoring or delivery). Its pace is configured
(an operator's setting, off when unset), so with no setting nothing changes.

## 8. Fleet SLOs and alerts (B4, B10)

| SLO | Target | Alert |
| --- | --- | --- |
| Existing users: user message p99 | <= 50 ms, 99.9% of 5-min windows | burn rate 14x over 1 h, 6x over 6 h |
| Errors (5xx except the rebalance's 503s for moving users) | < 0.1% | over 1% for 5 min |
| New users: time to first value (first page of every source stored) | p90 <= 5 min while the tenant's quota allows | p90 over 15 min for 15 min, with the quota pace not the cause |
| Backfill backlog | users waiting for a first page | rising for 30 min |
| Connector quota | tenant 429s / listing calls | over 5% for 10 min (pace too high) |
| Capacity | RSS per node | 75% at the peak: plan; 85%: scale now |
| Per-tenant fairness | a tenant's share of a process's kick slots while others wait | one tenant above 1/T of slots while others queue |

## 9. The lab (S1)

- `packages/sim/src/lab/surge.ts`: several processes in a cgroup (machines simulated as processes, d1-scale-out.md
  §6), existing users at a steady rate, then 10x new users connecting over minutes; connectors with a per-tenant quota
  (a shared token bucket across processes that answers 429 past it) and latency. Reports errors, p50/p99 for events and
  asks, time to first value, connector calls and 429s a second.
- A node join and a leave under load: `cluster.bench.ts` grown to full-size users, or the surge harness behind the
  cluster router.
- A rolling restart: the soak's restart (D1075's shape) before and after P3.

## 10. Cost for one tenant (heavy users, no model key unless said)

Ours a month (machines sized at 4.71 MB a user with one spare per cell; prices from d1-providers.md 2026-11-11 and the
checks above; **[EST]** wherever the count of things is ours and not a measurement):

| | 1,000 | 10,000 | 100,000 | 1,000,000 |
| --- | --- | --- | --- | --- |
| Base machines | 1 AX41 64 GB ($66) | 3 AX41 ($197) | 7 AX102 ($1,238) | 56 AX102: 51 + 5 spares, one a cell ($9,912) **[EST]**; or 14 AX162 ($9,565, 80k users a node: a larger blast radius) |
| Setup fees (one time) | €0 | €0 | €903 | €7,224 **[EST]** |
| Burst during a 10x day (until dedicated arrives) | none | 2 A1 128 GB for ~1 week (~$120) **[EST]** | 44 A1-class nodes for ~10 days (~$3,700) or r7g.4xlarge (~$9,000) **[EST]** | n/a (reached by then) |
| Store | $7 | $7 | $7 | ~$20 (2.7 TB, 8 buckets, no request fees at Hetzner) **[EST]**; R2 instead ~$1,040 (writes) + $40 storage |
| LB / routers | Caddy | LB11 $8 | LB11 $8 | 2 LBs + 4 router processes on nodes, ~$40 **[EST]** |
| Monitoring | free | free | free | paid tier or self-hosted, ~$50-300 **[EST]** |
| **Total a month (steady)** | **$73** | **$213** | **$1,254** | **~$10,000-10,300** **[EST]** |
| **Per heavy user-month** | $0.073 | $0.021 | $0.0125 | **~$0.010** **[EST]** |
| With a model key (Haiku 5.5, today's roles) | +$360-410 | +$3.6-4.1k | +$36-41k | **+$360-410k**, and 90 AX102 for card state (8.43 MB a user): +$6k **[EST]** |

The tenant's a month **[EST]** (COST-MODEL.md (b): 300-1,200 connector calls a user-month with Eden):

| | 1,000 | 10,000 | 100,000 | 1,000,000 |
| --- | --- | --- | --- | --- |
| Connector calls (millions) | 0.3-1.2 | 3-12 | 30-120 | 300-1,200 |
| First-party APIs | $0 (quota) | $0 | $0; Gmail quota increase likely needed | $0; a quota increase or push notifications **required** (§3) |
| Composio ($0.30 / 1,000) | $90-360 | $0.9-3.6k | $9-36k | $90-360k |
| One-time backfill calls (30-40 a user) | 30-40k | 0.3-0.4M | 3-4M | 30-40M (~$9-12k at Composio) |

## Sources (read 2026-11-12)

- Gmail quotas: https://developers.google.com/workspace/gmail/api/reference/quota
- Microsoft Graph throttling: https://learn.microsoft.com/en-us/graph/throttling-limits (via secondary summaries)
- Hetzner Cloud CCX prices and availability: https://www.hetzner.com/cloud/general-purpose
- Hetzner dedicated order processing: https://docs.hetzner.com/general/infrastructure-and-availability/order-processing
- Hetzner Object Storage limits: https://docs.hetzner.com/storage/object-storage/overview
- AWS r7g.4xlarge: https://calculator.holori.com/aws/ec2/r7g.4xlarge/us-east-1
- Cloudflare R2: https://developers.cloudflare.com/r2/pricing
- Anthropic rate limits: https://docs.anthropic.com/en/api/rate-limits (tier tables disagree between sources)
