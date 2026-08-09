---
id: auto-instrument
title: Instrument an existing repo
sidebar_label: Instrument an existing repo
sidebar_position: 8
---

# How-to — Instrument an existing repo

Eden does **not** open auto-integrate PRs against your GitHub repos.
You add the SDK yourself (or with your own tooling). Typical path:

1. [Quickstart](/quickstart) — Fill in creates a key and a runnable snippet.
2. [Connect any agent](/how-to/connect-any-agent) — pick native wrap, HTTP
   capture, or manual `trace_agent`.
3. Confirm under **Traces** in the portal.

## Minimum Python change

```python
import os
import eden

eden.configure(
    api_key=os.environ["EDEN_API_KEY"],
    org_id=os.environ["EDEN_ORG_ID"],
)
eden.instrument()  # patches installed frameworks (OpenAI, Anthropic, …)

@eden.trace_agent(name="checkout")
def run(user_input: str) -> str:
    from openai import OpenAI
    client = OpenAI()
    resp = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[{"role": "user", "content": user_input}],
    )
    return resp.choices[0].message.content or ""
```

```bash
pip install eden-sdk openai
export EDEN_ORG_ID="…"
export EDEN_API_KEY="…"
python -m eden_sdk.doctor   # or: eden-doctor
```

## Minimum TypeScript change

```ts
import { configure, instrument, getDefaultClient } from "@eden-ai/sdk";
import OpenAI from "openai";

configure({
  apiKey: process.env.EDEN_API_KEY!,
  orgId: process.env.EDEN_ORG_ID!,
});

// Prototype-patches OpenAI/Anthropic; returns wrap* for other frameworks.
const { wrapOpenAI, patched } = instrument();
const openai = patched.openai ? new OpenAI() : wrapOpenAI(new OpenAI());

const reply = await openai.chat.completions.create({
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: "Hello" }],
});

await getDefaultClient().flush();  // or dispose() on shutdown
```

```bash
export EDEN_ORG_ID="…" EDEN_ORG_API_KEY="…"
npx eden-doctor
```

## Framework matrix

See [Auto-instrumentation](/reference/auto-instrumentation) for the
supported frameworks and what each wrapper captures.

## GitHub

Connecting GitHub (Settings → Integrations) is for repo linkage and
agent metadata — **not** for automatic PR wiring. See
[Connect GitHub](/how-to/github).
