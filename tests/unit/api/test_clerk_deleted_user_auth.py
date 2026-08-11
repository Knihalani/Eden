"""Deleted-Clerk-account auth invariant.

Bug: deleting a Clerk user leaves the browser holding a still-valid
session JWT (Clerk revokes sessions server-side, but the signed token
lives on until refresh/expiry). The backend verified only the JWT
signature, so a deleted account could keep authenticating — and
``/auth/me``'s auto-provision would even re-create a zombie ``users``
row for the deleted Clerk id (the "deleted in Clerk but still lets me
into Eden" bug).

Invariant under test: a soft-deleted Eden row (``users.deleted_at``
set — written by the ``user.deleted`` webhook or Eden erasure) must
fail closed on EVERY auth path:

* ``get_current_user`` (Clerk JWT)  → 401 "Account has been deleted"
* ``get_current_user`` (legacy cookie JWT) → 401 (same detail)
* ``get_current_org`` (org-scoped routes) → None (fail closed)
* ``/auth/me`` auto-provision      → Clerk 404 → 401, no INSERT
* ``clerk_webhooks._deactivate_user`` → rotates token_version + drops
  in-process caches so a resurrected session can't ride stale state
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

from eden.api.utils.clerk_client import (
    ClerkUserNotFoundError,
)

# A Clerk-shaped session JWT payload (``iss`` present) so
# ``_is_clerk_payload_public`` treats it as a Clerk session.
CLERK_ISS = "https://clerk.edenobservability.com"


def _deleted_row(clerk_id: str) -> dict:
    return {
        "id": "00000000-0000-0000-0000-000000000099",
        "email": "deleted@example.com",
        "name": "Deleted User",
        "created_at": None,
        "preferred_org_id": None,
        "clerk_id": clerk_id,
        "deleted_at": datetime.now(UTC),
    }


class TestDeletedClerkUserRejected:
    def test_auth_me_401_for_deleted_clerk_user(
        self, mock_postgres_client, api_client: TestClient
    ) -> None:
        """A valid-but-orphaned Clerk JWT for a soft-deleted Eden row
        must 401 on /auth/me — the portal's boot endpoint — instead of
        returning 200 and letting the deleted account back in."""
        clerk_id = "user_2deletedaccount"
        mock_postgres_client._fetchrow_overrides.append(
            ("WHERE clerk_id::text", _deleted_row(clerk_id))
        )

        with patch(
            "eden.api.utils.clerk_auth.verify_clerk_token",
            new_callable=AsyncMock,
            return_value={
                "sub": clerk_id,
                "email": "deleted@example.com",
                "iss": CLERK_ISS,
            },
        ):
            response = api_client.get(
                "/auth/me",
                headers={"Authorization": "Bearer fake-clerk-jwt"},
            )

        assert response.status_code == 401, response.text
        assert "deleted" in response.json().get("detail", "").lower()

    def test_legacy_cookie_jwt_401_for_deleted_user(
        self, mock_postgres_client, api_client: TestClient
    ) -> None:
        """The legacy Eden cookie path must also reject soft-deleted
        rows. ``user.deleted`` webhooks don't rotate ``token_version``,
        so a pre-deletion cookie JWT would otherwise keep working for
        its remaining lifetime."""
        # get_current_user's legacy branch reads
        # ``SELECT token_version, last_seen_at, deleted_at ... WHERE id = $1``.
        mock_postgres_client._fetchrow_overrides.append(
            (
                "users WHERE id",
                {
                    "id": "user-123",
                    "token_version": 1,
                    "last_seen_at": None,
                    "deleted_at": datetime.now(UTC),
                },
            )
        )

        from eden.api.utils.auth import create_access_token

        token = create_access_token(
            data={"sub": "user-123", "email": "deleted@example.com"},
            token_version=1,
        )
        api_client.cookies.set("authorization", token)
        response = api_client.get("/auth/me")

        assert response.status_code == 401, response.text
        assert "deleted" in response.json().get("detail", "").lower()

    def test_get_current_org_fails_closed_for_deleted_user(
        self, mock_postgres_client
    ) -> None:
        """Org-scoped routes (``require_org_member`` / ``require_org_admin``
        / ``require_path_org_access``) resolve through ``get_current_org``;
        a deleted user must resolve to None so those routes 403/401
        instead of continuing to read org data."""
        from eden.api.deps import get_current_org

        payload = {
            "sub": "user_2orgdel",
            "iss": CLERK_ISS,
            "o": {"id": "org_2x", "rol": "admin"},
        }
        mock_postgres_client._fetchrow_overrides.append(
            (
                "FROM org_members om",
                {
                    "role": "admin",
                    "name": "Org",
                    "slug": "org",
                    "owner_id": "eden-user-1",
                    "archived_at": None,
                    "user_deleted_at": datetime.now(UTC),
                },
            )
        )

        async def run():
            return await get_current_org(None, payload)

        result = asyncio.run(run())
        assert result is None

    def test_get_optional_user_returns_none_for_deleted(
        self, mock_postgres_client
    ) -> None:
        """Optional-auth routes (e.g. agents register) treat a deleted
        Clerk user as unauthenticated."""
        from eden.api.deps import get_optional_user

        clerk_id = "user_2optdel"
        mock_postgres_client._fetchrow_overrides.append(
            ("WHERE clerk_id::text", _deleted_row(clerk_id))
        )

        async def run():
            return await get_optional_user(
                {"sub": clerk_id, "iss": CLERK_ISS, "email": "x@y.com"}
            )

        assert asyncio.run(run()) is None

    def test_get_optional_user_returns_none_for_deleted_legacy(
        self, mock_postgres_client
    ) -> None:
        """Same invariant on the legacy Eden cookie path: a deleted
        user's old cookie must not authenticate on optional-auth
        routes (token_version isn't checked there)."""
        from eden.api.deps import get_optional_user

        eden_id = "00000000-0000-0000-0000-000000000033"
        mock_postgres_client._fetchrow_overrides.append(
            ("WHERE id::text", _deleted_row("user_2legacydel"))
        )

        async def run():
            return await get_optional_user(
                {"sub": eden_id, "email": "x@y.com"}
            )

        assert asyncio.run(run()) is None


class TestAutoProvisionExistenceGate:
    def test_auth_me_refuses_to_provision_when_clerk_404s(
        self, mock_postgres_client, api_client: TestClient
    ) -> None:
        """No Eden row + Clerk answers 404 (user deleted) → 401 and NO
        INSERT. Before the fix this auto-provisioned a zombie row for
        the deleted account."""
        clerk_id = "user_2ghostdeleted"
        # get_me's get_eden_user_row_from_auth miss (no Eden row yet).
        mock_postgres_client._fetchrow_overrides.append(
            ("WHERE clerk_id::text", None)
        )

        with patch(
            "eden.api.utils.clerk_auth.verify_clerk_token",
            new_callable=AsyncMock,
            return_value={"sub": clerk_id, "email": "ghost@example.com"},
        ), patch(
            "eden.api.routes.auth.clerk_get_user",
            new_callable=AsyncMock,
            side_effect=ClerkUserNotFoundError(
                f"Clerk 404 on /users/{clerk_id}"
            ),
        ):
            response = api_client.get(
                "/auth/me",
                headers={"Authorization": "Bearer fake-clerk-jwt"},
            )

        assert response.status_code == 401, response.text
        assert "no longer exists" in response.json().get("detail", "").lower()
        insert_calls = [
            c
            for c in mock_postgres_client.fetchrow.call_args_list
            if c.args and "INSERT INTO users" in c.args[0]
        ]
        assert insert_calls == [], f"zombie provision fired: {insert_calls}"

    def test_auth_me_provisions_when_clerk_user_exists(
        self, mock_postgres_client, api_client: TestClient
    ) -> None:
        """The existence gate must not break the legit signup path:
        Clerk user exists (webhook lag, no Eden row yet) → provision."""
        clerk_id = "user_2freshsignup"
        provisioned_row = {
            "id": "00000000-0000-0000-0000-000000000111",
            "email": "fresh@example.com",
            "name": "fresh",
            "created_at": None,
            "preferred_org_id": None,
            "clerk_id": clerk_id,
        }
        mock_postgres_client._fetchrow_overrides.append(
            ("WHERE clerk_id::text", None)
        )
        mock_postgres_client._fetchrow_overrides.append(
            ("INSERT INTO users", provisioned_row)
        )

        with patch(
            "eden.api.utils.clerk_auth.verify_clerk_token",
            new_callable=AsyncMock,
            return_value={"sub": clerk_id, "email": "fresh@example.com"},
        ), patch(
            "eden.api.routes.auth.clerk_get_user",
            new_callable=AsyncMock,
            return_value={
                "id": clerk_id,
                "email_addresses": [
                    {"email_address": "fresh@example.com", "id": "idn_1"},
                ],
                "primary_email_address_id": "idn_1",
                "first_name": "Fresh",
                "last_name": "",
                "image_url": "",
            },
        ):
            response = api_client.get(
                "/auth/me",
                headers={"Authorization": "Bearer fake-clerk-jwt"},
            )

        assert response.status_code == 200, response.text
        assert response.json()["email"] == "fresh@example.com"


class TestClerkUserNotFoundError:
    def test_is_clerk_api_error_subclass(self) -> None:
        from eden.api.utils.clerk_client import ClerkAPIError

        assert issubclass(ClerkUserNotFoundError, ClerkAPIError)

    def test_get_user_reraises_404(
        self, mock_postgres_client
    ) -> None:
        """``get_user`` must propagate 404 as ClerkUserNotFoundError so
        /auth/me can distinguish "deleted" from "Clerk is down"."""
        from eden.api.utils import clerk_client

        with patch(
            "eden.api.utils.clerk_client._get",
            new_callable=AsyncMock,
            side_effect=ClerkUserNotFoundError("Clerk 404 on /users/user_x"),
        ):
            with pytest.raises(ClerkUserNotFoundError):
                asyncio.run(clerk_client.get_user("user_x"))

    def test_get_user_returns_none_on_api_failure(
        self, mock_postgres_client
    ) -> None:
        """A non-404 failure (timeout / 5xx) still degrades to None —
        the webhook-lag tolerance depends on it."""
        from eden.api.utils import clerk_client

        with patch(
            "eden.api.utils.clerk_client._get",
            new_callable=AsyncMock,
            side_effect=clerk_client.ClerkAPIError("Clerk 500 on /users/user_y"),
        ):
            result = asyncio.run(clerk_client.get_user("user_y"))

        assert result is None


class TestWebhookDeactivate:
    def test_deactivate_bumps_token_version_and_invalidates_caches(
        self, mock_postgres_client
    ) -> None:
        """``user.deleted`` must (1) set deleted_at, (2) rotate
        token_version so legacy cookie JWTs die immediately, and
        (3) drop the in-process id / last-seen / Clerk-API caches so a
        stale session can't ride cached membership resolution."""
        from eden.api import deps
        from eden.api.routes.clerk_webhooks import _deactivate_user
        from eden.api.utils import clerk_client

        clerk_id = "user_2webhookdel"
        eden_id = "00000000-0000-0000-0000-000000000222"
        mock_postgres_client._fetchrow_overrides.append(
            ("RETURNING id", {"id": eden_id})
        )

        # Seed caches as a mid-flight session would leave them.
        deps._user_id_cache[clerk_id] = (0.0, eden_id)
        deps._user_id_cache[eden_id] = (0.0, eden_id)
        deps._last_seen_bumped_at[clerk_id] = 1.0
        clerk_client._USER_CACHE[clerk_id] = (0.0, {"id": clerk_id})

        asyncio.run(_deactivate_user({"id": clerk_id}))

        sql = mock_postgres_client.fetchrow.call_args.args[0]
        assert "deleted_at = NOW()" in sql
        assert "token_version" in sql and "COALESCE" in sql
        assert "RETURNING id" in sql

        assert clerk_id not in deps._user_id_cache
        assert eden_id not in deps._user_id_cache
        assert clerk_id not in deps._last_seen_bumped_at
        assert clerk_id not in clerk_client._USER_CACHE

    def test_deactivate_no_row_is_silent(
        self, mock_postgres_client
    ) -> None:
        """A webhook for a clerk_id Eden never provisioned must not
        crash or pollute caches."""
        from eden.api.routes.clerk_webhooks import _deactivate_user

        mock_postgres_client._fetchrow_overrides.append(
            ("RETURNING id", None)
        )

        # Should not raise.
        asyncio.run(_deactivate_user({"id": "user_2neverprovisioned"}))
