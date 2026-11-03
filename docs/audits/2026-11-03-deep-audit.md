# Deep audit: cost and speed (2026-11-03)

## Final tree

This section supersedes the merge state described further down, which was written against an older integration tree
(6f7a36fee) and is kept as the working record.

- **Merged commit:** the head of `claude/audit-2026-11-03` after the commit that adds this section (reviewer findings
  applied). It holds every fix below, on top of current `main`.
- **Checks on that tree:** `bun run check` green (1,362 tests pass, 0 fail); `bun run eval` identical to `main`'s
  except latency noise (precision 1, recall 0.444, falseFireRate 0, 0 model calls; only `latencyP50Ms` and
  `latencyP95Ms` differ).
- **Merged since 6f7a36fee:** `r1-check-caches` (8cc2b8073), `r1-openrouter-cache` (182fcae8f, which carries
  c00a2a7dc) and `r2-source-call-accounting` (3c9d73c79). `r1-reader-push-wait` stays unmerged on purpose: it was
  replaced by `r2-reader-merge`.
- **Review:** the 10 items listed below as "awaiting reviewer" (and `cost-reader-session-cap-silent`) were reviewed by
  the repo's `reviewer` agent on the combined diff. It found no code defects; its documentation findings are fixed in
  the commit that adds this section, and the OpenRouter `cache_control` breakpoints are now behind an explicit
  `anthropicCache` option, off by default, until a live probe confirms OpenRouter's ZDR Anthropic endpoints accept
  them.
- **Still open:** `bun run eval --live` for the `readerPush` delivery-timing change (the flag is off by default; the
  run needs paid model calls). The deferred findings and decisions listed below are unchanged.

## Final summary (read this first)

Written after round 2. It is for the repo owner, not for a specialist. The sections below it are the full working
record. Three words used here: the **reader** is Eden's one model call that reads the user's request and picks the
facts that matter; a **push** is Eden sending those facts to the agent without being asked; **NEW** and **NEW2**
are lab settings that turn the reader on. The reader is **off by default in production**.

### The bottom line

One request with a deeply nested body could freeze the server for every customer for about 1.8 s. That is fixed: the
same check now takes about 0.2 ms, and request bodies are capped at 8 MB instead of 128 MB. The reader leaked money and
time in several small ways (calls paid for and thrown away, spend reported as $0, silent cut-offs). Those are fixed on
the final tree and were reviewed by the repo's independent reviewer (see "Final tree"). A default deployment behaves the
same as before (the no-model eval is unchanged), and the developer loop is faster (the lab funnel runs about 2.8x
faster). No 10x lever on the reader's cost per call was found. The main cost lever is calling it less often, and today
the lab's NEW2 setting calls it on almost every message.

### Scoreboard

"Found" is what the auditors reported. "Verified" survived a second, adversarial check; the rest were rejected.
"Fixed and reviewed" is what the audit's own review accepted. "Still open" splits into fixes waiting for the repo's
`reviewer` subagent (CLAUDE.md, Workflow step 5) and findings with no fix yet.

| Dimension | Found | Verified | Fixed and reviewed | Open: fixed, awaiting reviewer | Open: not fixed |
|---|---|---|---|---|---|
| Security | 8 | 6 | 1 | 4 | 1 |
| Correctness (bugs) | 7 | 7 | 2 | 5 | 0 |
| Order-of-magnitude levers | 9 | 7 | 3 | 0 | 4 |
| Inefficiency | 8 | 4 | 2 | 1 | 1 |
| Pain points | 4 | 4 | 4 | 0 | 0 |
| **Total** | **36** | **28** | **12** | **10** | **6** |

The "awaiting reviewer" column is as of round 2; all 10 have since been reviewed (see "Final tree"). One caveat on
"fixed and reviewed": `cost-ask-rereads-push-verdict` was closed by correcting the docs, not the code: a reworded ask on
the same request still costs a second reader call.

### The most important fixes

Every number was measured by a command during this audit unless it says "estimate". No paid model calls were made.

- **Server freeze on deep input (security).** `checkEvent` on a 60,000-deep body: 1,537 ms before, 0.2 ms after
  (decision D100). Over HTTP it was 1,844 ms. Input nested deeper than 1,000 levels is now refused with a 400.
  Round 2 made the check cheaper on object-heavy input: 333,000 empty objects went from 20.7-29.4 ms to
  12.0-16.5 ms.
- **Huge request bodies (security).** Bodies are now capped at 8 MB (`EDEN_MAX_BODY_BYTES`). A 64 MB body took
  159 ms to accept before; it is now refused in 11 ms.
- **Push reads paid for and thrown away (correctness).** Before, 2.8-8.5% of push reads landed after the 2.5 s
  cut-off and were paid for but never delivered. The push now waits for its read, and the read is traced. The new
  rate was not measured, because that needs a paid run.
- **Two reader fixes collided (correctness).** Merging them by hand could silently undo five cost fixes. They were
  rebuilt on one base. Kept as part of it: a 1 MB user message costs 4.15 ms on the request path instead of
  42.82 ms, because the question handed to the reader is now capped.
- **Reader spend reported as $0 (correctness).** `AskResponse.costUsd` now includes the reader's call, a late
  reader call is traced when it lands, and a reader stopped by its budget reports the outcome "budget" instead of
  stopping silently.
- **The gate's real saving is now measurable (cost).** A new $0 lab, `bun run gate-traffic`, counts reader calls.
  For NEW2: 436 reader calls for 438 user messages (0.995 a message), 0% skipped by the gate. So today the gate
  saves nothing under NEW2. The cost docs now say 1.49 reader calls a task, not one a message.
