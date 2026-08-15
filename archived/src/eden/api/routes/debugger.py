"""Phase P — Agent Debugger API routes.

Three routes:

  * ``GET  /orgs/{org}/debugger/checkpoints/{trace_id}`` — list checkpoints
  * ``POST /orgs/{org}/debugger/rerun`` — re-run from a step
  * ``POST /orgs/{org}/debugger/discover`` — discover rollout entrypoints
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, Path, Query
from pydantic import BaseModel, Field

from eden.api.deps import (
    get_current_user,
    require_feature_flag,
    require_path_org_access,
)
from eden.debugger.checkpoints import (
    Checkpoint,
    CheckpointStore,
    LivePrefixEngine,
    ReRunEngine,
    discover_entrypoint,
)
from eden.debugger.session import DebugSessionService
from eden.storage.postgres import get_postgres_client

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/orgs/{org_id}/debugger",
    tags=["debugger"],
    dependencies=[Depends(require_path_org_access)],
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
    live_prefix: bool = Field(
        default=False,
        description="When true, use cached-prefix + live tail mode (F01).",
    )
    live: bool = Field(
        default=False,
        description=(
            "When true AND debugger_live_rerun_v1 is enabled, actually call "
            "the model on the mutated tail step (F01 live gateway) instead of "
            "the hermetic recorded replay. Requires prompt_override and/or "
            "tool_result_override to be meaningful."
        ),
    )
    tool_result_override: dict[str, Any] | None = Field(
        default=None,
        description=(
            "Optional mutated tool-result applied to the first tail step "
            "before a live re-run (F01 debugger 'what if the tool returned X')."
        ),
    )
    session_id: str | None = Field(
        default=None,
        description="Optional F74 debug session to attach this run to.",
    )

class CreateDebugSessionRequest(BaseModel):
    title: str = "Debug session"
    source_trace_id: str | None = None
    notes: str = ""

class PatchDebugSessionRequest(BaseModel):
    title: str | None = None
    notes: str | None = None
    last_replay: dict[str, Any] | None = None

class AddDebugRunRequest(BaseModel):
    source_trace_id: str
    from_step: int = 0
    rerun_mode: str = "hermetic"
    result_trace_id: str | None = None
    diff_summary: list[dict[str, Any]] = Field(default_factory=list)

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

def _make_live_llm_fn(org_id: str) -> Any:
    """Build an async llm_fn for the F01 live-rerun path.

    Adapts the checkpoint's chat ``messages`` into the sanctioned playground
    handler (ModelRouter + cost caps + kill switches, with a deterministic
    offline fallback when no API key is configured). Returns a response dict
    the engine can diff against the recorded response.
    """

    async def _live_llm_fn(messages: list[dict[str, Any]]) -> dict[str, Any]:
        from eden.playground.llm_handler import playground_llm_handler

        system = ""
        parts: list[str] = []
        for msg in messages:
            content = msg.get("content")
            if not isinstance(content, str):
                content = str(content or "")
            if msg.get("role") == "system":
                system = content
            else:
                parts.append(f"{msg.get('role', 'user')}: {content}")
        prompt_dict = {
            "system": system,
            "user": "\n".join(parts),
            "model": "t1",
            "org_id": org_id,
        }
        res = await playground_llm_handler(prompt_dict, org_id=org_id)
        return {
            "content": res.response,
            "model": res.model,
            "cost_usd": res.cost_usd,
            "latency_ms": res.latency_ms,
            "source": "live_gateway",
        }

    return _live_llm_fn


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
    "/checkpoints",
    response_model=CheckpointListResponse,
    summary="List checkpoints for a trace (query: trace_id)",
)
async def list_checkpoints_query(
    org_id: str = Depends(require_path_org_access),
    trace_id: str = Query(..., min_length=1, description="Trace to list checkpoints for"),
    user: dict = Depends(get_current_user),
) -> CheckpointListResponse:
    """LP-15: portal historically called ``/checkpoints?trace_id=``;
    path form ``/checkpoints/{trace_id}`` remains canonical.
    """
    return await list_checkpoints(org_id=org_id, trace_id=trace_id, user=user)

@router.get(
    "/checkpoints/{trace_id}",
    response_model=CheckpointListResponse,
    summary="List all checkpoints for a trace, in step order",
)
async def list_checkpoints(
    org_id: str = Depends(require_path_org_access),
    trace_id: str = Path(...),
    user: dict = Depends(get_current_user),
) -> CheckpointListResponse:
    pg = await get_postgres_client()
    store = CheckpointStore(pg)
    cps = await store.list_for_trace(trace_id, org_id=org_id)
    return CheckpointListResponse(
        checkpoints=[_checkpoint_to_response(c) for c in cps],
    )

@router.post(
    "/rerun",
    summary="Re-run a trace from a given step with an optional prompt override",
)
async def rerun(
    body: RerunRequest,
    org_id: str = Depends(require_path_org_access),
    user: dict = Depends(get_current_user),
) -> dict[str, Any]:
    pg = await get_postgres_client()
    store = CheckpointStore(pg)
    if body.live:
        rerun_mode = "live_gateway"
    elif body.live_prefix:
        rerun_mode = "cached_live"
    else:
        rerun_mode = "hermetic"
    if body.live:
        from eden.config import get_settings

        if not get_settings().debugger_live_rerun_v1:
            # Honest, not silent: never pretend a model ran when the live
            # gateway is disabled.
            raise HTTPException(
                status_code=403,
                detail=(
                    "live rerun disabled: enable debugger_live_rerun_v1 to "
                    "actually call the model"
                ),
            )
        from eden.debugger.cache import PrefixCacheService

        cache_svc = PrefixCacheService(pg)
        engine = LivePrefixEngine(
            store, cache_svc=cache_svc, llm_fn=_make_live_llm_fn(org_id),
        )
        result = await engine.rerun_live(
            body.trace_id,
            live_from_step=body.from_step,
            prompt_override=body.prompt_override,
            tool_result_override=body.tool_result_override,
            org_id=org_id,
        )
        out: dict[str, Any] = {
            "source_trace_id": result.source_trace_id,
            "from_step": result.live_from_step,
            "to_step": result.live_from_step + result.live_tail_steps - 1
            if result.live_tail_steps
            else result.live_from_step - 1,
            "prompt_override": body.prompt_override,
            "checkpoints": [
                _checkpoint_to_response(c).model_dump() for c in result.prefix_checkpoints
            ],
            "diff": result.diff,
            "mode": result.mode,
            "live_tail_steps": result.live_tail_steps,
            "model_invoked": result.model_invoked,
        }
    elif body.live_prefix:
        from eden.debugger.cache import PrefixCacheService

        cache_svc = PrefixCacheService(pg)
        engine = LivePrefixEngine(store, cache_svc=cache_svc)
        result = await engine.rerun_live_prefix(
            body.trace_id,
            live_from_step=body.from_step,
            prompt_override=body.prompt_override,
            org_id=org_id,
        )
        out = {
            "source_trace_id": result.source_trace_id,
            "from_step": result.live_from_step,
            "to_step": result.live_from_step + result.live_tail_steps - 1
            if result.live_tail_steps
            else result.live_from_step - 1,
            "prompt_override": body.prompt_override,
            "checkpoints": [
                _checkpoint_to_response(c).model_dump() for c in result.prefix_checkpoints
            ],
            "diff": result.diff,
            "mode": result.mode,
            "live_tail_steps": result.live_tail_steps,
            "model_invoked": result.model_invoked,
        }
    else:
        rerun_engine = ReRunEngine(store)
        rerun_result = await rerun_engine.rerun(
            body.trace_id,
            from_step=body.from_step,
            prompt_override=body.prompt_override,
            org_id=org_id,
        )
        out = RerunResponse(
            source_trace_id=rerun_result.source_trace_id,
            from_step=rerun_result.from_step,
            to_step=rerun_result.to_step,
            prompt_override=rerun_result.prompt_override,
            checkpoints=[_checkpoint_to_response(c) for c in rerun_result.checkpoints],
            diff=rerun_result.diff,
        ).model_dump()

    if body.session_id:
        svc = DebugSessionService(pg)
        await svc.add_run(
            org_id,
            body.session_id,
            source_trace_id=body.trace_id,
            from_step=body.from_step,
            rerun_mode=rerun_mode,
            diff_summary=list(out.get("diff") or []),
        )
        out["session_id"] = body.session_id
    return out

@router.get(
    "/sessions",
    summary="List debugger sessions (F74)",
    dependencies=[Depends(require_feature_flag("debug_sessions_v1"))],
)
async def list_debug_sessions(
    org_id: str = Depends(require_path_org_access),
    limit: int = Query(50, ge=1, le=200),
    user: dict = Depends(get_current_user),
) -> dict[str, Any]:
    pg = await get_postgres_client()
    sessions = await DebugSessionService(pg).list_sessions(org_id, limit=limit)
    return {
        "sessions": [s.to_dict() for s in sessions],
        "count": len(sessions),
    }

@router.post(
    "/sessions",
    summary="Create debugger session (F74)",
    dependencies=[Depends(require_feature_flag("debug_sessions_v1"))],
)
async def create_debug_session(
    org_id: str = Depends(require_path_org_access),
    body: CreateDebugSessionRequest = Body(default_factory=CreateDebugSessionRequest),
    user: dict = Depends(get_current_user),
) -> dict[str, Any]:
    pg = await get_postgres_client()
    session = await DebugSessionService(pg).create(
        org_id,
        title=body.title,
        source_trace_id=body.source_trace_id,
        notes=body.notes,
    )
    return {"session": session.to_dict()}

@router.get(
    "/sessions/{session_id}",
    summary="Get debugger session with runs",
    dependencies=[Depends(require_feature_flag("debug_sessions_v1"))],
)
async def get_debug_session(
    org_id: str = Depends(require_path_org_access),
    session_id: str = Path(...),
    user: dict = Depends(get_current_user),
) -> dict[str, Any]:
    pg = await get_postgres_client()
    session = await DebugSessionService(pg).get(org_id, session_id)
    if session is None:
        return {"status": "not_found", "session_id": session_id}
    return {"session": session.to_dict()}

@router.patch(
    "/sessions/{session_id}",
    summary="Update debugger session title, notes, or last_replay",
    dependencies=[Depends(require_feature_flag("debug_sessions_v1"))],
)
async def patch_debug_session(
    org_id: str = Depends(require_path_org_access),
    session_id: str = Path(...),
    body: PatchDebugSessionRequest = Body(...),
    user: dict = Depends(get_current_user),
) -> dict[str, Any]:
    pg = await get_postgres_client()
    kwargs: dict[str, Any] = {
        "title": body.title,
        "notes": body.notes,
    }
    if "last_replay" in body.model_fields_set:
        kwargs["last_replay"] = body.last_replay
    session = await DebugSessionService(pg).update(
        org_id,
        session_id,
        **kwargs,
    )
    if session is None:
        raise HTTPException(status_code=404, detail="session not found")
    return {"session": session.to_dict()}

@router.get(
    "/sessions/{session_id}/compare",
    summary="Compare two runs in a debug session",
    dependencies=[Depends(require_feature_flag("debug_sessions_v1"))],
)
async def compare_debug_runs(
    org_id: str = Depends(require_path_org_access),
    session_id: str = Path(...),
    run_a: str = Query(..., alias="run_a"),
    run_b: str = Query(..., alias="run_b"),
    user: dict = Depends(get_current_user),
) -> dict[str, Any]:
    pg = await get_postgres_client()
    result = await DebugSessionService(pg).compare_runs(
        org_id, session_id, run_a_id=run_a, run_b_id=run_b
    )
    if result is None:
        return {"status": "not_found"}
    return result

@router.post(
    "/discover",
    response_model=DiscoverResponse,
    summary="Discover rollout entrypoints from a list of candidates",
)
async def discover(
    body: DiscoverRequest,
    org_id: str = Depends(require_path_org_access),
    user: dict = Depends(get_current_user),
) -> DiscoverResponse:
    entrypoints = discover_entrypoint(
        body.candidates, min_confidence=body.min_confidence,
    )
    return DiscoverResponse(
        entrypoints=[e.to_dict() for e in entrypoints],
    )
