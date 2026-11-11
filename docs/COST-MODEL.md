# Cost model

Input tokens drive the cost, so the design rations them: most turns cost nothing, and a model call sees a bounded
input.

## Prices (verify before relying on them)

`z-ai/glm-5.3-flash` is served by 38 OpenRouter endpoints at different prices (OpenRouter endpoints API, queried
2026-10-27 in the fast-primitives research; [docs/research/fast-primitives.md](research/fast-primitives.md)):

| Endpoint               | Input $/M | Output $/M | Cache read $/M | Note                                               |
| ---------------------- | --------- | ---------- | -------------- | -------------------------------------------------- |
| Z.AI and most US hosts | 0.15      | 0.50       | 0.03           | Z.AI caches automatically                          |
| Relace                 | 0.0513    | 0.0701     | 0.03           | The founder's figure; no `response_format` support |
| Wafer                  | 0.054     | 0.20       | 0.053          | Almost no cache discount                           |
| OpenInference (fp4)    | 0.082     | 0.06       | 0.0064         | Quantized                                          |

Many endpoints are fp4/nvfp4 quantized; whether that hurts judge precision is unmeasured. With default load
balancing, prompt-cache hits are unlikely: caching pays only with sticky routing (a per-user `session_id`, a
byte-stable system prefix). `packages/llm/src/pricing.ts` budgets with the Z.AI list price, the conservative one.
OpenRouter returns the real cost per call (`usage.cost`), and the engine books that.

## Per call (upper bounds from the engine's caps)

| Call                                                                                                        | Input bound                                                                                    | Output bound                      | Cost at $0.15 / $0.50, uncached |
| ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------- | ------------------------------- |
| Judge                                                                                                       | system ≈ 100 tok + window ≤ 4,000 chars (≈ 1,000 tok) + ≤ 6 candidates × ≈ 100 tok ≈ 1,700 tok | 512 tok, reasoning included (D45) | ≈ $0.00051                      |
| Card enrichment (`cards`, in the default since D112 and kept there by D113(5); background, never per event) | system ≈ 700 tok + ≤ 10 items × (title ≤ 160 + own text ≤ 900 chars) ≈ 3,400 tok               | 2,000 tok, no reasoning (D149)    | ≈ $0.0015                       |

Queued request (`slowPathQueue`, D102): deleted by D228 (2026-11-07; docs/research/fix-w2a-parts.md). A request that
arrives while the session's slow path is busy is not looked up, so the one extra slow path (and judge call) per busy
window it could add is gone.

Smaller poll pages (`syncPollPageSize`, D101, in the default since D112 at 5). No model call. An on-demand poll lists
far
fewer items (measured on the train funnel: 182,742 → 10,080 items at `syncPollPageSize` 5, calls 2,048 → 2,049) but
can make one listing call more than full pages would (at most `syncCatchupPages` + 1): a connector billed per call
pays at most that one call more per poll, one billed per item or byte pays less.

Card enrichment, measured (docs/research/moon-cards.md, 572 calls on simulated worlds, 2026-10-31): 1,599 input and
677 output tokens per call on average, $0.000181 per call as OpenRouter reported it. One call per ten new items that
pass the no-model prefilter (11-15% of simulated items), each item read once per content hash: about $0.002 per 1,000
items arriving, $0.003-0.004 per user-month at 50 new items a day (at most about $0.013 at list prices). Reserved per
call at $0.002 against its own per-user-day `Budget`.

Intent index (D87, `intent`, in the default since D112, kept there by D113(5); docs/research/edge-intent.md). No new
call: the card call also
writes up to four requests per item, and every new item is read, not only the 11–15% the prefilter passes. The cap per
call rises from 2,000 to 3,000 output tokens (300 per item past ten); the reservation is unchanged. Estimates from
measured per-item prices, not a live run of the combined prompt on the default model: requests alone cost $0.0000091
per item (path-to-90's doc2query run, glm-5.3-flash, cheapest endpoint, 1,607 items for $0.0147) and cards $0.0000134;
reading every item for both is about $0.000023 per item, so about $0.035 per user once (a 1,500-item backfill) and
about $0.035 per user-month at 50 new items a day, against about $0.0011 with `cardsEconomy` alone. The free lab model
(nemotron-3.5-super-vl, which reasons at length whatever effort it is asked for) used 1,855 input and 3,720 output
tokens per ten-item call over 184 calls (24 of them retries of a batch cut off at 8,000 tokens): at the list price
that would be $0.0021 per call, $0.00021 per item, about $0.32 per user-month, an upper bound for a model that
reasons that much. Request time adds one BM25 search over the user's requests (no model, no call).

A distilled open model for the card and intent call (M2, lab only, D445–D449; docs/research/m2-cards-distill.md):
Qwen2.5-1.5B-Instruct fine-tuned on Haiku's train cards, served by vLLM on one Modal L4 ($0.80 an hour, list), costs
$0.0126 per 1,000 items at 16 calls at once and $0.133 one call at a time (p50 5.0 s, p90 12.0 s a call, about 12
items a call), against Haiku's $0.051 per 1,000 items (lab provider, cached; $0.001012 a 20-item call, p50 5.4 s).
Its cards match Haiku's in the funnel but its intent requests lose hidden facts, so it is not used.

Card lanes (`cardsLanes` 4, D521, D522; docs/research/n4-agents.md): a user's waiting batches are sent up to four at
once. No call is added (the $0 funnel makes 382–392 card calls with one lane or four, by machine load); a new
user's backfill of about sixteen calls ($0.0014 a call, about $0.022 a user on Haiku 5.5, Anthropic-direct lab
figures, cards made in-run on train seeds 45–48) is spent in a quarter of the time, with up to four reservations of
`estimatedCallUsd` held against the user's day at once. Near the user's day cap that costs calls: lanes in flight
hold their estimates ($0.003) rather than what they will cost (about $0.0014), so the refusal that drops what waits
comes up to three calls' worth earlier than with one lane (the reviewer's probe: 2 calls against 3 under a cap of
$0.0045).

The match thresholds (`intentMinCoverage` 0.2, `intentMinMatched` 1, `intentHits` 12 since D179) add no call: a looser
match only lets more intent hits into the ask's reader pool, which is capped at `askReaderPool` items either way. On
Pi held-out 13 seeds 41–44, intent replayed (ledger runs `close-d159-pi-41` to `-44`, $0.534;
docs/research/edge-intent.md, "D179 result"), the paired cache-neutral agent+Eden cost moved −0.031 $/1k tasks (95%
CI −0.080..+0.015), Eden's own −0.015 (−0.047..+0.018), and reader calls 450 to 433.

