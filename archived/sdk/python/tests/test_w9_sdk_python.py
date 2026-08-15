"""Wave 9 Agent 9.1 — Python SDK instrument aliases, auth, onboarding."""

from __future__ import annotations

import logging
import types

import httpx
import pytest

import eden
import eden_sdk
from eden_sdk.client import EdenClient, TraceEvent, reset_default_client
from eden_sdk.config import EdenConfig, configure, reset_config


@pytest.fixture(autouse=True)
def _reset_sdk_state() -> None:
    reset_config()
    reset_default_client()
    eden.uninstrument()
    eden_sdk.INSTRUMENTED.clear()
    yield
    eden.uninstrument()
    eden_sdk.INSTRUMENTED.clear()
    reset_default_client()
    reset_config()


def test_instrument_accepts_hyphen_aliases(monkeypatch: pytest.MonkeyPatch) -> None:
    """Docs/DEPLOY use pydantic-ai / llama-index; must not silently no-op."""
    installed: list[str] = []

    fake_pai = types.ModuleType("eden_sdk.instrumentations.pydantic_ai")

    def _install_pai() -> None:
        installed.append("pydantic_ai")

    fake_pai.install = _install_pai  # type: ignore[attr-defined]
    fake_pai.uninstall = lambda: None  # type: ignore[attr-defined]

    fake_li = types.ModuleType("eden_sdk.instrumentations.llama_index")

    def _install_li() -> None:
        installed.append("llama_index")

    fake_li.install = _install_li  # type: ignore[attr-defined]
    fake_li.uninstall = lambda: None  # type: ignore[attr-defined]

    import sys

    import eden_sdk.instrumentations as instr

    monkeypatch.setattr(instr, "pydantic_ai", fake_pai, raising=False)
    monkeypatch.setattr(instr, "llama_index", fake_li, raising=False)
    monkeypatch.setitem(sys.modules, "eden_sdk.instrumentations.pydantic_ai", fake_pai)
    monkeypatch.setitem(sys.modules, "eden_sdk.instrumentations.llama_index", fake_li)

    eden.instrument("pydantic-ai", "llama-index")
    assert installed == ["pydantic_ai", "llama_index"]
    assert "pydantic_ai" in eden_sdk.INSTRUMENTED
    assert "llama_index" in eden_sdk.INSTRUMENTED


