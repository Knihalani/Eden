"""F71 — Slack interactive endpoints."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException, Request

from eden.config import get_settings
from eden.integrations.slack.interactive import (
    handle_block_actions,
    handle_slash_command,
    parse_interaction_body,
    verify_slack_signature,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/integrations/slack", tags=["slack-interactive"])


@router.post("/commands")
async def slack_slash_commands(request: Request) -> dict[str, Any]:
    body = await request.body()
    settings = get_settings()
    secret = str(getattr(settings, "slack_signing_secret", "") or "")
    sig = request.headers.get("X-Slack-Signature", "")
    ts = request.headers.get("X-Slack-Request-Timestamp", "")
    if secret and not verify_slack_signature(
        signing_secret=secret, timestamp=ts, body=body, signature=sig
    ):
        raise HTTPException(status_code=401, detail="invalid slack signature")

    form = await request.form()
    payload = {k: form.get(k) for k in form.keys()}
    return await handle_slash_command(payload)


@router.post("/interactions")
async def slack_interactions(request: Request) -> dict[str, Any]:
    body = await request.body()
    settings = get_settings()
    secret = str(getattr(settings, "slack_signing_secret", "") or "")
    sig = request.headers.get("X-Slack-Signature", "")
    ts = request.headers.get("X-Slack-Request-Timestamp", "")
    if secret and not verify_slack_signature(
        signing_secret=secret, timestamp=ts, body=body, signature=sig
    ):
        raise HTTPException(status_code=401, detail="invalid slack signature")

    content_type = request.headers.get("content-type", "")
    payload = parse_interaction_body(body, content_type)
    result = await handle_block_actions(payload)
    return result or {}
