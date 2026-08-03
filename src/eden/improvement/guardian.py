"""Soft Autonomy Phase 9 — post-PR guardian.

When a merged fix PR regresses (the post-merge N01 verify fails), the
guardian turns that signal into action instead of just an alert:

1. Locate the merged plan whose PR caused the regression
   (``evidence.issue_id`` / ``source_ref == "issue:<id>"``, status
   ``merged``).
2. Decide **revert** vs **follow-up fix** (M5, D9 — plans are
   actionable, never empty shells):
   * Revert when the regression severity is high (P0/P1) and the org's
     autonomy policy permits rollbacks: the parent's merged diff is
     inverted (``invert_unified_diff``), applied + statically checked
     against current HEAD, and drafted as a real ``code_patch``. Drift
     or static failure falls back to a follow-up with the conflict
     noted. The plan is the revert vehicle.
   * M15 (§9): when the parent rode the canary auto-merge ladder,
     guardian **auto-executes** the revert (approve + merge) provided
     ``auto_revert_enabled`` and the kill switch allow it — using the
     same M5 inverse-diff plan. Non-canary parents still wait for a
     human Approve.
   * Otherwise draft a follow-up via the real generation path
     (``PatchGenerator``, ``persist=False``) with the verify failure +
     parent diff as feedback; failed generation degrades to
     ``plan_kind="advisory"`` ("needs manual fix"). Both are linked to
     the original via ``parent_plan_id`` so the portal renders the chain.
3. Slack-alert the agent's channel via
   :func:`eden.services.slack_notify.notify_regression`.

Everything is best-effort: a guardian failure must never break the
verify pipeline, so every public entry point swallows transport errors
after logging.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)

#: Severities that justify an immediate revert draft over a follow-up fix.
_REVERT_SEVERITIES = frozenset({"P0", "P1", "CRITICAL", "HIGH"})


async def _find_merged_plan_for_issue(
    org_id: str, issue_id: str
) -> dict[str, Any] | None:
    """The most recent merged plan that targeted this issue."""
    try:
        from eden.storage.postgres import get_postgres_client

        client = await get_postgres_client()
        if client is None:
            return None
        row = await client.fetchrow(
            """
            SELECT * FROM improvement_plans
            WHERE org_id = $1
              AND status = 'merged'
              AND (
                    source_ref = $2
                    OR evidence->>'issue_id' = $3
                  )
            ORDER BY updated_at DESC
            LIMIT 1
            """,
            org_id,
            f"issue:{issue_id}",
            issue_id,
        )
        if row is None:
            return None
        from eden.improvement.plans_repo import _row

        return _row(row)
    except Exception as exc:  # noqa: BLE001
        logger.debug("guardian: merged plan lookup failed: %s", exc)
        return None


async def _existing_follow_up(org_id: str, parent_plan_id: str) -> bool:
    """True when an open follow-up already exists for this parent —
    the guardian must never spam duplicate revert/fix drafts."""
    try:
        from eden.storage.postgres import get_postgres_client

        client = await get_postgres_client()
        if client is None:
            return False
        row = await client.fetchval(
            """
            SELECT 1 FROM improvement_plans
            WHERE org_id = $1 AND parent_plan_id = $2::uuid
              AND status IN ('draft', 'pending_review', 'approved', 'pr_opened')
            LIMIT 1
            """,
            org_id,
            parent_plan_id,
        )
        return bool(row)
    except Exception:  # noqa: BLE001
        return False


async def _decide_revert_allowed(org_id: str, agent_id: str | None) -> bool:
    """Policy gate for an autonomous revert draft."""
    try:
        from eden.closed_loop.autonomy_policy import decide, resolve

        policy = await resolve(org_id, agent_id)
        verdict, _reason, _tier = decide(policy, "rollback")
        return verdict in ("allow", "require_approval")
    except Exception:  # noqa: BLE001 — fail closed on policy errors
        return False


async def handle_regression(
    org_id: str,
    issue_id: str,
    *,
    severity: str = "",
    agent_id: str | None = None,
    verify_detail: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Post-merge verify failed → revert or follow-up fix + Slack alert.

    Returns a status dict; never raises. ``{"status": "no_plan"}`` when
    the issue has no merged plan (the regression wasn't caused by an
    Eden PR — nothing to guard).
    """
    try:
        plan = await _find_merged_plan_for_issue(org_id, issue_id)
        if plan is None:
            return {"status": "no_plan", "issue_id": issue_id}

        plan_id = str(plan["id"])
        if await _existing_follow_up(org_id, plan_id):
            return {"status": "follow_up_exists", "plan_id": plan_id}

        sev = (severity or "").upper()
        plan_agent = agent_id or (str(plan.get("agent_id") or "").strip() or None)
        want_revert = sev in _REVERT_SEVERITIES and await _decide_revert_allowed(
            org_id, plan_agent
        )
        action = "follow_up"
        follow_up: dict[str, Any] | None = None
        revert_conflict: str | None = None
        if want_revert:
            follow_up, revert_conflict = await _draft_revert(
                org_id,
                plan,
                issue_id=issue_id,
                verify_detail=verify_detail,
            )
            if follow_up is not None:
                action = "revert"
            else:
                logger.info(
                    "guardian: revert draft fell back to follow-up: %s",
                    revert_conflict,
                )
        if follow_up is None:
            follow_up = await _draft_follow_up(
                org_id,
                plan,
                issue_id=issue_id,
                verify_detail=verify_detail,
                revert_conflict=revert_conflict,
            )

        # M15 (§9): canary auto-merge class → auto-execute the revert
        # plan (M5 inverse diff) when auto_revert is permitted.
        auto_revert_result: dict[str, Any] | None = None
        if (
            action == "revert"
            and follow_up is not None
            and follow_up.get("id")
        ):
            auto_revert_result = await _maybe_auto_execute_revert(
                org_id,
                parent=plan,
                revert_plan=follow_up,
                agent_id=plan_agent,
            )
            if auto_revert_result and auto_revert_result.get("status") in (
                "merged",
                "pr_opened",
            ):
                action = "auto_revert"

        # M13 (§6.3): only real revert / auto-revert actions write KG
        # ``reverted`` — follow-up drafts must not inflate revert history
        # (that would falsely block future auto-merges).
        if action in ("revert", "auto_revert"):
            try:
                from eden.patches.knowledge_graph import record_plan_outcome

                await record_plan_outcome(org_id, plan, "reverted")
            except Exception as exc:  # noqa: BLE001
                logger.warning("guardian: KG reverted outcome failed: %s", exc)

        # Slack regression alert — deep link to the issue.
        try:
            from eden.services.slack_notify import notify_regression

            await notify_regression(
                org_id,
                plan_id=plan_id,
                issue_id=issue_id,
                title=str(plan.get("title") or "Merged fix regressed"),
                agent_id=plan_agent,
                action=action,
            )
        except Exception as exc:  # noqa: BLE001
            logger.debug("guardian: slack regression notify failed: %s", exc)

        out: dict[str, Any] = {
            "status": "drafted",
            "action": action,
            "plan_id": plan_id,
            "follow_up_plan_id": (follow_up or {}).get("id"),
        }
        if auto_revert_result is not None:
            out["auto_revert"] = auto_revert_result
            if auto_revert_result.get("status") in ("merged", "pr_opened"):
                out["status"] = "auto_reverted"
        return out
    except Exception as exc:  # noqa: BLE001
        logger.warning("guardian.handle_regression failed: %s", exc)
        return {"status": "error", "reason": str(exc)[:200]}


