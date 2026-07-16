---
id: sdk-typescript
title: TypeScript SDK
sidebar_label: TypeScript SDK
sidebar_position: 3
---

# TypeScript SDK

Drop-in observability for OpenAI, Anthropic, Vercel AI, LangChain, and
Mastra on Node.js, Bun, and Deno.

- **Package** — `@eden-ai/sdk` on npm
- **Default ingest API** — `https://api.edenobservability.com`
- **Model** — fire-and-forget; tracing must never block the caller

New here? Start with the **[Quickstart](/quickstart)** (Fill in creates your key).

## Install

```bash
npm install @eden-ai/sdk
# or: pnpm add / bun add / yarn add @eden-ai/sdk
```

Framework SDKs (`openai`, `@anthropic-ai/sdk`, `ai`, `@langchain/core`,
`@mastra/core`) are optional peer dependencies — install only what you
use.

## Quick start

```ts
import OpenAI from "openai";
import { configure, wrapOpenAI, getDefaultClient } from "@eden-ai/sdk";

configure({ orgId: "org_abc", apiKey: "sk_eden_..." });

const openai = wrapOpenAI(new OpenAI({ apiKey: process.env.OPENAI_API_KEY }));

const reply = await openai.chat.completions.create({
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: "Hello!" }],
});

await getDefaultClient().flush();
```

The TypeScript SDK wraps **client instances** (Proxy-based), not global
module exports. This survives ESM/CJS interop and bundler tree-shaking.

## Configuration

Environment variables are read first; `configure(...)` overrides them.

| Env var | Default | Purpose |
|---------|---------|---------|
| `EDEN_ORG_ID` | — | Required for production. `EDEN_DEFAULT_ORG` accepted as alias. |
| `EDEN_ORG_API_KEY` | — | API key (`X-Org-Api-Key`). `EDEN_API_KEY` accepted as alias. |
| `EDEN_BASE_URL` | `https://api.edenobservability.com` | Ingestion / API base URL |
| `EDEN_GATEWAY_URL` | `{baseUrl}/gateway/v1` | OpenAI-compatible gateway override |
| `EDEN_PROJECT_ID` | `default` | Sent as `X-Project-Id` |
| `EDEN_REALM` | `production` | Realm tag on events |
| `EDEN_DEBUG` | `0` | `1` logs every batch flush to `console.debug` |
| `EDEN_EXACT_CACHE` | on | Gateway optimization opt-out |
| `EDEN_COALESCE` | on | Gateway optimization opt-out |
| `EDEN_PROVIDER_CACHE_LAYOUT` | on | Gateway optimization opt-out |
| `EDEN_RESPONSE_REPAIR` | on | Gateway optimization opt-out |

`configure()` also accepts `maxBatchSize` (default `50`),
`flushIntervalMs` (default `250`), `maxQueueSize` (default `4096`),
`timeoutS` (default `5`), `redactOnClient` (default `true`),
`disabled`, `strict`, and `filters`.

```ts
import { configure } from "@eden-ai/sdk";

configure({
  orgId: "org_abc",
  apiKey: "sk_eden_...",
  baseUrl: "https://api.edenobservability.com",
  tags: ["prod", "checkout-agent"],
  debug: false,
  strict: false,       // true → throw when orgId missing
  redactOnClient: true,
});
```

When `orgId` is unset, events are dropped silently (dev-friendly). Set
`strict: true` to fail fast instead.

## Instrumentation

### Per-framework wrappers

```ts
import { wrapOpenAI, wrapAnthropic, wrapVercelAI, wrapLangChain, wrapMastra } from "@eden-ai/sdk";
```

#### OpenAI

```ts
import OpenAI from "openai";
import { wrapOpenAI } from "@eden-ai/sdk";

const openai = wrapOpenAI(new OpenAI(), { tags: ["checkout"] });

await openai.chat.completions.create({
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: "Hello!" }],
});

// Streaming — emits llm_completion_stream + per-chunk /ingest/chunks rows
const stream = await openai.chat.completions.create({
  model: "gpt-4o-mini",
  stream: true,
  messages: [{ role: "user", content: "Stream a haiku." }],
});
for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
}
```

#### Anthropic

