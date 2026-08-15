---
id: auto-instrumentation
title: Auto-instrumentation matrix
sidebar_label: Auto-instrumentation
sidebar_position: 6
---

# Auto-instrumentation matrix

Python's `eden.instrument()` is a true one-liner across **13 frameworks**
(the `mastra` entry is a no-op stub — Mastra is TypeScript-only; use the
TypeScript SDK for Mastra projects).
TypeScript's `instrument()` prototype-patches the frameworks listed below
(OpenAI, Anthropic, Groq, LangChain, Gemini, Mistral); others still need
`wrap*()` — see the TS matrix. The tables list every framework the SDKs
know how to wrap and what gets recorded.

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
| `langgraph` | Patch `CompiledGraph.invoke` / `stream` / `ainvoke` / `astream` | `graph.node_start` + `graph.node_end` spans with node name and state keys |
| `bedrock` | boto3 `bedrock-runtime` API call wrap | model, request/response, tokens, latency |
| `gemini` | `google.generativeai` `generate_content` wrap | model, prompt, response, tokens, latency |
| `groq` | Patch `chat.completions.create` | model, prompt, response, tokens; streaming metrics |
| `cohere` | Patch v2 `chat` / `chat_stream` | model, response, tokens, tool calls |
| `mistral` | Patch `Chat.complete` / `.stream` | model, response, tokens; streaming metrics |
| `mastra` | No-op (use TypeScript SDK) | — |

### Tier 2 — Python universal fallback

| Mechanism | Patches | Recorded |
|-----------|---------|----------|
| HTTP capture | `httpx` for OpenAI/Anthropic/Ollama URL patterns | model, request/response bodies (truncated), latency |
| OTel bridge | `eden_sdk.otel.configure_exporter()` | spans forwarded with framework attribution |
| Logging forwarder | `eden_sdk.logging_forwarder.install_logging()` | `event_type: log` events |

### TypeScript (`@eden-ai/sdk`)

`instrument()` patches supported frameworks **once at class/prototype level**
(mirroring Python's one-liner UX). Check `result.patched` (sync CJS pass)
and `result.patchedAsync` (async ESM pass for dual-package SDKs) to see
what applied in your process. Pass `autoPatch: false` to opt out.

| Framework | `instrument()` auto-patch | `wrap*` fallback | Recorded |
|-----------|---------------------------|------------------|----------|
| `openai` | Yes — `Chat.Completions.prototype.create` (+ xAI via `baseURL`) | `wrapOpenAI` / `wrapXai` | model, prompt, response, tokens; streaming + chunk replay |
| `anthropic` | Yes — `Messages.prototype.create` | `wrapAnthropic` | model, messages, response, tokens, cache tokens |
| `groq` | Yes — `Chat.Completions.prototype.create` | `wrapGroq` | model, prompt, response, tokens; streaming metrics |
| `langchain` | Yes — `BaseChatModel` invoke/call/stream/batch | `wrapLangChain` | invoke/call/stream/batch on any chat model |
| `langgraph` | No — instance-level `CompiledGraph` API | `wrapLangGraph` | `graph.node_start` + `graph.node_end` spans per node, state keys |
| `gemini` | Yes — `GenerativeModel.generateContent` / `@google/genai` Models | `wrapGemini` | model, prompt, response, tokens |
| `mistral` | Yes — `Chat.complete` / `.stream` (when installed) | `wrapMistral` | model, response, tokens; streaming metrics |
| `ai` (Vercel AI) | **No** — ESM namespace exports are immutable | `wrapVercelAI` | model, prompt/response from `generateText` / `streamText` |
| `cohere` | No — dual client shapes (`CohereClient` vs `CohereClientV2`) | `wrapCohere` | v2 chat/chatStream; tool calls |
| `bedrock` | No — AWS SDK command `send` pattern | `wrapBedrock` | model, request/response, tokens |
| `mastra` | No — instance-level agent/workflow API | `wrapMastra` | agent/workflow name, step outcomes |
| `llamaindex` | No — no global span-handler API | `wrapLlamaIndex` | query/chat/retrieve duration, `sourceNodes` |

#### Why not `import-in-the-middle`?

Prototype patching covers every framework with a mutable class prototype
(OpenAI-shaped clients, LangChain `BaseChatModel`, Gemini `GenerativeModel`,
etc.) without adding a loader-hook dependency or requiring a `--import`
startup flag for ESM apps. Vercel AI is the main exception: its API is
top-level functions on an ESM module namespace object, whose bindings
cannot be reassigned from outside the module. Loader hooks could intercept
`ai` at load time but are intentionally deferred (Phase 2 in the SDK DX
spec) to keep `instrument()` a zero-config one-liner for the common case.

Dual-package SDKs (`openai`, `@anthropic-ai/sdk`, `groq-sdk`) ship
separate CJS and ESM builds. `instrument()` runs both a synchronous
`require()` pass (`patched`) and an async dynamic `import()` pass
(`patchedAsync`) so both import styles are covered.

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
// TypeScript — opt out of auto-patch (wrap* factories still work)
instrument({ autoPatch: false });

// Or create a fresh unwrapped client in a process that was patched
// before your code ran (patches are process-global):
const raw = new OpenAI();

// Or disable telemetry entirely:
configure({ disabled: true });
```

For tests, combine `configure({ disabled: true })` or
`EDEN_DISABLED=1` (Python) with unwrapped clients so no events ship.
