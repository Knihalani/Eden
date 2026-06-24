"""Voice / audio routes — D.12.4 (§8.4, §C.8).

Routes (per spec §C.8):

* ``GET  /v1/voice_sessions`` — list voice sessions with
  filtering (provider, had_barge_in, asr_p95_ms_gt).
* ``POST /v1/voice_sessions/{org_id}`` — record a voice
  session (SDK path; org-member gated).
* ``GET  /v1/traces/{trace_id}/voice_sessions`` — return
  the voice sessions for a trace (no auth gate beyond
  the global feature flag + current user, same as
  ``/mcp`` + ``/a2a`` + ``/computer_use``).
* ``POST /v1/voice_sessions/{org_id}/barge_in`` — mark
  a (session_id, trace_id) turn as having had a barge-in
  (org-member gated). Idempotent.
* ``GET  /v1/voice_sessions/barge_in_spike`` — return
  the spike summary for an org in the last window
  (org-admin gated; fires the ``on_voice_barge_in_spike``
  hook on the way out).
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Body, Depends, Path, Query
from pydantic import BaseModel, Field

from eden.api.deps import (
    get_current_user,
    require_feature_flag,
    require_org_admin,
    require_org_member,
)
from eden.services.observability import (
    DEFAULT_SPIKE_THRESHOLD,
    DEFAULT_SPIKE_WINDOW_MINUTES,
    get_voice_service,
)

logger = logging.getLogger(__name__)

router = APIRouter(
    tags=["observability-voice"],
    dependencies=[
        Depends(require_feature_flag("intelligence_gap_v0")),
        Depends(get_current_user),
    ],
)


class RecordSessionRequest(BaseModel):
    trace_id: str
    span_id: str
    session_id: str
    transport: str | None = None
    asr_provider: str | None = None
    asr_latency_ms: int | None = None
    asr_confidence: float | None = Field(default=None, ge=0.0, le=1.0)
    asr_input_audio_ms: int | None = None
    llm_first_audio_ms: int | None = None
    tts_provider: str | None = None
    tts_first_byte_ms: int | None = None
    tts_total_ms: int | None = None
    barge_in_detected: bool = False


class MarkBargeInRequest(BaseModel):
    session_id: str
    trace_id: str


# ── /v1/voice_sessions (list with filters) ───────────────────────────


@router.get("/v1/voice_sessions")
async def list_voice_sessions(
    org_id: str = Query(...),
    provider: str | None = Query(None),
    had_barge_in: bool | None = Query(None),
    asr_p95_ms_gt: int | None = Query(None, ge=0),
    limit: int = Query(100, ge=1, le=500),
    _member: dict = Depends(require_org_member),
) -> dict[str, Any]:
    """List voice sessions for an org with optional filters
    (per spec §C.8).
    """
    svc = get_voice_service()
    rows = await svc.list_sessions(
        org_id,
        provider=provider,
        had_barge_in=had_barge_in,
        asr_p95_ms_gt=asr_p95_ms_gt,
        limit=limit,
    )
    return {
        "status": "ok",
        "feature": "voice_sessions",
        "live": True,
        "data": rows,
        "count": len(rows),
    }


# ── /v1/voice_sessions/{org_id} (record) ────────────────────────────


@router.post("/v1/voice_sessions/{org_id}")
async def record_voice_session(
    org_id: str = Path(...),
    body: RecordSessionRequest = Body(...),
    _member: dict = Depends(require_org_member),
) -> dict[str, Any]:
    """Record a voice session turn. Idempotent on
    (trace_id, span_id). Setting ``barge_in_detected=True``
    persists the flag (the spike detector runs on a separate
    endpoint so the SDK can decide whether to count
    immediately or batch).
    """
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
    return {
        "status": "ok" if session_id else "error",
        "feature": "voice_sessions",
        "live": bool(session_id),
        "data": {"id": session_id},
    }


# ── /v1/traces/{trace_id}/voice_sessions ────────────────────────────


@router.get("/v1/traces/{trace_id}/voice_sessions")
async def get_trace_voice_sessions(
    trace_id: str = Path(...),
) -> dict[str, Any]:
    """Return every voice session row for a trace."""
    svc = get_voice_service()
    rows = await svc.get_sessions_for_trace(trace_id)
    return {
        "status": "ok",
        "feature": "voice_sessions",
        "live": True,
        "data": rows,
        "count": len(rows),
    }


# ── /v1/voice_sessions/{org_id}/barge_in ─────────────────────────────


@router.post("/v1/voice_sessions/{org_id}/barge_in")
async def mark_barge_in(
    org_id: str = Path(...),
    body: MarkBargeInRequest = Body(...),
    _member: dict = Depends(require_org_member),
) -> dict[str, Any]:
    """Mark a (session_id, trace_id) turn as having had a
    barge-in. Idempotent.
    """
    svc = get_voice_service()
    ok = await svc.mark_barge_in(
        body.session_id, body.trace_id,
    )
    return {
        "status": "ok" if ok else "error",
        "feature": "voice_sessions",
        "live": ok,
        "data": {
            "session_id": body.session_id,
            "trace_id": body.trace_id,
            "barge_in_detected": ok,
        },
    }


# ── /v1/voice_sessions/barge_in_spike ───────────────────────────────


@router.get("/v1/voice_sessions/barge_in_spike")
async def detect_barge_in_spike(
    org_id: str = Query(...),
    window_minutes: int = Query(
        DEFAULT_SPIKE_WINDOW_MINUTES, ge=1, le=24 * 60,
    ),
    threshold: int = Query(DEFAULT_SPIKE_THRESHOLD, ge=1, le=1000),
    fire_hook: bool = Query(True),
    _admin: dict = Depends(require_org_admin),
) -> dict[str, Any]:
    """Return the barge-in spike summary for an org in the
    last ``window_minutes`` minutes. When the count crosses
    ``threshold``, the response carries ``spike: true`` and
    the contributing ``session_ids``. ``fire_hook=false``
    is a dry-run (no hook emission).
    """
    svc = get_voice_service()
    summary = await svc.detect_barge_in_spike(
        org_id,
        window_minutes=window_minutes,
        threshold=threshold,
        fire_hook=fire_hook,
    )
    if summary is None:
        return {
            "status": "ok",
            "feature": "voice_barge_in_spike",
            "live": True,
            "data": {
                "org_id": org_id,
                "window_minutes": int(window_minutes),
                "threshold": int(threshold),
                "count": 0,
                "spike": False,
                "session_ids": [],
            },
        }
    return {
        "status": "ok",
        "feature": "voice_barge_in_spike",
        "live": True,
        "data": summary,
    }
