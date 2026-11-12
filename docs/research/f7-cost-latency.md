# F7: the push check's cost and wait, leaner

Status: 2026-11-12, branch `claude/f7-cost-latency` (from main 006b505c), session F7. Train, reworded and longtail
only; heldout19 is never read or run, heldout20 never looked for. Paid calls go to Anthropic directly with
`HAIKU_API_KEY` through the lab transport and its spend ledger (`.local/f7/ledger.jsonl`, D97): **Anthropic-direct
lab figures**. Cap $40. No Modal. Numbers marked **[EST]** are arithmetic or judgement; every other number comes from
a command in this note.

**Outcome:** the account's API credit ran out after the first $0.23. The levers are priced from the tokens recorded
before that (§3, §5, D1190). The two trial switches built here, `pushCheckLeanStop` and `pushCheckLeanLead`, could
not be measured (§7) and are deleted (D1191; code and tests in commit 49ce5972). The screen of §6 was stopped before
its first batch was answered; nothing of it is read.

## 1. Pre-registration: the screen (committed before its paid calls)

Base: the shipped default's live check on train and reworded seed 43 with neutral tasks
(`bun run funnel --suite train|reworded --seeds 43 --jobs 1 -- --neutral --check live --check-dump …`; 1,092 recorded
checks, $0.229). `packages/sim/lab/f7/screen.ts` (H3's split screen with a lean prefix) re-asks every recorded pool
live under each arm, interleaved row by row in the same lanes:

- **W**: the shipped check.
- **Y**: `pushCheckLeanStop`: the same pool and instructions, one clause asking for every yes first, and the reply
  stopped at its first `"act":false`.
- **YD**: Y on the pool less same-source, same-title copies (H3's D, 15 items at most).

**Rule.** An arm goes to the Pi pair if, against W in the same run: planted named on hidden rows at least W − 6,
the look-alike named on control rows at most W + 6, neutral rows with any yes at most W + 6 (the bars are H3's ±4 on
189 rows of a kind, scaled to about 360), and its output tokens a check at most 0.75 of W's. Of the arms that pass,
Y goes if it passes (one change); YD only if Y fails. None passes: the switch and its code are deleted, findings kept.

## 2. Pre-registration: the Pi run (committed before its paid calls)

Two trial switches, each its own arm, against the shipped integrator shape `both+ask` in the same pi-ab processes
(`packages/sim/lab/f7/pi.sh`; H3's recipe: Haiku 5.5 agent, grader, card, reader and check models, shipped card
coverage replayed, `--tenant-prompt`, payload notices, the `direct` profile, time scale 1):

- **Y** = `both+ask+pushCheckLeanStop`, only if it passes §1's screen (else the run has two arms, base and L);
- **L** = `both+ask+pushCheckLeanLead`: a packet the check picked is framed as picked ("a quick read of this request
  picked as likely to change what to do") rather than "nothing has checked them". The funnel cannot see wording, so
  it has no screen.

**Runs**, two processes at a time, in this order:
1. Stage 1: `--suite train` and `--suite reworded`, seeds 41, 42, 43, 44 (`--seeds N`), `--variants
   hidden,control,neutral` (8 runs).
2. Stage 2: seeds 45, 46, 47, 48, `--variants hidden`: `train` with an empty cards file (`--cards
   .local/f7/empty.cards.jsonl`, its cards recorded live and shared by the arms), then `reworded` replaying that run's
   cards (`--cards .local/f7/pi/f7-train-N/out.cards.jsonl`) (8 runs).

**Grading:** `i3-regrade.ts` (Sonnet 5.5) on every hidden answer and every concern the Haiku grader flagged, every arm.

**Rule, per switch against base:** promote (D814) if all three hold, else delete with its code and tests.
1. **Cheaper or faster:** total $ per 1,000 tasks (agent and Eden) on the 1:1:8 mix (`n5/mix.py --cluster template`,
   stage 1) has its 95% upper bound below 0, **or** the wall p50 on the 1:1:8 mix (`f7/wall.py`, stage 1) has its
   upper bound below 0.
2. **Facts held:** hidden raised by Sonnet, the switch minus base (`p3/report.py --pair X:both+ask --cluster
   template` over all 16 runs), has its 95% lower bound above −1.5 points.
3. **No new false concerns:** Sonnet-confirmed concerns on control and neutral (stage 1) are not up (switch ≤ base).

Reported beside, outside the rule: Eden's and the agent's $ per 1,000 tasks, mean wall, agent turns and tool calls,
asks, the check's output tokens and p50/p90 (`h3/checks.py`). If both switches pass, both are promoted (each measured
alone against the base; their combination is not measured here and is said so). Hermes is not run (installing the
Hermes checkout's dependencies was refused in this container); any wall claim is Pi's. If the session's cap or the
day would cut stage 2, the rule is read on the whole seeds (both suites) finished, the rest unrun; no seed is added
after a result is read.

## 3. Where the cost and the wait are, and the levers weighed at $0

**The check's bill, measured on the base funnels** (`python3 -I packages/sim/lab/p2/calls.py .local/f7/ledger.jsonl`,
1,092 calls, train and reworded seed 43 with neutral, two processes at once):

| run | calls | $ a call | input / cached / output tokens | p50 / p90 s | time to first token p50 |
| --- | ---: | ---: | --- | --- | ---: |
| train 43 | 563 | 0.000201 | 2,361 / 1,002 / 110 | 1.11 / 1.83 | 0.52 |
| reworded 43 | 529 | 0.000219 | 2,615 / 1,136 / 120 | 1.08 / 1.64 | 0.52 |

At Haiku 5.5's $0.10 / $0.01 (cache read) / $0.50 per million, a call of 2,500 input tokens with 1,185 read from the
cache and 115 out is about $0.000131 of uncached input (the pool and the request: **about 65%**), $0.000012 of cache
reads and $0.000058 of output (**about 29%**) **[EST: arithmetic on the table]**.

**Prompt caching is already on and mostly hits.** The fixed instructions (1,185 tokens) are the only stable prefix.
983 of the 1,092 calls read them from the cache (90%), and no call reported a cache write (the prefix was warm from
earlier calls on the account). A miss pays about $0.00011 more [EST], so the 10% that miss cost about 5% of the
check's bill: nothing large to win. The pool is the request's own (its items, ranked for that request), so it has no
prefix to cache across requests; one request a session never reads the same pool twice.

**Levers weighed and not built (reasoned at $0):**

- **Overlap the check with the agent's first model call.** D156 bounded it at 1.05–1.14x of task wall and D248
  measured it: wall −0.14 s (−0.52..+0.28) for +$0.058/1k, because half the first calls had to be re-sent when the
  packet landed, and re-sending only on an answer made the agent ask first. The push check makes it worse, not
  better, for this lever: the check names nothing on most requests (silence), but on the requests where it names an
  item the packet is what keeps the agent from searching (D98, D191), so a first call sent without it is the one
  re-sent. Nothing measured since changes D248's arithmetic; not reopened.
- **Skip the check when nothing in its pool could be handed** (every item already handed this session): the
  candidates then send nothing anyway, so the skip would change no packet. One request a session never meets it, and
  over a day the check reads 15 items of which a packet hands at most 5, so a pool with no fresh item is rare
  [EST]. Not built.
- **Skip the check when the turn gate is sure.** The gate decides whether a push starts, not whether its pool holds a
  fact; H19 found the facts lost before the agent are lost in retrieval (31%) and in the check (9%), and a skip would
  hand the unchecked candidates (the before arm's neutral packets: +17.5 points of neutral packets, B19) or stay
  silent (a fact lost wherever the check would have said yes). Neither is cheaper overall: the agent's bill is about
  twice Eden's.
- **Shorter compare-first entries or an ids-only reply.** D822 measured a shorter reply letting look-alikes in, and
  H3 found a line reply longer. Not reopened; the lean stop (Y) keeps every written entry's compare step whole.
- **A cheaper model or route.** The check is already on the cheapest Claude model the lab uses (Haiku 5.5); the
  shipped OpenRouter route sends no cache breakpoint (D145), about +$0.0001 a call [EST], which is a route decision
  outside this lab (Anthropic only).
- **Concurrent split calls, a line reply, a smaller pool.** Measured by H3 (D1072–D1074): no faster, or facts not
  held.

**Amendment before any paid call of §1 or §2 (08:35 UTC):** main now has the dev20 tuning suites (D1100). If the
cap allows after stage 2, a stage 3 runs `--suite dev20` seed 41, `--variants hidden,control` (cards recorded live
into an empty file), and its Sonnet-graded hidden raised and confirmed concerns are **reported beside the rule, not
part of it**. The lean wording is now applied as a transform of the check's instructions (`leanSystem`), so a sibling
switch that rewords the format's act sentence (F2's `pushCheckDone`) composes with it; when F5's rule sheet adds a
second list to the reply, the stop is not sent.

## 4. Re-pre-registration: no API credit, subagent-simulated runs (08:40 UTC, before any such run)

The owner confirmed there will be no Anthropic API credit. Model calls go through F9's queue lab transport, answered
by Haiku subagents, which measure neither real latency nor cache billing. So from here every model result is
labelled **subagent-simulated**, and every $ and wall figure built from it is **[EST]**:

- **Cost [EST]:** each call's input, cache-eligible input (the fixed instructions, 1,185 tokens on the check; 90% read
  from the cache on the real API, §3) and output tokens, priced at Haiku 5.5's published rates (input $0.10, cache
  read $0.01, cache write $0.125, output $0.50 per million), times calls a task, on the 1:1:8 mix.
