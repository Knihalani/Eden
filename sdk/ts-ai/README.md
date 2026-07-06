# @eden-ai/sdk

Eden TypeScript runtime SDK — drop-in auto-instrumentation for OpenAI, Anthropic, Vercel AI, and LangChain with fire-and-forget telemetry to the [Eden](https://eden.dev) gateway.

The SDK mirrors the surface of Eden's Python SDK (`@eden/sdk`-equivalent `eden.sdk.trace`) so existing agent code can be ported by changing the import.

## Install

```bash
bun add @eden-ai/sdk
# or
npm install @eden-ai/sdk
# or
pnpm add @eden-ai/sdk
```

## Configure

The SDK reads the following env vars by default (all optional in dev — events are dropped silently when `orgId` is unset):

| Variable | Default | Description |
| --- | --- | --- |
| `EDEN_ORG_ID` | — | Required for production. Sent in URL path + `X-Org-Id` header. |
| `EDEN_ORG_API_KEY` | — | API key sent as `X-Org-Api-Key`. |
| `EDEN_BASE_URL` | `http://localhost:8000` | Gateway base URL. |
| `EDEN_PROJECT_ID` | `default` | Sent as `X-Project-Id`. |
| `EDEN_REALM` | `production` | Realm tag. |
| `EDEN_DEBUG` | `0` | Set to `1` to log every batch flush. |

Or pass the same values explicitly:

```ts
import { configure } from "@eden-ai/sdk";

configure({
  orgId: "org_abc",
  apiKey: "sk_...",
  baseUrl: "https://api.eden.dev",
  tags: ["prod", "checkout-agent"],
  debug: false,
});
```

## Auto-instrument OpenAI

```ts
import OpenAI from "openai";
import { configure, wrapOpenAI, getDefaultClient } from "@eden-ai/sdk";

configure({ orgId: "org_abc", apiKey: "sk_..." });

const raw = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const openai = wrapOpenAI(raw, { tags: ["checkout"] });

// Every call through this Proxy emits telemetry to
// POST /orgs/{orgId}/ingest/openai.
const reply = await openai.chat.completions.create({
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: "Hello!" }],
});

// Streaming:
const stream = await openai.chat.completions.create({
  model: "gpt-4o-mini",
  stream: true,
  messages: [{ role: "user", content: "Stream a haiku." }],
});
for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
}
```

For streaming calls the SDK emits one `llm_completion_stream` event after the iterator exhausts, with:

- `ttft_ms` — time-to-first-token
- `itl_ms_avg` — average inter-token latency
- `tpot_ms` — time-per-output-token
- `completion_duration_ms` — total wall-clock
- `output_tokens` — token estimate (chunk-based; SDK's reported usage wins when present)

The SDK also buffers each chunk and flushes them to `POST /orgs/{orgId}/ingest/chunks` for per-token replay (mirrors the Python SDK's `_flush_stream_chunks`).

## Auto-instrument Anthropic

```ts
import Anthropic from "@anthropic-ai/sdk";
import { wrapAnthropic } from "@eden-ai/sdk";

const raw = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const anthropic = wrapAnthropic(raw, { tags: ["checkout"] });

const reply = await anthropic.messages.create({
  model: "claude-3-5-sonnet-20241022",
  max_tokens: 256,
  messages: [{ role: "user", content: "Hello!" }],
});
```

## Auto-instrument Vercel AI

```ts
import * as ai from "ai";
import { openai } from "@ai-sdk/openai";
import { wrapVercelAI } from "@eden-ai/sdk";

const wrapped = wrapVercelAI(ai);

const result = await wrapped.generateText({
  model: openai("gpt-4o-mini"),
  prompt: "Write a haiku.",
});

const stream = await wrapped.streamText({
  model: openai("gpt-4o-mini"),
  prompt: "Stream a haiku.",
});
for await (const chunk of stream.textStream) process.stdout.write(chunk);
```

## Auto-instrument LangChain

```ts
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage } from "@langchain/core/messages";
import { wrapLangChain } from "@eden-ai/sdk";

const raw = new ChatOpenAI({ modelName: "gpt-4o-mini" });
const chat = wrapLangChain(raw, { tags: ["checkout"] });

const result = await chat.invoke([new HumanMessage("Hello!")]);
```

`wrapLangChain` is a Proxy that instruments `invoke`, `call`, `stream`, and `batch` methods on any chat-model instance.

## Talking to the Eden gateway (OpenAI-compatible)

Eden ships an OpenAI-compatible proxy at `https://gateway.eden.ai/v1`
that exposes `/chat/completions`, `/completions`, `/embeddings`, and
`/models`. Point any OpenAI-compatible client at it and Eden applies
PII redaction, semantic caching, per-tenant budgets, circuit
breakers, and cost-aware routing in the path.

The SDK ships a typed filter-config surface so callers can configure
PII (and any future gateway filters) without hand-rolling headers:

```ts
import {
  EdenSDK,
  FilterConfig,
  PIIConfig,
  openaiClient,
} from "@eden-ai/sdk";

const sdk = new EdenSDK({
  orgId: "org_abc",
  apiKey: "sk_...",
  filters: new FilterConfig({
    pii: new PIIConfig({ mode: "fail_closed", disabledCategories: ["api_key"] }),
  }),
});

// Built-in helper that wires the right URL + headers in one call:
const client = await openaiClient(sdk, {
  // Optional per-call upstream override — route this specific call
  // through your own OpenAI-compatible server instead of the
  // Eden-default upstream.
  upstreamBaseUrl: "https://my-internal-llm.example.com/v1",
  upstreamApiKey: "<your-internal-key>",
});

const reply = await client.chat.completions.create({
  model: "gpt-5",
  messages: [{ role: "user", content: "hello" }],
});
```

You can also call `sdk.gatewayHeaders()` to get the headers as a
record and pass them to any HTTP client:

```ts
const headers = sdk.gatewayHeaders({
  piiBypass: true,        // skip PII for this one call
  filters: new FilterConfig({ pii: new PIIConfig({ mode: "off" }) }),
});
await fetch(`${sdk.resolvedGatewayUrl()}/chat/completions`, {
  method: "POST",
  headers,
  body: JSON.stringify({ model: "gpt-5", messages: [...] }),
});
```

`resolvedGatewayUrl()` returns `${baseUrl}/v1` by default and honours
an explicit `gatewayUrl` option when one is set. The gateway strips
`X-Upstream-Api-Key`, `X-Org-Api-Key`, and `X-Org-Id` before
forwarding to the upstream so Eden credentials never leak to a
third-party LLM provider.

The Python SDK has the same surface (`eden_sdk.filters.FilterConfig`,
`EdenConfig.filters`, `openai_client()`, `chat_completion()`); see
`sdk/python/README.md` for the Python equivalent.

## Manual tracing

If you want to trace arbitrary functions (not just LLM calls), use `trace()` or `@traceAgent()`.

```ts
import { trace, traceAgent } from "@eden-ai/sdk";

class MyAgent {
  @traceAgent({ tags: ["prod"], environmentId: "env_abc" })
  async run(query: string) {
    return await fetch("/api/echo", { body: query });
  }
}

// or imperative:
const result = await trace("myAgent", async (ctx) => {
  // ctx.traceId / ctx.spanId / ctx.startMs
  return await openai.chat.completions.create({ ... });
});
```

## Auto-instrument everything

```ts
import { autoInstrument } from "@eden-ai/sdk";
const status = autoInstrument({ tags: ["prod"] });
// { openai: true, anthropic: true, vercelAi: true, langchain: false }
```

The result tells you which frameworks were detected and wrapped; missing modules return `false` (the SDK never hard-imports them).

## Batching & flush

The SDK is fire-and-forget:

- Events are queued and flushed in batches of `maxBatchSize` (default **50**) or every `flushIntervalMs` (default **250 ms**), whichever comes first.
- Stream chunks share the same cap and are POSTed separately to `/ingest/chunks`.
- `await getDefaultClient().dispose()` flushes pending work — call this from `beforeExit` or a graceful-shutdown handler.

## Telemetry payload shape

Every emitted event matches the gateway's expected `telemetry_events` row (see `src/eden/db_migrations/versions/009_telemetry_events.py`):

```json
{
  "eventId": "lzx...24",
  "tenantId": "org_abc",
  "projectId": "default",
  "traceId": "lzx...24",
  "realm": "production",
  "eventType": "llm_completion",
  "timestamp": "2026-06-08T12:00:00.000Z",
  "sourceFormat": "openai",
  "payload": {
    "provider": "openai",
    "model": "gpt-4o-mini",
    "duration_ms": 234,
    "status": "success",
    "error_type": null
  },
  "metrics": { "duration_ms": 234 },
  "tags": ["prod", "auto_instrument"]
}
```

`sourceFormat` is one of `openai | anthropic | vercel-ai | langchain | eden-trace-agent-ts | eden-auto-instrument-ts` — the portal uses it to filter events by framework.

## Why is it fire-and-forget?

Tracing must never block the user's call. Every emit path is wrapped in a try/catch, network failures are logged at debug level, and oversized batches are dropped silently. To opt into strict mode:

```ts
configure({ strict: true, orgId: "..." });
```

## Testing

```bash
cd sdk/ts-ai
bun install
bun test            # run unit tests
bun run typecheck   # tsc --noEmit
```

The unit tests stub `global.fetch` and assert on the captured POST bodies — no real network or gateway required.

## End-to-end

With the Eden backend running locally:

```bash
cd sdk/ts-ai
bun install
OPENAI_API_KEY=sk-... bun run examples/basic-chat.ts
```

Verify a row was written to `telemetry_events` with `framework="openai"` and the expected payload fields.

## License

MIT
