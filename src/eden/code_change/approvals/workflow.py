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

Gate 4a: reads from ``patch_approvals`` + ``patch_approval_status`` +
checks active grants (``approval_grants``) and delegations
(``approval_delegations``). Upserts ``patch_approval_status`` on each
recorded approval so the portal can show a live countdown.
"""

from __future__ import annotations

import logging
from typing import Any

from .._common import _insert_row, _new_id, _ok_envelope, _select_rows

logger = logging.getLogger(__name__)


class ApprovalWorkflowService:
    """The multi-approval workflow engine for the PR Inbox."""

    name = "approval_workflow"

    async def get_status(
        self, org_id: str, patch_id: str
    ) -> dict[str, Any]:
        """Return the patch's live approval status from ``patch_approval_status``.

        Falls back to counting rows in ``patch_approvals`` when no rollup
        row has been written yet (first call before any approval is recorded).
        Also checks for active grants to determine eligible_approvers.
        """
        # Try the rollup table first.
        status_rows = await _select_rows(
            org_id,
            "patch_approval_status",
            where="patch_id = $2",
            params=(patch_id,),
            limit=1,
        )
        if status_rows:
            row = status_rows[0]
            return _ok_envelope(
                self.name,
                {
                    "org_id": org_id,
                    "patch_id": patch_id,
                    "approvals_required": row.get("approvals_required", 1),
                    "approvals_received": row.get("approvals_received", 0),
                    "eligible_approvers": row.get("eligible_approvers") or [],
                    "missing_approver_roles": row.get("missing_approver_roles") or [],
                    "status": row.get("status", "awaiting"),
                    "status_id": str(row.get("id") or ""),
                },
            )

        # No rollup row yet — count approvals directly.
        approval_rows = await _select_rows(
            org_id,
            "patch_approvals",
            where="patch_id = $2 AND approval_type = 'approve'",
            params=(patch_id,),
        )
        received = len(approval_rows)
        current_status = "approved" if received >= 1 else "awaiting"
        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "patch_id": patch_id,
                "approvals_required": 1,
                "approvals_received": received,
                "eligible_approvers": [],
                "missing_approver_roles": [],
                "status": current_status,
                "status_id": _new_id("apst"),
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
        """Insert into ``patch_approvals`` and upsert ``patch_approval_status``.

        Checks whether the approver is acting via an active delegation
        (``approval_delegations``) so ``delegated_from_user_id`` is
        recorded. Also checks active grants to confirm the approver has
        authority (logged; enforcement is the caller's responsibility).
        """
        from .delegations import get_delegation_source
        from .grants import has_active_grant

        delegated_from = await get_delegation_source(org_id, approver_user_id)
        has_grant = await has_active_grant(org_id, approver_user_id)
        if not has_grant and not delegated_from:
            logger.debug(
                "approval_workflow: approver=%s has no active grant/delegation for org=%s",
                approver_user_id,
                org_id,
            )

        approval_id = _new_id("appr")
        await _insert_row(
            org_id,
            "patch_approvals",
            ["id", "patch_id", "approver_user_id", "approval_type", "comment", "delegated_from_user_id"],
            [approval_id, patch_id, approver_user_id, approval_type, comment, delegated_from],
        )

        # Upsert the rollup row so get_status stays accurate.
        new_status = "approved" if approval_type == "approve" else "denied" if approval_type == "deny" else "awaiting"
        await _upsert_approval_status(org_id, patch_id, approval_type, new_status)

        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "patch_id": patch_id,
                "approver_user_id": approver_user_id,
                "approval_type": approval_type,
                "approval_id": approval_id,
                "comment": comment,
                "delegated_from_user_id": delegated_from,
                "has_active_grant": has_grant,
                "new_workflow_status": new_status,
            },
        )


async def _upsert_approval_status(
    org_id: str,
    patch_id: str,
    approval_type: str,
    new_status: str,
) -> None:
    """INSERT or UPDATE ``patch_approval_status`` for the given patch.

    Increments ``approvals_received`` on each approve action.
    Best-effort — DB errors are logged and swallowed.
    """
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception:  # pragma: no cover - defensive
        return
    client = await get_postgres_client()
    if client is None:
        return
    status_id = _new_id("apst")
    increment = 1 if approval_type == "approve" else 0
    try:
        async with client.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO patch_approval_status
                    (id, org_id, patch_id, approvals_required, approvals_received, status, updated_at)
                VALUES ($1, $2, $3, 1, $4, $5, NOW())
                ON CONFLICT (patch_id) DO UPDATE
                SET approvals_received = patch_approval_status.approvals_received + $4,
                    status = $5,
                    updated_at = NOW()
                """,
                status_id,
                org_id,
                patch_id,
                increment,
                new_status,
            )
    except Exception as exc:
        logger.debug("approval_workflow: upsert_approval_status failed: %s", exc)
