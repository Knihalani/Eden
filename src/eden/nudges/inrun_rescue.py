"""In-run rescue — mid-trajectory Artifact inject (max 1/trace)."""

from __future__ import annotations

import logging
from typing import Any

from eden.nudges.engine import NudgeEngine, apply_nudge_to_prompt
from eden.preview.gates import artifacts_inrun_enabled

logger = logging.getLogger(__name__)

#: Rescues already issued, keyed by trace_id.
#:
#: There IS a pop() on the completion path below, but it only runs when
#: a rescued trace reaches that path — a trace that errors, times out or
#: is abandoned never removes its entry. Keyed by trace_id, that is one
#: permanent entry per rescued-and-lost trace, growing without bound
#: until the process is OOM-killed. Every sibling cache in this codebase
#: is capped; this one was not.
#:
#: Latent today: gated on artifacts_inrun_v1, which defaults False.
_TRACE_RESCUE_MAX = 10_000
_TRACE_RESCUE_COUNT: dict[str, int] = {}


def _remember_rescue(trace_id: str) -> None:
    """Record a rescue, evicting oldest-first at the cap.

    dicts preserve insertion order, so popping the front is FIFO. The
    only cost of evicting a live trace is that it could be rescued a
    second time — bounded memory is worth strictly more than that.
    """
    while len(_TRACE_RESCUE_COUNT) >= _TRACE_RESCUE_MAX:
        _TRACE_RESCUE_COUNT.pop(next(iter(_TRACE_RESCUE_COUNT)), None)
    _TRACE_RESCUE_COUNT[trace_id] = _TRACE_RESCUE_COUNT.get(trace_id, 0) + 1


class InRunRescue:
    """Match inrun_rescue Artifacts after loop/tool-error detectors."""

    def __init__(self, engine: NudgeEngine | None = None) -> None:
        self._engine = engine or NudgeEngine()

    async def try_rescue(
        self,
        org_id: str,
        context: dict[str, Any],
        request: Any,
    ) -> tuple[Any, list[str]]:
        if not await artifacts_inrun_enabled(org_id):
            return request, []

        trace_id = str(context.get("trace_id") or "")
        if not trace_id or _TRACE_RESCUE_COUNT.get(trace_id, 0) >= 1:
            return request, []

        matched = self._engine.evaluate_sync(context)
        rescue = [
            n
            for n in matched
            if getattr(n, "action_type", "") == "inrun_rescue"
            or (n.evidence or {}).get("inrun_rescue")
        ]
        if not rescue:
            return request, []

        nudge = rescue[0]
        findings: list[str] = []
        applied = False
        if nudge.mode == "promoted":
            request.prompt, meta = apply_nudge_to_prompt(nudge, request.prompt)
            findings.append(meta)
            applied = True
        else:
            findings.append(f"inrun_rescue_shadow:{nudge.id}")

        _remember_rescue(trace_id)
        await self._engine.log_shadow(
            nudge,
            trace_id=trace_id,
            matched=True,
            applied=applied,
        )
        audit = getattr(request, "nudge_audit", None)
        if isinstance(audit, list):
            audit.append(
                {
                    "nudge_id": str(nudge.id),
                    "mode": nudge.mode,
                    "applied": applied,
                    "inrun_rescue": True,
                }
            )
        return request, findings

    @staticmethod
    def clear_trace(trace_id: str) -> None:
        _TRACE_RESCUE_COUNT.pop(trace_id, None)
