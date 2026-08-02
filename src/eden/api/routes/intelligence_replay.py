"""Intelligence Gap — Trace Replay & Workflow (Cat 1) routes.

Real implementations (2026-06-10):
* ``replay_trace`` — paginated read of ``telemetry_events``
* ``diff_traces`` — per-event-fingerprint comparison
* ``workflow_graph`` — Cytoscape-style nodes/edges
* ``workflow_subgraph`` — BFS sub-DAG from a root span
* ``live_tail`` — SSE stream of new events for an org
* ``rewind_checkpoint`` — read state at step N
* ``list_checkpoints`` — list available checkpoints
* ``conversation_history`` — read chat history for a session
* ``add_message`` — append to a conversation
* ``set_custom_properties`` / ``list_custom_properties`` —
  merge into the trace's ``tags`` column

Gates:
* ``intelligence_gap_v0`` umbrella flag
* Org scoping via ``{org_id}`` path param
* ``get_current_user`` for auth

See ``docs/observability-gap/01-trace-replay.md``.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, Path
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from eden.api.deps import (
    require_feature_flag,
    require_path_org_access,
)
from eden.api.utils.redact import redact_all
from eden.observability.checkpoint.rewind import CheckpointService
from eden.observability.custom_properties.service import CustomPropertiesService
from eden.observability.live_tail.service import LiveTailService
from eden.observability.message_view.service import MessageViewService
from eden.observability.replay.service import ReplayService
from eden.observability.workflow.graph_builder import WorkflowGraphBuilder

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/orgs/{org_id}/intelligence/replay",
    tags=["intelligence-replay"],
    dependencies=[
        Depends(require_feature_flag("intelligence_gap_v0")),
        Depends(require_path_org_access),
    ],
)

# ─── Singletons (stateless) ───────────────────────────────────────
_replay = ReplayService()
_workflow = WorkflowGraphBuilder()
_live_tail = LiveTailService()
_checkpoint = CheckpointService()
_messages = MessageViewService()
_custom_props = CustomPropertiesService()

# ─── Schemas ───────────────────────────────────────────────────────
class ReplayRequest(BaseModel):
    cursor: int = Field(0, ge=0)
    page_size: int = Field(100, ge=1, le=1000)

class DiffRequest(BaseModel):
    trace_id_a: str
    trace_id_b: str

class SubgraphRequest(BaseModel):
    root_span_id: str

class RewindRequest(BaseModel):
    step_index: int = Field(0, ge=0)

class AddMessageRequest(BaseModel):
    session_id: str
    role: str = Field(..., description="user, assistant, system, or tool")
    content: str
    conversation_id: str | None = None

class CustomPropertiesRequest(BaseModel):
    properties: dict[str, str]

class ListCustomPropertiesRequest(BaseModel):
    """Body schema for ``POST /properties/list`` — we use POST
    rather than GET to keep the org_id scoping pattern
    consistent with the other replay routes."""

class CreateReplaySessionRequest(BaseModel):
    """Body for ``POST /sessions`` (Phase A.6).

    Starts a new replay session anchored to an existing trace. The
    session row is persisted to ``replay_sessions`` (added in
    migration 029) so the portal's /replay page can list and resume
    prior sessions.
    """
    trace_id: str = Field(..., min_length=1, max_length=128)
    name: str | None = Field(None, max_length=128)

# ─── Routes ────────────────────────────────────────────────────────
@router.post("/sessions")
async def create_replay_session(
    org_id: str = Depends(require_path_org_access),
    body: CreateReplaySessionRequest = Body(...),
) -> dict[str, Any]:
    """Create a new replay session anchored to ``trace_id``.

    Persists a row to ``replay_sessions`` (migration 029). The portal's
    ``replayApi.createSession`` client method calls this; before this
    endpoint existed the frontend had no way to start a session and
    would silently fail on save. The session_id is returned so the
    portal can immediately fetch the tree / messages.

    Idempotent on (org_id, trace_id, name) — re-calling with the same
    args returns the existing session_id. Sessions with a NULL name are
    always treated as new (the "scratch session" path).
    """

    from eden.storage.postgres import get_postgres_client

    client = await get_postgres_client()
    if client is None:
        raise HTTPException(status_code=503, detail="Postgres unavailable")

    # Find-or-create pattern. If (org, trace, name) already exists,
    # return the existing id; otherwise insert a new row.
    try:
        return await _create_replay_session_row(client, org_id, body)
    except HTTPException:
        raise
    except Exception as exc:
        msg = str(exc).lower()
        if "invalid input syntax for type uuid" in msg:
            raise HTTPException(status_code=400, detail="Invalid organization id") from exc
        if "foreign key" in msg:
            raise HTTPException(status_code=404, detail="Organization not found") from exc
        if "unique" in msg or "duplicate" in msg:
            raise HTTPException(status_code=409, detail="Replay session conflict") from exc
        logger.warning("create_replay_session failed: %s", redact_all(str(exc)))
        raise HTTPException(status_code=503, detail="Failed to create replay session") from exc

async def _create_replay_session_row(client: Any, org_id: str, body: CreateReplaySessionRequest) -> dict[str, Any]:
    import uuid as _uuid

    if body.name is not None:
        existing = await client.fetchrow(
            """
            SELECT id, created_at FROM replay_sessions
            WHERE org_id = $1 AND trace_id = $2 AND name = $3
            """,
            org_id, body.trace_id, body.name,
        )
        if existing:
            return {
                "session_id": str(existing["id"]),
                "org_id": org_id,
                "trace_id": body.trace_id,
                "name": body.name,
                "created_at": existing["created_at"].isoformat() if hasattr(existing["created_at"], "isoformat") else str(existing["created_at"]),
            }

    session_id = f"replay_{_uuid.uuid4().hex[:16]}"
    row = await client.fetchrow(
        """
        INSERT INTO replay_sessions (id, org_id, trace_id, name, created_at)
        VALUES ($1, $2, $3, $4, NOW())
        RETURNING id, created_at
        """,
        session_id, org_id, body.trace_id, body.name,
    )
    created_at = row["created_at"]
    return {
        "session_id": str(row["id"]),
        "org_id": org_id,
        "trace_id": body.trace_id,
        "name": body.name,
        "created_at": created_at.isoformat() if hasattr(created_at, "isoformat") else str(created_at),
    }

@router.post("/{trace_id}/replay")
async def replay_trace(
    org_id: str = Depends(require_path_org_access),
    trace_id: str = Path(...),
    body: ReplayRequest = ReplayRequest(),
) -> dict[str, Any]:
    return await _replay.replay_trace(
        org_id, trace_id, cursor=body.cursor, page_size=body.page_size
    )

@router.post("/diff")
async def diff_traces(
    org_id: str = Depends(require_path_org_access),
    body: DiffRequest = Body(...),
) -> dict[str, Any]:
    return await _replay.diff_traces(
        org_id, body.trace_id_a, body.trace_id_b
    )

@router.get("/{trace_id}/workflow")
async def workflow_graph(
    org_id: str = Depends(require_path_org_access),
    trace_id: str = Path(...),
) -> dict[str, Any]:
    return await _workflow.build(org_id, trace_id)

@router.post("/{trace_id}/subgraph")
async def workflow_subgraph(
    org_id: str = Depends(require_path_org_access),
    trace_id: str = Path(...),
    body: SubgraphRequest = Body(...),
) -> dict[str, Any]:
    return await _workflow.subgraph(
        org_id, trace_id, root_span_id=body.root_span_id
    )

@router.get("/live-tail")
async def live_tail(
    org_id: str = Depends(require_path_org_access),
    filter_agent_id: str | None = None,
    filter_event_type: str | None = None,
) -> StreamingResponse:
    """SSE stream of new telemetry events for ``org_id``.

    The stream is held open by the consumer; the response
    is ``text/event-stream`` so browsers' native
    ``EventSource`` works without a polyfill. The first
    line is a heartbeat (``": heartbeat"``) so the client
    knows the connection is live before any events arrive.
    """
    generator = _live_tail.stream(
        org_id,
        filter_agent_id=filter_agent_id,
        filter_event_type=filter_event_type,
    )
    return StreamingResponse(
        generator,
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",  # disable proxy buffering
        },
    )

@router.post("/{trace_id}/checkpoint/rewind")
async def rewind_checkpoint(
    org_id: str = Depends(require_path_org_access),
    trace_id: str = Path(...),
    body: RewindRequest = Body(...),
) -> dict[str, Any]:
    return await _checkpoint.rewind_to_step(
        org_id, trace_id, step_index=body.step_index
    )

@router.get("/{trace_id}/checkpoints")
async def list_checkpoints(
    org_id: str = Depends(require_path_org_access),
    trace_id: str = Path(...),
) -> dict[str, Any]:
    return await _checkpoint.list_checkpoints(org_id, trace_id)

# ─── Decision Intelligence (Cat 16) — co-located per plan ────────
# Per the plan, Decision Intelligence routes live under
# /intelligence/replay/decision/* because the decision path is
# just a special view of a trace. We lazy-import each decision
# service so the trace package stays light and an import error
# in one service can't take down the others.
#
# All five routes share the same org-scoping, feature flag, and
# auth pattern as the rest of the router. The services
# themselves are stateless and safe to instantiate per request.
@router.post("/{trace_id}/decision/path")
async def decision_path(
    org_id: str = Depends(require_path_org_access),
    trace_id: str = Path(...),
) -> dict[str, Any]:
    from eden.decision.path_reconstructor import DecisionPathReconstructor

    return await DecisionPathReconstructor().reconstruct(org_id, trace_id)

@router.post("/{trace_id}/decision/explain")
async def decision_explain(
    org_id: str = Depends(require_path_org_access),
    trace_id: str = Path(...),
) -> dict[str, Any]:
    from eden.decision.reasoning_explainer import ReasoningTraceExplainer

    return await ReasoningTraceExplainer().explain(org_id, trace_id)

@router.get("/{trace_id}/decision/alternatives")
async def decision_alternatives(
    org_id: str = Depends(require_path_org_access),
    trace_id: str = Path(...),
) -> dict[str, Any]:
    from eden.decision.alternatives import DecisionAlternatives

    return await DecisionAlternatives().list_considered(org_id, trace_id)

@router.post("/{trace_id}/decision/score")
async def decision_score(
    org_id: str = Depends(require_path_org_access),
    trace_id: str = Path(...),
) -> dict[str, Any]:
    from eden.decision.decision_scorer import DecisionScorer

    return await DecisionScorer().score(org_id, trace_id)

@router.get("/{trace_id}/decision/trajectory")
async def decision_trajectory(
    org_id: str = Depends(require_path_org_access),
    trace_id: str = Path(...),
) -> dict[str, Any]:
    from eden.decision.trajectory_analyzer import AgentTrajectoryAnalyzer

    return await AgentTrajectoryAnalyzer().analyze(org_id, trace_id)

@router.get("/conversation/{session_id}")
async def conversation_history(
    org_id: str = Depends(require_path_org_access),
    session_id: str = Path(...),
    limit: int = 100,
    conversation_id: str | None = None,
) -> dict[str, Any]:
    return await _messages.get_conversation_history(
        org_id, session_id=session_id, limit=limit, conversation_id=conversation_id
    )

@router.post("/conversation/message")
async def add_message(
    org_id: str = Depends(require_path_org_access),
    body: AddMessageRequest = Body(...),
) -> dict[str, Any]:
    return await _messages.add_message(
        org_id,
        session_id=body.session_id,
        role=body.role,
        content=body.content,
        conversation_id=body.conversation_id,
    )

@router.post("/{trace_id}/properties")
async def set_custom_properties(
    org_id: str = Depends(require_path_org_access),
    trace_id: str = Path(...),
    body: CustomPropertiesRequest = Body(...),
) -> dict[str, Any]:
    return await _custom_props.set(
        org_id, trace_id=trace_id, properties=body.properties
    )

@router.get("/{trace_id}/properties")
async def list_custom_properties(
    org_id: str = Depends(require_path_org_access),
    trace_id: str = Path(...),
) -> dict[str, Any]:
    return await _custom_props.list(org_id, trace_id=trace_id)
