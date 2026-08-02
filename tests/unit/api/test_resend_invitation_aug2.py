"""Aug 2: dedicated resend path for pending invites.

The portal's "Resend invite" button used to re-POST ``/invites``,
which ``create_invitation`` rejects with "already pending" — so the
button failed for exactly the invites it exists for. Locks:

- ``resend_invitation`` rotates the token + extends expiry on a
  pending invite and returns the record for re-sending.
- Non-pending (accepted/declined/expired) invites cannot be resent.
- Unknown invitation ids raise.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from eden.services.invitation_service import (
    hash_invite_token,
    resend_invitation,
)


def _make_client(invitation: dict | None) -> AsyncMock:
    client = AsyncMock()
    # fetchrow order: invitation → inviter → org
    client.fetchrow = AsyncMock(
        side_effect=[
            invitation,
            {"name": "Inviter"} if invitation else None,
            {"name": "Acme"} if invitation else None,
        ]
    )
    client.execute = AsyncMock()
    return client


@pytest.mark.asyncio
async def test_resend_rotates_token_and_extends_expiry():
    invitation = {
        "id": "inv-1",
        "org_id": "org-1",
        "email": "user@example.com",
        "role": "member",
        "status": "pending",
        "invited_by": "user-1",
    }
    client = _make_client(invitation)
    with patch(
        "eden.services.invitation_service.get_postgres_client",
        new=AsyncMock(return_value=client),
    ):
        plain_token, record = await resend_invitation("inv-1")

    assert plain_token
    assert record["id"] == "inv-1"
    assert record["email"] == "user@example.com"
    assert record["status"] == "pending"
    assert record["inviter_name"] == "Inviter"
    assert record["org_name"] == "Acme"

    # Token rotation persisted: the UPDATE stores the NEW token's hash.
    update_call = client.execute.await_args_list[0]
    assert "UPDATE org_invitations" in update_call.args[0]
    assert update_call.args[1] == hash_invite_token(plain_token)
    assert update_call.args[3] == "inv-1"


@pytest.mark.asyncio
@pytest.mark.parametrize("bad_status", ["accepted", "declined", "expired"])
async def test_resend_rejects_non_pending(bad_status: str):
    invitation = {
        "id": "inv-1",
        "org_id": "org-1",
        "email": "user@example.com",
        "role": "member",
        "status": bad_status,
        "invited_by": "user-1",
    }
    client = _make_client(invitation)
    with (
        patch(
            "eden.services.invitation_service.get_postgres_client",
            new=AsyncMock(return_value=client),
        ),
        pytest.raises(ValueError, match="cannot resend"),
    ):
        await resend_invitation("inv-1")
    client.execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_resend_unknown_invitation_raises():
    client = _make_client(None)
    with (
        patch(
            "eden.services.invitation_service.get_postgres_client",
            new=AsyncMock(return_value=client),
        ),
        pytest.raises(ValueError, match="Invitation not found"),
    ):
        await resend_invitation("inv-missing")
    client.execute.assert_not_awaited()
