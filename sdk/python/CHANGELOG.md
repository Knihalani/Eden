# Changelog — eden-sdk (Python)

All notable changes to the Eden Python SDK are documented here. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## 0.2.15 — 2026-07-09

No SDK changes; this release bumps the version to track
the parallel TypeScript SDK release (0.2.24). The TS SDK
fixes two issues the Python SDK already had parity on:

* `bufferChunk` chunk-buffer cap (parallel to 0.2.13's
  ``_chunk_buffer_max``) — TS now caps at
  ``maxChunkBuffer`` (default 4096) and drops oldest on
  overflow, matching the Python SDK's behavior.
* `@traceAgent` error-message capture — TS now uses
  ``controller.recordError(err)`` so the wire payload's
  ``error_message`` is populated, matching the Python
  SDK's ``@trace_agent``.

209/209 Python tests still pass; mypy unchanged.

## 0.2.14 — 2026-07-09

Refactor + bug-fix release.

### Fixed
- `instrumentations.autogen`: a redundant ternary in the
  `_reply_hook` did
  `_trace_id_or_random() if current_trace() else uuid.uuid4().hex`.
  The helper already returns the active trace id when one is
  present and a fresh ``uuid4().hex`` otherwise — the inline
  condition was a no-op that just made the code harder to
  read. Now just `_trace_id_or_random()`.

### Changed
- New shared module ``eden_sdk._instrumentation_ids`` with
  `_trace_id_or_random` and `_get_attr`. Previously, six
  per-framework instrumentations (``openai``, ``anthropic``,
  ``langchain``, ``crewai``, ``autogen``, ``llama_index``)
  each carried their own byte-identical copy of
  `_trace_id_or_random`, and two of them (OpenAI + Anthropic)
  also had their own copy of `_get_attr`. Duplicated code is
  a divergence hazard: a fix to one copy would silently
  leave the others emitting a different ``trace_id`` on the
  wire. Mirrors the TypeScript SDK's ``sdk/ts-ai/src/ids.ts``
  shared module. Wire shape is unchanged.

### Tests
- 5 new tests in `test_instrumentation_ids.py` pin the wire
  shape (``uuid4().hex`` 32 lowercase hex chars), the
  active-context short-circuit, and ``_get_attr``'s None /
  dict / object shapes. 209/209 Python tests pass.

## 0.2.13 — 2026-07-09

Bug-fix + resilience release.

### Fixed
- `client.EdenClient._run_loop`: wrap `asyncio.run(self._async_loop())`
  in a `try`/`except` so a failure in `httpx.AsyncClient(...)`
  construction (invalid transport, bad timeout, anything that
  raises before `_loop_started.set()`) is logged at WARNING and
  surfaces via a new `_loop_failed` latch. Without this, the
  worker thread died silently, `start()` returned normally after
  timing out on `_loop_started.wait(...)`, and every subsequent
  `enqueue()` landed in a queue nothing drained — events
  silently disappeared. `start()` now raises `RuntimeError` when
  the latch reports a failed start, so the caller can react.
- `client.EdenClient._send_batch`: parse the `Retry-After`
  response header per RFC 7231 — accepts both the
  delta-seconds form (`"5"`) and the HTTP-date form
  (`"Wed, 21 Oct 2015 07:28:00 GMT"`). The previous
  implementation did `float(retry_after)`, which raised
  `ValueError` on HTTP-date and silently fell back to
  exponential backoff, ignoring the gateway's explicit hint.
  Past HTTP-dates clamp to 0 ("retry now"); far-future dates
  are capped at 30s to keep the worker responsive.

### Added
- `client.EdenClient._enqueue_chunk`: producer-side helper that
  pushes a streaming chunk with oldest-drop overflow
  semantics, mirroring `enqueue()` for the regular event
  queue. Existing instrumentations still append directly to
  `self._chunk_buffer` (the cap is also enforced defensively
  at flush time).
