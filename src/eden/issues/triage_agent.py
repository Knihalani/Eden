"""TriageAgent — StatGate-first issue triage (F30 / N08).

Facade over the existing :class:`InvestigationAgent` (reuse, not a
parallel ReAct engine):

1. Load the issue + its top-5 example stumbles.
2. **StatGate-first**: run the deterministic
   :class:`StatGateIncidentScorer`. If a P0 signal fires, write a
   deterministic ``triage_result`` (``source="statgate"``, sub-200ms, no
   LLM) and return immediately.
3. Otherwise, respect the daily triage budget (N22 pre-cursor), then
   delegate to ``InvestigationAgent.investigate(trigger="issue:<id>")``
   and map the findings into the ``triage_result`` JSONB.

Results are persisted to ``agent_issues.triage_result`` and returned in
the standard envelope shape.
"""

from __future__ import annotations

import logging
from datetime import UTC, date, datetime
from typing import Any

from eden.issues.repo import IssuesRepo
from eden.issues.statgate_scorer import StatGateIncidentScorer

logger = logging.getLogger(__name__)

# Rough per-triage LLM cost estimate ($) used to debit the daily budget
# when the provider does not report an exact cost.
_TRIAGE_COST_ESTIMATE_USD = 0.02


class TriageAgent:
    def __init__(
        self,
        repo: IssuesRepo | None = None,
        scorer: StatGateIncidentScorer | None = None,
    ) -> None:
        self._repo = repo or IssuesRepo()
        self._scorer = scorer or StatGateIncidentScorer()

    async def triage(
        self, org_id: str, issue_id: str, *, force: bool = False
    ) -> dict[str, Any]:
        issue = await self._repo.get_issue(org_id, issue_id)
        if issue is None:
            return _envelope(
                "triage",
                {"issue_id": issue_id, "message": "issue not found"},
                status="not_found",
            )

        # Return cached triage unless forced.
        if issue.triage_result and not force:
            return _envelope(
                "triage",
                {
                    "issue_id": issue_id,
                    "triage_result": issue.triage_result,
                    "cached": True,
                },
            )

        stumbles = await self._repo.list_stumbles(
            org_id, fingerprint=issue.fingerprint, limit=5
        )
        issue_row = _issue_to_row(issue)

        # ── 1. StatGate-first (deterministic, no LLM) ──
        score = self._scorer.score(issue_row, stumbles)
        if score.auto_escalate:
            triage_result = {
                "root_cause": self._statgate_root_cause(score, issue),
                "confidence": 0.95,
                "source": "statgate",
                "auto_escalate": True,
                "p0_checks": score.p0_checks,
                "suggested_actions": _statgate_actions(score),
                "evidence_span_ids": [
                    s.get("span_id") for s in stumbles if s.get("span_id")
                ],
                "triaged_at": datetime.now(UTC).isoformat(),
            }
            await self._repo.set_triage_result(org_id, issue_id, triage_result)
            return _envelope(
                "triage",
                {"issue_id": issue_id, "triage_result": triage_result},
            )

        # ── 2. Budget gate before spending an LLM call (N22 pre-cursor) ──
        if not await self._budget_ok(org_id):
            triage_result = {
                "root_cause": "deferred — daily triage budget exhausted",
                "confidence": 0.0,
                "source": "budget_exceeded",
                "suggested_actions": [],
                "evidence_span_ids": [],
                "triaged_at": datetime.now(UTC).isoformat(),
            }
            await self._repo.set_triage_result(org_id, issue_id, triage_result)
            return _envelope(
                "triage",
                {"issue_id": issue_id, "triage_result": triage_result},
                status="budget_exceeded",
            )

        # ── 3. LLM triage via InvestigationAgent (issue: trigger) ──
        try:
            from eden.autonomous import InvestigationAgent

            inv = await InvestigationAgent().investigate(
                org_id, trigger=f"issue:{issue_id}"
            )
        except Exception as exc:
            logger.warning("triage_agent: investigate failed: %s", exc)
            inv = {}

        data = (inv or {}).get("data", {}) if isinstance(inv, dict) else {}
        findings = data.get("findings") or []
        remediations = data.get("proposed_remediations") or []
        llm_used = bool(data.get("llm_used"))

        triage_result = {
            "root_cause": _first_summary(findings)
            or "no detailed root cause identified",
            "confidence": _max_confidence(findings),
            "source": "llm" if llm_used else "heuristic",
            "auto_escalate": False,
            "p0_checks": [],
            "suggested_actions": _map_remediations(remediations),
            "evidence_span_ids": [],
            "investigation_id": data.get("investigation_id"),
            "triaged_at": datetime.now(UTC).isoformat(),
        }
        await self._repo.set_triage_result(org_id, issue_id, triage_result)
        if llm_used:
            await self._debit_budget(org_id, _TRIAGE_COST_ESTIMATE_USD)
        return _envelope(
            "triage", {"issue_id": issue_id, "triage_result": triage_result}
        )

    # ── budget helpers (N22 pre-cursor; formalised in Wave 5) ──

    def _budget_key(self, org_id: str) -> str:
        return f"triage_spend:{org_id}:{date.today().isoformat()}"

    async def _budget_ok(self, org_id: str) -> bool:
        try:
            from eden.config import get_settings

            cap = float(getattr(get_settings(), "max_triage_cost_usd_per_day", 25.0))
        except Exception:
            cap = 25.0
        if cap <= 0:
            return True
        try:
            from eden.storage.redis import get_redis_client

            redis = await get_redis_client()
            if redis is None:
                return True
            spent = await redis.get(self._budget_key(org_id))
            return float(spent or 0.0) < cap
        except Exception:  # pragma: no cover - redis optional
            return True

    async def _debit_budget(self, org_id: str, amount: float) -> None:
        try:
            from eden.storage.redis import get_redis_client

            redis = await get_redis_client()
            if redis is None:
                return
            key = self._budget_key(org_id)
            new_val = await redis.incrbyfloat(key, amount)
            # Expire at ~36h so the counter resets daily.
            if float(new_val) <= amount + 1e-9:
                await redis.expire(key, 129_600)
        except Exception:  # pragma: no cover - redis optional
            pass

    @staticmethod
    def _statgate_root_cause(score: Any, issue: Any) -> str:
        checks = ", ".join(score.p0_checks) or "p0"
        return f"Deterministic P0 escalation ({checks}) for {issue.kind} issue"