The carded cut (`intentByKind`, D200) adds no call either; it changes which items fill the reader's pool and makes the
reader prompt about 2.4% longer on train (mean 7,493 to 7,673 characters over 1,306 to 1,314 calls, seeds 41-44, stub).
On a Pi pair, held-out 13 and 14 seeds 41-42 (ledger runs `s3a-kind2-h13-41` to `s3a-kind2-h14-42`, $0.621; Anthropic
direct), Eden's own cost on hidden tasks moved +$0.014 per 1k (95% CI −0.022..+0.048), agent+Eden cache-neutral +0.015
(−0.044..+0.070); on control tasks +$0.009 and on neutral tasks +$0.042 (Eden's own, unpaired means). A
first pair on a build that also widened the uncarded cut read +$0.040 (+0.003..+0.076) on hidden tasks.
docs/research/fix-s3a-intent.md.

**Card reasoning (D149): none by default.** Until D149 `ModelCardMaker` always sent reasoning "low" (D59), which the
servers send to OpenRouter (`build.ts` wires `models.cards`), while every Haiku 5.5 card call in the lab ran on
`AnthropicModel` with thinking off (`pi-ab.ts`, `hermes-ab.ts` and `cards-enrich.ts` pass no thinking option;
`anthropic.ts` defaults it to off and sends effort only with adaptive thinking): all 5,158 `eden.cards` ledger rows,
$2.298, $0.000445 a call, p50 2,699 ms, 625 output tokens a call. So every Haiku card and intent figure in this file
describes "off"; the earlier glm-5.3-flash and nemotron figures through OpenRouter (D59's measurement above, D66's
re-carding, the intent estimates, and the replayed `cards-v2.jsonl` the funnel reads) were made with "low". The
maker now sends no reasoning field, and since D155 it has no option to send one: "low" exists only as a lab arm,
sent through a model wrapper that adds the effort to each request (as `eval-live.ts` does for the reader). The output
caps are unchanged. Timed on Haiku 5.5, Anthropic-direct, lab provider, cached (the system block read from the cache
on both arms), the shipped shape (`cardsEconomy` batches of 20 train items, seed 41, `intent` on, 6,000-token cap),
arms interleaved per batch: "off" is `new ModelCardMaker(model)` with thinking off; "low" sent effort "low" with
adaptive thinking, so the effort reaches the model (at the time through the maker's own `reasoning` option, which
D155 deleted; the request is the same). Percentiles are nearest-rank.

| Arm (run `close-cards-reasoning`, 2026-11-05) | Calls | p50 / p90 ms   | TTFT p50 ms | Thought | Truncated | Tokens in (cached) / out | $ per call |
| --------------------------------------------- | ----- | -------------- | ----------- | ------- | --------- | ------------------------ | ---------- |
| off                                           | 17    | 5,406 / 8,862  | 542         | 0       | 0         | 3,801 (1,242) / 1,484    | $0.001012  |
| low (adaptive)                                | 18    | 9,863 / 18,017 | 5,756       | 18      | 0         | 3,809 (1,248) / 2,580    | $0.001561  |

"low" is 1.82x slower at p50 (2.03x at p90), 1.54x dearer a call and writes 1.74x the output tokens; no batch was cut
off at the cap on either arm. Items given at least one request: 318 of 340 off, 299 of 360 low (no labels here, so
not a quality figure). The run stopped at its own $0.045 limit after 17 batch pairs and one more "low" call: 35 ledger
rows, $0.0453 ($0.0172 off, $0.0281 low). It used a scratch script outside the repo (`ModelCardMaker` over
`labModel("claude-haiku-5-5")`, as `reader-time.ts` does for the reader) with `--spend-ledger .local/mkt/ledger.jsonl
--spend-cap 17 --spend-headroom 0.3 --run-label close-cards-reasoning`. How OpenRouter maps effort "low" for
`anthropic/claude-haiku-5.5` stays unmeasured (D145), as for the reader (D144).

The bridging query (D89) was deleted by D112; its cost notes are in git history.

**The open push (`pushOpen`, D710) adds no model call of Eden's**: the candidates' push runs for more requests (98%
of nothing-to-add requests get a packet against 87%), which cost the agent's own model +$0.012 per 1,000 tasks
(+0.009..+0.014) over 32 simulated users' days on Haiku 5.5 (Anthropic-direct lab figures, o3-pointer.md §3).

**Since D237 (CL6, 2026-11-07) the default makes no reader call** (`pushCandidates` 5: the push hands the agent its
pool's first five items to judge, about 950 bytes a task in the $0 funnel; an ask reads nothing either). Eden's
per-task model spend is $0; the agent reads about 300–600 more input tokens a task on the short horizon. Pi, Anthropic
Haiku (lab provider), train seeds 41–42, 1:1:8 mix, steady state per 1,000 tasks: short 0.338 (signals) and 0.415
(payload, billed; cache hits vary between runs) against the old default's 0.631 and 0.665 and the agent alone's
0.368; long 0.326 and 0.338 against 0.568 and 0.529 and the agent alone's 0.317 (docs/research/cl-cl6.md). The reader
figures below hold for `pushCandidates: 0` (`--preset minus-candidates`). **D317 (A12) adds no model call of Eden's
and no connector call** but makes the agent ask more (`askNudge`: +0.20–0.38 asks a task): +$0.061 per 1,000 tasks
on the 1:1:8 mix as measured (0.374 → 0.435; Pi, Anthropic Haiku, the 91 targeted train templates, seeds 41–44 and
41–42 for neutral; docs/research/a12-quality.md). A later check of the version after review came out at +$0.046–0.059
a kind against an earlier baseline, so read the trade as +$0.04–0.07 a kind and +0.3–0.6 s (D317). M4 measured it on
the whole train suites at +$0.022 per 1,000 tasks and +0.21 s a task (D455); **D461's narrower trigger
(`askNudgeDeep`) takes back −$0.005 per 1,000 tasks (−0.009..−0.000), −0.062 asks and −0.062 s a task** against it
(Pi, train 41–44, short and over days; docs/research/m5-nudge-narrow.md).
**With the D340 trial on (A17; off in the default)** a candidate handed for an earlier request of the session is
handed again when it ranks for a later one: over a user's days the agent reads about 600-750 more input tokens a task (+$0.013 per 1,000 tasks on
8-day days, +5% of the eden arm's $0.251 steady state; +$0.017 pooled with 40-request days), with no Eden model call;
under signal-only notices a re-shown mail item is re-read (Eden connector calls 6.11 → 6.42 a task). One request a
session it never acts (docs/research/a17-long-quality.md).

Ask-time reader (D95, `askReader`, in the default since D112; `reader.ts`). One call per `ask` about an action (an
imperative question, a question about blockers, or an ask while the session's latest request acts; any ask with
`askReaderQuestions`), never per event, never on the fast path, cached per user and session by request and pool, so a
repeated ask makes none. Input: the system prompt (about 450 tokens) and up to 30 candidates (at most 40) of at most
400 characters each plus title, sender and card fields. Measured on simulated worlds (train1–6, seed 41,
glm-5.3-flash, 2026-11-02, OpenRouter's reported cost): 0.86 calls per task (124 asks read in 144 tasks). Two
endpoints, with very different reasoning lengths:

**Every Haiku 5.5 reader and card figure in this file is "lab provider, cached" (D145)** unless it says otherwise: it
was measured on the lab's `AnthropicModel` (Anthropic directly, thinking off, the system prompt always read from the
prompt cache after the first call), not on the path the servers ship, which reaches `anthropic/claude-haiku-5.5`
through OpenRouter and sends no cache breakpoint (`anthropicCache` is a documented, untested opt-in, off and set by
nothing in the servers, D817). Re-priced with no cache, the lab
ledger's `eden.reader` rows cost 1.32x and its `eden.cards` rows 1.27x what they did (D145; the gap at lab traffic
density, an upper bound for sparser traffic). The OpenRouter path's cost and latency are **unmeasured**: this
audit's runs could call Anthropic only.

Measured on Claude Haiku 5.5 (lab provider, cached; D96, docs/research/haiku-opt.md): prompt v5 over a 30-item pool is
about 3,770 tokens in and 250 out, 24% of the prompt read from the cache (the instructions), $0.00042 per call ($0.10 /
$0.50 per million, cache reads at a tenth), p50 1.41 s and p90 1.99 s with thinking off. With `readerPush` (D96) the
same call is also made once per user request that acts (an imperative request), whether or not the agent asks: at
about $0.00042 a call, $0.42 per thousand acting requests. Phase 3 (D99, lab provider, cached): prompt v7 is about
3,900 tokens in and 190 out, $0.00040 a call; the leaner operating point (pool 15, 240-character snippets,
`readerGate`) about 2,900 in and 180 out, $0.00029 a call (30% less Eden cost per task live; the default's reader,
D112).
A wider request gate (D168's verb-gate trial, measured and deleted 2026-11-06) read 124 more of 768 train tasks
and added 113 reader calls (651 to 764, +17.4%; 0.91 a newly gated request) at $0.000278 a call (ledger run
`close3-verbgate-topup`: 119 calls, $0.03306), so $0.041 per thousand train tasks and $0.25 per thousand newly gated
requests; it gained no hidden item (311 to 310) and cut decoys 137 to 121 (recipe 2a replay, LAB.md).
Since D193 (`readerReuse`) an agent's `ask_context` in the request's own turn reuses the push's reading instead of
a call, and since D192 (`readerVerifyAfter`) no doubted item is re-read beside a reading. Pi on Anthropic Haiku
(lab provider, cached), heldout13+14, seeds 41-42, both on against the old default: reader calls a neutral task
1.78 → 0.88, Eden's per-task $ on neutral tasks $0.465 → $0.218 per 1,000, the 1:1:8 mix all-in $0.856 → $0.628
per 1,000 tasks (−$0.228, CI −0.292..−0.165) and 2.45 fewer connector calls a task (docs/research/fix-s1-reader.md).
Since D240 (`readerStopEarly`) the reply stops at the first entry the model says is not the request's own thing
(lab provider, cached; train1–6 seeds 41–42, 643 calls each, docs/research/cl-cl2.md): 2,834 tokens in, output 172 →
91, $0.000284 → $0.000244 a call (−14%), reader p50 1,129 → 869 ms. Its latency is output: over 2,544 live calls,
759 ms + 2.89 ms per output token, flat in input. Pi (train, n 120 a kind short, 96 on `--day 4`): Eden's per-task $
−18% (short) and −10..−20% (day), wall −0.61..−0.77 s short. Smaller pools (`askReaderPool` 10: −22% $ a call) and
narrower items (160 characters) cost recall and were not taken (D238); compact item fences save 2% of tokens (D239);
a per-user cached item prefix would cost more to read than it saves (D241).

**Reader reasoning (D144): the default sends none.** Until D144 `ModelReaderMaker` defaulted to reasoning "low", which
the servers send to OpenRouter, while every lab figure above (and D96's, D98's and D125's quality) ran with thinking
off. Timed on Haiku 5.5, Anthropic-direct, lab provider, cached (the system prompt read from the cache on both arms):
"off" is `new ModelReaderMaker(model)` on `AnthropicModel` with thinking off; "low" sent effort "low" with adaptive
thinking, so the effort reaches the model (`output_config.effort`). "Low" is a lab arm only: the runs below passed it
as the maker's `reasoning` option, which D155 deleted, and the lab now sends it through a model wrapper that adds
the effort to each request (`eval-live.ts`, `reader-time.ts`); the request is the same. Percentiles are
nearest-rank; "thought" is a call whose stream held a thinking block; the wait is `askReaderWaitMs` (2,500 ms).

| Run (ledger label)                                                   | Arm            | Calls | p50 / p90 ms  | TTFT p50 ms | Thought | Over 2.5 s | Tokens in (cached) / out | $ per call |
| -------------------------------------------------------------------- | -------------- | ----- | ------------- | ----------- | ------- | ---------- | ------------------------ | ---------- |
| `s1-reader-time`: 60 real train pools, 14.6 items (pool 15, 240 ch.) | off            | 60    | 1,187 / 1,612 | 582         | 0       | 0          | 2,796 (945) / 173        | $0.000281  |
| same pools, interleaved                                              | low (adaptive) | 60    | 2,822 / 4,176 | 2,559       | 46      | 38         | 2,797 (946) / 506        | $0.000447  |
| `pp-reader-time` (audit probe): one 30-item pool, 10 calls per arm   | off            | 10    | 1,235 / 1,384 | 636         | n/a     | 0          | 3,192 (945) / 228        | $0.000348  |
| same                                                                 | off, uncached  | 10    | 1,338 / 1,507 | 646         | n/a     | 1          | 3,192 (0) / 228          | $0.000433  |
| same                                                                 | low (adaptive) | 10    | 3,449 / 4,319 | 3,158       | n/a     | 6          | 3,193 (946) / 582        | $0.000526  |
| same                                                                 | low, uncached  | 10    | 3,536 / 4,059 | 2,922       | n/a     | 7          | 3,193 (0) / 623          | $0.000631  |

At the default's pool, "low" is 2.38x slower at p50 and 2.59x at p90, 1.59x dearer per call, and 38 of 60 calls
(63%) ran past the wait, where the ask answers without the reader while the call is still paid for; "off" had none
past it (slowest 2,102 ms). Latency under "low" is bimodal: the 46 calls that thought took a median 3,242 ms (38 of
them past the wait), the 14 that did not 1,150 ms, like "off". Both arms flagged the same items on 50 of 60 pools and
43 items each (the pools carry no labels here, so this is agreement, not quality; quality is D144's: haiku-opt.md's
one thinking-on row, 117 hidden and 89 decoys against 114 and 88 off). The `s1-reader-time` run is 120 ledger rows,
$0.0437 ($0.0169 off, $0.0268 low), 2026-11-05. The `pp-reader-time` rows were re-tallied from the ledger in blocks of
ten (role `eden.reader.pp`, no thinking flag recorded). Reproduce:

```bash
bun run funnel --jobs 4 -- --reader-log .local/s1/pools.jsonl                     # $0: 657 distinct train pools
bun packages/sim/src/lab/reader-time.ts --pools .local/s1/pools.jsonl --calls 60 \
  --spend-ledger .local/mkt/ledger.jsonl --spend-cap 17 --spend-headroom 0.3 --run-label s1-reader-time
```

How OpenRouter maps effort "low" for `anthropic/claude-haiku-5.5` is **unmeasured**: adaptive thinking (the arm
timed here) or enabled thinking with a token budget, which Haiku 5.5 refuses with HTTP 400 (the audit's
`lat-audit-reasoning` enabled-1024 rows: no tokens, about 160 ms), so the reader would have failed open on every call.
"off" avoids both. Time the same two arms through OpenRouter once a key it serves Anthropic models for exists
(`reader-time.ts` times `claude-*` ids only). `askReaderStanding` and `askReaderQuestions` were deleted by
D112 (NEW2 was not adopted): they added about 3,000 input tokens a call and a push read of every user message. An
`ask_context` the agent then makes about the same request is a second full call unless its question is the request word
for word: the verdict cache is keyed by the request, the question and the focused pool (`readerKey`), and a paraphrase
changes all three (the audit's scratch test on the `reader.test.ts` harness, re-run 2026-11-03: 1 call for a verbatim
ask, 2 for a paraphrase). In Pi's held-out 13 run (seed 41, `packages/sim/lab/haiku/phase3/ledger-summary.jsonl`) the
reader made 476 calls over the 320 tasks of the five reader conditions, 1.49 a task, mixing the `eden` arms (which have
`ask_context`) with the `both` arms (which do not). So the reader runs once per user message plus once per paraphrased
ask, not once per user message. The reader's calls show in the traces, each call counted once (`readerCalls`,
`readerCostUsd`): an "answer" trace for an ask's read, a "reader-push" trace for a push's (the push waits for its
reading), and a "reader-late" trace, emitted when it lands, for a call an explicit ask started and stopped waiting for
at `askReaderWaitMs`. `AskResponse.costUsd` holds only a call that answered in time: a late call reports 0 there (and
`usedModel` false), so an embedder meters the reader from the traces or from `AskReader.stats`, not from `AskResponse`
alone. A reader given a default `new Budget()` stops after 20 reads a session (`callsPerSession`; settling at the actual
cost frees the dollar cap, so the count binds first): about 20 user messages when each is read once, fewer when an ask
reads a pool its push did not. Refused reads report the outcome "budget"; size the reader's own `Budget` for longer
sessions. The intent index's requests for every item of a world (D87) cost $0.0000501 per item on Haiku 5.5 (lab provider,
cached; 3,331 items, 355 calls, $0.177), once per item version.

| Routing (`sort`)           | Endpoint      | Calls | Tokens in / out per call | $ per call (reported) | Latency p50 / p90 | Over 2.5 s |
| -------------------------- | ------------- | ----- | ------------------------ | --------------------- | ----------------- | ---------- |
| `price`                    | OpenInference | 124   | 2,551 / 800              | $0.000205             | 4.39 s / 6.76 s   | 117        |
| `throughput`               | Parasail      | 42    | 2,666 / 135              | $0.000455             | 0.86 s / 2.36 s   | 4          |
| `throughput`, blind suites | Parasail      | 10    | 1,894 / 49               | $0.000309             | 0.61 s / 1.18 s   | 0          |

At the Z.AI list price ($0.15/$0.50 per M) a call is about $0.00046 (135 tokens out) to $0.0008 (800 out); it is
reserved at $0.002 against the reader's own `Budget`. Per task: about $0.0002 (price routing) to $0.0004 (throughput
routing), comparable to the agent's own cost per task (about $0.0005, docs/research/path-to-90.md), so a tenant
turning it on roughly doubles the model cost of an acting task. The price-routed endpoint reasons about 800 tokens
whatever effort it is asked for, which puts 94% of its calls past the default 2.5 s wait (the ask then answers
without it, and the call only fills the cache); throughput routing is what makes the reader fit its wait. Small
samples on one seed: not statistics.

