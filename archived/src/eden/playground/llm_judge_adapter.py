"""FEAT-131 — bridge playground/F51 dataset rows to :class:`UnifiedJudge`.

``Judge.score`` expects a :class:`~eden.observability.telemetry_collector.TelemetryEvent`,
not an ``(input, output, expected)`` triple. This module builds a minimal
playground-shaped event and maps the requested axis back into the F49/F51
scorer tuple ``(score, detail)``.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import hashlib
import uuid
from datetime import UTC, datetime
from typing import Any

from eden.llmops.judges.base import JudgeContext, JudgeScore
from eden.llmops.judges.unified import UNIFIED_AXES, UnifiedJudge
from eden.observability.telemetry_collector import TelemetryEvent

_DEFAULT_AXIS = "correctness"
_LLM_UNAVAILABLE = "llm unavailable: configure OPENROUTER_API_KEY"


def dataset_row_to_telemetry_event(
    *,
    output: str,
    input_text: str | None = None,
    expected: str | None = None,
    spec: dict[str, Any] | None = None,
) -> TelemetryEvent:
    """Wrap a dataset/playground row as a :class:`TelemetryEvent` for judges."""
    spec = spec or {}
    task = spec.get("input") or input_text or spec.get("task") or ""
    task = str(task) if not isinstance(task, (dict, list)) else str(task)
    if expected:
        if task:
            task = f"{task}\n\nExpected reference:\n{expected}"
        else:
            task = f"Expected reference:\n{expected}"

    row_key = f"{task}|{output}|{expected or ''}"
    trace_id = hashlib.sha256(row_key.encode("utf-8")).hexdigest()[:32]

    return TelemetryEvent(
        event_id=f"pg_{uuid.uuid4().hex[:16]}",
        tenant_id=str(spec.get("tenant_id") or "playground"),
        project_id=str(spec.get("project_id") or "playground"),
        trace_id=trace_id,
        realm="environment",
        event_type="openai.chat.completion",
        timestamp=datetime.now(UTC).isoformat(),
        payload={
            "openai": {"response_text": output},
            "task": task,
            "playground": True,
        },
        tags=["playground", "llm_judge"],
        source_format="eden_native",
    )


def resolve_llm_judge_axis(spec: dict[str, Any]) -> str:
    return str(spec.get("axis") or _DEFAULT_AXIS).strip()


def llm_client_available() -> bool:
    """Return True when an OpenRouter-backed client can be constructed."""
    try:
        from eden.config import get_settings

        api_key = (get_settings().openrouter_api_key or "").strip()
        return bool(api_key)
    except Exception:
        return False


def try_get_llm_client() -> Any | None:
    if not llm_client_available():
        return None
    try:
        from eden.llm.client import OpenRouterClient

        return OpenRouterClient()
    except Exception:
        return None


def _pick_axis_score(
    scores: list[JudgeScore], axis: str
) -> tuple[float | None, str | None, JudgeScore | None]:
    by_name = {s.judge_name: s for s in scores}
    picked = by_name.get(axis)
    if picked is None:
        return None, f"judge returned no axis {axis!r}", None

    rationale = picked.rationale or ""
    if rationale.startswith("no_score:"):
        reason = rationale.split("no_score:", 1)[-1]
        if "no llm_client" in reason:
            return None, _LLM_UNAVAILABLE, picked
        return None, f"judge error: {reason}", picked

    detail = f"{axis}: {rationale[:200]}" if rationale else axis
    return picked.score, detail, picked


async def score_llm_judge_async(
    output: str,
    expected: str | None,
    spec: dict[str, Any],
    *,
    input_text: str | None = None,
    judge: UnifiedJudge | None = None,
    llm_client: Any | None = None,
    persist: bool = False,
) -> tuple[float | None, str | None, list[JudgeScore]]:
    """Score one playground row via :class:`UnifiedJudge`."""
    if not (output or "").strip():
        return None, "empty output", []

    axis = resolve_llm_judge_axis(spec)
    if axis not in UNIFIED_AXES:
        return None, f"unknown judge axis: {axis}", []

    client = llm_client if llm_client is not None else try_get_llm_client()
    if client is None:
        return None, _LLM_UNAVAILABLE, []

    event = dataset_row_to_telemetry_event(
        output=output,
        input_text=input_text,
        expected=expected,
        spec=spec,
    )
    j = judge or UnifiedJudge()
    ctx = JudgeContext(event=event, llm_client=client, trace_id=event.trace_id)
    scores = await j.score(event, ctx)
    score, detail, _ = _pick_axis_score(scores, axis)

    if persist and score is not None:
        from eden.llmops.judges.runner import JudgeRunner

        runner = JudgeRunner(llm_client=client)
        for row in scores:
            await runner._persist(row)

    return score, detail, scores


def _run_sync_coro(coro: Any) -> Any:
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro)
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        return pool.submit(asyncio.run, coro).result()


def score_llm_judge_sync(
    output: str,
    expected: str | None,
    spec: dict[str, Any],
    *,
    input_text: str | None = None,
    judge: UnifiedJudge | None = None,
    llm_client: Any | None = None,
) -> tuple[float | None, str | None]:
    """Sync entrypoint for :func:`eden.playground.scorers.run_scorers`."""
    score, detail, _ = _run_sync_coro(
        score_llm_judge_async(
            output,
            expected,
            spec,
            input_text=input_text,
            judge=judge,
            llm_client=llm_client,
            persist=False,
        )
    )
    return score, detail


__all__ = [
    "dataset_row_to_telemetry_event",
    "llm_client_available",
    "resolve_llm_judge_axis",
    "score_llm_judge_async",
    "score_llm_judge_sync",
    "try_get_llm_client",
]
