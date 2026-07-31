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

from eden.api.deps import get_current_user, log_audit_event, require_path_org_access
from eden.api.utils.rate_limit import RateLimitExceeded, SlidingWindowRateLimiter
from eden.api.utils.redact import redact_all
from eden.config import get_settings
from eden.llmops.insights_tools import list_tools
from eden.storage.postgres import get_postgres_client

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/orgs/{org_id}/ai-insights",
    tags=["ai-insights"],
    dependencies=[Depends(require_path_org_access)],
)

# W23: ChatSidebar rate limit — 30 turns / minute / org+user (soft Loop parity).
_chat_rate_limiter = SlidingWindowRateLimiter(max_requests=30, window_seconds=60.0)


# ============================================================================
# Schemas
# ============================================================================


class PageContext(BaseModel):
    """Optional UI context so answers cite the view the user is on (W21 rich)."""

    pathname: str | None = Field(
        None,
        description="Current portal pathname, e.g. /traces or /issues/abc.",
        max_length=512,
    )
    search: str | None = Field(
        None,
        description="Current URL search string including leading ?.",
        max_length=2048,
    )
    resource: str | None = Field(
        None,
        description="Top-level resource segment (traces, issues, …).",
        max_length=64,
    )
    trace_id: str | None = Field(
        None,
        description="Optional trace_id from the URL or selected row.",
        max_length=128,
    )
    issue_id: str | None = Field(
        None,
        description="Optional issue id from path or query.",
        max_length=128,
    )
    session_id: str | None = Field(
        None,
        description="Optional session id from path or query.",
        max_length=128,
    )
    alert_id: str | None = Field(
        None,
        description="Optional alert id from query.",
        max_length=128,
    )
    artifact_id: str | None = Field(
        None,
        description="Optional artifact id from query.",
        max_length=128,
    )
    q: str | None = Field(
        None,
        description="Active U08 list filter string (?q=).",
        max_length=1024,
    )
    selected_id: str | None = Field(
        None,
        description="Primary selected entity id on the page.",
        max_length=128,
    )
    filters: dict[str, Any] | None = Field(
        None,
        description="Optional UI filters (agent_id, outcome, since, …).",
    )


