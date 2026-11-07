# A9: answer-ahead and plan-conflict proactivity

Status: 2026-11-07, branch `claude/a9-ahead` (from `claude/lucid-hypatia-v9wqk5` at `ae5757b75`). Decisions D300–D302.
Every paid call went to the Anthropic API with `HAIKU_API_KEY` through the lab provider (D97), `claude-haiku-5-5` in
every role (agent, grader, cards), `OPENROUTER_API_KEY` unset, one ledger (`.local/a9/ledger.jsonl`), hard cap $2.5;
one regrade used `claude-sonnet-5-5`: **Anthropic-direct lab figures**. Train only (seeds 41–42); no held-out suite
was run. **Spent: $1.859** (`packages/sim/lab/a9/spend.txt`). Intervals are paired bootstrap 95% (5,000 draws, seed
1). Every number comes from a command in this note; the 1:1:8 mix (hidden : control : nothing-to-add) is an assumption.

## In plain words

- **Answer-ahead (A6's idea 2) does not pay: deleted (D300).** The push also carried the records the agent would look
  up first: the newest item about each person or firm the request names, and the calendar of the day it names. Where
  it fired (about a quarter of requests) the agent asked Eden 0.30 times less a task (−0.47..−0.14) and took 0.20
  fewer turns. But across all traffic nothing moved: asks, turns, output tokens, wall time and dollars all within noise,
  one request at a time (dressed worlds) and over a user's eight days. The reason is in the agent's questions: they are
  mostly for records the worlds do not hold (an account number, a registry's items, a contract's terms), so there is
  nothing to send ahead, and the person's own record is usually already among the push's candidates. On the hidden
  tasks it did reach, the agent asked less and raised 26 facts of 37 against 29: D257's trap, small but in the wrong
  direction. Not better on its axis, so it went, with its code and tests.
- **Plan-conflict proactivity (A6's idea 5) works: promoted (D301).** When something new arrives that bears on a
  request the agent already acted on in this conversation (a cancellation after the booking), Eden now tells the agent
  at its next turn, whatever it is asked then. In a new lab test where each request's key fact arrives only after the
  agent answered it (D302), the agent's later replies that day raised the fact **59 times in 144 against 8 without
  it, +35.4 points (+27.1..+43.8)**, and 3 for the agent with its own tools. False alarms on look-alikes: 1 against 1
  after a Sonnet regrade (Haiku had graded 8 against 1; read by hand, 2 are real and 1 borderline). It costs Eden
  nothing (no model or connector call), and the agent about 3–8% more a task on days where every request's fact
  arrives late (it says the fact). On ordinary days it stayed silent: no plan packet reached a request over two users'
  eight days, and with 2–5 unrelated background items arriving between requests it spoke before 1–8% of requests.
- **Connector pricing.** Neither idea adds a connector call. Per plan (market.py's CONNECTORS), answer-ahead's arm
  costs what `eden` costs on every plan; one request at a time both make no connector calls against the tools agent's
  3.46 a task ($89.65 against $0.41 per 1,000 tasks on Zapier MCP).

## 1. What was asked, and the guard against D257

A6 left two untested levers: answer-ahead (idea 2: the push pre-answers the agent's first lookups, so it answers in one
call) and event-driven proactivity (idea 5: speak when a new item conflicts with something the agent already acted
on). D257's lesson bounds both: anything that makes the agent ask less can lose the hidden facts its own ask finds.
Answer-ahead's lead therefore never says nothing else exists ("records … about who and what this request names …,
for reference; nothing has checked them against it"; a test checks the wording), and both runs report hidden facts
beside asks.

## 2. Answer-ahead (D300, deleted; code in `c6ac643b`, `231649a8`)

**Mechanism.** Trial `pushAhead` (off). On the push's first pass, from the push's own ranked pool (lexical, probed, the
named days' events; no new call): the newest item naming each of the first two names the request gives (an address,
two or more words, or one word with an inner capital), then the events of the day or two it names, soonest first (a
span such as "this week" sends no calendar: the first smoke sent seven days of it), at most four, none already a
candidate, as a second packet re-read like the candidates (`verifyItems`). Eight tests.

**$0 screen** (`bun run funnel … -- --neutral --packets`, train1–6 seeds 41–42, undressed; `ahead-screen.txt`):

| Kind | Tasks with an ahead packet | Items a task | Bytes a task | Planted item only in the ahead packet |
| --- | --- | --- | --- | --- |
| hidden | 104 / 384 (27%) | 0.64 | 144 | 2 |
| control | 96 / 384 (25%) | 0.62 | 138 | 3 |
| nothing-to-add | 95 / 384 (25%) | 0.59 | 128 | 0 |

Every other packet was identical (384 of 384 a kind); funnel TOTAL hidden 305 → 307, decoys 267 → 270.

**Live** (Pi, payload, `tools,eden,eden~ahead`; short: `--dress --limit 12`, 144 a kind and arm; long: `--days 8`,
users 41–42; `short-arms.txt`, `long-arms.txt`, `short-asks.txt`, `long-asks.txt`, `short-reach.txt`, `pooled-ahead.txt`):

| | eden | eden~ahead | paired (ahead − eden) |
| --- | --- | --- | --- |
| Short: requests reached (hidden / control / neutral) | | 26% / 25% / 23% | |
| Short, reached tasks only (n 106): asks a task | | | −0.30 (−0.47..−0.14) |
| Short, reached tasks only: turns / output tokens | | | −0.20 (−0.29..−0.10) / −0 (−30..+28) |
| Short: asks a task (hidden / control / neutral) | 0.50 / 0.72 / 0.95 | 0.42 / 0.60 / 1.01 | −0.08 (−0.19..+0.01) / −0.13 (−0.24..−0.02) / +0.06 (−0.10..+0.21) |
| Short: mix asks, turns, output tokens (point) | | | +0.024, +0.026, +11.6 |
| Short: mix wall | 3.49 s | 3.57 s | +0.08 s (−0.09..+0.25) |
| Short: mix $/1k (`arms.py` all-in) | 0.406 | 0.408 | +0.003 (−0.020..+0.024) |
| Short: hidden raised | 73.6% | 70.1% | −3.5 points (−10.4..+3.5) |
| Short: hidden raised where it reached (37 tasks) | 29 | 26 | |
| Long: mix asks a task | 0.103 | 0.069 | −0.034 (point) |
| Long: mix wall / $/1k | 2.77 s / 0.341 | 2.73 s / 0.343 | −0.04 s (−0.16..+0.07) / +0.002 (−0.009..+0.013) |
| Pooled, 4 runs: hidden raised (n 167) | | | −1.8 points (−8.4..+4.8) |
| Pooled: concerns on control + neutral, regraded (n 497) | | | −0.2 points (−1.6..+1.2) |

**Why it does not pay.** The questions Eden's agent still asks on dressed worlds (`asks.py --questions`) are mostly
for what no world holds: "list items on Tilly and Ross's gift registry under £100", "account names, sort codes",
"current annual price per seat, term end date". The dressing message that does exist ("You can reach X on 020…")
usually ranks among the push's candidates already, so answer-ahead has nothing new to add (it fired on a quarter of
requests). Over a user's days the agent asks 0.1 times a task: its day's transcript holds what it learned. **Verdict:**
not better on its axis; deleted (D112).

## 3. Plan-conflict proactivity (D301, promoted)

**Mechanism.** `planConflict` (on in the default, part `plans`). Each session keeps the cues of its last 12 acting
requests (those the push ran for). The sync's `onStored` (a poll, a notice's payload) records, per such session, the
ids it stored; at the session's next take (`takePending`, or an observe that starts no push, so `pending` says a
packet waits) each id is checked against each acting request by `candidatesOf`'s rule: among the first
`pushCandidates` of that request's ranked pool, bulk mail out, the pool holding something constraint-like (cards
included). One that qualifies and that no packet has handed the session is queued as a packet:

