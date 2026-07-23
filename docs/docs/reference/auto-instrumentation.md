---
id: auto-instrumentation
title: Auto-instrumentation matrix
sidebar_label: Auto-instrumentation
sidebar_position: 6
---

# Auto-instrumentation matrix

The Eden SDKs patch the most popular LLM SDKs at import time (Python) or
wrap client instances (TypeScript), so "trace my agent" is a one-liner.
The matrix below lists every framework the SDKs know how to wrap and what
gets recorded.

## Three-tier model

| Tier | When | Mechanism |
|------|------|-----------|
| **1 — Native** | Framework listed below | `eden.instrument()` / `wrap*` |
| **2 — Universal** | Custom agent, raw HTTP, OTel-only frameworks | HTTP capture, OTel bridge, logging forwarder |
| **3 — Manual** | Full control | `@trace_agent` / `traceAgent` |

See [Connect any agent](/how-to/connect-any-agent) for the full decision tree.

## By SDK

### Python (`eden-sdk`)

| Framework | Mechanism | Recorded |
|-----------|-----------|----------|
| `openai` | Monkey-patch sync/async `chat.completions.create` | model, prompt, response, tokens, latency; streaming TTFT/ITL/TPOT |
| `anthropic` | Monkey-patch sync/async `messages.create` | model, messages, response, tokens, cache read/write tokens |
| `langchain` | Global `BaseCallbackHandler` via `langchain_core.callbacks` | chain/agent/tool spans across the execution tree |
| `llama_index` | `BaseSpanHandler` on `Settings.callback_manager` | span name, query/response, duration |
| `crewai` | Default `step_callback` + `task_callback` on `Crew` | step thought/tool/result, task name/outcome |
| `autogen` | Global reply hook on `ConversableAgent` | speaker, recipient, message contents |
| `pydantic_ai` | Patch `Agent.run` / `run_sync` | agent name, input/output, duration, `source_format: pydantic-ai` |
| `bedrock` | boto3 `bedrock-runtime` API call wrap | model, request/response, tokens, latency |
| `gemini` | `google.generativeai` `generate_content` wrap | model, prompt, response, tokens, latency |
| `mastra` | No-op (use TypeScript SDK) | — |

### Tier 2 — Python universal fallback

| Mechanism | Patches | Recorded |
|-----------|---------|----------|
| HTTP capture | `httpx` for OpenAI/Anthropic/Ollama URL patterns | model, request/response bodies (truncated), latency |
| OTel bridge | `eden_sdk.otel.configure_exporter()` | spans forwarded with framework attribution |
| Logging forwarder | `eden_sdk.logging_forwarder.install_logging()` | `event_type: log` events |

### TypeScript (`@eden-ai/sdk`)

The TypeScript SDK wraps **client instances** (Proxy-based), not global
module exports. Call `wrap*` on the object you already use in production.

| Framework | Wrapper | Recorded |
|-----------|---------|----------|
| `openai` | `wrapOpenAI(client)` | model, prompt, response, tokens; streaming metrics + chunk replay |
| `anthropic` | `wrapAnthropic(client)` | model, messages, response, tokens, cache tokens |
| `ai` (Vercel AI) | `wrapVercelAI(aiModule)` — pass `import * as ai from "ai"` | model, prompt/response from `generateText` / `streamText` |
| `langchain` | `wrapLangChain(chatModelInstance)` | invoke/call/stream/batch on any chat model |
| `mastra` | `wrapMastra(mastraInstance)` | agent/workflow name, step outcomes, `source_format: mastra` |

### Tier 2 — TypeScript universal fallback

| Mechanism | Patches | Recorded |
|-----------|---------|----------|
| HTTP capture | `fetch` / `undici` for known LLM URLs | model, bodies (truncated), latency |
| OTel bridge | `configureOtelExporter()` from `@eden-ai/sdk` | spans with framework attribution |
| Logging forwarder | SDK logging shim | `event_type: log` events |

## What gets recorded, per call

Every instrumented call emits a single `framework` ingestion event
with these standard fields:

| Field | Source | Always? |
|-------|--------|---------|
| `event_type` | `"framework"` | yes |
| `source_format` | `"openai"` \| `"anthropic"` \| `"vercel-ai"` \| `"langchain"` \| `"pydantic-ai"` \| `"mastra"` \| `"http-capture"` \| `"custom"` | yes |
| `model` | From request | yes |
| `prompt` | Last user message (truncated at 8 KiB) | yes |
| `response` | Assistant message (truncated at 8 KiB) | yes |
| `input_tokens` | `usage.prompt_tokens` | if available |
| `output_tokens` | `usage.completion_tokens` | if available |
| `cost_usd` | Computed from `model_pricing` table | if model known |
| `duration_ms` | Wrapped start→finish | yes |
| `outcome` | `"success"` \| `"error"` \| `"timeout"` | yes |
| `error` | Truncated error message if `outcome != "success"` | conditional |
| `trace_id` | From active span, or generated | yes |
| `parent_span_id` | From active span | if nested |
| `attributes` | Anything you set via `set_attribute()` | optional |

The portal renders this as the **timeline** view; trace_id ties
sibling calls into one agent graph.

## Custom frameworks

If your framework isn't on the list, you have two options:

### 1. Manual ingestion

Send a `custom` event with whatever fields matter to you:

```python
from eden_sdk import EventBuilder, Outcome

await eden.trace(
    EventBuilder.agent_call("my_tool_call")
    .with_attribute("tool", "search")
    .with_attribute("query", q)
    .with_outcome(Outcome.Success)
)
```

```ts
import { traceAgent } from "@eden-ai/sdk";

class MyTool {
  @traceAgent({ name: "search" })
  async search(q: string) { /* ... */ }
}
```

### 2. Wire-format ingestion

Send the raw event directly:

```bash
curl -X POST "https://api.edenobservability.com/orgs/org_abc/ingest/custom" \
  -H "Authorization: Bearer sk_eden_..." \
  -H "Content-Type: application/json" \
  -d '{
    "events": [{
      "name": "my_custom_event",
      "outcome": "success",
      "duration_ms": 137,
      "attributes": { "anything": "you want" }
    }]
  }'
```

See the [Ingestion reference](/reference/api-ingestion) for the
full schema.

## Disabling instrumentation

```python
# Python — reverses monkey-patches
eden.uninstrument()         # undo everything
eden.uninstrument("openai") # undo just one framework
eden.uninstrument("http_capture")  # undo httpx capture
```

```ts
// TypeScript — create a fresh unwrapped client (no global uninstrument)
const raw = new OpenAI();
// do not pass through wrapOpenAI()

// Or disable telemetry entirely:
configure({ disabled: true });
```

For tests, combine `configure({ disabled: true })` or
`EDEN_DISABLED=1` (Python) with unwrapped clients so no events ship.