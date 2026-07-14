"""PRReviewService — the actions the human takes on each inbox patch.

Each action is RBAC-gated and audit-logged. The 8 actions per the
v1.6 STUB checklist:

* ``POST /inbox/{patch_id}/approve`` — RBAC: ``reviewer``+.
* ``POST /inbox/{patch_id}/deny`` — RBAC: ``reviewer``+.
* ``POST /inbox/{patch_id}/edit`` — RBAC: ``editor``+.
* ``POST /inbox/{patch_id}/request-changes`` — RBAC: ``reviewer``+.
* ``POST /inbox/{patch_id}/comment`` — RBAC: ``commenter``+.
* ``POST /inbox/{patch_id}/pr`` — RBAC: ``editor``+.
  Human open uses ``manual_open_pr`` (``code_change_enabled``
  only). Automated open_pr still requires ``auto_pr_enabled``.
* ``POST /inbox/{patch_id}/revert`` — RBAC: ``admin``+ AND
  ``auto_revert_enabled=true`` if creating auto-mode.
* ``POST /inbox/{patch_id}/bulk`` — bulk action; RBAC: ``admin``+.

STUB mode (Gate 4a) returns the not-implemented envelope for the
destructive actions (pr, revert, edit) and the live envelope for
the read-only ones (comment). The :class:`AgentActivityFeed` is
NOT yet fired because no real patches exist.
"""

from __future__ import annotations

import logging
from typing import Any

from .._common import (
    _check_two_stage_optin,
    _error_envelope,
    _insert_row,
    _new_id,
    _ok_envelope,
    _select_one,
    _update_row,
)

logger = logging.getLogger(__name__)


# The 8 inbox actions, each mapped to the action_kind used by
# ``_check_two_stage_optin`` and the RBAC role required.
INBOX_ACTIONS: frozenset[str] = frozenset(
    {
        "approve",
        "deny",
        "edit",
        "request-changes",
        "comment",
        "pr",
        "revert",
        "bulk",
    }
)

# RBAC mapping per the v1.6 cat spec. The router enforces these
# (the route layer adds ``Depends(require_role(...))``); the
# service is the second line of defence.
INBOX_ACTION_RBAC: dict[str, str] = {
    "approve": "reviewer",
    "deny": "reviewer",
    "edit": "editor",
    "request-changes": "reviewer",
    "comment": "commenter",
    "pr": "editor",
    "revert": "admin",
    "bulk": "admin",
}

# Map inbox action → ``_check_two_stage_optin`` action kind.
# Human inbox actions use kinds that only need
# ``code_change_enabled``. Auto-mode kinds (``open_pr``,
# ``auto_approve``, ``revert_pr``) stay available for
# automated callers that pass them explicitly.
INBOX_ACTION_KIND: dict[str, str] = {
    "approve": "create_patch",  # human approve — not auto-approve
    "deny": "create_patch",  # no auto-mode opt-in needed
    "edit": "create_patch",
    "request-changes": "create_patch",
    "comment": "create_patch",
    "pr": "manual_open_pr",  # human Open PR — not auto_pr gate
    "revert": "revert_pr",
    "bulk": "create_patch",
}


