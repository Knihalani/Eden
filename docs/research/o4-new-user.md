# O4: a new user's time to full strength (the backfill starts late and stops for the timer)

Status: measured 2026-11-10/11 on branch `claude/o4-new-user` (from `claude/o4-work`). Decisions D751 (the trial
`syncKick`, O4), D753 (its review closed, a quick first retry, O5) and D755 (promoted into the default after the
paid check of §6, O5). §1-§4 are no-model runs with the reader stub ($0), as the funnel's usual screen; §6b is
the paid check ($2.43 on the Anthropic API in all, Anthropic-direct lab figures). Machine: 4 vCPU, 16 GB, Bun
1.4.4. Tables: `packages/sim/lab/o4/new-user-5.txt`, `new-user-1000.txt` (O4's runs), `packages/sim/lab/o5/`
(O5's re-runs with the final code, the traces, the storm and the paid check's reports).

## In plain words

- **The question.** A user connects their sources. How long until Eden is as good for them as for a user it has
  known for days?
- **Today: about three minutes with five sources, and more than five minutes with a thousand.** For the first half
  minute a five-source user gets under half of the hidden facts a settled user gets (34-46% against 80%); a
  thousand-source user gets none at all for the first 25 seconds.
- **Why.** Not because reading the sources is slow: one user's five sources are read in about ten seconds (alone,
  20 users: 7.8-17.3 s, median 10.2 s; O4 first wrote "about 6.5 seconds" from a run that was not kept and did not
  reproduce). Three waits, each for the server's 60-second timer:
  1. The first reading of a new user's sources does not start when they arrive. It starts at the next timer tick.
  2. It then stops when a large mailbox has used its allowance of calls (ten pages at once, then one every two
     seconds) and waits for the next tick, although the allowance would permit the next page a second later.
  3. If it meets the user's first request on the same source, our own guard refuses it the page, and again it waits
     for the next tick. Starting the reading at once without fixing this did nothing at all (measured).
  With a thousand sources there is a fourth: the reading takes its sources eight at a time and waits for the slowest
  of each eight, so a thousand sources take about two minutes where the calls themselves need about fifteen seconds.
- **The change (`syncKick`, on in the default since D755).** Start the first reading with the user's first event, take
  it up again as soon as
  it is allowed instead of at the next tick, and for such a user read 32 sources at once, each lane moving on as
  soon as its page is in. The same calls under the same allowances; no model call.
- **What it does, measured:**

  | Sources | Full strength today | With the trial | First half minute today | With the trial |
  | --- | --- | --- | --- | --- |
  | 5 | about 180 s | about 25 s (78% at 10 s) | 34-46% of hidden facts | 46% at 0 s, 78% at 10 s, 80% at 25 s |
  | ~1,000 | not reached at 300 s (67%) | about 45 s (75% at 25 s) | 0% | 46-52% at 0-10 s |

- **With an agent (§6b, paid, pre-registered).** Pi on Haiku, 1,152 new users an arm over two seeds. Ten seconds
  after connecting, the agent raised the hidden fact in 34.9% of requests today and 65.1% with the change (+30.2
  points, 23.7 to 36.7). At 45 seconds: 59.4% and 63.8% (+4.4, 0.5 to 8.6). False concerns confirmed by Sonnet: one
  in 1,536 in each arm. Connector calls a user until their sources are read: 42.3 → 18.0 (−57%), because requests
  no longer search live for what the copy now holds. Every condition registered beforehand held, so the switch is
  in the default.
- **What it does not fix.** The very first request, at second 0, still runs before anything is read: 46-52%.
  A tenant should send the user's first event when they connect, not with their first request
  (docs/INTEGRATION.md).
- **Since fixed (D753):** a source whose listing failed once was not tried again for 30 seconds; in a user's first
  backfill it is now tried again after 1.5 seconds (a 1,000-source user alone: fully read in 15-17 s, not 39-45 s).

## 1. How it was measured

