# F11: making the agent do less (turns and connector calls)

Status: 2026-11-12, branch `claude/f11-turns`. Decisions D1250 (finding), D1251 (ask-first levers, rejected),
D1252 (`pushLookup`, trial). Targets: agent + Eden net cheaper (3) and net faster (4) than the agent alone.

**Every number here is served by subagents (D1101), not the Haiku API.** No API credit was left, so every model call
(agent, push check, cards, grader) went through F9's queue transport to Claude Code subagents (Haiku for the agent,
check and cards, Sonnet for the grader). Costs and waits are therefore estimates **[EST]**, built as below.

## The harness

- Pi, multi-turn (`pi-ab`'s real agent loop, not `--agent-sim single`), `--tenant-prompt`, `--push payload`, the
  `direct` market source profile at time scale 1 (connector latency as the profile's lognormal medians: gmail 600 ms,
  calendar 280, drive 700, crm 450, slack 550).
- train1–6, hidden, control and neutral variants, `--limit 1`: 18 tasks a seed and arm. Seeds 41–43 (round 1, 54 tasks
  an arm) and 41–44 (rounds 2 and 3, 72 tasks an arm). Arms in one process per seed, paired task by task.
- Eden arms run `@w900000` with `pushCheckWaitMs` and `readerPushWaitMs` 900000. A subagent's push check takes 60–85 s,
  so with the shipped waits the check fails open or lands after the agent's first call (F7's warning). The report
  counts checks that end after the first model call: 0 in every run below.
- `packages/sim/lab/f11/report.py` reads each arm:
  - agent model calls, connector calls (the agent's `search_*` calls and Eden's own traced source calls), asks and
    push checks, per task;
  - agent tokens from each request's size (pi-ab now records `inChars`, `lastChars` and `outChars` per model call,
    4 characters a token), priced at Haiku 5.5 list with the prefix read from cache on 90% of calls;
  - the push check at F7's real-API price and size (D1190: $0.000210 a call, 68 output tokens);
  - cards at B19's Pi figure ($0.088 per 1,000 tasks);
  - wait = model calls by H3's fit (596 ms + 2.93 ms an output token) + the check by the same fit + the agent's
    searches (the measured union of its search spans, or an assumed 0.3/0.8/2.0 s a round) + measured `ask_context`
    time;
  - connector $ at COST-MODEL.md's per-call plan prices.
- The subagent grader flags concerns on answers that state none (18 of 18 "concerns" on the agent alone's control and
  neutral answers in round 1 were not concerns). `packages/sim/lab/f11/concerns.py` dumps every flagged answer for a
  careful Sonnet regrade; only regraded concerns are quoted.

## 1. With Eden the agent takes fewer turns and fewer connector calls (D1250)

Round 2, seeds 41–44, 72 tasks an arm (template-clustered 95% intervals):

| | agent alone (`tools`) | Eden default (`both+ask`) | Eden − alone |
| --- | ---: | ---: | --- |
| hidden facts raised | 1/24 | 20/24 | +79 pts (+46..+100) |
| concerns, control and neutral (Sonnet-regraded) | 0/48 | 4/48 | all four the change-freeze look-alike, one a seed |
| agent model calls a task | 2.08 | 1.49 | −0.60 (−0.93..−0.31) |
| connector calls a task | 1.92 | 0.76 | −1.15 (−1.79..−0.56) |
| agent $ per 1,000 tasks [EST] | 0.144 | 0.130 | −0.014 (−0.030..+0.003) |
| all-in $ per 1,000, first-party connectors [EST] | 0.144 | 0.428 | +0.284 (+0.268..+0.301) |
| all-in $ per 1,000, Composio ($0.30/1k calls) [EST] | 0.719 | 0.657 | −0.062 (−0.266..+0.129) |
| all-in $ per 1,000, Unified.to ($0.75) [EST] | 1.58 | 1.00 | |
| all-in $ per 1,000, first-party, agent prompt +30k tokens [EST] | 1.49 | 1.39 | |
| wait a task, measured searches [EST] | 3.00 s | 2.47 s | −0.53 s (−1.06..−0.06) |
| wait, 0.3 s a connector call [EST] | 2.07 s | 2.29 s | +0.22 s (−0.08..+0.52) |
| wait, 2.0 s a connector call [EST] | 3.91 s | 3.03 s | −0.89 s (−1.73..−0.12) |

What the four targets read today, on this harness:

