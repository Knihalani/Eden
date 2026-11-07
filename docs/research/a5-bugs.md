# A5: correctness bug hunt (2026-11-07 afternoon, wave A)

Session A5 of [audit-1107-plan.md](audit-1107-plan.md): a bug hunt over engine, server, client, sources, llm, redact,
protocol and primitives, weighted to code changed since 2026-11-06 (the candidates push D237, reader stop-early D240,
strict asks D211/D232, revision ordering, `cardsLeanDays` D244, payload notices D210) and to long-running server
behaviour. Method: four parallel hunters (candidates push; ask and reader path; sync, sources, client and redact;
long-running server), each told to reproduce every suspicion with a failing test before reporting; each report checked
again here (the cause read in the code, the test run failing before the fix and passing after). Branch
`claude/a5-bugs` from `c7cfc8fc9`. No paid calls.

Eleven bugs in the first pass, ranked by severity, then more from A4's merged code, the fuzz harness and the connector-call hunt (sections below). Every fix has a test that fails without it.

| # | Severity | Area | Bug | Test |
|---|---|---|---|---|
| 1 | High (privacy, D10) | redact | A quoted multi-word credential kept every word after the first | `redact/src/keyword-quoted.test.ts` |
| 2 | Medium-high | sync | A lookup's poll cut at its page cap marked the source current with pages unread | `engine/src/sync.test.ts` |
| 3 | Medium | sources | Listings and re-reads ran past their deadline when a source ignored its signal | `sources/src/deadline-unwatched.test.ts`, `engine/src/freshen-deadline.test.ts` |
| 4 | Medium | engine (D211, D126) | A strict ask could cite the old copy of an item deleted during its re-reads | `engine/src/verify-removed.test.ts` |
| 5 | Medium | engine (D237, D65) | `readerPushBehind`'s second pass left neither packet queued during its re-reads | `engine/src/push-behind-gap.test.ts` |
| 6 | Medium (stdio) | server (D281) | A long-lived MCP stdio server lost its reader for good after 20 calls | `server/src/mcp.test.ts` |
| 7 | Low-medium | engine (D244, D125) | A lean-skipped old occurrence kept a recurring event's next occurrence from intent | `engine/src/cards-lean-recurring.test.ts` |
| 8 | Low-medium | engine (`askDedup`) | An ask removed a queued packet whose item its answer's size cap had cut | `engine/src/ask-cut-pending.test.ts` |
| 9 | Low-medium (leak) | engine/reader | An ask racing its session's end left a tally on the reader's Budget and started a call | `engine/src/closed-ask-budget.test.ts` |
| 10 | Low (leak) | engine | An ask-only session's ledger grew for the session's life | `engine/src/ledger.test.ts` |
| 11 | Low (unverified provider) | llm (D240) | A stop-cut reply from a non-Anthropic `EDEN_MODEL` was never closed | `llm/src/llm.test.ts`, `engine/src/reader-stop-native.test.ts` |

Plus two load-flaky tests made robust (below).

## 1. Redact: a quoted multi-word credential (high, privacy)

- **Symptom.** `sanitizeForStore('{"password":"correct horse battery staple"}')` stored
  `{"password":[REDACTED] horse battery staple"}`; prose (`my password is "correct horse battery"`) the same; after
  another credential field (`{"secret":"s","password":"…"}`, `password: x, passphrase: "…"`) the next key's value
  leaked whole.
- **Cause.** D13's keyword rule took `(\S{6,})` from the opening quote to the first space. The structural assignment
  pass (`redactString`), which takes a quoted value whole, runs after the rules on the gated text: it saw a bare
  sentinel where the value began and skipped it (`redact.ts`, "already reduced to the sentinel"). A rule span running
  over the next field's key hid that key from the pass entirely.
- **Fix.** The keyword rule takes a double-quoted value whole (`"[^"\n]{4,256}"|\S{6,}`, bounded, so D24's linear-time
  sweeps stay green); and when any rule finds something, `sanitizeForStore` adds the assignment pass's spans on the
  original text (`assignmentSpans`, new export of `redact.ts`) to the rules' spans. No finding, no extra scan.
