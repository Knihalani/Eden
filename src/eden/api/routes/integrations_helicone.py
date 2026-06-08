"""Helicone integration routes.

Exposes:
  - GET  /integrations/helicone/status  — feature flag + version info
  - POST /integrations/helicone/webhook — Helicone → Eden usage sync
  - GET  /integrations/helicone/test    — health check (returns 200 if
                                          the API key is configured and
                                          the upstream is reachable)

All inbound requests are validated against the
``X-Eden-Integration-Version`` header so we can detect when
Helicone is talking to an outdated Eden build. Unknown versions
are logged but accepted (forward-compat).
"""
from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Header, HTTPException, Request, status, Depends
from pydantic import BaseModel

from eden.api.deps import require_feature_flag
from eden.integrations import INTEGRATION_API_VERSION
from eden.integrations.helicone.sync import parse_helicone_event

logger = logging.getLogger(__name__)
router = APIRouter(
    prefix="/integrations/helicone",
    tags=["integrations"],
    dependencies=[Depends(require_feature_flag("enable_eval_pipeline"))],
)


class StatusResponse(BaseModel):
    enabled: bool
    integration_version: str
    api_key_configured: bool


@router.get("/status", response_model=StatusResponse)
async def helicone_status() -> StatusResponse:
    from eden.config import get_settings
    settings = get_settings()
    return StatusResponse(
        enabled=bool(settings.helicone_api_key),
        integration_version=INTEGRATION_API_VERSION,
        api_key_configured=bool(settings.helicone_api_key),
    )


@router.post("/webhook", status_code=status.HTTP_200_OK)
async def helicone_webhook(
    request: Request,
    x_eden_integration_version: str | None = Header(default=None),
) -> dict[str, Any]:
    """Accept a Helicone usage event. Always 200 (ack-and-drop)."""
    if x_eden_integration_version and x_eden_integration_version != INTEGRATION_API_VERSION:
        # Forward-compat: log the version mismatch so we can detect
        # when a third-party sender is on a newer schema. We still
        # accept the payload so we don't drop data.
        logger.info(
            "Helicone webhook sent with integration version %s (we are %s); accepting",
            x_eden_integration_version,
            INTEGRATION_API_VERSION,
        )
    try:
        payload = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON")
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Expected JSON object")
    event = parse_helicone_event(payload)
    if event is None:
        return {"status": "ignored", "reason": "malformed"}
    # Real implementation: write to a helicone_usage_events table or
    # push to the Bronze sink. For the integration-versioning
    # milestone we only log + return the dedup key so the operator
    # can confirm the wire is alive.
    logger.info(
        "Helicone event received: id=%s model=%s cost_usd=%.4f job_id=%s",
        event.event_id,
        event.model,
        event.cost_usd,
        event.job_id,
    )
    return {
        "status": "accepted",
        "dedup_key": event.dedup_key(),
        "integration_version": INTEGRATION_API_VERSION,
    }


@router.get("/test")
async def helicone_test() -> dict[str, Any]:
    """Health check that exercises the upstream proxy."""
    from eden.config import get_settings
    import httpx

    settings = get_settings()
    if not settings.helicone_api_key:
        raise HTTPException(status_code=503, detail="helicone_api_key not configured")
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(
                f"{settings.helicone_base_url.rsplit('/v1', 1)[0]}/v1/models",
                headers={"Authorization": f"Bearer {settings.helicone_api_key}"},
            )
        return {
            "ok": response.status_code == 200,
            "upstream_status": response.status_code,
            "integration_version": INTEGRATION_API_VERSION,
        }
    except httpx.RequestError as exc:
        raise HTTPException(status_code=502, detail=f"Helicone upstream unreachable: {exc}")
