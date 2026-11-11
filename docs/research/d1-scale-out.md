# D1: deploying Eden, sizing the box, and more than one machine

Status: built and measured 2026-11-11 on branch `claude/d1-deploy` (decisions D990-D994). Paid spend: $0. Machine:
4 vCPU x86-64, 15 GB, Bun 1.4.4; the sizing runs inside a cgroup of 2 CPUs (cpuset 0-1, CFS quota 200%) and 12 GB,
one at a time; other work in the session was pinned to the other cores, but a Docker build and the reviewer's runs
shared the machine at times, so CPU timings are **contended** and memory figures are not. Every figure comes from a
command run in this session; estimates are marked **[EST]**. The provider survey is docs/research/d1-providers.md;
the operator's guide is docs/DEPLOY.md.

## In plain words

- The server image did not start (D990): fixed; it now builds and runs on arm64 and amd64.
- Users per box are bound by memory: 2.0-3.4 MB of RSS a user at the 3,000-item cap on prose, 1.0-2.1 on the sim's
  text, measured on the free A1's 2-core 12 GB budget. A 2 OCPU / 12 GB box holds 2,600-4,300 prose users by that.
- Persistence is now on by default (D991): a restart of 200 users at the cap is 12 s with the drain's warm files and
  48 s with compact ones, against 152-158 s re-reading every source.
- More than one machine is built (D992-D994): users placed by bucket over machines (rendezvous) and processes (jump);
  persisted files shared through an S3-compatible store; a cluster router that releases users before moving them,
  fails over a dead machine in about 5 s, and costs 0.05-0.1 ms at p50 on one host.

## 1. Users per box (users.bench.ts, the 2-core 12 GB cgroup)

`users.bench.ts <users> 3000 [--prose] [--sources=N] --waves=W --warm-waves=3`, one run a row: with W waves the last
is live, the three before it warm and the rest compact, so the active share (used within 30 minutes) is 4/W and a
quarter of the active users are live (p6-scale.md's split; p6's "`--waves=4K`" means 4 x K waves). 200 users (400 at
1/20), 3,000 items each. Process RSS before any user: 90 MB (prose), 70 MB (sim text).

| Text | Active | RSS a user live mix | RSS a user frozen | Thaw p50 / p99 (compact) | First event p50 / p99 |
| --- | --- | --- | --- | --- | --- |
| Prose | 1/4 | 3.06 MB | 2.08 MB | 224 / 314 ms | 10.5 / 22.9 ms |
| Prose | 1/8 | 2.50 MB | 1.92 MB | 229 / 334 ms | 10.9 / 24.4 ms |
| Prose | 1/20 | 2.00 MB | 1.73 MB | 241 / 426 ms | 10.5 / 18.1 ms |
| Sim text | 1/4 | 2.10 MB | 1.06 MB | 147 / 224 ms | 10.4 / 21.4 ms |
| Sim text | 1/8 | 1.56 MB | 0.96 MB | 147 / 231 ms | 10.1 / 26.7 ms |
| Sim text | 1/20 | 1.05 MB | 0.78 MB | 153 / 277 ms | 10.5 / 20.0 ms |
| Prose, 20 connectors (heavy) | 1/4 | 3.36 MB | 2.35 MB | 235 / 373 ms | 11.8 / 29.6 ms |
| Prose, 20 connectors, peak hour | all active, 1/6 live, 5/6 warm | 5.29 MB | 3.41 MB | 21.9 / 279 ms (most warm) | 12.4 / 25.3 ms |
| Prose, 20 connectors | 1/2 | 4.29 MB | 2.73 MB | 222 / 321 ms | 13.2 / 26.9 ms |

The prose 1/4 row reproduces p6's 4-core figure (3.00 MB; here 3.06). Twenty connectors instead of three add 0.30 MB
a user (per-source sync state, sketches, rare-term tables). Thaws are the compact form's (a user back after 30
minutes); a warm user (back within 30 minutes) thaws in 8-17 ms (p6). Every row backfilled its users at 285-377 µs
of CPU an item.

**At real-box scale:** HEAVY_1000.