- **Check wait [EST]:** H3's fit, 596 ms + 2.93 ms an output token (time to first token about 450 ms whatever the
  reply), per call; the wall claim is the check's modelled wait on the request path, not a measured wall.

**Rule, replacing §1's output-token clause and §2's clause 1** (the facts and concerns clauses stand as written):
- Screen: Y (else YD) goes on if its output tokens a check are at most 0.75 of W's in the same subagent-simulated
  run, with §1's planted, look-alike and neutral bars.
- Pi (or whatever harness the queue transport serves): clause 1 is met if the check's modelled wait a task on the
  1:1:8 mix, or total $ [EST] a task, is lower with a template-clustered 95% upper bound below 0. Clauses 2 and 3 as
  in §2, graded as the transport allows (said beside the result).
- `pushCheckLeanLead` is judged on the agent's tokens and turns [EST] by the same clause 1, as it moves no check call.

**$0 estimate already in hand** (`packages/sim/lab/f7/simstop.py` on the 943 readable recorded replies of §3): a stop
at the first no on the *shipped* order keeps 72% of the reply's characters (hidden 83%, control 63%, neutral 68%) and
loses 6 of 283 planted facts the check named, and 6 of 84 look-alikes. At about 115 output tokens a call that is
about −32 tokens: −94 ms of modelled wait and −$0.000016 a call (−8% of the check) **[EST]**. The lean order is
meant to keep those 6 facts; only a model answering the lean prompt can say whether it does.

