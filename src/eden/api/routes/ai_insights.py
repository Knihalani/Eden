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

Wired through the OpenRouter client (model_router-aroute path).
The router's tier classification + fallback chain picks the
cheapest tier that can answer (T1 -> T2 -> T3 -> T4). Manual
agentic loop (max 4 iterations) so a single chat can chain
multiple tool calls before producing a final answer.

Tool calling is implemented as a JSON-block in the model's
response (the simpler "pseudo function calling" pattern) since
not every OpenRouter model in the tier list supports the
OpenAI-style ``tools`` parameter natively. The system prompt
tells the model the exact format to emit.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import uuid
from collections.abc import AsyncIterator
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse

from eden.api.deps import get_current_user, log_audit_event, require_org_member
from eden.api.utils.redact import redact_all
from eden.api.utils.safe_error import safe_detail
from eden.config import get_settings
from eden.llm.client import get_llm_client
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

def _build_system_prompt(tools: list) -> str:
    """Compress the system prompt + tool catalogue into one string.

    The tool catalogue is rendered as a compact name + 1-line
    description per tool — enough for the model to pick the right
    one without bloating every-turn tokens. Output format is
    described inline so the model emits a parseable JSON block
    when it wants to call a tool.
    """
    tool_lines = []
    for t in tools:
        one_liner = (t.description or "").split("\n", 1)[0].strip()
        tool_lines.append(f"- {t.name}: {one_liner}")
    tool_block = "\n".join(tool_lines) if tool_lines else "(no tools available)"

    return f"""\
You are Eden's AI Insights assistant. Help users understand what's \
happening in their Eden workspace.

Answer style:
- Lead with the answer (1-2 sentences). Then numbers. Never padding.
- Cite job_ids / trace_ids / timestamps verbatim.
- Aggregate over dumping rows on open-ended questions.
- Never invent data. Surface tool errors plainly.

If the user asks for something outside your tools, say so. Don't \
guess. "I don't have that data — try the dashboard's X panel" beats a \
fabricated answer.

Available tools (call one by emitting the JSON block below):
{tool_block}

When you need data: emit EXACTLY ONE tool call block, fenced with \
``tool_call`` markers, like this:

```tool_call
{{"name": "list_jobs", "args": {{"limit": 5, "status": "failed"}}}}
```

When you have enough to answer: write the answer directly, no \
fence. Keep it short — the user can ask for more.
"""


TOOL_CALL_RE = re.compile(
    r"```tool_call\s*\n(\{.*?\})\s*\n```",
    re.DOTALL,
)


def _extract_tool_call(text: str) -> dict[str, Any] | None:
    """Parse a ```tool_call``` block out of the model's text.

    Returns ``{"name": ..., "args": {...}}`` or ``None`` if the
    response didn't contain a parseable tool call.
    """
    match = TOOL_CALL_RE.search(text)
    if not match:
        return None
    raw = match.group(1).strip()
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        logger.warning(f"ai_insights: model emitted invalid tool_call JSON: {raw[:200]}")
        return None
    if not isinstance(parsed, dict) or "name" not in parsed:
        return None
    return {
        "name": str(parsed["name"]),
        "args": parsed.get("args") or {},
    }


def _strip_tool_call_block(text: str) -> str:
    return TOOL_CALL_RE.sub("", text).strip()


# Agentic-loop cap so a single chat turn can't burn unbounded
# tokens chasing a misbehaving tool.
MAX_TOOL_ITERATIONS = 4

# Most answers are a few sentences + a small list; 2048 is well
# within high-quality range and halves the worst-case output cost
# vs 4096.
MAX_OUTPUT_TOKENS = 2048

# Sliding-window cap on history. Beyond this we summarise the
# oldest messages into a single [Earlier context] block so long
# sessions don't blow out the context window.
HISTORY_KEEP_RECENT = 8
HISTORY_KEEP_HEAD = 2

# Model selection. The OpenRouter client picks a model per slot
# (``fast`` = cheap, ``reasoning`` = balanced, ``expert`` = top
# tier). We always use ``reasoning`` for chat — a chat turn
# should be cost-effective but still high quality; cheap
# classification is the wrong default. The model's own internal
# fallback chain handles model outages.
LLM_SLOT = "reasoning"