- `client.EdenClient._chunk_buffer_max`: hard cap on the
  streaming chunk buffer (4096 entries by default). A
  runaway streaming response (millions of small chunks
  between worker ticks) could OOM the process before this —
  now oldest chunks are dropped with a warning on overflow,
  both at enqueue time and at flush time.

### Tests
- 5 new tests in `test_client.py`:
  - `test_start_raises_runtime_error_when_async_client_init_fails`
    monkeypatches `httpx.AsyncClient` to raise during
    construction and asserts `start()` now raises
    `RuntimeError` (and the failure latch is flipped).
  - 3 × `_parse_retry_after` tests cover delta-seconds,
    future HTTP-date, past HTTP-date, and garbage input.
  - `test_send_batch_retries_after_http_date_retry_after`
    pins the end-to-end retry path with an HTTP-date header.
  - 2 chunk-buffer tests pin the cap on `_enqueue_chunk` and
    the defensive trim inside `_send_chunks` so
    instrumentations that bypass the helper are also bounded.

## 0.2.12 — 2026-07-09

Bug-fix + parity release.

### Fixed
- `instrumentations.langchain._safe_llm_response`: walk the
  ``LLMResult.generations`` and extract ``usage_metadata`` +
  per-generation ``response_metadata`` from each
  ``AIMessage``. Modern LangChain (0.1+) does NOT carry usage
  in ``LLMResult.llm_output.token_usage`` (that field is
  empty for modern chains), so the previous implementation
  had no ``input_tokens`` /
  ``cache_read_input_tokens`` /
  ``cache_creation_input_tokens`` / ``model`` on the wire for
  every non-streaming modern LangChain call — pricing
  roll-ups missed every modern chain. The new path uses
  ``setdefault`` semantics so the legacy path (which wins on
  older LangChain versions where ``llm_output`` IS populated)
  is not clobbered.

### Tests
- 2 new tests in `test_instrumentations.py` pinning the
  modern + legacy paths (modern path surfaces
  ``input_tokens`` / ``output_tokens`` / ``model`` from
  ``usage_metadata`` + per-generation ``response_metadata``;
  legacy path still wins when both are populated).

## 0.2.11 — 2026-07-09

Bug-fix + parity release.

### Fixed
- `instrumentations.langchain`: implemented
  `on_llm_new_token` callback to push per-token chunks to
  `client._chunk_buffer` (parity with the OpenAI + Anthropic
  streaming instrumentations). The previous implementation
  never read this callback, so streaming LangChain calls
  emitted only the aggregate framework event and the
  per-chunk TTFT / ITL / TPOT dashboards rendered empty
  for every LangChain stream.
- `instrumentations.langchain`: extract `usage_metadata` and
  `response_metadata` from the per-chunk `AIMessageChunk` (the
  `chunk` kwarg on `on_llm_new_token`) so `input_tokens`,
  `cache_read_input_tokens`, `cache_creation_input_tokens`,
  and `model` are surfaced on the wire. The aggregate
  framework event now carries these fields. The streaming
  state is hoisted onto the framework event in `on_llm_end`
  (and cleared in `on_llm_error` so a mid-flight error does
  not leak the per-run dict).
- `instrumentations.langchain`: `_record_end`'s hoist list
  now also promotes `model` to the top-level framework
  event. Previously the payload dict had both `model` and
  `model_normalized` (from `_safe_llm_response`'s
  `response_metadata` walk) but the top-level event only
  carried `model_normalized`. Callers reading the raw
  provider model id off the framework event were always
  seeing `None`.

### Tests
- 3 new tests in `test_instrumentations.py` pinning the
  new `on_llm_new_token` callback (per-chunk push to
  `client._chunk_buffer`; same `trace_id` family +
  incrementing `chunk_index`; non-null ITL/TPOT after the
  first chunk; the framework event carries the model +
  input_tokens the streaming state captured; state cleanup
  on `on_llm_error` so a mid-flight error does not leak
  the per-run dict).

## 0.2.10 — 2026-07-09

Bug-fix + consistency release.

