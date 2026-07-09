"""Auto-instrumentation for CrewAI.

CrewAI uses a step-callback system: every agent step, tool call, and
task completion fires a registered callback. We add a single
``step_callback`` and ``task_callback`` to the crew that emits a
framework event for each.

The CrewAI API surface moves frequently; we use a defensive install
that survives missing attributes.
"""

from __future__ import annotations

import logging
import uuid
from typing import Any

from eden_sdk.client import TraceEvent, get_default_client
from eden_sdk.config import get_config
from eden_sdk.trace import current_trace

logger = logging.getLogger("eden_sdk.instrumentation.crewai")

_installed = False
_original_step_callback: Any | None = None
_original_task_callback: Any | None = None


def _emit(kind: str, name: str, payload: dict[str, Any] | None = None,
          error: str | None = None) -> None:
    cfg = get_config()
    if not cfg.enabled:
        return
    event: dict[str, Any] = {
        "event_id": f"eden_crew_{uuid.uuid4().hex[:16]}",
        "trace_id": _trace_id_or_random(),
        "name": name,
        "event_type": "framework.callback",
        "agent_id": name,
        "outcome": "error" if error else "success",
        "attributes": {
            "crewai.kind": kind,
            **({f"crewai.payload.{k}": _short(v) for k, v in (payload or {}).items()}),
        },
        "tags": ["crewai", "framework"],
        "source_format": "framework",
    }
    if error:
        event["attributes"]["crewai.error"] = error
    get_default_client().enqueue(
        TraceEvent(payload=event, source_format="framework")
    )


def _step_callback(step_output: Any) -> Any:
    try:
        _emit(
            kind="step",
            name=getattr(step_output, "agent", "agent"),
            payload={
                "thought": _short(getattr(step_output, "thought", None), 200),
                "tool": getattr(step_output, "tool", None),
                "result": _short(getattr(step_output, "result", None), 200),
            },
        )
    except Exception:  # noqa: BLE001
        pass
    return step_output


def _task_callback(task_output: Any) -> Any:
    try:
        _emit(
            kind="task",
            name=getattr(task_output, "name", "task"),
            payload={
                "raw": _short(getattr(task_output, "raw", None), 400),
                "agent": getattr(task_output, "agent", None),
            },
        )
    except Exception:  # noqa: BLE001
        pass
    return task_output


def install() -> None:
    """Patch CrewAI ``Crew.__init__`` defaults to register our callbacks.

    The simpler approach (recommended by the CrewAI docs) is to pass
    ``step_callback`` and ``task_callback`` to a specific ``Crew`` at
    construction time. We additionally monkey-patch the constructor to
    default those to our handlers when the user doesn't supply their own.
    """
    global _installed, _original_step_callback, _original_task_callback
    if _installed:
        return
    try:
        from crewai import Crew  # type: ignore
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(f"crewai not importable: {exc}") from exc

    _original_step_callback = _step_callback  # noqa: F841 (kept for future use)
    _original_task_callback = _task_callback  # noqa: F841 (kept for future use)
    original_init = Crew.__init__

    def patched_init(self, *args: Any, **kwargs: Any) -> None:
        # Don't override if the user supplied their own.
        kwargs.setdefault("step_callback", _step_callback)
        kwargs.setdefault("task_callback", _task_callback)
        return original_init(self, *args, **kwargs)

    Crew.__init__ = patched_init  # type: ignore[assignment]
    _installed = True
    # Cache the original init so uninstall() can restore it.
    _original_crew_init = original_init
    logger.debug("eden: crewai Crew.__init__ patched")


_original_crew_init: Any | None = None


def uninstall() -> None:
    """Reverse the install: restore the original ``Crew.__init__``.

    Idempotent: calling twice is a no-op.
    """
    global _installed, _original_crew_init
    if not _installed:
        return
    try:
        from crewai import Crew  # type: ignore
    except Exception:  # noqa: BLE001
        _installed = False
        _original_crew_init = None
        return
    if _original_crew_init is not None:
        Crew.__init__ = _original_crew_init  # type: ignore[assignment]
    _installed = False
    _original_crew_init = None


def _short(value: Any, max_len: int = 256) -> str:
    try:
        s = repr(value)
    except Exception:  # noqa: BLE001
        s = f"<unrepr {type(value).__name__}>"
    if len(s) > max_len:
        s = s[: max_len - 1] + "…"
    return s


def _trace_id_or_random() -> str:
    """Return the active trace id, or a fresh random one.

    Centralised so callers don't have to handle the Optional
    return type of :func:`current_trace` (mypy-friendly).
    """
    ctx = current_trace()
    return ctx.trace_id if ctx is not None else uuid.uuid4().hex