- **Cheaper (3):** not on first-party connectors with the lab's short Pi prompt: Eden's own bill (the check $0.21 and
  cards $0.09 per 1,000 tasks) is twenty times what the agent saves in tokens ($0.014). Level on Composio's per-call
  price, cheaper on every dearer plan. Each model call Eden saves is worth more the longer the agent's prompt: with
  about 22,000 more cached tokens a call (a production agent's system prompt, tools and history) Eden is cheaper on
  first-party connectors too (linear between +$0.16 at +10,000 and −$0.10 at +30,000).
- **Faster (4):** yes at the `direct` profile's measured latency (−0.53 s) and at 2 s a connector call; level at
  0.8 s; slower at 0.3 s. The check's ~0.8 s on the request path is what Eden has to win back, and the turns and
  connector rounds it saves do so whenever connector calls cost more than about half a second.
- **Caveat:** the subagent agent answers from a packet more readily than the API's Haiku did: B19 measured Pi with
  Eden +0.39 s against raw. Read the sizes as the subagents', the direction as the finding.

**Why the agent still searches.** After a packet it answers directly: 37 of 40 packet tasks in round 2 made no
connector call. On the turns Eden stays silent (the check named nothing: 32 of 72 tasks) it searched on 28. So the
remaining calls are the silent turns', not distrust of packets: the packet already carries what the agent would
fetch, and the lever is what a silent turn gets.

## 2. `ask_context` as the agent's first search: rejected (D1251)

Three levers to route the agent's lookups through Eden's local index (milliseconds) instead of its connectors:

- `ASK_CONTEXT_DESCRIPTION_FIRST`: the tool described as a search of every source at once, to call before any
  per-source tool;
- `askCoverage`: an ask answer whose sources all answered ends "Eden: searched mail, calendar, …; every one answered,
  and these are its matches";
- `ASK_FIRST_GUIDE`: one line for the tenant's system prompt.

| round | arm against `both+ask` | asks a task | connector calls a task | model calls a task |
| --- | --- | --- | --- | --- |
| 1 (54 tasks) | description | 0.000 → 0.019 | −0.056 (−0.167..+0.000) | −0.019 |
| 1 | description + coverage | 0.000 → 0.019 | −0.056 | −0.019 |
| 2 (72 tasks) | all three | 0.056 → 0.208 | +0.000 (−0.50..+0.50) | +0.042 |

The pre-registered rule needed −0.3 connector calls a task. With all three the agent asked more but called
`ask_context` beside its connector searches in the same turn (13 of 32 silent tasks), never instead of them, so it
saved nothing and paid for the ask's tokens. Hidden facts and concerns were unchanged. Deleted (code in 0170bc89).
A checked packet's lead saying it was searched and checked (`pushCheckCoverage`) was dropped before any run: F7's
`pushSearchedLead` is the same lever.

## 3. `pushLookup`: a silent turn gets the records the agent would look up (D1252, trial)

With the switch at k, a push the check answered and named nothing for hands up to k items of its own pool (no bulk
mail, pool order) that name one of the request's anchors (a person or thing it names, or its day), under a fixed
lead: for reference; a check found none that changes what the request should do; use them for the details the
request needs. No new connector or model call. D300 (answer-ahead, rejected 2026-11-07) handed similar records
beside every candidates packet, before the check made silence common, and moved no mix figure; this fires only on
the silent turns where the agent now searches.

**Round 3** (k 3, pre-registered in 6defe771; 72 tasks an arm, against `both+ask`): connector calls −0.222 a task
(−0.500..+0.000), model calls −0.139 (−0.278..+0.000), agent $ −0.009 per 1,000 tasks [EST], wait at measured search
time −0.19 s (−0.42..+0.01) [EST], hidden raised 20/24 in both, packets on 76% of tasks against 56%. Short of the
rule's −0.3 connector calls. Where it fired on a silent turn (15 of 32) the agent searched on 1; the 17 silent turns
it did not reach (no record in the pool named the request's anchors, e.g. "Send Ilse Marchetti at Corvalis a revised
quote") all searched.

**Round 4** (pre-registered in 2c93b9e9): `pushLookupAny` hands the pool's head when nothing is named. Against B,
72 tasks an arm: connector calls −0.597 a task (−1.097..−0.111), model calls −0.306 (−0.569..−0.069), hidden 20/24
both, [EST] wait −0.48 s (−0.90..−0.11), agent $ −0.018 per 1,000; packets on every task (B 60%). Every control and
neutral answer, Sonnet: concerns by B19's standard B 4, LK2 5; naming a planted specific 4 and 5; hedges ("check it
is approved", "no record found", naming none of the specifics) 17 and 21 (neutral 9 and 14).

**Review.** The reviewer found two defects behind these numbers, fixed before any deciding run. The gate needed the
check to have been called this pass, so a late or reused answer (the shipped waits) never gave the lookup. The
pool-head branch reused a lead claiming its items name the request. **Round 5** (LK3: LK2 with the fixed code and
`pushLookupQuiet`, a lead that calls the records background, not a reason to warn) decides on seeds 41–44 and 45–48,
with a days run.

**Round 5, LK3 (fixed code, quiet lead), seeds 41–44:** connector calls −0.556 (−1.028..−0.083), model calls −0.375,
hidden 20 → 21/24, asks 0.069 → 0.056, [EST] wait −0.50 s, hedges 20 → 17, but concerns naming a planted specific
3 → 7: the ISA look-alike, which the check had read and rejected, handed as reference on all four control seeds and
surfaced by the agent. Rejected; the lookup now hands only plain (not constraint-like) records.

**LK4 (plain records):**

| run | connector calls | model calls | hidden | asks | specific concerns | hedges | [EST] wait | agent $/1k |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| seeds 45–48, 72 an arm | −0.667 (−1.194..−0.153) | −0.389 | 6 → 8/24 | equal | 1 → 1 | 13 → 13 | −0.60 s | −0.021 |
| seeds 41–44, 72 an arm | −0.319 (−0.667..+0.069) | −0.208 | 19 → 19 | +0.014 | 4 → 5 | 8 → 12 | −0.29 s | −0.012 |
| days, seeds 41–42, 24 an arm | −0.083 | −0.042 | 2 → 2 | 0 | — | — | −0.08 s | +0.015 (+0.005..+0.024) |

The hedge bar (+1) sits far below the classifier's noise: the same default arm read 20 hedges in round 5 and 8 in
round 6 (28 of its 48 answers differed between the runs, and on the 20 identical ones the verdict agreed 16 times).
Within a day the records saved almost no search but stayed in the transcript, so **LK5** hands them only on a
session's first request (one-request sessions are unchanged: its rerun on seeds 41–44 read connector calls −0.25,
model calls −0.22, hidden 20 → 20). LK5's days run was stopped by the subagent API's weekly limit (every Haiku and
Sonnet worker failed at about 11:00 UTC), so it is unmeasured.

**Where it stands:** not passed as registered (hedges on seeds 41–44, connector calls −0.25 on LK5's rerun there, and
LK5's days bar unmeasured). It stays a trial switch, off in the default, offered to F12's candidate profile as
`{"pushLookup":3,"pushLookupAny":true,"pushLookupQuiet":true}`. All of these runs predate #315 (the harnesses now
place the packet a tool result's observe hands out; before it both arms dropped it).

## Reproduce

```bash
export EDEN_LAB_QUEUE=$PWD/.local/f11/q
M="--source-profile packages/sim/lab/before-after/market-profiles/direct.json --push payload"
for s in 41 42 43 44; do env -u OPENROUTER_API_KEY EDEN_LAB_QUEUE_RUN=r3-$s bun packages/sim/src/lab/pi-ab.ts \
  --conditions tools,both+ask@w900000,both~LK+ask@w900000 --variant-config '{"LK":{"pushLookup":3}}' \
  --config '{"pushCheckWaitMs":900000,"readerPushWaitMs":900000}' --model claude-haiku-5-5 \
  --grader claude-sonnet-5-5 --card-model claude-haiku-5-5 --reader-model claude-haiku-5-5 --time-scale 1 \
  --suite train --seeds $s --variants hidden,control,neutral --limit 1 --budget 1 --tenant-prompt $M \
  --out .local/f11/r3-$s.json --timeline .local/f11/r3-$s.tl & done
# answer the queue with subagents (packages/sim/lab/subagent/README.md; Haiku workers with --skip-role grader,
# a Sonnet worker with --role grader), then:
python3 -I packages/sim/lab/f11/report.py --queue $EDEN_LAB_QUEUE --base both+ask@w900000 \
  --stem .local/f11/r3-41 --stem .local/f11/r3-42 --stem .local/f11/r3-43 --stem .local/f11/r3-44
python3 -I packages/sim/lab/f11/concerns.py dump .local/f11/concerns-r3.json .local/f11/r3-4{1,2,3,4}
```
