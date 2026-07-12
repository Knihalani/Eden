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

B-6 (Session 23): ``_fetch_jwks`` and ``verify_clerk_token`` are async;
the JWKS lock is ``asyncio.Lock``. Pre-fix the JWKS fetch blocked the
event loop on a sync ``httpx.get`` while holding ``threading.Lock``,
which meant a single 5 s timeout stalled every concurrent request on
the same worker.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

import httpx
import jwt
from jwt import InvalidTokenError as JWTError
from jwt.api_jwk import PyJWK

from eden.api.utils.redact import redact_all
from eden.config import get_settings

logger = logging.getLogger(__name__)
_settings = get_settings()

# In-process JWKS cache. Clerk rotates keys rarely (months) so a 1h
# TTL is more than safe; the per-request ``kid`` lookup still works
# if a fresh key appears, because we re-fetch on cache miss.
_JWKS_CACHE: dict[str, Any] = {"fetched_at": 0.0, "keys": None}
_JWKS_TTL_SECONDS = 3600
# B-6 (Session 23): use ``asyncio.Lock`` so a slow httpx fetch doesn't
# block the event loop or starve other coroutines waiting on the lock.
_JWKS_LOCK = asyncio.Lock()
# Shared async HTTP client. ``verify_clerk_token`` is awaited many
# times per request lifecycle (one per Clerk-protected endpoint), and
# creating a fresh AsyncClient per call paid the TLS handshake cost
# each time. Created lazily so importing this module in offline tests
# (which never call ``verify_clerk_token``) doesn't open a real socket.
_HTTP_CLIENT: httpx.AsyncClient | None = None


def _get_http_client() -> httpx.AsyncClient:
    global _HTTP_CLIENT
    if _HTTP_CLIENT is None:
        _HTTP_CLIENT = httpx.AsyncClient(
            timeout=httpx.Timeout(5.0, connect=5.0, read=5.0, write=5.0),
            headers={"User-Agent": "eden-api/1.0"},
        )
    return _HTTP_CLIENT


async def shutdown_clerk_auth() -> None:
    """Close the shared ``httpx.AsyncClient``.

    Called from the FastAPI lifespan on shutdown so the underlying
    SSL transport + connection pool are released cleanly. Pre-fix
    the module-global ``_HTTP_CLIENT`` was created lazily and never
    closed, leaking open sockets and HTTP/2 connection-pool
    resources on every pod restart. Safe to call multiple times.
    """
    global _HTTP_CLIENT
    client = _HTTP_CLIENT
    if client is None:
        return
    try:
        await client.aclose()
    except Exception as exc:  # pragma: no cover - defensive
        # Surface as debug, not error: shutdown should never crash
        # the process over a socket close.
        logger.debug("clerk_auth httpx client close failed: %s", redact_all(str(exc)))
    _HTTP_CLIENT = None


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
            logger.debug("Failed to decode Clerk publishable key: %s", redact_all(str(exc)))
    logger.warning(
        "Clerk JWKS URL not configured and CLERK_PUBLISHABLE_KEY is "
        "missing or unparseable. Set CLERK_JWKS_URL to your Clerk "
        "instance's /.well-known/jwks.json endpoint, or set "
        "CLERK_JWT_KEY to the static PEM public key. Clerk verification "
        "is being skipped — only legacy Eden cookie auth will succeed."
    )
    return None


async def _fetch_jwks() -> dict[str, Any]:
    """Fetch and cache the Clerk JWKS document.

    B-6 (Session 23): now async so the 5 s ``httpx`` round-trip
    doesn't block the event loop. Uses ``asyncio.Lock`` to serialize
    cache fills — a stampede of concurrent first-calls shares one
    upstream request instead of issuing N parallel ones.
    """
    now = time.time()
    # Fast path: cache hit, no lock needed.
    if _JWKS_CACHE["keys"] is not None and now - _JWKS_CACHE["fetched_at"] < _JWKS_TTL_SECONDS:
        return _JWKS_CACHE["keys"]
    # Slow path: take the lock so only one fetch happens at a time.
    async with _JWKS_LOCK:
        # Re-check after acquiring the lock — another coroutine may
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
            client = _get_http_client()
            resp = await client.get(url)
            resp.raise_for_status()
            data = resp.json()
            _JWKS_CACHE["keys"] = data
            _JWKS_CACHE["fetched_at"] = now
            return data
        except Exception as exc:
            logger.warning("Failed to fetch Clerk JWKS from %s: %s", url, redact_all(str(exc)))
            return _JWKS_CACHE["keys"] or {"keys": []}


def _public_key_from_jwk(jwk: dict[str, Any]) -> Any:
    """Convert a JWKS key entry to the object ``jwt.decode`` expects.

    PyJWT 2.13+ no longer accepts a raw JWK dict as ``jwt.decode``'s
    key argument — passing one raises ``TypeError: Expecting a
    PEM-formatted key`` and 500'd every authenticated portal request.
    """
    return PyJWK.from_dict(jwk).key


