"""OOM W2-7 (O5) — first-detection email and SENDKIT_API_KEY guardrails.

Covers:
- P3 (low-severity) issue_created sends when the org has never received one
- 24-hour Redis burst-dedupe prevents a second send in the same window
- Opt-out (first_detection_email_opt_out) blocks the send
- send_issue_alert_email skips send and emits an info log when
  sendkit_api_key is empty
"""

from __future__ import annotations

import logging
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


def _settings(*, sendkit_api_key: str = "sk_test_123") -> MagicMock:
    s = MagicMock()
    s.sendkit_api_key = sendkit_api_key
    return s


async def test_p3_first_detection_sends_when_never_sent() -> None:
    """P3 issue_created fires the first-detection email when the org is pristine."""
    from eden.services import alert_email

    svc = AsyncMock()
    with (
        patch.object(alert_email, "get_settings", return_value=_settings()),
        patch.object(
            alert_email,
            "_should_send_first_detection_email",
            new=AsyncMock(return_value=True),
        ),
        patch.object(
            alert_email,
            "_allow_first_detection_send",
            new=AsyncMock(return_value=True),
        ),
        patch.object(alert_email, "_mark_first_detection_sent", new=AsyncMock()),
        patch.object(
            alert_email,
            "_org_alert_recipients",
            new=AsyncMock(return_value=["admin@example.com"]),
        ),
        patch.object(alert_email, "get_email_service", return_value=svc),
    ):
        await alert_email.send_issue_alert_email(
            org_id="org-1",
            event_kind="issue_created",
            issue_id="issue-99",
            severity="P3",
            title="Slow query detected",
            detail="p99 > 2s",
            extra=None,
        )

    svc.send_email.assert_awaited_once()
    call_kw = svc.send_email.await_args.kwargs
    assert call_kw["to_email"] == "admin@example.com"
    # Subject must flag the first-detection nature.
    assert "first" in call_kw["subject"].lower()
    assert call_kw["purpose"] == "alert"


async def test_24h_burst_dedupe_blocks_second_send() -> None:
    """A second P3 within the 24-hour Redis window is silently dropped."""
    from eden.services import alert_email

    svc = AsyncMock()
    with (
        patch.object(alert_email, "get_settings", return_value=_settings()),
        patch.object(
            alert_email,
            "_should_send_first_detection_email",
            new=AsyncMock(return_value=True),
        ),
        patch.object(
            # Redis burst key already set → fail the 24h guard.
            alert_email,
            "_allow_first_detection_send",
            new=AsyncMock(return_value=False),
        ),
        patch.object(alert_email, "get_email_service", return_value=svc),
    ):
        await alert_email.send_issue_alert_email(
            org_id="org-2",
            event_kind="issue_created",
            issue_id="issue-100",
            severity="P3",
            title="Another issue",
            detail=None,
            extra=None,
        )

    svc.send_email.assert_not_awaited()


async def test_opt_out_blocks_first_detection_email() -> None:
    """first_detection_email_opt_out in org settings silences the send."""
    from eden.services import alert_email

    svc = AsyncMock()
    with (
        patch.object(alert_email, "get_settings", return_value=_settings()),
        patch.object(
            alert_email,
            "_should_send_first_detection_email",
            new=AsyncMock(return_value=False),  # opted out or already sent
        ),
        patch.object(alert_email, "get_email_service", return_value=svc),
    ):
        await alert_email.send_issue_alert_email(
            org_id="org-3",
            event_kind="issue_created",
            issue_id="issue-101",
            severity="P3",
            title="Issue",
            detail=None,
            extra=None,
        )

    svc.send_email.assert_not_awaited()


async def test_empty_sendkit_key_skips_send_and_logs(caplog: pytest.LogCaptureFixture) -> None:
    """All email paths are silenced with an INFO log when sendkit_api_key is unset."""
    from eden.services import alert_email

    svc = AsyncMock()
    with (
        patch.object(
            alert_email, "get_settings", return_value=_settings(sendkit_api_key="")
        ),
        patch.object(alert_email, "get_email_service", return_value=svc),
        caplog.at_level(logging.INFO, logger="eden.services.alert_email"),
    ):
        await alert_email.send_issue_alert_email(
            org_id="org-4",
            event_kind="issue_created",
            issue_id="issue-102",
            # P0 would normally always fire — the key guard must fire first.
            severity="P0",
            title="Critical issue",
            detail=None,
            extra=None,
        )

    svc.send_email.assert_not_awaited()
    assert any(
        "sendkit_api_key not configured" in r.message for r in caplog.records
    ), f"Expected key-absent log; got: {[r.message for r in caplog.records]}"
