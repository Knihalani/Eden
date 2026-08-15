"""W1-D: invites must not create owners; only ownership transfer can.

Locks:
- InviteMemberRequest rejects role=owner (Pydantic → 422 at the API)
- UpdateMemberRoleRequest still rejects role=owner (no promote-to-owner)
- create_invitation rejects owner even if called internally
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from eden.api.routes.orgs import InviteMemberRequest, UpdateMemberRoleRequest
from eden.services.invitation_service import create_invitation


@pytest.mark.parametrize("role", ["admin", "member", "viewer"])
def test_invite_member_request_allows_non_owner_roles(role: str):
    req = InviteMemberRequest(email="user@example.com", role=role)
    assert req.role == role


def test_invite_member_request_rejects_owner():
    with pytest.raises(ValidationError) as exc_info:
        InviteMemberRequest(email="user@example.com", role="owner")
    assert any(
        "role" in (err.get("loc") or ()) for err in exc_info.value.errors()
    )


@pytest.mark.parametrize("role", ["admin", "member", "viewer"])
def test_update_member_role_request_allows_non_owner_roles(role: str):
    req = UpdateMemberRoleRequest(role=role)
    assert req.role == role


def test_update_member_role_request_rejects_owner():
    with pytest.raises(ValidationError) as exc_info:
        UpdateMemberRoleRequest(role="owner")
    assert any(
        "role" in (err.get("loc") or ()) for err in exc_info.value.errors()
    )


@pytest.mark.asyncio
async def test_create_invitation_rejects_owner_internally():
    with pytest.raises(ValueError, match="Cannot invite with owner role"):
        await create_invitation(
            org_id="org-1",
            email="user@example.com",
            role="owner",
            invited_by="user-1",
        )