```ts
import Anthropic from "@anthropic-ai/sdk";
import { wrapAnthropic } from "@eden-ai/sdk";

const anthropic = wrapAnthropic(new Anthropic(), { tags: ["checkout"] });

await anthropic.messages.create({
  model: "claude-3-5-sonnet-20241022",
  max_tokens: 256,
  messages: [{ role: "user", content: "Hello!" }],
});
```

#### Vercel AI

Pass the imported `ai` namespace — not a model factory:

```ts
import * as ai from "ai";
import { openai } from "@ai-sdk/openai";
import { wrapVercelAI } from "@eden-ai/sdk";

const wrapped = wrapVercelAI(ai);

await wrapped.generateText({
  model: openai("gpt-4o-mini"),
  prompt: "Write a haiku.",
});

const stream = await wrapped.streamText({
  model: openai("gpt-4o-mini"),
  prompt: "Stream a haiku.",
});
for await (const chunk of stream.textStream) process.stdout.write(chunk);
```

#### LangChain

Wraps any chat-model instance — instruments `invoke`, `call`, `stream`,
and `batch`:

```ts
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage } from "@langchain/core/messages";
import { wrapLangChain } from "@eden-ai/sdk";

const chat = wrapLangChain(new ChatOpenAI({ modelName: "gpt-4o-mini" }), { tags: ["checkout"] });

await chat.invoke([new HumanMessage("Hello!")]);
```

#### Mastra

```ts
import { wrapMastra } from "@eden-ai/sdk";

const mastra = wrapMastra(mastraInstance, { tags: ["prod"] });
// Proxies getAgent / getWorkflow — emits agent.run events with source_format: mastra
```

### `instrument()` convenience helper

Returns all `wrap*` functions plus detection status. Does **not**
auto-wrap clients — you still call the wrappers yourself:

```ts
import { configure, instrument } from "@eden-ai/sdk";
import OpenAI from "openai";

configure({ orgId: "org_abc", apiKey: "sk_eden_..." });

const { wrapOpenAI, detected } = instrument({ tags: ["prod"] });
// detected: { openai: true, anthropic: false, vercelAi: false, langchain: false, mastra: false }

if (detected.openai) {
  const openai = wrapOpenAI(new OpenAI());
}
```

### Detection helpers

```ts
import { autoInstrument, detectInstalledFrameworks } from "@eden-ai/sdk";

const status = autoInstrument({ tags: ["prod"] });
// { openai: true, anthropic: true, vercelAi: true, langchain: false, mastra: false }
```

`autoInstrument()` is an alias of `detectInstalledFrameworks()` — it
reports which packages are importable but does not wrap them.

## Manual tracing

### `trace()` context manager

```ts
import { trace, getDefaultClient } from "@eden-ai/sdk";

const result = await trace("myAgent", async (ctx) => {
  ctx.setTag("prod");
  ctx.setInput({ question: "hi" });
  const answer = await doWork();
  ctx.setOutput({ answer });
  return answer;
});

await getDefaultClient().flush();
```

Import `TraceController` for imperative span building with
`setInput` / `setOutput` / `setTag` / `setStatus` / `recordError` /
`end`.

### `@traceAgent()` decorator

```ts
import { traceAgent } from "@eden-ai/sdk";

class MyAgent {
  @traceAgent({ name: "my-agent", tags: ["prod"], environmentId: "env_abc" })
  async run(query: string) {
    return await fetch("/api/echo", { method: "POST", body: query });
  }
}
```

## Flush and shutdown

```ts
import { getDefaultClient } from "@eden-ai/sdk";

const client = getDefaultClient();
await client.flush();        // drain event queue
await client.flushChunks();  // drain streaming chunk buffer
await client.dispose();      // flush both + stop timers — call on graceful shutdown
```

Register `dispose()` from a `beforeExit` handler or your server's
shutdown hook.

### Batching and backpressure

- Events flush at `maxBatchSize` (default **50**) or `flushIntervalMs`
  (default **250 ms**), whichever comes first.
- Stream chunks share the same timer and POST separately to
  `/ingest/chunks`.
- When the queue exceeds `maxQueueSize` (default **4096**), oldest
  events are dropped silently.
- Network failures are swallowed at debug level unless `strict: true`.

## Gateway (OpenAI-compatible)

