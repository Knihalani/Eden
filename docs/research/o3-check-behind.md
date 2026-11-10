# O3: the push check behind the packet ("K behind")

Status: 2026-11-10, branch `claude/o3-k-behind` (from `claude/lucid-hypatia-v9wqk5` at 146aa636), session O3.
Decisions D700–D702. Train suites only (train1–6); heldout18 is not dumped, labelled or run. Every paid call goes to
Anthropic directly with `HAIKU_API_KEY` through the lab (D97): **Anthropic-direct lab figures**. Numbers marked
**[EST]** are arithmetic or judgement; every other number comes from a command in this note. Cap: Anthropic $25
(ledger `.local/o3/ledger.jsonl`); Modal is not used (the runs are local, one seed a process, two at a time).

## 0. Where the misses are (before any design; seed 41, the default on Pi, 192 hidden tasks)

`.local/o3/pi.sh diag-41 41 eden --variants hidden` (the bench recipe, local; $0.061), every answer regraded by
Sonnet 5.5 (`i3-regrade.ts`, $0.11), read with `decomp.py` against each task's timeline (`planted`, `cited`,
`askCited`):

| Where the planted item was                         | Tasks | Raised (Sonnet) | Not raised |
| -------------------------------------------------- | ----- | --------------- | ---------- |
| In a push packet                                   | 134   | 110             | 24         |
| Only in an `ask_context` answer                    | 16    | 10              | 6          |
| Never handed, the agent asked                      | 14    | 0               | 14         |
| Never handed, the agent did not ask                | 28    | 0               | 28         |
| All                                                | 192   | 120 (62.5%)     | 72         |

- **The agent asks in 59 of 192 hidden tasks (31%).** A packet queued after the first model request reaches the agent
  only in those. The second request starts 1.02 / 1.25 / 1.62 s (p10 / p50 / p90) after the first; N5's check
  answers in 0.97 / 1.4 s (p50 / p90).
- **30 of the 72 misses had the fact in hand.** Read one by one, most of those answers state the fact's core and
  leave out a specific the grader requires (the sign-off needed, the exception route, the fee), a few reason past it,
  one was cut by the excerpt. The excerpt is not the lever: D258 measured 93% of the fact's words kept at 320 bytes.
