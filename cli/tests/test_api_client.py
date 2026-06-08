"""Tests for ``eden.api_client`` — Eden HTTP client.

Uses ``httpx.MockTransport`` to avoid any real network. Covers:
    - request envelope behavior
    - retry on 5xx
    - 4xx → EdenAPIError
    - KB query / write
    - Observability summary / traces
    - health()
"""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest

from eden.api_client import EdenAPIClient, EdenAPIError, eden_client
from eden.config import EdenCLIConfig


def _make_client(handler, *, config: EdenCLIConfig | None = None) -> EdenAPIClient:
    """Build an EdenAPIClient with a mock transport."""
    cfg = config or EdenCLIConfig(
        api_key="k", org_id="o", base_url="http://test"
    )
    client = EdenAPIClient(cfg, max_retries=2, timeout=5.0)
    # Inject a mock transport by hijacking _ensure_client
    async def _ensure():
        if client._client is None or client._client.is_closed:
            client._client = httpx.AsyncClient(
                base_url=cfg.base_url,
                headers={
                    "X-Org-Api-Key": cfg.api_key or "",
                    "X-Org-Id": cfg.org_id or "",
                },
                transport=httpx.MockTransport(handler),
                timeout=5.0,
            )
        return client._client
    client._ensure_client = _ensure  # type: ignore[method-assign]
    return client


def _ok(payload: Any = None, status_code: int = 200):
    def _handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status_code, json=payload or {})
    return _handler


def test_health_returns_true_on_2xx():
    client = _make_client(_ok({}))
    import asyncio
    try:
        assert asyncio.run(client.health()) is True
    finally:
        asyncio.run(client.close())


def test_health_returns_false_on_error():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, json={"err": "boom"})
    client = _make_client(handler)
    import asyncio
    try:
        assert asyncio.run(client.health()) is False
    finally:
        asyncio.run(client.close())


def test_query_kb_requires_org():
    client = _make_client(_ok(), config=EdenCLIConfig(api_key="k", base_url="http://test"))
    import asyncio
    try:
        with pytest.raises(EdenAPIError):
            asyncio.run(client.query_kb("x"))
    finally:
        asyncio.run(client.close())


def test_query_kb_forwards_params():
    seen: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["method"] = request.method
        return httpx.Response(200, json={"results": []})

    client = _make_client(handler)
    import asyncio
    try:
        out = asyncio.run(
            client.query_kb("reward shaping", scope="global", limit=7)
        )
        assert "results" in out
        assert seen["method"] == "GET"
        assert "q=reward" in seen["url"] or "q=reward+shaping" in seen["url"] or "q=reward%20shaping" in seen["url"]
        assert "scope=global" in seen["url"]
        assert "limit=7" in seen["url"]
    finally:
        asyncio.run(client.close())


def test_write_kb_entry_posts_json():
    seen: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["body"] = json.loads(request.content or b"{}")
        seen["url"] = str(request.url)
        return httpx.Response(201, json={"id": "abc"})

    client = _make_client(handler)
    import asyncio
    try:
        out = asyncio.run(
            client.write_kb_entry({"title": "t", "body": "b"})
        )
        assert out["id"] == "abc"
        assert seen["body"]["title"] == "t"
        assert "/v1/orgs/o/kb/entries" in seen["url"]
    finally:
        asyncio.run(client.close())


def test_list_traces_default_limit():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"traces": [{"trace_id": "t1"}]})

    client = _make_client(handler)
    import asyncio
    try:
        out = asyncio.run(client.list_traces())
        assert isinstance(out, dict)
        assert out["traces"][0]["trace_id"] == "t1"
    finally:
        asyncio.run(client.close())


def test_observability_summary_window():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"total_traces": 5, "p95_latency_ms": 200})

    client = _make_client(handler)
    import asyncio
    try:
        out = asyncio.run(client.observability_summary(window_hours=12))
        assert out["total_traces"] == 5
    finally:
        asyncio.run(client.close())


def test_submit_job_and_get_job():
    paths_hit: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        paths_hit.append(request.url.path)
        if request.method == "POST":
            return httpx.Response(201, json={"id": "job-1", "status": "queued"})
        return httpx.Response(200, json={"id": "job-1", "status": "done"})

    client = _make_client(handler)
    import asyncio
    try:
        out = asyncio.run(client.submit_job({"description": "x"}))
        assert out["id"] == "job-1"
        out2 = asyncio.run(client.get_job("job-1"))
        assert out2["status"] == "done"
    finally:
        asyncio.run(client.close())


def test_4xx_raises_eden_api_error():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, json={"detail": "missing"})

    client = _make_client(handler)
    import asyncio
    try:
        with pytest.raises(EdenAPIError) as excinfo:
            asyncio.run(client.list_traces())
        assert excinfo.value.status_code == 404
        assert excinfo.value.detail == {"detail": "missing"}
    finally:
        asyncio.run(client.close())


def test_5xx_retries_then_succeeds():
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] < 2:
            return httpx.Response(503, json={"err": "busy"})
        return httpx.Response(200, json={"ok": True})

    client = _make_client(handler)
    import asyncio
    try:
        out = asyncio.run(client.list_traces())
        assert out == {"ok": True}
        assert calls["n"] >= 2
    finally:
        asyncio.run(client.close())


def test_context_manager_closes():
    async def _run():
        async with eden_client(EdenCLIConfig(api_key="k", org_id="o", base_url="http://x")) as c:
            assert c._client is not None
        # After exit, the underlying client should be closed
        assert c._client is None or c._client.is_closed
    import asyncio
    asyncio.run(_run())
