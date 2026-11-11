# P3: baselines (a stronger agent, plain retrieval, the pointer) and weak points 2 and 6

Status: 2026-11-11, session P3, branch `claude/p3-baselines`. Decisions D830–D839. Train suites only (there is no
unread blind suite, D802). Paid calls go to the Anthropic API with `HAIKU_API_KEY` through the lab provider (D97):
every live figure here is an **Anthropic-direct lab figure** on simulated worlds. Numbers marked **[EST]** are
arithmetic or judgement; every other number comes from a command named beside it. Motivation:
[weak-points-1111.md](weak-points-1111.md) (Q1, Q2, Q3, B6, B10).

## 0. What was measured at $0 before anything was spent

| Command | Result |
| --- | --- |
| `bun run eval` | precision 0.65, recall 0.52, falseFireRate 0 (as on main) |
| `bun run funnel` | hidden 315/384, decoys 276/384 (as on main); candidates hand 289 facts and 247 decoys |
| `bun packages/sim/src/lab/hits-screen.ts` (seeds 41–42) | the request's top 5 BM25 hits over every source hold the hidden fact in **201/384** and the decoy in **223/384**; top 15: 262 and 266 |

So on one request a session, at $0, Eden's candidates hand 88 more hidden facts than the five best lexical hits, and
24 more decoys.

## 1. Pre-registration: (a) and (b)

Written and committed before any paid call of either run. Harness: Pi (`pi-ab.ts`) through
`packages/sim/lab/p3/run.sh` (N4's recipe: `--config default --tenant-prompt`, cards replayed from the three checked-in
files and intent requests replayed for seeds 41–44, payload notices, the market `direct` profile, time scale 1).
Eden's card and reader models and the grader stay `claude-haiku-5-5` in every run; only the agent changes. Every
hidden answer and every control or neutral concern is regraded by `claude-sonnet-5-5` (`i3-regrade.ts`) and Sonnet's
grade is the headline. One ledger (`.local/p3/ledger.jsonl`) with the session's hard cap ($30); each process has a hard
`--budget`. At most two Anthropic processes at a time.

### (a) Sonnet 5.5 as the agent (D830, a measurement)

**Question.** Of hidden facts Eden hands the agent at the fact's own request, Haiku 5.5 does not raise about one in
five (o3-check-behind §4). How much of that is the agent model?

**Runs.**

| Label | Agent | Shape | Arms | Task runs | `--budget` |
| --- | --- | --- | --- | --- | --- |
| `a-sonnet-short-h` | Sonnet 5.5 | seed 41, `--variants hidden` | `tools,eden` | 384 | $5.0 |
| `a-sonnet-short-c` | Sonnet 5.5 | seed 41, `--variants control` | `eden` | 192 | $2.5 |
| `a-sonnet-days-S` (S = 41..44) | Sonnet 5.5 | `--days 4 --day-size 16`, one user a process | `eden` | about 68 a user | $1.2 |
| the Haiku reference | Haiku 5.5 | the `eden` arm of (b)'s seed-41 short run and `a-haiku-days-S` (the same four users and days) | `eden` | | $0.3 |

Sonnet runs with `between_tools` thinking (it refuses "disabled"; A2, N4). The cost estimate is about $0.010 a
Sonnet task run (N4: $9.0–10.6 per 1,000) [EST]: $7.7 for the runs, $0.6 for the regrade.

**Read (no pass rule; no engine change follows, D830).**

1. Per agent, `eden` arm: of hidden tasks, the planted item **handed at its own request** (a packet or an
   `ask_context` answer of that request cited it; the timeline's `cited`/`askCited`), and of those, **raised**.
   "In hand, not raised" = handed and not raised, as a share of handed. Sonnet against Haiku, paired task by task on
   the same tasks, with a template-clustered 95% interval (short) and a user-clustered one (days).
2. Hidden raised, `eden` − `tools`, Sonnet agent, template-clustered (short).
3. Confirmed concerns (Haiku flagged, Sonnet keeps) on control (short) and control plus neutral (days), per agent.
4. Agent cost per 1,000 tasks and wall, per agent.

**What it decides.** If Sonnet's "in hand, not raised" is under 10% (upper bound under 15%), weak point 6 is mostly
the agent model: the docs say Eden's ceiling there is agent-bound and no Eden lever is built for it. Otherwise P3 tries
one new idea for it (not wording; §4), pre-registered on its own.

### (b) The `hits` arm: the five best lexical hits on every request (D831, a measurement)

**What is built.** A Pi condition `hits` (`lexical-hits.ts`): no Eden, no tools, no `ask_context`. On every request
the request's top 5 BM25 hits over every item of the user's sources (`SimIndex`'s ranked search, the one the `tools`
arm's sources answer with, over all sources at once; the world as it is at that request), redacted
(`sanitizeForStore`), in Eden's candidates packet (the same envelope, `CANDIDATES_LEAD`, 320-byte focused excerpts,
byte cap). No cards, intent, gate, constraint test, settled cut, nudge, not-twice ledger or silence.

**Runs (Haiku 5.5 as the agent).**

| Label | Shape | Arms | Task runs | `--budget` |
| --- | --- | --- | --- | --- |
| `b-short-S` (S = 41, 42) | `--variants hidden,control,neutral` | `tools,eden,hits` | about 1,700 a seed | $1.0 |
| `b-days-S` (S = 45..60, 16 fresh users; cards made in-run) | `--days 4 --day-size 16` | `eden,hits` | about 136 a user | $0.4 |

Cost [EST]: about $3 with the regrade.

**Read (no pass rule; no engine change follows, D831).**

1. Hidden raised (Sonnet's grade): `eden` − `hits` and `hits` − `tools`, short (templates resampled) and days (users
   resampled), 95% intervals.
2. Confirmed concerns on control and neutral, per arm.
3. Neutral requests given a packet, and items a neutral request; the agent's cost per 1,000 tasks (the 1:1:8 mix,
   `n5/mix.py`) and wall.
