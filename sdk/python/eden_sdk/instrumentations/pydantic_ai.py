"""Auto-instrumentation for Pydantic AI agents.

Patches :class:`pydantic_ai.Agent` ``run`` / ``run_sync`` so every agent
invocation emits an ``agent.run`` framework event with
``source_format: pydantic-ai``.
"""

from __future__ import annotations

import functools
import logging
import time
import uuid
from typing import Any

from eden_sdk._instrumentation_ids import _trace_id_or_random
from eden_sdk.client import TraceEvent, get_default_client
from eden_sdk.config import get_config
from eden_sdk.trace import current_trace

logger = logging.getLogger("eden_sdk.instrumentation.pydantic_ai")

_installed = False
_original_run: Any | None = None
_original_run_sync: Any | None = None


def _short(value: Any, limit: int = 400) -> str | None:
    if value is None:
        return None
    text = str(value)
    return text if len(text) <= limit else text[: limit - 3] + "..."


def _emit(
    *,
    name: str,
    duration_ms: float,
    outcome: str,
    attributes: dict[str, Any],
    error: str | None = None,
) -> None:
    cfg = get_config()
    if not cfg.enabled:
        return
    if error:
        attributes["pydantic_ai.error"] = error
    payload: dict[str, Any] = {
        "event_id": f"eden_pai_{uuid.uuid4().hex[:16]}",
        "trace_id": _trace_id_or_random(),
        "name": name,
        "event_type": "agent.run",
        "agent_id": name,
        "outcome": outcome,
        "duration_ms": duration_ms,
        "attributes": attributes,
        "tags": ["pydantic-ai", "framework"],
        "source_format": "pydantic-ai",
    }
    get_default_client().enqueue(TraceEvent(payload=payload, source_format="pydantic-ai"))


def _agent_name(agent: Any) -> str:
    for attr in ("name", "_name"):
        val = getattr(agent, attr, None)
        if val:
            return str(val)
    model = getattr(agent, "model", None)
    if model is not None:
        return f"pydantic-ai:{model}"
    return "pydantic-ai-agent"


def _result_attrs(result: Any) -> dict[str, Any]:
    attrs: dict[str, Any] = {"pydantic_ai.framework": "pydantic-ai"}
    if result is None:
        return attrs
    output = getattr(result, "output", None)
    if output is not None:
        attrs["pydantic_ai.output"] = _short(output)
    data = getattr(result, "data", None)
    if data is not None:
        attrs["pydantic_ai.data"] = _short(data)
    usage = getattr(result, "usage", None)
    if usage is not None:
        attrs["pydantic_ai.usage"] = _short(usage)
    return attrs


def _wrap_run(original):  # type: ignore[no-untyped-def]
    @functools.wraps(original)
    async def wrapper(self, *args, **kwargs):  # type: ignore[no-untyped-def]
        cfg = get_config()
        if not cfg.enabled:
            return await original(self, *args, **kwargs)
        name = _agent_name(self)
        t0 = time.perf_counter()
        try:
            result = await original(self, *args, **kwargs)
            _emit(
                name=name,
                duration_ms=(time.perf_counter() - t0) * 1000.0,
                outcome="success",
                attributes={
                    **_result_attrs(result),
                    "pydantic_ai.prompt": _short(args[0] if args else kwargs.get("user_prompt")),
                },
            )
            return result
        except Exception as exc:  # noqa: BLE001
            _emit(
                name=name,
                duration_ms=(time.perf_counter() - t0) * 1000.0,
                outcome="error",
                attributes={"pydantic_ai.framework": "pydantic-ai"},
                error=repr(exc),
            )
            raise

    return wrapper


def _wrap_run_sync(original):  # type: ignore[no-untyped-def]
    @functools.wraps(original)
    def wrapper(self, *args, **kwargs):  # type: ignore[no-untyped-def]
        cfg = get_config()
        if not cfg.enabled:
            return original(self, *args, **kwargs)
        name = _agent_name(self)
        t0 = time.perf_counter()
        try:
            result = original(self, *args, **kwargs)
            _emit(
                name=name,
                duration_ms=(time.perf_counter() - t0) * 1000.0,
                outcome="success",
                attributes={
                    **_result_attrs(result),
                    "pydantic_ai.prompt": _short(args[0] if args else kwargs.get("user_prompt")),
                },
            )
            return result
        except Exception as exc:  # noqa: BLE001
            _emit(
                name=name,
                duration_ms=(time.perf_counter() - t0) * 1000.0,
                outcome="error",
                attributes={"pydantic_ai.framework": "pydantic-ai"},
                error=repr(exc),
            )
            raise

    return wrapper


def install() -> None:
    """Patch Pydantic AI ``Agent.run`` / ``run_sync`` in place."""
    global _installed, _original_run, _original_run_sync
    if _installed:
        return
    try:
        from pydantic_ai import Agent
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(f"pydantic-ai not importable: {exc}") from exc

    if _original_run is None:
        _original_run = Agent.run
        Agent.run = _wrap_run(_original_run)
    if hasattr(Agent, "run_sync") and _original_run_sync is None:
        _original_run_sync = Agent.run_sync
        Agent.run_sync = _wrap_run_sync(_original_run_sync)
    _installed = True
    logger.debug("eden: pydantic_ai Agent.run patched")


def uninstall() -> None:
    """Reverse the patches."""
    global _installed, _original_run, _original_run_sync
    if not _installed:
        return
    try:
        from pydantic_ai import Agent
    except Exception:  # noqa: BLE001
        _installed = False
        _original_run = None
        _original_run_sync = None
        return
    if _original_run is not None:
        Agent.run = _original_run
    if _original_run_sync is not None and hasattr(Agent, "run_sync"):
        Agent.run_sync = _original_run_sync
    _installed = False
    _original_run = None
    _original_run_sync = None
