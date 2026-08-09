"""D3/D8 — 22-category remediation playbook router.

Fuses issue kind, triage root_cause, StatGate checks, and stumble
signals into a deterministic playbook + suggested_actions list for
:class:`ClosedLoopOrchestrator` and :class:`TriageAgent`.

FEAT-44: remediation ``category`` is orthogonal to notification routing.
Shared severity/destination types live in ``eden.alerting.types`` and
``eden.alerts.unified`` for when per-category paging is added.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

# 22 remediation playbooks (AUTONOMOUS-MAINTENANCE §3 + trace-quality cats).
PLAYBOOK_CATEGORIES: tuple[str, ...] = (
    "statgate_p0",
    "deploy_regression",
    "cache_poison",
    "routing_drift",
    "code_bug",
    "mcp_auth_failure",
    "etec_loop",
    "cost_spike",
    "tool_error",
    "hallucination",
    "user_frustration",
    "confusion_loop",
    "high_cost",
    "slow_trace",
    "task_failure",
    "prompt_regression",
    "behavioral_drift",
    "fleet_slo_breach",
    "delegation_failure",
    "semantic_cache_drift",
    "guardrail_breach",
    "unknown",
)

_PLAYBOOK_ACTIONS: dict[str, tuple[str, str]] = {
    "statgate_p0": ("rollback", "StatGate P0 — rollback deploy"),
    "deploy_regression": ("rollback", "Post-deploy regression — rollback"),
    "cache_poison": ("cache_bust", "Semantic cache poison — bust cache"),
    "semantic_cache_drift": ("cache_bust", "Cache drift — bust + verify"),
    "routing_drift": ("reweight", "Model routing drift — reweight"),
    "code_bug": ("propose_patch", "Code defect — propose patch"),
    "mcp_auth_failure": ("escalate", "MCP auth failure — isolate server"),
    "etec_loop": ("rollback", "ETEC loop P0 — rollback or coalesce"),
    "cost_spike": ("reweight", "Cost spike — reweight routing"),
    "high_cost": ("reweight", "High cost trace — reweight"),
    "tool_error": ("cache_bust", "Tool error burst — cache bust"),
    "hallucination": ("propose_patch", "Hallucination — prompt fix"),
    "user_frustration": ("escalate", "User frustration — human review"),
    "confusion_loop": ("rollback", "Confusion loop — rollback prompt"),
    "slow_trace": ("recommend", "Slow trace — observe"),
    "task_failure": ("propose_patch", "Task failure — fix agent"),
    "prompt_regression": ("rollback", "Prompt regression — rollback"),
    "behavioral_drift": ("recommend", "Behavioral drift — eval slice"),
    "fleet_slo_breach": (
        "escalate",
        "Fleet SLO breach — notify for human review",
    ),
    "delegation_failure": ("escalate", "Delegation trust failure — review"),
    "guardrail_breach": ("escalate", "Guardrail breach — review policy"),
    "unknown": ("escalate", "No playbook match — human triage"),
}


@dataclass(slots=True)
class PlaybookDecision:
    category: str
    action_type: str
    summary: str
    auto_heal: bool = False

    def to_action(self) -> dict[str, Any]:
        return {
            "type": self.action_type,
            "action_type": self.action_type,
            "summary": self.summary,
            "playbook": self.category,
            "auto": self.auto_heal,
        }


def route_playbook(
    *,
    issue_kind: str | None = None,
    root_cause: str | None = None,
    p0_checks: list[str] | None = None,
    stumble_kinds: list[str] | None = None,
    triage_result: dict[str, Any] | None = None,
) -> PlaybookDecision:
    """Map signals → one of 22 playbooks."""
    tr = triage_result or {}
    kind = (issue_kind or tr.get("issue_kind") or "").lower()
    rc = (root_cause or tr.get("root_cause") or "").lower()
    checks = [c.lower() for c in (p0_checks or tr.get("p0_checks") or [])]
    stumbles = [s.lower() for s in (stumble_kinds or [])]

    category = _classify(kind, rc, checks, stumbles)
    action_type, summary = _PLAYBOOK_ACTIONS.get(
        category, _PLAYBOOK_ACTIONS["unknown"]
    )
    auto_heal = category in (
        "cache_poison",
        "semantic_cache_drift",
        "statgate_p0",
        "deploy_regression",
        "routing_drift",
        "cost_spike",
        "etec_loop",
    ) and action_type in ("rollback", "reweight", "cache_bust")
    return PlaybookDecision(
        category=category,
        action_type=action_type,
        summary=summary,
        auto_heal=auto_heal,
    )


def enrich_triage_with_playbook(triage_result: dict[str, Any]) -> dict[str, Any]:
    """Attach playbook metadata + merge suggested_actions when missing."""
    out = dict(triage_result)
    decision = route_playbook(
        root_cause=out.get("root_cause"),
        p0_checks=out.get("p0_checks"),
        triage_result=out,
    )
    out["playbook"] = decision.category
    if not out.get("suggested_actions"):
        out["suggested_actions"] = [decision.to_action()]
    else:
        first = out["suggested_actions"][0]
        if isinstance(first, dict) and not first.get("playbook"):
            first = dict(first)
            first["playbook"] = decision.category
            out["suggested_actions"] = [first] + list(out["suggested_actions"][1:])
    return out


def _classify(
    kind: str, root_cause: str, checks: list[str], stumbles: list[str]
) -> str:
    text = f"{kind} {root_cause} {' '.join(checks)} {' '.join(stumbles)}"

    if "cache_poison" in text or "cache poison" in text or "stale cache" in text:
        return "cache_poison"
    if "semantic_cache" in text or "cache drift" in text or "cache-hit-cascade" in text:
        return "semantic_cache_drift"
    if "statgate_p0" in checks or "statgate_regression" in checks:
        return "statgate_p0"
    if "deploy" in text and ("regression" in text or "rollback" in text):
        return "deploy_regression"
    if "mcp_auth" in text or "mcp auth" in text:
        return "mcp_auth_failure"
    if "etec_loop" in checks or kind == "loop" or "loop" in kind:
        return "etec_loop"
    if "cost_spike" in checks or kind == "high_cost":
        return "cost_spike" if "cost_spike" in checks else "high_cost"
    if "routing" in text and "drift" in text:
        return "routing_drift"
    if kind == "tool_error" or "tool_error" in stumbles:
        return "tool_error"
    if kind == "hallucination":
        return "hallucination"
    if kind == "user_frustration":
        return "user_frustration"
    if kind == "confusion_loop":
        return "confusion_loop"
    if kind == "slow_trace":
        return "slow_trace"
    if kind == "task_failure":
        return "task_failure"
    if "prompt" in text and "regression" in text:
        return "prompt_regression"
    if "drift" in text:
        return "behavioral_drift"
    if "fleet" in text and "slo" in text:
        return "fleet_slo_breach"
    if "delegation" in text or "a2a" in text:
        return "delegation_failure"
    if "guardrail" in text:
        return "guardrail_breach"
    if "code" in text and ("bug" in text or "defect" in text):
        return "code_bug"
    if kind in PLAYBOOK_CATEGORIES:
        return kind
    return "unknown"


__all__ = [
    "PLAYBOOK_CATEGORIES",
    "PlaybookDecision",
    "enrich_triage_with_playbook",
    "route_playbook",
]
