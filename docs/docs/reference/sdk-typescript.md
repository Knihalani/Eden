---
id: sdk-typescript
title: TypeScript SDK
sidebar_label: TypeScript SDK
sidebar_position: 3
---

# TypeScript SDK

Drop-in auto-instrumentation for OpenAI, Anthropic, Vercel AI, and
LangChain on Node.js, Bun, and Deno. Fire-and-forget telemetry to
the Eden gateway.

- **Package** — `@eden-ai/sdk` on npm
- **Source** — [`sdk/ts-ai/`](https://github.com/eden/eden/tree/main/sdk/ts-ai)
- **Runtime** — Node 18+, Bun 1.0+, Deno 1.40+

## Install

```bash
# npm
npm install @eden-ai/sdk

# pnpm
pnpm add @eden-ai/sdk

# bun
bun add @eden-ai/sdk

# yarn
yarn add @eden-ai/sdk
```

## Configure

```ts
import { configure } from "@eden-ai/sdk";

configure({
  apiKey: process.env.EDEN_API_KEY!,   // required
  orgId: process.env.EDEN_ORG_ID!,     // required
  baseUrl: process.env.EDEN_BASE_URL,  // optional, defaults to EDEN_BASE_URL
  environment: "production",           // free-form label
  flushIntervalMs: 1000,
  maxBatchSize: 200,
  debug: false,
});
```

## Auto-instrument

The TypeScript SDK wraps **client instances**, not modules globally.
Use `detectInstalledFrameworks()` to see what's installed, then call the
matching `wrap*` helper:

```ts
import {
  detectInstalledFrameworks,
  wrapOpenAI,
  wrapAnthropic,
  wrapVercelAI,
  wrapLangChain,
} from "@eden-ai/sdk";

const installed = detectInstalledFrameworks();
// if (installed.openai) { client = wrapOpenAI(new OpenAI()); }
```

`autoInstrument()` is an alias for `detectInstalledFrameworks()` kept for
v0.1 compatibility — it does **not** patch constructors. Call `wrap*`
before creating client instances you want traced.

## Per-framework wrappers

Prefer explicit wrappers over global monkey-patching in production
code — they're easier to grep for and easier to test.

### OpenAI

```ts
import { wrapOpenAI } from "@eden-ai/sdk";
import OpenAI from "openai";

const raw = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const openai = wrapOpenAI(raw, { tags: ["checkout"] });

const reply = await openai.chat.completions.create({
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: "Hello!" }],
});
```

### Anthropic

```ts
import { wrapAnthropic } from "@eden-ai/sdk";
import Anthropic from "@anthropic-ai/sdk";

const raw = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const anthropic = wrapAnthropic(raw, { tags: ["checkout"] });

const msg = await anthropic.messages.create({
  model: "claude-3-5-sonnet-20240620",
  max_tokens: 1024,
  messages: [{ role: "user", content: "Hello!" }],
});
```

### Vercel AI SDK

```ts
import { wrapVercelAI } from "@eden-ai/sdk";
import { openai } from "@ai-sdk/openai";
import { generateText } from "ai";

const ai = wrapVercelAI({ openai }, { tags: ["chat"] });

const { text } = await ai.generateText({
  model: ai.openai("gpt-4o-mini"),
  prompt: "Hello!",
});
```

### LangChain

```ts
import { wrapLangChain } from "@eden-ai/sdk";
import { ChatOpenAI } from "@langchain/openai";

const lc = wrapLangChain({ ChatOpenAI }, { tags: ["agent"] });

const model = new lc.ChatOpenAI({ modelName: "gpt-4o-mini" });
const reply = await model.invoke("Hello!");
```

## Tracing primitives

### `traceAgent` decorator

```ts
import { traceAgent } from "@eden-ai/sdk";

class MyAgent {
  @traceAgent({ name: "run", tags: ["prod"], environmentId: "env_abc" })
  async run(query: string) {
    return await fetch("/api/echo", { body: query });
  }
}
```

The decorator works on classes (TypeScript 5+ stage-3) and on plain
functions via `traceAgent({ name })`.

### `withTrace` helper

```ts
import { withTrace } from "@eden-ai/sdk";

const result = await withTrace({ name: "user-session" }, async (t) => {
  t.setAttribute("user_id", "u_abc");
  return await doWork();
});
```

### Manual spans

```ts
import { EdenSDK } from "@eden-ai/sdk";

const client = EdenSDK.instance();
const span = client.startSpan("retrieval");
span.setAttribute("k", 8);
try {
  // ...
  span.finish({ outcome: "success" });
} catch (e) {
  span.finish({ outcome: "error", error: String(e) });
  throw e;
}
```

## Edge runtime

The SDK runs on the Edge runtime (Vercel Edge, Cloudflare Workers)
with one caveat: the default `fetch`-based sender needs an
implementation that supports the Edge `fetch` signature. Import the
edge entry point explicitly:

```ts
import { configure, instrument } from "@eden-ai/sdk/edge";
```

This swaps the in-memory batcher for a `waitUntil`-based flush and
keeps p99 overhead under 5 ms.

## Errors

The SDK never throws on the hot path — telemetry failures are logged
and swallowed. The exceptions:

| Error | When |
|-------|------|
| `EdenConfigError` | Bad config on `configure()` |
| `IngestionError` | Background sender failed after retries |

## Versioning

The SDK follows SemVer. The wire format matches
[`POST /orgs/{org_id}/ingest/custom`](/reference/api-ingestion) and
is forward-compatible.