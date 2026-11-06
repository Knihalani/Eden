# RealUse-1 part E: speed and scale (tier T4)

Status: measured 2026-11-06 on branch `claude/realuse1-e-perf` (main at 957b82a9 plus the RealUse-1 design and this
part's two lab fixes, below). Design: [benchmark-realuse-1.md](../benchmark-realuse-1.md), tier T4. Compact results:
`packages/sim/lab/realuse-1/E/results.json` (the figures below per run, with the command, wall time and the load
average before each run; the concurrent probe's per-event stall lines are in this text only). No engine behaviour
was changed.

## What this says, in plain words

- **One event costs Eden about a millisecond of CPU, and the agent waits for a fraction of that.** Through the real
  partner with instant sources, `observe` takes 0.16 ms at the median and 4.1 ms at p99; over HTTP against the real
  server with simulated connectors it takes 1.2 ms at the median and 9 ms at p99, at real pacing, through connector
  outages, slowdowns and throttling, and over a simulated day, with no request failing open.
- **A 4-core box serves 3,200–3,800 events per second inside a 100 ms p99** with the shipped router over four
  children (simulated connectors, sync on). One process holds 450 (realistic connectors) to 1,060 (hosted) events/s
  inside that tail, and about 460 events/s on the HTTP ramp's mix; past saturation the client fails open at its
  800 ms bound instead of blocking the agent.
- **Memory, not CPU, decides how many users one machine holds.** A synced user costs about 2 MB of heap per 500 items
  (4.0–4.2 KB an item) in the shipped mode, and a server process grows about 1.5–2.1 MB of RSS per active user plus
  about 400 MB of its own. By arithmetic on those figures (section 6), a 4-core 16 GB machine holds roughly
  5,000–7,400 active users and a 16-core 64 GB machine 20,000–29,600, while their CPU would carry 3–6 times as
  many.
- **The reader, Eden's one per-ask model call, answers in about 1.1 s at the median and 1.5 s at p90** (first token
  after 0.46 s), for about $0.0003 a call, with 2 calls in 180 past the engine's 2.5 s wait (Haiku 5.5 on the
  Anthropic API directly, a lab transport: the servers ship it through OpenRouter). The effort-"low" arm D144 rejected
  stays 2.7x slower.
- **The dev loop:** `bun run check` takes about 36 s warm (54 s with a cold type-check cache), `bun run test:changed`
  after a one-line engine edit 24 s, and `bun run funnel --jobs 4` 12 s.

Two lab tools were broken and are fixed here (router-sim's ladder stop rule, a test that timed out under the parallel
run). One bench result looks like a bug and is not: the concurrent bench's 0.9 s tail is one saturated event loop
(section 2), which is what the multi-process router is for.

## Machine and method

| | |
|---|---|
| CPU | 4 vCPU, Intel Xeon @ 2.10 GHz (`nproc` 4), cloud container, not shared with other sessions during the runs |
| Memory | 15 GiB |
| Kernel | Linux 6.18.44 |
| Bun | 1.4.4 |
| Load average before each run | 0.0–2.2 for the benches, except 6.6 before the realistic router-sim re-run (it followed `bun run check`, whose 4x parallel tests reach 10; the bench settles 75 s before measuring); 0.2–10 before the dev-loop runs, which ran back to back (section 7) |

Every command ran with `OPENROUTER_API_KEY` and `BUN_OPTIONS` unset (this container set `BUN_OPTIONS=--smol`), one at a
time, from the repository root. Each was run three times and is reported as **median (min–max)**. The benches that
repeat internally (`router.bench.ts`, `router-sim.bench.ts`: three repetitions per arm, arms alternating, D172) report
their own medians; `router.bench.ts` was also run three times over. Exact commands are under each table.

## 1. Per-event fast path (`pipeline.bench.ts`)

`bun packages/engine/bench/pipeline.bench.ts` — 6,000 items over 4 instant sources, 2,000 events, one session stream,
the first 20 events reported apart (JIT, session set-up).