### Fixed
- `model_advisor.ModelAdvisor._headers()`: the `User-Agent`
  was hardcoded to `"eden-sdk/python"` (no version), so
  version attribution for advisor traffic was permanently
  pinned to a literal. The advisor now reuses the same
  `_USER_AGENT` constant the telemetry client emits on every
  ingestion POST (`"eden-sdk/<version> (python)"`), so the
  advisor and the auto-instrumentation paths always report
  the same version.

### Tests
- 1 new test in `test_model_advisor.py` pinning the
  `User-Agent` to the SDK-versioned constant (parity with
  the client).

## 0.2.9 — 2026-07-09

Bug-fix + parity release.

### Fixed
- `_redact_value` (PII redaction): two distinct keys that redact to
  the same value (e.g. `"alice@..."` and `"bob@..."` both becoming
  `"[REDACTED]"`) silently overwrote each other under the previous
  dict-comprehension, dropping one entry on every payload that
  carried multiple PII keys. The redacted dict now disambiguates
  by appending a numeric suffix on collision (`[REDACTED]`, then
  `[REDACTED]_2`, `[REDACTED]_3`, …) so per-user metrics keyed by
  email are no longer collapsed to a single entry. The
  disambiguator is a no-op for distinct redacted values, which
  is the common case.
- `EdenClient.start()` after `shutdown()` returned immediately
  because the `_loop_started` latch was never reset. The first
  `enqueue()` after the second `start()` raced against an
  in-flight `httpx.AsyncClient` that was about to be re-created
  on the new loop. `start()` now clears the latch before
  spawning the new sender thread, so the second `start()`
  blocks until the new loop is actually up and the new
  AsyncClient is ready to accept traffic.
- `extract_usage` (cache-read tokens): only the nested OpenAI
  `prompt_tokens_details.cached_tokens` path was recognised.
  Some OpenAI-compatible gateways (and older OpenAI SDK
  responses) expose the same value as a top-level
  `cached_tokens` / `cachedTokens` field, or as the camelCase
  `promptTokensDetails.cached_tokens`. The Python SDK now
  accepts all four shapes — bringing it to parity with the
  TypeScript SDK, which has always accepted them.
- `wrapAnthropic` streaming: the `message_start` handler only
  inspected `event.message` when it was a `dict`. Modern
  Anthropic SDKs (1.x) hand back a Pydantic model object, so the
  model name and `input_tokens` were silently dropped on every
  Anthropic stream. The handler now uses `_get_attr`, which
  dispatches on the actual shape; both sync and async
  instrumentations are fixed.

### Tests
- 4 new tests in `test_filters.py` pinning the new key-collision
  disambiguator (two- and three-way PII key collisions, plus
  non-colliding and non-string-key passthrough).
- 1 new test in `test_client.py` pinning the start-shutdown-start
  latch reset (the second `start()` must wait for the new loop
  to come up before the first post-`shutdown()` `enqueue()` is
  accepted).
- 3 new tests in `test_tokens.py` pinning the four accepted
  cache-read token shapes (top-level snake and camel, plus the
  camel `promptTokensDetails` wrapper).

## 0.2.8 — 2026-07-09

Bug-fix + observability release.

### Fixed
- `@trace_agent` decorator: stop writing `eden.tags` as a
  comma-joined string. The emitter did
  `["eden-sdk", "framework", *extra_tags]`; when `extra_tags`
  was a string the `*` spread it into per-character entries
  on the wire (e.g. `['e','n','v',':','p','r','o','d',',',...]`
  for `tags=["env:prod"]`). Decorator now writes a list and
  the emitter coerces legacy string attributes defensively.
  `Span.set_tag()` similarly tolerates pre-existing string or
  list attributes instead of `list(...)` on the raw value.
- `_from_env`: introduce `EDEN_DRY_RUN` as the canonical env
  var for opt-in dry-run mode. `EDEN_DEBUG` is preserved as a
  back-compat alias (the older README documented it). When
  both are set, `EDEN_DRY_RUN` wins — a user that explicitly
  sets `EDEN_DRY_RUN=0` does not have their intent
  overridden by a stale `EDEN_DEBUG=1`.
