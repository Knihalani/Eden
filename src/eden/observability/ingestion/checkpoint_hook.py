"""F03 — Persist debugger checkpoints from LLM telemetry events.

Best-effort hook: never raises into the ingest hot path. Writes
``debugger.checkpoint`` rows via :class:`CheckpointStore` so F48
debugger list/rerun has production steps to load.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)

_LLM_EVENT_TYPES = frozenset({
    "llm.completion",
    "llm_completion",
    "llm_completion_stream",
    "openai.chat_completion",
    "anthropic.message",
    "bedrock.invoke_model",
    "gemini.generate_content",
    "otel.llm_completion",
    "helicone.request",
    "langfuse.observation",
})


def is_llm_event(event_type: str | None) -> bool:
    if not event_type:
        return False
    et = event_type.lower()
    if et in _LLM_EVENT_TYPES:
        return True
    if "llm" in et and ("completion" in et or "chat" in et or "message" in et):
        return True
    return False


def extract_llm_payload(payload: dict[str, Any] | None) -> dict[str, Any]:
    """Normalize common LLM payload shapes into checkpoint fields."""
    p = payload or {}
    messages = (
        p.get("input_messages")
        or p.get("messages")
        or (p.get("request") or {}).get("messages")
        or []
    )
    if not isinstance(messages, list):
        messages = []
    tool_calls = p.get("tool_calls") or []
    if not isinstance(tool_calls, list):
        tool_calls = []
    tool_results = p.get("tool_results") or []
    if not isinstance(tool_results, list):
        tool_results = []
    response = p.get("response") or p.get("output") or {}
    if not isinstance(response, dict):
        response = {"content": response}
    step = p.get("step_number")
    try:
        step_number = int(step) if step is not None else None
    except (TypeError, ValueError):
        step_number = None
    return {
        "input_messages": messages,
        "tool_calls": tool_calls,
        "tool_results": tool_results,
        "response": response,
        "step_number": step_number,
        "started_at": str(p.get("started_at") or ""),
        "ended_at": str(p.get("ended_at") or ""),
        "duration_ms": float(p.get("duration_ms") or 0.0),
    }


async def maybe_persist_checkpoint(event: Any, *, pg: Any | None = None) -> bool:
    """If ``event`` is an LLM completion, persist a debugger checkpoint.

    Returns True when a checkpoint was written.
    """
    try:
        event_type = getattr(event, "event_type", None) or ""
        if not is_llm_event(str(event_type)):
            return False
        trace_id = getattr(event, "trace_id", None) or ""
        if not trace_id:
            return False
        tenant_id = getattr(event, "tenant_id", None) or "default"
        payload = getattr(event, "payload", None) or {}
        if not isinstance(payload, dict):
            payload = {}
        fields = extract_llm_payload(payload)
        step_number = fields["step_number"]
        if step_number is None:
            # Fall back to sequence / span ordinal when SDK omits step.
            seq = getattr(event, "sequence", None)
            try:
                step_number = int(seq) if seq is not None else 0
            except (TypeError, ValueError):
                step_number = 0

        from eden.debugger.checkpoints import Checkpoint, CheckpointStore

        if pg is None:
            from eden.storage.postgres import get_postgres_client

            pg = await get_postgres_client()

        store = CheckpointStore(pg)
        import uuid

        cp = Checkpoint(
            id=str(uuid.uuid4()),
            trace_id=str(trace_id),
            step_number=int(step_number),
            input_messages=list(fields["input_messages"]),
            tool_calls=list(fields["tool_calls"]),
            tool_results=list(fields["tool_results"]),
            response=dict(fields["response"]),
            started_at=fields["started_at"],
            ended_at=fields["ended_at"],
            duration_ms=float(fields["duration_ms"]),
            source="live",
        )
        await store.save(cp, org_id=str(tenant_id))
        return True
    except Exception as exc:  # noqa: BLE001 — never break ingest
        logger.debug("checkpoint_hook: skip persist: %s", exc)
        return False
