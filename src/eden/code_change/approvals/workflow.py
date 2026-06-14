"""ApprovalWorkflowService — the multi-approval workflow engine.

Per the v1.6 cat spec, the workflow supports:

* ``min_approvals`` (default 1)
* ``prevent_self_approval`` (default true)
* ``require_security_for_protected_paths`` (default true)
* ``approval_path_rules`` — list of
  ``{path_glob, required_approver_roles, min_approvals}``
* ``default_required_approver_roles`` (default [])
* ``auto_approve_paths`` (default ``["**/*.md", "**/CHANGELOG.md"]``)
* ``approval_timeout_hours`` (default 72)

The service is queried by the ``PRReviewService.approve`` flow
to determine if the patch has enough approvals + the right
approver roles to be merged.

STUB mode (Gate 4a) returns a deterministic approval-status
response derived from the patch metadata. The real implementation
will read from ``patch_approvals`` + ``patch_approval_status`` +
``approval_grants`` + ``approval_delegations``.
"""

from __future__ import annotations

import logging
from typing import Any

from .._common import _new_id, _ok_envelope

logger = logging.getLogger(__name__)


class ApprovalWorkflowService:
    """The multi-approval workflow engine for the PR Inbox."""

    name = "approval_workflow"

    async def get_status(
        self, org_id: str, patch_id: str
    ) -> dict[str, Any]:
        """Return the patch's approval status. STUB: zero approvals."""
        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "patch_id": patch_id,
                "approvals_required": 1,
                "approvals_received": 0,
                "eligible_approvers": [],
                "missing_approver_roles": [],
                "status": "awaiting_approval",
                "status_id": _new_id("apst"),
                "message": (
                    "Stub status — Gate 4a will read from "
                    "patch_approvals + patch_approval_status."
                ),
            },
        )

    async def record_approval(
        self,
        org_id: str,
        patch_id: str,
        approver_user_id: str,
        approval_type: str,
        comment: str = "",
    ) -> dict[str, Any]:
        """Record an approval. STUB: live envelope with the new approval id."""
        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "patch_id": patch_id,
                "approver_user_id": approver_user_id,
                "approval_type": approval_type,
                "approval_id": _new_id("appr"),
                "comment": comment,
                "message": (
                    "Stub record — Gate 4a will insert into "
                    "patch_approvals and re-evaluate the workflow."
                ),
            },
        )