- **Faster developer loop.** `bun run funnel --jobs 4`: 15 s instead of 41.6 s, with identical counts. The reader
  test file: 10.30-10.63 s down to 3.01-3.05 s. With the new caches, `bun run check` ran in 34.6 s cold and 20.8 s
  warm on the round 1 tree (the audit's starting estimate was about 40 s).
- **Docs and example match reality (pain point).** INTEGRATION.md now explains `waitMs`, and the example agent's
  `EDEN_WAIT_MS=0` now really means "do not wait" (it used to wait up to 1.5 s).

The final tree passes `bun run check` (1,362 tests pass, 0 fail) and `bun run eval` (precision 1, recall 0.444,
falseFireRate 0, 0 model calls). The eval numbers match `main` and the pre-audit baseline (see "Final tree").

### What is still open, and the next step for each

**Fixed; reviewed after round 2 (10).** The fixing agents had no tool to start the `reviewer` subagent, so each
checked its own diff against the reviewer's checklist. All 10 were then reviewed by the `reviewer` agent on the
combined diff and are merged on the final tree (see "Final tree").

- `sec-deep-json-stringify-stall` and `sec-no-body-size-limit`: on the integration tree (D100).
- `cost-ask-costusd-omits-reader`, `cost-readerpush-bypasses-question-cap`, `mem-component-budget-session-leak`,
  `speed-reader-push-late-paid-never-delivered`, `integ-reader-branches-conflict` and
  `cost-late-reader-call-untraced`: on the integration tree, through `r2-reader-merge`.
- `lab-push-source-calls-uncounted`: on `audit/2026-11-03-r2-source-call-accounting`, merged (3c9d73c79).
- `reader-prompt-cache-lost-on-openrouter`: the fix (commit c00a2a7dc), merged (182fcae8f). Its `cache_control`
  breakpoints are now sent only with the `anthropicCache` option (off by default) until a live probe confirms them.

`cost-reader-session-cap-silent` was included in the same reviewer pass.

**Needs your decision (5).**

- `cost-no-tenant-spend-cap` (security). The caller picks the user id, so one API key can run up model spend
  across made-up users. Estimate: up to about $8,640 a day per key at the rate limit. Next step: choose a daily
  spend cap per tenant; the code change is then small.
- `speed-reader-stream-early-exit`. Streaming the reader's reply and stopping early could make it about 2x faster
  (estimate: about 590 ms instead of 1,190 ms). It cannot reach 10x and may lose recall. Next step: decide whether
  to fund a measured trial.
- `speed-push-reader-after-search`. The push waits for the live source search before it reads. Overlapping the two
  could save 0.4-0.8 s (estimate). Next step: decide whether the reader may start on cached results alone.
- `cost-push-duplicates-source-search`. Under NEW2 the push adds 3.2-3.3 connector calls per message, about double
  the connector traffic. Next step: decide whether the push may share the normal search (fewer calls, possible
  recall loss).
- `cost-reader-reasoning-openrouter-anthropic`. Production asks OpenRouter for "low" reasoning; the lab measured
  the reader with reasoning off. Unverified estimate: up to 2.8x the cost per call, and much slower. Next step:
  approve a small paid probe before NEW runs on OpenRouter.

**Too big for this run (1).**

- `speed-draft-speculative-reader`. Starting the reader while the user is still typing is the only path found to a
  near-zero wait (estimate: 10x or more, but only for integrations that send drafts). Pi and Hermes send no drafts,
  so today's labs cannot measure it. Next step: build a draft-streaming test suite first.

**Partly done.** `reader-replay-cache-not-committed`: the lab now stops clearly on a cache miss, but the reader
cache itself is still not checked in, so screening NEW still needs an API key. Next step: decide whether to commit
the cache file.

**Rejected by review (8).** These did not survive verification and need no action:
`mem-per-user-text-dominated`, `dev-redact-test-critical-file`, `sec-deep-json-parse-stall-unchecked-field`,
`speed-push-wait-unbounded-critical-path`, `dev-worktrees-fill-disk`, `cost-superseded-push-read-not-aborted`,
`speed-push-packet-second-roundtrip`, `cost-openrouter-cache-write-premium-all-calls`.

### Where everything is

- **This audit:** `docs/audits/2026-11-03-deep-audit.md` (this file). Findings 1-27 and the round 1 and round 2
  plans follow below.
- **Final branch:** `claude/audit-2026-11-03` (see "Final tree"). The earlier integration tree 6f7a36fee is an
  ancestor of it.
- **Merged** (all named `audit/2026-11-03-<name>`): `r1-server-input-hardening`, `r1-reader-accounting`,
  `r1-gate-instrument`, `r1-lab-visibility`, `r1-waitms-docs`, `r2-reader-merge`, `r2-reader-test-speed`,
  `r2-gate-traffic-budget`, `r2-validate-walk`, `r2-example-waitms-zero`, `r2-bench-warmup`, `r2-funnel-jobs`, and,
  after 6f7a36fee, `r1-check-caches` (8cc2b8073), `r1-openrouter-cache` (182fcae8f) and `r2-source-call-accounting`
  (3c9d73c79).
- **Not merged, on purpose:** `r1-reader-push-wait`, replaced by `r2-reader-merge`. **Do not merge it.**
- **Done before `main`:** the reviewer pass, `bun run check` and `bun run eval` on the final tree. **Still to run:**
  `bun run eval --live`, because these changes touch reader delivery (CLAUDE.md); it needs paid model calls.

## Background

Scope: what Eden costs to run (model spend, memory, developer time) and how fast it answers (server event loop,
reader critical path, `bun run check`). Base: `main` at `164f2909c`. No paid model or API calls were made; every
number below is either from a local command named in the finding or labelled an estimate with its arithmetic.

## Summary in plain language

- **One request can freeze the server for everyone.** A deeply nested JSON body (about 117 KB) makes the input
  check spend about 1.5-1.8 s of CPU before rejecting it. While that runs, no other tenant gets an answer, and
  their clients time out and go silent. A second, smaller version of the same problem: the server accepts request
  bodies up to 128 MB. Both need a valid API key. Both are quick fixes.
- **`bun run check` is slower than it needs to be.** Formatting and type checks redo all their work each run.
  Turning on their built-in caches cut the two steps from about 17 s to about 4 s warm in this session.
- **The reader (the ask-time model call) has several leaks of money and time, none of them large today.** It is
  off by default in production, so none of these hurt a default deployment now; they matter as soon as the NEW
  preset ships. It sometimes reads the same request twice; a slow push read is paid for and then thrown away;
  its spend is missing from the per-ask cost Eden reports; a long session silently stops reading after about 20
  calls; and the production model client drops the reader's prompt-cache marker.
- **There is no per-tenant ceiling on model spend.** Caps exist per session and per user-day, but the caller picks
  the user id, so one tenant key can run up spend across many made-up users. Fixing it needs a decision on the
  cap value.
- **No 10x lever was found for the reader's cost per call.** The remaining big lever is calling it less often (the
  gate), and its saving on realistic traffic has never been measured. Streaming the reply could make it about
  1.6-1.7x faster, not 10x, and carries recall risk.

Round 1 packages 8 work items for parallel fixers (two of them run in sequence) and defers 5 findings that need a
decision from you.

**Round 2 (a review of round 1's branches) in plain language:**

- **Two round 1 fixes were built on the same starting point and now collide.** The reader-accounting fix and the
  push-wait fix both rewrote the same reader code. Merging them carelessly would quietly undo five cost fixes, and
  the type checker would not notice. One package redoes the push-wait fix on top of reader-accounting.
- **Once merged, the tree would not type-check.** A lab script counts reader outcomes and does not know the new
  "budget" outcome. A one-line fix, but it blocks the merge until it lands.
- **Eden still under-reports some spend and some source calls.** A reader call that finishes after the ask has
  returned is paid for but shows as $0 in traces. In the lab, the push's own connector searches are missing from
  calls per task, so under NEW2 the lab reports about 41-42% of the real connector calls.
- **Smaller items.** The example agent cannot turn its wait off (`EDEN_WAIT_MS=0` still waits up to 1.5 s); the new
  input check is about 2-3x slower than it needs to be on large inputs; the new reader tests sleep for real and
  nearly double that file's test time; the no-model funnel uses one CPU core of four; a benchmark's alarming "max"
  numbers are only start-up cost.
- **Two findings need your decision**: whether the push may share the slow path's source search (fewer connector
  calls, possible recall loss), and whether to fund a small paid probe of the reader's reasoning setting on
  OpenRouter before NEW ever runs there.

