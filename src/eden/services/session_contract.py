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
    "optional_help_fields": {
        "outcome": "helped | not_helped | unknown — never copied from success",
        "source": "person | product; missing or agent rejects outcome",
        "slack.channel": "optional Path B pointer",
        "slack.ts": "optional Path B pointer; required with channel",
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



HELP_OUTCOMES = ("helped", "not_helped", "unknown")
HELP_SOURCES = ("person", "product")


def accepted_outcome(outcome: Any, source: Any) -> str | None:
    """Return outcome if legal. source missing or agent -> reject outcome."""
    if source in (None, "", "agent"):
        return None
    if str(source) not in HELP_SOURCES:
        return None
    if outcome not in HELP_OUTCOMES:
        return None
    return str(outcome)


def pointer_from_payload(payload: dict[str, Any]) -> tuple[str | None, str | None]:
    """Optional slack.channel + slack.ts. Missing ts -> no Path B join."""
    slack = payload.get("slack")
    if not isinstance(slack, dict):
        channel = payload.get("slack_channel") or payload.get("channel")
        ts = payload.get("slack_ts") or payload.get("ts")
    else:
        channel = slack.get("channel")
        ts = slack.get("ts")
    channel_s = str(channel).strip() if channel else ""
    ts_s = str(ts).strip() if ts else ""
    if not channel_s or not ts_s:
        return None, None
    return channel_s, ts_s


__all__ = ["CONTRACT_VERSION", "SESSION_CONTRACT", "accepted_outcome", "pointer_from_payload", "validate_session_payload"]
