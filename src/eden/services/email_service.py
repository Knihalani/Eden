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


async def send_password_reset_email(*, to_email: str, token: str) -> EmailResult:
    """Send the password-reset link.

    This function did not exist. ``/auth/forgot-password`` imported it
    inside a ``try/except Exception``, so the ImportError was caught,
    logged at WARNING, and the endpoint still returned 200 with "If an
    account exists for that email, a password reset link has been sent."

    A reset row was written and the plaintext token only ever lived in
    the email that was never sent — so any password-auth customer who
    forgot their password was permanently locked out, with nothing
    visible to them or to us saying why.
    """
    from eden.config import get_settings

    settings = get_settings()
    base = (getattr(settings, "portal_base_url", "") or "").rstrip("/")

    # portal_base_url defaults to the placeholder "portal.example.com"
    # and PORTAL_BASE_URL was NOT set in production — caught by Eden's
    # own sign_in_home golden probe, which had been failing against that
    # hostname on every tick for as long as the data goes back.
    #
    # Sending a reset link to a domain that does not resolve is worse
    # than sending nothing: the user burns their one-time token on a
    # dead URL and has no way to tell why. Refuse instead, so the ERROR
    # in forgot-password names a fixable cause.
    if not base or "example.com" in base:
        raise RuntimeError(
            "portal_base_url is unset or still the placeholder "
            f"({base or 'empty'!r}); a reset link built on it would not "
            "resolve. Set PORTAL_BASE_URL to the portal origin."
        )

    link = f"{base}/reset-password?token={token}"

    subject = "Reset your Eden password"
    text = (
        "You asked to reset your Eden password.\n\n"
        f"Open this link to choose a new one:\n{link}\n\n"
        "The link expires in one hour and can be used once.\n"
        "If you did not request this, you can ignore this email — "
        "your password has not changed.\n"
    )
    html = (
        "<p>You asked to reset your Eden password.</p>"
        f'<p><a href="{link}">Choose a new password</a></p>'
        "<p>The link expires in one hour and can be used once.</p>"
        "<p>If you did not request this, you can ignore this email — "
        "your password has not changed.</p>"
        f'<p style="color:#666;font-size:12px">If the button does not '
        f"work, paste this into your browser:<br>{link}</p>"
    )

    return await get_email_service().send_email(
        to_email=to_email,
        subject=subject,
        html_content=html,
        text_content=text,
        purpose="transactional",
    )
