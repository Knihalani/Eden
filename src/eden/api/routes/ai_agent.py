"""Phase C — unified AI agent API (Cat 14 real, global panel backend).

Exposes the agent as an SSE-streaming POST endpoint plus the
standard CRUD over persisted conversations + messages.

Routes
──────

  POST   /orgs/{org}/ai/chat              Stream one user turn (SSE)
  GET    /orgs/{org}/ai/conversations     List user's conversations
  GET    /orgs/{org}/ai/conversations/{id} Get conversation + messages
  DELETE /orgs/{org}/ai/conversations/{id} Soft-delete (archive) a chat
  GET    /orgs/{org}/ai/tools             Public tool catalog

The ``POST /chat`` endpoint is the headline — it returns
``text/event-stream`` where each event is one :class:`AgentChunk`
JSON-serialised. The portal renders text deltas as they arrive and
collapses chart/citation/tool_call events inline.

Per-org + per-user isolation is enforced by every query — the
``org_id`` comes from the URL path (the JWT lookup gives the
caller; we never trust a client-supplied value), the ``user_id``
from the authenticated session.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from eden.api.deps import get_current_user, require_path_org_access
from eden.autonomous.agent import (
    AgentChunk,
    get_chat_service,
    tool_specs,
)

logger = logging.getLogger(__name__)
router = APIRouter(
    prefix="/orgs/{org_id}/ai",
    tags=["ai-agent"],
    dependencies=[Depends(require_path_org_access)],
)


# ── Pydantic schemas ──────────────────────────────────────────────


class ChatRequest(BaseModel):
    conversation_id: str | None = Field(
        None, description="Existing conversation id (omit to start a new one).",
    )
    message: str = Field(..., min_length=1, max_length=8_000)
    page_context: dict[str, Any] = Field(
        default_factory=dict,
        description="Auto-attached context from the portal (trace_id, incident_id, agent_id, etc).",
    )


class ChatResponseSummary(BaseModel):
    """Returned as the LAST SSE event so the portal can update its
    conversation-id state and token counters."""

    conversation_id: str
    turns: int
    prompt_tokens: int
    completion_tokens: int


class ConversationSummary(BaseModel):
    id: str
    title: str
    page_context: dict[str, Any] = {}
    turn_count: int = 0
    total_tokens: int = 0
    total_cost_usd: float = 0.0
    created_at: str
    updated_at: str
    last_message_at: str | None = None


class MessageOut(BaseModel):
    id: str
    role: str
    content: str = ""
    tool_calls: list[dict[str, Any]] = []
    chart_specs: list[dict[str, Any]] = []
    citations: list[dict[str, Any]] = []
    prompt_tokens: int = 0
    completion_tokens: int = 0
    model_used: str | None = None
    created_at: str


class ConversationDetail(BaseModel):
    conversation: ConversationSummary
    messages: list[MessageOut]


class ToolCatalogEntry(BaseModel):
    name: str
    summary: str
    args: dict[str, Any]


# ── Helpers ────────────────────────────────────────────────────────


def _sse_format(data: dict[str, Any]) -> str:
    """Format one SSE event. Multi-line data is split across ``data:`` lines."""
    payload = json.dumps(data, default=str)
    lines = payload.splitlines() or ["{}"]
    return "data: " + "\ndata: ".join(lines) + "\n\n"


async def _resolve_user_role(org_id: str, user_id: str) -> str:
    """Look up the caller's role inside ``org_id``.

    Returns one of: ``"owner"``, ``"admin"``, ``"member"``, ``"viewer"``.
    Raises 403 when membership/role cannot be resolved — never defaults
    a non-member to ``"member"``.
    """
    try:
        from eden.storage.postgres import get_postgres_client
        client = await get_postgres_client()
        if client is None:
            raise HTTPException(status_code=503, detail="postgres_unavailable")
        row = await client.fetchrow(
            """
            SELECT m.role
            FROM org_members m
            WHERE m.org_id = $1 AND m.user_id = $2
            """,
            org_id, user_id,
        )
        if row:
            return str(row["role"])
    except HTTPException:
        raise
    except Exception as exc:
        logger.debug(f"role lookup failed: {exc}")
        raise HTTPException(status_code=503, detail="role_lookup_failed") from exc
    raise HTTPException(status_code=403, detail="Not a member of this organization")


# ── Routes ─────────────────────────────────────────────────────────


@router.post("/chat")
async def chat_route(
    request: Request,
    org_id: str = Depends(require_path_org_access),
    body: ChatRequest = ...,
    user: dict = Depends(get_current_user),
) -> StreamingResponse:
    """Stream one user turn via SSE.

    The response is ``text/event-stream`` of :class:`AgentChunk`
    payloads. Each chunk is one SSE event. The final event has
    ``type: done`` and the portal closes the connection.

    Per-org + per-user isolation enforced via the URL path + JWT.
    """
    if not getattr(request.app.state, "ai_agent_enabled", True):
        raise HTTPException(status_code=503, detail="ai_agent_disabled")

    user_id = str(user.get("id") or user.get("user_id") or user.get("sub") or "")
    if not user_id:
        raise HTTPException(status_code=401, detail="user_id_not_in_token")
    user_role = await _resolve_user_role(org_id, user_id)
    service = get_chat_service()

    async def event_generator():
        # SSE prelude — gives the portal a fast "connected" ack.
        yield _sse_format({"type": "connected",
                           "conversation_id": body.conversation_id or "new"})

        # The ReAct loop emits chunks via emit(); we forward each
        # one to the client as one SSE event.
        async def emit(chunk: AgentChunk) -> None:
            # ``StreamingResponse`` queues data into the ASGI
            # send channel; we just yield the SSE frame.
            yield _sse_format(chunk.to_dict())

        # Run the loop in a task; we drain its emit() events into the
        # stream. We do this with a small asyncio.Queue so the loop
        # can push events while we yield them.
        queue: asyncio.Queue[AgentChunk | None] = asyncio.Queue()

        async def emit_push(chunk: AgentChunk) -> None:
            await queue.put(chunk)

        async def run_loop() -> dict[str, Any]:
            return await service.stream_chat(
                tenant_id=org_id,
                user_id=user_id,
                conversation_id=body.conversation_id,
                user_message=body.message,
                page_context=body.page_context,
                user_role=user_role,
                emit=emit_push,
            )

        task = asyncio.create_task(run_loop())

        try:
            while True:
                if await request.is_disconnected():
                    task.cancel()
                    break
                try:
                    chunk = await asyncio.wait_for(queue.get(), timeout=15.0)
                except TimeoutError:
                    # Heartbeat — keeps proxies from closing the SSE
                    # channel during long ReAct loops.
                    yield ": heartbeat\n\n"
                    continue
                if chunk is None:
                    break
                yield _sse_format(chunk.to_dict())
                if chunk.type in ("done", "error"):
                    break
        finally:
            if not task.done():
                task.cancel()
            try:
                summary = await task
                if summary:
                    yield _sse_format({
                        "type": "summary",
                        "conversation_id": summary.get("conversation_id"),
                        "turns": summary.get("turns"),
                        "prompt_tokens": summary.get("prompt_tokens"),
                        "completion_tokens": summary.get("completion_tokens"),
                    })
            except (asyncio.CancelledError, Exception):
                pass

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",  # disable nginx buffering
            "Connection": "keep-alive",
        },
    )


@router.get("/conversations", response_model=list[ConversationSummary])
async def list_conversations_route(
    org_id: str = Depends(require_path_org_access),
    user: dict = Depends(get_current_user),
    limit: int = Query(50, ge=1, le=200),
):
    """List the caller's recent conversations (newest first)."""
    user_id = str(user.get("id") or user.get("user_id") or user.get("sub") or "")
    from eden.storage.postgres import get_postgres_client
    client = await get_postgres_client()
    if client is None:
        raise HTTPException(status_code=503, detail="postgres_unavailable")
    rows = await client.fetch(
        """
        SELECT id, title, page_context, turn_count, total_tokens,
               total_cost_usd, created_at, updated_at, last_message_at
        FROM ai_conversations
        WHERE org_id = $1 AND user_id = $2 AND archived_at IS NULL
        ORDER BY updated_at DESC
        LIMIT $3
        """,
        org_id, user_id, limit,
    )
    return [
        ConversationSummary(
            id=str(r["id"]),
            title=r["title"],
            page_context=r["page_context"] or {},
            turn_count=int(r["turn_count"] or 0),
            total_tokens=int(r["total_tokens"] or 0),
            total_cost_usd=float(r["total_cost_usd"] or 0),
            created_at=r["created_at"].isoformat(),
            updated_at=r["updated_at"].isoformat(),
            last_message_at=(r["last_message_at"].isoformat()
                             if r["last_message_at"] else None),
        )
        for r in rows
    ]


