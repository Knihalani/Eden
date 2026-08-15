"""B-10 last_used_at debounce for ``eden.api.deps.get_current_org_api_key``.

Mirrors ``TestB10LastUsedAtDebounce`` in
``tests/api/test_session24_b8_b13.py`` (which covers
``api_keys.validate_org_api_key``) but targets the deps-layer auth
path used by ingest / SDK callers.
"""

from __future__ import annotations

import inspect
import textwrap
from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock, patch

import pytest


class TestDepsLastUsedAtDebounce:
    """``UPDATE last_used_at`` is throttled to once per 60s per key."""

    def test_reads_last_used_at_and_60s_throttle(self) -> None:
        """The dep reads ``last_used_at`` and applies a 60s throttle."""
        from eden.api import deps

        source = textwrap.dedent(
            inspect.getsource(deps.get_current_org_api_key)
        )
        assert "last_used_at" in source, (
            "B-10 regression: get_current_org_api_key doesn't read "
            "last_used_at"
        )
        assert "60" in source, (
            "B-10 regression: no 60s throttle constant"
        )

    @pytest.mark.asyncio
    async def test_null_last_used_writes_stamp(self) -> None:
        """A key with ``last_used_at = NULL`` always writes the stamp."""
        from eden.api import deps

        fake_client = AsyncMock()
        fake_row = {
            "name": "Org",
            "slug": "org",
            "owner_id": "owner-uuid",
            "org_id": "org-uuid",
            "scopes": ["ingest:write"],
            "key_id": "key-uuid",
            "active": True,
            "revoked_at": None,
            "expires_at": None,
            "last_used_at": None,
        }
        fake_client.fetchrow = AsyncMock(return_value=fake_row)
        fake_client.execute = AsyncMock()

        with patch(
            "eden.api.deps.get_postgres_client",
            new=AsyncMock(return_value=fake_client),
        ):
            result = await deps.get_current_org_api_key(
                "org-uuid", "eden_api_key_xyz",
            )
        assert result is not None
        assert result["org_id"] == "org-uuid"
        fake_client.execute.assert_called_once()

    @pytest.mark.asyncio
    async def test_recent_last_used_skips_stamp(self) -> None:
        """A key whose ``last_used_at`` is < 60s old does NOT write."""
        from eden.api import deps

        fake_client = AsyncMock()
        fake_row = {
            "name": "Org",
            "slug": "org",
            "owner_id": "owner-uuid",
            "org_id": "org-uuid",
            "scopes": ["ingest:write"],
            "key_id": "key-uuid",
            "active": True,
            "revoked_at": None,
            "expires_at": None,
            "last_used_at": datetime.now(UTC) - timedelta(seconds=10),
        }
        fake_client.fetchrow = AsyncMock(return_value=fake_row)
        fake_client.execute = AsyncMock()

        with patch(
            "eden.api.deps.get_postgres_client",
            new=AsyncMock(return_value=fake_client),
        ):
            result = await deps.get_current_org_api_key(
                "org-uuid", "eden_api_key_xyz",
            )
        assert result is not None
        fake_client.execute.assert_not_called()

    @pytest.mark.asyncio
    async def test_stale_last_used_writes_stamp(self) -> None:
        """A key whose ``last_used_at`` is ≥ 60s old writes the stamp."""
        from eden.api import deps

        fake_client = AsyncMock()
        fake_row = {
            "name": "Org",
            "slug": "org",
            "owner_id": "owner-uuid",
            "org_id": "org-uuid",
            "scopes": ["ingest:write"],
            "key_id": "key-uuid",
            "active": True,
            "revoked_at": None,
            "expires_at": None,
            "last_used_at": datetime.now(UTC) - timedelta(seconds=90),
        }
        fake_client.fetchrow = AsyncMock(return_value=fake_row)
        fake_client.execute = AsyncMock()

        with patch(
            "eden.api.deps.get_postgres_client",
            new=AsyncMock(return_value=fake_client),
        ):
            result = await deps.get_current_org_api_key(
                "org-uuid", "eden_api_key_xyz",
            )
        assert result is not None
        fake_client.execute.assert_called_once()