- `Span.set_status("ok", error="boom")` previously wrote
  `eden.status = "success"` BEFORE the error override, so
  the public `eden.status` field said `"success"` while
  `outcome` was `"error"`. The two fields now agree.
- `_coerce_int` rejected all floats; a JSON-decoded
  `{"prompt_tokens": 1.0}` was dropped on the floor.
  Accepts whole-number floats (`1.0` → `1`) and float
  strings (`"1.0"` → `1`); rejects NaN, infinity, and
  fractional floats (`0.7`) so a partial-token count is
  never silently rounded down to 0 and under-billed.

### Added
- `User-Agent: eden-sdk/<version> (python)` header on every
  ingestion POST (regular batch + `/ingest/chunks`). The
  Python SDK was shipping without a User-Agent — version
  drift across the fleet was invisible. The TS SDK already
  ships one via `SDK_USER_AGENT`; this brings Python to
  parity.

### Tests
- 6 new tests in `test_trace.py` pinning the tag-list wire
  contract (decorator sync + async emit a list, `set_tag`
  handles string / list / missing attribute without
  per-character spread) + the `set_status` /
  `eden.status` field agreement.
- 3 new tests in `test_config.py` pinning the
  `EDEN_DRY_RUN` / `EDEN_DEBUG` precedence rules.
- 2 new tests in `test_client.py` pinning the new
  `User-Agent` header on the batch and chunk ingest paths.
- 6 new tests in `test_tokens.py` pinning the new
  whole-number float / float-string acceptance and the
  NaN / infinity / fractional rejection.

## 0.2.7 — 2026-07-09

Bug-fix release.

- `normalize_model_name`: fix ordering so `claude-sonnet-4-5-20250929-latest`
  no longer leaves the date stamp stranded in the output (the bare
  `-latest` strip used to run AFTER the date regexes, which never
  matched `-YYYYMMDD-latest`). Now matches `-DATE-latest` as a
  single compound suffix.
- Client retry list now treats `408 Request Timeout` as retryable
  (was previously failing fast alongside the other non-5xx 4xx).

## [0.2.6] — 2026-07-08

### Added
- New `eden_sdk._tokens` module: shared `extract_usage()` and
  `normalize_model_name()` helpers used by every instrumentation.
  Both providers (Anthropic, OpenAI) and every framework adapter
  (LangChain, LlamaIndex, CrewAI, AutoGen, Vercel AI) now emit
  the same field names on the wire:
    * `input_tokens`, `output_tokens`
    * `cache_read_input_tokens`, `cache_creation_input_tokens`
    * `model_normalized` — strips dated suffixes
      (`gpt-4o-2024-08-06` → `gpt-4o`,
      `claude-3-5-sonnet-20241022` → `claude-3-5-sonnet`) and the
      `-latest` alias (`claude-3-5-sonnet-latest` →
      `claude-3-5-sonnet`) so pricing lookups hit a single row.
- `EdenConfig.validate()`: raises `ValueError` if `org_id` is
  unset on a non-`disabled`, non-`dry_run` config. Wired into
  `configure()` so misconfigured startup fails loudly instead of
  silently dropping events for the lifetime of the process.
  Logs a warning when `api_key` is missing on a shipping config.

### Changed
- OpenAI + Anthropic streaming paths now capture the
  `cache_read_input_tokens` / `cache_creation_input_tokens` fields
  when the provider returns them. Cache pricing is significant on
  Anthropic (90% discount on cache reads) so the SDK now hands
  the signal to the server instead of silently dropping it.
- LangChain instrumentation promotes `token_usage.input_tokens` /
  `token_usage.output_tokens` to the top-level event payload
  (instead of nesting under `attributes.langchain.payload.*`).
  Adds `model_normalized` so the pricing lookup matches what the
  server-side normalizer does for OpenAI/Anthropic payloads.
