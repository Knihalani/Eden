"""Approve flow: N22 gate → PRCreator → plan status update (N23)."""

from __future__ import annotations

import logging
import uuid
from typing import Any

from eden.improvement import plans_repo
from eden.patches.pr_creator import _parse_unified_diff
from eden.providers import PRCreateRequest, PRProvider, get_default_pr_provider

logger = logging.getLogger(__name__)


class ApproveBlocked(Exception):
    def __init__(self, reason: str) -> None:
        self.reason = reason
        super().__init__(reason)


async def approve_plan(
    org_id: str,
    plan_id: str,
    *,
    approved_by: str | None = None,
    provider: PRProvider | None = None,
) -> dict[str, Any]:
    plan = await plans_repo.get_plan(org_id, plan_id)
    if plan is None:
        return {"status": "not_found", "plan_id": plan_id}

    if plan.get("status") not in ("draft", "pending_review", "approved"):
        return {
            "status": "invalid_state",
            "plan_id": plan_id,
            "current_status": plan.get("status"),
        }

    blocked = await _n22_blocked(org_id, plan)
    if blocked:
        raise ApproveBlocked(blocked)

    plan_kind = plan.get("plan_kind") or "code_patch"
    if plan_kind != "code_patch":
        return await _approve_non_code(org_id, plan_id, plan, approved_by=approved_by)

    diff = plan.get("diff_unified") or ""
    if not diff.strip():
        return {"status": "error", "plan_id": plan_id, "error": "empty_diff"}

    repo_id = plan.get("agent_id") or ""
    if not repo_id:
        return {
            "status": "error",
            "plan_id": plan_id,
            "error": "repo_not_connected",
            "message": "Connect GitHub App in Settings",
        }

    files = _parse_unified_diff(diff)
    if not files:
        return {"status": "error", "plan_id": plan_id, "error": "unparseable_diff"}

    pr_provider = provider or get_default_pr_provider()
    branch = f"eden/improve-{plan_id[:12]}"
    title = f"[Eden] {plan.get('title', 'Improvement plan')[:120]}"
    body = plan.get("summary") or f"Eden improvement plan `{plan_id}`"
    req = PRCreateRequest(
        title=title,
        body=body,
        branch=branch,
        base="main",
        draft=True,
        repo_id=repo_id,
        files=files,
    )

    try:
        info = await pr_provider.create_pr(req)
    except NotImplementedError as exc:
        return {
            "status": "error",
            "plan_id": plan_id,
            "error": "provider_not_implemented",
            "message": str(exc),
        }
    except Exception as exc:
        logger.warning("approve_plan: PR create failed: %s", exc)
        return {
            "status": "error",
            "plan_id": plan_id,
            "error": "pr_create_failed",
            "message": str(exc),
        }

    opened_branch = info.branch or branch
    updated = await plans_repo.mark_pr_opened(
        org_id,
        plan_id,
        pr_url=info.url,
        pr_number=info.number,
        github_branch=opened_branch,
        approved_by=approved_by,
    )

    verify_job_id = await _queue_verify(
        org_id, updated or plan, branch=opened_branch
    )
    await _audit_approve(org_id, plan_id, approved_by)

    return {
        "plan_id": plan_id,
        "status": "pr_opened",
        "pr_url": info.url,
        "pr_number": info.number,
        "branch": opened_branch,
        "verify_job_id": verify_job_id,
        "plan": updated,
    }


