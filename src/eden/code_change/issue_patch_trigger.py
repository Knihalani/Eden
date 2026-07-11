"""Issue → autonomous patch trigger (N20, Wave 6).

Bridges the closed-loop (F46) to the Cat 23 patch pipeline: when the
orchestrator decides an issue warrants a code fix (and the N22 policy
permits it), it calls :func:`propose_patch_for_issue`, which drives
``PatchGenerator.generate(rca_id=issue_id, ...)`` and leaves the diff in
the ``proposed_patches`` inbox for human review (or auto-PR when
``auto_pr_enabled``).

The master ``code_change_enabled`` switch is a hard gate — this refuses
to generate anything when it is off, mirroring the propose route and the
scheduler. All failures are swallowed to a structured dict so the loop
never crashes on a missing patch substrate.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)


def _code_change_enabled() -> bool:
    try:
        from eden.config import get_settings

        return bool(getattr(get_settings(), "code_change_enabled", False))
    except Exception:
        return False


async def _issue_context(org_id: str, issue_id: str) -> dict[str, Any] | None:
    """Load the issue for RCA grounding (title, kind, triage summary)."""
    try:
        from eden.issues.repo import IssuesRepo

        issue = await IssuesRepo().get_issue(org_id, issue_id)
    except Exception as exc:
        logger.debug("issue_patch_trigger: load issue failed: %s", exc)
        return None
    if issue is None:
        return None
    triage = issue.triage_result or {}
    summary = triage.get("summary") or triage.get("root_cause") or issue.title
    return {
        "agent_id": issue.agent_id or "",
        "kind": issue.kind,
        "rca_summary": (
            f"Issue {issue.fingerprint} ({issue.kind}): {issue.title}. "
            f"Root-cause: {summary}. Seen {issue.stumble_count}x across "
            f"{issue.user_count} user(s)."
        ),
    }


async def propose_patch_for_issue(
    org_id: str, issue_id: str
) -> dict[str, Any]:
    """Generate a proposed patch for an issue (N20).

    Returns ``{"status": ..., "patch_id"?, "reason"?}``. Never raises.
    """
    if not _code_change_enabled():
        return {"status": "disabled", "reason": "code_change_enabled=false"}

    ctx = await _issue_context(org_id, issue_id)
    if ctx is None:
        return {"status": "not_found", "reason": f"issue {issue_id!r} not found"}

    try:
        from eden.code_change.patch_generator import PatchGenerator

        rca_id = f"iss_{issue_id}"
        result = await PatchGenerator().generate(
            org_id=org_id,
            rca_id=rca_id,
            trace_id=rca_id,
            repo_id=ctx["agent_id"],
            rca_summary=ctx["rca_summary"],
            test_plan=[],
            linked_files=[],
        )
    except Exception as exc:
        logger.warning(
            "issue_patch_trigger: generate failed for issue %s: %s",
            issue_id,
            exc,
        )
        return {"status": "error", "reason": str(exc)}

    data = result.get("data", {}) if isinstance(result, dict) else {}
    return {
        "status": "proposed",
        "patch_id": data.get("patch_id"),
        "patch_status": data.get("status"),
        "cost_usd": data.get("cost_usd"),
        "issue_id": issue_id,
    }


async def propose_patch_for_action(
    org_id: str, action: dict[str, Any]
) -> dict[str, Any]:
    """Adapter for ``closed_loop_executor._dispatch_side_effect``.

    Resolves the issue id from the action payload/target and delegates to
    :func:`propose_patch_for_issue`.
    """
    payload = action.get("payload") or {}
    issue_id = None
    if isinstance(payload, dict):
        issue_id = payload.get("issue_id")
    issue_id = issue_id or action.get("target")
    if not issue_id:
        return {"status": "no_target", "reason": "action has no issue_id/target"}
    return await propose_patch_for_issue(org_id, str(issue_id))
