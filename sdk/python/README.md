# Eden Python SDK

Lightweight, fire-and-forget observability for LLM applications.

- `@trace_agent` decorator and `with eden.trace(...)` context manager
- One-call auto-instrumentation for **OpenAI, Anthropic, Groq, Cohere, Mistral, LangChain, LlamaIndex, CrewAI, AutoGen, Mastra** (no-op for TS-only frameworks)
- Async, batched HTTP sender with a **5 ms p99 overhead budget** on the producer hot path
- Zero required dependencies beyond `httpx` (zero required deps beyond)

## Install

```bash
# From PyPI (published as eden-sdk)
pip install eden-sdk

# Optional framework integrations (auto-instrumentation):
pip install "eden-sdk[openai,anthropic,langchain]"
pip install "eden-sdk[all]"   # every supported framework

# Or install from source (this repo):
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
| `EDEN_ORG_ID`          | (required)                | Org the events are attributed to. `EDEN_DEFAULT_ORG` accepted as an alias for parity with the TypeScript SDK. |
| `EDEN_API_KEY`         | (required)                | Programmatic key (`X-Org-Api-Key`). `EDEN_ORG_API_KEY` accepted as an alias for parity with the TypeScript SDK. |
| `EDEN_BASE_URL`        | `https://api.edenobservability.com`   | Gateway / ingestion base URL             |
| `EDEN_PROJECT_ID`      | `default`                 | Multi-tenant project label               |
| `EDEN_BATCH_SIZE`      | `50`                      | Max events per HTTP POST                 |
| `EDEN_FLUSH_INTERVAL_MS` | `250`                   | Max time to buffer a batch               |
| `EDEN_MAX_QUEUE`       | `4096`                    | Backpressure cap (oldest dropped first)  |
| `EDEN_DISABLED`        | `0`                       | Turn the SDK into a complete no-op       |
| `EDEN_DRY_RUN`        | `0`                       | Log events at DEBUG level instead of POST (was `EDEN_DEBUG`) |

## Auto-instrumentation

```python
eden.instrument()                     # everything installed
eden.instrument("openai", "langchain")  # specific frameworks
eden.uninstrument("openai")           # tear down a patch
```

| Framework     | Mechanism                                   | Status |
|---------------|---------------------------------------------|--------|
| openai        | Monkey-patch `chat.completions.create`      | Supported |
| anthropic     | Monkey-patch `messages.create`              | Supported |
| langchain     | `BaseCallbackHandler` registered globally   | Supported |
| llama_index   | `BaseSpanHandler` via `Settings.callback_manager` | Supported |
| crewai        | Default `step_callback` + `task_callback`   | Supported |
| autogen       | Global `register_reply_hook`                | Supported |
| pydantic_ai   | Agent run hooks                             | Supported |
| bedrock       | boto3 `bedrock-runtime` API call wrap       | Supported |
| gemini        | `google.generativeai` generate_content      | Supported |
| xai (Grok)    | Aliases to the `openai` instrumentor (`eden.instrument("xai")`) — xAI has no distinct Python client, just the `openai` package pointed at `base_url="https://api.x.ai/v1"` | Supported |
| groq          | Monkey-patch `chat.completions.create` (native — Groq's `groq` SDK mirrors OpenAI's schema, incl. streaming deltas + tool calls) | Supported |
| cohere        | Monkey-patch `cohere.ClientV2`/`AsyncClientV2` `.chat`/`.chat_stream` (Chat API v2 only — the legacy v1 surface still falls back to generic HTTP-capture) | Supported |
| mistral       | Monkey-patch `mistralai` `chat.complete`/`.stream` (incl. streaming deltas + tool calls) | Supported |
| mastra        | **No-op stub** (TypeScript-only framework)  | Unsupported on Python — use `@eden-ai/sdk` |
| Vercel AI     | N/A (TS)                                    | Use TypeScript SDK |

### Agent sessions (F23)

```python
import eden

eden.configure(org_id="org_123", api_key="sk_...")

with eden.begin(agent_id="bot", user_id="u1") as session:
    eden.identify("u1")
    with session.trace("turn-1"):
        ...
# posts to /orgs/{org_id}/ingest/agent-sessions with X-Org-Api-Key
```

See `examples/10_sessions.py`.

### Sampling + offline queue

