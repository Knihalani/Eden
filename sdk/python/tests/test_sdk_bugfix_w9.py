"""Worker 9 regression pins — Python SDK bug fixes."""

from __future__ import annotations

import asyncio
import gzip
import json
import logging
import types
from pathlib import Path

import httpx
import pytest
from _http_body import decode_ingest_body

import eden
from eden_sdk.client import EdenClient, TraceEvent
from eden_sdk.client import __version__ as client_version
from eden_sdk.config import EdenConfig, configure, reset_config
from eden_sdk.logging_forwarder import EdenLoggingHandler, uninstall_logging
from eden_sdk.offline_queue import OfflineQueue


def test_client_user_agent_version_matches_package() -> None:
    """User-Agent must track the package ``__version__`` (not a stale pin)."""
    import eden_sdk

    assert client_version == eden_sdk.__version__
    assert client_version == "0.3.3"
    from eden_sdk.client import _USER_AGENT

    assert _USER_AGENT == f"eden-sdk/{client_version} (python)"


def test_stumbles_user_agent_matches_client() -> None:
    from eden_sdk.client import _USER_AGENT as client_ua
    from eden_sdk.stumbles import _USER_AGENT as stumble_ua

    assert stumble_ua == client_ua


def test_flush_chunks_wakes_sender_with_long_flush_interval() -> None:
    """``flush_chunks`` must signal ``_wake`` or it stalls past the timeout
    when ``flush_interval_ms`` is larger than the flush timeout.
    """
    seen: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(decode_ingest_body(request.content, request.headers))
        return httpx.Response(202, json={"ok": True}, request=request)

    transport = httpx.MockTransport(handler)
    client = EdenClient(
        EdenConfig(
            org_id="o",
            api_key="k",
            base_url="http://test.invalid",
            flush_interval_ms=60_000,
            dry_run=False,
        ),
        transport=transport,
    )
    client.start()
    try:
        client._chunk_buffer.append(
            {
                "event_id": "s1",
                "trace_id": "t1",
                "chunk_index": 0,
                "delta_text": None,
                "ttft_ms": 1.0,
                "itl_ms": None,
                "tpot_ms": None,
                "received_at_client_ms": 0,
            }
        )
        client.flush_chunks(timeout=2.0)
        assert len(seen) == 1
        assert seen[0]["chunks"][0]["event_id"] == "s1"
    finally:
        client.shutdown()


def test_permanent_4xx_does_not_spill_offline(tmp_path: Path) -> None:
    """Auth/validation 4xx must not poison the durable offline queue."""
    call_count = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal call_count
        call_count += 1
        return httpx.Response(401, text="unauthorized")

    offline = OfflineQueue(tmp_path / "offline.sqlite3")
    transport = httpx.MockTransport(handler)
    client = EdenClient(
        EdenConfig(
            org_id="o",
            api_key="k",
            base_url="http://test.invalid",
            dry_run=False,
            offline_queue_path=str(tmp_path / "unused.sqlite3"),
        ),
        transport=transport,
    )
    # Force the already-constructed offline queue.
    client._offline = offline
    client._http = httpx.AsyncClient(timeout=2.0, transport=transport)
    batch = [TraceEvent(payload={"event_id": "bad"}, source_format="openai")]
    asyncio.run(client._send_batch(batch))
    assert call_count == 1
    assert client.failed == 1
    assert offline.size() == 0
    offline.close()


def test_transient_5xx_spills_offline(tmp_path: Path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, text="unavailable")

    offline = OfflineQueue(tmp_path / "offline.sqlite3")
    transport = httpx.MockTransport(handler)
    client = EdenClient(
        EdenConfig(
            org_id="o",
            api_key="k",
            base_url="http://test.invalid",
            dry_run=False,
        ),
        transport=transport,
    )
    client._offline = offline
    client._http = httpx.AsyncClient(timeout=2.0, transport=transport)
    batch = [TraceEvent(payload={"event_id": "tmp"}, source_format="openai")]
    asyncio.run(client._send_batch(batch))
    assert offline.size() >= 1
    offline.close()


