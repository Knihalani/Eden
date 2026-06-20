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
import threading
import time
from typing import Any

import httpx

from jose import JWTError, jwt

from eden.config import get_settings

logger = logging.getLogger(__name__)
_settings = get_settings()

# In-process JWKS cache. Clerk rotates keys rarely (months) so a 1h
# TTL is more than safe; the per-request ``kid`` lookup still works
# if a fresh key appears, because we re-fetch on cache miss.
_JWKS_CACHE: dict[str, Any] = {"fetched_at": 0.0, "keys": None}
_JWKS_TTL_SECONDS = 3600
# Lock guards the read-modify-write on _JWKS_CACHE so concurrent
# first-call bursts don't stomp each other. Per-request cache hits
# stay lock-free via the TTL fast-path.
_JWKS_LOCK = threading.Lock()


def _derive_jwks_url() -> str | None:
    """Resolve the JWKS URL for the configured Clerk instance.

    Priority:
    1. ``CLERK_JWKS_URL`` — explicit override (recommended for
       production; matches what the Clerk dashboard shows under
       "Endpoints > Show endpoint URLs > JWT public key").
    2. Auto-derive from ``CLERK_PUBLISHABLE_KEY`` — the publishable key
       embeds the Clerk frontend-API host. ``pk_live_…$`` decodes
       (base64) to ``<frontend-api>$`` and the JWKS URL is
       ``https://<frontend-api>/.well-known/jwks.json``.
    3. ``None`` — neither configured. The caller treats this as
       "skip Clerk verification" and falls back to the legacy Eden
       cookie path, instead of crashing the request thread with
       ``RuntimeError`` like the previous implementation did.
    """
    if _settings.clerk_jwks_url:
        return _settings.clerk_jwks_url
    pk = _settings.clerk_publishable_key
    if pk and (pk.startswith("pk_test_") or pk.startswith("pk_live_")):
        # Strip the ``pk_{test,live}_`` prefix; the remainder is a
        # base64-encoded payload whose first (and only, for modern
        # keys) line is the frontend-API host + trailing ``$``.
        body = pk.split("_", 2)[-1]
        try:
            import base64
            # Pad to a multiple of 4 for base64 decoding.
            padded = body + "=" * (-len(body) % 4)
            decoded = base64.b64decode(padded).decode("utf-8", errors="ignore").strip()
            # Format: ``clerk.edenobservability.com$`` (prod) or
            # ``modest-bug-7.clerk.accounts.dev$`` (dev).
            host = decoded.rstrip("$").strip()
            if host:
                return f"https://{host}/.well-known/jwks.json"
        except Exception as exc:
            logger.debug("Failed to decode Clerk publishable key: %s", exc)
    logger.warning(
        "Clerk JWKS URL not configured and CLERK_PUBLISHABLE_KEY is "
        "missing or unparseable. Set CLERK_JWKS_URL to your Clerk "
        "instance's /.well-known/jwks.json endpoint, or set "
        "CLERK_JWT_KEY to the static PEM public key. Clerk verification "
        "is being skipped — only legacy Eden cookie auth will succeed."
    )
    return None


def _fetch_jwks() -> dict[str, Any]:
    """Fetch and cache the Clerk JWKS document."""
    now = time.time()
    # Fast path: cache hit, no lock needed.
    if _JWKS_CACHE["keys"] is not None and now - _JWKS_CACHE["fetched_at"] < _JWKS_TTL_SECONDS:
        return _JWKS_CACHE["keys"]
    # Slow path: take the lock so only one fetch happens at a time.
    with _JWKS_LOCK:
        # Re-check after acquiring the lock — another thread may
        # have refreshed while we were waiting.
        if _JWKS_CACHE["keys"] is not None and now - _JWKS_CACHE["fetched_at"] < _JWKS_TTL_SECONDS:
            return _JWKS_CACHE["keys"]
        url = _derive_jwks_url()
        if not url:
            # JWKS not configured — can't verify Clerk tokens. Return an
            # empty key set so the caller can short-circuit without
            # raising into a request thread.
            return {"keys": []}
        try:
            resp = httpx.get(url, timeout=5.0, headers={"User-Agent": "eden-api/1.0"})
            resp.raise_for_status()
            data = resp.json()
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
