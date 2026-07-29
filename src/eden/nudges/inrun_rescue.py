"""In-run rescue — mid-trajectory Artifact inject (max 1/trace)."""

from __future__ import annotations

import logging
from typing import Any

from eden.nudges.engine import NudgeEngine, apply_nudge_to_prompt
from eden.preview.gates import artifacts_inrun_enabled

logger = logging.getLogger(__name__)

_TRACE_RESCUE_COUNT: dict[str, int] = {}


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

        _TRACE_RESCUE_COUNT[trace_id] = _TRACE_RESCUE_COUNT.get(trace_id, 0) + 1
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
