"""POST /orgs must not cast ``organizations.owner_id`` to uuid.

Prod stores ``users.id`` / ``organizations.owner_id`` as TEXT (Clerk-era
schema). The create_org idempotency query used ``owner_id = $1::uuid``,
which raises ``operator does not exist: text = uuid`` and 500s every
onboarding auto-create before the org row is written.
"""

from __future__ import annotations

import inspect

import pytest


def test_ensure_clerk_org_insert_does_not_cast_owner_id_to_uuid() -> None:
    """Session self-heal INSERT must match TEXT ``organizations.owner_id``."""
    import inspect

    from eden.api import deps as deps_mod

    source = inspect.getsource(deps_mod.ensure_clerk_org_from_session)
    assert "$4::uuid" not in source
    assert "$4, NOW()" in source or "$4, NULL, NOW()" in source


def test_webhook_upsert_org_insert_does_not_cast_owner_id_to_uuid() -> None:
    import inspect

    from eden.api.routes import clerk_webhooks as wh

    source = inspect.getsource(wh._upsert_org)
    assert "$4::uuid" not in source


def test_create_org_seeds_settings_not_missing_features_column() -> None:
    import inspect

    from eden.api.routes import orgs as orgs_mod

    source = inspect.getsource(orgs_mod.create_org)
    assert "SET features =" not in source
    assert "SET settings =" in source


def test_create_org_idempotency_sql_does_not_cast_owner_id_to_uuid() -> None:
    from eden.api.routes import orgs as orgs_mod

    source = inspect.getsource(orgs_mod.create_org)
    # Only the executable SQL matters — the docstring may mention the
    # forbidden cast as the bug we fixed.
    sql_start = source.index("SELECT id::text AS id, name, slug, clerk_org_id")
    sql_end = source.index("user_id,", sql_start)
    idempotency_sql = source[sql_start:sql_end]
    assert "owner_id = $1::uuid" not in idempotency_sql
    assert "WHERE owner_id = $1" in idempotency_sql


@pytest.mark.asyncio
async def test_create_org_survives_text_owner_id_idempotency_lookup(monkeypatch):
    """Simulate prod: owner_id compare as text; duplicate short-circuit works."""
    from eden.api.routes import orgs as orgs_mod

    mock_client = __import__("unittest.mock", fromlist=["MagicMock"]).MagicMock()
    AsyncMock = __import__("unittest.mock", fromlist=["AsyncMock"]).AsyncMock

    async def _fetchrow(query, *args):
        if "owner_id = $1" in query and "60 seconds" in query:
            assert "::uuid" not in query.split("owner_id = $1", 1)[1].split("\n", 1)[0]
            return {
                "id": "org-dup",
                "name": "My workspace",
                "slug": "my-workspace",
                "clerk_org_id": "org_clerk",
            }
        raise AssertionError(f"unexpected fetchrow: {query[:80]}")

    mock_client.fetchrow = AsyncMock(side_effect=_fetchrow)
    mock_client.fetchval = AsyncMock()
    mock_client.execute = AsyncMock()

    monkeypatch.setattr(orgs_mod, "get_postgres_client", AsyncMock(return_value=mock_client))
    monkeypatch.setattr(orgs_mod, "eden_user_id_from_auth", AsyncMock(return_value="user-text-id"))

    result = await orgs_mod.create_org(
        name="My workspace",
        make_default=True,
        user={"user_id": "user-text-id"},
    )
    assert result["org_id"] == "org-dup"
    assert result["role"] == "owner"
    mock_client.execute.assert_not_called()
