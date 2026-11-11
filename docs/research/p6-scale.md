# P6: users per box: idle compaction, a fast thaw with two frozen tiers, persistence by default, more machines

Status: built and measured 2026-11-11 on branch `claude/p6-thaw-fast` (from `claude/lucid-hypatia-v9wqk5` at
d5d504f0, weak point 9 of docs/research/weak-points-1111.md). Decisions D860-D864. Paid spend: $0 (no model in any
run; Modal unused). Machine: 4 vCPU, 15 GB, Bun 1.4.4; benches one at a time. Raw outputs are summarised in the
tables below; every figure comes from a command run in this session.

## In plain words

- **What limits users on a box is how many are live at once.** A live user (vocabulary, index, item objects) costs
  5-8 MB of heap at the 3,000-item cap; a frozen one 0.4-1.8 MB. Users stayed live for 20-30 minutes after their last
  request because waking one cost 150-300 ms of CPU.
- **Waking is now 10-20 ms.** A new "warm" frozen form keeps what a thaw used to rebuild: each item's compressed text
  bytes as they are, and the user's word list and search index as arrays. Thawing copies them back instead of
  re-reading, re-indexing and re-compressing every item.
- **So users freeze after two minutes, in two tiers.** Idle two minutes: frozen warm (fast to wake, about twice the
  bytes of the compact form on ordinary prose). Idle 30 minutes: re-frozen in the old, compact form. Both are in the
  default now (D862).
- **Result, users on a 4-core 16 GB box** (by the same arithmetic as O2): **1.25-1.6x more** at every active share
  measured, on both kinds of text, if a quarter of the users active within 30 minutes are active within the last two
  (the lab's ten-minute request rhythm); 1.14-1.3x if half are. Nobody has measured the real share (weak point SC1).
- **Idle compaction (D861, in the default).** An idle live user's index is merged and its spare room let go: 0.5-0.95
  MB a user at the cap, same answers.
- **Persistence on by default (step 4): recommended, with conditions** (§5). The restart cost falls from re-reading
  every source to reading a file; the warm form is not written to disk at each two-minute pause (that would have
  been 1-3 MB a pause), only at the 30-minute freeze and at shutdown. It is the owner's decision (D8, D425).
- **More than one machine (step 5): a design, nothing built** (§6). The cheap-looking piece (consistent hashing) is
  unsafe alone with today's persistence directories.

## 1. Idle compaction (D861)

`SparseIndex.compact()` (`@eden/primitives`) purges removed docs, finishes any merge, merges the whole delta tier into
the frozen arrays however few docs it holds, and cuts the delta's arrays to their floor. Frozen postings keep
insertion order, so results are unchanged (`sparse-index-snapshot.test.ts` runs three indexes through 3,000-6,000
random adds, removes and queries and compares every result; `cache-freeze.test.ts` compares a compacting cache with
a twin that does not). The cache runs it at the expiry tick for a live user not used through a whole tick interval
and with at least 32 delta docs or removals waiting, as a sliced background job (the reviewer's finding: inline, a
tick could merge hundreds of users in one turn of the event loop).

Measured (scratch script, 20 users of 3,000 items stored in pages of 100, heap after a full GC, before and after one
compacting tick):

| Text | Heap freed a user | Bytes an item | CPU a compaction | Answers |
| --- | --- | --- | --- | --- |
| Sim world | 0.95 MB | 317 | 2.3 ms | identical |
| Prose (docs/) | 0.50 MB | 167 | 6.3 ms | identical |

The report's estimate was 0.4-0.5 MB (130-180 B an item). A compaction after a single add costs 2.6-3.0 ms at 3,000
docs (the reviewer's probe), which is why it waits for 32 delta docs.

## 2. The warm form and its thaw (D860)

`fastFreezeSteps` writes one blob ("EDF2"): a zstd section with a JSON head (each entry's fields without its text,
the tallies, the vocabulary's terms) and the index's typed arrays (`SparseIndex.snapshot()` after `compact()`;
postings, forward arena and key offsets as zigzag varint gaps, which halves what zstd leaves of them), then the items'
deflated text bytes, copied as they are. `fastThawSteps` restores the vocabulary (`Vocab.restore`, fingerprints
hashed again: they are 12 incompressible bytes a term) and the index (`SparseIndex.restore`: the same doc numbers and
term ids, so entries keep their doc), and rebuilds each item around a copy of its bytes (`packedFrom`). Nothing is
tokenized, indexed, inflated or deflated. `thawSteps` reads either form by its first four bytes.

One user of 3,000 items, put in one call (a scratch script, 12 freeze/thaw rounds, median of the last 10; three runs
on a quiet machine, load average 0.7; the freeze column includes two ticks that do nothing):

| Text | Form | Freeze | Thaw | Longest sliced step | Blob, bytes an item |
| --- | --- | --- | --- | --- | --- |
| Sim world | compact (before) | 38.6-47.6 ms | 118.4-131.8 ms | 9.8-13.6 ms | 84 |
| | warm | 9.3-9.9 ms | 8.2-8.8 ms | 6.8-9.4 ms | 412 |
| Prose | compact | 68.7-72.4 ms | 205.5-206.5 ms | 17.4-22.7 ms | 408 |
| | warm | 18.3-21.1 ms | 15.7-16.9 ms | 9.9-14.1 ms | 890 |

So a thaw is 13-15x faster and a freeze 3.5-4.5x; the warm blob is 2.2x the compact one on prose and 4.9x on the
sim's text. (`users.bench.ts`'s blobs read 101 and 435 B an item compact: its items carry a per-user suffix.)

Where the warm prose blob's bytes go (scratch breakdown, bytes an item): item text 607 (each item's own deflate, the
live form since D188), postings 87 and forward arena 107 after varint and zstd, terms 30, the rest about 80. The
compact form keeps all text in one zstd stream, which shares words across items: 4.7x smaller than per-item deflate on
the sim's templated text and about 1.3x on prose (O4's screen 3). That gap is why a warm user is re-frozen compact
after 30 minutes rather than held warm.

