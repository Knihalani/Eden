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


# ── Leftover-work SHIP / BLOCK / INCONCLUSIVE rail (P2.1) ───────────
#
# Not a 9th detector. Does not run on trace.finalized as a help trigger.
# Input is extra-work rate vs control on the same mapped channel/queue.
# Issue-rate quiet, quieter Slack, thumbs-up, and a clean trace are
# ignored (they cannot SHIP).

LEFTOVER_MIN_N = 20
UNKNOWN_SHARE_CEILING = 0.5

SHIP = "SHIP"
BLOCK = "BLOCK"
INCONCLUSIVE = "INCONCLUSIVE"


def leftover_work_verdict(
    *,
    n_control: int,
    n_treatment: int,
    extra_work_rate_control: float,
    extra_work_rate_treatment: float,
    unknown_share: float,
    listen_silent: bool = False,
    mapped_channel: bool = True,
    min_n: int = LEFTOVER_MIN_N,
    unknown_share_ceiling: float = UNKNOWN_SHARE_CEILING,
    **_ignored: Any,
) -> tuple[str, dict[str, Any]]:
    """The only SHIP check: leftover extra-work rate vs control.

    ``_ignored`` absorbs activity proxies (issue_rate_quiet, slack_quieter,
    thumbs_up, clean_trace, eval_score_up, traces_flowing). They never
    produce SHIP.
    """
    detail: dict[str, Any] = {
        "extra_work_rate_control": extra_work_rate_control,
        "extra_work_rate_treatment": extra_work_rate_treatment,
        "n_control": int(n_control),
        "n_treatment": int(n_treatment),
        "unknown_share": unknown_share,
        "listen_silent": bool(listen_silent),
        "mapped_channel": bool(mapped_channel),
        "min_n": int(min_n),
        "unknown_share_ceiling": float(unknown_share_ceiling),
    }
    if listen_silent or not mapped_channel:
        detail["reason"] = "listen_silent"
        detail["verdict"] = INCONCLUSIVE
        return INCONCLUSIVE, detail
    if int(n_control) < int(min_n) or int(n_treatment) < int(min_n):
        detail["reason"] = "thin_n"
        detail["verdict"] = INCONCLUSIVE
        return INCONCLUSIVE, detail
    if float(unknown_share) >= float(unknown_share_ceiling):
        detail["reason"] = "unknown_share"
        detail["verdict"] = INCONCLUSIVE
        return INCONCLUSIVE, detail
    if extra_work_rate_treatment < extra_work_rate_control:
        detail["reason"] = "extra_work_fell"
        detail["verdict"] = SHIP
        return SHIP, detail
    if extra_work_rate_treatment > extra_work_rate_control:
        detail["reason"] = "extra_work_worse"
        detail["verdict"] = BLOCK
        return BLOCK, detail
    detail["reason"] = "extra_work_unchanged"
    detail["verdict"] = INCONCLUSIVE
    return INCONCLUSIVE, detail


def leftover_rates(
    *,
    extra_work_control: int,
    extra_work_treatment: int,
    n_control: int,
    n_treatment: int,
    unknown_n: int = 0,
) -> dict[str, float | int]:
    """Product-rule rates. Slack message volume is not a denominator."""
    nc = max(int(n_control), 0)
    nt = max(int(n_treatment), 0)
    unk = max(int(unknown_n), 0)
    total = nc + nt + unk
    return {
        "n_control": nc,
        "n_treatment": nt,
        "extra_work_rate_control": int(extra_work_control) / max(nc, 1),
        "extra_work_rate_treatment": int(extra_work_treatment) / max(nt, 1),
        "unknown_share": unk / max(total, 1),
    }


__all__ = [
    "BLOCK",
    "INCONCLUSIVE",
    "LEFTOVER_MIN_N",
    "SHIP",
    "UNKNOWN_SHARE_CEILING",
    "apply_statgate_p0_rail",
    "collect_issue_ids_from_scan",
    "leftover_rates",
    "leftover_work_verdict",
]
