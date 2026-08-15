---
title: "43 — TypeScript SDK + framework integrations (Phase G)"
status: IMPLEMENTED v1
last_updated: 2026-06-17
version: 1.0
---

# 43 — TypeScript SDK + framework integrations (Phase G)

> **Status:** ✅ **IMPLEMENTED v1** (shipped 2026-06-17).
> Closes the Laminar / RagaAI "TS SDK" gap. Ships
> ``eden-sdk`` — a zero-dependency, pure-TypeScript client
> with one namespace per resource, an in-memory queue +
> batched sender with exponential-backoff retries, plus
> auto-instrumentation for OpenAI. Anthropic / Vercel AI
> SDK / LangChain / Browser Use / Playwright follow in
> Phase G.5.

## Goal & motivation

Eden was Python-only for the agent SDK. The TS / Node /
browser community couldn't instrument their apps without
writing a custom HTTP client. Phase G ships a TS SDK that
matches the Laminar / RagaAI DX:

  * ``new EdenClient({...})`` — one client, one config.
  * ``client.traces.start({...})`` — start a trace.
  * ``client.spans.log({...})`` — log a span event.
  * Auto-instrumentation for OpenAI (and the rest in G.5).

The SDK is the wedge for the TypeScript agent-dev
community — currently the largest gap between Eden and
Laminar / RagaAI.

## What's in Eden

### EdenClient

```ts
import { EdenClient } from "eden-sdk";

const eden = new EdenClient({
  apiKey: "ek_...",
  endpoint: "https://app.eden.example",
  projectId: "my-project",       // optional, default "default"
  batchSize: 100,                  // optional, default 100
  flushIntervalMs: 1_000,          // optional, default 1000
  maxRetries: 3,                   // optional, default 3
});
```

The client:

  * Holds an in-memory queue.
  * Auto-flushes when the queue reaches ``batchSize`` events.
  * Auto-flushes after ``flushIntervalMs`` ms (for partial
    batches).
  * Retries on 5xx with exponential backoff (100ms, 200ms,
    400ms, ...).
  * Sends a Bearer-authenticated POST to
    ``/v1/ingest``.

### TracesNamespace

```ts
const trace = eden.traces.start({
  name: "my-agent-run",
  realm: "production",        // optional, default "production"
  agent_id: "agent-1",        // optional
  agent_version: "1.0.0",     // optional
  metadata: {...},            // optional
});
// trace.trace_id is unique per call.
```

### SpansNamespace

```ts
eden.spans.log(
  {
    name: "llm-call",
    event_type: "llm.completion",  // optional, default "span"
    duration_ms: 1234,
    payload: {...},                  // optional
    metrics: { prompt_tokens: 87 },  // optional
    attributes: {...},               // optional
    outcome: "success",              // optional
    parent_span_id: "span-1",       // optional
  },
  trace,                             // optional, default = current trace
);
```

The event is queued. The next flush (manual
``await eden.flush()``, or auto on size / time) sends it
to the server.

### OpenAI auto-instrumentation

```ts
import OpenAI from "openai";
import { EdenClient, instrumentOpenAI } from "eden-sdk";

const eden = new EdenClient({...});
const openai = instrumentOpenAI(new OpenAI(), eden);

// Every chat-completion call is auto-traced.
const r = await openai.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: "Hello" }],
});
// On success: a span event with event_type=llm.completion,
// outcome=success, metrics.prompt_tokens, metrics.completion_tokens.
// On failure: outcome=failure, payload.error.
```

The instrumented client is a transparent wrapper — every
method on the original client passes through unchanged.
Only ``chat.completions.create`` is intercepted.

## Architecture

The SDK is shipped as a **single file** (``src/index.ts``)
so it can be vendored into environments where the user
doesn't want a build step (e.g. edge functions, Cloudflare
Workers, Deno). The ``dist/`` output (when the user
runs ``tsc``) is the standard ESM module.

The in-memory queue is the same pattern as the Python
SDK's ``EdenLoggingHandler``: events are added to a queue,
flushed in batches, with exponential-backoff retries on
5xx. The user never blocks on a network call.

## Routes consumed

| Method | Path | Auth |
|---|---|---|
| `POST` | `/v1/ingest` | Bearer |