def test_flush_offline_acks_after_flush(tmp_path: Path) -> None:
    """Ack only after flush so a crash mid-replay cannot drop durable rows."""
    posts: list[object] = []

    def handler(request: httpx.Request) -> httpx.Response:
        posts.append(decode_ingest_body(request.content, request.headers))
        return httpx.Response(202, json={"ok": True}, request=request)

    qpath = tmp_path / "q.sqlite3"
    offline = OfflineQueue(qpath)
    offline.enqueue("openai", {"event_id": "replay-1"})
    assert offline.size() == 1

    transport = httpx.MockTransport(handler)
    client = EdenClient(
        EdenConfig(
            org_id="o",
            api_key="k",
            base_url="http://test.invalid",
            dry_run=False,
            flush_interval_ms=50,
        ),
        transport=transport,
    )
    client._offline = offline
    client.start()
    try:
        n = client.flush_offline(limit=10)
        assert n == 1
        assert len(posts) >= 1
        assert offline.size() == 0
    finally:
        client.shutdown()
        offline.close()


def test_flush_offline_skips_ack_on_timeout(tmp_path: Path) -> None:
    """Do not ack SQLite ids when flush times out before send completes."""
    import time

    def handler(request: httpx.Request) -> httpx.Response:
        time.sleep(2.0)
        return httpx.Response(202, json={"ok": True}, request=request)

    qpath = tmp_path / "q-timeout.sqlite3"
    offline = OfflineQueue(qpath)
    offline.enqueue("openai", {"event_id": "replay-slow"})
    assert offline.size() == 1

    transport = httpx.MockTransport(handler)
    client = EdenClient(
        EdenConfig(
            org_id="o",
            api_key="k",
            base_url="http://test.invalid",
            dry_run=False,
            flush_interval_ms=50,
        ),
        transport=transport,
    )
    client._offline = offline
    client.start()
    try:
        n = client.flush_offline(limit=10, timeout=0.15)
        assert n == 0
        assert offline.size() == 1
    finally:
        client.shutdown()
        offline.close()


def test_flush_offline_bypasses_sampling(tmp_path: Path) -> None:
    """Durable offline replay must not be dropped by ClientSampler."""
    posts: list[object] = []

    def handler(request: httpx.Request) -> httpx.Response:
        posts.append(decode_ingest_body(request.content, request.headers))
        return httpx.Response(202, json={"ok": True}, request=request)

    qpath = tmp_path / "q-sample.sqlite3"
    offline = OfflineQueue(qpath)
    offline.enqueue("openai", {"event_id": "replay-sampled"})
    assert offline.size() == 1

    transport = httpx.MockTransport(handler)
    client = EdenClient(
        EdenConfig(
            org_id="o",
            api_key="k",
            base_url="http://test.invalid",
            dry_run=False,
            flush_interval_ms=50,
        ),
        transport=transport,
    )
    client._offline = offline
    # Aggressive sampler would drop non-error events without force/skip.
    from eden_sdk.sampling import ClientSampler

    client._sampler = ClientSampler(
        profile="aggressive", keep_errors=True, enabled=True, rng_seed=0
    )
    client.start()
    try:
        n = client.flush_offline(limit=10)
        assert n == 1
        assert len(posts) >= 1
        assert offline.size() == 0
        assert client.sampled_out == 0
    finally:
        client.shutdown()
        offline.close()


