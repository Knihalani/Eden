"""Tests for the Phase 7.3e RLS GUC helper.

The RLS policies added in migration 015 use
``current_setting('app.current_org_id', true)`` to filter rows on
the observability / retention / audit tables to the authenticated
tenant. The middleware sets this GUC on every request.

These tests verify the helper:

* Sets the GUC via ``SELECT set_config(...)`` (not the
  connection-level ``SET``, which would leak).
* No-ops on an empty org_id.
* Swallows DB errors so a SET blip doesn't poison the request.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest


@pytest.mark.asyncio
async def test_set_session_org_context_calls_set_config():
    from eden.storage.postgres import set_session_org_context

    client = MagicMock()
    client.execute = AsyncMock(return_value=None)
    await set_session_org_context(client, "org_xyz")
    client.execute.assert_called_once()
    # First positional arg is the SQL — must use set_config (not SET)
    sql = client.execute.await_args[0][0]
    assert "set_config" in sql
    assert "app.current_org_id" in sql
    # Second positional arg is the org_id
    assert client.execute.await_args[0][1] == "org_xyz"


@pytest.mark.asyncio
async def test_set_session_org_context_noop_on_empty_org():
    from eden.storage.postgres import set_session_org_context

    client = MagicMock()
    client.execute = AsyncMock(return_value=None)
    await set_session_org_context(client, "")
    # No DB call when org_id is empty.
    client.execute.assert_not_called()


@pytest.mark.asyncio
async def test_set_session_org_context_swallows_db_errors():
    """A DB blip on the SET must never poison the request."""
    from eden.storage.postgres import set_session_org_context

    client = MagicMock()
    client.execute = AsyncMock(side_effect=RuntimeError("DB down"))
    # Should not raise.
    await set_session_org_context(client, "org_xyz")
