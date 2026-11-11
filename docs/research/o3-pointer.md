# O3: naming what was handed earlier (`pushPointer`)

Status: 2026-11-11, branch `claude/o3-k-behind`, session O3. Decisions D708–D712. **Result (§3): `pushPointer`
failed its rule and is deleted; `pushOpen` passed over days and is in the default.** Train suites only; heldout18 is not
dumped, labelled or run. Paid calls go to Anthropic directly with `HAIKU_API_KEY` through the lab (D97):
**Anthropic-direct lab figures**. Numbers marked **[EST]** are arithmetic or judgement; every other number comes from
a command in this note or the note it names.

## 0. Why

Over eight users' days (o3-push-open.md §7, the `eden` arm, 101 hidden tasks, Sonnet-graded) the planted item reached
the agent at its own request in 52 tasks (47 raised), **only at an earlier, unrelated request that day in 37 (12
raised)**, and never in 12. A constraint-worded item ranks for many of a day's requests, so it is handed early, where
the candidates' lead tells the agent to ignore what does not fit; at its own request the not-twice ledger (D13)
keeps it out of the packet and the agent rarely goes back to it. 28 of those 37 tasks still got a candidates packet
at the fact's own request; 9 got none.

Two earlier trials sent the item again: `pushReshow` (D340: +6.8 points, −0.5..+14.1, then +2.7, −1.8..+7.3 on fresh
users; deleted by D380 on one Sonnet-confirmed concern against none) and the check-gated `pushCheckReshow` (D512:
−10.9 against the check alone, n 46). `pushReshow` re-sent only items that passed the constraint test, and most
planted facts carry no constraint card or wording (packages/engine/CLAUDE.md, `planConflict`).

## 1. What is built (D708; a trial, off)

`pushPointer`: with `pushCandidates`, the items among this request's candidates that the agent was handed before this
request began (a ledger entry from an earlier turn) are named in the packet's lead after `POINTER_LEAD`, by title and
source, at most three, in rank order: "Already sent to you earlier in this conversation and ranking for this request
too (read them again above and judge them the same way): "…" (gmail); …". No item text is sent twice (D13 stands for
content), no constraint test narrows them, no model call and no wait are added. When the request has no new
candidate, the names go as a packet with no item of its own. A title is source text: one inert line, cut to 80
characters, its double quotes made single, inside the data envelope (as D301 quotes a request).

An item whose title the agent has already stated in a message of its own is not named (`saidTitle`: every content
word of the title in one recent agent message; best effort, no model). The lab's Pi harness and the client's
`withContext` report no agent messages, so this is inert in the runs below; the proxy reports them.

## 2. Pre-registration (committed before the first call of the run below)

A first form of this section named a two-arm run on 16 users; it was started, one user finished ($0.09), and it was
stopped unread when the owner's delegate asked for one run that also settles `pushOpen` over days (D709). The
finished user's results are not used.

- **Run:** pi-ab `--days 8`, the bench recipe, one user a process, one at a time, arms `eden`, `eden~O` (`pushOpen`),
  `eden~P` (`pushPointer`) and `eden~OP` (both). **Users w41–w72 (32)**, in two halves (w41–w56, then w57–w72); the
  second half runs only if the ledger's booked total after the first is under $19.5 (the cap is $25); if it is not,
  the rules are read on 16 users and the note says so. Cards and intent are replayed for w41–w44 and made in-run
  after.
- **Grades:** every hidden answer and every control or neutral concern regraded by Sonnet 5.5 (`i3-regrade.ts`).
  Hidden with whole users resampled (`n5/days_hidden.py`); cost and wall paired by task, clustered by user
  (`n5/mix.py --days`).
- **Rule for `pushPointer` (`eden~P` against `eden`):** it goes to the owner's delegate for the default only if
  hidden raised is at least **+4.0 points** with the user-resampled interval's lower bound above 0; Sonnet-confirmed
  concerns (control and neutral) are not up; total cost rises by at most **$0.20 per 1,000 tasks**; wall by at most
  **0.1 s** a task. Otherwise it is deleted with its code and tests.
- **Rule for `pushOpen` over days (`eden~O` against `eden`; D709, replacing o3-push-open.md §6's point-estimate
  clause):** it passes over days if the user-resampled interval's **lower bound for hidden is above −2.0 points**,
  Sonnet-confirmed concerns are not up, cost rises by at most $0.20 per 1,000 tasks and wall by at most 0.1 s. Passing
  here, with D706's pass one request a session, it is promoted into the default; failing, it stays off and is
  deleted at its end date (2026-12-10).
- **Also reported, no bar:** `eden~OP` against each single arm; of the hidden tasks whose fact was handed only
  earlier, in how many the pointer named it and how many of those were raised; pointers a task by kind.
- **Budget [EST]:** $4 a half (runs $3.5, regrade $0.5).

## 3. Result (2026-11-11)

