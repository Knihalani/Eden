"""Operator supervision for Loop 2 plans — manual PR merge / revert."""

from __future__ import annotations

import logging
from typing import Any

from eden.improvement import plans_repo
from eden.improvement.approve import (
    ApproveBlockedError,
    _merge_plan_evidence,
    _n06_ledger,
    approve_plan,
    queue_verify_for_plan,
)

logger = logging.getLogger(__name__)


async def manual_merge_plan(
    org_id: str,
    plan_id: str,
    *,
    merged_by: str | None = None,
    force: bool = False,
) -> dict[str, Any]:
    """Merge the open PR for a ``pr_opened`` code_patch plan.

    Operator supervision path — does not re-run the M15 auto-merge
    eligibility ladder; the human clicking Merge is the gate.
    """
    plan = await plans_repo.get_plan(org_id, plan_id)
    if plan is None:
        return {"status": "not_found", "plan_id": plan_id}

    status = (plan.get("status") or "").lower()
    if status != "pr_opened":
        return {
            "status": "invalid_state",
            "plan_id": plan_id,
            "current_status": status,
            "message": "Manual merge requires an open PR (pr_opened status)",
        }

    plan_kind = plan.get("plan_kind") or "code_patch"
    if plan_kind != "code_patch":
        return {
            "status": "unsupported_kind",
            "plan_id": plan_id,
            "plan_kind": plan_kind,
        }

    pr_number = plan.get("pr_number")
    if pr_number is None:
        return {
            "status": "error",
            "plan_id": plan_id,
            "error": "missing_pr_number",
            "message": "Plan has no linked PR number",
        }

    plan_agent_id = (plan.get("agent_id") or "").strip() or None
    from eden.improvement.auto_merge import merge_pull_request
    from eden.providers.factory import get_pr_provider_for_org

    try:
        pr_provider = await get_pr_provider_for_org(org_id, agent_id=plan_agent_id)
    except Exception as exc:
        return {
            "status": "error",
            "plan_id": plan_id,
            "error": "repo_connection_error",
            "message": str(exc),
        }

    title = f"[Eden] {str(plan.get('title') or 'Improvement plan')[:120]}"
    merge_result = await merge_pull_request(
        pr_provider,
        int(pr_number),
        commit_title=title,
    )
    if not merge_result.get("ok"):
        block = str(merge_result.get("reason") or "merge_failed")
        try:
            await _merge_plan_evidence(
                org_id,
                plan_id,
                {
                    "manual_merge": {
                        "attempted_by": merged_by,
                        "force": force,
                        "ok": False,
                        "reason": block,
                    }
                },
            )
        except Exception as exc:  # noqa: BLE001
            logger.debug("manual_merge: failure stamp failed: %s", exc)
        return {
            "status": "error",
            "plan_id": plan_id,
            "error": "merge_failed",
            "message": block,
        }

    updated = await _merge_plan_evidence(
        org_id,
        plan_id,
        {
            "manual_merge": {
                "attempted_by": merged_by,
                "force": force,
                "ok": True,
                "pr_number": pr_number,
            },
            "auto_merge": {
                **(
                    ((plan.get("evidence") or {}).get("auto_merge") or {})
                    if isinstance(plan.get("evidence"), dict)
                    else {}
                ),
                "merged": True,
                "manual": True,
            },
        },
    )
    merged_plan = await plans_repo.mark_merged(org_id, plan_id)
    if merged_plan is not None:
        updated = merged_plan

    branch = plan.get("github_branch")
    try:
        await queue_verify_for_plan(org_id, updated or plan, branch=branch)
    except Exception as exc:  # noqa: BLE001
        logger.debug("manual_merge: verify queue failed: %s", exc)

    await _n06_ledger(
        org_id,
        plan_id,
        event_subtype="manual_merge",
        actor_id=merged_by,
        payload={"pr_number": pr_number, "force": force},
    )
    await plans_repo.emit_event(
        org_id,
        plan_id,
        "manual_merge",
        actor=merged_by,
        payload={"pr_number": pr_number, "force": force},
    )

    return {
        "status": "merged",
        "plan_id": plan_id,
        "pr_number": pr_number,
        "pr_url": plan.get("pr_url"),
        "plan": updated,
    }


def _issue_id_from_plan(plan: dict[str, Any]) -> str | None:
    evidence = plan.get("evidence")
    if isinstance(evidence, dict):
        issue_id = str(evidence.get("issue_id") or "").strip()
        if issue_id:
            return issue_id
    source = str(plan.get("source_ref") or "")
    if source.startswith("issue:"):
        return source.split(":", 1)[1]
    return None


