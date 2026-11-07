# A11: second correctness hunt (2026-11-07 evening)

A second bug hunt over code added on 2026-11-07 that [a5-bugs.md](a5-bugs.md) only partly covered: the
OpenAI-compatible proxy (D280, D282), `POST /v1/explain` and `Session.traces` (D277), the digest and trace-report
scripts (D279, D293), connector presets and `McpSource.fetch`'s record-shaped replies (D294), the Python client
(D278), the demo (D292), the no-key path (D276), `buildPartner`'s options, the Dockerfile, and server limits under
abuse. Method as in A5: four hunters in parallel worktrees (traces and reports; Python client, presets and sources;
server limits, demo and Docker; the seeded fuzz), each told to reproduce every suspicion with a failing test before
fixing it; the proxy was read here. Each fix was read again here and its test run red before and green after.
Branch `claude/a11-bugs2` from `07e881cd1`, with the parent's tip `37767a757` (A3, A8) merged mid-session. No paid
calls ($0).

Twenty-four fixes, ranked by severity (privacy/security > wrong context > cost > crash > cosmetic):

| # | Severity | Area | Bug | Test | Decision |
|---|---|---|---|---|---|
| 1 | Security | client-python | A 3xx sent the API key to whatever host `location` named | `test_eden_client.py` redirect | D313 |
| 2 | Security | Docker | Nested `.env`, `.local/` and Eden data copied into the image (`.dockerignore` without `**/`) | build check (below) | D310 |
| 3 | Privacy (D56) | trace-report, digest | A log line not written by the engine put its words into both reports | `digest.test.ts` | D311 |
| 4 | Wrong context (not-twice) | engine | A slow path delivered an item the next request's fast path handed out during its re-reads | `freshness.test.ts`, fuzz | D314 |
| 5 | Wrong context | client-python | `source_changed(removed={…})` (a set or tuple) sent only the bare signal and returned True | `test_eden_client.py` | D313 |
| 6 | Wrong context | sources (D294) | `McpSource.fetch` missed the record in a text block beside other `structuredContent`, or in an envelope | `mcp-source.test.ts` | D313 |
| 7 | Wrong context | proxy | A message or tool result past 1,000,000 characters was dropped whole, not cut | `proxy-a11.test.ts` | D312 |
| 8 | Wrong context (explain) | engine | A push's trace named the turn current when it settled, not its request's | `push-trace-turn.test.ts` | D311 |
| 9 | Wrong numbers | trace-report, digest | Asks collapsed into one event per turn (an MCP session stays at turn 0) | `trace-report.test.ts` | D311 |
| 10 | Wrong numbers | engine | A verify trace's `sourceCalls` took in other sessions' re-reads (and could be -1) | `freshness.test.ts`, fuzz | D314 |
| 11 | Wrong numbers | digest | An ask-only log priced every plan at $0.00 per 1,000 requests | `digest.test.ts` | D311 |
| 12 | Wrong numbers | digest | An explicit outcome overwritten by an "ended" line that came after it in the file | `digest.test.ts` | D311 |
| 13 | Availability | server | Bodies under 8 MB held the loop 100-660 ms in `JSON.parse` (and junk fields were served 200) | `http.test.ts`, `router.test.ts`, `validate.test.ts` | D310 |
| 14 | Availability | router | A tenant past its rate got unlimited body reads and parses on the router's shared thread | `router-processes.test.ts` | D310 |
| 15 | Cost | proxy | An agent hanging up did not cancel the model call; one gone during Eden's wait still had it called | `proxy-a11.test.ts` | D312 |
| 16 | Cost / latency | client-python | A trickled body held a 0.3 s call for 9.9 s | `test_eden_client.py` | D313 |
| 17 | Cost | sources | `toItems` mapped every row of a reply before cutting to its limit | `sources.test.ts` | D313 |
| 18 | Data loss (minor) | server | No SIGTERM handler: PID 1 in the image ignored it (10 s to SIGKILL), a router child lost its outcome batch | `main-signal.test.ts` | D310 |
| 19 | Crash | client-python | `with_context` raised on message objects (the OpenAI SDK's reply appended as is) | `test_eden_client.py` | D313 |
| 20 | Crash | client-python | `timeout_s=None` made every `observe` raise into the agent's loop; `base_url=None` raised | `test_eden_client.py` | D313 |
| 21 | Low | engine | `explain`'s copy shared plans with the held trace | `explain.test.ts` | D311 |
| 22 | Low (security) | proxy | `x-eden-proxy-key` compared with `!==` | (behaviour unchanged) | D312 |
| 23 | Cosmetic | server | `build.ts` said a no-key server runs no push (D276 says it does) | none | none |
| 24 | Tests | sim, engine, sources | Three tests failing under a parallel Hermes run (the parent's request) | below | none |

## Security and privacy

**1. The Python client's redirects.** urllib's default handler re-sent a 301/302/303 as a GET with every header,
`Authorization` included, to the host `location` named. A scratch server received `Bearer k_secret`; the TypeScript
client under Bun received none (fetch drops it across origins). The client now builds its opener with a handler that
follows no redirect: a 3xx is a failure like any non-2xx and reaches `on_error` with its status. Eden never redirects.

**2. Docker image contents.** `.dockerignore` listed `.env`, `.env.*`, `.local` and `.eden-local` without `**/`,
which Docker matches from the context root only, so `COPY packages` and `COPY examples` copied
`examples/x/.env`, `packages/y/.env.local` and the like into a layer (Bun loads `.env` from its working directory, so
one beside an example is likely). Patterns gained `**/`, plus `**/.eden`, `**/.tmp-*`, `**/.probe`. Evidence: a
`docker build -o type=local` of a scratch context had all four planted files before and none after, with
`docs/profiles` (re-included) still copied. The rest of the Dockerfile held: it runs as `bun` (uid 1000), `/data` is
owned by it, the health check needs no auth and reported healthy in router mode on the built image. Left: source-map
files are created 0644 in a 0755 `/data` (`edenHome`'s 0700 applies only when it creates the directory), and a
`HOST` that is neither loopback nor 0.0.0.0 fails the health check.

**3. Reports reading foreign lines.** A log is often stdout and stderr together (a stdio connector's stderr, a proxy).
`trace-report`'s `isTrace` checked only types, so any JSON line with `decision` and `reason` strings was a trace:
its silent reason printed verbatim ("Silent: looked and delivered nothing (Dana's salary is $200k\n# PWNED)" in the
digest through `explainTrace`), an unknown decision became a Markdown line, an item id's prefix printed as a
connector id ("Dana fired [see](http"), a string count concatenated (`sourceCalls:"5"` gave a $1,806 price row),
and `1e999` printed a p95 of Infinity; the digest parsed traces in loops of its own and counted lines trace-report
refused. One strict reader (`readTrace`) now serves both: the decision must be one of the engine's
(`TRACE_DECISIONS`), ids strings, counts finite and non-negative; a reason outside `SILENT_REASONS` prints "other"
(an engine test scans partner.ts so the list keeps up), a connector id that is not `isId` prints "unknown", and a
connector id with a colon (`work:gmail`, allowed by `isId`) is named whole.

## Wrong context

**4. A repeat across the fast and slow paths (D314).** `deliverChecked` ranked against the ledger, awaited
`verifyItems`' re-reads, then delivered all it had ranked; the next request's fast path could hand one of those items
out from the cache in that wait. Each item's ledger entry is now taken before the wait and an item whose entry changed
is left out (one swept meanwhile, past the cooldown or `MAX_LEDGER_ITEMS`, is kept: nothing handed it out; the review). This is a5-bugs.md's documented core 704 (left there as a known race); the 20,000-seed runs found it
in the default too (2577, flaky 18959).

**5-6.** `source_changed` checked `isinstance(x, list)`, so a set of removed refs sent the bare signal and returned
True while the deleted item stayed deliverable until the next poll. `McpSource.fetch`'s record lookup (D294) read
only the top of `structuredContent`; it now gathers the `structuredContent` object and each text block's object, then
the objects under their container keys (depth 3), the id still required to equal the ref (an envelope holding another
record is still no match, a test). A null there was a failed re-read, never a deletion (no `fetchReportsGone`).

**7. Long text through the proxy.** The API refuses event text past 1,000,000 characters (400, swallowed by the
client), so a large file read or pasted document reached Eden as nothing. The proxy reports its head
(`MAX_TEXT_CHARS`, now exported), which is all the engine reads, with no lone high surrogate at the cut; a tool call whose input's JSON is past the cap (a write of a large file) goes as the head of its arguments' text (the review). The SDKs do
not cut: an integration passing such text directly still loses the event (left; the SDK's `observe` contract is the
caller's text).

**8. A push's trace turn.** The `reader-push` trace took `s.turn` when its lookup settled; with agent events during the
lookup it named a later turn (3 for 1 in the test), so `/v1/explain` showed it under the wrong turn and the reports,
which pair a push with its request by session, turn and event, could count one request twice. `AskInternal.turn` is set
with `internal.request` in `observe` and passed on by `pushAgain`.

## Wrong numbers

**9.** Asks do not move the turn, so keying "spoke" by session, turn and event collapsed every ask in a turn (4 asks, 3
holding items: spoke 1); each ask is now its own key. **10.** `verifyItems` read the engine-wide `freshness.calls`
before and after its awaits; each delivery now counts its own re-reads (`made`). **11.** With no `user_message` in
the log, `callsPer1k` was 0 and every plan read $0.00; the digest now prints raw counts and "n/a". **12.** A plain
`usage.set` let an "ended" or "expired" line after an explicit outcome replace it (files passed newest first, a
shipper reordering); an explicit outcome is now never replaced (the engine sends nothing after explicit feedback).

## Availability, cost, crashes

**13. Body structure (D310).** D100 caps bytes, but structure is what costs a parse. 8 MB bodies, best of 3: one
string 4-7 ms, 4 M small numbers 106-134 ms (and served 200 as a junk field), 2.8 M empty arrays 265-339 ms, 4 M nested
arrays 453-665 ms on the loop; the router's `userOf` paid the same on its shared thread. `bodyShapeUnder` (a byte
scan outside strings, skipping escapes) refuses more than 1,010,000 values or nesting past 1,008 with a 400 before the
parse; the widest and deepest inputs `checkEvent` accepts still pass (a test), as does a 1 M-unit text full of brackets
and escaped quotes. About 9 ms on an 8 MB string body.

**14. The router's limiter (D310, amends D163).** One process answers 429 before reading a body; the router read and
parsed every authenticated body with no limit, so a tenant past its rate had unlimited reads on the thread every tenant
shares, and a stalled body was held until Bun's idle timeout (no response, cut at 12,017 ms). The router now holds a
GCRA at the tenant's undivided rate and burst and answers 429 with Retry-After before the body (under 2 s in the test;
the other tenant 200); each child still holds 1/N.

**15. The proxy's upstream call (D312).** The upstream fetch did not take the caller's signal. An agent that hung up
during a non-streamed completion left it running and billed (upstream aborted 0 of 1 in the test, 1 after); one that
hung up during Eden's wait still had the model called (1 call before, 0 after: the proxy answers 499 to the closed
request). A streamed answer was already cancelled with the client's stream (checked).

**16-20.** Python: urllib's timeout bounds each socket read, so a body trickled one byte every 0.1 s held a 0.3 s call
9.9 s; the body is now read in `read1` chunks against a deadline (a 5 MB and a chunked body still parse, 0.018 s vs
0.024 s before). `toItems` mapped (hashed, stringified) every row before its cut: a 100,000-row reply for a search
keeping 10 took 176-233 ms structured and 225-357 ms as text, now 1.6-2.7 ms and 36-52 ms (the rest is `JSON.parse`).
No SIGTERM handler in `main.ts`: `docker stop` 10.17 s ending in SIGKILL (137) before, 0.14 s exit 0 after; `main.ts`
now opens the source map itself and closes (flushes) it on SIGTERM, SIGINT or the router's disconnect, handlers set
before the listening line (the first version set them after it and the test failed once under a parallel run).
`with_context` read `.get("role")`; options passed as None now take the defaults as the TypeScript `??` does
(`ask(timeout_s=None)` had waited 0.8 s, not 8 s).

## The fuzz at scale

`fuzz.test.ts` gains (1) an explain check after every operation, for a random session, often another user's or one
never opened: no other user's items, at most `EXPLAIN_TRACES`, none for a closed session, no planted item text, title,
secret or question words, counts non-negative numbers; (2) a `default-shadow` configuration in which tenant t1 sends
events and takes with `{shadow:true}` beside a live t0, failing if anything a shadow call returned reaches `onUsage` or
is tracked outstanding (D282 keeps shadow ledger marks, so those are not checked); (3) the same packet handed out twice
is a violation. The checks draw from their own random stream, so earlier seeds replay as before; the regression seeds
run only in the configuration they failed in. Mutation check: `takePending` ignoring shadow, and event text in a trace
reason, are both caught at once. `bun test` of the file: 3.2 s to 4.0 s.

20,000 seeds × 60 operations on each of five configurations (4 chunks of 5,000, 10 processes on 4 cores), on
`07e881cd1`: 969 s. Violations: repeats (finding 4) default 2577, flaky 18959, core 704 and 7797; foreign or negative
verify counts (finding 10) default 1539 and 10316 (no-key and shadow: the default's seeds, nothing of their own); two
false alarms, 9648 and 19657, where a page read before a `sourceRemoved` was stored only after the harness's clock
jumped 4-17 hours past the 10-minute gone-hold: the engine bounds that race by time (call timeouts of about 5 s
against the hold, D126), so the harness skips a removal whose hold the clock passed before it settled. A real clock
jump (a suspended VM) could open the same window; holding the removal by sequence rather than expiry would close it
(a design change, left). The same 100,000 seed-runs on the fixed tree: none (920 s). On the final tree (with the
parent's tip and the other fixes): 4,000 more seeds on all five configurations (seeds 20,001-24,000), see
"Measurements".

## Flaky tests (the parent's request)

- `sim.test.ts` "a rate under one request a second …": a wall-clock bucket at 1 ms = 1 simulated second, so 5 ms of
  load between two calls refilled a token. `SimSource` takes an injectable `clock`; the test drives it and now also
  checks that 4.9 simulated seconds give no token.
- `probes.test.ts` "judgeItemBytes …": read `model.calls[0]` at once, though the judge can run behind the event's
  answer; it now waits for the call (bounded, 10 s).
- `sources/src/regressions.test.ts` "50,000 empty pages …": timers fire late under load, so one fixed wait read the
  heap with deadline timers pending; the reading is now repeated 250 ms apart until it stops falling by more than 64 KB
  (at most 8 s). Bounds unchanged.

All three passed 3 of 3 under 16 busy loops on the 4-core box.

## Checked and rejected (one line each)

Proxy: conversation keys across users (the user id is in the key), `edenId` collisions (injective: `_`-escaping,
`e:`/`h:` re-escaped), path joining to the upstream (`pathname` always starts with `/`), hop-by-hop and `x-eden-*`
headers, a streamed answer on hang-up (cancelled), packets growing within a tool-using turn (bounded by the engine's
not-twice and pacing; not measured further). Explain: isolation (`tenant/user#session` keys, `isId` forbids the
separators), a route naming another tenant (403), the ring bound (32), after end, forget and eviction (`[]`), late
traces landing on a closed session object (not the reopened one). Reports: nearest-rank percentiles at n = 1, division
by zero guarded, restart detection by `run`. Python: `eden_id` parity on 68,546 inputs (every UTF-16 unit, lone
surrogates, astral, empty, `e:`/`h:`, lengths 128/129): 0 mismatches; every error shape (refused, non-JSON, a list or
`null`, 4xx/5xx with or without `{error}`, non-UTF-8, reset, 204) fails open. Presets: never add `trustedReadTools` or
a write tool, explicit fields win, `__proto__` and friends refused. D7: every search, fetch and list call uses a name
`readTool` checked at that connect; a reconnect re-checks; a string `"true"` annotation fails. Server: slow uploads and
idle keep-alives cut at about 12 s by Bun's idle timeout; declared and chunked oversize bodies get 413 in both the
server and the router; `waitMs` clamped; sessions per tenant capped with eviction inside the tenant; the `now` clock
reaches every cache and source-map call (budgets on the wall clock by design). Demo: an item marked caught whose line
the cap cut is not reachable today (496 packets across train1-6 seeds 41-42, none with fewer lines than citations).

## Left

- Python: DNS resolution and a status line or headers sent a byte at a time are not bounded by the timeout (stdlib
  would need threads); no `shadow` option (parity gap).
- The SDKs do not cut text past the API's cap (finding 7 covers the proxy only).
- A proxy request that injects a mid-conversation system message into an upstream that refuses one fails rather than
  retrying without Eden's context (no such upstream seen; a retry would double the model call).
- The removal hold under a real clock jump (above). Source-map file modes in an existing `/data`.

## Measurements on the final tree

See the commit that adds this note for the runs on the final tree: `bun run check`, `bun run eval`, the funnel, the
confirmation fuzz and the reviewer.