def _statgate_actions(score: Any) -> list[dict[str, Any]]:
    actions: list[dict[str, Any]] = []
    if score.suggested_heal:
        actions.append(
            {
                "type": score.suggested_heal,
                "action_type": score.suggested_heal,
                "summary": f"Auto-suggested heal: {score.suggested_heal}",
                "auto": True,
            }
        )
    return actions


def _map_remediations(remediations: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for r in remediations:
        if not isinstance(r, dict):
            continue
        action = r.get("action") or r.get("action_type") or "review"
        out.append(
            {
                "type": action,
                "action_type": action,
                "summary": r.get("summary") or r.get("description") or str(action),
                "blast_radius": r.get("blast_radius"),
            }
        )
    return out


def _first_summary(findings: list[dict[str, Any]]) -> str | None:
    for f in findings:
        if isinstance(f, dict) and f.get("summary"):
            return str(f["summary"])
    return None


def _max_confidence(findings: list[dict[str, Any]]) -> float:
    best = 0.0
    for f in findings:
        if isinstance(f, dict):
            try:
                best = max(best, float(f.get("confidence", 0.0)))
            except (TypeError, ValueError):
                continue
    return best or 0.5


def _issue_to_row(issue: Any) -> dict[str, Any]:
    return {
        "id": issue.id,
        "org_id": issue.org_id,
        "fingerprint": issue.fingerprint,
        "kind": issue.kind,
        "severity": issue.severity,
        "title": issue.title,
        "stumble_count": issue.stumble_count,
        "user_count": issue.user_count,
        "triage_result": issue.triage_result,
    }


def _envelope(
    feature: str, data: dict[str, Any], *, status: str = "ok"
) -> dict[str, Any]:
    return {
        "status": status,
        "feature": feature,
        "live": True,
        "timestamp": datetime.now(UTC).isoformat(),
        "data": data,
    }
