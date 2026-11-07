# A5: correctness bug hunt (2026-11-07 afternoon, wave A)

Session A5 of [audit-1107-plan.md](audit-1107-plan.md): a bug hunt over engine, server, client, sources, llm, redact,
protocol and primitives, weighted to code changed since 2026-11-06 (the candidates push D237, reader stop-early D240,
strict asks D211/D232, revision ordering, `cardsLeanDays` D244, payload notices D210) and to long-running server
behaviour. Method: four parallel hunters (candidates push; ask and reader path; sync, sources, client and redact;
long-running server), each told to reproduce every suspicion with a failing test before reporting; each report checked
again here (the cause read in the code, the test run failing before the fix and passing after). Branch
`claude/a5-bugs` from `c7cfc8fc9`. No paid calls.

Eleven bugs fixed, ranked by severity. Every fix has a test that fails without it.

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
- **Left.** Over-redaction is unchanged: a credential field's rule span can still swallow the following field's key
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
- **Fix.** `untilAborted` (new `sources/src/abort.ts`) races the call against its signal in `list` and `fetchChecked`
  (a search was already bounded by `Singleflight`); `McpSource` gives up its `connect` at the call's signal
  (`connectFor`), the connect itself going on for the next call. A late answer is ignored; the permit and breaker are
  settled as for a timeout.

## 4. Strict ask: a re-read item deleted meanwhile (medium)

- **Symptom.** An ask whose strict re-reads (D211) ran together: item A re-read "changed" (new copy stored), then a
  `sourceRemoved` for A landed while item B's re-read was still on the wire. The ask cited A in its old words: an
  out-of-date copy of a deleted item.
- **Cause.** `verifyItems`' last step fell back to the copy in hand when the cache had no current copy, and checked no
  removal after the re-reads settled (`recheck` checks `isHeldGone` only within its own read).
- **Fix.** After the re-reads, an item the cache holds gone is dropped whatever its own outcome; a "changed" item with
  no current copy cached is not cited in its superseded copy.

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
  state goes at once. A per-session cap that resets daily in `Budget` was the alternative; it would change the
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

## Flaky tests

- `probes.test.ts` "judgeItemBytes …": the engine helper ran with the default 1.5 s `sourceTimeoutMs`; under a loaded
  parallel run the static source's search was cut, nothing reached the judge, and the test read an empty
  `model.calls` (a 1 ms deadline reproduces the exact TypeError). The helper now gives a 30 s deadline; the static
  sources answer at once, so nothing waits longer.
- `partner.test.ts` "only the head of a large event is read": one wall-clock sample under 250 ms; now the best of
  three sessions (a reading of the whole megabyte is slower on every try, so the bound still catches it).

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

- `bun run check`: green, 1,947 pass, 0 fail (base: 1,926).
- `bun run eval`: identical to the base on every metric (precision 0.828, recall 0.48, falseFireRate 0) except
  `plannedLookups`, which is 121 or 122 run to run on both trees (base: 122, 121, 122, 121, 121, 122; this branch: 121,
  122, 121, 122, 122, 122).
- `bun run funnel --jobs 4 --baseline <base>`: hidden 305/384, decoys 267/384 on both; task by task +0 −0; cards
  summed calls 546 on both.
