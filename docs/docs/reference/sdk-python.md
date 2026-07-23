---
id: sdk-python
title: Python SDK
sidebar_label: Python SDK
sidebar_position: 2
---

# Python SDK

Lightweight, fire-and-forget observability for LLM applications.

- **Package** — `eden-sdk` on PyPI (import as `eden` or `eden_sdk`)
- **Default ingest API** — `https://api.edenobservability.com`
- **Producer budget** — ≤ 5 ms p99 overhead on the hot path (enqueue + `@trace_agent`)

New here? Start with the **[Quickstart](/quickstart)** (Fill in creates your key).

## Install

```bash
pip install eden-sdk

# Optional framework extras (auto-instrumentation):
pip install "eden-sdk[openai,anthropic,langchain]"
pip install "eden-sdk[all]"   # every supported framework
```

From source:

```bash
cd sdk/python
pip install -e .[dev]
pip install -e .[openai,anthropic,langchain]
```

## Quick start

```python
import eden

eden.configure(
    org_id="org_123",
    api_key="sk_eden_...",
    # base_url optional — defaults to https://api.edenobservability.com
)

eden.instrument()  # patches every installed framework

@eden.trace_agent(name="my-agent", tags=["prod"])
async def answer(question: str) -> str:
    from openai import AsyncOpenAI
    client = AsyncOpenAI()
    resp = await client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[{"role": "user", "content": question}],
    )
    return resp.choices[0].message.content

eden.get_default_client().flush()
```

Events batch in memory and POST to `/orgs/{org_id}/ingest/{format}` on a
background thread. The wire shape matches the server's existing decoders —
the SDK does no extra normalization.

## Configuration

Environment variables are read first; `eden.configure(...)` overrides them.

| Env var | Default | Purpose |
|---------|---------|---------|
| `EDEN_ORG_ID` | (required) | Org the events are attributed to. `EDEN_DEFAULT_ORG` accepted as alias. |
| `EDEN_API_KEY` | (required) | Programmatic key (`X-Org-Api-Key`). `EDEN_ORG_API_KEY` accepted as alias. |
| `EDEN_BASE_URL` | `https://api.edenobservability.com` | Ingestion / API base URL |
| `EDEN_PROJECT_ID` | `default` | Multi-tenant project label (`X-Project-Id`) |
| `EDEN_BATCH_SIZE` | `50` | Max events per HTTP POST |
| `EDEN_FLUSH_INTERVAL_MS` | `250` | Max time to buffer a batch |
| `EDEN_DISABLED` | `0` | `1` turns the SDK into a complete no-op |
| `EDEN_DRY_RUN` | `0` | Log events at DEBUG instead of POSTing (`EDEN_DEBUG` is a back-compat alias) |
| `EDEN_EXACT_CACHE` | on | Gateway optimization opt-out (`false` to disable) |
| `EDEN_COALESCE` | on | Gateway optimization opt-out |
| `EDEN_PROVIDER_CACHE_LAYOUT` | on | Gateway optimization opt-out |
| `EDEN_RESPONSE_REPAIR` | on | Gateway optimization opt-out |

