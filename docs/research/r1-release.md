# R1: release readiness of tonight's merges (2026-11-11)

Scope: every merge into `main` from 5026ba512 to 3b54c433 (PRs #244–#269). The audit concentrated on #267 (`pushGate`,
D1014, D1015), #268 (`cardsRequestsFix`, D1060–D1063), #263 and #265 (deploy kit, D990–D997) and #254 (`pushCheck`
S, `pushIndirect`). Branch `claude/r1-release`, decision D1070. No paid model call, no Modal, heldout19 not read.
Every number below comes from a command run in this session on a 4-core container (other work running beside it:
read p50 differences under ~10% as noise).

## Findings

| # | Where | Finding | Severity | Status |
|---|---|---|---|---|
| 1 | `persist-shared.ts` `enqueue`, `start` | After a release passed its deadline, the old owner is fenced and its forget's delete is skipped, but its own put of the user still queued (or waiting to retry) ran later, after the new owner's delete: a forgotten user came back in the store (confirmed in a scratch test, 300 ms put delay) | medium (privacy) | fixed: a fenced delete drops the name's queued job; a store write that starts or retries after the fence is skipped (review). A put already on the wire still lands (one store call's window) |
| 2 | `persist-shared.ts` `absent` | One name per user ever missed or deleted, cleared only on a membership change: unbounded on a single machine with a store | medium | fixed: `MAX_ABSENT` 100,000, then starts over |
| 3 | `router.ts` `/readyz` | One crashed child made a machine's `/readyz` 503; the single box's Caddy (`health_uri /readyz`, one upstream) then held every user's requests for 20 s and failed them | medium | fixed: plain `/readyz` ready while any child is up; `?all=1` keeps D994's rule, and the cluster router probes it |
| 4 | `ops.ts` `cluster` | A release still awaiting hand-offs, finishing after a newer `drop`, wrote its older table back | low | fixed |
| 5 | `router.ts` | A child restarted after a membership had no table (no fence, every bucket writable) until the next membership | low | fixed: the last membership is replayed to a (re)started child before it serves; one sent during the replay reaches it too (review) |
| 6 | `main.ts`, `ops.ts` | A throw in `Ops.wrap` (a cut-off body in the fence, a 40,000-node membership) was Bun's default 500 | low | fixed: `wrap` answers 503, `main.ts` has a 503 `error` handler, a membership naming more than 1,024 distinct nodes is 400 |
| 7 | `router.ts` `stopChildren` | SIGKILL exactly at the grace the child's steps fill (`persistLive` checks its deadline between users only) | low | fixed: 1.25x the grace (compose stop periods still cover router drain delay + 0.4 + 1.25 grace) |
| 8 | `cluster.ts` `forward` | No timeout on a forwarded request: a hung node held router requests for ever | low | fixed: 60 s, then 503 (`cluster.test.ts`, a node that accepts and hangs) |
| 9 | `main.ts` | Persistence problems found on first read were logged by a 60 s unref'd timer only, never at shutdown | low | fixed: flushed at shutdown |
| 10 | `cluster.ts` / D992 | A machine whose child keeps failing is dropped by the cluster router (drop mode): its users lose live and warm state since their last compact freeze | design | not changed: D992's chosen trade (a child that cannot start is better served elsewhere); a crashed child restarts in ~1 s, inside the 3 probes |
| 11 | `persist.ts` | A wrong `EDEN_PERSIST_KEY` starts the server and deletes every blob (logged as `N discarded (key)`) | design | not changed: DEPLOY.md documents a new key as discarding every persisted user (and rotation after a leak needs it); the state re-syncs from sources |
| 12 | `users.bench.ts` | Thawing 300 warm users at once showed one 356–381 ms event-loop stall in 2 of 3 runs (27 ms in the third); the thaw itself is sliced, so most likely a major GC | low | not fixed: intermittent, outside the reviewed PRs' code (D862, #249); worth a GC trace |
| 13 | `http.ts:119` | An unknown GET path is 405, not 404 | cosmetic | not changed |

