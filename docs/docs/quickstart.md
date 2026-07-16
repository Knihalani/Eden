---
title: Quickstart
description: From signup to your first trace in under five minutes.
sidebar_position: 2
---

# Quickstart

Get from zero to a live trace in your dashboard in under five minutes.
Eden is a **cloud product** — you do not self-host the control plane.

## 1. Sign up & create an API key

1. Sign up at [edenobservability.com](https://edenobservability.com).
2. Open **Settings → API Keys** (or finish the product tour — it ends there).
3. Click **Create API key**. Copy the secret immediately — it is shown once.
4. Copy your **Organization ID** from the same page.

```bash
export EDEN_API_KEY="sk_eden_…"
export EDEN_ORG_ID="org_…"
export EDEN_BASE_URL="https://api.edenobservability.com"
```

Issue one key per environment (`prod`, `staging`, `dev`) and rotate them
from **Settings → API Keys**.

## 2. Install the SDK

Pick whichever matches your service. Both write to the same cloud ingestion
endpoint.

```bash
# Python
pip install eden-sdk

# TypeScript / Node / Bun
npm install @eden-ai/sdk
```

### Validate your setup

```bash
# Python
python -m eden_sdk.doctor

# TypeScript
npx @eden-ai/sdk doctor
```

Doctor checks API key, org id, gateway connectivity, and emits a
test event you can find in **Traces**.

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
    return resp.choices[0].message.content or ""

if __name__ == "__main__":
    print(answer("Say hello in five languages"))
    eden.get_default_client().flush()
```

### TypeScript

```ts
import { configure, instrument, trace } from "@eden-ai/sdk";
import OpenAI from "openai";

configure({
  apiKey: process.env.EDEN_API_KEY!,
  orgId: process.env.EDEN_ORG_ID!,
  baseUrl: process.env.EDEN_BASE_URL ?? "https://api.edenobservability.com",
});

instrument();

async function greet(question: string) {
  return trace("hello-world", async (ctx) => {
    ctx.setTag("quickstart");
    ctx.setInput({ question });
    const client = new OpenAI();
    const resp = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: question }],
    });
    const answer = resp.choices[0]?.message?.content ?? "";
    ctx.setOutput({ answer });
    return answer;
  });
}

greet("Say hello in five languages").then(console.log);
```

## 4. Confirm in the portal

Open **Traces** — you should see `hello-world` within about a minute.
If nothing appears, re-run doctor and check that `EDEN_BASE_URL` points at
`https://api.edenobservability.com`.

## Next

- [Connect any agent](/how-to/connect-any-agent)
- [Python SDK reference](/reference/sdk-python)
- [TypeScript SDK reference](/reference/sdk-typescript)
