# G4: agent + Eden no slower than the agent alone (target 4)

Status: 2026-11-12, session G4, branch `claude/g4-speed` (run tree: main with `claude/f11-turns` at e47fe735 and F1's
harness fix a0df6639 merged). Decisions D1550–D1553. Tuning suites only (dev20, seed 41); heldout20 is never read or
run. **Every number is served by subagents (D1101)**: Haiku subagents answer the agent, the push check and the
cards, Sonnet subagents grade. Wall times and dollars are **[EST]**, modelled from each task's timeline
(`packages/sim/lab/final/wall.py`).

## 1. Pre-registration (committed before any result of the run was read)

**The bar (the integrator's, as last changed at 10:35 UTC).** In the multi-turn harness of the final's step 2b
(`pi-ab`, the real Pi loop; here `packages/sim/lab/g4/run.sh`, the same flags) on dev20 at 40 tasks a world (120 an
arm): agent + Eden wall a task, by `wall.py`, is at most the agent alone's at the measured connector latency and at
0.3 s a connector round; hidden raised falls by at most 0.5 points against the default; decoys handed and concerns on
control and neutral do not rise; Eden's CPU p99 a request stays under 10 ms. A partial pass does not ship.

**Run `g4b`.** Four arms, one process each, one queue, a batch holding one arm's requests (F7 §13): `mt-raw`
(`tools`), `mt-final` (the default), `mt-lk` (F11's LK4: `pushLookup` 3, `pushLookupAny`, `pushLookupQuiet`, on
e47fe735's plain-records rule), `mt-lku` (LK4 plus `pushLookupUnchecked`).

**D1552, `pushLookupUnchecked` (engine, trial, off; needs F11's `pushLookup`, D1252).** A push whose pool holds
nothing constraint-like asks no check and hands nothing, so the agent searches. The switch hands those turns the
lookup's reference records under a lead that claims no check. Rule, `mt-lku` against `mt-lk`: recommend promotion
with D1252 if all hold, else delete with its code and tests today:
1. the agent's connector calls a task are at least 0.15 lower, or wall at the measured latency is lower with its
   paired 95% interval below 0;
2. hidden raised (the run's Sonnet grader) is not lower by more than 0.5 points (on 40 hidden tasks: not lower);
3. concerns on control and neutral (the run's grader) are not higher, and control tasks whose packet holds the
   planted look-alike are not more.
If D1252 itself is rejected by F11's confirmation, D1552 is deleted with it.

**D1551, `ahead` and the proxy's `speculateAhead` (trial, off; needs F10's `speculate`, D1273).** The engine tells
the caller, before the check answers, the packet a silent check would hand; the proxy sends its early request with
that packet and keeps the answer only on a byte-for-byte match. The agent's bytes are the default's by construction
(tests: engine, server, client, proxy, and end to end), and Pi's lab harness does not go through the proxy, so no lab
arm can measure it: it is priced on `mt-lk`'s timelines by `wall.py --hold`. Rule: keep it as a trial beside
`speculate` if, on `mt-lk`, the "ahead" reading releases at least 20% of tasks and its wall at the measured latency
is below the "speculate" reading's; otherwise delete it. Whether either is on by default is the integrator's call
with G3's cost result (an aborted call is paid for), as for D1273.

## 2. The wall model (D1550)

`cost.py`'s first wall figure summed the modelled latency of every agent call and every `eden.check` line in the
queue's `calls.jsonl`. On F6's dev20 rehearsal that read 2.2 s against the agent alone's 1.8 s. Two things were wrong
with it: a call replayed after a restart is logged again (567 check lines for 293 checks on the timelines), and the
agent's connector time, most of what Eden saves, was left out. `packages/sim/lab/final/wall.py` reads each task's
own timeline instead (its header says how each part is priced) and pairs the arms task by task, with a bootstrap over
templates. It is on main and in the final's report since #310; F6 fixed `cost.py`'s double count in #308.

## 3. Run g4b (dev20, seed 41, 480 paired tasks an arm; served by subagents, D1101; wall [EST])

`SUITE=dev20 SEED=41 LIMIT=40 PREFIX=g4b bash packages/sim/lab/g4/run.sh`, then
`python3 -I packages/sim/lab/final/wall.py .local/final/g4b --arms mt-final,mt-lk,mt-lku --hold`. No check landed
late; no task failed. A check is priced at 701 ms (36 output tokens, the run's mean). Hidden raised is the run's
Sonnet-subagent grade; concerns are the same grader's and read high on neutral in every arm, the agent alone
included, so compare them only between arms. "Look-alike handed" counts control tasks whose packets cite the
planted look-alike.

| arm | hidden raised | look-alike handed | concerns, control / neutral | model calls, connector calls a task | wall at the measured latency, against raw | wall at 0.3 s a connector round, against raw |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| agent alone (`tools`) | 13/160 | 0 | 0 / 34 | 2.10, 1.54 | 2,346 ms | 1,921 ms |
| default | 72/160 | 26 | 4 / 74 | 1.75, 1.01 | 2,295 ms, −2.2% (−7.1..+2.7) | 2,087 ms, +8.6% (+4.7..+12.5) |
| default, `speculate` (modelled) | the default's bytes | | | | 2,140 ms, −8.8% (−13.4..−4.2) | 1,932 ms, +0.5% (−2.9..+4.1) |
| LK4 (F11) | 63/160 | 34 | 2 / 46 | 1.64, 0.91 | 2,170 ms, −7.5% (−12.1..−3.0) | 1,980 ms, +3.1% (−0.5..+6.5) |
| LK4, `speculate` (modelled) | LK4's bytes | | | | 2,163 ms, −7.8% | 1,973 ms, +2.7% |
| LK4, `speculateAhead` (modelled) | LK4's bytes | | | | 1,911 ms, −18.5% (−23.1..−14.1) | 1,721 ms, −10.4% (−14.0..−6.9) |
| LK4 + `pushLookupUnchecked` | 62/160 | 35 | 4 / 44 | 1.63, 0.85 | 2,140 ms, −8.8% (−13.8..−3.9) | 1,967 ms, +2.4% (−1.5..+6.2) |

What it says:

- **Where the time is.** The agent alone spends 1.59 s in 2.10 model calls and 0.75 s in 1.10 connector rounds. With
  the default it makes 1.75 model calls and 0.72 rounds, and waits 0.47 s for the push check (0.67 blocking checks a
  task) and 0.03 s for the rest of Eden's path.
- **The bar (parity).** The default is level with the agent alone at the lab's measured connector latency and slower
  at 0.3 s a round, where the calls it saves are worth less than the check's wait. With F10's `speculate` it is level
  at both. The price is the aborted early calls: 0.45 a task on this run (214 of 480), their input paid for nothing.
- **`speculate` and `pushLookup` do not compose.** Once a silent check hands reference records, the early request
  sent with no packet matches on 5 of 480 tasks and 317 are aborted. `speculateAhead` sends the early request with
  the packet a silent check would hand: 179 of 480 released, 143 aborted.
- **LK4 on this run traded facts for speed.** Against the default it raised 9 fewer hidden facts (72 → 63 of 160,
  −5.6 points) and put the look-alike in 8 more control packets (26 → 34), while neutral concerns fell (74 → 46) and
  the agent made fewer calls. That is outside the bar's facts guard. D1252 is F11's to decide on its own
  confirmation; this run is evidence for it, reported to F11 and the integrator.

**Caveats.** One seed. The agent, check, cards and grader are subagents, more diligent than the API's Haiku (D1140),
so levels read high. In the coverage step one card request (about ten items of one world) was answered with another
request's cards; every Eden arm replays the same file, so arms are affected alike. The `speculate` rows are modelled
on the measured timelines (the Pi harness does not go through the proxy): they assume the early call starts with the
user's message and that a released call saves min(check, first call).

## 4. Decisions

- **D1552, `pushLookupUnchecked`: rejected and deleted.** Against LK4: connector calls −0.06 a task (the rule needed
  −0.15), wall −1.4% (−3.7..+0.9) at the measured latency, hidden 63 → 62, look-alikes handed 34 → 35. It fails
  rule 1 and rule 3. The turns it reaches (no constraint-like item in the pool) are mostly turns the agent already
  answers without searching. Code and tests in commit c736020c.
- **D1551, `ahead` and `speculateAhead`: kept as a trial, off, beside `speculate`.** On LK4's timelines it releases
  37% of tasks (rule: at least 20%) and reads 1,911 ms against `speculate`'s 2,163 ms. It changes nothing the agent
  sees (the proxy keeps an early answer only on a byte-for-byte match; `proxy-ahead-e2e.test.ts` runs the proxy, the
  client, the real handler and the engine). It is worth merging only if D1252 (`pushLookup`) lands: without it a
  silent check hands nothing, and `speculate` alone already matches. Its code is not on main: it is handed to F12 as
  off-by-default code on `claude/g4-speed` (its decision row, D1551, is there too); not reviewed by the reviewer subagent (the account's subagent capacity was kept for the final),
  so that review is owed before a merge (D814).
- **D1550, finding.** Target 4 at parity is met by the default with `speculate`, at an abort cost that is G3's and
  the integrator's to weigh; without `speculate` the default is slower than the agent alone wherever a connector
  round costs less than about half a second.

Not done: Eden's CPU p99 a request was not re-measured. With both trials off the default's path is unchanged; with
`ahead` asked, a push that waits for a check renders one more packet (the same code as the delivery's).
