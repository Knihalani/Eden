# Fix session S4: connector calls, ask citations and 429 wording (RealUse-1 weak points 5, 8, 9)

Status: 2026-11-07. Branch `claude/fix-s4-connectors`. Plan: [realuse-1-weak-points.md](realuse-1-weak-points.md).
Decisions D210–D214. Every number below comes from a command run in this session. The paid run is Anthropic-direct
Haiku 5.5 through the lab provider, a lab transport (D97), not the shipped OpenRouter route. Summaries and scripts
are in [`packages/sim/lab/fix-s4/`](../../packages/sim/lab/fix-s4/). Paid spend: **$0.4767** (ledger
`.local/ledger.jsonl`, labels `s4-pi-41` and `s4-pi-42`; agent $0.177, reader $0.214, cards $0.044, grader $0.042).

## Outcomes

| Issue | Change | Shipped how | Result |
|---|---|---|---|
| 5 | Payload notices are the documented default: `client.sourceChanged(sourceId, { items, removed })` | D210, a client and docs change | 23% fewer connector calls per session than bare signals in the sim; no re-reads |
| 5 | A per-(user, source) poll window (`syncCoalesceMs`) | Trial D213, **deleted** | No call saving in any harness |
| 5 | Per-source recency caps (`syncMaxAgeDays`, `syncMaxAgeBySource`) | Trial D214, **deleted** | Background listings down; no gain on Pi; the setting that works is fitted to the sim |
| 8 | An ask leaves out a doubted citation that no re-read confirmed, and names it | D211, bug fix | Deleted items cited under signals: 1 → 0 |
| 9 | A connector's 429 is `throttled` in the fan-out and "rate-limited" in the ask | D212, wording fix | 1,064 of 1,064 rate-limited asks now say so (0 before) |

## Issue 8: an ask cited a deleted item

The plan expected the ask to skip `verifyItems`. It does not skip it: the ask has always re-read its doubted citations.
Instrumenting the freshness run located the one bad citation:

- the item was `gmail:mail-31`;
- it was doubted, and its re-read settled `"failed"` (a transient sim connector error);
- D126 keeps a failed re-read "as held", so the ask cited the deleted copy.

The fix applies to asks only:

- A re-read that fails with a plain error is tried once more.
- A doubted item still not confirmed is left out, and the answer names it ("Left out items from gmail (1) that changed
  at the source and could not be re-checked"). An answer that would otherwise be empty is never worded as an
  all-clear.
- A source with no fetch tool, or one whose null proves nothing (MCP), is still cited as held. Such a source answers
  the same way every time, so leaving its items out would remove all of its doubted items from every ask.
- Proactive deliveries keep D126's rule. The ask's answer is what the agent takes as the sources' current word.

To support this, `fetchChecked`'s failure now says why (`no-fetch`, `refused`, `aborted`, `error`, `timeout`,
`throttled`, `null`, `gate`).

