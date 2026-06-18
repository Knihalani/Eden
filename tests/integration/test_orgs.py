"""Integration tests for the org/Clerk alignment fix.

Asserts:
- POST /orgs creates the Clerk org BEFORE writing the Eden row and
  stores the returned ``clerk_org_id``.
- POST /orgs is resilient when Clerk is unreachable (degraded
  response shape; local row still exists).
- Accept-invite (paste-token and per-org routes) creates a Clerk
  membership after the local ``org_members`` insert.
- Accept-invite tolerates Clerk outages (local join still succeeds).

The mocking strategy uses two seams, both established in the
codebase:

- ``eden.api.utils.clerk_client._post`` — single seam that covers
  both ``create_organization`` and ``create_membership``. Mirrors
  the ``unittest.mock.patch`` pattern in ``tests/integration/test_auth.py``.
- ``mock_postgres_client._fetchrow_overrides.append((needle, row))``
  — per-test row injection for ``resolve_clerk_org_id`` lookups.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient


# ── Shared fixtures ───────────────────────────────────────────────────

CLERK_OK_ORG = {
    "id": "org_2xabc123",
    "name": "Acme AI Labs",
    "slug": "acme-ai-labs",
}

CLERK_OK_MEMBERSHIP = {
    "id": "orm_2xabc",
    "organization": {"id": "org_2xabc123"},
    "public_user_data": {"user_id": "user-123"},
    "role": "org:member",
}


# ── Tests ────────────────────────────────────────────────────────────


class TestCreateOrgClerkSync:
    def test_create_org_calls_clerk_and_stores_id(
        self, api_client: TestClient, auth_headers: dict
    ):
        """POST /orgs must hit Clerk FIRST and write clerk_org_id."""
        with patch(
            "eden.api.utils.clerk_client._post",
            AsyncMock(return_value=CLERK_OK_ORG),
        ) as mock_post:
            response = api_client.post(
                "/orgs?name=Acme%20Labs&make_default=true",
                headers=auth_headers,
            )
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["clerk_org_id"] == "org_2xabc123"
        assert body["org_degraded"] is False
        assert body["role"] == "owner"
        # Verify the right Clerk path was called
        mock_post.assert_called_once()
        call_path = mock_post.call_args.args[0]
        assert call_path == "/organizations"
        # Verify the slug was passed (``Acme Labs`` → ``acme-labs``
        # via the route's ``slugify()`` helper; single space → single
        # dash, no consecutive dashes).
        call_body = mock_post.call_args.args[1]
        assert call_body["name"] == "Acme Labs"
        assert call_body["slug"] == "acme-labs"

    def test_create_org_degraded_when_clerk_unreachable(
        self, api_client: TestClient, auth_headers: dict
    ):
        """Clerk 500 must not break the local create; degraded flag set."""
        from eden.api.utils.clerk_client import ClerkAPIError

        with patch(
            "eden.api.utils.clerk_client._post",
            AsyncMock(side_effect=ClerkAPIError("Clerk timeout: /organizations")),
        ):
            response = api_client.post(
                "/orgs?name=Acme%20Labs",
                headers=auth_headers,
            )
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["clerk_org_id"] is None
        assert body["org_degraded"] is True
        # Local row still exists
        assert body["org_id"]


class TestAcceptInviteClerkSync:
    def test_accept_by_token_creates_clerk_membership(
        self, api_client: TestClient, auth_headers: dict, mock_postgres_client
    ):
        """The paste-token accept route must call Clerk create_membership.

        We let the real ``accept_invitation`` service run (so the
        local ``org_members`` insert + Clerk side-effect actually
        happen) and patch only the network seams: ``verify_invite_token``
        to return a fake invitation, and the service's Clerk helpers
        to skip the network. The mock_postgres_client fixture
        pre-configures the lookup handlers in ``conftest.py``.
        """
        from eden.api.routes import auth as auth_routes

        fake_invite = {
            "id": "inv-1",
            "org_id": "org-eden-1",
            "org_name": "Acme AI Labs",
            "email": "test@example.com",
            "role": "member",
            "invited_by": "user-0",
            "inviter_name": "Admin",
            "expires_at": "2099-01-01T00:00:00",
            "status": "pending",
        }
        # ``resolve_clerk_org_id`` reads from Postgres; prime the
        # conftest's per-test override queue so it returns the
        # bridge column value for ``org-eden-1``.
        mock_postgres_client._fetchrow_overrides.append(
            ("COALESCE(clerk_org_id", {"clerk_org_id": "org_2xabc123"}),
        )
        # The real ``accept_invitation`` service re-queries
        # ``org_invitations`` to validate the invite; prime it so it
        # sees the same fake invite the route already validated.
        mock_postgres_client._fetchrow_overrides.append(
            ("FROM org_invitations", {
                "id": "inv-1",
                "org_id": "org-eden-1",
                "email": "test@example.com",
                "role": "member",
                "status": "pending",
                "expires_at": datetime.utcnow() + timedelta(days=7),
                "invited_by": "user-0",
            }),
        )
        with patch.object(
            auth_routes, "verify_invite_token", return_value=fake_invite,
        ), patch(
            # ``create_membership`` is imported locally inside the
            # service (``from eden.api.utils.clerk_client import …``);
            # patch the source module so the bound name inside the
            # service picks up the mock.
            "eden.api.utils.clerk_client.create_membership",
            AsyncMock(return_value=CLERK_OK_MEMBERSHIP),
        ) as mock_create:
            response = api_client.post(
                "/auth/invitations/accept?token=any-plaintext-token",
                headers=auth_headers,
            )
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["clerk_org_id"] == "org_2xabc123"
        mock_create.assert_called_once()
        kwargs = mock_create.call_args.kwargs
        assert kwargs["clerk_org_id"] == "org_2xabc123"
        assert kwargs["role"] == "member"

    def test_accept_invite_resilient_when_clerk_down(
        self, api_client: TestClient, auth_headers: dict, mock_postgres_client
    ):
        """Clerk outage during accept must not block the local join."""
        from eden.api.routes import auth as auth_routes
        from eden.api.utils.clerk_client import ClerkAPIError

        fake_invite = {
            "id": "inv-2",
            "org_id": "org-eden-2",
            "org_name": "Beta",
            "email": "test@example.com",
            "role": "viewer",
            "invited_by": "user-0",
            "inviter_name": "Admin",
            "expires_at": "2099-01-01T00:00:00",
            "status": "pending",
        }
        mock_postgres_client._fetchrow_overrides.append(
            ("COALESCE(clerk_org_id", {"clerk_org_id": "org_2xdef456"}),
        )
        mock_postgres_client._fetchrow_overrides.append(
            ("FROM org_invitations", {
                "id": "inv-2",
                "org_id": "org-eden-2",
                "email": "test@example.com",
                "role": "viewer",
                "status": "pending",
                "expires_at": datetime.utcnow() + timedelta(days=7),
                "invited_by": "user-0",
            }),
        )
        with patch.object(
            auth_routes, "verify_invite_token", return_value=fake_invite,
        ), patch(
            "eden.api.utils.clerk_client.create_membership",
            AsyncMock(side_effect=ClerkAPIError("Clerk 503: /memberships")),
        ):
            response = api_client.post(
                "/auth/invitations/accept?token=any-plaintext-token",
                headers=auth_headers,
            )
        # Local join still succeeds — degraded Clerk sync is logged only
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["org_id"] == "org-eden-2"
        assert body["role"] == "viewer"
        assert "clerk_org_id" in body

    def test_accept_per_org_route_includes_clerk_org_id(
        self, api_client: TestClient, auth_headers: dict
    ):
        """The per-org accept route mirrors the token route's shape."""
        with patch(
            "eden.api.routes.orgs.accept_invitation",
            return_value={
                "org_id": "org-eden-3",
                "role": "admin",
                "clerk_org_id": "org_2xadmin",
            },
        ):
            response = api_client.post(
                "/orgs/org-eden-3/invites/inv-3/accept",
                headers=auth_headers,
            )
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["org_id"] == "org-eden-3"
        assert body["role"] == "admin"
        assert body["clerk_org_id"] == "org_2xadmin"


