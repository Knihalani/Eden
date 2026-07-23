"""Approve flow: N22 gate → materialize diff → draft PR → plan status (N23)."""

from __future__ import annotations

import logging
from typing import Any

from eden.improvement import plans_repo
from eden.patches.diff_materializer import (
    DiffMaterializeError,
    materialize_unified_diff,
)
from eden.providers import PRCreateRequest, PRProvider

logger = logging.getLogger(__name__)


class ApproveBlocked(Exception):
    def __init__(self, reason: str) -> None:
        self.reason = reason
        super().__init__(reason)


async def _resolve_repo_id(org_id: str) -> str | None:
    """Return the org's active repo_connections id (or full name), else None.

    Intentionally does **not** fall back to ``plan.agent_id`` — that field is
    an Eden agent identifier, not a GitHub/repo connection id.
    """
    from eden.providers.factory import resolve_active_repo_id

    return await resolve_active_repo_id(org_id)


async def _resolve_base_branch(org_id: str, repo_provider: Any) -> str:
    """Resolve the PR base branch — never hardcode ``main``.

    Preference order:
    1. ``repo_connections.default_branch`` when set
    2. :meth:`RepoProvider.get_default_branch`
    """
    try:
        from eden.providers.factory import active_repo_connection

        conn = await active_repo_connection(org_id)
    except Exception as exc:
        logger.debug("approve: active_repo_connection failed: %s", exc)
        conn = None
    if conn:
        branch = (conn.get("default_branch") or "").strip()
        if branch:
            return branch
    try:
        branch = await repo_provider.get_default_branch()
    except Exception as exc:
        logger.warning("approve: get_default_branch failed: %s", exc)
        raise RuntimeError(
            "could not resolve default branch for approve"
        ) from exc
    branch = (branch or "").strip()
    if not branch:
        raise RuntimeError("could not resolve default branch for approve")
    return branch


