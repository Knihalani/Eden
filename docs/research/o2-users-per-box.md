# O2: users per box — the capacity bench corrected, and frozen users on disk only

Status: built and measured 2026-11-10 on branch `claude/o2-capacity` (from `claude/lucid-hypatia-v9wqk5` at
3ee07ac65). Decisions D651 (finding), D652 (trial). Paid spend: $0 (no-model runs). Machine: 4 vCPU, 15 GB, Bun
1.4.4, `BUN_OPTIONS` unset, benches one at a time.

## In plain words

- **The record understated how many users a box holds.** A14 and A24 sized a 4-core 16 GB box at about 2,280 users
  from a bench run described as "a quarter of the users active, three quarters frozen". The bench froze only half:
  it ran two expiry ticks between waves and a user freezes on the third. Fixed, the same run reads **3.39 MB a user,
  not 5.0-5.16: about 3,460 users on that box, 1.5x the record**, with no change to the product.
- **How many users fit depends mostly on how many are active at once.** Measured, same bench: a quarter active 3.39
  MB a user, an eighth 2.36 MB, a twentieth 1.46 MB (about 8,000 users on the box). Nobody has measured what share
  of a real fleet is active inside the 20-30 minutes before a user freezes; a quarter is A14's convention.
- **Frozen users on disk only (a trial, off).** When the operator already keeps frozen users on disk (D425), the
  copy in memory is a duplicate. With `EDEN_PERSIST_DISK_ONLY=1` the memory's copy goes once the file is written and
  the file is read back when the user returns. A frozen user's heap falls from 0.41 to 0.12-0.13 MB and its resident
  memory from 0.62 to 0.35 MB. On a whole fleet that is **1.2x more users at a twentieth active** (1.46 to 1.22 MB a
  user) and 1.06x at an eighth (2.36 to 2.23 MB): live users, not frozen ones, hold most of the memory. The thaw is
  6-9 ms slower at the median (the file's read and decrypt). No content reaches the disk that D425 does not already
  write.
- **What did not work.** Bun's `--smol` mode changed nothing (4.99 against 5.00 MB resident a user).
- **What is left.** A live user is 4.5 MB of heap but 6.3 MB resident after a thaw and more after an ingest burst.
  The next factor is there, or in freezing sooner (a thaw is 145-150 ms of CPU at the cap), not in frozen users.

## 1. The bench's waves (D651)

`users.bench.ts --waves=K` brings the users in K waves and freezes the earlier ones before the next arrives, to
measure a steady state with 1/K of the users live. It ran two `expireIdle` ticks between waves. `freezeTicks` is
`max(2, ceil(freezeIdleMs / expireEveryMs))`, three at the defaults (30 and 10 minutes), so the wave before the last
was still live at the reading: 2/K live, not 1/K. The bench now ticks until every earlier wave is frozen, fails if
that does not happen, and prints the count.

`bun packages/engine/bench/users.bench.ts 200 3000 --world --waves=4`, resident memory (RSS) a user:

| | Users frozen at the reading | heapUsed a user | RSS a user | Users on 4 cores, 16 GB |
| --- | --- | --- | --- | --- |
| Before the fix (what A24 and C3 report) | 100 of 200 | 2.71 MB | 5.00 MB | ~2,350 |
| After | 150 of 200 | 1.67 MB | 3.39 MB | ~3,460 |

Users on a box, as A14 and A24 compute it: (0.75 x 16,384 MB - 4 x 70 MB) / 1.024 / RSS a user.

By share active (after the fix, 3,000 items a user, sim world text):

| Run | Active | RSS a user | Users on 4 cores, 16 GB |
| --- | --- | --- | --- |
| `200 3000 --world --waves=4` | 1/4 | 3.39 MB | ~3,460 |
| `200 3000 --world --waves=8` | 1/8 | 2.36 MB | ~4,970 |
| `400 3000 --world --waves=20` | 1/20 | 1.46 MB | ~8,030 |

The pieces, each measured on its own:

- a live user right after its backfill: 5.3 MB heap, 7.8-7.9 MB RSS (one wave, 60 and 100 users);
- a live user after a thaw: 4.5 MB heap, 6.33 MB RSS (60 users);
- a frozen user, by the slope between two runs with 25 live users each and everyone then frozen (100 users in 4
  waves against 200 in 8): 0.39 MB heap, 0.62 MB RSS.

The mixed readings are higher than those pieces add up to (1/4 active: 0.25 x 7.9 + 0.75 x 0.62 = 2.4 MB against
3.39 measured): each wave's ingest leaves resident pages behind that later waves do not fully reuse. A server whose
live users mostly arrive by thawing sits between the two; the table above is the conservative reading.

## 2. Frozen users on disk only (D652, a trial)

With D425 on, every freeze writes the user's blob to disk, encrypted, and keeps it in memory too. The trial
(`ItemCache.persist(disk, { diskOnly: true })`, `EDEN_PERSIST_DISK_ONLY=1` on the servers) lets go of the memory's
copy once the write succeeded. Everything else about a frozen user stays in memory as before: its counts, probes,
expiry times and the sync's state, so reads that do not thaw (`revision`, `syncedCount`, the usage report) are
unchanged and the sync is as warm as it was.

- **Thaw.** The blob is read back from the file (`FrozenDisk.read`: the same authenticated decrypt a restart uses)
  and thawed as a memory blob is: the same items, order, read marks and revision. It is the same process, so marks
  are kept (a restart's restore zeroes them).
- **A write that fails** (the directory's cap, an I/O error) keeps the memory's copy: the user is frozen as without
  the trial.
- **A file that does not open** (deleted, damaged, expired, copied from another user): the user thaws empty, what
  was derived from their items is dropped (`onDropped(scope, null)`: cards), and the partner forgets the user's sync
  state, so the next event syncs them from the start, as a restart without the file does. Counted in
  `freezes.lost`; the disk reports the reason, never content.
- **Isolation.** The file is bound to tenant and user (D425's additional data): another user's file under this
  user's name does not open (tested).
- **Privacy.** Nothing new is written: the file is D425's. With the trial the file is the only copy of an idle
  user's items, which is the point.

Tests (`packages/engine/src/persist-disk-only.test.ts`, 7): off unless asked; the same answers, text and order
after a thaw from the file; a failed write; a lost or tampered file (the user empty, the owner told once, puts work
again); isolation across tenants; the partner serving a returning user with the sync still warm; a lost file
followed by a full re-sync and the fact delivered again. Two mutations each fail tests (the release switched off: 5
of 7; the partner's `lost` hook removed: 1).

Measured, `users.bench.ts ... --world`, base against `--disk-only` (`--persist`, D425 alone, reads as base: 2.42 MB at
1/8 active):

| Run | | heapUsed a user | RSS a user | Everyone frozen: heap, RSS a user | Thaw p50 |
| --- | --- | --- | --- | --- | --- |
| `100 3000 --waves=4` (1/4 active) | base | 1.69 MB | 3.74 MB | 0.43, 1.04 MB | 147.2 ms |
| | disk only | 1.47 MB | 3.57 MB | 0.14, 0.75 MB | 153.1 ms |
| `200 3000 --waves=8` (1/8) | base | 1.04 MB | 2.36 MB | 0.41, 0.83 MB | 143.4 ms |
| | disk only | 0.79 MB | 2.23 MB | 0.13, 0.54 MB | 150.2 ms |
| `400 3000 --waves=20` (1/20) | base | 0.66 MB | 1.46 MB | 0.41, 0.71 MB | 145.0 ms |
| | disk only | 0.38 MB | 1.22 MB | 0.12, 0.41 MB | 153.5 ms |

A frozen user's own cost, by the slope between the 100- and 200-user runs once everyone is frozen: 0.62 MB RSS a
user before, 0.33-0.38 MB with the trial. What is left is not the blob: `/proc/self/smaps` and `bun:jsc`'s
`heapStats` at that point show the JS heap's capacity growing 0.28 MB a frozen user for 0.09 MB of live heap and
about 110 live objects. The few long-lived objects a frozen user keeps (the sync's state, its id sets) pin the heap
blocks they were allocated in while the user was live.

Backfill CPU with the trial read 274-286 µs an item against 262-270 without (the writes are at freezes, not in the
backfill; the benches ran at different times and the difference is within what two runs of one tree show).

## 3. Verdict

- D651: adopted (a bench fix and a corrected figure; the product is unchanged).
- D652: a trial, off. It is cheap and exact, but its gain is 1.06-1.2x on a fleet, not a factor of several. It is
  worth promoting into D425's behaviour only if a real fleet turns out to be mostly idle (a few percent active),
  where frozen users are most of the memory.

## 4. Not done

- **Why a live user is 6.3-7.9 MB resident for 4.5-5.3 MB of heap**, and why a mixed fleet reads higher still. The
  thaw builds one 3 MB JSON string and every item's object and text before packing them again; a thaw that kept
  each item's packed text as bytes would allocate far less.
- **Freezing sooner than 20-30 minutes.** It cuts the active share directly. It needs the thaw's cost (145-150 ms
  of CPU at the cap, sliced) weighed against it, and a figure for how users really pace their sessions.
- **The sync's state on disk too.** It is the ~0.12 MB a disk-only frozen user still holds, and it pins heap blocks.
  The file already carries a copy for restarts (D426), but a restore in the same process must be exact where a
  restart's is conservative.
