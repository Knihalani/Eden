# Connector calls by cause, and the push's wait (13 Nov)

The owner's cost and speed targets map onto two numbers: connector calls per task and the agent's wait on the push.
This note measures both at $0, names what each is made of, and says which levers clear the bars. Decisions: D1746 (the
call table and its instrument), D1747 (the floor's allowance for unused sources, promoted; branch
`claude/floor-cap`), D1748 (the push's wait). Every figure is from a command run on 2026-11-13 on main at 6e3a5e30a or
766516f6d (the engine is the same at both); model latencies are modelled from recorded timings and marked **[EST]**.

## 1. The instrument: `--call-causes` (D1746)

`packages/sim/src/lab/call-causes.ts` books every call a connector receives by what made it. It wraps the partner's
and the sync's entry points on the instances (never the prototypes) so each runs inside an `AsyncLocalStorage` frame
naming it, and each `list`, `search` and `fetch` reads its frames and books itself to the innermost cause. It also
books what each cause's listings stored new or changed (the sync's `store` count), and both by source (the 995 noise
connectors as one row). The engine is not changed; `als.run` adds no await, and the funnel's rows were identical with
and without it (768 of 768 rows, calls and listings summed the same).

```bash
bun run funnel --json F.json -- --call-causes $PWD/causes.jsonl     # one JSON line a process
bun packages/sim/src/lab/call-causes.ts causes.jsonl                 # the merged table, by cause and by source
bun packages/sim/src/lab/days-calls.ts --seeds 41-48 --days 8 --night-h 20 --ask --push none \
  --cards .local/weeks.cards.jsonl --intent .local/weeks.cards.jsonl --call-causes   # per user-day
```

Causes: backfill (and a kicked one), deepen, floor poll, catch-up poll, on-demand poll by the lookup that made it
(push, ask, the slow path's lookup), live search by the same three, probe, cut-behind search, re-read (the push's
verify, the ask's strict verify, other), revision poll, ref notice read, sweep.

## 2. The call table

**Five sources, one request a session** (`bun run funnel`, train1–6 seeds 41–42, 768 tasks, amortised: the backfill
and the sync's ticks between tasks included):

| Cause                 | Calls a task | Share |
| --------------------- | -----------: | ----: |
| on-demand poll (push) |        3.143 |   70% |
| backfill (once)       |        0.563 |   13% |
| sweep                 |        0.561 |   13% |
| floor poll            |        0.125 |    3% |
| on-demand poll (ask)  |        0.063 |    1% |
| on-demand poll (slow) |        0.021 |  0.5% |
| total                 |        4.475 |       |

No live search, probe or re-read: every copy is whole and current or polled, and the funnel sends no notices.

**Five sources, a user's days** (`days-calls.ts`, seeds 41–48, 8 days of 24 h, one ask a request; 64 user-days, 989
requests). Calls a user-day, with what each cause's listings stored over the run:

| Cause                 | Payload notices | No notices (stored) | 5% notify | Bare signals |
| --------------------- | --------------: | ------------------: | --------: | -----------: |
| backfill (once)       |            2.25 |       2.25 (11,948) |      2.25 |         2.25 |
| on-demand poll (push) |            3.20 |         16.83 (155) |     16.55 |         2.34 |
| sweep                 |               0 |           11.61 (0) |     11.53 |            0 |
| floor poll            |               0 |            0.33 (0) |      0.33 |            0 |
| on-demand poll (ask)  |            0.08 |            0.14 (2) |      0.14 |         0.05 |
| re-read (push verify) |               0 |                   0 |         0 |        25.25 |
| re-read (ask strict)  |               0 |                   0 |         0 |         9.14 |
| re-read (other)       |               0 |                   0 |         0 |         1.75 |
| revision poll         |               0 |                   0 |         0 |         1.56 |
| total                 |            5.53 |               31.25 |     30.88 |        42.34 |

By source with no notices: the push's polls of gmail 607 (stored 119), slack 169 (29), calendar 189 (6), crm 56 (0),
drive 56 (1); the sweeps 743 calls (gmail 533) and stored nothing. Under bare signals the 2,313 re-reads found 0 changed
copies (about 97% confirmed, 3% failed); the moved items all arrived through the notices' own polls (175 stored).

**995 first-party noise connectors** (funnel train1–6 seed 41 `--limit 16 --noise-vocab 1000`, 192 tasks; and
`days-calls` seeds 41–44 `--push none`, 32 user-days):

| Cause                 | Funnel, calls a task | Days, calls a user-day (stored) |
| --------------------- | -------------------: | ------------------------------: |
| floor poll            |          214.1 (76%) |               1,003.1 (85%) (9) |
| backfill (once)       |                 62.8 |                           125.4 |
| cut-behind search     |                 0.94 |                            16.0 |
| sweep                 |                    0 |                        13.1 (1) |
| probe                 |                 1.50 |                            12.9 |
| on-demand poll (push) |                 1.96 |                       11.3 (68) |
| deepen                |                 1.13 |                             2.8 |
| on-demand poll (ask)  |                 0.05 |                            0.28 |
| total                 |                282.6 |                         1,185.6 |

## 3. Which calls are avoidable without losing facts

| Candidate (the owner's list and more)       | What was found                                                                                                                                                                                                                                                                                                     | Taken?                 |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------- |
| Floor polls at many sources                 | 85% of a 1,000-connector user's calls, about one poll per first-party source per active day, used or not, nearly all storing nothing                                                                                                                                                                               | **Yes: D1747**, see §4 |
| Re-reads whose result is already known      | None under payload or no notices. Under bare signals 85% of calls are re-reads and 0 of 2,313 found a change, but a bare signal names no item, so no re-read's answer is known in advance. Ref or payload notices remove them (D347, D210); a poll standing in for them delivered stale copies (D345)              | No                     |
| Duplicate searches across push and ask      | No live search at five sources; the ask's own polls are 1–2% of calls (the push's poll has made the copies current, or is still running and the ask waits on it, `SourceSync.busy`); at 995 the ask makes no live search                                                                                           | Nothing to cut         |
| Polls that find nothing, by source          | Sweeps: 37% of no-notice calls, nothing stored in 64 user-days, but they are the deletion check (D297: a weekly sweep let deletions through under lost notices). The push's polls of crm, drive and calendar: 301 calls, 7 stored, set by `syncMaxStaleMs` (6 h) on quiet sources, the bound D1131 found too loose | No (freshness)         |
| Probes that never contribute                | 0 at five sources (every copy whole); 1.5 a task at 995, 0.5% of calls, under the bar even if all were cut                                                                                                                                                                                                         | No                     |
| Floor polls on sources a lookup just polled | 1% of calls at five sources. The floor's batching (sources past half their interval join a due one) cost 12% of floor polls at 995 (41,102 → 36,091 with the share at 1, rows unchanged); subsumed by D1747                                                                                                        | No (subsumed)          |
| A deeper floor backoff (2 h to 32 h)        | No change on the funnel's 16-hour horizon (36,125 floor polls); no lab screen sees what it costs (a quiet source's silent edit found later)                                                                                                                                                                        | No                     |

