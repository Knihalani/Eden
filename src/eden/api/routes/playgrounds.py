"""F49 playground API — persisted CRUD, run matrix, from-span, promote."""

from __future__ import annotations

import json
import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from pydantic import BaseModel, Field
from starlette.responses import StreamingResponse

from eden.api.deps import (
    get_current_user,
    require_path_org_access,
)
from eden.api.utils.redact import redact_all
from eden.api.utils.safe_error import raise_mapped_db_error
from eden.playground.service import PlaygroundService

try:
    from sse_starlette.sse import EventSourceResponse as _SSEResponse
except ImportError:  # pragma: no cover
    _SSEResponse = None  # type: ignore[misc, assignment]

logger = logging.getLogger(__name__)

def _value_error_status(exc: ValueError) -> int:
    msg = str(exc).lower()
    if "not found" in msg:
        return 404
    return 400

router = APIRouter(
    prefix="/orgs/{org_id}/playgrounds",
    tags=["playgrounds"],
    dependencies=[Depends(require_path_org_access)],
)

class CreatePlaygroundRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    config: dict[str, Any] = Field(default_factory=dict)

class PatchPlaygroundRequest(BaseModel):
    name: str | None = None
    config: dict[str, Any] | None = None

class RunPlaygroundRequest(BaseModel):
    params: dict[str, Any] = Field(default_factory=dict)
    dataset_rows: list[dict[str, Any]] | None = None

class FromSpanRequest(BaseModel):
    trace_id: str = Field(..., min_length=1)
    span_id: str | None = None
    messages: list[dict[str, Any]] = Field(default_factory=list)
    model: str | None = None
    tools: list[dict[str, Any]] = Field(default_factory=list)

class PromoteExperimentRequest(BaseModel):
    name: str | None = None
    dataset_id: str | None = None

@router.get("")
async def list_playgrounds(
    org_id: str = Depends(require_path_org_access),
    user: dict = Depends(get_current_user),
    limit: int = Query(50, ge=1, le=100),
) -> dict[str, Any]:
    svc = PlaygroundService()
    try:
        items = await svc.list(org_id, limit=limit)
    except Exception as exc:
        logger.warning("list_playgrounds failed: %s", redact_all(str(exc)))
        raise_mapped_db_error(
            exc,
            fallback="playgrounds unavailable",
            uuid_detail="Invalid organization id",
        )
    return {"playgrounds": [p.to_dict() for p in items], "total": len(items)}

@router.post("")
async def create_playground(
    body: CreatePlaygroundRequest,
    org_id: str = Depends(require_path_org_access),
    user: dict = Depends(get_current_user),
) -> dict[str, Any]:
    svc = PlaygroundService()
    created_by = str(user.get("user_id") or user.get("id") or "")
    try:
        rec = await svc.create(
            org_id, name=body.name, config=body.config or None, created_by=created_by or None
        )
    except Exception as exc:
        logger.warning("create_playground failed: %s", redact_all(str(exc)))
        raise_mapped_db_error(
            exc,
            fallback="playground create failed",
            unique_detail="playground already exists",
            uuid_detail="Invalid organization id",
            fk_detail="Organization not found",
        )
    return {"playground": rec.to_dict()}

@router.post("/from-span")
async def playground_from_span(
    body: FromSpanRequest,
    org_id: str = Depends(require_path_org_access),
    user: dict = Depends(get_current_user),
) -> dict[str, Any]:
    svc = PlaygroundService()
    created_by = str(user.get("user_id") or user.get("id") or "")
    try:
        rec = await svc.from_span(
            org_id,
            trace_id=body.trace_id,
            span_id=body.span_id,
            messages=body.messages,
            model=body.model,
            tools=body.tools,
            created_by=created_by or None,
        )
    except Exception as exc:
        logger.warning("playground_from_span failed: %s", redact_all(str(exc)))
        raise_mapped_db_error(
            exc,
            fallback="playground from-span failed",
            uuid_detail="Invalid organization id",
            fk_detail="Organization not found",
        )
    return {"playground": rec.to_dict()}