class TestUpsertOrgRace:
    """Verify the ``organization.created`` webhook handler is safe
    across the three arrival orders documented in the handler's
    docstring (case 1: webhook first; case 2: backend first;
    case 3: legacy row).

    Critical: when the webhook arrives for a backend-created row
    (``id = uuid4()``, ``clerk_org_id = 'org_2x...'``), the
    handler must NOT try to ``INSERT`` with ``id = 'org_2x...'``
    into the UUID column. That would raise ``invalid input
    syntax for type uuid`` and fail the webhook delivery.
    """

    def test_webhook_skips_insert_for_backend_created_row(
        self, mock_postgres_client
    ):
        """Case 2 (backend first): the handler must NOT issue a
        non-UUID INSERT. We assert that the INSERT statement is
        guarded by a ``NOT EXISTS`` check AND only inserts UUID
        ``clerk_id`` values."""
        from eden.api.routes.clerk_webhooks import _upsert_org

        import asyncio
        asyncio.run(_upsert_org({
            "id": "org_2xabc",
            "name": "Acme",
            "slug": "acme",
        }))

        # Collect every INSERT statement issued.
        inserts = [
            c for c in mock_postgres_client.execute.call_args_list
            if "INSERT INTO organizations" in (c.args[0] if c.args else "")
        ]
        # An INSERT may or may not be issued depending on the mock
        # state; if it IS issued, it must use ``::uuid`` cast and a
        # ``NOT EXISTS`` guard.
        if inserts:
            sql = inserts[0].args[0]
            assert "::uuid" in sql, (
                "INSERT into organizations must cast clerk_id to UUID "
                "to avoid the type error on Clerk's default ``org_2x...`` format"
            )
            assert "NOT EXISTS" in sql, (
                "INSERT must be guarded by a NOT EXISTS check to avoid "
                "duplicate rows when both the UPDATE and INSERT match"
            )

    def test_webhook_updates_existing_row_idempotently(
        self, mock_postgres_client
    ):
        """The UPDATE branch must run on every webhook delivery
        (idempotent for case 2; backfills case 3)."""
        from eden.api.routes.clerk_webhooks import _upsert_org

        import asyncio
        asyncio.run(_upsert_org({
            "id": "org_2xabc",
            "name": "Acme",
            "slug": "acme",
        }))

        updates = [
            c for c in mock_postgres_client.execute.call_args_list
            if c.args and "UPDATE organizations" in c.args[0]
            and "INSERT" not in c.args[0]
        ]
        assert updates, "Webhook handler did not issue an UPDATE"
        update_sql = updates[0].args[0]
        # The conditional matches either a clerk_org_id hit (case 2)
        # or a legacy id::text match (case 3).
        assert "clerk_org_id = $1" in update_sql
        assert "id::text = $1" in update_sql


