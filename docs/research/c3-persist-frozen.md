# C3: frozen users on disk, encrypted (opt-in)

Status: built and measured 2026-11-10 on branch `claude/c3-persist-frozen` (from `main` at 314e2445). Decisions
D425–D427. Paid spend: $0 (every figure is a no-model run). Machine: 4 vCPU, Bun 1.4.4, `BUN_OPTIONS` and
`OPENROUTER_API_KEY` unset for every bench figure, benches run one at a time.

## In plain words

- **What it is.** Eden keeps what it reads from a user's mail, calendar and documents in memory only (D8), so a
  restart forgets it and every user's sources are read again from the start. A14 measured what that costs a full 4-core
  box: about 3.6 minutes of every core, and every connector listed again. When a user has been idle for 20-30 minutes
  Eden already packs their items into one compressed blob in memory (D325). With this change an operator can choose to
  also write that blob to disk, encrypted, so that after a restart each user is read back from disk the first time
  they are used, and their sources are only checked for what is new.
- **It is off unless the operator turns it on**, by setting both `EDEN_PERSIST_FROZEN_DIR` and `EDEN_PERSIST_KEY`.
  Off, nothing changes: no item content reaches the disk, as D8 says. On, it departs from D8 in one bounded way (D425):
  redacted item content of idle users is on disk, encrypted, until the user is used again, forgotten, or 7 days old.
- **What a restart gains (200 users, measured).** At 1,000 items a user, every user was synced again in **14.1-14.2 s
  instead of 42.9-44.0 s**, with **600 listing calls instead of 2,400** and **3,000 items listed instead of 200,000**
  (two runs). At the 3,000-item cap with instant connectors: **32.4 s instead of 121.8 s**, **600 calls instead of
  6,000**, **3,000 items listed instead of 600,000**. What is left is mostly the thaw itself (67 ms a user at 1,000
  items, 152 ms at 3,000), which Eden already pays for any user returning after 30 minutes idle.
- **Safety.** Each file is encrypted with AES-256-GCM under the operator's key with a fresh random nonce; the file is
  bound to its tenant and user, so a file copied under another user's name does not open; file names are a keyed hash,
  so the directory does not say whose files are there. A file is deleted as soon as its user is used again, forgotten
  (`/v1/forget`, of the user or of one source), a source removes their items, the user is evicted or expires. A wrong
  key, a file from another version of Eden, an expired or a damaged file is deleted and logged as a count by reason,
  and that user simply re-syncs. The directory has a size cap.
- **What it does not do.** The key sits in the server's environment beside the files, so someone who can read both
  can read the users. Deleting a file does not scrub the disk blocks (use an encrypted volume too). Implication cards
  are not persisted: with a model key, restored items are carded again as a re-sync would card them, so card spend is
  unchanged. Memory is unchanged when it is off (section 4).

## 1. Design (D425)

### What is written, when

A user frozen while idle (D325) is one zstd JSON blob of their cache entries in memory. With
`ItemCache.persist(disk)`, every freeze (`install`) also writes that blob to disk, together with:

- the frozen user's own fields that outlive a process (item counts, the probes' queries and ids, the oldest and newest
  fetch times per class, the largest insertion sequence);
- the sync's state for the user (`SyncManager.snapshot`, D426): per source its synced ids, phase, cursor, cut,
  frontier, last poll and sweep times, missed ids, change-rate posterior, used flag and vocabulary sketch; the names
  the user's requests named and the sources they used.

A thaw deletes the file: what is on disk is only ever the state of a user who is frozen now. A live user changes; when
they freeze again they are written again. At SIGTERM the server also writes every live user (within 1.5 s, the router
kills a child 2 s after its SIGTERM); a crash loses the live users' state, and they re-sync.

### Reading it back

On start the store reads every file's 36-byte header once: temporary files, other format versions, other keys and
files older than 7 days are deleted (reported by reason). Nothing else is read until a user is used: `peek`, `touch`
and `ready` look for the user's file (a keyed-hash name in an in-memory set, no I/O when absent), read and decrypt it
(1.0-1.2 ms at 1,000 items, 2.8 ms at 3,000), install it as a frozen user, and thaw it in slices as any frozen user
is. A user read back gets a new revision (no revision of another process means anything here), read marks of 0, and
the cache's sequence counter moves past its entries'.

### The sync's state (D426)

Without the sync's state a restored user would be backfilled again: every listing re-read, though nothing would be
redacted or indexed twice (the fan-out's `reuse` and the cache's unchanged-copy check skip those). With it, the user's
sources come back warm and the next lookup polls each one newest first until it reaches an item already synced, as a
running process does. Two things cannot be known across a restart, and are handled conservatively:

- a notifying source (`syncPush`) may have sent notices while no process ran: it is behind until polled (its notice
  count is ahead of what was last polled);
- signals: every restored copy has read mark 0 and a notifying source's latest signal is a new mark, so each such copy
  is in doubt as after a signal and is re-read before delivery (D126), until a poll reads it again.

A non-notifying source's copy is current or stale by its learned change rate, the downtime counting as elapsed time.