## 5. The levers in numbers (08:55 UTC; $0 from recorded tokens, and a subagent-simulated pilot)

Every figure here is **[EST]**: tokens the lab recorded on the real API this morning (§3's 1,092 checks, train and
reworded seed 43 with neutral), priced at Haiku 5.5's list prices, and the check's wait from H3's fit (596 ms + 2.93
ms an output token). `python3 -I packages/sim/lab/f7/levers.py .local/f7/ledger.jsonl .local/f7/base-*-43.dump.jsonl`.

**The base:** a check is 2,484 input tokens (1,067 of them cached on average; 90% of calls hit the cache), 115
output tokens, $0.000210 and 934 ms of modelled wait. At 0.97 calls a hidden or control task and 0.92 a neutral one,
it is **$0.196 per 1,000 tasks** on the 1:1:8 mix and **870 ms of wait a task** on the request path. (B19's ledger
read $0.16: B19 was heldout19, this is train; same order.)

| lever | $ per 1,000 tasks | wait a task | facts at risk | status |
| --- | --- | --- | --- | --- |
| `pushCheckLeanStop` (stop at the first no; output kept 69% on the mix: hidden 83%, control 63%, neutral 68%) | −0.017 (−9% of the check) | −98 ms (−105 ms a call) | on the shipped order 6 of 283 planted facts the check named come after its first no; the lean order is meant to keep them | built, trial |
| every call hitting the prompt cache (10% miss today) | −0.010 (−5%) | 0 (latency is not input-bound, D241) | none | not controllable from Eden: the misses are the provider's |
| skipping the check, ceiling: an oracle that skips exactly the calls that end silent (43% of calls) | −0.083 (−43%) | −277 ms | any real predictor errs: M7's ten pre-screens (D930) could not match Haiku's own repeat agreement (D931: 90.9% on speak or silent) | not reachable; the turn gate reads the request, not the pool |
| smaller packets (agent side) | about −0.01 to −0.02 for the packets' whole cost (≈0.6 items a task on the mix, ≈100 tokens an item written to the agent's cache once and read after) | ≈0 | D258, D273: every lexical cut measured lost facts | not built |