| Env / config | Default | Purpose |
|---|---|---|
| `EDEN_SAMPLING_PROFILE` | `full` | `full` / `balanced` (~15%) / `aggressive` (~5%); errors always kept |
| `EDEN_SAMPLE_KEEP_ERRORS` | `1` | Keep error events under sampling |
| `EDEN_OFFLINE_QUEUE` | `0` | Spill failed batches to `~/.eden/offline_queue.sqlite3` |

## Token extraction & model normalization

Every instrumentation routes through two shared helpers exposed at
``eden_sdk._tokens``:

```python
from eden_sdk._tokens import extract_usage, normalize_model_name

# Extract a normalized usage dict from any provider's usage blob
extract_usage({
    "prompt_tokens": 100,
    "completion_tokens": 50,
    "prompt_tokens_details": {"cached_tokens": 25},
})
# => {"input_tokens": 100, "output_tokens": 50,
#     "cache_read_tokens": 25, "cache_creation_tokens": None}

# Strip dated suffixes / -latest aliases so pricing lookups hit
# a single row
normalize_model_name("gpt-4o-2024-08-06")           # => "gpt-4o"
normalize_model_name("claude-3-5-sonnet-20241022") # => "claude-3-5-sonnet"
normalize_model_name("claude-3-5-sonnet-latest")   # => "claude-3-5-sonnet"
```

The SDK emits ``model_normalized`` on every auto-instrumented event
so the server-side pricing lookup never has to do the stripping
itself. Missing token counts are reported as ``None`` (never zero)
so billing math doesn't accidentally bill free input.

## Examples

```bash
export EDEN_ORG_ID=org_...
export EDEN_API_KEY=sk-...
export OPENAI_API_KEY=sk-...
python examples/01_basic_chat.py      # OpenAI non-streaming
python examples/02_langchain.py       # LangChain
python examples/03_anthropic.py       # Anthropic
python examples/04_streaming.py       # OpenAI streaming (TTFT/ITL/TPOT)
```

Each example traces a real LLM call and prints the result. Verify that
a row lands in `telemetry_events` with `source_format` matching the
framework (`openai`, `anthropic`, or `framework` for chains).

## Streaming

`eden.instrument("openai")` / `eden.instrument("anthropic")` transparently
wrap streaming responses too — no code changes are needed. For each
`stream=True` call the SDK emits:

- one `llm_completion_stream` event with `ttft_ms`, `itl_ms_avg`,
  `tpot_ms`, `output_tokens`, `input_tokens`,
  `cache_read_input_tokens`, `cache_creation_input_tokens`,
  `chunk_count`, `finish_reason`, and `model_normalized`
  (e.g. `gpt-4o` for both `gpt-4o` and `gpt-4o-2024-08-06`);
- one row per chunk to `/ingest/chunks` with the `delta_text` and the
  per-chunk `ttft_ms` / `itl_ms` / `tpot_ms`.

Cache tokens are significant for billing — Anthropic's prompt cache
gives a ~90% discount on cache reads, so the SDK forwards
`cache_read_input_tokens` / `cache_creation_input_tokens` to the
gateway when the provider returns them.

`model_normalized` is the dated-suffix-stripped model alias
(``gpt-4o-2024-08-06`` → ``gpt-4o``,
``claude-3-5-sonnet-20241022`` → ``claude-3-5-sonnet``,
``claude-3-5-sonnet-latest`` → ``claude-3-5-sonnet``) so the
server-side pricing lookup hits a single row regardless of which
alias the caller used.

```python
import eden
from openai import OpenAI

eden.configure(org_id="...", api_key="...", base_url="...")
eden.instrument("openai")

client = OpenAI()
stream = client.chat.completions.create(
    model="gpt-4o-mini",
    messages=[{"role": "user", "content": "Stream a haiku."}],
    stream=True,
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="", flush=True)
print()

eden.get_default_client().flush()
# → /ingest/openai  (one llm_completion_stream event)
# → /ingest/chunks  (one row per chunk)
```

The same applies to Anthropic — `eden.instrument("anthropic")` understands
`message_start`, `content_block_delta`, `message_delta`, and `message_stop`
events and emits matching metrics.

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

## Eden AI gateway (OpenAI-compatible)

