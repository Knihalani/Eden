"""Regression tests for send_self_obs_degraded_email (F84 paging wiring).

Mirrors the pattern of the existing NL-incident / budget alert emails
in this module: Redis dedupe via ``_allow_send`` + org admin recipient
lookup, reused here for self-observability degraded/fail transitions.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest


@pytest.mark.asyncio
async def test_send_self_obs_degraded_email_sends_to_org_admins():
    from eden.services import alert_email

    svc = AsyncMock()
    with patch.object(
        alert_email, "_allow_send", new=AsyncMock(return_value=True)
    ), patch.object(
        alert_email,
        "_org_alert_recipients",
        new=AsyncMock(return_value=["owner@example.com"]),
    ), patch.object(
        alert_email, "get_email_service", return_value=svc
    ):
        await alert_email.send_self_obs_degraded_email(
            org_id="org-1",
            component="background_workers",
            status="degraded",
            detail={"background_workers_running": False},
        )

    svc.send_email.assert_awaited_once()
    call = svc.send_email.await_args.kwargs
    assert call["to_email"] == "owner@example.com"
    assert "background_workers" in call["subject"]
    assert call["purpose"] == "alert"


@pytest.mark.asyncio
async def test_send_self_obs_degraded_email_deduped():
    """A second call within the dedupe window must not send again —
    this is the secondary safety net behind the scheduler's own
    transition-only check.
    """
    from eden.services import alert_email

    svc = AsyncMock()
    with patch.object(
        alert_email, "_allow_send", new=AsyncMock(return_value=False)
    ), patch.object(
        alert_email,
        "_org_alert_recipients",
        new=AsyncMock(return_value=["owner@example.com"]),
    ), patch.object(
        alert_email, "get_email_service", return_value=svc
    ):
        await alert_email.send_self_obs_degraded_email(
            org_id="org-1",
            component="background_workers",
            status="degraded",
        )

    svc.send_email.assert_not_awaited()


@pytest.mark.asyncio
async def test_send_self_obs_degraded_email_no_recipients_skips_send():
    from eden.services import alert_email

    svc = AsyncMock()
    with patch.object(
        alert_email, "_allow_send", new=AsyncMock(return_value=True)
    ), patch.object(
        alert_email, "_org_alert_recipients", new=AsyncMock(return_value=[])
    ), patch.object(
        alert_email, "get_email_service", return_value=svc
    ):
        await alert_email.send_self_obs_degraded_email(
            org_id="org-1", component="golden_probes", status="fail"
        )

    svc.send_email.assert_not_awaited()
