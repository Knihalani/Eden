"""Rank, dedupe, and persist improvement plan candidates (N23)."""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

from eden.improvement import plans_repo

logger = logging.getLogger(__name__)

_SEVERITY_SCORE = {
    "critical": 1.0,
    "high": 0.8,
    "medium": 0.5,
    "low": 0.3,
    "info": 0.1,
}

_BLAST_SCORE = {"high": 0.2, "medium": 0.5, "low": 0.8}


@dataclass
class PlanCandidate:
    plan_kind: str
    title: str
    source_ref: str
    source_fingerprint: str
    agent_id: str | None = None
    summary: str | None = None
    diff_unified: str | None = None
    files_changed: list[Any] = field(default_factory=list)
    evidence: dict[str, Any] = field(default_factory=dict)
    triage_snapshot: dict[str, Any] | None = None
    estimated_blast_radius: str = "medium"
    llm_cost_usd: float = 0.0
    severity: str = "medium"
    confidence: float = 0.5

    @property
    def score(self) -> float:
        sev = _SEVERITY_SCORE.get(self.severity.lower(), 0.4)
        blast = _BLAST_SCORE.get(
            (self.estimated_blast_radius or "medium").lower(), 0.5
        )
        return sev * self.confidence * blast


def rank_candidates(candidates: list[PlanCandidate]) -> list[PlanCandidate]:
    """Sort by severity × confidence × inverse blast radius."""
    return sorted(candidates, key=lambda c: c.score, reverse=True)


async def persist_candidates(
    org_id: str,
    candidates: list[PlanCandidate],
    *,
    run_id: str | None = None,
    max_plans: int = 10,
) -> tuple[list[dict[str, Any]], int]:
    """Dedupe, supersede stale drafts, cap at max_plans.

    Returns ``(created_plans, skipped_dedup_count)``.
    """
    ranked = rank_candidates(candidates)
    created: list[dict[str, Any]] = []
    skipped = 0

    for cand in ranked:
        if len(created) >= max_plans:
            break
        if not cand.source_fingerprint:
            skipped += 1
            continue
        existing = await plans_repo.find_open_by_fingerprint(
            org_id, cand.source_fingerprint
        )
        if existing is not None:
            if cand.score > _existing_score(existing):
                await plans_repo.supersede_drafts(
                    org_id, cand.source_fingerprint
                )
            else:
                skipped += 1
                continue

        plan = await plans_repo.create_plan(
            org_id,
            run_id=run_id,
            plan_kind=cand.plan_kind,
            title=cand.title,
            agent_id=cand.agent_id,
            summary=cand.summary,
            source_ref=cand.source_ref,
            source_fingerprint=cand.source_fingerprint,
            diff_unified=cand.diff_unified,
            files_changed=cand.files_changed,
            evidence=cand.evidence,
            triage_snapshot=cand.triage_snapshot,
            estimated_blast_radius=cand.estimated_blast_radius,
            llm_cost_usd=cand.llm_cost_usd,
        )
        if plan:
            created.append(plan)
            await _emit_plan_created(org_id, plan)
        else:
            skipped += 1

    return created, skipped


def _existing_score(plan: dict[str, Any]) -> float:
    evidence = plan.get("evidence") or {}
    sev = _SEVERITY_SCORE.get(str(evidence.get("severity", "medium")).lower(), 0.4)
    conf = float(evidence.get("confidence", 0.5))
    blast = _BLAST_SCORE.get(
        str(plan.get("estimated_blast_radius") or "medium").lower(), 0.5
    )
    return sev * conf * blast


async def _emit_plan_created(org_id: str, plan: dict[str, Any]) -> None:
    try:
        from eden.llmops.hooks_bus import HookEvent, get_hook_bus

        await get_hook_bus().emit(
            HookEvent(
                reason="improvement.plan_created",
                severity="low",
                org_id=org_id,
                source={
                    "primary_entity_id": str(plan.get("id") or ""),
                    "plan_kind": plan.get("plan_kind"),
                },
            )
        )
    except Exception as exc:
        logger.debug("planner: plan_created hook failed: %s", exc)
