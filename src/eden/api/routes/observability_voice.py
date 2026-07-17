"""D.12.4 Voice / audio API routes (§8.4).

Thin FastAPI wrapper over ``VoiceSessionService``. All persistence
and validation logic lives in
``eden.services.observability.voice_sessions``; this module only
handles request/response shaping + org membership enforcement.

Routes:
* ``GET  /v1/voice_sessions``
* ``POST /v1/voice_sessions/{org_id}``
* ``GET  /v1/traces/{trace_id}/voice_sessions``
* ``POST /v1/voice_sessions/{org_id}/barge_in``
* ``GET  /v1/voice_sessions/barge_in_spike``
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, Path, Query
from pydantic import BaseModel

from eden.api.deps import require_org_member
from eden.services.observability import get_voice_service

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/v1",
    tags=["voice"],
    dependencies=[Depends(require_org_member)],
)


def _ok(data: Any, **extra: Any) -> dict[str, Any]:
    return {"status": "ok", "data": data, **extra}


class VoiceSessionCreate(BaseModel):
    trace_id: str
    span_id: str
    session_id: str
    transport: str | None = None
    asr_provider: str | None = None
    asr_latency_ms: int | None = None
    asr_confidence: float | None = None
    asr_input_audio_ms: int | None = None
    llm_first_audio_ms: int | None = None
    tts_provider: str | None = None
    tts_first_byte_ms: int | None = None
    tts_total_ms: int | None = None
    barge_in_detected: bool = False


class BargeInRequest(BaseModel):
    session_id: str
    trace_id: str


# The order routes are declared in matters: a static path
# (``/voice_sessions/barge_in_spike``) must be registered before the
# dynamic ``/voice_sessions/{org_id}`` POST route family so FastAPI's
# path matching doesn't try to interpret "barge_in_spike" as an org_id
# on a route that doesn't exist for GET anyway — kept explicit for
# readability regardless.


@router.get("/voice_sessions/barge_in_spike")
async def get_barge_in_spike(
    org_id: str = Query(...),
    window_minutes: int = Query(15, ge=1, le=1440),
    threshold: int = Query(5, ge=1),
) -> dict[str, Any]:
    """Detect a recent spike in barge-in events for an org."""
    svc = get_voice_service()
    summary = await svc.detect_barge_in_spike(
        org_id, window_minutes=window_minutes, threshold=threshold, fire_hook=False,
    )
    if summary is None:
        return _ok({"spike": False, "count": 0})
    return _ok(summary)


@router.get("/voice_sessions")
async def list_voice_sessions(
    org_id: str = Query(...),
    provider: str | None = Query(None),
    had_barge_in: bool | None = Query(None),
    asr_p95_ms_gt: int | None = Query(None),
    limit: int = Query(100, ge=1, le=1000),
) -> dict[str, Any]:
    """List voice sessions for an org, with optional filters."""
    svc = get_voice_service()
    rows = await svc.list_sessions(
        org_id,
        provider=provider,
        had_barge_in=had_barge_in,
        asr_p95_ms_gt=asr_p95_ms_gt,
        limit=limit,
    )
    return _ok(rows, count=len(rows))


@router.post("/voice_sessions/{org_id}/barge_in")
async def post_barge_in(
    body: BargeInRequest,
    org_id: str = Path(...),
) -> dict[str, Any]:
    """Mark a voice session as having a barge-in event."""
    svc = get_voice_service()
    ok = await svc.mark_barge_in(body.session_id, body.trace_id)
    return _ok({"barge_in_detected": ok})


@router.post("/voice_sessions/{org_id}")
async def post_voice_session(
    body: VoiceSessionCreate,
    org_id: str = Path(...),
) -> dict[str, Any]:
    """Record (or upsert) a voice session."""
    svc = get_voice_service()
    session_id = await svc.record_session(
        org_id,
        trace_id=body.trace_id,
        span_id=body.span_id,
        session_id=body.session_id,
        transport=body.transport,
        asr_provider=body.asr_provider,
        asr_latency_ms=body.asr_latency_ms,
        asr_confidence=body.asr_confidence,
        asr_input_audio_ms=body.asr_input_audio_ms,
        llm_first_audio_ms=body.llm_first_audio_ms,
        tts_provider=body.tts_provider,
        tts_first_byte_ms=body.tts_first_byte_ms,
        tts_total_ms=body.tts_total_ms,
        barge_in_detected=body.barge_in_detected,
    )
    return _ok({"id": session_id})


@router.get("/traces/{trace_id}/voice_sessions")
async def get_trace_voice_sessions(trace_id: str = Path(...)) -> dict[str, Any]:
    """Return every voice session recorded for a trace."""
    svc = get_voice_service()
    rows = await svc.get_sessions_for_trace(trace_id)
    return _ok(rows, count=len(rows))


__all__ = ["router"]