Round 2 packages 8 work items (three of them wait for another package) and defers 2 findings.

## Findings, ranked by value

Ranked by severity, then effort (S before M), within each round: 1-16 are round 1, 17-27 are round 2 (detailed in
the Round 2 section below). Severities are the verified ones, which in several cases are lower than the auditor's
first rating. Statuses name the branch or package; "deferred" findings name the decision needed.

| # | ID | Severity | Effort | Status |
|---|---|---|---|---|
| 1 | sec-deep-json-stringify-stall | high | S | fixed on `r1-server-input-hardening`, merged; see #23 |
| 2 | sec-no-body-size-limit | medium | S | fixed on `r1-server-input-hardening`, merged; see #23 |
| 3 | dev-prettier-cache-tsc-incremental | medium | S | fixed on `r1-check-caches`, merged |
| 4 | speed-reader-push-late-paid-never-delivered | medium | M | `r1-reader-push-wait` has the wrong base; redone in #17 |
| 5 | cost-ask-rereads-push-verdict | medium | M | deferred (doc sentence fixed on `r1-gate-instrument`) |
| 6 | cost-no-tenant-spend-cap | medium | M | deferred |
| 7 | cost-gate-realistic-traffic | medium | M | instrument on `r1-gate-instrument`, merged; see #19 |
| 8 | speed-reader-stream-early-exit | medium | M | deferred |
| 9 | speed-push-reader-after-search | medium | M | deferred |
| 10 | reader-prompt-cache-lost-on-openrouter | low | S | fixed on `r1-openrouter-cache`, `r1-reader-accounting`, merged; behind `anthropicCache` |
| 11 | cost-reader-session-cap-silent | low | S | fixed on `r1-reader-accounting` and `r1-lab-visibility`, merged |
| 12 | cost-ask-costusd-omits-reader | low | S | fixed on `r1-reader-accounting`, merged; see #20 |
| 13 | cost-readerpush-bypasses-question-cap | low | S | fixed on `r1-reader-accounting`, merged; see #20 |
| 14 | mem-component-budget-session-leak | low | S | fixed on `r1-reader-accounting`, merged; see #20 |
| 15 | painpoint-waitms-undocumented | low | S | fixed on `r1-waitms-docs`, merged; see #21 |
| 16 | reader-replay-cache-not-committed | low | S | miss gate on `r1-lab-visibility`, merged; cache build deferred |
| 17 | integ-reader-branches-conflict | medium | S | fixed in round 2 package `reader-merge`, merged |
| 18 | lab-push-source-calls-uncounted | medium | S | fixed in round 2 package `source-call-accounting`, merged |
| 19 | integ-gate-traffic-budget-outcome | low | S | fixed in round 2 package `gate-traffic-budget`, merged |
| 20 | cost-late-reader-call-untraced | low | S | fixed in round 2 package `reader-merge`, merged |
| 21 | painpoint-example-waitms-zero | low | S | fixed in round 2 package `example-waitms-zero`, merged |
| 22 | dev-reader-test-sleeps | low | S | fixed in round 2 package `reader-test-speed`, merged |
| 23 | speed-input-shape-walk-allocates | low | S | fixed in round 2 package `validate-walk`, merged |
| 24 | speed-eventloop-max-is-coldstart | low | S | fixed in round 2 package `bench-warmup`, merged |
| 25 | cost-reader-reasoning-openrouter-anthropic | low | S | deferred |
| 26 | cost-push-duplicates-source-search | low | M | deferred |
| 27 | dev-funnel-single-process | low | M | fixed in round 2 package `funnel-jobs`, merged |

### 1. A deeply nested tool_call body stalls the event loop for about 1.5-1.8 s (high, S)

- **Evidence.** `jsonUnder` (packages/protocol/src/validate.ts:18-24) runs `JSON.stringify(v)` and treats a throw as
  "too big". It runs on every tool_call (validate.ts:54), reached from /v1/events (packages/server/src/http.ts:79)
  and /v1/check (http.ts:85), after auth and the rate limiter. Scratch probe timing `checkEvent` on a parsed
  `[[[...1]]]` body (Bun 1.4.4): depth 1,000 took 1.6 ms (accepted), 10,000 took 0.6 ms (accepted), 60,000 took
  1,514.9 ms (rejected), 200,000 took 1,449.5 ms (rejected). `JSON.parse` itself took 18.8-27.8 ms. The HTTP probe
  measured 1,844 ms at depth 60,000. A prototype iterative walk rejected depth 60,000 in 0.16 ms.
- **Impact.** Synchronous on the single event loop. Estimate: at about 1.5 s per request, one request per second
  per tenant (far under the 200/s limit, http.ts:30) keeps the loop stalled indefinitely. Other tenants' clients
  time out at 800 ms (packages/client/src/client.ts:76) and fail open, so Eden goes silent for every tenant. Needs a
  valid key. The slow "deep body" tests (http.test.ts:214-230, validate.test.ts:46-48) pay the same cost.
- **Fix.** Before any stringify, walk the value iteratively (explicit stack, counting array elements and object
  values) and reject past a depth cap or about 1e6 nodes; keep the stringify length check as a second pass. A cap
  of 256 would newly refuse depths 257 to about 50,000 that are accepted today, so this is a small protocol
  tightening: record it in a decision row, choose the cap there (proposal: 1,000), and test that depth 100 is still
  accepted. Use loose timing bounds (under 500 ms) so tests are not flaky.
- **Status.** Open, package `server-input-hardening`.

### 2. No request-body size limit (medium, S)

- **Evidence.** packages/server/src/main.ts:19 calls `Bun.serve({ port, hostname, fetch })` with no
  `maxRequestBodySize`; http.ts:55 runs `await req.json()` before validation, and unknown fields are ignored.
  Probe with real `Bun.serve`: 1 MB 200 in 9.0 ms, 64 MB 200 in 144.6 ms, 127 MB 200 in 494.7 ms with RSS +267 MB,
  129 MB 413 in 12.3 ms (client time included). Bun's 128 MB default is the only limit.
- **Impact.** The limiter counts requests, not bytes. Estimate: a 400-request burst of 127 MB bodies is about 51 GB
  of buffering and stalls the loop for every tenant. Needs a valid key (or `EDEN_DEV=1`).
- **Fix.** New `EDEN_MAX_BODY_BYTES` config field, default 8 MB, passed as `maxRequestBodySize`; plus an early 413
  on `content-length` in http.ts after auth and the limiter. 8 MB fits every valid event: the largest field is
  1,000,000 UTF-16 units (validate.ts:10), at most about 6 MB if every unit is a `\uXXXX` escape. Shipping it unset
  would deliver nothing. Needs a decision row (latest is D99).
- **Status.** Open, package `server-input-hardening`.

### 3. format:check and typecheck redo all their work (medium, S)

