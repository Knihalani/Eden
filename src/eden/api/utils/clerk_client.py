"""Thin async client for the Clerk Backend API.

Used to keep Eden's ``organizations`` table in lock-step with Clerk's
hosted org system. Two operations are exposed:

- ``create_organization`` — called from ``POST /orgs`` BEFORE writing
  the Eden row. Returns ``{"id": "org_2x...", ...}``.
- ``create_membership`` — called from ``accept_invitation()`` AFTER
  the local ``org_members`` insert. The matching
  ``organizationMembership.created`` webhook re-syncs the row
  idempotently, so this call does NOT write to Postgres.

The module follows the same async-httpx pattern used by
``src/eden/services/email_service.py`` (``async with httpx.AsyncClient()
as client:``) and the lazy-import pattern from
``src/eden/services/webhook_delivery.py``, so test suites can
``unittest.mock.patch`` the ``_post`` helper to avoid any real network.

Failure policy: callers MUST treat ``ClerkAPIError`` / timeouts as
non-fatal for the local write. We log a warning and let the row exist
without a ``clerk_org_id`` so the existing fallback path keeps working.
"""

from __future__ import annotations

import logging
from typing import Any

from eden.config import get_settings

logger = logging.getLogger(__name__)

CLERK_API_BASE = "https://api.clerk.com/v1"


class ClerkAPIError(RuntimeError):
    """Raised when Clerk Backend API returns non-2xx or times out."""


async def _post(path: str, body: dict[str, Any], *, timeout: float = 10.0) -> dict[str, Any]:
    """POST JSON to Clerk Backend API and return the decoded body.

    Single seam for tests — patch ``eden.api.utils.clerk_client._post``
    with an ``AsyncMock`` to cover both ``create_organization`` and
    ``create_membership`` with one mock.
    """
    # Lazy import keeps test imports cheap and matches
    # ``src/eden/services/email_service.py`` + ``webhook_delivery.py``.
    import httpx

    settings = get_settings()
    if not settings.clerk_secret_key:
        raise ClerkAPIError("CLERK_SECRET_KEY not configured")

    url = f"{CLERK_API_BASE}{path}"
    headers = {
        "Authorization": f"Bearer {settings.clerk_secret_key}",
        "Content-Type": "application/json",
    }
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(url, json=body, headers=headers)
    except httpx.TimeoutException as exc:
        raise ClerkAPIError(f"Clerk timeout: {path}") from exc
    except httpx.RequestError as exc:
        raise ClerkAPIError(f"Clerk network error: {path}: {exc}") from exc

    if response.status_code < 200 or response.status_code >= 300:
        # Truncate the body so we never log a Clerk JWT or PII.
        raise ClerkAPIError(
            f"Clerk {response.status_code} on {path}: {response.text[:300]}"
        )
    return response.json()


async def create_organization(name: str, slug: str) -> dict[str, Any]:
    """Create a Clerk org; returns the full org record (with ``id``).

    ``slug`` must match Clerk's slug regex (lowercase, dashes, digits).
    Callers slug via ``slugify()`` in ``src/eden/api/routes/orgs.py:31``.
    """
    return await _post("/organizations", {"name": name, "slug": slug})


async def create_membership(clerk_org_id: str, user_id: str, role: str) -> dict[str, Any]:
    """Add a user to a Clerk org; returns the membership record.

    ``role`` is Clerk's ``org:<slug>`` format (``org:admin`` /
    ``org:member``); Eden's role vocabulary is mapped at the call site
    by ``_eden_role_to_clerk_role``.
    """
    clerk_role = _eden_role_to_clerk_role(role)
    return await _post(
        f"/organizations/{clerk_org_id}/memberships",
        {"user_id": user_id, "role": clerk_role},
    )


def _eden_role_to_clerk_role(eden_role: str) -> str:
    """Map Eden's role vocabulary to Clerk's ``org:<slug>`` strings.

    Mirrors the inverse of ``clerk_role_to_eden_role`` in
    ``src/eden/api/utils/clerk_auth.py``. Owner → admin (Clerk's
    defaults lack ``org:owner``; the ``owner`` status is tracked on
    ``organizations.owner_id`` and re-applied if/when we add a custom
    role). Viewer collapses to ``org:member`` — Clerk's RBAC doesn't
    ship a read-only default membership role, so we keep both
    ``member`` and ``viewer`` as standard members and surface the
    distinction on the Eden row.
    """
    if eden_role in ("owner", "admin"):
        return "org:admin"
    return "org:member"


async def resolve_clerk_org_id(client, eden_org_id: str) -> str | None:
    """Return the Clerk org id for an Eden org, or ``None``.

    Backward-compat shim: rows created via the webhook have
    ``clerk_org_id IS NULL`` but ``id`` IS the Clerk id. New rows
    have ``clerk_org_id`` populated and ``id`` is an Eden UUID.
    Callers that need to talk to Clerk Backend API always use this
    helper.
    """
    row = await client.fetchrow(
        "SELECT COALESCE(clerk_org_id, id::text) AS clerk_org_id "
        "FROM organizations WHERE id = $1",
        eden_org_id,
    )
    return str(row["clerk_org_id"]) if row else None
