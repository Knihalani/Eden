---
title: Quickstart
description: From signup to your first trace in under five minutes.
sidebar_position: 2
---

# Quickstart

Get from zero to a live trace in under five minutes. Eden is **cloud-only** —
the control plane is not self-hosted.

## Fastest path (recommended)

1. Sign in at [edenobservability.com](https://edenobservability.com).
2. Open **[Quickstart](https://edenobservability.com/quickstart)** in the portal.
3. Click **Fill in** — Eden creates an API key (if needed) and writes it into the
   snippet with your org id.
4. **Copy**, paste into your project, and run.
5. Open **Traces** — `hello-world` should appear within about a minute.

No `EDEN_BASE_URL` required. The SDKs default to
`https://api.edenobservability.com`.

## Manual setup

If you prefer env vars:

1. Open **Settings → API Keys** and create a key (secret shown once).
2. Copy your **Organization ID** from the same page.

```bash
export EDEN_API_KEY="sk_eden_…"
export EDEN_ORG_ID="org_…"
```

```bash
# Python
pip install eden-sdk
python -m eden_sdk.doctor

# TypeScript
npm install @eden-ai/sdk
npx @eden-ai/sdk doctor
```

### Python

```python
import os
import eden

eden.configure(
    api_key=os.environ["EDEN_API_KEY"],
    org_id=os.environ["EDEN_ORG_ID"],
)

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

## Next

- [Connect any agent](/how-to/connect-any-agent)
- [Python SDK reference](/reference/sdk-python)
- [TypeScript SDK reference](/reference/sdk-typescript)