async def manual_revert_plan(
    org_id: str,
    plan_id: str,
    *,
    reverted_by: str | None = None,
) -> dict[str, Any]:
    """Draft + approve a revert plan for a merged ``code_patch``.

  Uses the guardian inverse-diff path (``guardian._draft_revert``) so the
  revert is statically checked against current HEAD, then opens (and may
  auto-merge) the revert PR via the normal approve flow.
    """
    plan = await plans_repo.get_plan(org_id, plan_id)
    if plan is None:
        return {"status": "not_found", "plan_id": plan_id}

    status = (plan.get("status") or "").lower()
    if status != "merged":
        return {
            "status": "invalid_state",
            "plan_id": plan_id,
            "current_status": status,
            "message": "Manual revert requires a merged plan",
        }

    plan_kind = plan.get("plan_kind") or "code_patch"
    if plan_kind != "code_patch":
        return {
            "status": "unsupported_kind",
            "plan_id": plan_id,
            "plan_kind": plan_kind,
        }

    from eden.improvement.guardian import (
        _decide_revert_allowed,
        _draft_revert,
        _existing_follow_up,
    )

    plan_agent = str(plan.get("agent_id") or "").strip() or None
    if not await _decide_revert_allowed(org_id, plan_agent):
        return {
            "status": "blocked",
            "plan_id": plan_id,
            "blocked_reason": "rollback_policy_denied",
            "message": "Org autonomy policy denies rollback for this agent",
        }

    parent_id = str(plan.get("id") or "")
    if await _existing_follow_up(org_id, parent_id):
        return {
            "status": "blocked",
            "plan_id": plan_id,
            "blocked_reason": "follow_up_exists",
            "message": (
                "An open revert or follow-up plan already exists for this merge"
            ),
        }

    issue_id = _issue_id_from_plan(plan)
    if not issue_id:
        return {
            "status": "error",
            "plan_id": plan_id,
            "error": "missing_issue_id",
            "message": "Cannot revert: plan has no linked issue",
        }

    revert_plan, conflict = await _draft_revert(
        org_id,
        plan,
        issue_id=issue_id,
        verify_detail={
            "trigger": "operator_manual_revert",
            "actor": reverted_by,
        },
    )
    if revert_plan is None:
        return {
            "status": "error",
            "plan_id": plan_id,
            "error": "revert_draft_failed",
            "message": conflict or "Could not draft revert plan",
        }

    revert_id = str(revert_plan.get("id") or "")
    try:
        result = await approve_plan(org_id, revert_id, approved_by=reverted_by)
    except ApproveBlockedError as exc:
        return {
            "status": "blocked",
            "plan_id": plan_id,
            "revert_plan_id": revert_id,
            "blocked_reason": exc.reason,
        }

    result_status = result.get("status")
    if result_status in ("error", "invalid_state", "not_found", "unsupported_kind"):
        return {
            "status": "error",
            "plan_id": plan_id,
            "revert_plan_id": revert_id,
            "error": result.get("error") or result_status,
            "message": result.get("message") or str(result),
        }

    try:
        from eden.patches.knowledge_graph import record_plan_outcome

        await record_plan_outcome(org_id, plan, "reverted")
    except Exception as exc:  # noqa: BLE001
        logger.debug("manual_revert: KG outcome failed: %s", exc)

    await _merge_plan_evidence(
        org_id,
        plan_id,
        {
            "operator_revert": {
                "by": reverted_by,
                "revert_plan_id": revert_id,
                "approve_status": result_status,
            }
        },
    )

    await _n06_ledger(
        org_id,
        plan_id,
        event_subtype="manual_revert",
        actor_id=reverted_by,
        payload={
            "revert_plan_id": revert_id,
            "approve_status": result_status,
        },
    )
    await plans_repo.emit_event(
        org_id,
        plan_id,
        "manual_revert",
        actor=reverted_by,
        payload={"revert_plan_id": revert_id, "approve_status": result_status},
    )

    merged = result_status == "merged"
    return {
        "status": "revert_initiated",
        "plan_id": plan_id,
        "revert_plan_id": revert_id,
        "revert_plan": result.get("plan") or revert_plan,
        "approve_status": result_status,
        "pr_url": result.get("pr_url"),
        "auto_merged": merged,
        "message": (
            "Revert PR merged"
            if merged
            else "Revert PR opened — merge when ready or let Eden verify post-merge"
        ),
    }
