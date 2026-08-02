"""NL alert_events acknowledge (mute/unmute) route."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
from fastapi import HTTPException

from eden.alerts import routes as alerts_routes


def _user() -> dict:
    return {"id": "user-1", "user_id": "user-1", "sub": "user-1"}


@pytest.mark.asyncio
async def test_acknowledge_alert_event_mutes() -> None:
    with (
        patch.object(
            alerts_routes,
            "_require_org_member",
            AsyncMock(return_value="org-1"),
        ),
        patch.object(
            alerts_routes,
            "eden_user_id_from_auth",
            AsyncMock(return_value="user-1"),
        ),
        patch.object(
            alerts_routes.repo,
            "set_alert_acknowledged",
            AsyncMock(
                return_value={
                    "id": "evt-1",
                    "acknowledged": True,
                }
            ),
        ) as set_ack,
    ):
        resp = await alerts_routes.acknowledge_alert_event(
            body=alerts_routes.AcknowledgeRequest(acknowledged=True),
            org_id="org-1",
            alert_id="evt-1",
            user=_user(),
            payload=None,
        )

    set_ack.assert_awaited_once_with(
        alert_event_id="evt-1",
        org_id="org-1",
        acknowledged=True,
    )
    assert resp["status"] == "ok"
    assert resp["acknowledged"] is True


@pytest.mark.asyncio
async def test_acknowledge_alert_event_404_when_missing_and_unmute() -> None:
    with (
        patch.object(
            alerts_routes,
            "_require_org_member",
            AsyncMock(return_value="org-1"),
        ),
        patch.object(
            alerts_routes,
            "eden_user_id_from_auth",
            AsyncMock(return_value="user-1"),
        ),
        patch.object(
            alerts_routes.repo,
            "set_alert_acknowledged",
            AsyncMock(return_value=None),
        ),
    ):
        with pytest.raises(HTTPException) as excinfo:
            await alerts_routes.acknowledge_alert_event(
                body=alerts_routes.AcknowledgeRequest(acknowledged=False),
                org_id="org-1",
                alert_id="missing",
                user=_user(),
                payload=None,
            )
    assert excinfo.value.status_code == 404
