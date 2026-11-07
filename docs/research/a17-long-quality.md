# A17: quality over a user's days

Status: 2026-11-07 (audit wave A, session A17). Branch `claude/a17-quality-long` from `claude/lucid-hypatia-v9wqk5`
(598bd6ebe). Decisions D340–D343. Every paid call went to the Anthropic API with `HAIKU_API_KEY` through the lab
provider (D97), `OPENROUTER_API_KEY` unset, `claude-haiku-5-5` in every role (agent, grader, cards, intent), on the
ledger `.local/a17/ledger.jsonl` with a hard cap of $2.50: **Anthropic-direct lab figures**, not the OpenRouter route
the servers ship. Train only. **Spent: $2.352** of the $2.50 cap.

## In plain words

- **Eden does not get worse as a day goes on, but it wasted what it had already said.** Over four users' eight days
  (`pi-ab --days 8`), the share of hidden facts the agent raised did not fall with position in the day (60%, 50%, 70%,
  83% for requests 1–4, 5–8, 9–12, 13+ under payload notices). The agent stops calling `ask_context` after the first
  few requests (0.18 asks a request, then 0.00), so Eden's unasked packet carries the day.
- **The loss that grows with the day: a fact Eden pushed early, for the wrong request, was kept back at the right
  one.** A constraint-worded item ranks for many requests, so it was often handed as a candidate to an unrelated
  request earlier that day, where the agent was told to ignore what does not fit. At its own request the not-twice
  ledger then kept it back, and the agent rarely went back to it in the transcript: raised 6 of 14 (payload), 5 of
  13 (signals) and 16 of 26 (40-request days), against 24 of 25 when it came in the request's own packet. On 8-day
  days this was 30% of hidden tasks; on 40-request days, 54%.
- **Fix 1, kept as an off trial (D340, `pushReshow`, ends 2026-12-07):** a push candidate the agent took for an
  earlier request is handed again when it ranks for this one and passes the constraint test. Pooled over every sample
  (the final rule's included): **+6.8 points of hidden facts raised (−0.5..+14.1, n 220**, the shared baseline
  resampled as one), look-alike and nothing-to-add concerns flat, **+$0.013 per 1,000 tasks of agent tokens on 8-day
  days** (+5%; +$0.017 with the 40-request stress days), no Eden model or connector call under payload notices (+5%
  connector calls under signal-only notices). Every sample moved the same way and a re-shown planted item was raised
  45 of 55 times, but the gain is not shown and the cost is: under D112 it stays off until a fresh paired run.
- **Stale recaps: the update reached the agent, and it still named the old time.** With D205 on, recaps named a
  changed item's old time on 29 of 147 occasions (fresh 118). Of the stale ones, 18 of 28 had been sent an
  "updated:" packet after the change; Eden had done its part.
- **Fix 2, measured and deleted (D341, `recapRefresh`):** re-sending every revised item on a recap-shaped request.
  In this lab the change lands just before the recap, so the update is already the last thing the agent read; stale
  recaps 16 → 15, fresh 70 → 62 over 64 days. Not neutral-better, so removed.
- **Fix 3, promoted (D342, `revisionDiff`):** the "updated:" line names the times the agent was shown that the new
  version no longer has ("…; no longer: 09:30"). Recaps naming the old time 16 → 12, the new one 70 → 83 over 64
  paired days, both push modes the same way, intervals touching 0; graded tasks and cost unchanged. Promoted as
  neutral at no extra paid cost.
- **What was looked for and not found:** no rise of false concerns with position (control 0–7%, neutral 0–4% per
  bucket, no trend); no stale delivery by Eden in any run; packets repeating the transcript only where intended
  (revisions, and with D340 re-shows). A "what changed since yesterday" packet at the start of a day is not built:
  each day is a new session with an empty ledger, so any item a request touches is delivered in its current version
  anyway, and a digest of the rest is noise in this lab (see section 5).

## 1. Setup

`pi-ab --days 8` (CL5's long horizon): one user per seed, 8 days of 12–20 requests mixed 1:1:8 (hidden, look-alike,
nothing-to-add) from train1–6, the agent's transcript reset each morning and kept within the day, Eden kept across
days, the day's planted items moved two hours before an ungraded recap turn. Pi harness, Haiku 5.5 agent and grader,
direct market profile, time scale 1, `--tenant-prompt` (D271), cards and intent replayed (`cards-v2` + `cards-train` +
`cards-train-4344`, `intent-v2` by default). Users w41–w44 (seeds 41–44): 480 tasks per arm (46 hidden, 46
look-alike, 388 nothing-to-add) and 32 recaps. Longer days: `--days 3 --day-size 40 --mix 1:1:3`, users w41–w42, 240
tasks per arm (48 hidden), 6 recaps: a stress shape with more planted items per day, not the assumed traffic.

