# O5: fewer items held from sources a user never uses (screened at $0, not taken)

Status: measured 2026-11-11 on branch `claude/o5-items`. Decision D756 (a finding; nothing in the product changed).
Paid spend: $0. Machine: 4 vCPU, 16 GB, Bun 1.4.4. Figures: `packages/sim/lab/o5/items-screen.txt`. The trial's code
and tests are in commit adada20c and are reverted at this branch's tip.

## In plain words

- **The bet.** A user with a thousand connected sources holds 3,000 items, the newest of every source, used or
  not. Holding only a few items of each source they never use might make such a user much smaller, perhaps half.
- **It does not make them smaller.** The room goes to the sources they do use. After ten requests a 1,000-source
  user is 14.10 MB of heap today, 13.81 MB keeping two items of each unused source and 13.49 MB keeping none (2%
  and 4% smaller), and still holds 3,000 items in the first case. Only before any request is the user smaller
  (10.6 → 9.2 → 4.9 MB after the backfill).
- **It loses no hidden facts, and its effect on connector calls is mixed.** One request a session: calls a task
  down 9% on today's default and down by half on O1's promotion candidate, hidden facts 76 → 78 and 77 → 78 of 96
  (too few to call a gain). Over two users' eight days on O1's candidate: calls a request up 11% (1.88 → 2.08),
  hidden facts 14 of 23 both.
- **Verdict: not taken.** No memory gain, and no call saving that survives a user's days. The switch would be code
  with no measured benefit, so it is not merged.

## 1. What was built

`syncUnusedCap`, `syncUnusedKeep` (off; commit adada20c): for a user with more than 32 synced sources, a source no
lookup of theirs has used (`Sync.engage`, D320) keeps only its newest `syncUnusedKeep` items. The check ran at the
end of the sync's `store`, after `onStored`, so everything a source lists still fed routing (its sketch, the source
map's mentions); the rest was dropped from the cache, the copy marked cut (D264), and the backfill stopped at the
page that passed the bound. A source a lookup then used was read whole again by `syncEngagedDeep`, as any cut
copy is. Six unit tests. Off, the funnel at 1,000 sources read what it read without the code (76 and 76 of 96,
31.48 request calls a task, the same as the run before the change).

## 2. The screens

`bun run funnel --suite train1,train2,train3 --seeds 41,42 --jobs 1 -- --noise-sources 995 --limit 16`, 96 hidden
and 96 control tasks, reader stub; on O1's candidate (`claude/o1-promote` @ 14f87de3, which turns on
`sourceYieldEarn`, `sourceYieldNames` 4 and `sourceYieldEngage`) with O1's `--noise-vocab 1000 --notify-share 0.05`.

| Base | Arm | Hidden surfaced | Decoys surfaced | Request calls a task |
| --- | --- | --- | --- | --- |
| Today's default | off | 76 | 76 | 31.48 |
| | keep 2 | 78 | 79 | 28.68 |
| | keep 0 | 77 | 79 | 41.38 |
| O1's candidate | off | 77 | 76 | 4.16 |
| | keep 2 | 78 | 77 | 2.00 |
| | keep 0 | 76 | 79 | 4.49 |

A first screen with no code gave each noise connector fewer items (`--noise-items`): 20, 5, 2 items a connector
read 76, 76, 77 hidden and 31.48, 22.63, 19.26 request calls a task. That overstated the saving: there the unused
sources' copies are whole and answer from the index; under the bound they are cut and still searched live.

Over days (`days-calls.ts --seeds 41,42 --days 8 --push payload --ask --noise-sources 995 --noise-vocab 1000
--notify-share 0.05`, O1's candidate): request-time calls a request 1.879 → 2.082, by day 4.7 2.5 1.2 1.2 1.4 0.8
2.0 1.0 → 3.4 1.6 0.5 0.5 4.0 2.4 2.0 2.2; hidden facts surfaced 14 of 23 both, decoys 16 of 23 both. Fewer calls in
the first four days, more in the last four; not looked into further.

Heap (`source-heap.ts 995 3 10`, the profile of o4-per-source.md, MB a user): after the backfill 10.57 → 9.18 →
4.94; after ten requests 14.10 → 13.81 → 13.49; the item cache 5.45 → 5.25 → 4.77.

## 3. Why the memory does not move

The user's cap (`syncMaxItems` 3,000) is a budget, not a sum of per-source shares. With the unused sources bounded,
the sources the user's lookups use are read whole (up to half the cap) and on-demand polls store past the cut, so
the cache fills again. A 1,000-source user is smaller only if the cap itself is lower for them, which changes what
lookups find for the sources they do use; that is a different question from this one.

## 4. What is left

- The days result (calls up in days five to eight) was not explained. If the bound is ever revisited for calls
  alone, start there, on more than two users.
- The item cache is 5.4 of a 1,000-source user's 14 MB. O4's D750 screens (text in blocks, columns) remain the
  measured route to a smaller live user.