## 4. Shipped: the floor's allowance for unused sources (D1747, branch `claude/floor-cap`)

The freshness floor (D1131, D1132) polls every warm, non-notifying, first-party source of an active user every 2–8 h.
D1132 priced it for 20 connectors. At a thousand it is the timer-for-every-source that D477 declined to build: about
1,000 calls an active user-day. `syncActivePollCap` 40: used sources (`engage`) keep the floor exactly as before; the
others share 40 floor polls a floor interval, refilled continuously per user. When more are due, an overdue one (no
complete poll for 12 floors, 24 h) goes first, then the likeliest to have changed by its learned rate; an unused source
opens the floor's block (and its thaw, D325) only once half the allowance has refilled. A user with up to 40 unused due
sources never reaches it.

**The staleness bound it trades.** Without the allowance an unused first-party source's floor poll is at most 8 h
apart. With it, about 24 h while overdue sources fit the allowance (about 20 polls an active hour); past that, with
hundreds of dormant sources, the weekly sweep (D356) bounds it.

The fixed build against the same build with the cap at 0 (main's floor code), both on main at 6e3a5e30a and later:

| Screen                                                 | Cap 0            | Cap 40                |
| ------------------------------------------------------ | ---------------- | --------------------- |
| Funnel, 995 noise, calls a task                        | 282.6            | 88.9 (−69%)           |
| Funnel, 995 noise, hidden / decoys                     | 80/96, 72/96     | 80/96, 71/96          |
| Days, 995 noise, calls a user-day (seeds 41–44, 45–48) | 1,185.6, 1,253.3 | 264.3, 275.7 (−78%)   |
| Days, 995 noise, steady calls a request                | 70.7, 70.9       | 9.3, 9.4              |
| Days, 995 noise, hidden / decoys surfaced              | 68/101, 75/101   | 67/101, 75/101        |
| Days, 995 noise, stale copies held at a request        | 132              | 133                   |
| Days, 995 noise, moved items updated at the recap      | 49               | 50                    |
| Five sources: funnel (323/384, 294/384), eval          | as on main       | identical row for row |

The reviewer's probes (`syncActivePollMs` 2 h, the sweep held off): 300 quiet unused sources over 6 h, thaws 2 (cap 0),
81 (the first build), 4 (fixed); 60 busy and one dormant source over 72 h, thaws 36, 1,401 and 70, and the dormant
source's floor polls 19, 0 and 2 (at 24 h and 48 h). The reviewer's own screen of changed planted facts behind unused
sources read hidden 30 → 34 of 92, none lost to staleness.

The one fact lost (w47, day 7) is an index effect, not a stale copy: the noise copies had passed the synced TTL (7
days), and the floor without the cap had re-listed 11,407 of them, so the index, and the planted item's rank, differed.
The allowance's other cost: an unused source is re-listed less often, so its copy lapses at the TTL until its weekly
sweep (D356), and a delivery of an unswept copy is re-read first (+29 re-reads over 64 user-days). A first form that
ordered every due source by chance, used ones included, let noise connectors take the world's crm and drive polls; it
was dropped before any number above.

## 5. The push's wait (D1748)

**What it is made of.** The F-wave final's modelled push wait (`heldout20-report.txt`, H3's fit: 596 ms + 2.93 ms an
output token) is the check alone **[EST]**: 0.786 checks a task × 713 ms (40 output tokens) = 562 ms, against before's
0.580 × 666 ms (24 tokens) = 386 ms. Of the +176 ms, about +147 is more checks a task (the gate opens on more requests;
D1402's day plans are one cause) and about +27 the longer replies (the rule sheet's `rules` list). The sheet's input (1,692 → 3,458 tokens a
call) is not in H3's fit, which reads output only: any prefill cost it adds is unmodelled. wall.py puts Eden's own
path time at 22 ms a task (mt-final).

