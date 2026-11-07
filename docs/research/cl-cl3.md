# CL3: background cards and intent, and connector calls (H6, H7, H14)

Status: 2026-11-07, branch `claude/cl3-background` (base `claude/lucid-hypatia-v9wqk5` at 2c65a6f9; CL5's tip 05d145080
merged in after the runs). Decisions D242–D245. Every paid call went to the Anthropic API with `HAIKU_API_KEY`,
`claude-haiku-5-5` in every role (agent, grader, cards, intent, reader), through the lab provider (D97),
`OPENROUTER_API_KEY` unset, on one spend ledger with a hard cap of $2: **Anthropic-direct lab figures**. Plan:
[cost-latency-plan.md](cost-latency-plan.md), session CL3.

## In plain words

- **A new user's background enrichment now costs less than half as much, with no measured quality loss** (D244,
  promoted). Only person-written items from the last 7 days, not 30, are read for intent requests. Constraint-worded
  items are still carded whatever their age. A new user costs $0.0088 instead of $0.0208, and the cards are ready in
  about 41 s instead of 103 s. On a fresh-cache paid funnel pair (D177's gate) it surfaced 320 of 384 hidden facts
  against 312 (+2.1 points, +0.0..+4.4), decoys 129 against 126; on Pi it raised as many hidden facts on both horizons,
  with no false concerns.
- **Anthropic's Batch API halves the price of what is left, but a new user waits 17+ minutes for cards, and that wait
  costs real recall** (D242, rejected and deleted). With cards and intent withheld (a user whose batch has not landed),
  the paid funnel raised 22.9 points fewer hidden facts and Pi 6.2 points fewer. The saving per user after D244 is about
  $0.004, once. The shipped route (OpenRouter) has no batch API either.
- **Fewer intent requests per item saves almost nothing once fewer items are read** (D243, rejected and deleted). Two
  requests instead of four saved 7% of a new user's cost on top of D244 and lost 3.6 points of hidden facts in the paid
  funnel (−7.8..+0.0).
- **Most of Eden's connector calls come from change signals that carry no items** (D245, no engine change). In the shape
  every Pi benchmark measured (`--push signals`), Eden made 6.3–6.9 connector calls a task: about 3.3 listings (one poll
  per notifying source per notice) and 2.8–3.3 re-reads (cited items a signal put in doubt). With notifications that
  carry their items (D210's documented integration default), the same tasks made **0.56 calls a task (agent alone:
  3.6)**, Eden's share of the critical path fell from 2.1 s to 1.2 s, and wall time fell about 1.0 s a task (hidden
  −1.04 s, −1.49..−0.62), with the hidden facts raised unchanged.
- **Prompt caching works for both model roles and saves 10–28% of a card call and about 23% of a reader call** (on the
  Anthropic transport). The shipped OpenRouter route has the cache off (D145's trial): an action item below.
- **Eden is still dearer than the agent alone on these runs.** On short horizons (train2 and train5, seed 41, hidden
  tasks) Eden's all-in is $0.742 (default) and $0.693 with D244 per 1,000 tasks against tools' 0.387; the agent itself
  is cheaper with Eden (0.260 against 0.387). The reader is the gap: CL1/CL2's levers, not CL3's.

## What was tried

| Lever                                                     | Hypothesis              | Screen                                                       | Live                                      | Outcome                        |
| --------------------------------------------------------- | ----------------------- | ------------------------------------------------------------ | ----------------------------------------- | ------------------------------ |
| Lean window 30 → 14, 7, 3, 1 days                         | H7 (fewer items carded) | funnel pool, $0; paid reader seed 41 (7 days) and both seeds | cold start; Pi short and `--day 4`        | 7 days promoted (D244)         |
| Requests per item 4 → 3, 2, 1 (and "eight words at most") | H7 (terser output)      | funnel pool (replayed requests cut), $0; paid reader seed 41 | cold start                                | rejected (D243)                |
| Message Batches API for a user's backlog                  | H6                      | funnel and Pi with cards withheld                            | cold start through the Batch API, 3 users | rejected (D242)                |
| Prompt-cache check on card and reader calls               | H7                      | ledger                                                       | —                                         | caches; OpenRouter action item |
| Connector-call attribution; item-carrying notices         | H14                     | Pi timelines by op and source                                | Pi `--push payload` against `signals`     | D245, no engine change         |

Hypothesised and not built: coalescing a day's trickle of new items into fuller card calls (below, the lifetime model,
makes it a CL5 question); notices that name changed ids without their items (an engine and protocol change; D210's
item-carrying notices already remove the calls); the reader's re-reads limited to rendered citations (an ask cites 2–3
items, so little to gain).