The SDK only writes to the ingest endpoint. Read endpoints
(``/v1/traces/:id``, ``/v1/spans/search``) are exposed via
the Python / portal clients; the TS SDK is write-only in
v1. A future cat adds read access (probably as a separate
``EdenAdminClient`` class).

## RagaAI / Laminar parity matrix

| RagaAI / Laminar feature | Eden Phase G | Notes |
|---|---|---|
| TS SDK with namespaces | ✅ EdenClient | traces / spans (v1) |
| In-memory queue + batched send | ✅ _Queue class | auto-flush on size + time |
| Exponential backoff | ✅ _with_retries | 100ms, 200ms, 400ms, ... |
| Bearer auth | ✅ Authorization header | apiKey from config |
| OpenAI auto-instrumentation | ✅ instrumentOpenAI | success + failure path |
| Anthropic auto-instrumentation | 🟡 deferred (G.5) | Same shape as OpenAI |
| Vercel AI SDK | 🟡 deferred (G.5) | Wraps the stream API |
| LangChain | 🟡 deferred (G.5) | Trace per Runnable |
| Browser Use | 🟡 deferred (G.5) | Trace per action |
| Playwright | 🟡 deferred (G.5) | Trace per page |
| Trace context propagation | 🟡 in-flight trace_id only | W3C trace-context in G.5 |
| Read endpoints | ❌ deferred | v1 is write-only |
| Streaming responses | 🟡 not handled | Auto-instrumentation buffers the response; streaming is G.5 |

## What's NOT in this phase (deferred)

- **Anthropic / Vercel AI SDK / LangChain / Browser Use /
  Playwright auto-instrumentation** — same pattern as
  OpenAI. The v1 ships OpenAI because it's the most
  common. G.5 ships the rest.
- **Streaming response tracing** — the OpenAI wrapper
  buffers the full response before logging. The streaming
  variant (log first-token latency, token-by-token cost)
  is G.5.
- **W3C trace-context propagation** — the v1 uses
  Eden's own ``trace_id`` header. G.5 adds the
  ``traceparent`` / ``tracestate`` headers so traces can
  cross SDK / framework boundaries.
- **Read endpoints** — the v1 SDK is write-only. G.5
  adds ``EdenAdminClient`` with ``traces.get(id)``,
  ``spans.search(q)``, etc.
- **Browser bundle** — the v1 targets Node / Deno. G.5
  ships a separate browser bundle (UMD) for use in the
  portal's "trace this session" feature.

## Failure modes

| Failure | Behaviour |
|---|---|
| Network error on send | Event re-queued; retried on next flush |
| 5xx on send | Same: re-queued, exponential backoff |
| 4xx on send | Logged + dropped (the event is malformed) |
| Missing apiKey / endpoint | Throws at construction time |
| ``spans.log`` without an active trace | Throws |
| Auto-flush when the user navigates | Use ``pagehide`` / ``visibilitychange`` events (browser); ``process.on('beforeExit')`` (Node) — both deferred to G.5 |

## Tests

11 unit tests in ``clients/eden-sdk/test/index.test.ts``:

- EdenClient: requires apiKey
- EdenClient: requires endpoint
- traces.start returns fresh trace_id
- spans.log requires active trace
- spans.log queues without sending
- flush sends the queue
- Authorization header is Bearer
- endpoint strips trailing slash
- batchSize auto-flushes
- instrumentOpenAI: success path
- instrumentOpenAI: failure path

All 11 pass with the Node test runner.

## Files added

| File | LOC | Purpose |
|---|---|---|
| ``clients/eden-sdk/src/index.ts`` | ~330 | The SDK |
| ``clients/eden-sdk/test/index.test.ts`` | ~180 | Unit tests |
| ``clients/eden-sdk/package.json`` | ~25 | Package manifest |
| ``clients/eden-sdk/tsconfig.json`` | ~20 | TS config |

## Cross-references

- [Cat 22 — APM Depth](22-apm-tracing-depth.md) — the
  backend that receives the SDK's events.
- [Cat 10 — Governance Intelligence](10-governance-intelligence.md)
  — the PII scanner that masks the SDK's payloads
  before they reach the database.
- [Phase C — Unified AI Agent](14-autonomous-intelligence.md)
  — the agent that the SDK's events eventually feed
  into.
- [Phase R — stdlib logging shim](30-stdlib-logging-shim.md)
  — the Python sibling of the TS SDK.
