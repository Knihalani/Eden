"""Tests for the trusted-proxy-aware client-IP resolution in
:class:`eden.api.middleware.tenant_rate_limit.TenantRateLimitMiddleware`.

Audit 2026-07-07: pre-fix the middleware trusted the leftmost X-Forwarded-For
hop unconditionally when building the per-IP rate-limit key. An attacker
could:

1. **Bypass per-IP rate limiting** by sending a fresh ``X-Forwarded-For``
   value on each request (each fresh value gets its own bucket; the
   attacker's actual IP never trips 429).
2. **Concentrate rate-limit hits on a victim** by spoofing their IP via
   ``X-Forwarded-For: <victim-ip>`` (the victim's IP key fills up).

The fix delegates to
:func:`eden.api.utils.client_ip.get_client_ip`, which honours XFF only when
the direct socket peer is in ``TRUSTED_PROXY_CIDRS``.
"""
from __future__ import annotations

import asyncio
from typing import Any

import pytest

from eden.api.middleware.tenant_rate_limit import TenantRateLimitMiddleware
from eden.api.utils import client_ip as client_ip_mod

# ────────────────────────────────────────────────────────────────────────
# Test helpers
# ────────────────────────────────────────────────────────────────────────


def _make_scope(
    path: str = "/", headers: list[tuple[bytes, bytes]] | None = None,
    client: tuple[str, int] = ("1.2.3.4", 5000),
) -> dict[str, Any]:
    return {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.0"},
        "http_version": "1.1",
        "method": "GET",
        "scheme": "http",
        "path": path,
        "raw_path": path.encode("latin1"),
        "query_string": b"",
        "headers": headers or [],
        "client": client,
        "server": ("testserver", 80),
        "root_path": "",
    }


async def _noop_receive() -> dict[str, Any]:
    return {"type": "http.request", "body": b"", "more_body": False}


class _StatusCapture:
    """ASGI ``send`` that just records the status code."""

    def __init__(self) -> None:
        self.status_code: int | None = None
        self.headers: list[tuple[bytes, bytes]] = []

    async def __call__(self, message: dict[str, Any]) -> None:
        if message["type"] == "http.response.start":
            self.status_code = message["status"]
            self.headers = list(message.get("headers") or [])


async def _drive(mw: TenantRateLimitMiddleware, scope: dict[str, Any]) -> int:
    """Drive one request through the middleware and return the
    response status code."""
    send = _StatusCapture()
    await mw(scope, _noop_receive, send)
    return send.status_code or 0


@pytest.fixture
def middleware(monkeypatch):
    """Build a middleware with a tiny limit (3 requests) and a
    no-op inner app so we can hit 429 fast.

    The test ``conftest.py`` sets ``rate_limit_enabled=False`` by
    default (to avoid 429s on back-to-back TestClient calls). The
    rate-limit short-circuit checks ``get_settings().rate_limit_enabled``
    *inside dispatch*, so we patch the middleware module's
    ``get_settings`` binding to flip that flag for this test only.
    """
    from eden.api.middleware import tenant_rate_limit as _trl

    # Re-enable rate limiting for the duration of this test.
    real_get_settings = _trl.get_settings

    def _enabled_get_settings():
        s = real_get_settings()
        # Return a shallow-override view — the middleware only reads
        # ``rate_limit_enabled`` and never mutates settings, so a
        # SimpleNamespace with the patched flag is sufficient.
        from types import SimpleNamespace
        d = dict(s.__dict__)
        d["rate_limit_enabled"] = True
        d["redis_url"] = ""
        return SimpleNamespace(**d)

    monkeypatch.setattr(_trl, "get_settings", _enabled_get_settings)

    called = {"n": 0}

    async def inner(scope, receive, send):
        called["n"] += 1
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b""})

    mw = TenantRateLimitMiddleware(
        app=inner, default_limit=3, default_window=60
    )
    # Disable the periodic cleanup task so it doesn't keep the loop alive.
    mw._running = False
    return mw