`configure()` also accepts `max_queue` (default `4096`), `timeout_s`
(default `5`), `gateway_url`, `redact_on_client` (default `True`), and
`filters` for per-call PII policy. See [Gateway helper](#gateway-openai-compatible)
below.

```python
import eden

eden.configure(
    org_id="org_123",
    api_key="sk_eden_...",
    project_id="checkout",
    batch_size=50,
    flush_interval_ms=250,
    max_queue=4096,
    redact_on_client=True,
)
```

## Auto-instrumentation

```python
eden.instrument()                        # every importable framework
eden.instrument("openai", "langchain")   # specific frameworks
eden.instrument("http_capture")          # universal httpx capture (Tier 2)
eden.uninstrument("openai")              # tear down one patch
eden.uninstrument()                      # tear down everything
```

| Framework | Mechanism | `source_format` |
|-----------|-----------|-----------------|
| `openai` | Monkey-patch sync/async `chat.completions.create` | `openai` |
| `anthropic` | Monkey-patch sync/async `messages.create` | `anthropic` |
| `langchain` | Global `BaseCallbackHandler` via `langchain_core` | `framework` |
| `llama_index` | `BaseSpanHandler` on `Settings.callback_manager` | `framework` |
| `crewai` | Default `step_callback` + `task_callback` on `Crew` | `framework` |
| `autogen` | Global reply hook on `ConversableAgent` | `framework` |
| `pydantic_ai` | Patch `Agent.run` / `run_sync` | `pydantic-ai` |
| `bedrock` | boto3 `bedrock-runtime` API call wrap | `framework` |
| `gemini` | `google.generativeai` `generate_content` wrap | `framework` |
| `mastra` | No-op (use the TypeScript SDK) | — |

See the full matrix in [Auto-instrumentation](/reference/auto-instrumentation).

### Detection helpers

```python
eden.detect_installed_frameworks()
# => {"openai": True, "anthropic": False, "langchain": True, ...}

eden.autoInstrument(tags=["prod"])  # alias — reports importable frameworks
```

## Manual tracing

### `@trace_agent` decorator

Works on sync and async functions:

```python
@eden.trace_agent(name="checkout", tags=["prod"])
def run_checkout(cart_id: str) -> str:
    ...
```

### `with eden.trace(...)` context manager

Yields a `Span` with `set_input()`, `set_output()`, `set_tag()`, and
`set_status()`:

```python
with eden.trace("my-span", tags=["prod"]) as span:
    span.set_input({"query": "hello"})
    result = do_work()
    span.set_output({"answer": result})
```

Nested spans inherit `trace_id` from the active context via
`current_trace()` / `current_span()`.

## Flush and shutdown

The `EdenClient` singleton (`get_default_client()`) buffers events
non-blockingly (`queue.put_nowait`). A background thread runs the async
httpx flush loop.

```python
client = eden.get_default_client()
client.flush()           # drain the event queue (default timeout 2 s)
client.flush_chunks()    # drain streaming chunk buffer
client.shutdown()        # flush + stop the background thread (default 5 s)
```

Call `flush()` before process exit in short-lived scripts (tests, CLI
tools, serverless handlers). Long-running services can rely on the
timer-based flush (`EDEN_FLUSH_INTERVAL_MS`).

### Batching and backpressure

- Events flush when the batch reaches `batch_size` **or**
  `flush_interval_ms` elapses — whichever comes first.
- When the in-memory queue exceeds `max_queue`, the **oldest** events are
  dropped (with a warning) so the producer never blocks.
- Stream chunks for `stream=True` calls buffer separately and POST to
  `/ingest/chunks` with TTFT, ITL, and TPOT metrics.

## Gateway (OpenAI-compatible)

Eden's OpenAI-compatible proxy lives at `https://api.edenobservability.com/gateway/v1`
(`/chat/completions`, `/completions`, `/embeddings`, `/models`). Set
`gateway_url` (or pass `upstream_base_url` per call) to route through
your own upstream.

### `openai_client()` helper

```python
from eden_sdk import EdenConfig, FilterConfig, PIIConfig, openai_client

cfg = EdenConfig(org_id="org_123", api_key="sk_eden_...")
client = openai_client(
    cfg,
    gateway_url="https://api.edenobservability.com/gateway/v1",
    filters=FilterConfig(pii=PIIConfig(mode="redact")),
    upstream_base_url="https://my-internal-llm.example.com/v1",
    upstream_api_key="<your-internal-key>",
)

resp = client.chat.completions.create(
    model="gpt-4o-mini",
    messages=[{"role": "user", "content": "hello"}],
)
```

One-shot alternative:

```python
from eden_sdk import chat_completion, FilterConfig, PIIConfig

resp = chat_completion(
    cfg,
    model="gpt-4o-mini",
    messages=[{"role": "user", "content": "hello"}],
    filters=FilterConfig(pii=PIIConfig(mode="fail_closed")),
)
```

`cfg.gateway_headers(pii_bypass=True)` returns the wire headers for
custom HTTP clients. Per-call `filters=` overrides process-wide
`EdenConfig.filters`.

By default `redact_on_client=True` masks obvious emails, phones, SSNs,
and credit cards in outgoing payloads before they leave the process
(belt-and-suspenders; the gateway remains the authoritative PII layer).

## Doctor

Validate config, connectivity, and emit a test event:

```bash
export EDEN_ORG_ID=org_...
export EDEN_API_KEY=sk_eden_...

python -m eden_sdk.doctor
# or, after pip install:
eden-doctor
```

Programmatic:

```python
report = eden.run_doctor(emit_test_event=True)
```

Doctor checks `org_id`, `api_key`, `base_url`, `gateway_url`, gateway
optimization flags, `/health` reachability, and (when configured) emits
a test event visible under **Traces**.

## Dry-run and disabled modes

| Mode | How | Behaviour |
|------|-----|-----------|
| **Disabled** | `EDEN_DISABLED=1` or `configure(disabled=True)` | Complete no-op — no enqueue, no network |
| **Dry-run** | `EDEN_DRY_RUN=1` or `configure(dry_run=True)` | Events logged at DEBUG, not POSTed |
| **Missing org** | No `EDEN_ORG_ID` and no `configure(org_id=...)` | Events dropped silently (dev-friendly) |

Use `disabled` for feature flags in production; use `dry_run` in CI
tests that exercise instrumentation without shipping telemetry.

## Token extraction

```python
from eden_sdk._tokens import extract_usage, normalize_model_name

extract_usage({"prompt_tokens": 100, "completion_tokens": 50})
# => {"input_tokens": 100, "output_tokens": 50, ...}

normalize_model_name("gpt-4o-2024-08-06")  # => "gpt-4o"
```

Every auto-instrumented event includes `model_normalized` so server-side
pricing hits a single row. Missing token counts are `None` (never `0`).

## Common errors

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| No events in portal | Missing `org_id` / `api_key` | Set env vars or call `configure()`; run doctor |
| Doctor: `org_id` red | `EDEN_ORG_ID` unset | Match the org from Settings → API Keys |
| Doctor: `api_key` red | `EDEN_API_KEY` unset | Create a key in the portal |
| Doctor: `enabled` red | `EDEN_DISABLED=1` | Unset or pass `disabled=False` |
| `instrument("langchain")` skipped | Package not installed | `pip install langchain-core` or `eden-sdk[langchain]` |
| Events stop mid-run | Queue overflow | Increase `max_queue` or call `flush()` more often |
| 401 / 403 on ingest | Wrong key or org mismatch | Key must belong to the `org_id` in the URL path |
| Gateway 422 | PII `fail_closed` policy | Use `pii_bypass=True` or adjust `FilterConfig` |

## Next

- [Connect any agent](/how-to/connect-any-agent)
- [Auto-instrumentation matrix](/reference/auto-instrumentation)
- [TypeScript SDK](/reference/sdk-typescript)
- [Ingestion API](/reference/api-ingestion)