## 1. H7: what a card call spends, and fewer items read (D244)

A card call's output dominates: on a new user (cold start below) 31.3k output tokens against 79.7k input, of which 27.7k
were read from the cache. The cached system prompt is 1,276–1,328 tokens a call; the rest of the input is the items. Of
432 items sent for a new user, 341 were request-only (the prefilter found no constraint wording; read for intent
requests only, D87), so most of the output was intent requests for unworded items.

**$0 screen** (train1–6, seeds 41–42, cards and intent replayed; the reader pool does not depend on the reader):

| `cardsLeanDays`                  | items sent to the card model | calls | hidden in reader pool | decoys in pool |
| -------------------------------- | ---------------------------- | ----- | --------------------- | -------------- |
| 30 (default)                     | 13,604                       | 822   | 282/384               | 249/384        |
| 14                               | 8,890                        | 623   | 286/384               | 252/384        |
| 7                                | 6,582                        | 504   | 287/384               | 251/384        |
| 3                                | 4,771                        | 434   | 283/384               | 246/384        |
| 1                                | 3,979                        | 402   | 277/384               | 240/384        |
| cards withheld (`minus-cards`)   | 0                            | 0     | 212/384               | 213/384        |
| intent withheld (`minus-intent`) | 2,113                        | 300   | 212/384               | 213/384        |

Intent requests carry the whole pool gain of the card pass (minus-intent and minus-cards read the same pool).

**Paid funnel** (Haiku reader, reader cache topped up, 0 misses; `surfaced` = delivered or cited by the ask):

