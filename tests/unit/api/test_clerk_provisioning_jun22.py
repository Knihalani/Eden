"""Tests for the June 22 2026 Clerk provisioning fixes.

The two real bugs that broke the portal:
1. ``/auth/me`` auto-provision silently failed because:
   (a) ``password_hash`` was NOT NULL (Clerk users have no password)
   (b) Clerk IDs are strings like ``user_2abc...`` but ``users.id`` is UUID
2. ``/notifications`` handlers called ``get_current_user(cookie_string)``
   which crashed with AttributeError → 500

These tests use the conftest's ``_fetchrow_overrides`` queue to inject
deterministic row responses without touching the database.
"""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

# ─────────────────────────────────────────────────────────────────────────────
# /auth/me with a Clerk-style sub claim
# ─────────────────────────────────────────────────────────────────────────────


class TestAuthMeClerkProvisioning:
    """The post-signup flow that the bug report described.

    Before the fix: GET /auth/me with a Clerk JWT (sub = "user_2abc...")
    → 404 "User not found" → portal stuck on Loading… spinner.
    After the fix: same request → 200 with a populated UserResponse;
    the row was auto-provisioned via the clerk_id column.
    """

    def test_me_with_clerk_id_first_call_provisions(
        self, mock_postgres_client: MagicMock, api_client: TestClient
    ):
        """First call with a fresh Clerk id: should auto-provision
        via INSERT (clerk_id, email, name, password_hash=NULL) and
        return 200."""
        clerk_id = "user_2abc123def456"
        provisioned_row = {
            "id": "00000000-0000-0000-0000-000000000001",
            "email": "newuser@example.com",
            "name": "newuser",
            "created_at": None,
            "preferred_org_id": None,
            "clerk_id": clerk_id,
        }

        # Queue: first lookup-by-clerk_id returns None (triggers
        # INSERT), INSERT returns the provisioned row.
        mock_postgres_client._fetchrow_overrides.append(
            ("WHERE clerk_id::text", None)
        )
        mock_postgres_client._fetchrow_overrides.append(
            ("INSERT INTO users", provisioned_row)
        )

        with patch(
            "eden.api.deps.verify_clerk_token",
            return_value={"sub": clerk_id, "email": "newuser@example.com"},
        ):
            response = api_client.get(
                "/auth/me",
                headers={"Authorization": "Bearer fake-clerk-jwt"},
            )

        assert response.status_code == 200, (
            f"Expected 200, got {response.status_code}: {response.text}"
        )
        data = response.json()
        assert data["email"] == "newuser@example.com"
        assert data["user_id"] == "00000000-0000-0000-0000-000000000001"

    def test_me_with_clerk_id_second_call_is_idempotent(
        self, mock_postgres_client: MagicMock, api_client: TestClient
    ):
        """Second /auth/me for the same Clerk id: row already exists,
        no INSERT needed, 200 returned."""
        clerk_id = "user_2abc123def456"
        existing_row = {
            "id": "00000000-0000-0000-0000-000000000001",
            "email": "newuser@example.com",
            "name": "newuser",
            "created_at": None,
            "preferred_org_id": None,
            "clerk_id": clerk_id,
        }

        # Lookup-by-clerk_id returns the existing row → no INSERT path.
        mock_postgres_client._fetchrow_overrides.append(
            ("WHERE clerk_id::text", existing_row)
        )

        with patch(
            "eden.api.deps.verify_clerk_token",
            return_value={"sub": clerk_id, "email": "newuser@example.com"},
        ):
            response = api_client.get(
                "/auth/me",
                headers={"Authorization": "Bearer fake-clerk-jwt"},
            )

        assert response.status_code == 200, response.text
        assert response.json()["email"] == "newuser@example.com"

    def test_me_unauthenticated_still_returns_401(
        self, api_client: TestClient
    ):
        """Sanity: without any auth header, /auth/me still 401s —
        the Clerk path didn't accidentally weaken auth."""
        response = api_client.get("/auth/me")
        assert response.status_code in (401, 403)


