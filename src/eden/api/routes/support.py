"""Support + Discord webhook routes.

  - POST /support/tickets — submit a ticket (closes §11.6).
  - POST /integrations/discord/test — verify a Discord webhook
    URL is reachable.
"""
from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from eden.api.deps import get_current_user
from eden.integrations.discord import post_to_discord
from eden.integrations.support_webhook import (
    SupportTicketError,
    forward_to_support_webhook,
    validate_ticket,
)

logger = logging.getLogger(__name__)
router = APIRouter(tags=["support"])


class TicketRequest(BaseModel):
    subject: str = Field(min_length=4, max_length=200)
    body: str = Field(min_length=4, max_length=10_000)
    user_email: str
    severity: str = "normal"
    tags: list[str] = Field(default_factory=list)


@router.post("/support/tickets")
async def submit_ticket(
    req: TicketRequest,
    user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    try:
        payload = validate_ticket(req.model_dump())
    except SupportTicketError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    # Enrich with org + user context.
    payload["org_id"] = user.get("active_org_id") or user.get("org_id")
    payload["user_id"] = user.get("user_id")
    from eden.config import get_settings
    settings = get_settings()
    webhook = getattr(settings, "support_webhook_url", "") or getattr(settings, "eden_support_webhook_url", "")
    ok = await forward_to_support_webhook(payload, webhook_url=webhook)
    return {
        "status": "submitted" if ok else "queued",
        "note": "" if ok else "Support webhook not configured; ticket logged but not forwarded.",
    }


class DiscordTestRequest(BaseModel):
    webhook_url: str = Field(min_length=20)
    message: str = "Eden Discord webhook test"


@router.post("/integrations/discord/test")
async def discord_test(req: DiscordTestRequest) -> dict[str, Any]:
    ok = await post_to_discord(req.webhook_url, title="Test", body=req.message, severity="info")
    if not ok:
        raise HTTPException(status_code=502, detail="Discord webhook did not accept the message")
    return {"status": "ok"}
