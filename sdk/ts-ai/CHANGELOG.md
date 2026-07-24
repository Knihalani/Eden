# Changelog — @eden-ai/sdk (TypeScript)

All notable changes to the Eden TypeScript SDK are documented here. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## 0.3.4 — 2026-07-24

### Changed
- Lockstep release with Python SDK 0.3.4 (no TypeScript runtime changes).

## 0.3.3 — 2026-07-23

### Added
- Bedrock + Gemini instrumentations now extract input/output/cache/total
  token usage (parity with OpenAI/Anthropic), including Converse API and
  InvokeModel body shapes.

### Changed
- Documented that Node `fetch` uses undici keep-alive pooling (no
  httpx-style pool knobs needed).

## 0.3.2 — 2026-07-18

### Fixed
- `flush()` waits for in-flight POSTs then drains (parity with `flushChunks`).
- `wrapOpenAI` / `wrapAnthropic` / `wrapLangChain` / `wrapVercelAI`:
  re-wrapping the original client returns the same Proxy (WeakMap),
  not the bare original.
- LangChain async `invoke`/`call`/`batch` errors emit telemetry
  (including `error_message`); early stream `return()` emits aggregate.
- Vercel AI: emit when `streamText` has no attachable stream; read
  AI SDK v4 `text-delta.text`.

### Changed
- **Breaking:** `redactOnClient` now defaults to `false`. Restore with
  `redactOnClient: true` or `EDEN_REDACT_ON_CLIENT=1`.
- **Breaking:** `instrument()` no longer enables HTTP capture by
  default (avoids double-emit with `wrap*`). Pass `httpCapture: true`
  to opt in.
- Streaming chunks omit `deltaText` unless `captureChunkText: true`
  (or `EDEN_CAPTURE_CHUNK_TEXT=1`).
- Ingest POSTs use `Content-Encoding: gzip`; multi-format flush is
  concurrent (`Promise.all`).
- Package sets `"sideEffects": false`; `ModelAdvisor` also available
  via `@eden-ai/sdk/model-advisor`.

## 0.3.1 — 2026-07-17

### Added
- F23 agent sessions via ingest path (`/ingest/agent-sessions`) with
  `X-Org-Api-Key`; `identify()`, cost attach, flush-on-complete.
- `wrapBedrock` / `wrapGemini` provider wrappers.
- `recordStumble` (F28) parity with Python.
- Client sampling (`EDEN_SAMPLING_PROFILE`) mirroring N16 profiles;
  durable offline JSONL queue; OTel `BatchSpanProcessor`.
- Doctor `sessionConfig` check; npm `files` include CHANGELOG;
  repository/homepage/bugs metadata.

## 0.2.27 — 2026-07-09

Bug-fix release.

### Fixed
- All four auto-instrumentations
  (``openai.ts``, ``anthropic.ts``, ``langchain.ts``,
  ``vercel-ai.ts``) used to store only the **class name**
  of a thrown error (e.g. ``error_type: "Error"``) and
  drop the message on the wire. The Python SDK's
  instrumentations have always captured both
  (``error=repr(exc)``) and the trace ``recordError`` path
  also captures the message; a thrown
  ``new Error("rate limit")`` from a TypeScript
  instrumented call landed on the wire as just
  ``error_type: "Error"`` and two distinct ``Error``
  throws were indistinguishable in the portal's trace
  detail view. The shared ``errorClass`` /
  ``errorMessage`` helpers (added to ``ids.ts``) are
  now used by every catch block, so each
  ``llm_completion`` / ``llm_completion_stream`` event
  also carries an ``error_message`` field on the wire.
  Mirrors the Python SDK's existing wire shape so the
  portal renders identical error rows for events from
  either language.
- ``tokens.coerceInt`` (used by ``extractUsage``) used to
  accept any finite number, including fractional
  floats (``coerceInt(0.7) === 0.7``). The
  ``_coerce_int`` Python helper has been strict since
  0.2.9 and rejects fractional values; the TS path
  silently disagreed and let ``0.7`` propagate through
  to ``input_tokens`` and bill a call for a fractional
  token. The shared helper now mirrors Python's
  behaviour: whole-number floats round-trip, but
  fractional floats and fractional strings return
  ``null`` (and the matching field is omitted from the
  wire payload). NaN / infinity / empty-string inputs
  are also rejected.

