# CL2: the reader's diet (input, cached prefix, output)

Status: 2026-11-07, branch `claude/cl2-reader-diet` (based on `claude/lucid-hypatia-v9wqk5` at 2c65a6f9a). Session CL2
of the cost-and-latency wave ([cost-latency-plan.md](cost-latency-plan.md), hypotheses H3, H4, H5). Decisions
D238–D241. Every paid call went to the Anthropic API with `HAIKU_API_KEY`, `claude-haiku-5-5` in every role (agent,
grader, cards, intent, reader), through the lab provider (D97), `OPENROUTER_API_KEY` unset, on one spend ledger with
a hard cap (`--spend-ledger .local/cl2/ledger.jsonl --spend-cap 3 --spend-headroom 0.3`): **Anthropic-direct lab
figures**. The servers ship the same model through OpenRouter (D12), which nothing here called.

**Spent: $2.338** of the $3 cap (ledger labels and amounts in §7).

## In plain words

- **The reader now stops writing once it reaches the look-alikes (D240, in the default).** It lists binding items
  first, then look-alikes it only rejects; a stop sequence ends the reply at the first look-alike. Output halves
  (172 → 91 tokens), each reading is about 0.26 s faster (p50 1,129 → 869 ms) and 14% cheaper. With Pi as the agent,
  Eden's per-task cost fell 10–20% and wall time 0.6–0.8 s on the short horizon, with no loss of hidden facts (+1.7
  and +1.0 points, both intervals across zero) and no rise in false concerns (3 → 1 of 120, 1 → 0 of 96).
- **The reader's latency is its output, not its input.** Over 2,544 live calls: 0.76 s + 2.9 ms per output token, and
  nothing per input token. So input diets only save money.
- **Feeding the reader less costs recall.** Ten items instead of fifteen cuts its cost 22% a call but lost 3–7 points
  of hidden facts against the stop alone on Pi (not significant, but in the same direction in every screen); shorter
  item windows lost more. Not taken (D238). Rewriting the item fences more compactly saves only 2% of tokens (D239).
- **A per-user cached block of the user's standing items would cost more than it saves** (D241, not built): a quarter
  of the reader's items are carded, and the block a user would need is several times the size of what it replaces.
- **Not reached: Eden below the agent alone.** On these train tasks the agent with its own tools cost $0.394–0.396
  per 1,000 tasks; with Eden and the stop, agent plus Eden's per-task calls $0.532 (hidden) and $0.593 (control), plus
  the cards backfill. The reader is now about $0.23 per 1,000 tasks; the remaining gap needs fewer reader calls (CL1)
  or a cheaper agent turn, not a leaner reader request.

Tried in this session: pool caps 6/8/10/12, a 160-character item window, compact item fences, three pool trims (bulk
mail, `readerGate`'s per-item test, the card pass's `none` mark), the per-user cached prefix (analysed), the stop
sequence (simulated, then live), output caps by tokens and by entries (offline), and the reader latency fit.


## 1. Where a reader call's money and time go

From the 2,544 reader calls this session made live (ledger `.local/cl2/ledger.jsonl`, the four train top-ups below):

- **Time is output.** A least-squares fit over those calls gives latency = 759 ms + 2.89 ms per output token, and
  −0.032 ms per uncached input token (no effect: the input range here, about 1,100–1,900 uncached tokens, does not
  move it); time to first token = 614 ms − 0.034 ms per uncached input token, again flat. COST-MODEL.md's earlier fit
  (0.006 ms per input token) agrees. **No input diet can cut the reader's latency**; only fewer output tokens or
  fewer calls can.
- **Money is input.** The default call: 2,834 input tokens (945 of them the system block, read from the cache at
  0.1x), 172 output tokens, $0.000284 (the resample below). Uncached input is about two thirds of the cost, output a
  third.
