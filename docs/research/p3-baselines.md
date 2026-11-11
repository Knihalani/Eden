# P3: baselines (a stronger agent, plain retrieval, the pointer) and weak points 2 and 6

Status: 2026-11-11, session P3, branch `claude/p3-pointer` (it holds `claude/p3-baselines` and `claude/p3-alias`).
Decisions D830–D835. Train suites only (there is no
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
## 3. Weak point 2: facts outside the push's pool over days ($0)

All runs here: `days-calls.ts --days 8 --pool-diag` (Eden alone, no agent, time scale 0), the same 32 users O3 paid
for (w41–w72, 433 hidden and 433 control requests), cards replayed where the checked-in files hold them, and **the
intent index off** (`--intent none`). Without it the pool-recall gap is at its widest, so a lexical lever shows its
full reach; the paid run's users w45 on had intent requests only for the items a card call read.
`packages/sim/lab/p3/pool.py` sorts each request's planted item into o3-pointer §3.2's buckets.

| Arm | hidden pushed at its request | handed earlier that day | not in the pool | pooled, fails the constraint test | pooled, below the cut | decoys pushed at their request |
| --- | --- | --- | --- | --- | --- | --- |
| default (`--intent none`) | 184 | 94 | **112** | 27 | 12 | 184 |
| + `aliasTerms` (dates and names) | 190 | 93 | 108 | 25 | 13 | **197** |
| + dates only | 189 | 92 | 112 | 24 | 12 | 195 |
| + names only | 187 | 95 | 107 | 27 | 13 | 184 |

(With intent replayed, w41–w44: 26 pushed, 13 earlier that day, 2 not in the pool of 46, as O3 read.)

### 3.1 The lab's constraint density does not make the miss (B6)

A days user's world (`userWorldOf`) holds the base world's ~1,490 items plus one planted item for each of its own
hidden and control requests (about 28), not every template's. `--pool-diag` now counts, for each request, how many of
the pool's items are **other requests' planted items** (`poolPlanted`, `handedPlanted`): on average 1.3 of a hidden
request's ~15 pool items and 0.7 of its handed ones. Among the 112 facts not in the pool, the pool held none of them
in 40 cases, one in 40, two in 16 and three to six in 16. N2 found that a 60-item pool takes in only 10 of 72 such
facts (they are not ranked just below the cut; they are not ranked). So removing every other planted item would free
about one seat and would not bring these facts in: **the miss is the product's, not the lab's density.** (The lab may
still be easier than a real mailbox, which is larger and noisier than 1,500 items; that would make the miss larger.)

### 3.2 What links a missed fact to its request

Of the 112 facts not in the pool (a scratch classifier over request and item text; by hand on 15 of them):

- **60 share no content word, date or name with the request.** The link is an inference: "Dubai" and "no
  international trips"; "upper circle" and "on crutches, stairs are a nightmare"; "AWS, GitHub and Vault" and "14 SSO
  app assignments removed". Only the intent index (a card model's requests) or a model at the push reaches these.
- **38 share a content word** but rank outside the 15 (other items hold the same word more often).
- **About 14 share an anchor written another way:** a day ("Thursday 10 December" against "Thu 10 Dec", 10 tasks),
  a person ("Alex" against "Alexander Novak"; "Becky" against "Rebecca Stone"), an organisation ("Calder Mutual"
  against `caldermutual.com`, 2 tasks).

### 3.3 The alias table (`aliasTerms`, D833; built, screened, not run paid)

Built as a trial switch, off: at ingest each item is indexed with the other written forms of its day-and-month dates
(weekday and month in full, the day unpadded) and of its first names (a static nickname table both ways, the ambiguous
ones such as "Will" or "Pat" never read back), derived from the item's own text with no model and nothing stored
(`alias.ts`, `ItemCache.index`). The query is unchanged, so every search path sees the forms alike.

- **Dates** move 5 facts to their request's packet and **11 decoys**: a control task's decoy is written to share the
  request's day, so a date written another way finds the look-alike at least as often as the fact.
- **Names** move 3 facts (5 more into the pool) and no decoy.
- One request a session (`bun run funnel`): hidden surfaced 317 against 315, decoys 276 against 276; candidates hand
  290 facts against 289 and 250 decoys against 247.

On 16 fresh users with the shipped intent pipeline (w45–w60, `--days 4`, the cards and intent requests (b)'s paid
run made, `--intent` those files): **nothing moved** (hidden pushed 41 of 113 in both arms, decoys 42 in both).
**Rejected and deleted (D833; the code is in commit f39b431f).**

**Size of the bet: about +3 facts in 433 (0.7%) for names alone, under 1 point of hidden raised over days [EST], and
dates trade one fact for two decoys.** A paid run that could see 1 point needs several hundred users. The organisation
part (a domain label split by the user's own words) would reach 2 tasks. Lexical levers are exhausted here as well:
what remains is the 60 with no shared word, where every widening measured so far (embeddings k 3: +42 facts, +48
decoys, M3; N2) brings a look-alike per fact unless a model check separates them (the push check, owner decision Q4.1).
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

## 7. Pre-registration: (b2) the `hits` arm again, with its own prompt and Eden's compaction (D831)

Written after (b)'s results and the review of this branch, before any call of this run. The review found two
differences between `hits` and its design: its system prompt said "Use the tools to look up…" though the arm has no
tool (`systemPrompt`'s `data` sentence, true for `eden`, which has `ask_context`), and its excerpts were compacted
without `DEFAULT_CONFIG`'s `densePacket`, `compactParts` and the user's own name. Both are fixed: `hits` now gets "Items
from the user's own mail, calendar, documents, CRM and chat may be given to you as context before the request; use
them when the request depends on them." and Eden's compaction. The item ids handed are unchanged.

- **Runs:** `b2-short-S` (S = 41, 42; `--conditions hits --variants hidden,control,neutral`, `--budget 0.5`) and
  `b2-days-S` (S = 45..60; `--conditions hits --days 4 --day-size 16`, `--budget 0.3`), on the same tasks and users as
  (b), two processes at a time; hidden answers and concerns regraded by Sonnet. Cost [EST] about $1.
- **Read and rule:** as (b), with `eden` taken from (b)'s runs and paired task by task (the same seeds, plans and
  worlds). (b2) replaces (b)'s `hits` figures in D831 whichever way it reads; (b)'s are kept in §6 as run.