class ChatRequest(BaseModel):
    """Body for POST /chat."""

    message: str = Field(..., min_length=1, max_length=8000)
    session_id: str | None = Field(
        None,
        description=("Existing session to append to. Omit (or null) to start a " "fresh session."),
    )
    page_context: PageContext | None = Field(
        None,
        description="Portal page context (pathname, optional trace_id).",
    )
    preferred_model: str | None = Field(
        None,
        max_length=128,
        description="Operator model picker id (or 'auto').",
    )
    preferred_tier: str | None = Field(
        None,
        max_length=16,
        description="t1 | t2 | t3 | auto — T1/SLM vs T3 routing hint.",
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
You are Eden's AI Insights assistant for Capture → Analyse → Improve.

Capture: traces, spans, live agent runs.
Analyse: latency, cost, judge/eval scores, anomalies.
Improve: agent issues, proposed patches / PR inbox.

Answer style:
- Lead with the answer (1-2 sentences). Then numbers. Never padding.
- Cite trace_ids / issue_ids / patch_ids / timestamps verbatim.
- Prefer aggregate tools (get_insights, get_cost_breakdown) over \
dumping rows on open-ended questions.
- Include deep links from tool output (traces_url / issues_url) when \
citing an id.
- Never invent data. Surface tool errors plainly.
- Use page_context (pathname / trace_id / q / resource / selected_id) \
when present — do not ask for an id the UI already provides.
- To change the UI: call navigate, propose_filter, find_similar, or \
open_trace / open_issue / open_session / open_alert / open_artifact \
(these return client_action payloads the portal executes).
- Cite-before-claim: emit ```cite blocks before naming concrete \
trace/span/issue ids in prose.
- Dataset / experiment / playground writes \
(create_dataset, promote_trace_to_dataset, create_experiment, \
create_playground, playground_from_span) are approval-gated — call \
them to preview; the operator Confirm card executes.
- Call estimate_chat_cost before long multi-tool or export runs.

If the user asks for something outside your tools, say so. Don't \
guess. Point them at /traces, /issues, /closed-loop, or \
/observability/query (EQL) as appropriate.

Available tools (call one by emitting the JSON block below):
{tool_block}

When you need data: emit EXACTLY ONE tool call block, fenced with \
``tool_call`` markers, like this:

```tool_call
{{"name": "list_traces", "args": {{"limit": 5, "outcome": "failure"}}}}
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
            content = " ".join(b.get("text", "") for b in content if b.get("type") == "text")
        # Truncate each message to keep the prompt tight. 800
        # chars per turn is plenty for the model to know what
        # was said.
        if len(content) > 800:
            content = content[:797] + "..."
        prefix = "USER" if role == "user" else "ASSISTANT" if role == "assistant" else "TOOL"
        lines.append(f"{prefix}: {content}")
    return "\n".join(lines)


# ============================================================================
# Persistence helpers
# ============================================================================


async def _resolve_user_role(org_id: str, user_id: str) -> str:
    """Look up the caller's role inside ``org_id``.

    Returns one of: ``"owner"``, ``"admin"``, ``"member"``, ``"viewer"``.
    Defaults to ``"member"`` if the role can't be resolved.
    """
    try:
        client = await get_postgres_client()
        if client is None:
            return "member"
        row = await client.fetchrow(
            """
            SELECT m.role
            FROM org_members m
            WHERE m.org_id = $1 AND m.user_id = $2
            """,
            org_id,
            user_id,
        )
        if row:
            return str(row["role"])
    except Exception as exc:
        logger.debug("role lookup failed: %s", redact_all(str(exc)))
    return "member"


async def _load_session(org_id: str, user_id: str, session_id: str) -> dict[str, Any] | None:
    """Fetch a single chat session from ``ai_conversations``, scoped to (org, user)."""
    try:
        client = await get_postgres_client()
        return await client.fetchrow(
            """
            SELECT id AS session_id, org_id, user_id, title, archived_at, created_at, updated_at
            FROM ai_conversations
            WHERE id = $1 AND org_id = $2 AND user_id = $3
            """,
            session_id,
            org_id,
            user_id,
        )
    except Exception as exc:
        logger.warning(
            "ai_insights: _load_session failed for user=%s org=%s session=%s: %s",
            user_id,
            org_id,
            session_id,
            redact_all(str(exc)),
        )
        return None


async def _create_session(org_id: str, user_id: str, title: str) -> str:
    """Insert a new ``ai_conversations`` row and return its uuid.

    The same UUID is passed into ChatService so messages land on
    this row (no dual-table id drift).
    """
    session_id = str(uuid.uuid4())
    client = await get_postgres_client()
    if client is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Chat storage temporarily unavailable",
        )
    await client.execute(
        """
        INSERT INTO ai_conversations (id, org_id, user_id, title, page_context)
        VALUES ($1::uuid, $2, $3, $4, '{}'::jsonb)
        """,
        session_id,
        org_id,
        user_id,
        title,
    )
    return session_id


async def _append_message(session_id: str, role: str, content: list[dict[str, Any]]) -> None:
    """Legacy helper retained for callers; chat path uses ChatService."""
    try:
        client = await get_postgres_client()
        text = ""
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                text += str(block.get("text") or "")
        await client.execute(
            """
            INSERT INTO ai_messages (conversation_id, role, content)
            VALUES ($1::uuid, $2, $3)
            """,
            session_id,
            role,
            text,
        )
    except Exception as exc:
        logger.warning(
            "ai_insights: _append_message failed for session=%s role=%s: %s",
            session_id,
            role,
            redact_all(str(exc)),
        )


async def _touch_session(session_id: str, title: str | None = None) -> None:
    """Bump ``updated_at`` (and optionally ``title``) on a conversation."""
    try:
        client = await get_postgres_client()
        if title:
            await client.execute(
                """
                UPDATE ai_conversations
                SET updated_at = NOW(), title = $2
                WHERE id = $1
                """,
                session_id,
                title,
            )
        else:
            await client.execute(
                "UPDATE ai_conversations SET updated_at = NOW() WHERE id = $1",
                session_id,
            )
    except Exception as exc:
        logger.warning(
            "ai_insights: _touch_session failed for session=%s: %s",
            session_id,
            redact_all(str(exc)),
        )


