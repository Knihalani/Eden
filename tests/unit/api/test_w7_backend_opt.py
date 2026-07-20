"""Worker 7 — backend middleware / rate-limit / pool hot-path opts."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from starlette.requests import Request


@pytest.mark.asyncio
async def test_api_key_org_resolve_is_single_db_round_trip():
    """API-key requests must not hit Postgres twice for org + key id."""
    from eden.api.middleware.tenant_rate_limit import TenantRateLimitMiddleware

    mw = TenantRateLimitMiddleware(MagicMock())
    try:
        fake_client = MagicMock()
        fake_client.fetchrow = AsyncMock(
            return_value={"id": "key-uuid-1", "org_id": "org-1"}
        )

        scope = {
            "type": "http",
            "asgi": {"version": "3.0"},
            "http_version": "1.1",
            "method": "GET",
            "scheme": "http",
            "path": "/v1/jobs",
            "raw_path": b"/v1/jobs",
            "query_string": b"",
            "headers": [
                (b"x-org-api-key", b"sk_test_secret"),
                (b"x-org-id", b"org-1"),
            ],
            "client": ("127.0.0.1", 1),
            "server": ("test", 80),
        }

        async def receive():
            return {"type": "http.request", "body": b"", "more_body": False}

        request = Request(scope, receive)

        with patch(
            "eden.api.middleware.tenant_rate_limit.get_postgres_client",
            new=AsyncMock(return_value=fake_client),
        ):
            org_id, key_id = await mw._resolve_org_and_api_key(request)

        assert org_id == "org-1"
        assert key_id == "key-uuid-1"
        assert fake_client.fetchrow.await_count == 1
        sql = fake_client.fetchrow.await_args.args[0]
        assert "id" in sql and "org_id" in sql
    finally:
        await mw.shutdown()


@pytest.mark.asyncio
async def test_get_bucket_skips_full_scan_on_hot_path():
    """Bucket acquire must be O(1); eviction is periodic, not per request."""
    from eden.api.middleware.tenant_rate_limit import TenantRateLimitMiddleware

    mw = TenantRateLimitMiddleware(MagicMock())
    try:
        for i in range(50):
            await mw._get_bucket(f"org:{i}", capacity=60, refill_rate=1.0)
        assert len(mw._buckets) == 50
        b1 = await mw._get_bucket("org:0", capacity=60, refill_rate=1.0)
        b2 = await mw._get_bucket("org:0", capacity=60, refill_rate=1.0)
        assert b1 is b2
        assert len(mw._buckets) == 50
    finally:
        await mw.shutdown()


@pytest.mark.asyncio
async def test_quota_skips_second_budget_fetch_when_headers_warmed():
    """Mutating path: header warm + under-cap → no second get_budget_status."""
    from eden.api.middleware.quota_enforcement import QuotaEnforcementMiddleware

    settings = MagicMock()
    settings.quota_enabled = True

    fetch_count = {"n": 0}
    budget = {
        "cost_usd": {
            "used": 0.1,
            "soft_limit": 0.7,
            "hard_limit": 1.0,
            "status": "ok",
            "percentage": 10.0,
        },
        "tokens": {
            "used": 0,
            "soft_limit": 1,
            "hard_limit": 1,
            "status": "ok",
            "percentage": 0,
        },
        "storage_mb": {
            "used": 0,
            "soft_limit": 1,
            "hard_limit": 1,
            "status": "ok",
            "percentage": 0,
        },
        "sandbox_seconds": {
            "used": 0,
            "soft_limit": 1,
            "hard_limit": 1,
            "status": "ok",
            "percentage": 0,
        },
        "plan_name": "org_free",
    }

    class _Svc:
        async def get_budget_status(self, org_id):
            fetch_count["n"] += 1
            return budget

    with patch("eden.config.get_settings", return_value=settings):
        inner_called = {"n": 0}

        async def inner(scope, receive, send):
            inner_called["n"] += 1
            await send({"type": "http.response.start", "status": 200, "headers": []})
            await send({"type": "http.response.body", "body": b"", "more_body": False})

        mw = QuotaEnforcementMiddleware(inner)
        mw._usage_service = _Svc()
        mw._resolve_org_id = AsyncMock(return_value="org-warm")  # type: ignore[method-assign]

        scope = {
            "type": "http",
            "asgi": {"version": "3.0", "spec_version": "2.0"},
            "method": "POST",
            "path": "/orgs/org-warm/sidebar-prefs",
            "raw_path": b"/orgs/org-warm/sidebar-prefs",
            "headers": [],
            "query_string": b"",
        }

        async def receive():
            return {"type": "http.request", "body": b"", "more_body": False}

        sent: list = []

        async def send(msg):
            sent.append(msg)

        await mw(scope, receive, send)

    assert inner_called["n"] == 1
    assert fetch_count["n"] == 1, (
        f"expected one budget fetch (headers warm only), got {fetch_count['n']}"
    )
    starts = [m for m in sent if m["type"] == "http.response.start"]
    assert starts and starts[0]["status"] != 429


@pytest.mark.asyncio
async def test_bounded_gather_caps_concurrency():
    from eden.async_tasks import bounded_gather, reset_bounded_task_semaphores

    reset_bounded_task_semaphores()
    in_flight = 0
    peak = 0
    lock = asyncio.Lock()

    async def _work() -> int:
        nonlocal in_flight, peak
        async with lock:
            in_flight += 1
            peak = max(peak, in_flight)
        await asyncio.sleep(0.03)
        async with lock:
            in_flight -= 1
        return 1

    results = await bounded_gather(
        *(_work() for _ in range(8)),
        limit=2,
        return_exceptions=False,
    )
    assert results == [1] * 8
    assert peak <= 2
    reset_bounded_task_semaphores()


def test_redis_settings_include_timeout_and_pool_cap():
    from eden.config import get_settings

    get_settings.cache_clear()
    s = get_settings()
    assert float(s.redis_socket_timeout) > 0
    assert int(s.redis_max_connections) > 0


@pytest.mark.asyncio
async def test_auth_redis_check_times_out_to_memory_fallback():
    """Hung Redis must not block forever — fall back to in-memory."""
    from eden.api.utils import rate_limit as rl

    class _Hung:
        async def eval(self, *a, **kw):  # noqa: ANN001, ARG002
            await asyncio.sleep(10)
            return [1, 0]

        def register_script(self, _script):  # noqa: ANN001
            raise RuntimeError("no script")

    # Reset cached script between tests.
    rl._auth_sliding_window_script = None

    with (
        patch(
            "eden.storage.redis.get_redis_client",
            AsyncMock(return_value=_Hung()),
        ),
        patch.object(rl, "_AUTH_REDIS_TIMEOUT_S", 0.05),
    ):
        handled, retry = await rl._redis_sliding_window_check("ip-timeout", 5, 60.0)
    assert handled is False
    assert retry is None