- **Evidence.** scripts/format.sh:16-19 runs `prettier --check` over 348 files with no cache; scripts/typecheck.sh
  runs `tsc --noEmit` per tsconfig (lines 9-23 loop; only ./tsconfig.json exists) with no incremental build.
  Re-measured: prettier 8.65 s uncached, 8.76 s cold with `--cache --cache-strategy content`, 1.11-1.13 s warm; tsc
  8.57 s plain, 8.53 s cold incremental, 2.78-2.83 s warm, 3.02 s after a leaf edit, 7.97 s after editing a widely
  imported file. A new misformatted file (rc=1) and a new type error (rc=2) were still caught on warm caches.
- **Impact.** 17.2 s cold to 3.9 s warm for the two steps (8.65 + 8.57 vs 1.11 + 2.78), on every `bun run check`.
- **Fix.** Add the prettier cache flags (cache under `node_modules/.cache/prettier/`) to both check and write; add
  `--incremental --tsBuildInfoFile` with one build-info file per tsconfig path; keep a `CHECK_COLD=1` escape hatch.
  The claimed "stale 72 s figure" in docs/TESTING.md does not exist; time the whole check instead. The line-check
  shortcut and a separate lab tsconfig are separate changes, not in this package.
- **Status.** Open, package `check-caches`.

### 4. A push read that lands after askReaderWaitMs is paid for but never delivered (medium, M)

- **Evidence.** observe waits min(waitMs, readerPushWaitMs) (packages/engine/src/partner.ts:702; readerPushWaitMs
  defaults to 60,000, config.ts:765), but the push's readAsk races the reader against askReaderWaitMs (partner.ts:
  1622-1633, default 2,500 at config.ts:755). On "late" it returns `unchanged` (partner.ts:1641-1645), so nothing is
  queued, while the call runs on, settles (reader.ts:599) and is cached. Scratch test (reader delay 300 ms,
  askReaderWaitMs 100, waitMs 3,000): observe returned in 149 ms, reader report "late", 1 call, 0 packets after 1 s.
  reader.test.ts:587 passes only because it sets askReaderWaitMs 3,000. funnel-reader-cost.txt counts reads over
  2.5 s at 18/634 (2.8%) to 65/768 (8.5%).
- **Impact.** The documented readerPushWaitMs (ARCHITECTURE.md:250) cannot take effect; the push wait is capped at
  2.5 s. The cost is cents per 1k requests; the quality cost is unmeasured (2.8-8.5% is an upper bound on tasks
  affected). readerPush is off by default.
- **Fix.** Give readAsk a wait argument and use readerPushWaitMs when `internal.push` is set, so the code matches
  ARCHITECTURE.md:250. Skip delivery when the session is closed or `s.turn` moved on since the request. Do not
  abort on the session's shared signal. Tests: delay 300 ms, askReaderWaitMs 100, readerPushWaitMs 3,000 gives a
  packet; closed session gives none; advanced turn gives none.
- **Status.** Open, package `reader-push-wait` (runs after `reader-accounting`: both edit partner.ts).

### 5. With readerPush, a paraphrased ask_context reads the same request again (medium, M)

- **Evidence.** The push asks with `question: event.text` (partner.ts:685-695); readAsk then builds request, focus
  (readerFocus) and question from the agent's cue (partner.ts:1531-1532, 1584-1620). readerKey (reader.ts:240-249)
  hashes all of them, so a paraphrase misses the cache and the in-flight dedupe (reader.ts:557-575). Scratch test:
  verbatim ask 1 call; paraphrased ask 2 calls ($0.0008 scripted). Ledger: Pi h13 s41 made 476 reader calls over
  320 tasks (1.49 per task), so about a third are second reads. COST-MODEL.md:79-80 wrongly says one call per user
  message.
- **Impact.** Estimate: about 15-35% of reader spend in Pi's eden arm. The latency claims (ask p50 1,087 ms vs
  14 ms) compare reader on against reader off, not the second read, so they are not evidence for this finding.
- **Fix (proposed).** `askReaderReuse` flag, default off, reusing the per-session verdict for the same request.
  The paraphrase changes question and focus, which is sometimes why the second read finds the fact, so reuse can
  lower recall. The `$0` replay cannot measure that (ReplayModel throws on new prompts, packages/sim/src/lab/
  reader-disk.ts:66-76); a paid seed is needed.
- **Status.** Deferred. Decision needed: accept a possible hidden-fact recall loss for about 15-35% reader savings,
  and approve one paid Pi train seed to measure it. The COST-MODEL.md:79-80 sentence is corrected now in package
  `gate-instrument`.

### 6. No per-tenant cap on model spend (medium, M)

- **Evidence.** Budget limits are callsPerSession 20, usdPerSession 0.02 and usdPerUserDay 0.25 only
  (packages/llm/src/budget.ts:6-12, reserve at :57-73); one `new Budget()` serves every tenant
  (packages/server/src/build.ts:47); keys are `tenant/user` with caller-chosen ids (http.ts:85-96). Probe: 1,000
  users x 100 sessions x 20 tries at $0.0005 gave 499,000 grants, $249.50, all for one tenant.
- **Impact.** Estimate (upper bound, assumes every request makes a model call): 200 rps x $0.0005 x 86,400 s =
  $8,640 per day per tenant key. In practice only uncertain judge candidates cost a call, and per-user connectors
  (roadmap M2) would give made-up users no sources.
- **Fix (proposed).** Per-tenant-day tally in Budget, tenant passed explicitly to reserve (not parsed from the key
  string), booked on settle too, plus a server knob and isolation and rollover tests. A default of Infinity
  changes nothing.
- **Status.** Deferred. Decision needed: the per-tenant daily USD cap value (amending D5, which scopes budgets per
  session and per user-day), and approval of the reserve() signature change that touches every Budget caller.

### 7. The gate's saving on realistic traffic is unmeasured (medium, M)

- **Evidence.** p3-GL ledger (packages/sim/lab/haiku/phase3/ledger-summary.jsonl): 623 calls, $0.181512, 2,879
  input tokens per call of which 942 cached, 176 output: $0.000291 per call, recomputed exactly from
  packages/llm/src/pricing.ts. The uncached part is the per-request pool, which prefix caching cannot reach, and
  shrinking it (NEWL) cost -8.3 points. The gate skipped only 2-10 of 768 events on train
  (docs/research/haiku-phase3.md:80-82), which says its real-traffic saving is unmeasured.
- **Impact.** Cost per call has no 10x headroom without losing the hidden fact; calls per user is the remaining
  lever. Estimate, unverified: 30 messages x $0.000291 = $0.0087 per user-day; a 70-90% closed gate would give
  3.3-10x. Note NEWL does not set askReaderQuestions, so its small talk already costs $0 (partner.ts:1533, 692);
  only NEW2 reads every message, at $0.00042-0.00047 per call (COST-MODEL.md:79-80).
- **Fix.** A `$0` instrument: run sim sessions (packages/sim/src/sessions.ts) through a ContextPartner with
  readerGate and a call-counting stub reader, for NEWL and NEW2 separately; report gate outcomes per event kind,
  calls per user message, missed-binding rate and card coverage (uncovered items close the gate and overstate the
  skip rate). Record in bench/ledger.jsonl and COST-MODEL.md labelled as simulated.
