"""Email service for sending transactional emails via SendGrid."""

import logging
from dataclasses import dataclass
from typing import Literal

import httpx

from eden.api.utils.redact import redact_email
from eden.config import get_settings

logger = logging.getLogger(__name__)

# SendGrid API endpoint
SENDGRID_API_URL = "https://api.sendgrid.com/v3/mail/send"

EmailStatus = Literal["sent", "not_configured", "failed"]


@dataclass(frozen=True)
class EmailResult:
    status: EmailStatus


class EmailService:
    """Email service that sends emails via SendGrid API.

    Uses httpx to make HTTP requests to the SendGrid API.
    If SendGrid is not configured (no API key), emails are logged instead.
    """

    def __init__(self) -> None:
        self.settings = get_settings()

    async def send_email(
        self,
        to_email: str,
        subject: str,
        html_content: str,
        text_content: str | None = None,
    ) -> EmailResult:
        """Send an email via SendGrid.

        Args:
            to_email: Recipient email address
            subject: Email subject line
            html_content: HTML body of the email
            text_content: Plain text body (optional, for email clients that prefer text)

        Returns:
            EmailResult with sent, not_configured, or failed status
        """
        api_key = self.settings.sendgrid_api_key

        # If no API key configured, log and return (stub mode)
        if not api_key:
            # F65 — PII redaction. The pre-F65 log line
            # embedded the full recipient address + email body
            # in plaintext, which is a PII-in-logs violation
            # under GDPR Art. 5 and CCPA §1798.150. The
            # subject + recipient domain are still useful for
            # diagnostics so we keep them; the local-part and
            # the body are redacted.
            recipient_domain = to_email.rsplit("@", 1)[-1] if "@" in to_email else "unknown"
            logger.warning(
                "sendgrid_api_key not configured. Email not sent.\n"
                f"  To: ***@{recipient_domain}\n"
                f"  Subject: {subject}\n"
                f"  Content: {redact_email(text_content or html_content[:100])}..."
            )
            return EmailResult(status="not_configured")

        # Prepare SendGrid API payload
        payload = {
            "personalizations": [
                {
                    "to": [{"email": to_email}],
                }
            ],
            "from": {
                "email": self.settings.sendgrid_from_email,
                "name": self.settings.sendgrid_from_name,
            },
            "subject": subject,
            "content": [
                {
                    "type": "text/plain",
                    "value": text_content or self._html_to_text(html_content),
                },
                {
                    "type": "text/html",
                    "value": html_content,
                },
            ],
        }

        try:
            async with httpx.AsyncClient() as client:
                response = await client.post(
                    SENDGRID_API_URL,
                    json=payload,
                    headers={
                        "Authorization": f"Bearer {api_key}",
                        "Content-Type": "application/json",
                    },
                    timeout=30.0,
                )

                if response.status_code == 202:
                    # F65 — recipient email is PII. Keep the
                    # domain so the operator can still
                    # attribute the log line, but redact the
                    # local-part.
                    recipient_domain = to_email.rsplit("@", 1)[-1] if "@" in to_email else "unknown"
                    logger.info(f"Email sent successfully to ***@{recipient_domain}")
                    return EmailResult(status="sent")
                else:
                    # F65 — recipient email is PII. The
                    # SendGrid error body is logged as-is —
                    # SendGrid does not echo the recipient
                    # in error bodies so it's safe to leave.
                    recipient_domain = to_email.rsplit("@", 1)[-1] if "@" in to_email else "unknown"
                    logger.error(
                        f"Failed to send email to ***@{recipient_domain}. "
                        f"Status: {response.status_code}, Body: {response.text}"
                    )
                    return EmailResult(status="failed")

        except httpx.TimeoutException:
            # F65 — recipient email is PII.
            recipient_domain = to_email.rsplit("@", 1)[-1] if "@" in to_email else "unknown"
            logger.error(f"Timeout sending email to ***@{recipient_domain}")
            return EmailResult(status="failed")
        except httpx.RequestError as e:
            # F65 — recipient email is PII. The httpx
            # RequestError exception is also run through
            # ``redact_all`` to scrub any embedded
            # credentials in the URL/headers.
            from eden.api.utils.redact import redact_all
            recipient_domain = to_email.rsplit("@", 1)[-1] if "@" in to_email else "unknown"
            logger.error(
                f"Request error sending email to ***@{recipient_domain}: {redact_all(str(e))}"
            )
            return EmailResult(status="failed")

    def _html_to_text(self, html: str) -> str:
        """Convert basic HTML to plain text (simple conversion)."""
        # Simple conversion - strip tags and decode common entities
        text = html.replace("<br>", "\n").replace("<br/>", "\n").replace("<p>", "\n").replace("</p>", "")
        import re
        text = re.sub(r"<[^>]+>", "", text)
        text = text.replace("&nbsp;", " ").replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&")
        return text.strip()


def get_email_service() -> EmailService:
    """Get an email service instance."""
    return EmailService()
