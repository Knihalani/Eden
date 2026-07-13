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

Gate 4a: persists grants to ``approval_grants`` and reads live data.
"""

from __future__ import annotations

import logging
from typing import Any

from .._common import _error_envelope, _insert_row, _new_id, _ok_envelope, _select_rows

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
        """List the org's approval grants from ``approval_grants``."""
        where = "" if include_revoked else "revoked_at IS NULL"
        rows = await _select_rows(
            org_id,
            "approval_grants",
            where=where,
            order_by="created_at DESC",
        )
        grants = [
            {
                "grant_id": r.get("id"),
                "granted_user_id": r.get("granted_user_id"),
                "granted_by_user_id": r.get("granted_by_user_id"),
                "scope_type": r.get("scope_type"),
                "scope_value": r.get("scope_value"),
                "reason": r.get("reason", ""),
                "expires_at": str(r["expires_at"]) if r.get("expires_at") else None,
                "created_at": str(r.get("created_at") or ""),
                "revoked_at": str(r["revoked_at"]) if r.get("revoked_at") else None,
                "revoked_by_user_id": r.get("revoked_by_user_id"),
            }
            for r in rows
        ]
        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "include_revoked": include_revoked,
                "grants": grants,
                "count": len(grants),
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
        """Persist a new approval grant to ``approval_grants``."""
        if scope_type not in GRANT_SCOPE_TYPES:
            return _error_envelope(
                self.name,
                message=f"unknown scope_type: {scope_type!r}",
                error_code="invalid_scope_type",
                data={"valid_scope_types": sorted(GRANT_SCOPE_TYPES)},
            )
        grant_id = _new_id("grant")
        await _insert_row(
            org_id,
            "approval_grants",
            ["id", "granted_user_id", "granted_by_user_id", "scope_type", "scope_value", "reason", "expires_at"],
            [grant_id, granted_user_id, granted_by_user_id, scope_type, scope_value, reason, expires_at or None],
        )
        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "grant_id": grant_id,
                "granted_user_id": granted_user_id,
                "granted_by_user_id": granted_by_user_id,
                "scope_type": scope_type,
                "scope_value": scope_value,
                "reason": reason,
                "expires_at": expires_at or None,
            },
        )

    async def revoke_grant(
        self, org_id: str, grant_id: str, revoked_by_user_id: str
    ) -> dict[str, Any]:
        """Set ``revoked_at`` on an ``approval_grants`` row."""
        revoked = await _revoke_grant_row(org_id, grant_id, revoked_by_user_id)
        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "grant_id": grant_id,
                "revoked": revoked,
                "revoked_by_user_id": revoked_by_user_id,
            },
        )


async def _revoke_grant_row(
    org_id: str, grant_id: str, revoked_by_user_id: str
) -> bool:
    """Set revoked_at + revoked_by_user_id on an approval_grants row.

    Returns ``True`` if a row was found and updated, ``False`` otherwise.
    Best-effort — DB errors return ``False``.
    """
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception:  # pragma: no cover - defensive
        return False
    client = await get_postgres_client()
    if client is None:
        return False
    try:
        async with client.acquire() as conn:
            result = await conn.execute(
                "UPDATE approval_grants "
                "SET revoked_at = NOW(), revoked_by_user_id = $3 "
                "WHERE org_id = $1 AND id = $2 AND revoked_at IS NULL",
                org_id,
                grant_id,
                revoked_by_user_id,
            )
        return result.endswith(" 1")
    except Exception as exc:
        logger.debug("approval_grants: revoke_grant_row failed: %s", exc)
        return False


async def has_active_grant(org_id: str, user_id: str) -> bool:
    """Return True if ``user_id`` has at least one non-expired, non-revoked grant."""
    rows = await _select_rows(
        org_id,
        "approval_grants",
        where="granted_user_id = $2 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())",
        params=(user_id,),
        limit=1,
    )
    return bool(rows)
