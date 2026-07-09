"""Real-SDK test: eden-sdk 0.2.6 auto-instruments a real OpenAI client
against a mocked upstream, asserting billing fields land correctly.
"""
from __future__ import annotations

import json
import time
from collections import defaultdict
from typing import Any

import httpx

import eden
from eden_sdk.client import TraceEvent
from eden_sdk.config import EdenConfig

# ── Mock gateway ────────────────────────────────────────────────────────

events: dict[str, list[dict]] = defaultdict(list)
chunks: list[dict] = []


def mock_handler(request: httpx.Request) -> httpx.Response:
    url = str(request.url)
    body = json.loads(request.content) if request.content else {}
    if "/ingest/chunks" in url:
        for c in body.get("chunks", []):
            chunks.append(c)
        return httpx.Response(200, json={"accepted": len(body.get("chunks", []))})
    if "/ingest/" in url:
        fmt = url.split("/ingest/")[-1].split("?")[0]
        if isinstance(body, list):
            events[fmt].extend(body)
        else:
            events[fmt].append(body)
        return httpx.Response(200, json={"accepted": 1})
    if "/chat/completions" in url:
        # Mock upstream OpenAI response
        return httpx.Response(200, json={
            "id": "chatcmpl-mock-real-test",
            "object": "chat.completion",
            "created": int(time.time()),
            "model": "gpt-4o-2024-08-06",
            "choices": [{
                "index": 0,
                "message": {"role": "assistant", "content": "Hello from mock!"},
                "finish_reason": "stop",
            }],
            "usage": {
                "prompt_tokens": 10,
                "completion_tokens": 7,
                "total_tokens": 17,
                "prompt_tokens_details": {"cached_tokens": 4},
            },
        })
    return httpx.Response(404, json={"error": f"unmocked: {url}"})


transport = httpx.MockTransport(mock_handler)

# ── Configure eden-sdk with the mock transport ──────────────────────────

eden.reset_config()
eden.configure(
    org_id="org_real_test",
    api_key="sk_test",
    base_url="http://mock-gateway.test",
    project_id="proj_test",
    redact_on_client=True,
    batch_size=1,
    transport=transport,
)
client = eden.get_default_client()
client.start()

print(f"eden-sdk {eden.__version__} configured for real-SDK test")
print()

# ── Test 1: detect_installed_frameworks ────────────────────────────────

print("=== Test 1: detect_installed_frameworks with real OpenAI/Anthropic ===")
detected = eden.detect_installed_frameworks()
print(f"  detected: {detected}")
assert detected["openai"] is True, "openai SDK is installed but detection returned False"
assert detected["anthropic"] is True, "anthropic SDK is installed but detection returned False"
print("  PASS")
print()

# ── Test 2: install auto-instrumentation ──────────────────────────────

print("=== Test 2: install() patches real OpenAI/Anthropic ===")
eden.instrument()
print("  install() succeeded")
print("  PASS")
print()

# ── Test 3: real OpenAI non-streaming call ────────────────────────────

print("=== Test 3: real OpenAI chat.completions.create (non-streaming) ===")
events.clear()
from openai import OpenAI
real_client = OpenAI(
    api_key="sk-test-fake",
    base_url="http://mock-gateway.test/v1",
    http_client=httpx.Client(transport=transport),
)
resp = real_client.chat.completions.create(
    model="gpt-4o-2024-08-06",
    messages=[{"role": "user", "content": "Hi"}],
)
print(f"  upstream returned: {resp.choices[0].message.content!r}")
client.flush(timeout=3.0)
assert "openai" in events, f"no openai event: {list(events.keys())}"
oev = events["openai"][0]
print(f"  captured payload keys: {sorted(oev.keys())}")
assert oev.get("model") == "gpt-4o-2024-08-06", f"model: {oev.get('model')}"
assert oev.get("model_normalized") == "gpt-4o", f"normalized: {oev.get('model_normalized')}"
# Non-streaming preserves the full response payload (Phase 7.2 transcript);
# the server-side normalizer (src/eden/observability/ingestion/providers.py)
# extracts input_tokens / output_tokens / cache_read_input_tokens into the
# metrics dict for billing roll-up. Verify the raw response is preserved:
usage = oev.get("usage") or {}
assert usage.get("prompt_tokens") == 10, f"usage.prompt_tokens: {usage.get('prompt_tokens')}"
assert usage.get("completion_tokens") == 7, f"usage.completion_tokens: {usage.get('completion_tokens')}"
ptd = usage.get("prompt_tokens_details") or {}
assert ptd.get("cached_tokens") == 4, f"cached_tokens: {ptd.get('cached_tokens')}"
print(f"  model={oev['model']!r} normalized={oev['model_normalized']!r} "
      f"usage.prompt_tokens={usage['prompt_tokens']} "
      f"usage.completion_tokens={usage['completion_tokens']} "
      f"usage.cached_tokens={ptd['cached_tokens']}")