async def _maybe_auto_execute_revert(
    org_id: str,
    *,
    parent: dict[str, Any],
    revert_plan: dict[str, Any],
    agent_id: str | None,
) -> dict[str, Any] | None:
    """M15 (§9): auto-approve+merge a canary-class revert plan.

    Returns ``None`` when the parent was not a canary auto-merge or
    auto-revert is not permitted (human Approve remains the path).
    """
    from eden.improvement.auto_merge import (
        auto_revert_permitted,
        parent_is_canary_auto_merged,
    )

    if not parent_is_canary_auto_merged(parent):
        return None
    if not await auto_revert_permitted(org_id, agent_id):
        return {"status": "skipped", "reason": "auto_revert_not_permitted"}

    revert_id = str(revert_plan.get("id") or "")
    if not revert_id:
        return {"status": "error", "reason": "missing_revert_plan_id"}

    # Stamp force_canary_revert so approve's eligibility gate bypasses
    # the ladder checks (the original canary merge already passed them).
    try:
        from eden.improvement.approve import _merge_plan_evidence

        stamped = await _merge_plan_evidence(
            org_id,
            revert_id,
            {
                "auto_merge": {
                    "force_canary_revert": True,
                    "parent_plan_id": str(parent.get("id") or ""),
                    "canary_auto_revert": True,
                }
            },
        )
        if stamped is not None:
            revert_plan = stamped
    except Exception as exc:  # noqa: BLE001
        logger.debug("guardian: stamp force_canary_revert failed: %s", exc)

    try:
        from eden.improvement.approve import approve_plan

        result = await approve_plan(
            org_id,
            revert_id,
            approved_by="eden:guardian_auto_revert",
        )
        return {
            "status": result.get("status"),
            "pr_url": result.get("pr_url"),
            "pr_number": result.get("pr_number"),
            "auto_merged": result.get("auto_merged"),
            "plan_id": revert_id,
        }
    except Exception as exc:  # noqa: BLE001
        logger.warning("guardian: auto-revert execute failed: %s", exc)
        return {"status": "error", "reason": str(exc)[:200]}


