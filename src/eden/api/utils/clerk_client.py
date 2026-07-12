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

import asyncio
import logging
import time
from typing import Any

import httpx

from eden.api.utils.redact import redact_all
from eden.config import get_settings

# Module-level singleton httpx client (mirrors the F42 pattern in
# ``eden.providers.pr``). The Clerk Backend SDK fires 2-3 requests
# per ``get_user`` / ``list_users`` call, so the keep-alive pool
# win is real for the portal's user-management pages.
_HTTPX: httpx.AsyncClient | None = None


def _shared_httpx(timeout: float) -> httpx.AsyncClient:
    global _HTTPX
    if _HTTPX is None or _HTTPX.is_closed:
        _HTTPX = httpx.AsyncClient(timeout=timeout)
    return _HTTPX

logger = logging.getLogger(__name__)

CLERK_API_BASE = "https://api.clerk.com/v1"

# In-process cache for ``get_user`` lookups. Eden's /auth/me auto-provision
# fires on every page load for a signed-in Clerk user whose session JWT
# doesn't carry the email claim; the default Clerk session token doesn't
# include email, so without this cache every /auth/me hit would round-trip
# to Clerk's Backend API. The cache is keyed on the Clerk user id, holds
# the full payload, and expires after ``_USER_CACHE_TTL_SECONDS`` so a
# profile change in Clerk propagates within minutes without an unbounded
# cache.
_USER_CACHE: dict[str, tuple[float, dict[str, Any]]] = {}
_USER_CACHE_TTL_SECONDS = 300.0  # 5 minutes — long enough to absorb page
                                  # navigations, short enough that a user
                                  # updating their email in Clerk sees the
                                  # change on their next visit.
_USER_CACHE_LOCK = asyncio.Lock()


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
    # IMPORTANT: do NOT ``async with`` the shared singleton — that
    # calls ``aclose()`` on exit and permanently bricks every later
    # Clerk call with ``RuntimeError: Cannot reopen a client
    # instance``. Mirror ``clerk_auth._get_http_client`` instead.
    try:
        client = _shared_httpx(timeout)
        response = await client.post(url, json=body, headers=headers)
    except httpx.TimeoutException as exc:
        raise ClerkAPIError(f"Clerk timeout: {path}") from exc
    except httpx.RequestError as exc:
        raise ClerkAPIError(f"Clerk network error: {path}: {exc}") from exc
    except RuntimeError as exc:
        # Closed / unusable singleton — reset and surface as ClerkAPIError
        # so callers (auto-provision) can fall back instead of 500ing.
        global _HTTPX
        _HTTPX = None
        raise ClerkAPIError(f"Clerk client error: {path}: {exc}") from exc

    if response.status_code < 200 or response.status_code >= 300:
        # Truncate the body so we never log a Clerk JWT or PII.
        raise ClerkAPIError(
            f"Clerk {response.status_code} on {path}: {response.text[:300]}"
        )
    return response.json()


async def _get(path: str, *, timeout: float = 5.0) -> dict[str, Any]:
    """GET Clerk Backend API and return the decoded body.

    Used by ``get_user`` to enrich the auto-provision path when the
    Clerk session JWT doesn't carry the email claim (the default
    Clerk session token only includes ``sub`` / ``iat`` / ``exp``).
    Failures raise ``ClerkAPIError`` so the caller can fall back
    gracefully.
    """
    import httpx

    settings = get_settings()
    if not settings.clerk_secret_key:
        raise ClerkAPIError("CLERK_SECRET_KEY not configured")

    url = f"{CLERK_API_BASE}{path}"
    headers = {
        "Authorization": f"Bearer {settings.clerk_secret_key}",
    }
    # See ``_post`` — never ``async with`` the shared client.
    try:
        client = _shared_httpx(timeout)
        response = await client.get(url, headers=headers)
    except httpx.TimeoutException as exc:
        raise ClerkAPIError(f"Clerk timeout: {path}") from exc
    except httpx.RequestError as exc:
        raise ClerkAPIError(f"Clerk network error: {path}: {exc}") from exc
    except RuntimeError as exc:
        global _HTTPX
        _HTTPX = None
        raise ClerkAPIError(f"Clerk client error: {path}: {exc}") from exc

    if response.status_code < 200 or response.status_code >= 300:
        raise ClerkAPIError(
            f"Clerk {response.status_code} on {path}: {response.text[:300]}"
        )
    return response.json()