### Added
- ``ids.errorClass(err)`` and ``ids.errorMessage(err)``
  shared helpers. The class helper always returns a
  non-empty string for any throw shape (``Error``,
  ``null``, ``undefined``, primitives, plain objects,
  arrays); the message helper returns ``undefined`` for
  ``null`` / ``undefined`` and a stringified form
  otherwise (with a ``JSON.stringify`` fallback for
  objects so circular refs don't crash the cleanup
  path).

### Tests
- 1 new test in ``tests/instrumentations.test.ts``:
  ``wrapOpenAI > captures errors without breaking the
  call`` now also asserts the message is on the wire.
- 1 new test in ``tests/instrumentations.test.ts``:
  ``wrapOpenAI > captures the error message for
  non-Error throws (object, primitive, string)`` — pins
  the four non-``Error`` throw shapes (``TypeError``,
  string, number, plain object) all produce a non-empty
  ``error_type`` string.
- 4 new tests in ``tests/tokens.test.ts``:
  ``whole-number floats round-trip as integers``,
  ``fractional floats are dropped``,
  ``fractional strings are dropped``,
  ``NaN and infinities are rejected``.
- TS: 178/178 tests pass; ``tsc --noEmit`` clean.

## 0.2.26 — 2026-07-09

Bug-fix + resilience release.