def _paths_from_diff(diff: str) -> list[str]:
    """Unique repo-relative paths a unified diff touches (both sides)."""
    from eden.patches.diff_materializer import _DEV_NULL, _parse_unified_diff_files

    paths: list[str] = []
    for fd in _parse_unified_diff_files(diff):
        for p in (fd.old_path, fd.new_path):
            if p and p != _DEV_NULL and p not in paths:
                paths.append(p)
    return paths


async def _hydrate_head_files(
    org_id: str, agent_id: str | None, paths: list[str]
) -> list[dict[str, str]]:
    """Current HEAD content for ``paths`` via the org's repo provider.

    Missing files hydrate as ``""`` (same contract as
    ``RepoProvider.read_file``) so a revert of a delete — a new-file
    inverse hunk — still applies.
    """
    from eden.providers.factory import get_repo_provider_for_org

    provider = await get_repo_provider_for_org(org_id, agent_id=agent_id)
    import asyncio

    async def _one(path: str) -> dict[str, str]:
        try:
            content = await provider.read_file(path) or ""
        except Exception as exc:  # noqa: BLE001
            logger.debug("guardian: read_file %s failed: %s", path, exc)
            content = ""
        return {"path": path, "content": content}

    return list(await asyncio.gather(*[_one(p) for p in paths]))


def _parent_evidence(
    parent: dict[str, Any],
    *,
    issue_id: str,
    action: str,
    verify_detail: dict[str, Any] | None,
) -> dict[str, Any]:
    return {
        "issue_id": issue_id,
        "guardian": action,
        "guardian_action": action,
        "parent_plan_id": str(parent["id"]),
        "parent_pr_url": parent.get("pr_url"),
        "parent_pr_number": parent.get("pr_number"),
        "parent_github_branch": parent.get("github_branch"),
        "verify": verify_detail or {},
    }