- **What the user turn holds** (643 prompts of the default's train run, `--reader-log`, characters): item texts 56%,
  the item fences' attributes (`source=`, `date=`, `from=`) 23%, card lines 11%, titles 6%, the day, request and
  question 3%. 14.6 items per prompt on average (12.3 per ask, counting asks with smaller pools).

## 2. H3: the input diet (D238, D239)

Screened on train1–6, seeds 41–42, cards and intent replayed (D158), the paid reader replayed (recipe 2a) or, for a
changed prompt, read live into a copy of the cache (one metered funnel run each, ~640 calls). Because a fresh paid
reading samples again, the unchanged default was also read live once from an empty cache (`cl2-default-resample`):
its spread against the committed cache is the noise to judge every other row by.

| Run | hidden surfaced | decoys surfaced | hidden flagged in pool | input / output tokens per call | $ per call | reader p50 ms | how |
| --- | --- | --- | --- | --- | --- | --- | --- |
| default, committed cache | 313 | 127 | 255 / 282 | 2,834 / 176 | 0.000287 | 1,210–1,299 (as made) | replay, $0 |
| default, read again | 311 | 123 | 253 / 282 | 2,834 / 172 | 0.000284 | 1,129 | live, $0.183 |
| pool 12 | 311 | 126 | 253 / 280 | — | — | — | subset replay (approximate, D117) |
| pool 10 | 310 | 130 | 250 / 279 | — | — | — | subset replay (approximate) |
| pool 8 | 307 | 131 | 246 / 274 | — | — | — | subset replay (approximate) |
| pool 6 | 301 | 132 | 235 / 264 | — | — | — | subset replay (approximate) |
| **pool 10** | 310 | 135 | 249 / 279 | 2,284 / 162 | 0.000224 | 1,088 | live, $0.141 |
| compact item fences | 310 | 130 | 251 / 282 | 2,780 / 178 | 0.000282 | 1,143 | live, $0.181 |
| pool 10, 160 chars, compact | 302 | 137 | 243 / 279 | 2,100 / 164 | 0.000207 | 1,122 | live, $0.132 |
| trim: no bulk mail | 313 | 127 | 255 / 282 | (no change) | | | subset replay |
| trim: not constraint-like | 312 | 209 | — / 197 | | | | subset replay |
| trim: carded "none" | 305 | 234 | 94 / 117 | | | | subset replay |

- **Pool size.** The knee is at 10–12 items: from 15 to 10 the hidden fact stays within the noise (310 against
  311–313) and input falls 19% ($/call −22%); below 8 the planted item starts to leave the pool (274 at 8, 264 at 6).
  Decoys rise a little (130–135 against 123–127): an answer item the reader no longer reads is no longer rejected
  by name (`askReaderDrop`), so it stays listed.
- **The window per item** (240 → 160 characters) costs real recall: pool 10 alone 310/135, with 160 characters and
  compact fences 302/137, flagged 249 → 243. Not taken.
- **Compact fences** (`<item i="n">gmail; 2026-10-26T09:00; from Fiona Marsh; …`, D239): the attributes are 23% of
  the characters but only **2%** of the tokens (2,834 → 2,780). Quality within noise, saving negligible: deleted.
- **Trimming the pool by what cannot bind** (D238's first form, `readerPoolTrim`). Three tests, all with the reader's
  own verdicts replayed: bulk mail never reaches the pool (no change); `readerGate`'s per-item test (a constraint
  card or constraint wording) drops 85 planted items from the pool, because planted items are often uncarded (the lean
  card pass skips most items) and phrased without the gate's words, and the decoys it drops are no longer rejected, so
  decoys surfaced jump to 209; the card pass's `none` mark (`card: null`) is held for prefiltered items too, so it
  drops 165 planted items. **The pool's ranking is already the best cheap filter;** the trims were deleted.

## 3. H4: a per-user cached item prefix (D241, not built)

The idea: the user's constraint-carded items as a stable block after the system prompt, cached for an hour, read at
0.1x on every later call, with each request's own extras after it. Measured on the same 643 default prompts:

- Only **27% of the items in a pool are carded** with a constraint kind (2,562 of 9,411; the rest have no card or a
  `none` card). So a block of carded items can stand in for at most a quarter of a call's item tokens; the other
  three quarters stay uncached.
- A user's carded items that ever reach a pool: **32–92 distinct per world** (median about 60; 12 suite × seed
  worlds), about 330–370 characters each as rendered: roughly 7,000–12,000 tokens a block, rendered without the
  request's focus (a stable prefix cannot depend on the request).
- Per call, reading that block at 0.1x costs 700–1,200 token-equivalents; the carded items it replaces in a pool are
  about 4 a call, ~570 tokens at 1x. **The block costs more to read than it saves, before any write** (an hour's
  write at 2x is another 14,000–24,000 token-equivalents a user). It loses on short horizons and on long ones alike,
  and it would also show the reader 60 items it does not need (NEW2's standing block, D99, raised false concerns
  and cost 8–13% more).
- In production the reader's own system block may not be cached at all: Anthropic caching through OpenRouter is the
  open trial D145. In the lab it is (945 tokens at 0.1x), so every lab $ figure here understates the shipped route's
  reader input by up to the system block's share (about a third of input tokens).

