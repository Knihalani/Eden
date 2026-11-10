# F1: a complete local copy that does not depend on push

Status: built and measured 2026-11-10 on branch `claude/f1-local-copy` (from `claude/lucid-hypatia-v9wqk5` at
0fbbeb56). Decisions D475–D479. **Two trial switches, both off: nothing in the default changed** (D479). Paid calls:
Anthropic API only, the Modal Secret `HAIKU_API_KEY`, `claude-haiku-5-5` in every role (agent, grader, cards, intent),
lab provider (D97), each shard on its own ledger: **Anthropic-direct lab figures. Spent: $0.813** (three Modal runs,
six shards; `manifest-*.json`). Modal credits: not read from the billing report; six 4-CPU, 24 GiB shards of 5–15
minutes each, about $0.5 at the README's rate (**an estimate**). Every other figure is a $0 run on a 4 vCPU, 15 GiB
box, Bun 1.4.4, `BUN_OPTIONS` and `OPENROUTER_API_KEY` unset. Summaries of every run are in `packages/sim/lab/f1/`.

## In plain words

- **The problem.** With about 1,000 connected sources Eden made ~40 connector calls for every task, mostly live
  searches of sources whose local copy the per-user item cap had cut short (D264), and about 900 calls a user a day
  in the background. On a connector platform that bills per call this is $920–1,000 per 1,000 tasks on the dearest
  plan measured here, against ~$91 for the agent alone (A21's figure, not rerun).
- **The owner's concern.** Many connectors send no change notifications, so the answer cannot be "wait for push".
- **What was built, as two trial switches (off).**
  1. **A cold tier (`syncCold`, D475).** Items the cap pushes out of the in-memory index are no longer thrown away:
     they are kept compressed in memory, per source, behind a small index of their words. The first read of each
     source goes to the end of its listing while there is room (30,000 items a user by default). A source whose
     items are all held, indexed or cold, is answered here: the cold copies that hold the request's words are
     brought back into the index, with no call. A live search is made only for a source whose copy is still not
     whole (past the cold tier's room, or a calendar, which is matched by date). This needs no push and no delta.
  2. **Change feeds (`syncDelta`, D476).** Where a connector can say "what changed since this cursor" (Gmail history,
     Graph and Drive delta, Calendar sync tokens, Salesforce CDC), Eden reads that instead of re-listing: one call
     brings new items, changed items wherever they sit in the listing, and deletions. With push as well, a change
     notice costs one such read instead of a re-read of every item in doubt. Connectors with neither are polled,
     swept and re-read exactly as before (D126, D211, D356 all stand).
  3. **The lab now has connector kinds** (D478): each simulated connector is push + feed, feed only, or neither,
     30% / 30% / 40% (**an assumption taken from the brief, not a census**), and the cost report prices event
     triggers.
- **What it did, live** (Pi, train, seeds 41–44, 432 tasks an arm, 995 noise connectors, the 30/30/40 mix in every
  arm, payload notices, market latency, `--tenant-prompt`; paired by task, bootstrap 95%):
  - **Connector calls: 35.4 → 6.7 a task** on the 1:1:8 mix (−28.7, −30.4..−27.1).
  - **Hidden facts raised: 83 → 94 of 144** (+0.076, +0.007..+0.146). False concerns not up (control 2 → 0, neutral
    1 → 0, Haiku-graded, not regraded).
  - **Cost on the mix, steady, per 1,000 tasks:** first-party $0.577 → $0.489; Composio $12.16 → $2.55; Zapier MCP
    **$997 → $178**. The first read of a new user's sources costs more calls (1,004 → 1,625 a user), paid back
    after about 20 tasks.
  - **But tasks got slower: wall +2.1 s a task** (+1.7..+2.5) and Eden's time on the agent's path +1.08 s
    (+0.82..+1.37). Without the re-read of copies brought back from the cold tier (`syncColdVerify` off, the `fast`
    arm) it is still +1.56 s wall and +0.36 s on the path. The median path time fell (494 → 473 and 143 ms); the
    tail grew (p90 1.4 → 4.6 and 3.8 s). Section 6 says what is known about why: the cold tier's own CPU.
- **Stale and deleted deliveries** (`quality-cli`, 16 users × 20 sessions, 213 updates, 128 deletions, signal-only
  notices): with a change feed, **deleted items delivered or cited 5/17 → 0/0** for feed-only connectors and
  re-reads before delivery **1,492 → 0** for push + feed connectors, stale deliveries not up, with 0%, 20% and 30% of
  notices lost. For connectors with neither, the cold tier alone is not worse than live-searching the cut copy
  (deleted 3/14 → 2/12, stale 15/143 → 12/132) only because copies brought back are re-read before delivery;
  without that re-read it reads 4/17.
- **A user-day** (one user, 1,000 sources, items arriving all day, days 2–8): **907 → 373 connector calls a day**
  (searches 444 → 0). The cold tier held 23,000 items in **8.9 MB** and Eden's own CPU for the day rose from 2.2 s
  to 6.1 s.
- **Decision (D479): not promoted.** Calls fall, hidden facts are not worse, stale and deleted deliveries are not
  worse: the brief's three conditions hold. The trials stay off because tasks are measurably slower, the cold tier
  costs about three times the memory of a live user's index and 2.7 times the CPU of a user-day, and no shipped
  connector has a change feed yet (`McpSource` has no delta tool). Section 8 lists what would change that.

## 1. Where the calls were

A21 and C4 measured ~40 calls a task at 1,000 sources: ~26 live searches of noise connectors' cut copies, ~6
on-demand listings of noise copies, ~6.5 searches of the world's own sources. This run's baseline arm (the default,
with the 30/30/40 mix) made 38.6 on the mix (Eden 32.4 in the task's window, 3.2 in the background): gmail search
2.83 a task, crm 0.85, drive 0.71, slack 0.55, calendar 0.53, the rest spread over hundreds of noise connectors at
~0.08 each (`pi-pair.txt`).

The cut copies exist because the sync keeps a user's newest 3,000 items across sources (`syncMaxItems`). With 995
noise connectors of 20 items each, the backfill lists nearly all 20,000 items once and then drops 17,000 of them; a
lookup routed to such a source cannot trust the remainder and searches the source live (D264). Rejected before this
session: a budget on those searches (D390: half the calls, lost facts), a weekly sweep without a fetch tool (D297),
a poll standing in for re-reads (D345).

## 2. The cold tier (`syncCold`, D475)

`packages/engine/src/cold.ts`, `sync.ts`, `cache.ts` (`syncedCopy`, `putBack`), `partner.ts` (`thawCold`).

- **What is held.** Per (user, source), on the sync's own state: zstd chunks of at most 64 items (the redacted
  copies as the cache held them, with the time and read mark each was read under), each chunk with the ids it holds
  (`IdSet`) and a Bloom filter of its items' words (16 bits a word), and per pack the signatures of the copies held
  (id, title, text and time, 53 bits). In memory only (D8). Dropped with the user or the source (`forget`, eviction,
  a removed connector). `syncColdMaxItems` (30,000) bounds a user's cold items; past it a copy is cut and searched
  live, as before.
- **In.** The trim moves what the cap pushes out into the cold tier instead of dropping it. The backfill reads each
  listing to its end while there is room. A background poll or sweep that lists an item older than the user's cut
  puts it in the cold tier. When the index is already half a cap over (a week's sweeps land together), a background
  read's new items go to the cold tier whatever their date: stored in the index they passed the cache's own synced
  cap, which evicts by sync order, and the copies that lost items were cut again (found on the bench's seventh day).
- **Out.** `localAnswer` (the lookup's own query and every probe) first brings back the cold copies of its sources
  that hold any of the query's words: per source, the chunks whose filters match the rarer words (at most 8 a
  source, 48 a call), their items ranked by which of the words they hold (rarer first), at most 8 a source. They go
  back as synced items and are carded and their mentions recorded, as a live search's finds are. A source the user
  starts to use has its cold copies brought back up to the half of the cap the trim keeps for used sources: the
  cards and the intent index read only indexed items (without this, 5 planted items stayed cold at $0).
- **Kept current.** An id is indexed or cold, never both. A listing that shows a cold item unchanged leaves it cold
  (counted as listed); one that shows it changed takes it out and stores the new copy. The sweep of a source with
  cold items reads its whole listing and counts cold ids among those missed (two misses drop an item, as before).
  The longer sweep of an unused source that has cold items comes inside the cache's 7-day time to live.
- **Freshness.** A cold copy keeps its read time and read mark (`putBack`), so D126 and D356 doubt it as they would
  the indexed copy. A copy a lookup brought back from a source with no change feed and a fetch tool is in doubt
  until a listing or a re-read sees it (`syncColdVerify`, on): it stands in for a live search's find, which was the
  source's copy of that moment.
- **Not covered.** A source that lists by time (a calendar) stays out: the cold match is on words. After a restart
  with D425's persistence a source that had cold items comes back cut (the packs are not saved).

## 3. Change feeds (`syncDelta`, D476)

`Source.changes(scope, cursor)` returns `{ items, removed, next, more? }`, or null for a cursor the source no longer
honours; with no cursor it returns none and a cursor for "now". `SourceFanout.changes` runs it under `list`'s guards
and redacts its items.

- The cursor is taken before the backfill's first page, so nothing falls between the listing and the feed.
- A poll of such a source is one delta read (`pollDelta`): new and changed items stored, deletions dropped as a
  deletion notice's are (`dropGone`: held gone, queued packets citing them withdrawn).
- A complete delta read vouches for every copy held as of its start. A signal at or before that start doubts
  nothing (`signalledSince`), so with push **a change notice costs one delta read**: a delivery that finds doubted
  copies waits on one read of the feed, shared by all of them (`recheckByDelta`, within `verifyTimeoutMs`), and
  falls back to the per-item re-read (D126, strict for an ask, D211) when the feed cannot settle it.
- The daily re-listing for deletions becomes one delta read (or, for an unused source with a fetch tool, D356's
  re-read before delivery). The whole listing is read again about every six days, inside the cache's time to live,
  and daily while a whole listing has missed an item.
- A lost notice on a push + feed source is bounded by `syncMaxStaleMs` (6 h) instead of `syncPushMaxStaleMs` (24 h):
  checking costs one call. With the 24 h bound stale deliveries read 12 against 10 at 20% lost; with 6 h, 10 and 10.
- An expired cursor is let go: the next tick takes a new one and re-lists the source (a deletion in the gap is in
  no feed).

**D477: no scheduled poll of every source.** The brief asked for sweeps scheduled by how often a source changes and
how often the user's requests route to it. That schedule already exists and is kept: a source is polled when a
lookup routes to it and its learned change rate says it has probably changed, and re-listed daily when used, weekly
when unused with a fetch tool (D356). A timer that polled every source by its rate would cost more: the bench's
1,000 sources each change about once a day, so about 1,000 polls a day (arithmetic, not a run), against the 190–220
on-demand polls a day measured below. What the trial adds is that the incremental read is a delta where one exists.

## 4. $0 screens

**Hidden facts at 1,000 sources** (`bun run funnel --jobs 2 --suite train1..6 --seeds S -- --noise-sources 995
--limit 16`, `funnel-995.txt`): surfaced hidden / decoys of 96, connector calls a hidden task.

| Seed | Default | `syncCold` | Default, 30/30/40 mix | `syncCold` + `syncDelta`, mix |
| --- | --- | --- | --- | --- |
| 41 | 77 / 69, 47.8 calls | 76 / 69, 11.3 | 77 / 69, 42.9 | 76 / 69, 10.8 |
| 42 | 77 / 64, 48.6 | 76 / 64, 11.8 | 77 / 64, 43.0 | 76 / 64, 9.6 |

The ask's own time (one process, time 0) rose from 12–13 to 16–19 ms at the median and 25 to 43–50 ms at p90. The
first form (no re-warming of used sources, cold items ranked by how many words they held) read 75 / 65 on seed 41.

**Five sources:** `bun run funnel --jobs 4` reads 314/273 with both trials off and with both on, 768 rows identical.

**Stale and deleted deliveries** (`quality-cli --users 16 --sessions 20 --updates 0.6 --deletes 0.1 --push signals
--connector-mix P,D --lost-notices L`, `freshness.txt`; 128 deletions, 213 updates, 2,428 turns). Stale / updated
items delivered; deleted items delivered / cited; re-reads; background calls; connector calls a lookup:

| Connectors | Arm | Stale | Deleted | Re-reads | Background | Calls / lookup |
| --- | --- | --- | --- | --- | --- | --- |
| all push + feed, none lost | default | 10/123 | 0/0 | 1,492 | 1,087 | 0.763 |
| | `syncDelta` | 10/132 | 0/0 | 0 | 0 | 0.561 |
| all push + feed, 20% lost | default | 10/121 | 0/2 | 1,287 | 1,089 | 0.693 |
| | `syncDelta` | 10/133 | 0/0 | 0 | 0 | 0.553 |
| all push + feed, 30% lost | default | 11/121 | 1/5 | 1,085 | 1,101 | 0.618 |
| | `syncDelta` | 10/133 | 0/0 | 0 | 0 | 0.549 |
| all feed only | default | 22/124 | 5/17 | 29 | 1,102 | 0.695 |
| | `syncDelta` | 10/132 | 0/0 | 0 | 0 | 0.677 |
| neither | default (= `syncDelta`) | 22/124 | 5/17 | 29 | 1,102 | 0.695 |
| 30/30/40, none lost | default | 18/124 | 1/10 | 651 | 1,093 | 0.730 |
| | `syncDelta` | 16/128 | 0/3 | 9 | 415 | 0.630 |
| 30/30/40, 20% lost | default | 18/121 | 2/11 | 618 | 1,094 | 0.715 |
| | `syncDelta` | 17/127 | 0/3 | 9 | 415 | 0.626 |

(The 30% row is from the run before the last code change to `syncDelta`; the others were rerun after it and did
not move.) Precision 0.427–0.439 and recall 0.496–0.505 in every row.

The cold tier needs a cut copy, which a five-source world has only under a smaller cap, so these rows set
`syncMaxItems` 300 (`freshness-cold.txt`):

| Connectors | Arm | Stale | Deleted | Re-reads | Calls / lookup | Recall |
| --- | --- | --- | --- | --- | --- | --- |
| neither | cap 300, default | 15/143 | 3/14 | 21 | 3.042 | 0.529 |
| | `syncCold`, no re-read (`syncColdVerify` off) | 12/130 | 4/17 | 29 | 1.097 | 0.496 |
| | `syncCold` | 12/132 | 2/12 | 1,320 | 1.236 | 0.492 |
| 30/30/40 | cap 300, default | 14/143 | 1/10 | 203 | 2.931 | 0.526 |
| | `syncCold` | 11/132 | 1/10 | 1,578 | 1.194 | 0.492 |
| | `syncCold` + `syncDelta` | 10/132 | 0/3 | 462 | 1.096 | 0.490 |

With 20% of notices lost the rows read the same within one item. Two things to read here. The deleted counts differ
by one to three items of 128 deletions: small numbers, read with the mechanism (a live search cannot return a
deleted item; a held copy can until two sweeps miss it, or a re-read finds it gone). And **recall is 0.03 lower
with the cold tier than with live searches of the cut copies**, the same as the uncapped default's (0.496): in this
simulation a connector's own search finds a little more than the local index does. The funnel's hidden facts and
the live run did not show a loss.

**A user-day** (`source-days.bench.ts 1000 20 8`, days 2–8, `days.txt`; `--mix=0.3,0.3` for the mixed rows, a bare
notice per new item of a pushing source):

| Arm | Background | On demand | of which delta reads | Searches | Re-reads | All calls a day | Items listed | Eden CPU a day |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| default | 244.6 | 218.0 | 0 | 444.4 | 0 | **907.0** | 8,041 | 2.2 s |
| default, mix | 246.6 | 218.6 | 0 | 462.4 | 18.6 | 946.1 | 8,092 | 2.2 s |
| `syncDelta`, mix | 235.9 | 209.9 | 120.4 | 471.7 | 0 | 917.4 | 6,628 | 2.0 s |
| `syncCold` | 201.7 | 190.3 | 0 | 0 | 0 | **392.0** | 6,460 | 6.0 s |
| `syncCold` + `syncDelta`, mix | 184.9 | 188.3 | 124.0 | 0 | 0 | **373.1** | 5,054 | 6.1 s |

Cold start: 1,000 listing calls (1,600 with feeds: a cursor each for the 600 that have one), 3.0 s of CPU against
5.5–5.7 s with the cold tier. The cold tier ended at 23,200–23,300 items in 8.9 MB (about 380 B an item: blobs, id
sets, filters, signatures). A request or ask brought back 47 cold items and opened 30 blobs on average (a three-day
run, 192 requests and asks; `coldTier` in the bench's JSON). The delta feed alone saves little in calls here (a 20-item source's sweep is one
page either way); it saves items listed and, with push, the re-reads.

With 300 items a source the cold tier's cost shows (`base300`, `local300`; `syncColdMaxItems` raised to 400,000 so
that every copy is whole): 964.6 → 759.0 calls a day, but 302,000 cold items in **104.7 MB**, a cold start of 3,592
calls and 55 s of CPU against 13 s, and 12.6 s of CPU a day against 5.0 s. At the default 30,000 most of those
sources stay cut and are searched live as before. A complete copy of large sources does not fit in memory.

## 5. Connector kinds and event triggers (D478)

`--connector-mix P,D` (funnel, pi-ab, quality-cli, days-calls; `applyConnectorMix`): each connector is "push"
(notifies, has a feed), "delta" (a feed only) or "plain", by a hash of its id and the seed. `SimSource.enableDelta`
is the feed: one call, the items created or changed and the refs deleted since the cursor, expired for any cursor
but the last. The day bench has `--mix=P,D`. With the mix, only a pushing connector's changes are forwarded.

`pi-cost-report.ts --trigger-avoids N --events-per-task E [--event-usd 0.003]` prices event triggers: N of Eden's
calls a task replaced by E billed events. At the brief's $0.003 an event (**assumed, not checked against a price
list**) one event costs as much as 10 Composio calls, 4 Unified.to calls, 0.3 Arcade calls, 0.25 Pipedream calls or
0.12 Zapier MCP calls. An event replaces at most the one poll or delta read that would have fetched that change, so
**triggers pay only where a call costs more than an event** (Arcade, Pipedream, Zapier MCP), and cost more than
polling on Composio and Unified.to. In the day bench the 300 pushing sources sent 331 events a day, which at $0.003
is $0.99 a user a day, against $0.11 for all 373 calls on Composio and $9.63 on Zapier MCP. No engine rule chooses
between them: that is the integrator's wiring (`sourceItems` for a trigger's payload costs Eden no call).

## 6. Live: Pi, train, seeds 41–44

`lab_fanout.py --kind pi-ab` (`go.sh`): train1–6, `--limit 6`, hidden/control/neutral, `--noise-sources 995`,
`--connector-mix 0.3,0.3`, `--push payload`, direct profile, time scale 1, `--tenant-prompt`, Haiku 5.5 in every
role, cards and intent replayed, two shards at a time. Arms: `eden` (the default), `eden~local` (`syncCold` and
`syncDelta`), `eden~fast` (the same with `syncColdVerify` off). Three runs: seeds 41–42 with `eden`, `eden~local`
(commit aed88abe); seeds 43–44 with all three and seeds 41–42 with `eden~fast` alone (ce1a6680, which adds only the
`syncColdVerify` switch and a multi-day sweep rule; the final tree adds one more multi-day rule, the half-cap
overflow of section 2, which a one-day run does not reach). 432 tasks an arm, paired by task (`pi-pair.txt`,
`pi-cost.txt`).

| Arm | Hidden raised | Concerns control / neutral | Eden calls a task (mix) | Path mean / p50 / p90 ms | Wall mean / p50 s | Mix $/1k first-party | Composio | Zapier MCP |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| default | 83/144 | 2 / 1 | 35.42 | 659 / 494 / 1,437 | 3.66 / 3.62 | 0.577 | 12.16 | 996.77 |
| `syncCold` + `syncDelta` | 94/144 | 0 / 0 | 6.69 | 1,738 / 473 / 4,639 | 5.76 / 4.49 | 0.489 | 2.55 | 177.74 |
| the same, no re-read | 95/144 | 1 / 0 | 5.85 | 1,017 / 143 / 3,827 | 5.22 / 4.28 | 0.551 | 2.37 | 156.81 |

Paired, trial − default: hidden **+0.076 (+0.007..+0.146)**; control −0.014 (−0.035..0); neutral −0.007 (−0.021..0);
connector calls on the mix **−28.7 (−30.4..−27.1)**; agent + Eden $/1k on the mix −0.027 (−0.042..−0.012); Eden's
path **+1,080 ms (+817..+1,368)**; wall **+2,098 ms (+1,703..+2,512)**. No re-read − default: hidden +0.083
(+0.014..+0.153); calls −29.6; path +358 ms (+191..+533); wall +1,563 ms (+1,242..+1,910). The concerns are
Haiku-graded and were not regraded (the trial has fewer).

Calls that remain (trial arm, a task): calendar search 0.57 (the calendar is not in the cold tier), gmail fetch 0.48,
drive and slack fetch 0.16 (the re-reads of copies brought back), gmail list 0.48, calendar list 0.30, delta reads
0.65 over the world's sources, the rest polls of noise connectors at ~0.02 each.

The first read of a new user: 1,004 → 1,625 calls (the cursors, and the listings read to their end). The lab gives
each user only six tasks, so its all-in columns are dominated by it; at 31.7 fewer calls a task it is paid back
after about 20 tasks.

**Why the tasks are slower.** By process: seeds 41–42 (two arms a process) path +539 ms, wall +774 ms; the no-re-read
arm alone in its own process path +100 ms (−31..+256), wall +369 ms (0..+734); seeds 43–44 (three arms a process)
path +1,621 and +617 ms, wall +3.4 and +2.8 s, with the model's time to first token at 2.3–2.6 s against 0.8 s for
the default arm in the same process. What is known:

- The re-read of copies brought back (`syncColdVerify`) waits on a connector on the agent's path: observe 144 → 688
  ms a task. That part is the price of not delivering a copy older than a live search would have returned.
- The rest is Eden's own CPU, which a lab process shares between its agent streams: the day bench reads 2.7 times
  the CPU a user-day and 1.8 times at cold start, and a lookup brings 47 items back into the index and opens 30
  blobs. In the one-process funnel the ask's median rose only 12 → 14–19 ms, so the cost is in the churn between the
  tiers and the cold start, not in one lookup's match. It was not profiled further, and how much of the wall time
  is the lab's packing (72 new users a shard, each with a 1,000-source cold start, beside running tasks) was not
  isolated.

## 7. Decision (D479)

The brief's rule: promote only if hidden facts are not worse (paired), stale and deleted deliveries are not worse,
and calls a task fall. All three hold. **Not promoted**, because the same run shows costs the rule did not name and
D112 does ("better or neutral at no extra cost"):

- tasks slower by 1.6–2.1 s of wall on the mix in the lab, partly on the agent's path;
- about 8.9 MB of cold items for a 1,000-source user of small sources (a live user at the 3,000-item cap is about
  2.7 MB of heap in `users.bench.ts`, C3's table), and far more for large ones;
- 2.7 times Eden's CPU a user-day at 1,000 sources;
- `syncDelta` moves nothing for a shipped connector: `McpSource` has no delta tool.

`syncCold` (with `syncColdMaxItems`, `syncColdVerify`) and `syncDelta` stay as trial switches, off, in the trials
table to 2026-12-08. Nothing moves for the default: `bun run check` green, the eval 0.65 / 0.52 / 0, the funnel
314/273 at five sources.

## 8. What is left

- **The cold tier's CPU.** Bring back fewer items (the best few across the lookup, not 8 a source), keep a matched
  item cold until it is delivered or cited rather than indexing every match, and stop rewriting a source's open
  chunk on every trim. Then rerun this note's live pair with one arm a process.
- **Memory.** The packs are the obvious thing to write to disk under D425's opt-in (encrypted, per user), with the
  filters and id sets in memory; that is what the brief described, and it is what a complete copy of large sources
  needs (105 MB in memory at 300 items a source). Not built here.
- **A delta tool for `McpSource`** (`deltaTool`, read-only checked like `listTool`), with the mapping from a
  connector's reply to `ChangePage`, and the presets that have one (Gmail history, Drive changes, Calendar sync
  tokens). Until then `syncDelta` is exercised only by the sim and by an embedder's own `Source`.
- **Calendars.** A source that lists by time is not in the cold tier and its cut copy is still searched live (0.57
  calls a task here).
- **Recall against a connector's own search** (−0.03 in quality-cli under a 300-item cap): the local index answers
  a mail or chat search by every word (`syncLocalAll`); what the connector's ranking finds beyond that was not
  studied.
- **Mentions.** Items a background read puts straight into the cold tier get no entity mentions recorded, so
  routing learns nothing from them until they are brought back.
- **The first read.** 60% more calls for a new user; it could be spread over the user's first days for sources
  that no request has routed to.
- **Triggers.** Whether to take a platform's event triggers is a per-plan choice by price (section 5); nothing in
  Eden picks it.

## Reproduce

```bash
unset BUN_OPTIONS
bun test ./packages/engine/src/cold.test.ts ./packages/engine/src/delta.test.ts
F="bun run funnel --jobs 2 --suite train1,train2,train3,train4,train5,train6"
$F --seeds 41 --json n41-base.json -- --noise-sources 995 --limit 16                       # and 42
$F --seeds 41 --set '{"syncCold":true}' --json n41-cold.json -- --noise-sources 995 --limit 16
$F --seeds 41 --json n41-basemix.json -- --noise-sources 995 --limit 16 --connector-mix 0.3,0.3
$F --seeds 41 --set '{"syncCold":true,"syncDelta":true}' --json n41-local.json -- --noise-sources 995 --limit 16 \
  --connector-mix 0.3,0.3
python3 -I packages/sim/lab/c4/ask-pair.py n41-base.json n41-cold.json
bun run funnel --jobs 4 [--set '{"syncCold":true,"syncDelta":true}']                         # 314/273 both
# qrun.sh NAME MIX LOST CONFIG: quality-cli --users 16 --sessions 20 --updates 0.6 --deletes 0.1 --jobs 4 --push signals
packages/sim/lab/f1/qrun.sh delta-0,1-l0 0,1 0 '{"sync":true,"syncDelta":true}'
packages/sim/lab/f1/qrun.sh cap300cold-0,0-l0 0,0 0 '{"sync":true,"syncMaxItems":300,"syncCold":true}'
python3 -I packages/sim/lab/f1/fresh.py name=.local/f1/q-NAME.json …
B=packages/engine/bench/source-days.bench.ts
bun $B 1000 20 8 > base.json; bun $B 1000 20 8 '--config={"syncCold":true}' > cold.json
bun $B 1000 20 8 --mix=0.3,0.3 '--config={"syncCold":true,"syncDelta":true}' > local.json
python3 -I packages/sim/lab/f1/days.py base=base.json cold=cold.json local=local.json
# Live (Modal; go.sh RUN SEEDS CAP CONDITIONS VARIANT_CONFIG):
VC='{"local":{"syncCold":true,"syncDelta":true},"fast":{"syncCold":true,"syncDelta":true,"syncColdVerify":false}}'
packages/sim/lab/f1/go.sh f1-b 43,44 1.6 'eden,eden~local,eden~fast' "$VC"
python3 -I packages/sim/lab/a8/pair.py base=S1:eden,… local=S1:eden~local,… --pair base,local   # S = STEM of out.json
python3 -I packages/sim/lab/f1/path.py base=S1:eden,… local=S1:eden~local,…
bun packages/sim/src/lab/pi-cost-report.ts …/out.json … --trigger-avoids 1 --events-per-task 1
```

`a8/pair.py` and `f1/path.py` read `STEM.json` and `STEM.tl/tasks.jsonl`: link each shard's `out.json` and
`out.timeline` under those names. `go.sh` and `qrun.sh` use this session's paths (`.local/venv-modal`, `.local/f1`).

## Spend

| Run | Shards | Anthropic $ |
| --- | --- | --- |
| f1-a: seeds 41, 42; default and trial | 2 | 0.1345 + 0.1432 |
| f1-b: seeds 43, 44; default, trial, no re-read | 2 | 0.1762 + 0.1853 |
| f1-c: seeds 41, 42; no re-read | 2 | 0.0859 + 0.0879 |
| **Total (manifests)** | 6 | **0.8130** |