async def _draft_revert(
    org_id: str,
    parent: dict[str, Any],
    *,
    issue_id: str,
    verify_detail: dict[str, Any] | None,
) -> tuple[dict[str, Any] | None, str | None]:
    """Draft a revert ``code_patch`` carrying the parent diff inverted.

    The plan *is* the revert vehicle. For non-canary parents a human
    approves and the normal approve flow opens the PR. M15 (§9): when
    the parent was a canary auto-merge, :func:`handle_regression`
    auto-executes this plan. Returns ``(plan, None)`` on success or
    ``(None, reason)`` when the inverse diff no longer applies to HEAD
    (drift), fails static checks, or cannot be computed — the caller
    falls back to a follow-up fix with the conflict noted.
    """
    from eden.improvement import plans_repo
    from eden.improvement.evidence_plane import apply_diff_to_files
    from eden.patches.diff_materializer import (
        DiffMaterializeError,
        invert_unified_diff,
    )

    parent_id = str(parent["id"])
    parent_diff = str(parent.get("diff_unified") or "").strip()
    if not parent_diff:
        return None, "parent_diff_missing"

    try:
        inverted = invert_unified_diff(parent_diff)
    except DiffMaterializeError as exc:
        return None, f"invert_failed:{str(exc)[:200]}"
    if not inverted.strip():
        return None, "inverted_diff_empty"

    paths = _paths_from_diff(inverted)
    agent = str(parent.get("agent_id") or "").strip() or None
    try:
        linked = await _hydrate_head_files(org_id, agent, paths)
    except Exception as exc:  # noqa: BLE001
        return None, f"head_read_failed:{str(exc)[:200]}"

    check = await apply_diff_to_files(inverted, linked)
    if check.get("status") != "passed":
        detail = check.get("detail") or {}
        reason = str(detail.get("reason") or "apply_failed")
        if reason == "static_syntax_failed":
            return None, f"revert_static_failed:{reason}"
        return None, f"revert_apply_conflict:{reason}"

    evidence = _parent_evidence(
        parent, issue_id=issue_id, action="revert", verify_detail=verify_detail
    )
    evidence["revert_strategy"] = "inverse_diff"
    evidence["verify_detail"] = verify_detail or {}
    evidence["static_check"] = (check.get("detail") or {}).get("static_check") or {}

    plan = await plans_repo.create_plan(
        org_id,
        plan_kind="code_patch",
        title=f"Revert: {str(parent.get('title') or 'improvement plan')[:100]}",
        agent_id=agent,
        summary=(
            "Post-merge verify failed — Eden drafted a revert of "
            f"PR {parent.get('pr_url') or parent.get('pr_number')} "
            "(inverse of the merged diff, statically checked against "
            "HEAD). Approve to open the revert PR."
        ),
        source_ref=f"issue:{issue_id}",
        # Distinct fingerprint so the dedup index doesn't treat the
        # follow-up as the parent's still-open draft.
        source_fingerprint=f"guardian:{parent_id}:revert",
        diff_unified=inverted,
        files_changed=paths,
        evidence=evidence,
        triage_snapshot=parent.get("triage_snapshot"),
        parent_plan_id=parent_id,
    )
    if plan is None:
        return None, "persist_failed"
    return plan, None


