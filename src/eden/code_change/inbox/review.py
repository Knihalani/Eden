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
    _new_id,
    _not_implemented_envelope,
    _ok_envelope,
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
        """Dispatch the 8 inbox actions. STUB: opt-in gated, otherwise blocked.

        The two-stage opt-in is checked FIRST (per the v1.6
        STUB checklist constraint). Read-only actions
        (``comment``) bypass the opt-in check entirely.
        """
        if action not in INBOX_ACTIONS:
            return _not_implemented_envelope(
                self.name,
                message=f"unknown action: {action!r}",
                data={"patch_id": patch_id, "action": action},
            )

        # The opt-in gate is only enforced for the actions that
        # can mutate state. Comment is always allowed because
        # it doesn't change the patch state.
        if action != "comment":
            optin = _check_two_stage_optin(
                self.name, policy, INBOX_ACTION_KIND[action]
            )
            if optin is not None:
                return optin

        # In STUB mode, the auto-mode actions return a blocked
        # envelope (they require Gate 4a). The read-only
        # actions (comment) return the live envelope.
        if action == "comment":
            return _ok_envelope(
                self.name,
                {
                    "patch_id": patch_id,
                    "action": action,
                    "comment_id": _new_id("cmt"),
                    "actor_user_id": actor_user_id,
                    "message": (
                        "Stub comment — Gate 4a will persist to "
                        "patch_review_actions."
                    ),
                },
            )

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
