# O4/O5: the review of `syncKick` (D751), and how each finding was closed (D753)

Status: 2026-11-11, branch `claude/o4-new-user`. The reviewer returned REQUEST_CHANGES on c26a1d31 with eight
findings. O4 fixed the first; O5 closed the rest, below. The paid check (o4-new-user.md §6b) has since passed and
the switch is in the default (D755). Figures are from commands run on 2026-11-11 on a 4 vCPU, 16 GB box, Bun 1.4.4;
their outputs are in
`packages/sim/lab/o5/`.

## The findings

1. **A resume timer could start a second step beside a tick's step for the same user.** Fixed by O4
   (`UserSync.ticking`). Now tested, for batches and for the pool: a kick, and a resume timer, that meet a tick's
   step start nothing and look again in 500 ms; a tick that meets a kicked step waits for it. Without either wait
   the tests see a page listed twice (batches) or more reads at once than the pool's lanes.
2. **The tests passed with most of the new code removed.** Rewritten (`sync-kick.test.ts`, 28 tests). The clock and
   the timer are the test's own and move only when told, so a budget stop is real and each wait is read in the
   clock's milliseconds. `packages/sim/lab/o5/mutate-sync-kick.py` applies 34 mutations to the engine (the resume
   timer, what its wait is made of, the cap, the timer's clearing in `forget` and `drop`, both waits of finding 1,
   the bound across users and its queue, `stopKicks`, the pool's `left` set, its back-off check, its lanes, a gone
   user's page, the first retry, and the second review's: see below) and runs the file after each: all 34 fail it. One
   line found redundant that way
   was removed (a source its budget stopped needs no place in `left`: a refused `take` spends nothing).
