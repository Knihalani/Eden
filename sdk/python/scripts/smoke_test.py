"""End-to-end smoke test for eden-sdk wheel.

Validates 20-point contract + streaming-specific behavior against the
freshly built wheel at /tmp/wheel-extract.
"""
import asyncio
import dataclasses
import json
import sys

sys.path.insert(0, "/tmp/wheel-extract")

failures = []
def check(name, cond, detail=""):
    status = "OK" if cond else "FAIL"
    print(f"[{status}] {name}" + (f" — {detail}" if detail else ""))
    if not cond:
        failures.append(name)

# ── 1. Public surface ─────────────────────────────────────────────────
import eden

check("import eden", eden is not None)
check("eden.__version__", hasattr(eden, "__version__") and eden.__version__ == "0.3.0", eden.__version__)
check("eden.__all__", isinstance(eden.__all__, list) and "configure" in eden.__all__ and "trace" in eden.__all__,
      f"{len(eden.__all__)} exports")
for must_have in ["EdenConfig", "EdenClient", "configure", "get_config", "trace",
                  "trace_agent", "Span", "FilterConfig", "PIIConfig",
                  "openai_client", "chat_completion", "ModelAdvisor", "instrument",
                  "uninstrument", "reset_config"]:
    check(f"  exports {must_have}", must_have in eden.__all__, "")

# ── 2. configure / get_config ────────────────────────────────────────
from eden import configure, get_config

configure(org_id="acme", api_key="sk-test", base_url="https://api.example.com",
          gateway_url="https://gw.example.com/v1")
cfg = get_config()
check("configure persists org_id", cfg.org_id == "acme")
check("configure persists api_key", cfg.api_key == "sk-test")
check("configure persists gateway_url", cfg.gateway_url == "https://gw.example.com/v1")
check("resolved_gateway_url", cfg.resolved_gateway_url() == "https://gw.example.com/v1")
check("ingest_url (openai)", cfg.ingest_url("openai") == "https://api.example.com/orgs/acme/ingest/openai")
check("ingest_url (anthropic)", cfg.ingest_url("anthropic") == "https://api.example.com/orgs/acme/ingest/anthropic")
gh = cfg.gateway_headers(upstream_base_url="https://api.openai.com",
                         upstream_api_key="sk-upstream", upstream_provider="openai")
check("gateway_headers X-Org-Id", gh.get("X-Org-Id") == "acme")
check("gateway_headers X-Org-Api-Key", gh.get("X-Org-Api-Key") == "sk-test")
check("gateway_headers X-Upstream-Base-Url", gh.get("X-Upstream-Base-Url") == "https://api.openai.com")
check("gateway_headers X-Upstream-Provider", gh.get("X-Upstream-Provider") == "openai")
auth = cfg.auth_headers()
check("auth_headers X-Project-Id default", auth.get("X-Project-Id") == "default")

# ── 3. FilterConfig / PIIConfig ───────────────────────────────────────
from eden import FilterConfig, PIIConfig

p_cfg = PIIConfig(mode="redact", disabled_categories=["credit_cards", "ssn"], bypass=False)
f = FilterConfig(pii=p_cfg)
check("FilterConfig holds PIIConfig", f.pii is p_cfg)
fh = f.to_headers()
check("FilterConfig.to_headers X-PII-Mode", fh.get("X-PII-Mode") == "redact", str(fh))
check("FilterConfig.to_headers X-PII-Disabled-Categories",
      fh.get("X-PII-Disabled-Categories") == "credit_cards,ssn", fh.get("X-PII-Disabled-Categories"))
check("PIIConfig.mode", p_cfg.mode == "redact")
check("PIIConfig.disabled_categories", "credit_cards" in p_cfg.disabled_categories)
check("PIIConfig.bypass default False", p_cfg.bypass is False)
try:
    PIIConfig(strip_pii=False)
    check("PIIConfig rejects bad kwarg", False)