Not built. D164 already found the items shared across a task's calls are 2.88% of item characters; this closes the
per-user form too.

## 4. H5: output (D240)

Output is 172 tokens a call and about 500 of the reader's ~1,130 ms. The model lists every item that looks relevant,
binding ones first (prompt v7), each with a `why` before `same` and `binds` (D96: that order is what rejects
look-alikes). On the committed cache (4,377 replies): 3.2 entries a reply, 2,097 replies with nothing binding, and in
246 (5.6%) a binding entry comes after a non-binding one.

`readerStopEarly` sends `"same":false` as a stop sequence: the reply ends where the model first writes that an entry
is not about the request's own thing. The entry it was writing keeps its `why` and is read as rejected
(`closeStopped`), so D96's reason-first order stands; what is lost is every entry after it. A lab replay simulates
the stop on recorded replies (`stopLine`, counts and timings scaled by characters kept, labelled
`READER STOP-SIMULATED`), then a live read checked it:

| Run | hidden | decoys | hidden flagged | output tokens | $ per call | reader p50 ms | how |
| --- | --- | --- | --- | --- | --- | --- | --- |
| default, read again | 311 | 123 | 253 | 172 | 0.000284 | 1,129 | live |
| stop | 315 | 141 | 242 | 87 | 0.000242 | 890–949 | simulated on the committed cache |
| **stop** | 316 | 146 | 244 | 91 | 0.000244 | 869 | live, $0.157 |
| **pool 10 + stop** | 310 | 137 | 246 | 86 | 0.000186 | 881 | live, $0.119 |

The simulation predicted the live read closely. The stop halves output (−47%), cuts the reader's p50 by 260 ms and
its cost by 14%; with pool 10, −35% $ a call. Its price: about 10 fewer hidden facts flagged (the binding entries
after a look-alike), more listed instead, and 19–23 more decoys listed (the look-alikes after the first are no longer
rejected by name, so `askReaderDrop` keeps them in ask answers). Capping output another way is worse: cutting replies
at N tokens or at K entries loses far more binding entries for the same saving (offline over the committed cache: at
120 tokens 656 of 3,252 binding entries lost for −39% output; at 3 entries 299 lost for −22%).

Since live agents reject most funnel decoys (broad-set.md) and the push only carries flagged items, the deciding
measure is live: section 5.

## 5. Live on Pi: short and long horizons

Pi harness (`@earendil-works/pi-agent-core`), Haiku 5.5 as agent, grader and Eden's roles, `--config default`, the
market `direct` profile, `--push signals`, time scale 1, cards and intent replayed (train cards: `cards-v2` +
`cards-train`). Train1–6, seeds 41–42 (one process per seed), `hidden` and `control`. Short: the first 10 templates of
each suite (n 120 a kind and arm), one request per session. Long: `--day 4`, the first 8 templates (n 96; days of 4
requests and a recap that is never graded). Arms: `tools` (the agent alone), `eden` (the default before D240),
`eden~diet` (pool 10 + stop) and `eden~stop` (stop alone). The short `eden~stop` arm ran in a second pair of
processes (same tasks, paired by task id). Figures from `packages/sim/lab/cl2/arms.py` (paired bootstrap, 5,000
draws) and `pi-ab-report.ts`; $ per 1,000 tasks. Backfill (cards made live per lane) is a one-time cost spread over
few tasks here (10 or 8 a suite), so it is shown apart and is not changed by anything in this session.

**Short horizon (n 120 a kind).**

| arm | kind | raised | wall p50 / p90 / mean s | agent + Eden per-task + backfill $/1k | reader calls / task | connector calls / task | Eden on critical path ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| tools | hidden | 12.5% | 4.91 / 7.54 / 5.17 | 0.394 + 0 + 0 | 0 | 3.38 | 0 |
| eden | hidden | 70.0% | 4.90 / 8.03 / 5.45 | 0.312 + 0.274 + 0.155 | 0.94 | 6.03 | 2,164 |
| eden~stop | hidden | 71.7% | 4.31 / 6.97 / 4.68 | 0.307 + 0.225 + 0.305 | 0.89 | 5.77 | 1,763 |
| eden~diet | hidden | 65.0% | 4.83 / 8.11 / 5.16 | 0.346 + 0.175 + 0.147 | 0.90 | 5.99 | 1,854 |
| tools | control | 0.0% | 4.88 / 8.15 / 5.25 | 0.396 + 0 + 0 | 0 | 3.53 | 0 |
| eden | control | 2.5% | 6.17 / 9.00 / 6.08 | 0.355 + 0.289 + 0.175 | 0.97 | 6.92 | 2,344 |
| eden~stop | control | 0.8% | 5.95 / 7.65 / 5.47 | 0.358 + 0.235 + 0.337 | 0.99 | 7.18 | 2,121 |
| eden~diet | control | 0.8% | 5.75 / 8.99 / 5.62 | 0.371 + 0.181 + 0.168 | 1.00 | 6.69 | 1,966 |

