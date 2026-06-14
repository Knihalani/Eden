"""AI Insights chat sidebar API.

Phase 8 / Batch B4: persistent AI assistant sidebar that streams
token deltas + tool-call events to the portal as Server-Sent Events.

POST /orgs/{org_id}/ai-insights/chat
    Body: ``{"session_id": "uuid" | null, "message": "..."}``
    Returns: ``text/event-stream`` of ``data: {json}\\n\\n`` chunks.

Event shapes emitted on the stream:
    - ``{"type": "session", "session_id": "...", "title": "..."}``  — first
      message of a new session; the UI stores the id and updates the
      sidebar list.
    - ``{"type": "text_delta", "text": "..."}``                       — incremental
      token from the assistant.
    - ``{"type": "tool_call", "id": "toolu_...", "name": "...",
         "input": {...}}``                                            — the assistant
      decided to call a tool.
    - ``{"type": "tool_result", "id": "toolu_...", "name": "...",
         "status": "ok"|"error", "output": {...},
         "duration_ms": 12}``                                         — the tool
      finished; the assistant will see this in the next model call.
    - ``{"type": "done", "usage": {...}, "stop_reason": "..."}``      — turn
      complete.
    - ``{"type": "error", "message": "..."}``                        — the
      assistant errored; the UI surfaces a toast.

The Anthropic SDK streams the response, so the user sees tokens
land within ~250ms. We use a manual agentic loop (max 4 iterations)
so a single chat can chain multiple tool calls before producing a
final answer.
"""

from __future__ import annotations

import json
import logging
import os
import uuid
from collections.abc import AsyncIterator
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse

from eden.api.deps import log_audit_event, require_org_member
from eden.config import get_settings
from eden.llmops.insights_tools import dispatch_tool_call, list_tools
from eden.storage.postgres import get_postgres_client

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/orgs/{org_id}/ai-insights",
    tags=["ai-insights"],
)


# ============================================================================
# Schemas
# ============================================================================

class ChatRequest(BaseModel):
    """Body for POST /chat."""
    message: str = Field(..., min_length=1, max_length=8000)
    session_id: str | None = Field(
        None,
        description=(
            "Existing session to append to. Omit (or null) to start a "
            "fresh session."
        ),
    )


# ============================================================================
# Prompt + tool definitions
# ============================================================================

SYSTEM_PROMPT = """\
You are the Eden AI Insights assistant. You help engineers and \
product managers understand what's happening in their Eden workspace.

You have access to the following tools. Use them whenever the user's \
question depends on data you don't have in the conversation.

When you answer:
- Lead with a short, direct answer (one or two sentences).
- Follow with the supporting numbers / job_ids / timestamps in a brief list.
- If the data is missing or the question is out of scope, say so plainly.
- Cite job_ids and reference names verbatim so the user can copy them.
- Prefer aggregating data (summarize_jobs) over dumping rows when the user \
asks an open-ended "how are things going" question.

Do not invent data. If a tool returns an error, surface the error and \
ask whether to retry or try a different filter.
"""


# We cap the agentic loop at 4 iterations so a single chat turn can't
# burn unbounded tokens chasing a misbehaving tool.
MAX_TOOL_ITERATIONS = 4


def _anthropic_tools() -> list[dict[str, Any]]:
    """Render the registered insights tools as Anthropic tool specs."""
    return [t.to_anthropic_tool() for t in list_tools()]


# ============================================================================
# Persistence helpers
# ============================================================================

async def _load_session(org_id: str, user_id: str, session_id: str) -> dict[str, Any] | None:
    client = await get_postgres_client()
    return await client.fetchrow(
        """
        SELECT session_id, org_id, user_id, title, archived_at, created_at, updated_at
        FROM ai_insights_chat_sessions
        WHERE session_id = $1 AND org_id = $2 AND user_id = $3
        """,
        session_id, org_id, user_id,
    )


async def _create_session(org_id: str, user_id: str, title: str) -> str:
    session_id = str(uuid.uuid4())
    client = await get_postgres_client()
    await client.execute(
        """
        INSERT INTO ai_insights_chat_sessions (session_id, org_id, user_id, title)
        VALUES ($1, $2, $3, $4)
        """,
        session_id, org_id, user_id, title,
    )
    return session_id


