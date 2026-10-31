# Moon track: telemetry, measuring every second of Eden

Track `telemetry`, branch `moon/telemetry`. It builds engine-wide span tracing, a run recorder and a report, and uses
them to find where Eden's time goes. Two optimisations came out of it and are measured below. No model call was
made and the live spend is $0. Every number here comes from a command run in this session on a 4-CPU machine shared
with six other agents. Timings are noisy, so overhead is given as interleaved A/B means of thread CPU time.

## What was built

**Spans (`packages/engine/src/spans.ts`).** A span is `{id, parent, name, startMs, endMs, cpuUs, attrs}`:

- `startMs` and `endMs` are epoch milliseconds from the monotonic clock.
- `cpuUs` is the engine thread's CPU, read with `process.threadCpuUsage` (Node 23.9+ and Bun), or the process's CPU
  where that is missing.
- `attrs` holds counts, connector ids, statuses, decisions and the session id that traces already carry.

Spans are content-free (D19): a test plants distinctive request and item words and item ids, and checks that none of
them reaches a span or the timeline file.

Spans are off by default. With them off the partner holds `spans: null`, and each phase's call site is one
optional-chained call on null. Arguments are not evaluated, so tracing costs nothing when off. Two things turn
spans on:

- an `onSpan(span)` sink in `PartnerDeps`. This is the API for other runners, such as the pi track's: import
  `Span` / `SpanSink` from `@eden/engine` and pass a sink;
- `config.spans: true`, which keeps per-phase totals (count, wall, CPU, and p50/p95/p99 from the primitives'
  `Histogram`) in at most 128 phase names, readable through `ContextPartner.spanStats()`.

These are the phases:

| Where | Spans |
|---|---|
| Event | `observe` (root: kind, session, turn, decision, delivered), `observe.prep` (redact and tokenize the event) |
| Fast path | `fast.rank`, `fast.confident`, then `deliver` |
| Slow path | `slow` (how it delivered), `route` (source map), `search` (fan-out outcome counts), `source.search` per call that reaches a connector (connector id, page size, error), `sanitize` (child of the call whose page it redacts), `cache.put`, `mentions` (source-map writes) |
| Probes | `probes`, `probe.<kind>` (calls), their own `source.search`, `orgs`, `probes.grace` |
| Ranking and delivery | `rank`, `conflict`, `confident`, `ground`, `fallback`, `judge.tied`, `judge.build` (input chars), `model` (tokens, cost, truncated), `judge.parse`, `deliver` (bytes), `fold`, `render` |
| Background | `refresh` with its `source.fetch` calls, `shadow` (planner shadow lookups); probes that outlive the lookup keep their parent |
| Ask | `ask` (root), then `search`, `rank`, `ground`, `render` and `model` as above |

A source call is traced by wrapping the lookup's `Source` objects in the partner, and only while spans are on. The
fan-out, the planner and `McpSource`'s read-only check are untouched (D7). Asynchronous spans (`attrs.async`) do not
read CPU, because their figure would include whatever ran meanwhile.

**Recorder (`packages/sim/src/lab/timeline.ts`).** `new Timeline(path, meta)` writes JSONL:

- one `meta` line;
- a span line per span, tagged with its lane (one engine instance);
- a task line per harness task;
- a trace line per decision (counts only);
- a sample line each second (CPU%, RSS, heap, spans);
- one `end` line (process CPU and engine-thread CPU).

`timeline.sink(lane)` and `timeline.traceSink(lane)` plug into a partner.

**Report (`packages/sim/src/lab/timeline-report.ts`).** For each phase it gives n, wall p50/p95/p99 and total wall,
plus self CPU and its share of the run's engine-thread CPU. It also gives:

- the critical path of each delivery: walking back from the delivery, the child that ended last, recursively;
- a per-second histogram;
- the slowest 20 tasks with their span trees.

**Wiring.** `hidden-funnel.ts` gains three options:

- `--timeline out.jsonl`;
- `--spans noop`, a sink that drops spans, for measuring overhead;
- `--serial`, which plays seeds one after another with the same results, so a task's wall time is its own.

With any of these, or `--cpu`, it prints the suites' process CPU and the tasks' engine-thread CPU to stderr.
`quality-cli.ts --timeline out.jsonl` records each simulated user's engine as a lane (`QualityOptions.spanSink`).

## Where the time goes

### In-sample funnel, no model

