"""Phase P — Agent Debugger API routes.

Three routes:

  * ``GET  /orgs/{org}/debugger/checkpoints/{trace_id}`` — list checkpoints
  * ``POST /orgs/{org}/debugger/rerun`` — re-run from a step
  * ``POST /orgs/{org}/debugger/discover`` — discover rollout entrypoints
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, Path
from pydantic import BaseModel, Field

from eden.debugger.checkpoints import (
    Checkpoint,
    CheckpointStore,
    ReRunEngine,
    discover_entrypoint,
)
from eden.storage.postgres import get_postgres_client

logger = logging.getLogger(__name__)


router = APIRouter(
    prefix="/orgs/{org_id}/debugger",
    tags=["debugger"],
)


# ─- Schemas ──────────────────────────────────────────────────────


class CheckpointResponse(BaseModel):
    id: str
    trace_id: str
    step_number: int
    input_messages: list[dict[str, Any]]
    tool_calls: list[dict[str, Any]]
    tool_results: list[dict[str, Any]]
    response: dict[str, Any]
    prompt_override: str | None = None
    started_at: str
    ended_at: str
    duration_ms: float
    source: str


class CheckpointListResponse(BaseModel):
    checkpoints: list[CheckpointResponse]


class RerunRequest(BaseModel):
    trace_id: str = Field(..., description="The trace to replay.")
    from_step: int = Field(
        default=0, ge=0,
        description="The step to start from (inclusive).",
    )
    prompt_override: str | None = Field(
        default=None,
        description="Optional system-prompt override for the first replayed step.",
    )


class RerunResponse(BaseModel):
    source_trace_id: str
    from_step: int
    to_step: int
    prompt_override: str | None = None
    checkpoints: list[CheckpointResponse]
    diff: list[dict[str, Any]]


class DiscoverRequest(BaseModel):
    candidates: list[dict[str, Any]] = Field(
        default_factory=list,
        description="List of candidate entrypoints discovered by the user-repo scan.",
    )
    min_confidence: float = Field(default=0.5, ge=0.0, le=1.0)


class DiscoverResponse(BaseModel):
    entrypoints: list[dict[str, Any]]


# ─- Helpers ───────────────────────────────────────────────────────


def _get_user():
    from eden.api.routes.auth import get_current_user
    return get_current_user


def _checkpoint_to_response(c: Checkpoint) -> CheckpointResponse:
    return CheckpointResponse(
        id=c.id, trace_id=c.trace_id, step_number=c.step_number,
        input_messages=c.input_messages, tool_calls=c.tool_calls,
        tool_results=c.tool_results, response=c.response,
        prompt_override=c.prompt_override,
        started_at=c.started_at, ended_at=c.ended_at,
        duration_ms=c.duration_ms, source=c.source,
    )


# ─- Routes ────────────────────────────────────────────────────────


@router.get(
    "/checkpoints/{trace_id}",
    response_model=CheckpointListResponse,
    summary="List all checkpoints for a trace, in step order",
)
async def list_checkpoints(
    org_id: str = Path(...),
    trace_id: str = Path(...),
    user: dict = Depends(_get_user()),
) -> CheckpointListResponse:
    pg = await get_postgres_client()
    store = CheckpointStore(pg)
    cps = await store.list_for_trace(trace_id)
    return CheckpointListResponse(
        checkpoints=[_checkpoint_to_response(c) for c in cps],
    )


@router.post(
    "/rerun",
    response_model=RerunResponse,
    summary="Re-run a trace from a given step with an optional prompt override",
)
async def rerun(
    body: RerunRequest,
    org_id: str = Path(...),
    user: dict = Depends(_get_user()),
) -> RerunResponse:
    pg = await get_postgres_client()
    store = CheckpointStore(pg)
    engine = ReRunEngine(store)
    result = await engine.rerun(
        body.trace_id,
        from_step=body.from_step,
        prompt_override=body.prompt_override,
    )
    return RerunResponse(
        source_trace_id=result.source_trace_id,
        from_step=result.from_step,
        to_step=result.to_step,
        prompt_override=result.prompt_override,
        checkpoints=[_checkpoint_to_response(c) for c in result.checkpoints],
        diff=result.diff,
    )


@router.post(
    "/discover",
    response_model=DiscoverResponse,
    summary="Discover rollout entrypoints from a list of candidates",
)
async def discover(
    body: DiscoverRequest,
    org_id: str = Path(...),
    user: dict = Depends(_get_user()),
) -> DiscoverResponse:
    entrypoints = discover_entrypoint(
        body.candidates, min_confidence=body.min_confidence,
    )
    return DiscoverResponse(
        entrypoints=[e.to_dict() for e in entrypoints],
    )