Measured at $0 (funnel `--time 1 --jobs 1`, direct profile, train1–6 seed 41 `--limit 16`, no checker wired; the
pieces from `latency-report.ts`):

| Notices                        | The push, p50 / p90 / mean | Where it goes                                                                                |
| ------------------------------ | -------------------------- | -------------------------------------------------------------------------------------------- |
| payload (the F-wave's harness) | 12.6 / 53.6 / 25.7 ms      | CPU: ranking, grounding, probes' grace; the on-demand poll runs behind and is not waited for |
| bare signals                   | 995 / 1,513 / 995 ms       | `verify` (the re-reads of doubted copies) on 99% of pushes, 98% of the push's wall           |

So on the shipped payload path the wait is the check (about 96%) plus CPU (about 4%); under bare signals it is the
check and then one round of re-reads, in series (`checkPush`, then `verifyItems`): about 713 + 995 ms [EST].

**Levers, and why none shipped.**

| Lever                                                        | Modelled effect                                                                       | Why not shipped                                                                                                                                                                                                                                           |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Start the doubted re-reads beside the check (signals only)   | the series becomes a max: about −0.7 s on checked pushes with doubted items **[EST]** | Re-reads the gate's doubted items the check then rejects. D192 measured the reader-era form at about 2 more fetches a task, against target 1; the check-era cost needs a checker in the $0 funnel (none is recorded) or a paid run. Written up, not built |
| Cache the check's fixed prefix (D1196)                       | not in H3's fit (input)                                                               | Trial pending the owner's OpenRouter probe (on by default since D1790, unprobed)                                                                                                                                                                                                                |
| Shorter replies (a stop at the first no, a cap of 3 entries) | −34 to −100 ms a call                                                                 | Priced on F2's API replies: loses 4–12 of 614 facts (D1273, f10-rule-index.md §9)                                                                                                                                                                         |
| Fewer checks (a learned skip)                                | 10–20% of calls                                                                       | Rejected: D1272, D1274                                                                                                                                                                                                                                    |
| Speculate in the proxy                                       | −0.37 s a checked task                                                                | Already on (D1273); the Pi harness does not pass through the proxy                                                                                                                                                                                        |

No lever decidable at $0 cuts the payload path's modelled wait by 15% with outputs identical: the check is a fixed
model call and its time to first token dominates.

## Caveats

- The funnel's world does not change between tasks, so on-demand polls there store nothing; the days harness moves
  items, and is the screen for anything that trades polls for freshness.
- The noise connectors are static: the floor's polls of them can only find nothing. What the allowance costs a real
  user is a later find of a silent edit at an unused first-party source, bounded by its weekly sweep.
- Every model latency here is H3's fit over recorded sizes **[EST]**; none was re-timed.
