"""Rank, dedupe, and persist improvement plan candidates (N23).

M13 (§6.1): expected-value ranking
``EV = severity_w × confidence × recurrence_rate × user_count_w
      × est_cost_of_issue − est_fix_cost``
(fix cost includes token estimate + KG revert-risk premium).
"""

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

# M13 (§6.1) default weights — overridable via Settings.
_DEFAULT_SEVERITY_W = {
    "critical": 1.0,
    "high": 0.85,
    "medium": 0.55,
    "low": 0.3,
    "info": 0.1,
}
_DEFAULT_USER_COUNT_W = {
    # buckets by affected-user count in evidence
    0: 0.5,
    1: 0.7,
    5: 0.85,
    20: 1.0,
    100: 1.15,
}


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
    # M13 (§6.1) EV inputs — filled by rank_candidates / callers.
    recurrence_rate: float | None = None
    user_count: int | None = None
    est_cost_of_issue: float | None = None
    est_fix_cost: float | None = None
    kg_revert_premium: float = 0.0
    ev_score: float | None = None

    @property
    def score(self) -> float:
        """Legacy score (pre-EV). Prefer ``ev_score`` when ranking under §6.1."""
        if self.ev_score is not None:
            return self.ev_score
        sev = _SEVERITY_SCORE.get(self.severity.lower(), 0.4)
        blast = _BLAST_SCORE.get((self.estimated_blast_radius or "medium").lower(), 0.5)
        stumble = int((self.evidence or {}).get("stumble_count") or 0)
        stumble_boost = 1.0 + min(stumble, 50) / 50.0
        return sev * self.confidence * blast * stumble_boost


def _user_count_weight(user_count: int) -> float:
    w = _DEFAULT_USER_COUNT_W[0]
    for threshold, weight in sorted(_DEFAULT_USER_COUNT_W.items()):
        if user_count >= threshold:
            w = weight
    return w


def _ev_enabled() -> bool:
    try:
        from eden.config import get_settings

        return bool(getattr(get_settings(), "sweep_ev_ranking_v1", True))
    except Exception:
        return True


def compute_ev(
    cand: PlanCandidate,
    *,
    kg_premium: float = 0.0,
) -> float:
    """M13 (§6.1) EV formula. Pure; never raises."""
    evid = cand.evidence or {}
    sev_key = (cand.severity or "medium").lower()
    try:
        from eden.config import get_settings

        settings = get_settings()
        sev_map = getattr(settings, "ev_severity_weights", None) or _DEFAULT_SEVERITY_W
    except Exception:
        sev_map = _DEFAULT_SEVERITY_W
    severity_w = float(sev_map.get(sev_key, 0.4))
    confidence = float(cand.confidence if cand.confidence is not None else 0.5)

    if cand.recurrence_rate is not None:
        recurrence = float(cand.recurrence_rate)
    else:
        stumble = int(evid.get("stumble_count") or 0)
        # Map stumble count → (0, 1] recurrence rate.
        recurrence = min(1.0, 0.2 + stumble / 25.0)

    if cand.user_count is not None:
        user_n = int(cand.user_count)
    else:
        user_n = int(evid.get("user_count") or evid.get("affected_users") or 1)
    user_w = _user_count_weight(max(0, user_n))

    if cand.est_cost_of_issue is not None:
        issue_cost = float(cand.est_cost_of_issue)
    else:
        # Default: severity-scaled proxy dollars.
        issue_cost = float(evid.get("est_cost_of_issue") or (severity_w * 10.0))

    token_est = float(cand.llm_cost_usd or evid.get("est_token_cost") or 0.05)
    premium = float(kg_premium if kg_premium else cand.kg_revert_premium or 0.0)
    if cand.est_fix_cost is not None:
        fix_cost = float(cand.est_fix_cost)
    else:
        fix_cost = token_est + premium

    return severity_w * confidence * recurrence * user_w * issue_cost - fix_cost