The review of this branch found two gaps, fixed with a test each that fails without the fix:

- a restored source was not marked notifying until its first poll (`notes` sets it), so on the first event after a
  restart its read-mark-0 copies were not in doubt: `notifies` and `fetches` are now saved and restored;
- a source removed while the user was on disk (no tick sees a user who is not in memory) came back with them, and its
  items could be served on the first event: `SyncManager.reconcile` drops sources the resolver no longer lists, with
  their synced items, before `ready` resolves (bounded by `sourceTimeoutMs`; a failing or late resolver changes
  nothing, and the next tick does it).

A connector's page token can carry query text or an account id, so it is saved only if `sanitizeForStore` leaves it
unchanged; otherwise that source's next page is read from the head.

### The file

```
header (36 bytes, in the clear, authenticated): "EDNF" | format (u16) | 0 (u16) | key id (8) | written at (f64 ms) | nonce (12)
body: AES-256-GCM( meta length (u32) | meta JSON | zstd blob ) | tag (16)
additional data: header | tenant id | NUL | user id
name: hex(HMAC-SHA256(name key, tenant NUL user))[0..40] + ".blob"
keys: HKDF-SHA256(operator key, salt "eden-persist-frozen", info "enc" / "name" / "key-id")
```

Ids cannot hold a NUL (`isId`), so tenant NUL user is unambiguous. The key id in the header lets a store tell a file
written under another key at open, without trying to decrypt it. Writes go to a temporary file renamed into place, so
a file is whole or absent; files are 0600 in 0700 directories.

### Processes

Each server process writes its own directory, `<i>-of-<N>` under `EDEN_PERSIST_FROZEN_DIR` (a single process is
`0-of-1`), as each keeps its own source-map file (D163). Users are pinned to one child, so a child reads only what it
wrote. When N changes, the router (or a single process) deletes the other N's directories before any child starts: a
file name does not say which child owns its user, so those users re-sync, as their memory state would (D163).
`EDEN_PERSIST_MAX_MB` (default 4,096) is the whole directory's cap; each child holds 1/N. A freeze that would pass it
is not written, and any older file of that user is deleted.

### Failing open

| Case | What happens | Report |
| --- | --- | --- |
| Another format version | deleted at open | `discarded (version)` |
| Another key | deleted at open (its key id differs) | `discarded (key)` |
| Older than 7 days | deleted at open, or by the expiry tick | `discarded (expired)` |
| Truncated, tampered, or copied under another user's name | deleted on read | `discarded (corrupt)` |
| Directory past its cap | not written; an older file of the user deleted | `write-failed (full)` |
| A write or read error | not written / not read | `write-failed (io)`, `read-failed (io)` |

The server logs these as one line of counts, at most once a minute: never a name, an id or the key. The user
re-syncs, as without persistence.

## 2. Requirements, and where each is tested

| Requirement | Code | Test |
| --- | --- | --- |
| Off by default: no disk write | `ItemCache.disk` null; `loadConfig` `persist` null | `persist.test.ts` "off by default"; server `persist.test.ts` "off unless both are set" |
| Content redacted before it is cached | unchanged: `sanitizeItem`/the gate before `put` (D10) | existing redaction tests; the blob is the cache's |
| AES-256-GCM, random nonce, key from env, never logged | `EncryptedFrozenDisk.write`; `PersistKey` | "written encrypted under a keyed name" (no id or word in the clear); "the key ... never echoed" |
| Tenant and user in the AAD | `aad()` | "copied under another user's name does not open" |
| Lazy load, then incremental re-sync | `ItemCache.load`; `SyncManager.restore` | "the sync's state comes back: polls, not backfills" (10 listing calls before, at most 2 after) |
| `/v1/forget` and source removal delete the blob | `dropUser`, `forget`, `thawed` | "forget deletes the user's blob, read back or not; a source's forget and a removal too"; "a source the user no longer has"; server "forget deletes them" |
| Older than the TTL or another version: discarded | `headerProblem`, `sweep` | "a wrong key, another version, a tampered byte and an expired blob each fail open" |
| Wrong key or corrupt: fail open, reported without content | `discard`, `PersistEvent` | the same test checks the events are reasons only |
| Names reveal no ids | `nameOf` (HMAC) | "written encrypted under a keyed name" |
| Bounded disk | `maxBytes`, `sweep` | "the directory is bounded"; "flush ... sweeps blobs nobody came back for" |
| Router | `childPersistDir`, `prunePersistDirs`, cap / N | server "each process has its own directory"; "a router child holds 1/N" |

## 3. Restart measurements

`bun packages/engine/bench/restart.bench.ts [users] [itemsPerUser] [--latency=0] [--downtime=M]`: the shipped wiring
(`DEFAULT_CONFIG`, no model, one source-map file kept across the restart), three in-memory connectors a user (20-80
ms a listing unless `--latency=0`). Every user is synced and frozen to disk; then two restarts from the same moment
(`--downtime` minutes later): a new cache and partner without persistence, and one reading the directory. In each,
every user returns at once (one `user_message`), and the sync runs until every user holds their items again.

