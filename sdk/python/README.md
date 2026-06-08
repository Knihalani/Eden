# Eden Python SDK

Lightweight, fire-and-forget observability for LLM applications.

- `@trace_agent` decorator and `with eden.trace(...)` context manager
- One-call auto-instrumentation for **OpenAI, Anthropic, LangChain, LlamaIndex, CrewAI, AutoGen, Mastra** (no-op for TS-only frameworks)
- Async, batched HTTP sender with a **5 ms p99 overhead budget** on the producer hot path
- Zero required dependencies beyond `httpx` + `pydantic`

## Install

```bash
cd sdk/python
pip install -e .[dev]            # core + tests
pip install -e .[openai,anthropic,langchain]   # add instrumentations
pip install -e .[all]            # every supported framework
```

## Quick start

```python
import eden

eden.configure(
    org_id="org_123",
    api_key="sk-eden-...",
    base_url="https://api.eden.dev",  # default: http://localhost:8000
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
```

Events are batched in memory and posted to the Eden ingestion endpoint
(`/orgs/{org_id}/ingest/{format}`) on a background thread. The shape
matches what `src/eden/observability/ingestion/providers.py` already
decodes — the SDK does no extra normalization.

## Configuration

All settings are read from environment variables first, then overridden
by `eden.configure(...)`:

| Env var                | Default                   | Purpose                                  |
|------------------------|---------------------------|------------------------------------------|
| `EDEN_ORG_ID`          | (required)                | Org the events are attributed to         |
| `EDEN_API_KEY`         | (required)                | Programmatic key (`X-Org-Api-Key`)       |
| `EDEN_BASE_URL`        | `http://localhost:8000`   | Gateway / ingestion base URL             |
| `EDEN_PROJECT_ID`      | `default`                 | Multi-tenant project label               |
| `EDEN_BATCH_SIZE`      | `32`                      | Max events per HTTP POST                 |
| `EDEN_FLUSH_INTERVAL_MS` | `250`                   | Max time to buffer a batch               |
| `EDEN_DISABLED`        | `0`                       | Turn the SDK into a complete no-op       |

## Auto-instrumentation

```python
eden.instrument()                     # everything installed
eden.instrument("openai", "langchain")  # specific frameworks
eden.uninstrument("openai")           # tear down a patch
```

| Framework     | Mechanism                                   |
|---------------|---------------------------------------------|
| openai        | Monkey-patch `chat.completions.create`      |
| anthropic     | Monkey-patch `messages.create`              |
| langchain     | `BaseCallbackHandler` registered globally   |
| llama_index   | `BaseSpanHandler` registered via `Settings.callback_manager` |
| crewai        | Default `step_callback` + `task_callback`   |
| autogen       | Global `register_reply_hook` on `ConversableAgent` |
| mastra        | No-op (use the TypeScript SDK)              |

## Examples

```bash
export EDEN_ORG_ID=org_...
export EDEN_API_KEY=sk-...
export OPENAI_API_KEY=sk-...
python examples/01_basic_chat.py
python examples/02_langchain.py
python examples/03_anthropic.py
```

Each example traces a real LLM call and prints the result. Verify that
a row lands in `telemetry_events` with `source_format` matching the
framework (`openai`, `anthropic`, or `framework` for chains).

## Testing

```bash
cd sdk/python
pip install -e .[dev]
pytest -v                  # unit + integration
pytest -v -m perf          # perf microbench (p99 < 5 ms)
```

The perf test asserts that the SDK's enqueue + `@trace_agent` wrapper
adds no more than 5 ms p99 over an uninstrumented baseline.

## Architecture

```
+-------------------+      +------------------+      +------------------+
|  User code        | ---> |  EdenClient      | ---> |  /ingest/{fmt}   |
|  (sync/async)     |      |  (queue + flush) |      |  (FastAPI route) |
+-------------------+      +------------------+      +------------------+
        ^                                                       |
        |                                                       v
   eden.trace /                                       src/eden/observability/
   @trace_agent                                       ingestion/providers.py
                                                          (existing decoders)
```

- The `EdenClient` is a singleton: `get_default_client()`.
- Producer calls are non-blocking (`queue.put_nowait`).
- A single background thread runs the async httpx loop.
- The ingestion route's auth (`get_ingestion_auth`) accepts the
  `X-Org-Id` + `X-Org-Api-Key` headers this SDK sends.

## License

Apache 2.0
