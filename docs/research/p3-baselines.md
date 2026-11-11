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