**What the pilot says** (`packages/sim/lab/f7/mkpilot.ts`, `pilot-score.ts`; **subagent-simulated**: 25 recorded
prompts, 9 hidden where Haiku had named the planted fact, 8 control, 8 neutral with a non-empty reply; each asked once
as shipped and once lean, by separate Haiku subagents, 23 pairs complete): planted named 9/9 in both, look-alike 0/7
in both, neutral with a yes 1/7 (W) and 2/7 (Y); output tokens a call 42.4 (W) and 41.6 (Y). The subagents wrote far
shorter replies than the API's Haiku on the same prompts (68 tokens a call recorded), listing few rejections, so the
stop had little to cut: **the pilot cannot measure the lean stop's saving**, which lives in the rejections the API's
Haiku writes, and it is too small to see a 2% loss of named facts. It does say the lean wording did not make the
model drop a planted fact or name a look-alike on these 16 rows. Two subagents also tried a tool the brief did not
give them (a session create, refused); their replies were written before it and are used.

**Reading.** The check's own bill has little left in it: the largest lever that keeps every reply (the stop) is
about 9% of the check, under 5% of Eden plus agent. The wait is the larger prize, and the stop is worth about 0.1 s a
task. Only a model answering the lean prompt over a powered pool can say whether it keeps the 6 facts in 283 the
shipped order would lose; that needs the API or F9's transport at volume, not 25 prompts.

## 6. Pre-registration: the screen served by subagents (D1101), before its first call

The screen of §1 runs through F9's queue transport (D1101) on every sixth readable recorded pool (158 rows:
`.local/f7/sample6.dump.jsonl`), arms W and Y only. **Served by subagents (D1101)**; tokens and wait are [EST].
Rule (§4's, with §1's bars scaled to the rows): Y passes if its output tokens a check (as the transport counts them)
are at most 0.75 of W's, planted named on hidden rows at least W − 2, the look-alike named on control rows at most
W + 2, and neutral rows with a yes at most W + 2. The queue's validator (`batch.ts`) is fixed first to accept an
answer whose stop sequence cuts its JSON mid-object, as the lean stop and the reader's stop do (the whole answer must
parse, or the part before the stop).

## 7. Decision: both trials deleted unmeasured (D1191)