# ─────────────────────────────────────────────────────────────────────────────
# get_user_by_id lookup_column arg
# ─────────────────────────────────────────────────────────────────────────────


class TestGetUserById:
    """The deps.get_user_by_id helper now accepts lookup_column
    so the Clerk path can resolve by Clerk's string id without
    crashing on UUID parse."""

    def test_lookup_column_id_uses_id_column(
        self, mock_postgres_client: MagicMock
    ):
        from eden.api.deps import get_user_by_id

        mock_postgres_client._fetchrow_overrides.append(
            ("WHERE id::text", {
                "id": "user-123",
                "email": "x@y.com",
                "name": "X",
                "created_at": None,
                "preferred_org_id": None,
                "clerk_id": None,
            })
        )

        async def run():
            return await get_user_by_id("user-123", lookup_column="id")

        asyncio.run(run())

        # Find the most recent fetchrow call with WHERE id::text
        calls = [
            c for c in mock_postgres_client.fetchrow.call_args_list
            if "WHERE id::text" in c.args[0]
        ]
        assert calls, "get_user_by_id did not issue a WHERE id::text query"
        # args[1] is the first positional arg after the query — *args
        # from get_user_by_id gets spread into fetchrow(query, *args).
        assert calls[-1].args[1] == "user-123"

    def test_lookup_column_clerk_id_uses_clerk_id_column(
        self, mock_postgres_client: MagicMock
    ):
        from eden.api.deps import get_user_by_id

        mock_postgres_client._fetchrow_overrides.append(
            ("WHERE clerk_id::text", {
                "id": "00000000-0000-0000-0000-000000000001",
                "email": "x@y.com",
                "name": "X",
                "created_at": None,
                "preferred_org_id": None,
                "clerk_id": "user_2abc",
            })
        )

        async def run():
            return await get_user_by_id(
                "user_2abc...", lookup_column="clerk_id"
            )

        asyncio.run(run())

        calls = [
            c for c in mock_postgres_client.fetchrow.call_args_list
            if "WHERE clerk_id::text" in c.args[0]
        ]
        assert calls, "get_user_by_id did not issue a WHERE clerk_id::text query"
        assert calls[-1].args[1] == "user_2abc..."

    def test_lookup_column_rejects_unknown_values(self):
        from eden.api.deps import get_user_by_id

        async def run():
            return await get_user_by_id("user-123", lookup_column="email")

        with pytest.raises(ValueError, match="lookup_column"):
            asyncio.run(run())


# ─────────────────────────────────────────────────────────────────────────────
# Notifications handlers — must not 500
# ─────────────────────────────────────────────────────────────────────────────