Rejected on the way: keeping each item's bytes as a view of one shared copy of the text section (1-2 ms faster) would
keep a thawed user's whole section alive under churn until its next freeze.

## 3. Two tiers, freezing at two minutes (D862)

`CacheLimits.warmIdleMs` (2 minutes) and an expiry tick of a minute (`expireEveryMs`, ten before): a user idle two
ticks is frozen warm; a warm user still idle at `freezeIdleMs` (30 minutes, so 30 ticks) is thawed and frozen compact
in the timer's sliced jobs (`coldDue`, `laterJob`; a user a request started waiting on meanwhile is left live). No
warm freeze without `releaseTerms` (a warm blob carries the vocabulary, which then still holds the words of items gone)
or when users never freeze compact.

**Users per box.** `users.bench.ts` at the cap (3,000 items a user), O2's arithmetic: (0.75 x 16,384 MB - 4 x 70 MB) /
1.024 / RSS a user. "Active" is A14's share: users used within the 30-minute bound. Today all of them are live. With
D862 only those used within about two minutes are; the rest of them are warm. That split is not measured anywhere: the
lab's day harness sends a request every ten minutes (`days-calls.ts --gap-min 10`), which makes a user live about two
or three minutes in ten, so the table gives a quarter (`--waves=4K --warm-waves=3`) and, as a pessimistic case, a half
(`--waves=2K --warm-waves=1`).