async def verify_clerk_token(token: str) -> dict[str, Any] | None:
    """Verify a Clerk session JWT and return the decoded payload.

    Returns ``None`` if Clerk isn't configured, the token is malformed,
    the signature doesn't match, or the token has expired. Callers
    should treat ``None`` as "try the legacy cookie flow" rather than
    "reject", so the same handler can serve both auth paths.

    B-6 (Session 23): now ``async`` so the production JWKS path
    (``_fetch_jwks``) can perform an async httpx round-trip without
    stalling the event loop. Production callers (``deps._resolve_token_payload``
    and ``websocket._authenticate_ws``) now await this function.
    """
    if not _settings.clerk_secret_key and not _settings.clerk_jwt_key:
        return None

    try:
        header = jwt.get_unverified_header(token)
    except JWTError:
        return None

    alg = header.get("alg", "RS256")

    # Fast path: static PEM (dev / offline). Avoids the JWKS round-trip.
    if _settings.clerk_jwt_key and (
        alg.startswith("RS") or alg.startswith("ES")
    ):
        try:
            return jwt.decode(
                token,
                _settings.clerk_jwt_key,
                algorithms=[alg],
                options={"verify_aud": False},
            )
        except JWTError as exc:
            logger.debug("Clerk JWT static-key verification failed: %s", redact_all(str(exc)))
            return None

    # Production path: JWKS lookup by ``kid``.
    if alg.startswith("RS"):
        try:
            jwks = await _fetch_jwks()
            kid = header.get("kid")
            matching = next(
                (k for k in jwks.get("keys", []) if k.get("kid") == kid),
                None,
            )
            if not matching:
                # ``kid`` miss means Clerk rotated keys since we
                # cached the JWKS. Force a fresh fetch (under the
                # lock so we don't stampede) before giving up —
                # otherwise a rotation produces a 1-hour auth
                # outage even though the new public key is
                # already published.
                logger.info(
                    "Clerk JWT kid=%s not in cached JWKS; "
                    "forcing fresh fetch",
                    kid,
                )
                async with _JWKS_LOCK:
                    _JWKS_CACHE["fetched_at"] = 0.0
                jwks = await _fetch_jwks()
                matching = next(
                    (k for k in jwks.get("keys", []) if k.get("kid") == kid),
                    None,
                )
                if not matching:
                    logger.debug(
                        "Clerk JWT kid=%s still missing after JWKS "
                        "refresh; rejecting",
                        kid,
                    )
                    return None
            return jwt.decode(
                token,
                _public_key_from_jwk(matching),
                algorithms=[alg],
                options={"verify_aud": False},
            )
        except (JWTError, TypeError, ValueError) as exc:
            logger.debug("Clerk JWT JWKS verification failed: %s", redact_all(str(exc)))
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

    Clerk's default session JWT uses the abbreviated ``o: {id, rol,
    slg}`` shape (single-letter keys to keep the token small). The
    long-form ``org_id`` / ``organization_id`` claims only appear
    when the Clerk dashboard has a custom session JWT template
    configured. We accept both shapes so the backend works against
    the out-of-the-box Clerk session shape AND against custom
    templates, without forcing the operator to configure a JWT
    template just to make /orgs resolve.

    Returns ``None`` for sessions minted in personal-account mode
    (i.e. the user isn't currently inside an organization).
    """
    # Abbreviated default: ``o.id``
    org_claim = payload.get("o")
    if isinstance(org_claim, dict):
        oid = org_claim.get("id")
        if oid:
            return oid
    # Custom JWT template: ``org_id`` / ``organization_id``
    return payload.get("org_id") or payload.get("organization_id")


def extract_org_role(payload: dict[str, Any]) -> str | None:
    """Return the active organization role from a Clerk payload.

    Standard Clerk default is the abbreviated ``o.rol`` field. A
    custom JWT template can surface the same value as ``org_role``
    or ``organization_role`` (``org:admin`` / ``org:member`` / any
    custom slug). Map these onto Eden's ``owner`` / ``admin`` /
    ``member`` / ``viewer`` vocabulary at the call site (see
    ``src/eden/api/deps.py``).
    """
    # Abbreviated default: ``o.rol``
    org_claim = payload.get("o")
    if isinstance(org_claim, dict):
        rol = org_claim.get("rol")
        if rol:
            return rol
    # Custom JWT template: ``org_role`` / ``organization_role``
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

    June 2026 fix: Clerk's ``org:admin`` is the *highest* role Clerk
    ships out of the box — there is no ``org:owner``. The org creator
    always gets ``org:admin`` in Clerk, so collapsing it to Eden's
    ``admin`` silently stripped ``owner``-only permissions
    (``org:transfer``, ``billing:edit``, ``gdpr:execute``,
    ``retention:override``) from every solo dev. Map it to
    ``owner`` so the create-org path stays authoritative; the
    ``create_org`` INSERT sets ``last_writer_source='local'`` so the
    Clerk webhook race-resolution doesn't overwrite us back.
    """
    if not clerk_role:
        return "viewer"
    if clerk_role == "org:admin":
        return "owner"
    if clerk_role == "org:member":
        return "member"
    # Any custom role defaults to admin so we don't accidentally
    # demote someone who was set up with a non-standard slug.
    return "admin"