Users per box (`deploy/scripts/sizing.py`): (0.75 x RAM - 55 MB router - N x (70 MB a process + 60 MB of micro-model
weights, an upper bound)) / 1.024 / RSS. On 2 OCPU / 12 GB: 2,840 prose users at 1/4 active, 3,476 at 1/8, 4,346 at
1/20; 4,139-8,278 on the sim's text; 2,587 heavy users at 1/4 (docs/DEPLOY.md §6 has 4/24, 64 and 128 GB).

## 2. Restart (restart.bench.ts 200 3000 [--warm], the same cgroup)

| | Every user synced again | CPU | Listing calls | Read / thaw a user |
| --- | --- | --- | --- | --- |
| Persistence off | 158.0 s (compact run), 152.5 s (warm run) | 164.9 s, 158.4 s | 6,000 | |
| Persisted, compact files | 48.1 s | 50.8 s | 600 | 5.6 ms / 199.4 ms |
| Persisted, warm files (a drain's) | 12.0 s | 12.6 s | 600 | 6.8 ms / 21.3 ms |

On 2 cores against p6's 4: 1.3x, 1.4x and 2x p6's 122 s, 33.6 s and 6.0 s.

## 3. More than one machine, as built (D992-D994)

D864 listed five pieces and a smallest working step. Built, in order:

1. **Placement by bucket.** `bucketOf(tenant, user)` (16 bits, unkeyed, @eden/protocol). Machines: rendezvous
   hashing over node ids (`OwnerTable`, a 65,536-entry table rebuilt on a membership change, about 1 ms a node);
   losing any node moves only its buckets, which jump hashing cannot do for a node other than the last. A machine's
   children: jump hashing (`childTable`) over a second mix of the bucket, so a node's buckets spread evenly over its
   children (tested within 2%). `childFor` became the table: 2 -> 3 children keeps two thirds of users in place (it
   was one third with `mod N`).
2. **The blob as the hand-off, from a shared store.** File names `<bucket>-<keyed hash>.blob`, one directory per
   machine (each child indexes its own buckets only: a new child count moves nothing). `SharedFrozenDisk` mirrors
   each file, byte for byte and encrypted, to an S3-compatible store through Bun's built-in client (no new
   dependency), queued per file (newest wins) 8 at a time with retries, and fetches a user it does not hold before
   their first read (`FrozenDisk.fetch`, awaited in `ItemCache.ready`). A thaw keeps the store's copy (the failover
   copy); forget, expiry and eviction delete it; a node clears its own local files at start.
3. **Per-user learning moves.** The blob's extra carries the user's source-map rows (`exportUser`/`importUser`:
   mentions, utilities, planner arms), replaced where they land (`PERSIST_FORMAT` 5). Sessions, the not-twice ledger,
   explain traces, `SourceYield` and cards still start over on a move (memory only, as on any restart).
4. **Per-tenant caps** (D993): the whole rate and burst at the cluster router; 1/N in each child as a backstop; the
   spend cap divided by N x machines (no shared ledger: the paid roles are being replaced by $0 CPU models).
