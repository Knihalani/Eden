# Deep audit: cost and speed (2026-11-03)

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

## Findings, ranked by value

Ranked by severity, then effort (S before M). Severities are the verified ones, which in several cases are lower
than the auditor's first rating. "Package" names the round 1 work package; "Deferred" names the decision needed.

| # | ID | Severity | Effort | Status |
|---|---|---|---|---|
| 1 | sec-deep-json-stringify-stall | high | S | open, package `server-input-hardening` |
| 2 | sec-no-body-size-limit | medium | S | open, package `server-input-hardening` |
| 3 | dev-prettier-cache-tsc-incremental | medium | S | open, package `check-caches` |
| 4 | speed-reader-push-late-paid-never-delivered | medium | M | open, package `reader-push-wait` (after `reader-accounting`) |
| 5 | cost-ask-rereads-push-verdict | medium | M | deferred (doc sentence fixed in `gate-instrument`) |
| 6 | cost-no-tenant-spend-cap | medium | M | deferred |
| 7 | cost-gate-realistic-traffic | medium | M | open, package `gate-instrument` |
| 8 | speed-reader-stream-early-exit | medium | M | deferred |
| 9 | speed-push-reader-after-search | medium | M | deferred |
| 10 | reader-prompt-cache-lost-on-openrouter | low | S | open, packages `openrouter-cache` and `reader-accounting` |
| 11 | cost-reader-session-cap-silent | low | S | open, packages `reader-accounting` and `lab-visibility` |
| 12 | cost-ask-costusd-omits-reader | low | S | open, package `reader-accounting` |
| 13 | cost-readerpush-bypasses-question-cap | low | S | open, package `reader-accounting` |
| 14 | mem-component-budget-session-leak | low | S | open, package `reader-accounting` |
| 15 | painpoint-waitms-undocumented | low | S | open, package `waitms-docs` |
| 16 | reader-replay-cache-not-committed | low | S | partly open (miss gate in `lab-visibility`); cache build deferred |

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

Round 1 results: pending.
