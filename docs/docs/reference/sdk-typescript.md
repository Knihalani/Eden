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
- **Install** — `npm install @eden-ai/sdk`
- **Default API** — `https://api.edenobservability.com` (no base URL required)

New here? Start with the **[Quickstart](/quickstart)** (Fill in creates your key).

## Install

```bash
npm install @eden-ai/sdk
# or: pnpm add / bun add / yarn add @eden-ai/sdk
```

## Configure

```ts
import { configure } from "@eden-ai/sdk";

configure({
  apiKey: process.env.EDEN_API_KEY!,
  orgId: process.env.EDEN_ORG_ID!,
  // baseUrl optional — defaults to https://api.edenobservability.com
});
```

| Env var | Purpose | Default |
|---------|---------|---------|
| `EDEN_API_KEY` | Org API key | — (required) |
| `EDEN_ORG_ID` | Org id | — (required) |
| `EDEN_BASE_URL` | Override API host | `https://api.edenobservability.com` |

## Instrument

```ts
import { configure, instrument, wrapOpenAI } from "@eden-ai/sdk";
import OpenAI from "openai";

configure({
  apiKey: process.env.EDEN_API_KEY!,
  orgId: process.env.EDEN_ORG_ID!,
});

const { wrapOpenAI: wrap } = instrument(); // enables HTTP capture + returns wrap helpers
const openai = wrap(new OpenAI());
```

Or call wrappers directly:

```ts
import { wrapOpenAI, wrapAnthropic, wrapVercelAI, wrapLangChain } from "@eden-ai/sdk";
```

The TypeScript SDK wraps **client instances** (not global module
exports). Prefer `wrap*` in production code.

### OpenAI

```ts
import { wrapOpenAI } from "@eden-ai/sdk";
import OpenAI from "openai";

const openai = wrapOpenAI(new OpenAI());
await openai.chat.completions.create({
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: "Hello!" }],
});
```

### Anthropic

```ts
import { wrapAnthropic } from "@eden-ai/sdk";
import Anthropic from "@anthropic-ai/sdk";

const anthropic = wrapAnthropic(new Anthropic());
await anthropic.messages.create({
  model: "claude-3-5-sonnet-20240620",
  max_tokens: 1024,
  messages: [{ role: "user", content: "Hello!" }],
});
```

## Tracing primitives

```ts
import { configure, trace, getDefaultClient } from "@eden-ai/sdk";

configure({ apiKey: process.env.EDEN_API_KEY!, orgId: process.env.EDEN_ORG_ID! });

await trace("hello-world", async (ctx) => {
  ctx.setTag("quickstart");
  ctx.setInput({ question: "hi" });
  // ... work ...
  ctx.setOutput({ answer: "hello" });
});

await getDefaultClient().flush();
```

Also available: `traceAgent` for class methods.

## Doctor

```bash
npx @eden-ai/sdk doctor
```

## Gateway (optional)

```ts
import { openaiClient } from "@eden-ai/sdk";

const client = openaiClient(); // OpenAI-compatible client → Eden gateway
```

## Next

- [Connect any agent](/how-to/connect-any-agent)
- [Ingestion API](/reference/api-ingestion)
- [Python SDK](/reference/sdk-python)