`hidden-funnel.ts --connect-at S1,S2,…` (new; docs/LAB.md). Each world runs once per task, as a user of its own.
The user's first event comes at second 0 (it tracks them; nothing is synced), and they make one request at each
checkpoint: replica r asks task (r + j) mod T at checkpoint j, so every task is asked at every checkpoint once, each
time by a user whose earlier requests were other tasks. Time is real: connectors answer at the market profile's
latency (`direct.json`, `--time 1`), the sync's timer ticks every 60 s with its first tick 30 s after the connect
(the average wait), each card call takes 2.7 s (Haiku's p50, docs/COST-MODEL.md; the replayed card maker otherwise
answers at once), and nothing waits for the backfill or the cards. Surfaced means delivered or cited by the ask, as
the funnel scores it. Reader stub; intent requests replayed (D158).

- Five sources: train1-6, seed 41, 32 users a world and variant, 192 hidden and 192 control requests a checkpoint.
- ~1,000 sources: train1-3, seed 41, `--noise-sources 995 --limit 16`, 48 hidden and 48 control requests a
  checkpoint. A world's users share its 995 noise connectors (they hold 550 MB a world), so calls a task are not
  read there.

Limits of the method: one seed; the users of a shard share one process (64 at five sources, staggered 2 s apart; 32
at 1,000 sources, 12 s apart), so a user's backfill can be slowed by its neighbours' (alone, a five-source user is
complete in 7.8-17.3 s, median 10.2 s, 20 users, `o5/trace-5.txt`; in the shard 142 of 192 were complete at 10 s
and all at 25 s); a world's users also share its noise connectors' rate buckets and fault draws; the reader is the
stub, so these are what Eden surfaces, not what an agent raises (§6b is that).

## 2. Five sources

Hidden surfaced of 192, by seconds since the connect (`new-user-5.txt`):

| Seconds | Today | Tick at the connect, no resume | `syncKick`, batches | `syncKick`, pool of 32 |
| --- | --- | --- | --- | --- |
| 0 | 88 | 89 | 85 | 89 |
| 10 | 65 | 69 | 146 | 149 |
| 25 | 81 | 81 | 147 | 154 |
| 35 | 113 | 75 | 150 | 154 |
| 45 | 129 | 73 | 154 | 154 |
| 60 | 128 | 95 | 154 | 154 |
| 90 | 133 | 141 | 154 | 154 |
| 180 | 154 | 153 | 154 | 154 |

"Tick at the connect, no resume" is the naive fix (the harness ticks at second 0): the backfill met the first
request, was refused a page and held 21 items until the tick at 60 s. Decoys surfaced end where they do today
(140-141 of 192): they arrive sooner as the facts do.

O5's re-run with the final code (D753: the bound across users, the quick retry; `o5/new-user-5.txt`), today → the
pool: 86 → 92, 62 → 149, 85 → 154, 108 → 154, 132 → 154, 132 → 154, 134 → 154, 153 → 154; decoys end at 140 both.

Connector calls, from that re-run (the figures O4 quoted here were from runs that were not kept): the backfill's
listing calls are 18.48 a user today and 18.00 with the change, the items they list 577,529 and 579,968 over 384
users, and the requests' own calls fall from 7.57 to 2.77 a request, since copies answer sooner (the funnel's own
lines, a shard each, are under the table in `o5/new-user-5.txt`).

## 3. About 1,000 sources

Hidden surfaced of 48 (`new-user-1000.txt`):

| Seconds | Today | `syncKick`, batches of 8 | `syncKick`, pool of 32 |
| --- | --- | --- | --- |
| 0 | 0 | 24 | 25 |
| 10 | 0 | 24 | 22 |
| 25 | 0 | 28 | 36 |
| 45 | 25 | 27 | 39 |
| 60 | 27 | 28 | 38 |
| 90 | 29 | 27 | 39 |
| 120 | 27 | 35 | 39 |
| 180 | 27 | 40 | 39 |
| 300 | 32 | 38 | 38 |

A settled 1,000-source user reads 38 of 48 on the same tasks (o4-segment-screens.md §6). Today a new one is at 0
until the first tick, about 55% from 45 s to 180 s and 67% at 300 s, with 8 of 48 users' copies complete. With the
trial and the pool it is at 75% at 25 s and at full strength from 45 s.

Where the two minutes went (one user traced alone, 995 noise sources, three users each, `new-user-trace.ts`,
`o5/trace-1000.txt`): the backfill lists 1,000 first pages. In batches of 8 it made 6-9 calls a second (each batch
waits for its slowest page): all 1,000 at 112-123 s. A pool of 8 lanes: 54-56 s. A pool of 32: all but five at
13.5-14.2 s; the last few are listings that failed once, read by 39-45 s with the 30 s back-off and by 15.2-16.5 s
with D753's 1.5 s first retry. The user's items reach the cap (3,000) at 16-19 s, 7.6-7.7 s and 2.0-2.1 s; what
the lookups wait for is each source being known complete or cut, which needs its first page.

