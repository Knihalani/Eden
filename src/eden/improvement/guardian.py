"""Soft Autonomy Phase 9 — post-PR guardian.

When a merged fix PR regresses (the post-merge N01 verify fails), the
guardian turns that signal into action instead of just an alert:

1. Locate the merged plan whose PR caused the regression
   (``evidence.issue_id`` / ``source_ref == "issue:<id>"``, status
   ``merged``).
2. Decide **revert** vs **follow-up fix**:
   * Revert when the regression severity is high (P0/P1) and the org's
     autonomy policy permits rollbacks — the fastest way back to
     "Eden only ever helps".
   * Otherwise draft a follow-up ``code_patch`` plan linked to the
     original via ``parent_plan_id`` so the portal renders the chain.
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
        action = "revert" if want_revert else "follow_up"

        follow_up = await _draft_follow_up(
            org_id,
            plan,
            issue_id=issue_id,
            action=action,
            verify_detail=verify_detail,
        )

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

        return {
            "status": "drafted",
            "action": action,
            "plan_id": plan_id,
            "follow_up_plan_id": (follow_up or {}).get("id"),
        }
    except Exception as exc:  # noqa: BLE001
        logger.warning("guardian.handle_regression failed: %s", exc)
        return {"status": "error", "reason": str(exc)[:200]}


async def _draft_follow_up(
    org_id: str,
    parent: dict[str, Any],
    *,
    issue_id: str,
    action: str,
    verify_detail: dict[str, Any] | None,
) -> dict[str, Any] | None:
    """Create the linked follow-up plan row (draft — human approves).

    For ``revert`` the plan carries the parent PR coordinates so the
    approve flow can call ``RepoProvider.revert`` without re-deriving
    them. For ``follow_up`` the plan re-points at the issue so the
    normal patch pipeline re-drafts a fix with the regression evidence
    attached.
    """
    from eden.improvement import plans_repo

    parent_id = str(parent["id"])
    parent_title = str(parent.get("title") or "improvement plan")
    if action == "revert":
        title = f"Revert: {parent_title[:100]}"
        summary = (
            "Post-merge verify failed — Eden drafted a revert of "
            f"PR {parent.get('pr_url') or parent.get('pr_number')}. "
            "Approve to open the revert PR."
        )
    else:
        title = f"Follow-up fix: {parent_title[:100]}"
        summary = (
            "Post-merge verify failed after the original fix landed. "
            "Eden drafted a follow-up patch with the regression evidence."
        )

    evidence = {
        "issue_id": issue_id,
        "guardian_action": action,
        "parent_plan_id": parent_id,
        "parent_pr_url": parent.get("pr_url"),
        "parent_pr_number": parent.get("pr_number"),
        "parent_github_branch": parent.get("github_branch"),
        "verify": verify_detail or {},
    }
    return await plans_repo.create_plan(
        org_id,
        plan_kind="code_patch",
        title=title,
        agent_id=(str(parent.get("agent_id") or "").strip() or None),
        summary=summary,
        # Distinct fingerprint so the dedup index doesn't treat the
        # follow-up as the parent's still-open draft.
        source_ref=f"issue:{issue_id}",
        source_fingerprint=f"guardian:{parent_id}:{action}",
        evidence=evidence,
        triage_snapshot=parent.get("triage_snapshot"),
        parent_plan_id=parent_id,
    )


__all__ = ["handle_regression"]
