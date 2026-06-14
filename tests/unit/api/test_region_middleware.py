"""Tests for the Phase 7.3c ``X-Region-Hint`` middleware plumbing.

The middleware sets the ``X-Region-Hint`` response header when the
resolved tenant has a region. The DB lookup is best-effort and
cached in-process.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


@pytest.fixture
async def fresh_middleware():
    """Build a fresh middleware inside a running event loop so its
    background cleanup task can be created."""
    from eden.api.middleware.tenant_rate_limit import TenantRateLimitMiddleware

    app = MagicMock()
    mw = TenantRateLimitMiddleware(app=app, default_limit=60, default_window=60)
    try:
        yield mw
    finally:
        # Stop the background task to avoid "coroutine was never awaited"
        # warnings at teardown.
        await mw.shutdown()


@pytest.mark.asyncio
async def test_resolve_region_returns_none_when_no_org_id(fresh_middleware):
    assert await fresh_middleware._resolve_region(None) is None


@pytest.mark.asyncio
async def test_resolve_region_returns_none_on_db_error(fresh_middleware):
    """DB blip → returns None; caller treats as best-effort and
    simply omits the header. Never raises."""
    with patch(
        "eden.storage.postgres.get_postgres_client",
        new=AsyncMock(side_effect=RuntimeError("DB down")),
    ):
        assert await fresh_middleware._resolve_region("org_x") is None


@pytest.mark.asyncio
async def test_resolve_region_returns_value_when_set(fresh_middleware):
    fake_row = {"region": "eu"}
    fake_client = MagicMock()
    fake_client.fetchrow = AsyncMock(return_value=fake_row)
    with patch(
        "eden.storage.postgres.get_postgres_client",
        new=AsyncMock(return_value=fake_client),
    ):
        region = await fresh_middleware._resolve_region("org_eu")
    assert region == "eu"


@pytest.mark.asyncio
async def test_resolve_region_caches_result(fresh_middleware):
    """Second call within the TTL should not hit the DB again."""
    fake_client = MagicMock()
    fake_client.fetchrow = AsyncMock(return_value={"region": "ap"})
    with patch(
        "eden.storage.postgres.get_postgres_client",
        new=AsyncMock(return_value=fake_client),
    ):
        r1 = await fresh_middleware._resolve_region("org_ap")
        r2 = await fresh_middleware._resolve_region("org_ap")
    assert r1 == "ap"
    assert r2 == "ap"
    # Only one DB hit.
    assert fake_client.fetchrow.call_count == 1


@pytest.mark.asyncio
async def test_resolve_region_handles_null_region(fresh_middleware):
    """Tenant exists but region is NULL → returns None."""
    fake_client = MagicMock()
    fake_client.fetchrow = AsyncMock(return_value={"region": None})
    with patch(
        "eden.storage.postgres.get_postgres_client",
        new=AsyncMock(return_value=fake_client),
    ):
        region = await fresh_middleware._resolve_region("org_no_region")
    assert region is None