### Fixed
- `model_advisor.ModelAdvisor.post<T>` returned
  `null as T` on a 200 with an empty body (interrupted
  chunked response, missing ``Content-Type``, or a
  proxy that swallowed the reply). The caller's
  ``comparisonFromApi(null)`` then blew up later with a
  cryptic ``Cannot read property 'current' of null``
  with no mention of the network at all. Now the SDK
  throws a typed ``ModelAdvisorError(200, "empty
  response body", null)`` so the caller can surface a
  clear message and the rest of any retry / circuit-
  breaker logic can react.
- `trace.TraceController.recordError` (used by
  `trace()` and `@traceAgent`) crashed on non-`Error`
  throws. The previous code did
  ``err.constructor.name`` unconditionally, so throwing
  ``null``, ``undefined``, a plain object, or a
  primitive caused a ``TypeError`` in the cleanup
  path and the trace was emitted with no error
  context. Now the method handles every shape:
  `Error` (class + message), `null`, `undefined`,
  objects (via `JSON.stringify` with a circular-ref
  fallback to `Object.prototype.toString`), and
  primitives (`String(...)`).
- `client.EdenSDK` (the background flush + chunk
  timer): the three internal `setTimeout` handles
  (`bufferChunk` chunk timer, `scheduleFlush` flush
  timer, `_postChunksTracked` re-arm) were not
  unref'd. The Node.js event loop therefore held the
  process open until each timer's first firing, which
  in a short-lived script (e.g. a one-off benchmark,
  a serverless function that did a single
  `eden.shutdown()`) could keep the runtime alive
  for up to a full ``flushIntervalMs`` after the
  work was done. All three now call
  ``.unref()`` when available, mirroring the
  well-known Node.js pattern for background
  intervals. The behaviour is unchanged on Deno /
  Bun (where unref is a no-op).

### Tests
- 1 new test in `tests/model_advisor.test.ts`:
  `raises ModelAdvisorError on 200 with empty body`.
- 3 new tests in `tests/trace.test.ts`:
  `recordError handles null`, `recordError handles
  primitive`, `recordError handles circular object`.
- 2 new tests in `tests/client.test.ts`:
  `setTimeout handles are unref'd in
  scheduleFlush` and `_postChunksTracked` (pins the
  three unref sites by inspecting the active
  timer list).
- TS: 173/173 tests pass; `tsc --noEmit` clean.

## 0.2.25 — 2026-07-09

Bug-fix release.

### Fixed
- `trace.TraceController` (the `@traceAgent` / `trace()`
  path) used to emit ``eventType: "agent_call"`` on the
  wire. The gateway's promotion / cost-savings roll-ups
  query ``WHERE event_type = 'agent.run'``
  (``src/eden/llmops/promotion.py:161``), so the previous
  value silently dropped **every TS-traced agent run**
  from the cost-savings widgets and the monthly report
  emails. The Python SDK already emits
  ``event_type: "agent.run"``, so this was a wire-contract
  regression introduced in 0.2.18 (commit ``aaab8f63``).
  Now the TS SDK emits the canonical ``"agent.run"`` and
  the gateway filters match.

### Tests
- 1 new test in `tests/trace.test.ts`: end-to-end wire
  contract regression — runs a real `trace()` emit and
  pins that the wire body has exactly one event with
  ``event_type === "agent.run"`` and zero events with
  the old ``"agent_call"`` value.
- Updated 9 test assertions across `tests/trace.test.ts`,
  `tests/wire.test.ts`, `tests/edge.test.ts`, and
  `tests/client.test.ts` to assert against the new value.
- TS: 167/167 tests pass; `tsc --noEmit` clean.

## 0.2.24 — 2026-07-09

Bug-fix + resilience release.

### Fixed
- `client.EdenSDK.bufferChunk`: cap the chunk buffer at
  `maxChunkBuffer` (default 4096) entries and drop the
  oldest on overflow. The TS buffer had no upper bound
  (parallel to the Python bug fixed in 0.2.13); a
  runaway streaming producer pushing millions of small
  chunks would OOM the process before this. Mirrors the
  Python SDK's `_chunk_buffer_max` from 0.2.13 so both
  SDKs surface identical resilience guarantees on the
  same gateway-side rate-limit configuration.
- `client.TraceController` decorator path
  (`@traceAgent`): the wrapped method stored only
  `err.constructor.name` (just the class name) on
  `controller.error` when the underlying call threw.
  `finishTrace` splits `controller.error` on the first
  `": "` into `error_type` + `error_message`, so the TS
  decorator path was emitting `error_type: "TypeError"`
  with `error_message: null` for every decorator-thrown
  exception — silently dropping the human-readable
  error message that the portal surfaces in the trace
  detail view. The Python SDK's `@trace_agent` and the
  TS callback-form `trace()` both captured the full
  message. Now the decorator path uses
  `controller.recordError(err)` (the same helper the
  callback form uses) so the wire payload matches.

### Added
- `client.EdenSDKOptions.maxChunkBuffer` — new
  constructor option (default 4096). Tunable via
  `new EdenSDK({ maxChunkBuffer: N })`.

### Tests
- 3 new tests in `tests/client.test.ts` and
  `tests/trace.test.ts`:
  - `chunk buffer cap > drops oldest chunks when
    maxChunkBuffer is exceeded` (pins the buffer
    eviction end-to-end through `bufferChunk`).
  - `traceAgent() > captures the error MESSAGE (not
    just the class name) on sync throws` — regression
    pinning the sync throw path.
  - `traceAgent() > captures the error MESSAGE on async
    rejects (regression)` — same for async.
- 166/166 TS tests pass; `tsc --noEmit` clean.
- Python SDK unchanged this turn: 209/209 still pass.

## 0.2.23 — 2026-07-09

Bug-fix release.

### Fixed
- `client.EdenSDK.postJson`: parse the `Retry-After`
  response header per RFC 7231 — accept both the
  delta-seconds form (`"5"`) and the HTTP-date form
  (`"Wed, 21 Oct 2015 07:28:00 GMT"`). The previous
  implementation did `parseFloat(retryAfter) * 1000` and
  capped with `Number.isFinite`; on an HTTP-date
  `parseFloat` returns `NaN`, `Math.min(NaN, 30_000)` is
  `NaN`, `Number.isFinite(NaN)` is false — so the wait
  was skipped entirely and the retry happened immediately,
  hammering the server. The new ``parseRetryAfterMs``
  helper handles both forms; past HTTP-dates clamp to 0
  ("retry now"); far-future dates are capped at 30s to
  keep the worker responsive. Mirrors the Python SDK's
  `_parse_retry_after` from 0.2.13 so a single
  gateway-side retry policy drives both SDKs identically.
- `client.EdenSDK.dispose`: reorder the chunk-path
  teardown so the in-flight chunk POST is awaited
  BEFORE the ``chunkInflight`` flag is released. The
  previous order (set flag false → await promise) left
  a window where a concurrent ``flushChunks()`` could
  see the slot as free and produce a phantom POST with
  an empty body. Mirrors the batch-path handling that
  the previous fix already got right.

### Tests
- 7 new tests in `tests/client.test.ts`:
  - 5 unit tests for ``parseRetryAfterMs`` covering
    delta-seconds, future HTTP-date, past HTTP-date,
    garbage input, and the 30s cap.
  - 1 regression test pinning the HTTP-date retry path
    end-to-end on a 503 with an HTTP-date header.
  - 1 regression test mirroring the existing batch-path
    dispose() inflight test for the chunk path.
  - 163/163 TS tests pass; ``tsc --noEmit`` clean.

## 0.2.22 — 2026-07-09

Refactor release.

### Changed
- Extracted the per-instrumentation `randomId()` helper into
  a new shared module `src/ids.ts`. Each of the four
  instrumentations (OpenAI, Anthropic, Vercel AI, LangChain)
  previously carried its own copy of the same 6-line
  `Date.now().toString(36) + Math.random().toString(36)`
  function — a divergence hazard (a fix to one
  instrumentation's id shape would silently leave the
  others emitting a different id). The id shape on the wire
  is unchanged, so existing consumers (the gateway's
  per-event `trace_id` + `event_id` columns, the portal's
  URL fragments) keep working without any contract change.

### Tests
- 3 new tests in `ids.test.ts` pinning the shared helper
  (id length 8-24 chars, URL-safe base-36 characters,
  unique across 1000 calls).

## 0.2.21 — 2026-07-09

Bug-fix + parity release.

### Fixed
- `wrapLangChain` streaming: the per-chunk buffer was missing
  and the `_emitStream` call sites never passed `model`,
  `inputTokens`, `cacheReadTokens`, or `cacheCreationTokens`.
  The previous implementation only emitted the aggregate
  `llm_completion_stream` event with no model or input
  tokens on the wire, so the per-chunk TTFT / ITL / TPOT
  dashboards rendered empty for every LangChain stream and
  pricing lookups could not roll them up. The fix mirrors
  the OpenAI + Anthropic + Vercel AI streaming paths: every
  chunk is appended to a `chunkBuffer` and flushed via
  `client.bufferChunk(...)` on the same tick as the
  aggregate emit; the aggregate now carries the model +
  token-count fields extracted from the chunks' modern
  `usage_metadata` + `response_metadata` (with the legacy
  `usage` / `usage_kwargs` keys also accepted). The
  iterator's `return()` also flushes a partial chunk buffer
  so a caller that breaks out of a stream loop still ships
  the partial series.

### Tests
- 2 new tests in `instrumentations.test.ts` pinning the
  Vercel-OpenAI-style per-chunk emission (2 text-delta
  events → 2 chunk-buffer pushes; same `trace_id`,
  incrementing `chunk_index`) + the new `model` /
  `input_tokens` extraction on the aggregate event.
- 1 new test in `instrumentations.test.ts` pinning the
  partial-chunk-buffer flush on `iterator.return()`
  (breaking out of a stream after the first chunk still
  ships that chunk to `/ingest/chunks`).

## 0.2.20 — 2026-07-09

Bug-fix + parity release.

### Fixed
- `ModelAdvisor` constructor: did NOT read `apiKey`, `orgId` or
  `baseUrl` from the SDK config singleton, so a caller that did
  `configure({ orgId, apiKey })` and then `new ModelAdvisor()`
  ended up with an empty `Authorization` header and 401s on
  every call. The advisor now falls back to the SDK config for
  all three fields (mirrors `ModelAdvisor.__init__` in the
  Python SDK). An explicit `opts` value always wins — the
  explicit path is the documented escape hatch for customers
  running their own Eden instance.
- `wrapVercelAI` streaming: the per-chunk buffer was missing.
  Vercel AI streams were emitting only the aggregate
  `llm_completion_stream` event and never pushing individual
  chunks to `/ingest/chunks`, so the per-chunk TTFT / ITL /
  TPOT dashboards rendered empty for every Vercel AI stream.
  The OpenAI + Anthropic TS paths and the Python SDK all
  already do this; Vercel AI was the odd one out. The fix
  mirrors the OpenAI streaming path: every chunk is appended
  to a `chunkBuffer` and flushed via `client.bufferChunk(...)`
  on the same tick as the aggregate emit, with the same
  per-chunk TPOT arithmetic.
- `EdenSDK.dispose()` race: released the `inflight` flag
  unconditionally, then called `flush()` immediately. If a
  real flush was in flight at that moment, the second
  `flush()` grabbed the same slot and started a SECOND
  concurrent POST — racing the first one for the same batch.
  The dispose path now tracks the in-flight POST promise
  (mirroring the chunk-path handling) and awaits it before
  releasing the inflight slot, so the subsequent `flush()`
  sees an empty queue and returns.

### Tests
- 2 new tests in `model_advisor.test.ts` pinning the SDK
  config fallback (apiKey + orgId + baseUrl populated from
  the SDK config when not explicit; explicit `opts` always
  wins).
- 1 new test in `instrumentations.test.ts` pinning the
  Vercel AI per-chunk emission (2 text-delta events → 2
  chunk-buffer pushes; same `trace_id`, incrementing
  `chunk_index`).
- 1 new test in `client.test.ts` pinning the `dispose()`
  inflight race (a dispose() called while a POST is in
  flight must await the in-flight POST before its final
  flush, so only 1 POST ships for a single emit).

## 0.2.19 — 2026-07-09

Bug-fix + consistency release.

### Fixed
- `redactPayload` (PII redaction): two distinct keys that redact to
  the same value (e.g. `"alice@..."` and `"bob@..."` both becoming
  `"[REDACTED]"`) silently overwrote each other under the previous
  object-comprehension, dropping one entry on every payload that
  carried multiple PII keys. The redacted object now disambiguates
  by appending a numeric suffix on collision (`[REDACTED]`, then
  `[REDACTED]_2`, `[REDACTED]_3`, …) so per-user metrics keyed by
  email are no longer collapsed to a single entry. The
  disambiguator is a no-op for distinct redacted values, which
  is the common case.
- `ModelAdvisor.headers()`: the `User-Agent` was hardcoded to
  `"eden-sdk/typescript"` (no version), so version attribution for
  advisor traffic was permanently pinned to the literal string.
  Now uses the same `SDK_USER_AGENT` constant the telemetry
  client emits on every ingestion POST, so the advisor and the
  auto-instrumentation paths always report the same version.

### Tests
- 3 new tests in `filters.test.ts` pinning the new key-collision
  disambiguator (two- and three-way PII key collisions, plus a
  non-colliding passthrough).

## 0.2.18 — 2026-07-09

Bug-fix release.

### Fixed
- `wrapAnthropic` streaming: the per-chunk buffer was missing.
  Anthropic streams were emitting only the aggregate
  `llm_completion_stream` event and never pushing individual
  events to `/ingest/chunks`, so the per-chunk TTFT / ITL /
  TPOT dashboards rendered empty for every Anthropic stream.
  The Python SDK and the TS OpenAI path both already do this;
  TS Anthropic was the odd one out. Mirrors Python: every
  event is appended to a `chunkBuffer` and flushed via
  `client.bufferChunk(...)` on the same tick as the aggregate
  emit. Per-chunk TPOT mirrors the OpenAI semantics
  (inter-chunk interval divided by `ceil(len/4)`, `null` for
  non-text events).

### Tests
- 1 new test in `instrumentations.test.ts` pinning the
  Anthropic streaming chunk path: 4 streamed events →
  4 chunk-buffer pushes; `delta_text` set on the two
  `content_block_delta`s and `null` on the `message_start` /
  `message_delta`s; chunks share a single `trace_id` and
  have incrementing `chunk_index` from 0.

## 0.2.17 — 2026-07-09

Bug-fix release.

- `flushChunks()` rewrite: callers can now rely on
  `await flushChunks()` to mean "every chunk buffered up to
  this point has been POSTed". The previous implementation
  returned early when an in-flight POST was already running,
  leaving 3-of-4 chunks stranded in the buffer for the next
  timer tick — observable as a stream of single-chunk POSTs
  followed by a single N-chunk POST well after the test
  asserted on them. Now flushChunks loops, awaiting the
  in-flight POST and draining any chunks that arrived during
  it before returning.

## 0.2.16 — 2026-07-09

Bug-fix release.

- `normalizeModelName`: fix ordering so `claude-sonnet-4-5-20250929-latest`
  no longer leaves the date stamp stranded in the output (compound
  `-DATE-latest` regex now strips both suffixes together).
- User-Agent header: was hardcoded to `@eden-ai/sdk/0.1.0` and
  silently drifted across many patch releases. Now pulled from
  `package.json` via a `version.ts` constant exported as
  `SDK_NAME` / `SDK_VERSION` / `SDK_USER_AGENT`.
- Anthropic non-streaming instrumentation: extract `usage` from
  the response and populate `metrics.input_tokens` /
  `output_tokens` / `cache_read_input_tokens` /
  `cache_creation_input_tokens`, and set `modelNormalized`. Mirrors
  the OpenAI fix shipped in 0.2.14.
- `wrapAnthropic`: bind the proxied `messages.create` to the
  `messages` resource object instead of the top-level client.
  The Anthropic SDK internally calls `this._client.post(...)`,
  so `this` must be the resource or wrapped-client internals
  break. Mirrors the OpenAI fix shipped in 0.2.13.
- `trace()`: pop `_activeContextStack` in
  `TraceController.end()`. The push was never paired, so the
  stack grew unboundedly across the process lifetime and the
  wrong (dead) span kept being returned as the new parent.
- `flushChunks()` / `bufferChunk`: atomic inflight claim
  (mirrors `flush()`). Concurrent `flushChunks()` calls could
  otherwise both grab the same buffer and double-POST chunks.

## [0.2.14] — 2026-07-08

### Fixed
- `wrapOpenAI()` non-streaming path was emitting events with only
  `metrics.duration_ms` populated — `usage` from the upstream
  response was discarded. Now `input_tokens`, `output_tokens`,
  `cache_read_input_tokens`, and `cache_creation_input_tokens`
  flow through the same normalized metrics block as the streaming
  path, so `non_streaming` and `streaming` calls produce
  identical billing fields. `modelNormalized` is also populated on
  non-streaming events so pricing lookups stay consistent.

## [0.2.13] — 2026-07-08

### Fixed
- `wrapOpenAI()` proxy: the OpenAI SDK's `completions.create` was
  being invoked with `this` bound to the top-level client instead
  of the `completions` resource. The SDK internally calls
  `this._client.post(...)`, so the wrong `this` triggered a
  `TypeError: Cannot read properties of undefined (reading 'post')`
  on every chat-completion call. The original `create` is now
  bound to the resource before being wrapped, restoring
  non-streaming and streaming chat calls end-to-end. Verified
  against `openai@6.45.0` from npm.
- `flush()` race regression: a flaky test surfaced when the test
  runner had background timers from prior tests. Test now uses a
  deferred mock-fetch that only resolves on `release()`, so it
  asserts only the in-flight claim, not timer-induced timing
  variation.

## [0.2.12] — 2026-07-08

### Fixed
- `detectInstalledFrameworks()` ESM detection: the 0.2.11 fix used
  `createRequire` against the SDK's own module URL, which still
  resolves to a broken `require` in some pure-ESM contexts.
  Replaced with `process.getBuiltinModule("module")`, which is
  available in all Node runtimes (>= 18.19) and always returns a
  working `require`. Confirmed against `openai@6.45.0` from npm.

## [0.2.11] — 2026-07-08

### Fixed
- `detectInstalledFrameworks()` (and its `autoInstrument()` alias)
  now returns the correct values when the SDK is consumed from
  pure-ESM files (`"type": "module"` or `.mjs`). The previous
  implementation used bare `require(...)` which is `undefined`
  in ESM, so every framework was reported as "not installed" and
  no instrumentation was installed.
- `flush()` race: when two callers invoke `flush()` concurrently
  with events in the queue, both could pass the `inflight` check
  and POST separately, doubling the load on the gateway. The
  in-flight slot is now claimed atomically (set + check in a
  single statement) before the queue length is tested.

## [0.2.10] — 2026-07-08

## [0.2.9] — 2026-07-08

    * `metrics.input_tokens`, `metrics.output_tokens`
    * `metrics.cache_read_input_tokens`,
      `metrics.cache_creation_input_tokens`
    * `modelNormalized` — strips dated suffixes
      (`gpt-4o-2024-08-06` → `gpt-4o`,
      `claude-3-5-sonnet-20241022` → `claude-3-5-sonnet`) and the
      `-latest` alias so pricing lookups hit a single row.
- `TelemetryEvent.modelNormalized?: string` field on the SDK's
  public TelemetryEvent shape.
- Startup warning when `apiKey` is missing on a non-debug
  configuration so the operator notices before the first failed
  ingest.

### Changed
- OpenAI streaming path now captures `input_tokens` (it was only
  capturing `output_tokens` before) plus
  `cache_read_input_tokens` / `cache_creation_input_tokens` from
  the chunk's `usage` block.
- Anthropic streaming path now extracts cache tokens from both
  `message_start` (cache_read_input_tokens,
  cache_creation_input_tokens) and `message_delta`
  (cache_read_input_tokens for incremental updates).
- LangChain streaming emit surfaces `input_tokens` /
  `cache_read_input_tokens` / `cache_creation_input_tokens` and
  `modelNormalized` on the TelemetryEvent.

### Tests
- 13 new tests in `tokens.test.ts` for `extractUsage()` and
  `normalizeModelName()` (anthropic flat dict, OpenAI camelCase
  aliases, nested `cached_tokens`, null / partial / bool /
  string-coerced / unknown-shape inputs, dated + `-latest`
  suffix stripping).
- Existing 108 tests still pass.

## [0.2.0] — 2026-07-08

### Added
- New context-manager form of `trace()`: instead of (or in addition
  to) the legacy `await trace("name", async (ctx) => ...)`
  callback, you can now `import { TraceController } from
  "@eden-ai/sdk"` and build the span imperatively with
  `setInput`, `setOutput`, `setTag`, `setStatus`, `recordError`,
  and `end`. The legacy callback form remains fully supported.
- Retry with exponential backoff for transient gateway failures
  in `EdenSDK.postJson`. Honours the `Retry-After` response header
  (capped at 30 s). 3 attempts total; 4xx other than 408/429 are
  treated as permanent and are not retried.
- Free-function `configure(opts)` exported from the main entry
  point, mirroring `eden.configure(...)` in the Python SDK.
- One-shot `chatCompletion(sdk, opts)` helper in
  `gateway_session.ts` for simple OpenAI-compatible calls.
- New resolved-config fields: `maxQueueSize`, `timeoutS`,
  `disabled`. Parity with the Python SDK.

### Changed
- Default `maxQueueSize` is now 4096 (matches the Python SDK).
  When the in-memory queue exceeds this, the oldest event is
  dropped to prevent unbounded growth in long-lived processes.

## [0.1.0] — 2026-06-19

- Initial public release.

## [0.2.1] — 2026-07-08

### Added
- **Client-side PII safety net.** `redactPayload()` (exported from
  `@eden-ai/sdk/filters`) masks obvious emails, US phone numbers,
  US SSNs, and credit-card numbers in every outgoing payload. The
  pass is enabled by default via the `redactOnClient` flag
  (`new EdenSDK({ redactOnClient: false })` to disable). The
  gateway remains the authoritative redaction layer; this is a
  belt-and-suspenders safety net.

## [0.2.2] — 2026-07-08

### Fixed
- `redactPayload` is now re-exported from the main entry point
  (`@eden-ai/sdk`) so callers don't have to deep-import from
  `@eden-ai/sdk/filters`.

## [0.2.3] — 2026-07-08

### Fixed
- The client-side `redactPayload` PII safety net no longer
  false-positives on pure-digit numeric IDs (10-11 char strings
  like timestamps and order numbers). The phone regex now
  requires an actual phone format (parentheses, hyphens, dots,
  or spaces between the 3-3-4 groups) before flagging a match.
- The credit-card regex now runs the candidate through a Luhn
  checksum before redacting. 13-19 digit runs that fail Luhn
  (timestamps, hashes, system IDs) are no longer touched.

## [0.2.4] — 2026-07-08

### Added
- `examples/auto-detect.ts` — uses `autoInstrument()` to detect
  installed LLM SDKs and dynamically wrap the ones that are
  importable.
- 4 new integration tests in `tests/filters.test.ts` exercise
  the redactor against realistic OpenAI / Anthropic response
  shapes and assert that PII is masked while structure is
  preserved.

## [0.2.3] — 2026-07-08

### Fixed
- The client-side `redactPayload` PII safety net no longer
  false-positives on pure-digit numeric IDs. The phone regex
  now requires an actual phone format before flagging a match.
- The credit-card regex now runs the candidate through a Luhn
  checksum before redacting.

## [0.2.5] — 2026-07-08

### Fixed
- The client-side `redactPayload` PII safety net now also
  redacts string keys in objects. Some upstream LLM SDKs stash
  identifiers in keys; without this, an email-keyed object
  would leak through unmasked.

## [0.2.4] — 2026-07-08

### Added
- `examples/auto-detect.ts` — uses `autoInstrument()` to detect
  installed LLM SDKs and dynamically wrap the ones that are
  importable.
- 4 new integration tests in `tests/filters.test.ts` exercise
  the redactor against realistic OpenAI / Anthropic response
  shapes and assert that PII is masked while structure is
  preserved.

## [0.2.3] — 2026-07-08

### Fixed
- The client-side `redactPayload` PII safety net no longer
  false-positives on pure-digit numeric IDs. Phone now requires
  an actual phone format; CC runs the candidate through Luhn.

## [0.2.6] — 2026-07-08

### Added
- 3 new tests in `tests/client.test.ts` cover the new config
  fields: `redactOnClient` defaults to `true` and is overridable
  via the constructor; `EdenSDK.configure()` merges new opts over
  existing config (and can flip `redactOnClient` at runtime).

## [0.2.7] — 2026-07-08

### Fixed
- The streaming `/ingest/chunks` path now applies the client-side
  PII safety net to every chunk's `deltaText` before it leaves
  the process. Without this, model-echoed PII (an email the
  user put in the prompt that the model then repeated in its
  reply) would leak to the gateway unmasked via the streaming
  route.
- `redactString` is now exported from `@eden-ai/sdk` so callers
  can redact a single string outside of the payload path
  (e.g. for log scrubbing).
- 2 new tests in `tests/client.test.ts` cover the chunk
  redaction: PII is masked when `redactOnClient=true` (default)
  and `deltaText` passes through unchanged when
  `redactOnClient=false`.

## [0.2.6] — 2026-07-08

### Added
- 3 new tests in `tests/client.test.ts` cover the new config
  fields: `redactOnClient` defaults to `true` and is overridable
  via the constructor; `EdenSDK.configure()` merges new opts over
  existing config (and can flip `redactOnClient` at runtime).

## [0.2.8] — 2026-07-08

### Fixed
- DTS build error in 0.2.7 caused by passing `c.deltaText`
  (which is `string | null | undefined` in the wire type)
  directly to `redactString` (which expects `string`). The
  chunk redaction now falls back to empty string when
  `deltaText` is null/undefined, so the DTS build succeeds
  and the wire contract is preserved (an empty `deltaText`
  is a valid streaming-payload value).