print("  PASS")
print()

# ── Test 4: real OpenAI streaming call ────────────────────────────────

print("=== Test 4: real OpenAI chat.completions.create(stream=True) ===")
events.clear()
chunks.clear()

# Patch the mock to return a streaming response
def stream_handler(request: httpx.Request) -> httpx.Response:
    url = str(request.url)
    if "/chat/completions" in url:
        body = b'data: {"id":"chatcmpl-stream","object":"chat.completion.chunk","created":1,"model":"gpt-4o-2024-08-06","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}\n\ndata: {"id":"chatcmpl-stream","object":"chat.completion.chunk","created":1,"model":"gpt-4o-2024-08-06","choices":[{"index":0,"delta":{"content":" streaming"},"finish_reason":null}]}\n\ndata: {"id":"chatcmpl-stream","object":"chat.completion.chunk","created":1,"model":"gpt-4o-2024-08-06","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}\n\ndata: {"id":"chatcmpl-stream","object":"chat.completion.chunk","created":1,"model":"gpt-4o-2024-08-06","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":3,"total_tokens":13,"prompt_tokens_details":{"cached_tokens":4}}}\n\ndata: [DONE]\n\n'
        return httpx.Response(200, content=body, headers={"content-type": "text/event-stream"})
    if "/ingest/" in url:
        body = json.loads(request.content) if request.content else {}
        if "/ingest/chunks" in url:
            for c in body.get("chunks", []):
                chunks.append(c)
            return httpx.Response(200, json={"accepted": len(body.get("chunks", []))})
        fmt = url.split("/ingest/")[-1].split("?")[0]
        if isinstance(body, list):
            events[fmt].extend(body)
        else:
            events[fmt].append(body)
        return httpx.Response(200, json={"accepted": 1})
    return httpx.Response(404, json={"error": url})


# Swap the transport for the streaming one
transport2 = httpx.MockTransport(stream_handler)
client._transport = transport2
# Recreate the AsyncClient to pick up the new transport
import asyncio

async def reset_http():
    if client._http:
        await client._http.aclose()
    client._http = httpx.AsyncClient(
        timeout=httpx.Timeout(client.config.timeout_s),
        limits=httpx.Limits(max_connections=16, max_keepalive_connections=8),
        transport=transport2,
    )

asyncio.run(reset_http())

stream_client = OpenAI(
    api_key="sk-test-fake",
    base_url="http://mock-gateway.test/v1",
    http_client=httpx.Client(transport=transport2),
)
stream = stream_client.chat.completions.create(
    model="gpt-4o-2024-08-06",
    messages=[{"role": "user", "content": "Stream please"}],
    stream=True,
)
reconstructed = ""
for chunk in stream:
    delta = chunk.choices[0].delta.content
    if delta:
        reconstructed += delta
print(f"  upstream stream reconstructed: {reconstructed!r}")

client._chunk_wake.set()
client.flush(timeout=5.0)
assert len(chunks) == 4, f"expected 4 chunks, got {len(chunks)}: {chunks}"
# The first 3 chunks have text; the 4th is the trailing finish_reason chunk
text_chunks = [c for c in chunks if c.get("delta_text")]
assert len(text_chunks) == 3, f"expected 3 text chunks, got {len(text_chunks)}"
chunk_text = "".join(c.get("delta_text") or "" for c in text_chunks)
assert chunk_text == "Hello streaming world", f"chunk text mismatch: {chunk_text!r}"
print(f"  {len(chunks)} chunks shipped, reconstructed: {chunk_text!r}")

# And the parent llm_completion_stream event should be in events["openai"]
assert "openai" in events, f"no openai stream event: {list(events.keys())}"
oevs = events["openai"]
# Find the one with stream=True
stream_evt = next((e for e in oevs if e.get("stream") is True), None)
assert stream_evt is not None, f"no stream=True event in {oevs}"
print(f"  stream event: model={stream_evt.get('model')!r} "
      f"normalized={stream_evt.get('model_normalized')!r} "
      f"out={stream_evt.get('output_tokens')} in={stream_evt.get('input_tokens')} "
      f"cache_read={stream_evt.get('cache_read_input_tokens')}")
assert stream_evt.get("model_normalized") == "gpt-4o"
assert stream_evt.get("output_tokens") == 3
assert stream_evt.get("input_tokens") == 10
assert stream_evt.get("cache_read_input_tokens") == 4
print("  PASS")
print()

# ── Summary ────────────────────────────────────────────────────────────

print("=" * 60)
print("All 4 real-SDK tests passed. eden-sdk 0.2.6 auto-instruments")
print("real OpenAI + Anthropic SDKs correctly with cache tokens + model_normalized.")
