# F7: the push check's cost and wait, leaner

Status: 2026-11-12, branch `claude/f7-cost-latency` (from main 006b505c), session F7. Train, reworded and longtail
only; heldout19 is never read or run, heldout20 never looked for. Paid calls go to Anthropic directly with
`HAIKU_API_KEY` through the lab transport and its spend ledger (`.local/f7/ledger.jsonl`, D97): **Anthropic-direct
lab figures**. Cap $40. No Modal. Numbers marked **[EST]** are arithmetic or judgement; every other number comes from
a command in this note.

**Outcome:** the account's API credit ran out after the first $0.23. The levers are priced from the tokens recorded
before that (§3, §5, D1140). The two trial switches built here, `pushCheckLeanStop` and `pushCheckLeanLead`, could
not be measured (§7) and are deleted (D1141; code and tests in commit 49ce5972). The screen of §6 was stopped before
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

## 7. Decision: both trials deleted unmeasured (D1141)

No API credit, and the subagent stand-ins (D1101) write check replies about 40% shorter than the API's Haiku on the
same prompts (§5's pilot: 42 against 68 output tokens a call), listing few of the rejections the stop would cut, and
they judge differently (F2's finding). So neither the stop's saving nor its cost in facts (the 6 of 283 named planted
facts that follow the first no on the shipped order) can be read through them, and the checked lead needs a live
agent's searches and turns. Per D814 both switches are deleted the same day; the code and its tests are in commit
49ce5972 for a re-test on the API (§1 and §2's rules stand as written for it). Kept: the findings (§3, §5, D1140),
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
trickle): backfill calls × $ a card call + 30 × daily calls × $ a card call. Today's figures: F5's world-clock count
of 16–17 calls a heavy new user (twice what COST-MODEL's D244 column used), the card call at about $0.0011 (CL3's
measured $0.0088 for 8 calls), and about 1–2 calls a day for about 10 new items sent a day (CL3): about $0.018 +
30 × $0.0011–0.0022 = **about $0.05–0.08 a heavy user-month** before the widened carding; replace the call count and
the $ a call with the final arm's `eden.cards` line from `price-queue.py` and F8's re-recorded count.
