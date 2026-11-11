# O4: what a 1,000-source user's memory is made of

Status: measured 2026-11-11 on branch `claude/o4-per-source` (from `claude/o4-new-user`). Decision D752 (a finding
and one small change to `IdSet`). Paid spend: $0. Machine: 4 vCPU, 15 GB, Bun 1.4.4.

## In plain words

- A user with about 1,000 connected sources holds about 10 MB of heap, against about 2-5 MB for a five-source
  user. O4 first read that as "six times the memory for twice the items" and looked for per-source waste.
- **Most of it is items, not sources.** The 1,000-source user is at the 3,000-item cap (5.4 MB with text and
  index); the five-source user of the same world holds 1,487 items. The cap fills with the newest items of every
  source, used or not.
- **Per-source state is a third (3.3 MB).** The two largest pieces are the sync's id set for each source (1.34 MB)
  and the fan-out's guards for each (user, source) (1.0 MB). Sketches (0.31 MB) and source yield (0.02 MB) are O1's
  and were not touched.
- **One cut made:** an id set kept the room of a whole page after the page was trimmed to the cap. It now gives the
  room back: 1.34 → 0.83 MB a user. Small (5% of the user); the rest of an id set's cost is five small arrays' own
  headers, which only a different layout would remove.
- **No order of magnitude is in the per-source state.** Removing all of it would make the user 1.5 times smaller.
  The larger question is whether a user's item cap should be spent on sources they never use; that changes what
  lookups find and needs the 1,000-source funnel and a live check. Not done here.

## 1. The profile

`bun packages/sim/src/lab/source-heap.ts 995 3 10`: default config, the world's five sources and 995 noise
connectors of 20 items, three users backfilled, ten requests each (an observe and an ask), then each part cleared in
turn and the heap read after a full collection. MB of heap a user:

| Part | 1,000 sources | 5 sources |
| --- | --- | --- |
| After the backfill | 10.56 | 3.28 |
| After ten requests | 13.90 | 5.19 |
| Sync: sketches | 0.31 | 0.00 |
| Sync: id sets | 1.34 | 0.06 |
| Sync: the rest of its per-source state | 0.45 | 0.00 |
| Fan-out: guards a (user, source) | 1.00 | 0.01 |
| Planner: state a connector | 0.19 | 0.00 |
| Source yield | 0.02 | 0.00 |
| Item cache: items, text, index | 5.43 | 1.96 |
| Left (the lab's own, shared by the users, and what was not cleared) | 5.09 | 3.14 |

"Left" is mostly the process's and the lab's fixed memory: with one user it reads 13.6 MB, with six 2.9 MB a user
(17.5 MB in all). By the slope between one and six users, a 1,000-source user is about 10 MB after ten requests.

## 2. The id sets

A user's 1,000 sets held 3,000 ids (205 sets empty) in 786 KB of arrays: 786 bytes a set. Each had grown to hold
its source's page of 20 ids, the trim then deleted most of them, and a set compacts only at a later `add`. `IdSet`
now starts with shared empty arrays (the first `add` allocates), and a `delete` that leaves a quarter of the slots
live moves what is left into arrays sized for it (never while an iterator is open). `source-heap.ts`: 1.34 → 0.83
MB a user. `bench/idset.bench.ts`, before → after (one run each, ±30% on this machine): `has` hit 127 → 122 ns,
miss 115 → 113 ns, delete and add 350 → 355 ns, iterate 3,000 198 → 200 µs; 37 B an id for sets of 3,000 unchanged.

## 3. The fan-out's guards (O5, D754)

A breaker, a concurrency limiter and a latency histogram a (user, source), made at the pair's first call and kept
until the user is forgotten or 100,000 pairs exist: about 1 KB a pair, 1.00 MB for a user with 1,000 sources, almost
all for sources called once, in the backfill. A pair no call has taken for ten minutes is now parked
(`SourceFanout.park`): its guards are dropped and only the concurrency limit it had learned is kept (a number by the
pair's key), given back to the new limiter at the pair's next call. Ten minutes is the longest window the guards
hold (the breaker's and the lookup histogram's are 60 s, the planner calls' ten minutes), so a parked pair's new
guards behave as its old ones would have: an idle breaker that is closed has an empty window, and an idle histogram
is empty. A pair is kept when that is not so: a call in flight, a breaker open or half-open, a rate limit still
pushed back. The work is done as calls come (the eight least recently used pairs are looked at each call), with no
timer.

`source-heap.ts 995 3 10` (`packages/sim/lab/o5/source-heap.txt`), MB of heap a user after ten requests, before →
after: 13.61 → 12.70; the guards 1.00 → 0.00, with about 0.1 left as parked limits (in the profile's last line,
5.16 → 5.27). After the backfill alone nothing is idle yet: 10.07 both.

Meant to change no result: the funnel's clock moves an hour between requests, so every pair is parked and brought
back between any two of a user's requests there. Checked: the default funnel reads 314 and 274 with all 768 task
rows identical to the run without it (connector calls 2,064 both), and the 1,000-source funnel 192 of 192 rows
(calls 6,045 both).

## 4. Not done

- A single-array form for small id sets (the remaining 0.83 MB is mostly five arrays' headers a set).
- Fewer items of never-used sources under the cap.