Both halves ran (the booked total after the first was $17.43): 32 users, 4,103 task runs an arm (433 hidden, 433
control, 3,237 neutral), no errors, none ungraded. Sonnet regraded 1,858 answers in two batches (one batch's
worst-case reservation did not fit under the ledger's cap), none unreadable. The run cost $5.74 and the regrade $0.97.

| against `eden` (hidden 53.6%, 232 of 433) | hidden raised, points (users resampled) | confirmed concerns of 3,670 | cost per 1,000 tasks | wall, s a task |
|---|---|---|---|---|
| `eden` | | 3 (1 control, 2 neutral) | $0.228 | 1.387 |
| `eden~O` (`pushOpen`) | **+2.1** (−1.6..+5.6); 55.7% | 1 | +$0.012 (+0.009..+0.014) | +0.018 (−0.003..+0.042) |
| `eden~P` (`pushPointer`) | **−1.2** (−4.8..+2.3); 52.4% | 4 (2 control, 2 neutral) | +$0.004 (+0.002..+0.006) | −0.012 (−0.028..+0.004) |
| `eden~OP` (both) | +4.6 (+0.9..+8.4); 58.2% | 1 | +$0.018 (+0.015..+0.022) | +0.009 (−0.016..+0.036) |

- **`pushPointer` fails** (hidden −1.2 against a bar of +4.0 with the lower bound above 0; concerns 4 against 3) and
  is deleted with its code and tests (D711; the code is in commits 31ac72ad and f8d8cfdd).
- **`pushOpen` passes over days** (lower bound −1.6, above −2.0; concerns 1 against 3; cost and wall inside their
  bounds). With D706's pass one request a session it is promoted into the default as the part `open` (D710).
- **No bar:** `eden~OP` against `eden~O` reads +2.5 points (+0.2..+4.9), against `eden~P` +5.8 (+1.7..+9.9). The
  pointer alone reads below the default and beside the open push above it. This is one of several unplanned
  comparisons on one sample and the rule was written for the pointer alone, so it changes nothing here; a pointer on
  the new default would need its own pre-registered run on fresh users.
- **Where the fact was** (the run's timelines; Sonnet's grade): handed at its own request, only at an earlier request
  that day, or never, with the number raised.

  | arm | own request | earlier only | of those, a packet at the fact's request | never |
  |---|---|---|---|---|
  | `eden` | 189 (166 raised) | 190 (66) | 159 (51) | 54 (0) |
  | `eden~O` | 197 (170) | 192 (71) | 178 (65) | 44 (0) |
  | `eden~P` | 189 (163) | 189 (64) | 161 (53) | 55 (0) |
  | `eden~OP` | 196 (175) | 193 (77) | 191 (77) | 44 (0) |

  The timelines do not record which packets carried a pointer or how many, so the two counts §2 listed (tasks
  where the pointer named the fact; pointers a task by kind) are **not reported**.

### 3.1 "Earlier only" was two groups (a correction to §0 and D707's reading)

The agent's transcript resets each day (`pi-ab --days`), and so does Eden's session and its not-twice ledger. Split
by whether the earlier handing was the same day (the plan's day sizes give each request's day):

| arm | handed at its own request | handed earlier the same day only | not in that day's transcript at all |
|---|---|---|---|
| `eden` | 189 (166 raised, 88%) | 110 (66, 60%) | 134 (0) |
| `eden~O` | 197 (170) | 115 (71, 62%) | 121 (0) |
| `eden~P` | 189 (163) | 108 (63, 58%) | 136 (1) |
| `eden~OP` | 196 (175) | 119 (77, 65%) | 118 (0) |

So of the default's 190 "earlier only" tasks, 80 had the fact handed on another day only: the agent no longer held
it and Eden did not hand it at its own request, the same miss as "never" (54). A fact handed earlier the same day is
raised 60% of the time, not a third. The pointer could only reach that same-day group (it reads the session's
ledger) and did not move it (58% against 60%). **The larger gap over days is the 134 of 433 hidden tasks (31%) where
the fact is not among the request's candidates at all**: in 67 of the 80 other-day tasks a candidates packet of
other items went. A user's world holds every template's constraint and decoy at once, and the request's five
candidates fill with other requests' constraints. That is a ranking question a $0 screen can study; no model call
found it here.

```bash
.local/o3/days4.sh d4 41 … 72      # pi.sh per user: --days 8, arms eden,eden~O,eden~P,eden~OP, --budget 1.0
bun packages/sim/src/lab/i3-regrade.ts --results .local/o3/d4/s41/out.json,… --spend-ledger … --spend-cap 25
python3 -I packages/sim/lab/n5/days_hidden.py --base eden --arms 'eden~O,eden~P,eden~OP' .local/o3/d4/s*/
python3 -I packages/sim/lab/n5/mix.py --days --base eden --arms 'eden~O,eden~P,eden~OP' .local/o3/d4/s*/out.json
```