async def _append_message(session_id: str, role: str, content: list[dict[str, Any]]) -> None:
    client = await get_postgres_client()
    await client.execute(
        """
        INSERT INTO ai_insights_chat_messages (message_id, session_id, role, content_jsonb)
        VALUES ($1, $2, $3, $4::jsonb)
        """,
        str(uuid.uuid4()), session_id, role, json.dumps(content),
    )


async def _touch_session(session_id: str, title: str | None = None) -> None:
    client = await get_postgres_client()
    if title:
        await client.execute(
            """
            UPDATE ai_insights_chat_sessions
            SET updated_at = NOW(), title = $2
            WHERE session_id = $1
            """,
            session_id, title,
        )
    else:
        await client.execute(
            "UPDATE ai_insights_chat_sessions SET updated_at = NOW() WHERE session_id = $1",
            session_id,
        )


async def _load_history(session_id: str) -> list[dict[str, Any]]:
    """Reconstruct Anthropic-compatible messages from the DB."""
    client = await get_postgres_client()
    rows = await client.fetch(
        """
        SELECT role, content_jsonb
        FROM ai_insights_chat_messages
        WHERE session_id = $1
        ORDER BY created_at ASC
        """,
        session_id,
    )
    messages: list[dict[str, Any]] = []
    for r in rows:
        content = r["content_jsonb"]
        # content_jsonb is a JSON string (we stored via ::jsonb cast); asyncpg
        # usually deserialises it to a python list. Guard both.
        if isinstance(content, str):
            try:
                content = json.loads(content)
            except json.JSONDecodeError:
                content = []
        messages.append({"role": r["role"], "content": content})
    return messages


def _derive_title(message: str) -> str:
    """Heuristic title for a new session — first ~50 chars of the user message."""
    cleaned = " ".join(message.split())
    if len(cleaned) <= 50:
        return cleaned
    return cleaned[:47] + "..."


# ============================================================================
# Anthropic streaming + tool loop
# ============================================================================

def _is_anthropic_enabled() -> bool:
    settings = get_settings()
    if not settings.ai_insights_enabled:
        return False
    # The SDK picks up ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN from the
    # environment. Surface a clear 503 if neither is configured.
    return os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN")