- `_send_batch` no longer crashes with `UnboundLocalError` if
  `ingest_url()` raises (e.g. `org_id` not configured). The
  `count` local is initialized at the top of the group loop so
  the outermost `except` can always increment the failure
  counter safely.

### Tests
- 14 new tests in `test_tokens.py` for `extract_usage()` and
  `normalize_model_name()` (Anthropic flat dict, OpenAI pydantic
  with nested `cached_tokens`, camelCase aliases, null / partial /
  bool / string-coerced / unknown-shape inputs, dated + `-latest`
  suffix stripping).
- 6 new tests in `test_config.py` for `EdenConfig.validate()`
  (raises without `org_id`, no-ops when disabled / dry_run,
  passes when configured, warns without `api_key`, propagates
  through `configure()`).
- Existing 133 tests still pass.

## [0.2.0] — 2026-07-08

### Added
- New `Span` API for tracing: `set_input()`, `set_output()`,
  `set_tag()`, `set_status()` are now first-class methods on the
  `Span` yielded by `trace()`. Input, output, status, and tags are
  hoisted to top-level fields on the emitted trace payload (in
  addition to being mirrored into the legacy nested shape).
- Retry with exponential backoff for transient gateway failures
  in `EdenClient._send_batch`. Honours the `Retry-After` response
  header (capped at 30 s). 3 attempts total; 4xx other than
  408/429 are treated as permanent and are not retried.
- New tests for the Span API and retry behaviour (10 in
  `test_trace.py`, 12 in `test_client.py`).

### Changed
- `eden.instrument("mastra")` now emits a `WARNING` (instead of
  silently logging at `DEBUG`) when called on the Python SDK, which
  has no Mastra integration. The TS SDK is the supported path.

## [0.1.0] — 2026-06-19

- Initial public release.

## [0.2.1] — 2026-07-08

### Added
- **Client-side PII safety net.** `redact_payload()` is exported
  from both `eden_sdk.filters` and the top-level `eden` namespace.
  A small regex pass masks obvious emails, US phone numbers,
  US SSNs, and credit-card numbers in every outgoing payload.
  Enabled by default via `EdenConfig(redact_on_client=True)`;
  set to `False` when the gateway is your trusted redaction
  point. The gateway remains the authoritative redaction layer.

### Added
- `eden.autoInstrument()` / `eden.detect_installed_frameworks()` —
  mirror the TypeScript SDK's detection helpers. Reports all
  seven supported framework keys (openai, anthropic, langchain,
  llama_index, crewai, autogen, mastra) with `True`/`False`
  values for whether each is importable.

### Added
- `examples/05_crewai.py`, `examples/06_autogen.py`,
  `examples/07_llamaindex.py` — mirror the existing
  `02_langchain.py` shape and exercise the corresponding
  auto-instrumentation.

### Fixed
- `eden.instrument("mastra")` now logs at WARNING (was DEBUG)
  to make the no-op visible to operators.

## [0.2.2] — 2026-07-08

### Fixed
- The client-side `redact_payload` PII safety net no longer
  false-positives on pure-digit numeric IDs (10-11 char strings
  like timestamps and order numbers). The phone regex now
  requires an actual phone format (parentheses, hyphens, dots,
  or spaces between the 3-3-4 groups) before flagging a match.
- The credit-card regex now runs the candidate through a Luhn
  checksum before redacting. 13-19 digit runs that fail Luhn
  (timestamps, hashes, system IDs) are no longer touched.
- `redact_payload` is now exported from the top-level `eden`
  namespace as well as `eden_sdk.filters`, matching the
  TypeScript SDK's public surface.

## [0.2.1] — 2026-07-08

### Added
- Client-side PII safety net. `redact_payload()` masks obvious
  emails, US phone numbers, US SSNs, and credit-card numbers
  in every outgoing payload.  Enabled by default via
  `EdenConfig(redact_on_client=True)`.  The gateway remains the
  authoritative redaction layer.