def _format_history_for_prompt(
    history: list[dict[str, Any]],
    keep_recent: int = HISTORY_KEEP_RECENT,
    keep_head: int = HISTORY_KEEP_HEAD,
) -> str:
    """Render the conversation history as a compact transcript
    that fits in the OpenRouter prompt's single ``prompt`` field.
    Long sessions get the head + a "[Earlier context]" placeholder
    + the recent turns — the model rarely needs the middle and we
    don't want to burn tokens on it.
    """
    if not history:
        return ""

    if len(history) <= keep_recent + keep_head:
        body = history
    else:
        head = history[:keep_head]
        recent = history[-keep_recent:]
        middle = history[keep_head:-keep_recent]
        body = [
            *head,
            {
                "role": "user",
                "content": (
                    f"[Earlier context: {len(middle)} prior message(s) "
                    f"trimmed to save tokens. The most recent "
                    f"{keep_recent} turns below are the live exchange.]"
                ),
            },
            *recent,
        ]

    lines = []
    for m in body:
        role = m.get("role", "user")
        content = m.get("content", "")
        if isinstance(content, list):
            content = " ".join(
                b.get("text", "") for b in content if b.get("type") == "text"
            )
        # Truncate each message to keep the prompt tight. 800
        # chars per turn is plenty for the model to know what
        # was said.
        if len(content) > 800:
            content = content[:797] + "..."
        prefix = (
            "USER" if role == "user"
            else "ASSISTANT" if role == "assistant"
            else "TOOL"
        )
        lines.append(f"{prefix}: {content}")
    return "\n".join(lines)


# ============================================================================
# Persistence helpers
# ============================================================================

async def _load_session(org_id: str, user_id: str, session_id: str) -> dict[str, Any] | None:
    """Fetch a single chat session, scoped to (org, user).

    Defensive: a DB blip returns ``None`` so the caller sees
    "session not found" instead of a 500. Distinguishing a real
    not-found row from a DB error is impossible without a
    second round-trip, so we treat both the same — safer than
    shipping a 500 to the chat sidebar. July 2026 site-wide
    hardening (companion to the list_sessions try/except).
    """
    try:
        client = await get_postgres_client()
        return await client.fetchrow(
            """
            SELECT session_id, org_id, user_id, title, archived_at, created_at, updated_at
            FROM ai_insights_chat_sessions
            WHERE session_id = $1 AND org_id = $2 AND user_id = $3
            """,
            session_id, org_id, user_id,
        )
    except Exception as exc:
        logger.warning(
            "ai_insights: _load_session failed for user=%s org=%s session=%s: %s",
            user_id, org_id, session_id, redact_all(str(exc)),
        )
        return None


async def _create_session(org_id: str, user_id: str, title: str) -> str:
    """Insert a new chat session row and return its uuid.

    Re-raises DB errors so the caller (``/chat``) can surface
    them as an explicit ``error`` SSE event rather than a 500.
    The chat stream already catches all exceptions via the
    outer ``try/except`` in ``_stream_chat`` (see
    ``_stream_chat``'s last-resort guard).
    """
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
    """Persist one chat turn. Best-effort: a DB blip is logged
    but doesn't stop the chat stream — the user would lose
    their reply if a single transient write failed. The outer
    ``_stream_chat`` finally block still emits a ``done`` event
    so the client gets a clean stream close."""
    try:
        client = await get_postgres_client()
        await client.execute(
            """
            INSERT INTO ai_insights_chat_messages (message_id, session_id, role, content_jsonb)
            VALUES ($1, $2, $3, $4::jsonb)
            """,
            str(uuid.uuid4()), session_id, role, json.dumps(content),
        )
    except Exception as exc:
        logger.warning(
            "ai_insights: _append_message failed for session=%s role=%s: %s",
            session_id, role, redact_all(str(exc)),
        )


async def _touch_session(session_id: str, title: str | None = None) -> None:
    """Bump ``updated_at`` (and optionally ``title``) on a session.

    Best-effort: a DB blip is logged but the chat stream still
    finishes normally — losing the updated_at tick on one turn
    is harmless."""
    try:
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
    except Exception as exc:
        logger.warning(
            "ai_insights: _touch_session failed for session=%s: %s",
            session_id, redact_all(str(exc)),
        )


async def _load_history(session_id: str) -> list[dict[str, Any]]:
    """Reconstruct Anthropic-compatible messages from the DB.

    Defensive: a DB blip returns an empty history so the chat
    stream treats the session as fresh — better than a 500 mid-
    conversation. The outer ``_stream_chat`` try/except already
    surfaces any ``Exception`` (not just DB errors) as an
    ``error`` SSE event, but returning ``[]`` here means the
    in-memory transcript still starts cleanly."""
    try:
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
    except Exception as exc:
        logger.warning(
            "ai_insights: _load_history failed for session=%s: %s",
            session_id, redact_all(str(exc)),
        )
        return []
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
# OpenRouter + tool loop (model_router-driven)
# ============================================================================

def _is_enabled() -> bool:
    settings = get_settings()
    return (
        bool(settings.openrouter_api_key)
        and bool(getattr(settings, "ai_insights_enabled", True))
        and bool(getattr(settings, "ai_agent_enabled", True))
    )


async def _stream_chat(
    org_id: str,
    user_id: str,
    session_id: str,
    user_message: str,
    *,
    user_role: str = "member",
    is_new_session: bool = False,
) -> AsyncIterator[dict[str, Any]]:
    """Yield SSE events via the unified ChatService (insights compat layer)."""
    from eden.autonomous.insights_compat import stream_insights_chat

    if not _is_enabled():
        yield {
            "type": "error",
            "message": (
                "AI assistant is not configured. Set OPENROUTER_API_KEY "
                "and ensure ai_agent_enabled is true."
            ),
        }
        return

    async for ev in stream_insights_chat(
        org_id=org_id,
        user_id=user_id,
        session_id=session_id,
        user_message=user_message,
        user_role=user_role,
        is_new_session=is_new_session,
    ):
        yield ev