## 4. The change

`syncKick` (D751; `SyncManager.kick`, `backfillPool`; `syncKickLanes` 32):

- `observe` calls `kick` for a user `track` has just added. The user's step starts at once; a tick that comes
  meanwhile waits for it and starts no second one.
- When a kicked step ends with sources still backfilling, it is taken up again after the longest of: 500 ms
  (`KICK_RESUME_MS`: a page one of our guards refused), the call budget's own wait, the soonest back-off's end. At
  most 128 times (`KICK_RESUMES`), then the ticks take over. Every wait is on the engine's clock, through one
  injected timer (`SyncDeps.after`, D753).
- At most four kicked steps run at once across users (`KICKS_AT_ONCE`: the 128 listings at once a tick already
  allows); the rest wait their turn, and a tick leaves a user alone while they wait for a kick turn. Only a kicked
  step reads as a pool; a tick's step reads batches. `stopSync` cancels them (D753).
- A page of a first backfill that failed once is tried again after 1.5 s (`syncKickRetryMs`), then 30 s and
  doubling as before (D753).
- A kicked user's backfill reads as a pool: a lane takes the next source, newest unread page first, as soon as it is
  free; a source that must wait for its budget or whose page failed is left for the resume and the others go on.
- Off (the `sync` part taken out, or `syncKick: false`), nothing changes: `track` returns a value nobody reads, and
  the tick's lane takes the path it took.

Tests: `sync-kick.test.ts`, 28 tests on a clock and a timer the test moves by hand, each holding one mechanism:
35 mutations of the engine each fail it (`packages/sim/lab/o5/mutate-sync-kick.py`; o4-new-user-review.md).

## 5. What is left

- **Second 0.** The first request is looked up before anything is read. A second look when the backfill lands, a
  few seconds later, could hand its finds at the agent's next take; whether an agent takes it needs a live run (C4
  found no follow-up packet was ever taken on Pi within a task).
- **A failed listing waited 30 s.** Done (D753): a first retry after 1.5 s closes the 15-40 s tail.
- **With a thousand cold sources and no history, a lookup has nothing to route on** (0 of 48). A prior from the
  tenant's other users (which connectors have ever been useful, counts only) would give one; it crosses the
  per-user partition, so it is the owner's decision, not built.
- **A tenant cannot say "this user just connected".** Any event does it (a `session_start` with no request), which
  is what the harness sends. Documented for integrators (docs/INTEGRATION.md, D755).

### 5a. The tenant prior: a proposal for the owner (O5; nothing is built)

**The gap.** A new user with a thousand sources and no history gives routing nothing to rank on. Before their
backfill has read a source, a lookup reads sources on the prior's draw: 0 of 48 hidden facts in the first 25 s today,
22-25 of 48 at 0-10 s with `syncKick`, against 38 for a settled user (§3). Their own evidence (mentions, sketches,
used sources) arrives with the backfill and the first requests. Other users of the same tenant already have it.

**What would be counted.** Per tenant and per connector the tenant offers (the connector's tenant-level name, such
as `gmail` or `crm`; never a per-user source id), two whole numbers:

1. users of the tenant who have the connector connected and synced;
2. of those, users for whom it was ever *used*: a lookup of theirs read it on evidence of its items (`Sync.engage`,
   D320) and an item from it was then handed to their agent.

**That it is counts only.** No item, title, text, term, sketch, entity or person name; no request text; no user id;
no per-user row leaves a user's partition. A user contributes one bit per connector (used or not), added to the
tenant's two counters. A connector's counts are read only once at least k users of the tenant stand behind them
(k = 5 proposed), so no count describes a small group; below k the prior is today's flat one.

**What crosses the per-user partition, exactly.** Today every piece of state is keyed by tenant and user (D9).
This adds one piece keyed by tenant alone, and a read of it inside a user's lookup: a new user's starting weight for
a connector is the tenant's share (2 over 1), instead of the same weight for all. So one user's routing is shaped by
a fact about other users: "in this tenant, people who connect X end up using it". What that can reveal: nothing in
any packet or answer, which carry only the user's own items; but which sources Eden reads first for a new user is
observable to the tenant (it sees the connector calls), and it already knows which connectors its users use. It
reveals nothing across tenants, and nothing to one end user about another by name. It is still a crossing D9 does
not allow, so it needs a decision by the owner.

