# O3: the push check behind the packet ("K behind")

Status: 2026-11-10, branch `claude/o3-k-behind` (from `claude/lucid-hypatia-v9wqk5` at 146aa636), session O3, measured.
Decisions D700, D701, D704. **Result: killed (§4).** Train suites only (train1–6); heldout18 is not dumped, labelled or run. Every paid call goes to
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

## 4. Result (stage 1; Pi, local, commit c194a536; Sonnet-graded)

`.local/o3/stage.sh s1 41 42 43 44`: 2,304 task runs an arm, 0 errors in `eden` and `eden~B`, 1 in `eden~B+amend`;
3,772 check calls ($0.00027 a call, 0.80 a task on the mix). Sonnet regraded 2,322 answers (0 failed).
`bench_report.py --sonnet` (template-clustered) and `n5/mix.py` (1:1:8):

| Against `eden` (62.1% of 768 hidden raised)       | `eden~B` (follow-up at the next model request) | `eden~B+amend` (and one more turn after the answer) |
| ------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------- |
| Hidden raised                                     | **+0.0 points (−2.5..+2.6)**, 62.1%            | **+3.9 points (+1.4..+6.5)**, 66.0%                 |
| Sonnet-confirmed concerns, control and neutral    | 0 against 0 of 1,536                           | **3 against 0** of 1,535                            |
| Total $ per 1,000 tasks, 1:1:8 mix                | +0.203 (+0.187..+0.218)                        | +0.203 (+0.187..+0.220)                             |
| Wall a task, 1:1:8 mix                            | +0.01 s (−0.26..+0.28)                         | +0.11 s (−0.12..+0.34)                              |
| Agent turns a task, mix                           | −0.013                                         | +0.058                                              |
| Follow-up taken: hidden / control / neutral tasks | 36 / 42 / 51 of 768 each                       | 190 / 121 / 99                                      |
| of them holding the planted item (the decoy)      | 10 (10)                                        | 43 (27)                                             |

- **A check that runs behind the packet keeps nothing of K's +7.9 points.** Its follow-up reached the agent in 36
  of 768 hidden tasks and held the fact in 10: the agent makes a second model request in under a third of tasks, and
  where it does the ask usually finds the fact anyway. K's gain needs the check's answer before the agent's first
  model request (the fact in the first packet, the look-alikes out of it, and the silence that makes the agent ask).
- **Handing the follow-up over after the answer is worth +3.9 points and fails three clauses.** Confirmed concerns
  rise 0 → 3 (the follow-up is one fact in four or five items, and the extra turn invites the agent to use it); cost
  is +$0.203 (bound $0.20) and wall +0.11 s (bound 0.1 s; a local box, so the interval is wide).
- **Against §3's rule both arms fail** (B: hidden; B+amend: concerns, cost and wall at their point estimates).
  **Departure:** `eden~B+amend` met stage 2's entry (+3.0 points) and stage 2 was not run: no result on four more
  seeds takes back three confirmed concerns against none, and the $2.5 is better spent elsewhere. `pushCheckBehind`,
  `pushCheckAskWaitMs` and `+amend` are deleted with their code and tests (D704; the code is in commit c194a536).
- **§0's table on four seeds** (the `eden` arm, 768 hidden tasks, Sonnet): the planted item was in a push packet in
  535 tasks (431 raised), only in an ask's answer in 61 (46), never handed in 172 (the agent asked in 45 of those
  and not in 127). So of 291 misses, 119 had the fact in hand and 172 never got it; the agent asked in 212 of 768
  tasks. That is what [o3-push-open.md](o3-push-open.md) works on.

**Spend (this note):** Anthropic $4.79 booked on `.local/o3/ledger.jsonl` (diagnostic and its regrade $0.17, funnel
pilots $0.24, smoke $0.07, stage 1 $3.01, its regrade $1.31). Modal $0.

## Reproduce

```bash
# .local/o3/pi.sh LABEL SEED CONDITIONS [flags]: pi-ab on the bench recipe (LAB.md 7b's RECIPE), cards concatenated
bun run funnel --suite train --seeds 41,42,43,44 --jobs 4 --json .local/o3/base.json -- --neutral          # $0
V='{"B":{"pushCheck":true,"pushCheckForm":2,"pushCheckBehind":true,"pushCheckAskWaitMs":400,"pushWiden":true,
  "pushWidenEmbed":0,"pushWidenIntent":5}}'                                    # at c194a536, one seed a process
bun packages/sim/src/lab/pi-ab.ts --suite train --seeds 41 --conditions 'eden,eden~B,eden~B+amend' \
  --variant-config "$V" --variants hidden,control,neutral --config default --tenant-prompt --push payload …
bun packages/sim/src/lab/i3-regrade.ts --results .local/o3/s1/s41/out.json,… --spend-ledger … --spend-cap 25
python3 -I packages/sim/modal/bench_report.py --pair 'eden~B:eden' --pair 'eden~B+amend:eden' \
  --group s1=.local/o3/s1 --sonnet
python3 -I packages/sim/lab/n5/mix.py --base eden --arms 'eden~B,eden~B+amend' .local/o3/s1/s4*/out.json
```