Before: `200 3000 --world --waves=4`, `200 3000 --world --waves=8`, `400 3000 --world --waves=20` on the base tree
(the sim rows reproduce O2's 3.39 / 2.36 / 1.46 MB); prose rows the same with `--prose` and the trial off. After: the
same users and shares with `--warm-waves`.

| Text | Active | Before: RSS a user, users | After, a quarter live | After, half live |
| --- | --- | --- | --- | --- |
| Sim world | 1/4 | 3.30 MB, 3,548 | 2.06 MB, 5,692 (1.60x) | 2.54 MB, 4,616 (1.30x) |
| | 1/8 | 2.39 MB, 4,898 | 1.59 MB, 7,395 (1.51x) | 1.93 MB, 6,084 (1.24x) |
| | 1/20 | 1.49 MB, 7,858 | 1.03 MB, 11,346 (1.44x) | 1.25 MB, 9,411 (1.20x) |
| Prose | 1/4 | 4.36 MB, 2,687 | 3.00 MB, 3,906 (1.45x) | 3.51 MB, 3,342 (1.24x) |
| | 1/8 | 3.35 MB, 3,496 | 2.57 MB, 4,557 (1.30x) | 2.95 MB, 3,979 (1.14x) |
| | 1/20 | 2.51 MB, 4,670 | 2.01 MB, 5,838 (1.25x) | 2.17 MB, 5,404 (1.16x) |

One run a cell. Prose users are heavier (more distinct words: 19,128 terms at 3,000 items against 8,163), and their
warm blobs are 2.1x the compact ones, so the gain is smaller there. The prose corpus is this repository's docs (one
author), not mail; it is the honest side of the sim's templated text, not a stand-in for users.

**CPU.** A pause longer than two minutes now costs a warm freeze and a warm thaw, about 36 ms of CPU on prose (18 on
the sim's text); a pause past 30 minutes adds a warm thaw (16 ms) before the compact freeze it always had. At the lab's
rhythm (a pause after each request, six an hour) that is about 0.22 s an hour per active user; for the prose 1/4 box
above (3,906 users, 977 active) about 0.06 of a core, 1.5% of four (arithmetic on the measured pieces). In return, a
user back within 30 minutes wakes in 8-17 ms of CPU instead of 120-210, and the timer's tick walks the users every
minute instead of every ten (a few comparisons a user). The sliced scheduler gives the loop back between steps; a warm
thaw's longest step (the head's decompress and parse) is 7-14 ms, shorter than a compact thaw's (10-23 ms).

## 4. Persistence: the restart, the disk, the posture

**What changed in D425 with D862.** A warm freeze writes nothing: an active user pauses every few minutes, and each
pause would have written (and its thaw deleted) a file of 1-3 MB, on the order of 10 MB/s on a full box. Files are
written at the compact freeze (30 minutes idle) and at shutdown (`flush`: live and warm users, the warm ones in the
warm form, so a restart wakes them fast). A crash loses the users used within the last 30 minutes (they re-sync), as
before. Format 4 is written; format 3 (compact) files are still read.

