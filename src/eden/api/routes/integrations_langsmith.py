"""LangSmith integration routes."""
from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from eden.integrations import INTEGRATION_API_VERSION
from eden.integrations.langsmith import (
    LangSmithClient,
    eden_env_to_langsmith_dataset,
    trace_to_langsmith_run,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/integrations/langsmith", tags=["integrations"])


class StatusResponse(BaseModel):
    enabled: bool
    integration_version: str
    endpoint: str


def _client() -> LangSmithClient:
    from eden.config import get_settings
    settings = get_settings()
    return LangSmithClient(
        api_key=getattr(settings, "langsmith_api_key", ""),
        endpoint=getattr(settings, "langsmith_endpoint", "https://api.smith.langchain.com"),
        enabled=bool(getattr(settings, "langsmith_api_key", "")),
    )


@router.get("/status", response_model=StatusResponse)
async def langsmith_status() -> StatusResponse:
    client = _client()
    return StatusResponse(
        enabled=client.enabled,
        integration_version=INTEGRATION_API_VERSION,
        endpoint=client.endpoint,
    )


class DatasetExportRequest(BaseModel):
    dataset_name: str
    envs: list[dict[str, Any]] = Field(default_factory=list)


@router.post("/dataset-export")
async def langsmith_dataset_export(req: DatasetExportRequest) -> dict[str, Any]:
    if not req.envs:
        raise HTTPException(status_code=400, detail="envs must be a non-empty list")
    return _client().export_dataset(req.envs, req.dataset_name)


class RunExportRequest(BaseModel):
    trace: dict[str, Any]


@router.post("/run-export")
async def langsmith_run_export(req: RunExportRequest) -> dict[str, Any]:
    if not req.trace:
        raise HTTPException(status_code=400, detail="trace must be a non-empty object")
    return {"integration_version": INTEGRATION_API_VERSION, "run": trace_to_langsmith_run(req.trace).to_langsmith()}
