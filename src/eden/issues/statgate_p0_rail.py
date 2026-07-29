"""D1 — StatGate P0 rail on trace.finalized before LLM triage.

Runs deterministic :class:`StatGateIncidentScorer` scoring immediately
after issue promotion so the closed-loop orchestrator can skip an LLM
call when P0 signals are already conclusive (<200ms target).
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Any

from eden.issues.repo import IssuesRepo
from eden.issues.statgate_scorer import StatGateIncidentScorer
from eden.issues.triage_agent import TriageAgent, _statgate_actions

logger = logging.getLogger(__name__)


async def apply_statgate_p0_rail(
    org_id: str, issue_ids: set[str]
) -> list[str]:
    """Score issues and persist StatGate triage when P0 fires.

    Returns issue ids that received a deterministic triage_result.
    """
    if not issue_ids:
        return []

    repo = IssuesRepo()
    scorer = StatGateIncidentScorer()
    escalated: list[str] = []

    for issue_id in issue_ids:
        try:
            issue = await repo.get_issue(org_id, issue_id)
            if issue is None:
                continue
            if issue.triage_result and issue.triage_result.get("source") == "statgate":
                continue

            stumbles = await repo.list_stumbles(
                org_id, fingerprint=issue.fingerprint, limit=5
            )
            issue_row = {
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
            score = scorer.score(issue_row, stumbles)
            if not score.auto_escalate:
                continue

            triage_result = {
                "root_cause": TriageAgent._statgate_root_cause(score, issue),
                "confidence": 0.95,
                "source": "statgate",
                "auto_escalate": True,
                "p0_checks": score.p0_checks,
                "suggested_actions": _statgate_actions(score),
                "evidence_span_ids": [
                    s.get("span_id") for s in stumbles if s.get("span_id")
                ],
                "fingerprint": issue.fingerprint,
                "severity_at_triage": issue.severity,
                "triaged_at": datetime.now(UTC).isoformat(),
                "rail": "trace_finalized",
            }
            await repo.set_triage_result(org_id, issue_id, triage_result)
            escalated.append(issue_id)
            logger.info(
                "statgate_p0_rail: org=%s issue=%s checks=%s",
                org_id,
                issue_id,
                score.p0_checks,
            )
        except Exception as exc:
            logger.debug("statgate_p0_rail: issue=%s failed: %s", issue_id, exc)
    return escalated


def collect_issue_ids_from_scan(scan_results: list[dict[str, Any]]) -> set[str]:
    """Extract unique issue ids from AutoIssueScanner scan results."""
    ids: set[str] = set()
    for row in scan_results:
        issue = row.get("issue")
        if issue is None:
            continue
        iid = getattr(issue, "id", None) or (
            issue.get("id") if isinstance(issue, dict) else None
        )
        if iid:
            ids.add(str(iid))
    return ids


__all__ = ["apply_statgate_p0_rail", "collect_issue_ids_from_scan"]