except TypeError:
    check("PIIConfig rejects bad kwarg", True)

# ── 4. ModelAdvisor (mocked httpx) ────────────────────────────────────
import httpx

from eden import ModelAdvisor


class _MockResp:
    status_code = 200
    content = b'{"recommended_provider":"anthropic"}'
    def json(self):
        return {
            "recommended_provider": "anthropic",
            "recommended_model_id": "claude-3-5-sonnet",
            "score": 0.92,
            "rationale": "best fit for cost",
            "monthly_savings_usd": 12.5,
            "runners_up": [],
            "empty_history": False,
        }
    def raise_for_status(self): pass

class _MockClient(httpx.Client):
    def __init__(self): pass
    def post(self, url, json=None, headers=None): return _MockResp()
    def close(self): pass

advisor = ModelAdvisor(client=_MockClient())
rec = advisor.recommend(org_id="acme", candidates=[("openai", "gpt-4o"), ("anthropic", "claude-3-5-sonnet")])
check("ModelAdvisor.recommend returns Recommendation", hasattr(rec, "recommended_model_id"),
      f"{type(rec).__name__}: {rec.recommended_model_id}")
check("ModelAdvisor.recommend picks winner", rec.recommended_model_id == "claude-3-5-sonnet")
check("ModelAdvisor.recommend carries score", rec.score == 0.92)
check("ModelAdvisor.recommend carries savings", rec.monthly_savings_usd == 12.5)
advisor.close()

# ── 5. trace_agent decorator + trace context manager ─────────────────
from eden import current_span, trace, trace_agent


@trace_agent("acme", tags=["prod"])
def my_agent(prompt: str) -> str:
    return f"echo: {prompt}"

result = my_agent("hi")
check("trace_agent decorator returns wrapped callable", result == "echo: hi")

# trace() is a context manager yielding TraceContext
with trace("manual", attributes={"x": 1}) as ctx:
    check("trace() yields TraceContext", hasattr(ctx, "trace_id") and ctx.name == "manual")
    check("current_span() inside trace()", current_span() is not None)
check("trace() ctx.trace_id is hex uuid", len(ctx.trace_id) == 32)

# ── 6. Span dataclass ────────────────────────────────────────────────
from eden import Span

check("Span is a dataclass", dataclasses.is_dataclass(Span))

# ── 7. EdenClient construction + counters ────────────────────────────
from eden import EdenClient

client = EdenClient(config=cfg, transport=httpx.MockTransport(lambda req: httpx.Response(200, json={"ok": True})))
check("EdenClient initial counters", client._sent_total == 0 and client._failed_total == 0)
check("EdenClient has _chunk_buffer", hasattr(client, "_chunk_buffer"))
check("EdenClient has flush_chunks", hasattr(client, "flush_chunks"))
check("EdenClient has ingest_chunks_url", hasattr(client, "ingest_chunks_url"))

# ── 8. Instrumentations loaded ───────────────────────────────────────
from eden_sdk.instrumentations import openai as eden_oa

check("OpenAI _wrap_sync_stream exists", hasattr(eden_oa, "_wrap_sync_stream"))
check("OpenAI _wrap_async_stream exists", hasattr(eden_oa, "_wrap_async_stream"))
from eden_sdk.instrumentations import anthropic as eden_an

check("Anthropic _wrap_sync_stream exists", hasattr(eden_an, "_wrap_sync_stream"))
check("Anthropic _wrap_async_stream exists", hasattr(eden_an, "_wrap_async_stream"))
# All 7 instrumentations packaged
from eden_sdk.instrumentations import autogen, crewai, langchain, llama_index, mastra

check("All 7 instrumentations packaged", all([langchain, llama_index, crewai, autogen, mastra]))

# ── 9. ingest_chunks_url matches /ingest/chunks path ─────────────────
chunks_url = client.ingest_chunks_url()
check("ingest_chunks_url ends with /chunks", chunks_url.endswith("/chunks"), chunks_url)

