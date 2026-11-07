# A18: Eden's time on the agent's path

Status: 2026-11-07, branch `claude/a18-latency` (from `claude/lucid-hypatia-v9wqk5` at `598bd6ebe`). Session A18 of
the afternoon audit. Decisions D345–D348. Every paid call went to Anthropic (`claude-haiku-5-5`, `HAIKU_API_KEY`, the
lab provider, D97) with `OPENROUTER_API_KEY` unset, on this session's own ledger (`.local/a18/ledger.jsonl`, cap $2):
**Anthropic-direct lab figures**, train suites only. Spent: **$0.287**.

## In plain words

- **Eden's own work is a few milliseconds.** When change notices carry their items (payload), Eden adds about 6 ms to
  the agent's wait on a request and 2.4 ms on an `ask_context` at the median, 18 ms and 10 ms at p99 (train1–6, real
  connector latency). Over HTTP with 300 users at real pacing the server answers a request in 2.4 ms (p99 13.5 ms) and
  an ask in 6 ms (p99 21 ms). Nothing in Eden's own code, the server, HTTP or the client is worth a lever.
- **Almost all the rest is one thing: re-reading copies a change signal put in doubt.** When a notice says only "this
  source changed", Eden re-reads by id every copy it is about to deliver or cite from that source (D126, D211). Those
  re-reads are connector round trips: the agent waits **about 1.0 s at the median and 1.5 s at p99 on every
  request**, and an ask **0.6 s at the median and 2.8 s at p99** (direct market connectors; hosted ones 1.4 s and
  4.0 s). On Pi with a real agent that was **41–43% of the task's wall time**.
- **Two ways to make the signal path itself faster failed, and are deleted.** Letting the sync's poll stand in for the
  re-reads delivered stale copies (5 → 12 of 101 updates): listings are not reliably newest-modified first (D345).
  Re-reading an ask's likely citations while its poll runs cut the ask's p99 by about a second but read items the
  answer then dropped, adding connector calls (D346).
- **What works: let the notice name what changed (D347).** Most providers' notices carry ids even when they carry no
  content (Gmail history ids, Graph and HubSpot resource ids, Drive change lists). A new route,
  `POST /v1/sources/refs` (`sourceChanged(id, { refs })` in both clients), has Eden read just those items in the
  background and doubt nothing else. With the same notices as the signals runs:
  - **funnel, direct:** request p50 **1,013 → 6 ms**, p90 **1,507 → 17 ms**; ask p50 **588 → 2.3 ms**, p99
    **2,782 → 1,050 ms**; connector calls **7.4 → 2.0 a task** (seed 42: 7.8 → 1.6), planted facts unchanged;
  - **funnel, hosted:** request p50 1,406 → 6 ms, p90 1,512 → 850 ms; ask p50 1,505 → 2.6 ms, p90 2,778 → 10 ms;
    calls 8.4 → 2.4 a task; 2 of 96 planted facts fewer than payload (asks that came while their own item's read was
    on the wire);
  - **Pi, real agent:** Eden's share of the critical path **1,438–1,587 ms (41–43%) → 69–73 ms (3%)**; each task
    **1.3–1.6 s faster** (paired, both seeds); hidden facts raised 60 of 96 against 65 under signals and 58 with
    payload (differences not significant either way);
  - **freshness:** the staleness simulation delivered no more stale or deleted items than payload notices (5 of 101
    and 0), with no delivery re-reads against 761.
- **What is left.** With ref notices, the remaining tail (p99 about 1.5 s) is a request that arrives while its own
  item's read is still on the wire; the lab sends each notice at the same instant as the request, which real
  notices rarely do. With bare signals the wait is the freshness guarantee itself, bounded by `verifyTimeoutMs`: the
  only call-free cure is a notice that says what changed.

## 1. The breakdown, before (the shipped default)