The reader gate on everyday traffic, SIMULATED (`bun run gate-traffic`, no model, $0). `sessions.ts` sessions
(requests that need context, inbound mail, small talk, off-world and novel requests, passing mentions; 438 user
messages over 160 sessions, 40 on each of seeds 41–44) through a `ContextPartner` with a reader that counts calls and
makes none, every item synced with its replayed card (99.9% of the request's own pool items have a known card, so
missing cards do not inflate the skip rate). These are simulated sessions, not production traffic, and the agent's
own `ask_context` calls are not played, so the counts are the push's alone.

Today the command runs only `default` and `default-nogate` (gate-traffic.ts `CONFIGS`). Current rows: `bun
packages/sim/src/lab/gate-traffic.ts`, 2026-11-04, on 39a41c49e (two runs, identical counts, 7.2 and 9.9 s) and again
on cc668e4df (identical counts, 6.9 s):

| Preset                     | Reader calls per user message | Gated share (of messages at the gate) | Gated with a needed item in the pool |
| -------------------------- | ----------------------------- | ------------------------------------- | ------------------------------------ |
| default-nogate (gate off)  | 0.199 (87 calls)              | –                                     | –                                    |
| default (gate on, shipped) | 0.151 (66 calls)              | 25.0% (22 of 88)                      | 5 of 22 gated; 5 of 42 such pools    |