(The stop arm's higher backfill is its own process making the same cards again over fewer runs; the stop does not
touch cards.) Reader calls: eden p50 1,150 ms, 182 output tokens; stop p50 862 ms, 81 tokens; diet p50 890 ms.

| pair (a − b), short | kind | raised (points) | wall mean s | Eden per-task $/1k |
| --- | --- | --- | --- | --- |
| stop − eden | hidden | +1.7 (−5.0..+9.2) | −0.77 (−1.13..−0.44) | −0.049 (−0.064..−0.036) |
| stop − eden | control | −1.7 (−4.2..0.0) | −0.61 (−0.99..−0.21) | −0.054 (−0.077..−0.035) |
| diet − eden | hidden | −5.0 (−12.5..+1.7) | −0.30 (−0.60..−0.01) | −0.099 (−0.113..−0.086) |
| diet − eden | control | −1.7 (−4.2..0.0) | −0.46 (−0.83..−0.10) | −0.108 (−0.128..−0.088) |
| diet − stop | hidden | −6.7 (−14.2..+0.8) | +0.48 (+0.18..+0.79) | −0.050 (−0.057..−0.042) |
| eden − tools | hidden | +57.5 (+47.5..+66.7) | +0.28 (−0.25..+0.81) | +0.274 |
| stop − tools | hidden | +59.2 (from the rows) | −0.49 (from the rows) | +0.225 |

**Long horizon, `--day 4` (n 96 a kind).**

| arm | kind | raised | wall p50 / p90 / mean s | agent + Eden per-task + backfill $/1k | reader / task | connectors / task | Eden on critical path ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| tools | hidden | 4.2% | 3.75 / 5.46 / 3.58 | 0.343 + 0 + 0 | 0 | 2.15 | 0 |
| eden | hidden | 63.5% | 3.83 / 6.56 / 4.18 | 0.284 + 0.267 + 0.141 | 0.92 | 5.19 | 1,775 |
| eden~stop | hidden | 64.6% | 3.66 / 5.88 / 4.14 | 0.289 + 0.241 + 0.147 | 0.95 | 5.19 | 1,629 |
| eden~diet | hidden | 61.5% | 3.77 / 5.62 / 3.97 | 0.279 + 0.180 + 0.180 | 0.92 | 4.92 | 1,535 |
| tools | control | 0.0% | 3.67 / 5.44 / 3.60 | 0.343 + 0 + 0 | 0 | 2.26 | 0 |
| eden | control | 1.0% | 4.69 / 7.72 / 4.97 | 0.353 + 0.281 + 0.159 | 0.97 | 5.98 | 1,990 |
| eden~stop | control | 0.0% | 3.71 / 6.55 / 4.18 | 0.305 + 0.224 + 0.184 | 0.94 | 5.33 | 1,536 |
| eden~diet | control | 0.0% | 4.40 / 7.34 / 4.61 | 0.345 + 0.174 + 0.174 | 0.97 | 6.12 | 1,746 |

| pair (a − b), day | kind | raised (points) | wall mean s | Eden per-task $/1k |
| --- | --- | --- | --- | --- |
| stop − eden | hidden | +1.0 (−7.3..+9.4) | −0.04 (−0.28..+0.22) | −0.026 (−0.048..−0.006) |
| stop − eden | control | −1.0 (−3.1..0.0) | −0.79 (−1.13..−0.46) | −0.057 (−0.078..−0.038) |
| diet − eden | hidden | −2.1 (−10.4..+6.2) | −0.20 (−0.45..+0.02) | −0.088 (−0.113..−0.065) |
| diet − eden | control | −1.0 (−3.1..0.0) | −0.35 (−0.72..+0.02) | −0.106 (−0.128..−0.088) |
| diet − stop | hidden | −3.1 (−11.5..+5.2) | −0.17 (−0.43..+0.09) | −0.062 (−0.076..−0.048) |

