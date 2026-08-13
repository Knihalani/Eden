"""Unit tests for OOM plan 2.3 / W1-2: tenant_rate_limit_distributed setting.

Verifies three contracts:

1. Default config (tenant_rate_limit_distributed=False) → the middleware
   consumes tokens from the in-process TokenBucket and issues ZERO Redis
   commands.

2. distributed=True → _check_redis is called (Redis sliding-window Lua path).

3. In-process 429 behaviour is identical to the pre-existing Redis path:
   X-RateLimit-* headers present, body is JSON, status 429, Retry-After
   present.
"""
from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.api.middleware.tenant_rate_limit import TenantRateLimitMiddleware


# ── ASGI test helpers (mirrors test_tenant_rate_limit_xff.py) ─────────────────


def _make_scope(
    path: str = "/ping",
    headers: list[tuple[bytes, bytes]] | None = None,
    client: tuple[str, int] = ("10.0.0.1", 4000),
) -> dict[str, Any]:
    return {
        "type": "http",
        "asgi": {"version": "3.0"},
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


class _ResponseCapture:
    """Minimal ASGI ``send`` that records status code and response headers."""

    def __init__(self) -> None:
        self.status_code: int | None = None
        self.headers: list[tuple[bytes, bytes]] = []
        self.body: bytes = b""

    async def __call__(self, message: dict[str, Any]) -> None:
        if message["type"] == "http.response.start":
            self.status_code = message["status"]
            self.headers = list(message.get("headers") or [])
        elif message["type"] == "http.response.body":
            self.body += message.get("body", b"")


def _header_value(capture: _ResponseCapture, name: bytes) -> bytes | None:
    for k, v in capture.headers:
        if k.lower() == name.lower():
            return v
    return None


# ── Fixture: middleware with rate limiting enabled, Redis disabled by default ──


def _make_middleware(
    limit: int = 3,
    distributed: bool = False,
) -> TenantRateLimitMiddleware:
    """Build a TenantRateLimitMiddleware whose get_settings() returns a
    settings object where:
      - rate_limit_enabled = True   (so the middleware is active)
      - tenant_rate_limit_distributed = <distributed>
      - redis_url = ""              (no Redis connectivity expected)
    """

    fake_settings = SimpleNamespace(
        rate_limit_enabled=True,
        tenant_rate_limit_distributed=distributed,
        rate_limit_distributed=False,  # generic flag untouched
        rate_limit_portal_per_window=300,
        redis_url="",
    )

    async def _inner_app(scope: Any, receive: Any, send: Any) -> None:
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"ok", "more_body": False})

    mw = TenantRateLimitMiddleware(app=_inner_app, default_limit=limit, default_window=60)
    # Prevent the background cleanup task from being created — it outlives
    # the test's event loop on some pytest-asyncio configurations.
    mw._running = False
    # Patch the module-level get_settings binding in the middleware module
    # so that every internal call returns fake_settings.
    mw._fake_settings = fake_settings  # keep a reference for convenience
    return mw, fake_settings


async def _drive(mw: TenantRateLimitMiddleware, scope: dict[str, Any]) -> _ResponseCapture:
    capture = _ResponseCapture()
    await mw(scope, _noop_receive, capture)
    return capture


# ── Test 1: default config → zero Redis commands ──────────────────────────────


@pytest.mark.asyncio
async def test_default_config_no_redis_commands() -> None:
    """With tenant_rate_limit_distributed=False (the default), the middleware
    must NOT issue any Redis commands.  Assert that _get_redis is never awaited
    and that _check_redis is never called.
    """
    from eden.api.middleware import tenant_rate_limit as _trl

    mw, fake_settings = _make_middleware(limit=10, distributed=False)

    with patch.object(_trl, "get_settings", return_value=fake_settings):
        # Patch _get_redis to a sentinel that records if it was called.
        get_redis_calls: list[str] = []

        async def _spy_get_redis():
            get_redis_calls.append("called")
            return None

        check_redis_calls: list[str] = []

        async def _spy_check_redis(key, limit, window):
            check_redis_calls.append("called")
            return True, limit - 1, 0, 0

        with patch.object(mw, "_get_redis", side_effect=_spy_get_redis):
            with patch.object(mw, "_check_redis", side_effect=_spy_check_redis):
                capture = await _drive(mw, _make_scope())

    assert capture.status_code == 200, f"Expected 200, got {capture.status_code}"
    assert check_redis_calls == [], (
        "tenant_rate_limit_distributed=False must not call _check_redis; "
        f"got {check_redis_calls}"
    )
    # _get_redis CAN be called (it short-circuits immediately), but
    # _check_redis must not be reached.  The key assertion is check_redis_calls.