```bash
# packages/sim/lab/a17/run.sh LABEL PUSH CONDITIONS [pi-ab flags]: A3's run.sh with this ledger and a $2.50 cap
packages/sim/lab/a17/run.sh a17-base-pay-41 payload tools,eden --seeds 41 --days 8 --budget 0.15   # 41..44
packages/sim/lab/a17/run.sh a17-base-sig-41 signals eden --seeds 41 --days 8 --budget 0.12          # 41..44
packages/sim/lab/a17/run.sh a17-base-long-41 payload eden --seeds 41 --days 3 --day-size 40 --mix 1:1:3 --budget 0.12
python3 -I packages/sim/lab/a17/days.py --pair tools,eden .local/a17/runs/a17-base-pay-4{1,2,3,4}
```

`packages/sim/lab/a17/days.py` (new) joins each run's `tasks.jsonl` (records in stream order) with the plan's day
sizes and reports, per position bucket: hidden raised; how the planted item reached the agent (this request's
packet, an ask, or only earlier that day); concerns; asks a request; agent $/1k; input tokens; wall. `--pair A,B`
pairs task by task (same set, user, task), bootstrap 95%, and pairs recaps by day. `reshown.py` splits in-packet
hidden tasks by first showing or re-show. pi-day.ts's day summary now also says, for recaps that named an old time,
whether the item was handed that day and whether an update reached the agent (`staleHanded`, `staleUpdated`).

## 2. The baseline by position in the day

Default (D237 candidates, D205 revisions), payload notices, eden arm (tools arm for scale):

| requests | hidden raised | in packet now | earlier only | control concern | neutral concern | asks/request | agent $/1k | input tokens |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1–4 | 6/10 | 6 | 2 | 0/10 | 2/108 | 0.18 | 0.226 | 3,331 |
| 5–8 | 7/14 | 7 | 5 | 0/10 | 1/104 | 0.01 | 0.220 | 5,781 |
| 9–12 | 7/10 | 5 | 3 | 1/15 | 0/103 | 0.00 | 0.234 | 8,118 |
| 13+ | 10/12 | 7 | 4 | 0/11 | 3/73 | 0.00 | 0.256 | 10,859 |

- Hidden by way: in this request's packet 24/25 raised; handed only earlier that day 6/14; never 0/7.
- Signals: the same shape (packet now 23/26, earlier only 5/13, asks 0.20 → 0.00).
- 40-request days: packet now 14/19, earlier only **16/26**, input tokens 5.0k → 20.8k, agent $/1k 0.207 → 0.328 from
  the first ten requests to the last ten.
- eden − tools (payload, 46 hidden): hidden +60.9 points (+47.8..+76.1), agent $/1k +0.025 (+0.015..+0.035), wall
  −0.68 s (−0.78..−0.57). Per plan (pi-cost-report, connector list prices assumed, market.py), steady state: tools
  0.207 first-party / 0.561 Composio / 30.63 Zapier MCP; eden 0.251 / 0.300 / 4.44 $ per 1,000 tasks.
- Recaps (32 days a push mode): eden named a changed item's old time 9 (payload) and 7 (signals) times, its new time
  35 and 35; tools 7 and 7 (it rarely holds the item).

Where the planted item went before its own request (seed 41–42, payload): `promotion-before-calibration` was pushed
for `wedding-no-plus-ones`, `nursery-collection-list` for `editor-seats-exhausted`, `cleaning-contract-tender` for
`parking-permit-paused`. The request's own push then handed other items (2–4) and the ledger held the planted one.

## 3. Fix 1: re-show a candidate at the request it ranks for (D340, an off trial)

`pushReshow` (config.ts, partner.ts `handedBefore`, `Session.handedIn`): in the push's candidates filter, an item the
agent took in a candidates packet for an earlier request (its hand-out request, `handedIn`, is older than the latest
user message) is allowed again if it passes `readerGate`'s constraint test. Never twice within one request; an item
that reached the agent only by an ask or another path is not re-shown.

Arms, all paired task by task with the baseline's eden arm (another process, the same users and tasks):

