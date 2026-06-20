---
id: sdk-python
title: Python SDK
sidebar_label: Python SDK
sidebar_position: 2
---

# Python SDK

Lightweight, fire-and-forget observability for LLM applications.

- **Package** — `eden-sdk` on PyPI (import as `eden`)
- **Source** — [`sdk/python/`](https://github.com/eden/eden/tree/main/sdk/python)
- **Target overhead** — ≤ 5 ms p99 on the producer hot path

## Install

```bash
pip install eden-sdk                    # core
pip install eden-sdk[openai,anthropic]  # add instrumentations
pip install eden-sdk[all]               # every supported framework
```

Optional extras:

| Extra | Patches |
|-------|---------|
| `openai` | `openai` (sync + async) |
| `anthropic` | `anthropic` |
| `langchain` | `langchain`, `langchain_core` |
| `llama_index` | `llama-index-core` |
| `crewai` | `crewai` |
| `autogen` | `pyautogen`, `autogen-agentchat` |
| `mastra` | Mastra Python (if installed) |

## Configure

```python
import eden

eden.configure(
    api_key="sk_eden_...",        # or EDEN_API_KEY env var
    org_id="org_...",             # or EDEN_ORG_ID env var
    base_url="https://api.edenobservability.com",
    environment="production",     # free-form label, defaults to EDEN_ENV
    debug=False,                  # set True to log every event
    flush_interval_ms=1000,       # how often the background sender flushes
    max_batch_size=200,           # max events per POST
)
```

Environment variables win unless you pass the kwarg explicitly:

| Env var | Config key | Default |
|---------|-----------|---------|
| `EDEN_API_KEY` | `api_key` | — |
| `EDEN_ORG_ID` | `org_id` | — |
| `EDEN_BASE_URL` | `base_url` | `http://localhost:8000` |
| `EDEN_ENV` | `environment` | `"default"` |
| `EDEN_DEBUG` | `debug` | `false` |

## Auto-instrument

```python
import eden
eden.configure(api_key=..., org_id=...)
eden.instrument()             # patches every installed framework
# or pick exactly one:
eden.instrument("openai")     # only OpenAI
eden.instrument("anthropic")  # only Anthropic
```

`instrument()` is idempotent — calling it twice is a no-op. To undo
the patches (e.g. in a test teardown), call `eden.uninstrument()`.

## Tracing primitives

### `@eden.trace_agent` decorator

```python
@eden.trace_agent(name="my-agent", tags=["prod"], capture_args=True)
async def answer(question: str) -> str:
    # The whole function becomes one trace span.
    # LLM calls inside are automatically nested as child spans.
    ...
```

### `with eden.trace(...)` context manager

```python
with eden.trace("user-session-42") as t:
    t.set_attribute("user_id", "u_abc")
    t.log("Started retrieval")

    result = await do_work()

    t.set_attribute("outcome", "success")
    # t auto-closes on exit; span attributes land in telemetry_events
```

### Manual spans

```python
span = eden.Span(name="retrieval")
span.set_attribute("k", 8)
with span:
    docs = await retrieve(...)
span.finish(outcome="success")
```

## Framework auto-instrumentation details

Each framework module monkey-patches the SDK's chat/embedding
methods at import time. After `eden.instrument()`:

| Framework | Patched methods | Recorded fields |
|-----------|-----------------|------------------|
| OpenAI | `Client.chat.completions.create`, `AsyncClient.chat.completions.create` | model, prompt, response, tokens, latency |
| Anthropic | `Client.messages.create`, `AsyncClient.messages.create` | model, system, messages, response, tokens |
| LangChain | `ChatModel.invoke`, `ChatModel.ainvoke`, `LLMChain.invoke`, `AgentExecutor.invoke` | chain name, agent name, tool calls, intermediate steps |
| LlamaIndex | `QueryEngine.query`, `ChatEngine.chat` | query, response, retrieved node ids |
| CrewAI | `Crew.kickoff` | crew name, agent roster, task outcomes |
| AutoGen | `ConversableAgent.generate_reply` | speaker, recipient, message contents |
| Mastra | Mastra Python runtime calls | runtime id, workflow name, step outcomes |

All instrumentations emit a single `framework` ingestion event per
LLM call, joined to the parent span by `trace_id` + `parent_span_id`.

## Manual ingestion

For events that aren't an LLM call (tool results, retrieval hits,
business outcomes):

```python
from eden_sdk import EventBuilder, Outcome

event = (
    EventBuilder.agent_call("checkout")
    .add_tag("prod")
    .with_duration_ms(137)
    .with_attribute("order_id", "ord_123")
    .with_outcome(Outcome.Success)
)
await eden.trace(event)
```

`Outcome` is one of `Success`, `Error`, `Timeout`, `Unknown`.

## Shutdown

```python
import atexit
atexit.register(eden.uninstrument)
# Or, in async apps, on the FastAPI shutdown event:
@app.on_event("shutdown")
async def _shutdown():
    await eden.get_default_client().aclose()
```

The default client flushes in-flight events on close; an explicit
`await client.flush()` is available if you need to drain before a
critical section.

## Errors

The SDK never raises on the hot path — telemetry failures are
swallowed and logged at `WARNING`. The exceptions:

| Error | When |
|-------|------|
| `eden.EdenConfigError` | Bad config on `eden.configure()` (e.g. missing `api_key`) |
| `eden.IngestionError` | The background sender failed to POST after retries; raises only when explicitly awaited |

## Versioning

The SDK follows SemVer. The wire format matches
[`POST /orgs/{org_id}/ingest/custom`](/reference/api-ingestion) and
is forward-compatible — new optional fields are additive only.