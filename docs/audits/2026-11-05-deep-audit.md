# Deep audit (2026-11-05)

## Final summary of the second pass (for the owner, read this first)

Written on 2026-11-05 at `audit/2026-11-05-integration` c839af3e2. Every number here comes from a commit message, a
section further down this file, a decision row, or a command run while writing this summary (named where used).
"Estimate" marks figures nobody measured. Paid calls in this pass went only to Anthropic (`HAIKU_API_KEY`,
`claude-haiku-5-5` for every role). The spend ledger (`.local/mkt/ledger.jsonl`) now sums to $7.73 (a `bun -e` sum,
32,232 rows). It held $7.05 when the pass began, so the pass spent about $0.68 of its $17 cap.

Two words used throughout:

- **The reader** is the one paid model call on Eden's main path. It reads a short list of candidate items and says
  which ones matter for what the agent is doing.
- **The lab** is the test bench (`packages/sim`). It calls Anthropic directly. The servers that ship call the model
  through OpenRouter, a reseller.

### 1. Bottom line

The reader that shipped was not the reader that was tested. It asked the model to "think" first; the tested one did
not. On Haiku, thinking made each reader call 2.38x slower at the median and 1.59x dearer, with no quality gain, and
most asks gave up waiting for it. That is fixed: the servers now send exactly what the lab measured, and the option to
think was deleted. Three correctness bugs are fixed: a stale copy could survive a change notice, a slow connector
could hide an answer Eden already held, and an event stamped in UTC could land on the wrong day. The knowledge graph
now reads 1,000 characters per item instead of 4,000, which makes its part of ingest 2.1-2.3x cheaper in CPU with no
change on any quality screen, and a light user's memory is about half what it was. What is left is mostly one thing:
nobody has yet checked what OpenRouter does with these requests, because this run was allowed to pay Anthropic only.

### 2. Findings by area

"Found" is every candidate the hunt raised (53). "Verified" is what two independent checkers confirmed (17).
"Fixed" means a code or docs change is merged into the integration branch with `bun run check`, `bun run eval` and the
funnel green on the merged tree; it also counts 2 found-but-unverified items that were fixed later
(`corr-timed-utc-start-day`, `scale-graph-dominates-ingest-stage2`). "Closed" means rejected, decided against, or a
negative result with nothing to fix. Each "open" item has a reason and a next step in section 5.

| Area | Found | Verified | Fixed and merged | Closed without a fix | Still open |
| --- | --- | --- | --- | --- | --- |
| Correctness | 5 | 2 | 3 | 2 | 0 |
| User pain points | 3 | 3 | 3 | 0 | 0 |
| Dev loop | 14 | 5 | 5 | 6 | 3 |
| Latency | 7 | 2 | 1 (Anthropic half) | 5 | 1, plus the OpenRouter half of the fix |
| Cost | 7 | 2 | 0 | 5 | 2 |
| Scale and memory | 8 | 1 | 2 | 5 | 1 |
| Quality | 5 | 0 | 0 | 3 | 2 |
| Redesigns ("moonshots") | 2 | 2 | 1 (Anthropic half) | 1 | the OpenRouter half of the fix |
| Waste ("inefficiency") | 2 | 0 | 0 | 2 | 0 |
| **Total** | **53** | **17** | **15** | **29** | **9**, plus 2 OpenRouter halves |

About "reviewed": each package was checked by the run before merging, and the merged tree passed the gate after each
of the three integration steps (1,657, then 1,666, then 1,666 tests, 0 failures). The repo's own `reviewer` subagent
has **not** yet run on the whole engine and server diff. CLAUDE.md requires that before merging into `main`; it is
open item O1.

### 3. What was achieved

One row per merged branch. All timings are Anthropic-direct on the lab, `claude-haiku-5-5`.

| Fix (branch) | Before -> after (measured unless marked) | Outcome |
| --- | --- | --- |
| Reader thinks no more (`r1-s1-reader-reasoning-off`, D144) | At the default pool, 60 calls per arm: p50 2,822 -> 1,187 ms (2.38x); p90 4,176 -> 1,612 ms; calls over the 2.5 s ask wait 38/60 -> 0/60; $0.000447 -> $0.000281 per call (1.59x) | Shipped as default |
| Live eval on Anthropic (`r1-s2-eval-live-anthropic`) | `eval --live` could reach OpenRouter only -> runs the shipped wiring on Haiku: 6 reader calls, $0.00092, precision 0.8276, recall 0.48, false fires 0. Eval now declares its server dependency, so `test:changed` reruns it when server code changes | Shipped (lab tool) |
| Change notices clear held pages (`r1-s3-notify-held-pages`, D148) | A notice left the old search page in use for up to 60 s fresh, then 600 s stale -> every notice drops it. An ignored notice now says why (`push-off`, `not-synced`, `not-notifying`). A slow poll now answers from a held page instead of a fake timeout. Covered by new tests; no timing measured | Shipped as default |
| Smaller per-user sketcher (`r1-s4-sketcher-lazy-arrays`) | Memory per one-item user, 5,000 users: 29,567 -> 13,248 bytes (2.23x) at 10 terms; 33,166 -> 16,845 bytes (1.97x) at 100 terms. Heavy users unchanged (1,149 -> 1,148 bytes per item) | Shipped as default |
| Faster dev loop (`r1-s5-devloop-timers-bench`) | `ask-deadline.test.ts`: CPU 7.65 -> 0.27 s, wall 7.77 -> 2.7 s. Ingest bench `--quick`: 76.5 -> 16.9 s wall | Shipped; `--quick` is an opt-in dev flag and the full bench is unchanged |
| Example agent finds something (`r1-s6-example-default-prompt`) | First run printed "Nothing in the connected sources." -> cites the sample calendar; a test now runs it with no argument | Shipped |
| Sources file checked at start (`r1-s7-sources-file-validation`) | A bad, missing or duplicate source id loaded silently, and `{}` crashed with a stack trace -> exits with code 2 and one line naming the bad entry | Shipped |
| $0 replay of a paid reader run (`r1-s8-reader-replay-cache`) | A reader-quality screen cost $0.19-0.43 (from the finding, not re-measured) -> $0, reproducing the paid run exactly (hidden 247/384, decoys 127/384) | Shipped (lab tool) |
| Cards think no more (`final1-cards-reasoning-off`, D149) | Thinking was 1.82x slower at p50, 1.54x dearer and 1.74x the output tokens (35 calls, $0.0453) -> no thinking | Shipped as default |
| Graph reads 1,000 characters (`final1-graph-read-chars-1000`, D150) | Graph stage of ingest: 173.9 -> 74.3 µs per item (2.34x) and 167.4 -> 79.1 (2.12x) in two pairs; whole ingest 5.17x -> 3.56x the core cost; memory 5,188 -> 4,222 bytes per item. Funnel, paid-reader replay and eval unchanged | Shipped as default, no switch |
| UTC start on the right day (`final1-timed-zone-day`) | New test failed 2 of 5 cases -> passes. Eval and funnel unchanged | Shipped as default |
| Eval's "thinking" arm fixed (`final1-eval-live-thinking-arm`) | The adaptive arm thought at the model's default effort -> sends effort "low", the arm D144 timed | Shipped (lab tool) |
| Final live checks (`final1-final-live-ab`) | Measurement, not a change. Pi: Eden 77.3% of hidden facts vs 9.4% for plain tools, 0/128 false concerns. Hermes: 70.3% vs 4.7%, 1/64. Eden cost $0.834 per 1,000 tasks on Pi. Spent $0.516 | Recorded in docs/research/final-live-2026-11-05.md |
| Thinking options deleted (`final2-drop-maker-reasoning-options`, D155) | The reader and card makers could still be asked to think -> they cannot. No product code ever asked | Removed |
| Docs (`final1-close-docs`, `final2-close-docs-loose-ends`) | Decision rows D149-D157 and the closing tables in this file | Docs only |

On the merged tree, the integration check's `bun packages/engine/bench/ingest.bench.ts` gave whole ingest 3.57x the
core cost, against a 5.02x baseline. The box is shared, so treat those timings as noisy.

### 4. Decisions made during the run

| Decision | Evidence | Row |
| --- | --- | --- |
| The reader sends no thinking request | 2.38x slower at p50, 1.59x dearer, quality neutral | D144 |
| OpenRouter caching (`anthropicCache`) becomes a trial ending 2026-12-03; cost figures are labelled "lab provider, cached" | The flag was dead code; production pays an estimated 1.22-1.32x per reader call without it | D145 |
| No batch or cheaper endpoint for cards and intent | No batch tier on OpenRouter; at most 1.14-1.33x all-in (estimate) | D146 |
| No streaming reader; no local copy of the reader | Streaming: an estimated 1.12x at p50. Local model: earlier no-model attempts could not tell real items from decoys (score 0.544, where 0.5 is chance) | D147 |
| Change notices always drop held pages; ignored notices say why; slow polls fall back to held pages | Bugs B6, B12 and note 8a, with new tests | D148 |
| Cards send no thinking request | 1.82x slower, 1.54x dearer | D149 |
| The graph reads 1,000 characters, not 4,000 | Graph stage 2.12-2.34x faster; every quality screen unchanged | D150 |
| No "veto by name" over rule-path deliveries | Every such delivery happens before the reader has read anything | D151 |
| No re-reads started from a streamed reader | At most 1.34x, on connector calls that cost nothing | D152 |
| Anticipation stays | Removing it: hidden +0 −0, decoys +2 −1, 1.16x fewer unpaid connector calls | D153 |
| No request replay for the Pi and Hermes harnesses | A Pi seed costs about $0.135, and reader changes now screen at $0 | D154 |
| The thinking options are deleted from the code | No caller used them, and every measurement of thinking was worse | D155 |
| No speculative first agent call | At most 1.05-1.14x on task time, for 21-40% more agent spend (estimates) | D156 |
| No learned gate in front of the reader | A perfect gate caps at 2.19x on the reader, about 1.41x on model spend (estimate); the learned one decided 2.5% of calls | D157 |

### 5. Still open, and why

| # | Item | Why it is open | Next step |
| --- | --- | --- | --- |
| O1 | Merge into `main` | Needs the `reviewer` subagent on the engine and server diff first (CLAUDE.md step 5) | Run the reviewer on `git diff main audit/2026-11-05-integration`, fix its correctness findings, then `bun run check` and `bun run eval` on the final tree, and merge |
| O2 | Turning OpenRouter caching on (D145) | Needs a paid OpenRouter call; this run could pay Anthropic only | One probe with an OpenRouter key: two calls at realistic spacing, check for cached tokens above 0 on the second. Decide by 2026-12-03 |
| O3 | Cost and speed of the shipped path through OpenRouter | Same reason. All the numbers above are Anthropic-direct | Re-run `packages/sim/src/lab/reader-time.ts` through OpenRouter once a key is available |
| O4 | How OpenRouter treats "low" thinking | Same reason. The servers no longer send it; only the lab-only judge does | Only if a judge is ever shipped: one OpenRouter call, check for an error or thinking tokens |
| O5 | `ask-deadline.test.ts` failed once (801 ms against a 750 ms limit) on a loaded box | A timing test; the next two full runs passed | Watch it; if it fails again, widen the bound or move it to a fake clock |
| O6 | 42 stale `origin/claude/r10-*` branches | Deleting remote branches needs the owner's approval | Owner approves, then delete them |
| O7 | `quality-retrieval-unranked-quarter` and `quality-push-skipped-top15` | Found, never verified in this run's single round. The first says two thirds of paid misses are facts the ask never ranks (a vocabulary gap); the second counts 13 misses the push skipped | Verify in the next audit; this is the biggest quality lever left |
| O8 | `devloop-funnel-setup-share` (caching funnel start-up, up to 1.7x), `devloop-ingest-bench-frozen-clock`, `devloop-test-discovery-hidden-dirs` | Found, never verified in this run | Verify in the next audit |
| O9 | `lat-ask-reader-overlap-poll`, `scale-kg-label-substring-retention`, `cost-poll-tuning-no-1-5x` (its free 1.12x from full poll pages) | Found, never verified; all low severity | Verify in the next audit; take the small free wins if they hold |

### 6. Where the data and git disagree

I checked every claimed fix against git. `git branch --no-merged audit/2026-11-05-integration --list
'audit/2026-11-05*'` prints nothing: all 16 second-pass branches (and every first-pass branch) are merged. The run's
own data differs from what shipped in a few places; the tables above use what shipped.

- The ask-deadline fix: the finding proposed a 300 ms timeout and 7.8 -> 1.6 s. What shipped uses 500 ms and gives
  7.77 -> 2.7 s wall.
- The sketcher: the finding said about 30 KB per user and 1.75x. The commit measured 29,567 -> 13,248 bytes, 2.23x.
- The ingest bench: the finding expected 5.4x per run. What shipped is an opt-in `--quick` flag (76.5 -> 16.9 s,
  4.5x); the default full run is unchanged.
- The reader slowdown: the finding said 2.8-3.2x at p50 on larger probes. At the shipped pool size it measured 2.38x.
- The run's "deferred" list still names items 1-11 as waiting. The closing sections below show them done or decided;
  only the OpenRouter items (O2-O4) are really still waiting.

### 7. Where everything is

- This file: `docs/audits/2026-11-05-deep-audit.md`. The sections below hold every finding, work package, deferred
  item and closing table.
- Integration branch: `audit/2026-11-05-integration`. Before this summary it was at c839af3e2. It is ahead of `main`
  (cf38efb09) by 69 files, +3,204 −220 lines (`git diff --stat main audit/2026-11-05-integration`).
- Per-package branches (second pass):
  - Round 1: `audit/2026-11-05-r1-s1-reader-reasoning-off` (06f760ebd), `-r1-s2-eval-live-anthropic` (230f3d8af),
    `-r1-s3-notify-held-pages` (c0c18202d), `-r1-s4-sketcher-lazy-arrays` (98d31ef6e),
    `-r1-s5-devloop-timers-bench` (e41478b13), `-r1-s6-example-default-prompt` (8b0897d54),
    `-r1-s7-sources-file-validation` (ef8217ef1), `-r1-s8-reader-replay-cache` (8ada6d9bc).
  - Closing: `audit/2026-11-05-final1-cards-reasoning-off` (04456fa6c), `-final1-graph-read-chars-1000` (79a583032),
    `-final1-timed-zone-day` (c98570273), `-final1-eval-live-thinking-arm` (686c6f4b7), `-final1-close-docs`
    (3293a0e95), `-final1-final-live-ab` (ac8624185), `-final2-drop-maker-reasoning-options` (c338b74fc),
    `-final2-close-docs-loose-ends` (637a9ada9).
- Decisions: `docs/DECISIONS.md` rows D144-D157. Measured reader timings: `docs/COST-MODEL.md` (`s1-reader-time`).
  Live checks: `docs/research/final-live-2026-11-05.md`.

## Second pass (2026-11-05, Anthropic-only): summary for the owner

This pass audited `audit/2026-11-05-integration` at 323395554, after the first pass (everything below "Final summary
of the whole run") had closed. Its rule for paid calls: Anthropic only (`HAIKU_API_KEY`, `claude-haiku-5-5` for every
role), metered on `.local/mkt/ledger.jsonl` with `--spend-cap 17 --spend-headroom 0.3` (the ledger held $7.05 at the
start, so about $10 is available). Verification spent about $0.002 (one eval-live trial, finding B2); every other
number in this pass comes from the ledger, local runs and code reads cited in each finding. Numbers marked "estimate"
were not measured.

In plain terms:

- **The paid reader that ships is not the one that was measured.** Every quality and cost figure for the reader came
  from the lab, which calls Anthropic directly with thinking off and its instructions cached. The servers send
  reasoning "low" through OpenRouter and mark nothing for caching. On Haiku 5.5, thinking at low effort made the
  reader 2.8-3.3x slower at the median and about 1.5x dearer, and 6-7 of 10 calls missed the ask's 2.5 s wait. The
  one lab row that tried thinking (haiku-opt.md, v3) found it did not change quality. Decision D144 turns reasoning
  off by default, so what ships is what was measured. Whether OpenRouter honours caching for Anthropic cannot be
  checked under this run's rule; D145 makes that switch a trial with an owner and an end date instead of dead code.
- **A stale copy can survive a change notice.** For a source that sends change notices but has no listing, a notice
  did not clear the held search page, so the next ask answered the old text for up to a minute. A slow poll also made
  an ask report "could not reach" for a source whose page was already held. Both are small fixes (package S3).
- **The live eval cannot run here.** `bun run eval --live` reaches only OpenRouter. A small lab driver already worked
  in verification (6 reader calls, 0 failures, about $0.001 a run); package S2 lands it.
- **A $0 replay of a paid reader run exists** and reproduces it exactly (hidden 247/384, decoys 127/384), but it sat
  in a scratchpad due for deletion. This report copied it to `.local/mkt/reader-train-4142.jsonl` in the main
  checkout (md5 9a492c00cf9724306e3e4743e2882982, 866 lines, the same as the source); package S8 commits it and
  documents the recipe.
- **Smaller items**: each user's near-duplicate sketcher allocates about 17 KB up front (61% of a light user's
  memory); one test file burns a CPU core for 7.7 s on a Bun timer bug; the ingest bench takes 73-84 s; the example
  agent's default prompt finds nothing; a bad shared sources file starts silently; eval tests are skipped by
  `test:changed` when server code changes.
- **Not pursued, with decisions**: a batch endpoint for cards (D146: no production route under D12, and at most
  1.14-1.33x all-in); a streaming reader and a local distilled reader (D147: an estimated 1.12x, and a very low chance
  of matching Haiku on decoys).

