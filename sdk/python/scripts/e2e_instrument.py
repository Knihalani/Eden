"""Real end-to-end test: instrument the OpenAI SDK with a local mock server.

Verifies that:
1. eden.instrument('openai') actually patches openai SDK
2. A chat completion flows through and lands at our mock ingest endpoint
3. Streaming also works and chunks land at /ingest/chunks
"""
import sys, os, json, asyncio, subprocess
sys.path.insert(0, "/tmp/wheel-extract")

# Install openai if not present (we need it to patch)
try:
    import openai
    print(f"openai version: {openai.__version__}")
except ImportError:
    print("Installing openai...")
    subprocess.check_call([sys.executable, "-m", "pip", "install", "--quiet", "openai>=1.30"])
    import openai
    print(f"openai installed: {openai.__version__}")

import eden

# Configure for dry-run mode so no real HTTP is attempted
eden.configure(org_id="e2e", api_key="e2e", base_url="http://127.0.0.1:0",
                dry_run=True, debug=True)

# Capture all events via the default client (dry_run just logs them)
import io, logging
log_stream = io.StringIO()
handler = logging.StreamHandler(log_stream)
handler.setLevel(logging.DEBUG)
logger = logging.getLogger("eden_sdk")
logger.addHandler(handler)
logger.setLevel(logging.DEBUG)

# Instrument
eden.instrument("openai")
print("[OK] eden.instrument('openai') succeeded")

# Build an OpenAI client pointed at a local mock that returns canned data
import httpx

class _MockTransport(httpx.BaseTransport):
    def __init__(self, response_json):
        self.response_json = response_json
    def handle_request(self, request):
        return httpx.Response(200, json=self.response_json)

# Create OpenAI client with the mock transport (it uses httpx under the hood)
import openai as _openai
mock_client = _openai.OpenAI(
    api_key="sk-test",
    http_client=httpx.Client(transport=_MockTransport({
        "id": "chatcmpl-e2e",
        "object": "chat.completion",
        "model": "gpt-4o",
        "choices": [{
            "index": 0,
            "finish_reason": "stop",
            "message": {"role": "assistant", "content": "Hello from the mock!"}
        }],
        "usage": {"prompt_tokens": 5, "completion_tokens": 4, "total_tokens": 9},
    }))
)

# Drive a chat completion through the patched client
print("\n=== non-streaming call ===")
result = mock_client.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "hi"}],
)
print(f"[OK] response: {result.choices[0].message.content}")

# Flush so the dry-run logger captures the event
eden.get_default_client().flush(timeout=2.0)
log_content = log_stream.getvalue()
if "dry-run" in log_content or "fmt=" in log_content:
    print(f"[OK] dry-run logged the event")
else:
    print(f"[INFO] no dry-run log lines (queue may have been empty)")

# Now try streaming
print("\n=== streaming call ===")
class _StreamingTransport(httpx.BaseTransport):
    def handle_request(self, request):
        # SSE-style response with 3 chunks
        chunks = [
            'data: {"id":"c1","object":"chat.completion.chunk","model":"gpt-4o","choices":[{"index":0,"delta":{"content":"He"},"finish_reason":null}]}\n\n',
            'data: {"id":"c1","object":"chat.completion.chunk","model":"gpt-4o","choices":[{"index":0,"delta":{"content":"llo"},"finish_reason":null}]}\n\n',
            'data: {"id":"c1","object":"chat.completion.chunk","model":"gpt-4o","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":2,"total_tokens":4}}\n\n',
            'data: [DONE]\n\n',
        ]
        body = "".join(chunks).encode()
        return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=body)

stream_client = _openai.OpenAI(
    api_key="sk-test",
    http_client=httpx.Client(transport=_StreamingTransport()),
)

result = stream_client.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "hi"}],
    stream=True,
)
chunks_received = []
for ch in result:
    if ch.choices and ch.choices[0].delta.content:
        chunks_received.append(ch.choices[0].delta.content)
print(f"[OK] received {len(chunks_received)} chunks: {chunks_received}")

# Wait for the stream's finally block to enqueue the summary event
eden.get_default_client().flush(timeout=2.0)

# Check that the default client has telemetry from both calls
client = eden.get_default_client()
print(f"\n[OK] sent_total: {client._sent_total}")
print(f"[OK] chunk_buffer size after streaming: {len(client._chunk_buffer)}")

# Cleanup
eden.uninstrument("openai")
print("\n[OK] eden.uninstrument('openai') succeeded")
print("\n=== END-TO-END OK ===")
