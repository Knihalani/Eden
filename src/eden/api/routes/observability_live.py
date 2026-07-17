"""N11 — live session stream routes (publish / SSE / finalize)."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Body, Depends, Path, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from eden.api.deps import get_ingest_auth, require_feature_flag, require_org_member
from eden.observability.live.publisher import LiveTracePublisher
from eden.observability.live.subscriber import LiveTraceSubscriber

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/orgs/{org_id}/stream/traces",
    tags=["live-trace-streaming"],
    dependencies=[Depends(require_feature_flag("live_trace_streaming_v1"))],
)

_publisher = LiveTracePublisher()
_subscriber = LiveTraceSubscriber()


class LiveEventBody(BaseModel):
    type: str = Field(..., description="span_start|span_update|span_end|stumble_detected|...")
    span_id: str | None = None
    name: str | None = None
    parent_id: str | None = None
    trace_id: str | None = None
    attributes: dict[str, Any] | None = None
    attributes_partial: dict[str, Any] | None = None
    status: str | None = None
    kind: str | None = None
    ts: float | None = None


class FinalizeBody(BaseModel):
    trace_id: str | None = None
    step_count: int | None = None


@router.post("/{session_id}/publish")
async def publish_live_event(
    org_id: str = Path(...),
    session_id: str = Path(...),
    body: LiveEventBody = Body(...),
    auth: dict = Depends(get_ingest_auth),
) -> dict[str, Any]:
    """SDK ingest for in-flight live events (X-Org-Api-Key)."""
    resolved_org = str(auth.get("org_id") or org_id)
    if resolved_org != org_id:
        return {
            "status": "error",
            "code": "org_mismatch",
            "message": "Path org_id does not match auth org",
        }
    result = await _publisher.publish(org_id, session_id, body.model_dump(exclude_none=True))
    return {"feature": "live_trace_streaming", "live": True, **result}


@router.get("/{session_id}/events")
async def stream_live_events(
    org_id: str = Path(...),
    session_id: str = Path(...),
    from_event_id: int = Query(0, ge=0),
    member: dict = Depends(require_org_member),
) -> StreamingResponse:
    """SSE live tail for a session (portal / MCP)."""
    resolved = str(member.get("org_id") or org_id)

    async def gen():
        async for chunk in _subscriber.stream(
            resolved, session_id, from_event_id=from_event_id
        ):
            yield chunk

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/{session_id}/finalize")
async def finalize_live_session(
    org_id: str = Path(...),
    session_id: str = Path(...),
    body: FinalizeBody | None = Body(None),
    auth: dict = Depends(get_ingest_auth),
) -> dict[str, Any]:
    """Upgrade live buffer → single persisted finalize signal."""
    resolved_org = str(auth.get("org_id") or org_id)
    if resolved_org != org_id:
        return {
            "status": "error",
            "code": "org_mismatch",
            "message": "Path org_id does not match auth org",
        }
    payload = body or FinalizeBody()
    result = await _publisher.finalize(
        org_id,
        session_id,
        trace_id=payload.trace_id,
        step_count=payload.step_count,
    )
    return {"feature": "live_trace_streaming", "live": True, **result}
