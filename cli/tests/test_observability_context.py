"""Tests for ``eden.observability_context`` — observability summary provider."""

from __future__ import annotations

import asyncio

import httpx

from eden.api_client import EdenAPIClient
from eden.config import ContextConfig, EdenCLIConfig
from eden.observability_context import (
    ObservabilityContext,
    ObservabilityContextProvider,
    _truncate_to_budget,
)


def _client(handler) -> EdenAPIClient:
    cfg = EdenCLIConfig(api_key="k", org_id="o", base_url="http://x")
    client = EdenAPIClient(cfg, max_retries=0)
    async def _ensure():
        if client._client is None or client._client.is_closed:
            client._client = httpx.AsyncClient(
                base_url="http://x",
                transport=httpx.MockTransport(handler),
                headers={"X-Org-Api-Key": "k", "X-Org-Id": "o"},
            )
        return client._client
    client._ensure_client = _ensure  # type: ignore[method-assign]
    return client


def test_truncate_no_truncation_when_small():
    text, dropped = _truncate_to_budget("hi", 1000)
    assert text == "hi"
    assert dropped is False


def test_truncate_drops_when_over_budget():
    text, dropped = _truncate_to_budget("x" * 5000, 100)
    assert dropped is True
    assert "truncated" in text


def test_render_includes_known_fields():
    p = ObservabilityContextProvider(
        client=None,  # type: ignore[arg-type]
        config=ContextConfig(),
    )
    out = p._render(
        {
            "window_hours": 24,
            "total_traces": 42,
            "error_rate": 0.07,
            "p50_latency_ms": 50,
            "p95_latency_ms": 250,
            "p99_latency_ms": 900,
            "total_cost_usd": 12.34,
            "top_failure_modes": [{"name": "tool timeout", "count": 5}],
            "model_breakdown": [{"model": "claude-sonnet-4.6", "calls": 100}],
        }
    )
    assert "OBSERVABILITY CONTEXT" in out
    assert "**Traces:** 42" in out
    assert "**Error rate:** 7.0%" in out
    assert "**Cost (window):** $12.34" in out
    assert "tool timeout" in out
    assert "claude-sonnet-4.6" in out


def test_render_empty_summary_returns_empty():
    p = ObservabilityContextProvider(client=None, config=ContextConfig())  # type: ignore[arg-type]
    out = p._render({})
    assert out == ""


def test_get_context_calls_api():
    captured = {}
    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        return httpx.Response(200, json={
            "window_hours": 24,
            "total_traces": 3,
            "error_rate": 0.1,
        })
    c = _client(handler)
    p = ObservabilityContextProvider(c, ContextConfig(observability_token_budget=2000))
    out = asyncio.run(p.get_context(window_hours=24))
    assert out.hit_count == 3
    assert "**Traces:** 3" in out.text
    assert "window_hours=24" in captured["url"]


def test_list_recent_traces_dict_response():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"traces": [{"trace_id": "t1"}]})
    c = _client(handler)
    p = ObservabilityContextProvider(c, ContextConfig())
    out = asyncio.run(p.list_recent_traces(limit=5))
    assert out == [{"trace_id": "t1"}]


def test_list_recent_traces_bare_list():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=[{"trace_id": "t1"}])
    c = _client(handler)
    p = ObservabilityContextProvider(c, ContextConfig())
    out = asyncio.run(p.list_recent_traces(limit=5))
    assert out == [{"trace_id": "t1"}]