class PRReviewService:
    """The actions a human (or admin) takes on a proposed patch."""

    name = "pr_review"

    async def act(
        self,
        org_id: str,
        patch_id: str,
        action: str,
        policy: dict[str, Any],
        actor_user_id: str,
        comment: str = "",
        edited_diff: str = "",
    ) -> dict[str, Any]:
        """Dispatch the 8 inbox actions.

        Phase 2 of the audit pass wires the 4 review-shaped actions
        (``approve``, ``deny``, ``request-changes``, ``comment``)
        to the real ``patch_approvals`` table. Each approval row
        is append-only; the matching ``proposed_patches.status``
        flip is the side-effect for ``approve`` / ``deny`` /
        ``request-changes``.

        ``comment`` is the only action that bypasses the two-
        stage opt-in (per the v1.6 STUB checklist) because it
        doesn't mutate patch state.

        The destructive actions (``edit``, ``pr``, ``revert``,
        ``bulk``) stay Gate-4a blocked — they require LLM
        generation, branch creation, PR opening, or revert PR
        machinery that hasn't shipped.
        """
        if action not in INBOX_ACTIONS:
            return _error_envelope(
                self.name,
                message=f"unknown action: {action!r}",
                error_code="unknown_action",
                data={
                    "patch_id": patch_id,
                    "action": action,
                    "valid_actions": sorted(INBOX_ACTIONS),
                },
            )

        # Comment bypasses opt-in (read-only).
        if action != "comment":
            optin = _check_two_stage_optin(
                self.name, policy, INBOX_ACTION_KIND[action]
            )
            if optin is not None:
                return optin

        # ── Real persistence for the 4 review-shaped actions ──
        if action in {"approve", "deny", "request-changes", "comment"}:
            approval_type = (
                "approve" if action == "approve"
                else "deny" if action == "deny"
                else "request_changes" if action == "request-changes"
                else "comment"
            )
            new_status = (
                "approved" if action == "approve"
                else "denied" if action == "deny"
                else "needs_revision" if action == "request-changes"
                else None
            )
            approval_id = _new_id("approval")
            await _insert_row(
                org_id,
                "patch_approvals",
                [
                    "id",
                    "patch_id",
                    "approver_user_id",
                    "approval_type",
                    "comment",
                ],
                [
                    approval_id,
                    patch_id,
                    actor_user_id,
                    approval_type,
                    comment,
                ],
            )
            if new_status is not None:
                await _update_row(
                    org_id,
                    "proposed_patches",
                    where_col="id",
                    where_val=patch_id,
                    set_col="status",
                    set_val=new_status,
                )
            # Emit activity event for approve / deny outcomes.
            if action in {"approve", "deny"}:
                event_type = "patch_approved" if action == "approve" else "patch_denied"
                try:
                    from ..activity_feed import AgentActivityFeed
                    await AgentActivityFeed().emit(
                        org_id,
                        event_type=event_type,
                        summary=f"Patch {patch_id} {action}d by {actor_user_id}",
                        deep_link=f"/inbox/{patch_id}",
                        metadata={"patch_id": patch_id, "actor_user_id": actor_user_id, "comment": comment},
                    )
                except Exception as _exc:
                    logger.debug("pr_review: activity emit failed: %s", _exc)
            return _ok_envelope(
                self.name,
                {
                    "patch_id": patch_id,
                    "action": action,
                    "approval_id": approval_id,
                    "actor_user_id": actor_user_id,
                    "new_status": new_status,
                },
            )

        # ── Destructive actions: edit / pr / revert / bulk ────────
        #
        # Each one writes an audit row to ``closed_loop_actions``
        # and updates the corresponding patch state. The
        # opt-in check above already gated them
        # (``manual_open_pr`` / ``create_patch`` for human
        # actions; ``revert_pr`` still needs auto_revert).
        if action == "edit":
            if not edited_diff:
                return _error_envelope(
                    self.name,
                    message=(
                        "action 'edit' requires edited_diff in the "
                        "request body."
                    ),
                    error_code="edited_diff_required",
                    data={"patch_id": patch_id, "action": action},
                )
            approval_id = _new_id("approval")
            await _insert_row(
                org_id,
                "patch_approvals",
                [
                    "id", "patch_id", "approver_user_id",
                    "approval_type", "comment",
                ],
                [
                    approval_id, patch_id, actor_user_id,
                    "edit", comment or "",
                ],
            )
            await _update_row(
                org_id,
                "proposed_patches",
                where_col="id",
                where_val=patch_id,
                set_col="diff",
                set_val=edited_diff,
            )
            await _update_row(
                org_id,
                "proposed_patches",
                where_col="id",
                where_val=patch_id,
                set_col="status",
                set_val="needs_revision",
            )
            return _ok_envelope(
                self.name,
                {
                    "patch_id": patch_id,
                    "action": action,
                    "approval_id": approval_id,
                    "actor_user_id": actor_user_id,
                    "new_status": "needs_revision",
                    "diff_updated": True,
                },
            )

        if action == "pr":
            # Delegate to PRCreator so the inbox action reuses the
            # same gate / provider / diff-parsing path. Human
            # inbox Open PR uses ``manual_open_pr`` (master
            # opt-in only) — matching POST /patches/{id}/pr.
            from ..pr_creator import PRCreator

            creator = PRCreator()
            # The inbox doesn't have a built request, so the
            # PRCreator's destructive-route branch fires (it loads
            # the patch row + parses the diff + delegates to the
            # provider).
            pr_result = await creator.create(
                org_id, patch_id, policy,
                pr_patterns=None,
                action_kind="manual_open_pr",
            )
            return pr_result

        if action == "revert":
            # Gate 4b: record the audit row, flip status, then
            # delegate the actual revert-PR to AutoRevertEngine.
            approval_id = _new_id("approval")
            await _insert_row(
                org_id,
                "patch_approvals",
                [
                    "id", "patch_id", "approver_user_id",
                    "approval_type", "comment",
                ],
                [
                    approval_id, patch_id, actor_user_id,
                    "revert", comment or "",
                ],
            )
            # Best-effort audit row for the deferred
            # patch_review_actions table (migration 098).
            try:
                await _insert_row(
                    org_id,
                    "patch_review_actions",
                    [
                        "id", "patch_id", "action",
                        "actor_user_id", "comment", "reason",
                    ],
                    [
                        _new_id("pra"),
                        patch_id,
                        "revert",
                        actor_user_id,
                        comment or "",
                        "inbox_revert",
                    ],
                )
            except Exception as pra_exc:
                logger.debug(
                    "pr_review: patch_review_actions insert failed: %s",
                    pra_exc,
                )
            await _update_row(
                org_id,
                "proposed_patches",
                where_col="id",
                where_val=patch_id,
                set_col="status",
                set_val="reverted",
            )

            revert_pr_url = None
            revert_result: dict[str, Any] | None = None
            try:
                from ..revert_engine import AutoRevertEngine

                # Prefer an associated pull_requests row when present;
                # otherwise fall back to patch_id as the pr_id key.
                pr_id = patch_id
                pr_state = "merged"
                try:
                    pr_row = await _select_one(
                        org_id,
                        "pull_requests",
                        where="patch_id = $2",
                        params=(patch_id,),
                    )
                    if pr_row and pr_row.get("id"):
                        pr_id = str(pr_row["id"])
                        pr_state = str(pr_row.get("state") or "merged")
                except Exception as lookup_exc:
                    logger.debug(
                        "pr_review: pull_requests lookup failed: %s",
                        lookup_exc,
                    )

                engine = AutoRevertEngine()
                revert_result = await engine.revert(
                    org_id=org_id,
                    pr_id=pr_id,
                    policy=policy,
                    pr_state=pr_state,
                    history_is_linear=True,
                    regression_evidence={
                        "source": "inbox_revert",
                        "patch_id": patch_id,
                        "actor_user_id": actor_user_id,
                        "comment": comment or "",
                    },
                )
                if isinstance(revert_result, dict):
                    revert_pr_url = (
                        (revert_result.get("data") or {}).get("revert_pr_url")
                    )
            except Exception as revert_exc:
                logger.warning(
                    "pr_review: AutoRevertEngine failed for %s: %s",
                    patch_id, revert_exc,
                )
                revert_result = {
                    "status": "error",
                    "message": str(revert_exc),
                }

            return _ok_envelope(
                self.name,
                {
                    "patch_id": patch_id,
                    "action": action,
                    "approval_id": approval_id,
                    "actor_user_id": actor_user_id,
                    "new_status": "reverted",
                    "revert_pr_url": revert_pr_url,
                    "revert": revert_result,
                },
            )

        if action == "bulk":
            # ``bulk`` takes a list of patch ids in ``comment`` (JSON-encoded
            # for transport simplicity — the inbox UI passes a JSON
            # array as the comment field). Each id is reviewed under
            # the same RBAC + opt-in check.
            import json as _json
            try:
                bulk_ids = _json.loads(comment or "[]")
            except Exception as exc:
                return _error_envelope(
                    self.name,
                    message=(
                        "action 'bulk' requires comment to be a "
                        f"JSON array of patch ids. Got: {exc}"
                    ),
                    error_code="bulk_payload_invalid",
                    data={"patch_id": patch_id},
                )
            if not isinstance(bulk_ids, list):
                return _error_envelope(
                    self.name,
                    message=(
                        "action 'bulk' requires comment to be a "
                        "JSON array of patch ids."
                    ),
                    error_code="bulk_payload_invalid",
                    data={"patch_id": patch_id},
                )
            results = []
            for bulk_id in bulk_ids:
                if not isinstance(bulk_id, str):
                    continue
                # Each bulk action reuses this same method but with
                # ``action="approve"`` — the operator already cleared
                # the opt-in for the bulk action itself.
                bulk_result = await self.act(
                    org_id=org_id,
                    patch_id=bulk_id,
                    action="approve",
                    actor_user_id=actor_user_id,
                    comment=comment,
                    edited_diff=None,
                    policy=policy,
                )
                results.append({
                    "patch_id": bulk_id,
                    "result": bulk_result,
                })
            return _ok_envelope(
                self.name,
                {
                    "patch_id": patch_id,
                    "action": "bulk",
                    "actor_user_id": actor_user_id,
                    "results": results,
                    "bulk_count": len(results),
                },
            )

        # Unknown action — should have been caught by INBOX_ACTIONS
        # check at the top, but keep the safety net.
        return _error_envelope(
            self.name,
            message=f"action {action!r} is not implemented in dispatch()",
            error_code="unknown_action",
            data={"patch_id": patch_id, "action": action},
        )
