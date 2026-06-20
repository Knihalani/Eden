---
id: auto-instrument-openai
title: Auto-instrument an OpenAI app
sidebar_label: Auto-instrument OpenAI
sidebar_position: 2
---

# Tutorial — Auto-instrument an OpenAI app

Time: **15 minutes**. By the end you'll have a working OpenAI chat
script that sends full traces to Eden with one line of code.

## What you'll build

A small command-line "FAQ bot" that answers a question with a few
shots, and a dashboard trace showing every LLM call with prompt,
response, tokens, cost, and latency.

## Step 1 — Set up

```bash
mkdir eden-faq-bot && cd eden-faq-bot
python -m venv .venv && source .venv/bin/activate
pip install eden-sdk openai
```

```bash
export EDEN_API_KEY="sk_eden_..."
export EDEN_ORG_ID="org_..."
export OPENAI_API_KEY="sk-..."
```

## Step 2 — Write the bot (uninstrumented)

```python
# bot.py
import os
from openai import OpenAI

client = OpenAI()

FAQ = [
    "Refund policy: 30 days, no questions asked.",
    "Shipping: 3-5 business days, free over $50.",
    "Support: help@acme.com or chat 24/7.",
]

def answer(question: str) -> str:
    resp = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {"role": "system", "content": "You are a helpful FAQ bot.\n" + "\n".join(FAQ)},
            {"role": "user", "content": question},
        ],
    )
    return resp.choices[0].message.content

if __name__ == "__main__":
    print(answer(input("Ask: ")))
```

Run it to confirm it works:

```bash
python bot.py
Ask: How long does shipping take?
Shipping takes 3-5 business days, and is free over $50.
```

## Step 3 — Add Eden (two lines)

```python
# bot.py
import os
import eden
from openai import OpenAI

eden.configure(
    api_key=os.environ["EDEN_API_KEY"],
    org_id=os.environ["EDEN_ORG_ID"],
)
eden.instrument()      # ← this patches openai globally

client = OpenAI()

FAQ = [...]

@eden.trace_agent(name="faq-bot")   # ← every bot invocation becomes one trace
def answer(question: str) -> str:
    resp = client.chat.completions.create(...)
    return resp.choices[0].message.content
```

Run it again. Same answers, but now the portal is recording every
call.

## Step 4 — See it in the portal

Open the portal's **Traces** tab. You should see a new row called
`faq-bot`. Click into it:

- **Timeline** shows the LLM call as one span (`openai.chat.completions`)
  with start/end, model, and a snippet of the prompt.
- **Tokens + cost** shows input/output token counts and the dollar
  cost (computed from Eden's model pricing table).
- **Latency** shows the wall-clock duration of the LLM call.

## Step 5 — Add attributes

Attributes show up in the portal's filter bar and get indexed for
search. Add a user id:

```python
@eden.trace_agent(name="faq-bot", attributes={"surface": "cli", "version": "1.0.0"})
def answer(question: str, user_id: str) -> str:
    eden.set_attribute("user_id", user_id)
    resp = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[...],
    )
    eden.set_attribute("input_tokens", resp.usage.prompt_tokens)
    return resp.choices[0].message.content

if __name__ == "__main__":
    import sys
    print(answer(input("Ask: "), user_id=sys.argv[1] if len(sys.argv) > 1 else "anon"))
```

Now `user_id` is searchable and you can scope the **Traces** tab to a
specific user.

## Step 6 — Tag and group runs

```python
@eden.trace_agent(name="faq-bot", tags=["prod", "support"], version="1.0.0")
def answer(...): ...
```

Tags are free-form strings — use them for environment (`prod`,
`staging`), feature area (`support`, `checkout`), or anything else.

## What you learned

- `eden.configure(...)` reads env vars and sets up the SDK.
- `eden.instrument()` patches the OpenAI client globally — no
  per-call code.
- `@eden.trace_agent(...)` wraps a function as a top-level span;
  LLM calls inside it become child spans automatically.
- `eden.set_attribute(...)` adds metadata that the portal indexes.
- `tags=[...]` are searchable.

## Where next

- [Tutorial — Trace a multi-agent run](/tutorials/trace-multi-agent)
- [Tutorial — Judge a model output](/tutorials/judge-model-output)
- [How-to — Set a PII policy](/how-to/pii) so prompts and
  responses get redacted before they reach the portal
- [Reference — Auto-instrumentation matrix](/reference/auto-instrumentation)