The default's missed-binding share is 0.227 (5 of 22 gated), 0.119 of the 42 pools holding a needed item, and all 5
are `landlord` sessions (landlord row: gated 5, missed-binding 1.000; R3-19, still open: D122 measured a pattern
that reads the landlord's arranged visit, 66 → 72 calls with missed-binding 0, and rejected it). An oracle gate makes 42
calls over any needed fact and 24 over needed reader facts: 1.57x and 2.75x fewer than the default, 2.07x and 3.63x
fewer than default-nogate. NEWL's rows from 2026-11-03 (bench/ledger.jsonl `20261103060929-sim-sessions-gate-traffic`)
are the same numbers: NEWL is the default's reader setting (D112).

History, not reproducible with today's command: the NEW2 rows below were measured on 2026-11-03 (same ledger entry)
with the NEW2 preset, which D112 deleted; they reproduce with `bun run gate-traffic` at 51b55c9a8, the commit before
D112 (#217).

| Preset (deleted, D112) | Reader calls per user message | Gated share (of messages at the gate) | Gated with a needed item in the pool  |
| ---------------------- | ----------------------------- | ------------------------------------- | ------------------------------------- |
| NEW2, gate off         | 0.995                         | –                                     | –                                     |
| NEW2 + gate            | 0.628                         | 37.2% (163 of 438)                    | 29 of 163 gated; 29 of 199 such pools |

Under the default 348 of 438 messages are never read (they do not act), so the gate trims 24% of an already small count;
under NEW2 it cut calls by 37%, not the 3.3–10x an estimate in the audit assumed. The cost of the cut is real: about one
gated message in five held an item stating a fact the turn needed. That is a proxy, not a count of lost bindings: most
needed facts in `sessions.ts` are plain information (a meeting's time, an invoice's amount) that the reader is not for,
and the sessions label no constraints of their own. It is not zero; D112 put the gate in the default on its live Pi run,
and the landlord misses stay open (R3-19, D122). Applying the live per-call prices above to these counts (an estimate, not
measured): the default about $0.044 per 1,000 user messages with the gate and $0.058 without ($0.00029 a call); NEW2
(history) about $0.25–0.30 with the gate and $0.40–0.47 without ($0.00040–0.00047 a call). Ceilings for the gate, an
oracle gate and verdict reuse: "Where 3x is impossible" below.

The active-constraints digest (D90) was deleted by D112.

ALL5 (D92) was deleted by D112; its intent part is in the default (cost above).

Card economy (D66, `cardsEconomy`, in the default since D112; docs/research/econ-background.md; in-sample, 2026-10-31):
the strict prefilter and sentence reuse read 74.25 items per simulated user instead of 166.5 (−55.4%) in 12.4 calls
instead of 24.25 (20 items per call), with the same funnel totals (218/19; the track measured 70.25 items and 12.15
calls before the sentence key took the subject in, after review). Per item, OpenRouter's endpoint decides the price:
$0.00013–0.00015 per 20-item call on OpenInference (fp4), $0.00028–0.00031 on Wafer, $0.0004–0.0012 elsewhere. With
`sort: "price"` on the card maker's model (ZDR kept), $0.0000144 per item pooled against $0.0000245 with default
routing (−41%). Together: about $0.0011 per user one-time and per user-month (50 items a day) against $0.0041 (−74%;
the track's $0.0010 was at 70.25 items).
Price routing cut off 40 of 657 items' batches at the output cap in the track's re-card (617 covered against 637 with
default routing); the enricher now sends a cut batch once more with default routing (`CardMakerOptions.retry`), under
its own reservation. At that rate the retries add about 6% of items at the default price, about $0.0001 per user
(arithmetic from the track's numbers, not a live run): about $0.0012 per user in all. A 20-item call's output cap is
4,000 tokens (200 per item past ten) and its reservation $0.003 (about $0.0024 at the cap on the list-price endpoint:
2,400 input tokens at $0.15/M, 4,000 output at $0.50/M). On D64's accounting the benchmark's card share would fall
from $0.156 to about $0.039 per 1,000 tasks, Eden ALL all-in from $0.474 to about $0.36 (an estimate, not a live run).

Sync push (D66) was deleted by D112.

The knowledge graph (`graph`, D58) and its judge seat were deleted by D225 (2026-11-07;
docs/research/fix-w2a-parts.md): no measured value on train with the paid reader replayed.

The action firewall (`actionCheck`, D69) was deleted by D815; the party check that `POST /v1/check` runs (D376) adds
no model call and no source call.

These are arithmetic on list prices, not measurements. Output is billed on tokens used, not the cap: a judge verdict
is a few tokens plus low-effort reasoning (about 20 tokens on GLM 5.3 Flash in a probe of three calls).

## Where 3x is impossible (and where it is not)

The audit's question for each cost and latency component: is a 3x cut left, on today's evidence? Each row names the
command or source that gives it. Rows marked **unverified** carry figures no command in the repo reproduces;
**estimate** rows are arithmetic. Commands are no-model and $0 (2026-11-03, audit 2026-11-03b, R3-18/19/20; this
closes R2-18).

**Reader latency is a fixed floor plus output decoding.** `bun packages/sim/src/lab/reader-latency-fit.ts` fits
`latency = floor + a × input tokens + b × output tokens` over the ten single-value train-screen rows of
docs/research/haiku-phase3.md: floor 364.9 ms, 0.006 ms per input token, 4.214 ms per output token (R² 0.988, max
error 34.9 ms). At prompt v7's shape (3,921 in, 188 out) that is 365 ms floor (31%), 24 ms input (2%) and 792 ms
output (67%). `--runs packages/sim/lab/haiku/phase3/funnel-reader-cost.txt` (19 runs) gives a higher floor: p50 =
534.7 ms + 0.0107 ms/input + 3.40 ms/output (R² 0.831, max error 122 ms); p90 = 1,325 ms + 0.0285/input +
1.96/output, R² 0.164, so the p90 fit is weak. Leaving out the one run that only replayed another (f7-AB20k) changes
the floor by under 5 ms. Both fits are run-level (they regress run medians, not calls), so the floor is a range,
365–535 ms. Per-call data settles it: reader replay lines now keep each call's input, cached input and output
tokens, `latencyMs` and, when the provider streamed the call, `ttftMs` (reader-disk.ts; counts and timings only),
and `--replay FILE.jsonl ...` fits per call, with cached input apart when the lines carry it.

**Eden on the agent's path is reader time (D165).** Measured with `bun packages/sim/src/lab/pi-ab-report.ts
.local/mkt/final-pi-4{1,2,3,4}.json` (2026-11-06, $0, its "Eden on the critical path by task kind" section): the
final live Pi run of the shipped default on held-out 13 (seeds 41-44, eden arm, Haiku 5.5 through the lab's
Anthropic-direct provider, `--time-scale 1`; docs/research/final-live-2026-11-05.md). Eden's time is the union of its
path spans (the blocking observe and the agent's `ask_context` calls); the reader is counted where it overlaps it.

| Task kind | Tasks | Wall mean | Eden on the path | Observe (push) | Asks     | Reader inside Eden's path | Wall if Eden took no time |
| --------- | ----- | --------- | ---------------- | -------------- | -------- | ------------------------- | ------------------------- |
| hidden    | 128   | 3,979 ms  | 1,372 ms (34.5%) | 920 ms         | 449 ms   | 1,297 ms (94.5%)          | 1.53x                     |
| control   | 128   | 5,344 ms  | 2,083 ms (39.0%) | 994 ms         | 1,078 ms | 1,925 ms (92.4%)          | 1.64x                     |

The same command's reader line: 441 calls, p50 998 ms, p90 1,471 ms, mean 1,088 ms, mean output 149 tokens; least
squares on each call's latency against its output tokens gives **702 ms + 2.60 ms per output token** (mean/floor
1.55x). That floor belongs to this run and endpoint: the train-screens fit above
(`packages/sim/src/lab/reader-latency-fit.test.ts:41`) gives about 365 ms + 4.21 ms per output token. So removing all
of Eden from the path caps task wall at 1.53x (hidden) and 1.64x (control), and a reader-only change that kept only
the floor would save at most (1,088 − 702) / 1,088 = 35.5% of the reader time on the path: 1,297 × 0.355 = 460 ms of
3,979 (1.13x) on hidden and 1,925 × 0.355 = 683 ms of 5,344 (1.15x) on control (**estimate**, arithmetic on the
measured rows). Hidden found on train is already about 72% (D165; not re-measured here), so a quality multiple is
read on misses, with decoys in pool beside it.

| Component                                                                                                                          | Best lever on file                                                                                           | Ceiling                                                                                                                                                                                                                                                                                                                                                                                                                      | Source                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Reader latency, any reader-only change while it emits a verdict                                                                    | everything but the floor                                                                                     | 3.24x p50 (fit a), 2.27x p50 and 1.36x p90 (fit b, weak)                                                                                                                                                                                                                                                                                                                                                                     | `reader-latency-fit.ts`, default and `--runs`                                                                                                                                                                                                    |
| Reader latency, input side (pool size, item chars, standing, markup)                                                               | shorter input                                                                                                | 24–42 ms of 1,190 (about 1.02–1.04x): a cost lever only                                                                                                                                                                                                                                                                                                                                                                      | the same fits at v7's shape                                                                                                                                                                                                                      |
| Reader latency and cost, terse reply (no output at all)                                                                            | a ceiling, **not a recommendation**: D96's reply carries the bearing the agent reads                         | latency at most the floor ratio above; cost 1.31x ($0.000094 output of $0.000401, haiku-phase3.md:93)                                                                                                                                                                                                                                                                                                                        | **estimate** from the fits and haiku-phase3.md:93                                                                                                                                                                                                |
| Reader calls, the shipped gate                                                                                                     | `readerGate`                                                                                                 | default 87 → 72 calls (1.21x, none of 16 gated held a needed item; 66 and 5 of 22, all `landlord`, before D124); history: NEW2 436 → 275 (1.59x, 29 of 163)                                                                                                                                                                                                                                                                  | `bun run gate-traffic` (2026-11-04); NEW2 at 51b55c9a8, before D112                                                                                                                                                                              |
| Reader calls, arranged visits open the gate                                                                                        | `readerGateVisits` (D124)                                                                                    | default 66 → 72 calls (+9.1%), missed-binding 0.227 → 0.000; live train (Pi, 768 tasks per arm) 1,156 → 1,158 reader calls                                                                                                                                                                                                                                                                                                   | `gate-traffic.ts` (2026-11-04); docs/research/live-checks-1104.md                                                                                                                                                                                |
| Reader calls, an oracle gate over any needed fact                                                                                  | perfect skip of pools with no needed item                                                                    | default-nogate 2.07x (42 calls), default 1.57x; history: NEW2 2.19x (199)                                                                                                                                                                                                                                                                                                                                                    | `bun run gate-traffic`, "oracle gate" line; NEW2 at 51b55c9a8                                                                                                                                                                                    |
| Reader calls, an oracle gate over reader facts only (constraint, blocker, paid)                                                    | perfect skip of pools with nothing the reader is for                                                         | default-nogate 3.63x (24 calls), default 2.75x; history: NEW2 8.90x (49 calls; 5.38x, 81 calls, counting reader facts the turn may use)                                                                                                                                                                                                                                                                                      | `bun run gate-traffic`, "oracle gate" line; NEW2 at 51b55c9a8                                                                                                                                                                                    |
| Reader calls, a verdict reused across one user's sessions                                                                          | cache by exact input / pool / same type and binding set                                                      | NEWL-nogate (now default-nogate) 1.10x / 1.18x / 1.61x; history: NEW2 1.27x / 1.50x / 2.19x                                                                                                                                                                                                                                                                                                                                  | `bun run gate-traffic --reuse` (2026-11-03); NEW2 at 51b55c9a8                                                                                                                                                                                   |
| Reader cost per call, whole input read from the prompt cache                                                                       | cached per-user prefix                                                                                       | about 3.0x: 3,921 × $0.01/M + 188 × $0.5/M = $0.000133 against $0.000401 (lab provider, cached)                                                                                                                                                                                                                                                                                                                              | **estimate**: ignores cache writes (1.25x, pricing.ts:21) and the focus-dependent request part                                                                                                                                                   |
| Reader cost per call, cheaper model endpoint                                                                                       | cheapest glm-5.3-flash endpoint                                                                              | under 2x on input ($0.0513/M against Haiku's $0.10/M); glm list price is dearer than Haiku                                                                                                                                                                                                                                                                                                                                   | packages/llm/src/pricing.ts:15, :20-22                                                                                                                                                                                                           |
| Sharing a verdict between push and ask                                                                                             | one cache                                                                                                    | none: the key hashes the request, the question and the items as read                                                                                                                                                                                                                                                                                                                                                         | packages/engine/src/reader.ts:262-270 (`readerKey`)                                                                                                                                                                                              |
| Reader cost, the items prompt-cached across calls (D164) | the ask's prompt starts with its push's whole prompt, question last | **estimate** about 1.17x on reader cost ($0.114 → about $0.097; the finding's figure), upper bound about 1.28x if every ask reused an identical push prompt within the cache's life; **measured**: the default never sets `standing` (prefix 0.0 chars on every suite), a task's calls share 2.88% of item characters as a prefix (1.72% sorted), 5 of 658 calls repeat an earlier call's item set (order ignored), items are 94.1% of the user message and 56.0% of the whole prompt (system 3,036 chars, already cached); Pi run reader 441 calls $0.114, 35.0% of input tokens cached (the system block), output 28.8% of reader cost. Not built: it would also change the prompt order quality was measured on | `bun run funnel --jobs 1 -- --reader stub --reader-log F` (2026-11-06, 658 calls; prefix shares from a python pass over F grouped by task, `i="n"` stripped); `eden.reader` rows of the four `final-pi-4N` runs in `.local/mkt/ledger.jsonl`; the estimates are the finding's arithmetic and D164's |
| Engine CPU on the fast path                                                                                                        | lazy `confident()` (stop at the cap, cheap tests first; audit 2026-11-05 `fastpath-assess-eager-unmemoized`) | before 3.762 / 3.190 / 3.441 ms per event, observe p50 213.3 / 179.6 / 193.2 µs, p99 18,145 / 16,132 / 15,836 µs; after 2.569 / 2.699 / 2.490 ms per event, p50 181.5 / 185.9 / 175.3 µs, p99 11,562 / 11,603 / 10,819 µs (means 3.464 → 2.586 ms, 1.34x per event); a reader call (p50 1,190 ms, above) still costs about 460x an event (1,190 / 2.586). The per-item analysis cache (the finding's part 2) is the next row | `bun packages/engine/bench/pipeline.bench.ts`, 3 interleaved pairs, base 9c4779fe5's partner.ts against this branch, shared 4-core box, load average 3.1-3.5 (2026-11-05). The old row (0.389 ms, p50 104.8 µs, p99 848 µs) no longer reproduces |
| Engine CPU on the fast path                                                                                                        | profile-guided work                                                                                          | per-item conflict analysis cache and fold's anchor exit (2026-11-05): steady observe p50 154/188 µs, p99 4.8/5.3 ms, 1.16/1.31 ms per event, against 166/166 µs, 14.1/14.8 ms, 3.01/3.08 ms before (two interleaved runs each, shared 4-core box at load 3); `assess` 50% → 13% of the CPU profile; the reader (1,190 ms) is about 10^3 times dearer                                                                         | `bun packages/engine/bench/pipeline.bench.ts`                                                                                                                                                                                                    |
| Total task cost with a free Eden (agent + Eden, reader only)                                                                       | Eden at $0                                                                                                   | Pi 2.55x ($0.638 total, $0.388 Eden, haiku-phase3.md:138), Hermes 1.78x ($0.628, $0.276, :145)                                                                                                                                                                                                                                                                                                                               | docs/research/haiku-phase3.md held-out 13 table                                                                                                                                                                                                  |
| Reader calls per task in the funnel (656 for 768 tasks under NEWL), background calls (1,796 against 300), compute per task ($4e-8) | –                                                                                                            | –                                                                                                                                                                                                                                                                                                                                                                                                                            | **unverified**: from audit scratch runs, no committed command                                                                                                                                                                                    |

What the table says:

- **Latency.** 3x on the reader itself needs a verdict of almost no tokens, so it is impossible while the reader
  answers with bearings. Input-side changes are cost levers with about zero latency effect. The routes to 3x on
  Eden's critical path all move the read off it: not waiting for it (the answer gate), starting it on drafts, or no
  separate reader call (agent-as-reader, a distilled no-model scorer). None of those is measured at $0.
- **Push off the start (D166, beside D118 and D156).** Not built. **Measured** (a python pass over
  `.local/mkt/final-pi-4{1,2,3,4}/tasks.jsonl`, eden arm, 2026-11-06, $0): 66 of 75 hidden tasks with a push that
  injected items made one agent request, so a push moved off the start has no later turn to land on; the first agent
  request starts at a mean 921 ms (hidden) and 994 ms (control), so the saving is at most that, 1.30x and 1.23x on
  wall (a ceiling). Request count is partly caused by the push, so D118's direct measurement decides: its off-path
  variant took hidden from 81.3% to 75.0% (docs/DECISIONS.md, not re-run). Reopen only for harnesses whose agents
  routinely make 3 or more model calls per task.
- **Ask reader overlapped with its poll and live search (D167).** Not built. **Measured** (the same pass): the 239
  `eden.sync.freshen` spans that start inside an `ask_context` call take a mean 17.5 ms, p90 0.1 ms, max 797 ms (D167's
  other count, every freshen span overlapping an ask, gives about 13 ms). The reader's pool comes from the live search
  (`partner.ts:1253`, `:1303-1309`), so starting it earlier reads a different pool; the overlap caps at 1.13-1.14x on
  ask batches and about 1.01x on task wall (**estimates** from D167's scripts over the same traces, not re-run).
- **Call count.** The earlier "an oracle gate caps at 2.2x" counted every needed fact, most of which are plain
  information (a meeting's time, an invoice's amount) the reader is not for. Counted over the facts the reader is for,
  an oracle gate cut NEW2's calls 5.4–8.9x on simulated sessions (history, NEW2 deleted by D112): a 3x on calls is not
  ruled out; the shipped gate's precision is what stands between: NEW2 + gate made 275 calls against the oracle's 49–81
  and still gates 36 need turns, 5 of them needing a reader fact (7 needing or able to use one). Two caveats: the
  reader-fact kinds are this lab's reading of the reader's prompt (gate-traffic.ts `READER_FACTS`), and a pool holding
  the item is not the reader binding it.
- **Need turns the default never reads.** Of the default's (NEWL's) 348 unread user messages, 178 are need turns: 26 of
  those need a reader fact and 62 need or can use one (gate-traffic's oracle line): a quality question for NEWL's
  "acting requests only" rule, not a cost lever.
- **Reuse.** A cross-session verdict cache reaches 1.27x on exact inputs and 2.19x only as an oracle memo (same type
  and same binding set); the sessions' requests are templated, so even these overstate real repeats. It is not worth
  a decision and an isolation test.
- **Total cost.** Even a free Eden cuts agent + Eden cost at most 2.55x (Pi) or 1.78x (Hermes): the agent's own model
  is the rest.

## Measured so far (tiny samples, not statistics)

- `bun run eval --live`, seed scenario, 8 turns, 2026-10-27: 1 model call, $0.0000162 total
  (`costPerTurnUsd` 0.00000202825), p95 observe latency 767 ms with `waitMs` 2000.
- Live judge in simulation, realistic, seeds 41–43, 2026-10-30 (D45): 0.186 model calls per turn, $0.010 per 1,000
  turns (about $0.000056 per judge call, OpenRouter's reported cost), delivery p95 3.5 s on seed 41 with the judge
  against 11 ms without (docs/research/live-judge.md).
- Server smoke test, one `ask`: $0.000013639431, 1,549 ms end to end, including the OpenRouter round trip.

## The shipped default's model roles (D112)

With `OPENROUTER_API_KEY` set, the shipped servers run the unified default with three model roles on
`EDEN_MODEL` (default `anthropic/claude-haiku-5.5` through OpenRouter, D12's routing): **cards** and the **intent**
requests in the background (one call per batch of new items, never per event), and the ask-time **reader** on the
request path (one call per acting request or ask that a candidate could constrain, `readerGate`; the push reads the
user's request, the ask its question). No judge is wired (the measured setup ran none). Each role has its own
`Budget` (20 calls and $0.02 per session, $0.25 per user per day) and all of a tenant's roles share one
`TenantSpend` cap per UTC day (`EDEN_MODEL_USD_PER_TENANT_DAY`, default $25). Over any cap the role is skipped and the
no-model path answers. Without a key nothing is called and the same default runs with no model, the push's
candidates included (they make no model call, D276). The HTTP server
runs `EDEN_PROCESSES` processes, by default the core count (capped at 64, D178), and each child holds 1/N of the
tenant cap (`tenantSpendFor`, D163): the $25 is a total only when a tenant's users spread over the children. A tenant
whose spend comes from one user, or a few on one child, is capped at $25/N a day ($6.25 on 4 cores, $0.39 on 64);
raise the cap or set `EDEN_PROCESSES=1` for it (docs/INTEGRATION.md, "Processes and per-tenant caps").

Per task (live, Pi harness, Haiku 5.5 as agent, grader and Eden's roles, all lab provider, cached (D145), blind
held-out 13, seeds 41–42, 64 hidden + 64 control tasks per condition, `--time-scale 1`; `.local/unify`, 2026-11-03, D112; the last row `.local/lc`,
2026-11-04, D123, docs/research/live-checks-1104.md, within run-to-run noise of D112's):

| Configuration                                 | Eden per-task calls, $/1k hidden / control | Background (cards + intent), $/1k tasks | Agent + Eden per-task, $/1k hidden / control |
| --------------------------------------------- | ------------------------------------------ | --------------------------------------- | -------------------------------------------- |
| Old shipped default (judge on the same model) | 0.055 / 0.056                              | 0                                       | 0.482 / 0.494                                |
| NEWL                                          | 0.384 / 0.474                              | 0.451                                   | 0.638 / 0.790                                |
| Unified default                               | 0.385 / 0.547                              | 0.451                                   | 0.667 / 0.900                                |
| Default after D114/D119, rerun (D123)         | 0.332 / 0.510                              | 0.459                                   | 0.577 / 0.830                                |

**After D125** (docs/research/cost-fixes.md; lab provider, cached; Pi, held-out 13, seeds 41–44, both market latency profiles, 512 Eden task
runs per arm, hidden and control pooled; per 1,000 tasks): the old default spent $0.318 on the agent, $0.448 on the
reader and $0.900 on cards and intent ($1.666); the default with `cardsLean` and `syncPush` spent $0.323, $0.458 and
$0.387 ($1.168, −30%). Cards are a cold-cache figure (every item of a fresh user, 64 tasks per user). Connector calls
are the other half of the cost on a per-call platform: Eden's sync made 3.8–5.1 listing calls per task, and 0.6–0.8 when
the integrator forwards notifications that carry their items (a static lab world, so no notification was sent: the sweep
and the 24 h safety poll; receiving notifications has its own cost, not counted here) (signal-only notifications:
3.7–4.7, since a busy inbox changes every hour). Priced per agent model and connector plan in
docs/research/cost-fixes.md and eden-market-effect.md.

**Freshness (D126, docs/research/freshness.md):** each re-read is one connector call, made only for an item read
before its source's latest signal-only notification: about 0.48 per agent turn in the simulation with signals, none
with item-carrying notifications or none at all (the live market runs: unchanged). Re-reading by age was measured at
+4.6 calls per task live and rejected; on a $12-per-1,000-calls platform that would have been about $55 per 1,000
tasks. A signal, an item-carrying notification or a deletion also drops the search pages Eden holds for that user's
source (`SourceFanout.dropResults`, held 60 s fresh), so the next lookup there searches again instead of reusing one:
at most one extra search per notification (not separately measured).

- Every dollar figure in these bullets is lab provider, cached (D145). The background column spreads each seed's card
  and intent spend over that seed's task runs; with only 64 tasks per
  simulated user it is mostly the one-time backfill, an upper bound on the steady state. In this run the checked-in
  card cache replayed 4,634 cards, so new cards and intent requests cost $0.058 (seed 41) and $0.057 (seed 42) for
  two partner conditions: about $0.03 per user per condition, a lower bound for a cold user.
- Per user, cold: the intent requests cost about $0.071 per user backfill (1,487.5 items at $0.0000510 an item,
  docs/research/new-minus-intent.md) on top of the cards (ALL3's card backfill was $0.106 per 1k Pi tasks on held-out
  13, docs/research/haiku-phase3.md). The per-user-day budget ($0.25) bounds a day's backfill.
- `intentConstraintOnly` (D170, a trial; **ended by D177**, switch and code deleted under D112): an item the card
  prefilter rejects was not read for its requests alone. It failed its own gate: a fresh-cache paired run on
  train1–6 seeds 41–42 (Haiku 5.5 reader live in both arms; ledger runs `close-d170-fresh-base`, 652 calls,
  $0.1864, and `close-d170-fresh-co`, 654 calls, $0.1866) gave hidden/decoys 286/140 (default) against 281/144
  (paired hidden −1.30 points, CI −4.17..+1.56; decoys +1.04, CI −1.82..+3.91); a top-up of the committed cache
  (`close-d170-co`, 269 calls, $0.0786) replayed 281/139 against 279/144. Decoys rose 4 and 5 tasks, beyond the
  gate's ±3, and hidden flagged by the reader fell (238 to 228, 234 to 226). The saving below stays unclaimed.
  (Those scores are the planning run's on 4503fabb6; the ledger rows are re-summed in this branch.) What it would
  have saved, measured at $0 (`bun run funnel --jobs 4 -- --intent <gunzipped intent-v2>`, train1–6 seeds 41–42,
  24 simulated users, 2026-11-06): items sent to the card model 13,604 to 2,113 (6.44x fewer; the 11,491
  request-only items go), calls 822 to 300 (2.74x); held-out 10–11 (`--blind`, measurement only) 4,514 to 650
  items and 266 to 98 calls.
  Estimated $, not measured (the funnel replays cards and intent): the 522 calls saved at $0.000445 a call (above) are
  $0.232 for the 24 users, and the 11,491 items at the intent figure of $0.0000501 an item are $0.576; so about
  $0.010–$0.024 per cold user's backfill. Scaled onto the post-D125 Pi background of $0.387 per 1k tasks by calls
  (300/822) or items (2,113/13,604), the background becomes about $0.141 or $0.060 per 1k tasks.
- Per task, larger sample (haiku-phase3.md, held-out 13 seeds 41–44): NEWL agent + reader $0.638 per 1k hidden Pi
  tasks ($0.744 all-in); traffic-weighted at one task in ten carrying a fact, Eden's own calls $0.518 per 1k (Pi) and
  $0.290 (Hermes).
- Each role's own budget is `DEFAULT_LIMITS` (as in the measured Pi setup): at the reader's $0.002 reservation that is
  about 10 reads per session, past which a long session's later requests take the no-model path.
- Reader calls are about 2,800 input tokens ($0.00028 priced uncached) and 200 output tokens ($0.0001) each on Haiku
  5.5 (haiku-phase3.md, lab provider, thinking off; D144 made "off" the shipped default); the budget reserves $0.002 a call (`DEFAULT_READER_LIMITS.estimateUsd`).

## Cards and intent over a user's lifetime (CL3, D242–D245)

Anthropic-direct lab figures (Haiku 5.5, `cold-start.ts` through `buildPartner`; docs/research/cl-cl3.md §7). A
user's background enrichment is a one-time backfill plus a daily trickle:

| | Default before D244 (30-day lean window) | Default since D244 (7 days) |
| --- | --- | --- |
| One-time backfill, measured (3 users) | $0.0208, 21.7 calls, 103 s to idle | $0.0088, 8 calls, 41 s to idle |
| Per day, estimate (≈ 36 new items a day, ≈ 10 sent to the card model) | ≈ $0.0005–0.0006 | the same (the window bounds only the backlog) |
| 30 days of use, estimate | ≈ $0.038 | ≈ $0.026 |
| Per 1,000 tasks at 12–20 requests a day for 30 days, estimate | ≈ $0.06–0.10 | ≈ $0.04–0.07 |

Short-horizon benchmarks that spread one user's backfill over that user's run overstate it: one user over 128 Pi tasks
is $0.162 per 1,000 tasks before D244 and $0.069 after. Not taken: the Message Batches API for the backlog (D242:
−45% of what is left, about $0.004 per user, at a 17–22 minute wait without cards, the state that costs most recall)
and two intent requests instead of four (D243: −7%, hidden facts lost). Prompt caching saves 10–28% of a card call
and about 23% of a reader call on the Anthropic transport; on OpenRouter the cache is off until D145's probe.

### The two Haiku calls that stay: where their price is (H2, D1050–D1054; docs/research/h2-haiku-lean.md)

Anthropic-direct lab figures, Haiku 5.5, thinking off.

- **Push check** (train seeds 42–43, 1,121 calls): $0.000232 a call, 2,738 input tokens (1,184 cached: the
  instructions, shared by every user) and 128 output; p50 0.92 s, p90 1.34 s, time to first token 0.45 s. The items
  are about two thirds of its price, the output about a quarter. A pool of 10 items of 140 characters cut $ a call
  26.5% ($0.000171) and handed 20 fewer facts of 384 (D1050). The push reaches the call about 9 ms after the request,
  so the wait is the call itself.
- **Card-and-intent call** (400 items, batches of 20): $0.000073 a item, 201 input tokens a item (66 cached) and 118
  output: **output is about 80% of its price.** On batches whose reply lists requests, batches of 40 cost the same a
  item; a compact reply (no key names) 27% less (D1052). Neither is taken. The shipped prompt leaves the requests
  list out of about a quarter of its replies (D1053), so its price per item given requests is about a third higher
  than its price per item sent. A requests-only call (no cards) costs 45% less an item, 57% with a compact reply.
- **Every item read for intent** (`cardsLean` false; D1053): a heavy user's backfill (about 1,500 items) is 74 calls
  and $0.058–0.060 against 7 calls and $0.0074–0.0080, with 70–74 s to idle against 3.5–6.3 s; about $0.000040 a
  item sent. At 50 new items a day **[EST]** about +$0.04 a user-month after a one-time +$0.051. Not taken: the same
  requests on every item read no more facts than the lean selection's (funnel), see D1053 for the live pair.

### The card prompt's requests fix (`cardsRequestsFix`, D1060, D1062; docs/research/h2-requests-fix.md)

Anthropic-direct lab figures, Haiku 5.5, thinking off. The shipped enricher's card calls with the fix, over the 84
worlds of train1–6 and longtail × seeds 41–44 × hidden, control and neutral (`cold-start.ts`): $0.63, $0.0075 a world
against P7's $0.0070 with the old prompt (+8%), 581 calls of which 17 re-asks (2.9%), 97.7% of items sent given
requests. A call writes more because more items get requests: on H2's 400 items $0.0000770 against $0.0000766 a item
over the batches that list requests, and 379 against 260 items given requests (D1053). A re-ask is one
requests-only call for a batch, reserved on the enricher's `Budget` like a card call (about $0.0008 for 20 items
**[EST]**: R20's $0.0000419 an item). Per user-month **[EST]**: about +8% of the background card spend (COST-MODEL's
$0.026 first month, about +$0.002). Pi (agent and Eden per task): −$0.001 per 1,000 tasks (−0.008..+0.006), wall
−0.007 s.

## Budget defaults (`packages/llm/src/budget.ts`)

20 calls and $0.02 per session; $0.25 per user per day; each call reserved before its real cost is known, at about its
worst case at the cap: $0.0005 for the judge, $0.0015 for a model-composed ask answer (D45). Over budget, the engine
takes the no-model path; it never defers spend.

## How live cost is reported (D71)

OpenRouter spreads one model over many endpoints up to 10× apart in price, and the mix moved with the condition within
one concurrent run (D64's runs: the cheapest fp4 endpoint served 29% of no-tool requests, 21% of the Eden agent's and
9% of the five-tool agent's; docs/research/econ-research.md §1.1). So a live comparison reports agent cost twice: as
billed, which is what a tenant pays, and re-priced at fixed prices (Z.AI's list price and Wafer-us), with each
condition's inferred endpoint mix (`reprice.ts`, printed by `pi-ab-report.ts`). A claim that one condition costs less
holds only if it holds re-priced. Re-priced, D64's Eden agent (ALL) costs 20–23% less than the tools agent ($0.770
against $0.998 per 1,000 tasks at Z.AI list, $0.272 against $0.342 at Wafer-us), where billed it looked equal ($0.318
against $0.320). The grader is reported separately and never counts in all-in. The fixed prices are a snapshot from
2026-10-31.

What a tenant's own agent costs depends mostly on the agent: in D64, 85% of its model time is output tokens, and each
`ask_context` round trip is one more model request. Removing the ask (D70, rejected) saved $0.070 per 1,000 tasks
(−27%) but lost 0.12 of hidden facts raised (in-sample). docs/INTEGRATION.md collects the agent-side levers; they are
unmeasured advice.

## The agent's extra tokens under the candidates default (A3, D271–D273)

With no reader call on the path (D237), Eden's per-task cost to a tenant is the agent's own: the packet (about 1 KB on
a nothing-to-add request, 1.4–1.6 KB on one with something to add) and `ask_context` answers (816–964 bytes an ask,
0.33–0.70 asks a task one request at a time, 0.04–0.06 over days) enter the agent's prompt, are written to its cache
once (1.25x input) and read back on later requests (0.1x). Measured on Pi with a prompt that caches in every arm
(train, Anthropic Haiku, lab figures; docs/research/a3-cost-speed.md): Eden writes 865 vs 318 tokens a nothing-to-add
task one request at a time and 629 vs 262 over days; $ per 1,000 tasks on the 1:1:8 mix +0.060 (+0.042..+0.078) and
+0.080 (+0.065..+0.095) against the agent alone, while Eden saves model turns (wall −0.96 s and −0.42 s); rerun on
the tree merged with A4/A6, +0.047 (+0.029..+0.065) and +0.050 (+0.035..+0.065), −0.95 s and −0.65 s. **With the
connectors' own per-call fees counted** (`pi-cost-report.ts`, `CONNECTOR_PLANS`), Eden is cheaper than the agent
alone on every paid plan, because it replaces the agent's 1.0–2.2 tool calls a task with 0–0.16 of its own: over a
user's days, all-in, −$0.17 per 1,000 tasks on Composio, −$0.50 on Unified.to, −$7.2 on Arcade.dev, −$18.7 on Zapier
MCP (docs/research/a3-cost-speed.md §12). Cuts of
packet or ask bytes by lexical anchoring drop planted facts or move the bytes into the ask (D258, D273): the packet's
bytes are what recall costs. An agent with a fixed prompt under the provider's cache minimum (512 tokens on Haiku 5.5)
pays its whole prompt as a cache write on every task; Pi's minimal Eden agent did (D260, D271).

**What the packet costs the agent now (E1, D1030–D1032; docs/research/e1-lean.md; Anthropic-direct lab figures).** With
the push check in the default, over a user's days (`pi-ab --days 8`, Haiku 5.5 agent, users 105–120): 0.78–0.80
packets a task of 516–544 B (206–223 B fixed envelope and lead, 310–321 B items), and the day's re-read packets about
950 of the agent's 5,600 prompt tokens a task (17%, 4 characters a token **[EST]**). Saying the lead once a session cut
the fixed bytes 32% and the agent's prompt tokens about 93 a task (−1.7%; $ −0.002 to −0.004 per 1,000 tasks), and
dropping item boilerplate 3% of item bytes; both were deleted for their hidden-fact readings (D1031, D1032). No no-model
cut of the packet is left that moves the agent's bill by more than a few percent: the items are what recall costs.

## The push check (I3, `pushCheck`, a trial; D500–D504)

A per-push model call, so it needs this estimate (CLAUDE.md, "model last"). One Haiku 5.5 call a push over the whole
pool (`push-check.ts`), only when the pool is constraint-like (the candidates' own gate), thinking off, a fixed
~890-token instruction block first, then the request and at most 15 items of at most 200 characters; output a few
short entries cut by a stop sequence; budgeted at $0.001 a call on its own `Budget` (20 calls and $0.02 a session,
$0.25 a user-day, and the tenant's shared cap). Measured (funnel, train seeds 41–42 with neutral tasks, 1,152 tasks,
Anthropic direct, lab provider, cached; docs/research/i3-push-check.md §2): **0.82 calls a task** (944, exactly the
pushes the default hands candidates on; a second pass reuses the first's answer), **$0.000202 a call** (2,467 input
tokens of which 894 read from the cache, 71 output), p50 886 ms and p90 1,190 ms as made. So **about $0.17 per
1,000 tasks** on the train mix **[EST: calls × price]**, before any change in the agent's own spend (fewer packets on
neutral and control requests: 309 → 110 and 318 → 220 of 384 in that screen). Through OpenRouter (the servers'
route) no cache breakpoint is sent (D145), so the instructions are paid in full: about +$0.00008 a call **[EST]**,
about $0.23 per 1,000 tasks. **Live (Pi, train seeds 41–48, D503, lab provider, cached):** 0.82–0.83 calls a task,
$0.0002 a call, Eden's check $0.161–0.164 per 1,000 tasks; total steady state on a 1:1:8 user over 8 days $0.247 →
$0.359 (+$0.112; the agent itself −$0.030 from smaller packets), one request at a time $0.252 → $0.406; and +0.7 to
+0.9 s on every task's wall (the push waits on the call). Kept off (D504): i3-push-check.md §4–§5.

## A per-push "changes what to do" check (N2, D510–D514; a trial, off, not shipped)

N2 measured the push with one Haiku 5.5 call that reads the request and the pool and says which items change what the
agent should do (docs/research/n2-recall.md; Anthropic-direct lab figures, I2's prompt with a 12-word reason per
item). On the ledger: **$0.00115 a check at thinking effort low** (about 27 items; on Pi p50 5.5–5.9 s, p90 7.2–7.9 s),
$0.00053 (about 15 items) and $0.00089 (about 27) with no thinking (p50 3.5 s, but it passed 82% of the pool's
look-alikes and failed the widening screen). On Pi one request a session the push ran a check on 816 of 960 tasks:
**+$0.98 per 1,000 tasks** for the check against the agent's $0.312 per 1,000 (the bench report's $ column), about
three times the agent, and +5.1 s of wall a task while the agent waits for it (`@w12000`); over days +$0.80 per
1,000. It is a per-event model call: shipping it needs its own decision (D4, D5), a `Budget` and a smaller, faster
request, measured again before any promotion: **[EST]** I3's short-reply request with thinking at effort low, about
300 output tokens, 2–3 s and $0.0004 a call (n2-recall.md §8). I3's no-thinking check (D500–D502) is the cheap end:
$0.0002 a call, p50 0.9 s, which cannot gate a widened pool (D511).

## The push check (in the default since D828; N5 and P2 measurements, D527–D536, D825, D826)

The per-push call of I3's check with another reply (docs/research/n5-widen-check.md): the same fixed instructions
plus a compare-first format (about 1,185 tokens, read from the cache on Anthropic direct), the request and at most 20
items of 200 characters, no thinking, no stop sequence, output capped at 500 tokens; one call a push through the
check's own `Budget` ($0.001 reserved a call). Measured on Pi (train seeds 41–48, lab provider, cached; 14,194
calls): **$0.00023–0.00026 a call** (about 2,950 input tokens of which 1,185 cached, 116–143 output), p50 0.96–1.04 s,
p90 1.44–1.52 s.

| Arm (per 1,000 tasks, 1:1:8) | Calls a task | Check $ | Total $ against the default (short; days) | Wait a task (short; days) |
| --- | --- | --- | --- | --- |
| every gated push, with `pushWiden` (K) | 0.81–0.83 | 0.21–0.22 | +0.214; +0.173 | +1.06 s; +0.85 s |
| every gated push (Kp) | 0.81–0.83 | 0.18–0.19 | +0.183; +0.156 | +1.04 s; +0.88 s |
| `pushCheckAnchored`, `pushCheckSilent` off (N) | 0.30; 0.40 | 0.07; 0.09 | +0.043; +0.083 | +0.31 s; +0.41 s |
| N with `pushCheckOpen`, wait 1,500 ms (P2's N) | 0.35; 0.48 | 0.08; 0.11 | +0.050; +0.103 | +0.32 s; +0.57 s |
| Kp with `pushCheckOpen`, wait 1,500 ms (P2's S) | 0.96; 0.99 | 0.21; 0.22 | +0.213; +0.178 | +1.09 s; +1.15 s |

**In the default (D828) is P2's S row:** with a Haiku 5.5 agent +$0.21 per 1,000 tasks one request a session (1:1:8)
and +$0.18 over days, +1.1 s a task; **with a Sonnet 5.5 agent the total bill falls $0.86 per 1,000 tasks
(−1.24..−0.59) over days**, wall +0.57 s (D826): the agent carries 67% fewer packet characters all day. The other rows
are measured arms whose switches were deleted (D828). A server with no model key makes no check call.

P2 (docs/research/p2-push-check.md, D823): checking the open shape's pushes too, so the call rate rises
by about a sixth (funnel, seeds 42–43: 470 → 565 calls a seed). Over days the silent arm (S) cuts the packet
characters the agent carries all day by 57% and its prompt tokens by 1,731 a task: the Haiku agent's own bill falls
$0.242 → $0.198 per 1,000 tasks; the same tokens priced at Sonnet's rates **[EST]** fall $4.17 → $3.46.

The agent's own spend is flat to lower with the check (−$0.01 to −$0.05 per 1,000 tasks over days: smaller packets
in the day's transcript); a silent push adds agent turns one request a session (`ask_context` +0.30 a task, D532).
Through OpenRouter with no cache breakpoint (D145) the instructions are paid in full: about +$0.0001 a call
**[EST]**. Asking the check's question once per item at ingest (rejected, D526) cost $0.000053–0.000055 an item on
Haiku 5.5 at effort low, 12 items a call: about $0.12 per 1,000 tasks at 36 new items and 16 requests a day
**[EST]**, half by Message Batches. Thinking at effort low on I3's short reply: $0.00036 and 2.0 s a call (D528).

## Connector calls at about 1,000 sources and the earn rule (O1, D603)

No model call. With `sourceYieldEarn`, `sourceYieldNames` and `sourceYieldEngage` in the default (Pi, train, 995
noise connectors with words of their own, Anthropic-direct lab figures, measured before `pushOpen` (D710);
docs/research/o1-earn.md §2e): Eden's
connector calls 23.3 → 5.5 a task one request a session and 7.3 → 2.4 over a user's eight days (8.3 → 1.9 on 24
more users); agent + Eden $ per 1,000 tasks level (+0.002, −0.002..+0.006); steady first-party with background
cards 0.581 → 0.331 short and 0.386 → 0.296 over days (the unrelated connectors' items no longer reach the card
model); on a per-call plan at list prices (assumed), Zapier MCP $645 → $175 short and $213 → $77 over days. The
backfill (about 1,005 listings a new user, once) and the weekly sweep of unused sources (D356) are unchanged. Its
own costs: `RareTerms`, at most 1 MB a user (+0.72 MB at 1,000 sources in the lab; it lives with the sync, not
in the frozen blob, so freezing a user does not shrink it until the sync drops the user after `syncDropMs`), and 3–5 µs a new word on the
sync's store path (30–70 ms for a page of 100 items of 150 new words each).

## `ask_context` through the proxy (D851, opt-in `askTool`, off unless set; D857)

With `EDEN_PROXY_ASK=1` the proxy adds Eden's `ask_context` to the model's tools and answers the calls itself. Each
round the model asks is one more upstream model call on the tenant's own bill (the conversation so far plus the
round), and one `/v1/ask` per question (at most four a round, three rounds a request). On the shipped default an ask
makes no model call (D237: the candidates; Eden's time about 5 ms at p50, D64); with the reader's configuration each
ask may make one reader call under its own `Budget`. D70 measured the SDK arm without the tool at 27% lower agent
cost and 11.9 points fewer hidden facts raised; the proxy's figure is not measured (docs/research/p5-integrator.md
§4b). A streamed asking round is buffered, so the agent's first token waits for the rounds.

## Hosting: our cost and the tenant's, per heavy user (D1, D990-D994)

A **heavy user**: a daily agent (Hermes, say) making about 50 requests a day (1,500 a month), 20 connectors, at the
3,000-item cap. Sized for the **peak hour**, when every heavy user of a tenant is active within 30 minutes, a sixth
live and the rest warm: **5.29 MB of RSS a user, measured** (`users.bench.ts 200 3000 --prose --sources=20 --waves=6
--warm-waves=5`, the 2-core 12 GB budget; docs/research/d1-scale-out.md §1). Users per box by
`deploy/scripts/sizing.py` (75% of RAM, 70 MB a process, 60 MB of micro-model weights a process): 1,643 on 2 OCPU /
12 GB, 3,296 on 4 / 24, 8,871 on 64 GB (8 processes), 17,753 on 128 GB (16). Prices read 2026-11-11
(docs/research/d1-providers.md; EUR at 1.1127; **check at signup**).

**(a) Our cost per heavy user-month** (no model key: the shipped no-model path, $0 a call):

| | 1,000 users | 10,000 users | 100,000 users |
| --- | --- | --- | --- |
| Machines | 1 Hetzner AX41-class, 64 GB ($66) | 3 x AX41-class (one can fail: 2 hold 17,742) ($197) | 7 x AX102-class, 128 GB (6 hold 106,518; one spare) ($1,238) |
| Load balancer | none (Caddy on the box) | Hetzner LB11 $8.33 | LB11 $8.33 **[traffic allowance unverified]**, or DNS over two routers, $0 |
| Shared store (cluster) / backups | Hetzner Object Storage $7.22 (backups) | $7.22 (blobs about 27 GB, 1 TB included) | $7.22 (blobs about 270 GB; requests free) |
| Disk | the servers' NVMe (persisted files about 1.2-2.7 MB a user) | included | included |
| Bandwidth | included (dedicated: unmetered 1 Gbit/s) | included | included |
| Monitoring | Grafana Cloud free tier **[unverified terms]** | free (about 1,500 series) | free (about 3,500 series) |
| Cluster router | none | on two of the nodes (no state, little CPU) | on two of the nodes |
| **Total a month** | **$73** | **$213** | **$1,254** |
| **Per heavy user-month** | **$0.073** | **$0.021** | **$0.0125** |
| Free start instead | Oracle Always Free A1 2 / 12 GB: $0 for up to about 1,600 heavy users (reclamation, capacity and suspension risks: docs/DEPLOY.md §2.1) | | |
| Fallback host | Oracle paid A1 4 / 24 GB $55.48 (3,296 users) | 4 x A1 4/24 ($222) | about 31 x A1 4/24 or 8 x A1 16 OCPU / 128 GB ($257 each: $2,056) **[EST]** |

Per box, **[EST]** for everything but the RSS: CPU is not the bound (100,000 heavy users at 50 requests a day is 58
requests a second over 7 machines; an event costs about 10-12 ms at p50 on the fast path); the store's writes are
one per idle period (about 5-10 a heavy user a day **[EST]**), free at Hetzner and OVH, about $0.0007-0.0014 a user
a month at Cloudflare R2's $4.50 a million; bandwidth about 0.1-0.2 GB a heavy user a month **[EST]** (events and
packets of a few KB, connector listings), inside every plan above except Oracle past its free 10 TB ($0.0085/GB).

**Eden's model calls today** (with `OPENROUTER_API_KEY`, Haiku 5.5), per heavy user-month **[EST]** from the
measured per-call figures above: the push check on about 0.97 of requests at $0.00023-0.00026 a call ($0.33-0.38) and
cards and intent at about $0.026 a month (the 36-new-items-a-day estimate): **about $0.36-0.41**, 5 to 30 times the
hosting cost. The plan is micro CPU models in every role at $0 a call, their weights inside the RSS budget above;
on main at this writing four were stopped on their pre-registered rules (the push check M1, D982; intent M11, D970;
supersession M3b, D914; the packet trimmer M6, D920) and cards (M10) and the source router (M8) were not in yet.
Until a role lands, a deployment either runs that role on Haiku (the figure above) or runs without a key, the no-model
default (eval 0.65 / 0.52 / 0), at $0.

**(b) The tenant's cost per heavy user-month** (paid by the tenant, not by us):

- **Connector calls.** Over a user's days the agent alone made 0.89 tool calls a request and Eden-equipped agents
  0.16 of Eden's (5 sources, a3-cost-speed.md §11); at about 1,000 sources Eden made 2.4 a request with the earn
  rule (O1). For 20 connectors **[EST]**: about 1,300-3,300 calls a month with the agent's own search (0.89-2.2 a
  request) against about 300-1,200 with Eden (0.2-0.8 a request, background listings and the backfill included).
  Priced at `CONNECTOR_PLANS`' list prices ($ per 1,000 calls; assumed, from market.py):

  | Plan | Agent alone (1,300-3,300 calls) | With Eden (300-1,200 calls) |
  | --- | --- | --- |
  | First-party APIs (quota only) | $0 | $0 |
  | Composio ($0.30) | $0.39-0.99 | $0.09-0.36 |
  | Unified.to ($0.75) | $0.98-2.48 | $0.23-0.90 |
  | Arcade.dev ($10) | $13-33 | $3-12 |
  | Pipedream Connect ($12) | $16-40 | $3.6-14 |
  | Zapier MCP ($25.8) | $34-85 | $7.7-31 |

- **The agent's tokens.** Measured per 1,000 tasks on the lab's cached Pi agent (a3-cost-speed.md, p2-push-check.md):
  a Haiku 5.5 agent's own bill is about $0.18-0.25 per 1,000 requests, so $0.27-0.37 per heavy user-month; Eden's
  packets add $0.05-0.07 per 1,000 requests without a model key (+$0.08-0.10 a month). A Sonnet 5.5 agent is about
  $3.5-4.2 per 1,000 requests **[EST, priced from the Haiku tokens]**, $5.2-6.3 a month; with the push check (a model
  key) its bill falls $0.86 per 1,000 requests over days (D826). Lab tasks are short: a production agent's prompts
  (system prompt, tools, history) are larger, and its own bill scales with them, not with Eden.

So at 10,000 heavy users our hosting is about 2 cents a user a month, under a tenth of what today's model roles
would cost, and small beside the tenant's own agent tokens and any per-call connector plan, where Eden's fewer
calls are the larger effect.

## Levers, in order of leverage

1. Fewer model calls: better cheap scoring (M1 tuning), the graph (M3; deleted by D225), learned silence. Done so far: ask answers
   without a model by default (D43), which halved model calls per turn in simulation (realistic, perfect judge, seeds
   31–40: 0.378 to 0.198; cost per 1,000 turns $0.027 to $0.014) with recall, precision and ask retrieval unchanged.
   Grounding the no-model path in people and days (D44) adds no model call: with the perfect judge, model calls per turn
   are identical to main on every mix. A rule that skipped the judge for weak candidate sets was measured and rejected
   ([research/model-calls.md](research/model-calls.md)). `judgeTied` (D54, in the default since D112) skips the judge
   only when no candidate is tied to the request (a probe's find, a day it names, two of its words, or one word rare in
   the user's items): simulation, perfect judge, realistic seeds 41–44, on G (D54): model calls per turn 0.253 → 0.212,
   $0.02025 → $0.0170 per 1,000 turns at recall 0.647 → 0.643 ([research/judge-tied.md](research/judge-tied.md), before
   review). With D55's final H: 0.213 model calls per turn, $0.0172 per 1,000 turns, recall 0.645.
   `decideConflict` (D67) was deleted by D112; what it measured (docs/research/econ-decide.md): with no model call it
   re-read the ranked candidates with the engine's own conflict test only when no model decided (+1.6 ms of slow-path
   CPU per task in the track's in-sample funnel, measured before it also ran on the fast path's cached answers), at
   +0.06 delivered items per hidden task (a few dozen agent input tokens). The logistic decision model it was measured
   beside (+5.5 ms) was in the lab.
2. Smaller inputs: shorter windows, candidate snippets, prompt-cache-friendly prompt layout (stable system prefix).
3. Cheaper model: a fine-tuned small judge (M6).

Probes (D46, in the default since D112) add no model call but roughly double source calls per lookup in simulation
(5.4–5.6 → 11.4–11.8; 8.7–9.1 with `probeWhen: "actions"`, never in the default; the 2026-11-04 audit's
`engine-dead-switches` package deleted it, D121), within `probeCalls` (8) per lookup; with a judge, model calls per
turn rise by 0.01–0.03 (more lookups have candidates). For the agent, Eden with probes in place of search tools cost
less per task than the tools did ($0.327 against $0.354 per 1,000 held-out tasks; docs/research/probes.md).

D47 (docs/research/lean-probes.md), simulation, realistic, 4 seeds, perfect judge: compaction lowers model cost per turn
($0.0203 → $0.0180 per 1,000 turns with probes: the judge reads compacted candidates) and the agent's cost per task
(live held-out, $0.407 → $0.392 per 1,000 tasks). `judgeConfident` was deleted by D112; what it measured: a judge call
added on lookups whose candidates all scored as sure, model calls per turn 0.21 → 0.28 and $0.0180 → $0.0245 per 1,000
turns with probes and compaction (about +36%). Live, Eden with probes cost $0.407 per 1,000 held-out tasks against
$0.370 for tools (the agent's tokens fall, 3,045 → 1,714 input, but Eden's judge calls are added).

`packetDates` (D68) was deleted by D112; what it measured: with no model call and no state it kept the year compaction
dropped and added an event's start. In-sample funnel (ALL, cards-v2 replayed, hidden and held-out 1–4, seeds 41–44, that
session): hidden packet bytes 105,331 → 106,993 over 268 tasks (+1.6%, about 6 bytes or 1–2 agent input tokens a task),
control 41,560 → 42,495. A start with a time is 35 bytes (about 9 tokens); 14 of 536 tasks have one. The judge's
candidates were compacted without it, so the judge's input was unchanged. With the flag on, each delivery was rendered a
second time without it for usage learning (`usageText`): linear in the packet, no model call.

D76–D78 (proposed, docs/research/gen-tokens.md; `compactAsk`, `askDedup`, `compactParts`, in the default since D112)
makes no model
call. No-model funnel, ALL, one ask per task, this session: bytes the agent reads per task 1,528 → 900 in-sample and
1,328 → 801 on dev6a/dev6b (ask answers 1,254 → 625 and 1,195 → 669), every task's delivered and askCited unchanged.
At 4 bytes a token and $0.053 per million input tokens that is about −$0.008 per 1,000 tasks, per read of each
packet and answer (an agent re-sending its context on later turns multiplies it). With `cardsEconomy` card sends fall
54–55% and card calls 48–49% (replayed; about −$0.019 per 1,000 tasks scaled from the measured $0.036, an estimate).
`askDedup` keeps per session the words each item's line showed (at most 64 items).

D48 (docs/research/sharper-grounds.md): shared calls and the topic probe only without people take probes from 11.8 to
7.9 source calls per lookup (simulation; baseline 5.6). `judgeContested` adds judge calls (0.21 → 0.25 per turn),
offset by 200-byte judge candidates: $0.0200 against probes' $0.0203 per 1,000 turns. Live, one run: Eden with D48's
settings $0.357, tools $0.329, Eden beside tools $0.329 per 1,000 held-out tasks; Eden's judge is about $0.034 of that
(live judge funnel). A cheaper judge model (mistral-nemo, $0.0097 per 1,000 tasks) let more decoys through.

D49–D53 (docs/research/combined-config.md): the conflict ground, the probe economy and dense packets add no model call.
With them (D53's configuration), simulation, realistic, 4 seeds, perfect judge: 7.79 source calls per lookup (F 7.86),
model calls per turn 0.253 (0.251), $0.02025 per 1,000 turns (F $0.0200), 433 bytes per needed fact (484). The probe
economy starts cold for each new user, so a user's first lookups make the wider calls `probeYield` sends before it has
learned which to skip (8.4 calls per task in the per-task funnel, which builds a new engine each task). The register's
background sweep (D51) added calls (10.4 per task) and was removed with it.

D57 (background sync, "Eden Atlas", `sync`, in the default since D112; docs/research/moon-sync.md) adds no model call:
the
sync makes listing calls only. With a judge it raises model cost, because the judge sees more candidates: simulation,
realistic, seeds 41–44, perfect judge, $0.0170 (H) → $0.0222–0.0223 (HA, two runs) per 1,000 turns (+31%), at the same input caps
(≤ 6 candidates of ≤ 200 bytes, ≤ 4k characters of window). Source calls fall: 7.78 → 0.86 request-time calls per
lookup, 1.72 with backfill and background amortised; in the per-task funnel, 8.5 → 3.04 per task (4.38 amortised).
A synced user costs about 4 MB of heap per ~1,500 items and ~200 ms of CPU to backfill (`sync-cost.ts`, the sync track's
measurement, not re-run). The combined funnel implies more, about 420 ms per user (16.9 s of extra process CPU over 40
users with ALL), because there the graph and the cards are built on every synced item too (below).

The shipped ingest path, measured (2026-11-05, after D150; docs/research/graph-ablation.md): `ingest.bench.ts` times the
cache's own work (its `core` line) and the same backfill through a `ContextPartner` on `DEFAULT_CONFIG` with no model
(its `shipped` line), 200 users × 500 items of 1,599 chars on average. Two full runs of
`bun packages/engine/bench/ingest.bench.ts` at a0e4da57e (shared 4-core box): `core` 68.7 and 65.1 µs per backfilled
item, 2,562 B of heap per item; `shipped` 261.8 and 258.9 µs and 4,218-4,223 B per item (3.81x and 3.98x the CPU, 1.65x
the heap). Of the difference, the graph's add (`+graph`) is 86.2 and 90.3 µs and 1,662-1,663 B per item, and recording
mentions in the source map (`+onStored`) 106.9 and 103.5 µs (SQLite, outside the heap). Re-listing unchanged items stays
3.9-5.1 µs per item. Before D150 the graph read 4,000 characters per item and the same bench gave `shipped` 358-381 µs
and 5.2-5.4x `core`, the graph's add 182-192 µs and 2.6 KB; D150 cut the read to 1,000 characters with every train
screen identical, which closed the planned `graphLite` trial with no switch. Arithmetic, not measured: a cold restart
that backfills 10,000 users × 3,000 items at about 260 µs each is about 7,800 CPU-seconds per process, about a third of
it the graph. The graph adds no paid call; the paid-reader funnel credits it with 4 more hidden facts surfaced of 384
(and 2 more decoys), so D141 kept it. D225 (2026-11-07; docs/research/fix-w2a-parts.md) deleted it: with the paid
reader replayed after a top-up it read 317/131 without it against 314/132, so `shipped` no longer pays the `+graph`
share and the figures above that include it are history.

Anticipation (D60, `anticipate`) was deleted by D227 (2026-11-07; docs/research/fix-w2a-parts.md): its prefetches
were 0.5 source calls a task (16% of request-time calls) with no measured gain on train with the paid reader
replayed; without it the default makes 2.7 rather than 3.2 connector calls a task.

Combined (proposed D62, docs/research/moonshots.md; history: `graph`, `graphMerge` and `anticipate` were deleted by
D225 and D227; one session, in-sample, realistic seeds 41–44, perfect judge
modelled): R (H + `consequenceProbe`, `probeRoles`, `graph`, `graphMerge`, `cards`, `anticipate`) costs $0.0195 per
1,000 turns against H's $0.0170 (+15%), 0.231 model calls per turn (0.213), 7.88 source calls per lookup (7.78; 8.76
with no model); in the per-task funnel 9.94 calls per task against 8.49 (a draft's prefetch and the class query). R +
`sync` (ALL) costs $0.0243 (+43%, the judge sees more tied candidates) at 1.25 request-time calls per lookup, 2.10
with the sync's backfill and background; in the funnel 5.55 request-time calls per task, 6.89 amortised, with 18
listing calls to backfill each simulated user. Cards add the background enrichment above: on the blind suites' new
items this session, 41 calls at $0.000212 each ($0.0087), consistent with $0.003–0.004 per user-month at 50 new items
a day. Process CPU in the funnel (40 simulated users) rises 7.8 s → 24.7 s with ALL. The sync's backfill redacting
and recording mentions for every listed item is about a third of the rise (`sanitize` 2.9 s, `mentions` 2.4 s in the
telemetry spans), and the graph about 35% (the review's runs: ALL 31.5 s, ALL − `graph` 24.3 s; not re-run here).
The graph's build cost, measured after the review (D63; 20 users with full caches of 2,000 realistic items each):
heap 3.38 → 8.16 MB per user and cache-put CPU 120 → 361 ms per 2,000 items, about 48 GB more heap at the cache's
10,000 users per tenant. Request-time engine CPU stays under 1 ms per lookup at p50 for the graph walk and card
matching. (History: the graph was deleted by D225 on 2026-11-07, and its build cost with it.)

The judge, measured on ALL (D65, docs/research/econ-judge.md; in-sample). On the critical path it adds no facts and
costs time: in the full benchmark (D64), in-sample, paired, eden-judge − eden is −0.026 hidden at +1.10 s and +$0.039
per 1,000 tasks, so the recommended configuration has no judge (and the shipped servers wire none, D112).
`judgeBehind`, which moved it behind the no-model answer, was deleted by D112. What it measured, for the record: one
bounded judge call (the judge's caps and `Budget`) on a lookup whose no-model answer left candidates out:

- funnel, seed 41: 0.93 calls per task, $0.0088 for 134 tasks ($0.066 per 1,000 tasks);
- live, seed 43: 0.90 calls per task, about $0.000024 a call (OpenRouter's reported cost), $0.017–0.022 per 1,000
  tasks against the judge on the path's $0.023.

At 20 tasks a user a day, that is about $0.012–0.040 per user-month. `syncPollBehind` (in the default since D112) makes
no model
call and no new poll: the poll a lookup used to wait for runs behind it. When that poll stores something, the lookup
is made again; it decides as a lookup behind a delivery (what is sure or grounded), so with a model configured it
makes no second judge call (a test counts one model call per event, flag on or off). Its synced sources then answer
locally, but sources that are not synced are searched live a second time. The in-sample worlds are static, so that second lookup never ran in any benchmark and its source calls are
unmeasured; in a live mailbox they scale with how often a poll finds something new.

`readerPushBehind` (in the default since D112; with `readerPush`, `syncOnDemand` and `syncPollBehind`) lets the push's
reader
start before that poll is done. It adds no source call: when the poll stores something, the push is ranked once more
on the refreshed index with the first search's results, and read at most once more. That second read is a model call
only when the poll changed the reader's pool (an item in or out, or an item's words): an unchanged pool is the same
`readerKey`, a cache hit at $0. Worst case, one extra reader call per acting request whose poll stored something,
about $0.00040 (prompt v7) each; the rate is that of polls that find something new for a request's own pool, which
the static sim worlds do not show. In the stub screen (`funnel --preset NEWB` vs `NEWBB --suite train1,train2 --seeds
41 -- --reader stub --time 1`, 2026-11-03) the reader was asked 119 times under NEWB and 117 under NEWBB; connectors
received 430 and 424 calls.

The non-model costs (source API calls, hosting) are not modelled yet. Source calls may dominate for some connectors;
measure them per connector in M2. The query planner (D28), on by default in the server since D33, adds no model call.
After its iterations it makes 1.36–1.47x planner-off's source calls per lookup in the simulation at time 0 and
1.23–1.32x at real pacing (about 5.6–6.2 calls per lookup against 4.1–4.65), and 1.00–1.74 calls per lookup per
connector on the lab's real servers at the current settings; with `maxCalls: 1` it adds none
(docs/research/query-planner-results.md).