| arm | runs | hidden (n) | hidden raised Δ | control Δ | neutral Δ | agent $/1k Δ | wall Δ s |
| --- | --- | --- | --- | --- | --- | --- | --- |
| v1: any candidate (`a17-rs-*`) | pay, sig, long | 140 | +5.7 (−0.7..+12.9) | +1.4 | +0.2 | +0.024 (+0.021..+0.027) | +0.04 |
| v2: constraint-like only (`a17-rs2-*`) | pay, sig, long | 140 | **+8.6 (+0.7..+16.4)** | −0.7 | +0.3 | +0.019 (+0.016..+0.022) | +0.04 |
| v2 + D342 (`a17-both-pay-*`) | pay | 46 | +4.3 (−6.5..+17.4) | +2.2 | −1.0 | +0.013 (+0.008..+0.018) | +0.01 |
| v2, pooled before the final rule¹ | | 186 | +7.5 (+0.0..+14.8) | +0.0 (−2.8..+2.2) | −0.1 (−0.9..+0.7) | +0.017 (+0.014..+0.020) | +0.03 |
| v2, 8-day days only¹ | pay ×2, sig | 138 | +5.8 (−2.8..+14.5) | +0.0 | −0.3 | +0.012 (+0.009..+0.015) | |

¹ The combined arm's baseline is a copy of the v2 payload baseline: these pool with each baseline task resampled as
one cluster (`days.py --alias pay2=pay`). The first version of this note bootstrapped the pairs as independent
(+7.5, +1.6..+14.0), which the review found too narrow.

v2 by set: payload +6.5 (−4.3..+17.4), $ +0.009; signals +6.5 (−8.7..+21.7), $ +0.014, Eden connector calls 6.11 →
6.42 a task; 40-request days +12.5 (+0.0..+27.1), $ +0.050 (the transcript is long and re-shows add up).

- **Mechanism.** In v2 runs the planted item reached this request's packet on 110 of 140 hidden tasks (baseline 70);
  a re-shown planted item was raised 30 of 38 times (and 10 of 11 in the confirming run), against 27 of 53 for a
  planted item left only earlier in the transcript in the baselines.
- **Position.** The gain is in requests 5 onward: +8.6 (+0.0..+17.2, n 151) pooled (clustered); the first four
  requests +2.9 (−6.1..+13.3, n 35).
- **Repeats.** Items delivered again within a day rose from 202 (all revisions) to 1,037 of 5,315 (v2, all sets); v1
  re-showed plain items too and cost a quarter more for less.
- **Per plan, steady state $/1k (payload, 4 users):** eden 0.251 → 0.258 first-party, 0.300 → 0.307 Composio, 0.373 →
  0.380 Unified.to; under signals 0.242 → 0.257 first-party and, from the extra re-reads, Composio 2.086 → 2.192,
  Zapier MCP 158.9 → 166.7.
- **Fuzz.** The engine fuzz harness (`fuzz.test.ts`) found two things once it was on: its not-twice invariant now
  allows a candidate re-handed at a later request (by design), and the first version judged "earlier" by the ledger's
  delivery turn, so a packet queued for the last request and taken with the next one's observe was handed again by
  the next push in the same take. Fixed by recording the request each item is handed out in (`handedIn`, at most 512
  a session) and by never re-showing an item still in an untaken packet. The paid runs above measured the ledger-turn
  version (v1 on the tree before 06163e30; v2 at 06163e30, the combined arm at 4f64130e); section 6 re-ran the final
  tree.