def _pr_create_failed(info: Any) -> bool:
    """True when create_pr returned a silent failure envelope."""
    state = (getattr(info, "state", None) or "").lower()
    number = int(getattr(info, "number", 0) or 0)
    url = (getattr(info, "url", None) or "").strip()
    return state == "failed" or number == 0 or not url


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

    # Resolve real repo_connections row — never treat plan.agent_id as repo_id.
    repo_id = await _resolve_repo_id(org_id)
    if not repo_id:
        return {
            "status": "error",
            "plan_id": plan_id,
            "error": "repo_not_connected",
            "message": "Connect GitHub App in Settings",
        }

    from eden.providers.factory import (
        get_pr_provider_for_org,
        get_repo_provider_for_org,
    )

    repo_provider = await get_repo_provider_for_org(org_id)
    try:
        files = await materialize_unified_diff(
            diff,
            read_file=repo_provider.read_file,
        )
    except DiffMaterializeError as exc:
        logger.warning("approve_plan: materialize failed: %s", exc)
        return {
            "status": "error",
            "plan_id": plan_id,
            "error": "diff_materialize_failed",
            "message": str(exc),
        }
    if not files:
        return {"status": "error", "plan_id": plan_id, "error": "unparseable_diff"}

    try:
        base = await _resolve_base_branch(org_id, repo_provider)
    except RuntimeError as exc:
        return {
            "status": "error",
            "plan_id": plan_id,
            "error": "base_branch_unresolved",
            "message": str(exc),
        }

    if provider is not None:
        pr_provider = provider
    else:
        pr_provider = await get_pr_provider_for_org(org_id)

    branch = f"eden/improve-{plan_id[:12]}"
    title = f"[Eden] {plan.get('title', 'Improvement plan')[:120]}"
    body = plan.get("summary") or f"Eden improvement plan `{plan_id}`"
    req = PRCreateRequest(
        title=title,
        body=body,
        branch=branch,
        base=base,
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

    if _pr_create_failed(info):
        logger.warning(
            "approve_plan: create_pr returned failure envelope "
            "(state=%s number=%s url=%r)",
            getattr(info, "state", None),
            getattr(info, "number", None),
            getattr(info, "url", None),
        )
        return {
            "status": "error",
            "plan_id": plan_id,
            "error": "pr_create_failed",
            "message": "PR provider returned a failed create_pr result",
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
    await _n06_ledger(
        org_id,
        plan_id,
        event_subtype="approve",
        actor_id=approved_by,
        payload={
            "pr_url": info.url,
            "pr_number": info.number,
            "branch": opened_branch,
            "verify_job_id": verify_job_id,
        },
    )

    merge_advice = {
        "do_not_merge_until": "n01_verify_pass",
        "verify_job_id": verify_job_id,
        "message": (
            "N01 regression verify must pass before merge advice; "
            "do not merge until verify completes successfully."
        ),
    }

    return {
        "plan_id": plan_id,
        "status": "pr_opened",
        "pr_url": info.url,
        "pr_number": info.number,
        "branch": opened_branch,
        "verify_job_id": verify_job_id,
        "merge_advice": merge_advice,
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

    if plan_kind in ("prompt_update", "guardrail_tune"):
        # F68 gateway deploy is not wired for improve approve — fail closed
        # so the portal cannot toast success on a no-op.
        return {
            "plan_id": plan_id,
            "status": "not_implemented",
            "supported": False,
            "plan_kind": plan_kind,
            "error": "f68_gateway_deploy_not_implemented",
            "message": (
                "Gateway deploy is not live (F68). "
                "Prompt update / guardrail tune approve is not implemented yet."
            ),
        }

    candidate_id: str | None = None
    route_status = "promotion_queued"
    message = "Queued in F41 promotion pipeline"

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
    except Exception as exc:
        logger.warning("approve non-code: F41 enqueue failed: %s", exc)
        return {
            "plan_id": plan_id,
            "status": "error",
            "supported": False,
            "plan_kind": plan_kind,
            "error": "promotion_enqueue_failed",
            "message": f"F41 enqueue unavailable: {exc}",
        }

    if not candidate_id:
        return {
            "plan_id": plan_id,
            "status": "error",
            "supported": False,
            "plan_kind": plan_kind,
            "error": "promotion_enqueue_empty",
            "message": "F41 enqueue returned no candidate id",
        }

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


async def queue_verify_for_plan(
    org_id: str, plan: dict[str, Any], *, branch: str | None = None
) -> str | None:
    """Public entry point so other callers reuse the approve flow's N01
    verify scheduling instead of standing up a parallel subsystem.

    Used by :func:`approve_plan` itself (PR-open time) and by the
    GitHub webhook (Phase 2b, PR-merge time) when a linked improvement
    plan's PR lands.
    """
    return await _queue_verify(org_id, plan, branch=branch)


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

        # schedule_verify returns the real verification row id (or None).
        return await schedule_verify(org_id, str(issue_id), ref=verify_ref)
    except Exception as exc:
        logger.debug("approve verify queue failed: %s", exc)
        return None


async def _n06_ledger(
    org_id: str,
    plan_id: str,
    *,
    event_subtype: str,
    actor_id: str | None = None,
    payload: dict[str, Any] | None = None,
) -> None:
    """N06 compliance pack — append-only audit for N20 approve/reject."""
    try:
        from eden.governance.compliance_pack import AgentAuditLedgerWriter

        await AgentAuditLedgerWriter().write(
            org_id,
            event_type="n20_code_patch",
            event_subtype=event_subtype,
            actor_id=actor_id,
            actor_type="user" if actor_id else "system",
            payload={"plan_id": plan_id, **(payload or {})},
            compliance_tags=["soc2", "n20", "n06"],
        )
    except Exception as exc:
        logger.debug("approve n06 ledger failed: %s", exc)


async def reject_plan_audited(
    org_id: str,
    plan_id: str,
    *,
    rejected_by: str | None = None,
    rejection_reason: str | None = None,
) -> dict[str, Any] | None:
    """Reject + N06 ledger (used by improve routes)."""
    updated = await plans_repo.reject_plan(
        org_id,
        plan_id,
        rejected_by=rejected_by,
        rejection_reason=rejection_reason,
    )
    await _n06_ledger(
        org_id,
        plan_id,
        event_subtype="reject",
        actor_id=rejected_by,
        payload={"rejection_reason": rejection_reason or ""},
    )
    return updated


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