- `eden.autoInstrument()` and `eden.detect_installed_frameworks()`
  for detection parity with the TypeScript SDK. Reports all
  seven supported framework keys.
- `examples/05_crewai.py`, `06_autogen.py`, `07_llamaindex.py`.

### Fixed
- `eden.instrument("mastra")` now logs at WARNING (was DEBUG).

## [0.2.3] — 2026-07-08

### Added
- `examples/08_auto_detect.py` — uses `detect_installed_frameworks`
  to selectively instrument whichever LLM SDKs are importable.
- 4 new integration tests in `test_filters.py` exercise the
  redactor against realistic OpenAI / Anthropic response shapes
  (id, model, usage block, deeply-nested choices.content) and
  assert that PII is masked while structure and token counts
  are preserved.

## [0.2.2] — 2026-07-08

### Fixed
- The client-side `redact_payload` PII safety net no longer
  false-positives on pure-digit numeric IDs (10-11 char strings
  like timestamps and order numbers). The phone regex now
  requires an actual phone format (parentheses, hyphens, dots,
  or spaces between the 3-3-4 groups) before flagging a match.
- The credit-card regex now runs the candidate through a Luhn
  checksum before redacting. 13-19 digit runs that fail Luhn
  (timestamps, hashes, system IDs) are no longer touched.
- `redact_payload` is now exported from the top-level `eden`
  namespace as well as `eden_sdk.filters`.

## [0.2.4] — 2026-07-08

### Fixed
- The client-side `redact_payload` PII safety net now also
  redacts string keys in dicts. Some upstream LLM SDKs (and
  application code) stash identifiers in dict keys; without
  this, an email-keyed dict would leak through unmasked.
- `eden.redact_payload` is now re-exported from the canonical
  `eden_sdk` package as well as the `eden` shim and
  `eden_sdk.filters`.
- `__version__` is now in the `__all__` list of `eden_sdk` for
  consistency with the `eden` shim.
- New `scripts/redactor_smoke.py` exercises the redactor
  against 14 curated inputs (PII + non-PII false-positive
  cases) and exits 1 on any regression.

## [0.2.3] — 2026-07-08

### Added
- `examples/08_auto_detect.py` — uses `detect_installed_frameworks`
  to selectively instrument whichever LLM SDKs are importable.
- 4 new integration tests in `test_filters.py` exercise the
  redactor against realistic OpenAI / Anthropic response shapes
  and assert that PII is masked while structure and token counts
  are preserved.

## [0.2.2] — 2026-07-08

### Fixed
- The client-side `redact_payload` PII safety net no longer
  false-positives on pure-digit numeric IDs. Phone now requires
  an actual phone format; CC runs the candidate through Luhn.
- `redact_payload` is now exported from the top-level `eden`
  namespace as well as `eden_sdk.filters`.

## [0.2.5] — 2026-07-08

### Added
- 3 new tests in `test_config.py` cover the `redact_on_client`
  config flag: default is `True`, can be disabled via
  `configure(redact_on_client=False)`, and is incrementally
  updatable across multiple `configure()` calls.

## [0.2.6] — 2026-07-08

### Fixed
- The streaming `/ingest/chunks` path now applies the client-side
  PII safety net to every chunk's `delta_text` before it leaves
  the process. Without this, model-echoed PII (an email the
  user put in the prompt that the model then repeated in its
  reply) would leak to the gateway unmasked via the streaming
  route, bypassing the batched redaction in `_send_batch`.
- 2 new tests in `test_client.py` cover the chunk redaction:
  PII is masked when `redact_on_client=True` (default) and
  `delta_text` passes through unchanged when
  `redact_on_client=False`.

## [0.2.5] — 2026-07-08

### Added
- 3 new tests in `test_config.py` cover the `redact_on_client`
  config flag: default is `True`, can be disabled via
  `configure(redact_on_client=False)`, and is incrementally
  updatable across multiple `configure()` calls.