def _summarize_tool_result(name: str, result: dict[str, Any]) -> str:
    """One-line summary of a tool result, for the in-memory transcript.

    Long result payloads are truncated so the next model call
    doesn't see the raw JSON dump. The full result is still in
    the DB via the persisted ``tool`` message.
    """
    if result.get("status") == "error":
        return f"TOOL ({name}) error: {result.get('output', '')[:200]}"
    output = result.get("output")
    if isinstance(output, list):
        return f"TOOL ({name}) ok: {len(output)} rows"
    if isinstance(output, dict):
        return f"TOOL ({name}) ok: keys={list(output.keys())[:5]}"
    return f"TOOL ({name}) ok: {str(output)[:200]}"


# ============================================================================
# Endpoints
# ============================================================================

@router.post("/chat")
async def chat(
    org_id: str,
    body: ChatRequest,
    org: dict = Depends(require_org_member),
    user: dict = Depends(get_current_user),
):
    """Stream a chat turn as Server-Sent Events.

    The first message of a new session also writes an audit-log
    entry so the org's compliance view can see AI usage.
    """
    user_id = user["user_id"]
    from eden.api.routes.ai_agent import _resolve_user_role

    user_role = await _resolve_user_role(org_id, user_id)

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
        async for ev in _stream_chat(
            org_id=org_id,
            user_id=user_id,
            session_id=session_id,
            user_message=body.message,
            user_role=user_role,
            is_new_session=is_new,
        ):
            yield {"event": ev.get("type", "message"), "data": json.dumps(ev, default=str)}

    return EventSourceResponse(event_generator())


@router.get("/sessions")
async def list_sessions(
    org_id: str,
    org: dict = Depends(require_org_member),
    user: dict = Depends(get_current_user),
    limit: int = 50,
):
    """List the current user's chat sessions (newest first, archived last).

    Defensive: a DB blip or missing table must not 500 the chat
    sidebar — the user would lose their conversation list for
    reasons the route can't control. Return an empty list so the
    UI renders "no sessions yet" instead of a red error. July
    2026 site-wide fix.
    """
    limit = max(1, min(int(limit), 200))
    user_id = user["user_id"]
    try:
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
    except Exception as exc:
        logger.warning(
            "ai_insights: list_sessions failed for user=%s org=%s: %s",
            user_id, org_id, redact_all(str(exc)),
        )
        return {"sessions": []}
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
    user: dict = Depends(get_current_user),
):
    """Replay all messages in a session (for sidebar rehydration).

    Defensive: a DB blip on the messages fetch returns an empty
    transcript rather than 500ing the sidebar rehydrate. The
    session row itself still has to exist (per the
    ``_load_session`` check above) — without it we have no way
    to title the conversation and we 404 instead. July 2026
    site-wide hardening (companion to the list_sessions
    try/except)."""
    user_id = user["user_id"]
    existing = await _load_session(org_id, user_id, session_id)
    if not existing:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Session not found",
        )
    try:
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
    except Exception as exc:
        logger.warning(
            "ai_insights: list_messages failed for user=%s org=%s session=%s: %s",
            user_id, org_id, session_id, redact_all(str(exc)),
        )
        rows = []
    if not rows:
        from eden.autonomous.insights_compat import list_messages_from_conversation

        compat = await list_messages_from_conversation(session_id)
        if compat:
            return {
                "session_id": session_id,
                "title": existing["title"],
                "messages": [
                    {
                        "message_id": f"compat_{i}",
                        "role": m["role"],
                        "content": m["content"],
                        "created_at": m.get("created_at"),
                    }
                    for i, m in enumerate(compat)
                ],
            }
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
    user: dict = Depends(get_current_user),
):
    """Soft-delete a session (sets ``archived_at``).

    Defensive: a DB blip on the UPDATE returns 503 with the
    project's standard error envelope rather than 500. The
    session-row check before is already defensive via
    ``_load_session``. July 2026 site-wide hardening."""
    user_id = user["user_id"]
    existing = await _load_session(org_id, user_id, session_id)
    if not existing:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Session not found",
        )
    try:
        client = await get_postgres_client()
        await client.execute(
            "UPDATE ai_insights_chat_sessions SET archived_at = NOW() WHERE session_id = $1",
            session_id,
        )
    except Exception as exc:
        logger.warning(
            "ai_insights: archive_session failed for user=%s org=%s session=%s: %s",
            user_id, org_id, session_id, redact_all(str(exc)),
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Chat archive temporarily unavailable",
        ) from exc
    return {"session_id": session_id, "archived": True}


@router.get("/health")
async def health(
    org_id: str,
    org: dict = Depends(require_org_member),
    user: dict = Depends(get_current_user),
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