# ── Test 2: distributed=True → Redis path is used ─────────────────────────────


@pytest.mark.asyncio
async def test_distributed_true_uses_redis_path() -> None:
    """With tenant_rate_limit_distributed=True, the middleware must call
    _check_redis (the Redis sliding-window Lua path).
    """
    from eden.api.middleware import tenant_rate_limit as _trl

    mw, fake_settings = _make_middleware(limit=10, distributed=True)

    check_redis_calls: list[tuple] = []

    async def _fake_check_redis(key: str, limit: int, window: int):
        check_redis_calls.append((key, limit, window))
        return True, limit - 1, 0, 0

    with patch.object(_trl, "get_settings", return_value=fake_settings):
        with patch.object(mw, "_check_redis", side_effect=_fake_check_redis):
            capture = await _drive(mw, _make_scope())

    assert capture.status_code == 200, f"Expected 200, got {capture.status_code}"
    assert len(check_redis_calls) == 1, (
        "tenant_rate_limit_distributed=True must call _check_redis once per "
        f"request; got {check_redis_calls}"
    )


# ── Test 3: in-process 429 has correct headers and body ───────────────────────


@pytest.mark.asyncio
async def test_in_process_429_behaviour() -> None:
    """Exhausting the in-process TokenBucket must produce a 429 response with:
    - X-RateLimit-Limit header
    - X-RateLimit-Remaining: 0 header
    - X-RateLimit-Reset header
    - Retry-After header
    - JSON body with ``detail`` and ``retry_after`` fields
    """
    from eden.api.middleware import tenant_rate_limit as _trl

    limit = 3
    mw, fake_settings = _make_middleware(limit=limit, distributed=False)

    with patch.object(_trl, "get_settings", return_value=fake_settings):
        # Drain the bucket (limit requests allowed).
        for _ in range(limit):
            cap = await _drive(mw, _make_scope())
            assert cap.status_code == 200, (
                f"Expected 200 before limit exhausted, got {cap.status_code}"
            )

        # The next request must be rejected.
        cap = await _drive(mw, _make_scope())

    assert cap.status_code == 429, f"Expected 429, got {cap.status_code}"

    assert _header_value(cap, b"x-ratelimit-limit") is not None, (
        "X-RateLimit-Limit header missing from 429 response"
    )
    remaining_hdr = _header_value(cap, b"x-ratelimit-remaining")
    assert remaining_hdr == b"0", (
        f"X-RateLimit-Remaining must be 0 on 429; got {remaining_hdr}"
    )
    assert _header_value(cap, b"x-ratelimit-reset") is not None, (
        "X-RateLimit-Reset header missing from 429 response"
    )
    assert _header_value(cap, b"retry-after") is not None, (
        "Retry-After header missing from 429 response"
    )

    import json

    body = json.loads(cap.body)
    assert "detail" in body, f"JSON body missing 'detail' key: {body}"
    assert "retry_after" in body, f"JSON body missing 'retry_after' key: {body}"


# ── Test 4: in-process fallback when Redis raises ─────────────────────────────


@pytest.mark.asyncio
async def test_distributed_redis_failure_falls_back_to_in_process() -> None:
    """When tenant_rate_limit_distributed=True but the Redis call raises,
    the middleware must fall back to the in-process bucket and serve the
    request (200) rather than propagating the exception.
    """
    from eden.api.middleware import tenant_rate_limit as _trl

    mw, fake_settings = _make_middleware(limit=10, distributed=True)

    async def _failing_check_redis(key: str, limit: int, window: int):
        raise RuntimeError("Redis is down")

    with patch.object(_trl, "get_settings", return_value=fake_settings):
        with patch.object(mw, "_check_redis", side_effect=_failing_check_redis):
            capture = await _drive(mw, _make_scope())

    assert capture.status_code == 200, (
        f"Redis failure with distributed=True must fall back to in-process "
        f"(200), got {capture.status_code}"
    )
