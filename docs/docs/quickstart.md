---
title: Quickstart
description: From signup to your first trace in under five minutes.
sidebar_position: 2
---

# Quickstart

Get from zero to a live trace in your dashboard in under five minutes.

## 1. Sign up & grab a key

1. Sign up at the portal (cloud or self-hosted — see
   [How-to → Deploy](/how-to/deploy) for the self-host path).
2. The wizard creates your first org and reveals an API key. Copy
   it — it's shown once.

```bash
export EDEN_API_KEY="sk_eden_…"
export EDEN_ORG_ID="org_…"
export EDEN_BASE_URL="https://api.edenobservability.com"   # cloud default
```

The API key is per-org. You'll issue one per environment
(`prod`, `staging`, `dev`) and rotate them from the portal's
Settings → API Keys page.

## 2. Install the SDK

Pick whichever matches your service. The two production SDKs both
write to the same ingestion endpoint.

```bash
# Python
pip install eden-sdk

# TypeScript / Node / Bun
npm install @eden-ai/sdk
```

## 3. Send your first trace

### Python

```python
import os
import eden

eden.configure(
    api_key=os.environ["EDEN_API_KEY"],
    org_id=os.environ["EDEN_ORG_ID"],
    base_url=os.environ.get("EDEN_BASE_URL", "https://api.edenobservability.com"),
)

# One call to auto-instrument every installed framework.
eden.instrument()

@eden.trace_agent(name="hello-world", tags=["quickstart"])
def answer(question: str) -> str:
    from openai import OpenAI
    client = OpenAI()
    resp = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[{"role": "user", "content": question}],
    )
    return resp.choices[0].message.content

if __name__ == "__main__":
    print(answer("Say hello in five languages"))
```

### TypeScript

```ts
import { configure, instrument, traceAgent } from "@eden-ai/sdk";

configure({
  apiKey: process.env.EDEN_API_KEY!,
  orgId: process.env.EDEN_ORG_ID!,
  baseUrl: process.env.EDEN_BASE_URL,
});

instrument(); // patches OpenAI, Anthropic, Vercel AI, LangChain

class Greeter {
  @traceAgent({ name: "hello-world", tags: ["quickstart"] })
  async greet(question: string) {
    const openai = (await import("openai")).default;
    const client = new openai();
    const resp = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: question }],
    });
    return resp.choices[0].message.content;
  }
}

new Greeter().greet("Say hello in five languages");
```

### Go

```go
package main

import (
    "context"
    "os"
    eden "github.com/eden-ai/eden-go"
    "github.com/eden-ai/eden-go/openai"
    openaipkg "github.com/sashabaranov/go-openai"
)

func main() {
    eden.Configure(eden.ConfigFromEnv())

    inner := openaipkg.NewClient(os.Getenv("OPENAI_API_KEY"))
    client := openai.Wrap(inner)

    resp, err := client.CreateChatCompletion(context.Background(), openaipkg.ChatCompletionRequest{
        Model: openaipkg.GPT4oMini,
        Messages: []openaipkg.ChatCompletionMessage{{
            Role: openaipkg.ChatMessageRoleUser,
            Content: "Say hello in five languages",
        }},
    })
    if err != nil {
        panic(err)
    }
    println(resp.Choices[0].Message.Content)
}
```

### Rust

```rust
use eden::{openai, Client, Config};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cfg = Config::from_env()?;
    let client = Client::new(cfg)?;

    let response = openai::wrap(&client, "gpt-4o-mini", &serde_json::json!({
        "choices": [{"message": {"role": "assistant", "content": "Hello"}}],
    })).await?;

    println!("{response}");
    Ok(())
}
```

## 4. See it in the portal

Open the portal's **Traces** tab. Your trace appears within a second.
Click into it to see the per-step latency, cost, tokens, model,
prompt, and response.

> **Not appearing?** Check the **Settings → Diagnostics** page — it
> shows the last 10 ingestion errors for your org. Most are a wrong
> org id (`X-Org-Id` header) or a typo in the API key.

## What's next

- [Tutorial: auto-instrument a real OpenAI app](/tutorials/auto-instrument-openai)
- [Tutorial: trace a multi-agent run](/tutorials/trace-multi-agent)
- [Tutorial: judge a model output](/tutorials/judge-model-output)
- [How-to: open the dashboard, build your first eval](/how-to/judges)

## Common gotchas

| Error | Cause | Fix |
|-------|-------|-----|
| `401 unauthorized` | Missing `X-Org-Id` header (raw `curl`) | SDKs set this automatically; otherwise add `-H "X-Org-Id: $EDEN_ORG_ID"` |
| `429 too many requests` | Default per-tenant rate limit (60 req/60 s) | Upgrade the plan in Settings → Billing, or batch via the SDK's auto-buffering |
| Trace truncated at 5 MiB | Ingestion body cap | Chunk the trace, or pre-redact with `eden.redact(body)` |
| `org_id not found` | API key is for org A but request is scoped to org B | Issue per-env keys from the portal; never share keys across orgs |