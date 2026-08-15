"""Runloop integration routes — status + sanity check.

The full Runloop-backed :class:`SandboxRunner` is registered via
``EdenConfig.runloop_runner = "runloop"`` (see
:mod:`eden.sandbox.runner`). This route surface is just the
status/test plumbing used by CI to verify the wiring.
"""
from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from eden.integrations import INTEGRATION_API_VERSION
from eden.integrations.runloop import RunloopClient, RunloopDevboxSpec

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/integrations/runloop", tags=["integrations"])


class StatusResponse(BaseModel):
    enabled: bool
    integration_version: str
    sdk_module: str


def _client() -> RunloopClient:
    from eden.config import get_settings
    settings = get_settings()
    return RunloopClient(
        api_key=getattr(settings, "runloop_api_key", ""),
        enabled=bool(getattr(settings, "runloop_api_key", "")),
        sdk_module=getattr(settings, "runloop_sdk_module", "runloop"),
    )


@router.get("/status", response_model=StatusResponse)
async def runloop_status() -> StatusResponse:
    client = _client()
    return StatusResponse(
        enabled=client.enabled,
        integration_version=INTEGRATION_API_VERSION,
        sdk_module=client.sdk_module_name,
    )


class TestCreateRequest(BaseModel):
    blueprint_id: str
    name: str = "eden-smoke-test"
    env_vars: dict[str, str] = {}


@router.post("/test-create")
async def runloop_test_create(req: TestCreateRequest) -> dict[str, Any]:
    client = _client()
    if not client.enabled:
        raise HTTPException(status_code=503, detail="runloop_api_key not configured")
    spec = RunloopDevboxSpec(
        blueprint_id=req.blueprint_id,
        name=req.name,
        env_vars=req.env_vars,
        metadata={"test": "smoke"},
    )
    devbox = await client.create_devbox(spec)
    return {
        "integration_version": INTEGRATION_API_VERSION,
        "id": devbox.id,
        "state": devbox.state,
    }