| Measure | Median (min–max) |
|---|---|
| `observe` p50 (fast path, waitMs 0) | 161 µs (140–185) |
| `observe` p99 | 4,120 µs (4,033–5,771) |
| slow path per event p99 | 3,255 µs (2,580–4,058) |
| event-loop lag p50 / p99 | 662 µs (650–821) / 7,797 µs (7,381–10,771) |
| CPU per event, whole run | 1.006 ms (0.938–1.198) |
| first event (cold) | 46.1 ms (38.7–62.4) |

Meaning: the agent's wait on an event is a fraction of a millisecond at the median; Eden's whole cost per event,
background work included, is about a millisecond of one core.

## 2. Ingest and memory

### Ingest (`ingest.bench.ts`, 200 users × 500 items)

`bun packages/engine/bench/ingest.bench.ts` (workload text, 1,599 chars an item) and
`bun packages/engine/bench/ingest.bench.ts --world` (the sim world's text, 1,091 chars an item). Each runs three modes
in separate processes; `shipped` is what the servers run (a `ContextPartner` on `DEFAULT_CONFIG`, no model).

| Mode | Backfill µs/item | Unchanged sweep µs/item | Held B/item | Released B/item |
|---|---|---|---|---|
| workload, `core` | 105.9 (101.8–124.9) | 3.6 (3.5–7.2) | 3,304 (3,304–3,304) | 1,921 (1,921–1,921) |
| workload, `graph` | 185.0 (184.2–195.1) | 4.4 (4.0–8.3) | 4,011 (4,001–4,011) | 2,631 (2,621–2,631) |
| workload, **`shipped`** | **294.5 (288.4–305.8)** | **4.0 (3.8–4.0)** | **4,015 (4,015–4,016)** | **2,635 (2,635–2,635)** |
| `--world`, `core` | 82.6 (81.9–85.1) | 3.9 (3.9–3.9) | 3,509 (3,509–3,510) | 1,693 (1,693–1,847) |
| `--world`, `graph` | 150.0 (143.3–154.6) | 4.5 (4.2–5.5) | 4,173 (4,165–4,186) | 2,374 (2,365–2,377) |
| `--world`, **`shipped`** | **245.8 (229.4–246.8)** | **5.3 (4.8–7.1)** | **4,197 (4,188–4,197)** | **2,377 (2,368–2,378)** |

"Held" is the heap after the backfill with the sources' raw items still alive; "released" is with them dropped, the
cache's own share. **Memory per synced user** at 500 items, shipped: 1,960 KB (workload) and 2,049 KB (world) held. At
the sync cap (`syncMaxItems` 3,000) that would be about 11.5–12.0 MB (linear arithmetic, not measured). Wall time
61–66 s (workload), 49–52 s (world) a run.

Meaning: backfilling a new user costs about 0.3 ms of CPU per item (2.5–3x the bare cache: the graph and the
mention recording); keeping that user current costs 4–5 µs per unchanged item per sweep.

### Index memory (`index-memory.bench.ts`)

`bun packages/engine/bench/index-memory.bench.ts` (6,892 sim items, ~1 KB each).

| Measure | Median (min–max) |
|---|---|
| packed index, 1 user × 6,892 items | 415 B/item (identical in 3 runs) |
| packed index, 500 users × 20 items | 922 B/item (identical) |
| whole `ItemCache`, 1 × 6,892, after an expiry tick | 1,632 B/item (identical) |
| search p50 / p99 at 6,892 items | 133 µs (125–138) / 372 µs (187–409) |
| churn at 6,892, worst step | 2.8 ms (2.7–13.0) |

### Concurrent, put and churn

`bun packages/engine/bench/concurrent.bench.ts` (400 events/s open loop over 200 users for 8 s, sources 50–250 ms),
`bun packages/engine/bench/put.bench.ts`, `bun packages/engine/bench/churn.bench.ts`.

| Bench | Measure | Median (min–max) |
|---|---|---|
| concurrent | `observe` p50 | 7.65 ms (6.07–12.77) |
| concurrent | `observe` p99 | 887 ms (826–960) |
| concurrent | event-loop lag p99 | 11.7 ms (11.4–11.8) |
| concurrent | process CPU | 106% (all three) |
| put | redaction (`sanitizeForStore`) mean | 22.5 µs (21.3–23.3) |
| put | tokenize mean | 9.5 µs (8.8–9.8) |
| put | index add + remove mean | 15.3 µs (14.9–18.3) |
| put | entity extraction mean | 33.9 µs (32.4–34.6) |
| churn | worst put, `releaseTerms` off / on | 216 ms (201–254) / 6.3 ms (5.7–8.8) |
| churn | put p99, on | 2.9 ms (2.9–4.0) |
| churn | churned heap / fresh build, on | 1.08x (all three) |
| churn | `expireIdle` over 1,000 users p50 | 0.19 ms (0.17–0.26) |

**The concurrent bench's 0.9 s `observe` p99 is a saturated event loop, not a broken bench.** Every run shows one stall
of 0.7–2.5 s (lag max 1.8–2.5 s) that every in-flight `observe` waits out together: in one probe run events
1,169–1,208 all finished 941–980 ms after they were sent. The 1 ms lag probe records one sample per stall, so its
p99 (about 9 ms) hides it; its max does not. The process runs at 95–109% of one core from 200 events/s up: 200 users'
first lookups store their results (redaction, tokenizing, the graph, mention recording: `store` was 40% of the CPU
profile) and the fast path ranks and renders on the same thread. Stepping the open-loop rate (three runs each,
`bun packages/engine/bench/concurrent.bench.ts <rate>`):

| Events/s | `observe` p50 | `observe` p99 | Process CPU |
|---|---|---|---|
| 200 | 4.29 ms (3.62–5.30) | 35.4 ms (33.6–40.0) | 98% (95–99) |
| 300 | 4.11 ms (3.59–6.02) | 606 ms (565–645) | 97% (97–98) |
| 350 | 7.51 ms (4.33–7.74) | 872 ms (619–926) | 102% (100–106) |
| 400 | 6.78 ms (5.58–10.30) | 707 ms (701–735) | 107% (106–109) |
| 400, redaction in a 2-worker pool (`... 400 8 2`) | 4.61 ms (2.15–5.72) | 908 ms (528–931) | 102% (101–106) |

So one process holds about 200–300 events/s of cold-start-heavy load inside a tight tail, and taking redaction off the
loop (D25) does not move it. What does is more processes: the router (D163, D178), section 3. This is a measurement,
not a change: no engine code was touched.

## 3. Server throughput

### `router.bench.ts` (one in-process 400-doc StaticSource)

`bun packages/server/bench/router.bench.ts` (4 children, 5 s steps, p99 target 100 ms, 400 users, 3 repetitions per
arm), run three times; each run took about 650 s.

| Run | One process | Router over 1 | Router over 4 | Ratio 4/1 median (lowest) | Hop ratio |
|---|---|---|---|---|---|
| 1 | 1,145 (953–1,170) | 1,057 (995–1,137) | 3,127 (3,124–3,362) | 2.73 (2.67) | 0.97 |
| 2 | 1,155 (1,139–1,194) | 1,134 (1,091–1,143) | 3,864 (3,572–3,885) | 3.24 (3.14) | 0.96 |
| 3 | 1,146 (1,015–1,153) | 1,102 (1,047–1,154) | 3,573 (3,314–3,795) | 3.29 (2.89) | 0.96 |
| **median of runs** | **1,146** | **1,102** | **3,573** | **3.24** | **0.96** |

Events/s at p99 ≤ 100 ms. All three runs meet D172 (median ratio ≥ 1.5, lowest ≥ 1.2). The hop (router over one
child) costs about 4%.

### `router-sim.bench.ts` (shipped wiring on simulated connectors, sync on)

`env -u BUN_OPTIONS bun packages/sim/src/lab/router-sim.bench.ts --children 4 --seconds 5 --reps 3 --profile <p>`,
4 = `nproc`. Every server process runs `buildPartner` (the default, sync timer on, no model key) over per-user
`SimSource` connectors at time scale 1. RSS is per server process; each process also holds 8 sim worlds (about 490 MB
at start), so the Eden share is the growth.

Events/s at p99 ≤ 100 ms, median (min–max) of 3 repetitions per arm. "Before" ran the old ladder rule, "after" the
fixed one (see Fixes); the after rows are the ones to quote. The fix changes no figure in the after runs (replaying
the old rule on their steps picks the same best step in all 18 arm-repetitions), so before/after differences other
than the 54 are run-to-run noise; the realistic re-run also started at load 6.6 against 1.5.

| Profile, rule | One process | Router over 1 | Router over 4 | Ratio 4/1 median (lowest) | Hop ratios | D172 |
|---|---|---|---|---|---|---|
| realistic, before | 396 (309–406) | 362 (325–391) | 3,663 (**54**–3,808) | 9.02 (0.17) | 0.96, 0.82, 1.17 | not met (the 54) |
| **realistic, after** | **452 (413–455)** | **390 (376–478)** | **3,819 (3,566–3,950)** | **8.68 (7.90)** | 1.05, 0.94, 0.83 | met |
| hosted, before | 1,029 (1,004–1,029) | 984 (933–997) | 3,164 (2,865–3,234) | 3.14 (2.78) | 0.91, 0.98, 0.97 | met |
| **hosted, after** | **1,056 (991–1,100)** | **1,062 (997–1,091)** | **3,210 (3,016–3,522)** | **3.04 (2.92)** | 1.01, 1.01, 0.99 | met |

Memory per server process, after the fix (median over repetitions; users per process from the stats files):

| Profile | Arm | Users per process | RSS at start (worlds built) | RSS at end | Growth | Growth per user |
|---|---|---|---|---|---|---|
| realistic | one process | 400 | 490 MB | 1,740 MB | 1,248 MB | 3.1 MB |
| realistic | router×4, each child | 100 | 489 MB | 1,108 MB | 613 MB | 6.1 MB |
| hosted | one process | 400 | 496 MB | 1,459 MB | 964 MB | 2.4 MB |
| hosted | router×4, each child | 100 | 489 MB | 1,022 MB | 529 MB | 5.3 MB |

Fitting both arms to `fixed + users × per-user` (one process: 400 users; a child: 100) gives a per-user growth of
2.1 MB (realistic: (1,248 − 613) / 300) and 1.45 MB (hosted: (964 − 529) / 300), and a fixed growth per process of
about 400 MB (realistic) and 385 MB (hosted). The one-process arm's growth over 400 (3.1 and 2.4 MB) includes that
fixed part, so it is an upper bound per user. RSS is read
without a forced GC, so it includes garbage not yet collected. The users are synced only as far as the run got
(2,346 sync lists over 400 users × 5 sources by the end of the router×4 settle), not to their whole world.

Meaning: on a 4-core box the shipped router serves 3,200–3,800 events/s inside a 100 ms p99. With realistic
connectors one process is held to about 450 events/s by its tail, not its CPU (its sync ticks and slow paths share
one event loop); spreading users over four processes multiplies that by 8.7, more than the core count. The router's
own hop is within noise here (median hop ratio 0.94–1.01; single repetitions 0.83–1.05).

## 4. HTTP end to end (`bun run sim:perf`)

`bun packages/sim/src/perf-cli.ts <scenario>` (what `bun run sim:perf` runs; it defaults to `steady`), every scenario,
three runs each. The server is `packages/sim/src/server.ts` in its own process: one process (no router), 20 worlds,
10 tenants, `realistic` connectors, no model.

**Caveat:** that server builds a bare `ContextPartner` and never calls `startSync()` (only `buildPartner` does), so its
users are not backfilled by the sync timer: their caches hold lookup results only. Its memory figures are therefore far
below a synced user's (section 2 and router-sim are the shipped-wiring figures). Not changed here: it is a scenario
choice, and changing it would break comparison with every earlier `sim:perf` figure.

| Scenario | What | Result, median (min–max) |
|---|---|---|
| cold | server start-up / spawn to listening | 2,839 ms (2,810–2,844) / 2,975 ms (2,971–2,977) |
| cold | first request; first lookup, cold user; again, same user; another cold user | 198 (188–234); 921 (917–937); 812 (365–815); 359 (356–539) ms (with simulated source latency, waitMs 5,000) |
| steady | 300 users, real pacing, 90 s | 39.2 events/s (39.1–39.2); `observe` p50 1.20 ms (1.19–1.21), p99 9.21 ms (7.77–10.97); ask p50 562 ms (554–587), p99 1,504 ms (1,504–1,509); failed open 0; server CPU 20% (19.6–20.2), RSS 1,162 MB (1,154–1,162), lag p99 4.9 ms |
| ramp | 10x pacing, users doubling, 20 s a step | see the table below |
| memory | heap per user, users warmed 250 → ~1,980 (forced GC) | 0.038 MB/user (0.037–0.039) heap; RSS slope 0.004 MB/user (0–0.016): unsynced users (caveat) |
| faults | 300 users; Gmail down 30 s, Drive 5x slower 30 s, CRM at 0.2 req/s 30 s | 36.1 events/s; `observe` p99 7.42 ms (6.28–8.02); worst 5 s window p99 in any fault phase 21 ms; failed open 0 in every run and window |
| hot | 2,400 users at 10x pacing (deliberate overload, for profiling) | 1,011 events/s offered; `observe` p50 800 ms (the client's bound); failed open 79% (77–80%); server CPU 118%, lag p99 1.3 s (1.0–2.1) |
| soak | 300 users, 10 min, server clock at 144x (a simulated day) | 32.6 events/s; `observe` p99 7.87 ms (7.64–8.30); failed open 0; heap 768 → 922 MB (760–778 → 914–931), growth slowing from 33 to 2–3 MB a minute |

Ramp (10x pacing and source latency, so each user sends about ten times real traffic):

| Users | Events/s | `observe` p50 | `observe` p99 | Failed open | Server CPU | RSS MB |
|---|---|---|---|---|---|---|
| 100 | 114.9 (114.7–115.4) | 1.16 (1.13–1.41) | 13.7 (10.1–16.5) | 0 | 45% | 1,118 |
| 200 | 230.1 (230.0–231.0) | 1.20 (1.16–1.22) | 12.4 (10.8–14.2) | 0 | 54% | 1,288 |
| 400 | 459.8 (459.0–460.2) | 2.77 (2.49–2.91) | 49.5 (45.6–63.3) | 0 | 88% | 1,663 |
| 800 | 644.3 (644.2–656.9) | 150 (148–171) | 560 (494–592) | 0 | 115% | 1,903 |
| 1,600 | 717.2 (712.3–724.3) | 746 (713–759) | 802 (801–803) | 34% (25–36%) | 116% | 2,168 |

The ramp stops at 1,600 users (the scenario's 3,200 step is not reached in its time budget). One process keeps p99
under 100 ms up to about 460 events/s of this mix; past saturation the client fails open at its bound (800 ms) rather
than block the agent, as designed (D17's fail-open edge).

Meaning: at real pacing a user sends about 0.13 events/s (39.2 events/s from 300 users), and the agent's wait per
event stays near a millisecond at the median and under 11 ms at p99 through outages, throttling and a simulated day.

## 5. Reader latency and cost, live (Anthropic-direct)

`bun packages/sim/src/lab/reader-time.ts --pools .local/realuse1-e/pools.jsonl --calls 60 --spend-ledger
.local/ledger.jsonl --spend-cap 1 --run-label realuse1-e-reader-time-<i> --json .local/realuse1-e/reader-time.<i>.json`,
three runs (`claude-haiku-5-5`, `HAIKU_API_KEY`). The pools are the engine's own at the default (`askReaderPool` 15,
mean 14.9 items, 7,658 prompt characters), logged at $0 by `bun run funnel --jobs 4 -- --reader-log
.local/realuse1-e/pools.jsonl`. Each pool is read once per arm, arms alternating: **off** is the shipped request (no
reasoning field, D144); **low** is the rejected effort-"low" arm, kept as a reference. Anthropic-direct with the lab's
prompt cache on the system block: a lab transport (D97), not the OpenRouter route the servers ship (D12, D145).

| Arm | p50 | p90 | TTFT p50 | Past the 2,500 ms wait | Input tokens (cached) | Output tokens | $ per call |
|---|---|---|---|---|---|---|---|
| **off (shipped)** | **1,123 ms (1,081–1,140)** | **1,485 ms (1,390–1,515)** | **463 ms (435–470)** | **1, 1, 0 of 60** | **2,872 (929–945)** | **169 (169–184)** | **$0.000287 (0.000286–0.000296)** |
| low (reference) | 3,001 ms (2,812–3,095) | 4,292 ms (4,192–4,387) | 2,607 ms (2,483–2,624) | 34, 41, 38 of 60 | 2,873 (930–946) | 516 (505–541) | $0.000460 (0.000456–0.000473) |

No call failed; every reply parsed (180 of 180 per arm). The two arms flagged the same items on 45 of 60 pools in
run 1 (a screen of agreement, not quality: the pools carry no labels). Spend: 360 calls, **$0.1355** in all
(`.local/ledger.jsonl`, against the $1 cap).

Meaning: when the reader runs, it adds about 1.1 s to an ask at the median and 1.5 s at p90, inside the engine's
2.5 s wait almost always, for about three hundredths of a cent; 1,000 asks that reach the reader cost about $0.29.

## 6. Users per machine (arithmetic on the measured figures, not a measurement)

Inputs, all measured above:

- events per active user at real pacing: 39.2 events/s / 300 users = **0.131 events/s** (`sim:perf steady`, median);
- 4-core capacity inside a 100 ms p99, shipped router over 4 children: **3,210–3,819 events/s** (router-sim after
  the fix, hosted and realistic medians; `router.bench.ts` gives 3,573);
- memory: **1.45–2.1 MB RSS per active user** plus **385–400 MB of fixed growth per server process** (router-sim,
  the two-arm fit in section 3, hosted and realistic); and, from ingest, **2.0 MB of heap per synced user at 500 items**
  (about 12 MB at the 3,000-item sync cap, linear arithmetic).

Assumptions (labelled): 16 GB of RAM on the 4-core machine and 64 GB on the 16-core one; 25% of RAM kept free (GC
headroom, OS, the runtime's own base, which these benches do not separate from the sim worlds); one server process per
core; throughput scales linearly from 4 to 16 cores (only 4 were measured); every user counted is active, with the
router-sim users' partial sync (section 3).

| Machine | CPU-bound: capacity / 0.131 | Memory-bound: (0.75 × RAM − cores × fixed) / MB per user | Binds |
|---|---|---|---|
| 4 cores, 16 GB | 3,210–3,819 / 0.131 ≈ **24,500–29,000** | (12,288 − 4 × 400) / 2.1 ≈ 5,090; (12,288 − 4 × 385) / 1.45 ≈ 7,410: **5,100–7,400** | memory |
| 16 cores, 64 GB | 4 × that ≈ 98,000–117,000 (assumed linear) | (49,152 − 16 × 400) / 2.1 ≈ 20,400; (49,152 − 16 × 385) / 1.45 ≈ 29,650: **20,000–29,600** | memory |

With the conservative per-user figure (the one-process arm's whole growth over 400 users, 2.4–3.1 MB, and no fixed
part) the 4-core machine holds 4,000–5,100 users. If every user were synced to the 3,000-item cap (~12 MB of heap
each), it would hold about 900 users and the 16-core one about 3,600. Either way memory binds 3–6x before CPU, so a
deployment sizes by RAM per synced user; the CPU figures say how much headroom bursts and backfills have.

## 7. Dev loop

| Command | Wall time, median (min–max) | Notes |
|---|---|---|
| `bun run check` | 36.4 s (35.5–53.9) | 1,791 tests in 146 files; the 53.9 s run was the first, with a cold type-check cache; the median run is the one that failed one test (below; its wall time is a full run's); load 0.2, 4.0, 6.5 before the three runs |
| `bun run test:changed` after a one-line engine edit (a comment appended to `packages/engine/src/text.ts`, reverted) | 23.9 s (23.6–24.0) | engine and its dependents: 1,149 tests in 98 files, one end-to-end file deferred (D161); load 7.8–10 before (right after the checks) |
| `bun run funnel --jobs 4` | 11.8 s (11.5–12.1) | train, 12 shards in 4 processes, reader stub; identical TOTAL lines in all three runs |

The second `bun run check` failed one test: `cards-disk.test.ts` "the checked-in file covers held-out 13's items" took
5,410 ms against bun's default 5 s timeout under the 4x parallel run. It builds and lists four worlds; run alone,
the whole file (12 tests) takes 1.5–2.4 s (three runs), so the failure is contention, not a slow test.
It now has its own 30 s timeout with the reason, as the RE2 test got for the same contention (docs/TESTING.md).

## Fixes made in this part

1. **`router-sim.bench.ts` stopped its ladder on one noisy step.** With sync on, a 5 s step can coincide with the
   sync timer's minute tick; one step past twice the p99 target ended the arm. In the first realistic run a router×4
   repetition settled at 1,336 events/s, ran C=1 at 54 events/s, then stopped at C=2 (66 events/s, p99 205 ms),
   against 3,663 and 3,808 in its other repetitions, pulling the lowest ratio to 0.17. The rule is now
   `ladderStops` in `router-sim.ts` (stop on two steps in a row past twice the target), with a test; a step over the
   target still never counts towards a figure. Both profiles were re-run with the fix; the first runs are kept above
   as "before". The fix reduces this failure rather than removes it: in every realistic router×4 repetition the steps
   after the settle run slow (C=1 at 54–84 events/s against 1,330–1,569 during the settle, recovering near C=16,
   about 35 s in), so two slow steps in a row could still end an arm early. A fuller fix (later) would re-run or skip
   a step during which the processes' sync-list counters rose, or start the ladder once they stop rising.
   `packages/server/bench/router.bench.ts` keeps the old rule: it has no background sync, and its three runs show no
   such collapse.
2. **`cards-disk.test.ts`'s coverage test got its own timeout** (section 7).

Both are lab or test code; nothing in `packages/engine`, `server` or `client` changed.

## Reproduce

```bash
bun install --frozen-lockfile
unset BUN_OPTIONS OPENROUTER_API_KEY
bun packages/engine/bench/pipeline.bench.ts
bun packages/engine/bench/ingest.bench.ts && bun packages/engine/bench/ingest.bench.ts --world
bun packages/engine/bench/index-memory.bench.ts
bun packages/engine/bench/concurrent.bench.ts   # also with a rate: 200, 300, 350; and `400 8 2` (gate pool)
bun packages/engine/bench/put.bench.ts; bun packages/engine/bench/churn.bench.ts
bun packages/server/bench/router.bench.ts
bun packages/sim/src/lab/router-sim.bench.ts --children "$(nproc)" --seconds 5 --reps 3 --profile realistic
bun packages/sim/src/lab/router-sim.bench.ts --children "$(nproc)" --seconds 5 --reps 3 --profile hosted
for s in cold steady ramp memory faults hot soak; do bun packages/sim/src/perf-cli.ts $s; done
bun run funnel --jobs 4 -- --reader-log .local/realuse1-e/pools.jsonl
bun packages/sim/src/lab/reader-time.ts --pools .local/realuse1-e/pools.jsonl --calls 60 \
  --spend-ledger .local/ledger.jsonl --spend-cap 1 --run-label realuse1-e-reader-time-1 \
  --json .local/realuse1-e/reader-time.1.json
time bun run check; time bun run test:changed; time bun run funnel --jobs 4
```