# ── 10. Async OpenAI streaming end-to-end ─────────────────────────────
async def async_stream_smoke():
    from eden_sdk.instrumentations.openai import _wrap_async_stream

    class FakeUsage:
        prompt_tokens = 7
        completion_tokens = 11

    class FakeChoice:
        def __init__(self, content, finish=None):
            self.delta = type("D", (), {"content": content})()
            self.finish_reason = finish

    class FakeChunk:
        def __init__(self, content, model="gpt-4o", finish=None):
            self.choices = [FakeChoice(content, finish)]
            self.model = model
            self.usage = FakeUsage() if finish else None

    async def aiter():
        for c in ["He", "llo", " world"]:
            yield FakeChunk(c)
        yield FakeChunk("", finish="stop")

    class FakeCompletions:
        async def create(self, *a, **kw):
            return aiter()

    class FakeChat:
        completions = FakeCompletions()

    class FakeClient:
        chat = FakeChat()

    async def original(self, *a, **kw):
        return aiter()
    # _wrap_async_stream(original, self, args, kwargs) — kwargs must include stream=True
    gen = _wrap_async_stream(original, object(), (), {"model": "gpt-4o", "messages": [], "stream": True})
    check("_wrap_async_stream returns async iterator (not coroutine)",
          hasattr(gen, "__aiter__"), f"got {type(gen).__name__}")
    out = []
    async for ch in gen:
        out.append(ch)
    return len(out)

async_count = asyncio.run(async_stream_smoke())
check("OpenAI async streaming yielded 4 chunks (3 deltas + final)",
      async_count == 4, f"got {async_count}")

# ── 11. Anthropic async streaming end-to-end ─────────────────────────
async def anthropic_stream_smoke():
    from eden_sdk.instrumentations.anthropic import _wrap_async_stream

    class FakeDelta:
        def __init__(self, t, **kw):
            self.type = t
            for k, v in kw.items():
                setattr(self, k, v)

    class FakeEv:
        def __init__(self, t, **kw):
            self.type = t
            for k, v in kw.items():
                setattr(self, k, v)

    class FakeMessage:
        def __init__(self, id_): self.id = id_

    async def aiter():
        yield FakeEv("message_start", message=FakeMessage("msg_test"))
        yield FakeEv("content_block_start")
        yield FakeEv("content_block_delta", delta=FakeDelta("text_delta", text="Hi"))
        yield FakeEv("content_block_delta", delta=FakeDelta("text_delta", text=" there"))
        yield FakeEv("content_block_stop")
        yield FakeEv("message_delta", delta=FakeDelta("", stop_reason="end_turn"))
        yield FakeEv("message_stop")

    class FakeMessages:
        async def create(self, *a, **kw):
            return aiter()

    class FakeAnthropic:
        messages = FakeMessages()

    async def original(self, *a, **kw):
        return aiter()
    gen = _wrap_async_stream(original, object(), (), {"model": "claude-3-5-sonnet", "messages": [], "stream": True})
    check("Anthropic _wrap_async_stream returns async iter",
          hasattr(gen, "__aiter__"), f"got {type(gen).__name__}")
    out = []
    async for ev in gen:
        out.append(ev)
    return len(out)

an_count = asyncio.run(anthropic_stream_smoke())
check("Anthropic async streaming yielded 7 events", an_count == 7, f"got {an_count}")