**Instrument (D348).** `bun run funnel` takes pi-ab's connector options at `--time 1` (`--source-profile`, `--push
signals|payload|refs`, `--fetch-gone false`); the engine opens a content-free `verify` span around a delivery's
re-reads; `latency-report.ts` reads the timeline and the funnel's rows. "Request" is what the agent waits on after
sending a user message: the observe with its push (the funnel's `ms`, the client's `waitMs` 3,000). "Ask" is one
`ask_context` (the request's own words, sent after the push settled). Each piece's figures are over the roots it ran
in; its share is its time over the kind's total wall time (pieces overlap, so shares can pass 100%).

```bash
.local/a18/run.sh NAME direct|hosted signals|payload|refs SEEDS SET   # bun run funnel --suite train --jobs 1 --set SET
#   -- --limit 16 --time 1 --source-profile .../market-profiles/$P.json --push $PUSH --timeline ... --json ...
bun packages/sim/src/lab/latency-report.ts .local/a18/NAME.jsonl --funnel .local/a18/NAME.json
```

train1–6, 16 templates a suite, hidden and control, seed 41 (n = 192 requests and asks a run):

| run | request p50 / p90 / p99 ms | ask p50 / p90 / p99 ms | re-reads (`verify`) in the push / ask | calls a task |
| --- | --- | --- | --- | --- |
| direct, payload | 5.6 / 9.3 / 18 (max 57) | 2.4 / 3.4 / 10 | — | 0 |
| direct, signals | **1,013 / 1,508 / 1,512** | **589 / 1,506 / 2,782** | p50 1,017 ms (99% of the push) / 409 ms (74% of the ask) | 7.44 |
| hosted, payload | 5.0 / 8.3 / 16 | 2.2 / 3.0 / 7.6 | — | 0 |
| hosted, signals | **1,409 / 1,511 / 1,516** | **1,506 / 2,723 / 3,987** | p50 1,501 ms (the 1.5 s deadline) / 1,191 ms | 8.38 |

Seed 42, direct: payload 6.1 / 12.9 / 31 and 2.4 / 6.0 / 11.8 ms; signals 956 / 1,510 / 1,548 and 721 / 1,504 /
2,725 ms, 7.79 calls a task.

Where the payload run's milliseconds go (`timeline-report.ts`): the slow path's ranking and grounding, rendering and
the push's own search, a few hundred microseconds each; traced CPU is about 30% of the process's (the rest is the
sync's background work and the harness). The slowest roots are a process's first requests (55 ms: JIT warm-up), not a
steady tail.

Under signals, the re-reads are the cost, not their scheduling: 59 of 60 strict asks finish in one round (the D211
retry of a skipped or flaked read almost never runs), and most asks reuse the push's re-reads (0–1 new calls). The
push waits for the slowest of its candidates' re-reads, at most `verifyTimeoutMs` (1.5 s); on hosted connectors (median
800 ms, σ 0.75) one fetch in five passes 1.5 s, so most pushes wait the full deadline and then deliver that item as
held anyway. An ask also waits for its own on-demand poll and any live search before its re-reads (serial).

**Server and HTTP** (`perf-cli.ts steady --synced`: 300 synced users, real pacing, REALISTIC connectors, no model,
90 s, one run): observe of a user message p50 2.44, p95 8.1, p99 13.5 ms; ask p50 5.95, p95 10.3, p99 21 ms; time to
context p50 5.1, p99 20 ms; server CPU 13%, event-loop lag p99 6.2 ms. `session_end`'s p95 of 37 ms is the load
generator ending all 300 sessions at the same instant at the run's end, not engine work. These match A3's run of the
same scenario (ask p99 30 ms, observe p99 15 ms).

**On Pi** (§4): Eden on the agent's critical path 1,438 ms (41% of wall time) on seed 41 and 1,587 ms (43%) on seed
42 under signals, 12 ms (1%) under payload.

## 2. What was tried

| # | Lever | Outcome |
| --- | --- | --- |
| D345 | A complete poll after the signal stands in for the re-reads (`verifyByPoll`) | deleted: stale 5 → 12 of 101 |
| D346 | An ask re-reads its likely citations beside its poll (`askVerifyEarly`) | deleted: +0.06–0.09 calls a task |
| D347 | Notices name the refs that changed (`/v1/sources/refs`) | adopted (an integration route) |
| — | Queue a strict ask's re-reads for a connector slot instead of skip-and-retry | not built: 59 of 60 asks were one round |
| — | Hedged re-reads on the slow tail | not built: every hedge is a connector call |
| — | A shorter push deadline | not built: delivers more doubted copies as held (a freshness loss) |
| — | Answer-ahead / re-read after the push | already measured and deleted (D249: +1.5 calls a task) |
| — | Cold-session warm-up, GC, the event loop | nothing to fix: the tail is one process's first requests, and the server's lag p99 is 6 ms |

## 3. D345: the poll does not cover a signal

The idea: after a signal, the sync polls the source; a poll reads the listing newest first down to the first item it
already holds unchanged. If listings were ordered by last modification, every item changed since the last poll would
have been listed again (and stored under a newer read mark), so any copy still held from before the signal is
unchanged, and re-reading it proves nothing new where a re-read cannot tell a deletion either (an MCP tool's null
proves nothing, D126). The trial skipped those re-reads, and made a delivery wait for a covering poll in flight.

Measured with the freshness matrix and MCP-like connectors (`--fetch-gone false`, new: the sim's fetch null proves
nothing), `quality-cli.ts --users 8 --sessions 20 --updates 0.6 --deletes 0.05 --jobs 2 --push signals`:

| arm | stale / updates delivered | deleted delivered / cited | re-reads |
| --- | --- | --- | --- |
| off | 5 / 74 | 11 / 11 | 761 |
| on | **12** / 73 | 11 / 11 | 0 |

The seven extra stale copies: the sim's calendar holds future-dated events, so its newest-first listing starts with
them and the poll stops at one of them, above the moved meeting. Real connectors do the same in other ways: a Slack
edit keeps its message's timestamp, a calendar list tool usually orders by start time. The sync itself tolerates this
(the sweep and the next signal catch up), but a freshness guarantee cannot rest on it. With `--fetch-gone true` (the
switch inert) the run was identical to off. Code in commit `3852120e`, deleted in `67fde45b`.

## 4. D346: early re-reads cost calls

An ask waits for its poll and search, then re-reads. The trial ranked the index before the poll and started the
re-reads of its first five doubted candidates at once. Funnel, seed 41, `--push signals`, against a fresh run of the
default (same machine, same time):

| profile | ask p50 / p90 / p99 ms, off → on | ask mean | hidden / decoys surfaced | calls a task |
| --- | --- | --- | --- | --- |
| direct | 588 / 1,506 / 2,782 → 560 / 1,504 / **2,017** | 718 → 653 | 75 / 69 → 75 / 69 | 7.443 → **7.505** |
| hosted | 1,505 / 2,778 / 3,991 → 1,377 / **1,518** / **3,006** | 1,583 → 1,174 | 76 / 66 → 76 / 68 | 8.375 → **8.469** |

A diagnostic run (hosted) counted 346 early re-reads over 152 asks, 16 of them for items the answer then left out:
12 in asks with nothing to wait on (the probes reorder the top five after the search), 4 in asks with a live search.
No gate gets that to zero, and the audit's bar is no added connector calls on per-call plans. Code in commit
`750b5fc4`, deleted in `56dd7e37`.

## 5. D347: notices that name their refs

**Behaviour.** `ContextPartner.sourceRefs(scope, sourceId, refs)`: the source must be synced and notifying (else the
plain signal's answer and reason). Its held search pages are dropped; each named ref (at most 100, de-duplicated) is
marked `refreshing`, so `doubted` holds it in doubt and `check` waits on its read (raced against `verifyTimeoutMs`)
instead of making a second call. In the background, two at a time: a fetch within 5 s (`REF_TIMEOUT_MS`; off the
agent's path), a guard's skip or a plain error tried again up to 4 times; an item the source no longer has is dropped;
a found one is stored as synced under the read mark its call began with, unless a removal landed during the call.
The first ref not read (no fetch tool, errors, a timeout, a null that proves nothing) raises the plain signal before
its item's doubt is lifted. A signal after the notice makes a delivery read the item itself rather than reuse the ref
read. A landed read that changed the item is noted in the user's live sessions as a recent re-read (a pool built before it applies it).
Reads stop when the user is forgotten or no longer synced. The stored ref is the gated one (D10). Stores announce
revisions as any sync store does (D205). `freshness.refsRead` and `refsFallback` count them.

**Review.** The reviewer subagent's probes found three faults in the first build, all fixed with a regression test
each (each test fails on the first build): a failed read lifted its item's doubt until every lane had finished, so an
ask in that window cited the old copy with no re-read; a signal during a ref read did not stop a delivery reusing it;
the raw ref (a secret-shaped one in the probe) was stored past the gate. Also fixed: reads went on after a forget, and
a pool built before a read landed delivered its older copy.

**Integration.** `POST /v1/sources/refs {userId, sourceId, refs}` answers at once with `{ok, synced, reason?}`
(`checkSourceRefs`, the deletion body's shape); `EdenClient.sourceChanged(id, { refs })` and Python
`source_changed(refs=…)` send it in batches of 100, and the plain signal when a batch is not taken. docs/INTEGRATION.md
says when to use it. Two retries were added after the first measurement: the first build fell back to the signal
whenever the request's own lookups held the source's two connector slots (request p90 1,329 ms), and on hosted
connectors whenever a fetch passed 1.5 s (p90 1,507 ms).

**Lab.** `--push refs` sends the notices `--push signals` sends (same draws, same rates) as ref notices, each naming
the source's newest item (content unchanged), with no lead time: the notice reaches Eden with the request. In
quality-cli it names the updated items. In pi-ab's `--days` recap it names the moved items.

**Funnel**, train1–6, 16 a suite, signals → refs (payload, with no notices at all, for reference):

| run | request p50 / p90 / p99 ms | ask p50 / p90 / p99 ms | calls a task | hidden / decoys |
| --- | --- | --- | --- | --- |
| direct 41 | 1,013 / 1,507 / 1,516 → **5.7 / 17 / 1,504** | 588 / 1,506 / 2,782 → **2.3 / 3.9 / 1,050** | 7.44 → **2.00** | 75 / 69 → 75 / 70 (payload 76 / 70) |
| direct 42 | 956 / 1,510 / 1,548 → **6.1 / 155 / 1,506** | 721 / 1,504 / 2,725 → **2.5 / 4.3 / 1,250** | 7.79 → **1.62** | 76 / 65 → 76 / 66 (payload 76 / 66, identical tasks) |
| hosted 41 | 1,406 / 1,512 / 1,534 → **6.4 / 850 / 1,508** | 1,505 / 2,778 / 3,991 → **2.6 / 10 / 3,010** | 8.38 → **2.37** | 76 / 66 → 74 / 70 (payload 76 / 70) |

These are the final build (after the review's fixes, below); the first build's runs (`r3-*`, `r4-*`) gave the same
figures within a few milliseconds and one planted fact. Against payload, ref notices differed in 1 task (direct 41),
0 (direct 42) and 2 (hosted 41): asks that came while their own item's read was on the wire and gave up at
`verifyTimeoutMs` (strict, D211: left out and named), which the lab's zero lead time causes. The decoys refs and
payload surface above signals are asks that signals' strict re-reads left out for want of a confirmation.

**Freshness**, quality-cli (`--users 8 --sessions 20 --updates 0.6 --deletes 0.05 --jobs 2`), $0:

| push | stale / updates delivered | deleted delivered / cited | precision / recall | delivery re-reads | calls a lookup |
| --- | --- | --- | --- | --- | --- |
| signals | 5 / 73 | 0 / 0 | 0.403 / 0.531 | 761 | 0.764 |
| payload | 5 / 69 | 0 / 0 | 0.396 / 0.518 | 0 | 0.136 |
| refs | 5 / 69 | 0 / 0 | 0.396 / 0.518 | 0 (+ the ref fetches) | 0.413 |
| refs, `--fetch-gone false` (first build) | identical to refs then | | | | |

**Pi** (`.local/a18/pi.sh`: the eden arm, `--tenant-prompt`, direct profile, time scale 1, train1–6, `--variants
hidden,control,neutral --limit 8`, one process an arm, the three arms at once; 144 tasks an arm a seed):

| seed, push | Eden on the critical path | wall p50 mix | hidden raised | control false | neutral any |
| --- | --- | --- | --- | --- | --- |
| 41 signals | 1,438 ms (41%) | 3.05 s | 33 / 48 | 0 / 48 | 0 / 48 |
| 41 refs | **73 ms (3%)** | **2.13 s** | 28 / 48 | 1 / 48 | 0 / 48 |
| 41 payload | 12 ms (1%) | 2.10 s | 26 / 48 | 0 / 48 | 0 / 48 |
| 42 signals | 1,587 ms (43%) | 3.65 s | 32 / 48 | 1 / 48 | 0 / 48 |
| 42 refs | **69 ms (3%)** | **2.18 s** | 32 / 48 | 0 / 48 | 0 / 48 |
| 42 payload | 12 ms (1%) | 2.32 s | 32 / 48 | 2 / 48 | 0 / 48 |

Paired over both seeds (bootstrap 95%, n = 96 a kind): wall refs − signals **−1.26 s** (−1.48..−1.03) hidden,
**−1.51 s** (−1.73..−1.28) control, **−1.61 s** (−1.88..−1.35) neutral; payload − signals −1.29, −1.59, −1.53 s. Hidden
raised refs − signals −5.2 points (−13.5..+4.2; discordant tasks 7 against 12), payload − signals −7.3 (−15.6..+1.0;
5 against 12), refs − payload +2.1 (−6.2..+10.4). The packets were the same in all but 2 tasks a seed (same item
counts): the hidden differences are the agent's answers, and payload, the documented default, sits with refs.
Neither is significant; a small loss of either against signals is not ruled out by two seeds. The $/1k columns are
not comparable here: the three arms ran at once with the same prompts, so the slower signals arm read the prompt
caches the others wrote (agent $0.030 against $0.039 a seed).

## 6. Decisions and code

| # | What | Code |
| --- | --- | --- |
| D345 | `verifyByPoll`: deleted | `3852120e` (built), `67fde45b` (deleted) |
| D346 | `askVerifyEarly`: deleted | `750b5fc4` (built), `56dd7e37` (deleted) |
| D347 | ref notices: `sourceRefs`, `/v1/sources/refs`, both clients, `--push refs` | `128b18c7` |
| D348 | the latency instruments; no lever for CPU, server, HTTP or client | `3852120e`, `750b5fc4` |

Tests: `packages/engine/src/source-refs.test.ts` (the named item read and cited with no further call, the others not
doubted where a signal doubts them, an ask during the read waits on it with one call in all, a gone ref, the fallback
to the signal, not-synced, two users, and the review's: a failure while other reads run, a signal during a read, a
secret-shaped ref, a removal and a forget during reads, a retry that succeeds, a read slower than `verifyTimeoutMs`,
a pool from before the read), `http.test.ts` (the route), `client.test.ts` (refs batches, not-taken shapes),
`test_eden_client.py` (parity), `connector-options.test.ts` (`recapNotice` refs). `bun run check` green; `bun run eval`
identical to the base tree but its latency fields (p50 0.316 → 0.258 ms, p95 6.13 → 6.02 ms, which move run to run).

## 7. Reproduce

```bash
# $0 latency screens (2-5 min each; .local/a18/run.sh wraps these two lines)
bun run funnel --suite train --seeds 41 --jobs 1 --set '{}' --json .local/a18/X.json -- --limit 16 --time 1 \
  --source-profile packages/sim/lab/before-after/market-profiles/direct.json --push signals|payload|refs \
  --timeline .local/a18/X.jsonl