Tally: 17 verified findings (1 high, 8 medium, 8 low after verification). 14 are packaged into 8 work packages
(S1-S8), counting B8 (the union of B1 and B3). 3 are closed by decisions (B7 by D146; B9 and B17 by D147). The
OpenRouter halves of B1, B3 and B8 are deferred (outside the run's Anthropic-only budget).

## Second pass: findings, ranked by value (severity, then effort)

Status key: **packaged** (a work package below fixes it), **decided** (a decision row closes it), **deferred**
(section "Second pass: deferred" says why). Severities are after verification.

### B1. `reader-shipped-reasoning-unmeasured`: the shipped reader thinks; every measured reader did not (high, M)

- **Evidence.**
  - `packages/engine/src/reader.ts:486` defaults `reasoning` to "low" and `:493` sends it.
    `packages/server/src/build.ts:97` builds `new ModelReaderMaker(models.reader)` with no options, through OpenRouter
    (`packages/server/src/models.ts:68`; `packages/llm/src/openrouter.ts:74` sends `reasoning: {effort, exclude:
    true}`).
  - The lab reader ignores the request: `labModel` (`packages/sim/src/lab/free.ts:101-111`) builds `AnthropicModel`,
    whose `thinking` defaults to "off" (`packages/llm/src/anthropic.ts:137,144`). All 9,555 `eden.reader` ledger rows
    ran with thinking off; `hidden-funnel.ts:342` defaults `--reader-thinking` to off.
  - Ledger run `pp-reader-time` (Haiku 5.5, 30 items, 3,192 input tokens, 10 calls per arm), re-tallied by both
    verifiers: off with cache p50 1,244-1,253 ms, 0/10 over 2,500 ms, $0.000348 a call; adaptive-low with cache p50
    3,475-3,501 ms, 6/10 over 2,500 ms, TTFT 3,249 vs 641 ms (5.1x), $0.000526 (1.51x); adaptive-low uncached 7/10
    over. Run `ineff-reader-time`: p50 1,098 vs 3,652 ms (standard median, 3.33x), cost 1.59x.
  - The latency is bimodal: 3-4 of 10 adaptive-low calls did not think and took 0.9-1.9 s. Run `lat-audit-reasoning`
    (n=5, about 1,700 tokens) had only 1 of 5 think.
  - Quality: `docs/research/haiku-opt.md:71` (v3, thinking on at low) flagged 117 hidden and 89 decoys against 114
    and 88 with it off, p50 1,450 vs 1,434 ms. D96's decoy cut (88 to 13 flagged) came from v4's `why` before `binds`
    (haiku-opt.md:72), with thinking off. The comment at `reader.ts:472-475` credits it to provider reasoning, which
    misreads D96.
- **Impact.** On Anthropic-direct the shipped mode is 2.8-3.3x slower at p50 and 1.5-1.6x dearer per call, and at
  these pool sizes about 60-70% of asks would fall back after the 2.5 s wait while still paying (COST-MODEL.md:76
  puts the default pool at about 2,900 input tokens, close to the probes). The push waits `readerPushWaitMs` (60 s,
  `config.ts:588`), so the fallback share applies to asks. How OpenRouter maps `effort: "low"` for
  `anthropic/claude-haiku-5.5` is unmeasured: if it becomes `thinking.type: enabled` with a budget, the
  `lat-audit-reasoning` enabled-1024 rows (0 output tokens, about 160 ms) suggest an HTTP 400 on every call, so the
  reader would always fail open.
- **Fix.** D144: default reasoning "off" (the measured configuration). Re-time at the default pool on Anthropic and
  record the figures in COST-MODEL.md, labelled Anthropic-direct.
- **Status.** Packaged (S1). The OpenRouter mapping probe is deferred. The judge's own `reasoning: "low"`
  (`partner.ts:4365`) is a different role and is not changed here.

### B2. `devloop-eval-live-openrouter-only`: `eval --live` cannot reach Anthropic (medium, M)

- **Evidence.** `modelRolesFromEnv` returns `NO_MODELS` without `OPENROUTER_API_KEY`
  (`packages/server/src/models.ts:59-60`); `fromEnvVia` has the same gate (`packages/eval/src/run.ts:104`);
  `packages/eval/src/cli.ts:70` never passes `make`. A verifier's scratch driver using `liveWiring({judge: false,
  usdCap: 0.05, env: {...process.env, OPENROUTER_API_KEY: "placeholder"}, make: o => labModel(access, {...o, model:
  "claude-haiku-5-5"}, "eden.reader")})` ran twice: `readerPool.reader` "live", 6 calls, 0 failures, 13 reads, 6
  `eden.reader` ledger rows summing to $0.00102.
- **Impact.** The live gate CLAUDE.md requires for scoring and delivery changes cannot run in this environment, so
  B1's re-time and any veto screen have no shipped-wiring driver.
- **Fix.** `packages/sim/src/lab/eval-live.ts` as above, with `@eden/eval` added to `packages/sim/package.json`
  (missing today; a workspace dependency, no cycle). `labAccess` already parses the spend flags (`free.ts:81-87`).
  Label the output "shipped engine wiring, lab provider (D97)".
- **Status.** Packaged (S2).

### B3. `anthropic-cache-dead-flag-prod-pays-full-prefix`: no cache breakpoints on the shipped path (medium, S)

- **Evidence.** `anthropicCache` is defined at `openrouter.ts:40`, read only at `:67`, and set only in
  `packages/llm/src/llm.test.ts:226,248,267,292`; `models.ts:65-67` builds reader, cards and cardsRetry without it;
  the trials table had no row. The lab always caches the last system block (`anthropic.ts:111-117`). Ledger
  re-priced at list prices by both verifiers: `eden.reader` $2.530 vs $3.339 uncached (1.32x, 34.5% of input
  cached, n=9,555); `eden.cards` $2.298 vs $2.908 (1.27x, 52.4%, n=5,158).
- **Impact.** Every COST-MODEL reader and card figure describes a cached path that does not ship. At lab traffic
  density the gap is 1.22-1.32x per reader call; with sparse production traffic it is probably smaller (OpenRouter
  may spread endpoints; the cache lives 5 minutes). Dollars are small (estimate: about $0.1-0.2 per 1,000 tasks).
- **Fix.** D145: the flag becomes a trial with an owner and an end date, and COST-MODEL figures are labelled "lab
  provider, cached". Turning it on needs an OpenRouter probe (cached tokens above 0 on a second call, at realistic
  per-user spacing).
- **Status.** Trial row and decision written in this commit; doc labels packaged (S1); the probe is deferred.

### B4. `devloop-paid-reader-replay-exists`: a $0 replay of the paid default exists only in a scratchpad (medium, S)

- **Evidence.** Two verifiers replayed the cache with `--reader replay --reader-model claude-haiku-5-5
  --reader-cache <copy>`: replayed 648, missed 5, hidden 247/384, decoys 127/384, equal to graph-ablation.md:82.
  Without `--reader-model` every prompt misses (0 replayed, 1,250 missed): `promptKey` hashes the model id
  (`reader-disk.ts:51-63`) and the default model is `z-ai/glm-5.3-flash` (`hidden-funnel.ts:338`). With 5 misses the
  funnel exits 3 unless `--allow-misses` is passed. A pool cut (`askReaderPool` 10 with `--reader-subset`) screened
  at $0 (hidden 230, decoys 140, labelled APPROXIMATE).
- **Impact.** A paid default reader screen costs $0.17-0.19 (ledger: ga-default $0.172, ga-default2 $0.187); veto,
  gate and pool-cut changes can screen at $0 instead. Changes that add or re-render pool items still miss.
- **Fix.** Commit the cache gzipped next to `intent-v2.jsonl.gz` (simulated text only; 106,277 bytes gzipped,
  measured with `gzip -c | wc -c`), a LAB.md recipe with `--allow-misses`, its preset, seeds, commit and staleness
  rule, and a funnel hint when every reader prompt misses without `--reader-model`.
- **Status.** File preserved at `.local/mkt/reader-train-4142.jsonl` by this report; packaged (S8).

### B5. `memory-user-fixed-overhead-sketcher`: 17 KB of sketch arrays allocated per user up front (medium, S)

- **Evidence.** `packages/primitives/src/dedup.ts:64-68` allocates four `Uint32Array(1_024)` and one
  `Uint8Array(1_024)` per `TextSketcher`; `packages/engine/src/cache.ts:154` creates one per user. heapStats: a
  one-item user 29,540 B, of which the five arrays are 17,724 B; 1,404 B at 64 slots. Per user (2,000 users): 10
  terms 30,251 to 13,941 B (2.17x), 100 terms 34,126 to 18,965 B (1.80x), 200 terms 1.51x, 600 terms 1.05x. Growth
  already exists (`growTerms`, `dedup.ts:256-265`; the pool, `:319`); `compactPool` (`:305`) floors at 1,024.
- **Impact.** About 130-160 MB less per 10,000 light users (estimate: 13.2-16.3 KB x 10,000); negligible for heavy
  users.
- **Fix.** Start at 64, lower `compactPool`'s floor to match, test growth past 64 and 1,024, and re-run
  `dedup.bench.ts`, `sketch.bench.ts` and `ingest.bench.ts` before and after (the primitives rule).
- **Status.** Packaged (S4).

### B6. `corr-sourcechanged-keeps-held-page`: a notice for an unsynced notifying source keeps the old page (medium, S)

- **Evidence.** `partner.ts:1743-1748` calls `fanout.dropResults` only when `sync.changed()` is true, and
  `sync.ts:262-268` returns false without sync state; a search-only source never has any (`sync.ts:441-443`;
  `user-sources.ts:73,380` accept `notifies` without `listTool`). `sourceItems` (`partner.ts:1766`) has the same gap.
  Both verifiers reproduced it: after the change `sourceChanged` returned false and the next ask answered the old text
  with status "cached" and no new search; with `dropResults` called, a new search and the new text.
- **Impact.** Old text for up to 60 s (fresh window, `guarded.ts:212`), then as a stale fallback up to 600 s. The fix
  clears only the held fan-out page; ItemCache copies of a search-only source are still not doubted (D126's mechanism
  needs sync state), so it narrows the gap rather than extending D126 to such sources.
- **Fix.** Drop the held page on every notice while `syncPush` is on, and in `sourceItems` when items are non-empty;
  keep the returned value. Test in `freshness-push.test.ts` on `CORE_CONFIG`.
- **Status.** Packaged (S3).

### B7. `cost-intent-cheaper-endpoint-or-batch`: a batch or cheaper endpoint for cards and intent (medium, M)

- **Evidence.** Ledger: 5,158 `eden.cards` calls at $0.000445 each, output about 70% of the cost; 11,492 of 13,605
  card items are request-only (map-funnel.json). Batches halve token prices, but cache hits in a batch are
  best-effort: 1.58-2.0x on the card part (verifier arithmetic), 1.14-1.20x all-in against COST-MODEL.md:279-282,
  1.33x on the finding's own unverified totals. Production roles go through OpenRouter (D12), which has no batch
  tier; Anthropic-direct is lab only (D97). Batch results can take up to 24 hours and land on a cold user's
  backfill, and the funnel replays cards, so it cannot see that delay.
- **Fix.** D146: rejected for now.
- **Status.** Decided (D146).

### B8. `redesign-shipped-reader-is-not-the-measured-reader`: ship the measured reader (medium, M)

- **Evidence.** The union of B1 and B3. Measured ledger mean per reader call $0.0002647 (2,729.6 tokens in, 941.8
  cached, 153 out); uncached at list price $0.000350 (1.32x). The finding's 1.55x adds 118 reasoning tokens a call
  that no run measured on OpenRouter.
- **Fix.** B1's D144 plus B3's D145.
- **Status.** Packaged with B1 (S1); the OpenRouter cost and latency of the shipped path stay deferred.

### B9. `lat-reader-stream-early-settle`: settle the push early from a streamed reader (medium, M)

- **Evidence.** Ledger (9,552 reader rows with TTFT): p50 1,053 ms, TTFT 547, decode 486 ms (46%), output p50 123
  tokens. The push delivers every flagged item of a push kind (`partner.ts:1318-1321`), so it can settle only after
  all binding entries: about 61% of entries on the labels-train histogram, an estimated p50 939 ms (1.12x) and p90
  1,207 ms (1.25x). Aborting at settle would cache a partial reading that a later ask, which needs every rejection
  (D96, D114), cannot reuse, so the claimed cost cut does not hold.
- **Fix.** D147: not built.
- **Status.** Decided (D147).

### B10. `devloop-ingest-bench-size`: ingest.bench takes 73-84 s (low, S)

- **Evidence.** Defaults 200 users x 500 items (`ingest.bench.ts:38-39`), modes in series (`:221-227`). Verifier
  runs: 73.0 s at 200 x 500 vs 14.7 s at 40 x 500; memory at 40 users runs about 5% high (core 2,734 vs 2,595
  B/item), so the two sizes are not comparable for memory.
- **Fix.** Keep 200 x 500 as the default (every recorded figure uses it); add an opt-in `--quick` that prints its size
  and that it is not comparable with 200 x 500 memory figures. No parallel mode children (they would contend the
  per-mode timings the stage subtraction relies on).
- **Status.** Packaged (S5).

### B11. `devloop-bun-unref-timer-spin`: a test spins a core on Bun 1.4.4's unref'd timer wait (low, S)

- **Evidence.** Bun 1.4.4: an unref'd `setTimeout(1500)` used 1,495 ms of CPU over 1,502 ms of wall time; with a ref'd
  interval alive, 4.5 ms. `ask-deadline.test.ts`: 7.795 s real and 7.757 s user; with a keep-alive preload 7.752 s
  real and 0.325 s user.
- **Fix.** A ref'd keep-alive interval in `scripts/test-preload.ts`, cleared in its `afterAll`. Do not cut TIMEOUT to
  300 ms with a `+250` bound: that leaves 50 ms between one deadline and two, which weakens the D140 test. A
  proportional bound (`TIMEOUT * 1.5` at TIMEOUT 500) only if 20 runs under load pass; otherwise keep 1,500.
- **Status.** Packaged (S5).

### B12. `painpoint-source-notify-ambiguous-results`: notices give no reason when they are ignored (low, S)

- **Evidence.** `http.ts:140-145` answers 200 `{ok: true, synced: false}` for a typo'd source, an unknown user, push
  off and a non-notifying source alike (`partner.ts:1743-1748`, `sync.ts:262-268`). The client doc at
  `client.ts:276-277` says `sourceRemoved` returns "how many were held"; it returns cached items dropped
  (`cache.ts:783-790`). An unreachable server already reaches `onError` (`client.ts:184`).
- **Fix.** A `reason` field computable without I/O: `push-off`, `not-synced` (covers an unknown source, an unknown
  user and a source not yet warm) or `not-notifying`; status stays 200. The client exposes it without changing return
  types (`sourceChanged` stays `Promise<boolean>`); the `sourceRemoved` doc is corrected. No `unknown-source` reason:
  telling it apart needs `deps.sources`, which is async I/O on the notice path.
- **Status.** Packaged (S3, which owns `partner.ts`).

### B13. `corr-example-default-prompt-empty`: the example's default prompt finds nothing (low, S)

- **Evidence.** `examples/personal-agent/agent.ts:75` defaults to "What's on my plate this week?"; both verifiers got
  "Nothing in the connected sources." Adding `meta.start` dates did not change that prompt's answer ("plate" matches
  neither `ASKS_SCHEDULE` nor `TIME_WORD`, `partner.ts:428,435`). "When is the dentist?" and the Priya prompt cite
  calendar items.
- **Fix.** The default prompt becomes the documented Priya command (`agent.ts:7`), plus a no-argument test that
  expects `[calendar]`.
- **Status.** Packaged (S6).

### B14. `painpoint-sources-file-unvalidated`: a bad `EDEN_SOURCES_FILE` starts silently (low, S)

- **Evidence.** `connectors.ts:24-35` checks only `Array.isArray(s.docs)`. The ids "bad id!", a missing id, duplicate
  ids and a numeric ref all loaded; a missing `docs` threw with a stack; `{}` threw a bare `TypeError`
  (`file.sources.forEach`). `http.ts:134` then rejects such ids. `user-sources.ts:418-436` (`checkSpecs`)
  already validates the per-user file.
- **Fix.** Reuse `checkSpecs` (kind "static") after checking `file.sources` is an array; catch `SourceConfigError` and
  `SyntaxError` in `main.ts` and `mcp-stdio.ts`, print one line without a stack and exit 2; log the source count. Keep
  the D108 hint that `user-sources.test.ts:347-349` expects. One validator, not a second zod schema that could drift.
- **Status.** Packaged (S7).

### B15. `devloop-eval-undeclared-server-dep`: eval imports server by relative path; `test:changed` skips it (low, S)

- **Evidence.** `packages/eval/src/cli.ts:17`, `run.ts:21` and `run.test.ts:6` import `../../server/src/*`;
  `packages/eval/package.json` lacks `@eden/server`; `touchedPackages(['packages/server/src/models.ts'])` returned
  [server, sim]. The sim `graph-memory.ts:19` import is cosmetic (sim already declares `@eden/engine`).
- **Fix.** Add `"@eden/server": "workspace:*"` to eval; export `modelRolesFromEnv`, `MakeRoleModel`,
  `DEFAULT_ROLE_MODEL` and `readerFailureLog` from `packages/server/src/index.ts`; switch the imports; add a
  test-select test. Optionally export `extract` and `UserGraph` from engine for graph-memory.
- **Status.** Packaged (S2, which also edits `bun.lock` and sim's package.json).

### B16. `correctness-searchlive-deadline-skips-held-page`: a slow poll hides pages the fan-out holds (low, S)

- **Evidence.** `partner.ts:2809-2814` turns every chosen source into a synthetic timeout when `left()` is under 50 ms
  (`MIN_SEARCH_MS`, `:5077`) without asking the fan-out, whose `one()` would answer a fresh page as "cached" or a
  stale one as a fallback (`guarded.ts:635-639`). Reproduced: with a hanging notes poll, the second ask reported mail
  as "timeout" and said "Could not reach mail (timed out)". The gate came in with cf38efb09 (#226).
- **Impact.** A false "could not reach" notice and a wrong per-source status; the items survived in the repro through
  the ItemCache. Frequency unmeasured.
- **Fix.** A cache-only peek on the fan-out that shares `one()`'s cache-key helper and honours `isStale`, forget and
  drop marks, with no rate token, slot or breaker charge; a stale page carries `error: "timeout"`. The synthetic
  timeout only when nothing is held.
- **Status.** Packaged (S3).

### B17. `lat-learned-local-reader-moonshot`: a local distilled reader (low, L)

- **Evidence.** D110: boosted trees reached pair AUC 0.864 but planted vs decoy 0.544. Haiku itself flagged 105/192
  decoys until the prompt made it write `why` first (haiku-opt.md:69-72); a one-pass cross-encoder does no such
  reasoning. `labels-train.jsonl` has 1,416 rows. The finding's 1.77 s Eden path figure was not reproduced.
- **Fix.** D147: not built.
- **Status.** Decided (D147).

## Second pass: round 1

- 17 verified findings, each checked by two verifiers: 1 high, 8 medium, 8 low (the severities verification left).
  Verifiers lowered several from their first rating (for example `devloop-ingest-bench-size` from high) and corrected
  five fixes: B10 keeps the full default, B11 keeps a wide bound, B12 drops `unknown-source`, B13 changes the prompt
  rather than the dates, B14 reuses `checkSpecs`.
- Judgement calls made here (the owner delegated them), each with its evidence in `docs/DECISIONS.md`:
  - **D144**: reader reasoning defaults to "off", the measured configuration. Thinking at low measured 2.8-3.3x slower
    at p50, 1.5-1.6x dearer, and neutral on quality (haiku-opt.md v3).
  - **D145**: `anthropicCache` becomes a trial (owner: repo owner, ends 2026-12-03); COST-MODEL figures are labelled.
  - **D146**: a batch or cheaper endpoint for cards and intent is rejected for now.
  - **D147**: a streaming reader with early settle and a local distilled reader are not built.
  - Smaller calls, recorded in the findings: B4 commits the cache gzipped (precedent `intent-v2.jsonl.gz`); B10, B11,
    B12, B13 and B14 as above.
- Paid budget for the packages: S1's re-time about $0.06 (estimate: about $0.0005 a call x 120 calls) and S2's proof
  run about $0.001. Nothing else in round 1 needs paid calls.

## Second pass: work packages (round 1)

No two packages share a file. Each starts from `audit/2026-11-05-integration` (detached), commits on its own branch
`audit/2026-11-05-s<n>-<id>`, does not edit `docs/DECISIONS.md` (rows D144-D147 are written; a further row goes in
the commit message as a proposal) and ends with `bun run check` green. A package that changes engine behaviour also
pastes `bun run eval` JSON before and after. Paid calls go only through the lab provider on `claude-haiku-5-5`, with
`--spend-ledger .local/mkt/ledger.jsonl --spend-cap 17 --spend-headroom 0.3`. A bench owned by another package may be
run but not edited; a package that finds it must edit a file another package owns stops and reports instead.

| Package | Findings | Files |
| --- | --- | --- |
| S1 `reader-reasoning-off` | B1, B3 (doc labels), B8 | packages/engine/src/reader.ts, packages/engine/src/reader.test.ts, packages/engine/CLAUDE.md, packages/sim/src/lab/reader-time.ts (new), docs/COST-MODEL.md |
| S2 `eval-live-anthropic` | B2, B15 | packages/sim/src/lab/eval-live.ts (new), packages/sim/package.json, packages/eval/package.json, bun.lock, packages/eval/src/cli.ts, packages/eval/src/run.ts, packages/eval/src/run.test.ts, packages/server/src/index.ts, packages/engine/src/index.ts, packages/sim/src/lab/graph-memory.ts, scripts/test-select.test.ts, packages/sim/src/lab/CLAUDE.md, CLAUDE.md |
| S3 `notify-held-pages` | B6, B12, B16 | packages/engine/src/partner.ts, packages/sources/src/guarded.ts, packages/server/src/http.ts, packages/client/src/client.ts, packages/protocol/src/types.ts, packages/engine/src/freshness-push.test.ts, packages/engine/src/ask-deadline-held.test.ts (new), packages/server/src/http.test.ts, packages/client/src/client.test.ts, packages/sources/src/regressions.test.ts |
| S4 `sketcher-lazy-arrays` | B5 | packages/primitives/src/dedup.ts, packages/primitives/src/dedup.test.ts, packages/primitives/README.md |
| S5 `devloop-timers-bench` | B10, B11 | scripts/test-preload.ts, packages/engine/src/ask-deadline.test.ts, packages/engine/bench/ingest.bench.ts, docs/TESTING.md |
| S6 `example-default-prompt` | B13 | examples/personal-agent/agent.ts, examples/personal-agent/agent.test.ts |
| S7 `sources-file-validation` | B14 | packages/server/src/connectors.ts, packages/server/src/main.ts, packages/server/src/mcp-stdio.ts, packages/server/src/user-sources.ts, packages/server/src/connectors.test.ts (new) |
| S8 `reader-replay-cache` | B4 | packages/sim/lab/distilled/reader-haiku-train-4142.jsonl.gz (new), packages/sim/src/lab/funnel.ts, packages/sim/src/lab/hidden-funnel.ts, packages/sim/src/lab/funnel-flags.test.ts, docs/LAB.md |

### S1 `reader-reasoning-off` (B1, B3 doc labels, B8)

- **Plan.**
  1. `ModelReaderMaker` defaults `reasoning` to "off" (D144). Rewrite the `reader.ts:472-475` comment: D96's decoy cut
     came from the prompt's `why` first; cite D144. Keep the option so a caller can still pass "low".
  2. A unit test with a fake `Model`: the default request has no `reasoning` field, and "low" still sends one.
  3. `packages/sim/src/lab/reader-time.ts`: times `ModelReaderMaker` over `labModel` on `claude-haiku-5-5` at the
     default pool (`askReaderPool` 15, `askReaderItemChars` 240) built from real train pools, interleaving an "off"
     arm and an adaptive-low arm (`anthropic.thinking`), 60 calls per arm, spend-metered with a `--run-label`. It
     reports p50/p90, the share of calls that thought (by output tokens), the share over `askReaderWaitMs`, and $ per
     call.
  4. COST-MODEL.md: S1's figures and the `pp-reader-time` figures, labelled "Anthropic-direct"; every reader and card
     cost figure labelled "lab provider, cached" (D145); a line saying the OpenRouter path is unmeasured.
  5. engine CLAUDE.md: the new default and D144.
- **Acceptance.**
  - `bun test packages/engine/src/reader.test.ts` passes, including the new default-request test.
  - `grep -n 'reasoning ?? "off"' packages/engine/src/reader.ts` matches; `grep -n 'reasoning ?? "low"'
    packages/engine/src/reader.ts` prints nothing.
  - `bun run eval` JSON identical before and after (the no-model eval has no reader).
  - The reader-time run adds about 120 rows under its label to `.local/mkt/ledger.jsonl`, summing under $0.10;
    COST-MODEL.md shows its p50/p90 per arm and the command that produced them.
  - `bun run check` green.

### S2 `eval-live-anthropic` (B2, B15)

- **Plan.**
  1. Add `"@eden/server": "workspace:*"` to `packages/eval/package.json` and `"@eden/eval": "workspace:*"` to
     `packages/sim/package.json`; run `bun install`.
  2. Export `modelRolesFromEnv`, `MakeRoleModel`, `DEFAULT_ROLE_MODEL` and `readerFailureLog` from
     `packages/server/src/index.ts`; switch eval's three relative imports to `@eden/server`. Optionally export
     `extract` and `UserGraph` from `@eden/engine` and switch `graph-memory.ts`.
  3. A `scripts/test-select.test.ts` case: `touchedPackages(['packages/server/src/models.ts'])` includes
     `packages/eval`.
  4. `packages/sim/src/lab/eval-live.ts`: `labAccess(argv, ['claude-haiku-5-5'])`, then `runScenarios` with
     `liveWiring({judge: false, usdCap, env: {...process.env, OPENROUTER_API_KEY: "lab-placeholder"}, make: o =>
     labModel(access, {...o, model: "claude-haiku-5-5"}, "eden.reader")})`. The real OpenRouter key is never passed;
     the output JSON carries `provider: "anthropic-direct (lab, D97)"`. An optional `--reasoning low` arm passes
     adaptive `anthropic.thinking`.
  5. Document it in `packages/sim/src/lab/CLAUDE.md`, and one line in root CLAUDE.md's "CI is local" section: the
     Anthropic route for the live gate when OpenRouter is unavailable, labelled as not the shipped transport.
- **Acceptance.**
  - `bun test scripts/test-select.test.ts` passes with the new case (eval selected for a server change).
  - `grep -rn "\.\./\.\./server/src" packages/eval/src` prints nothing.
  - `bun packages/sim/src/lab/eval-live.ts --spend-ledger .local/mkt/ledger.jsonl --spend-cap 17 --spend-headroom 0.3
    --run-label s2-eval-live` prints JSON with `readerPool.reader` "live", 0 reader failures and spend under the cap,
    and the ledger gains `eden.reader` rows under that label (about $0.001).
  - `bun run check` green.

### S3 `notify-held-pages` (B6, B12, B16)

- **Plan.**
  1. B6: in `sourceChanged`, call `fanout.dropResults(user, source)` on every notice while `syncPush` is on, whatever
     `sync.changed()` returns; in `sourceItems`, whenever the notice carries items. Keep the boolean result.
  2. B12: add `reason?: "push-off" | "not-synced" | "not-notifying"` to the `/v1/sources/changed` response when
     nothing was synced, computed without I/O (protocol type, http route). The client exposes it (for example a
     `sourceChangedDetail` method) without changing `sourceChanged`'s `Promise<boolean>`; the `sourceRemoved` doc
     says "cached items dropped".
  3. B16: a `peek` on the fan-out (`guarded.ts`) built on a key helper shared with `one()`: a fresh page gives
     "cached", a stale one gives "stale" with `error: "timeout"`, honouring `isStale`, forget and drop marks, with no
     rate token, slot or breaker. `partner.ts:2809-2814` uses it and synthesises a timeout only when nothing is held.
- **Acceptance.**
  - A new `freshness-push.test.ts` case (`CORE_CONFIG` plus `sync` and `syncPush`): a search-only notifying source
    changes, `sourceChanged` is called, and the next ask makes a new search and answers the new text.
  - New `ask-deadline-held.test.ts`: a poll hangs to the deadline while another source's page is held from an earlier
    ask; the held source is reported "cached" (or "stale") and the answer has no "Could not reach" for it.
  - `http.test.ts` covers each `reason`; `client.test.ts` covers the exposed reason and the unchanged boolean.
  - A `sources` regression test: `peek` spends no rate token (the limiter's count is unchanged) and respects a drop.
  - `bun run eval` JSON before and after (expected identical); `bun run check` green; the `reviewer` subagent run on
    the diff (engine and server change) and its correctness findings fixed.

### S4 `sketcher-lazy-arrays` (B5)

- **Plan.** Start the five `TextSketcher` arrays at 64 and let `growTerms` and the pool grow them; lower
  `compactPool`'s floor to 64. Tests that index past 64 and past 1,024 terms and pool entries and get the same
  sketches as an instance started at 1,024.
- **Acceptance.**
  - `bun test packages/primitives/src/dedup.test.ts` and `bun run test:pkg engine` pass.
  - Before/after numbers from `bun packages/primitives/bench/dedup.bench.ts`,
    `bun packages/primitives/bench/sketch.bench.ts` and `bun packages/engine/bench/ingest.bench.ts` (run, not edited)
    in the commit message and the primitives README, plus a heapStats B/user figure for a one-item user (expected
    about 29.5 KB before, about 13-14 KB after).
  - `bun run eval` JSON identical; `bun run check` green.

### S5 `devloop-timers-bench` (B10, B11)

- **Plan.**
  1. `scripts/test-preload.ts`: a ref'd `setInterval` keep-alive cleared in the existing `afterAll`, with a comment
     naming the Bun 1.4.4 unref'd-timer spin.
  2. `ask-deadline.test.ts`: only if 20 runs under load (alongside `bun run test`) pass, set TIMEOUT 500 with bounds
     `TIMEOUT * 1.5`; otherwise leave TIMEOUT and the bounds as they are and say so. Never narrow the gap between one
     deadline and two below 250 ms.
  3. `ingest.bench.ts`: an opt-in `--quick` (40 x 500) that prints its size and a not-comparable note; the default is
     unchanged.
  4. TESTING.md: the ask-deadline timing before and after (real and user), and full vs quick bench wall times.
- **Acceptance.**
  - `time bun test packages/engine/src/ask-deadline.test.ts` shows user time under 1 s (was 7.7 s).
  - `bun packages/engine/bench/ingest.bench.ts` with no flags prints the same 200 x 500 header as before; `--quick`
    finishes in under 20 s and prints its note.
  - `bun run check` green twice.

### S6 `example-default-prompt` (B13)

- **Plan.** The default prompt becomes "move lunch with Priya Raman to Friday" (the documented command at
  `agent.ts:7`), plus a test that runs the agent with no argument and expects `[calendar]`.
- **Acceptance.** `bun test examples/personal-agent/agent.test.ts` passes with the new no-argument case; running the
  agent with no argument against the dev server prints a `[calendar]` citation; `bun run check` green.

### S7 `sources-file-validation` (B14)

- **Plan.** `staticSources` checks that the file is an object with a `sources` array, then calls `checkSpecs`
  (exported from `user-sources.ts` if needed) with kind "static" and the label `EDEN_SOURCES_FILE.sources`;
  `main.ts` and `mcp-stdio.ts` catch `SourceConfigError` and `SyntaxError`, print one line without a stack and exit
  2; the server logs how many sources it loaded.
- **Acceptance.** A new `connectors.test.ts` with `{}`, a bad id, a missing id, a duplicate id, a non-string ref and a
  missing `docs`, each rejected with a message naming the entry; `user-sources.test.ts` passes unchanged;
  `EDEN_SOURCES_FILE=<bad file> EDEN_DEV=1 bun packages/server/src/main.ts` exits 2 with no stack trace;
  `bun run check` green.

### S8 `reader-replay-cache` (B4)

- **Plan.**
  1. `gzip -c /home/user/Eden/.local/mkt/reader-train-4142.jsonl >
     packages/sim/lab/distilled/reader-haiku-train-4142.jsonl.gz` (md5 of the plain file
     9a492c00cf9724306e3e4743e2882982). If `--reader-cache` cannot read `.gz`, teach it to (as the lab reads
     `intent-v2.jsonl.gz`) or document a `gunzip -c` step into `.local/`.
  2. A LAB.md recipe: the command with `--reader replay --reader-model claude-haiku-5-5 --allow-misses`; what it
     covers (default ALL3, train1-6, seeds 41-42, recorded by the D141 paid run); the expected hidden 247/384 and
     decoys 127/384; when it goes stale (any change upstream of the reader's input, a `READER_VERSION` bump).
  3. The funnel prints a hint naming `--reader-model` when every reader prompt missed and `--reader-model` was not
     given; a `funnel-flags.test.ts` case.
- **Acceptance.** The LAB.md command reproduces hidden 247/384 and decoys 127/384 at $0 (no ledger rows added);
  `bun test packages/sim/src/lab/funnel-flags.test.ts` passes with the hint case; `bun run check` green.

## Second pass: deferred

| Item | Why | Next step |
| --- | --- | --- |
| How OpenRouter maps `reasoning: {effort: "low"}` for `anthropic/claude-haiku-5.5` (B1, B8) | Needs a paid OpenRouter call; this run allows Anthropic only. Moot for the reader once S1 ships "off". The judge still sends "low" (`partner.ts:4385`), but the servers wire no judge, so that is lab-only: closed by D155 | One OpenRouter call with a served key: check for HTTP 400 or reasoning tokens (only if a judge or a reasoning arm is ever shipped) |
| Turning `anthropicCache` on (B3) | Needs an OpenRouter probe (cached tokens above 0 on a second call, at realistic per-user spacing); outside this run's budget | The D145 trial's deciding probe, by 2026-12-03 |
| The shipped path's cost and latency on OpenRouter (B8) | Same OpenRouter restriction | Re-run S1's `reader-time.ts` through OpenRouter once a served key exists |

## Closing the second pass

Checked on 2026-11-05 at `audit/2026-11-05-integration` (c11b0289c) plus this step's docs. Every number below comes
from a command run in this closing step (named where it appears) or from the commit, ledger run or decision row it
cites; "estimate" marks the rest. Paid calls in this step: Anthropic only (`claude-haiku-5-5`, `HAIKU_API_KEY`),
metered on `.local/mkt/ledger.jsonl` with `--spend-cap 17 --spend-headroom 0.3`: runs `close-docs-eval-live`
(6 calls, $0.00092), `close-docs-minus-anticipate` (53 calls, $0.0162) and `close-docs-default-topup` (5 calls,
$0.0013). The ledger holds $7.37 in all (summed with a `bun -e` script).

**State of the branches.** `main` (cf38efb09, #226) has the same tree as 323395554, the first pass's last commit
(`git diff --stat main 323395554` prints nothing). The integration branch is ahead of it by the second pass's audit
commit (1c8f0c064) and S1-S8, merged as 8 merge commits (`git log --merges 1c8f0c064..audit/2026-11-05-integration`
counts 8): 58 files, +2,367 −146 (`git diff --stat main audit/2026-11-05-integration`). Because #226 was squashed,
`git log main..audit/2026-11-05-integration` also lists the first pass's history (65 commits, 26 merges). This
closing step's packages (`final1-cards-reasoning-off` for D149, `final1-graph-read-chars-1000` for D150,
`final1-timed-zone-day`, `final1-eval-live-thinking-arm`, `final1-close-docs` and `final1-final-live-ab`) have since
been merged into the integration branch: at a0e4da57e, `git branch --no-merged audit/2026-11-05-integration --list
'audit/2026-11-05*'` printed none (run in "Closing the second pass: final loose ends" below). That check ran before
the two final2 packages (`final2-close-docs-loose-ends` and `final2-drop-maker-reasoning-options`), which merge
together after their review. Merging into `main`
needs the `reviewer` subagent on the engine and server diff first (CLAUDE.md step 5), then `bun run check` and `bun
run eval` on the final tree.

### Every deferred item

This table supersedes the "Blocked externally" rows of "Closing the run" below for the same items: the Anthropic-only
rule of this pass made them runnable on the lab transport.

| Item | Status | Where |
| --- | --- | --- |
| Paid timing of the shipped reader (`painpoint-prod-reader-unmeasured`, stage 1) | Resolved on Anthropic by S1: the `s1-reader-time` table in docs/COST-MODEL.md (60 train pools per arm; off p50 1,187 ms, $0.000281 a call; low 2.38x slower at p50 and 1.59x dearer) and D144 shipping "off". The OpenRouter half (what OpenRouter does with effort "low" and with cache breakpoints) waits on the D145 trial (ends 2026-12-03); this run's rule is Anthropic only | D144, D145, COST-MODEL.md |
| The paid `eval --live` run (`eval-live-measures-unshipped`) | Resolved. `bun packages/sim/src/lab/eval-live.ts --spend-ledger .local/mkt/ledger.jsonl --spend-cap 17 --spend-headroom 0.3 --run-label close-docs-eval-live` (S2's driver: shipped wiring, thinking off, Anthropic-direct): precision 0.8276, recall 0.48, falseFireRate 0, 6 reader calls, $0.00092. These are the same three figures `bun run eval` (no model) gave in the same step. The earlier run `close-eval-live` booked 6 calls, $0.00103 | D128, S2 |
| Reader veto by name (`quality-reader-veto-rule-path`) | Not built: every rule-path decoy is delivered before the reading exists | D151 |
| Re-reads started from a streamed reader (`fresh-checkahead-speculative-rereads`, stage 2) | Not built: at most 1.34x on unpaid connector calls, and the `Model` interface has no delta hook | D152 |
| A lighter graph (`scale-graph-dominates-ingest`, stage 2, `graphLite`) | Built with no switch: the graph reads 1,000 characters | D150 |
| A cheaper endpoint for intent-only card items (`cost-intent-requests-keyword-output`, stage 2) | Closed: D146 rejects a batch tier or a cheaper endpoint for now; D137 rejected keyword output | D137, D146 |
| Request replay in the agent lab (`devloop-agent-replay-identical-eden`; the Hermes request replay) | Not built: a Pi seed costs about $0.135 and reader changes screen at $0 | D154 |
| Low note 8a: a slow poll hid held pages | Fixed by S3 (`SourceFanout.held`, `packages/sources/src/guarded.ts:248`) | D148 |
| Low note 8b: `readMark` taken before `deps.sources()` and the poll (`partner.ts:2699`, and `:2961` for probes) | Not a bug: a conservative order. A mark taken early can only date a stored copy older than it is, so a signal in between makes the copy doubted and re-read once; it can never let a stale copy pass as current. D133 asks for the mark before the read begins | D133 |
| Low note 8c: `TenantHolds` entries kept once a tenant has evicted (`cache.ts:1171`, `:1235`) | Bounded, kept: an entry outlives its holds only for a tenant that hit a cap, and the servers fix the tenant from the API key (`packages/server/src/http.ts:46-50`; a body naming another tenant is refused, `:79-80`), so the map holds at most one entry per configured key (plus "dev" in dev mode). An embedder that mints tenant ids per request would need its own bound | This row |
| Low note 8d: eval imported server code by relative path, undeclared | Fixed by S2 (`@eden/server` declared in `packages/eval/package.json`) | S2 |
| The 24 candidates with no recorded outcome | Each resolved below | Below |
| Live Pi A/B of the current default; the Hermes live check of the default (carried from 2026-11-04) | Done, Anthropic-direct lab transport, Haiku 5.5 for every role: Pi held-out 13, seeds 41-44, hidden 77.3% vs 9.4% for tools, 0/128 false concerns; Hermes, seeds 41-42, 70.3% vs 4.7%, 1/64 false concerns | [docs/research/final-live-2026-11-05.md](../research/final-live-2026-11-05.md) |
| The second pass's three OpenRouter-only items (effort mapping, `anthropicCache`, the shipped path's cost and latency) | Unchanged: the D145 trial (ends 2026-12-03) and "Second pass: deferred" above | D144, D145 |

### The 24 candidates

| Candidate | Status | Evidence |
| --- | --- | --- |
| `memory-user-fixed-overhead` | Fixed | S4: TextSketcher arrays start at 64 slots and grow (98d31ef6e: 16.3 KB less per light user) |
| `example-default-prompt-empty` | Fixed | S6: the example agent's default prompt cites the sample calendar (8b0897d54) |
| `sourcechanged-silent-false` | Fixed | S3, finding B12: an ignored notice returns `reason` (`push-off`, `not-synced`, `not-notifying`; D148) |
| `fresh-sourcechanged-keeps-pages` | Fixed | S3, finding B6: every notice drops the source's held search pages (D148) |
| `client-sourceremoved-ambiguous-zero` | Fixed (doc) | S3: `sourceRemoved`'s doc says it counts cached items dropped; `sourceNotice` gives `{synced, reason?}` (D148) |
| `config-errors-one-at-a-time` | Fixed in part; the rest rejected | S7: `EDEN_SOURCES_FILE` goes through `checkSpecs`, and a bad file exits 2 with one line naming the entry (ef8217ef1). Reporting every error at once is rejected as low value: startup stops at the first bad entry and names it, so each round trip fixes one entry |
| `timed-utc-start-day` | Fixed (merged into the integration branch) | Package `timed-zone-day` (`audit/2026-11-05-final1-timed-zone-day`, c98570273): a UTC start is read on the user's local day (`dayOf` in grounding.ts); its test failed 2 of 5 cases before the fix; eval and stub funnel unchanged |
| `lat-reader-stream-early-settle` | Decided | D147 (an estimated 1.12x at p50) |
| `anthropic-cache-dead-flag` | Decided | D145: a trial with an owner and an end date |
| `reader-push-ask-verdict-reuse` | Decided | D116 already rejected reusing the push's verdict for the ask (trial `askReaderReuse`) |
| `r2-anticipate-redundant-under-sync` | Decided | D153: anticipation stays. With every reader prompt replayed, removing it is hidden +0 −0, decoys +2 −1 and 1.16x fewer unpaid connector calls, and its latency gain is invisible at `--time 0` |
| `lat-reader-ids-only-card-bearing` | Decided | D96 and D147: a reply of ids only drops the `why`-first reasoning that cut the reader's decoys from 88 to 13 (haiku-opt.md v4, D144) |
| `ingest-inline-secret-prefilter` | Rejected (under 1.5x) | A scratch timing in this step (`SECRET_INLINE`'s patterns as one `replace` over the 1,487 items of `buildWorld({seed: 41000})`, 6 runs, shared box): 3.6-6.0 µs/item, 12-25% of `sanitizeForStore`. Shipped ingest on this tree is 402 µs/item (`bun packages/engine/bench/ingest.bench.ts --quick`), so the whole pass is about 1-1.5% of ingest, not the claimed 12-15%; even deleting it would be at most 1.015x. `redact.ts:318-321` records why there is no prefilter (`replace` returns the string untouched when nothing matches; a hand-written gate drifted) |
| `render-pick-score-fastpath` | Rejected (under 1.5x) | The candidate's own figure, 7.8% of pipeline CPU (not re-measured), caps the gain at 1/(1-0.078) = 1.08x |
| `devloop-simindex-incremental` | Rejected (under 1.5x) | The candidate's own figure, 25% of the freshness sim's CPU (not re-measured), caps it at 1.33x |
| `freshen-only-routed-sources` | Rejected (under 1.5x) | Measured by the candidate at 1.25x (not re-measured) |
| `lazy-mcp-sdk` | Rejected (under 1.5x) | Importing the MCP SDK client and stdio transport took 113-145 ms in a fresh process (3 runs in this step, `bun -e` with `performance.now()`, shared box). `bun run funnel --jobs 4` runs its 4 processes at once, so the wall cost is about one import against the funnel's 10 s (docs/LAB.md 2a): about 1.5% (estimate from those two figures) |
| `where-1-5x-impossible` | Closed (informational) | A list of negative results; nothing to fix |
| `r2-fastpath-tail-is-delivery-render` | Closed (informational) | Where the fast path's tail goes; no change proposed above 1.5x |
| `funnel-ceiling` | Closed (informational) | The funnel's ceiling as a measurement note; no change proposed |
| `ab-baseline-cache` | Closed by an existing tool | `pi-ab.ts --reuse-arms F` copies the `none`/`tools` arms from a matching earlier run (`pi-ab.ts:51-53`; packages/sim/src/lab/CLAUDE.md, "Pay once") |
| `format-check-needs-git` | Rejected | `scripts/format.sh` lists files with `git ls-files`; every checkout this repo supports is a git checkout, worktrees included |
| `lat-speculative-first-call` | Rejected (under 1.5x, adds paid cost) | D156, measured from the final live Pi run's task traces: at most 1.05x (measured silent share) to 1.14x (the candidate's 62%) on task wall time, for +21% to +40% of agent spend (estimates) |
| `cost-reader-pool-gate-learned` | Closed by D110 | D157: in the checked-in Haiku reader replay a perfect gate caps the reader at 2.19x and Eden's model spend at about 1.41x (estimate); D110's learned cascade decided 2.5% of calls at its loss limit |

### Docs corrected in this step

- "Closing the run": the graph Stage 2 row said a trials-table row was added with the switch, but no switch or trials
  row was ever made. It now points to D150, as do the two other rows that called `graphLite` not yet built.
- `packages/engine/CLAUDE.md`: its two overlapping `syncPush` (D125) pitfalls are now one bullet; D149 (cards send no
  reasoning) and D150 (`READ_CHARS` 1,000) have pitfalls.
- Still to change with D150's merge (outside this step's files): `docs/COST-MODEL.md:462` called `graphLite` "not yet
  built". Done in "Closing the second pass: final loose ends" below.

## Closing the second pass: final loose ends

Checked on 2026-11-05 at `audit/2026-11-05-integration` (a0e4da57e) plus this step's docs (package
`close-docs-loose-ends`, which documents package `drop-maker-reasoning-options`; the two merge together). No paid
calls were made in this step: every new figure comes from files already on disk or from the $0 commands named next to
it.

### Flags and options of the run

Every switch the two passes added, kept or removed, and where it stands. D112 allows only shipped defaults and trials
with an owner and an end date; the rest is wiring or a developer flag.

| Flag or option | Where | Status |
| --- | --- | --- |
| `reasoning` on `ModelReaderMaker` and `ModelCardMaker` | `packages/engine/src/reader.ts`, `cards.ts` | Deleted (D155): both makers send no reasoning field; the lab's "low" arms wrap the model instead. The judge's hard-coded "low" stays: the servers wire no judge |
| `anthropicCache` | `OpenRouterOptions`, `packages/llm/src/openrouter.ts:40` | Trial (D145; owner repo owner, ends 2026-12-03). Still off: its deciding probe is an OpenRouter call, outside this run's Anthropic-only rule. Next step: that probe by 2026-12-03 |
| `syncBigPageSize`, `Source.listPageMax` | sync | Deleted with their code (D143) |
| `graphLite` | none | Never built: D150 promoted the graph's 1,000-character read with no switch |
| `onFailure`, `log`, `scrub`, `make` | `AskReader` (`build.ts:100`), `buildPartner` (`build.ts:53`), `models.ts:33`, `liveWiring` (`packages/eval/src/run.ts:81`) | Wiring hooks (where a failure is logged, how its text is redacted, which client a lab run builds); none switches behaviour |
| `CHECK_COLD=1` | `scripts/format.sh:62` | Dev flag: a format check that trusts no cache from an earlier run |
| `--quick` | `packages/engine/bench/ingest.bench.ts:42` | Dev flag: 40 users instead of 200, for a screen while iterating |
| `--jobs N` | `bun run funnel` (`packages/sim/src/lab/funnel.ts`) | Dev flag: processes for the funnel's shards (D139) |
| `--judge`, `--usd-cap` | `bun run eval --live` (`packages/eval/src/cli.ts:24`, `:31`) | Dev flags: the pre-D128 judge shape, and the required dollar cap on a paid run |

The trials table in docs/DECISIONS.md is unchanged by this step: action firewall, tsgo and `anthropicCache`, all
ending 2026-12-03.

### Measurements on the final tree

All on a0e4da57e plus this step's docs (documentation changes only), on the shared 4-core box:

- `bun run check`, run three times. The first run had 1 failure of 1,666: `ask-deadline.test.ts:119` timed the ask
  at 801 ms against its 750 ms bound. That run started as `ingest.bench.ts` finished, on a loaded box. The next two
  runs passed, 1,666 tests, 0 fail, in 139 files (23.7 s and 24.2 s for the tests). The test is timing-bound, so treat
  it as flaky under load; this step does not touch code.
- `bun run eval`: 31 scenarios, precision 0.8276, recall 0.48, falseFireRate 0.
- `bun run funnel --json F` (stub reader): hidden 214/384, decoys 211/384; reader pool hidden 230/384, decoys
  229/384, over 658 stub reader calls. Same as the audit's baseline.
- `bun packages/engine/bench/ingest.bench.ts`, two full runs: `core` 68.7 and 65.1 µs per backfilled item, `shipped`
  261.8 and 258.9 (3.81x and 3.98x `core`), `+graph` 86.2 and 90.3. docs/COST-MODEL.md now gives these post-D150
  figures in place of the pre-D150 ones (5.2-5.4x) and no longer calls `graphLite` "not yet built".
- At a0e4da57e, before the two final2 packages, `git branch --no-merged audit/2026-11-05-integration --list
  'audit/2026-11-05*'` printed nothing: every first-pass and final1 branch was merged into the integration branch.
  The two final2 branches (`audit/2026-11-05-final2-close-docs-loose-ends`, which holds this section, and
  `audit/2026-11-05-final2-drop-maker-reasoning-options`) are not merged by construction; they merge together
  after this review.
- `git branch -r | grep -c r10-` prints 42.

### What this step closed

| Item | Outcome | Where |
| --- | --- | --- |
| `lat-speculative-first-call` | Rejected: 1.05x to 1.14x on task wall time (upper bounds) for +21% to +40% of agent spend (estimates), from the final live Pi run's traces | D156 |
| `cost-reader-pool-gate-learned` | Closed by D110: a perfect gate caps the reader at 2.19x and Eden's model spend at about 1.41x, and D110's learned cascade decided 2.5% of calls | D157 |
| The makers' `reasoning` options (`drop-maker-reasoning-options`) and the "judge still sends low" note | Options deleted; the judge's "low" stays, lab-only | D155 |
| `scale-graph-dominates-ingest`: docs after D150 | COST-MODEL.md's shipped-ingest paragraph re-measured; graph-ablation.md's status and research/INDEX.md's row point to D150 | D150 |
| Low note 8c (`TenantHolds` entries kept per tenant) | Unchanged: bounded at one entry per configured API key ("Every deferred item" above) | This file |
| Final live Pi A/B (item 10) and Hermes live check (item 11) | Done: Pi 77.3% vs 9.4%, 0/128 false concerns; Hermes 70.3% vs 4.7%, 1/64 | [docs/research/final-live-2026-11-05.md](../research/final-live-2026-11-05.md) |

### Left for the owner

- Delete the 42 stale `origin/claude/r10-*` branches (`git branch -r | grep -c r10-` prints 42; the 2026-11-04 audit
  counted 41). Deleting remote branches needs the owner's approval.
- Merge the integration branch into `main` after the `reviewer` subagent has run on the engine and server diff
  (CLAUDE.md step 5), then `bun run check` and `bun run eval` on the final tree.
- The D145 probe (`anthropicCache`) by 2026-12-03, with a key OpenRouter serves Anthropic models for.

## Final summary of the whole run (for the owner)

> **Superseded in part by the second pass.** This summary was written before the second pass. Its rows that call the
> shipped reader untimed, say a change is not in `main`, or mark an item blocked externally are out of date: the
> second pass timed the reader on Anthropic (D144), ran the live eval and the live Pi and Hermes checks on the lab
> transport, and decided the D130 veto by name (D151) ("Closing the second pass" above); `main` (cf38efb09) holds the
> first pass, and the second pass waits in the integration branch for the reviewer and a merge. See "Closing the
> second pass: final loose ends" above for the current state.

This section closes the run. It covers two audit rounds and two final clean-up steps. Every number comes from a
command or commit message recorded in this run; numbers marked "estimate" were not measured. Benchmarks ran on a
4-core machine shared with other agents, so timings move between runs.

Words used below:

- **Ask**: the agent asks Eden a direct question.
- **Fast path**: the work Eden does on every event without any model call.
- **Re-read**: Eden fetches an item again to check it is still current before handing it out.
- **Eval / funnel**: the two free ($0) quality screens. The eval scores 31 scenarios (precision, recall, false
  fires). The funnel counts hidden facts found and decoys handed out on the six training suites.
- **Reader**: the small paid model that reads candidate items before Eden hands them out.
- **Integration branch**: `audit/2026-11-05-integration`, where every fix of this run is merged. It is not in `main`
  yet.

### 1. The bottom line

Eden could tell an agent "Nothing in the connected sources." when every source was down. That is now an honest
"could not reach" answer (D127). A deleted message could come back and be delivered if the deletion arrived while
Eden was re-checking it, and three timing races let old copies be handed out as current. All four are fixed and
tested. Several caches were not truly bounded in memory, and the fast path repeated the same analysis on every
event. The fast path now takes 1.16-1.31 ms per event instead of 3.01-3.08 ms on the pipeline benchmark (2.3-2.7x),
with eval and funnel scores unchanged (precision 0.8276, recall 0.48, false fires 0; hidden 214/384, decoys
211/384). Paid model cost did not change; the shipped paid reader is still untimed, because this environment's key
is refused (403) for the default model.

### 2. Findings by dimension

"Found" is every candidate. "Verified" survived two independent checks. "Fixed" means the fix is merged in the
integration branch (git confirms it). "Closed by decision" means verified but not fixed, with a decision row
saying why. "Open part" counts verified findings that still have work left (some are also fixed in part).

| Dimension    | Found | Verified | Rejected at verification | Fixed (merged) | Closed by decision | Open part |
| ------------ | ----: | -------: | -----------------------: | -------------: | -----------------: | --------: |
| Correctness  |     9 |        6 |                        1 |              6 |                  0 |         0 |
| Scale        |     9 |        6 |                        1 |              5 |                  1 |         1 |
| Latency      |     8 |        3 |                        1 |              2 |                  1 |         0 |
| Cost         |     8 |        4 |                        0 |              1 |                  3 |         3 |
| Quality      |     3 |        3 |                        0 |              1 |                  2 |         1 |
| Pain points  |     7 |        3 |                        0 |              3 |                  0 |         1 |
| Inefficiency |     4 |        1 |                        1 |              1 |                  0 |         0 |
| Dev loop     |    14 |        8 |                        1 |              7 |                  1 |         2 |
| Moonshot     |     2 |        1 |                        0 |              0 |                  1 |         0 |
| **Total**    |    64 |       35 |                        5 |             26 |                  9 |         8 |

24 found candidates were neither verified nor rejected: the run's ledger records no outcome for them (see section
5). Review: git shows review-fix commits on four branches (`r1-ask-honest-answers` 2ec5fc401,
`r1-engine-cache-sync-holds` c9ee1f304, `r2-r2-worktree-check-caches` ee46478d4, `final1-lc-sync-big-pages`
f41ee1512). The other branches are single fix commits; git alone cannot show whether a reviewer passed them
unchanged.

### 3. What was achieved

One row per merged fix. "Before -> after" is from the fix's own commit unless noted. "Default" means it ships in
`DEFAULT_CONFIG` or in the shipped code path for everyone.

| Fix (branch)                                                                                      | Before -> after (measured unless labelled)                                                                                                                                                                                                                         | Outcome                                                          |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| Honest ask when sources fail; "shown above" only after hand-out (`r1-ask-honest-answers`)         | All-failed ask: "Nothing in the connected sources." -> names the unreachable sources and says it is not an all-clear (tests). Eval unchanged.                                                                                                                      | Default (D127)                                                   |
| Docs keep the measured 3 s wait (`r1-docs-integration-wait`)                                      | README, INTEGRATION.md and the example set a 1,500 ms wait -> they use the client's 3,000 ms default.                                                                                                                                                              | Default (docs)                                                   |
| Deletion holds, lazy sketch, read marks (`r1-engine-cache-sync-holds`)                            | Deletion notice for an unseen user: ~27.8 KB of cache and a real user evicted -> 410 B per removal, no eviction. Ingest backfill 94.2/91.5 -> 58.8/52.9 µs/item. Signal-during-read race: repro fixed; freshness sim unchanged (575 re-reads, stale 1, deleted 0). | Default (D133)                                                   |
| Results cache bounded and fast to drop (`r1-fanout-results-cache`)                                | 200,000 empty pages: ~69 MB held -> under the 4 MB test budget. Dropping one user's pages from 10,000 entries: 1.355 -> 0.005 ms mean (scratch bench). Cost: +63 B per entry.                                                                                      | Default                                                          |
| Per-item analysis cache and fold early exit (`r1-fastpath-analysis-cache`)                        | Pipeline bench 3.08/3.01 -> 1.31/1.16 ms/event; observe p99 14.8/14.1 -> 5.3/4.8 ms. 0 verdict differences over 72,234 compared.                                                                                                                                   | Default                                                          |
| `eval --live` measures what ships (`r1-shipped-reader-path`)                                      | `--live` ran judge on, reader off -> the shipped wiring, and refuses to start without `--usd-cap`. A failing reader is now logged once instead of failing silently. No paid run (blocked, section 5).                                                              | Default (D128)                                                   |
| Faster freshness simulation (`r1-sim-reindex-memo`)                                               | 22.2 s -> 11.9 s (memo) -> 5.6 s (`--jobs 4`), same report.                                                                                                                                                                                                        | Dev tool                                                         |
| Deleted item no longer revived; one ask deadline; no wasted re-reads (`r2-r2-engine-fresh-ask`)   | Deletion during a re-read: item delivered -> not delivered (test). Time before the reader with hanging sources: 3,020 -> 1,524/1,503 ms. A gated ask: 1 re-read -> 0.                                                                                              | Default (D134, D140)                                             |
| Joined source calls respect change signals (`r2-r2-fanout-joined-flights`)                        | Engine repro: 2 of 2 deliveries stale (verifier) -> repro passes. Eval, funnel and freshness sim unchanged.                                                                                                                                                        | Default (D133)                                                   |
| Deletion holds last 10 minutes for large tenants (`r2-r2-tenant-holds-cap`)                       | Per-tenant cap 20,000 -> 100,000 holds, so holds last the full 10 minutes up to ~167 deletions/s instead of ~33 (arithmetic from the cap).                                                                                                                         | Default                                                          |
| One shared empty array in the analysis cache (`r2-r2-conflict-empty-marks`)                       | 6,805 -> 3,413 B per assessed item (38.3 -> 19.2 MB on the test workload). Pipeline speed unchanged.                                                                                                                                                               | Default (D136)                                                   |
| Funnel runs one process per core (`r2-r2-funnel-grouped-shards`)                                  | `bun run funnel` 24.1-26.4 s -> 11.7-15.4 s wall, for 1.25-1.5x the CPU.                                                                                                                                                                                           | Dev default (D139)                                               |
| Check caches that carry to a new worktree (`r2-r2-worktree-check-caches`)                         | First `format:check` in a new worktree 13.5 s -> 1.4-1.8 s; first `typecheck` 11.1 s -> 3.6-4.0 s (docs/TESTING.md).                                                                                                                                               | Dev default; `CHECK_COLD=1` skips the caches                     |
| Docs carry `--usd-cap`; slow tests trimmed (`r2-r2-devloop-tests-docs`)                           | Documented `bun run eval --live` exited 2 -> docs show `--live --usd-cap 0.05`. review-regressions test file 4.0 s -> 1.0-1.1 s.                                                                                                                                   | Dev default                                                      |
| Ingest bench measures what ships; paid graph test (`r2-r2-graph-ablation`)                        | The bench measured the core only: 73.4 µs/item; the shipped path is 380.6 µs/item (5.18x). Paid funnel ($0.43): with graph 247 hidden / 127 decoys, without 243 / 129.                                                                                             | Measurement; the graph stays default (D141)                      |
| Decision rows and closing table (`final1-lc-decisions-docs`)                                      | Docs only: D141 row and the "Closing the run" table.                                                                                                                                                                                                               | Docs                                                             |
| Bigger backfill and sweep pages (`final1-lc-sync-big-pages`, then `final2-delete-sync-big-pages`) | Backfill calls per user 33 -> 9; source calls per user-day 126.8 -> 103 (sim). But the reader's pool fell 230/229 -> 228/228 and the paid reader lost 2 hidden facts of 384 in both paired runs.                                                                   | Shipped off as a trial (D142), then removed with its code (D143) |

The final tree (326d93876, before this summary) passes `bun run check`: 1,614 tests pass, 0 fail, in 135 files
(the run started at 1,536 in 129). Eval and funnel equal the starting baseline. No paid calls were made outside
the graph test ($0.43) and the big-pages reader screen ($0.1875).

### 4. Decisions made during the run

All rows are in `docs/DECISIONS.md` (lines 133-149).

| Decision                                                              | Evidence                                                                                                 | Row  |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---- |
| An ask whose sources failed says so; it is not an all-clear           | Two scratch tests with failing sources got "Nothing in the connected sources."                           | D127 |
| `eval --live` wires what ships and needs a dollar cap                 | It ran judge on and reader off, the reverse of the servers                                               | D128 |
| Reader push on question turns is not reopened                         | Oracle ceiling recall 0.52; D99/D112 measured it live and deleted it                                     | D129 |
| A broad reader veto over rule deliveries is rejected                  | It drops right items with wrong ones even with a perfect reader                                          | D130 |
| Change signals stay source-wide                                       | The payload path already gives 0 re-reads to integrators who know what changed                           | D131 |
| Agent replay at time scale 0 is not built                             | It would score timing regressions as neutral                                                             | D132 |
| Freshness is judged by read marks, not read times                     | Race repro now re-reads; freshness sim unchanged (575 re-reads, stale 1, deleted 0)                      | D133 |
| Re-reads ahead of the reader stay at 3, start only if the reader runs | Lowering it saves at most 1.34x calls, under the 1.5x bar; gated asks now do 0 re-reads                  | D134 |
| The source results cache stays                                        | 1 hit in ~860 lookups, but the harnesses cannot repeat a query; not evidence it is dead                  | D135 |
| Analysis cache keeps its WeakMap with one shared empty array          | 8,598 -> 3,956 B per item (verifier); a byte cap would undo the speed gain                               | D136 |
| Intent requests stay sentences                                        | Keyword output saves an estimated 1.06-1.13x per call, under the 1.25x bar                               | D137 |
| A cold user's sources are not warmed in the background                | No measured first-lookup gain; connect already sits inside the 1.5 s deadline                            | D138 |
| `bun run funnel` runs one process per core                            | 1.6-2.4x faster wall (verifier); identical task rows                                                     | D139 |
| An ask's poll and live search share one deadline                      | Worst case before the reader ~3,010 ms -> ~1,500 ms; eval and funnel counts unchanged                    | D140 |
| The knowledge graph stays in the default                              | Paid funnel: +4 hidden, +2 decoys of 384 with it; eval identical                                         | D141 |
| Big sync pages as a trial, off by default                             | Calls 33 -> 9 per backfill, but the reader's pool moved 230/229 -> 228/228                               | D142 |
| The big-pages trial ends and its code is deleted                      | Paid reader lost 2 hidden of 384 in both runs; the gain is listing calls only, which cost no model money | D143 |

### 5. What is still open, and why

| Open item                                                                                               | Why it is open                                                                                                                                                               | Next step                                                                                                                             |
| ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Merge the integration branch into `main`                                                                | External action: `main` is still at 6911f514d. Engine, server and privacy changes need the `reviewer` subagent first (CLAUDE.md step 5); the last integrator did not run it. | Run the reviewer on `main..audit/2026-11-05-integration`, fix its findings, `bun run check`, then merge.                              |
| Paid timing of the shipped reader (`painpoint-prod-reader-unmeasured`, stage 1)                         | External action: this key gets 403 "violation of provider Terms Of Service" for Anthropic models, and the lab ledger meters only `claude-*` ids.                             | Owner supplies a key OpenRouter serves for `anthropic/claude-haiku-5.5`; add a ledger entry type for OpenRouter ids; time the reader. |
| The paid `eval --live` run (`eval-live-measures-unshipped`)                                             | Same key block. The wiring is fixed.                                                                                                                                         | With a served key: `bun run eval --live --usd-cap 0.05`.                                                                              |
| Reader veto by name (`quality-reader-veto-rule-path`)                                                   | Paid; it needs the live eval above first (D130).                                                                                                                             | Screen it after the live eval.                                                                                                        |
| Start re-reads when the reader's stream names an item (`fresh-checkahead-speculative-rereads`, stage 2) | Needs reader streaming and a paid live latency run (same key block).                                                                                                         | After the key is fixed, build behind a trial and time it (D134).                                                                      |
| A lighter graph (`scale-graph-dominates-ingest`, stage 2)                                               | D141 chose it as the next step at the end of the run; it was not built in this run.                                                                                          | Closed by D150 ("Closing the second pass" below): no `graphLite` switch was needed.                                                  |
| A cheaper model endpoint for intent-only card items (`cost-intent-requests-keyword-output`, stage 2)    | External: an owner decision about a new endpoint (D12/D98).                                                                                                                  | Owner decides.                                                                                                                        |
| Exact request replay in the agent lab (`devloop-agent-replay-identical-eden`)                           | Rejected as proposed by D132.                                                                                                                                                | Do it with the Hermes request-replay item from the 2026-11-04 audit.                                                                  |
| Big sync pages (`sync-sweep-backfill-big-pages`)                                                        | Rejected after measurement (D143).                                                                                                                                           | Reopen only with a tie-break for equal-score ask candidates that does not depend on ingest order.                                     |
| 24 candidates with no recorded outcome                                                                  | The ledger lists them as found but neither verified nor rejected; nothing in docs/ mentions them.                                                                            | Next audit round: verify or drop each one (list below).                                                                               |
| Carried from the 2026-11-04 audit                                                                       | 41 stale `origin/claude/r10-*` branches and a Hermes live check need owner approval.                                                                                         | Owner approves; then delete the branches and run the check.                                                                           |

The 24 candidates: `ingest-inline-secret-prefilter`, `memory-user-fixed-overhead`, `example-default-prompt-empty`,
`sourcechanged-silent-false`, `timed-utc-start-day`, `lat-speculative-first-call`, `lat-reader-stream-early-settle`,
`lat-reader-ids-only-card-bearing`, `reader-push-ask-verdict-reuse`, `cost-reader-pool-gate-learned`,
`ab-baseline-cache`, `fresh-sourcechanged-keeps-pages`, `freshen-only-routed-sources`, `anthropic-cache-dead-flag`,
`where-1-5x-impossible`, `lazy-mcp-sdk`, `config-errors-one-at-a-time`, `funnel-ceiling`,
`r2-anticipate-redundant-under-sync`, `r2-fastpath-tail-is-delivery-render`, `render-pick-score-fastpath`,
`client-sourceremoved-ambiguous-zero`, `format-check-needs-git`, `devloop-simindex-incremental`.

**Where the run's data and git disagree:**

- Git confirms all 19 `audit/2026-11-05-*` branches are merged in the integration branch
  (`git branch --merged`). No disagreement there.
- The ledger's "resolved" list counts 9 findings closed by decision (not fixed) as resolved, and lists some ids
  twice. Section 2 separates them.
- The ledger's "unresolved" list is empty, but 8 verified findings still have open parts (above).
- The ledger still lists `fresh-readat-race`'s exact per-copy variant as deferred. Git shows it done: c9ee1f304
  stores a read mark with every copy (D133).
- The ledger still lists deleting the graph's code as waiting; D141 has since rejected it.
- The round-1 text below says 20 findings were verified; its own numbered list and the ledger have 19.

### 6. Where everything is

- This file: `docs/audits/2026-11-05-deep-audit.md`. Round 1 and round 2 details follow below.
- Decisions D127-D143: `docs/DECISIONS.md`, lines 133-149.
- Integration branch: `audit/2026-11-05-integration` (branched from `main` at 6911f514d; this summary is its tip).
- Per-package branches (local; this checkout has no `origin` copy of any of them):
  - Round 1: `audit/2026-11-05-r1-ask-honest-answers`, `-r1-docs-integration-wait`, `-r1-engine-cache-sync-holds`,
    `-r1-fanout-results-cache`, `-r1-fastpath-analysis-cache`, `-r1-shipped-reader-path`, `-r1-sim-reindex-memo`.
  - Round 2: `audit/2026-11-05-r2-r2-engine-fresh-ask`, `-r2-r2-fanout-joined-flights`, `-r2-r2-tenant-holds-cap`,
    `-r2-r2-conflict-empty-marks`, `-r2-r2-funnel-grouped-shards`, `-r2-r2-worktree-check-caches`,
    `-r2-r2-devloop-tests-docs`, `-r2-r2-graph-ablation`.
  - Final steps: `audit/2026-11-05-final1-lc-decisions-docs`, `-final1-lc-sync-big-pages`,
    `-final2-delete-sync-big-pages`.
- Research notes written or updated: `docs/research/graph-ablation.md`, `docs/research/econ-background.md`,
  `docs/research/freshness.md`.

## Summary (read this first)

This audit ran on `main` at 6911f514d (after D126, freshness). It found 20 problems that survived adversarial
verification: each one was re-checked by two independent verifiers, who re-ran the cited command or wrote a scratch
reproduction. Below, every finding gives its evidence, what it costs users or developers, the fix, and its status.
Numbers come from the verifiers' runs; anything not measured is labelled an estimate.

In plain terms:

- **One serious answer bug.** When every connected source is down or times out, `ask` replies "Nothing in the
  connected sources." That is the same text as a real empty result, so an agent can act on an outage as if it were an
  all-clear. Fixed in package P1 (decision D127).
- **A second answer bug.** An `ask` can say an item was "(shown above)" when the agent has not received that packet
  yet: it is still waiting in the pending queue. Agents that only call `ask` never see the fact. Package P1.
- **The docs steer integrators below the measured default.** README, the integration guide and the example agent set
  a 1.5 s wait, which overrides the client's measured 3 s default, and one sentence contradicts the code. Package P2.
- **Memory and CPU problems that grow with users:**
  - The fan-out's results cache charges an empty page 1 byte, so its 32 MB budget does not bound real memory.
  - Every cache drop scans the whole results cache.
  - A burst of deletion notices for unknown users evicts real users' caches.
  - About half of fast-path CPU repeats the same conflict analysis on the same items.

  Packages P3, P4 and P5.

- **A measurement gap.** `bun run eval --live`, the merge gate's paid check, measures a configuration that does not
  ship (judge on, reader off), and the shipped reader path through OpenRouter has never been timed. With this
  session's key, every call to it returns 403. Package P6 (decision D128).
- **A slow dev loop.** The freshness simulation spends about half its time rebuilding its search index. A memo makes
  it about 1.65x faster. Package P7.
- **Five proposals rejected or deferred with evidence:**
  - Reader push on question turns: D129.
  - Broad reader veto: D130.
  - Per-item change signals: D131.
  - Agent replay at time scale 0: D132.
  - Bigger sweep pages: deferred behind P3.

Seven work packages (P1 to P7) share no files and can run in parallel. Fixers do not edit `docs/DECISIONS.md`: where a
package needs a new decision, its commit message carries the proposed row under `Decision row:`, and the integrator
appends it as D133 (P3) or D134 (any other).

Terms used here:

- **Eval**: the free scenario test (precision, recall, false-fire rate).
- **Funnel**: the free screen of Eden on the training tasks (hidden facts found, decoys delivered).
- **Reader**: the small model that reads candidates before delivery; each call costs money.
- **Oracle reader**: a stand-in reader that flags exactly the right items; it gives an upper bound.

**Round 2** (after round 1's deferred list) re-audited the merged integration branch. It found one high privacy
bug (a re-read in flight brings a deleted item back and delivers it), a hole in round 1's freshness fix, a 3 s
worst-case wait before an ask's reader, and memory and dev-loop costs: 16 findings, 8 packages (R2-P1 to R2-P8),
decisions D133-D140. Its own plain-language summary is under "Round 2 in plain terms".

## Findings, ranked by value (severity, then effort)

Status key:

- **P1-P7**: packaged this round (see "Work packages").
- **Rejected**: not fixed, with the decision that records why.
- **Deferred**: waiting, with the reason.

### 1. `ask-false-all-clear`: ask says "Nothing in the connected sources." when every source failed (high, S)

- **Evidence.**
  - partner.ts:1359 picks the phrase whenever `items` is empty. AskResponse (protocol/src/types.ts:87-94) has no
    source status.
  - The per-source outcomes exist inside `searchLive` (partner.ts:2751) but are not returned (2767-2771).
  - The D93/D114 guard (partner.ts:1620-1623) covers only the reader-drop case.
  - Two scratch tests, DEFAULT_CONFIG and CORE_CONFIG, with one source throwing `503 upstream down` and one never
    answering, both returned `{"answer":"Nothing in the connected sources.","citations":[],...}` (latencyMs
    1,512-1,562). A healthy empty source returns the same answer in 2 ms.
  - http.ts:100 and mcp.ts:21 pass the answer through unchanged.
- **Impact.** Every connector outage becomes a confident false all-clear. Integrators cannot tell "empty" from
  "unreachable".
- **Fix.**
  - Carry outcome statuses out of `searchLive` and `freshen`.
  - In the answer text, name sources that could not be reached and say this is not an all-clear. MCP callers see
    only text.
  - Add optional `sources?: {sourceId, status}[]` to AskResponse.
  - Count as answered: ok, cached, stale, and a local-index answer. Busy, limited and open count as not answered.
- **Status.** P1. Decision D127.

### 2. `scale-results-cache-unbounded`: the results cache budget is not real memory (medium, S)

- **Evidence.**
  - guarded.ts:596-601 `sizeOf` is `Math.max(1, title+text length)`, and the key is never charged. Empty pages are
    cached (guarded.ts:421, :563).
  - Expiry is lazy (primitives/src/cache.ts:117-126), and `evict` runs only under byte pressure.
  - Scratch script (S3FifoCache, 32e6 bytes, 200,000 empty pages with ~120-char keys over 2,000 simulated s): size
    200,000, bytes counted 200,000, heap +66.7 MB = 334 B/entry. 140,000 of those entries were past expiry.
  - A second run measured 340 B/entry.
- **Impact.** Under a workload of mostly empty results, the cache grows with no practical bound. With a realistic mix,
  heap is bounded at a few times maxBytes (estimate). The original finding said critical and ~10 GB; verifiers
  downgraded it, because that figure assumes every page is empty.
- **Fix.**
  - Charge `key.length*2` plus a measured per-entry overhead (~340 B) in `sizeOf`. This alone is the real bound.
  - `expireSome` at the FIFO heads is optional and weaker (re-set keys and main-ring reinsertions stall it), so it is
    not required.
- **Status.** P4.

### 3. `eval-live-measures-unshipped`: `eval --live` measures judge on, reader off (medium, S-M)

- **Evidence.**
  - cli.ts:45 builds `OpenRouterModel.fromEnv()` (default `z-ai/glm-5.3-flash`), and run.ts:191-198 passes it as the
    judge.
  - `parseReaderOption` refuses a live reader (reader-stub.ts:23-27).
  - The server wires no judge and AskReader over ModelReaderMaker on `anthropic/claude-haiku-5.5` (build.ts:67-69,
    :76; models.ts:16).
  - The eval wires no cards either.
  - `bun run eval --reader stub`: precision 0.828, recall 0.48, falseFireRate 0, 6 reader calls.
- **Impact.**
  - The merge gate's paid number (D119: 0.923/0.72/0.0147) describes a configuration that does not ship.
  - No reader-side change can be screened live in the eval.
  - Not user-facing: the Pi lab measures the shipped path (D112, D125).
- **Fix.**
  - `--live` wires what `buildPartner` wires (no judge, live reader on the shipped role model), with cards labelled
    inert.
  - `--live --judge` keeps the old shape.
  - The run refuses to start without a hard dollar cap. The lab `SpendLedger` is in `@eden/sim`, which the eval may
    not import, and it meters only `claude-*` ids.
- **Status.** P6. Decision D128. The paid run itself is deferred (see "Deferred").

### 4. `painpoint-prod-reader-unmeasured`: shipped reader path untimed; 403 with this key (medium, S)

- **Evidence.**
  - Production reader: OpenRouter, Haiku 5.5, throughput sort, ZDR, reasoning "low" (models.ts:16, :48-55;
    reader.ts:479-485).
  - Lab readers are Anthropic-direct with thinking off (free.ts:103-112). In the ledger, 7,356 `eden.reader` rows
    are all `claude-haiku-5-5` direct, and 0 carry reasoningTokens.
  - Decode is 3.62 ms/token at p50 (6,831 rows).
  - A probe of three arms (ZDR+throughput, no-ZDR+throughput, ZDR default) all returned `openrouter 403: "...
violation of provider Terms Of Service."`, $0 booked. The key is valid (limit 100, not free tier). The model has
    healthy endpoints.
- **Impact.**
  - Reasoning "low" may add about 1,024 × 3.62 ≈ 3.7 s (estimate, assuming Anthropic's thinking floor), past the
    3,000 ms wait.
  - If the 403 is not account-specific, the shipped reader fails open on every call.
  - Quality under "low" is also unmeasured: D96's "reason first" is the prompt's field, not model reasoning.
- **Fix.**
  - Now ($0): log the reader's first failure reason, and the provider error text, once per process. Use no extra
    model call; a startup probe would be a model call outside the "Model last" rule.
  - Later (paid): 20 production-shaped calls per arm with a key OpenRouter serves.
- **Status.** P6 for the $0 part. The paid timing is deferred.

### 5. `ask-shown-before-handed-out`: ask says "(shown above)" for a packet still pending (medium, S)

- **Evidence.**
  - `build()` calls `noteShown` at build time (partner.ts:4547-4551; `askDedup` on in DEFAULT_CONFIG,
    config.ts:571).
  - The slow path only queues into `s.pending` (partner.ts:829, 890, 953, 1327). takePending and handOut
    (1037-1043, 1863) never mark shown words.
  - Two scratch tests (DEFAULT_CONFIG, 300 ms source, observe with waitMs 0, ask before takePending) gave
    `- [drive] Procurement policy v4: (shown above)`. The full text arrived only afterwards via takePending.
- **Impact.**
  - An agent that asks while a reading is in flight gets only a title.
  - An agent that never polls pending never sees the fact.
- **Fix.**
  - Note shown words at hand-out: observe's returned injection at :721, :1179, :1384, and takePending. Do it before
    handOut's early returns.
  - In ask, drop from pending an untaken packet only when the answer cites all its items. Otherwise leave it queued.
    `withdraw` is not usable: it acts only on `undoable` entries.
  - Regression test with a two-item pending packet where the answer cites one.
- **Status.** P1.

### 6. `docs-wait-1500-degrades`: docs hard-code a 1.5 s wait over the 3 s default (medium, S)

- **Evidence.**
  - client.ts:123 sets `DEFAULT_WAIT_MS = 3_000`, applied at :196.
  - README.md:38 and docs/INTEGRATION.md:15 set `defaultWaitMs: 1500`.
  - examples/personal-agent/agent.ts:82-87 defaults to 1,500 and calls the reader "experimental (NEW, D98)".
  - INTEGRATION.md:48 says the client sends none by default, which contradicts :53 and the code.
  - README.md:50-51 is also stale.
- **Impact.** Copy-paste integrators wait less than the reader's p90 (1,768 ms). A 1 s wait lost 7.6 and 18.1 Pi
  points (INTEGRATION.md:66-70). The loss at 1.5 s is inferred, not measured.
- **Fix.**
  - Drop the overrides.
  - agent.ts passes waitMs only when EDEN_WAIT_MS is set (0 still turns the wait off).
  - Fix lines 47-49 and README 50-51.
- **Status.** P2.

### 7. `source-removed-evicts-users`: deletion notices for unknown users evict real users (medium, S)

- **Evidence.**
  - sourceRemoved (partner.ts:1727-1734) checks only `syncPush`.
  - dropGone calls `cache.removeItems(..., GONE_HOLD_MS)`, which calls `touch(scope)` (cache.ts:639-655). touch
    creates a UserCache and, at 10,000 users per tenant, evicts the least recently written one (cache.ts:360-382).
  - Repro (maxUsersPerTenant 3): three ghost removals evicted the real user.
  - 10,000 ghost removals: 202-246 ms and 27.8 KB heap per user (≈278 MB per tenant, estimate).
  - The "returns how many were held" doc is wrong: the method returns the number of dropped items.
- **Impact.** A mailbox-wide deletion feed silently cold-starts active users within the tenant.
- **Fix.**
  - Keep gone-holds in a separate bounded per-tenant map in ItemCache that never allocates a UserCache and never
    counts toward maxUsersPerTenant. "Return 0 for unknown pairs" would reopen D126's in-flight race.
  - Fix the doc.
- **Status.** P3. The `dropResults` cost on the same path is fixed by P4.

### 8. `ingest-lazy-sketch`: near-duplicate sketch computed for every stored item (medium, S)

- **Evidence.**
  - `sketchOf` runs eagerly at cache.ts:557. Sketches are read only by hit builders (cache.ts:769, 805, 833, 867)
    and partner's near-duplicate checks.
  - `ingest.bench.ts` with `sketch: null`: backfill 98.4/104.4 → 58.0/58.7 µs/item, and 96.2/92.1 → 56.9/56.0 at
    100x2000.
  - A real lazy prototype: 59.2/60.6 µs/item (1.57x). Engine tests 674/674. Eval and funnel identical.
- **Impact.** Backfill and lookup put cost about 1.5x less CPU per item. The cost moves to first read, once per item.
- **Fix.**
  - `Entry.sketch` holds undefined until computed, which is distinct from null ("no own words").
  - Compute it after `searchIn`'s per-source filter and after `timed`'s slice, not for all 400 depth hits.
  - Report ask or delivery latency before and after.
- **Status.** P3.

### 9. `deliver-reparses-item-text`: fold re-tokenizes items with no repeated anchor (medium, S)

- **Evidence.**
  - Profile (pipeline bench): observe 5,955 ms, deliver/build 1,675 ms, foldEchoes 926 ms (tokensOf 418 ms
    inclusive).
  - Counter in a scratch copy: 621 foldEchoes calls, 0 with any repeated anchor, 0 items folded.
  - Corrections: the three messageParts calls in a delivery use different arguments, so they cannot share a parse.
    render.ts:61 also has a stateful `known` closure. compactText (475-595 ms) belongs to `assess`, not delivery.
  - Prototype early exit plus memo: 674 engine tests pass, and eval output is byte-identical except latency.
- **Impact.** About 560 ms of profile time, ~9-10% of observe on the bench. It is smaller on calendar-heavy packets,
  which do repeat anchors.
- **Fix.**
  - In foldEchoes, compute ownText and anchors first and return the input unchanged when no anchor repeats. This is
    exact.
  - No messageParts memo on the render path.
- **Status.** P5 (the fold.ts part). The memo part is replaced by finding 15's conflict analysis cache.

### 10. `scale-dropresults-full-scan`: every drop scans the whole results cache (medium, M)

- **Evidence.**
  - `dropResults` and `forget` (guarded.ts:321-339) call `deleteWhere`. That copies and tests every key
    (primitives/src/cache.ts:197-208, whose own comment says "not for the hot path").
  - Callers: partner.ts:1698, :1717, :3448, :3465.
  - Bench: 1k entries 0.244 ms/drop, 10k 1.586 ms, 50k 6.19 ms (linear).
- **Impact.** At ~10k entries (32 MB of ~2-5 KB pages, estimate), 30 drops/s ≈ 5% of the event loop (estimate). Each
  stall is ~9x a fast-path event. The original 16% was revised down.
- **Fix.**
  - Option (a): `S3FifoCache` gets an optional group function, a `Map<group, Set<key>>` maintained in set and kill,
    and `deleteGroup`.
  - SourceFanout groups by `${scopeKey}|${sourceId}`.
  - Option (b), an epoch, is rejected: an evicted epoch that resets would revalidate stale pages.
  - Re-run the cache bench before and after (primitives README rule).
- **Status.** P4.

### 11. `fresh-readat-race`: a copy read before a signal is stamped after it (medium, M)

- **Evidence.**
  - `doubted` (partner.ts:3342) uses `signalledSince` (sync.ts:295-298, strict `noticedAt > readAt`).
  - readAt is the put-completion time (partner.ts:3230, sync.ts:698-701; cache.ts:525/543/557).
  - Two repros (freshness.test.ts harness, CORE_CONFIG + sync + syncPush + verifyDelivery, change signalled during
    the verify fetch): a minute later fetches stayed 1 → 1 and the answer said "Lisbon". The control with the signal
    after the fetch re-read and answered "Porto".
- **Impact.** A change notified while a read is on the wire is missed until the next signal or a poll that lists the
  item. A same-millisecond signal is also missed.
- **Fix (chosen to stay inside sync.ts and cache.ts, so it does not collide with P1's partner.ts).**
  - `signalledSince` treats a signal as possibly after the read when `noticedAt >= readAt - slack`. `slack` is the
    longest a source read can be on the wire: the fan-out's call timeout, or `verifyTimeoutMs` if longer.
  - The cost is extra re-reads only for copies read within `slack` after a signal. Measure it.
  - The exact alternative (record the per-source notice sequence per copy) needs partner.ts's `store` and can follow
    later.
- **Status.** P3. Proposed decision row D133 (amends D126).

### 12. `fastpath-assess-eager-unmemoized`: conflict.assess runs on every candidate, re-parsing the same items (medium, M)

- **Evidence.**
  - Profile: observe 6,208-6,454 ms. assess (conflict.ts:331) is 50.3-50.7% inclusive. confident (partner.ts:2022)
    is 49-50%.
  - 727 confident() calls, 4,105 cleared() calls, 5,156 verdict() calls over 325 distinct items (~16x).
  - Lazy stop-at-cap loop: identical output on all 727 calls. Verdict calls 5,095 → 2,137. ms/event 3.20 → 2.37-2.62
    (two runs per arm) and 3.39/3.15 → 2.44/2.48 (second verifier, ~1.33x). Eval identical.
  - COST-MODEL.md:221 (104.8 µs p50, 848 µs p99, 0.389 ms/event) is stale. Runs today give p50 160-190 µs, p99
    10-17 ms and 2.8-3.8 ms/event.
- **Impact.** About 1.33x events per core from the lazy loop (measured). An item-analysis cache may bring assess to
  about 0.9-1.2 s from ~3.7 s (estimate).
- **Fix.**
  - (1) confident(): one loop with the cheap tests first, stopping at the cap.
  - (2) conflict.ts: an item-only `analyse` cached in a WeakMap on the stored item, keyed also by vocab and
    hasDomain. Frame-dependent work stays uncached.
  - Update the COST-MODEL row.
- **Status.** Split: (1) goes in P1, which owns partner.ts. (2) and the COST-MODEL row go in P5.

### 13. `sim-reindex-memo-and-user-shards`: freshness sim rebuilds its index on every update (medium, M)

- **Evidence.**
  - quality.ts:554, :562 call `reindex()`, which builds a new SimIndex (sources.ts:496-499) over every item.
  - quality-cli `--updates 0.6 --deletes 0.05 --push signals`: 20.9-21.6 s, against 10.1-10.4 s without updates.
  - A full per-item memo (with a content check) ran in 12.7 s with JSON identical except timing (1.65x).
  - deletes.test.ts 4.08 → 1.91 s.
  - applyUpdate mutates items in place (updates.ts:92-94), so a WeakMap keyed only on the object would serve stale
    terms.
- **Impact.** Freshness-arm comparisons run about 1.65x faster (measured). `--jobs 4` sharding at ~3.9x is an
  estimate.
- **Fix.**
  - Stage 1: memo keyed by item object with stored title and text, recomputed on mismatch; df and postings rebuilt.
  - Stage 2 (optional, same package): `--jobs N --user-range a:b`, merging counters and raw latencies as
    funnel-merge.ts does.
  - Update LAB.md.
- **Status.** P7.

### 14. `sync-sweep-backfill-big-pages`: sweeps and backfill list 100 items per call (medium, M)

- **Evidence.**
  - config.ts:545 `syncPageSize: 100`. Backfill and sweep use it (sync.ts:465, :659).
  - sync-econ (`--days 6 --seed 1`) at 500 per page: background 33.8 → 9.2 calls/user-day, backfill 33 → 9,
    freshAtLookup 0.999 both, deletedStillHeld 0.4492 → 0.4453. A weekly sweep doubles deletedStillHeld (0.8324).
- **Impact.** On per-call platforms in payload mode, about 0.61-0.78 → 0.27-0.45 connector calls per task (estimate
  from cost-fixes.md:134's 0.46 sweep share).
- **Problem with the fix as proposed.**
  - Offset-paged MCP tools end on a short page (mcp-source.ts:276-278). A server that silently caps pages at 100
    would end every sweep after page 1.
  - Two missed sweeps then drop the unseen items (sync.ts:677-685).
  - A server that rejects big pages fails every sweep.
- **Status.** Deferred until P3 lands, because both change sync.ts. The safe design is recorded for it:
  - a trial switch;
  - big pages only for token-paged lists or a declared schema maximum;
  - on error, retry at 100;
  - offset lists end only on an empty page.

### 15. `quality-reader-ceiling-gated`: the eval's oracle ceiling is recall 0.52 (medium, M)

- **Evidence.** `bun run eval --reader oracle`: calls 6, pool 15/50, recall 0.52. With push on every message and the
  gate off: calls 45, recall 0.82, falseFires 0. That zero is built into the oracle.
- **Impact.** This is a ceiling on the eval suite, not a measured live gain. D99 measured the same change live
  (NEW2): small, CIs including 0, and +3.1 false-concern points. D112 deleted it.
- **Status.** Rejected for now: D129.

### 16. `quality-reader-veto-rule-path`: rule-path lookalikes ship next to the reader's push (medium, M)

- **Evidence.**
  - Eval: 5 of 29 delivered items are wrong, all from slow-path `deliverChecked` on cues the push read.
  - On the default, the broad veto trades 5 wrong items for 4 right ones even with a perfect reader. Recall
    0.52 → 0.44, and 0.36-0.42 with a reader that flags 90% of right items.
- **Status.** Broad veto rejected: D130. The by-name veto waits for P6's live reader eval and paid spend.

### 17. `fresh-per-ref-signals`: a change signal doubts every earlier-read item of its source (medium → low, M)

- **Evidence.** quality-cli `--push signals`: 575 re-reads, 94% unchanged. `--push payload`: 0 re-reads, same
  staleness.
- **Impact.** Re-reads cost read-only connector calls, not paid model spend. The integrators who could name refs can
  already use the payload path.
- **Status.** Rejected: D131. P2 adds a line to the integration guide recommending `sourceItems`/`sourceRemoved`.

### 18. `devloop-agent-replay-identical-eden`: replay the agent's own calls in the Pi lab (medium, M)

- **Evidence.**
  - The agent always runs live (pi-ab.ts:53, :230-237).
  - Funnel default vs minus-graph: 533/768 rows identical.
- **Problem.** At time scale 0 it scores timing-driven regressions as neutral (D126's by-age arm: −10.2 hidden points
  from awaited re-reads).
- **Status.** Rejected as specified: D132.

### 19. `fanout-drop-evicted-state`: a drop is lost when its pair's state is LRU-evicted mid-call (low, S)

- **Evidence.**
  - `dropResults` bumps `drops` only on an existing PerSource (guarded.ts:333-339). `dropsOf` returns 0 for a missing
    state. `state()` evicts at MAX_STATES 100,000 (:133, :483-497).
  - Two repros: slow search, then 100,000 other pairs touched (638-1,444 ms), then a drop. The next lookup returned
    `cached` with the old text. The control was honoured.
- **Impact.** It needs 100k distinct pair touches inside one in-flight call, which is rare. When it happens, a changed
  page is served for up to 60 s fresh and 600 s as stale fallback.
- **Fix.** A fanout-wide drop epoch that one() and planCalls compare alongside `forgets`, bumped when the pair has no
  state. Make MAX_STATES injectable for the test.
- **Status.** P4 (same file as findings 2 and 10).

## Round 1

Round 1 is this audit's first pass:

- 20 findings were verified, each by two verifiers.
- Severities after verification:

  | Severity | Findings | Notes                                                                                                               |
  | -------- | -------: | ------------------------------------------------------------------------------------------------------------------- |
  | High     |        1 |                                                                                                                     |
  | Medium   |       17 | Includes the downgraded `scale-results-cache-unbounded` (was critical) and `scale-dropresults-full-scan` (was high) |
  | Low      |        1 | `fanout-drop-evicted-state`                                                                                         |
  | Rejected |        1 | `fresh-per-ref-signals`, as an API change (D131)                                                                    |

- What happened to the findings:
  - 13 are packaged into P1-P7. Two findings are split across packages.
  - 4 are rejected with decisions (D129-D132).
  - 1 is deferred behind P3.
  - The paid parts of 2 findings are deferred.
- Decisions recorded by this audit: D127 (honest empty ask), D128 (eval `--live` is the shipped wiring), D129, D130,
  D131, D132.
- Reserved for fixers: D133 (P3's change to D126's read-time rule) and D134.

## Work packages (round 1)

No two packages share a file. Each runs from `audit/2026-11-05-integration`, commits on its own branch, and does not
edit `docs/DECISIONS.md` (it puts a proposed row in its commit message). Every package ends with `bun run check`
green. A package that changes engine behaviour also pastes `bun run eval` JSON before and after.

| Package                      | Findings         | Files                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1 `ask-honest-answers`      | 1, 5, 12(1)      | packages/engine/src/partner.ts, packages/protocol/src/types.ts, packages/engine/src/review-regressions.test.ts, packages/engine/src/reader.test.ts, packages/protocol/CLAUDE.md, packages/engine/CLAUDE.md                                                                                                                               |
| P2 `docs-integration-wait`   | 6, 17 (doc line) | README.md, docs/INTEGRATION.md, examples/personal-agent/agent.ts                                                                                                                                                                                                                                                                         |
| P3 `engine-cache-sync-holds` | 7, 8, 11         | packages/engine/src/cache.ts, packages/engine/src/sync.ts, packages/engine/src/cache.test.ts, packages/engine/src/freshness.test.ts, packages/engine/bench/ingest.bench.ts                                                                                                                                                               |
| P4 `fanout-results-cache`    | 2, 10, 19        | packages/sources/src/guarded.ts, packages/primitives/src/cache.ts, packages/primitives/README.md, packages/primitives/bench/runtime.bench.ts (the S3FifoCache bench), packages/primitives/src/cache.test.ts, packages/sources/src/regressions.test.ts                                                                                    |
| P5 `fastpath-analysis-cache` | 9, 12(2)         | packages/engine/src/conflict.ts, packages/engine/src/fold.ts, packages/engine/src/conflict.test.ts, packages/engine/src/fold.test.ts (new), packages/engine/bench/pipeline.bench.ts, docs/COST-MODEL.md                                                                                                                                  |
| P6 `shipped-reader-path`     | 3, 4 ($0 part)   | packages/eval/src/cli.ts, packages/eval/src/run.ts, packages/eval/src/reader-stub.ts, packages/eval/src/run.test.ts, packages/eval/CLAUDE.md, packages/engine/src/reader.ts, packages/engine/src/reader-failure.test.ts (new), packages/server/src/build.ts, packages/server/src/models.ts, packages/server/src/reader-log.test.ts (new) |
| P7 `sim-reindex-memo`        | 13               | packages/sim/src/sources.ts, packages/sim/src/quality.ts, packages/sim/src/quality-cli.ts, packages/sim/src/sim.test.ts, packages/sim/src/deletes.test.ts, docs/LAB.md                                                                                                                                                                   |

The plan and acceptance checks for each package are in the run's structured output and are summarised here:

- **P1.**
  - Plumb per-source outcomes out of `searchLive` and `freshen` into ask.
  - Empty and partial answers name the unreachable sources, with an optional `AskResponse.sources` (D127).
  - Note shown words at hand-out, not at build.
  - Drop a pending packet only when it is fully cited.
  - Turn confident() into a lazy stop-at-cap loop.
  - Acceptance:
    - tests for all-failed, partial-failure and healthy-empty asks;
    - a two-item pending regression test;
    - eval: precision 0.8276, recall 0.48, falseFireRate 0, unchanged;
    - funnel TOTAL 214/211, unchanged;
    - pipeline bench ms/event lower.
- **P2.**
  - Drop the 1,500 ms overrides.
  - Fix INTEGRATION.md:47-49 and README.md:50-51.
  - The example agent defers to the client default.
  - Add a payload-path recommendation (D131).
  - Acceptance:
    - `grep -n "1500\|1_500" README.md docs/INTEGRATION.md examples/personal-agent/agent.ts` finds no wait override;
    - `bun run check` passes.
- **P3.**
  - Separate bounded gone-hold map.
  - Correct the `removeItems` doc.
  - Lazy sketch.
  - `signalledSince` slack, with `>=`.
  - Acceptance:
    - 10k ghost removals leave the user count flat and the real user present;
    - a known user's removal still holds the id;
    - the race repro passes;
    - ingest.bench backfill µs/item before and after (expect about 1.5x);
    - quality-cli `--push signals` freshness.checked before and after, with staleDelivered and deletedDelivered not
      worse;
    - eval and funnel identical.
- **P4.**
  - `sizeOf` charges the key plus measured overhead.
  - Group index and `deleteGroup`, used by `dropResults`.
  - Fanout-wide drop epoch.
  - Acceptance:
    - cache bench set/get before and after, and deleteGroup vs deleteWhere at 1k/10k/50k;
    - 200k empty pages stay under maxBytes of heap;
    - a drop removes only the named pair;
    - the eviction repro with injectable MAX_STATES passes.
- **P5.**
  - foldEchoes early exit.
  - Item-analysis WeakMap cache in conflict.ts.
  - COST-MODEL row refreshed.
  - Acceptance:
    - pipeline bench before and after on the same machine;
    - conflict and fold tests;
    - eval and funnel identical.
- **P6.**
  - `--live` uses the shipped wiring, `--judge` keeps the old shape, and a dollar cap is required (D128).
  - The reader's first failure reason is logged once.
  - Acceptance:
    - run.test asserts the eval's live wiring matches buildPartner's (judge null, reader present);
    - `bun run eval --live` without a cap exits non-zero with a message;
    - a server test shows a failing reader logs its reason once and the ask still answers;
    - no paid call.
- **P7.**
  - Per-item memo with a content check.
  - Optional `--jobs`.
  - LAB.md.
  - Acceptance:
    - quality-cli JSON identical except timing for `--push signals`, `--push payload` and
      `--config '{"verifyDelivery":false}'`;
    - wall time before and after;
    - `bun run test:pkg sim`.

## Deferred

| Item                                                             | Why                                                                                                                                                          |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sync-sweep-backfill-big-pages` (14)                             | Waits for P3, which owns sync.ts. The safe design is in finding 14.                                                                                          |
| Paid timing of the shipped reader (4, stage 1)                   | Needs paid OpenRouter calls the lab ledger cannot meter, and a key OpenRouter serves for Anthropic: this session's key gets 403. That is an external action. |
| Live reader eval run (3) and the by-name reader veto screen (16) | Wait for P6's capped `--live`. They are paid.                                                                                                                |
| Exact per-copy notice sequence for `fresh-readat-race` (11)      | Needs partner.ts, held by P1. P3's slack window closes the hole first.                                                                                       |

## Round 2

Round 2 re-audited the integration branch after round 1's seven packages merged (tip 006b1694b). 16 findings
survived verification, each re-checked by two verifiers who re-ran the cited command or wrote a scratch reproduction.
Numbers below are the verifiers' unless marked; where the two verifiers disagreed, the lower figure is used.

### Round 2 in plain terms

- **One privacy bug.** If a deletion notice arrives while Eden is re-reading the same item to check it is current,
  the re-read puts the deleted item back and delivers it. A verifier reproduced it with a recalled message. Package
  R2-P1.
- **A hole in round 1's freshness fix.** Two lookups for the same words share one source call. If the source changes
  while that call is running, the second lookup stores the old copy as if it were current, and nothing re-reads it
  until the next change. Package R2-P2.
- **An explicit ask can wait 3 s before the reader starts**, because the sync poll and the live search each get a
  full 1.5 s. One shared deadline caps that at about 1.5 s (D140). Package R2-P1.
- **Wasted connector calls.** An ask that the reader gate stops still re-reads up to 3 items for a reading that never
  happens (D134). Package R2-P1.
- **A large tenant forgets deletions early.** Past about 33 deletions a second per tenant, deletion holds expire
  after 2-4 minutes instead of 10. Package R2-P3.
- **Memory.** Round 1's conflict-analysis cache stores an empty array for almost every mark; sharing one empty array
  halves its memory (D136). Package R2-P4.
- **The knowledge graph costs about half of ingest CPU and 1.45x memory per user**, and the free screens show no gain
  from it. Whether it stays needs a paid reader comparison (about $0.3 estimated, inside the run's budget). The ingest
  benchmark also measures only part of what ships. Package R2-P8.
- **A slower dev loop.** `bun run funnel` can be 1.6-2.4x faster (D139, R2-P5). Every new worktree pays about 25-30 s
  of cold format and type checks (R2-P6). Round 1 added about 6.6 s of test time, mostly fixed sleeps (R2-P7). The
  documented `bun run eval --live` now exits 2 without `--usd-cap` (R2-P7).
- **D133 had no row.** The read-mark rule from round 1 was cited by code and docs but never written into the decision
  log. Written in this commit.
- **Rejected with evidence:**
  - Removing the fan-out results cache (D135).
  - Keyword-only intent requests (D137).
  - Warming a cold user's sources in the background (D138).
  - A byte-capped conflict cache (D136).
  - Fewer re-reads ahead of the reader (D134).

### Round 2 findings, ranked by value (severity, then effort)

Status key as in round 1: R2-P1 to R2-P8 are this round's packages; "Rejected" names its decision; "Deferred" says
why; "Fixed" means fixed in this commit.

#### R2-1. `fresh-recheck-revives-deleted`: a re-read in flight when `sourceRemoved` lands brings the item back (high, S)

- **Evidence.**
  - `recheck` (packages/engine/src/partner.ts:3509-3547) awaits `fanout.fetchChecked`. On an ok status it calls
    `this.deps.cache.revive(s.scope, [item.id])` (:3533), then `store(...)`, without checking whether a removal
    landed during the fetch.
  - `sourceRemoved` (:1768) goes through `dropGone` (:3553-3557). `Sync.removed` does not advance the mark, so the
    `readMark` passed to `store` cannot see the removal. `ItemCache.put` already skips held-gone ids (cache.ts:611);
    the explicit `revive` lifts the hold first. main has the same revive (main partner.ts:3443).
  - Repro (both verifiers, scratch test built on freshness.test.ts helpers): the source's `fetch` snapshots q1,
    yields, deletes q1 and calls `partner.sourceRemoved`, then returns the snapshot. After `sourceChanged` and with
    search failing, "Remind me where the quarterly offsite is" gives `removed 1`, then `delivered ["notes:q1"]`, and
    the cache holds the Lisbon text. `expect(cited).not.toContain('notes:q1')` fails.
- **Impact.** D126 promises that a deleted item is not delivered after its deletion notice. That breaks whenever the
  notice lands during the re-read, which `checkAhead` widens by starting re-reads early. The item stays cached and
  deliverable and its 10-minute hold is lifted. On the default path; privacy-relevant (recalled messages).
- **Fix.** Before `revive`, return "gone" when `this.deps.cache.isHeldGone(s.scope, item.id, this.now())` (cache.ts:775
  already has it). A verifier applied exactly this: the repro passed and `bun test packages/engine/src/` gave 706
  pass, 0 fail. A live hold at that point can only come from a removal during the fetch, since `removeItems` drops the
  id from the cache; a push that re-adds the item (`sourceItems`) revives it itself.
- **Status.** R2-P1.

#### R2-2. `fresh-joined-flight-unmarked`: a lookup joining a call begun before a signal stores the old copy as current (medium, S)

- **Evidence.**
  - guarded.ts:586-593: `one()` joins `flights.run(cacheKey, ...)` and returns ok, `joined: true`, with the
    leader's items, whatever `dropResults` happened since the leader started. `dropResults` (:371-379) only bumps
    `running.drops`; the `undropped` check (:619-621) only stops the leader writing back. `planCalls` (:450-480) has
    the same shape.
  - partner.ts:2676 takes the read mark at lookup start and :2868 stores joined items under it; cache.ts:624/643 keep
    `Math.max(old.readMark, readMark)` for unchanged copies, so the joiner's later mark replaces the leader's earlier
    one and `doubted` (partner.ts:3428) is false.
  - Fan-out repro: leader A starts, the text changes, `dropResults`, B searches the same query: `A ok B ok true budget
is old calls 1`.
  - Engine repro (freshness.test.ts helpers, synced with syncPush and verifyDelivery, listing failing): s1 asks with
    its search held, the doc changes to Porto, `sourceChanged`, s2 asks. With s2 joining: 1 search, both answered
    Lisbon, readMark 2 = sync mark 2, not doubted, and a later ask made 0 fetches and answered Lisbon. Without s2:
    s1's delivery check re-read and answered Porto.
- **Impact.** The exact race D133 was written to close, through a different door. Joins are common by design
  (partner.ts:2826-2829: the slow path and the reader push's ask search the same words at once); crossing a signal
  is rarer and its frequency is unmeasured. When it happens the stale copy is delivered and stays undoubted until
  the next signal.
- **Fix.** A call that started before the pair's latest drop is not joinable: put the pair's drop count (and the
  fan-out-wide drop epoch round 1 added) into the flight key, or keep the leader's drop mark beside the flight and
  refuse the join when `undropped` fails. A lookup arriving after a drop then leads a fresh call. This costs at most
  one extra connector call per drop that lands during a flight and needs no engine change (the joiner's own read
  mark was taken before its search). Do not change `Singleflight` or `cache.ts`'s `Math.max`: with only post-drop
  joins, a later mark is true.
- **Status.** R2-P2.

#### R2-3. `fresh-checkahead-speculative-rereads`: re-reads ahead of the reader are paid even when the reader is not called (medium, S)

- **Evidence.** readAsk calls `this.checkAhead(s, pool)` (partner.ts:1531) before the empty-pool return and before
  the `readerGate` return (:1558-1571). checkAhead (:3564-3573) re-reads the first `VERIFY_AHEAD` = 3 doubted pool
  items, one connector fetch each. Verifier runs of a scratch-patched quality-cli (`--users 8 --sessions 20 --updates
0.6 --deletes 0.05 --push signals`, stub reader): 885 / 674 / 574 re-reads at ahead 3 / 1 / 0 (flag-nothing
  reader), 882 vs 593 at ahead 3 vs 0 (flag-first reader). staleDelivered and deletedDelivered never changed;
  deletedCited moved ±1 in both directions across seeds 1-3. Narrowing the delivery's own `verifyItems` to 3 items:
  574 -> 430 re-reads but +2 deleted cited.
- **Impact.** At most 1.34x fewer connector calls (upper bound, stub reader), under the audit's 1.5x bar, and the
  stub cannot price the latency the re-reads ahead buy (docs/research/freshness.md: -10.2 points of hidden facts
  raised and +0.68 s when re-reads waited for delivery). The gated asks are the clear waste; how many there are was
  not measured.
- **Fix.** Decided in D134: keep `VERIFY_AHEAD` at 3; move `checkAhead` below the empty-pool and `readerGate`
  returns. Do not narrow `verifyItems`.
- **Status.** R2-P1 (the move). Lowering the count: rejected, D134.

#### R2-4. `ask-poll-serial-double-deadline`: an ask's poll and search each get a full 1.5 s (medium, S)

- **Evidence.** partner.ts:2690 gives the poll `AbortSignal.timeout(sourceTimeoutMs)`; an ask awaits it (:2727,
  D65); `deadlineAt` is computed only after the poll (:2766); the search gets a fresh `timeoutMs` (:2801) and the
  probes their own (:2931). `Sync.freshen` (sync.ts:376-383) polls a source again after its poll timed out. Verifier
  spans over 51 recorded `.local/**/tasks.jsonl` files (3,725 explicit asks): pre-reader p95 1,741, p99 2,656, max
  3,042 ms; 207 asks had poll and search both over 200 ms in series. Worked example (.local/mkt/hosted-42,
  board-pack-deadline): gmail and slack `list` time out at 1,500 ms, then a slack `search` times out at 1,500 ms; the
  reader starts about 3,042 ms after the ask.
- **Impact.** One shared deadline caps the wait before the reader at about 1.5 s: verifier recomputation gives
  pre-reader p99 2,584 -> 1,520 ms (.local/fresh) and p95 2,306 -> 1,520 ms (.local/mkt); whole-ask p95 1.06-1.23x.
  The finding's larger figures (2.1x at p95) assume the poll is skipped altogether, which is Stage 2.
- **Fix.** Decided in D140: compute `deadlineAt` once before the poll and give poll, search and probes the time
  left; `Sync.freshen` does not poll again a source whose on-demand poll timed out within `sourceTimeoutMs`. Lands in
  the default if `funnel -- --ask` and eval counts are unchanged, otherwise as the trial switch `askSharedDeadline`.
  Stage 2 (answer from the warm index after a short grace) is not taken (D65 holds).
- **Status.** R2-P1.

#### R2-5. `devloop-ingest-bench-not-shipped-path`: ingest.bench measures under a third of shipped ingest work (medium, S)

- **Evidence.** packages/engine/bench/ingest.bench.ts builds `ItemCache` without `enableGraph()` and `SyncManager`
  without `onStored`. Shipped: `graph: true` (config.ts:514), the partner calls `enableGraph` and wires `onStored` to
  `enqueueCards` and `recordMentions` (partner.ts:522-608). Verifier scratch variants of the bench (200 x 500): core
  115-120 us/item and 2,614 B/item; with graph 283-290 us/item and 5,200 B/item; with graph and mentions 395-410
  us/item and 5,243 B/item.
- **Impact.** Shipped ingest is about 3.3-3.6x the reported CPU per item and about 2x the memory (the finding said
  4.3x and missed memory). Scale decisions quoting this bench understated both, and finding R2-8 needs a true
  figure.
- **Fix.** Add a `shipped` line driven through `ContextPartner` with `DEFAULT_CONFIG` and no model deps, so it
  follows future `onStored` changes; keep today's line as `core`; report per-stage us/item and B/item, and a separate
  line with raw items released.
- **Status.** R2-P8.

#### R2-6. `devloop-funnel-grouped-shards`: `bun run funnel` runs one process at `--time 0` (medium, S)

- **Evidence.** `defaultJobs` returns 1 at `--time 0` (packages/sim/src/lab/funnel-merge.ts:17-19); `--jobs N`
  starts one hidden-funnel.ts process per suite x seed shard (12 on train; funnel.ts:213, 255-260). Verifier runs on
  4 cores under load: default 31.2-33.5 s wall, 39-41 s CPU; four hand-grouped processes (3 suites x 1 seed) 14.2-19.0
  s wall, about 50 s CPU; `--jobs 4` 23.0-35.2 s wall, 68-72 s CPU. perTask rows without timing fields: 768 of 768
  identical.
- **Impact.** Each funnel screen 1.6-2.4x faster in wall; about 1.35x less CPU than `--jobs 4`. It costs about 1.3x
  the CPU of one process, and ms/task becomes a contended figure.
- **Fix.** Decided in D139. Default jobs at `--time 0` to min(shards, cores), each job a contiguous group of shards;
  keep one shard per process at `--time > 0` and when `soloReasons` apply. `mergeShards` must read each row's own
  suite and seed (it assumes one suite per part today, funnel.ts ~333-351). Label ms/task CONTENDED (funnel.ts:363);
  LAB.md says latency comes from `--jobs 1`.
- **Status.** R2-P5.

#### R2-7. `devloop-fresh-worktree-caches`: every new worktree pays a cold format check and type check (medium, S)

- **Evidence.** scripts/format.sh:18 keeps Prettier's cache in `node_modules/.cache/prettier/.prettier-cache`,
  keyed by absolute path (389 entries under `/home/user/Eden/`); scripts/typecheck.sh:39 keeps tsc's buildinfo in
  `node_modules/.cache/tsc` per checkout. In a fresh worktree: format:check 14.0-14.8 s cold, 4.8 s warm; typecheck
  11.5-16.5 s cold, 5.9 s warm. Copying the main checkout's cache: typecheck 3.8-3.9 s (tsc's paths are relative),
  format:check unchanged at 13.5-18.3 s. deep-audit SKILL.md:36,57 gives every fixer, reviewer and integrator a new
  worktree.
- **Impact.** First format plus type check in a new worktree 30.5 s -> about 8.7 s (3.5x, verifier). The whole first
  `bun run check` was estimated 1.47x and not re-run.
- **Fix.** format.sh: a set of known-formatted (path, content hash) pairs under the git common dir, keyed by
  Prettier's version and the hashes of .prettierrc.json, .prettierignore and .editorconfig; hash the working tree
  (`git hash-object`), not the index; write atomically (temp file and rename); call Prettier only on unknown files
  and not at all when none are left. Line length stays uncached unless its key includes the hash of
  check-line-length.ts. typecheck.sh: copy (not link) the main worktree's tsc cache when missing. `CHECK_COLD=1`
  bypasses both.
- **Status.** R2-P6.

#### R2-8. `scale-graph-dominates-ingest`: the knowledge graph is most of ingest CPU and memory, with no $0 gain (medium, M)

- **Evidence.** `graph: true` (config.ts:514); `put` calls `graphOf(u, now)?.add(item, now)` on every new or changed
  item (cache.ts:654). `bun packages/sim/src/lab/graph-memory.ts` (20 users x 2,000 items): put 41-45 -> 99-105
  us/item, heap per user 2.68-2.69 -> 3.90-3.91 MB. Funnel default vs `--preset minus-graph --baseline`: hidden 214
  -> 215 of 384, decoys 211 -> 211, pool hidden 230 -> 226; task by task +3/-2 hidden, +2/-2 decoys. `bun run eval`
  with and without graph: 0.828 / 0.48 / 0 both. Not re-run by a verifier: the scratch stage bench (6x on put) and
  the concurrent.bench and storm profiles.
- **Impact.** Ingest CPU about 2.0-2.3x and memory 1.45x per user (realistic), 2.07x (bench workload). Ingest is
  background work, so this matters at scale and in cold-start storms. The $0 screens use a stub reader, so they
  cannot show whether the graph's extra pool items become reader wins; D58's gain was measured with the reader off.
- **Fix.** Stage 1 (paid, about $0.3 estimated, inside the run's budget): a live-reader funnel, default against
  minus-graph, through the spend ledger with the cap, plus quality-cli with and without the graph. The package writes
  the result and a proposed decision (D141): remove the graph from the default under D112 if neutral, or keep it.
  Stage 2 if it stays: extract only headers and the first ~1,000 characters.
- **Status.** R2-P8 (measurement and decision proposal). Deleting the code, if decided, is deferred to round 3.

#### R2-9. `mem-conflict-analysis-weakmap`: round 1's analysis cache keeps 6.5-8.6 KB per assessed item (medium, M)

- **Evidence.** `ANALYSES = new WeakMap<ContextItem, AnalysisEntry>()` (conflict.ts:543), filled from `assess`
  (:334-343); each entry keeps `whole`, every lowered statement and about 5 mark arrays per statement (:376-387,
  :525-537). Verifier micro-benches: 7,743-8,598 B per item (4.7-4.8x the text); 99.93% of mark arrays empty; first
  pass 1,793-1,899 ms, second 190-289 ms. pipeline.bench (2,000 events) heap: cache on 55.8-57.5 MB, bypassed
  57.5-58.8 MB, so the claimed +12-17% did not reproduce.
- **Impact.** Bounded by item lifetime and the cache's item limits, not by session length. A constant multiplier on
  the items actually assessed (about 200 per 2,000 events).
- **Fix.** Decided in D136: one shared frozen empty array for empty marks (verifier: 8,598 -> 3,956 B/item, 2.17x,
  second pass 119-154 ms); optionally drop `whole` once refs are read. No byte cap, no statement dropping.
- **Status.** R2-P4 (shared empty array). The rest: rejected, D136.

#### R2-10. `cost-intent-requests-keyword-output`: ask the cards role for keywords instead of sentences (medium, M; rejected)

- **Evidence.** Requests are used only as stemmed terms (intent.ts:64-74, :106-109; partner.ts:4365). Ledger
  (.local/mkt/ledger.jsonl): eden.cards 5,158 calls, 625 output tokens, $0.000445 per call, $2.298 total. Funnel with
  intent-v2 rewritten to distinct content words: 244/229 surfaced against 243/228.
- **Impact.** The 1.53x is a ratio of request characters, not of output tokens. On the committed intent-v2 replay a
  keyword block is 1.22x fewer tokens per item, so a call would fall an estimated 1.06-1.13x (arithmetic in D137),
  under the trial's own 1.25x bar.
- **Status.** Rejected, D137.

#### R2-11. `r2-results-cache-dead-weight`: remove the fan-out results cache (low, S; rejected)

- **Evidence.** 1 hit in about 860 lookups across eval, funnel and quality-cli; turning it off changes no output.
  But the harnesses never repeat a key: the eval builds a new partner per scenario (packages/eval/src/run.ts:188),
  funnel tasks are one-shot, and stale-on-failure needs a cached key to fire.
- **Status.** Rejected, D135. Reopen with a multi-turn replay hit counter and outages injected after warm-up.

#### R2-12. `holds-tenant-cap-drops-early`: past ~33 deletions/s per tenant, holds expire after 2-4 minutes (low, S)

- **Evidence.** `MAX_HOLDS_PER_TENANT` 20,000 (cache.ts:327) evicts the least recently held user's oldest hold,
  expired or not (cache.ts:334-401); `GONE_HOLD_MS` is 10 minutes (partner.ts:5032). Two verifiers' scratch runs of
  `TenantHolds`: 10,000 users x 5 removals over 10 minutes leaves 20,000 held; survival by age falls from 1.00 at 0-1
  minute to 0.32 (one verifier) or 0.00 (the other) at 4 minutes. 10,000 users x 2 (33.3/s): all held. Heap per hold
  101-290 B.
- **Impact.** A tail risk for very large, deletion-heavy tenants: a source index lagging more than a few minutes can
  store a deleted item back. Not on main yet (round 1 code).
- **Fix.** Raise the tenant cap to 100,000 (covers about 167/s for 10 minutes; an estimated 10-29 MB per tenant at
  the measured bytes per hold), evict expired holds tenant-wide before live ones, and count early evictions
  (`freshness.holdsEvicted`). Test: 10,000 users x 5 removals within the window all held; heap per hold <= 600 B.
- **Status.** R2-P3.

#### R2-13. `d133-no-decision-row`: D133 cited by code and docs but missing from DECISIONS.md (low, S)

- **Evidence.** `grep -c '^| D133 ' docs/DECISIONS.md` was 0 on 006b1694b; D133 is cited at sync.ts:301,
  cache.ts:40, partner.ts (4 places), freshness.test.ts:286 and ARCHITECTURE.md:162.
- **Fix.** The row, with the evidence from commit c9ee1f304's message and this round's re-run on 006b1694b
  (`bun packages/eval/src/cli.ts`: precision 0.8276, recall 0.48, falseFireRate 0;
  `bun test packages/engine/src/freshness.test.ts`: 15 pass, 0 fail), and the joined-flight caveat (R2-2).
- **Status.** Fixed in this commit (D133).

#### R2-14. `docs-eval-live-uncapped`: the documented `bun run eval --live` exits 2 since D128 (low, S)

- **Evidence.** On the integration branch packages/eval/src/cli.ts:35-36 refuses `--live` without `--usd-cap`
  (exit 2 through `fail`, :25). Bare `eval --live` remains in CLAUDE.md:51, README.md:25, .claude/commands/eval.md:6,
  docs/research/econ-synthesis.md:150,189, docs/research/live-judge.md:77 and docs/research/model-calls.md:52. Only
  packages/eval/CLAUDE.md has the new form.
- **Impact.** The merge-gate instruction is wrong; the error is loud and suggests a cap, so nothing fails silently.
- **Fix.** `bun run eval --live --usd-cap 0.05` in CLAUDE.md, README.md and the /eval command (D125 recorded $0.0147
  for a live eval); `--live --judge --usd-cap 0.05` where the old judge shape is meant; annotate, do not rewrite,
  dated research notes and the D43/D125 rows. `--ask-model` (model-calls.md:52) is parsed by neither cli.ts: mark it
  stale.
- **Status.** R2-P7. Must reach main together with D128 (main's cli.ts has no `--usd-cap`).

#### R2-15. `devloop-round1-tests-sleep`: round 1 added about 6.6 s of test time (low, S)

- **Evidence.** junit per-file sums: main 88.7 s, integration 95.2-95.3 s (1,536 -> 1,588 tests). Integration
  per-test: sim.test.ts "user-range tallies merge" 5.8-6.4 s; review-regressions.test.ts's `queue` helper
  `await Bun.sleep(1_500)` (:384), called by two tests (1.51 s each); sources/regressions.test.ts's 200,000-page heap
  test 2.3-2.4 s; eval run.test "the cap is hard" 1.2-1.3 s.
- **Impact.** An estimated 1.5-1.8 s of wall per full `bun run test` (the suite is throughput-bound: about 6.5 s of
  sum over 4 cores) and about 3 s on every engine `test:changed`; sim.test.ts (9.3 s) sets `test:pkg sim`'s critical
  path. Full-suite wall noise was about 4 s, so the full-suite gain is not separately measured.
- **Fix.**
  - Replace the sleep with a held promise, as slow-path-queue.test.ts:20-58 does (a verifier's polling version took
    the file from 4.00 to 1.63 s).
  - Heap test: more than 60,000 pages, or a larger simulated step, so it still passes the 600 s expiry and the byte
    budget. A verifier's 50,000-page run took 0.6 s and still failed on the pre-fix guarded.ts, but no longer reached
    the expiry.
  - Sim shard test: 2 users x 2 sessions (verifier: 3.9-4.6 s; the finding's < 2 s target is not reachable because
    each run has a large fixed cost).
- **Status.** R2-P7. Target: junit sum at most 90 s; TESTING.md updated with measured numbers.

#### R2-16. `cold-user-sources-on-path`: warm a cold user's sources before the first lookup (low, M; rejected)

- **Evidence.** partner.ts:2678 awaits `deps.sources` with no deadline; user-sources.ts:237 waits up to
  `directoryTimeoutMs` 5,000; McpSource connects inside its first search (mcp-source.ts:125-196). A scratch McpSource
  over stdio: first search 125-185 ms, later 0.8-2.3 ms.
- **Status.** Rejected, D138: the shipped directory is a file, the connect already runs inside the 1,500 ms source
  timeout, no whole first-lookup time was measured, and warming every session costs a connection per user.

### Round 2 tally

| Severity (after verification) | Findings | Of which                                                         |
| ----------------------------- | -------: | ---------------------------------------------------------------- |
| High                          |        1 | R2-1                                                             |
| Medium                        |        9 | R2-2 to R2-10 (R2-10 rejected)                                   |
| Low                           |        6 | R2-11 to R2-16 (R2-11 and R2-16 rejected; R2-13 fixed in commit) |

- 12 findings packaged into R2-P1 to R2-P8; 2 of them only in part (R2-3, R2-9).
- 3 rejected with decisions: D135, D137, D138. Parts of R2-3 and R2-9 rejected: D134, D136.
- 1 fixed in this commit: R2-13 (D133).
- Decisions written this round: D133 to D140. D141 (R2-P8's graph verdict) is now written in docs/DECISIONS.md; D142
  is the big-pages package's (`lc-sync-big-pages`), written at integration with its trial row. Fixers do not edit docs/DECISIONS.md; a proposed row goes in the commit message under `Decision row:`.

## Work packages (round 2)

No two packages share a file. Each starts from `audit/2026-11-05-integration` at the commit that carries this
report, commits on its own branch, and ends with `bun run check` green. A package that changes engine behaviour
pastes `bun run eval` JSON before and after. A behaviour change comes with a test that fails before it.

| Package                       | Findings     | Files                                                                                                                                                                                                                                                                               |
| ----------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R2-P1 `engine-fresh-ask`      | R2-1, 3, 4   | packages/engine/src/partner.ts, packages/engine/src/sync.ts, packages/engine/src/freshness.test.ts, packages/engine/src/ask-deadline.test.ts (new), docs/research/freshness.md, docs/ARCHITECTURE.md, packages/engine/CLAUDE.md                                                     |
| R2-P2 `fanout-joined-flights` | R2-2         | packages/sources/src/guarded.ts, packages/sources/src/joined-flight.test.ts (new), packages/engine/src/joined-flight.test.ts (new), packages/sources/CLAUDE.md                                                                                                                      |
| R2-P3 `tenant-holds-cap`      | R2-12        | packages/engine/src/cache.ts, packages/engine/src/cache.test.ts                                                                                                                                                                                                                     |
| R2-P4 `conflict-empty-marks`  | R2-9         | packages/engine/src/conflict.ts, packages/engine/src/conflict.test.ts                                                                                                                                                                                                               |
| R2-P5 `funnel-grouped-shards` | R2-6         | packages/sim/src/lab/funnel.ts, packages/sim/src/lab/funnel-merge.ts, packages/sim/src/lab/funnel-merge.test.ts, packages/sim/src/lab/CLAUDE.md, docs/LAB.md                                                                                                                        |
| R2-P6 `worktree-check-caches` | R2-7         | scripts/format.sh, scripts/typecheck.sh, scripts/check-line-length.ts (only if it joins the shared set), .claude/skills/deep-audit/SKILL.md                                                                                                                                         |
| R2-P7 `devloop-tests-docs`    | R2-14, R2-15 | CLAUDE.md, README.md, .claude/commands/eval.md, docs/research/econ-synthesis.md, docs/research/live-judge.md, docs/research/model-calls.md, packages/engine/src/review-regressions.test.ts, packages/sim/src/sim.test.ts, packages/sources/src/regressions.test.ts, docs/TESTING.md |
| R2-P8 `graph-ablation`        | R2-5, R2-8   | packages/engine/bench/ingest.bench.ts, docs/research/graph-ablation.md (new), docs/research/INDEX.md, docs/COST-MODEL.md                                                                                                                                                            |

Plans and acceptance checks (the run's structured output has the same):

- **R2-P1.** An `isHeldGone` check before `revive` in `recheck`; `checkAhead` below the empty-pool and `readerGate`
  returns (D134); one `deadlineAt` before the poll, shared by poll, search and probes, and no re-poll of a source
  whose poll timed out within `sourceTimeoutMs` (D140). Acceptance:
  - freshness.test.ts: the removal-during-re-read repro fails before and passes after;
  - a gated-ask test: zero `fetch` calls on a doubted pool item when the gate returns;
  - ask-deadline.test.ts: a source whose list and search both hang; the ask's time before the reader is under
    `sourceTimeoutMs` + 250 ms (about 3 s before);
  - `bun run eval` precision 0.8276, recall 0.48, falseFireRate 0; `bun run funnel -- --ask` counts unchanged
    (otherwise the deadline goes behind `askSharedDeadline`, D140); quality-cli `--push signals` staleDelivered and
    deletedDelivered not worse.
- **R2-P2.** A flight started before its pair's latest `dropResults` (or the fan-out-wide drop epoch) is not
  joinable, in `one()` and `planCalls`. Acceptance:
  - sources joined-flight.test.ts: leader starts, `dropResults`, a second caller gets the new text and the connector
    sees 2 calls; with no drop in between the second caller still joins (1 call);
  - engine joined-flight.test.ts: the s1/s2 repro; s2 does not deliver Lisbon, and a later ask fetches and answers
    Porto;
  - `bun run eval` and `bun run funnel` unchanged.
- **R2-P3.** Tenant cap 100,000; tenant-wide expired-first eviction; a `freshness.holdsEvicted` counter. Acceptance:
  cache.test.ts 10,000 users x 5 removals within the window all held; heap per hold <= 600 B; an isolation test for
  the counter; round 1's 25,000-id and ghost-user tests still pass.
- **R2-P4.** One frozen shared empty array for empty marks (D136). Acceptance: verdicts identical on the
  conflict.test.ts fixtures and a test that empty marks share one frozen array; a scratch heap measure under 4.5 KB
  per assessed item (from about 8.6 KB); pipeline.bench ms/event within 10% of before on the same machine; eval and
  funnel identical.
- **R2-P5.** Grouped shards at `--time 0` (D139); `mergeShards` keyed by each row's suite and seed. Acceptance:
  funnel-merge.test.ts covers a group spanning suites; `bun run funnel` perTask rows without timing equal
  `bun run funnel --jobs 1`'s; three timed runs per arm; LAB.md and the comments at funnel-merge.ts:15 and
  funnel.ts:20-22 say ms/task is contended and `--jobs 1` gives latency.
- **R2-P6.** Shared formatted set and tsc seed. Acceptance: in a fresh worktree the first `bun run format:check` and
  `bun run typecheck` together take under 10 s (from about 30 s), three runs; a planted misformatted file and an
  overlong comment are still caught; `CHECK_COLD=1` ignores both caches; two worktrees running format:check at once
  leave a readable set.
- **R2-P7.** Docs and test time. Acceptance: `grep -rn 'eval --live' CLAUDE.md README.md .claude/commands` shows only
  `--usd-cap` forms; the held promise replaces the sleep; the heap test still fails against the pre-round-1
  guarded.ts; junit per-file sum at most 90 s (`./scripts/test.sh --reporter=junit`), and TESTING.md updated from
  that run.
- **R2-P8.** ingest.bench `core` and `shipped` lines, then the paid graph ablation. Acceptance: ingest.bench prints
  both lines with per-stage us/item and B/item; the paid funnel uses `--spend-ledger .local/mkt/ledger.jsonl