def test_instrument_maps_ollama_provider_to_openai(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    installed: list[str] = []
    fake = types.ModuleType("eden_sdk.instrumentations.openai")
    fake.install = lambda: installed.append("openai")  # type: ignore[attr-defined]
    fake.uninstall = lambda: None  # type: ignore[attr-defined]
    import sys

    import eden_sdk.instrumentations as instr

    monkeypatch.setattr(instr, "openai", fake, raising=False)
    monkeypatch.setitem(sys.modules, "eden_sdk.instrumentations.openai", fake)
    eden.instrument("ollama")
    assert installed == ["openai"]
    assert "openai" in eden_sdk.INSTRUMENTED


def test_instrument_maps_xai_provider_to_openai(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """xAI (Grok) has no distinct Python client — it's the `openai`
    package pointed at `base_url="https://api.x.ai/v1"` — so
    `eden.instrument("xai")` must reuse the openai instrumentor
    verbatim, same as the ollama/minimax aliases."""
    installed: list[str] = []
    fake = types.ModuleType("eden_sdk.instrumentations.openai")
    fake.install = lambda: installed.append("openai")  # type: ignore[attr-defined]
    fake.uninstall = lambda: None  # type: ignore[attr-defined]
    import sys

    import eden_sdk.instrumentations as instr

    monkeypatch.setattr(instr, "openai", fake, raising=False)
    monkeypatch.setitem(sys.modules, "eden_sdk.instrumentations.openai", fake)
    eden.instrument("xai")
    assert installed == ["openai"]
    assert "openai" in eden_sdk.INSTRUMENTED


def test_instrument_warns_on_unknown_framework(caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level(logging.WARNING, logger="eden_sdk"):
        eden.instrument("not-a-real-framework")
    assert any("unknown framework" in r.message for r in caplog.records)
    assert "not-a-real-framework" not in eden_sdk.INSTRUMENTED


def test_init_shim_configure_and_instrument(monkeypatch: pytest.MonkeyPatch) -> None:
    installed: list[str] = []
    fake = types.ModuleType("eden_sdk.instrumentations.openai")
    fake.install = lambda: installed.append("openai")  # type: ignore[attr-defined]
    fake.uninstall = lambda: None  # type: ignore[attr-defined]
    import sys

    import eden_sdk.instrumentations as instr

    monkeypatch.setattr(instr, "openai", fake, raising=False)
    monkeypatch.setitem(sys.modules, "eden_sdk.instrumentations.openai", fake)
    eden.init(org_id="org-w9", api_key="key-w9", framework="openai")
    cfg = eden.get_config()
    assert cfg.org_id == "org-w9"
    assert cfg.api_key == "key-w9"
    assert installed == ["openai"]


def test_init_empty_credentials_does_not_raise(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = types.ModuleType("eden_sdk.instrumentations.mastra")
    fake.install = lambda: None  # type: ignore[attr-defined]
    fake.uninstall = lambda: None  # type: ignore[attr-defined]
    import sys

    import eden_sdk.instrumentations as instr

    monkeypatch.setattr(instr, "mastra", fake, raising=False)
    monkeypatch.setitem(sys.modules, "eden_sdk.instrumentations.mastra", fake)
    eden.init(api_key="", org_id="", framework="mastra", auto_instrument=True)


def test_401_does_not_crash_sender_or_raise_to_caller() -> None:
    """Ingest 401 must increment failed, never raise into user code."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, text="unauthorized")

    transport = httpx.MockTransport(handler)
    client = EdenClient(
        EdenConfig(
            org_id="o",
            api_key="bad",
            base_url="http://test.invalid",
            dry_run=False,
            flush_interval_ms=50,
        ),
        transport=transport,
    )
    client.start()
    try:
        client.enqueue(
            TraceEvent(payload={"event_id": "e-401"}, source_format="openai")
        )
        client.flush(timeout=2.0)
        assert client.failed >= 1
        client.enqueue(
            TraceEvent(payload={"event_id": "e-401b"}, source_format="openai")
        )
        client.flush(timeout=2.0)
        assert client.failed >= 2
    finally:
        client.shutdown()


def test_live_publish_event_gzips_body() -> None:
    """Phase 5 — live span publish gzips its JSON body like main ingest."""
    import gzip
    import json

    from eden_sdk.live import LiveSpanPublisher

    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["headers"] = request.headers
        seen["content"] = request.content
        return httpx.Response(200, json={"status": "ok"})

    configure(org_id="o", api_key="k", base_url="http://test.invalid", dry_run=False)
    pub = LiveSpanPublisher()
    cfg_timeout = eden.get_config().timeout_s
    pub._http = httpx.Client(transport=httpx.MockTransport(handler), timeout=cfg_timeout)
    pub._http_timeout = cfg_timeout

    result = pub.publish_event(
        session_id="s1", event={"type": "span_start", "span_id": "sp1"}
    )

    assert result == {"status": "ok"}
    assert seen["headers"]["content-encoding"] == "gzip"
    decoded = json.loads(gzip.decompress(seen["content"]))
    assert decoded == {"type": "span_start", "span_id": "sp1"}


def test_live_finalize_401_does_not_raise() -> None:
    from eden_sdk.live import LiveSpanPublisher

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, text="nope")

    configure(org_id="o", api_key="k", base_url="http://test.invalid", dry_run=False)
    pub = LiveSpanPublisher()
    cfg_timeout = eden.get_config().timeout_s
    pub._http = httpx.Client(transport=httpx.MockTransport(handler), timeout=cfg_timeout)
    pub._http_timeout = cfg_timeout
    result = pub.finalize(session_id="s1", trace_id="t1")
    assert result["status"] == "error"
    assert "401" in result.get("reason", "")