Eden ships an OpenAI-compatible proxy at `https://api.edenobservability.com/gateway/v1`
that exposes `/chat/completions`, `/completions`, `/embeddings`, and
`/models`. Point any OpenAI-compatible client at it and Eden applies
PII redaction, semantic caching, per-tenant budgets, circuit
breakers, and cost-aware routing in the path.

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://api.edenobservability.com/gateway/v1",
    api_key="<EDEN_API_KEY>",  # your org's Eden API key
    default_headers={
        # Per-request upstream: route to your own OpenAI-compatible
        # server (e.g. an internal vLLM proxy) instead of the
        # Eden-default upstream. Both are optional; when omitted,
        # Eden uses the server-configured OpenRouter / MiniMax.
        "X-Upstream-Base-Url": "https://my-internal-llm.example.com/v1",
        "X-Upstream-Api-Key": "<your-internal-key>",
        # Optional: hint for telemetry labelling + provider-specific
        # header defaults (anthropic-version, etc.).
        "X-Upstream-Provider": "openai",
        # OpenRouter attribution (optional).
        "HTTP-Referer": "https://my-app.example.com",
        "X-Title": "my-app",
    },
)

resp = client.chat.completions.create(
    model="gpt-4o-mini",  # any model your upstream supports
    messages=[{"role": "user", "content": "hello"}],
)
```

The gateway strips `X-Upstream-Api-Key`, `X-Org-Api-Key`, and
`X-Org-Id` before forwarding to the upstream so Eden credentials
never leak to a third-party LLM provider. Other `X-*` headers
(OpenRouter `HTTP-Referer` / `X-Title`, Anthropic `anthropic-version`
/ `anthropic-beta`, OpenRouter `X-OpenRouter-Beta`) flow through
unchanged.

### Client-side PII safety net

In addition to the gateway's per-tenant PII policy, the SDK runs
its own redaction pass on every payload **before it leaves the
process**. This is a belt-and-suspenders backstop for local dev
and for the case where the gateway is down or misconfigured.
The default is on — to disable it (e.g. for compliance audits
where you need to verify the SDK never modifies your data), pass
``redact_on_client=False`` to :func:`eden.configure`:

```python
import eden
eden.configure(org_id="...", api_key="...", redact_on_client=False)
```

The client-side pass covers emails, formatted phones, SSNs, and
Luhn-valid credit cards in JSON string values (dict + list
recursively walked, plus string keys). False-positive guards keep
pure-digit IDs, hex digests, and token counts untouched.

### PII redaction

Every gateway call passes through Eden's PII redactor before the
upstream sees it. By default, the redactor masks emails, phones,
SSNs, credit cards, JWTs, API keys, AWS secrets, private keys,
IBANs, passports, and IP addresses. Three knobs control the
behaviour — pick the one that matches your scenario:

**1. Per-tenant policy (recommended for org-wide defaults).** The
org's `org_pii_policies` row drives the active category set, the
masker mode, and the fail-closed behaviour. Admins set it via
`PUT /orgs/{org_id}/pii-policy` or the portal. Three modes:

- `off` — never mask. Use when the system is designed to use the
  raw PII values (e.g. an internal credential-management flow
  that needs the API key to authenticate downstream).
- `redact` (default) — mask per the active category set.
- `fail_closed` — mask + reject with 422 when a credential
  category (JWT, API key, AWS secret, private key, etc.) is
  detected. Use for tenants handling user-supplied prompts that
  must never reach the upstream unmasked.

**2. Per-request opt-out (recommended for one-off calls).** Send
`X-PII-Bypass: true` on a specific request to skip redaction for
that call, regardless of the tenant policy:

```python
headers = cfg.gateway_headers(
    pii_bypass=True,  # skip PII redaction for this request
)
```

The same effect comes from a request-body field — useful for
OpenAI-compatible clients that can't easily add headers:

```python
client.chat.completions.create(
    model="gpt-4o-mini",
    messages=[...],
    extra_body={"pii_filter_enabled": False},
)
```

**3. Disable a specific category.** Set
`disabled_categories=["api_key", "url_with_creds"]` in the policy
when your flow intentionally carries API keys (e.g. the auth
header of an outbound call the LLM has to make on the user's
behalf). The masker will redact emails, phones, SSNs, etc. but
leave credentials untouched.

Per-request bypass wins over per-tenant policy. If a tenant has
`mode="fail_closed"` and a single request legitimately needs to
send a credential, that request can opt out via `X-PII-Bypass:
true` and the upstream sees the credential — the rest of the
tenant's traffic remains fail-closed.


### Programmatic filter configuration from the SDK

For call sites that want to configure PII (and any future gateway
filters) from Python instead of hand-rolling headers, the SDK ships
a typed filter config surface:

```python
import eden
from eden_sdk.filters import FilterConfig, PIIConfig