--spend-cap 25 --spend-headroom 0.3` with Haiku 5.5 and costs under $1 (ledger delta reported); graph-ablation.md
  gives default vs minus-graph hidden and decoys task by task, quality-cli with and without the graph,
  graph-memory.ts, and a D141 row to propose (remove under D112 if neutral at no extra paid cost, else keep and plan
  Stage 2). D141 is now written: keep.

## Deferred (round 2)

| Item                                                            | Why                                                                                                                 |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Deleting the graph's code (R2-8)                                | Rejected by D141: the graph stays in the default (+4 hidden, +2 decoys of 384 on the paid funnel).                  |
| Graph Stage 2, lighter extraction (R2-8)                        | D141 keeps the graph; Stage 2 is its recorded next step; built and closed by D150 (no switch, no trials row).        |
| Starting re-reads when the reader's stream names an item (R2-3) | Needs reader-stream plumbing in partner.ts (held by R2-P1) and a live latency run; D134 keeps the count until then. |
| A cheaper endpoint for intent-only card items (R2-10, Stage 2)  | An owner decision under D12/D98 about a new model endpoint: external.                                               |

## Where everything is

- This file: `docs/audits/2026-11-05-deep-audit.md`.
- Decisions D127-D132 (round 1), D133-D140 (round 2) and D141-D143 (final steps): `docs/DECISIONS.md`.
- Integration branch: `audit/2026-11-05-integration`, branched from main 6911f514d.

## Closing the run (loose ends)

Checked on `audit/2026-11-05-integration` at 7d10b8ae3: every `audit/2026-11-05-*` branch is merged into it. Every
item this run deferred or left to a decision, with its final status and where it is recorded:

| Item (finding id)                                                                  | Final status                                                                                                                                                                                                                                       | Recorded in                                  | Next step                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sync-sweep-backfill-big-pages` (14)                                               | Built behind a trial (D142), measured, deleted (D143): not neutral (reader-screen pool 230/229 to 228/228 at $0; a reproducible -2 hidden of 384 on the paid reader), from the ask's tie order among equal-score candidates following ingest order | D142, D143; docs/research/econ-background.md | Reopen only with a measured, ingest-order-independent tie-break for equal-score ask candidates (D143)                                                                                                                                                                                                                                                   |
| `painpoint-prod-reader-unmeasured` (4), stage 1: paid timing of the shipped reader | Blocked externally. The $0 part (the reader's first failure logged once per process, `readerFailureLog` in packages/server/src/build.ts) shipped in round 1                                                                                        | This file, finding 4 and "Deferred"          | This environment's OpenRouter key gets 403 "violation of provider Terms Of Service" for Anthropic models, and the lab `SpendLedger` meters only `claude-*` ids. The owner supplies a key OpenRouter serves for `anthropic/claude-haiku-5.5`; then a ledger entry type for OpenRouter ids before any reader timing run                                   |
| `eval-live-measures-unshipped` (3): the paid `--live` run                          | Wiring fixed (D128); the paid run is blocked externally (same key block)                                                                                                                                                                           | D128                                         | With a served key: `bun run eval --live --usd-cap 0.05` (D128)                                                                                                                                                                                                                                                                                          |
| `quality-reader-veto-rule-path` (16): the by-name veto screen                      | Broad veto rejected (D130); the by-name screen is blocked externally (same key block)                                                                                                                                                              | D130                                         | Run after the live reader eval above, as D130 says                                                                                                                                                                                                                                                                                                      |
| `quality-reader-ceiling-gated` (15)                                                | Rejected                                                                                                                                                                                                                                           | D129                                         | None                                                                                                                                                                                                                                                                                                                                                    |
| `fresh-per-ref-signals` (17)                                                       | Rejected                                                                                                                                                                                                                                           | D131                                         | None                                                                                                                                                                                                                                                                                                                                                    |
| `devloop-agent-replay-identical-eden` (18)                                         | Rejected as proposed; open with the Hermes request-replay item (audit 2026-11-04, section 5)                                                                                                                                                       | D132                                         | That Hermes request-replay item                                                                                                                                                                                                                                                                                                                         |
| `fresh-readat-race` (11), exact per-copy variant                                   | Closed: read marks are stored per copy (`ItemCache.put`'s `readMark`, `Entry.readMark`)                                                                                                                                                            | D133                                         | None                                                                                                                                                                                                                                                                                                                                                    |
| `d133-no-decision-row` (R2-13)                                                     | Closed: the D133 row is written                                                                                                                                                                                                                    | D133, commit 463f6fdfc                       | None                                                                                                                                                                                                                                                                                                                                                    |
| `scale-graph-dominates-ingest` (R2-8): deleting the graph's code                   | Rejected: the graph stays in the default                                                                                                                                                                                                           | D141                                         | None                                                                                                                                                                                                                                                                                                                                                    |
| `scale-graph-dominates-ingest` (R2-8): Stage 2, a lighter graph | Built with no switch: `READ_CHARS` 4,000 to 1,000 met D141's gate (`+graph` stage 2.12-2.34x cheaper per item) with every screen identical, so it joined the default and no trials-table row exists (package `graph-read-chars-1000`) | D141, D150 | None |
| `fresh-checkahead-speculative-rereads` (R2-3), stage 2                             | `VERIFY_AHEAD` stays 3; re-reads start only once the reader is called                                                                                                                                                                              | D134                                         | Starting re-reads when the reader's stream names an item needs reader-stream plumbing and a live latency run (paid, same key block)                                                                                                                                                                                                                     |
| `cost-intent-requests-keyword-output` (R2-10)                                      | Rejected                                                                                                                                                                                                                                           | D137                                         | A cheaper endpoint for intent-only card items is an owner decision under D12/D98 (external)                                                                                                                                                                                                                                                             |
| `r2-results-cache-dead-weight` (R2-11)                                             | Rejected: the results cache stays                                                                                                                                                                                                                  | D135                                         | None                                                                                                                                                                                                                                                                                                                                                    |
| `cold-user-sources-on-path` (R2-16)                                                | Rejected                                                                                                                                                                                                                                           | D138                                         | None                                                                                                                                                                                                                                                                                                                                                    |
| `mem-conflict-analysis-weakmap` (R2-9)                                             | WeakMap kept, shared frozen empty array shipped (R2-P4); byte cap rejected                                                                                                                                                                         | D136                                         | None                                                                                                                                                                                                                                                                                                                                                    |

The run added no `TODO`/`FIXME`. It added one `EngineConfig` key, `syncBigPageSize` (D142, a trial), and D143
deleted it with its code and tests, so the run ends with no new key. The 41 stale `origin/claude/r10-*` remote
branches and the Hermes live check of the default (owner approval for a checkout) stay open from the 2026-11-04
audit.

Checked again at cf59967f1 (before D143): every `audit/2026-11-05-*` branch is merged (`git branch --no-merged
audit/2026-11-05-integration` lists none), no `TODO`/`FIXME` added, `bun run check` green twice (1639 pass), and
no named preset beats the default (presets are only `default` and `minus-<part>`; D141 measured `minus-graph`
worse).