Reader p50 on the day runs: eden 1,152 ms (174 tokens), stop 902 ms (84), diet 930 ms (81). On the day runs Eden is
already cheaper than tools for the agent itself (0.284–0.353 against 0.343: tool results pile up in the tools
agent's transcript), as RealUse-2 found.

**Nothing-to-add turns (heldout14 neutral, read, seed 41, n 32; cost and latency only, not used to tune).** `eden~diet`
against `eden`: any concern 1 against 0 of 32 (+3.1, 0.0..+9.4), wall −0.12 s (−0.58..+0.37), Eden per-task $0.234
→ $0.131 per 1,000 (−0.102, −0.156..−0.049), reader output 191 → 37 tokens (nothing binds, so the reply stops at its
first entry), reader p50 1,083 → 737 ms, Eden on the critical path 2,366 → 2,184 ms. No stop-alone arm ran here.

## 6. Decisions

- **D240 promoted**: `readerStopEarly` on in the default and in `PARTS.reader`; the committed reader cache topped up
  so recipe 2a replays the new default whole (643 replayed, 0 missed, 316/146).
- **D238 rejected**: pool 10 (and every trim); the pool stays at 15.
- **D239 rejected**: compact fences. **D241**: the per-user cached prefix not built.

No trial switch is left open. `bun run eval` is unchanged (precision, recall, falseFireRate as on the base);
`eval-live.ts` (Anthropic, shipped wiring, lab transport): 0.8276 / 0.48 / 0 with and without the stop, 6 reader
calls, $0.00086 → $0.00062, output 1,068 → 590 tokens.

## 7. Commands and spend

```bash
gunzip -c packages/sim/lab/distilled/reader-haiku-train-4142-intent.jsonl.gz > .local/reader-haiku-train-4142-intent.jsonl
R="--reader-model claude-haiku-5-5 --reader-cache"
bun run funnel --jobs 4 --allow-misses --json .local/base.json -- --reader replay $R .local/reader-haiku-train-4142-intent.jsonl \
  --reader-log .local/base-log.jsonl                                   # the default, and the log subset replay reads
bun run funnel --jobs 4 --allow-misses --set '{"askReaderPool":10}' -- --reader replay $R .local/reader-haiku-train-4142-intent.jsonl \
  --reader-subset .local/base-log.jsonl                                # pool caps, approximate (D117)
env -u OPENROUTER_API_KEY bun run funnel --set '{"askReaderPool":10}' -- --reader live $R COPY \
  --spend-ledger .local/cl2/ledger.jsonl --spend-cap 3 --spend-headroom 0.3 --run-label cl2-p10-topup   # a live top-up
CONDS=tools,eden,eden~diet packages/sim/lab/cl2/run.sh 41 cl2-short-41 train hidden,control 10          # and 42
CONDS=eden~stop packages/sim/lab/cl2/run.sh 41 cl2-short-stop-41 train hidden,control 10               # and 42
CONDS=tools,eden,eden~diet,eden~stop packages/sim/lab/cl2/run.sh 41 cl2-day-41 train hidden,control 8 --day 4
packages/sim/lab/cl2/run.sh 41 cl2-h14n-41 heldout14 neutral 0
python3 -I packages/sim/lab/cl2/arms.py .local/cl2/cl2-short-41 .local/cl2/cl2-short-42 .local/cl2/cl2-short-stop-4{1,2}
bun packages/sim/src/lab/pi-ab-report.ts .local/cl2/cl2-day-41.json .local/cl2/cl2-day-42.json
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/eval-live.ts --spend-ledger .local/cl2/ledger.jsonl --spend-cap 3
```

(`run.sh` was run from `.local/cl2/`; the copy in `packages/sim/lab/cl2/` writes to `.local/cl2/` the same way.)
Reports: `packages/sim/lab/cl2/` (`pi-*-report.txt`, `arms-*.txt`).

| Ledger label | calls | $ |
| --- | --- | --- |
| cl2-default-resample | 642 | 0.1826 |
| cl2-cmp-topup | 642 | 0.1810 |
| cl2-stop-topup | 642 | 0.1565 |
| cl2-p10-topup | 624 | 0.1406 |
| cl2-dietA-topup | 636 | 0.1315 |
| cl2-p10stop-topup | 636 | 0.1187 |
| cl2-smoke | 37 requests | 0.0213 |
| cl2-short-41, -42 | 360 + 360 runs | 0.2487 + 0.2507 |
| cl2-short-stop-41, -42 | 120 + 120 runs | 0.1108 + 0.1186 |
| cl2-day-41, -42 | 384 + 384 runs | 0.2972 + 0.3062 |
| cl2-h14n-41 | 96 runs | 0.0710 |
| eval-live (three runs) | 18 | 0.0021 |
| **Total** | | **2.338** |