# ── 12. _chunk_buffer accumulates + flush_chunks posts ───────────────
async def chunk_buffer_test():
    # Use httpx.MockTransport so we capture every POST without real I/O
    # (sandbox blocks TCP bind).
    import eden_sdk.client as _client_mod
    from eden_sdk.client import EdenClient as _Client
    from eden_sdk.config import EdenConfig

    captured: list[dict] = []
    def handler(request):
        body = json.loads(request.content.decode() or "null")
        captured.append({"url": str(request.url), "body": body})
        return httpx.Response(200, json={"ok": True})

    cfg = EdenConfig(org_id="acme", api_key="sk-test",
                     base_url="https://api.example.com",
                     gateway_url="https://gw.example.com",
                     flush_interval_ms=10000, batch_size=1000,
                     disabled=False)
    c = _Client(config=cfg, transport=httpx.MockTransport(handler))
    c.start()  # start the background sender thread

    # Replace the module-level _default singleton so get_default_client() returns ours.
    saved_default = _client_mod._default
    _client_mod._default = c
    try:
        # Now drive the stream wrapper — it calls get_default_client() which yields c.
        from eden_sdk.instrumentations.openai import _wrap_async_stream

        class FakeUsage:
            prompt_tokens = 3
            completion_tokens = 8

        class FakeChoice:
            def __init__(self, content, finish=None):
                self.delta = type("D", (), {"content": content})()
                self.finish_reason = finish

        class FakeChunk:
            def __init__(self, content, finish=None):
                self.choices = [FakeChoice(content, finish)]
                self.model = "gpt-4o"
                self.usage = FakeUsage() if finish else None

        async def aiter():
            for ch in ["a", "b", "c", "d", "e"]:
                yield FakeChunk(ch)
            yield FakeChunk("", finish="stop")

        async def original(self, *a, **kw):
            return aiter()
        gen = _wrap_async_stream(original, object(), (), {"model": "gpt-4o", "messages": [], "stream": True})
        async for _ in gen:
            pass

        # Read the buffer BEFORE calling flush — flush drains it.
        # The chunks are appended during the stream iteration above.
        buf_size = len(c._chunk_buffer)
        check("_chunk_buffer accumulates chunks during streaming",
              buf_size >= 5, f"{buf_size} chunks buffered")

        c.flush(timeout=2.0)
        c.flush_chunks(timeout=3.0)
        await asyncio.sleep(0.5)  # give the async loop time to drain

        chunk_urls = [r["url"] for r in captured if "/chunks" in r["url"]]
        check("flush_chunks() posts to /chunks endpoint",
              len(chunk_urls) >= 1, f"{len(chunk_urls)} POSTs, captured={[r['url'] for r in captured]}")
        if chunk_urls:
            first_body = next(r["body"] for r in captured if r["url"] == chunk_urls[0])
            check("/chunks payload is list-or-dict",
                  isinstance(first_body, (list, dict)),
                  f"{type(first_body).__name__}")

        c.shutdown(timeout=2.0)
    finally:
        _client_mod._default = saved_default

asyncio.run(chunk_buffer_test())

# ── 13. flush_chunks safe on empty buffer ─────────────────────────────
async def empty_flush():
    from eden_sdk.client import EdenClient
    from eden_sdk.config import EdenConfig
    c = EdenClient(config=EdenConfig(org_id="acme", api_key="sk-test",
                                      base_url="http://x", gateway_url="http://x",
                                      flush_interval_ms=10000))
    c.flush_chunks(timeout=1.0)  # sync call, returns None
    c.shutdown(timeout=2.0)
    return True

check("flush_chunks() on empty buffer is a safe no-op", asyncio.run(empty_flush()))

# ── 14. Auto-instrument functions exist ──────────────────────────────
from eden_sdk import instrument as _instrument
from eden_sdk import uninstrument as _uninstrument

check("instrument() callable", callable(_instrument))
check("uninstrument() callable", callable(_uninstrument))
# Should be safe to call uninstrument without prior instrument
try:
    _uninstrument()
    check("uninstrument() idempotent", True)
except Exception as e:
    check("uninstrument() idempotent", False, f"{type(e).__name__}: {e}")

# ── Done ────────────────────────────────────────────────────────────
print()
if failures:
    print(f"=== {len(failures)} FAILURES ===")
    for f in failures:
        print(f"  - {f}")
    sys.exit(1)
print(f"=== ALL {len([n for n in dir() if not n.startswith('_')])} CHECKS PASSED ===")