**Freshness matrix** (part D's T3: `quality-cli.ts --users 8 --sessions 20 --updates 0.6 --deletes 0.05 --jobs 4
--push P`, plus signals with `verifyDelivery` off). Stale and deleted counts are delivered / cited.

| Push | Stale / updated delivered | Deleted delivered / cited | Re-reads | Precision | Recall | Ask recall@5 |
|---|---:|---:|---:|---:|---:|---:|
| none | 7 / 46 | 7 / 12 | 0 | 0.574 | 0.460 | 0.847 |
| signals, before | 1 / 43 | 0 / **1** | 575 | 0.588 | 0.454 | 0.836 |
| signals, after | 1 / 43 | 0 / **0** | 579 | 0.588 | 0.454 | 0.836 |
| payload | 1 / 38 | 0 / 0 | 0 | 0.581 | 0.442 | 0.836 |
| signals, `verifyDelivery` off | 7 / 44 | 7 / 12 | 0 | 0.576 | 0.460 | 0.847 |

- The fix costs 4 retried re-reads in 1,210 turns.
- The none, payload and verify-off rows match part D's.
- False fires are 2 of 253 in every row.

Tests: `packages/engine/src/ask-verify.test.ts` has six fix tests (four failed before the fix: a transient failure,
a persistent failure, a 429, and a doubted item still present) and two 429-wording tests. `freshness.test.ts`'s ask
case is split into the null case (cited as held) and the failed-re-read case (left out and named, still delivered
unasked).

## Issue 9: a 429 read as "failed"

- `SourceFanout` reports a search or listing whose error matches its rate-limit pattern as `throttled`. Unlike our own
  `limited`, a throttled call reached the source: `reachedSource` is true, the breaker counts it, and our rate limit
  is pushed back as before.
- `honestAnswer` words both statuses "rate-limited".
- The sync backs off a throttled listing as it does an error.

**Ask-honesty probe** (`bun packages/sim/lab/realuse-1/D/probes/ask-honesty-probe.ts --users 8`, 360 asks a profile).
The probe gained two columns: asks with a rate-limited source, and those whose text says "rate-limited". It ran on
main (a worktree) and on this branch.

| Profile | Honest, main → branch | False all-clear | Rate-limited asks saying so, main → branch | Statuses on the branch |
|---|---|---:|---|---|
| healthy, 10%/30% errors, Gmail down, Gmail+Calendar down, all down | identical | 0 | — | identical |
| 1 req/s | 351/351 → 352/352 | 0 | 0/0 → 349/349 | throttled 1,048, ok 731, timeout 12, busy 8, error 1 |
| 0.2 req/s | 358/358 → 358/358 | 0 | 0/0 → 358/358 | throttled 1,527, ok 227, busy 36, timeout 9, error 1 |
| 0.2 req/s, 10% errors | 357/357 → 359/359 | 0 | 0/0 → 357/357 | throttled 1,535, ok 196, error 29, busy 32, timeout 8 |

- Example answer: "Could not reach crm (rate-limited), calendar (rate-limited), drive (rate-limited): this answer may
  be missing what they hold."
- The rate rows run in compressed real time (`--time 0.05`), so recall@5 moves from run to run (0.472 vs 0.506 at
  1 req/s).

## Issue 5: connector calls

### Payload notices (D210)

- `client.sourceChanged(sourceId, { items, removed })` posts the items and deletions in batches of 100, with no
  signal.
- If any part is not taken, it also sends the bare signal and resolves false. It never throws.
- `docs/INTEGRATION.md` now leads with this form, in the loop example and in its own section.

Seven client tests cover the routes, batching, the plain signal, a refused part, a wrong-shaped answer, an unreachable
server and a throwing fetch.

### Connector calls per task, before and after

**quality-cli** (`--users 8 --sessions 20 --updates 0.6 --deletes 0.05 --jobs 4 --config '{"sync":true}'`).
"Calls per session" counts every connector call: searches, fetches and listings, background included. "main" is the
untouched tree.

| Run | Calls per session | Request calls per lookup | Background + backfill | Re-reads | Precision / recall | Ask recall@5 |
|---|---:|---:|---:|---:|---|---:|
| main, signals | 6.86 | 0.750 | 696 | 571 | 0.588 / 0.454 | 0.836 |
| branch, signals | 6.87 | 0.754 | 696 | 575 | 0.588 / 0.454 | 0.836 |
| branch, payload | **5.28** | **0.217** | 698 | 0 | 0.581 / 0.442 | 0.836 |
| `gmail:30` cap, signals / payload | 5.54 / 3.84 | 0.679 / 0.214 | 459 / 463 | 470 / 0 | 0.629 / 0.463 | 0.858 |
| coalesce 30 s, signals / payload | 6.87 / 5.28 | as branch | as branch | as branch | as branch | 0.836 |

**Pi** (heldout14 with neutral tasks, seeds 41–42, `--push signals`, direct market profile, time scale 1, Haiku 5.5 in
every role; `run.sh`, `analyze.py`).

- Each arm is a fresh Eden for the stream.
- 576 task runs, 0 errors, 0 ungraded, no budget overruns.
- The `eden` arm is this branch's default. For connector calls it is the "before": D211 and D212 make no listing call.
- Pi has no payload mode (its notifier sends only signals), so payload is measured in the sim only.

| Kind | Arm | Raised | Connector calls / task | Listings | Searches | Fetches | Wall p50 |
|---|---|---:|---:|---:|---:|---:|---:|
| hidden | eden | 0.703 | 7.92 | 3.30 | 0.30 | 4.33 | 4.34 s |
| hidden | `gmail:30` | 0.688 | 7.66 | 3.11 | 0.41 | 4.14 | 4.40 s |
| hidden | coalesce | 0.766 | 7.73 | 3.22 | 0.25 | 4.27 | 4.27 s |
| control | eden | 0.031 | 9.06 | 3.31 | 0.55 | 5.20 | 5.81 s |
| control | `gmail:30` | 0.000 | 8.84 | 3.11 | 0.61 | 5.12 | 5.52 s |
| control | coalesce | 0.000 | 8.61 | 3.23 | 0.45 | 4.92 | 5.01 s |
| neutral | eden | 0.078 | 10.39 | 3.30 | 0.67 | 6.42 | 6.17 s |
| neutral | `gmail:30` | 0.047 | 10.56 | 3.12 | 0.83 | 6.61 | 6.08 s |
| neutral | coalesce | 0.016 | 10.64 | 3.23 | 0.75 | 6.66 | 6.55 s |

"Raised" is hidden facts for hidden tasks and false concerns for control and neutral tasks.

Paired differences from `eden`, bootstrap 95% CI:

| Arm | Kind | Rate | Connector calls |
|---|---|---|---|
| `gmail:30` | hidden | −0.016 (−0.094..+0.062) | −0.27 (−0.84..+0.28) |
| `gmail:30` | control | −0.031 (−0.078..0) | −0.22 (−0.88..+0.44) |
| `gmail:30` | neutral | −0.031 (−0.109..+0.047) | +0.17 (−0.53..+0.91) |
| coalesce | hidden | +0.062 (−0.016..+0.156) | −0.19 (−0.80..+0.48) |
| coalesce | control | −0.031 (−0.078..0) | −0.45 (−1.00..+0.11) |
| coalesce | neutral | −0.062 (−0.125..−0.016) | +0.25 (−0.44..+0.94) |

### Why both sync trials were deleted

- **The coalescing window (D213)** had nothing to coalesce.
  - Concurrent lookups already join a poll in flight (`SourceSync.busy`).
  - A burst of notices before a poll already costs one poll.
  - Instrumented on-demand polls: 176 of 176 in the funnel and 814 of 814 in quality-cli came at least a minute after
    the source's last poll, nearly all an hour or more. Both the harnesses and Pi space tasks an hour apart and fire
    signals between tasks.
  - The trial was identical to the default in the funnel and in quality-cli, and in Pi its call difference is inside
    noise. The only case it changes is a storm of signals seconds apart, which no harness produces. Reopen with one
    measured from a real integration.
- **The recency caps (D214)** do not cut the poll that dominates a task.
  - They cut backfill and sweeps: funnel amortised calls fell from 4.33 to 3.79 a task with a 30-day cap on every
    source, and quality-cli calls fell 19–27% with `gmail:30`.
  - Their cost: a 30-day cap on every source lost hidden 281 → 273 and pool 278 → 262 on the stub funnel. `gmail:30`
    alone was neutral there (pool 275/251 against 278/254).
  - The sim's mailbox spans 60 days: 558 of seed 41's 1,227 mails are older than 30 days. A cap that suits it would
    drop most of a real mailbox's history, which no suite asks about.
  - On Pi it saved 0.19 listings a task (−6%) with total calls inside noise. Not promoted.
- The code of both is commit `a0ed239f`.

### What the Pi numbers say about the rest of the bill

- **Fetches** are 4.3–6.6 of the 7.9–10.4 connector calls a task: the reader's and the delivery's re-reads after
  signals. These are issue 1's `VERIFY_AHEAD` re-reads (session S1).
- **Listings** are a steady 3.3 a task: one on-demand poll per stale source after an hour's gap.
- **Payload notices** remove both. In the sim they bring request calls per lookup from 0.75 to 0.22 and re-reads to 0.
  This is why D210 makes them the default an integrator is told to send.
- **The next lever** inside the engine is the polls themselves: skip polling a source the request does not need.
  That is a routing change, not a sync one.

## Gate

- `bun run check`: green on the final tree.
- `bun run eval`: precision 0.828, recall 0.48, false-fire rate 0 (31 scenarios, 104 scored turns), the same as part
  D's T2.
- The `reviewer` subagent ran on the diff (see the branch's last commit).
