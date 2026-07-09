"""End-to-end smoke test of eden-sdk 0.2.6 from PyPI.

Stands up an in-process httpx MockTransport (no network),
configures eden-sdk to ship to it via EdenConfig.transport,
exercises the trace() API + synthetic auto-instrumentation events,
and asserts that every billing field lands on the wire.
"""
from __future__ import annotations

import json
import time
from collections import defaultdict
from typing import Any

import httpx

import eden
from eden_sdk.client import TraceEvent, get_default_client
from eden_sdk.config import EdenConfig


# ── In-process gateway mock ────────────────────────────────────────────

class GatewayMock:
    """Records every body POSTed to /ingest/* for inspection."""

    def __init__(self) -> None:
        self.events: dict[str, list[dict]] = defaultdict(list)
        self.chunks: list[dict] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        try:
            body = json.loads(request.content) if request.content else {}
        except Exception:
            body = {}
        if "/ingest/chunks" in url:
            for chunk in body.get("chunks", []):
                self.chunks.append(chunk)
            return httpx.Response(200, json={"accepted": len(body.get("chunks", []))})
        if "/ingest/" in url:
            fmt = url.split("/ingest/")[-1].split("?")[0]
            if isinstance(body, list):
                for ev in body:
                    self.events[fmt].append(ev)
            else:
                self.events[fmt].append(body)
            return httpx.Response(200, json={"accepted": 1})
        return httpx.Response(404, json={"error": f"unmocked: {url}"})


mock = GatewayMock()
transport = httpx.MockTransport(mock)


# ── Set up via the supported transport config field ────────────────────

eden.reset_config()
eden.configure(
    org_id="org_test_e2e",
    api_key="sk_test",
    base_url="http://mock-gateway.test",
    project_id="proj_test",
    redact_on_client=True,
    batch_size=1,
    transport=transport,  # ← supported path
)
client = eden.get_default_client()
client.start()

print(f"eden-sdk version: {eden.__version__}")
print(f"client enabled:   {client.config.enabled}")
print(f"client org_id:    {client.config.org_id}")
print(f"transport bound:  {client._transport is transport}")
print()


# ── Test 1: top-level token API ────────────────────────────────────────

print("=== Test 1: extract_usage + normalize_model_name ===")
from eden_sdk._tokens import extract_usage, normalize_model_name

usage = extract_usage({
    "prompt_tokens": 100,
    "completion_tokens": 50,
    "prompt_tokens_details": {"cached_tokens": 25},
})
assert usage == {"input_tokens": 100, "output_tokens": 50,
                 "cache_read_tokens": 25, "cache_creation_tokens": None}, usage
print(f"  extract_usage(anthropic + openai nested): {usage}")
assert normalize_model_name("gpt-4o-2024-08-06") == "gpt-4o"
assert normalize_model_name("claude-3-5-sonnet-20241022") == "claude-3-5-sonnet"
assert normalize_model_name("claude-3-5-sonnet-latest") == "claude-3-5-sonnet"
assert normalize_model_name("gpt-4o") == "gpt-4o"  # idempotent
print(f"  normalize_model_name strips dates + -latest aliases: PASS")
print()


# ── Test 2: trace() context manager ────────────────────────────────────

print("=== Test 2: trace() context manager ===")
with eden.trace("e2e-test-agent") as span:
    span.set_input({"q": "test"})
    span.set_output({"a": "ok"})
    span.set_tag("e2e")
    span.set_tag("env:live-pypi")

client.flush(timeout=2.0)
assert "framework" in mock.events, f"no framework event: {dict(mock.events)}"
ev = mock.events["framework"][0]
assert ev["name"] == "e2e-test-agent", ev
assert ev["event_type"] == "agent.run", ev
assert ev["input"] == {"q": "test"}, ev
assert ev["output"] == {"a": "ok"}, ev
print(f"  framework event: name={ev['name']!r}, type={ev['event_type']!r}, "
      f"input={ev['input']}, output={ev['output']}")
print("  PASS")
print()


# ── Test 3: OpenAI event with cache_read + model_normalized ────────────

print("=== Test 3: OpenAI event ships cache_read + model_normalized ===")
mock.events.clear()
synthetic_openai = {
    "event_id": "eden_openai_e2e_test",
    "trace_id": "trace_e2e_openai",
    "duration_ms": 42.0,
    "request_payload": {"model": "gpt-4o-2024-08-06",
                        "messages": [{"role": "user", "content": "Hello"}]},
    "model": "gpt-4o-2024-08-06",
    "model_normalized": "gpt-4o",
    "input_tokens": 10,
    "output_tokens": 7,
    "cache_read_input_tokens": 4,
    "cache_creation_input_tokens": None,
    "outcome": "success",
}
client.enqueue(TraceEvent(payload=synthetic_openai, source_format="openai"))
client.flush(timeout=2.0)
assert "openai" in mock.events
oev = mock.events["openai"][0]
assert oev["model"] == "gpt-4o-2024-08-06", oev
assert oev["model_normalized"] == "gpt-4o", oev
assert oev["input_tokens"] == 10, oev
assert oev["output_tokens"] == 7, oev
assert oev["cache_read_input_tokens"] == 4, oev
print(f"  openai event -> model={oev['model']!r} normalized={oev['model_normalized']!r} "
      f"in={oev['input_tokens']} out={oev['output_tokens']} cache_read={oev['cache_read_input_tokens']}")