**Decision: a trial, off (D340).** It was first promoted on "+6.8 (+0.9..+12.7)". The review found that interval
too narrow: two of the pooled arms were paired with copies of the same payload baseline, so 80 of the 220 pairs
reused a baseline answer, and the bootstrap treated them as independent. Resampling each baseline task as one cluster
(`days.py --alias pay2=pay,pay3=pay`) gives **+6.8 (−0.5..+14.1)**, and the 8-day days alone +5.2 (−3.1..+13.8). The
independent v2 sample alone (n 140) is +8.6 (+0.7..+16.4), but it ran the earlier ledger-turn rule and leans on the
40-request stress days; the shipped rule alone measured +2.9 (−8.8..+14.7, n 34). D340 costs agent tokens, so D112
needs it measured better, and that is not shown. It stays as a trial switch (owner the repo owner, ends 2026-12-07):
the decider is one fresh paired run of the final rule against its own re-run baseline, both push modes, users
w41–w44 (about $0.6 at this session's prices), promoted if hidden rises with the interval above 0 and concerns do not
rise, else deleted with its code and tests.

## 4. Stale recaps (D341 deleted, D342 promoted)

With D205 on, the base recaps named an old time 29 times and the new one 118 times (70 days, all sets). The new
day-log fields say why: of 28 stale items (the v2 arm's recaps), 20 were handed that day and 18 were sent an update
after the change. The update reached the agent; it still wrote the old time.

**D341 `recapRefresh` (deleted):** on a recap-shaped request (`isRecapRequest`, a no-model pattern), re-send every
item the session was sent an update for, current version, as "updated:" packets. 8-day days, both push modes, 64
paired days (`a17-rr-*`): stale 16 → 15 (−0.02 a day, −0.16..+0.11), fresh 70 → 62, update packets 83 → 67 (the
re-send merged one day's updates into one packet), graded hidden +5.4 (−2.2..+13.0, not reachable by the switch: it
fires only on the recap), agent $/1k −0.003. In this lab the change lands just before the recap, so the re-send
repeats the packet the agent has just read; it cannot help here, and nothing shows it would elsewhere. Its code and
tests are removed (commit 4f64130e).

**D342 `revisionDiff` (promoted):** an update's title ends "(changed at its source since shown earlier; this version
replaces it; no longer: 09:30)" when the session was shown times or dates (clock times, am/pm hours, day and month,
weekdays; `timesOf`, no model) that the new version lacks. The ledger keeps every version's times per item
(`Ledger.seenTimes`, at most 16). 64 paired days (`a17-rd-*`):

| | base | revisionDiff | per day (95%) |
| --- | --- | --- | --- |
| recaps naming an old time | 16 | 12 | −0.06 (−0.17..+0.03) |
| recaps naming the new time | 70 | 83 | +0.20 (−0.03..+0.44) |
| hidden raised (graded, 92) | | | −1.1 (−8.7..+6.5) |
| agent $/1k | | | −0.001 (−0.004..+0.002) |

Payload 9 → 7 stale, 35 → 41 fresh; signals 7 → 5, 35 → 42. The confirming arm with both changes (`a17-both-pay`):
9 → 8 stale, 35 → 42 fresh. Promoted under D112 as neutral at no extra paid cost, with a consistent direction on the
recaps; part `freshness`.