class TestNotificationsHandlers:
    """Each of the 6 notifications handlers used to call
    ``await get_current_user(authorization)`` with a raw cookie
    string — a FastAPI dependency passed as a positional arg
    bypasses Depends() and lands in the function body as a string,
    which crashes on ``payload.get("sub")`` → 500.

    After the fix: every handler uses ``Depends(get_current_user)``
    properly, so the authenticated client gets a clean 200."""

    @pytest.fixture
    def stubbed_counts(self, mock_postgres_client: MagicMock):
        """The notifications handler does two fetchrow COUNT(*) calls
        and one fetch for the list. The conftest's default fetchrow
        returns None on COUNT(*) which crashes with 'NoneType not
        subscriptable' — same kind of crash as the original 500."""
        # Pre-load the queue with responses in the order the handler
        # calls them (total count, unread count, then list rows via fetch).
        mock_postgres_client._fetchrow_overrides.append(
            ("SELECT COUNT(*) as count FROM notifications",
             {"count": 0})
        )
        mock_postgres_client._fetchrow_overrides.append(
            ("SELECT COUNT(*) as count FROM notifications WHERE user_id",
             {"count": 0})
        )

    def test_list_notifications_no_longer_500(
        self, authenticated_client: TestClient, stubbed_counts
    ):
        response = authenticated_client.get("/notifications")
        assert response.status_code != 500, (
            f"GET /notifications returned 500: {response.text}"
        )
        assert response.status_code == 200

    def test_list_notifications_with_limit(
        self, authenticated_client: TestClient, stubbed_counts
    ):
        response = authenticated_client.get("/notifications?limit=20")
        assert response.status_code != 500, response.text
        assert response.status_code == 200
        data = response.json()
        assert data["total"] == 0
        assert data["unread_count"] == 0

    def test_list_notifications_unread_only(
        self, authenticated_client: TestClient, stubbed_counts
    ):
        response = authenticated_client.get(
            "/notifications?unread_only=true"
        )
        assert response.status_code != 500, response.text
        assert response.status_code == 200

    def test_create_notification(
        self, authenticated_client: TestClient, mock_postgres_client: MagicMock
    ):
        response = authenticated_client.post(
            "/notifications",
            json={
                "type": "job_completed",
                "title": "Test",
                "message": "Hello",
            },
        )
        assert response.status_code != 500, response.text

    def test_patch_mark_notification_read(
        self, authenticated_client: TestClient
    ):
        response = authenticated_client.patch(
            "/notifications/00000000-0000-0000-0000-000000000000/read"
        )
        assert response.status_code != 500

    def test_patch_mark_all_read(self, authenticated_client: TestClient):
        response = authenticated_client.patch("/notifications/read-all")
        assert response.status_code != 500

    def test_delete_notification(self, authenticated_client: TestClient):
        response = authenticated_client.delete(
            "/notifications/00000000-0000-0000-0000-000000000000"
        )
        assert response.status_code != 500


# ─────────────────────────────────────────────────────────────────────────────
# Clerk webhook _upsert_user with a non-UUID clerk_id
# ─────────────────────────────────────────────────────────────────────────────


class TestClerkWebhookUserUpsert:
    """_upsert_user is the webhook path for Clerk user.created /
    user.updated. Pre-fix, the INSERT omitted password_hash and
    passed a non-UUID clerk_id as users.id — both fatal. Post-fix,
    INSERT keys on clerk_id and explicitly sets password_hash NULL."""

    def test_upsert_user_uses_clerk_id_not_id(
        self, mock_postgres_client: MagicMock
    ):
        from eden.api.routes.clerk_webhooks import _upsert_user

        clerk_id = "user_2webhookabc"
        payload = {
            "id": clerk_id,
            "primary_email_address_id": "email_1",
            "email_addresses": [
                {"id": "email_1", "email_address": "webhook@example.com"},
            ],
            "first_name": "Webhook",
            "last_name": "User",
            "image_url": "https://example.com/avatar.png",
        }

        asyncio.run(_upsert_user(payload))

        mock_postgres_client.execute.assert_called()
        last_sql = mock_postgres_client.execute.call_args.args[0]
        last_args = mock_postgres_client.execute.call_args.args[1:]

        # Must INSERT into users with clerk_id (not id) and explicit NULL
        # password_hash for Clerk-managed users. Must key on clerk_id
        # for idempotent re-delivery.
        assert "INSERT INTO users" in last_sql
        assert "clerk_id" in last_sql
        assert "ON CONFLICT (clerk_id)" in last_sql, (
            "Webhook upsert must use ON CONFLICT (clerk_id) for "
            "idempotent re-deliveries"
        )
        assert "password_hash" in last_sql
        # NULL is passed as a literal in the SQL; the value column is NULL.
        assert "NULL" in last_sql.upper()

        # The clerk_id arg must be in the args (not used as users.id)
        assert clerk_id in last_args, (
            f"clerk_id {clerk_id!r} not in INSERT args: {last_args}"
        )
