# Deploying Eden

A kit, not a deployment: everything here was built and checked locally on 2026-11-11; nothing was ordered, signed up
for, applied or published. Numbers come from commands run that day (docs/research/d1-scale-out.md has the raw
figures and the commands); prices come from docs/research/d1-providers.md, re-read 2026-11-12 in
docs/research/hosting-2026-11.md (which also sizes a pilot, 10k and 1M users), and **must be checked at signup**.

## 0. In plain words

- **Run it on one box first.** One machine with Docker, Eden behind Caddy (TLS), idle users persisted encrypted on
  its disk (D991). The image builds and runs on amd64 and arm64 (D990). It runs on Bun's distroless image (D1600):
  no shell inside, so `docker exec <container> bun …` works and `docker exec <container> sh` does not.
- **Users are bound by memory.** About 2-3.4 MB of RAM per user at the 3,000-item cap, measured. A heavy user
  (a daily agent, about 50 requests a day, 20 connectors) at the peak hour needs the most; plan with §6.
- **Where:** Hetzner dedicated servers are the cheapest RAM you can order (about $1.0-1.4 per GB-month at the low
  end of each model's range, EU only, an hourly rate up to the monthly price on its pages, plus a setup fee); paid A1
  on Oracle (ARM, about $1.10 per GB plus $7.30 per core, EU and US, hourly) is the fallback and the free start.
  Every Hetzner cloud line (CX, CAX, CPX, CCX) read "currently unavailable" on 2026-11-12.
- **Free to start:** Oracle Always Free A1 (2 OCPU / 12 GB in 2026; 4 / 24 on accounts that still have it) holds
  about 1,600 heavy users at their peak hour (2,600 if a quarter are active at once), by the measured RSS. Its risks are real (§2.1): use it for a pilot,
  not for paying tenants.
- **Grow vertically, then out.** One bigger box until about 64-128 GB; then the cluster (§9): several machines
  behind the cluster router, sharing an S3-compatible store, users placed by a hash so adding a machine moves a
  quarter of them (measured), with no downtime for anyone else.
- **Upgrades:** a restart of one box drains and comes back in about 1.2 s; Caddy holds requests meanwhile. Measured:
  842 requests across a restart, 0 errors, the longest held 6.1 s (§11).

## 1. What runs

| Piece | Where | State |
| --- | --- | --- |
| Eden (`packages/server/src/main.ts`) | one container; a router over `EDEN_PROCESSES` children, one per core | users in memory; `/data` (EDEN_HOME): the source map (entity names and counts, D8) and the persisted users (encrypted, D991) |
| Caddy | the same box, 80/443 | its certificates (`caddy-data`) |
| Cluster router (§9 only) | one or two small boxes | none (it reads the nodes file) |
| Shared store (§9 only) | S3-compatible bucket | each user's last written blob, encrypted, at most 7 days |

Ports: Eden 8790 (loopback or the private network only; on a node, a DOCKER-USER rule drops 8790 from outside the
private range, since Docker's published ports bypass ufw, D1702), Caddy 80/443. Routes beyond the API: `/healthz`
(liveness), `/readyz` (readiness, 503 while draining), `/metrics` (Prometheus text, counts only), `/internal/cluster`
(the cluster router's membership, `EDEN_CLUSTER_KEY`). Caddy serves neither `/metrics` nor `/internal/*`.

## 2. One box, step by step

Any Ubuntu 24.04 machine with 2+ cores and 8+ GB. Every machine is set up by one cloud-init file
(`deploy/cloud-init/eden.yaml.tftpl`), however it is created:

| Host | Role in the plan | How the machine is made |
| --- | --- | --- |
| **Hetzner dedicated (AX41/AX42, AX102 class)** | **Primary**: the cheapest RAM you can order (2026-11-12: AX41 64 GB €59, no setup fee, $1.02 per GB-month; AX42 64 GB €79-99 + €49 setup; AX102 128 GB €159-259 + €129; AX162 512 GB €614 + €304, $1.33/GB; AX42-1 and AX102-1 take "several weeks" in Germany), unmetered traffic, Hetzner Object Storage with no request fees for the cluster's store | Order in the Robot console (setup fee, billed hourly up to the monthly price, EU only: FSN1, HEL1), `installimage` Ubuntu 24.04, then `DEPLOY_KEY=<key> deploy/scripts/bootstrap-dedicated.sh root@<ip> <role> <ref> git@github.com:Knihalani/Eden.git <admin cidr>`: it installs the read-only deploy key, renders the cloud-init (`render-cloud-init.py`) and runs it with cloud-init's NoCloud source over SSH. No Terraform provider exists for dedicated servers |
| **Oracle Cloud A1.Flex** | **Fallback**: the cheapest RAM rented by the hour ($1.10 per GB plus $7.30 a core), EU and US regions (Hetzner dedicated is EU only), ARM verified here (D990), a free tier for the pilot; E4 (x86) when A1 is short | `deploy/tofu/oci` (A1.Flex, the VCN, the security list, the same cloud-init as user data) |
| OVHcloud | Second fallback if both fail on stock: public cloud r3 €3.02 per GB-month hourly ($3.35); its dedicated KS, SYS and Rise lines list €0.28-0.97 per GB with no setup fee but most 128-256 GB configurations were unavailable on 2026-11-12; free object-storage requests | by hand, with the rendered cloud-init as user data |
| Hetzner Cloud | Routers and the load balancer of a cluster (small, hourly), and Eden machines when its stock returns (no type was orderable on 2026-11-12: put the routers on the nodes or on a dedicated box) | `deploy/tofu/hetzner` |

Why not OVH as the first fallback: Oracle's RAM is a third of OVH's cloud price and hourly, and it adds US regions;
OVH's dedicated servers are cheaper still but rarely in stock; its other advantage, free store requests, matters only
at 100k users on a per-request store (docs/COST-MODEL.md, "Hosting").

1. **DNS.** An A (and AAAA) record for your Eden name (say `eden.example.com`) pointing at the box.
2. **Machine.** A dedicated server: `bootstrap-dedicated.sh` as above. A cloud one: `cd deploy/tofu/oci` (or
   `hetzner`), `cp terraform.tfvars.example terraform.tfvars` (edit; credentials stay in your environment or
   `~/.oci/config`), `tofu init && tofu plan && tofu apply`. Cloud-init installs Docker (Ubuntu's archive),
   opens 22 (your admin range), 80 and 443, enables unattended security upgrades, clones Eden at `eden_ref` into
   `/opt/eden`, and installs `eden.service` and the daily backup timer. It holds no secret.

   **Cloning a private repository.** A public clone URL needs no credential. If your Eden repository is private
   (a fork or mirror), an anonymous `git clone` fails and each server
   uses a read-only GitHub deploy key: make one with `ssh-keygen -t ed25519 -N '' -C eden-deploy -f
   secrets/eden_deploy` (no passphrase: the clone runs unattended) and add `secrets/eden_deploy.pub` under the
   repository's Settings → Deploy keys with write access off. `DEPLOY_KEY=secrets/eden_deploy
   bootstrap-dedicated.sh … git@github.com:Knihalani/Eden.git …` copies the private key over SSH to
   `/root/.ssh/eden_deploy` (0600), puts a `Host github.com` entry (`IdentityFile`, `IdentitiesOnly yes`) first in
   `/root/.ssh/config`, and adds github.com's ed25519 host key to `/root/.ssh/known_hosts` after `ssh-keyscan` on the
   server and a check against GitHub's published fingerprint; then the cloud-init clones over SSH, and every later
   `upgrade.sh` fetches the same way. The key never goes into user data, which the provider keeps and any process on
   the box can read through the metadata service, so a machine made with `deploy/tofu/*` boots without it and its
   clone fails: after `tofu apply`, run `bootstrap-dedicated.sh` with `DEPLOY_KEY` on each machine (it runs the same
   cloud-init again, now with the key; set `eden_git_url` to the SSH URL before `tofu apply`, since a rerun on a machine
   that booted from the provider's datasource may read the provider's user data again, unverified on a real machine),
   or set `eden_git_url` to a public mirror. Without `DEPLOY_KEY` the script
   installs nothing, as before. A box first cloned over HTTPS moves to the key with the bootstrap step's key install
   and `git -C /opt/eden remote set-url origin git@github.com:Knihalani/Eden.git`.
3. **Secrets** (§4). On your machine: `cp deploy/compose/single/.env.example secrets/single.env`, fill it in, then
   `deploy/scripts/push-secrets.sh root@<ip> single secrets/single.env`: the file goes over SSH (mode 600) and Eden
   starts (`docker compose up -d --build`: the image is built on the box; nothing is pulled from a registry of ours).
4. **Check.** `EDEN_API_KEY=<a tenant key> bun deploy/scripts/cluster-smoke.ts https://eden.example.com` (readiness,
   30 events, metrics). `docker compose logs eden | grep listening` shows `frozen users persisted, encrypted`.
5. **Monitoring and uptime** (§8), **backups** (§7).

The container runs as user `bun`, restarts unless stopped (`restart: unless-stopped`; `eden.service` brings the
project up at boot), keeps 5 x 20 MB of logs per container (`json-file`), and gets 40 s to stop (`stop_grace_period`,
above Eden's 5 s drain delay and 15 s grace, D994). Its health check reads `/readyz`.

### 2.1 Oracle Cloud Always Free (A1, ARM64)

The allowance fell in 2026 from 4 OCPU / 24 GB to 2 OCPU / 12 GB (1,500 OCPU-hours and 9,000 GB-hours a month;
Oracle's docs, read 2026-11-11; the date is disputed: 15 June or 18 August 2026). Write for 2 / 12; an account that
still has 4 / 24 doubles the figures in §6.

1. Create an A1.Flex instance, Ubuntu 24.04 aarch64, 2 OCPU, 12 GB, a 100-200 GB boot volume (the free block
   storage is 200 GB in all). Paste the rendered cloud-init (role `single`) as user data. Open 80 and 443 in the
   VCN's security list as well as in ufw (Oracle's images also ship iptables rules: allow 80/443 there).
2. Steps 3-5 above. `EDEN_PROCESSES=2`. The image builds natively on arm64 (verified under QEMU, D990).

**Risks, plainly:**

- **Idle reclamation.** Oracle may reclaim an Always Free instance idle for 7 days (CPU, network and, for A1, memory
  all under 20% at the 95th percentile, per its docs). An Eden box with users is not idle by memory; an empty one is.
- **Capacity.** "Out of host capacity" on A1 launches is widely reported in 2026, mostly on free accounts
  (unverified). You may not get the instance at all, or not again after deleting it.
- **Account suspension.** Free tenancies are reviewed and can be closed; a paid (pay-as-you-go) account is the only
  basis for production. Upgrading the account keeps the Always Free resources (Oracle's docs; **unverified** for 2026).
- **No SLA** on free resources; one box is one failure domain. Persistence (D991) and backups (§7) make a rebuild a
  restore, not a re-sync of every source.

### 2.2 The fallback when free capacity is gone or reclaimed

A cheap ARM or x86 box elsewhere, same steps (prices read 2026-11-12, docs/research/hosting-2026-11.md; **check at
signup**): paid Oracle A1 4 OCPU / 24 GB about $55/month (E4 x86 when A1 is short); netcup RS 2000 G12.5 (8 dedicated
cores, 16 GB, €40.70/month on a 12-month term; Vienna, Nuremberg or Manassas, Virginia); Hetzner dedicated AX41 64 GB
at €59 (no setup fee) or AX42 at €79-99 plus €49, the cheapest RAM. Hetzner's cloud lines (CPX32 in Helsinki was
€30.49 and in stock on 2026-11-11) read "currently unavailable" on 2026-11-12. The image is multi-arch from source;
move by restoring a backup (§13, Restore).

Compute per user-month on the fallback (arithmetic on §6's measured RSS and the listed prices): paid A1 4 / 24 GB at
$55.48 holds 3,702 heavy users at their peak hour ($0.015 a user-month), 5,698 prose users at a quarter active
($0.0097), 8,719 at a twentieth ($0.0064); a Hetzner AX41-class 64 GB at about $66 holds 9,964 heavy users at peak
($0.0066). docs/COST-MODEL.md, "Hosting", adds the store, the load balancer and monitoring.

## 3. TLS

**Recommended: Caddy on the box** (`deploy/compose/single`): automatic Let's Encrypt certificates and renewal, HTTP/3,
and the piece that makes restarts invisible: `lb_try_duration 20s` holds requests while Eden restarts, and its
`/readyz` health check (2 s) stops sending to a draining Eden (§11). No account needed.

**Cloudflare's free proxy in front** adds DDoS absorption and hides the box's address. Set the record to proxied,
SSL mode **Full (strict)** (Caddy still terminates TLS with its own certificate; HTTP-01 challenges pass through
Cloudflare), and restrict 80/443 to Cloudflare's published ranges. Costs: a hop (tens of ms), a third party that
sees request bodies (the agent's events and Eden's packets: content), and its own outages. Use it if the box's
address must stay private or you expect abuse; otherwise Caddy alone is simpler and keeps content between the
tenant and the box. Either way Eden's own port is never public.

## 4. Keys and secrets

| Secret | Made by | Lives | Rotation |
| --- | --- | --- | --- |
| `EDEN_API_KEYS` (tenant:key, 16+ chars) | `openssl rand -hex 24` per tenant | `.env` (600) on each Eden box and the cluster router | list the new key beside the old (`acme:<new>,acme:<old>`: a tenant may have several), restart, move the tenant over, remove the old (§13) |
| `EDEN_PERSIST_KEY` (32 bytes) | `openssl rand -hex 32`, **once** | `.env`; a copy in your password manager | none: a start with a key that opens none of the persisted users stops (exit 2, no foreign blob deleted, D1071); `EDEN_PERSIST_DISCARD=1` discards them on purpose (they re-sync, D425) |
| `EDEN_CLUSTER_KEY` (24+ chars) | `openssl rand -hex 24` | `.env` on nodes and routers | replace on all at once (a rolling restart) |
| `EDEN_S3_*` | the store's console, scoped to the one bucket | `.env` on nodes | create the new key, roll, delete the old |
| `OPENROUTER_API_KEY` (optional) | OpenRouter | `.env` | in OpenRouter; restart |
| Hetzner / Oracle API tokens | the console | your shell (`TF_VAR_…`), never a file | in the console |

Never in cloud-init user data (readable from the metadata service), an image, a compose file, a repository or a
log. Eden never logs a key; the server refuses keys that are short or placeholders. `push-secrets.sh` refuses a file
that still holds `REPLACE`.

## 5. Processes

`EDEN_PROCESSES` = the cores the container may use (D163, D178): 2 on the free A1, 4 on a 4-core box. Each process
costs about 70-90 MB before any user and holds 1/N of each tenant's caps (rate, burst, model spend); a tenant whose
traffic is one user needs its caps raised (docs/INTEGRATION.md). Users are pinned to a process by a bucket of their
id (D992), so changing N moves 1/(N+1) of them, all to the new process, and nothing on disk.

## 6. Sizing

Measured with `users.bench.ts` (3,000 items a user, one process, the 2-core 12 GB cgroup; d1-scale-out.md §1):
RSS per user against the share of users active within 30 minutes (a quarter of those live, the rest warm, D862).
Users per box by `deploy/scripts/sizing.py` (arithmetic on those: 75% of RAM, 70 MB a process, 60 MB of micro-model
weights a process as an upper bound).

| Text, active share | RSS a user | 2 OCPU / 12 GB | 4 / 24 GB | 64 GB, 8 proc | 128 GB, 16 proc |
| --- | --- | --- | --- | --- | --- |
| Prose, 1/4 | 3.06 MB | 2,840 | 5,698 | 15,336 | 30,691 |
| Prose, 1/8 | 2.50 MB | 3,476 | 6,975 | 18,772 | 37,566 |
| Prose, 1/20 | 2.00 MB | 4,346 | 8,719 | 23,465 | 46,957 |
| Sim text, 1/4 | 2.10 MB | 4,139 | 8,304 | 22,347 | 44,721 |
| Sim text, 1/20 | 1.05 MB | 8,278 | 16,608 | 44,695 | 89,442 |
| Heavy (20 connectors, prose), 1/4 | 3.36 MB | 2,587 | 5,190 | 13,967 | 27,950 |
| **Heavy, peak hour** (all active, 1/6 live, 5/6 warm; D998) | **4.71 MB** | **1,845** | **3,702** | **9,964** | **19,939** |

Read the prose rows for real mail (the sim's templated text compresses better than mail will), and **size daily
agents by the heavy peak row**: when a tenant's users all work the same hours, every one is active within 30 minutes,
a sixth of them live at any moment (about 7.3-7.5 MB each at the cap after a thaw since D998, 8.6 before) and the rest
warm: 4.71 MB a user (5.20 before D998, the same day). With a model key, card state adds about 3.7 MB a user: 8.43
MB at the peak (docs/research/d1-livemem.md). The other rows were measured before D998, which lowers them too. Compacting warm users sooner was tried and rejected (D996): at most 11% less memory for
200 ms more on every return after a pause. Latency at a realistic rate on the 2-core budget (`bun run sim:perf steady --synced`: 300 synced users of the sim
world at real pacing and connector latency, 39 events and 87 requests a second, one server process, the reviewer's
runs sharing the machine): observe p50 0.95 ms, p99 21.7 ms (a user's message 2.9 / 25.4 ms), `ask_context` 6.4 /
32.3 ms, with the server at 17% of a core.
CPU is not the limit at these counts (estimate: 14,000 heavy users at 50 requests a day is 8 requests a second on
average; a request costs tens of milliseconds); a cold start without persisted users is (14,000 users x 3,000 items
x 0.35 ms of ingest each is about 4 hours of one core), which is why persistence is on (D991).

**A half-hour soak on the 2-core 12 GB box (D1075, r1-release.md §Round 3):** 1,500 heavy users through the server's
wiring with persistence, sessions every ~12 minutes, a restart halfway: 33,382 requests, 0 errors, RSS 4.51 MB a user on
the mean (the table's 4.71 holds; the collector's peaks reach ~22% above it, so at the table's 1,845 users little of the
25% headroom is left); user message p99 15 ms, `ask_context` p99 272 ms; no leak over 40 minutes. **A full box's restart
keeps only what its shutdown budget writes:** at the single-box compose file's 15 s grace a process wrote about 170 of
its 750 users (~26 ms a heavy user, in 0.3 of the grace); the rest re-synced from their sources on their next event.
Writing the most recently used users first instead was measured and rejected (D1076): live users cost more to write,
so fewer were written (498 against 626 of 1,000) and fewer of those back within 5 minutes found their state (50%
against 61%). The order stays oldest first; size `EDEN_SHUTDOWN_GRACE_MS` to the users a process holds if restarts
must keep them.

**Restart, 200 users at the cap, the 2-core budget** (`restart.bench.ts`, connectors answering in 20-80 ms):
every user synced again in 158 s with 6,000 listing calls without persistence; 48 s with compact files; 12 s with
the warm files a drain writes (600 calls). Per user: 6-7 ms to read a file, 21 ms to thaw a warm one, 199 ms a
compact one.

## 7. Backups

`eden-backup.timer` runs `deploy/scripts/backup.sh` daily: the source map, copied with SQLite's online backup, and,
on a single box, the persisted users (still encrypted; useless without `EDEN_PERSIST_KEY`, which is not in the
archive). Kept 7 days on the box (`/var/backups/eden`, mode 700; D428: nothing persisted outlives 7 days, its
backups neither) and, with `BACKUP_REMOTE` set to an rclone remote (a Hetzner Storage Box, the object store), copied
off it. Checked here: an archive of a running box's `source-map.0.db`, `source-map.1.db` and `frozen/`. In a cluster
the users are in the shared store; back up the source maps only. What a lost box costs without a backup: its users
re-sync from their sources (minutes each, connector calls), and per-user learning starts over.

## 8. Monitoring, logs, uptime

- **Metrics:** `/metrics` on each box's loopback (summed over its processes; the cluster router's also over nodes):
  requests and latency by route, users held (live, warm, frozen), persistence and store counters, memory.
  `deploy/monitoring/config.alloy` (Grafana Alloy) scrapes it and the machine's memory, CPU and disk and sends
  both to Grafana Cloud's free tier (10k series, 14 days, 3 users at the time of writing: **unverified**, check the
  plan) or any Prometheus. Eden's own series: under 300 per box.
- **Alerts:** `deploy/monitoring/alerts.yaml`: down, a process or node down, 5xx over 1%, `/v1/events` p99 over
  500 ms, memory over 75% (plan a box) and 90% (act), store failures and backlog, disk over 80%, model calls failing
  (`EdenModelFailing`: thrown errors, not unreadable replies; D1690), and the scale SLOs of s1-scale-1m.md §8 —
  time to first value p90 over 15 min, the first-page backlog or kick queue still growing after 30 min, and over
  5% of connector listing calls throttled (D2047).
- **Prompt cache (D1790, D1800):** the model roles (`role="check"`, `"cards"`, `"reader"`) report, per process since
  it started, `eden_model_calls_total`, `eden_model_cache_breakpoint_calls_total` (calls whose request carried a
  `cache_control` breakpoint), `eden_model_input_tokens_total`, `eden_model_cache_read_tokens_total` and
  `eden_model_cache_write_tokens_total` (0 unless OpenRouter's usage reports `cache_write_tokens`: unverified, so
  read the cost instead). How to read them, after a day of traffic:
  - read tokens over input tokens on `role="check"` is the share of the check's input served at 0.1x. The fixed
    instructions are about 1,200 of a check's 3,000-5,000 input tokens and the same for every user, so a box with
    more than a few checks every five minutes should show about 0.2 or more [EST]; active users' rule sheets add to
    it.
  - breakpoint calls with read tokens flat at 0: the route accepts the fields and serves no reads. Each process
    stops sending breakpoints by itself after 50 calls that should have read (a prefix it sent within its TTL, long
    enough to cache) and logs `eden: openrouter served no cached tokens on 50 calls ...` once; a restart starts the
    count again.
  - a quiet box (a check every few minutes or less) reads little and writes little: the rule sheet is sent plain to
    a user whose checks are not usually within the hour (D1800), and only the fixed instructions are written (at the
    hour when the tenant's checks usually come within it, else five minutes).
  - set `EDEN_MODEL_CACHE=off` (and restart) when OpenRouter's activity page shows cache writes costing more than
    the reads save over a few days, when the log line above appears on every restart, or when the account's data
    rules forbid a provider keeping any prompt for reuse (docs/PRIVACY.md). It changes no reply, only the price.
- **Logs:** Docker's `json-file`, 5 x 20 MB per container; journald capped at 1 GB. Eden's logs are content-free by
  rule (D56); Alloy can ship them (Loki, free tier).
- **Uptime from outside:** any free HTTP monitor on `https://<name>/readyz` (UptimeRobot's free plan: 50 monitors
  at 5-minute intervals; Better Stack and Grafana Cloud Synthetic Monitoring have free tiers; all **unverified**
  2026 terms). Alert by email or a phone app.

## 9. More than one machine (the cluster, D992-D994)

```
             Caddy ── cluster router(s) ── private network ── node n1 (Eden: router + N children)
 (TLS, LB)            (rendezvous by bucket,                   node n2
                       health, rebalance)                      node n3 ── shared S3-compatible store
```

- **Nodes** (`deploy/compose/node`): Eden on the private address only, `EDEN_PERSIST_STORE` (an S3-compatible
  bucket every node reaches: Hetzner Object Storage has no request fees but allows 750 requests a second per bucket
  and 100 buckets an account; Cloudflare R2, Oracle, AWS work too). Several comma-separated
  `s3://<bucket>/<prefix>` URLs shard the store over that many buckets (S1-P4: a user's shard is their bucket mod the
  count, one prefix shared by all of them) for fleets whose peak would exceed one bucket's rate bound — set the
  count once, since changing it re-syncs every user. `EDEN_CLUSTER_KEY`, `EDEN_CLUSTER_SIZE` (the
  machine count: divides each tenant's spend cap, D993). A node clears its local copies at start: the store is the
  copy of record. A Hetzner vSwitch (the private network between dedicated servers) joins at most 100 servers.
- **Cluster router** (`deploy/compose/cluster-router`): `EDEN_NODES_FILE` (`id=url` lines; ids are stable names),
  `EDEN_API_KEYS` (to hold each tenant's whole rate, D993) and the cluster key. For cells (S1-P8, above ~100k
  users) add each row's cell as a second token (`a=http://… cell-a`) and set `EDEN_CELL` on each cell's routers:
  membership, placement and the published `cluster-membership.<cell>` doc then scope to that cell's rows, and a
  cell'd list refuses to boot without `EDEN_CELL` (one router must never merge cells). For redundancy run more behind the
  load balancer with `EDEN_CLUSTER_FOLLOW=1` and the same `EDEN_PERSIST_STORE`: a follower probes and tells nothing —
  it polls the `cluster-membership` doc the leader writes into the store and adopts its placement (S1-P7), so two
  routers never drive competing memberships; when the leader stops writing, a follower's last adopted table keeps
  serving until it is restarted without the flag (or a new leader is started by removing it). TLS in front as in §3.
- **Placement:** each user's bucket (16 bits of a hash of tenant and user) is owned by the node that scores highest
  for it (rendezvous hashing): adding a node moves about 1/(n+1) of users, all to it; losing one moves only its
  users.
- **A planned change** (a line added or removed, then `docker compose kill -s HUP router`, or just saving the file):
  the router tells every node the new membership; each releases the users it no longer owns (written with their sync
  state and learning, into the store) and answers; then routing switches. Moving users get 503 with Retry-After for
  that time (silence to the agent). Measured (one host, 300 small users): a fourth node, 24.8% of buckets moved, 97
  users released, 173 ms. At full size (3,000-item prose users, the peak-hour mix, a store at 30 ms a call):
  a process released 60 users in 422 ms and 120 in 1.65 s (live ones about 30 ms each, warm ones 3-7 ms), all in
  the store within 0.7-2.4 s; so a 64 GB node giving a fifth of 16,000 users to a new one takes about 6-11 s, its
  processes in parallel, under the router's 60 s bound (d1-scale-out.md §3).
- **A failure:** a node failing `/readyz?all=1` (ready only with every child process up; plain `/readyz`, which Caddy
  and the container's health check read, stays ready while any child is up, D1070) three probes in a row (2 s apart:
  4.6 s measured) is dropped; its users go to their second-choice nodes, which read their last stored blob (the
  30-minute compact freeze, the last release or shutdown) and poll their sources for what changed. Users that were live
  and never stored re-sync. When it answers again it is first told to drop everything it still holds (older than what
  the others served since), then its users move back the planned way (D995). A node being stopped (`/readyz` says
  "draining") is a planned leave: it hands its users over during its drain delay. Every node refuses requests for users
  another machine owns (503 "not the owner") and writes nothing of them to the store.
- **Latency through the router:** +0.05-0.1 ms at p50 and +0.6-1.4 ms at p99 on one host (a network hop adds its
  round trip).

Checked locally with real processes: `cluster.test.ts` (three machines, a fourth added, one killed, one removed,
forget), `bench/cluster.bench.ts`, and `deploy/compose/local-cluster` (three nodes in containers, the router, and
SeaweedFS as the S3 store: a node restart wrote its 12 live users at the drain and fetched all 12 back; a stopped
node's users were fetched by the other two).

## 10. When to scale, and how

Triggers (alerts in §8):

| Signal | Threshold | Action |
| --- | --- | --- |
| Memory used | over 75% for 30 min at the daily peak | plan the next step this week |
| Memory used | over 85-90% | act now: a bigger box or another node |
| Users held per box | 80% of §6's figure for your mix | as memory |
| `/v1/events` p99 | over 500 ms for 15 min with memory fine | CPU: more cores (and `EDEN_PROCESSES`) |
| A restart's re-sync | longer than you accept | persistence on (it is, D991) and a drain at stop |

Steps, in order:

1. **Vertical** (minutes of downtime, held by Caddy): a bigger box of the same kind. Oracle A1 resizes in place
   (stop, change OCPU and memory, start); Hetzner cloud rescales (`server_type`); a dedicated server moves by
   restore (§13). Set `EDEN_PROCESSES` to the new cores. Good to about 64-128 GB.
2. **Out** (§9): turn the box into node n1 (point it at a store and add the cluster key), start a cluster router in
   front, then add nodes one at a time. Each addition moves about 1/(n+1) of users, a planned rebalance.
3. **Down:** remove a node's line; it releases everything, then stop it.

What stays per machine: the cluster router holds each tenant's whole rate; children keep 1/N as a backstop; the
model spend cap is divided by N x machines (D993; once the micro models replace the paid roles it bounds nothing).

`deploy/scripts/autoscale-plan.py` does this arithmetic for you (S1-P5, D2043): point it at the nodes file and it
reads every node's `/metrics`, measures the live MB a user, projects the peak (held x 1.22), and prints the
`node_count` for the varset and the nodes-file lines to apply by hand. Scaling in needs three consecutive
below-need readings and never runs inside peak hours; a node that does not answer counts as full. A nodes
file naming cells (§9) must be planned one cell at a time — pass `--cell`, once per cell. Example:

    python3 -I deploy/scripts/autoscale-plan.py --nodes-file nodes.txt --ram-gb 128 --processes 16 --cidr 10.1.0.0/16

## 11. Upgrades with minimal downtime

**One box** (`deploy/scripts/upgrade.sh <compose dir> <ref>`): builds the new image while the old one serves, then
recreates the container. Eden's stop (D994): `/readyz` turns 503 and it keeps serving 5 s (`EDEN_DRAIN_DELAY_MS`)
while Caddy's health check moves away, then finishes in-flight requests, writes live users (warm, so the new one
thaws them in about 20 ms each) and exits; Caddy holds new requests until the new container answers. Measured
locally (Caddy and Eden as in `deploy/compose/single`, an event every 20 ms across a `docker compose restart`):
842 requests, **0 errors**, the longest held 6.05 s; without the drain delay one request in 491 got a 502 (a
kept-alive connection meeting the closing listener). `/readyz` was back 1.2 s after a plain restart.

**A cluster** (`deploy/scripts/rolling-upgrade.sh`): one node at a time: take it out of the nodes file (its users
are released to the others), upgrade it, put it back (they return). Nobody is unserved for longer than a rebalance.
Upgrade the cluster routers one at a time behind their load balancer.

A change of the persistence format (`PERSIST_FORMAT`) discards older files (those users re-sync once); the release
notes say so. It cuts the other way too: a rollback to an older build, or an older process beside newer ones on a
shared disk or store during a rolling upgrade, discards (deletes) the newer format's files, and those users re-sync
once. Format 6 (D1888, frozen entries carry their date facts) reads format 5's files; a build of format 5 deletes
format 6's. Format 7 (D1926, a warm blob's packed texts may be zstd) reads format 6's; a build of format 6 deletes
format 7's.

**Source-map files made before D1936 are moved once (D1960).** The first start of a build with D1960 rewrites each
older source-map file (`source-map.db`, `source-map.<i>.db`, mcp-stdio's per-user files) to the WITHOUT ROWID
layout at open, before it serves: about half the file and half its later disk writes. It logs one line a file
(`eden: source map … moved to the WITHOUT ROWID layout (D1960): N rows, compacted, T ms`); a real 7.5 MB file took
123 ms and wrote about 14 MB once. An open spends at most about 3.5 s on it, however many router children move
their files at once: the copy gives up and rolls back past 3 s (`MIGRATE_BUDGET_MS`), and measured with eight
children on 110 MB files each gave up at 3.0-3.3 s on the loaded 4-core VM, where a 28.5 MB file moved in 1.0 s
alone. A move that ran past 1.5 s skips its VACUUM (`not compacted`) and a later open compacts the file (`compacted
(D1960): F free pages of P`); the same compaction runs on any file grown loose, a new one after many forgets
included, if at most 64 MiB of it is live (0.4 s alone, up to 2.6 s with eight at once under load). Free disk is checked first: at least twice the file (plus its WAL and 4 MiB) when
SQLite's temp directory (`SQLITE_TMPDIR`, `TMPDIR`, else `/var/tmp` or `/tmp`) is on the same filesystem, else 1.5x
beside the file and 1x there. A file that cannot be moved logs `keeps its rowid layout … it works as before` and is
served as it was, and the next start tries again: another process holding it, read-only, too little free disk (the
line says how much it needs), damage, past the time budget, or an index, trigger or view someone added on its
tables (named in the line; drop it to let the move run). Two kinds are never moved at open and log that line at
every start: a file over 128 MiB, and a file from October 27 (its `mention` table has a `last_ref` column; neither
the open nor migrate.ts moves it, and the map reads and writes it as it is). To move a large or slow file, stop the
server and run `bun packages/graph/src/migrate.ts FILE` (from `/app` in the image; no size or time bound, about
0.13-0.17 ms a page: 4.7 s for 110 MB; it says `no source-map tables` for a file that is not a map). A rollback to
an older build reads and writes a moved file unchanged.

## 12. What was validated here, and what was not

Validated on 2026-11-11 (x86-64 host): the image built for linux/arm64 under QEMU and ran (healthy, events 200, a
clean stop); the amd64 image; every compose file (`docker compose config`); the single box with Caddy (internal CA
for `localhost`): restart with 0 errors; the backup script on a running box; the local cluster against SeaweedFS
(MinIO's images could not be pulled without an account); the cluster router, the store and persistence in the test
suite.

Also validated: the cloud-init file rendered for each role (`render-cloud-init.py`) passes `cloud-init schema`
(cloud-init 26.2 from Ubuntu's archive).

Validated on 2026-11-12 with the real tools (release binaries from GitHub, x86-64 host), by the session that wrote
PR #331; its command output was not kept, and the reviewer's sandbox had no copy of these tools to rerun them:

- **OpenTofu v1.10.6**: `tofu init -backend=false && tofu validate` in `deploy/tofu/hetzner` (providers
  hetznercloud/hcloud 1.70.2 and hashicorp/aws 5.100.0, as `versions.tf` resolved them that day) and
  `deploy/tofu/oci` (oracle/oci 7.32.0): "Success! The configuration is valid." in both; `tofu fmt -check` clean in
  both. This checks the configs against the providers' schemas; it does not run `tofu plan`, which needs credentials.
- **promtool 3.5.0** (Prometheus 3.5.0): `promtool check rules deploy/monitoring/alerts.yaml`: "SUCCESS: 10 rules
  found".
- **Alloy v1.11.3**: `alloy fmt deploy/monitoring/config.alloy` parses the file (exit 0); its output differs from the
  file only in whitespace (tabs for indentation, a blank line before nested blocks).
- **ShellCheck 0.10.0** on `deploy/scripts/*.sh`: no warnings or errors (`-S warning`); five SC2029 notes (info) on
  `push-secrets.sh` and `rolling-upgrade.sh`, where expanding on the client is intended. `scripts/deploy-kit.test.ts`
  runs `bash -n` on every deploy script, shellcheck where it is installed, and `bootstrap-dedicated.sh` against
  stand-ins for ssh (with and without `DEPLOY_KEY`, a wrong github.com host key, a key with a passphrase).

The static checks (D997) remain for a machine without those tools: `deploy/scripts/check-tf.py` (python-hcl2 from
PyPI) checks that every variable, local, resource and data source referenced exists and that each `templatefile`
call passes exactly the cloud-init template's variables; `deploy/scripts/check-monitoring.py` checks `config.alloy`'s
component references and listed environment variables, and that every rule in `alerts.yaml` watches a metric Eden
emits (semantics `promtool` does not know).

Validated on 2026-11-12 for D1702 (network namespaces on one host, Docker 29.9.2, iptables 1.8.10 nf_tables): with
Eden's port published on a "private" address only, a peer that routes to that address through another interface
reached it (the gap); with the DOCKER-USER rule, that peer was dropped and the private peer still served; the rule
survived a restart of dockerd when loaded before it (as ufw does at boot), and reloading the block twice left one rule.
`scripts/deploy-kit.test.ts` renders every role's cloud-init, parses it as YAML and runs the block through
`iptables-restore --test` where it can. Not validated: ufw itself loading `after.rules` on Ubuntu 24.04 at boot.

Not validated: `tofu plan` and `tofu apply` against real accounts; cloud-init and `bootstrap-dedicated.sh` on a real
machine, including the deploy key's clone of a private repository from a server; Hetzner Object Storage's lifecycle
rule (S3-compatible per its docs; unverified); Alloy's runtime behaviour (`alloy fmt` checks syntax only) and the
alert rules firing on real data; a real network between machines; real Ampere hardware (the arm64 run was emulated,
so no arm64 timings are quoted).

## 13. Runbook

**Deploy:** §2 (one box) or §9 (cluster). Smoke-check with `deploy/scripts/cluster-smoke.ts`.

**Scale up / down:** §10. A node: create it (tofu `node_count`), push its `.env` (`push-secrets.sh … node`), wait
for `/readyz`, add its line to the nodes file. Down: remove the line, watch the router log the release, then
destroy it.

**Restore a box** (disk lost, moving providers): new box (§2), the same `.env` (the same `EDEN_PERSIST_KEY`: with
another key Eden refuses to start, D1071), then before starting Eden: `tar -xzf eden-<host>-<stamp>.tar.gz -C
<the eden-data volume's mountpoint>` and `chown -R 1000:1000` it (the image's `bun` user); start, smoke-check.
Users come back from their files on first use; anything after the backup re-syncs from the sources.

**Rotate keys:** a tenant key: generate, add it beside the old one in `EDEN_API_KEYS` (`acme:<new>,acme:<old>`) on
every box and restart (a drain: no errors), give the tenant the new one, then remove the old and restart again. The cluster key: on every node and router, rolling. The store's
keys: add a new access key in its console, roll it out, delete the old. **The persistence key cannot rotate**:
changing it discards every persisted user (they re-sync); do it only after a suspected leak, and expect the
connector calls of a full re-sync.

**Incident: Eden is down.** `docker compose ps` and `logs eden | tail`: an `eden:` line names a configuration
mistake (exit 2). Out of memory (`dmesg | grep -i kill`): add memory or a node; lower `EDEN_PROCESSES` only if
per-process overhead is the issue. Callers fail open (the client never throws into the agent's loop): agents run
without context meanwhile.

**Incident: a node is down** (cluster): the router already moved its users (`eden cluster: node … stopped
answering`). Bring it back or replace it; when it answers it gets its users back. If the store is failing too
(`EdenStoreFailing`), moved users re-sync: check the store's status page and credentials.

**Incident: the model is failing** (`EdenModelFailing`, D1690): Eden is serving its no-model path. The first
failure's `eden:` log line names the provider's error. A 401 is the key; a 402 or "credit" is the balance; a 403
"violation of provider Terms Of Service" on `anthropic/*` is OpenRouter refusing that model for the account or the
region the box calls from: check it from the box with one small call, ask OpenRouter, or set `EDEN_MODEL` to a model
the account can reach until it is resolved (the quality numbers in docs/research were measured on Haiku).

**Incident: a leak of a key.** A tenant key: rotate it. `EDEN_PERSIST_KEY` with the disk or store: rotate it, and
start once with `EDEN_PERSIST_DISCARD=1` beside the new key (the old users are discarded and re-sync; without it Eden
refuses to start, D1071), then remove it; treat the store's and disk's contents as exposed (redacted content, D10;
T12 in THREAT-MODEL.md).

## 14. Persistence is the default (D991)

The owner decided it on D863's recommendation. Without it a restart re-reads every user's sources: on the 2-core
budget 158 s and 6,000 listing calls for 200 users, against 12 s and 600 with warm files from the drain. What every
deployment takes on: redacted content of idle users at rest, encrypted under the operator's key, which sits in the
environment beside the files (a host compromise reads both: put the volume on an encrypted disk, keep the key in a
secret store); deleted when the user returns, is forgotten, or after 7 days at most. `EDEN_PERSIST=off` is there for
an operator who prefers re-syncs to content at rest; it must be set on purpose. Disclose the store to your users
(docs/PRIVACY.md).

## 15. Cost

docs/COST-MODEL.md, "Hosting": our cost per heavy user per month at 1k, 10k and 100k users, and the tenant's.
