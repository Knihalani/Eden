"""W&B Weave integration routes.

Exposes:
  - GET  /integrations/wandb/status   — feature flag + version info
  - POST /integrations/wandb/webhook  — W&B → Eden (no current
                                         surface; reserved for future
                                         back-sync of W&B alerts)
  - POST /integrations/wandb/test-log — accepts a synthetic Bronze
                                         event and returns the
                                         Weave-ready payload so
                                         operators can confirm the
                                         mapping without running a
                                         real LLM call.
"""
from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from eden.integrations import INTEGRATION_API_VERSION
from eden.integrations.wandb import WeaveClient, fan_out_bronze_event

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/integrations/wandb", tags=["integrations"])


class StatusResponse(BaseModel):
    enabled: bool
    integration_version: str
    project: str


def _client() -> WeaveClient:
    from eden.config import get_settings
    settings = get_settings()
    return WeaveClient(
        project=getattr(settings, "wandb_project", "eden"),
        enabled=bool(getattr(settings, "wandb_api_key", "")),
    )


@router.get("/status", response_model=StatusResponse)
async def wandb_status() -> StatusResponse:
    client = _client()
    return StatusResponse(
        enabled=client.enabled,
        integration_version=INTEGRATION_API_VERSION,
        project=client.project,
    )


class TestLogRequest(BaseModel):
    event: dict[str, Any]


@router.post("/test-log")
async def wandb_test_log(req: TestLogRequest) -> dict[str, Any]:
    """Return the Weave payload that would be published for ``event``."""
    payload = fan_out_bronze_event(req.event, _client())
    if payload is None:
        raise HTTPException(
            status_code=400,
            detail="Event is not an LLM call or integration is disabled",
        )
    return {"integration_version": INTEGRATION_API_VERSION, "weave_payload": payload}