async def _load_history(session_id: str) -> list[dict[str, Any]]:
    """Reconstruct messages from ``ai_messages`` for legacy callers."""
    from eden.autonomous.insights_compat import list_messages_from_conversation

    return await list_messages_from_conversation(session_id)


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
    page_context: dict[str, Any] | None = None,
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
        page_context=page_context,
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
    body: ChatRequest,
    org_id: str = Depends(require_path_org_access),
    user: dict = Depends(get_current_user),
):
    """Stream a chat turn as Server-Sent Events.

    The first message of a new session also writes an audit-log
    entry so the org's compliance view can see AI usage.
    """
    user_id = user["user_id"]
    user_role = await _resolve_user_role(org_id, user_id)

    try:
        await _chat_rate_limiter.check(f"ai-insights:{org_id}:{user_id}")
    except RateLimitExceeded as exc:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"Chat rate limit exceeded. Retry after {int(exc.retry_after)}s.",
            headers={"Retry-After": str(int(exc.retry_after))},
        ) from exc

    # Find or create the session on the unified ``ai_conversations`` store.
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
        try:
            session_id = await _create_session(
                org_id=org_id,
                user_id=user_id,
                title=_derive_title(body.message),
            )
        except HTTPException:
            raise
        except AttributeError as exc:
            # None PG client used to AttributeError on ``.execute`` → 500.
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Chat storage temporarily unavailable",
            ) from exc
        is_new = True
        # First message of a new session: write the audit entry.
        try:
            pg = await get_postgres_client()
            if pg is not None:
                await log_audit_event(
                    client=pg,
                    org_id=org_id,
                    user_id=user_id,
                    action="ai_insights.session.create",
                    target_type="ai_conversation",
                    target_id=session_id,
                    metadata={"title": _derive_title(body.message)},
                )
        except Exception as exc:  # noqa: BLE001 — audit must not block chat
            logger.warning(f"ai_insights: audit log failed (non-fatal): {exc}")

    page_ctx: dict[str, Any] = {"surface": "ai_insights_sidebar"}
    if body.page_context is not None:
        page_ctx.update(
            body.page_context.model_dump(exclude_none=True),
        )
    if body.preferred_model:
        page_ctx["preferred_model"] = body.preferred_model
    if body.preferred_tier:
        page_ctx["preferred_tier"] = body.preferred_tier

    async def event_generator():
        async for ev in _stream_chat(
            org_id=org_id,
            user_id=user_id,
            session_id=session_id,
            user_message=body.message,
            user_role=user_role,
            is_new_session=is_new,
            page_context=page_ctx,
        ):
            yield {"event": ev.get("type", "message"), "data": json.dumps(ev, default=str)}

    return EventSourceResponse(event_generator())


class ApproveRequest(BaseModel):
    """Body for POST /approve — ConfirmationCard write path."""

    tool: str = Field(..., min_length=1, max_length=128)
    args: dict[str, Any] = Field(default_factory=dict)
    session_id: str | None = Field(None, max_length=64)


