---
id: connect-any-agent
title: Connect any agent
sidebar_label: Connect any agent
sidebar_position: 10
---

# How-to — Connect any agent

Every customer gets a clear path to first trace, regardless of framework.
Eden uses a **three-tier** model:

```mermaid
flowchart LR
  Tier1[Tier 1 — Native wrap] --> Traces
  Tier2[Tier 2 — HTTP / OTel capture] --> Traces
  Tier3[Tier 3 — Manual trace_agent] --> Traces
```

| Tier | When | What you ship |
|------|------|---------------|
| **1 — Native** | Framework in the [support matrix](/reference/auto-instrumentation) | `eden.instrument()` / `wrap*` — full model, tools, tokens, cost |
| **2 — Universal** | Custom agent, niche framework, raw HTTP to OpenAI/Ollama/Anthropic | HTTP capture + OTel bridge + logging forwarder |
| **3 — Manual** | Maximum control | `@trace_agent` / `traceAgent` + `ToolSpan` helpers |

## Step 0 — Run the doctor

Before picking a tier, validate connectivity:

```bash
# Python
pip install eden-sdk
export EDEN_ORG_ID="org_..." EDEN_API_KEY="sk_eden_..."
python -m eden_sdk.doctor   # or: eden-doctor

# TypeScript
npm install @eden-ai/sdk
export EDEN_ORG_ID="org_..." EDEN_ORG_API_KEY="sk_eden_..."
npx eden-doctor
```

:::tip
Fastest path for first credentials: **[Fill in](/quickstart)** on the
docs quickstart.
:::

Doctor checks API key, org id, and connectivity (defaults to
`https://api.edenobservability.com`). Fix any red items before continuing.

## Tier 1 — Native instrumentation

### Python

```python
import os
import eden

eden.configure(
    api_key=os.environ["EDEN_API_KEY"],
    org_id=os.environ["EDEN_ORG_ID"],
)
eden.instrument()  # patches every installed framework
```

Supported frameworks include OpenAI, Anthropic, LangChain, LlamaIndex,
CrewAI, AutoGen, and **Pydantic AI** (SDK 0.3+).

### TypeScript

`instrument()` (default `autoPatch: true`) patches OpenAI and Anthropic
prototypes — instances built afterward are traced without a `wrap*` call.
Other frameworks still need explicit wrappers:

```ts
import {
  configure,
  detectInstalledFrameworks,
  instrument,
  wrapOpenAI,
  traceAgent,
} from "@eden-ai/sdk";

configure({
  apiKey: process.env.EDEN_API_KEY!,
  orgId: process.env.EDEN_ORG_ID!,
});

const { wrapLangChain, patched } = instrument();
const installed = detectInstalledFrameworks();
let client: ReturnType<typeof wrapOpenAI> | undefined;
if (installed.openai) {
  const { default: OpenAI } = await import("openai");
  client = patched.openai ? new OpenAI() : wrapOpenAI(new OpenAI());
}
if (installed.langchain) {
  const { ChatOpenAI } = await import("@langchain/openai");
  wrapLangChain(new ChatOpenAI({ modelName: "gpt-4o-mini" }));
}
```

Native TypeScript frameworks: OpenAI, Anthropic (prototype patch via
`instrument()`), plus Vercel AI, LangChain, and **Mastra** (`wrapMastra`,
SDK 0.3+) and the other `wrap*` helpers.

## Tier 2 — Universal HTTP / OTel capture

Use Tier 2 when your framework is not in the matrix — custom FastAPI
agents, niche runtimes, or direct `httpx` / `fetch` calls to LLM APIs.

### HTTP capture (Python)

```python
import eden
from eden_sdk.http_capture import install_http_capture

eden.configure(api_key=..., org_id=...)
install_http_capture()  # patches httpx for known LLM URL patterns
```

### HTTP capture (TypeScript)

```ts
import { configure } from "@eden-ai/sdk";
import { installHttpCapture } from "@eden-ai/sdk/http-capture";

configure({ apiKey: ..., orgId: ... });
installHttpCapture();  // patches fetch / undici for OpenAI-compatible URLs
```

### OTel bridge (SDK helper)

If your agent already exports OpenTelemetry spans:

```python
import eden
eden.configure_otel_exporter(
    api_key=os.environ["EDEN_API_KEY"],
    org_id=os.environ["EDEN_ORG_ID"],
)
# or: from eden_sdk.otel import configure_exporter
```

Spans forward to Eden ingest with framework attribution from OTel
resource attributes.

### OTel zero-SDK path — migrate in 2 env vars {#otel-env-vars}

If you already run any OpenTelemetry SDK (Python, Java, Go, Node, …) and
want to point it at Eden without touching application code, set two env vars:

```bash
# The Eden OTLP/HTTP ingest endpoint for your org
export OTEL_EXPORTER_OTLP_ENDPOINT="https://api.edenobservability.com/orgs/<org-id>/ingest/otel"

# Auth headers — both are required for API-key authentication
export OTEL_EXPORTER_OTLP_HEADERS="X-Org-Api-Key=<your-api-key>,X-Org-Id=<org-id>"
```

Replace `<org-id>` with your Organization ID and `<your-api-key>` with an
API key that has the `ingest:write` scope (see
[Manage API keys](/how-to/api-keys)).

:::tip Where to find your credentials
Open the Eden portal → **Settings → API Keys**. The org ID appears at the
top of the page as `org_…`.
:::

#### Supported signal types