Checked and sound: the turn gate's load fails open (`loadTurnGate` returns null on any read or parse failure, the
header is validated against every array the forward reads, `read` is wrapped in the partner, and a gate-only start
needs `pushOpen` with candidates); its scratch buffers are per process but `read` is synchronous, so no state crosses
users. The card re-ask runs at most once a batch, only for a readable, uncut reply with no requests, under its own
`Budget` reservation (over budget: skipped), through the same redacting prompt builder (`cardMessages`); no wrapper
outside the lab drops `CardMakeOptions`. `pushStart`'s new regexes read a 400-character head. Metrics labels carry no
tenant, user or text; blob names join tenant and user with NUL (refused by `isId`) under a keyed hash; `/internal/*`
and `/metrics` are kept off the internet by Caddy.

## Hot path and memory (no model)

`pipeline.bench.ts` (1,500 items a source, 2,000 events), three alternating runs per arm; "nogate" is main with
`pushGate: false`.

| | base 5026ba512 | main 3b54c433 | main, gate off |
|---|---|---|---|
| observe p50, all events (µs) | 131.0, 113.1, 109.1 / 115.7, 101.8, 113.9 | 132.4, 116.7, 122.4 / 122.9, 119.5, 124.4 | 117.9, 114.8, 115.0 / 116.6, 109.8, 110.6 |
| observe p99, all events (µs) | 5,874, 4,421, 4,192 / 4,749, 3,961, 4,229 | 4,638, 4,030, 4,369 / 4,548, 4,043, 4,260 | 4,365, 3,811, 4,112 / 4,003, 4,588, 4,067 |
| observe p50, user messages only (µs) | 1,904, 1,762, 1,848 | 1,929, 1,775, 1,843 | 1,910, 1,833, 1,809 |
| observe p99, user messages (µs) | 5,933, 5,035, 5,145 | 5,581, 5,321, 4,951 | 5,528, 6,030, 5,473 |

The gate alone (`TurnGate.read`, scratch bench): 25 µs for "hello", 58 µs for a 64-character request, 102 µs at the
300-code-point cap, 203 µs for a 2,130-character French message. It adds about 5–10% to the all-event p50 (well
under the 20% bar) and nothing measurable to a user message's observe, so no fix was needed.

Memory: `users.bench.ts 300 500`: live 0.93 MB heap a user on both trees (RSS 1.57 vs 1.58 MB). Frozen 0.17 →
0.43 MB heap a user, thaw p50 29 → 3 ms: the warm tier (D862), as designed. Server (`perf-cli.ts memory --steps
250,500`, sim worlds subtracted): heap 0.527 vs 0.519 MB a user; RSS 0.865 vs 1.018 MB a user over the whole
reading, but 0.69 vs 0.72 MB a user between 250 and 500 users (the zero-user baselines differ by 49 MB). The gate's
weights are 1.59 MB once a process.

## Deploy smoke (main 3b54c433)

The quickstart's settings (`EDEN_PROCESSES=2`, a 64-hex `EDEN_PERSIST_KEY`, grace 15 s, drain delay 5 s, no model
key, a static three-document sources file): `/healthz`, `/readyz`, `/metrics` 200; 23 malformed requests gave
400/401/403/404/405/413, no 5xx; two users through the client SDK got injections and asks citing their items; SIGTERM
wrote each child's live users (2 blobs, mode 600), a restart with the same key read them back (same citations),
`/readyz` was 503 from 1 ms after SIGTERM and the process exited 0 after 5.08–5.10 s (an in-flight slow upload
finished 200); a wrong key and corrupt files started ready and served 200s. `docker build` of the image: 
`turn-gate.bin` is in it (1,591,772 bytes, sha256 matching the repo), `turnGate()` loads there, `docker stop` 5.2 s,
exit 0. The .dockerignore excludes only `*.db`, root `bench`/`docs`/`native` and env files.

## Gates on the branch

On the branch's final tree (main 793a4c47 merged), with `OPENROUTER_API_KEY` unset:

- `CHECK_COLD=1 bun run check`: passed in 62 s (2,339 tests in 241 files, then the tail's 463 in 25, 0 fail).
- `bun run eval`: precision 0.65, recall 0.52, falseFireRate 0; counts and the `acting` block identical to main's
  (packets on 19 of 28 neutral requests, 1.18 items each; facts handed 10 of 11; a look-alike on 3 of 10).
- `bun run funnel`: hidden 295/384, decoys 268/384 at shipped coverage, as on main.
- The `reviewer` subagent: REQUEST_CHANGES on the first diff. Fixed: a membership sent while a restarted child was
  being told the last one now reaches it (the replay sends it too); a store write that starts after the fence is
  skipped; a hung-node test pins the forward timeout; the node cap is 1,024 distinct nodes; a long line in
  DEPLOY.md. Not pinned by a test (low): the 1.25x kill, `main.ts`'s `error` handler, the shutdown flush of the
  persistence report and the turn-gate log line.

Not done: `bun run eval --live` (no engine scoring, threshold or delivery change; no paid calls allowed tonight).

## Round 2 (the parent's decisions on what round 1 left, D1071)

- **A wrong `EDEN_PERSIST_KEY` (finding 11): fixed.** A start whose key opens none of the blobs on disk (its own
  buckets) exits 2 with `eden: cannot start: EDEN_PERSIST_KEY opens none of the N persisted users in <dir> (a mistyped
  or changed key?): … or EDEN_PERSIST_DISCARD=1 …`, and deletes no foreign blob; with a shared store, a marker object of
  the key's id (`<prefix>key-id`) decides, and a store from before the marker is sampled (up to 8 blobs, all foreign
  stops it) before the marker is written. The reviewer found that sampling alone refused the right key after a rotation
  in a cluster (the old key's blobs stay until the 7-day age sweep: a probe with 5 of 20 users rewritten sampled 8 of 8
  foreign), and that an unanswering store blocked the start: the marker fixes the first, a 3 s bound the second
  (unknown: the start goes ahead). Some blob opening is a key that works: the foreign ones are discarded and logged, as
  before. `EDEN_PERSIST_DISCARD=1` starts and logs `EDEN_PERSIST_DISCARD=1: discarded N persisted users written with
  another key`. Tests: engine `persist.test.ts` (all foreign: refused, files kept; partial: starts, one discarded; an
  expired blob of the key beside a foreign one: not refused), `persist-shared.test.ts` (no marker: sampled; the marker
  written; a rotation; an empty, a down and a hung store), server `persist.test.ts` (a real process: exit 2 and both
  blobs kept, then the override starts and the blobs go; the variable's values). Not driven end to end: a cluster node's
  start refused by the marker (the engine test covers the check, `cluster.test.ts`'s machines start through it).
  DEPLOY.md (§ secrets table, restore, key leak) and the quickstart say so.
- **Pins for round 1's lows:** the 1.25x kill (`router-processes.test.ts`: a child that ignores SIGTERM under a 400 ms
  grace takes at least 480 ms to go; fails at 1x), the 503 `error` handler (`serveError`, passed by `main.ts`), the
  shutdown flush (a flipped ciphertext byte read after start is logged at SIGTERM; fails without the flush), the
  turn-gate notice (`turnGateNotice`).
- **An unknown GET (finding 13): fixed.** A path the API does not have is 404 whatever the method; a route asked
  with GET stays 405.
- **The 300-user thaw stall (finding 12): GC, not fixed** (re-run on main 530807c6 with #272's memory levers: 351,
  164 and 22 ms in three runs, live heap 0.86 MB a user). With `BUN_JSC_logGC=1` and lag probes timestamped, the
  stall coincides each time with a JSC `FullCollection` of a 590-670 MB heap at the start of the thaw-all (one run:
  heap 491 MB before, 210 MB at the probe after a 270 ms gap); no engine step runs longer than `SLICE_MS` (5 ms)
  between yields. Runs without a long stall also had full collections there (48 ms at most). `bun --smol` does not
  help: 301, 354 and 359 ms in 3 of 3 runs. The heap is the freeze's garbage (300 users' live structures let go a
  moment before); a real server frees it gradually as users go idle over minutes, not all in 0.7 s. No cheap fix:
  forcing a collection after a sliced freeze would move the same pause. Left as a finding.