4. Handed at its own request and raised given handed, per arm (as (a) item 1).

**What it says.** "Eden's ranking and silence earn their keep" if `eden` − `hits` on hidden raised has its lower bound
above 0 on short and on days, and `eden`'s confirmed concerns are not above `hits`'. If `hits` is within 2 points of
`eden` (interval including 0) on either horizon, the report says that Eden's selection adds nothing measurable over
plain retrieval there, and what `eden` costs over `hits`.

## 4. Pre-registration: (a2) a second grade of "in hand, not raised" (D830, a measurement)

Written after (a)'s first read and before any call of this grade. (a)'s rule reads Sonnet's "in hand, not raised" at
20 of 193 (10.4%, short and days pooled), just over its 10% bar. A hand read of those answers (one reader, P3) found
most state the fact and leave out one clause of a multi-part detail (the grade asks for every clause). To replace the
hand read with an independent one:

- **What is graded:** every `eden` answer to a hidden task in (a)'s and (b)'s runs (seed 41–42 short, w41–w44 days)
  whose planted item was handed at its own request and which Sonnet's grade marks not raised; and, as a check of the
  rubric, a fixed sample of 40 such answers Sonnet marks raised (the first 40 by task id).
- **Grader:** Opus 5.5 (`core-grade.ts`, adaptive thinking at effort low, the nearest setting it accepts), asked
  whether the answer tells the user the core of the consideration (the fact that bears on the request and changes
  what should be done), even if it leaves out secondary details. JSON `{"core": true|false}`. Cost [EST] under $1.