After the review, `timesOf` writes each time in one form before comparing (a 24-hour "HH:MM" with am/pm folded in, a
date as "<day> <3-letter month>", ordinals dropped), so a time only reworded ("9:30" to "9:30am", "Oct 4" to "October
4th") is no longer named as gone; month names are anchored, so "decision 2" or "marketing 5" is no date. Times are
noted when the agent is handed a copy (an update superseded in the queue was never shown), and `timesOf` runs only
with the switch on. The lab's changes move "HH:MM" times, which read the same before and after, so the measured
behaviour is unchanged.

## 5. Not built, and why

- **A "what changed since you last checked" packet at the start of a day.** Each day is a new Eden session with an
  empty ledger, and the agent's transcript is new: any item a request touches is delivered in its current version,
  and items changed overnight that no request touches would be a digest the agent does not need. The lab's changes
  all land inside a day before its recap (where D205 and D342 act), so a morning packet has nothing to carry here. An
  agent with memory across days (not the Pi harness) would change this; it needs a harness that keeps memory first.
- **De-duplication against the transcript.** The engine already keeps back items the session was handed (the ledger,
  `alreadyHas`, near-duplicates, `askDedup`). The measurement found the opposite problem: holding back a fact that
  bears on this request costs facts (section 3).
- **Making the agent ask more later in the day.** Asks fall to zero after about four requests in every arm, yet hidden
  facts do not fall with position: the push carries the day. Nothing Eden can say makes the agent ask without the
  note D257 measured and deleted.
- **False concerns accumulating.** None seen: concerns per position bucket stay within 0–7% (control) and 0–4%
  (neutral), with no trend, in every arm.

## 6. Final tree

The tree as first promoted (commit 7d48c4d8: both changes in the default, the hand-out-request rule; the review then
limited the re-show to candidates' packets and turned D340 off) as plain `eden`, payload, users w41–w43 (354 tasks,
34 hidden), paired with the baseline's eden arm (`a17-final-pay-*`):

- hidden +2.9 (−8.8..+14.7), control +0.0, neutral −0.3, agent $/1k +0.018 (+0.013..+0.022), wall +0.01 s;
- a re-shown planted item raised 5 of 6; recaps naming an old time 7 → 6, the new time 25 → 31 (24 days).

Every sample of the narrowed re-show pooled with it (v2, the combined arm, this run; n 220 hidden), each baseline task
resampled as one cluster (`reshow-pooled.txt`): **+6.8 points (−0.5..+14.1)**, requests 5 onward +7.8
(−0.6..+16.5), control +0.0 (−2.4..+2.0), neutral −0.1 (−0.9..+0.6), agent $/1k +0.017 (+0.015..+0.020). On 8-day
days alone (n 172): +5.2 (−3.1..+13.8) at +$0.013 per 1,000 tasks (+5% of the eden arm's $0.251 steady state). A
re-shown planted item was raised 45 of 55 times in all.

## Checks

- `bun run check`: 2,077 pass, 0 fail (185 files), on the final tree.
- `bun run eval`, against the base 598bd6ebe, on the final tree (D342 on, D340 off): identical apart from latency
  (precision 0.591, recall 0.52, falseFireRate 0). With D340 on as first promoted it read precision 0.600, delivered
  45 against 44 (a re-shown candidate in a multi-turn scenario), the rest unchanged.
- `bun run funnel --jobs 4` (train, stub reader): identical to the base task by task apart from timings (one request a
  session: neither switch can act).
- Tests: `push-reshow.test.ts` (9), `revision-diff.test.ts` (11), `pi-day.test.ts` (the new fields), `fuzz.test.ts`
  (the not-twice invariant, and a `reshow-flaky` variant with the trial on), `default.test.ts` (49 switches on);
  a mutation of each rule fails them. The first version also kept back an item still queued in an untaken packet; no
  test could reach that guard (an observe hands out a queued packet before the push ranks), so it was deleted.

## Review

The `reviewer` subagent returned REQUEST_CHANGES on 7635df1b. Each finding and what was done:

1. **D340's pooled interval counted one baseline three times** (two arms paired with copies of the payload baseline).
   `days.py --alias` now resamples a shared baseline task as one cluster; the interval touches 0, so D340 is an off
   trial with a decider (section 3), not promoted.
2. **D342 could call a reworded, unchanged time gone** ("9:30" against "9:30am"), and read "decision 2" as a date.
   `timesOf` normalises and anchors month names; tests for both.
3. **The untaken-packet guard had no test that reached it.** Deleted (an observe hands out a queued packet before the
   push ranks); the fuzz runs the trial in a `reshow-flaky` variant.
4. **Any hand-out counted as "handed", not only candidates.** `handedIn` is set for candidates' packets only; test.
5. **Stale numbers and a doubled doc comment.** Fixed.
6. **Times noted when an update was queued, not shown.** Noted at hand-out only.
7. **`timesOf` ran with the switch off.** Gated on `revisionDiff`.

## Spend (ledger `.local/a17/ledger.jsonl`)

| ledger runs | what | calls | $ |
| --- | --- | --- | --- |
| a17-smoke | smoke (1 day of 6) | 16 | 0.0019 |
| a17-base-pay-4x | baseline, payload, tools + eden, 4 users | 2,279 | 0.2968 |
| a17-base-sig-4x | baseline, signals, eden, 4 users | 1,064 | 0.1583 |
| a17-base-long-4x | baseline, 40-request days, eden, 2 users | 508 | 0.0920 |
| a17-rs-pay-4x | pushReshow v1, payload | 1,062 | 0.1688 |
| a17-rs-sig-4x | pushReshow v1, signals | 1,059 | 0.1665 |
| a17-rs-long-4x | pushReshow v1, 40-request days | 508 | 0.1076 |
| a17-rs2-pay-4x | pushReshow v2, payload | 1,061 | 0.1660 |
| a17-rs2-sig-4x | pushReshow v2, signals | 1,063 | 0.1651 |
| a17-rs2-long-4x | pushReshow v2, 40-request days | 510 | 0.1040 |
| a17-rr-pay-4x | recapRefresh, payload | 1,068 | 0.1608 |
| a17-rr-sig-4x | recapRefresh, signals | 1,062 | 0.1556 |
| a17-rd-pay-4x | revisionDiff, payload | 1,064 | 0.1608 |
| a17-rd-sig-4x | revisionDiff, signals | 1,065 | 0.1571 |
| a17-both-pay-4x | pushReshow v2 + revisionDiff, payload | 1,069 | 0.1677 |
| a17-final-pay-4x | final tree (the default), payload, 3 users | 787 | 0.1233 |
| **total** | | 15,245 | **2.3522** |

No Sonnet regrade was run: no arm moved false or neutral concerns (sections 3, 4 and 6), and the Haiku grader's known
lean on hidden facts (slightly strict, fix-s3b: Sonnet 65 against Haiku 61 raised of 128) applies to both arms of a
pair alike.
