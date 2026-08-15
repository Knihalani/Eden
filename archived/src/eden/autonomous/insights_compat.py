"""Compatibility layer: AI Insights SSE shape → ChatService backend."""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from collections.abc import AsyncIterator
from typing import Any

from eden.autonomous.agent import AgentChunk, get_chat_service

logger = logging.getLogger(__name__)


def _derive_title(message: str) -> str:
    cleaned = " ".join(message.split())
    return cleaned if len(cleaned) <= 50 else cleaned[:47] + "..."


async def stream_insights_chat(
    *,
    org_id: str,
    user_id: str,
    session_id: str,
    user_message: str,
    user_role: str,
    is_new_session: bool,
    page_context: dict[str, Any] | None = None,
) -> AsyncIterator[dict[str, Any]]:
    """Stream ai-insights-compatible SSE events via ChatService."""
    if is_new_session:
        yield {
            "type": "session",
            "session_id": session_id,
            "title": _derive_title(user_message),
        }

    queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()
    tool_seq = 0
    ctx: dict[str, Any] = {"surface": "ai_insights_sidebar"}
    if page_context:
        ctx.update(page_context)

    async def emit(chunk: AgentChunk) -> None:
        nonlocal tool_seq
        if chunk.type == "text_delta" and chunk.text:
            await queue.put({"type": "text_delta", "text": chunk.text})
        elif chunk.type == "tool_call" and chunk.tool_call:
            tool_seq += 1
            tool_id = f"tool_{tool_seq}"
            await queue.put({
                "type": "tool_call",
                "id": tool_id,
                "name": chunk.tool_call.name,
                "input": chunk.tool_call.args,
            })
            if chunk.tool_call.result is not None or chunk.tool_call.error:
                await queue.put({
                    "type": "tool_result",
                    "id": tool_id,
                    "name": chunk.tool_call.name,
                    "status": "error" if chunk.tool_call.error else "ok",
                    "output": chunk.tool_call.result if not chunk.tool_call.error else {
                        "error": chunk.tool_call.error,
                    },
                    "duration_ms": chunk.tool_call.latency_ms,
                })
        elif chunk.type == "chart" and chunk.chart:
            await queue.put({
                "type": "chart",
                "chart": chunk.chart.to_dict(),
            })
        elif chunk.type == "citation" and chunk.citation:
            await queue.put({
                "type": "citation",
                "citation": chunk.citation.to_dict(),
            })
        elif chunk.type == "cost":
            await queue.put({
                "type": "cost",
                "cost_usd": chunk.cost_usd,
                "turn_cost_usd": chunk.turn_cost_usd,
                **(chunk.meta or {}),
            })
        elif chunk.type == "meta":
            await queue.put({"type": "meta", **(chunk.meta or {})})
        elif chunk.type == "error" and chunk.error:
            await queue.put({"type": "error", "message": chunk.error})
        elif chunk.type == "done":
            # Single terminal done is emitted from run_chat with cost/usage.
            return

    async def run_chat() -> None:
        service = get_chat_service()
        try:
            summary = await service.stream_chat(
                tenant_id=org_id,
                user_id=user_id,
                conversation_id=session_id,
                user_message=user_message,
                page_context=ctx,
                user_role=user_role,
                emit=emit,
            )
            await queue.put({
                "type": "done",
                "usage": {
                    "prompt_tokens": summary.get("prompt_tokens", 0),
                    "completion_tokens": summary.get("completion_tokens", 0),
                },
                "stop_reason": "end_turn",
                "conversation_id": summary.get("conversation_id", session_id),
                "cost_usd": summary.get("cost_usd", 0),
                "turn_cost_usd": summary.get("cost_usd", 0),
            })
        except Exception as exc:
            logger.exception("insights_compat stream failed")
            await queue.put({"type": "error", "message": str(exc)})
        finally:
            await queue.put(None)

    task = asyncio.create_task(run_chat())
    try:
        while True:
            ev = await queue.get()
            if ev is None:
                break
            yield ev
    finally:
        await task


async def list_messages_from_conversation(
    conversation_id: str,
) -> list[dict[str, Any]]:
    """Load messages from ``ai_messages`` for sidebar rehydration."""
    from eden.storage.postgres import get_postgres_client

    client = await get_postgres_client()
    if not client:
        return []
    try:
        rows = await client.fetch(
            """
            SELECT role, content, tool_calls, tool_results, chart_specs, citations, created_at
            FROM ai_messages
            WHERE conversation_id = $1
            ORDER BY created_at ASC
            """,
            conversation_id,
        )
    except Exception as exc:
        logger.debug("list_messages_from_conversation failed: %s", exc)
        return []

    out: list[dict[str, Any]] = []
    for row in rows:
        content = row["content"] or ""
        tool_calls = row.get("tool_calls") or []
        tool_results = row.get("tool_results") or []
        chart_specs = row.get("chart_specs") or []
        citations = row.get("citations") or []
        for field_name, raw in (
            ("tool_calls", tool_calls),
            ("tool_results", tool_results),
            ("chart_specs", chart_specs),
            ("citations", citations),
        ):
            if isinstance(raw, str):
                try:
                    parsed = json.loads(raw)
                except json.JSONDecodeError:
                    parsed = []
                if field_name == "tool_calls":
                    tool_calls = parsed
                elif field_name == "tool_results":
                    tool_results = parsed
                elif field_name == "chart_specs":
                    chart_specs = parsed
                else:
                    citations = parsed
        blocks: list[dict[str, Any]] = []
        if content:
            blocks.append({"type": "text", "text": content})
        for tc in tool_calls if isinstance(tool_calls, list) else []:
            if isinstance(tc, dict):
                blocks.append({
                    "type": "tool_use",
                    "id": tc.get("id") or str(uuid.uuid4()),
                    "name": tc.get("name", ""),
                    "input": tc.get("args") or tc.get("input") or {},
                    "result": tc.get("result"),
                })
        for tr in tool_results if isinstance(tool_results, list) else []:
            if isinstance(tr, dict) and tr.get("name"):
                blocks.append({
                    "type": "tool_result",
                    "name": tr.get("name", ""),
                    "output": tr.get("result"),
                    "error": tr.get("error"),
                })
        for chart in chart_specs if isinstance(chart_specs, list) else []:
            if isinstance(chart, dict):
                blocks.append({"type": "chart", "chart": chart})
        for cite in citations if isinstance(citations, list) else []:
            if isinstance(cite, dict):
                blocks.append({"type": "citation", "citation": cite})
        out.append({
            "role": row["role"],
            "content": blocks or [{"type": "text", "text": ""}],
            "created_at": row["created_at"].isoformat() if row.get("created_at") else None,
        })
    return out