- **Of the 42 never handed** (the funnel's view of the same tasks, `base.json`): 13 had no candidates push at all (no
  constraint-like item in the pool, so no check would run either; the funnel's ask finds 8 of them), 13 had the fact
  in the pool at places 6–15, 12 had it outside the pool, 4 other.
- So 90% needs both: the fact handed in about 95% of tasks (150 of 192 today) and stated with its specifics in about
  95% of those (120 of 150 today).

## 1. What is built (D700, D701)

- **`pushCheckBehind` (D700; a trial, off; engine).** With `pushCheck`, the push does not wait for the check. The
  default's candidates go at once. Behind them: `pushWiden`'s look, then the check's one call, read to its end. The
  items it names that the session's ledger still holds fresh (not handed by the default's packet or anything else),
  at most `pushCandidates`, are re-read like any delivery and queued as one follow-up packet (`CHECK_BEHIND_LEAD`;
  reason `check-behind:`), taken at the agent's next model request in the same request and withdrawn untaken at the
  user's next request. It never silences, replaces or retracts the default's packet. `pushCheckAskWaitMs`: an
  `ask_context` call in that request waits at most that long (from the ask's start, beside its own work) for a
  check still running, so the follow-up is queued when the agent's next model request takes what is pending.
- **No retraction.** A follow-up that calls the first packet noise can only land where the agent makes a second
  model request (31% of hidden tasks), after it has read the packet; Sonnet-confirmed concerns are already 0–2 in
  3,072 (N5), so there is nothing measurable for it to remove. Not built.
- **Widening without an embedder:** `pushWiden` with `pushWidenEmbed` 0 and `pushWidenIntent` 5 (the request's raw
  intent hits, which the product has). The check and its wording are N5's (`pushCheckForm` 2, frozen).
- **`+amend` (D701; lab only, pi-ab).** A harness flag on a condition: when the agent has answered and Eden holds a
  packet queued behind the answer, the agent gets one more turn with it (`AMEND_NOTE`) and may add to its answer;
  "No change" adds nothing. Nothing is waited for. It stands in for an integration that hands a late packet to the
  agent after its reply (Pi's follow-up message); the product's client has no such hook, so this arm can be
  recommended, not promoted.

## 2. Pilot at $0.26 (funnel, seed 41, check live; the funnel takes every follow-up)

`.local/o3/funnel-b.sh` (`bun run funnel … --check live`), against `base.json`; 192 tasks a variant:

| Arm (seed 41)                          | Hidden surfaced | Follow-ups: hidden / control / neutral tasks | Follow-ups holding the planted item / the decoy | Check calls |
| -------------------------------------- | --------------- | -------------------------------------------- | ----------------------------------------------- | ----------- |
| default                                | 154             |                                              |                                                 |             |
| B0 behind, no widening                 | 163             | 51 / 33 / 34                                 | 15 / 7                                          | 473         |
| Bi behind, intent widening 5           | 167             | 59 / 35 / 34                                 | 20 / 8                                          | 473         |

- Joined with §0's live tasks, Bi's 20 planted follow-ups fall on: 6 tasks where the agent asked and never got the
  fact, 8 where it did not ask, 6 where it was handed anyway. **So the most a follow-up at the next model request
  can add on this seed is 6 tasks of 192 (+3.1 points), before uptake and timing [EST].**
- The follow-up is noisy: on hidden tasks 20 of its 96 items are the planted one; 18% of neutral tasks get one. No
  no-model feature of the item separates them (constraint-like, anchored, in the pool or widened: the planted items
  spread over the same cells as the rest).
- A smoke on Pi (`smoke-41`, 24 hidden and 24 neutral tasks an arm, $0.07): the follow-up was taken in 2 of 48 tasks
  of `eden~B` and in 12 of 48 with `+amend`.

## 3. Pre-registration (committed before the first call of the run below)

- **Arms** (pi-ab, the bench recipe: `--config default --tenant-prompt --push payload`, direct profile, Haiku 5.5 as
  agent, grader, cards and check; cards and intent replayed): `eden`; `eden~B` = `pushCheck`, `pushCheckForm` 2,
  `pushCheckBehind`, `pushCheckAskWaitMs` 400, `pushWiden`, `pushWidenEmbed` 0, `pushWidenIntent` 5;
  `eden~B+amend`.
- **Stage 1:** train seeds 41–44, hidden, control and neutral, all 192 templates, one seed a process, two processes
  at a time. Seed 41 chose the widening (§2), so it is also reported apart. **Stage 2:** seeds 45–48, only for an
  arm whose stage-1 hidden difference is at least +3.0 points; the rule is then read on all eight seeds.
- **Grades:** every hidden answer and every control or neutral concern of the three arms regraded by Sonnet 5.5
  (`i3-regrade.ts`). Intervals: template-clustered bootstrap (`bench_report.py --sonnet`); cost and wall paired by
  task on the 1:1:8 mix (`n5/mix.py`).
- **Rule (the brief's).** An arm is put to the owner as worth a blind run only if, against `eden`: hidden raised is
  at least **+4.0 points** with the clustered interval's lower bound above 0; Sonnet-confirmed concerns (control
  and neutral) are not up; wall on the 1:1:8 mix rises by at most **0.1 s**; total cost (agent + check) rises by at
  most **$0.20 per 1,000 tasks**. For `+amend` wall is read on the whole task (the extra turn included); the time to
  the first answer is reported beside it.
- **Otherwise** the arm is killed: `pushCheckBehind`, `pushCheckAskWaitMs` and `+amend` are deleted with their code
  and tests (D112), and the note says what a non-blocking check keeps.
- **Also reported, no bar:** in how many tasks the follow-up was taken, how many of those held the planted item,
  `ask_context` calls a task, and §0's table on four seeds.
- **Budget [EST]:** $5 (agent and grader $2.5, check $1.0, regrade $1.3).