| Users x items | Listing | Arm | Re-synced in | CPU | Listing calls | Items listed |
| --- | --- | --- | --- | --- | --- | --- |
| 200 x 1,000 (run 1) | 20-80 ms | without (D8) | 42.87 s | 46.78 s | 2,400 | 200,000 |
| | | with (D425) | **14.08 s** | 15.89 s | **600** | **3,000** |
| 200 x 1,000 (run 2) | 20-80 ms | without | 44.00 s | 48.04 s | 2,400 | 200,000 |
| | | with | **14.20 s** | 15.94 s | **600** | **3,000** |
| 200 x 1,000, 60 min down | 20-80 ms | without | 43.86 s | 47.50 s | 2,400 | 200,000 |
| | | with | **13.50 s** | 15.28 s | **600** | **3,000** |
| 200 x 3,000 (the cap) | instant | without | 121.75 s | 130.99 s | 6,000 | 600,000 |
| | | with | **32.44 s** | 36.64 s | **600** | **3,000** |

After the review's fixes (section 1), one more run of `200 1000`: 44.99 s without, 14.21 s with, the same 2,400 and
600 calls.

With persistence the 600 calls are one poll a source a user (each returning user's lookup polls its three sources:
nothing new, so one page each). The time left is the thaws, which are sliced (D325) so other requests do not stall
behind them: 64.7-67.8 ms a user at 1,000 items, 152 ms at 3,000; reading and decrypting a file is 1.0-1.2 ms and
2.8 ms.

What persistence costs while running (the "before" phase): the files are 256-260 B an item on disk (48.8 MB for
200 x 1,000, 148.9 MB for 200 x 3,000), and the writes (encrypt, write, rename) took 0.42-0.50 ms a user at 1,000
items and 1.71 ms at 3,000, on top of a freeze's own 17-18 ms at 1,000 items and 54 ms at 3,000 (the rest of each phase's time) (freeze + write 3.4-3.7 s for 200 users at 1,000, 11.2 s
at 3,000).

**A full box.** A14 estimated a 4-core box restarting with 1,920 users at the cap at ~3.6 minutes of all four cores.
The bench's ratio at the cap (32.44 / 121.75 s, CPU 36.64 / 130.99) puts that at about a minute, with connectors
receiving one listing call a source a user instead of the whole backfill (here 10x fewer calls, 200x fewer items).
That is an estimate from the ratio, not a run of a full box.

## 4. Memory when it is off

`bun packages/engine/bench/users.bench.ts 200 3000 --world --waves=4`, main (314e2445) against this branch with
persistence off (the bench never turns it on), two runs each, interleaved (main, branch, main, branch):

| | Steady state (1/4 active): heapUsed a user | RSS a user | Frozen: heapUsed a user | Frozen: RSS a user | Thaw p50 |
| --- | --- | --- | --- | --- | --- |
| main, run 1 | 2.73 MB | 5.08 MB | 0.41 MB | 0.95 MB | 127.2 ms |
| main, run 2 | 2.71 MB | 5.05 MB | 0.41 MB | 0.93 MB | 124.6 ms |
| branch, run 1 | 2.71 MB | 5.12 MB | 0.41 MB | 0.93 MB | 127.5 ms |
| branch, run 2 | 2.71 MB | 5.08 MB | 0.41 MB | 0.92 MB | 129.0 ms |

Unchanged within run-to-run noise (RSS moves a few percent between runs of one tree, D373). Blobs are 101 B an item in
all four.

The code adds three fields to a frozen user (its largest sequence, whether it came from disk, the sync's saved state:
undefined when off) and one null check on each freeze, thaw and miss.

## 5. Not done, with why

- **Persisting cards and intent.** Restored items are carded again with a model key (the same calls a re-sync makes).
  Persisting cards would save that spend, but cards are model output from item content and would need their own
  format and forget paths; measure the spend first.
- **Dropping the in-memory blob of a persisted user (a cold tier).** The blob stays in memory as well as on disk, so
  memory is unchanged and a returning user never waits on the disk. Letting go of it would save the blob (~296 KB of
  A24's 0.94 MB a frozen user at the cap; an estimate from A24's figures, not measured here) but makes the disk a read
  path; it would be its own decision with a latency
  measurement.
- **The stdio MCP server.** One user, a process the client starts and stops: not wired.
- **Key rotation.** A new key discards every file (users re-sync). Two keys at once (read with either, write with the
  new) would let a rotation keep the files.
- **A per-tenant share of the directory's cap.** `EDEN_PERSIST_MAX_MB` is per process across tenants: one tenant's
  users can fill it, and other tenants' freezes are then refused ("full"; they re-sync after a restart, nothing is
  evicted). A per-tenant share would follow CLAUDE.md's per-tenant caps; at 256-260 B an item the default 4 GB holds
  about 5,500 users at the 3,000-item cap (4,096 MB / (260 B x 3,000)).
- **Re-writing frozen users at shutdown.** A user frozen before the shutdown keeps the file written when they froze,
  with the sync's state of that moment; a later change to it while frozen (rare: polls and sweeps thaw the user) is
  not in the file. The restored state is then a little older, which the first poll corrects.