Command: H, suites hidden and held-out 1–4, seeds 41–44, `--serial --timeline`. The final code returns
148/268 hidden items, delivers 128/268 and delivers 21/268 decoys, at 8.5 calls per task. That is the same as H before
any change: all 536 per-task rows are identical apart from `ms`.

The run took 7.7 s wall. The engine thread used 7.5 s of CPU, and traced phases account for 18.5% of it. The rest is
the harness: building worlds and the simulated connectors' indexes was over half the CPU in a profile
(`bun --cpu-prof`: `SimIndex`, `fold`, `words`, `normalize`). Synchronous engine phases by self CPU:

| phase | n | wall p50 ms | p95 | p99 | self CPU s | share of thread CPU |
|---|---:|---:|---:|---:|---:|---:|
| ground | 444 | 0.56 | 1.77 | 2.91 | 0.347 | 4.6% |
| mentions | 994 | 0.21 | 0.57 | 0.98 | 0.272 | 3.6% |
| cache.put | 1,380 | 0.12 | 0.52 | 0.81 | 0.200 | 2.7% |
| sanitize | 1,731 | 0.06 | 0.24 | 0.39 | 0.169 | 2.3% |
| rank | 531 | 0.08 | 0.21 | 0.52 | 0.063 | 0.8% |
| confident | 531 | 0.00 | 0.30 | 0.73 | 0.057 | 0.8% |
| render | 310 | 0.13 | 0.25 | 0.42 | 0.053 | 0.7% |
| orgs | 531 | 0.03 | 0.21 | 0.43 | 0.040 | 0.5% |

The 310 deliveries took p50 3.58 ms and p95 10.32 ms from the start of the lookup. Their critical path splits like
this:

- `ground` 15.2%;
- in-process `source.search` 14.3%;
- untraced slow-path code and yields 11.8%;
- `search` 9.2%;
- `probe.second` 9.1%;
- `cache.put` 6.1%;
- `mentions` 5.8%.

With no source latency, the engine is CPU-bound in grounding, the cache and source-map writes, and redaction.

### Realistic real-time tier

Command: the `bench.ts --latency` shape (seed 41, 3 users × 6 sessions, `--planner --time 1`, perfect judge modelled
at 900 ms), H, `--timeline`.

The run took 384.9 s wall. Recall was 0.517 and precision 0.962. The quality report gives delivery p50 4,317 ms and p95
28,487 ms, and observe p50 0.30 ms. Another run before the tracer's final changes gave the same figures to within 1 ms.

The timeline shows how little of that delivery latency is the engine's:

- 18 proactive lookups delivered, at p50 1,627 ms and p95 3,119 ms from lookup start to delivery. Of their critical
  path, the judge (`model`) is 54.1% and connector calls are 37.5%.
- 132 asks answered, at p50 692 ms and p95 1,181 ms. Connector calls are 93.3% of their critical path.
- Over all 150 deliveries, connector calls are 80.0% and the model 12.9% of the critical path. The 100 ms probe grace
  is 2.8%, and every synchronous engine phase together is under 0.5%. `ground` is the largest of them at 0.1%.
- In a lookup's own search, the slowest connector answers on average 358 ms after the median one (169 searches with
  two or more calls). The lookup waits for all of them.

The quality report's 4.3 s and 28.5 s delivery figures count from the event to when the simulated integration next
collects pending injections. The harness collects them only after the agent's pacing wait: about 2.5 s after a user
message and about 20 s after an agent message. So most of the measured delivery latency is the integration's
polling interval, not the engine. The engine had the packet ready after about 0.7 s for an ask and 1.6 s for a judged
lookup (in-sample, one seed).

## Overhead of tracing

The thread CPU of the funnel's tasks (`--serial`) was compared across three arms: spans off, spans to a no-op sink,
and the full timeline recorder. The rounds were interleaved and the means are over 5 rounds.

| tracer version | off | no-op sink | timeline |
|---|---:|---:|---:|
| first version (CPU read on every span, a sanitize span per page, async source wrapper) | 2.042 s | 2.160 s (+5.8%) | 2.223 s (+8.9%) |
| final | 2.199 s | 2.177 s (−1.0%) | 2.209 s (+0.4%) |

The first version broke the 3% bar. A profile of the no-op arm showed `threadCpuUsage` alone at 246 ms: a CPU read
is a system call, about 0.3 µs in a tight loop but several µs under load. The final version makes three changes:

- an asynchronous span reads no CPU;
- an empty page gets no sanitize span, and an empty put no `cache.put` span;
- the source wrapper is one `then`, not an async frame.