**The restart** (`restart.bench.ts 200 3000` and `--warm`: 200 users at the cap, three connectors answering in 20-80 ms,
the bench workload's text, every user returning at once 5 minutes after the shutdown):

| | Every user synced again | CPU | Listing calls | Items listed | Read and thaw a user |
| --- | --- | --- | --- | --- | --- |
| No persistence (today's default) | 121.4-123.2 s | 128.9-131.6 s | 6,000 | 600,000 | – |
| Persisted, compact files | 33.6 s | 37.7 s | 600 | 3,000 | 2.6 ms + 158.6 ms |
| Persisted, warm files (shutdown) | 6.0 s | 7.6 s | 600 | 3,000 | 4.2 ms + 25.8 ms |

Without persistence a restart costs every returning user a full backfill (on per-call connector plans, 30 listings a
user here and about 1,000 at 1,000 sources, o1-sweep) and their first minutes of answers; with it, a poll of what is
new.

**The disk.** Files at the cap: 262 B an item compact and 602 B warm on the workload's text (0.79 and 1.8 MB a user);
408 and 890 B on prose (1.2 and 2.7 MB). A prose box of 3,906 users with a file each is about 4.7 GB compact, past
today's default directory cap of 4,096 MB (`EDEN_PERSIST_MAX_MB`: a freeze past it is not written, so those users would
re-sync after a restart). Writes: about 1.2-2.3 ms a user (encrypt, write, rename). The shutdown's 1.5 s covers few
users: a live user's warm freeze is about 20 ms on prose (72 ms compact before D862), so about 70 live users, plus
already-warm ones at 2.3 ms a write; the rest re-sync, as a crash's would.

**The posture (THREAT-MODEL T12).** With persistence on by default, most users' redacted items would be on disk most of
the time (any user idle more than 30 minutes), encrypted under a key that sits in the environment beside the files: a
host compromise reads both. Deleting a file does not scrub its blocks (an encrypted volume is needed under it); there
is no key rotation (a new key discards every file); file sizes and times show how much a user holds and when they were
last active. What is on disk is what memory already holds (redacted, D10), bounded by item expiry and 7 days (D428).

**Frozen-user memory.** D425 alone keeps each frozen user's blob in memory as well, so persistence changes nothing
there. D652 (disk only, a trial) is what turns it into memory: O2 measured a compact frozen user 0.62 → 0.35 MB RSS,
1.2x more users at a twentieth active and 1.06x at an eighth. With D862 most frozen users are compact, so the gain
should be of that size; not re-measured here.

## 5. Recommendation on persistence by default

Recommended, as the documented production default, with three conditions; it is the owner's decision (D8, D425).

1. **Not silently on.** It needs a key the operator provides; an auto-generated key stored beside the files would add
   nothing. So "on by default" should mean: the production docs and the deploy template set
   `EDEN_PERSIST_FROZEN_DIR`/`EDEN_PERSIST_KEY`, and a server started without them logs once that a restart will
   re-read every user's sources.
2. **Size the directory.** Raise the default cap from 4 GB to what a box's users need at the cap (about 5 GB of
   compact files for a prose box of 3,900 users; more with 1,000-source users), or derive it from users per box.
3. **With it, D652 (disk only).** Once the files are on, the memory's copy of a compact frozen user is a duplicate;
   promoting D652 with persistence is about 1.1-1.2x more users at low active shares for a thaw 6-9 ms slower (O2).

Against: content at rest on every server by default, which D8 has kept off since the start; what it buys is restarts
(6-34 s instead of about 2 minutes for 200 users, a tenth of the connector calls), which matter most for operators on
per-call connector plans and for deploys.

## 6. More than one machine (design, nothing built here; built by D992, docs/research/d1-scale-out.md §3)

What one machine does today (D113, D163, D425): a router hashes each tenant/user to one of N child processes
(`childFor`: FNV-1a mixed, mod N); every piece of per-user state lives in that child; each child has its own
source-map file and its own persistence directory (`<i>-of-<N>`). What a second machine needs, in order:

1. **Sticky routing by user, across machines.** The same rule as `childFor`, one level up: a front tier (the
   existing router, or the load balancer with a hash on a header the client sets) sends each tenant/user to one
   machine, then that machine's router to one child. Plain `mod N` is wrong at this level: adding a machine to
   four moves four fifths of users, and a moved user starts over (a re-sync of every source: about 45 s and
   about 1,000 listing calls for a 1,000-source user, o4-new-user). Jump consistent hashing (Lamping and Veach) or
   rendezvous hashing moves 1/(N+1) of users when one machine is added, and only the dead machine's users when one
   is lost. The membership list can start as static configuration (machines named in an env var), as N is today.