@router.get("/conversations/{conversation_id}",
            response_model=ConversationDetail)
async def get_conversation_route(
    org_id: str = Depends(require_path_org_access),
    conversation_id: str = Path(...),
    user: dict = Depends(get_current_user),
):
    """Return a conversation with all its messages (for chat reload)."""
    user_id = str(user.get("id") or user.get("user_id") or user.get("sub") or "")
    from eden.storage.postgres import get_postgres_client
    client = await get_postgres_client()
    if client is None:
        raise HTTPException(status_code=503, detail="postgres_unavailable")

    conv_row = await client.fetchrow(
        """
        SELECT id, title, page_context, turn_count, total_tokens,
               total_cost_usd, created_at, updated_at, last_message_at
        FROM ai_conversations
        WHERE id = $1 AND org_id = $2 AND user_id = $3
        """,
        conversation_id, org_id, user_id,
    )
    if conv_row is None:
        raise HTTPException(status_code=404, detail="conversation_not_found")

    msg_rows = await client.fetch(
        """
        SELECT id, role, content, tool_calls, chart_specs, citations,
               prompt_tokens, completion_tokens, model_used, created_at
        FROM ai_messages
        WHERE conversation_id = $1
        ORDER BY created_at ASC
        """,
        conversation_id,
    )

    return ConversationDetail(
        conversation=ConversationSummary(
            id=str(conv_row["id"]),
            title=conv_row["title"],
            page_context=conv_row["page_context"] or {},
            turn_count=int(conv_row["turn_count"] or 0),
            total_tokens=int(conv_row["total_tokens"] or 0),
            total_cost_usd=float(conv_row["total_cost_usd"] or 0),
            created_at=conv_row["created_at"].isoformat(),
            updated_at=conv_row["updated_at"].isoformat(),
            last_message_at=(conv_row["last_message_at"].isoformat()
                             if conv_row["last_message_at"] else None),
        ),
        messages=[
            MessageOut(
                id=str(m["id"]),
                role=m["role"],
                content=m["content"] or "",
                tool_calls=m["tool_calls"] or [],
                chart_specs=m["chart_specs"] or [],
                citations=m["citations"] or [],
                prompt_tokens=int(m["prompt_tokens"] or 0),
                completion_tokens=int(m["completion_tokens"] or 0),
                model_used=m["model_used"],
                created_at=m["created_at"].isoformat(),
            )
            for m in msg_rows
        ],
    )