@router.get("/{playground_id}")
async def get_playground(
    org_id: str = Depends(require_path_org_access),
    playground_id: str = Path(...),
    user: dict = Depends(get_current_user),
) -> dict[str, Any]:
    svc = PlaygroundService()
    try:
        rec = await svc.get(org_id, playground_id)
    except Exception as exc:
        logger.warning("get_playground failed: %s", redact_all(str(exc)))
        raise_mapped_db_error(
            exc,
            fallback="playground unavailable",
            uuid_detail="Invalid playground id",
        )
    if rec is None:
        raise HTTPException(status_code=404, detail="playground not found")
    return {"playground": rec.to_dict()}

@router.patch("/{playground_id}")
async def patch_playground(
    body: PatchPlaygroundRequest,
    org_id: str = Depends(require_path_org_access),
    playground_id: str = Path(...),
    user: dict = Depends(get_current_user),
) -> dict[str, Any]:
    svc = PlaygroundService()
    try:
        rec = await svc.update(
            org_id, playground_id, name=body.name, config=body.config
        )
    except Exception as exc:
        logger.warning("patch_playground failed: %s", redact_all(str(exc)))
        raise_mapped_db_error(
            exc,
            fallback="playground update failed",
            uuid_detail="Invalid playground id",
            fk_detail="Playground not found",
        )
    if rec is None:
        raise HTTPException(status_code=404, detail="playground not found")
    return {"playground": rec.to_dict()}

@router.post("/{playground_id}/run")
async def run_playground(
    body: RunPlaygroundRequest,
    org_id: str = Depends(require_path_org_access),
    playground_id: str = Path(...),
    user: dict = Depends(get_current_user),
) -> dict[str, Any]:
    svc = PlaygroundService()
    try:
        result = await svc.run(
            org_id,
            playground_id,
            params=body.params,
            dataset_rows=body.dataset_rows,
        )
    except ValueError as exc:
        raise HTTPException(status_code=_value_error_status(exc), detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:
        logger.warning("run_playground failed: %s", redact_all(str(exc)))
        raise_mapped_db_error(
            exc,
            fallback="playground run failed",
            uuid_detail="Invalid playground id",
        )
    return {"status": "ok", "run": result}

@router.post("/{playground_id}/run/stream")
async def run_playground_stream(
    body: RunPlaygroundRequest,
    org_id: str = Depends(require_path_org_access),
    playground_id: str = Path(...),
    user: dict = Depends(get_current_user),
) -> Any:
    """SSE wrapper — emits start → result → done (practical stream surface)."""
    svc = PlaygroundService()

    async def _sse_events():
        yield {"event": "start", "data": '{"status":"running"}'}
        try:
            result = await svc.run(
                org_id,
                playground_id,
                params=body.params,
                dataset_rows=body.dataset_rows,
            )
            yield {"event": "result", "data": json.dumps(result)}
            yield {"event": "done", "data": '{"status":"completed"}'}
        except ValueError as exc:
            yield {"event": "error", "data": json.dumps({"detail": str(exc)})}

    async def _plain():
        yield "event: start\ndata: {\"status\":\"running\"}\n\n"
        try:
            result = await svc.run(
                org_id,
                playground_id,
                params=body.params,
                dataset_rows=body.dataset_rows,
            )
            yield f"event: result\ndata: {json.dumps(result)}\n\n"
            yield "event: done\ndata: {\"status\":\"completed\"}\n\n"
        except ValueError as exc:
            yield f"event: error\ndata: {json.dumps({'detail': str(exc)})}\n\n"

    if _SSEResponse is not None:
        return _SSEResponse(_sse_events())
    return StreamingResponse(_plain(), media_type="text/event-stream")

@router.post("/{playground_id}/promote-experiment")
async def promote_playground_experiment(
    body: PromoteExperimentRequest,
    org_id: str = Depends(require_path_org_access),
    playground_id: str = Path(...),
    user: dict = Depends(get_current_user),
) -> dict[str, Any]:
    svc = PlaygroundService()
    try:
        result = await svc.promote_experiment(
            org_id,
            playground_id,
            name=body.name,
            dataset_id=body.dataset_id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=_value_error_status(exc), detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:
        logger.warning("promote_playground_experiment failed: %s", redact_all(str(exc)))
        raise_mapped_db_error(
            exc,
            fallback="playground promote failed",
            uuid_detail="Invalid playground or dataset id",
            fk_detail="Playground or dataset not found",
        )
    return {"status": "ok", **result}
