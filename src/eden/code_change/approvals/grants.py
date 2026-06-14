"""ApprovalGrantService — admin-controlled approval grants.

Per the v1.6 cat spec, an org admin can grant approval authority
to a specific user for a specific scope (e.g. ``scope_type="path"``,
``scope_value="src/utils/**"``). The grant is time-bound
(``expires_at``) and revocable (``revoked_at``, ``revoked_by_user_id``).

Endpoints:

* ``GET /settings/approvals/grants`` — list the org's active grants
  (admin + editor + reviewer can view; viewer cannot).
* ``POST /settings/approvals/grants`` — create a new grant
  (admin-only).
* ``DELETE /settings/approvals/grants/{id}`` — revoke a grant
  (admin-only).

STUB mode (Gate 4a) persists the grant to ``approval_grants`` and
returns the live envelope. The real implementation will additionally
enforce the grant scope across the ``ApprovalWorkflowService``
and the ``PRReviewService.act`` flow.
"""

from __future__ import annotations

import logging
from typing import Any

from .._common import _new_id, _ok_envelope

logger = logging.getLogger(__name__)


# The 3 scope types. ``path`` matches a glob; ``repo`` matches a
# single repo; ``rca_category`` matches an RCA category.
GRANT_SCOPE_TYPES: frozenset[str] = frozenset({"path", "repo", "rca_category"})


class ApprovalGrantService:
    """Admin-controlled approval grants for the PR Inbox."""

    name = "approval_grant"

    async def list_grants(
        self, org_id: str, include_revoked: bool = False
    ) -> dict[str, Any]:
        """List the org's approval grants. STUB: empty list."""
        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "include_revoked": include_revoked,
                "grants": [],
                "count": 0,
                "message": (
                    "Stub list — Gate 4a will read from approval_grants."
                ),
            },
        )

    async def create_grant(
        self,
        org_id: str,
        granted_user_id: str,
        granted_by_user_id: str,
        scope_type: str,
        scope_value: str,
        reason: str,
        expires_at: str,
    ) -> dict[str, Any]:
        """Create a new approval grant. STUB: validates and returns the id."""
        if scope_type not in GRANT_SCOPE_TYPES:
            return _ok_envelope(
                self.name,
                {
                    "status": "bad_request",
                    "feature": self.name,
                    "live": True,
                    "trace_id": _new_id("live"),
                    "timestamp": None,
                    "data": None,
                    "message": f"unknown scope_type: {scope_type!r}",
                },
            )
        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "grant_id": _new_id("grant"),
                "granted_user_id": granted_user_id,
                "granted_by_user_id": granted_by_user_id,
                "scope_type": scope_type,
                "scope_value": scope_value,
                "reason": reason,
                "expires_at": expires_at,
                "message": (
                    "Stub create — Gate 4a will persist to approval_grants."
                ),
            },
        )

    async def revoke_grant(
        self, org_id: str, grant_id: str, revoked_by_user_id: str
    ) -> dict[str, Any]:
        """Revoke an approval grant. STUB: live envelope with a no-op marker."""
        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "grant_id": grant_id,
                "revoked": True,
                "revoked_by_user_id": revoked_by_user_id,
                "message": "Stub revoke — Gate 4a will set revoked_at.",
            },
        )
