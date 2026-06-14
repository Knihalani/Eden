"""ApprovalDelegationService — out-of-office approval delegations.

Per the v1.6 cat spec, an org member can delegate their approval
authority to another user for a specific time window
(``starts_at`` / ``ends_at``) with an optional ``scope_filter``
(e.g. only delegate for ``rca_category="rate_limiter"`` patches).

Endpoints:

* ``GET /settings/approvals/delegations`` — list the org's
  active delegations.
* ``POST /settings/approvals/delegations`` — create a new
  delegation (the delegator only; admins can create on behalf
  of any user).

STUB mode (Gate 4a) persists the delegation to
``approval_delegations`` and returns the live envelope. The real
implementation will additionally check the ``starts_at`` /
``ends_at`` window + the ``scope_filter`` + the
``revoked_at`` flag across the ``PRReviewService.act`` flow.
"""

from __future__ import annotations

import logging
from typing import Any

from .._common import _new_id, _ok_envelope

logger = logging.getLogger(__name__)


class ApprovalDelegationService:
    """Out-of-office approval delegations."""

    name = "approval_delegation"

    async def list_delegations(self, org_id: str) -> dict[str, Any]:
        """List the org's active delegations. STUB: empty list."""
        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "delegations": [],
                "count": 0,
                "message": (
                    "Stub list — Gate 4a will read from "
                    "approval_delegations."
                ),
            },
        )

    async def create_delegation(
        self,
        org_id: str,
        delegator_user_id: str,
        delegate_user_id: str,
        starts_at: str,
        ends_at: str,
        scope_filter: str = "",
    ) -> dict[str, Any]:
        """Create a new delegation. STUB: validates and returns the id."""
        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "delegation_id": _new_id("del"),
                "delegator_user_id": delegator_user_id,
                "delegate_user_id": delegate_user_id,
                "starts_at": starts_at,
                "ends_at": ends_at,
                "scope_filter": scope_filter,
                "message": (
                    "Stub create — Gate 4a will persist to "
                    "approval_delegations."
                ),
            },
        )