The span count fell from 23,284 to 19,048. The final overhead is within run-to-run noise: the paired differences
against off range from −0.112 s to +0.070 s. The tracer alone costs 0.7–0.9 µs per span, measured in a micro-loop.

Thread CPU per span is reliable in aggregate, not for one span. In the mostly idle real-time run, many small spans
read 0 µs and a few read a whole tick. A process-wide `cpuUsage` would also count the runtime's GC and compiler
threads: in an allocation loop, the process read twice what the thread did.

## Optimisations

1. **`orgsOf`: linear address scan, and a denial-of-service fix (implemented).** The global regex that reads
   "Name <user@domain>" from probe results tried every position of a run of words and read to the end of the run:
   quadratic in the text.
   - Hostile item text (connector text is untrusted, and items are capped at 8 KB) blocked the event loop: 162 ms for
     6 KB of words ending in `dana@nodot`, 687 ms for 12 KB, and 1.66 s for 24 KB (direct call).
   - `addresses()` now runs the same regex once per "@" that can match, on the run before it (at most 512 characters)
     plus its domain. It first rejects, in O(1), an "@" with no local character before it or no `label.` after it.
   - The result is identical to the old regex on all 10,452 items of seven sim worlds and on 2,000 random strings,
     and 59 times faster on those items (3,728 → 63 ms).
   - Every hostile case in the test runs under 1 ms; the test bound is 50 ms. The only difference: words more than 512
     characters before an address are not read as beside it.
   - Measured: the `orgs` span went from 361 to 48 ms of CPU over the funnel (process CPU, in an earlier tracer
     version), with p95 1.78 → 0.23 ms. Interleaved A/B
     over 4 rounds, `--serial`: the tasks' thread CPU fell 2.325 → 2.171 s (−6.6%, lower in every round), with
     identical per-task results.
2. **Simulated connector index (implemented, lab only).** Each item's text is now normalized once for its words and
   its folded copy, and the title's words are read once.
   - Interleaved A/B over 3 rounds of the default (concurrent) funnel: suites CPU 11.52 → 10.98 s (−4.7%) and wall
     8.41 → 7.81 s (−7%). Results identical.
   - Not engine code. It makes every lab run cheaper.
3. **Tried and dropped** (no measured gain, so reverted):
   - a per-cue memo of conflict verdicts. Each item is assessed about once per lookup, so the memo had nothing to save;
   - a per-item memo of the text `assess` compacts. The `ground` CPU did not move beyond noise: 0.50 → 0.53 s.
4. **Opportunities measured but not implemented**, ranked by the time they would recover:
   - **Push, not poll.** The integration collects injections at the agent's next event, and that costs seconds:
     4.3 s against about 0.7–1.6 s engine-ready (real-time tier). A push channel would remove the gap, either an
     `onInjection` callback or the server streaming injections. This is an integration change, not engine CPU.
   - **The slowest connector.** A lookup waits for every source it searched: on average 358 ms from the median
     connector to the slowest. Ranking what has arrived at a per-lookup quantile deadline, and caching the stragglers
     for the next turn, would cut the tail. This changes behaviour and needs a flag and recall measurements.
   - **The judge.** The judge is 54% of a judged lookup's critical path at the modelled 900 ms. Live latency is in
     D47's notes. This is the model's own speed; `judgeTied` already skips untied calls.
   - **Probe grace.** 100 ms on every probe lookup is 2.8% of the real-time critical path. A grace shaped to the
     probes' expected finish could recover some of it.
   - **CPU in the no-latency funnel.** The engine CPU there is in grounding, mentions and the cache put. `mentions`
     (entity extraction and SQLite writes) sits on the critical path. It cannot simply be deferred, because the `org`
     probe routes on the mentions just written.

## Checks

- `bun run check` is green.
- `bun run eval` JSON equals the base apart from latency fields: 95 lines, the 3 latency lines excluded.
- The realistic simulation with H gives the brief's numbers on the final code:
  - no model: recall 0.407, precision 0.639, soft fire rate 0.086;
  - perfect judge: recall 0.645, precision 0.952, 7.78 calls per lookup, 432 bytes per needed fact, 0.213 model calls
    per turn.
- No hard false fire.
- The funnel matches H: 148/128/21 at 8.5 calls per task.

Fixed along the way: a date-dependent test in `partner.test.ts`. Its items expired against the wall clock 24 hours
after 2026-10-30T03:00Z, so it failed on `main` from 2026-10-31. It now uses the event's clock.

Not done: anything live (cap $0), and the blind suites.
