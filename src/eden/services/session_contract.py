"""D12 — agent session contract (F23 + long-agent semantics)."""

from __future__ import annotations

from typing import Any

CONTRACT_VERSION = "eden-agent-session-v1"

SESSION_CONTRACT: dict[str, Any] = {
    "version": CONTRACT_VERSION,
    "description": (
        "Multi-turn agent session unit for detection, debugging, and regression. "
        "One session groups N traces; unsuccessful completion emits task_failure stumble."
    ),
    "required_sdk_calls": [
        "eden.session.begin(agent_id=..., user_id=...)",
        "session.trace('turn_name') per agent run",
        "session.complete(success=..., failure_reason=...) on exit",
    ],
    "required_span_attributes": {
        "agent_session_id": "UUID linking trace to session",
        "agent_id": "optional agent identifier",
        "user_id": "optional end-user identifier",
    },
    "api_endpoints": {
        "start": "POST /orgs/{org_id}/agent-sessions/start",
        "end": "POST /orgs/{org_id}/agent-sessions/{session_id}/end",
        "attach_trace": "POST /orgs/{org_id}/agent-sessions/{session_id}/traces",
        "identify": "POST /orgs/{org_id}/agent-sessions/{session_id}/identify",
    },
    "failure_semantics": {
        "success_false": "Emits task_failure stumble for F20 detection",
        "trace_ids": "Ordered turn list for N12 timeline UI",
    },
    "debugger_link": {
        "fixture_export": "POST /orgs/{org_id}/agent-issues/{id}/export-fixture",
        "regression_memory": "POST /orgs/{org_id}/agent-issues/{id}/regression-cases",
        "debug_sessions": "POST /orgs/{org_id}/debugger/sessions",
    },
}


def validate_session_payload(payload: dict[str, Any]) -> list[str]:
    """Return validation errors for a session start/end payload."""
    errors: list[str] = []
    if payload.get("phase") == "end":
        if "success" not in payload:
            errors.append("missing success on end")
    else:
        if not payload.get("session_id") and not payload.get("agent_id"):
            errors.append("session_id or agent_id required")
    return errors


__all__ = ["CONTRACT_VERSION", "SESSION_CONTRACT", "validate_session_payload"]