No API credit, and the subagent stand-ins (D1101) write check replies about 40% shorter than the API's Haiku on the
same prompts (§5's pilot: 42 against 68 output tokens a call), listing few of the rejections the stop would cut, and
they judge differently (F2's finding). So neither the stop's saving nor its cost in facts (the 6 of 283 named planted
facts that follow the first no on the shipped order) can be read through them, and the checked lead needs a live
agent's searches and turns. Per D814 both switches are deleted the same day; the code and its tests are in commit
49ce5972 for a re-test on the API (§1 and §2's rules stand as written for it). Kept: the findings (§3, §5, D1190),
`packages/sim/lab/f7/levers.py`, `simstop.py`, `price.py`, `wall.py`, and the queue validator's fix for a stop that
cuts JSON mid-object (`packages/sim/lab/subagent/batch.ts`), which the reader's stop needs too.

## 8. The final comparison's cost and latency: the table to fill (prepared 09:20 UTC)

Final main against 006b505c, both served by subagents (D1101), so every figure is **[EST]**: tokens estimated from
the queue's request and answer sizes, priced at list, the path's wait from H3's fit.

**How to run it.** Give each arm's command its own label and share one queue (the arms' identical prompts then replay):
`EDEN_LAB_QUEUE=$Q EDEN_LAB_QUEUE_RUN=final …` and `EDEN_LAB_QUEUE_RUN=before …`, then
`python3 -I packages/sim/lab/f7/price-queue.py $Q --arm final=final:TASKS --arm before=before:TASKS`. Since this branch
`batch.ts put` keeps each answer's request and answer sizes (`size` in `done/<key>.json`) and the transport labels each
call with `EDEN_LAB_QUEUE_RUN` (calls answered earlier carry no size and are reported as unpriced). Check on a ledger
of real calls: the pricer's arithmetic on a push check of 4,740 + 5,300 characters in and 460 out gives $0.000216 a
call against the API's measured $0.000210 (F7 §3).

| role | before (006b505c): calls a task, $/1k, wait | final: calls a task, $/1k, wait | final − before |
| --- | --- | --- | --- |
| push check (`eden.check`) | | | |
| cards (`eden.cards`, per task while working) | | | |
| intent requests (in the card call since D1062; any re-ask `requestsOnly`) | | | |
| reader (`eden.reader`; none on the default's push, D237) | | | |
| agent (`agent`; `--agent-sim single` is one call a task: compare arms, never against the real loop) | | | |
| **all roles** | | | |

**Background cards a heavy user-month [EST]** (outside the per-task table; a new user's backfill plus the daily
trickle): backfill calls × $ a card call + 30 × daily calls × $ a card call. Today's figures: F5's world-clock count of
16–17 calls a heavy new user (twice what COST-MODEL's D244 column used), the card call at about $0.0011 (CL3's measured
$0.0088 for 8 calls), and CL3's daily trickle of about $0.0005–0.0006 (about 10 new items a day sent to the card model):
about $0.018 + 30 × $0.00055 = **about $0.035 a heavy user-month** before the widened carding; replace the call count
and the $ a call with the final arm's `eden.cards` line from `price-queue.py` and F8's re-recorded count.

## 9. Design: the push check beside the agent's first model call (design only; not measurable without the API)

**What D248 measured, and why it failed.** CL4 (cl-cl4.md, D248) sent the agent's first model request at once and
re-sent it when a packet with items landed. Two shapes:
- *Re-send when a packet lands:* Eden's path fell by about 1 s, but the task's wall only by −0.14 s (−0.52..+0.28),
  for +$0.058 per 1,000 tasks: half the first calls were re-sent, and a re-send started after the first call's
  answer was already being written, so its time was spent twice.
- *Late injection only (a packet the second call sees):* the agent, with no packet before its first call, searched
  and asked first (hidden asks 0.50 → 1.61 a task): +$0.118 per 1,000 tasks and +1.14 s of hidden wall. The packet
  before the first call is what keeps the agent from asking (D98, D191).

**Does an integration allow a late injection?** Yes, and that is the trap. Pi's harness takes Eden's queued packets
before *every* model request (`transformContext` → `takePending`, pi-ab.ts), and the proxy injects on every request
it forwards (packages/proxy/src/proxy.ts), so a packet that lands during the first call is in the second call's
context, when there is a second call. But the first call, made without the packet, is the one that decides to search
or ask, and Eden's packet cut the agent's tool calls from 2.76 to 1.55 a task (H19). A design that lets the first
call run unpacketed and only injects later gives that back. Late injection alone is D248's second shape: not
reopened.

**The one shape left: speculate, and abort on a yes.** At the proxy (or a harness hook with a stream it can cancel):
1. A user turn starts the push check as today, and the agent's first model request goes upstream at once, without
   waiting.
2. The response is streamed upstream but **held** at the proxy: nothing reaches the agent yet.
3. When the check answers:
   - silent (or no call: no constraint-like pool): release the held stream; the agent saw exactly what the default
     gives it (no packet), sooner by the check's wait;
   - a yes: abort the upstream call and send the request again with the packet, exactly as today. The agent sees
     only the second response, so its behaviour is the default's, and its wait is today's plus nothing (the re-send
     starts when the check lands, as the first request does now).
   - the check is late (past `pushCheckWaitMs`): today's fail-open, the held stream released.
4. A first call that finishes before the check lands is held whole until the check answers.

Unlike D248's first shape, nothing the agent sees changes: no answer is ever shown and then re-written, and a yes
costs no wall time. The price is the aborted calls.

**Priced from the recorded tokens [EST]:**
- The check ends silent on 43% of its calls on the 1:1:8 mix (§5) and makes 0.93 calls a task, so about 0.40 tasks
  in each are sped up, each by its check's wait.
- A silent reply is short, so it is about 650–750 ms (H3's fit at 20–60 output tokens). The saving is about **−0.28
  s a task on the mix**, the same as §5's oracle-skip ceiling, because the same calls are skipped from the wait.
- Aborts: 57% of calls end with a yes, so about 0.53 first agent calls a task are sent twice.
- An aborted Pi first call is billed its input: about 2,600 tokens with the house rules cached (`--tenant-prompt`),
  about 2,000 read from cache, about 600 uncached, and a cache write of the turn. Its output stops at the abort,
  within about 0.5–0.9 s of the start.
- That is about $0.00008–0.00012 a call [EST], so about **+$0.04–0.06 per 1,000 tasks**: about +9–12% of Pi's total
  (B19: $0.26 agent + $0.25 Eden). On Hermes, whose prompt is about 3× Pi's, it is about +$0.10–0.15.
- The wait on the request path drops from about 0.87 s a task to about 0.59 s: no lower bound, since the yes tasks
  still wait for the check.

**Verdict.** It buys about a third of the check's wait for about a tenth more spend, so it fails the brief's
"cost and latency both lower". It is worth building only if the owner prices wall above about $0.15–0.20 per 1,000
tasks per second [EST: 0.05 / 0.28]. It is measurable only on a real API, where the aborted call's billing and the
held stream's wall are real; served by subagents (D1101) neither exists, so it is not built here. If built:
- a proxy option, off;
- a pre-registered Pi pair at time scale 1 against the default, read on wall p50 (upper bound below 0), total $ (the
  aborts' cost, reported), hidden raised (lower bound above −1.5), and the share of first calls aborted;
- Hermes too, since its prompt is the one that makes the aborts dear.

## 10. Target 3+4: Eden net cheaper and faster than the agent alone (new mandate, 09:30 UTC)

The integrator's mandate: the agent with Eden must cost less and finish sooner than the agent alone. Today Eden adds
about $0.24 per 1,000 tasks on Hermes, and wall time of about +0.1 s on Hermes and +0.4 s on Pi, mostly the push check
on the request path. Everything is re-opened under this priority, D248 included.

**Baseline run, pre-registered before its first call (report only, no rule).** Multi-turn Pi (the real loop, not
`--agent-sim single`), **served by subagents (D1101)**:
- Two processes sharing one queue (`.local/q-f7b`), labelled `EDEN_LAB_QUEUE_RUN=raw` and `final`: `--conditions
  tools` and `--conditions both+ask`.
- `--suite train --seeds 41 --variants hidden,control,neutral --limit 2` (36 tasks an arm).
- Haiku 5.5 in every role, `--tenant-prompt`, `--push payload`, the `direct` profile, time scale 1, cards replayed.
- `--config '{"pushCheckWaitMs":900000}'`, so the push waits for its subagent-served check as it would for the API's
  (about 1 s). No other setting differs from the default.

Reported per arm: agent model calls and tool calls a task; tokens a call by role; $ per 1,000 tasks and per task
(`price-queue.py`) [EST]; and a modelled wall a task: H3's fit summed over the task's agent calls and the push check,
plus the connector time the timeline measures [EST]. Measured walls are the subagents' and are not read.

(The final arm runs as `both+ask@w900000`: the harness's 3,000 ms observe wait is lifted with the check's, so the
packet waits for its subagent-served check as it would for the API's.)

**Lever (a), pre-registered before its first call: `pushSearchedLead`.** A packet the push check picked says what
Eden did: "Eden searched the user's mail, calendar, documents, CRM and chat for this request, and a quick read picked
these items as likely to change what to do", followed by the shipped instruction to check each item. Today's lead
says "nothing has checked them against it", which invites the agent to search again before it acts. Its own arm
runs on the same 36 tasks and queue (`EDEN_LAB_QUEUE_RUN=searched`, `both+ask+pushSearchedLead@w900000`, the same
config). **Rule (served by subagents, D1101; a screen on a small sample, said so):** keep it, and recommend
promotion, if against the final arm: agent tool calls a task are at least 0.2 lower, agent model calls a task are not
higher, hidden facts raised (the run's grader) fall by at most 1 of 12, and concerns on control and neutral are not
up. Otherwise delete it the same day.

**Amendment (10:05 UTC), after the first Eden arms finished, a harness defect.** In `final`, 21 of 36 push checks landed
after the agent's first model request had started; in `searched`, 6 of 36. The observe's own cap
(`readerPushWaitMs`, 60 s) is below a subagent's answer time, so the push went late: on those tasks the first call
ran without the packet, D248's late-injection shape and not the default. Both Eden arms are void, and are re-run as
`final2` and `searched2` with `readerPushWaitMs` lifted beside `pushCheckWaitMs` (both 900,000 ms; a lab setting that
only removes the queue's wait, as the API's ~1 s check never meets either cap). Their checks mostly replay from the
queue. The raw arm is unaffected and stands. The void arms' facts were seen before this amendment (final 8/12,
searched 10/12 hidden raised). The re-run is decided by the defect (the late-check counts above), not by those
readings, and the §10 rule is read on `final2` against `searched2` only.

### 10a. The baseline, read (served by subagents, D1101; [EST] cost and wall)

36 tasks an arm. No re-run has a check landing after the first model call (`mt.py`). Tools: `price-queue.py` (tokens
from the queue's sizes) and `mt.py`. Sums are per task on the 1:1:8 mix; the modelled wall is the timeline's path
with every model call and check swapped for H3's fit.

| | raw (`tools`) | final2 (`both+ask`, the default) | searched2 (`+pushSearchedLead`) |
| --- | ---: | ---: | ---: |
| agent model calls a task (hidden / control / neutral) | 2.00 (2.00 / 2.00 / 2.00) | 1.69 (1.25 / 1.67 / 1.75) | 1.71 |
| agent tool calls a task (mean of the three kinds) | 1.33 | 0.69 | 0.72 |
| agent tokens a call: input (cacheable), output | 949 (898), 59 | 1,216 (1,077), 98 | 1,241 (1,089), 98 |
| agent $ per 1,000 tasks [EST] | 0.108 | 0.146 | 0.150 |
| push check $ per 1,000 tasks [EST] | 0 | 0.142 | 0.142 |
| **agent + check $ per 1,000 tasks [EST]** | **0.108** | **0.288** | 0.292 |
| cards (here 1.7 live calls a task: an 18-world backfill spread over 36 tasks; background, priced per user-month in §8) | 0 | 0.210 | 0.208 |
| modelled wall a task [EST]: all / model / tools / Eden | 2.04 / 1.54 / 0.50 / 0 | 3.04 / 1.49 / 0.58 / 0.97 | 3.01 / 1.51 / 0.56 / 0.94 |
| hidden raised (subagent grader) | 0/12 | 11/12 | 10/12 |
| concerns on control and neutral (subagent grader) | 7/24 | 10/24 | 12/24 |

What it says (direction only: 36 tasks, subagents for the agent and the grader):
- **Eden does make the agent do less.** Model calls fall 2.00 → 1.69 a task (hidden 1.25: the packet answers it), and
  tool calls 1.33 → 0.69.
- **But each call costs more.** The packet adds about 270 input tokens a call. The agent also writes about 66% more
  output (98 against 59 tokens) because it now has facts to state, so the agent's own bill rises (+$0.04 per 1,000
  tasks) and its model time barely falls (1.54 → 1.49 s).
- **The push check is the rest.** It adds $0.14 per 1,000 tasks, and Eden's path is 0.97 s a task: the check's 0.72
  s and about 0.25 s of lookup before the check starts.
- **So the agent alone is cheaper and faster here by about $0.18 per 1,000 tasks and 1.0 s a task.** The real-API
  B19 reads the gap as smaller ($0.24 and +0.39 s on Pi, the agent level), because there the agent's searches cost
  more than the subagents' short answers suggest. The subagents' agents search less, answer shorter and grade
  differently, so the raw arm here is optimistic.
- **The lead's wording moved nothing** (searched2 against final2): deleted, D1192.
- **Concerns are high in every arm,** raw included (7/24). That is the subagent grader's leniency on control and
  neutral; read them only between arms.

**Hold-and-abort on final2's timelines** (`holdabort.py`, [EST]): wall −0.31 s a task on the mix, +$0.047 per 1,000
tasks (0.57 first calls aborted a task: every hidden task, 8 of 12 control, 6 of 12 neutral). Facts are the
default's by construction.
