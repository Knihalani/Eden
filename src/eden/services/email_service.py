"""Email service for transactional + sparse alert emails via SendKit."""

from __future__ import annotations

import asyncio
import logging
import re
from dataclasses import dataclass
from typing import Literal

from eden.api.utils.redact import redact_email
from eden.config import get_settings

logger = logging.getLogger(__name__)

EmailStatus = Literal["sent", "not_configured", "failed"]
EmailPurpose = Literal["alert", "transactional"]


@dataclass(frozen=True)
class EmailResult:
    status: EmailStatus


class EmailService:
    """Send emails via the SendKit Python SDK.

    - ``purpose="alert"`` → from ``alerts@edenobservability.com``
    - ``purpose="transactional"`` → from ``info@edenobservability.com``

    If ``SENDKIT_API_KEY`` / ``sendkit_api_key`` is unset, emails are logged
    and return ``not_configured`` (safe degrade for local/dev).
    """

    def __init__(self) -> None:
        self.settings = get_settings()

    def _from_address(self, purpose: EmailPurpose) -> str:
        if purpose == "alert":
            return getattr(
                self.settings,
                "email_from_alerts",
                "alerts@edenobservability.com",
            )
        return getattr(
            self.settings,
            "email_from_info",
            "info@edenobservability.com",
        )

    async def send_email(
        self,
        to_email: str,
        subject: str,
        html_content: str,
        text_content: str | None = None,
        *,
        purpose: EmailPurpose = "transactional",
    ) -> EmailResult:
        """Send an email via SendKit.

        Args:
            to_email: Recipient email address
            subject: Email subject line
            html_content: HTML body
            text_content: Plain text body (optional)
            purpose: Selects from-address (alert vs transactional)
        """
        api_key = (getattr(self.settings, "sendkit_api_key", None) or "").strip()
        recipient_domain = to_email.rsplit("@", 1)[-1] if "@" in to_email else "unknown"

        if not api_key:
            logger.warning(
                "sendkit_api_key not configured. Email not sent.\n"
                f"  To: ***@{recipient_domain}\n"
                f"  Subject: {subject}\n"
                f"  Purpose: {purpose}\n"
                f"  Content: {redact_email(text_content or html_content[:100])}..."
            )
            return EmailResult(status="not_configured")

        from_addr = self._from_address(purpose)
        html = html_content
        # SendKit accepts html; include a minimal text fallback in the body
        # when callers only pass HTML.
        _ = text_content or self._html_to_text(html_content)

        try:
            result = await asyncio.to_thread(
                self._send_sync,
                api_key,
                from_addr,
                to_email,
                subject,
                html,
            )
            if result:
                logger.info(
                    "Email sent via SendKit to ***@%s (purpose=%s)",
                    recipient_domain,
                    purpose,
                )
                return EmailResult(status="sent")
            return EmailResult(status="failed")
        except Exception as exc:  # noqa: BLE001
            from eden.api.utils.redact import redact_all

            logger.error(
                "SendKit email failed to ***@%s: %s",
                recipient_domain,
                redact_all(str(exc)),
            )
            return EmailResult(status="failed")

    @staticmethod
    def _send_sync(
        api_key: str,
        from_addr: str,
        to_email: str,
        subject: str,
        html: str,
    ) -> bool:
        from sendkit import SendKit, SendKitError

        client = SendKit(api_key)
        try:
            client.emails.send(
                from_=from_addr,
                to=to_email,
                subject=subject,
                html=html,
            )
            return True
        except SendKitError as exc:
            logger.error(
                "SendKit API error status=%s name=%s msg=%s",
                getattr(exc, "status_code", None),
                getattr(exc, "name", None),
                getattr(exc, "message", str(exc)),
            )
            return False

    def _html_to_text(self, html: str) -> str:
        text = (
            html.replace("<br>", "\n")
            .replace("<br/>", "\n")
            .replace("<p>", "\n")
            .replace("</p>", "")
        )
        text = re.sub(r"<[^>]+>", "", text)
        text = (
            text.replace("&nbsp;", " ")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&amp;", "&")
        )
        return text.strip()


def get_email_service() -> EmailService:
    """Get an email service instance."""
    return EmailService()
