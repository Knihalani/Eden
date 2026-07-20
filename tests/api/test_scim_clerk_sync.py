"""SCIM ↔ Clerk sync (Phase 1) — focused unit/integration tests.

Mocks ``clerk_client`` helpers and a fake Postgres client so we never
hit the network or a real DB.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.api.routes.scim import (
    _sync_clerk_for_scim_user,
    apply_scim_patch_operations,
    get_service_provider_config,
)
from eden.api.utils import clerk_client


@pytest.fixture
def fake_pg():
    client = MagicMock()
    client.fetchrow = AsyncMock(return_value={"clerk_id": None, "clerk_org_id": "org_clerk_1"})
    client.execute = AsyncMock()
    return client


class TestSyncClerkForScimUser:
    @pytest.mark.asyncio
    async def test_provision_creates_user_and_membership(self, fake_pg):
        fake_pg.fetchrow = AsyncMock(
            side_effect=[
                {"clerk_id": None},  # users.clerk_id lookup
            ]
        )

        with (
            patch(
                "eden.api.utils.clerk_client.resolve_clerk_org_id",
                new_callable=AsyncMock,
                return_value="org_clerk_1",
            ),
            patch(
                "eden.api.utils.clerk_client.create_user_with_email",
                new_callable=AsyncMock,
                return_value={"id": "user_clerk_1"},
            ) as create_user,
            patch(
                "eden.api.utils.clerk_client.create_membership",
                new_callable=AsyncMock,
                return_value={"id": "mem_1"},
            ) as create_mem,
            patch(
                "eden.api.utils.clerk_client.delete_membership",
                new_callable=AsyncMock,
            ) as delete_mem,
        ):
            await _sync_clerk_for_scim_user(
                fake_pg,
                org_id="eden-org-1",
                user_id="eden-user-1",
                email="alice@example.com",
                given_name="Alice",
                family_name="Example",
                active=True,
            )

        create_user.assert_awaited_once_with(
            "alice@example.com",
            first_name="Alice",
            last_name="Example",
        )
        create_mem.assert_awaited_once_with(
            clerk_org_id="org_clerk_1",
            user_id="user_clerk_1",
            role="member",
        )
        delete_mem.assert_not_awaited()
        fake_pg.execute.assert_awaited()

    @pytest.mark.asyncio
    async def test_deprovision_deletes_membership_without_creating(self, fake_pg):
        fake_pg.fetchrow = AsyncMock(return_value={"clerk_id": "user_clerk_1"})

        with (
            patch(
                "eden.api.utils.clerk_client.resolve_clerk_org_id",
                new_callable=AsyncMock,
                return_value="org_clerk_1",
            ),
            patch(
                "eden.api.utils.clerk_client.create_user_with_email",
                new_callable=AsyncMock,
            ) as create_user,
            patch(
                "eden.api.utils.clerk_client.delete_membership",
                new_callable=AsyncMock,
                return_value={"id": "mem_1"},
            ) as delete_mem,
            patch(
                "eden.api.utils.clerk_client.create_membership",
                new_callable=AsyncMock,
            ) as create_mem,
        ):
            await _sync_clerk_for_scim_user(
                fake_pg,
                org_id="eden-org-1",
                user_id="eden-user-1",
                email="alice@example.com",
                active=False,
            )

        create_user.assert_not_awaited()
        create_mem.assert_not_awaited()
        delete_mem.assert_awaited_once_with("org_clerk_1", "user_clerk_1")

    @pytest.mark.asyncio
    async def test_skips_when_no_clerk_org(self, fake_pg):
        with (
            patch(
                "eden.api.utils.clerk_client.resolve_clerk_org_id",
                new_callable=AsyncMock,
                return_value=None,
            ),
            patch(
                "eden.api.utils.clerk_client.create_user_with_email",
                new_callable=AsyncMock,
            ) as create_user,
        ):
            await _sync_clerk_for_scim_user(
                fake_pg,
                org_id="eden-org-1",
                user_id="eden-user-1",
                email="alice@example.com",
                active=True,
            )
        create_user.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_clerk_failure_is_non_fatal(self, fake_pg):
        fake_pg.fetchrow = AsyncMock(return_value={"clerk_id": None})

        with (
            patch(
                "eden.api.utils.clerk_client.resolve_clerk_org_id",
                new_callable=AsyncMock,
                return_value="org_clerk_1",
            ),
            patch(
                "eden.api.utils.clerk_client.create_user_with_email",
                new_callable=AsyncMock,
                side_effect=clerk_client.ClerkAPIError("Clerk 500"),
            ),
        ):
            await _sync_clerk_for_scim_user(
                fake_pg,
                org_id="eden-org-1",
                user_id="eden-user-1",
                email="alice@example.com",
                active=True,
            )


class TestClerkClientHelpers:
    @pytest.mark.asyncio
    async def test_create_user_posts_email_address(self):
        with patch(
            "eden.api.utils.clerk_client._post",
            new_callable=AsyncMock,
            return_value={"id": "user_1"},
        ) as post:
            result = await clerk_client.create_user(
                email="bob@example.com",
                first_name="Bob",
                last_name="Builder",
            )
        assert result["id"] == "user_1"
        post.assert_awaited_once()
        args, _kwargs = post.await_args
        assert args[0] == "/users"
        body = args[1]
        assert body["email_address"] == ["bob@example.com"]
        assert body["skip_password_requirement"] is True
        assert body["first_name"] == "Bob"

    @pytest.mark.asyncio
    async def test_create_user_with_email_reuses_existing(self):
        with (
            patch(
                "eden.api.utils.clerk_client.find_user_by_email",
                new_callable=AsyncMock,
                return_value={"id": "user_existing"},
            ),
            patch(
                "eden.api.utils.clerk_client.create_user",
                new_callable=AsyncMock,
            ) as create,
        ):
            result = await clerk_client.create_user_with_email("bob@example.com")
        assert result["id"] == "user_existing"
        create.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_delete_membership_calls_delete(self):
        with patch(
            "eden.api.utils.clerk_client._delete",
            new_callable=AsyncMock,
            return_value={"id": "mem"},
        ) as delete:
            await clerk_client.delete_membership("org_1", "user_1")
        delete.assert_awaited_once_with(
            "/organizations/org_1/memberships/user_1"
        )

    @pytest.mark.asyncio
    async def test_update_membership_patches_role(self):
        with patch(
            "eden.api.utils.clerk_client._patch",
            new_callable=AsyncMock,
            return_value={"id": "mem"},
        ) as patch_fn:
            await clerk_client.update_membership("org_1", "user_1", "admin")
        patch_fn.assert_awaited_once_with(
            "/organizations/org_1/memberships/user_1",
            {"role": "org:admin"},
        )


class TestServiceProviderConfigPatch:
    @pytest.mark.asyncio
    async def test_patch_supported_true(self):
        with patch(
            "eden.api.routes.scim.get_current_org_scim",
            new_callable=AsyncMock,
            return_value={"org_id": "o1"},
        ):
            cfg = await get_service_provider_config("o1")
        assert cfg["patch"]["supported"] is True


class TestPatchThenParse:
    def test_azure_soft_delete_roundtrip_fields(self):
        current = {
            "userName": "alice@example.com",
            "name": {"givenName": "Alice", "familyName": "E"},
            "displayName": "Alice E",
            "emails": [{"value": "alice@example.com", "primary": True}],
            "active": True,
        }
        apply_scim_patch_operations(
            current,
            [{"op": "Replace", "path": "active", "value": "False"}],
        )
        from eden.api.routes.scim import _parse_scim_user

        parsed = _parse_scim_user(current)
        assert parsed["active"] is False
        assert parsed["email"] == "alice@example.com"