@router.delete("/conversations/{conversation_id}")
async def archive_conversation_route(
    org_id: str = Depends(require_path_org_access),
    conversation_id: str = Path(...),
    user: dict = Depends(get_current_user),
):
    """Soft-delete a conversation (sets archived_at = NOW)."""
    user_id = str(user.get("id") or user.get("user_id") or user.get("sub") or "")
    from eden.storage.postgres import get_postgres_client
    client = await get_postgres_client()
    if client is None:
        raise HTTPException(status_code=503, detail="postgres_unavailable")
    result = await client.execute(
        """
        UPDATE ai_conversations
        SET archived_at = NOW()
        WHERE id = $1 AND org_id = $2 AND user_id = $3 AND archived_at IS NULL
        """,
        conversation_id, org_id, user_id,
    )
    return {"archived": True, "conversation_id": conversation_id, "raw": str(result)}


@router.get("/tools", response_model=list[ToolCatalogEntry])
async def list_tools_route(
    org_id: str = Depends(require_path_org_access),
    user: dict = Depends(get_current_user),
):
    """Public catalog of tools the agent can call.

    Useful for the portal's "what can the agent do?" panel and for
    future integrations that want to enumerate capabilities.
    """
    return [ToolCatalogEntry(**spec) for spec in tool_specs()]
