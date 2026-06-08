"""Langfuse integration routes.

Exposes:
  - GET  /integrations/langfuse/status  — feature flag + version info
  - POST /integrations/langfuse/dataset-export — accepts a list of
         Eden envs and returns the Langfuse dataset payload that
         would be pushed. Customer runs this in a one-off script
         when they want to mirror their envs into Langfuse.
  - POST /integrations/langfuse/trace-export — accepts a single
         Eden trace and returns the Langfuse event payload.
"""
from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from eden.integrations import INTEGRATION_API_VERSION
from eden.integrations.langfuse import (
    LangfuseClient,
    eden_env_to_langfuse_dataset,
    trace_to_langfuse_event,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/integrations/langfuse", tags=["integrations"])


class StatusResponse(BaseModel):
    enabled: bool
    integration_version: str
    host: str


def _client() -> LangfuseClient:
    from eden.config import get_settings
    settings = get_settings()
    return LangfuseClient(
        public_key=getattr(settings, "langfuse_public_key", ""),
        secret_key=getattr(settings, "langfuse_secret_key", ""),
        host=getattr(settings, "langfuse_host", "https://cloud.langfuse.com"),
        enabled=bool(getattr(settings, "langfuse_public_key", "") and getattr(settings, "langfuse_secret_key", "")),
    )


@router.get("/status", response_model=StatusResponse)
async def langfuse_status() -> StatusResponse:
    client = _client()
    return StatusResponse(
        enabled=client.enabled,
        integration_version=INTEGRATION_API_VERSION,
        host=client.host,
    )


class DatasetExportRequest(BaseModel):
    dataset_name: str
    envs: list[dict[str, Any]] = Field(default_factory=list)


@router.post("/dataset-export")
async def langfuse_dataset_export(req: DatasetExportRequest) -> dict[str, Any]:
    if not req.envs:
        raise HTTPException(status_code=400, detail="envs must be a non-empty list")
    client = _client()
    items = [eden_env_to_langfuse_dataset(env).to_langfuse() for env in req.envs]
    return {
        "integration_version": INTEGRATION_API_VERSION,
        "dataset_name": req.dataset_name,
        "items": items,
        "count": len(items),
    }


class TraceExportRequest(BaseModel):
    trace: dict[str, Any]


@router.post("/trace-export")
async def langfuse_trace_export(req: TraceExportRequest) -> dict[str, Any]:
    if not req.trace:
        raise HTTPException(status_code=400, detail="trace must be a non-empty object")
    return {
        "integration_version": INTEGRATION_API_VERSION,
        "event": trace_to_langfuse_event(req.trace).to_langfuse(),
    }