```
Eden: new in the user's sources since an earlier request in this conversation, and may bear on it; nothing has
checked it against that request. If it is about the same person, thing and date and changes what was done or planned,
tell the user; if not, ignore it and do not mention it. The earlier request: "Move £5,000 from my current account …"
- [gmail] We've received your ISA subscription: …
```

Two design turns, both from the smoke: (1) checking at the store found no card yet for the new item, so the check
moved to the take; (2) requiring the item itself to read as a constraint (A6's sketch) missed most facts (the ISA
statement has no constraint wording and no card), so the rule is the candidates', which is how the same item would have
reached the agent had it existed at request time. Nine tests (off in the core, the packet's words and envelope, once
per item, no packet for an unrelated item or a pool with nothing constraint-like, none after an information question,
isolation across users and sessions, a closed session forgotten, `pending` reported, the config check).

**The lab test (D302): `pi-ab --day 4 --late`.** Each request's planted item is held out of the world until the
agent has answered that request, then arrives as a new item at its source (the notice carries it, `--push payload`);
the next request comes ten minutes later (the harness waits for the item's card) and is about something else; the day
ends with the recap. The agent's later replies that day are graded against the planted request (`lateFacts`).
Nothing-to-add days are left out: nothing arrives on them.

| `--day 4 --late`, train seeds 41–42 (`late.txt`, `latec.txt`) | tools | eden | eden~plan |
| --- | --- | --- | --- |
| Hidden: later replies raise the late fact (n 144) | 3 | 8 | **59** |
| Control: later replies raise the look-alike (n 144) | 1 | 1 | 5 |
| Control replicate, as Haiku graded (n 144) | | 1 | 8 |
| Control replicate, regraded by Sonnet | | 1 | 1 |
| Plan packets taken at a graded request (run 1; the recap's are not counted) | 0 | 0 | 84 |
| Agent $ per 1,000 tasks (run 1, seed 41 / 42) | | 0.352 / 0.338 | 0.368 / 0.363 |

Paired: corrected course **+35.4 points (+27.1..+43.8)** against `eden`, +38.9 (+30.6..+47.2) against `tools`; false
alarms +2.8 (0.0..+6.2) in run 1 and +4.9 (+1.4..+9.0) in the replicate as graded, 0 regraded; agent $/1k tasks +0.020
(+0.007..+0.033) and +0.017 (+0.002..+0.032). Read by hand, the replicate's eight graded alarms are: the agent applying
last year's ISA subscription to this year's allowance (real, hedged: "confirm it relates to 2026/27"), keeping a review
private on a People-team note about other reviews (borderline), a sister pub's refit mentioned as relevant (borderline
at most), and five that state the look-alike correctly (an approved access ticket, a cancelled match, "not done").

**Ordinary days.** The long-horizon run (`--days 8`, users 41–42, `eden~plan` against A9's `eden` and `tools`,
`plong-arms.txt`) never put a plan packet in front of a graded request (the static worlds send nothing new); mix $/1k
+0.008 (−0.001..+0.016), wall −0.06 s (−0.18..+0.04). Since the lab's worlds are static, a $0 screen sends ordinary
traffic (`arrivals.ts`, `arrivals.txt`: a user's eight days, Eden alone with cards replayed, randomly chosen background
items held back and arriving between requests, none of them a planted fact, so every plan packet is a false fire):

| Background items per request gap | w41 | w42 |
| --- | --- | --- |
| 2 (228 / 236 arrivals) | 4 of 114 requests (3.5%), 0.50 items a day | 1 of 118 (0.8%), 0.13 a day |
| 5 (570 / 590 arrivals) | 7 of 114 (6.1%), 0.88 a day | 9 of 118 (7.6%), 1.13 a day |

For scale, the candidates' packet goes out on about three requests in four. With one request per session (the funnel)
nothing can arrive after the request: 1,152 of 1,152 tasks' packets are identical with it on, and `bun run eval` is
unchanged.

**Verdict.** A new capability with a large gain on its axis, no regraded rise in false alarms, no Eden spend, and an
agent cost that is the price of saying the fact; promoted (D301). It departs from D3 (an unasked packet about an
earlier request) at the volume above.

## 4. Decisions

- **D300**: trial `pushAhead` opened and closed the same day: measured not better, deleted with its code and tests.
- **D301**: `planConflict` promoted into the default (part `plans`), with its D3 departure stated.
- **D302**: lab only: `pi-ab --day K --late` (`pi-late.ts`) and `a9/arrivals.ts` kept as instruments.

## Open

- The late test plants a fact on every request of a day: real days have few such arrivals, so the cost rise above is
  an upper bound. A held-out check (`heldout` suites, `--late`) has not been run.
- Recap replies are graded but their packets are not in `tasks.jsonl` (the recap is no task): the 84 plan packets
  counted exclude those taken at a recap.
- A6's open item (Eden's background re-reads over a user's days: 2.29 connector calls a task against the tools
  agent's 1.71 here) is untouched.

## Reproduce

```bash
cat packages/sim/lab/cards/cards-{v2,train,train-4344}.jsonl > .local/a9/cards-all.jsonl
R=packages/sim/lab/a9/run.sh; S=.local/a9/runs; O=packages/sim/lab/a9
# Answer-ahead (code in 231649a8): $0 screen, then live
bun run funnel --json .local/a9/f-base.json -- --neutral --packets .local/a9/f-base.packets.jsonl
bun run funnel --set '{"pushAhead":true}' --baseline .local/a9/f-base.json --json .local/a9/f-ahead.json \
  -- --neutral --packets .local/a9/f-ahead.packets.jsonl
python3 -I $O/ahead-screen.py .local/a9/f-base.packets.jsonl .local/a9/f-ahead.packets.jsonl
export A9_VC='{"ahead":{"pushAhead":true}}'
$R a9-short-41 payload tools,eden,eden~ahead --seeds 41 --variants hidden,control,neutral --limit 12 --dress \
  --budget 0.4                                                                    # and 42
$R a9-long-41 payload tools,eden,eden~ahead --seeds 41 --days 8 --budget 0.25    # and 42
python3 -I packages/sim/lab/cl7/arms.py --arms tools,eden,eden~ahead $S/a9-short-4{1,2}      # long alike
python3 -I $O/asks.py eden~ahead eden $S/a9-short-4{1,2} [--questions]; python3 -I $O/reach.py eden~ahead eden $S/a9-short-4{1,2}
python3 -I packages/sim/lab/cl8/pooled.py eden~ahead eden $S/a9-short-4{1,2} $S/a9-long-4{1,2}
python3 -I packages/sim/lab/a6/connector-price.py short $O/short-arms.txt long $O/long-arms.txt
# Plan-conflict (on in the default since D301: the arm's variant is a no-op on this tree; `--config default` with
# '{"plan":{"planConflict":false}}' as the base arm reproduces the pair)
export A9_VC='{"plan":{"planConflict":true}}'
$R a9-late-41 payload tools,eden,eden~plan --seeds 41 --variants hidden,control --limit 12 --day 4 --late --budget 0.35
$R a9-latec-41 payload eden,eden~plan --seeds 41 --variants control --limit 12 --day 4 --late --budget 0.15
$R a9-plong-41 payload eden~plan --seeds 41 --days 8 --budget 0.12                # each for 42 too
python3 -I $O/late.py eden~plan eden,tools $S/a9-late-4{1,2}
python3 -I packages/sim/lab/cl7/arms.py --arms tools,eden,eden~plan $S/a9-long-41:tools,eden $S/a9-long-42:tools,eden \
  $S/a9-plong-4{1,2}
bun packages/sim/lab/a9/arrivals.ts --cards .local/a9/cards-all.jsonl [--per-gap 5]
# Concern regrades: regrade.ts --only-concerns per run (Haiku); the replicate's later replies by Sonnet, from a copy
# of its results with each planted request's `answer` set to its `lateText`.
```

## Spend (`packages/sim/lab/a9/spend.txt`, cap $2.5)

| What | $ |
| --- | --- |
| answer-ahead: short dressed, three arms, seeds 41–42 | 0.608 |
| answer-ahead: long, three arms, users 41–42 | 0.314 |
| plan-conflict: late days, three arms, seeds 41–42 | 0.582 |
| plan-conflict: late control replicate, two arms | 0.185 |
| plan-conflict: long, one arm, users 41–42 | 0.108 |
| smokes | 0.034 |
| regrades (Haiku; Sonnet on the replicate) | 0.029 |
| **Total** | **1.859** |
