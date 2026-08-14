"""HelpMiss Do-it apply: prefer a small code PR, else replace one instruction."""

from __future__ import annotations

import logging
from typing import Any

from eden.improvement.issue_patch_trigger import (
    FIX_KIND_CODE,
    classify_help_miss_fix,
    instruction_is_generic,
)

logger = logging.getLogger(__name__)


def resolve_help_miss_target_file(leftovers: list[Any] | None) -> str | None:
    """First leftover path we can use. Do not ask which file."""
    for raw in leftovers or []:
        if not isinstance(raw, dict):
            continue
        path = str(raw.get("path") or "").strip()
        if path:
            return path
    return None


def existing_help_miss_pr_url(plan: dict[str, Any] | None) -> str | None:
    """Idempotent: reuse a PR already opened for this plan."""
    if not isinstance(plan, dict):
        return None
    for key in ("pr_url",):
        url = str(plan.get(key) or "").strip()
        if url:
            return url
    ev = plan.get("evidence")
    if isinstance(ev, dict):
        url = str(ev.get("pr_url") or "").strip()
        if url:
            return url
        meta = ev.get("approve_metadata")
        if isinstance(meta, dict):
            url = str(meta.get("pr_url") or "").strip()
            if url:
                return url
    return None


def choose_help_miss_apply(
    evidence: dict[str, Any] | None,
    *,
    plan: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Decide code PR vs one-line instruction replace. No agent-file write."""
    ev = evidence if isinstance(evidence, dict) else {}
    instruction = str(ev.get("instruction") or "").strip()
    if instruction_is_generic(instruction):
        return {"status": "refused", "reason": "generic_draft"}
    leftovers = ev.get("leftovers") if isinstance(ev.get("leftovers"), list) else []
    fix_kind = str(ev.get("fix_kind") or classify_help_miss_fix(leftovers) or "")
    target = resolve_help_miss_target_file(leftovers)
    has_diff = bool(str((plan or {}).get("diff_unified") or "").strip())
    existing_pr = existing_help_miss_pr_url(plan)
    if fix_kind == FIX_KIND_CODE and (target or has_diff or existing_pr):
        return {
            "status": "ok",
            "apply_kind": "code_pr",
            "target_file": target,
            "instruction": instruction,
            "can_open_pr": bool(has_diff or existing_pr),
        }
    return {
        "status": "ok",
        "apply_kind": "instruction_replace",
        "target_file": None,
        "instruction": instruction,
        "can_open_pr": False,
    }


async def approve_help_miss_plan(
    org_id: str,
    plan_id: str,
    plan: dict[str, Any],
    *,
    approved_by: str | None = None,
) -> dict[str, Any]:
    """Apply a HelpMiss draft. Human already approved. No auto-merge. No agent-file write."""
    from eden.improvement import plans_repo

    _raw_ev = plan.get("evidence")
    evidence: dict[str, Any] = _raw_ev if isinstance(_raw_ev, dict) else {}
    choice = choose_help_miss_apply(evidence, plan=plan)
    if choice.get("status") == "refused":
        return {
            "plan_id": plan_id,
            "status": "refused",
            "reason": choice.get("reason") or "generic_draft",
            "message": "Generic or empty instruction — stay on draft. No pin, no PR.",
        }

    apply_kind = str(choice["apply_kind"])
    target_file = choice.get("target_file")
    pr_url = existing_help_miss_pr_url(plan)
    pr_error: str | None = None

    if apply_kind == "code_pr" and not pr_url and not choice.get("can_open_pr"):
        # Prefer code, but no file diff yet — pin the one instruction instead.
        apply_kind = "instruction_replace"
        pr_error = "no_diff"

    updated = await plans_repo.mark_approved(
        org_id,
        plan_id,
        approved_by=approved_by,
        status="approved",
        metadata={
            "route_status": "applied",
            "apply_kind": apply_kind,
            "target_file": target_file,
            "instruction": choice.get("instruction"),
            "pr_url": pr_url,
            "pr_error": pr_error,
            "agents_md": False,
        },
    )

    notify = await _notify_applied(
        org_id,
        agent_id=str(plan.get("agent_id") or ""),
        plan_id=plan_id,
        apply_kind=apply_kind,
        pr_url=pr_url,
        pr_error=pr_error,
    )
    return {
        "plan_id": plan_id,
        "status": "applied",
        "apply_kind": apply_kind,
        "target_file": target_file,
        "pr_url": pr_url,
        "agents_md": False,
        "notify": notify,
        "plan": updated,
    }


async def _notify_applied(
    org_id: str,
    *,
    agent_id: str,
    plan_id: str,
    apply_kind: str,
    pr_url: str | None,
    pr_error: str | None,
) -> dict[str, Any]:
    try:
        from eden.services.slack_notify import notify_help_miss_applied

        return await notify_help_miss_applied(
            org_id,
            agent_id=agent_id,
            plan_id=plan_id,
            apply_kind=apply_kind,
            pr_url=pr_url,
            pr_error=pr_error,
        )
    except Exception as exc:
        logger.debug("help_miss_apply: notify failed: %s", exc)
        return {"status": "error", "reason": str(exc)[:200]}
