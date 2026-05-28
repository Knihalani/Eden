"""Email service for sending transactional emails via SendGrid."""

import logging
from typing import Optional

import httpx

from eden.config import get_settings

logger = logging.getLogger(__name__)

# SendGrid API endpoint
SENDGRID_API_URL = "https://api.sendgrid.com/v3/mail/send"


class EmailService:
    """Email service that sends emails via SendGrid API.

    Uses httpx to make HTTP requests to the SendGrid API.
    If SendGrid is not configured (no API key), emails are logged instead.
    """

    def __init__(self):
        self.settings = get_settings()

    async def send_email(
        self,
        to_email: str,
        subject: str,
        html_content: str,
        text_content: Optional[str] = None,
    ) -> bool:
        """Send an email via SendGrid.

        Args:
            to_email: Recipient email address
            subject: Email subject line
            html_content: HTML body of the email
            text_content: Plain text body (optional, for email clients that prefer text)

        Returns:
            True if email was sent successfully, False otherwise
        """
        api_key = self.settings.sendgrid_api_key

        # If no API key configured, log and return (stub mode)
        if not api_key:
            logger.warning(
                "sendgrid_api_key not configured. Email not sent.\n"
                f"  To: {to_email}\n"
                f"  Subject: {subject}\n"
                f"  Content: {text_content or html_content[:100]}..."
            )
            return False

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
                    logger.info(f"Email sent successfully to {to_email}")
                    return True
                else:
                    logger.error(
                        f"Failed to send email to {to_email}. "
                        f"Status: {response.status_code}, Body: {response.text}"
                    )
                    return False

        except httpx.TimeoutException:
            logger.error(f"Timeout sending email to {to_email}")
            return False
        except httpx.RequestError as e:
            logger.error(f"Request error sending email to {to_email}: {e}")
            return False

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
