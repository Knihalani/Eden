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

## 2. Pre-registration: (c) the pointer on today's default (D832, a trial, off)

Written and committed before any paid call of this run.

**What is built.** `pushPointer` exactly as O3 built it (D708; commits 31ac72ad and f8d8cfdd, re-applied without
change on today's default, where `pushOpen` is on): with `pushCandidates`, the items among this request's candidates
that the agent was handed for an earlier request of the session are named in the candidates' lead (`POINTER_LEAD`, at
most three, by title and source, quoted and inert); no item text twice, no model call; with no new candidate the names
go as a packet with no item of its own. Off by default; owner P3; ends 2026-11-25.

**Why again.** O3 measured it beside the old default (`pushOpen` off): −1.2 points (−4.8..+2.3). Beside `pushOpen` it
read +2.5 (+0.2..+4.9), an unplanned comparison (D711). Today's default has `pushOpen`, so the comparison that read
+2.5 is now the plain one; it needs its own run on fresh users.

**Run.** `pi-ab --days 8` (pi-user's 1:1:8 days of 12–20 requests), Haiku 5.5 as the agent, one user a process, two
processes at a time, arms `eden` and `eden~P` (`--variant-config '{"P":{"pushPointer":true}}'`), **users w73–w104 (32,
none run before by O3 or B18), cards and intent requests made in-run** (the shipped pipeline; no replay covers them),
`--budget 0.5` a process, `packages/sim/lab/p3/run.sh`. Every hidden answer and every control or neutral concern
regraded by Sonnet 5.5 (`i3-regrade.ts`). Cost [EST] from O3's run ($5.74 for four arms on 32 users): about $2.9, the
regrade about $0.5.

**Rule.** It goes to the parent for the default only if, against `eden`, **hidden raised (Sonnet's grade) is at least
+2.0 points with the user-resampled 95% interval's lower bound above 0** (`n5/days_hidden.py`); Sonnet-confirmed
concerns (control and neutral) are not up by more than one; cost rises by at most $0.20 per 1,000 tasks and wall by at
most 0.1 s a task (`n5/mix.py --days --cluster user`). Otherwise it is deleted with its code and tests for good.
**Also reported, no bar:** where the fact was (handed at its own request, handed earlier the same day only, not that
day), and raised in each group, per arm.