def rank_candidates(
    candidates: list[PlanCandidate],
    *,
    kg_premiums: dict[str, float] | None = None,
) -> list[PlanCandidate]:
    """Sort by EV (§6.1) when ``sweep_ev_ranking_v1`` else legacy score.

    Advisory lane stays unranked relative to code patches when mixed —
    callers typically separate lanes before ranking. Within a list,
    higher EV / score first.
    """
    premiums = kg_premiums or {}
    use_ev = _ev_enabled()
    for cand in candidates:
        if use_ev:
            # Advisory stays cheap / unranked relative to code: mild
            # demotion so code_patch with evidence wins generation slots.
            premium = premiums.get(cand.source_fingerprint, cand.kg_revert_premium)
            ev = compute_ev(cand, kg_premium=premium)
            if cand.plan_kind in ("advisory", "config_change"):
                ev = ev * 0.25  # keep cheap; never starve code lane
            cand.kg_revert_premium = premium
            cand.ev_score = ev
        else:
            cand.ev_score = None
    return sorted(candidates, key=lambda c: c.score, reverse=True)


def ev_capture(ranked: list[PlanCandidate], generated: list[PlanCandidate]) -> float:
    """M13 (§6.1): EV(generated) / EV(available). 1.0 when empty/zero."""
    avail = sum(max(0.0, float(c.ev_score if c.ev_score is not None else c.score)) for c in ranked)
    got = sum(
        max(0.0, float(c.ev_score if c.ev_score is not None else c.score)) for c in generated
    )
    if avail <= 0:
        return 1.0
    return min(1.0, got / avail)


def _is_empty_code_patch(cand: PlanCandidate) -> bool:
    if cand.plan_kind != "code_patch":
        return False
    return not (cand.diff_unified and str(cand.diff_unified).strip())


async def persist_candidates(
    org_id: str,
    candidates: list[PlanCandidate],
    *,
    run_id: str | None = None,
    max_plans: int = 10,
    max_code_patch: int | None = None,
    max_advisory: int | None = None,
) -> tuple[list[dict[str, Any]], int]:
    """Dedupe, supersede stale drafts, cap at max_plans / lane caps.

    Never persists empty ``code_patch`` candidates (fake PR cards).

    Returns ``(created_plans, skipped_dedup_count)``.
    """
    ranked = rank_candidates(candidates)
    created: list[dict[str, Any]] = []
    skipped = 0
    code_n = 0
    advisory_n = 0

    for cand in ranked:
        if len(created) >= max_plans:
            break
        if _is_empty_code_patch(cand):
            skipped += 1
            continue
        is_code = cand.plan_kind == "code_patch"
        if is_code and max_code_patch is not None and code_n >= max_code_patch:
            skipped += 1
            continue
        if not is_code and max_advisory is not None and advisory_n >= max_advisory:
            skipped += 1
            continue
        if not cand.source_fingerprint:
            skipped += 1
            continue
        existing = await plans_repo.find_blocking_by_fingerprint(org_id, cand.source_fingerprint)
        if existing is not None:
            if existing.get("status") == "snoozed":
                skipped += 1
                continue
            if cand.score > _existing_score(existing):
                await plans_repo.supersede_drafts(org_id, cand.source_fingerprint)
            else:
                skipped += 1
                continue

        evidence = dict(cand.evidence or {})
        if cand.ev_score is not None:
            evidence["ev_score"] = cand.ev_score
            evidence["kg_revert_premium"] = cand.kg_revert_premium

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
            evidence=evidence,
            triage_snapshot=cand.triage_snapshot,
            estimated_blast_radius=cand.estimated_blast_radius,
            llm_cost_usd=cand.llm_cost_usd,
        )
        if plan:
            created.append(plan)
            if is_code:
                code_n += 1
            else:
                advisory_n += 1
            await _emit_plan_created(org_id, plan)
        else:
            skipped += 1

    return created, skipped


def _existing_score(plan: dict[str, Any]) -> float:
    evidence = plan.get("evidence") or {}
    if "ev_score" in evidence:
        try:
            return float(evidence["ev_score"])
        except (TypeError, ValueError):
            pass
    sev = _SEVERITY_SCORE.get(str(evidence.get("severity", "medium")).lower(), 0.4)
    conf = float(evidence.get("confidence", 0.5))
    blast = _BLAST_SCORE.get(str(plan.get("estimated_blast_radius") or "medium").lower(), 0.5)
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