# Process-wide defaults — applied to every gateway call.
eden.configure(
    org_id="org_123",
    api_key="sk-eden-...",
    filters=FilterConfig(
        pii=PIIConfig(
            mode="fail_closed",
            disabled_categories=["api_key"],  # opt out of specific categories
        ),
    ),
)
```

Or, per-call, build a configured OpenAI client in one call:

```python
from eden_sdk import EdenConfig, FilterConfig, PIIConfig, openai_client

cfg = EdenConfig(org_id="org_123", api_key="sk-eden-...")
client = openai_client(
    cfg,
    filters=FilterConfig(pii=PIIConfig(mode="redact")),
    # Optional: route this specific call through your own
    # OpenAI-compatible upstream.
    upstream_base_url="https://my-internal-llm.example.com/v1",
    upstream_api_key="<your-internal-key>",
)

resp = client.chat.completions.create(
    model="gpt-5",
    messages=[{"role": "user", "content": "hello"}],
)
```

Or a one-shot helper for the common case:

```python
from eden_sdk import (
    EdenConfig, FilterConfig, PIIConfig, chat_completion,
)

cfg = EdenConfig(org_id="org_123", api_key="sk-eden-...")
resp = chat_completion(
    cfg,
    model="gpt-5",
    messages=[{"role": "user", "content": "hello"}],
    filters=FilterConfig(pii=PIIConfig(mode="fail_closed")),
)
```

The SDK renders the filter config as the same wire headers the
gateway already accepts (`X-PII-Mode`, `X-PII-Disabled-Categories`,
`X-PII-Bypass`). Per-call filters layered via the `filters=` kwarg
override the process-wide `EdenConfig.filters` for that one call.
Adding a new server-side filter is a one-line change in
`sdk/python/eden_sdk/filters.py` + one new field on `FilterConfig`.

The TypeScript SDK (`@eden-ai/sdk`) mirrors this surface:
`new FilterConfig({ pii: new PIIConfig({ mode: "fail_closed" }) })`
plus `sdk.gatewayHeaders({ filters })` and `sdk.resolvedGatewayUrl()`.

## License

Apache 2.0

## What's new in 0.3.2

- **Bedrock + Gemini usage extraction.** The `bedrock` and `gemini` instrumentations now extract input/output/cache/total token counts (Converse API, InvokeModel body shapes for Anthropic/Titan/Llama, and Gemini `usage_metadata`) so both providers report cost data like `openai`/`anthropic`.
- **`redact_on_client` now defaults to `False`.** The gateway remains the authoritative PII layer; restore with `EdenConfig(redact_on_client=True)` or `EDEN_REDACT_ON_CLIENT=1`.
- Default `batch_size` is now `50` (was `32`); streaming instrumentations omit `delta_text` unless `capture_chunk_text=True`.
- Offline queue keeps a persistent SQLite (WAL) connection; ingest POSTs use gzip; OTel exporter and native `instrument()` are mutually exclusive unless `allow_dual=True`.
- See `sdk/python/CHANGELOG.md` for the full 0.3.x notes.

## What's new in 0.2.0

- **Span API.** `trace()` now yields a `Span` with first-class
  `set_input()`, `set_output()`, `set_tag()`, and `set_status()`
  methods. The legacy `with trace(...) as ctx: ctx.set_*` shape
  remains supported.
- **Retry with backoff.** `EdenClient._send_batch` retries transient
  gateway failures (3 attempts, honours `Retry-After`, never retries
  4xx other than 408/429).
- **Detection helpers.** `eden.autoInstrument()` /
  `eden.detect_installed_frameworks()` report which LLM SDKs are
  importable, mirroring the TypeScript SDK.  All seven supported
  framework keys are always present in the result dict.
- **PII redaction is still the gateway's job.** The SDK now also
  exports a `redact_on_client: bool` config flag (default `True`)
  that, when enabled, runs a small regex pass over outgoing
  payloads to mask obvious emails / phone numbers / SSN / credit
  card patterns before they reach the network. This is a safety
  net only — the gateway remains the authoritative redaction
  layer and the source of truth for tenant policy.
- **New examples.** `examples/05_crewai.py`, `examples/06_autogen.py`,
  and `examples/07_llamaindex.py` mirror the LangChain example
  shape and exercise the corresponding auto-instrumentation.
- **CHANGELOG.md** is now shipped with the package; see
  `sdk/python/CHANGELOG.md` for the full 0.2.0 notes.