print("  PASS")
print()


# ── Test 4: streaming chunks ship to /ingest/chunks ────────────────────

print("=== Test 4: OpenAI streaming chunks ship to /ingest/chunks ===")
mock.chunks.clear()
deltas = ["Hello", " from", " streaming", " chunks", "!"]
for i, delta in enumerate(deltas):
    client._chunk_buffer.append({
        "event_id": "eden_stream_openai_e2e",
        "trace_id": "trace_e2e_stream",
        "chunk_index": i,
        "delta_text": delta,
        "received_at_client_ms": int(time.time() * 1000),
    })

client._chunk_wake.set()
client.flush(timeout=2.0)
assert len(mock.chunks) == len(deltas), f"expected {len(deltas)}, got {len(mock.chunks)}"
reconstructed = "".join(c["delta_text"] for c in mock.chunks)
assert reconstructed == "Hello from streaming chunks!", reconstructed
print(f"  {len(mock.chunks)} chunks shipped, reconstructed: {reconstructed!r}")
print("  PASS")
print()


# ── Test 5: PII redactor masks emails in chunks ────────────────────────

print("=== Test 5: PII redactor masks emails in chunks ===")
mock.chunks.clear()
client._chunk_buffer.append({
    "event_id": "eden_pii_chunk_test",
    "trace_id": "trace_pii",
    "chunk_index": 0,
    "delta_text": "Reach me at foo@example.com or bar+filter@eden.dev",
    "received_at_client_ms": int(time.time() * 1000),
})
client._chunk_wake.set()
client.flush(timeout=2.0)
assert len(mock.chunks) == 1
text = mock.chunks[0]["delta_text"]
assert "foo@example.com" not in text, f"email leaked: {text!r}"
assert "bar+filter@eden.dev" not in text, f"email leaked: {text!r}"
assert "[REDACTED]" in text, f"redaction marker missing: {text!r}"
print(f"  masked: {text!r}")
print("  PASS")
print()


# ── Test 6: Anthropic event with cache_creation + cache_read ──────────

print("=== Test 6: Anthropic event ships cache_creation + cache_read ===")
mock.events.clear()
synthetic_anthropic = {
    "event_id": "eden_anthropic_e2e_test",
    "trace_id": "trace_e2e_anthropic",
    "duration_ms": 100.0,
    "stream": True,
    "model": "claude-3-5-sonnet-20241022",
    "model_normalized": "claude-3-5-sonnet",
    "input_tokens": 50,
    "output_tokens": 30,
    "cache_read_input_tokens": 200,
    "cache_creation_input_tokens": 100,
    "outcome": "success",
}
client.enqueue(TraceEvent(payload=synthetic_anthropic, source_format="anthropic"))
client.flush(timeout=2.0)
assert "anthropic" in mock.events
aev = mock.events["anthropic"][0]
assert aev["model"] == "claude-3-5-sonnet-20241022", aev
assert aev["model_normalized"] == "claude-3-5-sonnet", aev
assert aev["input_tokens"] == 50
assert aev["output_tokens"] == 30
assert aev["cache_read_input_tokens"] == 200
assert aev["cache_creation_input_tokens"] == 100
print(f"  anthropic event -> model={aev['model']!r} normalized={aev['model_normalized']!r} "
      f"in={aev['input_tokens']} out={aev['output_tokens']} "
      f"cache_read={aev['cache_read_input_tokens']} cache_creation={aev['cache_creation_input_tokens']}")
print("  PASS")
print()


# ── Test 7: validate() raises loudly on missing org_id ────────────────

print("=== Test 7: EdenConfig.validate() raises on missing org_id ===")
try:
    EdenConfig(org_id=None, dry_run=False, disabled=False).validate()
    assert False, "should have raised"
except ValueError as e:
    msg = str(e)
    assert "org_id is required" in msg, msg
    print(f"  raised: {msg[:80]}...")
print("  PASS")
print()


# ── Test 8: counter surfaces for callers ───────────────────────────────

print("=== Test 8: counters surface for caller-side throttling ===")
sent = client.sent
failed = client.failed
dropped = client.dropped
print(f"  sent={sent} failed={failed} dropped={dropped}")
assert sent > 0, "expected sent > 0"
print("  PASS")
print()


# ── Test 9: top-level re-exports work ─────────────────────────────────

print("=== Test 9: top-level re-exports ===")
assert eden.extract_usage is extract_usage
assert eden.normalize_model_name is normalize_model_name
assert eden.Span is not None
assert eden.TraceContext is not None
assert eden.EdenConfig is EdenConfig
print(f"  eden.extract_usage, eden.normalize_model_name, eden.Span, eden.TraceContext, eden.EdenConfig: all available")
print("  PASS")
print()


# ── Summary ────────────────────────────────────────────────────────────

print("=" * 60)
print(f"All 9 e2e tests passed. Live eden-sdk 0.2.6 from PyPI works.")
print(f"Events shipped to mock gateway:")
for fmt, events in mock.events.items():
    print(f"  /ingest/{fmt:12s}: {len(events)} event(s)")
print(f"  /ingest/chunks    : {len(mock.chunks)} chunk(s)")