5. **Failover and planned moves.** The cluster router probes `/readyz` every 2 s; three failures drop a node (its
   users' new owners fetch their last stored blob); a membership change is planned: every live node releases the users
   it no longer owns (`ContextPartner.releaseMoved`: written, handed to the store, dropped) before routing switches,
   and moving users get 503 with Retry-After meanwhile. A refused connection (a node restarting) is retried for up to
   5 s, never a request a node may have taken.
6. **Readiness, metrics, drain** (D994): `/readyz`, `/metrics` (summed over processes and nodes), a SIGTERM drain in
   `EDEN_SHUTDOWN_GRACE_MS` with `EDEN_DRAIN_DELAY_MS` before the listener closes.

**Measured on one host** (`bench/cluster.bench.ts 300 100 1000`: three nodes of one process each, an in-memory S3
stand-in, 300 users of a static source, 1,000 events at 100 a second; one run):

| | Result |
| --- | --- |
| Latency, direct to the owner, p50 / p99 (two runs) | 1.37 / 4.53 ms, 1.12 / 4.36 ms |
| Latency through the cluster router, p50 / p99 | 1.42 / 5.96 ms, 1.22 / 4.98 ms |
| A fourth node added | 16,231 of 65,536 buckets moved (24.8%), 97 users released, 173 ms |
| The fourth node removed (planned) | the same buckets back, 97 users released, 56 ms |
| A node killed (SIGKILL) | routed around 4,569 ms after the kill (probes 2 s apart, 3 failures); 33.4% of buckets moved |

The users here hold a few items each, so a release is cheap. **For full-size users [EST]:** releasing a live user is
a warm freeze (18-21 ms on prose at the cap, p6) and a write (2.3 ms); a frozen one a write; then a PUT of 1-3 MB.
A 64 GB node of 4 processes holding 16,000 users that gives a fifth of them to a new node releases about 800 users a
process, a sixth of them live at the peak: about 3 s of freezing and 2 s of writes a process, in parallel, plus
about 4 s of PUTs at 8 at a time and 40 ms each: under 10 s a node, inside the router's 60 s bound.

**Against a real S3 server** (deploy/compose/local-cluster: three nodes of two processes in containers, the cluster
router, SeaweedFS 3.97; MinIO's images could not be pulled without an account): 30 users through the router; a
node's restart wrote its 12 live users at the drain and fetched all 12 back from SeaweedFS on their next events; a
stopped node was dropped and its users fetched by the other two (6 and 12). Found on the way: the cluster router sent
a restarting node's users 503s for about a second, now retried while the node refuses connections (3 retries, no
503 on the next restart); and SeaweedFS's gateway, started before its bucket existed, answered NoSuchBucket until
restarted (the compose file starts it after the bucket).

**Tests:** `placement.test.ts`, `ids.test.ts`, `source-map-move.test.ts`, `persist-shared.test.ts` (two machines over
an in-memory store; a released user lands with its sync state and rows and polls instead of backfilling),
`blob-store.test.ts` (Bun's S3 client against `fixtures/fake-s3.ts`, two pages of listing), `router-processes.test.ts`
(N 2 -> 3 -> 2 with persistence on: every user read back by its new child, none re-synced), `cluster.test.ts` (three
machines end to end: placement, a node added, killed and removed, forget), `ops.test.ts`.

**Not built:** a shared spend ledger (D993); resizing a machine's child count without a restart; a router tier that
re-reads membership from a service (a file and SIGHUP are the interface); store writes skipped when a user did not
change since the last one (the request-cost lever d1-providers.md names; at Hetzner and OVH requests are free).

## 4. Latency at a realistic rate (2-core budget)

STEADY_SECTION

## 5. ARM64 (D990)

`docker buildx build --platform linux/arm64` on this x86-64 host with QEMU user-mode (Ubuntu's `qemu-user-static`,
registered with binfmt_misc by hand; the `tonistiigi/binfmt` installer was not allowed to run) over
`oven/bun:1.4.4`'s arm64 image: the image builds, `uname -m` in it is `aarch64`, `/healthz` answers `{ok, processes:
2, up: 2}`, the health check turns healthy, an event answers 200 and `docker stop` exits 0 in 0.26 s. Nothing in
`packages/` loads native code: no `.node` or `.wasm` file is in the image, `bun:ffi` is not used, and zstd, SQLite,
S3 and crypto are Bun's own (shipped for arm64). No arm64 timing is quoted: emulated runs say nothing about Ampere.

## 6. Reproduce

```bash
# the cgroup: cpuset 0-1, cpu quota 200000/100000, memory 12 GiB (cgroup v1 here)
bun packages/engine/bench/users.bench.ts 200 3000 --prose --waves=16 --warm-waves=3      # 1/4 active; 32 = 1/8
bun packages/engine/bench/users.bench.ts 400 3000 --prose --waves=80 --warm-waves=3      # 1/20
bun packages/engine/bench/users.bench.ts 200 3000 --prose --sources=20 --waves=16 --warm-waves=3
bun packages/engine/bench/restart.bench.ts 200 3000 [--warm]
bun packages/sim/src/perf-cli.ts steady --synced
bun packages/server/bench/cluster.bench.ts 300 100 1000
python3 -I deploy/scripts/sizing.py
```
