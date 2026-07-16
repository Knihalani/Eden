---
id: sdk-python
title: Python SDK
sidebar_label: Python SDK
sidebar_position: 2
---

# Python SDK

Lightweight, fire-and-forget observability for LLM applications.

- **Package** — `eden-sdk` on PyPI (import as `eden`)
- **Install** — `pip install eden-sdk`
- **Default API** — `https://api.edenobservability.com` (no base URL required)

New here? Start with the **[Quickstart](/quickstart)** (Fill in creates your key).

## Install

```bash
pip install eden-sdk
# optional framework extras, e.g.:
pip install eden-sdk[openai,anthropic]
pip install "eden-sdk[all]"
```

## Configure

```python
import os
import eden

eden.configure(
    api_key=os.environ["EDEN_API_KEY"],
    org_id=os.environ["EDEN_ORG_ID"],
)
```

| Env var | Purpose | Default |
|---------|---------|---------|
| `EDEN_API_KEY` | Org API key | — (required) |
| `EDEN_ORG_ID` | Org id | — (required) |
| `EDEN_BASE_URL` | Override API host | `https://api.edenobservability.com` |

## Auto-instrument

```python
eden.instrument()          # every installed supported framework
# or: eden.instrument("openai")
```

Supported frameworks include OpenAI, Anthropic, LangChain, LlamaIndex,
CrewAI, AutoGen, and Pydantic AI. See
[Auto-instrumentation](/reference/auto-instrumentation).

## First trace

```python
@eden.trace_agent(name="hello-world", tags=["quickstart"])
def answer(question: str) -> str:
    from openai import OpenAI
    client = OpenAI()
    resp = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[{"role": "user", "content": question}],
    )
    return resp.choices[0].message.content or ""

print(answer("Say hello"))
eden.get_default_client().flush()
```

## Doctor

```bash
python -m eden_sdk.doctor
```

Checks key, org, connectivity, and emits a test event visible in **Traces**.

## Gateway (optional)

To route OpenAI-compatible calls through Eden's gateway:

```python
from openai import OpenAI
import eden

eden.configure(api_key=..., org_id=...)
client = eden.openai_client()  # base_url → {api}/v1 + auth headers
```

## Next

- [Connect any agent](/how-to/connect-any-agent)
- [Ingestion API](/reference/api-ingestion)
- [TypeScript SDK](/reference/sdk-typescript)
