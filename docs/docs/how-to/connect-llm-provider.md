---
id: connect-llm-provider
title: Connect a custom LLM provider
sidebar_label: Connect a custom LLM provider
sidebar_position: 10
---

# How-to — Connect a custom LLM provider

The Eden AI gateway ships with first-class support for OpenAI,
Anthropic, OpenRouter, and any OpenAI-compatible upstream. For
anything else, you have two options:

1. **Wire format translation** — translate your upstream's
   request/response to OpenAI shape on the SDK side.
2. **Custom gateway endpoint** — register your upstream with the
   gateway and route through `gateway/v1/models`.

## Option 1 — Wire format translation (recommended)

Translate at the SDK boundary. The SDK only needs the OpenAI shape
to ingest correctly.

```python
import httpx
import eden

eden.configure(api_key="...", org_id="...")

async def my_llm(prompt: str, model: str) -> str:
    async with httpx.AsyncClient() as http:
        resp = await http.post(
            "https://my-upstream.example.com/v1/generate",
            json={"model": model, "prompt": prompt, "max_tokens": 256},
        )
        data = resp.json()
        # Translate to OpenAI chat completion shape.
        openai_shape = {
            "id": data["id"],
            "model": model,
            "choices": [{
                "index": 0,
                "message": {"role": "assistant", "content": data["text"]},
                "finish_reason": "stop",
            }],
            "usage": {
                "prompt_tokens": data["usage"]["input"],
                "completion_tokens": data["usage"]["output"],
                "total_tokens": data["usage"]["input"] + data["usage"]["output"],
            },
        }
        # Manually emit the OpenAI-shaped event.
        from eden_sdk import EventBuilder, Outcome
        await eden.ingest_openai(
            request={"model": model, "messages": [{"role": "user", "content": prompt}]},
            response=openai_shape,
            duration_ms=int((time.monotonic() - t0) * 1000),
            outcome=Outcome.Success,
        )
        return data["text"]
```

The portal's **Trace** view renders the OpenAI shape natively — you
get prompt / response / token counts / cost (if you've configured
your model's pricing) without any extra wiring.

## Option 2 — Custom gateway endpoint

For high-volume upstreams, register the model in the gateway's
config:

```yaml
# config/gateway.yaml
providers:
  my_upstream:
    base_url: https://my-upstream.example.com
    auth_header: "X-API-Key: ${MY_UPSTREAM_KEY}"
    path_translation:
      chat_completions: /v1/generate
      embeddings: /v1/embed
    response_translation: openai_chat   # translate to OpenAI shape on egress
    pricing:
      input_per_1k:  0.0001
      output_per_1k: 0.0002
```

Once registered, you can route through the gateway:

```bash
curl https://api.edenobservability.com/gateway/v1/chat/completions \
  -H "Authorization: Bearer sk_eden_..." \
  -H "X-Org-Id: org_abc" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "my_upstream/my-model-v1",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

The gateway:

- Authenticates with your upstream (`MY_UPSTREAM_KEY`).
- Translates the OpenAI request to your upstream's shape.
- Calls the upstream.
- Translates the response back to OpenAI shape.
- Records the call in `telemetry_events` with `source_format: "openai"`
  and `model: "my_upstream/my-model-v1"`.
- Applies caching (exact-match Redis, then semantic Qdrant).
- Applies the per-org token budget.
- Routes to the cheapest healthy provider if you've configured
  multiple upstreams for the same logical model.

### Pricing

Set per-model pricing in `config/gateway.yaml` so the cost intel
service can compute USD totals. If you omit pricing, the model
shows up in the **Traces** tab but with `cost_usd: null` and a
warning banner ("Pricing not configured for my_upstream/my-model-v1").

## Streaming

Both options support SSE streaming. The gateway emits
`source_format: "openai"` events with the standard
`data: {"choices": [{"delta": ...}]}` shape; the SDK ingests them
in 1 KiB chunks to avoid one-event-per-line overhead.

## Webhooks

If you've configured [webhooks](/reference/webhooks), ingest events
fire:

- `trace.started` — first event of a new trace
- `trace.completed` — terminal event
- `judge.threshold_breach` — judge score crosses your threshold

These are emitted regardless of which path (SDK or gateway) the
event came in on.

## Cost tracking

Custom providers are first-class in the cost intel dashboard.
Models you've configured pricing for show up in the **Cost → By
model** chart; models without pricing show up with the "Pricing not
configured" warning.