- **Read:** per agent, of handed-not-raised answers, the share Opus calls core-stated; "in hand, core not stated" =
  handed answers neither grade calls raised, as a share of handed. **Rule (replacing nothing; added to (a)'s):** if
  Sonnet as the agent has "in hand, core not stated" under 5%, the docs say weak point 6 is the agent model plus the
  grade's every-clause rule, and no Eden lever is built for it. The rubric check must call at least 38 of the 40
  raised answers core-stated, or the second grade is not used.

## 5. Results: (a) Sonnet 5.5 as the agent

Runs 2026-11-11 (`packages/sim/lab/p3/ab.sh`; readouts `a-short.txt`, `a-days.txt`, `a2-core-grade.json` beside it).
No run stopped on its budget; no task errored. Sonnet's grade unless said.

| | Haiku 5.5 agent | Sonnet 5.5 agent |
| --- | --- | --- |
| Short, seed 41 (192 hidden): `tools` | 20 (10.4%) | 57 of 191 (29.8%) |
| Short: `eden` | 124 (64.6%) | 148 (77.1%) |
| Short: `eden` − `tools` (templates resampled) | +54.2 (+46.9..+61.5) | +47.1 (+39.3..+55.5) |
| Short: handed at its own request | 154 (80%) | 165 (86%) |
| Short: raised of handed ("in hand, not raised") | 80.5% (19.5%) | 89.7% (10.3%) |
| Days, w41–w44, 4 days of 16 (32 hidden): `eden` | 18 (56.2%) | 27 (84.4%) |
| Days: handed at its own request; raised of handed | 17; 12 (29.4% not raised) | 28; 25 (10.7%) |
| In hand, not raised, short and days pooled¹ | 67 of 333 (20.1%) | 20 of 193 (10.4%) |
| **In hand, core not stated (Opus's second grade, §4)** | **17 of 333 (5.1%)** | **1 of 193 (0.5%)** |
| Confirmed concerns, control and neutral | 0 | 1 of 192 control (short) |
| Agent + Eden cost per 1,000 task runs, short `eden` | $0.27 | $8.64 (`tools` $9.03) |

¹ Haiku's pooled count is over both short seeds' `eden` arms (seed 42 from (b)), so its denominators differ from the
paired rows above; Opus graded all of them.

- **Paired, `eden` with Sonnet against `eden` with Haiku** (the same tasks and Eden's same replayed packets): short
  +12.5 points (+6.2..+18.8; 192 pairs); on the 151 tasks handed in both, 136 against 122 raised. Days +28.1
  (+15.6..+43.8; 32 pairs, 4 users, an interval on four clusters): Sonnet asks more, so the fact reaches it at its own
  request in 28 tasks against 17.
- **(a)'s rule read on Sonnet's grade:** "in hand, not raised" 10.4% pooled, just over the 10% bar (upper bound about
  15%). **(a2)'s rule:** with Opus's core grade (its rubric check: 40 of 40 raised answers called core-stated) it is
  0.5%, under 5%. Of Sonnet's 20 graded misses, Opus calls 19 core-stated; they name the fact and leave out a clause
  of a multi-part detail ("DVLA asks not to apply again", "fees paid now won't be refunded until January").
- **What it says (D834):** weak point 6 ("one handed fact in five not raised") is the agent model and the grade's
  every-clause rule, not Eden. With Sonnet as the agent, a fact Eden hands is stated, in its core, in 192 of 193 tasks;
  with Haiku in 316 of 333. Half of Haiku's gap to Sonnet is the grade (Opus calls 50 of Haiku's 67 graded misses
  core-stated). No Eden lever is built for it, and four failed wording fixes (D705 and earlier) are consistent with
  this. The headline grade stays as it is (it is what every earlier figure used); a report quoting "raised" should say
  it requires every clause.

## 6. Results: (b) the five best lexical hits on every request

Haiku 5.5 as the agent, Sonnet's grade (`b-short.txt`, `b-days.txt`, `b-mix.txt`). No run stopped on its budget.

| | `tools` | `hits` | `eden` | `eden` − `hits` |
| --- | --- | --- | --- | --- |
| Short, seeds 41–42 (384 hidden), templates resampled | 9.6% | 40.1% | 66.1% | **+26.0 (+19.3..+33.1)** |
| Short: handed at its own request; raised of handed | | 201 (52%); 76.6% | 316 (82%); 80.4% | |
| Days, w45–w60 (16 fresh users, 128 hidden), users resampled | not run | 48.4% | 60.9% | **+12.5 (+4.7..+20.3)** |
| Days: at its own request; earlier that day only (raised); not that day | | 70; 41 (11); 17 | 66; 40 (23); 22 | |
| Confirmed concerns, control and neutral (short; days) | 0; not run | 0; 0 | 0; 0 | |
| Neutral requests given a packet (short; days) | | 100%; 100% | 97%; 97% | |
| Agent + Eden $ per 1,000 tasks, 1:1:8 mix (short) | −$0.040 | **−$0.104** (−0.116..−0.091) | $0.264 | |
| Same, days (users resampled) | | **+$0.017** (+0.011..+0.024) | $0.236 | |
| Wall a task (short; days) | +1.05 s | −0.68 s; +0.04 s | 2.20 s; 1.47 s | |

`hits` − `tools`, short: +30.5 points (+23.7..+37.2).

- **Eden's selection earns its keep (the pre-registered reading holds on both horizons): +26.0 points one request a
  session and +12.5 over users' days over pushing the five best lexical hits.** Pushing any retrieval is worth about
  as much again over the agent with its own search tools (+30.5).
- **The gain is which items are handed, not how the agent reads them.** Where both arms handed the fact at its
  request the agent raised it alike (short 149 against 148 of 189; days 39 against 39 of 49). One request a session
  Eden hands the fact in 82% of tasks against 52%: cards, intent requests and the ask (`ask_context` is part of the
  `eden` arm; `hits` has none). Over days `hits` hands the fact at its own request slightly more often (70 against
  66; it has no not-twice ledger), but the agent raises fewer of them (73% against 83%) and far fewer of those
  handed earlier the same day (11 of 41 against 23 of 40): five look-alikes on every request bury the fact.
- **Silence is not what separates them.** Eden puts a packet on 97% of nothing-to-add requests against `hits`' 100%,
  with 3.8 items against 5.0 (weak point Q4 stands). No arm had a Sonnet-confirmed false concern.
- **Cost.** One request a session `hits` is $0.10 per 1,000 tasks cheaper and 0.68 s faster than `eden`: Eden's
  agent calls `ask_context` (0.64 tool calls a task) and takes half a model turn more. Over days `hits` is $0.017 per
  1,000 dearer: five items on every request stay in the day's transcript.
