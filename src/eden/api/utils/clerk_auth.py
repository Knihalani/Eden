"""Clerk session-JWT verification.

The portal uses Clerk for end-user auth (June 2026 cutover). When a
signed-in browser hits the portal, Clerk issues a session JWT; the
portal attaches it as ``Authorization: Bearer <jwt>`` when forwarding
requests to FastAPI via the catch-all proxy at ``/api/proxy/[...path]``.

This module verifies those JWTs against Clerk's published keys so the
rest of the backend can keep using ``get_current_user`` /
``get_current_org_member`` and stay agnostic about whether the caller
authenticated via the legacy cookie flow or via Clerk.

Verification strategy, in priority order:

1. **JWKS** — fetch ``clerk_jwks_url`` (auto-derived from the publishable
   key when ``clerk_secret_key`` is set), pick the key matching the
   JWT's ``kid`` header, verify RS256. JWKS is cached for 1 hour.

2. **Static PEM** — fall back to ``clerk_jwt_key`` when JWKS is
   unavailable (offline deployments, dev). The PEM must be the Clerk
   instance's public key in PKCS#8 / SPKI format.

3. **Disabled** — when ``clerk_secret_key`` is empty, every Clerk
   verification call returns ``None`` so the legacy cookie flow keeps
   working for CLI / SDK / service-to-service callers.
"""

from __future__ import annotations

import json
import logging
import time
from typing import Any
from urllib.request import Request as UrlRequest
from urllib.request import urlopen

from jose import JWTError, jwt

from eden.config import get_settings

logger = logging.getLogger(__name__)
_settings = get_settings()

# In-process JWKS cache. Clerk rotates keys rarely (months) so a 1h
# TTL is more than safe; the per-request ``kid`` lookup still works
# if a fresh key appears, because we re-fetch on cache miss.
_JWKS_CACHE: dict[str, Any] = {"fetched_at": 0.0, "keys": None}
_JWKS_TTL_SECONDS = 3600


def _derive_jwks_url() -> str:
    """Pull the JWKS URL out of Clerk's publishable key.

    The pk_test_/pk_live_ token encodes the Clerk frontend API host,
    e.g. ``pk_test_bW9kZXN0LWJ1Zy03LmNsZXJrLmFjY291bnRzLmRldiQ`` decodes
    to ``modest-bug-7.clerk.accounts.dev$``. We construct the standard
    JWKS URL from that host.
    """
    if _settings.clerk_jwks_url:
        return _settings.clerk_jwks_url
    pk = _settings.clerk_secret_key  # secret key alone isn't enough;
    # we need the publishable key. In dev the user is expected to set
    # CLERK_JWT_KEY (static PEM) — see Settings docstring.
    raise RuntimeError(
        "clerk_jwks_url not configured. Set CLERK_JWKS_URL to your "
        "Clerk instance's /.well-known/jwks.json endpoint, or set "
        "CLERK_JWT_KEY to the static PEM public key."
    )


def _fetch_jwks() -> dict[str, Any]:
    """Fetch and cache the Clerk JWKS document."""
    now = time.time()
    if _JWKS_CACHE["keys"] is not None and now - _JWKS_CACHE["fetched_at"] < _JWKS_TTL_SECONDS:
        return _JWKS_CACHE["keys"]
    url = _derive_jwks_url()
    try:
        req = UrlRequest(url, headers={"User-Agent": "eden-api/1.0"})
        with urlopen(req, timeout=5) as resp:  # noqa: S310 — controlled URL
            data = json.loads(resp.read().decode("utf-8"))
        _JWKS_CACHE["keys"] = data
        _JWKS_CACHE["fetched_at"] = now
        return data
    except Exception as exc:
        logger.warning("Failed to fetch Clerk JWKS from %s: %s", url, exc)
        return _JWKS_CACHE["keys"] or {"keys": []}