async def _stream_chat(
    org_id: str,
    user_id: str,
    session_id: str,
    user_message: str,
) -> AsyncIterator[dict[str, Any]]:
    """Yield SSE event dicts for a single chat turn.

    The function is a generator; the route wraps it in an
    ``EventSourceResponse``. Errors are caught and turned into
    ``{"type": "error", ...}`` events so the client always gets a
    graceful close.
    """
    if not _is_anthropic_enabled():
        yield {
            "type": "error",
            "message": (
                "AI Insights is not configured. Set ANTHROPIC_API_KEY and "
                "ensure ai_insights_enabled is true."
            ),
        }
        return

    # Lazy import so the module is optional in environments that
    # never enable the feature.
    try:
        from anthropic import AsyncAnthropic
    except ImportError as exc:  # pragma: no cover — only hit if dep missing
        yield {"type": "error", "message": f"anthropic SDK not installed: {exc}"}
        return

    settings = get_settings()
    client = AsyncAnthropic()

    history = await _load_history(session_id)
    history.append({"role": "user", "content": user_message})
    await _append_message(session_id, "user", [{"type": "text", "text": user_message}])

    tools = _anthropic_tools()
    iterations = 0
    final_text_parts: list[str] = []
    last_usage: dict[str, Any] = {}
    last_stop_reason: str | None = None

    try:
        while iterations < MAX_TOOL_ITERATIONS:
            iterations += 1

            # ``messages.stream`` is the recommended helper. We pass
            # ``tools`` for the agentic loop and accumulate the full
            # assistant turn so we can persist it for replay.
            async with client.messages.stream(
                model=settings.ai_insights_model,
                max_tokens=4096,
                system=SYSTEM_PROMPT,
                tools=tools,
                messages=history,
            ) as stream:
                async for event in stream:
                    etype = getattr(event, "type", None)
                    if etype == "content_block_start":
                        block = getattr(event, "content_block", None)
                        if block is not None and getattr(block, "type", None) == "tool_use":
                            # Surface the tool call so the UI can render
                            # a "calling X" card while we wait for the
                            # result.
                            yield {
                                "type": "tool_call",
                                "id": block.id,
                                "name": block.name,
                                "input": getattr(block, "input", {}) or {},
                            }
                    elif etype == "content_block_delta":
                        delta = getattr(event, "delta", None)
                        if delta is not None and getattr(delta, "type", None) == "text_delta":
                            text = getattr(delta, "text", "")
                            if text:
                                final_text_parts.append(text)
                                yield {"type": "text_delta", "text": text}
                    elif etype == "message_delta":
                        usage = getattr(event, "usage", None)
                        if usage is not None:
                            last_usage = {
                                "input_tokens": getattr(usage, "input_tokens", None),
                                "output_tokens": getattr(usage, "output_tokens", None),
                            }

                final_message = await stream.get_final_message()
                last_stop_reason = getattr(final_message, "stop_reason", None)
                assistant_content = [
                    {
                        "type": b.type,
                        "text": getattr(b, "text", None),
                        "id": getattr(b, "id", None),
                        "name": getattr(b, "name", None),
                        "input": getattr(b, "input", None),
                    }
                    for b in (getattr(final_message, "content", None) or [])
                ]
                usage = getattr(final_message, "usage", None)
                if usage is not None:
                    last_usage = {
                        "input_tokens": getattr(usage, "input_tokens", None),
                        "output_tokens": getattr(usage, "output_tokens", None),
                    }

            # Persist the assistant turn immediately, so a mid-stream
            # client disconnect doesn't lose context.
            if assistant_content:
                await _append_message(session_id, "assistant", assistant_content)

            # If the model didn't ask for a tool, we're done.
            if last_stop_reason != "tool_use":
                break

            # Tool-use turn: dispatch each tool call and append a
            # tool_result block to the running history. We never block
            # the SSE stream on a single tool — the UI sees the
            # tool_call event before the result, just like Claude Code.
            tool_use_blocks = [
                b for b in (getattr(final_message, "content", None) or [])
                if getattr(b, "type", None) == "tool_use"
            ]
            tool_results: list[dict[str, Any]] = []
            for tb in tool_use_blocks:
                result = await dispatch_tool_call(
                    org_id=org_id,
                    name=tb.name,
                    input_json=getattr(tb, "input", {}) or {},
                )
                # ``is_error`` is what the Anthropic tool schema expects.
                is_error = result.get("status") == "error"
                tool_result_block = {
                    "type": "tool_result",
                    "tool_use_id": tb.id,
                    "content": json.dumps(result.get("output", ""), default=str),
                    "is_error": is_error,
                }
                tool_results.append(tool_result_block)
                yield {
                    "type": "tool_result",
                    "id": tb.id,
                    "name": tb.name,
                    "status": result.get("status", "ok"),
                    "output": result.get("output"),
                    "duration_ms": result.get("duration_ms", 0),
                }

            # Persist the tool turn so the assistant's next call sees it
            # when we reload from the DB.
            if tool_results:
                await _append_message(session_id, "tool", tool_results)

            # Append the assistant turn + tool result to the in-memory
            # history and loop for the next model call.
            history.append({"role": "assistant", "content": assistant_content})
            history.append({"role": "user", "content": tool_results})
        # Update the session's ``updated_at`` and bump the touch.
        await _touch_session(session_id)

        yield {
            "type": "done",
            "iterations": iterations,
            "usage": last_usage,
            "stop_reason": last_stop_reason,
        }
    except Exception as exc:  # noqa: BLE001 — last-resort guard
        logger.exception(f"ai_insights chat failed: {exc}")
        yield {"type": "error", "message": f"{type(exc).__name__}: {exc}"}


# ============================================================================
# Endpoints
# ============================================================================

