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
| `EDEN_BASE_URL` | `https://api.edenobservability.com` | Gateway base URL. |
| `EDEN_PROJECT_ID` | `default` | Sent as `X-Project-Id`. |
| `EDEN_REALM` | `production` | Realm tag. |
| `EDEN_DEBUG` | `0` | Set to `1` to log every batch flush. |

Or pass the same values explicitly:

```ts
import { configure } from "@eden-ai/sdk";

configure({
  orgId: "org_abc",
  apiKey: "sk_...",
  baseUrl: "https://api.edenobservability.com",
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

## Instrumentation parity matrix

| Framework | Status | API |
|---|---|---|
| OpenAI | Supported | `wrapOpenAI` |
| Anthropic | Supported | `wrapAnthropic` |
| Vercel AI | Supported | `wrapVercelAI` |
| LangChain | Supported | `wrapLangChain` |
| Mastra | Supported | `wrapMastra` |
| Bedrock | Supported | `wrapBedrock` |
| Gemini / Vertex | Supported | `wrapGemini` |
| CrewAI / AutoGen / LlamaIndex / Pydantic AI | Python SDK | use `eden-sdk` |

### Agent sessions (F23)

```ts
import { begin, identify } from "@eden-ai/sdk";

const session = await begin({ agentId: "bot", userId: "u1" });
await identify("u1");
await session.trace("turn-1", async () => { /* ... */ });
await session.completeSession(true);
// POSTs to /orgs/{orgId}/ingest/agent-sessions with X-Org-Api-Key
```

### Stumbles (F28)

```ts
import { recordStumble } from "@eden-ai/sdk";
await recordStumble("tool returned empty", { traceId, kind: "tool_error" });
```

### Sampling + offline

| Env | Default | Purpose |
|---|---|---|
| `EDEN_SAMPLING_PROFILE` | `full` | `full` / `balanced` / `aggressive` (keep-errors default on) |
| `EDEN_OFFLINE_QUEUE` | off | Spill failed batches to `~/.eden/offline_queue.jsonl` |

OTel bridge uses `BatchSpanProcessor` → `/ingest/otel`.

## Talking to the Eden gateway (OpenAI-compatible)

Eden ships an OpenAI-compatible proxy at `https://api.edenobservability.com/gateway/v1`
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

`resolvedGatewayUrl()` returns `${baseUrl}/gateway/v1` by default and honours
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

For LLM-completion events, the SDK also populates:

| Field | Source | Description |
| --- | --- | --- |
| `metrics.input_tokens` | provider `usage` block | prompt tokens (or `promptTokens` / `prompt_tokens`) |
| `metrics.output_tokens` | provider `usage` block | completion tokens (or `completionTokens` / `completion_tokens`) |
| `metrics.cache_read_input_tokens` | Anthropic / OpenAI `prompt_tokens_details.cached_tokens` | cached input tokens (Anthropic gives ~90% discount) |
| `metrics.cache_creation_input_tokens` | Anthropic `cache_creation_input_tokens` | cache write tokens (billed at 25% premium) |
| `modelNormalized` | `normalizeModelName(model)` | dated-suffix-stripped alias: `gpt-4o-2024-08-06` → `gpt-4o`, `claude-3-5-sonnet-20241022` → `claude-3-5-sonnet` |

Missing token counts are reported as `null` (never 0) so billing
math doesn't accidentally bill free input.

## Token extraction & model normalization

The same helpers used by every instrumentation are also exported as
a public API for users who want to pre-screen their own payloads:

```ts
import { extractUsage, normalizeModelName } from "@eden-ai/sdk";

extractUsage({
  prompt_tokens: 100,
  completion_tokens: 50,
  prompt_tokens_details: { cached_tokens: 25 },
});
// => { inputTokens: 100, outputTokens: 50,
//      cacheReadTokens: 25, cacheCreationTokens: null }

normalizeModelName("gpt-4o-2024-08-06");           // => "gpt-4o"
normalizeModelName("claude-3-5-sonnet-20241022"); // => "claude-3-5-sonnet"
normalizeModelName("claude-3-5-sonnet-latest");   // => "claude-3-5-sonnet"
```

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

## What's new in 0.2.0

- **Context-manager `trace()`.** `import { TraceController } from "@eden-ai/sdk"` and build the span imperatively with `setInput / setOutput / setTag / setStatus / recordError / end`. The legacy `await trace("name", async (ctx) => ...)` form is preserved.
- **Retry with backoff.** `EdenSDK.postJson` retries transient gateway failures (3 attempts, honours `Retry-After`, never retries 4xx other than 408/429).
- **Config parity with Python.** New `maxQueueSize` (default 4096, oldest-event drop), `timeoutS` (default 5), `redactOnClient` (default `true`), and `disabled` flags.
- **Client-side PII safety net.** `redactPayload()` masks obvious emails / phones / SSNs / credit cards in every outgoing payload. Disable via `new EdenSDK({ redactOnClient: false })` when the gateway is your trusted redaction point.
- **Detection helpers.** `autoInstrument()` and `detectInstalledFrameworks()` report which LLM SDKs are installed; same shape as the Python SDK.
- **CHANGELOG.md** ships with the package; see `sdk/ts-ai/CHANGELOG.md` for the full 0.2.0 notes.
