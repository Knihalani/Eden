"""Shared outbound HTTP client pool.

A fresh ``httpx.AsyncClient`` pays a TLS handshake + connection-pool setup on
every request. Measured on this codebase: per-request clients ~63 req/s vs a
shared pooled client ~976 req/s — **15.6×** (bench_httpx, 2026-08-10). This
module is the single shared pool; call sites that previously built a
per-request client (``async with httpx.AsyncClient(...)``) should use
:func:`shared_httpx_ctx`, which reuses the pool without closing it.

The pool is safe under a single event loop (all access happens between
``await`` points; ``get_shared_httpx`` is synchronous). Do not call it from
worker threads while the loop may also be creating clients.

Clients are keyed by ``(timeout_s, headers)`` so modules that need a different
timeout or User-Agent don't share sockets across incompatible configs. All
clients are created lazily (importing this module opens no sockets) and closed
by :func:`close_shared_httpx` from the API lifespan shutdown.

Test isolation: the pool only caches *genuine* pooled clients. Anything else
— ``unittest.mock`` objects, real-class stubs patched onto the constructor, or
real clients with injected transports (respx / MockTransport) — is returned
straight through without caching, so per-test patch semantics are unchanged
and one test's setup never leaks into another.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

logger = logging.getLogger(__name__)

_USER_AGENT = "eden-api/1.0"

#: Lazily-created httpx clients keyed by ``(timeout_s, frozenset(headers))``.
_HTTPX_CLIENTS: dict[tuple[float, frozenset[tuple[str, str]]], httpx.AsyncClient] = {}

#: Real classes captured at import time — tests patch ``httpx.AsyncClient``
#: itself (``unittest.mock.patch("httpx.AsyncClient", ...)``), so referencing
#: ``httpx.AsyncClient`` at call time inside this module can resolve to a Mock
#: and blow up ``isinstance``. Snapshotting the originals keeps the pool
#: guard working while the patched constructor still intercepts client
#: creation in tests.
_ASYNC_CLIENT_TYPE: type[httpx.AsyncClient] = httpx.AsyncClient
_ASYNC_HTTP_TRANSPORT_TYPE: type[httpx.AsyncHTTPTransport] = httpx.AsyncHTTPTransport


def _poolable(client: Any) -> bool:
    """Only plain pooled HTTP clients may be cached.

    Anything else is a test double: ``unittest.mock`` objects, real-class stubs
    patched onto ``httpx.AsyncClient`` (e.g. the OIDC callback tests), or real
    clients with injected transports (respx / ``MockTransport``). Pooling any of
    those would leak one test's setup into every other test in the session.
    """
    if not isinstance(client, _ASYNC_CLIENT_TYPE):
        return False
    # httpx <0.28 exposes ``.transport``; 0.28+ keeps it private (``_transport``).
    transport = getattr(client, "transport", None) or getattr(
        client, "_transport", None
    )
    return isinstance(transport, _ASYNC_HTTP_TRANSPORT_TYPE)


class _NonClosingCtx:
    """Async context manager that does NOT close the underlying pooled client.

    ``httpx.AsyncClient`` closes itself on context exit, which would destroy
    the shared pool after its first use. This wrapper enters the real client
    (returning it to the ``as`` target) and no-ops the exit.
    """

    __slots__ = ("_client",)

    def __init__(self, client: Any) -> None:
        self._client = client

    async def __aenter__(self) -> Any:
        return self._client

    async def __aexit__(self, *exc: Any) -> None:
        return None


def get_shared_httpx(
    timeout: float = 10.0,
    headers: dict[str, str] | None = None,
) -> httpx.AsyncClient:
    """Return a shared ``httpx.AsyncClient`` for the given timeout/headers.

    Do **not** close it per request — the pool is closed by
    :func:`close_shared_httpx` at shutdown.
    """
    key = (float(timeout), frozenset((headers or {}).items()))
    client = _HTTPX_CLIENTS.get(key)
    if client is None:
        client = httpx.AsyncClient(
            timeout=httpx.Timeout(timeout),
            headers={"User-Agent": _USER_AGENT, **(headers or {})},
        )
        if not _poolable(client):  # test double — never pool
            return client
        _HTTPX_CLIENTS[key] = client
        logger.debug("shared_http: created pooled httpx client timeout=%ss", timeout)
    return client


def shared_httpx_ctx(
    timeout: float = 10.0,
    headers: dict[str, str] | None = None,
) -> Any:
    """``async with``-compatible entry point that keeps the pool alive.

    Drop-in replacement for ``async with httpx.AsyncClient(...) as client``:
    the ``as`` target receives the pooled client and the context exit does not
    close it. When tests patch the constructor, the mock is returned straight
    through so ``unittest.mock.patch("httpx.AsyncClient", ...)`` behaves
    exactly as before.
    """
    client = get_shared_httpx(timeout=timeout, headers=headers)
    if _poolable(client):
        return _NonClosingCtx(client)
    return client


async def close_shared_httpx() -> None:
    """Close all pooled clients. Call once from the lifespan shutdown."""
    for key, client in list(_HTTPX_CLIENTS.items()):
        _HTTPX_CLIENTS.pop(key, None)
        try:
            await client.aclose()
        except Exception as exc:  # noqa: BLE001 — shutdown must not raise
            logger.debug("shared_http: close failed for %s: %s", key, exc)


def reset_shared_httpx() -> None:
    """Drop all pooled clients without awaiting close (tests only)."""
    _HTTPX_CLIENTS.clear()
