"""Tests for the shared outbound HTTP pool (``eden.util.shared_http``).

Pins the three properties the pool must hold:

1. **Pooling** — same ``(timeout, headers)`` key returns the same client;
   the pool survives ``async with`` (the context exit must NOT close it).
2. **Test-double isolation** — anything that is not a plain pooled client
   (``unittest.mock`` objects, real-class stubs, injected transports) is
   returned straight through and never cached, so one test's setup cannot
   leak into another.
3. **Shutdown** — ``close_shared_httpx`` releases the pooled clients and
   empties the pool.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from eden.util import shared_http
from eden.util.shared_http import (
    close_shared_httpx,
    get_shared_httpx,
    reset_shared_httpx,
    shared_httpx_ctx,
)

pytestmark = pytest.mark.asyncio


@pytest.fixture(autouse=True)
def _clean_pool():
    reset_shared_httpx()
    yield
    reset_shared_httpx()


class TestPooling:
    async def test_same_key_returns_the_same_client(self) -> None:
        a = get_shared_httpx(timeout=8.0)
        b = get_shared_httpx(timeout=8.0)
        assert a is b

    async def test_different_timeout_is_a_different_client(self) -> None:
        a = get_shared_httpx(timeout=5.0)
        b = get_shared_httpx(timeout=30.0)
        assert a is not b

    async def test_context_exit_does_not_close_the_pool(self) -> None:
        pooled = get_shared_httpx(timeout=7.0)
        async with shared_httpx_ctx(timeout=7.0) as client:
            assert client is pooled
        # httpx.AsyncClient.__aexit__ closes the client; ours must not.
        assert get_shared_httpx(timeout=7.0) is pooled

    async def test_headers_part_of_the_key(self) -> None:
        a = get_shared_httpx(timeout=10.0)
        b = get_shared_httpx(timeout=10.0, headers={"X-Foo": "1"})
        assert a is not b


class TestTestDoubleIsolation:
    async def test_unittest_mock_is_returned_but_not_pooled(self) -> None:
        mock_client = AsyncMock()
        mock_client.__aenter__.return_value = mock_client
        mock_client.__aexit__.return_value = None
        with patch("httpx.AsyncClient", return_value=mock_client):
            client = get_shared_httpx(timeout=10.0)
            assert client is mock_client
            # The pool must stay empty — the patched client must not leak.
            assert shared_http._HTTPX_CLIENTS == {}

    async def test_unittest_mock_keeps_async_with_semantics(self) -> None:
        mock_resp = MagicMock(status_code=401)
        mock_client = AsyncMock()
        mock_client.__aenter__.return_value = mock_client
        mock_client.__aexit__.return_value = None
        mock_client.get.return_value = mock_resp
        with patch("httpx.AsyncClient", return_value=mock_client):
            async with shared_httpx_ctx(timeout=10.0) as client:
                resp = await client.get("https://example.test")
        assert resp is mock_resp
        mock_client.get.assert_awaited_once_with("https://example.test")

    async def test_real_class_stub_is_returned_but_not_pooled(self) -> None:
        """The OIDC-callback test style: a hand-written stub class."""

        class _FakeClient:
            def __init__(self, *args, **kwargs) -> None:
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *exc):
                return False

            async def get(self, url, *args, **kwargs):
                return MagicMock(status_code=200)

        with patch("httpx.AsyncClient", _FakeClient):
            async with shared_httpx_ctx(timeout=10.0) as client:
                resp = await client.get("https://example.test")
        assert resp.status_code == 200
        assert shared_http._HTTPX_CLIENTS == {}

    async def test_injected_transport_client_is_not_pooled(self) -> None:
        class _FakeTransport(httpx.AsyncBaseTransport):
            async def handle_async_request(self, request):
                return httpx.Response(200, json={"ok": True})

        client = httpx.AsyncClient(transport=_FakeTransport())
        assert shared_http._poolable(client) is False
        await client.aclose()


class TestShutdown:
    async def test_close_empties_the_pool(self) -> None:
        get_shared_httpx(timeout=12.0)
        assert len(shared_http._HTTPX_CLIENTS) == 1
        await close_shared_httpx()
        assert shared_http._HTTPX_CLIENTS == {}
        # A later call rebuilds a fresh client.
        assert get_shared_httpx(timeout=12.0) is not None