- **Status.** Open, package `gate-instrument`.

### 8. Reader latency is mostly output decode; streaming could give about 1.6-1.7x (medium, M)

- **Evidence.** ModelReaderMaker.read waits for the whole reply (reader.ts:448-458); openrouter.ts does not stream.
  A least-squares fit over all rows of funnel-reader-cost.txt gives about 535-548 ms fixed plus 3.65-3.7 ms per
  output token (the auditor's 4-row fit gave 400 ms + 4.2 ms).
- **Impact.** Estimate: stopping after one ~45-token entry gives about 700 ms vs 1,190 ms, about 1.7x. Not 10x.
  Aborting saves no money: generated tokens are billed.
- **Fix (proposed).** Opt-in streaming with an incremental parser. Resolving on the first binding entry drops later
  binding items from the push (partner.ts:1327-1341), and "binds:false first means nothing binds" relies on an
  unmeasured ordering. Safer: end early only on `[]`, or push the first binder and follow with the rest; measure
  entry-order compliance from reader logs first.
- **Status.** Deferred. Decision needed: whether a delivery change that may drop later binding items (a recall
  risk) is acceptable for about 0.5 s, and whether to fund the measurement.

### 9. The push's reader starts only after the live source search (medium, M)

- **Evidence.** The push is a full ask (partner.ts:695) that awaits searchLive (partner.ts:1214) before readAsk
  (partner.ts:1322-1323). Phase 3 ran at time scale 0 (report-pi-h13.txt:1). `bun run funnel --suite train1
  --seeds 41 -- --time 1` (no model) gave lookup p50 418 ms, p90 785 ms, max 1,904 ms over 64 tasks; reader p50
  1,190 ms, p90 1,768 ms.
- **Impact.** Estimate: field push path about 1.6 s p50 and 2.6 s p90, 0.4-0.8 s more than the lab saw. readerPush
  is off by default.
- **Fix (proposed).** Measure first with `--time 1`. The auditor's speculative early read adds a model call when
  new candidates arrive (needs a COST-MODEL estimate and decision); a cheaper lever is running the push's search
  with the existing `behind` / syncPollBehind behaviour (partner.ts:3018-3021). The `$0` replay needs a reader
  cache that is not in the repo.
- **Status.** Deferred. Decision needed: which lever to try (syncPollBehind for the push, or speculative early
  read), and approval of a paid run or the owner's reader cache to measure hidden and decoy counts.

### 10. The production model path drops the reader's cache marker (low, S)

- **Evidence.** packages/llm/src/openrouter.ts:60 maps messages to `{ role, content }`, dropping `cache: true` set by
  readerMessages (reader.ts:277); no `cache_control` is sent. ModelReaderMaker.read passes no `cacheKey`, unlike
  partner.ts:989, 1417 and 4601. Only the lab's anthropic.ts:111-132 emits cache_control. Ledger: p3-pi-train-s41
  5,550 input, 2,843 cached, $0.000395 per call.
- **Impact.** Latent: build.ts wires no reader. Estimate: $0.00065 vs $0.000395 per call (+65%) only for
  `anthropic/*` models through OpenRouter; for the default glm model only the sticky `session_id` helps.
- **Fix.** Keep `cache`; emit `cache_control` blocks only for `anthropic/*` ids so the glm body stays byte-identical
  (package `openrouter-cache`). Add optional `cacheKey` to ReaderInput, filled with `userCacheKey(s.scope)` and
  passed by ModelReaderMaker (package `reader-accounting`).
- **Status.** Open, split across two packages by file.

### 11. The default Budget silently stops the reader after 20 calls a session (low, S)

- **Evidence.** budget.ts:62 refuses call 21 (callsPerSession 20). A refused reserve increments `stats.overBudget`
  (reader.ts:591-595) but the report outcome is "none" (partner.ts:229, 1621-1623), same as a model failure.
  Scratch test: 40 requests in one session gave 20 calls, overBudget 20. `grep overBudget packages/sim/src/lab/*.ts`
  finds nothing. The $0.002 reserve estimate does not bind (settle replaces it), so changing it moves nothing.
- **Impact.** Long sessions under NEW lose reading after about 20 user messages (about 10 with push plus ask), with
  no signal. Lab exposure unmeasured.
- **Fix.** A distinct "budget" ReaderReport outcome; print `reader.stats.overBudget` in the lab summaries. Drop the
  estimateUsd and ReaderLimits.budget parts (AskReader already takes its own Budget, reader.ts:527).
- **Status.** Open: outcome in `reader-accounting`, lab printing in `lab-visibility`.

### 12. AskResponse.costUsd is 0 when the reader made a call (low, S)

- **Evidence.** partner.ts:1404-1405 sets `usedModel = reading?.called === true` and `costUsd = 0`; only askWithModel
  adds cost (:1427); the trace at partner.ts:1447-1458 gets the same 0. Scratch test: first ask costUsd 0,
  usedModel true, reader.stats.costUsd 0.0002.
- **Impact.** Embedders and trace-fed accounting under-report ask-time reader spend. The lab A/B harnesses charge
  through `ownedModel` (pi-ab.ts:364-376), so published lab costs are unaffected. askReader is off by default.
- **Fix.** verdictFor returns the cost of this call (0 when cached or joined); add it to the ask's costUsd and to
  the trace; count modelCalls 2 when both reader and answer model ran. Push spend stays invisible unless the push
  branch emits its own trace; add one with decision "reader-push".
- **Status.** Open, package `reader-accounting`.

### 13. readerPush passes the full user_message as the ask question (low, S)

- **Evidence.** partner.ts:695 passes `question: event.text` (user_message allows 1,000,000 chars, validate.ts:10)
  while checkAsk caps questions at 10,000 (validate.ts:76). ask sanitizes and tokenizes it synchronously
  (partner.ts:1195). Measured: observe at 1 MB with push on took 42.82 ms; with `head(event.text, 10_000)` 4.15 ms,
  same as push off. The reader's prompt is unchanged (it heads to 400 chars, reader.ts:41).
- **Fix.** `question: head(event.text, 10_000)`; test the question/cue length, not an absolute time.
- **Status.** Open, package `reader-accounting`.

### 14. AskReader and QueryBridge Budgets never end their sessions (low, S)

- **Evidence.** Budget.prune clears only userDays (budget.ts:49-54); endSession is called only on deps.budget
  (partner.ts:2035) and in cards.ts:844/943. The labs give reader and bridge separate Budgets (pi-ab.ts:485/501,
  hermes-ab.ts:407/423). Probe: 100,000 distinct sessions left 624 session tallies, capped only by the user-day
  limit (uncapped under hidden-funnel's UNCAPPED budgets).
- **Impact.** Latent memory leak; production wires neither component. Estimate only for per-day size.
- **Fix.** `endSession(session)` on AskReader and QueryBridge, called next to partner.ts:2035; leak test asserting
  `size.sessions === 0` after 1,000 sessions are opened and closed through the partner.
- **Status.** Open, package `reader-accounting`.

### 15. waitMs is undocumented for integrators (low, S)

- **Evidence.** `grep -n waitMs docs/INTEGRATION.md` finds nothing; the client sends none by default
  (client.ts:74-76) and the server defaults to 0 (http.ts:69). examples/personal-agent/agent.ts:56 passes 1,500,
  below the reader's p90 of 1,768 ms. D98 says NEW integrations should pass about 3,000; only
  packages/client/CLAUDE.md:20-21 repeats it.
- **Impact.** Only deployments that opt into NEW are affected; default ones pay no reader cost. No wait loses
  18.2-32.3 points, a 1 s wait 7.6-18.1 (haiku-phase3.md, D98).
- **Fix.** A waitMs paragraph in INTEGRATION.md scoped to NEW/readerPush, pointing at D98, noting the client
  timeout is 800 ms plus waitMs. In the example, keep the default and read the wait from an env var with a
  comment (the client cannot see server-side reader config).
- **Status.** Open, package `waitms-docs`.

### 16. NEW cannot be screened for $0 from a clone (low, S)

- **Evidence.** funnel.ts:59-61 refuses NEW without a reader; funnel.ts:19-20 and docs/LAB.md:67-76 say the reader
  and intent caches are not checked in. Funnel reader spend in phase 3 was about $4.7 over about 10,500 calls;
  the f9 replay rerun still spent $0.114 (272 live, 493 replayed). The disk cache keys on the full prompt
  (reader-disk.ts:25), and a miss fails open (reader-disk.ts:7-8), so a screen with misses is silently part-ALL3.
- **Fix.** Now: count replay misses, print them prominently and exit non-zero unless `--allow-misses`. Later: check
  in a reader and intent cache generated at, or verified against, HEAD.
- **Status.** Miss gate open in package `lab-visibility`. Cache build deferred. Decision needed: approve one paid
  funnel run (estimate about $0.33, the f8 cost) to regenerate the cache at HEAD, or provide the owner's cache.

## Round 1

Eight packages. No two packages that run in parallel share a file. `reader-push-wait` shares partner.ts with
`reader-accounting` and starts only after it merges. Every package ends with `bun run check` green on the final
tree; engine packages also paste `bun run eval` JSON and run the reviewer subagent, per CLAUDE.md.

| Package | Findings | Files (exclusive) |
|---|---|---|
| `server-input-hardening` | 1, 2 | packages/protocol/src/validate.ts, validate.test.ts; packages/server/src/http.ts, http.test.ts, main.ts, config.ts; packages/server/CLAUDE.md; docs/DECISIONS.md |
| `check-caches` | 3 | scripts/format.sh, scripts/typecheck.sh, docs/TESTING.md |
| `reader-accounting` | 10 (cacheKey), 11 (outcome), 12, 13, 14 | packages/engine/src/partner.ts, reader.ts, bridge.ts, reader.test.ts, bridge.test.ts |
| `reader-push-wait` | 4 | packages/engine/src/partner.ts, reader.test.ts, docs/ARCHITECTURE.md (after `reader-accounting`) |
| `openrouter-cache` | 10 (cache_control) | packages/llm/src/openrouter.ts, packages/llm/src/llm.test.ts |
| `gate-instrument` | 7, 5 (doc sentence) | new packages/sim/src/lab/gate-traffic.ts, package.json (one script), docs/COST-MODEL.md, bench/ledger.jsonl |
| `lab-visibility` | 11 (lab print), 16 (miss gate) | packages/sim/src/lab/pi-ab.ts, hermes-ab.ts, hidden-funnel.ts, funnel.ts, reader-disk.ts, docs/LAB.md |
| `waitms-docs` | 15 | docs/INTEGRATION.md, examples/personal-agent/agent.ts |

Deferred this round: 5 (cost-ask-rereads-push-verdict), 6 (cost-no-tenant-spend-cap), 8
(speed-reader-stream-early-exit), 9 (speed-push-reader-after-search), and the cache-build half of 16. Each needs a
decision named in its finding above.

### Round 1 results

All eight packages produced a branch (`audit/2026-11-03-r1-<package>`); none is merged into
`audit/2026-11-03-integration` yet (`git branch -v` shows integration still at 6fea9110f). Review found:

- `r1-reader-push-wait` was cut from 6fea9110f, not from `r1-reader-accounting` as planned, and the two conflict
  (finding 17). It is redone in round 2 and should not be merged as is.
- `r1-gate-instrument` plus `r1-reader-accounting` fail typecheck together (finding 19), so they must merge with the
  round 2 `gate-traffic-budget` fix. Their only textual conflict is docs/COST-MODEL.md.
- `r1-reader-accounting` leaves late reader calls untraced (finding 20) and sets the push trace's sourceCalls to 0
  on a false premise (finding 18).
- `r1-server-input-hardening`, `r1-waitms-docs` and the reader tests carry small follow-ups (findings 21-23).
- Disk was nearly full during verification (one verifier saw 37-38 MB free on /); a failed `git worktree add` there
  briefly moved another branch, which was restored. Free space before starting round 2 worktrees.

## Round 2

Round 2 reviewed the round 1 branches and the paths they touch. Each finding below was verified twice, with no
paid model calls. Numbers come from the verifiers' local commands (named) or are labelled estimates.

### 17. reader-push-wait was branched from the wrong base and conflicts with reader-accounting (medium, S)

- **Evidence.** `git merge-base audit/2026-11-03-r1-reader-accounting audit/2026-11-03-r1-reader-push-wait` is
  6fea9110f, the integration base, although round 1 said push-wait runs after reader-accounting.
  `git merge-tree --write-tree` of the two reports CONFLICT (content) in packages/engine/src/partner.ts and
  packages/engine/src/reader.test.ts (docs/ARCHITECTURE.md merges cleanly). Overlaps in the merged partner.ts:
  readAsk's race (:1693-1710: accounting races `reader.read()` with `starts`/`costUsd`/`overBudget` against a `late`
  timer; push-wait races `verdictFor` only when `Number.isFinite(waitMs)`), and the push's `this.ask(...)` call
  (:709-717: accounting passes `head(event.text, ASK_QUESTION_CHARS)`; push-wait passes `internal`).
- **Impact.** Taking only push-wait's hunk leaves `got`/`starts`/`costUsd` undefined (a compile error), but taking
  push-wait's whole function or file typechecks, because `verdictFor` still exists on the accounting branch
  (reader.ts:587), and silently reverts findings 10 (cacheKey), 11, 12, 13 and 14. Taking accounting's side cuts the
  push at askReaderWaitMs again (finding 4). The combined reader.test.ts has never run.
- **Fix.** Rebase push-wait onto reader-accounting. In readAsk keep `reader.read()` and add the wait argument: race a
  late timer only when `Number.isFinite(waitMs)`, else await the read with no timer; keep the `starts` accounting so
  the call is counted once. At the push call site keep the head() cap and pass `internal`. Keep both branches' tests
  and add one combined test (a push read past askReaderWaitMs has a reader-push trace with costUsd > 0, readerCalls
  1).
- **Status.** Open, package `reader-merge`.

### 18. Lab calls per task drops the push's real connector calls (medium, S)

- **Evidence.** On `r1-reader-accounting` (e7e2d6d64) the reader-push trace sets `sourceCalls: 0, pushSourceCalls:
  sourceCalls`, with a comment that the push "mostly" joins the slow path's search. hidden-funnel.ts:402 counts
  only `t.sourceCalls + (t.anticipateCalls ?? 0)`. Probe (stub reader, counting SimSource.stats.calls, worktree at
  e7e2d6d64, rerun by a verifier): NEW2 seed 41 traced 300 vs 725 connector calls; seed 42 294 vs 704; NEWL seed 41
  334 vs 417; with the push off, 359/338/359 and traced equals connector. stats.lists was 0. On main the push emits
  no trace at all, so phase 3's NEW/NEWL calls per task already left these calls out.
- **Impact.** Lab calls per task is 41-42% of the real connector calls under NEW2 and 80% under NEWL (300/725,
  294/704, 334/417), biasing Bar 2/Bar 3 source-cost comparisons in NEW's favour. "Mostly joins" is false: by the
  same numbers 300 + 656 - 725 = 231 of the push's 656 lookups (about 35%) were joins. The staged edit in worktree
  wf-49 that restores `sourceCalls` overshoots the other way (about 956 vs 725, an estimate) and must not merge.
- **Fix.** Lab: use SimSource.stats.calls (minus stats.lists) per task as ground truth, as quality.ts already does;
  keep the trace as a cross-check. Trace: count calls in searchLive itself, only outcomes that reached the
  connector (not "cached", not joined flights; the fan-out must expose a joined marker), for push and slow path
  alike. Correct the trace.ts and partner.ts comments. Re-measure and relabel any published NEW/NEWL calls per task.
- **Status.** Open, package `source-call-accounting` (after `reader-merge`).

### 19. gate-traffic.ts does not know the new "budget" outcome; the merged tree fails typecheck (low, S)

- **Evidence.** packages/sim/src/lab/gate-traffic.ts:113 on `r1-gate-instrument` is `outcomes: { read: 0, gated: 0,
  none: 0, late: 0, skipped: 0 }`, typed `Record<ReaderReport["outcome"] | "skipped", number>`; reader-accounting
  adds "budget" (partner.ts:233). A verifier merged both into the integration tree and ran the root `tsc --noEmit`:
  exit 2, one error, TS2741 "Property 'budget' is missing" at gate-traffic.ts:113; adding `budget: 0` gave exit 0.
  `atGate` (:235) omits budget too.
- **Impact.** `bun run check` fails on integration once both branches merge. With a capped Budget,
  `outcomes["budget"]++` would give NaN; the lab uses UNCAPPED budgets, so published numbers are unaffected.
- **Fix.** Add `budget: 0`, count it in `atGate`, print it in the summary.
- **Status.** Open, package `gate-traffic-budget`.

### 20. A late reader call's cost never reaches traces or AskResponse (low, S)

- **Evidence.** `r1-reader-accounting` partner.ts:1677-1678: `const costUsd = got === "late" ? 0 : got.costUsd;`.
  The landed call is booked only in AskReader.stats and its Budget. A scratch test (reader 400 ms, $0.0002,
  askReaderWaitMs 100, then 600 ms sleep) fails for an explicit ask and for a readerPush read: traced cost 0,
  traced modelCalls 1, reader.stats.costUsd 0.0002. COST-MODEL.md:82 says reader calls show in AskResponse.costUsd
  and the traces, "each call counted once"; ARCHITECTURE.md:243 is accurate (the reader books it when it lands).
- **Impact.** Metering error, not extra spend (the reader's Budget still caps it). Anyone metering through onTrace
  or AskResponse.costUsd sees $0 for every late call; COST-MODEL.md records 117 of 124 price-routed glm calls past
  2.5 s. The lab meters the reader directly, so lab costs are unaffected.
- **Fix.** Capture `const reading = reader.read(...)` before the race; when `got === "late" && starts`, attach
  `reading.then(...)` that emits a new trace, decision "reader-late" (add it to the Trace.decision union and the
  trace.ts doc list, and check quality.ts:876, timeline.ts:81, pi-ab.ts and hermes-ab.ts), with costUsd,
  modelCalls 1, readerCalls 1, readerCostUsd, sourceCalls 0, latencyMs and turn. Emit it even if the session closed
  (Trace carries sessionId). Mark the ask's own trace as not having called, and document that AskResponse.usedModel
  is then false for late asks. Correct COST-MODEL.md:82.
- **Status.** Open, package `reader-merge`.

### 21. The example agent cannot turn its wait off (low, S)

- **Evidence.** `r1-waitms-docs` examples/personal-agent/agent.ts:57: `Number(process.env.EDEN_WAIT_MS) || 1_500`;
  `Number("0")` is falsy, so 0 becomes 1,500 (`bun -e` printed 1500).
- **Impact.** An integrator copying the pattern with EDEN_WAIT_MS=0 still waits up to 1.5 s (a ceiling: without the
  reader the call returns when its lookup finishes). Only the example; the SDK handles 0 correctly.
- **Fix.** Unset or empty falls back to 1,500; otherwise a finite number clamped at 0 (junk falls back to 1,500).
- **Status.** Open, package `example-waitms-zero`.

### 22. Round 1's reader tests sleep for real (low, S)

- **Evidence.** `bun test ./packages/engine/src/reader.test.ts`: main 2.14 s (29 tests); `r1-reader-accounting`
  3.90 s (38 tests); `r1-reader-push-wait` 4.52-4.55 s (32 tests). push-wait's tests use a 300 ms ScriptedReader
  with `Bun.sleep(150)` and `Bun.sleep(600)` (reader.test.ts:608-650); accounting adds `Bun.sleep(400)` and two
  1,000-session leak tests (reader.test.ts:727, bridge.test.ts:349; 1.09 s and 0.32 s with `-t`).
- **Impact.** Estimate: the merged file at about 6 s (2.2 + 1.7 + 2.4), next to redos.test.ts (6.01 s measured) as
  the engine package's long pole. Test time only.
- **Fix.** A gated ScriptedReader the test releases explicitly, ordering by awaits instead of sleeps; keep one
  real-timer test for each wait bound; run the leak tests over 100 sessions (Budget.sessions has no cap, so any N
  shows a leak). Same assertions.
- **Status.** Open, package `reader-test-speed` (after `reader-merge`).

### 23. D100's input-shape walk allocates an array per object (low, S)

- **Evidence.** `r1-server-input-hardening` packages/protocol/src/validate.ts:33: `const children =
  Array.isArray(v) ? v : Object.values(v)`. Verifier bench (bun, 3 warm-ups): 333,000 empty objects (999,001 chars,
  valid) checkEvent 21.6 ms mean of 20, stringify 3.3 ms, a for-in walk alone 9.2 ms; 50,000 small objects 4.6 ms
  vs main's ~2 ms; a 2 KB realistic input 3 µs.
- **Impact.** A constant-factor cost on large object-heavy inputs only. It is not what saturates the loop: the
  server already pays `JSON.parse` of the same 1 MB body (16.1 ms measured), so the auditor's "one key saturates the
  loop" story is a property of 200 req/s x 1 MB bodies, not of the walk.
- **Fix.** Walk objects with `for (const k in v)` plus `Object.hasOwn`, pushing only container children. Keep
  MAX_INPUT_NODES at 1,000,000 (100,000 would refuse valid input and contradict D100). Test node counts or refusal,
  not wall-clock time. Report before/after with a scratch bench in the PR.
- **Status.** Open, package `validate-walk`.

### 24. pipeline.bench's maxima are cold start (low, S)

- **Evidence.** `bun packages/engine/bench/pipeline.bench.ts` with a scratch copy printing the slowest events,
  run twice by each verifier: the observe max (32-34 ms), slow path max (17-42 ms) and lag max (48-76 ms) are all
  event #0 or lag sample #0. Skipping the first 20 events: observe p99 738-857 µs, max 3-5 ms, slow max 10-16 ms.
  The bench drives events back to back with `Bun.sleep(0)` (pipeline.bench.ts:59-69), so lag measures its own load.
- **Impact.** No product lever; the recurring pauses are under about 16 ms against an 800 ms client timeout.
- **Fix.** Report warm-up (first ~20 events) separately and percentiles after it, still printing the cold numbers.
- **Status.** Open, package `bench-warmup`.

### 25. The reader always asks OpenRouter for reasoning effort "low" (low, S, low confidence)

- **Evidence.** reader.ts:452 sends `reasoning: "low"`; openrouter.ts:64-65 forwards `{effort, exclude: true}`
  (billed as output). The same flag is at bridge.ts:144, cards.ts:484 and partner.ts:991, 1416, 4603. Phase 3's
  NEW numbers used AnthropicModel with thinking off, which ignores the flag (anthropic.ts:145).
- **Impact.** Estimate, unverified: if OpenRouter maps "low" to about 1,024 thinking tokens for Claude, 1,024 x
  $0.50/M = $0.00051 more per call and about 3.7 s more decode (1,024 x 3.65 ms). No production path wires a reader
  today (`grep` of packages/server finds none) and the production default model is glm, where D95 needed "low".
- **Status.** Deferred. Decision needed: when the D98 provider decision for NEW on anthropic/* via OpenRouter is
  taken, approve a small paid probe (about 20 reader calls, a few cents, estimate) of how OpenRouter maps effort for
  Claude, and then a per-role reasoning "off" option that sends an explicit disable (not an omitted field).

### 26. readerPush roughly doubles connector calls under NEW2 (low, M)

- **Evidence.** The push is a full ask that awaits `searchLive(s, cue, askSources)` (partner.ts:1214 on main),
  askSources 6 vs lookupSources 3 (config.ts:624-625), including on messages the slow path skipped. Probe rerun by
  both verifiers (stub reader, counting source): seed 41, 116 messages: NEW2 725 connector calls, NEW2 push off 359,
  NEWL 417 (= NEW), NEWL push off 359; seed 42: NEW 414, NEW push off 338. Lab presets only; readerPush defaults to
  false (config.ts:759).
- **Impact.** About +3.2 connector calls per user message under NEW2 ((725-359)/116), about +100%; under NEW/NEWL
  about +16-22%, 0.5-0.7 per message. The auditor's "askSources 3" variant removed only 40% of the extra.
- **Status.** Deferred. Decision needed: whether the push may reuse the slow path's per-turn search (or only the
  cache) instead of its own 6-source search. That shrinks the reader's candidate pool, which D98/D99 credit with the
  hidden-fact gains, so it needs a new decision amending D96/D99, new per-session shared search state (observe
  starts the push before the slow path decides, partner.ts:686-698), and a hidden/decoy measurement that needs the
  reader replay cache deferred under finding 16 or a paid run.

### 27. The no-model funnel runs in one process (low, M)

- **Evidence.** funnel.ts:98 runs one `spawnSync("bun", funnelArgs)`; hidden-funnel.ts runs suites in sequence and
  seeds on one event loop. `hidden-funnel.ts --suite train --seeds 41,42 --config <ALL3> --no-record`: 22.4-22.6 s
  single process; 11.4-12.8 s as 4 concurrent processes, with all 768 perTask rows identical once timing fields are
  removed (verifier's compare script). `bun run funnel` took 32.5 s with user time about equal to real (one core of
  `nproc` 4).
- **Impact.** About 1.75-2x on every tuning-loop screen. Not 10x (4 cores).
- **Fix.** `--jobs N` in funnel.ts, default 1, spawning hidden-funnel.ts per suite x seed shard with its own `--json`
  and merging rows inside funnel.ts (there is no funnel-score.py). Guards: force jobs 1 with any per-run output file
  flag (--packets, --card-log, --reader-log, --ask-diag, --candidates, --timeline), with --record, and with a live
  judge, reader or bridge; label ms/task as contended when jobs > 1; sum or label the stderr totals per shard.
- **Status.** Open, package `funnel-jobs`.

### Round 2 packages

Merge order on `audit/2026-11-03-integration`: the round 1 branches except `r1-reader-push-wait` (which `reader-merge`
replaces), with `gate-traffic-budget` landing together with `r1-gate-instrument` and `r1-reader-accounting` and the
COST-MODEL.md conflict resolved by hand. `reader-merge` then lands before `source-call-accounting` and
`reader-test-speed`. No two packages that run at the same time share a file.

| Package | Findings | Base | Files (exclusive) |
|---|---|---|---|
| `reader-merge` | 17, 20 | `r1-reader-accounting` + d34351285 | packages/engine/src/partner.ts, reader.ts, trace.ts, reader.test.ts; docs/ARCHITECTURE.md, docs/COST-MODEL.md; trace consumers if needed |
| `source-call-accounting` | 18 | integration after `reader-merge` | packages/engine/src/partner.ts, trace.ts, new source-calls.test.ts; packages/sources/src/guarded.ts; packages/sim/src/lab/hidden-funnel.ts |
| `reader-test-speed` | 22 | integration after `reader-merge` | packages/engine/src/reader.test.ts, bridge.test.ts |
| `gate-traffic-budget` | 19 | `r1-gate-instrument` | packages/sim/src/lab/gate-traffic.ts |
| `validate-walk` | 23 | `r1-server-input-hardening` | packages/protocol/src/validate.ts, validate.test.ts |
| `example-waitms-zero` | 21 | `r1-waitms-docs` | examples/personal-agent/agent.ts |
| `bench-warmup` | 24 | integration | packages/engine/bench/pipeline.bench.ts |
| `funnel-jobs` | 27 | `r1-lab-visibility` | packages/sim/src/lab/funnel.ts, docs/LAB.md |

Deferred this round: 25 (cost-reader-reasoning-openrouter-anthropic) and 26 (cost-push-duplicates-source-search).
Each needs the decision named in its finding above.