@pytest.fixture(autouse=True)
def _restore_trusted_proxy_cidrs():
    """Tests mutate the module-level CIDR list; restore on teardown so
    a leaked state doesn't poison sibling tests."""
    original = client_ip_mod.TRUSTED_PROXY_CIDRS
    yield
    client_ip_mod.TRUSTED_PROXY_CIDRS = original


# ────────────────────────────────────────────────────────────────────────
# Tests
# ────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_untrusted_client_xff_is_ignored(middleware):
    """When no proxy is trusted, a client-supplied XFF must be ignored.

    Reproduces the spoofing bypass: pre-fix the leftmost XFF hop was
    used as the limit key regardless of trust. Post-fix, an
    untrusted client sees their *real* socket IP only.
    """
    client_ip_mod.TRUSTED_PROXY_CIDRS = []  # no trust → XFF ignored

    # 4 requests, each with a different (spoofed) XFF. Without the
    # fix, each spoofed IP gets a fresh bucket → no 429. With the
    # fix, the real socket IP is used for all 4 → the 4th trips 429
    # (limit=3).
    statuses: list[int] = []
    for last_octet in (1, 2, 3, 4):
        scope = _make_scope(
            path="/x",
            headers=[(b"x-forwarded-for", f"9.9.9.{last_octet}".encode())],
        )
        statuses.append(await _drive(middleware, scope))

    assert statuses[-1] == 429, (
        f"XFF spoofing bypass: 4 distinct spoofed XFF values should "
        f"have collapsed to the same real-IP bucket (got {statuses})."
    )
    # The first three should succeed (200).
    assert statuses[:3] == [200, 200, 200]


@pytest.mark.asyncio
async def test_trusted_proxy_xff_is_honoured(middleware):
    """When the direct peer IS a trusted proxy, XFF must still be honoured.

    The fix must not break the legitimate proxy/CDN case where the
    socket peer is the load balancer.
    """
    client_ip_mod.TRUSTED_PROXY_CIDRS = ["127.0.0.0/8", "10.0.0.0/8"]

    # Drain the bucket for XFF "5.6.7.8" (3 requests).
    for _ in range(3):
        scope = _make_scope(
            path="/x",
            headers=[(b"x-forwarded-for", b"5.6.7.8")],
            client=("127.0.0.1", 5000),
        )
        assert await _drive(middleware, scope) == 200
    # 4th request from the same XFF must 429.
    scope = _make_scope(
        path="/x",
        headers=[(b"x-forwarded-for", b"5.6.7.8")],
        client=("127.0.0.1", 5000),
    )
    assert await _drive(middleware, scope) == 429

    # But a different XFF starts a fresh bucket (different client).
    scope = _make_scope(
        path="/x",
        headers=[(b"x-forwarded-for", b"5.6.7.9")],
        client=("127.0.0.1", 5000),
    )
    assert await _drive(middleware, scope) == 200


@pytest.mark.asyncio
async def test_victim_ip_spoofing_is_blocked(middleware):
    """An attacker must NOT be able to fill a victim's IP bucket.

    Pre-fix: an attacker sends ``X-Forwarded-For: <victim>`` and
    the victim's bucket fills up. Post-fix: the direct socket IP
    is used (the attacker's), not the victim.
    """
    client_ip_mod.TRUSTED_PROXY_CIDRS = []  # no trust → XFF ignored

    # Attacker spoofs victim's IP for 4 requests — limit is 3.
    statuses: list[int] = []
    for _ in range(4):
        scope = _make_scope(
            path="/x",
            headers=[(b"x-forwarded-for", b"9.9.9.99")],
        )
        statuses.append(await _drive(middleware, scope))

    # Without the fix the 4th would be 200 (different bucket per
    # spoofed XFF). With the fix the attacker always uses their
    # real IP (1.2.3.4) so the 4th hits 429.
    assert statuses == [200, 200, 200, 429]
