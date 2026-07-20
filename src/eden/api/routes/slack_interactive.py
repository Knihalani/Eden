"""F71 — Slack interactive endpoints."""

from __future__ import annotations

import logging
from typing import Any
from urllib.parse import parse_qs

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


def _require_verified_slack(body: bytes, request: Request) -> None:
    settings = get_settings()
    secret = str(getattr(settings, "slack_signing_secret", "") or "")
    if not secret:
        raise HTTPException(status_code=503, detail="Slack signing secret not configured")
    sig = request.headers.get("X-Slack-Signature", "")
    ts = request.headers.get("X-Slack-Request-Timestamp", "")
    if not verify_slack_signature(
        signing_secret=secret, timestamp=ts, body=body, signature=sig
    ):
        raise HTTPException(status_code=401, detail="invalid slack signature")


@router.post("/commands")
async def slack_slash_commands(request: Request) -> dict[str, Any]:
    body = await request.body()
    _require_verified_slack(body, request)

    # Body already consumed for signature verify — parse form from bytes.
    form = {k: (v[0] if v else "") for k, v in parse_qs(body.decode("utf-8")).items()}
    return await handle_slash_command(form)


@router.post("/interactions")
async def slack_interactions(request: Request) -> dict[str, Any]:
    body = await request.body()
    _require_verified_slack(body, request)

    content_type = request.headers.get("content-type", "")
    payload = parse_interaction_body(body, content_type)
    result = await handle_block_actions(payload)
    return result or {}