async def _approve_non_code(
    org_id: str,
    plan_id: str,
    plan: dict[str, Any],
    *,
    approved_by: str | None = None,
) -> dict[str, Any]:
    """Route prompt/nudge/guardrail plans to F41 promotion queue (v1)."""
    plan_kind = plan.get("plan_kind") or ""
    evidence = plan.get("evidence") or {}
    ref_id = (
        evidence.get("nudge_id")
        or evidence.get("prompt_version_id")
        or evidence.get("guardrail_id")
        or evidence.get("ref_id")
        or ""
    )
    if not ref_id:
        source = plan.get("source_ref") or ""
        if ":" in source:
            ref_id = source.split(":", 1)[1]

    kind_map = {
        "nudge_promote": "nudge",
        "prompt_update": "prompt_version",
        "guardrail_tune": "guardrail",
    }
    promo_kind = kind_map.get(plan_kind)
    if not promo_kind:
        return {
            "status": "unsupported_kind",
            "plan_id": plan_id,
            "plan_kind": plan_kind,
            "message": f"Unknown non-code plan kind: {plan_kind}",
        }

    candidate_id: str | None = None
    route_status = "promotion_queued"
    message = "Queued in F41 promotion pipeline (gateway deploy stub v1)"

    try:
        from eden.promotion.evidence_gate import EvidenceGate

        gate = EvidenceGate()
        candidate_id = await gate.enqueue(
            org_id,
            kind=promo_kind,
            ref_id=str(ref_id),
            status="pending",
        )
        if candidate_id and plan_kind == "nudge_promote":
            report = await gate.promote_if_passed(org_id, candidate_id)
            if report.passed:
                route_status = "promoted"
                message = "Nudge promoted via F41 evidence gate"
        elif candidate_id and plan_kind == "guardrail_tune":
            message = "Guardrail tune queued — gateway filter update pending (F68 stub)"
        elif candidate_id and plan_kind == "prompt_update":
            message = "Prompt update queued — gateway deploy pending (F68 stub)"
    except Exception as exc:
        logger.warning("approve non-code: F41 enqueue failed: %s", exc)
        route_status = "approved"
        message = f"F41 enqueue unavailable: {exc}"

    updated = await plans_repo.mark_approved(
        org_id,
        plan_id,
        approved_by=approved_by,
        status="approved",
        metadata={
            "route_status": route_status,
            "promotion_candidate_id": candidate_id,
            "promotion_kind": promo_kind,
            "ref_id": ref_id,
        },
    )
    await _audit_approve(org_id, plan_id, approved_by)

    return {
        "plan_id": plan_id,
        "status": route_status,
        "plan_kind": plan_kind,
        "promotion_candidate_id": candidate_id,
        "message": message,
        "plan": updated,
    }


async def _n22_blocked(org_id: str, plan: dict[str, Any]) -> str | None:
    try:
        from eden.closed_loop.autonomy_policy import decide, resolve

        policy = await resolve(org_id, plan.get("agent_id"))
        action = "propose_patch"
        plan_kind = plan.get("plan_kind") or "code_patch"
        if plan_kind == "nudge_promote":
            action = "nudge_promote"
        elif plan_kind in ("prompt_update", "guardrail_tune"):
            action = "prompt_canary"
        verdict, reason, _tier = decide(policy, action)
        if verdict == "deny":
            return reason
        if policy.compliance_profile == "hipaa":
            return "HIPAA observe mode — approve disabled"
    except Exception as exc:
        logger.debug("approve n22 check failed: %s", exc)
    return None


async def _queue_verify(
    org_id: str, plan: dict[str, Any], *, branch: str | None = None
) -> str | None:
    evidence = plan.get("evidence") or {}
    issue_id = evidence.get("issue_id")
    if not issue_id:
        source = plan.get("source_ref") or ""
        if source.startswith("issue:"):
            issue_id = source.split(":", 1)[1]

    verify_ref = branch or plan.get("github_branch") or plan.get("source_ref") or ""
    if not issue_id:
        return None

    try:
        from eden.closed_loop.verify import schedule_verify

        ok = await schedule_verify(org_id, str(issue_id), ref=verify_ref)
        return str(uuid.uuid4()) if ok else None
    except Exception as exc:
        logger.debug("approve verify queue failed: %s", exc)
        return None


async def _audit_approve(
    org_id: str, plan_id: str, approved_by: str | None
) -> None:
    try:
        from eden.closed_loop.autonomy_policy import audit

        await audit(
            org_id,
            agent_id=None,
            action="approve_improvement_plan",
            tier="auto_code_patch_pr",
            decision="allow",
            reason=f"plan {plan_id} approved by {approved_by or 'unknown'}",
        )
    except Exception:
        pass

    try:
        from eden.llmops.hooks_bus import HookEvent, get_hook_bus

        bus = get_hook_bus()
        await bus.emit(
            HookEvent(
                reason="improvement.plan_approved",
                severity="medium",
                org_id=org_id,
                source={"primary_entity_id": plan_id},
            )
        )
        await bus.emit(
            HookEvent(
                reason="improvement.pr_opened",
                severity="medium",
                org_id=org_id,
                source={"primary_entity_id": plan_id},
            )
        )
    except Exception:
        pass
