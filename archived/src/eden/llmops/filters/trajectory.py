"""D2 — inline trajectory intervention as a GatewayFilter.

Runs the same O(1) hot-path checks as
:func:`evaluate_trajectory_step` synchronously on live gateway
requests (no DB await on the filter path).
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)


class TrajectoryInterventionGatewayFilter:
    """Run hot-path trajectory checks on gateway requests."""

    name = "trajectory_intervention"

    def __init__(self, *, enabled_by_default: bool = True) -> None:
        self._enabled = enabled_by_default

    def enabled(self, request: Any) -> bool:
        if not self._enabled:
            return False
        org_id = getattr(request, "org_id", None) or getattr(
            request, "tenant_id", None
        )
        trace_id = getattr(request, "trace_id", None)
        return bool(org_id and trace_id)

    def apply(self, request: Any) -> tuple[Any, list[str]]:
        from eden.observability.trace_quality.hooks import (
            _ENHANCED_HOT_PATH_CHECKS,
            ACTION_CLASS_DEFAULTS,
            _reduce_recommended,
        )

        event = {
            "cost_usd": getattr(request, "cost_usd", 0.0),
            "usage_total_tokens": getattr(request, "usage_total_tokens", 0),
            "loop_verdict": getattr(request, "loop_verdict", "OK"),
            "loop_severity": getattr(request, "loop_severity", "low"),
            "tool_repeat_count": getattr(request, "tool_repeat_count", 0),
            "recent_failure_count": getattr(request, "recent_failure_count", 0),
            "latency_z": getattr(request, "latency_z", 0.0),
            "finish_reason": getattr(request, "finish_reason", None),
            "schema_missing": getattr(request, "schema_missing", False),
        }

        checks = [chk(event) for chk in _ENHANCED_HOT_PATH_CHECKS]
        action = _reduce_recommended(checks)
        applied = ACTION_CLASS_DEFAULTS.get(action, False)
        if action == "record_to_table":
            applied = True

        findings: list[str] = []
        if applied and action not in ("record_to_table", "emit_audit_event"):
            findings.append(f"trajectory:{action}")
            if action == "truncate_context" and hasattr(request, "prompt"):
                request.prompt = (request.prompt or "")[:4000]
            if action == "coalesce_step":
                meta = getattr(request, "metadata", None)
                if isinstance(meta, dict):
                    meta["coalesce_step"] = True
                elif meta is None:
                    request.metadata = {"coalesce_step": True}
        return request, findings


_filter = TrajectoryInterventionGatewayFilter()


def get_trajectory_filter() -> TrajectoryInterventionGatewayFilter:
    return _filter


__all__ = ["TrajectoryInterventionGatewayFilter", "get_trajectory_filter"]