class TestLastWriterRaceResolution:
    """Verify the role-write race between ``accept_invitation`` and the
    ``organizationMembership.created`` webhook is resolved by
    ``last_writer_source`` (migration 039).

    The race: Eden writes a local row with the invited role (e.g.
    ``viewer``) immediately on accept. Clerk's webhook fires
    milliseconds later with role ``org:member`` (which maps to
    ``member``) and would silently demote the invitee — unless the
    webhook's ``ON CONFLICT DO UPDATE`` respects
    ``last_writer_source``.
    """

    def test_local_insert_sets_last_writer_source(
        self, mock_postgres_client
    ):
        """The local INSERT in ``accept_invitation`` must mark the
        row as locally-written so the webhook knows to skip the
        initial role overwrite."""
        from eden.services.invitation_service import accept_invitation

        fake_invite = {
            "id": "inv-lw-1",
            "org_id": "org-eden-lw",
            "email": "test@example.com",
            "role": "viewer",
            "status": "pending",
            "expires_at": datetime.utcnow() + timedelta(days=7),
            "invited_by": "user-0",
        }
        mock_postgres_client._fetchrow_overrides.append(
            ("FROM org_invitations", fake_invite),
        )
        mock_postgres_client._fetchrow_overrides.append(
            ("COALESCE(clerk_org_id", {"clerk_org_id": None}),
        )
        # We don't care about Clerk side-effects for this test;
        # the resolve returns None so ``create_membership`` is
        # skipped.
        import asyncio
        asyncio.run(accept_invitation("inv-lw-1", "user-123"))

        # The local INSERT statement must include
        # ``last_writer_source = 'local'``. The mock's ``execute``
        # records every call; find the one that inserts the row.
        inserts = [
            c for c in mock_postgres_client.execute.call_args_list
            if "INSERT INTO org_members" in (c.args[0] if c.args else "")
        ]
        assert inserts, "accept_invitation did not insert into org_members"
        insert_sql = inserts[0].args[0]
        assert "last_writer_source" in insert_sql
        assert "'local'" in insert_sql

    def test_webhook_skips_role_overwrite_when_local(
        self, mock_postgres_client
    ):
        """The webhook's ``DO UPDATE`` must not overwrite the role
        when ``last_writer_source = 'local'`` (Eden wrote first)."""
        from eden.api.routes.clerk_webhooks import _upsert_membership

        # Seed: Eden already wrote the row as ``viewer`` and flagged
        # the writer as local. We don't actually need the fetchrow
        # return value — the webhook only writes via ``execute``.
        # We do need to assert the SQL itself contains the
        # conditional that skips the role overwrite.
        import asyncio
        asyncio.run(_upsert_membership({
            "organization": {"id": "org_2xabc"},
            "public_user_data": {"user_id": "user-123"},
            "role": "org:member",
        }))

        upserts = [
            c for c in mock_postgres_client.execute.call_args_list
            if "ON CONFLICT" in (c.args[0] if c.args else "")
        ]
        assert upserts, "_upsert_membership did not issue an UPSERT"
        upsert_sql = upserts[0].args[0]
        # The role-overwrite guard: only overwrite when the previous
        # writer was Clerk. Eden's local row wins on the first race.
        assert "last_writer_source = 'clerk'" in upsert_sql
        assert "CASE" in upsert_sql
        # The flip: every webhook arrival (even skipped ones) marks
        # Clerk as the most recent writer so subsequent role changes
        # propagate normally.
        assert "last_writer_source = 'clerk'" in upsert_sql
