# Changelog — @eden-ai/sdk (TypeScript)

All notable changes to the Eden TypeScript SDK are documented here. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

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