async def _draft_follow_up(
    org_id: str,
    parent: dict[str, Any],
    *,
    issue_id: str,
    verify_detail: dict[str, Any] | None,
    revert_conflict: str | None = None,
) -> dict[str, Any] | None:
    """Draft a follow-up fix via the real generation path.

    Calls ``PatchGenerator.generate(persist=False)`` with the verify
    failure detail + the parent's merged diff as ``static_feedback``
    context. Suppressed/failed/empty generation degrades to a
    ``plan_kind="advisory"`` row ("needs manual fix: <reason>") — the
    guardian never writes an approvable ``code_patch`` with an empty
    diff (D9).
    """
    import json as _json

    from eden.improvement import plans_repo

    parent_id = str(parent["id"])
    parent_title = str(parent.get("title") or "improvement plan")
    agent = str(parent.get("agent_id") or "").strip() or None
    parent_diff = str(parent.get("diff_unified") or "")

    feedback_parts = [
        "A previously merged fix for this issue regressed post-merge."
    ]
    if verify_detail:
        try:
            feedback_parts.append(
                "Post-merge verify failure detail:\n"
                + _json.dumps(verify_detail, default=str)[:2000]
            )
        except Exception:  # noqa: BLE001
            feedback_parts.append(
                f"Post-merge verify failure detail:\n{str(verify_detail)[:2000]}"
            )
    if parent_diff.strip():
        feedback_parts.append(
            "The merged diff that caused the regression (do not simply "
            "re-apply it):\n" + parent_diff[:4000]
        )
    static_feedback = "\n\n".join(feedback_parts)

    paths = _paths_from_diff(parent_diff) if parent_diff.strip() else []
    linked_files: list[dict[str, str]] = []
    try:
        linked_files = await _hydrate_head_files(org_id, agent, paths)
    except Exception as exc:  # noqa: BLE001
        logger.debug("guardian: linked-file hydration failed: %s", exc)

    data: dict[str, Any] = {}
    fail_reason: str | None = None
    try:
        from eden.patches.patch_generator import PatchGenerator

        result = await PatchGenerator().generate(
            org_id=org_id,
            rca_id=f"guardian:{parent_id}",
            trace_id=f"unknown_trace:{issue_id}",
            repo_id=agent or "guardian",
            rca_summary=(
                f"Regression after merged plan {parent_id} "
                f"({parent_title[:120]}) — post-merge verify failed."
            ),
            test_plan=[],
            linked_files=linked_files or None,
            persist=False,
            static_feedback=static_feedback,
        )
        data = result.get("data", {}) if isinstance(result, dict) else {}
        status = str(data.get("status") or "proposed")
        critic = data.get("critic_verdict") or {}
        if status in ("deduplicated", "investigation", "low_quality"):
            fail_reason = status
        elif critic.get("passed") is False or critic.get("reason") == "critic_error":
            fail_reason = "critic_failed"
        elif not str(data.get("diff") or "").strip():
            envelope_status = (
                str(result.get("status") or "") if isinstance(result, dict) else ""
            )
            fail_reason = (
                envelope_status if envelope_status not in ("", "ok") else "empty_diff"
            )
    except Exception as exc:  # noqa: BLE001
        logger.debug("guardian: follow-up generation failed: %s", exc)
        fail_reason = f"generation_error:{str(exc)[:160]}"

    evidence = _parent_evidence(
        parent, issue_id=issue_id, action="follow_up", verify_detail=verify_detail
    )
    if revert_conflict:
        evidence["revert_conflict"] = revert_conflict
        if parent.get("pr_number") is not None:
            # M15 (§9): canary auto-merges auto-execute the inverse-diff
            # revert above; non-canary / failed auto-revert still expose
            # PRProvider.revert(strategy="revert_pr") as a human fallback.
            evidence["revert_fallback"] = "pr_provider_revert:revert_pr"

    diff = "" if fail_reason else str(data.get("diff") or "")
    if not fail_reason and not diff.strip():
        fail_reason = "empty_diff"

    title = f"Follow-up fix: {parent_title[:100]}"
    if fail_reason is None:
        plan_kind = "code_patch"
        diff_unified: str | None = diff
        files_changed = list(data.get("files") or paths)
        summary = (
            "Post-merge verify failed after the original fix landed. "
            "Eden drafted a follow-up patch with the regression evidence."
        )
        evidence["patch_id"] = data.get("patch_id")
        llm_cost = float(data.get("cost_usd") or 0)
    else:
        plan_kind = "advisory"
        diff_unified = None
        files_changed = paths
        summary = f"needs manual fix: {fail_reason}"
        evidence["generation_failure"] = fail_reason
        llm_cost = float(data.get("cost_usd") or 0)

    # Invariant (D9): never an approvable empty code_patch.
    if plan_kind == "code_patch" and not (diff_unified or "").strip():
        plan_kind = "advisory"
        diff_unified = None
        summary = "needs manual fix: empty_diff"
        evidence["generation_failure"] = "empty_diff"

    return await plans_repo.create_plan(
        org_id,
        plan_kind=plan_kind,
        title=title,
        agent_id=agent,
        summary=summary,
        source_ref=f"issue:{issue_id}",
        # Distinct fingerprint so the dedup index doesn't treat the
        # follow-up as the parent's still-open draft.
        source_fingerprint=f"guardian:{parent_id}:follow_up",
        diff_unified=diff_unified,
        files_changed=files_changed,
        evidence=evidence,
        triage_snapshot=parent.get("triage_snapshot"),
        llm_cost_usd=llm_cost,
        parent_plan_id=parent_id,
    )


__all__ = ["handle_regression"]
