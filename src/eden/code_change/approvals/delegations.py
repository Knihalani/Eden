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

Gate 4a: persists delegations to ``approval_delegations`` and reads
live data. Active means ``revoked_at IS NULL AND NOW() BETWEEN starts_at AND ends_at``.
"""

from __future__ import annotations

import logging
from typing import Any

from .._common import _insert_row, _new_id, _ok_envelope, _select_rows

logger = logging.getLogger(__name__)


class ApprovalDelegationService:
    """Out-of-office approval delegations."""

    name = "approval_delegation"

    async def list_delegations(self, org_id: str) -> dict[str, Any]:
        """List active delegations from ``approval_delegations``."""
        rows = await _select_rows(
            org_id,
            "approval_delegations",
            where="revoked_at IS NULL AND ends_at > NOW()",
            order_by="created_at DESC",
        )
        delegations = [
            {
                "delegation_id": r.get("id"),
                "delegator_user_id": r.get("delegator_user_id"),
                "delegate_user_id": r.get("delegate_user_id"),
                "starts_at": str(r.get("starts_at") or ""),
                "ends_at": str(r.get("ends_at") or ""),
                "scope_filter": r.get("scope_filter", ""),
                "created_at": str(r.get("created_at") or ""),
            }
            for r in rows
        ]
        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "delegations": delegations,
                "count": len(delegations),
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
        """Persist a new delegation to ``approval_delegations``."""
        delegation_id = _new_id("del")
        await _insert_row(
            org_id,
            "approval_delegations",
            ["id", "delegator_user_id", "delegate_user_id", "starts_at", "ends_at", "scope_filter"],
            [delegation_id, delegator_user_id, delegate_user_id, starts_at, ends_at, scope_filter],
        )
        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "delegation_id": delegation_id,
                "delegator_user_id": delegator_user_id,
                "delegate_user_id": delegate_user_id,
                "starts_at": starts_at,
                "ends_at": ends_at,
                "scope_filter": scope_filter,
            },
        )


async def get_delegation_source(
    org_id: str, delegate_user_id: str
) -> str | None:
    """Return the delegator_user_id if ``delegate_user_id`` has an active delegation.

    Returns ``None`` when no active delegation exists. Delegation is active when
    ``revoked_at IS NULL AND NOW() BETWEEN starts_at AND ends_at``.
    """
    rows = await _select_rows(
        org_id,
        "approval_delegations",
        where="delegate_user_id = $2 AND revoked_at IS NULL AND starts_at <= NOW() AND ends_at > NOW()",
        params=(delegate_user_id,),
        limit=1,
    )
    if rows:
        return str(rows[0].get("delegator_user_id") or "")
    return None