def test_otel_headers_include_org_id(monkeypatch: pytest.MonkeyPatch) -> None:
    """OTLP exporter must send X-Org-Id (required with API key)."""
    reset_config()
    configure(org_id="org-otel", api_key="key-otel", project_id="proj")

    captured: dict[str, object] = {}

    class _FakeExporter:
        def __init__(self, endpoint=None, headers=None):
            captured["endpoint"] = endpoint
            captured["headers"] = dict(headers or {})

    class _FakeProcessor:
        def __init__(self, exporter):
            self.exporter = exporter

    class _FakeProvider:
        def __init__(self, resource=None):
            self.resource = resource
            self.processors = []

        def add_span_processor(self, proc):
            self.processors.append(proc)

    class _FakeResource:
        @staticmethod
        def create(attrs):
            return attrs

    class _FakeTraceMod:
        @staticmethod
        def set_tracer_provider(provider):
            captured["provider"] = provider

    import sys

    fake_otel = types.ModuleType("opentelemetry")
    fake_trace = types.ModuleType("opentelemetry.trace")
    fake_trace.set_tracer_provider = _FakeTraceMod.set_tracer_provider  # type: ignore[attr-defined]
    fake_otel.trace = fake_trace  # type: ignore[attr-defined]

    fake_exporter = types.ModuleType(
        "opentelemetry.exporter.otlp.proto.http.trace_exporter"
    )
    fake_exporter.OTLPSpanExporter = _FakeExporter  # type: ignore[attr-defined]
    # Parent packages required for nested imports.
    for name in (
        "opentelemetry.exporter",
        "opentelemetry.exporter.otlp",
        "opentelemetry.exporter.otlp.proto",
        "opentelemetry.exporter.otlp.proto.http",
        "opentelemetry.sdk",
        "opentelemetry.sdk.trace",
    ):
        if name not in sys.modules:
            monkeypatch.setitem(sys.modules, name, types.ModuleType(name))
    fake_resources = types.ModuleType("opentelemetry.sdk.resources")
    fake_resources.Resource = _FakeResource  # type: ignore[attr-defined]
    fake_sdk_trace = types.ModuleType("opentelemetry.sdk.trace")
    fake_sdk_trace.TracerProvider = _FakeProvider  # type: ignore[attr-defined]
    fake_export = types.ModuleType("opentelemetry.sdk.trace.export")
    fake_export.BatchSpanProcessor = _FakeProcessor  # type: ignore[attr-defined]

    monkeypatch.setitem(sys.modules, "opentelemetry", fake_otel)
    monkeypatch.setitem(sys.modules, "opentelemetry.trace", fake_trace)
    monkeypatch.setitem(
        sys.modules,
        "opentelemetry.exporter.otlp.proto.http.trace_exporter",
        fake_exporter,
    )
    monkeypatch.setitem(sys.modules, "opentelemetry.sdk.resources", fake_resources)
    monkeypatch.setitem(sys.modules, "opentelemetry.sdk.trace", fake_sdk_trace)
    monkeypatch.setitem(sys.modules, "opentelemetry.sdk.trace.export", fake_export)

    import eden_sdk.otel as otel_mod

    otel_mod._configured = False
    otel_mod.configure_exporter(service_name="test-svc", framework="pytest")

    headers = captured["headers"]
    assert isinstance(headers, dict)
    assert headers.get("X-Org-Id") == "org-otel"
    assert headers.get("X-Org-Api-Key") == "key-otel"
    assert headers.get("X-Project-Id") == "proj"
    assert headers.get("X-Source-Framework") == "pytest"
    assert "/orgs/org-otel/ingest/otel" in str(captured["endpoint"])
    # Reset so later tests can call ``eden.instrument()``.
    otel_mod._configured = False


def test_logging_forwarder_skips_eden_sdk_loggers() -> None:
    """SDK WARNINGs must not re-enter the logging → enqueue path."""
    from eden_sdk import client as client_mod

    client_mod.reset_default_client()
    configure(org_id="o", api_key="k", dry_run=True)
    uninstall_logging()
    handler = EdenLoggingHandler(level=logging.WARNING)
    root = logging.getLogger()
    root.addHandler(handler)
    try:
        before = get_default_client_sent()
        logging.getLogger("eden_sdk.client").warning("synthetic sdk warning")
        after = get_default_client_sent()
        assert after == before
        # App loggers still forward.
        logging.getLogger("app.demo").error("boom")
        assert get_default_client_sent() == before + 1
    finally:
        root.removeHandler(handler)
        uninstall_logging()


def get_default_client_sent() -> int:
    from eden_sdk.client import get_default_client

    return get_default_client().sent