| Arm                          | Seeds | Hidden surfaced | Decoys surfaced | Hidden, paired against the default | Decoys, paired    |
| ---------------------------- | ----- | --------------- | --------------- | ---------------------------------- | ----------------- |
| default (30 days)            | 41    | 157/192         | 64/192          |                                    |                   |
| 7 days (D244)                | 41    | 160/192         | 69/192          | +1.6 (−1.6..+4.7)                  | +2.6 (−0.5..+6.2) |
| 7 days, 2 requests (D243)    | 41    | 150/192         | 66/192          | −3.6 (−7.8..+0.0)                  | +1.0 (−1.6..+4.2) |
| cards withheld (D242's wait) | 41    | 113/192         | 66/192          | −22.9 (−29.2..−16.7)               | +1.0 (−4.7..+6.8) |
| default (30 days)            | 41–42 | 313/384         | 127/384         |                                    |                   |
| 7 days (D244)                | 41–42 | 321/384         | 129/384         | +2.1 (+0.0..+4.4)                  | +0.5 (−2.1..+3.1) |

D177's gate for cutting request-only reads is a **fresh-cache** paid pair (an empty reader cache per arm, so neither arm
reuses the other's readings): hidden not lower, decoys not higher beyond ±3 tasks. Run so (ledger runs `cl3-fresh-base`,
`cl3-fresh-l7`, $0.371): hidden 312 → 320 of 384 (+2.1 points, +0.0..+4.4), decoys 126 → 129 (+0.8, −1.8..+3.4; +3
tasks, at the gate's edge). It passes. D177 also asked a future cut to wait for a screen that sees unworded bearing
items; none exists (the planted facts are constraint-worded by design), so D244 amends D177 and accepts that blind spot:
an unworded item 8–30 days old that bears on a request is the first thing a blind check should probe.

**Cost screen** (LAB.md 2b, `-- --neutral`, $0): hidden and control rows replay fully and are unchanged, reader 0.84
calls a task and 2.67–2.70 connector calls a task under both windows (the window does not touch the reader's gate). The
neutral rows of the new default miss 590 reader prompts (re-rendered pools) and were not topped up (about $0.17, past
this session's cap), so its neutral and mix figures are not quoted.

**Cold start per new user** (`cold-start.ts`, the servers' `buildPartner`, train1:41, train3:42, train5:43; mean):

| Configuration                        | $ per user | calls           | tokens in (cached) / out | items sent (request-only) | wall to idle  |
| ------------------------------------ | ---------- | --------------- | ------------------------ | ------------------------- | ------------- |
| default (30 days), today             | 0.02076    | 21.7            | 79.2k (28.2k) / 30.7k    | 429 (338)                 | 103 s         |
| fix-s3b's run of the default         | 0.0213     | 22              | 79.9k / 31.8k            | 432 (341)                 | 108 s         |
| 7 days (D244)                        | 0.00881    | 8               | 26.3k (10.6k) / 14.3k    | 143 (52)                  | 41 s          |
| 7 days, 2 requests (D243)            | 0.00819    | 8               | 26.3k (10.2k) / 12.9k    | 143 (52)                  | 35 s          |
| 7 days, 2 requests, Batch API (D242) | 0.00449    | 8 (6–7 batched) | 26.3k (8.9k) / 11.3k     | 143 (52)                  | 1,038–1,294 s |

**Pi** (train2 and train5, seed 41, hidden and control, 64 tasks each, the direct profile, `--push signals`, time scale
1). Short: one request per session. Long: `--day 4`. `eden~cl3` is 7 days with 2 requests; `eden~lean7`, 7 days alone,
ran later in its own process (its pairs with `eden` are across runs, so their wall times compare loosely).

| Horizon | Arm                           | Hidden raised | False concerns (control) | Wall p50 / p90 / mean s (hidden) | All-in $/1k hidden (agent + Eden + backfill) | Connector calls / task (hidden) | Reader calls / task | Eden on path ms (share) |
| ------- | ----------------------------- | ------------- | ------------------------ | -------------------------------- | -------------------------------------------- | ------------------------------- | ------------------- | ----------------------- |
| short   | tools                         | 0.078 (5/64)  | 0/64                     | 5.41 / 7.66 / 5.43               | 0.387                                        | 3.58                            | 0                   | 0                       |
| short   | eden (default)                | 0.641 (41/64) | 0/64                     | 4.64 / 8.02 / 4.97               | 0.742 (0.260 + 0.320 + 0.162)                | 6.33                            | 1.02                | 2,106 (41%)             |
| short   | eden~lean7 (D244)             | 0.656 (42/64) | 0/64                     | 4.40 / 7.20 / 4.84               | 0.693 (0.321 + 0.303 + 0.069)                | 6.59                            | 0.95                | 2,035 (41%)             |
| short   | eden~cl3 (D244 + D243)        | 0.672 (43/64) | 0/64                     | 4.24 / 7.37 / 4.86               | 0.633 (0.263 + 0.307 + 0.064)                | 6.14                            | 0.97                | 2,138 (41%)             |
| short   | eden~pending (cards withheld) | 0.578 (37/64) | 1/64                     | 5.06 / 8.19 / 5.47               | 0.616 (0.348 + 0.269 + 0)                    | 6.56                            | 1.11                | 2,221 (40%)             |
| long    | tools                         | 0.047 (3/64)  | 0/64                     | 3.77 / 5.83 / 3.82               | 0.337                                        | 2.67                            | 0                   | 0                       |
| long    | eden (default)                | 0.688 (44/64) | 0/64                     | 3.79 / 6.07 / 4.12               | 0.746 (0.282 + 0.302 + 0.162)                | 6.06                            | 0.95                | 1,764 (42%)             |
| long    | eden~lean7 (D244)             | 0.688 (44/64) | 0/64                     | 3.83 / 6.33 / 4.10               | 0.658 (0.288 + 0.301 + 0.069)                | 6.00                            | 0.97                | 1,662 (41%)             |
| long    | eden~cl3 (D244 + D243)        | 0.703 (45/64) | 0/64                     | 3.73 / 5.97 / 4.05               | 0.651 (0.277 + 0.310 + 0.064)                | 5.61                            | 0.98                | 1,768 (42%)             |

Backfill is each arm's cold-start cost per user (the arms share one card cache in a run) over its 128 tasks for that one
user: a short-horizon worst case (§7). Paired differences (bootstrap 95%, 5,000 draws over tasks):

| Pair                          | Horizon | Hidden raised           | Wall s (hidden)      | All-in $/1k (hidden)    | All-in $/1k (control)   |
| ----------------------------- | ------- | ----------------------- | -------------------- | ----------------------- | ----------------------- |
| lean7 − default (across runs) | short   | +0.016 (−0.141..+0.172) | −0.12 (−0.55..+0.32) | −0.049 (−0.089..−0.009) | −0.061 (−0.109..−0.014) |
| lean7 − default (across runs) | long    | +0.000 (−0.125..+0.125) | −0.02 (−0.31..+0.27) | −0.089 (−0.118..−0.058) | −0.115 (−0.166..−0.065) |
| cl3 − default                 | short   | +0.031 (−0.062..+0.125) | −0.10 (−0.49..+0.28) | −0.109 (−0.146..−0.071) | −0.052 (−0.095..−0.006) |
| cl3 − default                 | long    | +0.016 (−0.094..+0.141) | −0.07 (−0.44..+0.29) | −0.095 (−0.137..−0.052) | −0.110 (−0.153..−0.069) |
| default − tools               | short   | +0.562 (+0.438..+0.688) | −0.46 (−1.00..+0.08) | +0.355 (+0.304..+0.409) | +0.390 (+0.337..+0.444) |
| lean7 − tools                 | short   | +0.578 (+0.453..+0.703) | −0.59 (−1.06..−0.11) | +0.306 (+0.253..+0.361) | +0.329 (+0.277..+0.382) |
| default − tools               | long    | +0.641 (+0.516..+0.750) | +0.29 (−0.16..+0.76) | +0.409 (+0.365..+0.455) | +0.427 (+0.384..+0.470) |
| lean7 − tools                 | long    | +0.641 (+0.516..+0.750) | +0.27 (−0.15..+0.70) | +0.321 (+0.274..+0.365) | +0.312 (+0.260..+0.365) |
| pending − default             | short   | −0.062 (−0.188..+0.062) | +0.50 (−0.06..+1.07) | −0.126 (−0.178..−0.074) | −0.131 (−0.178..−0.085) |

Day measures (`--day 4`, 160 turns an arm, 122 changed items): recaps naming a changed item's old time default 10, lean7
9, cl3 4; its new time 34, 44, 31; "updated:" packets 43, 41, 42; stale deliveries 2, 3, 2. Eden's reader calls and
critical path do not move with these levers (they are background work).

## 2. H6: the Batch API for a backlog (D242)

Built as a trial: a lab transport (`AnthropicBatchModel`: calls gathered for 3 s go out as one Message Batch, polled
every 15 s, each caller settled from its `custom_id`'s result, priced at half), and a bulk round in the card enricher (a
user's queue of at least `cardsBatchFrom`, 20, items sent to the bulk maker whole, every batch at once; a shorter queue,
the trickle of a day's new items, stays live). The newest backfill page went live by construction (the queue was under
20 when the drain started), so the first 20 items were carded in seconds. Code: commit 4e072585.

- **Price** (the docs, checked through the bundled Claude API reference): 50% off every token; up to 100,000 requests or
  256 MB a batch; most batches end within an hour, 24 hours at most; prompt caching works inside a batch, best effort.
- **Cost per user** (D244 and D243 on, 3 users): $0.00493, $0.00447 and $0.00407 per user (mean $0.00449) against
  $0.00855, $0.00838 and $0.00763 live (mean $0.00819), −45%. The batched calls are half price; the first call of each
  user went live at full price.
- **Turnaround**: one batch per user, of 7, 6 and 7 requests, submitted at 09:21 UTC on 2026-11-07: 1,292 s, 1,035 s and
  1,277 s from submission to end (17.2–21.5 minutes), against 32–38 s for the same users live.
- **What the wait costs.** A user whose batch has not landed has no cards and no intent. Paid funnel, seed 41: hidden
  157 → 113 of 192 (−22.9 points, −29.2..−16.7), decoys 64 → 66. Pi short (`eden~pending`): hidden 64.1% → 57.8% (−6.2
  points, −18.8..+6.2), false concerns 0 → 1 of 64, all-in $0.742 → $0.616 per 1,000 hidden tasks (no backfill charged).

Rejected: after D244 the batch saves about $0.004 per new user, once, and costs that user 17 minutes or more of the
recall the funnel loses without cards. The shipped route (OpenRouter, D12) has no batch API, and Anthropic is lab only
(D97), so promoting it would also need a provider decision.

## 3. H7: fewer requests per item (D243)

The prompt asked for "up to N short requests (eight words at most each)" below 4, and requests beyond N (from a replay,
or a model writing more) were cut, so the replayed requests screen it at $0 (the first N of the four recorded).

| requests per item | hidden in pool | decoys in pool |
| ----------------- | -------------- | -------------- |
| 4 (default)       | 282/384        | 249/384        |
| 3                 | 280/384        | 252/384        |
| 2                 | 278/384        | 247/384        |
| 1                 | 265/384        | 249/384        |
| 7 days, 3         | 283/384        | 253/384        |
| 7 days, 2         | 277/384        | 253/384        |

Live, two requests on top of D244 saved $0.00062 a new user (7%: most of a call's output after D244 is the carded items'
cards and requests) and the paid funnel lost hidden facts (seed 41: 160 → 150 against D244 alone; 157 → 150 against the
default, −3.6 points, −7.8..+0.0). Rejected and deleted.

## 4. Prompt caching (H7)

From the ledger (Anthropic transport, `cache_control` on the last system block):

| Role (run)                       | calls | input / call | read from cache / call | output / call | $ / call | caching saves / call |
| -------------------------------- | ----- | ------------ | ---------------------- | ------------- | -------- | -------------------- |
| eden.cards (cold start, default) | 30    | 3,582        | 1,276                  | 1,427         | 0.000958 | 0.000114 (10.6%)     |
| eden.cards (Pi short)            | 69    | 1,883        | 1,247                  | 424           | 0.000290 | 0.000110 (27.6%)     |
| eden.reader (Pi short)           | 26    | 2,696        | 945                    | 197           | 0.000283 | 0.0000851 (23.1%)    |
| agent (Pi short)                 | 119   | 1,151        | 822                    | 279           | 0.000189 | 0.0000659 (25.9%)    |

"Saves" is the cached tokens at full input price less what they cost (0.1x), less the cache writes' 0.25x premium.
**Action item (production):** `OpenRouterModel`'s `anthropicCache` is off by default (the D145 trial, unverified on
OpenRouter's ZDR endpoints), so the servers likely pay full input price for both system prompts. At the RealUse-2
traffic (0.92 reader calls a task) that is about $0.08 per 1,000 tasks on the reader alone. One OpenRouter probe (cached
tokens above 0 on a second identical call) decides D145; this session could not run it (Anthropic only).

## 5. H14: where Eden's connector calls come from (D245)

Pi short, by operation (per task; `eden.source` spans and the agent's `search_*` calls):

| arm            | kind    | agent searches | Eden listings | Eden re-reads | Eden searches | total |
| -------------- | ------- | -------------- | ------------- | ------------- | ------------- | ----- |
| tools          | hidden  | 3.58           |               |               |               | 3.58  |
| eden (signals) | hidden  |                | 3.34          | 2.84          | 0.14          | 6.33  |
| eden (signals) | control |                | 3.34          | 3.28          | 0.28          | 6.91  |
| eden (payload) | hidden  |                | 0.56          | 0             | 0             | 0.56  |
| eden (payload) | control |                | 0.56          | 0             | 0             | 0.56  |

By source (signals, eden arm): gmail 1.38 listings and 2.36 re-reads a task, slack 1.06 and 0.40, the rest under 0.4.

- **Listings are the notices.** With `--push signals` each source signals before a task with chance 1 − exp(−rate), a
  busy inbox and chat about every hour (assumed rates, connector-options.ts), and each notice makes the source not
  current until a poll lists its newest page (D125). Listings per task match the notice rate.
- **Re-reads are doubt.** A signal does not say which item changed, so every copy of that source read before it is in
  doubt (`signalledSince`), and every doubted item an ask cites is re-read first (D126, D211's strict ask). An ask cites
  2–3 items; most are gmail's.
- **The ask waits for both.** Eden's path: signals 2,106 ms a task (41% of wall; ask 528 ms on hidden), payload 1,184 ms
  (28%; ask 61 ms). Payload against signals, paired over the same 64 tasks: hidden raised +3.1 points (−12.5..+18.8),
  wall −1.04 s (−1.49..−0.62), Eden's $ per 1,000 −0.014 (−0.051..+0.022), connector calls −5.77 (−6.53..−5.08); control
  wall −0.96 s (−1.41..−0.51), calls −6.34.
- In this static lab world nothing changes, so every re-read confirmed and every poll found nothing new. That is a
  property of the lab, not a sign the calls are wasted: in a real inbox they catch edits and deletions (D126, D211). The
  payload arm sends no notices at all (the world never changes), so it is the lower bound of what item-carrying notices
  cost; a real one stores its items with no call (D125's `sourceItems`).

No engine change: the lever exists (D210: notices that carry their items are the documented default; the client's
`sourceChanged(sourceId, { items, removed })`). Cutting the polls or re-reads for signal-only notices would trade
D126/D211's guarantees for a saving the static world would overstate.

Found on the way (not fixed): an ask's `verify` trace counts `this.freshness.calls - before`, a counter every session
shares, so two asks verifying at once both count each other's re-reads (seen in the smoke: two traces of 5 calls for 5
fetches). The connectors' own counts and the Pi spans are right; summed `sourceCalls` over traces overcount. A follow-up
for whoever next owns partner.ts's verify path.

## 6. Lab fix: replayed request-only items no longer go live

CL5 found that with `--cards` replayed most of a run's in-run backfill was still live (370 of 447 live lines were null
cards). The cause: with intent on, an item the card prefilter rejects is sent for its requests, and the card files have
no line for it, so `DiskCardMaker` made a live call, although the enricher ignores such an item's card and `make`
returns the replayed requests over the live ones: the call's output was thrown away. `DiskCardMaker` now skips the live
call for an item whose requests are replayed and which fails the looser prefilter (`worthCarding`, so the stricter one
too), and counts it in `skipped` (`cards-disk.test.ts`). The funnel is unchanged (321/129, 504 calls, 0 misses); the
saving in a live run's backfill was not re-measured here.

## 7. The per-user lifetime model (for CL5)

A user's enrichment is a one-time backfill plus a daily trickle.

- **One-time**, measured (cold start above): default $0.0208, D244 $0.0088 per new user (8 calls, 41 s).
- **Per day**, an estimate, not measured: the sim worlds take in 36 items a day (240–260 in their last 7 days of about
  1,520). The lean window bounds only the backlog: every recent person-written item is read whatever the window, so a
  day's cost is the same with D244 as without. About 10 items a day reach the card model (D244's cold start sent 143
  items: 52 request-only, all from its last 7 days, and 91 constraint-worded or carded from any age; scaled to a day:
  52/7 + 91 × 36/1,520 ≈ 9.6). At the cold start's $0.00005–0.00006 per item sent, **≈ $0.0005–0.0006 a day**, more if a
  day's items arrive in many small calls (each call pays its prompt: about 1,300 cached and 300 uncached tokens, ≈
  $0.00004).
- **Lifetime**: one-time + days × per-day. Over 30 days of use: default ≈ $0.021 + $0.017 = $0.038; D244 ≈ $0.009 +
  $0.017 = $0.026 (estimates). Spread over tasks: at 12–20 requests a day, 30 days is 360–600 tasks, so cards and intent
  are $0.04–0.07 per 1,000 tasks with D244 (≈ $0.06–0.10 without), against the reader's $0.23–0.27.
- **Per 1,000 tasks in this session's Pi runs**, the one-time cost spread over one user's 128 tasks (a worst case: the
  short horizon has one user per seed): default $0.162, D244 $0.069 (8.81/128), D244 with 2 requests $0.064.

## Commands

```bash
# $0 screens (recipe 2a), e.g. the 7-day window
gunzip -c packages/sim/lab/distilled/reader-haiku-train-4142-intent.jsonl.gz > .local/reader-haiku-train-4142-intent.jsonl
bun run funnel --jobs 4 --allow-misses --set '{"cardsLeanDays":7}' --json .local/cl3/lean7.json -- --reader replay \
  --reader-model claude-haiku-5-5 --reader-cache .local/reader-haiku-train-4142-intent.jsonl
# paid top-ups into a copy of the cache (one per arm; seed 41, then both seeds for the 7-day window)
bun run funnel --seeds 41 --allow-misses --set '{"cardsLeanDays":7}' --json .local/cl3/t-l7.json -- --reader live \
  --reader-model claude-haiku-5-5 --reader-cache .local/cl3/reader-cl3.jsonl --spend-ledger .local/cl3/ledger.jsonl \
  --spend-cap 2 --spend-headroom 0.3 --run-label cl3-topup-l7
python3 -I packages/sim/lab/cl3/funnel-pairs.py .local/cl3/t-base41.json lean7=.local/cl3/t-l7.json
# cold start per user
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/cold-start.ts --users train1:41,train3:42,train5:43 \
  --set '{"cardsLeanDays":7}' --spend-ledger .local/cl3/ledger.jsonl --spend-cap 2 --spend-headroom 0.3 \
  --run-label cl3-cold-l7 --out .local/cl3/cold-l7.json
# Pi (packages/sim/lab/cl3/run.sh: pi-ab with the direct profile, --push signals, Haiku in every role).
# The eden~cl3 arm's intentRequests (D243) is deleted: these two runs need commit 4e072585; eden~lean7 is today's default.
packages/sim/lab/cl3/run.sh cl3-short-41 train2,train5 41 tools,eden,eden~cl3,eden~pending \
  '{"cl3":{"intentRequests":2,"cardsLeanDays":7},"pending":{"cards":false,"cardsEconomy":false,"intent":false,"cardsLean":false,"intentByKind":false}}' \
  packages/sim/lab/cards/cards-v2.jsonl
packages/sim/lab/cl3/run.sh cl3-day-41 train2,train5 41 tools,eden,eden~cl3 '{"cl3":{...}}' packages/sim/lab/cards/cards-v2.jsonl --day 4
PUSH=payload packages/sim/lab/cl3/run.sh cl3-payload-41 train2,train5 41 eden '{}' packages/sim/lab/cards/cards-v2.jsonl
python3 -I packages/sim/lab/cl3/arms.py --bk eden=0.020757 --bk eden~cl3=0.008185 --bk eden~pending=0 .local/cl3/pi/cl3-short-41
```

The `eden~cl3` arms ran on commit 4e072585 (the trials as built). Two of its effects on these runs: (1) the bulk and
request-cap code moved the enricher's microtask timing for every arm until it was rewritten (the default then made 732
card calls in the funnel instead of 822, and missed 86 reader prompts; restored to 822, 313/127, 0 misses before any
paid funnel number here was taken); Pi waits for every card before the first task, so its arms are unaffected. (2) Pi's
arms share one card cache, so a few of the 6 items intent-v2 does not cover may have replayed another arm's live
requests.

## Spend

Ledger `.local/cl3/ledger.jsonl` (cap $2, headroom $0.3), Anthropic API only:

| Label                                         | What                                                          | $          |
| --------------------------------------------- | ------------------------------------------------------------- | ---------- |
| cl3-smoke                                     | Pi smoke, train1 seed 41, 8 templates, tools and eden         | 0.0416     |
| cl3-short-41                                  | Pi short: tools, eden, eden~cl3, eden~pending (512 runs)      | 0.3527     |
| cl3-day-41                                    | Pi `--day 4`: tools, eden, eden~cl3 (384 runs)                | 0.3029     |
| cl3-payload-41                                | Pi short, eden with `--push payload` (128 runs)               | 0.1176     |
| cl3-l7-short-41, cl3-l7-day-41                | Pi eden~lean7, short and `--day 4` (128 runs each)            | 0.1893     |
| cl3-topup-l7r2, -l7r2b, -nocards, -l7, -l7-42 | paid reader top-ups of the funnel (seed 41; seed 42 for D244) | 0.3029     |
| cl3-cold-base, -l7, -l7r2, -bulk              | cold start, 3 users each                                      | 0.1268     |
| **total**                                     |                                                               | **1.4338** |

The funnel screens, `bun run eval` and every replay cost $0.