| Signal | Supported | Notes |
|--------|-----------|-------|
| **Traces** | Yes | Full OTLP/HTTP JSON trace export (`resourceSpans`) |
| Metrics | No | Use a separate metrics backend or the Eden SDK |
| Logs | No | Use the [logging forwarder](#logging-forwarder) below |

Eden maps OTel GenAI semantic convention attributes
(`gen_ai.request.model`, `gen_ai.usage.input_tokens`, etc.) to first-class
fields in the portal.

#### Wire encoding — JSON and protobuf both supported

The ingest endpoint accepts two OTLP/HTTP wire encodings:

| Content-Type | Encoding | Status |
|---|---|---|
| `application/json` | OTLP/HTTP JSON | Supported |
| `application/x-protobuf` | OTLP/HTTP binary protobuf | Supported |
| `application/x-otel-protobuf` | OTLP/HTTP binary protobuf (vendor variant) | Supported |

Most OTel SDKs default to **binary protobuf** — no extra configuration is
needed for them to work out of the box.

If you prefer JSON encoding (e.g. for easier debugging or proxy inspection),
set the protocol env var:

```bash
export OTEL_EXPORTER_OTLP_PROTOCOL=http/json
```

```python
# Explicit instantiation (Python SDK) — JSON exporter
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.trace.export import BatchSpanProcessor

exporter = OTLPSpanExporter(
    endpoint="https://api.edenobservability.com/orgs/<org-id>/ingest/otel",
    headers={
        "X-Org-Api-Key": "<your-api-key>",
        "X-Org-Id": "<org-id>",
    },
)
```

Both the default protobuf and the JSON encodings produce identical portal
output — the content-type only affects what's on the wire, not what's stored.

#### Worked example — Python OpenTelemetry SDK

```python
"""
Minimal OTel-instrumented agent that exports traces to Eden with no
Eden SDK dependency — only the standard opentelemetry packages.

Install:
  pip install opentelemetry-sdk opentelemetry-exporter-otlp-proto-http

Run:
  export OTEL_EXPORTER_OTLP_ENDPOINT="https://api.edenobservability.com/orgs/org_xxx/ingest/otel"
  export OTEL_EXPORTER_OTLP_HEADERS="X-Org-Api-Key=sk_eden_xxx,X-Org-Id=org_xxx"
  # OTEL_EXPORTER_OTLP_PROTOCOL defaults to http/protobuf — Eden accepts both.
  # Set to http/json if you prefer human-readable wire encoding for debugging:
  #   export OTEL_EXPORTER_OTLP_PROTOCOL=http/json
  python agent.py
"""

import os
from opentelemetry import trace
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter

resource = Resource.create({"service.name": "my-agent"})
provider = TracerProvider(resource=resource)

exporter = OTLPSpanExporter(
    endpoint=os.environ["OTEL_EXPORTER_OTLP_ENDPOINT"],
    headers=dict(
        h.split("=", 1)
        for h in os.environ["OTEL_EXPORTER_OTLP_HEADERS"].split(",")
    ),
)
provider.add_span_processor(BatchSpanProcessor(exporter))
trace.set_tracer_provider(provider)

tracer = trace.get_tracer("my-agent", "1.0.0")

with tracer.start_as_current_span("gpt-4o chat") as span:
    span.set_attribute("gen_ai.operation.name", "chat")
    span.set_attribute("gen_ai.request.model", "gpt-4o")
    span.set_attribute("gen_ai.usage.input_tokens", 42)
    span.set_attribute("gen_ai.usage.output_tokens", 17)
    # … call your LLM here …
    result = "Hello from my agent"

print("Trace exported — check Eden portal → Traces within ~5 seconds.")
```

The span appears in Eden portal → **Traces** with model, token counts, and
duration automatically extracted from the OTel GenAI attributes.

### Logging forwarder

Mirror server-side logging shim UX from the SDK:

```python
from eden_sdk.logging_forwarder import install_logging

install_logging()  # forwards log events as event_type: log
```

## Tier 3 — Manual `@trace_agent`

When you need full control over span boundaries:

```python
@eden.trace_agent(name="checkout-agent", tags=["prod"])
def run_checkout(cart_id: str) -> str:
    ...
```

```ts
class Checkout {
  @traceAgent({ name: "checkout-agent", tags: ["prod"] })
  async run(cartId: string) { ... }
}
```

Use `eden.tool_span("search", fn)` (Python) or `toolSpan("search", fn)`
(TypeScript) for nested tool calls.

## Portal first-trace polling

After pasting a snippet:

1. Open **Traces** in the portal.
2. Run your agent once.
3. The trace should appear within ~5 seconds.

If nothing shows after **120 seconds**, check:

| Check | Fix |
|-------|-----|
| Wrong `org_id` | Match the key's org in Settings → API Keys |
| Wrong API URL | Leave `base_url` unset — SDKs use `https://api.edenobservability.com` |
| Firewall | Allow HTTPS egress to Eden ingest |
| Doctor red | Re-run `python -m eden_sdk.doctor` / `npx eden-doctor` |

## Pick your path (decision tree)

1. Is your framework in the [auto-instrumentation matrix](/reference/auto-instrumentation)?
   → **Tier 1**
2. Do you call OpenAI-compatible HTTP directly?
   → **Tier 2 HTTP capture**
3. Do you already emit OTel spans and want zero code changes?
   → **[Tier 2 OTel zero-SDK (2 env vars)](#otel-env-vars)**
4. Do you want the Eden SDK to configure the OTel exporter for you?
   → **Tier 2 OTel bridge (SDK helper)**
5. Otherwise
   → **Tier 3** manual decorators

## What's next

- [Quickstart](/quickstart) — five-minute first trace
- [Agent sessions](/how-to/agent-sessions) — group traces by user interaction
- [Instrument an existing repo](/how-to/auto-instrument)