- **Cost.** `bun packages/primitives/bench/gate.bench.ts`, two runs each: 2 KB p50 12.18/13.44 µs before, 12.06/12.15
  µs after; 16 KB p50 137.8/135.5 µs before, 130.4/131.2 µs after (noise).
- **Recall cost.** Quoted prose after a credential word is now redacted whole (`Secret Santa: "Bring a gift under
  $20"` loses the quote, where before only `"Bring` went): the safe direction; eval and funnel unchanged. The
  reviewer timed crafted 112–130 KB inputs at 6–19 ms (linear, D24).
- **Left.** Over-redaction is otherwise unchanged: a credential field's rule span can still swallow the following field's key
  (`{"password":"hunter2long","note":"meet Dana at 9"}` stores `{"password":[REDACTED] Dana at 9"}`, before and after;
  another rule's span), and a closing `}` after a redacted value can be eaten by the final pass. Precision losses, not
  leaks.

## 2. Sync: catch-up past the page cap (medium-high)

- **Symptom.** More changes than a lookup's poll reads (`syncCatchupPages` 2 × page 100 in the default) left the
  rest unread while `current` said the source was up to date; lookups answered from the index without them until the
  next sweep (24 h). In the test, 250 changes: 200 held, and the source marked current.
- **Cause.** `SourceSync.poll`'s background continuation called `poll` with no cursor: it started from the newest page,
  which held what the lookup had just stored, read that as the boundary ("already synced and unchanged") and called
  `polled`.
- **Fix.** The continuation resumes as the same poll (`PollResume`: cursor, changes so far, start time, the notice and
  push marks taken when the lookup's poll began), so the boundary is met only past the pages read and the rate
  posterior learns over the whole poll.
- **Test.** `sync.test.ts` "more changes than a page": both page modes now settle to 250 held and current (fails on the
  old code: 200).

## 3. Sources: deadlines a source ignores (medium)

- **Symptom.** `SourceFanout.list` and `fetchChecked` awaited the source's call with no race against the deadline:
  with `timeoutMs` 50 against a source that ignores its signal, each took 801 ms (and `fetchChecked` said "null", not
  "timeout"). The real trigger is `McpSource`: its `connect` and `tools/list` take no signal (the SDK's own 60 s request
  timeout), and `listPage`/`fetch` connect first. An ask with a stale warm source and `sourceTimeoutMs` 100 waited 1.5 s
  on its on-demand poll, breaking D140's one deadline; the strict re-reads (D211) wait on `fetchChecked` too.
- **Fix.** `untilAborted` (new `sources/src/abort.ts`) races the call against its signal in `fetchChecked` (a search
  was already bounded by `Singleflight`); `McpSource` gives up its `connect` at the call's signal (`connectFor`), the
  connect itself going on for the next call; and a lookup waits for its on-demand poll (`freshen`) only until its
  deadline (`searchLive`), after which the source, not current, is searched with no time left ("timeout", D148). A
  late answer is ignored; the permit and breaker are settled as for a timeout (the caller's own abort settles it as
  "ignored"), so a source that ignores its signal can briefly hold more calls than its concurrency cap, as an
  abandoned search already could.
- **Not raced: `SourceFanout.list`.** Racing it too (the first version of this fix) added one await to every listing,
  and that moved the funnel's card batching: the same 6,582 items sent in 546 calls instead of 504, hidden and decoys
  unchanged (the drain-timing pitfall in packages/engine/CLAUDE.md). The engine's bound on the poll covers the
  lookup; a background listing that ignores its signal only holds its own sync slot.

## 4. Strict ask: a re-read item deleted meanwhile (medium)

- **Symptom.** An ask whose strict re-reads (D211) ran together: item A re-read "changed" (new copy stored), then a
  `sourceRemoved` for A landed while item B's re-read was still on the wire. The ask cited A in its old words: an
  out-of-date copy of a deleted item.
- **Cause.** `verifyItems`' last step fell back to the copy in hand when the cache had no current copy, and checked no
  removal after the re-reads settled (`recheck` checks `isHeldGone` only within its own read).
- **Fix.** After the re-reads, an item the cache holds gone is dropped whatever its own outcome; a "changed" item with
  no current copy cached (evicted meanwhile, not removed) is not cited in its superseded copy, and a strict ask counts
  it as not re-checked, so the answer names it rather than reading as an all-clear (D127; the review's finding 1, with
  its own test).

## 5. readerPushBehind: a gap with no packet queued (medium)

- **Symptom.** The second pass (after the poll stored something) took the first packet out of `s.pending` and
  withdrew it, then awaited `verifyItems` (a connector call when an item is doubted, the case the second pass exists
  for), then queued its own. A `takePending` in that window got nothing: the push reached the agent a request late,
  after it may have acted. A candidates pass whose re-reads dropped every item left nothing at all in place of the
  first packet.
- **Fix.** The first packet's items still count as undelivered for the second reading, but it is withdrawn only after
  the re-reads, in the same synchronous step that queues its replacement; a candidates pass with nothing verified keeps
  it (the reader path, whose second reading can say nothing binds, still withdraws as before); if the agent took it
  during the re-reads, its items go again only if fresh or revised. The ledger entries kept for undo are read after
  the withdrawal, as before.

## 6. MCP stdio: one session for the process's life (medium for stdio users; D281)

- **Symptom.** `mcp-stdio.ts` used one session id per process; MCP sends no session end, and the engine's idle sweep
  runs only when another session opens. The reader's Budget caps a session at 20 calls and $0.02 with no day roll-over,
  so after about 20 reader calls every later ask in that process took the no-model path, silently, across days, until
  the client restarted the server.
- **Fix (D281).** `createMcpServer` moves to a new session id (`<id>.<n>`) after `MCP_SESSION_IDLE_MS` (2 h, the
  engine's `sessionIdleMs`) with no ask, or when the UTC day changes, and ends the old session (`session_end`), so its
  state goes at once, once the old session's last ask in flight returns (MCP clients may call tools in parallel; the
  review's finding 4). A per-session cap that resets daily in `Budget` was the alternative; it would change the
  Budget's meaning for every embedding, where a session is the agent's.

## 7. cardsLean and recurring events (low-medium)

- **Symptom.** A recurring event's occurrences share a title and text. If an old occurrence (outside `cardsLeanDays`)
  was enqueued first, it was kept with no card under the content key, and the upcoming occurrence then counted as
  "already known": never read for its requests (`requestsOf` empty).
- **Cause.** `CardEnricher.enqueue` caches by content (`cardKey`), but the lean decision (`readForIntent`) is by date.
- **Fix.** An entry kept because the lean window skipped it is marked `leanSkipped`; a later item with that content
  that the window reads is enlisted for its requests. The funnel did not move (below): its planted items do not repeat
  content across dates.

## 8. An ask dropping a packet its answer cut (low-medium)

- **Symptom.** After an ask, a queued packet whose every item the answer cited was removed from `s.pending`, though
  the answer's byte cap could cut an item's line from the text: the agent never saw that item in either. Reachable with
  `maxItems` above about 8–10 and long excerpts.
- **Fix.** Covered means rendered: `renderedCount(items, injection.text)`, the helper the update path already used.

## 9. A closed session's ask and the reader's Budget (low-medium, leak)

- **Symptom.** An ask waiting on the push's verdict (`reusePush`) when its session closed went on to `reader.read` for
  the closed session: a new tally on the reader's Budget under a key whose tally `close` had already ended (one entry
  kept for the process's life per such race), and a second call started.
- **Fix.** `readAsk` returns after `reusePush` when the session closed; `AskReader.call` reserves nothing for an aborted
  signal.

## 10. An ask-only session's ledger (low, leak)

- **Symptom.** `Ledger.mark` drops entries once 40 turns old, but turns move only on events; an ask-only session (the
  MCP server's) stayed at turn 0, so every item its answers cited was kept for the session's life.
- **Fix.** `MAX_LEDGER_ITEMS` (2,048), oldest dropped first, as `MAX_SHOWN_COPIES` bounds the shown copies. Far above
  what a session's context holds, so not-twice is unchanged in practice.

## 11. Stop-early on non-Anthropic models (low; provider reasons unverified)

- **Symptom.** `OpenRouterModel` set `stopped: false` for every native finish reason but Anthropic's `stop_sequence`.
  Upstreams whose reason says either a stop hit or a natural end (OpenAI's "stop", Google's "STOP", as the hunter
  understood them; not checked with a live call) then never had a cut reply closed (`closeStopped`), so every stopped
  reading was dropped as unreadable on such an `EDEN_MODEL`. The shipped default (Haiku via OpenRouter) is unaffected.
- **Fix.** `stopped` is true for `stop_sequence`, false for reasons that are never a stop hit (`end_turn`,
  `max_tokens`, `length`, `MAX_TOKENS`, `tool_use`, `tool_calls`), and unset for anything else, as for an unreported
  reason.

## Classes, not cases: the engine fuzz harness

The parent asked for structural checks that remove a whole class of bugs. `packages/engine/src/fuzz.test.ts` (with
`fuzz-world.ts`) is a seeded fuzz of the engine's session state machine: 2 tenants × 2 users × 2 sessions, one
notifying, listable, fetchable source per user whose calls settle after a seeded 0–3 turns, and random interleavings
(about 40% run in the background) of user, agent and tool events with and without waits, asks, takes, source adds,
edits and deletes with or without their notices (`sourceChanged`, `sourceItems`, `sourceRemoved`), session ends,
forgets, sync ticks and clock jumps across UTC midnight. After every hand-out and every operation it checks:
isolation (D9, `explain` traces included), redaction of planted secrets (D10), the data envelope (D11), no hand-out of
a removed item after its removal settled (D126), nothing for a closed session and `sessionCount` bounded (D17), fail
open, and not-twice (proactive repeats of an item version within the cooldown). Four configurations: the default with
a stub reader, the default with no reader (D276), the default with one source call in ten failing, and the core.
`bun test` runs 8 seeds × 60 operations a configuration plus the regression seeds in 2.6–3.2 s; `FUZZ_SEEDS`,
`FUZZ_OPS`, `FUZZ_PLAN` (replay) and `FUZZ_MINIMIZE` scale and shrink it.

- **Found and fixed: a packet queued before `sourceRemoved` was handed out after it** (default config: 29 of 2,000
  seeds at 60 operations; candidates, rule-path, fallback and "updated:" packets). `dropGone` cleared the cache, the
  sync's records and held pages, not packets already queued. A removal now drops queued packets citing a removed item
  for every session of that user (undoing their ledger marks where an undo was kept), and `takePending` and observe's
  hand-out drop any that cite an item held gone (`dropRemovedPending`). Seeds 61 and 328 run with every default run.
- **Left, documented: two rule paths repeating an item version in one session** (`CORE_CONFIG` only, 1 of 2,000
  seeds: core 704). A request's fast path delivers from the cache while the previous request's slow path is in flight;
  the slow path ranked against the ledger before its awaits and `build` marks without testing it again. The same race
  between the candidates push and the rule paths is documented and kept (D258, cl-cl8.md "Repeats"); the harness exempts
  that form and reports this one when scaled.
- **Scale runs**: about 11,500 seed-runs while it was built (2,000 × 60 and 500 × 200 operations on three
  configurations, 1,000 × 60 on four), then 1,000 × 60 on all four on the fixed tree: no violation but core 704; 300 × 60 on all four after the connector-call fixes: none.

## Wasted connector calls

Connector calls are priced per call on some platforms ($10–26 per 1,000), so a hunter counted calls. Fixed
(`engine/src/sync-calls.test.ts`, each failing before):

- **A demand listing cut at the lookup's deadline (D283).** `freshen` passed the lookup's 1.5 s signal into the
  listing, so a listing slower than that was cancelled (and billed) by every lookup, stored nothing and never made the
  source current (4 listings for 4 lookups, current 0 of 4). The lookup now stops waiting at its deadline, and the
  listing goes on under the sync's own timeout (a closed session still cuts it); a later lookup joins it (`busy`).
  `ask-deadline.test.ts`'s "polled again" case now expects the join.
- **The daily sweep paged every source to the user's whole cap (D283).** `maxItems` (3,000) is across sources, so a
  quiet source was listed to 3,000 items a day and its synced set grew past the backfill's cut. The sweep now reads a
  source back to the oldest item synced from it and stores nothing older (test: 4 pages and 20 synced docs before, 1
  page and 1 after). About 29 calls a day per extra large source per active user at page 100.
- **A broken list tool listed again by every lookup.** `freshen` ignored `retryAt`. It now skips a source whose
  listing failed twice running while it backs off (searched live, as D127 has it). One failure is not enough: in the
  funnel that rule replaced cheap polls after transient failures with live searches and probes (2.69 request calls a
  task became 2.83); with two it stays 2.69 and a broken tool costs one listing a back-off step.
- **Handed to A8, not fixed here: a null re-read re-fetched by every ask** (`partner.ts` `recheck`/`check`). A null
  from a source without `fetchReportsGone` (every MCP source) is "unverifiable" and the copy stays doubted, so every
  later ask or delivery citing it re-fetches it after `CHECK_REUSE_MS` (30 s) or from another session (6 asks 31 s
  apart: 6 fetches for one signal; 4 sessions: 4). Background fetches with payload notices are A8's area; the repro
  was passed on.
- Checked and not wasteful: re-reads shared within 30 s, a notice on an unchanged source (one 5-item page), demand
  polls joining a running read, probes and the planner deduped, `afterPoll` and the second push pass searching no
  more, sources without fetch, `tools/list` once per connect, open breakers, payload notices (no poll).

## A4's new code (merged mid-session at a750f5f22)

A fifth hunter read A4's merge (D276 candidates without a reader, D277 traces and `/v1/explain`, D278 the Python
client, D279 trace-report, D280 the proxy). The engine and server parts held under every hypothesis tried (isolation of
`explain`, the ring's bound, content-free explanations, 400s for bad ids, router forwarding, D276's push guards). Three
proxy bugs were fixed (`proxy/src/proxy-a5.test.ts`, `with-messages.test.ts`):

- **A repeated user message was never a new turn (medium).** New messages are told by content counts, so "yes" or
  "continue" said again (an agent sending only its latest turn, or a window past the first copy) was not reported, and
  the previous turn's packets were re-inserted into the new turn. Now a request ending with a user message is a new turn
  unless its messages repeat the previous request's exactly (a retry; two identical requests in a row cannot be told
  apart, and are reported once).
- **Shadow mode trained the source map (medium; D282).** Shadow took packets like a live integration, so the engine
  counted them shown, and usage tracking recorded every cited source as unused in the persistent source map. Shadow
  requests now carry `?shadow=1`; the engine skips `handOut` for them.
- **Injecting re-serialised the body (low).** `JSON.stringify` of the parsed body lost the digits of a 64-bit `seed`
  and changed number formatting. `withMessages` now replaces only the top-level `messages` value in the raw text
  (checked against `JSON.parse` over 300 generated bodies).

## Flaky tests

- `probes.test.ts` "judgeItemBytes …": the engine helper ran with the default 1.5 s `sourceTimeoutMs`; under a loaded
  parallel run the static source's search was cut, nothing reached the judge, and the test read an empty
  `model.calls` (a 1 ms deadline reproduces the exact TypeError). The helper now gives a 30 s deadline; the static
  sources answer at once, so nothing waits longer.
- `partner.test.ts` "only the head of a large event is read": one wall-clock sample under 250 ms; now the best of
  three sessions (a reading of the whole megabyte is slower on every try, so the bound still catches it).
- `shapes.test.ts` "fuzz: every built query is inert, …": 0.6–0.9 s alone, past bun's 5 s default under a loaded
  `bun run check`; an explicit 30 s timeout (fewer assertions per query were tried and saved nothing).
- `sources/src/regressions.test.ts` "50,000 empty pages … under a 4 MB cache budget": the heap was read while some of
  the 50,000 searches' real-time 1 s deadline timers were still pending, a share that depends on load. It now waits
  for them to lapse and takes the least of three collections; the bounds are unchanged (3 of 3 under 16 busy loops).

## Review

The `reviewer` subagent ran `check` and `eval` on the branch, re-ran the new tests against the base, and mutation-tested
`verifyItems`: REQUEST_CHANGES for one finding (a strict ask dropping an evicted "changed" item without naming it,
fixed above with a test), plus low ones taken: assertions on the deadline tests' statuses, the abandoned-permit note,
MCP rotation waiting for in-flight asks, ARCHITECTURE.md. It probed the `readerPushBehind` restructure (candidates and
reader paths, a packet taken during the re-reads, an item revised meanwhile) and the `PollResume` continuation and
found them sound.

## Second review

The `reviewer` ran on the second half (proxy, fuzz harness, connector calls): REQUEST_CHANGES, all taken:

- **High: the sweep's cut marked an empty source current and stored none of its new items.** `oldestSynced` gave
  Infinity for a source with nothing synced, so its first page stored nothing and still counted as a poll. It now
  reads such a source as before (`sync-calls.test.ts`, "nothing synced").
- **A lookup's listing that outlived its deadline was in no trace** (traces must sum to the calls connectors
  received): a demand call is now counted when it is sent and taken back on a guard's skip, and the ask path no
  longer races its own 0 against `freshen`'s count (`freshen` bounds the wait itself).
- **A retry with a changing system prompt read as a new turn** in the proxy: `Conversation.last` now leaves out
  system and developer messages, as the conversation key does.
- **A listing that never answers held its source busy for good** once neither the fan-out nor the lookup cut it: `run`
  lets the source go after (20 pages + 1) × the sync's call timeout, by a timer (no await on the listing path), and
  `busy` is a promise the watchdog can settle, so waiters are freed too.
- Documented: shadow skips `watchCopies` too, so shadow counts miss "updated:" packets (D282); `withMessages` misses
  a `\u`-escaped `messages` key after a plain one (it fails open: the request goes without Eden's context);
  `dropGone`'s queue pass scans every session, as `forget` already does (a per-user session index is A1's to weigh).

## Checked and rejected (one line each)

Budgets across UTC midnight (pruned per day, settle books to its own tally); concurrent reserves overshooting a cap
(`reserve` is synchronous); refunds on failure (settled at 0); `Pacer`, `AskReader`, `ItemCache`, `SourceFanout`,
`Gcra`, `QueryPlanner`, `CardEnricher`, `SyncManager`, `UserSources` and the router's timers (all bounded or cleared);
400 interleaved asks, events, pendings, ends and forgets on shared sessions over HTTP (no 5xx, kept as
`server/src/concurrent-session.test.ts`); a stop string inside a `why` (escaped by JSON); escaped quotes or braces at a
cut; a cut Anthropic stream (an error since 625200e9); strict retries with two asks in one session; a notice for an
unknown source; a notice during a running poll; the backfill cursor on a failed page; the breaker never closing; the
client on a non-JSON 503 and its `sourceChanged` shape; redaction crashes on lone surrogates, NUL, deep JSON or 1 MB;
Unicode case folding hiding a key; a withdrawn packet announcing a revision; `takePending` ordering (`currentLast`);
`withoutCoveredUpdates` dropping another item's update; a closed session getting a packet queued.

## Measurements on the final tree

The first comparisons in this session (eval and funnel "unchanged") ran the base checkout with `node_modules`
symlinked into this checkout, so `@eden/*` resolved to the branch's code on both sides: they compared the branch with
itself. The base was then given its own install and everything re-measured against the parent tip:

- `bun run check`: green, 2,014 pass, 0 fail (base c7cfc8fc9: 1,926; the tip's merges add their own tests).
- `bun run eval` (parent tip ae5757b75, after D276's by-design change): precision 0.5909, recall 0.52, falseFireRate
  0, `plannedLookups` 87 on the tip and on this branch, two runs each.
- `bun run funnel --jobs 4 --baseline <tip>`: hidden 305/384, decoys 267/384 on both; task by task +0 −0; request
  calls 2.69 a task and amortised 3.81 on both; card calls 504 on both. Two first versions moved it and were changed
  (above): racing `SourceFanout.list` (card calls 504 to 546, by moving the card drain's timing) and skipping a
  listing after one failure (request calls 2.69 to 2.83).
