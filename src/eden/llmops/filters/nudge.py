"""F39 runtime nudge gateway filter."""

from __future__ import annotations

import logging
from typing import Any

from eden.nudges.engine import NudgeEngine, apply_nudge_to_prompt

logger = logging.getLogger(__name__)


def _request_context(request: Any) -> dict[str, Any]:
    ctx = getattr(request, "context", None)
    if isinstance(ctx, dict):
        return ctx
    return {
        "org_id": getattr(request, "org_id", None) or request.tenant_id,
        "agent_id": getattr(request, "agent_id", ""),
        "trace_id": getattr(request, "trace_id", request.job_id),
        "prompt": request.prompt,
        "recent_tool_calls": getattr(request, "recent_tool_calls", []),
        "nudges_enabled": getattr(request, "nudges_enabled", True),
    }


class NudgeGatewayFilter:
    """Inject promoted nudges; log shadow matches without mutation."""

    name = "runtime_nudge"

    def __init__(self, engine: NudgeEngine | None = None) -> None:
        self._engine = engine or NudgeEngine()

    def enabled(self, request: Any) -> bool:
        ctx = _request_context(request)
        return bool(ctx.get("nudges_enabled", True))

    def apply(self, request: Any) -> tuple[Any, list[str]]:
        ctx = _request_context(request)
        org_id = str(ctx.get("org_id") or "")
        agent_id = str(ctx.get("agent_id") or "")
        if not org_id or not agent_id:
            return request, []

        matched = self._engine.evaluate_sync(ctx)
        findings: list[str] = []
        audit = getattr(request, "nudge_audit", None)
        if not isinstance(audit, list):
            audit = []
            setattr(request, "nudge_audit", audit)

        for nudge in matched:
            if nudge.mode == "shadow":
                findings.append(f"nudge_shadow:{nudge.id}")
                audit.append({"nudge_id": str(nudge.id), "mode": "shadow", "applied": False})
                continue
            if nudge.mode == "promoted" and nudge.action_type == "system_append":
                request.prompt, meta = apply_nudge_to_prompt(nudge, request.prompt)
                findings.append(meta)
                audit.append({"nudge_id": str(nudge.id), "mode": "promoted", "applied": True})
            else:
                findings.append(f"nudge_promoted:{nudge.id}")
                audit.append({"nudge_id": str(nudge.id), "mode": nudge.mode, "applied": False})

        return request, findings