**Erasure and retention.** A forgotten user's bits must leave the counts. Either each user's contribution is kept
in their own partition (so `forget` subtracts it), or the counts are rebuilt on a schedule from the users the sync
still holds. The first is exact; the second needs no new per-user state. Proposed: the first.

**What it would be worth, and how to find out before building.** Unknown. The honest first step is a $0 screen
with a lab-only oracle prior (the funnel's 1,000-source `--connect-at`, the five world connectors marked "used by
the tenant", the 995 others not): if hidden facts at 0-10 s do not move towards the settled 38 of 48, the idea is
dead at no cost. It only matters before the backfill's first pages are in, which `syncKick` brings down to about
15 s (§3), so the window it can help is short.

**Alternatives that cross nothing.** (a) The tenant says which connectors matter, in its own configuration (a
static weight per connector name): no user's data is read, and the tenant knows its product. (b) A default weight
by connector kind shipped with Eden (mail and calendar ahead of a wiki): no data at all. Both can be screened the
same way and may give most of the gain.

**Asked of the owner:** whether a tenant-level count of this kind may exist at all; if so, k and the erasure rule.
Until then nothing is built, and the $0 screen above uses no real data and no product code.

## 6. A paid check, pre-registered

Written before any paid call. Pi, train, seeds 41-42, `--tenant-prompt`, Haiku in every role (Anthropic-direct lab
figures), Sonnet regrade of concerns; arms `eden` and `eden~K` (`syncKick` on); each user new, requests at 10 s and
45 s after their first event (pi-ab needs the funnel's `--connect-at`; not built). Promote only if all hold:
hidden facts raised at 10 s up by at least 10 points with the paired interval above zero; hidden at 45 s not worse
(interval's lower end above −5 points); Sonnet-confirmed concerns on control and neutral not up by more than 1
point; connector calls a user not up by more than 2%; `bun run eval` and the default funnel unchanged with the
switch on. Estimated cost under $1.

### 6a. The run as registered (O5, 2026-11-11, written before the first paid call)

`pi-ab --connect-at` now exists (docs/LAB.md). What §6 left open is fixed here; nothing below was chosen after a
paid result.

- **Run.** `packages/sim/lab/o5/run.sh`: Pi, train1-6, variants hidden, control and neutral, `--connect-at 10,45`,
  arms `eden` and `eden~K` (`{"syncKick":true}`, which brings D753's first retry and bound with it), `--tenant-prompt`,
  Haiku 5.5 as agent, grader, card and reader model on the Anthropic API (Anthropic-direct lab figures), cards
  replayed at 2.7 s a call, the market `direct` profile, payload notices, first tick 30 s after the connect, users
  2 s apart. One process a seed, at most two at once. Ledger `.local/o5/ledger.jsonl`.
- **A pricing smoke first** (train1, hidden, `--limit 2`: 8 task runs, label `o5-smoke`). It is read for the cost of
  a task run and for whether the harness works, not for any outcome, and its rows are not pooled.
- **Size.** `--limit L` tasks a suite and variant, the same L for every suite, with L and the seeds (41, then 42)
  chosen from the smoke's price so the whole check stays under about $2. A task run is one user at one checkpoint.
- **Outcomes.** Raised: a hidden answer with any fact true by the run's grader. Concern: a control or neutral
  answer with any fact true, counted only where a Sonnet 5.5 regrade (`regrade.ts --only-concerns`) agrees. Pairs
  are (seed, task, checkpoint) across the two arms; intervals are 95% from a bootstrap that resamples tasks
  (a task's two checkpoints and its seeds stay together). Connector calls a user: every call Eden made for the user
  from their first event until their backfill is complete (at most 200 s), mean by arm.
- **Rule.** As §6: raised at 10 s up by at least 10 points with the interval above zero; raised at 45 s not worse
  (lower end above -5 points); confirmed concerns on control and neutral not up by more than 1 point; calls a user
  not up by more than 2%; the eval and the default funnel unchanged with the switch on. All hold: promote. Any
  fails: the switch stays a trial or goes, as the failure says.
- **What would make the run void, not failed:** more than 5% of task runs in error in either arm, or a spend stop
  before both arms of a seed are complete. A void run is reported and re-run once.

### 6b. The result (O5, 2026-11-11): every condition held; promoted (D755)

`python3 -I packages/sim/lab/o5/new-user-pi.py` on the twelve result files (one a suite and seed); its output is
`packages/sim/lab/o5/check-haiku.txt` and, with the Sonnet regrade, `check-sonnet.txt`. Seeds 41 and 42, no
`--limit`: 576 tasks a seed (192 hidden, 192 control, 192 neutral), each asked once at each checkpoint in each arm,
by a user of its own: 4,608 task runs, 2,304 users, no errors, none ungraded. Anthropic-direct lab figures.

| Condition registered | Today (`eden`) | With `syncKick` (`eden~K`) | Difference (95%) | Held |
| --- | --- | --- | --- | --- |
| Hidden raised at 10 s: up at least 10 points, interval above zero | 134 of 384, 34.9% | 250, 65.1% | +30.2 points (+23.7 to +36.7) | yes |
| Hidden raised at 45 s: lower end above −5 points | 228, 59.4% | 245, 63.8% | +4.4 (+0.5 to +8.6) | yes |
| Confirmed concerns, control and neutral: not up by more than 1 point | 1 of 1,536 | 1 of 1,536 | +0.0 (−0.2 to +0.2) | yes |
| Connector calls a user: not up by more than 2% | 42.34 | 18.00 | −57.5% | yes |
| The eval and the default funnel unchanged with the switch on | 0.65 / 0.52 / 0; 315 / 276 on main's tree (314 / 274 on the first base) | the same; 768 of 768 task rows identical | | yes |

Before the Sonnet regrade the run's own grader called 11 control and neutral answers concerns today and 13 with the
change (+0.13 points, −0.52 to +0.78); Sonnet confirmed one in each arm (24 answers regraded, $0.027). The
intervals resample tasks with their two seeds and checkpoints together, as registered (the first report resampled
each seed's task on its own, which the reviewer caught: 24.2 to 35.9 and 0.5 to 8.3 then; no verdict moved).

The last condition is true but says little about the kick itself: the eval's sources do not list, and the default
funnel backfills its users before their first event, so no user is kicked in either. What it shows is that users
the sync already holds are untouched. The kick's own effect at $0 is §2 and §3.

What else the run shows:

- The backfill was complete for no user at their 10 s request today and for all 1,152 with the change (median 42 s
  and 8.4 s to complete); at 45 s for 824 of 1,152 today.
- The agent's task was also quicker at 10 s: 4.19 → 2.09 s of wall a task (2.62 → 2.08 s at 45 s), since its
  requests no longer wait on live searches. Cost a task was the same ($0.249 → $0.253 per 1,000 at 10 s, $0.233 →
  $0.211 at 45 s).
- Calls a user fall because a request made before the copy is read searches every source live; the listing calls
  themselves are the same (§2).

What went wrong on the way, and what it cost. The run was started three times. (1) Both seeds as one process
each: stopped unread 12 minutes in, because pi-ab's new mode kept every finished user's sources and cache alive
(about 11 MB a user; fixed, and flat at 1.3 GB after). (2) Restarted: the container was restarted 20 minutes in,
by the session's memory limit as far as can be told (a $0 funnel was running beside it), before either process
had written its results. (3) One process a suite and seed, so a loss is a few minutes: one piece was killed by
the same memory limit and re-run; the rest completed. No outcome of a stopped run was read (a process writes
results only at its end). The pricing smoke ran 144 task runs, not the 8 registered (a flag of mine was
overridden by the script's own); its rows are not pooled. Departures from §6a: one process a suite and seed
rather than a seed; and the smoke's size. Spend: $1.43 for the completed pieces (the killed piece among them),
$0.03 the regrade, $0.05 the smoke, $0.93 the two stopped attempts: $2.43, against "under about $2" registered for
the check itself.

Limits: Haiku as the agent; train suites; five-source users (a 1,000-source user was measured only at $0, §3);
users connect 2 s apart in a process of at most 48, so a real server's first seconds under a storm are the storm
bench's (o4-new-user-review.md), not this run's.