async def get_user(clerk_id: str) -> dict[str, Any] | None:
    """Fetch a Clerk user by id (``user_2abc...``) and return the full
    record. Returns ``None`` if the user no longer exists in Clerk
    (deleted) or the API call fails — callers should treat both as
    "best effort, fall back to JWT claims only".

    The default Clerk session JWT does not include the ``email`` /
    ``first_name`` / ``last_name`` / ``image_url`` claims — those have
    to be either added to a JWT template in the Clerk dashboard or
    fetched from the Backend API. We prefer the API fetch on the
    auto-provision path because it needs zero Clerk-dashboard config
    and works the moment ``CLERK_SECRET_KEY`` is set (which it must
    be for the portal to verify Clerk session JWTs in the first place).

    Results are cached in-process for ``_USER_CACHE_TTL_SECONDS`` so the
    auto-provision hot path doesn't round-trip to Clerk on every page
    load. Negative results (``None``) are NOT cached — Clerk could be
    transiently unreachable and we don't want to lock in the failure.
    """
    if not clerk_id:
        return None
    # Fast path: cache hit, no lock needed.
    cached = _USER_CACHE.get(clerk_id)
    if cached is not None:
        expires_at, payload = cached
        if time.monotonic() < expires_at:
            return payload
    # Slow path: take the lock so concurrent first-call bursts don't
    # stampede the Clerk API. The lock is a per-event-loop asyncio
    # lock — multi-worker deployments each have their own cache, which
    # is fine (the API call is cheap; the cache is a perf optimisation,
    # not a correctness requirement).
    async with _USER_CACHE_LOCK:
        cached = _USER_CACHE.get(clerk_id)
        if cached is not None:
            expires_at, payload = cached
            if time.monotonic() < expires_at:
                return payload
        try:
            payload = await _get(f"/users/{clerk_id}")
        except ClerkAPIError as exc:
            # F70 — defensive redaction. ``ClerkAPIError`` on a 4xx
            # contains ``response.text[:300]`` which Clerk often fills
            # with the user's email + their internal id. Wrap the
            # ``exc`` through ``redact_all`` so neither leaks into our
            # log stream even if Clerk's error format changes.
            logger.warning(
                "get_user(%s) failed: %s",
                clerk_id,
                redact_all(str(exc)),
            )
            return None
        if payload is not None:
            _USER_CACHE[clerk_id] = (time.monotonic() + _USER_CACHE_TTL_SECONDS, payload)
        return payload


def invalidate_user_cache(clerk_id: str | None = None) -> None:
    """Clear a single cached user (or the whole cache if ``clerk_id`` is
    None). Useful from the webhook handler when a ``user.updated`` event
    arrives so the next /auth/me picks up the new email/name/avatar
    without waiting for the 5-minute TTL.
    """
    if clerk_id is None:
        _USER_CACHE.clear()
        return
    _USER_CACHE.pop(clerk_id, None)


def extract_user_profile(payload: dict[str, Any]) -> dict[str, str]:
    """Best-effort extraction of (email, name, avatar_url) from a Clerk
    user payload (the dict returned by ``get_user`` or the webhook
    ``user.created`` event). Returns empty strings for any field that
    isn't present so callers can pass the result straight into the
    ``users`` table without further null handling.
    """
    email = ""
    primary = payload.get("primary_email_address_id")
    for addr in payload.get("email_addresses", []) or []:
        if addr.get("id") == primary or not email:
            email = addr.get("email_address", "") or email
    first = payload.get("first_name") or ""
    last = payload.get("last_name") or ""
    full = (
        payload.get("full_name")
        or " ".join(p for p in (first, last) if p)
        or email.split("@")[0]
    )
    avatar = payload.get("image_url") or ""
    return {"email": email, "name": full, "avatar_url": avatar}


async def create_organization(name: str, slug: str) -> dict[str, Any]:
    """Create a Clerk org; returns the full org record (with ``id``).

    ``slug`` must match Clerk's slug regex (lowercase, dashes, digits).
    Callers slug via ``slugify()`` in ``src/eden/api/routes/orgs.py:31``.
    """
    return await _post("/organizations", {"name": name, "slug": slug})


async def get_organization(clerk_org_id: str) -> dict[str, Any] | None:
    """Fetch a Clerk organization by id (``org_2abc…``).

  Returns ``None`` when the org was deleted or the API call fails so
  callers can fall back without 500ing the request.
    """
    if not clerk_org_id:
        return None
    try:
        return await _get(f"/organizations/{clerk_org_id}")
    except ClerkAPIError as exc:
        logger.warning(
            "get_organization failed for %s: %s",
            clerk_org_id,
            redact_all(str(exc)),
        )
        return None


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
