"""Unit tests for fail-closed startup dependency checks."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.api.startup_checks import (
    StartupCheckError,
    check_openrouter,
    check_postgres,
    check_qdrant,
    check_redis,
    check_typesense,
    run_startup_checks,
)


@pytest.mark.asyncio
async def test_check_postgres_ok():
    mock_client = AsyncMock()
    mock_client.fetchval.return_value = 1
    with patch(
        "eden.storage.postgres.get_postgres_client",
        AsyncMock(return_value=mock_client),
    ):
        assert await check_postgres() == "ok"


@pytest.mark.asyncio
async def test_check_redis_missing_url():
    with (
        patch("eden.api.startup_checks.redis_quota_exhausted", create=True),
        patch("eden.storage.redis.redis_quota_exhausted", return_value=False),
        patch("eden.storage.redis.redis_url_configured", return_value=False),
        patch("eden.storage.redis.get_redis_client", AsyncMock(return_value=None)),
    ):
        assert await check_redis() == "not_configured"


@pytest.mark.asyncio
async def test_check_redis_quota_exhausted():
    with (
        patch("eden.storage.redis.redis_quota_exhausted", return_value=True),
        patch("eden.storage.redis.redis_url_configured", return_value=True),
        patch("eden.storage.redis.get_redis_client", AsyncMock(return_value=None)),
    ):
        assert await check_redis() == "quota_exhausted"


@pytest.mark.asyncio
async def test_check_redis_ok():
    mock_client = AsyncMock()
    mock_client.ping.return_value = True
    with (
        patch("eden.storage.redis.redis_quota_exhausted", return_value=False),
        patch("eden.storage.redis.redis_url_configured", return_value=True),
        patch(
            "eden.storage.redis.get_redis_client",
            AsyncMock(return_value=mock_client),
        ),
    ):
        assert await check_redis() == "ok"


@pytest.mark.asyncio
async def test_check_qdrant_ok():
    mock_qdrant = MagicMock()
    mock_qdrant._get_client.return_value.get_collections.return_value = []
    with patch("eden.storage.qdrant.get_qdrant_client", return_value=mock_qdrant):
        assert await check_qdrant() == "ok"


@pytest.mark.asyncio
async def test_check_openrouter_missing_key():
    settings = MagicMock(openrouter_api_key="", openrouter_base_url="https://openrouter.ai/api/v1")
    assert await check_openrouter(settings) == "error: OPENROUTER_API_KEY not configured"


@pytest.mark.asyncio
async def test_check_openrouter_unauthorized():
    settings = MagicMock(
        openrouter_api_key="bad-key",
        openrouter_base_url="https://openrouter.ai/api/v1",
    )
    mock_resp = MagicMock(status_code=401)
    mock_client = AsyncMock()
    mock_client.__aenter__.return_value = mock_client
    mock_client.__aexit__.return_value = None
    mock_client.get.return_value = mock_resp
    with patch("httpx.AsyncClient", return_value=mock_client):
        assert (
            await check_openrouter(settings) == "error: unauthorized (invalid OPENROUTER_API_KEY)"
        )


@pytest.mark.asyncio
async def test_check_typesense_disabled_is_ok():
    with patch(
        "eden.observability.typesense_client.get_typesense_client",
        return_value=None,
    ):
        assert await check_typesense() == "ok"


@pytest.mark.asyncio
async def test_check_typesense_unreachable_is_soft_error():
    mock_client = AsyncMock()
    mock_client.health = AsyncMock(return_value=False)
    with patch(
        "eden.observability.typesense_client.get_typesense_client",
        return_value=mock_client,
    ):
        assert await check_typesense() == "error: typesense unreachable"


@pytest.mark.asyncio
async def test_run_startup_checks_strict_raises():
    settings = MagicMock(strict_startup_checks=True, eden_production=False)

    async def _fail_postgres():
        raise RuntimeError("db down")

    with (
        patch("eden.api.startup_checks.check_postgres", _fail_postgres),
        patch("eden.api.startup_checks.check_redis", AsyncMock(return_value="ok")),
        patch("eden.api.startup_checks.check_qdrant", AsyncMock(return_value="ok")),
        patch("eden.api.startup_checks.check_typesense", AsyncMock(return_value="ok")),
        patch("eden.api.startup_checks.check_openrouter", AsyncMock(return_value="ok")),
    ):
        with pytest.raises(StartupCheckError, match="postgres"):
            await run_startup_checks(settings=settings, strict=True)


@pytest.mark.asyncio
async def test_run_startup_checks_strict_ignores_soft_failures():
    """Redis/Qdrant/Typesense/OpenRouter must not fail-closed the process.

    A soft-dep blip previously marked /ready 503 → Northflank ingress
    returned ``no healthy upstream`` → portal /auth/me + notifications
    503 storm even though Postgres was fine.
    """
    settings = MagicMock(strict_startup_checks=True, eden_production=True)

    with (
        patch("eden.api.startup_checks.check_postgres", AsyncMock(return_value="ok")),
        patch("eden.api.startup_checks.check_redis", AsyncMock(return_value="error: down")),
        patch("eden.api.startup_checks.check_qdrant", AsyncMock(return_value="error: down")),
        patch(
            "eden.api.startup_checks.check_typesense",
            AsyncMock(return_value="error: typesense unreachable"),
        ),
        patch("eden.api.startup_checks.check_openrouter", AsyncMock(return_value="error: down")),
    ):
        results = await run_startup_checks(settings=settings, strict=True)
        assert results["postgres"] == "ok"
        assert results["redis"].startswith("error:")
        assert results["typesense"].startswith("error:")


@pytest.mark.asyncio
async def test_is_ready_requires_postgres_only():
    from eden.api.startup_checks import is_ready

    assert is_ready(None) is False
    assert is_ready({}) is False
    assert is_ready({"postgres": "ok", "redis": "error: down"}) is True
    assert is_ready({"postgres": "error: down", "redis": "ok"}) is False


@pytest.mark.asyncio
async def test_run_startup_checks_non_strict_returns_errors():
    settings = MagicMock(strict_startup_checks=False, eden_production=False)

    with (
        patch("eden.api.startup_checks.check_postgres", AsyncMock(return_value="ok")),
        patch("eden.api.startup_checks.check_redis", AsyncMock(return_value="error: down")),
        patch("eden.api.startup_checks.check_qdrant", AsyncMock(return_value="ok")),
        patch("eden.api.startup_checks.check_typesense", AsyncMock(return_value="ok")),
        patch("eden.api.startup_checks.check_openrouter", AsyncMock(return_value="ok")),
    ):
        results = await run_startup_checks(settings=settings, strict=False)
        assert results["postgres"] == "ok"
        assert results["redis"] == "error: down"