@router.post("/chat")
async def chat(
    org_id: str,
    body: ChatRequest,
    org: dict = Depends(require_org_member),
):
    """Stream a chat turn as Server-Sent Events.

    The first message of a new session also writes an audit-log
    entry so the org's compliance view can see AI usage.
    """
    user_id = org["user_id"]

    # Find or create the session.
    if body.session_id:
        existing = await _load_session(org_id, user_id, body.session_id)
        if not existing:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Session not found",
            )
        session_id = body.session_id
        is_new = False
    else:
        session_id = await _create_session(
            org_id=org_id,
            user_id=user_id,
            title=_derive_title(body.message),
        )
        is_new = True
        # First message of a new session: write the audit entry.
        try:
            pg = await get_postgres_client()
            await log_audit_event(
                client=pg,
                org_id=org_id,
                user_id=user_id,
                action="ai_insights.session.create",
                target_type="ai_insights_session",
                target_id=session_id,
                metadata={"title": _derive_title(body.message)},
            )
        except Exception as exc:  # noqa: BLE001 — audit must not block chat
            logger.warning(f"ai_insights: audit log failed (non-fatal): {exc}")

    async def event_generator():
        if is_new:
            # First event: tell the UI the new session id so it can
            # show the row in the sidebar and persist it client-side.
            yield {
                "event": "session",
                "data": json.dumps({
                    "type": "session",
                    "session_id": session_id,
                    "title": _derive_title(body.message),
                }),
            }
        async for ev in _stream_chat(
            org_id=org_id,
            user_id=user_id,
            session_id=session_id,
            user_message=body.message,
        ):
            yield {"event": ev.get("type", "message"), "data": json.dumps(ev, default=str)}
        # SSE terminator: the EventSourceResponse sends ``data: [DONE]``
        # implicitly when the generator returns. We follow the
        # portal's prior convention by emitting an explicit done event
        # for clients that don't use the EventSource helper.

    return EventSourceResponse(event_generator())


@router.get("/sessions")
async def list_sessions(
    org_id: str,
    org: dict = Depends(require_org_member),
    limit: int = 50,
):
    """List the current user's chat sessions (newest first, archived last)."""
    limit = max(1, min(int(limit), 200))
    user_id = org["user_id"]
    client = await get_postgres_client()
    rows = await client.fetch(
        """
        SELECT session_id, title, created_at, updated_at, archived_at
        FROM ai_insights_chat_sessions
        WHERE org_id = $1 AND user_id = $2
        ORDER BY (archived_at IS NULL) DESC, updated_at DESC
        LIMIT $3
        """,
        org_id, user_id, limit,
    )
    return {
        "sessions": [
            {
                "session_id": str(r["session_id"]),
                "title": r["title"],
                "created_at": r["created_at"].isoformat() if r["created_at"] else None,
                "updated_at": r["updated_at"].isoformat() if r["updated_at"] else None,
                "archived": r["archived_at"] is not None,
            }
            for r in rows
        ],
    }


@router.get("/sessions/{session_id}/messages")
async def list_messages(
    org_id: str,
    session_id: str,
    org: dict = Depends(require_org_member),
):
    """Replay all messages in a session (for sidebar rehydration)."""
    user_id = org["user_id"]
    existing = await _load_session(org_id, user_id, session_id)
    if not existing:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Session not found",
        )
    client = await get_postgres_client()
    rows = await client.fetch(
        """
        SELECT message_id, role, content_jsonb, created_at
        FROM ai_insights_chat_messages
        WHERE session_id = $1
        ORDER BY created_at ASC
        """,
        session_id,
    )
    return {
        "session_id": session_id,
        "title": existing["title"],
        "messages": [
            {
                "message_id": str(r["message_id"]),
                "role": r["role"],
                "content": r["content_jsonb"],
                "created_at": r["created_at"].isoformat() if r["created_at"] else None,
            }
            for r in rows
        ],
    }


@router.post("/sessions/{session_id}/archive")
async def archive_session(
    org_id: str,
    session_id: str,
    org: dict = Depends(require_org_member),
):
    """Soft-delete a session (sets archived_at)."""
    user_id = org["user_id"]
    existing = await _load_session(org_id, user_id, session_id)
    if not existing:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Session not found",
        )
    client = await get_postgres_client()
    await client.execute(
        "UPDATE ai_insights_chat_sessions SET archived_at = NOW() WHERE session_id = $1",
        session_id,
    )
    return {"session_id": session_id, "archived": True}


@router.get("/health")
async def health(
    org_id: str,
    org: dict = Depends(require_org_member),
):
    """Probe endpoint: returns whether AI Insights is configured."""
    settings = get_settings()
    return {
        "enabled": bool(settings.ai_insights_enabled),
        "model": settings.ai_insights_model,
        "anthropic_key_configured": bool(
            os.environ.get("ANTHROPIC_API_KEY")
            or os.environ.get("ANTHROPIC_AUTH_TOKEN")
        ),
        "tool_count": len(list_tools()),
    }
