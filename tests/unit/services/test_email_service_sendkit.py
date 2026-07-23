"""Unit tests for EmailService (SendKit-backed).

Covers the two from-address branches (alert vs transactional) and the
safe not_configured degrade when no API key is set. The SendKit client
itself is mocked — these tests never make a real network call.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from eden.services.email_service import EmailService


def _service_with(**settings_overrides) -> EmailService:
    """Build an EmailService with a stubbed ``settings`` object.

    Bypasses ``get_settings()`` (lru_cached, env-driven) so each test
    is isolated from the real process config.
    """
    svc = EmailService.__new__(EmailService)
    defaults = {
        "sendkit_api_key": "",
        "email_from_alerts": "alerts@edenobservability.com",
        "email_from_info": "info@edenobservability.com",
    }
    defaults.update(settings_overrides)
    svc.settings = SimpleNamespace(**defaults)
    return svc


class TestFromAddressSelection:
    def test_alert_purpose_uses_alerts_from_address(self) -> None:
        svc = _service_with(sendkit_api_key="sk_test_123")
        assert svc._from_address("alert") == "alerts@edenobservability.com"

    def test_transactional_purpose_uses_info_from_address(self) -> None:
        svc = _service_with(sendkit_api_key="sk_test_123")
        assert svc._from_address("transactional") == "info@edenobservability.com"


class TestSendEmailNotConfigured:
    @pytest.mark.asyncio
    async def test_missing_api_key_returns_not_configured(self) -> None:
        svc = _service_with(sendkit_api_key="")

        with patch("sendkit.SendKit") as mock_sendkit_cls:
            result = await svc.send_email(
                to_email="user@example.com",
                subject="Hello",
                html_content="<p>Hi</p>",
                purpose="transactional",
            )

        assert result.status == "not_configured"
        mock_sendkit_cls.assert_not_called()

    @pytest.mark.asyncio
    async def test_whitespace_only_api_key_returns_not_configured(self) -> None:
        svc = _service_with(sendkit_api_key="   ")

        result = await svc.send_email(
            to_email="user@example.com",
            subject="Hello",
            html_content="<p>Hi</p>",
        )

        assert result.status == "not_configured"


class TestSendEmailUsesCorrectFromAddress:
    @pytest.mark.asyncio
    async def test_alert_purpose_sends_from_alerts_address(self) -> None:
        svc = _service_with(sendkit_api_key="sk_test_123")

        mock_client = MagicMock()
        mock_client.emails.send = MagicMock(return_value=None)

        with patch("sendkit.SendKit", return_value=mock_client) as mock_sendkit_cls:
            result = await svc.send_email(
                to_email="owner@org.example.com",
                subject="Budget alert",
                html_content="<p>You are at 95% of your budget.</p>",
                purpose="alert",
            )

        assert result.status == "sent"
        mock_sendkit_cls.assert_called_once_with("sk_test_123")
        mock_client.emails.send.assert_called_once()
        _, kwargs = mock_client.emails.send.call_args
        assert kwargs["from_"] == "alerts@edenobservability.com"
        assert kwargs["to"] == "owner@org.example.com"

    @pytest.mark.asyncio
    async def test_transactional_purpose_sends_from_info_address(self) -> None:
        svc = _service_with(sendkit_api_key="sk_test_123")

        mock_client = MagicMock()
        mock_client.emails.send = MagicMock(return_value=None)

        with patch("sendkit.SendKit", return_value=mock_client):
            result = await svc.send_email(
                to_email="newuser@org.example.com",
                subject="You're invited to Eden",
                html_content="<p>Join your team on Eden.</p>",
                purpose="transactional",
            )

        assert result.status == "sent"
        mock_client.emails.send.assert_called_once()
        _, kwargs = mock_client.emails.send.call_args
        assert kwargs["from_"] == "info@edenobservability.com"

    @pytest.mark.asyncio
    async def test_transactional_is_the_default_purpose(self) -> None:
        svc = _service_with(sendkit_api_key="sk_test_123")

        mock_client = MagicMock()
        mock_client.emails.send = MagicMock(return_value=None)

        with patch("sendkit.SendKit", return_value=mock_client):
            result = await svc.send_email(
                to_email="newuser@org.example.com",
                subject="Welcome",
                html_content="<p>Welcome to Eden.</p>",
            )

        assert result.status == "sent"
        _, kwargs = mock_client.emails.send.call_args
        assert kwargs["from_"] == "info@edenobservability.com"


class TestSendEmailFailureHandling:
    @pytest.mark.asyncio
    async def test_sendkit_error_returns_failed(self) -> None:
        from sendkit import SendKitError

        svc = _service_with(sendkit_api_key="sk_test_123")

        mock_client = MagicMock()
        mock_client.emails.send = MagicMock(
            side_effect=SendKitError("boom", status_code=500, name="server_error")
        )

        with patch("sendkit.SendKit", return_value=mock_client):
            result = await svc.send_email(
                to_email="owner@org.example.com",
                subject="Budget alert",
                html_content="<p>Alert body</p>",
                purpose="alert",
            )

        assert result.status == "failed"
