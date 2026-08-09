"""D3 — closed-loop remediation playbooks for the orchestrator."""

from __future__ import annotations

from typing import Any

# Maps triage issue kinds → preferred remediation playbook.
_KIND_PLAYBOOKS: dict[str, str] = {
    "loop": "nudge_shadow",
    "hallucination": "prompt_canary",
    "tool_error": "nudge_shadow",
    "mcp_auth_failure": "cache_bust",
    "statgate_p0": "rollback",
    "timeout": "reweight",
    "user_frustration": "reweight",
    "task_failure": "rollback",
    "prompt_regression": "prompt_canary",
    "confusion_loop": "nudge_shadow",
}

# Secondary signals in triage_result can override kind defaults.
_SIGNAL_OVERRIDES: list[tuple[str, str]] = [
    ("semantic_cache", "cache_bust"),
    ("canary_regression", "rollback"),
    ("model_drift", "reweight"),
    ("cost_spike", "reweight"),
]


def resolve_playbook(
    issue_kind: str | None,
    triage_result: dict[str, Any] | None,
) -> str | None:
    """Return a heal action_type for the issue, or None if advisory only."""
    triage = triage_result or {}
    for signal, action in _SIGNAL_OVERRIDES:
        tags = triage.get("signals") or triage.get("tags") or []
        if signal in tags or triage.get(signal):
            return action
    sh = triage.get("suggested_heal")
    if isinstance(sh, str) and sh in ("rollback", "reweight", "cache_bust"):
        return sh
    for a in triage.get("suggested_actions") or []:
        if isinstance(a, dict):
            at = a.get("action_type") or a.get("type")
            if at in ("rollback", "reweight", "cache_bust"):
                return at
    if issue_kind and issue_kind in _KIND_PLAYBOOKS:
        return _KIND_PLAYBOOKS[issue_kind]
    return None