Production gateway: `https://api.edenobservability.com/gateway/v1`. The SDK resolves
`resolvedGatewayUrl()` as `{baseUrl}/gateway/v1` unless `gatewayUrl` /
`EDEN_GATEWAY_URL` is set.

```ts
import {
  EdenSDK,
  FilterConfig,
  PIIConfig,
  openaiClient,
} from "@eden-ai/sdk";

const sdk = new EdenSDK({
  orgId: "org_abc",
  apiKey: "sk_eden_...",
  gatewayUrl: "https://api.edenobservability.com/gateway/v1",
  filters: new FilterConfig({
    pii: new PIIConfig({ mode: "fail_closed", disabledCategories: ["api_key"] }),
  }),
});

const client = await openaiClient(sdk, {
  upstreamBaseUrl: "https://my-internal-llm.example.com/v1",
  upstreamApiKey: "<your-internal-key>",
});

await client.chat.completions.create({
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: "hello" }],
});
```

Raw headers for any HTTP client:

```ts
const headers = sdk.gatewayHeaders({
  piiBypass: true,
  filters: new FilterConfig({ pii: new PIIConfig({ mode: "off" }) }),
});
await fetch(`${sdk.resolvedGatewayUrl()}/chat/completions`, {
  method: "POST",
  headers,
  body: JSON.stringify({ model: "gpt-4o-mini", messages: [...] }),
});
```

`redactOnClient` (default `true`) masks obvious PII in outgoing payloads
before they leave the process.

## Doctor

```bash
export EDEN_ORG_ID=org_...
export EDEN_ORG_API_KEY=sk_eden_...

npx eden-doctor
# or, from a project with @eden-ai/sdk installed:
node node_modules/@eden-ai/sdk/dist/doctor.js
```

Programmatic:

```ts
import { runDoctor } from "@eden-ai/sdk";

const report = await runDoctor();
```

Doctor checks `orgId`, `apiKey`, `baseUrl`, `gatewayUrl`, optimization
flags, `/health` reachability, and emits a test event when configured.

## Strict mode and disabled

```ts
configure({ strict: true, orgId: "org_abc", apiKey: "sk_eden_..." });
```

| Mode | How | Behaviour |
|------|-----|-----------|
| **Disabled** | `configure({ disabled: true })` | Complete no-op |
| **Missing org** | No `EDEN_ORG_ID` | Events dropped silently (unless `strict`) |
| **Strict** | `configure({ strict: true })` | Throws when `orgId` missing |
| **Debug** | `EDEN_DEBUG=1` | Logs every flush to `console.debug` |

## Token extraction

```ts
import { extractUsage, normalizeModelName } from "@eden-ai/sdk";

extractUsage({ prompt_tokens: 100, completion_tokens: 50 });
// => { inputTokens: 100, outputTokens: 50, cacheReadTokens: null, ... }

normalizeModelName("gpt-4o-2024-08-06");           // => "gpt-4o"
normalizeModelName("claude-3-5-sonnet-20241022"); // => "claude-3-5-sonnet"
```

## Tier 2 fallbacks

```ts
import { installHttpCapture, uninstallHttpCapture } from "@eden-ai/sdk/http-capture";
import { installLogging, uninstallLogging } from "@eden-ai/sdk";
import { configureOtelExporter } from "@eden-ai/sdk";

installHttpCapture();   // patch fetch / undici for known LLM URLs
installLogging();       // forward console events as event_type: log
configureOtelExporter({ orgId: "...", apiKey: "..." });
```

## Common errors

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| No events in portal | Missing `orgId` / `apiKey` | Set env vars or `configure()`; run doctor |
| `wrapOpenAI` no telemetry | Wrapped the wrong object | Wrap the `OpenAI` instance, not a module import |
| `wrapVercelAI` no-op | Passed a model factory | Pass `import * as ai from "ai"` |
| Events stop mid-run | Queue overflow | Increase `maxQueueSize` or `await flush()` |
| 401 / 403 on ingest | Wrong key or org | Key must match `orgId` in the ingest URL |
| Strict mode crash | `orgId` unset | Set `EDEN_ORG_ID` or disable `strict` |

## Next

- [Connect any agent](/how-to/connect-any-agent)
- [Auto-instrumentation matrix](/reference/auto-instrumentation)
- [Python SDK](/reference/sdk-python)
- [Ingestion API](/reference/api-ingestion)
