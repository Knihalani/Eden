# O3: what a full intent index is worth over a user's days

Status: 2026-11-11, branch `claude/o3-k-behind`, session O3. Decision D713. Train suites only; heldout18 is not
dumped, labelled or run. Paid calls go to Anthropic directly with `HAIKU_API_KEY` through the lab (D97):
**Anthropic-direct lab figures**. Numbers marked **[EST]** are arithmetic or judgement; every other number comes from
a command in this note or the note it names.

## 0. Why

Over 32 users' days the fact a hidden request needs was not in that day's transcript in 134 of 433 tasks (D712,
o3-pointer.md §3.1), and at $0 it was outside the push's pool in 16 of 23 such misses on w45–w52 (§3.2). The lab's
checked-in intent requests cover 99% of the items of the four users they were made for; the shipped pipeline writes
requests only for the items a card call reads, about 14% of a user's items (181 to 238 of about 1,490) and 63 of
113 hidden planted items on w45–w52. With `intent` off on w41–w44, 11 of 46 facts are outside the pool against 2.

## 1. Pre-registration: a measurement (committed before its first paid call)

- **Paid step:** `cards-enrich.ts --days-users 45,…,52 --intent` on Haiku 5.5: requests for every item of those
  eight users' worlds (11,781 distinct items, 1,179 calls of ten), into `.local/o3/intent45/`. Hard cap $2.0 on the
  tool, on O3's ledger (cap $33). **[EST] $1.**
- **Readout, at $0:** `days-calls.ts --seeds 45,…,52 --pool-diag` twice on the same users: with the cards and
  requests the paid days run made for them (`.local/o3/cards-45-52.jsonl`, the shipped coverage; measured already:
  113 hidden requests, 59 pushed at their own request, 31 handed earlier that day, 16 outside the pool, 5 pooled
  failing the constraint test, 2 below the cut), and with the full requests file replayed beside the same cards
  (`--intent`). Reported: the same six counts, the control decoy's the same way, and the size of the handed packets.
- **No rule promotes anything here.** What it decides: a paid days run of full coverage against the default is
  pre-registered next (its own section, before its first call) only if the facts pushed at their own request rise by
  **at least 10 of 113** with full coverage. Below that the bet stops and the note says so.
- If the cap stops the calls early, the readout is run on the users whose items are all covered and says how many.
