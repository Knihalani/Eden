"""Support webhook (closes §11.6).

The portal's "Submit ticket" button POSTs a small JSON payload
to a customer-configured webhook URL. This module is the
backend: it validates the payload, optionally enriches it with
org context, and forwards to the webhook (Pylon, Intercom,
Zendesk, or a custom endpoint).

The webhook URL is configured per-deployment via the
``EDEN_SUPPORT_WEBHOOK_URL`` env var (see helm/eden/values.yaml).
"""
from __future__ import annotations

import logging
from typing import Any

import httpx

from eden.integrations import INTEGRATION_API_VERSION
from eden.util.shared_http import shared_httpx_ctx

logger = logging.getLogger(__name__)


class SupportTicketError(ValueError):
    """Raised when the ticket payload is invalid."""


def validate_ticket(payload: dict[str, Any]) -> dict[str, Any]:
    """Validate the ticket payload from the portal.

    Required fields: ``subject`` (str, 4-200 chars), ``body`` (str,
    4-10000 chars), ``user_email`` (valid email). Optional:
    ``severity`` (one of ``low``, ``normal``, ``high``, ``urgent``),
    ``tags`` (list of strings).
    """
    subject = (payload.get("subject") or "").strip()
    body = (payload.get("body") or "").strip()
    user_email = (payload.get("user_email") or "").strip()
    if not (4 <= len(subject) <= 200):
        raise SupportTicketError("subject must be 4-200 characters")
    if not (4 <= len(body) <= 10_000):
        raise SupportTicketError("body must be 4-10000 characters")
    if "@" not in user_email or " " in user_email:
        raise SupportTicketError("user_email must be a valid email address")
    severity = payload.get("severity", "normal")
    if severity not in {"low", "normal", "high", "urgent"}:
        raise SupportTicketError("severity must be one of low/normal/high/urgent")
    tags = payload.get("tags") or []
    if not isinstance(tags, list) or not all(isinstance(t, str) for t in tags):
        raise SupportTicketError("tags must be a list of strings")
    return {
        "subject": subject,
        "body": body,
        "user_email": user_email,
        "severity": severity,
        "tags": [t.strip() for t in tags if t.strip()][:10],
    }


async def forward_to_support_webhook(payload: dict[str, Any], *, webhook_url: str) -> bool:
    """Forward a validated ticket to the customer's support webhook.

    Returns True if the upstream returned 2xx, False otherwise.
    Errors are logged at warning level so a misconfigured
    webhook doesn't take down the portal submit flow.
    """
    if not webhook_url:
        logger.debug("Support webhook URL not configured; skipping forward")
        return False
    headers = {
        "Content-Type": "application/json",
        "X-Eden-Integration-Version": INTEGRATION_API_VERSION,
        "X-Eden-Source": "support-webhook",
    }
    try:
        async with shared_httpx_ctx(timeout=10.0) as client:
            response = await client.post(webhook_url, json=payload, headers=headers)
        if 200 <= response.status_code < 300:
            return True
        logger.warning("Support webhook returned %s: %s", response.status_code, response.text[:200])
        return False
    except httpx.RequestError as exc:
        logger.warning("Support webhook request failed: %s", exc)
        return False


__all__ = [
    "SupportTicketError",
    "forward_to_support_webhook",
    "validate_ticket",
]
