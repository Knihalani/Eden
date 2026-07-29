"""API-key auth caches validated lookups, and revocation still bites.

``get_current_org_api_key`` ran an uncached ``org_api_keys JOIN
organizations`` query on every ingest and every gateway call — the
hottest query in the product, paid before any real work started. It now
caches the validated context for ``_API_KEY_AUTH_CACHE_TTL_S``.

The cache is only safe if three things hold, so all three are pinned:

1. Only fully-validated rows are cached (never a revoked/expired/disabled
   key), because a hit skips re-validation.
2. The TTL is clamped to the key's own ``expires_at``.
3. Revoking through the API drops the entry immediately on that pod.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock, MagicMock

import pytest

from eden.api import deps


ORG = "11111111-1111-1111-1111-111111111111"
RAW_KEY = "eden_api_key_deadbeef"
KEY_ID = "22222222-2222-2222-2222-222222222222"


def _row(**overrides):
    row = {
        "name": "Acme",
        "slug": "acme",
        "owner_id": "33333333-3333-3333-3333-333333333333",
        "org_id": ORG,
        "scopes": ["ingest:write", "gateway:write"],
        "key_id": KEY_ID,
        "active": True,
        "revoked_at": None,
        "expires_at": None,
        # Recent, so the last_used_at debounce does not fire an UPDATE.
        "last_used_at": datetime.now(UTC),
    }
    row.update(overrides)
    return row


@pytest.fixture(autouse=True)
def _clear_cache():
    deps.invalidate_api_key_cache()
    yield
    deps.invalidate_api_key_cache()


def _client(row):
    client = MagicMock()
    client.fetchrow = AsyncMock(return_value=row)
    client.execute = AsyncMock(return_value=None)
    return client


@pytest.mark.asyncio
async def test_second_call_is_served_from_cache(monkeypatch):
    client = _client(_row())
    monkeypatch.setattr(
        deps, "get_postgres_client", AsyncMock(return_value=client)
    )

    first = await deps.get_current_org_api_key(x_org_id=ORG, x_org_api_key=RAW_KEY)
    second = await deps.get_current_org_api_key(x_org_id=ORG, x_org_api_key=RAW_KEY)

    assert first == second
    assert first["org_id"] == ORG
    assert client.fetchrow.await_count == 1, (
        "second authenticated request re-queried Postgres"
    )


@pytest.mark.asyncio
async def test_cached_context_is_a_copy(monkeypatch):
    """A caller mutating the returned dict must not poison the cache."""
    client = _client(_row())
    monkeypatch.setattr(
        deps, "get_postgres_client", AsyncMock(return_value=client)
    )

    first = await deps.get_current_org_api_key(x_org_id=ORG, x_org_api_key=RAW_KEY)
    first["scopes"] = ["*"]
    first["org_id"] = "hacked"

    second = await deps.get_current_org_api_key(x_org_id=ORG, x_org_api_key=RAW_KEY)
    assert second["org_id"] == ORG
    assert second["scopes"] == ["ingest:write", "gateway:write"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "bad",
    [
        {"active": False},
        {"revoked_at": datetime.now(UTC)},
        {"expires_at": datetime.now(UTC) - timedelta(hours=1)},
    ],
    ids=["disabled", "revoked", "expired"],
)
async def test_invalid_keys_are_never_cached(monkeypatch, bad):
    client = _client(_row(**bad))
    monkeypatch.setattr(
        deps, "get_postgres_client", AsyncMock(return_value=client)
    )

    from fastapi import HTTPException

    for _ in range(2):
        with pytest.raises(HTTPException) as ei:
            await deps.get_current_org_api_key(
                x_org_id=ORG, x_org_api_key=RAW_KEY
            )
        assert ei.value.status_code == 401
    # Both attempts must have re-queried — nothing cached a bad key.
    assert client.fetchrow.await_count == 2


@pytest.mark.asyncio
async def test_ttl_is_clamped_to_key_expiry(monkeypatch):
    """A key expiring inside the TTL window must not be cached past it."""
    soon = datetime.now(UTC) + timedelta(seconds=5)
    client = _client(_row(expires_at=soon))
    monkeypatch.setattr(
        deps, "get_postgres_client", AsyncMock(return_value=client)
    )

    await deps.get_current_org_api_key(x_org_id=ORG, x_org_api_key=RAW_KEY)

    assert len(deps._api_key_auth_cache) == 1
    (expires_at, _ctx) = next(iter(deps._api_key_auth_cache.values()))
    import time

    remaining = expires_at - time.monotonic()
    assert remaining <= 5.5, f"cached past key expiry ({remaining}s)"
    assert remaining < deps._API_KEY_AUTH_CACHE_TTL_S


@pytest.mark.asyncio
async def test_revocation_invalidates_immediately(monkeypatch):
    import hashlib

    client = _client(_row())
    monkeypatch.setattr(
        deps, "get_postgres_client", AsyncMock(return_value=client)
    )

    await deps.get_current_org_api_key(x_org_id=ORG, x_org_api_key=RAW_KEY)
    assert client.fetchrow.await_count == 1

    deps.invalidate_api_key_cache(
        hashlib.sha256(RAW_KEY.encode("utf-8")).hexdigest()
    )

    await deps.get_current_org_api_key(x_org_id=ORG, x_org_api_key=RAW_KEY)
    assert client.fetchrow.await_count == 2, (
        "revoked key still served from cache"
    )


@pytest.mark.asyncio
async def test_cache_is_scoped_per_org(monkeypatch):
    """Same key hash, different X-Org-Id must not share a cache entry."""
    client = _client(_row())
    monkeypatch.setattr(
        deps, "get_postgres_client", AsyncMock(return_value=client)
    )
    other_org = "44444444-4444-4444-4444-444444444444"

    await deps.get_current_org_api_key(x_org_id=ORG, x_org_api_key=RAW_KEY)
    await deps.get_current_org_api_key(
        x_org_id=other_org, x_org_api_key=RAW_KEY
    )
    assert client.fetchrow.await_count == 2


@pytest.mark.asyncio
async def test_cache_is_bounded(monkeypatch):
    client = _client(_row())
    monkeypatch.setattr(
        deps, "get_postgres_client", AsyncMock(return_value=client)
    )

    for i in range(deps._API_KEY_AUTH_CACHE_MAX + 50):
        await deps.get_current_org_api_key(
            x_org_id=ORG, x_org_api_key=f"{RAW_KEY}-{i}"
        )

    assert len(deps._api_key_auth_cache) <= deps._API_KEY_AUTH_CACHE_MAX
