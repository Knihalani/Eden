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

| Framework | Patched call | Recorded |
|-----------|--------------|----------|
| `openai` | `Client.chat.completions.create`, `AsyncClient.chat.completions.create` | model, prompt, response, tokens, latency |
| `anthropic` | `Client.messages.create`, `AsyncClient.messages.create` | model, system, messages, response, tokens |
| `langchain` | `ChatModel.invoke`, `ChatModel.ainvoke`, `LLMChain.invoke`, `AgentExecutor.invoke` | chain name, agent name, tool calls, intermediate steps |
| `llama_index` | `QueryEngine.query`, `ChatEngine.chat` | query, response, retrieved node ids |
| `crewai` | `Crew.kickoff` | crew name, agent roster, task outcomes |
| `autogen` | `ConversableAgent.generate_reply` | speaker, recipient, message contents |
| `pydantic-ai` | `Agent.run`, tool calls | agent name, tools, tokens, `source_format: pydantic-ai` |
| `mastra` | No-op (use TypeScript SDK) | — |

### Tier 2 — Python universal fallback

| Mechanism | Patches | Recorded |
|-----------|---------|----------|
| HTTP capture | `httpx` for OpenAI/Anthropic/Ollama URL patterns | model, request/response bodies (truncated), latency |
| OTel bridge | `eden_sdk.otel.configure_exporter()` | spans forwarded with framework attribution |
| Logging forwarder | `eden_sdk.logging_forwarder.install_logging()` | `event_type: log` events |

### TypeScript (`@eden-ai/sdk`)

| Framework | Wrapper | Recorded |
|-----------|---------|----------|
| `openai` | `wrapOpenAI(client)` | model, prompt, response, tokens |
| `anthropic` | `wrapAnthropic(client)` | model, system, messages, response, tokens |
| `ai` (Vercel AI) | `wrapVercelAI({ openai })` | model, prompt, response |
| `langchain` | `wrapLangChain({ ChatOpenAI })` | chain/agent name, intermediate steps |
| `mastra` | `wrapMastra(mastraInstance)` | workflow name, step outcomes, `source_format: mastra` |

### Tier 2 — TypeScript universal fallback

| Mechanism | Patches | Recorded |
|-----------|---------|----------|
| HTTP capture | `fetch` / `undici` for known LLM URLs | model, bodies (truncated), latency |
| OTel bridge | `@eden-ai/sdk/otel` exporter | spans with framework attribution |
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
# Python
eden.uninstrument()        # undo everything
eden.uninstrument("openai") # undo just one framework
```

```ts
// TypeScript
import { uninstrument } from "@eden-ai/sdk";
uninstrument("openai");
```

Useful for tests that need to assert on the SDK's behaviour without
the SDK sending real events.