"""Wave 2 Agent 2.1 — Clerk sync races / demotion via last_writer_source.

Covers:
- ``ensure_clerk_membership`` self-heal never overwrites roles
- webhook ``_upsert_membership`` only hands off last_writer when roles agree
- invite accept does not require pre-membership; uses ON CONFLICT DO NOTHING
"""

from __future__ import annotations

import inspect
from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock, MagicMock

import pytest

from eden.api.deps import ensure_clerk_membership
from eden.api.routes.clerk_webhooks import _upsert_membership
from eden.api.routes import orgs as orgs_routes
from eden.services.invitation_service import accept_invitation


@pytest.mark.asyncio
async def test_self_heal_sql_is_insert_do_nothing(monkeypatch):
    """Self-heal must not DO UPDATE role / last_writer_source."""
    execute = AsyncMock()
    mock_client = MagicMock()
    mock_client.execute = execute
    monkeypatch.setattr(
        "eden.api.deps.get_postgres_client",
        AsyncMock(return_value=mock_client),
    )

    assert await ensure_clerk_membership("user-1", "org-1", "org:member") is True
    sql = execute.await_args.args[0]
    assert "INSERT INTO org_members" in sql
    assert "ON CONFLICT (org_id, user_id) DO NOTHING" in sql
    assert "DO UPDATE" not in sql
    assert "last_writer_source = 'clerk'" not in sql.replace(
        "VALUES ($1, $2, $3, NOW(), NOW(), 'clerk')", ""
    )


@pytest.mark.asyncio
async def test_webhook_preserves_local_role_without_unconditional_flip(
    monkeypatch,
):
    """Local owner + org:member webhook must keep role and stay local."""
    execute = AsyncMock()
    mock_client = MagicMock()
    mock_client.execute = execute
    mock_client.fetchrow = AsyncMock(
        side_effect=[
            {"id": "eden-user-uuid"},
            {"id": "eden-org-uuid"},
        ]
    )
    monkeypatch.setattr(
        "eden.api.routes.clerk_webhooks.get_postgres_client",
        AsyncMock(return_value=mock_client),
    )

    await _upsert_membership(
        {
            "organization": {"id": "org_2xabc"},
            "public_user_data": {"user_id": "user_2xabc"},
            "role": "org:member",
        }
    )

    sql = execute.await_args.args[0]
    assert "WHEN org_members.last_writer_source = 'clerk'" in sql
    assert "WHEN org_members.role = EXCLUDED.role" in sql
    assert "ELSE org_members.last_writer_source" in sql
    # Must not unconditionally assign last_writer_source = 'clerk' in SET.
    set_clause = sql.split("DO UPDATE", 1)[1]
    assert "last_writer_source = 'clerk'," not in set_clause
    assert "last_writer_source = CASE" in set_clause
    assert execute.await_args.args[1:] == (
        "eden-org-uuid",
        "eden-user-uuid",
        "member",
    )


@pytest.mark.asyncio
async def test_accept_invitation_do_nothing_and_sets_local_writer(
    monkeypatch,
):
    """Invite accept inserts with last_writer_source=local; no role overwrite."""
    execute = AsyncMock()
    mock_client = MagicMock()
    mock_client.execute = execute
    mock_client.fetchrow = AsyncMock(
        return_value={
            "id": "inv-1",
            "org_id": "org-1",
            "email": "invitee@example.com",
            "role": "viewer",
            "status": "pending",
            "expires_at": datetime.now(UTC) + timedelta(days=7),
            "invited_by": "owner-1",
        }
    )
    monkeypatch.setattr(
        "eden.services.invitation_service.get_postgres_client",
        AsyncMock(return_value=mock_client),
    )
    monkeypatch.setattr(
        "eden.api.routes.billing.sync_plan_usage",
        AsyncMock(),
        raising=False,
    )
    monkeypatch.setattr(
        "eden.api.routes.billing.check_limit",
        AsyncMock(return_value=False),
        raising=False,
    )
    monkeypatch.setattr(
        "eden.api.utils.clerk_client.resolve_clerk_org_id",
        AsyncMock(return_value=None),
    )

    result = await accept_invitation("inv-1", "invitee-user")
    assert result["role"] == "viewer"
    assert result["org_id"] == "org-1"

    member_inserts = [
        c.args[0]
        for c in execute.await_args_list
        if c.args and "INSERT INTO org_members" in c.args[0]
    ]
    assert member_inserts
    sql = member_inserts[0]
    assert "ON CONFLICT (org_id, user_id) DO NOTHING" in sql
    assert "'local'" in sql
    assert "DO UPDATE" not in sql


def test_accept_org_invitation_route_does_not_require_membership():
    """Accept must not Depends(require_org_member) — invitees are not members yet."""
    src = inspect.getsource(orgs_routes.accept_org_invitation)
    assert "require_org_member" not in src
    assert "_assert_invitation_for_caller" in src
    assert "pre-existing" in src or "do not\n    require" in src or "do not require" in src
