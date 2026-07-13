"""N15 eval-to-live guardrail gateway filter."""

from __future__ import annotations

import logging
import re
from typing import Any

logger = logging.getLogger(__name__)


class GuardrailBlocked(Exception):
    """Raised when a live guardrail blocks a gateway request."""

    def __init__(self, verdict: dict[str, Any]) -> None:
        self.verdict = verdict
        super().__init__(verdict.get("summary") or "guardrail blocked")


class GuardrailGatewayFilter:
    """Run promoted judge-link guardrails on live gateway requests."""

    name = "judge_guardrail"

    def __init__(self) -> None:
        self._policies: dict[str, list[dict[str, Any]]] = {}

    def load_policies(self, org_id: str, policies: list[dict[str, Any]]) -> None:
        self._policies[org_id] = policies

    def unload_org(self, org_id: str) -> None:
        self._policies.pop(org_id, None)

    def enabled(self, request: Any) -> bool:
        org_id = str(getattr(request, "org_id", None) or request.tenant_id or "")
        return bool(self._policies.get(org_id))

    def apply(self, request: Any) -> tuple[Any, list[str]]:
        org_id = str(getattr(request, "org_id", None) or request.tenant_id or "")
        policies = self._policies.get(org_id) or []
        prompt = request.prompt or ""
        findings: list[str] = []

        for policy in policies[:3]:
            pattern = policy.get("pattern")
            enforcement = policy.get("enforcement_level") or "log"
            judge_id = policy.get("judge_id") or policy.get("id")

            breached = False
            if pattern:
                breached = bool(re.search(pattern, prompt, re.IGNORECASE))
            elif policy.get("keyword"):
                breached = policy["keyword"].lower() in prompt.lower()

            if not breached:
                continue

            summary = f"guardrail_breach:{judge_id}"
            if enforcement == "block":
                raise GuardrailBlocked(
                    {"judge_id": judge_id, "summary": summary, "enforcement": "block"}
                )
            if enforcement == "warn":
                request.prompt = f"[Guardrail warning: {summary}]\n{prompt}"
                findings.append(f"guardrail_warn:{judge_id}")
            else:
                findings.append(f"guardrail_log:{judge_id}")

        return request, findings


# Module-level singleton for hot-reload from EvalToGuardrailLink.
_guardrail_filter = GuardrailGatewayFilter()


def get_guardrail_filter() -> GuardrailGatewayFilter:
    return _guardrail_filter