2. **The hand-off is the persisted blob.** A frozen user's file already holds everything a new owner needs to serve
   them warm: items, the sync's positions and ids (`SyncManager.snapshot`), probes; it is authenticated to its
   tenant and user (D425's additional data), so it can move between machines without trust in the path. What is
   missing is a place both owners can reach: today the store is a local directory with synchronous I/O
   (`FrozenDisk`). An object store (or a shared volume) behind the same interface, with the reads made async, is
   the hand-off: the old owner writes at freeze and at drain (SIGTERM already writes live users within 1.5 s), the
   new owner loads on first use (`ItemCache.load`). With the warm form (D862) the load is a 10-20 ms thaw plus the
   fetch. This needs D425 on, which is why it follows step 4's decision.
3. **What is lost on a move and must be decided:** per-user learning in the source map (`mention`, `utility`,
   planner arms) stays in the old process's SQLite file (rows that `/v1/forget` must still reach: forget already
   goes to every child, and would go to every machine); sessions, the not-twice ledger and explain traces (memory
   only, S3 in the weak-point report); `SourceYield` and the cards (memory only). Either carry the small per-user
   rows in the blob or accept a cold start of learning for moved users.
4. **Per-tenant caps.** Rate, burst and model spend are divided by N children today (each holds 1/N). Across
   machines the divisor is machines × children, or a ledger in a store every machine reaches. D327's spend leases
   (a ledger inside the router, over child IPC) are not needed for this and are being deleted by P1; their commit
   in history is the shape to copy if a shared ledger is ever built.
5. **Failover.** A dead machine's users go to the next owner on the ring and resume from their last persisted
   freeze; what changed since (a live user's last minutes) is re-read from the sources. With warm freezing after
   two minutes that window is short; without persistence every such user re-syncs.

**The smallest piece, and why it is not built here.** Making `childFor` consistent (jump hash) is ten lines, but on
its own it does not keep a moved-back user correct: a child's persistence directory would hold blobs of users it
no longer owns, which it cannot name (file names are a keyed hash and the owner is not in the clear), so a user
that returns to an earlier child after two changes of N would load a stale blob; and `rehomeSourceMaps` moves rows
only out of files no child opens, not out of a file whose child keeps some of its users. The working piece is
therefore three changes together: (a) a bucket (for example 16 bits of an unkeyed hash of tenant/user) in the clear
in each file name, which is what routing hashes, so a child can move or delete files by owner without decrypting
them (it reveals 1/65,536 of a partition, no identity); (b) owner = jump(bucket, N), for the router and for
`rehomeSourceMaps`/`prunePersistDirs`, which then move rows and files by bucket instead of deleting other N's
directories; (c) the router tests for N 2 → 3 → 2 rewritten to check that 2/3 of users keep their state. About a
day with its review; it changes the persistence format again and every user's child once, so it belongs with the
decision on step 4, not ahead of it.

## 7. Primitives' benchmarks

`SparseIndex` and `Vocab` gained methods (`compact`, `snapshot`, `restore`, `compactWork`); no hot path changed.
`sparse-index.bench.ts` and `vocab.bench.ts`, base tree against this branch, two runs each alternating: search and
churn means moved within the run-to-run noise in both directions (dense search 85.9 / 54.5 µs base, 53.5 / 91.2 µs
branch; Vocab heap 42.1 B a term in all four).

## Review

The `reviewer` subagent read the code (REQUEST_CHANGES). Fixed: idle compaction ran inline in the timer's tick (now a
sliced job, past a floor of 32 delta docs, for users idle through a whole interval: the first guard, one tick, was met
by any user used before the tick); `SparseIndex.restore` did not grow the shared scratch, so a fresh process could
report a freed term twice; a warm blob without `releaseTerms` would have written dead items' words at shutdown (no warm
freeze then); `warmIdleMs` with users that never freeze froze them warm forever (now off); format 4 discarded every
format-3 file at upgrade (3 is still read); a warm-to-compact thaw counted as a user's thaw (now `freezes.recompacted`);
tests added for read marks after a load, probes, the rebuild baseline, Uint32 postings and the idle guard, each checked
by breaking the line it covers.
