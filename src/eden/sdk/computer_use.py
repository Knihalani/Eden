"""Computer Use SDK — D.12.3 (§8.3).

Lightweight wrappers for the 6 Computer Use action types
(per spec §B.6): ``click``, ``type``, ``scroll``, ``drag``,
``key``, ``wait``. Two surfaces:

* :func:`record_step` — async helper. Persists a single step
  to ``computer_use_steps`` via
  :class:`ComputerUseService.record_step`. Best-effort.
* :class:`ComputerUseAction` — pure dataclass. The caller
  builds the action locally; ``record_step`` persists.

Ponytail: zero new dependencies. The official
``claude-computer-use`` + ``openai-operator`` SDKs already
emit the per-step state machine the spec calls for; this
SDK is the persistence + blocked-step hook surface that
those libraries call into. The customer wires their
``on_step`` callback to call :func:`record_step` from
``eden.sdk.computer_use``.

Usage::

    from eden.sdk.computer_use import record_step

    await record_step(
        org_id="org-1",
        trace_id=tid, span_id=sid,
        step_index=0,
        action_type="click",
        action_payload={"x": 120, "y": 340, "button": "left"},
        screenshot_before="s3://eden-bronze/cu/org-1/before.png",
        screenshot_after="s3://eden-bronze/cu/org-1/after.png",
        target_app="chrome",
        success=True,
        duration_ms=320,
    )
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)


@dataclass
class ComputerUseAction:
    """A single Computer Use step's action (before persistence).

    The 6 action types per spec §B.6. Each has a small set of
    well-known fields; the full payload is preserved in
    ``action_payload`` (JSONB).
    """
    action_type: str
    action_payload: dict[str, Any] = field(default_factory=dict)
    target_app: str | None = None
    target_coords: dict[str, Any] | None = None
    success: bool | None = None
    error: str | None = None
    duration_ms: int | None = None

    def to_payload(self) -> dict[str, Any]:
        return {
            "action_type": self.action_type,
            "action_payload": self.action_payload,
            "target_app": self.target_app,
            "target_coords": self.target_coords,
            "success": self.success,
            "error": self.error,
            "duration_ms": self.duration_ms,
        }


# ── The 6 spec-defined convenience constructors ─────────────────────


def click(
    *,
    x: int,
    y: int,
    button: str = "left",
    target_app: str | None = None,
) -> ComputerUseAction:
    """Mouse click at (x, y)."""
    return ComputerUseAction(
        action_type="click",
        action_payload={"x": int(x), "y": int(y), "button": button},
        target_app=target_app,
        target_coords={"x": int(x), "y": int(y)},
    )


def type_text(
    *,
    text: str,
    target_app: str | None = None,
) -> ComputerUseAction:
    """Type a text string (no coords)."""
    return ComputerUseAction(
        action_type="type",
        action_payload={"text": text},
        target_app=target_app,
    )


def scroll(
    *,
    dx: int = 0,
    dy: int = 0,
    target_app: str | None = None,
) -> ComputerUseAction:
    """Scroll by (dx, dy) pixels."""
    return ComputerUseAction(
        action_type="scroll",
        action_payload={"dx": int(dx), "dy": int(dy)},
        target_app=target_app,
    )


def drag(
    *,
    x_from: int,
    y_from: int,
    x_to: int,
    y_to: int,
    target_app: str | None = None,
) -> ComputerUseAction:
    """Drag from (x_from, y_from) to (x_to, y_to)."""
    return ComputerUseAction(
        action_type="drag",
        action_payload={
            "x_from": int(x_from), "y_from": int(y_from),
            "x_to": int(x_to), "y_to": int(y_to),
        },
        target_app=target_app,
        target_coords={
            "x": int(x_to), "y": int(y_to),
            "width": int(x_to - x_from), "height": int(y_to - y_from),
        },
    )


def key(
    *,
    key: str,
    modifiers: list[str] | None = None,
    target_app: str | None = None,
) -> ComputerUseAction:
    """Press a key (with optional modifiers)."""
    return ComputerUseAction(
        action_type="key",
        action_payload={"key": key, "modifiers": modifiers or []},
        target_app=target_app,
    )


def wait(
    *,
    ms: int,
    target_app: str | None = None,
) -> ComputerUseAction:
    """Pause for ``ms`` milliseconds."""
    return ComputerUseAction(
        action_type="wait",
        action_payload={"ms": int(ms)},
        target_app=target_app,
        duration_ms=int(ms),
    )


# ── Persistence helper ───────────────────────────────────────────────


async def record_step(
    org_id: str,
    *,
    trace_id: str,
    span_id: str,
    step_index: int,
    action: ComputerUseAction | None = None,
    # Or the raw fields directly:
    action_type: str | None = None,
    action_payload: dict[str, Any] | None = None,
    screenshot_before: str | None = None,
    screenshot_after: str | None = None,
    target_app: str | None = None,
    target_coords: dict[str, Any] | None = None,
    success: bool | None = None,
    error: str | None = None,
    duration_ms: int | None = None,
    blocked: bool = False,
) -> str | None:
    """Persist a Computer Use step. Best-effort.

    Accepts either an :class:`ComputerUseAction` instance
    (the typical use) or the raw fields directly. The
    service does the SQL + fires ``on_computer_use_blocked``
    if ``blocked=True``.
    """
    if action is not None:
        action_type = action.action_type
        action_payload = action.action_payload
        target_app = action.target_app
        target_coords = action.target_coords
        success = action.success
        error = action.error
        duration_ms = action.duration_ms
    if action_type is None:
        raise ValueError("action_type is required (or pass action=...)")
    try:
        from eden.services.observability import get_computer_use_service
        svc = get_computer_use_service()
        return await svc.record_step(
            org_id,
            trace_id=trace_id,
            span_id=span_id,
            step_index=int(step_index),
            action_type=action_type,
            action_payload=action_payload or {},
            screenshot_before=screenshot_before,
            screenshot_after=screenshot_after,
            target_app=target_app,
            target_coords=target_coords,
            success=success,
            error=error,
            duration_ms=duration_ms,
            blocked=blocked,
        )
    except Exception as exc:
        logger.debug("cu.record_step SDK: %s", exc)
        return None


__all__ = [
    "ComputerUseAction",
    "click",
    "drag",
    "key",
    "record_step",
    "scroll",
    "type_text",
    "wait",
]