"""Discord webhook integration (closes §7.5).

Posts fired alerts to a customer-configured Discord channel
via a webhook URL. The webhook is configured per-org (the
``org_integrations`` table, not yet shipped — pending §5 follow-up).

Until the per-org config lands, the webhook URL can be set
globally via the ``EDEN_DISCORD_WEBHOOK_URL`` env var; this is
the configuration the Helm chart uses.
"""
from __future__ import annotations

import logging
from typing import Any

import httpx

from eden.integrations import INTEGRATION_API_VERSION

logger = logging.getLogger(__name__)


async def post_to_discord(webhook_url: str, *, title: str, body: str, severity: str = "info") -> bool:
    """Post an embed to Discord via a webhook URL.

    Returns True on success (Discord returns 204 for OK), False
    on any error. Errors are logged at warning level so a
    misconfigured webhook doesn't take down the alerts engine.
    """
    if not webhook_url:
        logger.debug("Discord webhook URL not configured; skipping")
        return False
    color_map = {"info": 0x3498DB, "warning": 0xF1C40F, "critical": 0xE74C3C}
    payload = {
        "embeds": [
            {
                "title": title,
                "description": body[:2000],  # Discord limit
                "color": color_map.get(severity, color_map["info"]),
                "footer": {"text": f"Eden · integration v{INTEGRATION_API_VERSION}"},
            }
        ]
    }
    try:
        async with httpx.AsyncClient(timeout=10.0, follow_redirects=False) as client:
            response = await client.post(webhook_url, json=payload)
        if response.status_code in (200, 204):
            return True
        logger.warning("Discord webhook returned %s: %s", response.status_code, response.text[:200])
        return False
    except httpx.RequestError as exc:
        logger.warning("Discord webhook request failed: %s", exc)
        return False


async def fan_out_alert(alert: dict[str, Any], *, webhook_url: str) -> bool:
    """Format a fired alert and post it to Discord.

    The alert shape mirrors :class:`eden.observability.alerts.Alert`.
    """
    severity = alert.get("severity", "info")
    title = f"[{severity.upper()}] {alert.get('name', 'Eden alert')}"
    body = alert.get("description", "")
    if "fired_at" in alert:
        body += f"\n\nFired at: `{alert['fired_at']}`"
    return await post_to_discord(webhook_url, title=title, body=body, severity=severity)


__all__ = ["fan_out_alert", "post_to_discord"]
