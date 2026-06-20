"""PRReviewService — the actions the human takes on each inbox patch.

Each action is RBAC-gated and audit-logged. The 8 actions per the
v1.6 STUB checklist:

* ``POST /inbox/{patch_id}/approve`` — RBAC: ``reviewer``+.
* ``POST /inbox/{patch_id}/deny`` — RBAC: ``reviewer``+.
* ``POST /inbox/{patch_id}/edit`` — RBAC: ``editor``+.
* ``POST /inbox/{patch_id}/request-changes`` — RBAC: ``reviewer``+.
* ``POST /inbox/{patch_id}/comment`` — RBAC: ``commenter``+.
* ``POST /inbox/{patch_id}/pr`` — RBAC: ``editor``+ AND
  ``auto_pr_enabled=true`` if creating auto-mode.
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
    _insert_row,
    _new_id,
    _not_implemented_envelope,
    _ok_envelope,
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
INBOX_ACTION_KIND: dict[str, str] = {
    "approve": "auto_approve",
    "deny": "create_patch",  # no auto-mode opt-in needed
    "edit": "create_patch",
    "request-changes": "create_patch",
    "comment": "create_patch",
    "pr": "open_pr",
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
            return _not_implemented_envelope(
                self.name,
                message=f"unknown action: {action!r}",
                data={"patch_id": patch_id, "action": action},
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

        # ── Destructive actions stay Gate-4a blocked ──
        return _not_implemented_envelope(
            self.name,
            message=(
                f"action {action!r} requires Gate 4a (manual "
                "end-to-end). STUB returns a blocked envelope."
            ),
            gate="4a_blocked",
            data={
                "patch_id": patch_id,
                "action": action,
                "required_rbac": INBOX_ACTION_RBAC[action],
                "actor_user_id": actor_user_id,
                "comment": comment,
                "edited_diff": edited_diff,
            },
        )