- **Gates (round 2, d7d4d9c6, main 530807c6 merged):** `CHECK_COLD=1 bun run check` passed in 58 s (2,350 tests in
  241 files, the tail's 465 in 25, 0 fail); `bun run eval` 0.65 / 0.52 / 0 with counts and the acting block identical
  to main's; `bun run funnel` 295/384 hidden, 268/384 decoys. The reviewer's REQUEST_CHANGES (the rotation refusal
  in a cluster, a hung store blocking the start, an expired blob of the key, the variable's tests, a misplaced doc
  comment) is fixed in d7d4d9c6. Not done: a ranged GET for the sample's headers (8 whole blobs at most, once, only
  for a store with no marker yet).

## Round 3: a capacity soak on the smallest recommended box (D1075)

The question (the parent's): does a 2-core 12 GB box hold what docs/DEPLOY.md §6 and `deploy/scripts/sizing.py` say
(a heavy user 4.71 MB at the peak hour; 1,845 of them on 2 OCPU / 12 GB), over a half hour of real work with a
restart, without a leak? The instrument is new: `packages/sim/src/lab/soak.ts` (heavy users as `users.bench.ts
--prose --sources=20` makes them, 3,000 items over 20 connectors that generate their items on each listing, served
through `buildPartner` and `createHandler` with the encrypted disk, one process per core, sessions at exponential
intervals of mean 12 minutes so about a sixth of users are touched within the 2-minute warm bound, a SIGTERM and
restart halfway; every message and a 10-second RSS sample journaled as it lands). Requests go to the HTTP handler in
process (no socket): the latencies are Eden's own work. The cgroup: cpuset 0-1, CFS quota 200000/100000, memory 12
GiB (cgroup v1), as d1-scale-out.md §6. Main b3d8edc4 (round 2 merged). No model key.

**Run 1 (1,800 users), cut short.** Backfill 13.6 min (900 users a process through the real sync kick); 7.27 GB of RSS
in the two processes just after it (3.66 + 3.61 GB, read by hand with `ps`; not journaled), the cgroup's peak 10.6 GB
(`memory.max_usage_in_bytes`, page cache included, read by hand); 15 minutes of load with no error in its last window;
at the halfway SIGTERM one process reported writing 275 users in its 4.5 s budget (the other's report was lost: the
harness exited before its message was sent, fixed since); the container itself restarted six seconds after the processes
came back up. The cause is not known (the cgroup's own limit kills processes, not the machine); the orchestrator then
wrote its report only at the end, so the samples were lost. The harness now journals every message as it lands, and run
2 used 1,500 users for headroom on the 16 GB host.

**Run 2 (1,500 users, 30 minutes, restart at 15; `--users 1500 --procs 2 --minutes 30 --restart-at 15`).**

| | |
| --- | --- |
| Backfill | 10.9 min; RSS peak in it 7.58 GB |
| Requests in the load | 33,382 (the restart's own windows, 479 requests with 0 errors, are left out of the totals and the latencies); **0 errors** (no 5xx, no throw), 0 4xx |
| RSS, first half (90 samples) | mean 6.96 GB, p95 8.28, max 8.82, min 6.05; slope +29 MB/min (the collector's sawtooth spans 2.8 GB) |
| RSS, last 10 min of the second half (60 samples) | mean 6.60 GB, p95 8.29, max 8.47 (the last 5 min: 7.46, 8.36) |
| cgroup peak (RSS + page cache) | 9.66 GB (cache at most 1.40 GB) |
| A process before its users | 95 MB (the smaller of the two just after the restart; the other read 139 MB with a few users back: at most 0.03 MB a user) |
| Event (session start/end, tool call and result, pending) | p50 0.46 ms, p99 95.7 ms (first half 0.59 / 42.6; second 0.35 / 123.7) |
| User message (`waitMs` 0) | p50 4.86 ms, p99 15.1 ms |
| `ask_context` | p50 9.54 ms, p99 272 ms (first half 8.0 / 21.4; second half 13.0 / 304) |
| Restart | SIGTERM to up again 5.5 s; each process wrote 169 and 179 of its 750 users in its 4.5 s budget (~26 ms a user) |

**Sizing: agrees.** RSS a user = (RSS − 2 × 95 MB) / 1,500: **4.51 MB** on the first half's mean (sizing.py: 4.71,
GC-settled), 5.39 at its p95 and 5.75 at its max. Through sizing.py's formula (75% of 12 GB, 55 MB router, 130 MB a
process): 1,927 users on the mean (+4% against 1,845), 1,612 on the p95 (−13%); within the 15% bar either way, so
sizing.py and the docs stay. One caution for the docs: the collector's peaks sit about 22% above the settled figure,
so at 1,845 users the processes would reach about 10.8 GB at their peaks, most of the formula's 25% headroom (page
cache is reclaimable; no OOM was seen at 1,500).

**The restart: a full box loses most of its warm users (a finding for the parent; not changed, it needs an engine or a
deployment trade-off).** `ItemCache.flush` writes users oldest first until its deadline, 0.3 of the shutdown grace (4.5
s at the single-box compose file's 15 s; the node file has 20 s, the cluster files 10 s): 169 and 179 of 750 users a
process here, so about 77% of the users were not written and re-synced from their sources after the restart, each on
their next event (the sessions' 12-minute arrivals set the pace: all 750 back about 13 minutes after it; not a re-sync
throughput), at the cost of a backfill each. Latency held through it (user message p99 17 ms, ask p99 312 ms while users
re-synced; 0 errors). DEPLOY.md's restart figures (12 s with warm files, 200 users) do not scale to a full box at the
shipped grace. Two ways out, each the parent's call: a longer `EDEN_SHUTDOWN_GRACE_MS` (about 26 ms a heavy user a
process at 0.3 of the grace: 65 s for 750; requests wait or fail while the process writes, since its listener is closed
by then), or an engine change (write the most recently used users first, so those likely to return are kept; or write
warm users in the background before the shutdown, which D862 chose not to).

**Leak check: none (run 3; `--users 1000 --procs 2 --minutes 40 --restart-at 99 --gc-every 120`, the same cgroup).**
Each process ran a full collection every 2 minutes and read its heap and RSS after it, over 40 minutes of steady load
(no restart; 500 users a process, 382-457 of them warm at each reading). Heap after the collection: 1.69-1.71 GB a
process on average, least-squares slope **−3.2 and −3.0 MB a minute** (flat to falling; the first readings, from minute
9.3, two minutes after the backfill, rise to 1.89 GB under the load's warm-up and settle); RSS slope −1.3 and −6.0 MB a
minute. Settled RSS a user: (2,245 + 2,152 − 2 × 95) / 1,000 = **4.21 MB** (sizing.py: 4.71; the run's mix is about 13%
live, a little under the peak hour's sixth). 25,035 requests, **0 errors**; event p50 0.58 ms, p99 37.2; user message
4.54 / 9.58; `ask_context` 7.62 / 16.1. The reading pauses the process (each full collection), so this run's latencies
include them.

Reproduce (as root, cgroup v1; the soak's processes inherit the cgroup):

```bash
C=/sys/fs/cgroup; for g in memory cpuset cpu; do mkdir -p $C/$g/r1soak; done
echo $((12*1024**3)) > $C/memory/r1soak/memory.limit_in_bytes
echo 0-1 > $C/cpuset/r1soak/cpuset.cpus; echo 0 > $C/cpuset/r1soak/cpuset.mems
echo 200000 > $C/cpu/r1soak/cpu.cfs_quota_us; echo 100000 > $C/cpu/r1soak/cpu.cfs_period_us
sh -c 'for g in memory cpuset cpu; do echo $$ > /sys/fs/cgroup/$g/r1soak/cgroup.procs; done; exec env -u \
  OPENROUTER_API_KEY bun packages/sim/src/lab/soak.ts --users 1500 --minutes 30 --restart-at 15 --out .local/soak.json'
```