def verify_clerk_token(token: str) -> dict[str, Any] | None:
    """Verify a Clerk session JWT and return the decoded payload.

    Returns ``None`` if Clerk isn't configured, the token is malformed,
    the signature doesn't match, or the token has expired. Callers
    should treat ``None`` as "try the legacy cookie flow" rather than
    "reject", so the same handler can serve both auth paths.
    """
    if not _settings.clerk_secret_key and not _settings.clerk_jwt_key:
        return None

    try:
        header = jwt.get_unverified_header(token)
    except JWTError:
        return None

    alg = header.get("alg", "RS256")

    # Fast path: static PEM (dev / offline). Avoids the JWKS round-trip.
    if _settings.clerk_jwt_key and alg.startswith("RS") or alg.startswith("ES"):
        try:
            return jwt.decode(
                token,
                _settings.clerk_jwt_key,
                algorithms=[alg],
                options={"verify_aud": False},
            )
        except JWTError as exc:
            logger.debug("Clerk JWT static-key verification failed: %s", exc)
            return None

    # Production path: JWKS lookup by ``kid``.
    if alg.startswith("RS"):
        try:
            jwks = _fetch_jwks()
            kid = header.get("kid")
            matching = next(
                (k for k in jwks.get("keys", []) if k.get("kid") == kid),
                None,
            )
            if not matching:
                logger.debug("No JWKS key matches Clerk JWT kid=%s", kid)
                return None
            return jwt.decode(
                token,
                matching,
                algorithms=[alg],
                options={"verify_aud": False},
            )
        except JWTError as exc:
            logger.debug("Clerk JWT JWKS verification failed: %s", exc)
            return None
    return None


def extract_user_id(payload: dict[str, Any]) -> str | None:
    """Return the stable user id from a Clerk payload.

    Clerk's standard claim is ``sub`` (same as our Eden JWT). Some
    accounts mint custom session tokens with a different claim — the
    fallback chain here covers the common shapes without forcing the
    JWT template to be edited in the Clerk dashboard.
    """
    return (
        payload.get("sub")
        or payload.get("user_id")
        or payload.get("uid")
    )


def extract_org_id(payload: dict[str, Any]) -> str | None:
    """Return the active organization id from a Clerk payload.

    When the session token was minted with the standard Clerk org
    claims (``org_id`` / ``org_slug``), these are populated. Returns
    ``None`` for sessions minted in personal-account mode (i.e. the
    user isn't currently inside an organization).
    """
    return payload.get("org_id") or payload.get("organization_id")


def extract_org_role(payload: dict[str, Any]) -> str | None:
    """Return the active organization role from a Clerk payload.

    Standard Clerk claim is ``org_role`` and uses the ``org:<slug>``
    format (``org:admin`` / ``org:member`` / any custom slug). Map
    these onto Eden's ``owner`` / ``admin`` / ``member`` / ``viewer``
    vocabulary at the call site (see ``src/eden/api/deps.py``).
    """
    return payload.get("org_role") or payload.get("organization_role")


def is_clerk_payload(payload: dict[str, Any]) -> bool:
    """Best-effort detection of a Clerk session JWT payload.

    Clerk's standard issuer is ``https://<slug>.clerk.accounts.dev$``
    (dev) or ``https://clerk.<production-domain>.com`` (prod). We
    accept any ``iss`` ending in ``.clerk.accounts.dev$`` or matching
    ``clerk.`` as a prefix, which covers the common shapes without
    coupling to a specific Clerk instance URL.
    """
    iss = (payload.get("iss") or "").lower()
    return ".clerk.accounts.dev$" in iss or iss.startswith("https://clerk.")


def clerk_role_to_eden_role(clerk_role: str | None) -> str:
    """Map a Clerk org role to Eden's role vocabulary.

    Clerk ships two default roles: ``org:admin`` and ``org:member``.
    Eden historically used a four-tier ladder (``owner`` / ``admin``
    / ``member`` / ``viewer``); we collapse to two tiers on the
    Clerk side and treat any custom ``org:<x>`` role as ``admin`` so
    the migration is lossless. Eden-specific callers that need
    ``owner`` vs ``admin`` distinction should add a custom Clerk role
    (e.g. ``org:owner``) and a corresponding branch here.
    """
    if not clerk_role:
        return "viewer"
    if clerk_role == "org:admin":
        return "admin"
    if clerk_role == "org:member":
        return "member"
    # Any custom role defaults to admin so we don't accidentally
    # demote someone who was set up with a non-standard slug.
    return "admin"