def test_langchain_stream_and_framework_share_trace_id(monkeypatch: pytest.MonkeyPatch) -> None:
    """Chunks and the aggregate llm.end event must share one trace_id."""
    import sys

    from eden_sdk.client import get_default_client, reset_default_client
    from eden_sdk.instrumentations import langchain as lc

    # Minimal langchain-core fake (fixture lives in test_instrumentations).
    callbacks = types.ModuleType("langchain_core.callbacks")

    class BaseCallbackHandler:
        pass

    class _Mgr:
        def __init__(self):
            self.handlers: list = []

        def add_handler(self, h):
            if h not in self.handlers:
                self.handlers.append(h)

        def remove_handler(self, h):
            if h in self.handlers:
                self.handlers.remove(h)

    _mgr = _Mgr()

    def get_callback_manager():
        return _mgr

    def set_handler(h):
        _mgr.add_handler(h)

    callbacks.BaseCallbackHandler = BaseCallbackHandler  # type: ignore[attr-defined]
    callbacks.get_callback_manager = get_callback_manager  # type: ignore[attr-defined]
    callbacks.set_handler = set_handler  # type: ignore[attr-defined]
    core = types.ModuleType("langchain_core")
    monkeypatch.setitem(sys.modules, "langchain_core", core)
    monkeypatch.setitem(sys.modules, "langchain_core.callbacks", callbacks)

    reset_default_client()
    configure(org_id="o", api_key="k", dry_run=True, capture_chunk_text=True)
    import eden_sdk.otel as otel_mod

    otel_mod._configured = False
    lc.uninstall()
    eden.instrument("langchain")
    handler = next(h for h in _mgr.handlers if isinstance(h, BaseCallbackHandler))

    client = get_default_client()
    captured: list[dict] = []
    original = client.enqueue

    def _capture(event: TraceEvent) -> None:
        captured.append(dict(event.payload))
        return original(event)

    client.enqueue = _capture  # type: ignore[method-assign]
    pinned = client._chunk_buffer

    run_id = "lc-join-1"
    handler.on_llm_start(
        serialized={"name": "openai-llm"},
        prompts=["hi"],
        run_id=run_id,
        parent_run_id=None,
        tags=[],
        metadata={},
    )
    handler.on_llm_new_token(token="Hello", run_id=run_id)
    handler.on_llm_new_token(token="!", run_id=run_id)
    handler.on_llm_end(
        response=types.SimpleNamespace(
            llm_output={"token_usage": {"prompt_tokens": 1, "completion_tokens": 1}},
            response_metadata={"model_name": "gpt-4o-mini"},
            generations=[[types.SimpleNamespace(text="Hello!")]],
        ),
        run_id=run_id,
        parent_run_id=None,
    )

    assert len(pinned) == 2
    chunk_tid = pinned[0]["trace_id"]
    assert all(c["trace_id"] == chunk_tid for c in pinned)
    framework = [e for e in captured if e.get("event_type") == "agent.run"]
    assert framework, f"expected framework event, got {captured!r}"
    assert framework[-1]["trace_id"] == chunk_tid
    lc.uninstall()


def test_gzip_ingest_still_round_trips() -> None:
    """Do not regress K35 gzip Content-Encoding on batch ingest."""
    seen: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["encoding"] = request.headers.get("content-encoding")
        raw = gzip.decompress(request.content)
        seen["decoded"] = json.loads(raw)
        return httpx.Response(200, json={"accepted": 1})

    cfg = EdenConfig(org_id="o", api_key="k", base_url="https://api.example.com")
    transport = httpx.MockTransport(handler)
    client = EdenClient(cfg, transport=transport)
    client._http = httpx.AsyncClient(timeout=2.0, transport=transport)
    asyncio.run(
        client._send_batch(
            [TraceEvent(payload={"event_id": "e1"}, source_format="openai")]
        )
    )
    assert seen["encoding"] == "gzip"
    decoded = seen["decoded"]
    assert isinstance(decoded, list)
    assert decoded[0]["event_id"] == "e1"