3. **The resume wait mixed clocks.** `SyncDeps.after` (`PartnerDeps.after`): one timer on `now`'s clock, used for
   every kick wait and nothing else. Absent, it is `setTimeout`, which is right when `now` is the wall clock (the
   servers, the lab's `--time 1`); a caller with another clock passes its own. The tests pass one, and one of the
   mutations puts the wait back on the wall clock.
4. **Kicks were not bounded across users, and `stopSync` did not stop them.** At most four kicked steps run at
   once (`KICKS_AT_ONCE`): four pools of 32 are the 128 listings at once that a tick's 16 users in batches of 8
   already are. The rest wait their turn in arrival order (across tenants, as a tick's queue is), and a tick leaves
   a user alone while a kick holds them (the second review, below). `stopSync` cancels
   every resume timer, lets the waiting users go and stops new kicks until `startSync` (`stopKicks`).
   `bench/storm.bench.ts`, 300 users arriving at once beside 20 warm users sending an event every 10 ms, off → on:

   | Ticks | Storm wall | Warm users' `observe` p99 | Max | Loop lag max |
   | --- | --- | --- | --- | --- |
   | Back to back (the bench as it was) | 76.3 → 76.8 s | 50.3 → 48.5 ms | 93.6 → 75.6 ms | 327 → 334 ms |
   | Every 60 s, as the servers | 137.4 → 79.6 s | 45.6 → 49.3 ms | 74.7 → 85.1 ms | 324 → 344 ms |

   One run each. With the servers' timer the storm is over in 80 s instead of 137 s, and the warm users' p99 is
   what it is in a storm today. Their p50 rises there (2.84 → 14.61 ms): today the storm's work is spread over the
   idle minute before the first tick, and half of their events fall in it. The bench's users have three sources,
   so it does not exercise the pool's lanes; the bound across users with many sources is held by a unit test.
5. **Figures no recorded file backed.** Re-run and recorded, or withdrawn; o4-new-user.md and D751's row now carry
   the recorded ones. "Five sources read in about 6.5 s" did not reproduce: alone, 20 users, 7.8-17.3 s, median
   10.2 s (`trace-5.txt`). The 1,000-source trace reproduced (`trace-1000.txt`, three users each): batches of 8
   112-123 s, a pool of 8 54-56 s, a pool of 32 all but five sources at 13.5-14.2 s; the cap is reached at 16-19 s,
   7.6-7.7 s and 2.0-2.1 s. The funnel re-run (`new-user-5.txt`, the funnel's own call lines under its table):
   listing calls 18.48 → 18.00 a user, items listed 577,529 → 579,968, the requests' own calls 7.57 → 2.77 a
   request; the table's shape is O4's (62 → 149 of 192 at 10 s, 154 from 25 s).
6. **The lab's `sync: backfill` line counted only what ticks returned.** With `--connect-at` it now reads the
   sync's own count of background calls at the end of each user.
7. **Lab, small.** `--connect-at` without the sync throws. The note says a world's users share its noise
   connectors' rate buckets and fault draws. The neutral variant runs in its own phase, so its users take the
   hidden variant's slots after those are done (said in the code).
8. **Engine, small.** `kick` starts its step in a microtask, so no part of the tenant's resolver runs inside
   `observe` (tested). The config comment says a kicked user keeps the pool in later ticks. The two wall-time
   assertions are gone with the test clock. The pool trims once per page landed only while the user is at the cap,
   as `backfill` does once per batch; not measured apart, and the traces above include it.

## Added beyond the findings (D753)

- **A first retry after 1.5 s** for a page of a source still in its first backfill that failed once
  (`syncKickRetryMs`), then 30 s and doubling as before. A new user's lookups wait on each source's first page; a
  1,000-source user alone was fully read in 15.2-16.5 s with it and 39.0-44.6 s without (`trace-1000.txt`).
- **`pi-ab --connect-at`** and the paid check's run and report scripts (docs/LAB.md).

## The second review (on bffe77db): REQUEST_CHANGES, closed

The reviewer re-ran the gates (green), the mutation check (26 of 26) and the paid check's reports from the raw
results (identical), found the paid check's conclusion sound, and returned four findings.

1. **The bound across users did not hold when a tick came during a storm** (correctness). A user waiting for a
   kick turn was already marked for the pool, and the tick's 16 lanes stepped such users as 32-lane pools beside
   the four kicked steps: 512 listings at once in the reviewer's probe (24 users of 40 sources), against 128
   without the switch. The storm bench could not see it (three sources a user). Fixed: only a kicked step reads as
   a pool (a tick's step reads batches, for a user who was kicked too), and a tick does not step a user whose kick
   is waiting for a turn or for its resume timer. Tested with the reviewer's shape: 24 users of 40 sources and a
   tick in the middle read at most 128 at once, four users at a time, each page once.
2. **Mechanisms no test held** (25 further mutations of the reviewer's). Now held: only a user new to the sync is
   kicked (a later event, or a user tracked another way, starts nothing); the pool at the user's cap keeps and cuts
   what the batches do; a kick after a tick's step ended unfinished; the quick retry only in a first backfill (a
   warm source that fails waits 30 s); a user forgotten while waiting for a turn; the budget's wait in batches.
   The mutation list is 34 now, all failing the file. One is listed there as not held: warming, at the cap, a
   source whose page is still on the wire, which changes nothing a test can see.
3. **The paid check's per-checkpoint intervals resampled each seed's task on its own**, not a task's seeds
   together as registered. Fixed in `new-user-pi.py`; the intervals widened a little (o4-new-user.md §6b) and no
   condition changed.
4. **Three figures had no committed file** (listing calls, items listed, request calls of the funnel re-run). The
   funnel's lines are now under the table in `new-user-5.txt`; "items listed" was wrong by a factor of two in the
   note (a sum taken twice) and is corrected: 577,529 → 579,968.

Nits taken: comments that still said "a trial"; `stopKicks`' comment; the storm bench, TESTING.md and LAB.md now
say the off arm needs `{"syncKick":false}`; LAB.md's `run.sh` arguments; the p50 sentence above; the resolver being
asked at each resume and the queue being first come across tenants, both said in `sync.ts`; long prose lines.