@router.post("/approve")
async def approve_tool(
    body: ApproveRequest,
    org_id: str = Depends(require_path_org_access),
    user: dict = Depends(get_current_user),
):
    """Execute an approval-gated write tool after operator confirm.

    RBAC is enforced inside ``dispatch_tool``. N06 audit is written
    on success so the compliance pack can see ChatSidebar mutations.
    """
    from eden.autonomous.agent import (
        _APPROVAL_GATED_TOOLS,
        _SPEND_CONFIRM_TOOLS,
        dispatch_tool,
    )

    user_id = user["user_id"]
    user_role = await _resolve_user_role(org_id, user_id)
    allowed = _APPROVAL_GATED_TOOLS | _SPEND_CONFIRM_TOOLS
    if body.tool not in allowed:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Tool {body.tool!r} is not approval-gated",
        )

    tc = await dispatch_tool(
        body.tool,
        body.args or {},
        tenant_id=org_id,
        user_role=user_role,
        execute_approved=True,
    )
    if tc.error:
        status_code = (
            status.HTTP_403_FORBIDDEN
            if "permission_denied" in tc.error
            else status.HTTP_400_BAD_REQUEST
        )
        raise HTTPException(status_code=status_code, detail=tc.error)

    try:
        pg = await get_postgres_client()
        await log_audit_event(
            client=pg,
            org_id=org_id,
            user_id=user_id,
            action=f"ai_insights.tool.approve.{body.tool}",
            target_type="ai_tool",
            target_id=body.session_id or body.tool,
            metadata={"tool": body.tool, "args": body.args or {}},
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("ai_insights: approve audit failed (non-fatal): %s", redact_all(str(exc)))

    return {
        "tool": body.tool,
        "status": "ok",
        "result": tc.result,
        "duration_ms": tc.latency_ms,
    }


@router.get("/sessions")
async def list_sessions(
    org_id: str = Depends(require_path_org_access),
    user: dict = Depends(get_current_user),
    limit: int = 50,
):
    """List the current user's chat sessions (newest first, archived last).

    Missing ``ai_conversations`` soft-empties (Alembic lag). A dead
    Postgres or unresolved Eden user 503s — same contract as portal
    Assistant threads (never paint outage as "no chats").
    """
    limit = max(1, min(int(limit), 200))
    from eden.api.deps import eden_user_id_from_auth

    try:
        user_id = await eden_user_id_from_auth(user)
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "ai_insights: list_sessions user resolve failed: %s",
            redact_all(str(exc)),
        )
        user_id = None
    if not user_id:
        raise HTTPException(
            status_code=503,
            detail="Chat sessions temporarily unavailable; please retry",
            headers={"Retry-After": "5"},
        )

    try:
        client = await get_postgres_client()
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "ai_insights: list_sessions postgres unavailable: %s",
            redact_all(str(exc)),
        )
        client = None
    if client is None:
        raise HTTPException(
            status_code=503,
            detail="Chat sessions temporarily unavailable; please retry",
            headers={"Retry-After": "5"},
        )

    try:
        rows = await client.fetch(
            """
            SELECT id AS session_id, title, created_at, updated_at, archived_at
            FROM ai_conversations
            WHERE org_id::text = $1 AND user_id::text = $2
            ORDER BY (archived_at IS NULL) DESC, updated_at DESC
            LIMIT $3
            """,
            org_id,
            user_id,
            limit,
        )
    except Exception as exc:
        msg = str(exc).lower()
        if "does not exist" in msg or "undefinedtable" in msg or "undefined column" in msg:
            logger.warning(
                "ai_insights: list_sessions store missing for user=%s org=%s: %s",
                user_id,
                org_id,
                redact_all(str(exc)),
            )
            return {"sessions": []}
        logger.warning(
            "ai_insights: list_sessions failed for user=%s org=%s: %s",
            user_id,
            org_id,
            redact_all(str(exc)),
        )
        raise HTTPException(
            status_code=503,
            detail="Chat sessions temporarily unavailable; please retry",
            headers={"Retry-After": "5"},
        ) from exc
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
    session_id: str,
    org_id: str = Depends(require_path_org_access),
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
    from eden.autonomous.insights_compat import list_messages_from_conversation

    compat = await list_messages_from_conversation(session_id)
    return {
        "session_id": session_id,
        "title": existing["title"],
        "messages": [
            {
                "message_id": f"msg_{i}",
                "role": m["role"],
                "content": m["content"],
                "created_at": m.get("created_at"),
            }
            for i, m in enumerate(compat)
        ],
    }


@router.post("/sessions/{session_id}/archive")
async def archive_session(
    session_id: str,
    org_id: str = Depends(require_path_org_access),
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
            "UPDATE ai_conversations SET archived_at = NOW() WHERE id = $1",
            session_id,
        )
    except Exception as exc:
        logger.warning(
            "ai_insights: archive_session failed for user=%s org=%s session=%s: %s",
            user_id,
            org_id,
            session_id,
            redact_all(str(exc)),
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Chat archive temporarily unavailable",
        ) from exc
    return {"session_id": session_id, "archived": True}


@router.get("/health")
async def health(
    org_id: str = Depends(require_path_org_access),
    user: dict = Depends(get_current_user),
):
    """Probe endpoint: returns whether AI Insights is configured."""
    settings = get_settings()
    return {
        "enabled": bool(settings.ai_insights_enabled),
        "model": settings.ai_insights_model,
        "anthropic_key_configured": bool(
            os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN")
        ),
        "tool_count": len(list_tools()),
    }