bun packages/sim/src/lab/latency-report.ts .local/a18/X.jsonl --funnel .local/a18/X.json
# freshness (D345, D347)
bun packages/sim/src/quality-cli.ts --users 8 --sessions 20 --updates 0.6 --deletes 0.05 --jobs 2 \
  --push signals|payload|refs [--fetch-gone false] [--config '{"…":true}']
# server under load
bun packages/sim/src/perf-cli.ts steady --synced
# Pi (paid, about $0.05 an arm a seed): .local/a18/pi.sh LABEL PUSH direct --seeds 41 \
#   --variants hidden,control,neutral --limit 8 --budget 0.3      (A3's run.sh with --conditions eden)
bun packages/sim/src/lab/pi-ab-report.ts .local/a18/pi/LABEL.json
```

## Spend

Ledger `.local/a18/ledger.jsonl`: the six Pi runs, $0.0417 (signals 41), $0.0505 (refs 41), $0.0517 (payload 41),
$0.0425 (signals 42), $0.0492 (refs 42), $0.0510 (payload 42): **$0.287** of the $2 cap. Everything else was $0.

## Limits

- One seed for most funnel figures (two for direct), one for hosted; the funnel's ask is the request's own words.
- The lab sends every notice with its request (no lead time): the worst case for ref notices' tail and for signals.
- `--push refs` names an existing item whose content does not change: its timing is a ref notice's, its freshness
  case is the quality run's.
- Pi: 48 tasks a kind a seed, two seeds; hidden-fact differences of ±5 points are within noise.
