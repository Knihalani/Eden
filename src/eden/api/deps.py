"""Shared FastAPI dependencies."""

import hashlib
import logging
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Annotated

from fastapi import Cookie, Depends, Header, HTTPException, Path, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from eden.api.utils.auth import decode_access_token
from eden.api.utils.clerk_auth import (
    clerk_role_to_eden_role,
    extract_org_id,
    extract_org_role,
    extract_user_id,
    verify_clerk_token_for_request,
)
from eden.api.utils.clerk_auth import (
    is_clerk_payload as _is_clerk_payload_public,  # canonical impl in clerk_auth.py
)
from eden.config import get_settings
from eden.storage.postgres import get_postgres_client

logger = logging.getLogger(__name__)
security = HTTPBearer(auto_error=False)
# B1 — debounce last_seen_at UPDATEs (≥60s) so auth does not write on every request.
_LAST_SEEN_DEBOUNCE_S = 60.0
_last_seen_bumped_at: dict[str, float] = {}

# B2 — TTL cache for resolve_eden_org_id (Clerk id / Eden UUID → Eden UUID).
_ORG_ID_CACHE_TTL_S = 60.0
_org_id_cache: dict[str, tuple[float, str | None]] = {}

# Mirror B2 for resolve_eden_user_id (Clerk sub / Eden UUID → Eden UUID).
# Auth deps hit this on nearly every request; a 60s hit avoids a users
# round-trip without stretching stale membership beyond org-id cache.
_USER_ID_CACHE_TTL_S = 60.0
_user_id_cache: dict[str, tuple[float, str | None]] = {}

# Negative lookups get a much shorter TTL than hits. A brand-new user is
# resolved (miss) a few milliseconds before their org/user row is INSERTed
# by the provisioning path — caching that miss for the full 60s left them
# staring at 403 "No active organization" for a minute after signup. Two
# seconds still absorbs a retry burst without outliving a provision.
_NEGATIVE_ID_CACHE_TTL_S = 2.0

# Bound in-process id caches so long-lived workers cannot grow without limit
# under org/user churn (cache stampede memory, not correctness).
_ID_CACHE_MAX = 4096


# Hot-path cache for API-key auth. Every SDK span batch and every gateway
# call paid an uncached Neon round trip (org_api_keys JOIN organizations)
# before any work started — the single most-executed query in the product.
# TenantRateLimitMiddleware already caches its own key resolution for 60s;
# this gives the auth dependency the same treatment so the two agree.
#
# Cost of the cache is bounded staleness on revocation: a key revoked on
# one pod stays usable on another for up to the TTL. Revocation through
# ``routes/api_keys.py`` calls :func:`invalidate_api_key_cache`, so the lag
# only applies to other pods, and the TTL is additionally clamped to the
# key's own ``expires_at`` so an expiring key can never outlive its expiry.
_API_KEY_AUTH_CACHE_TTL_S = 60.0
_API_KEY_AUTH_CACHE_MAX = 2048
_api_key_auth_cache: dict[tuple[str, str], tuple[float, dict]] = {}


def invalidate_api_key_cache(key_hash: str | None = None) -> None:
    """Drop cached API-key auth results.

    Called on revoke/disable so the issuing pod stops honouring the key
    immediately. With no argument, clears the whole cache (tests).
    """
    if key_hash is None:
        _api_key_auth_cache.clear()
        return
    for cached_key in [k for k in _api_key_auth_cache if k[0] == key_hash]:
        _api_key_auth_cache.pop(cached_key, None)


def invalidate_org_id_cache(*keys: str | None) -> None:
    """Drop cached org-id resolutions. Call right after an INSERT into
    ``organizations`` so the newly-created row is visible immediately."""
    for key in keys:
        if key:
            _org_id_cache.pop(key, None)


def invalidate_user_id_cache(*keys: str | None) -> None:
    """Drop cached user-id resolutions. Call right after an INSERT into
    ``users`` (Clerk auto-provisioning) for the same reason."""
    for key in keys:
        if key:
            _user_id_cache.pop(key, None)


def _cache_put(
    cache: dict[str, tuple[float, str | None]],
    key: str,
    expires_at: float,
    value: str | None,
) -> None:
    """Insert into a TTL id-cache, evicting expired/oldest entries when full."""
    if len(cache) >= _ID_CACHE_MAX and key not in cache:
        import time as _time

        now = _time.monotonic()
        expired = [k for k, (exp, _) in cache.items() if exp <= now]
        for k in expired:
            cache.pop(k, None)
        # Still full after expiry sweep — drop oldest insertion-order keys.
        while len(cache) >= _ID_CACHE_MAX:
            cache.pop(next(iter(cache)), None)
    cache[key] = (expires_at, value)

# API-key scope families (Wave 1). Empty / legacy references-jobs-only
# keys fail closed — callers must mint explicit ingest/gateway scopes.
INGEST_SCOPES = frozenset({"ingest:write", "ingest:read", "ingest:*", "*"})
GATEWAY_SCOPES = frozenset({"gateway:write", "gateway:read", "gateway:*", "*"})
MCP_SCOPES = frozenset({"mcp:read", "mcp:debug", "mcp:fix", "mcp:*", "*"})

# Portal scope aliases → canonical scopes.
#
# The Settings → API Keys UI has always offered a short vocabulary
# (``ingest``, ``traces:write``, …) that ``VALID_SCOPES`` in
# ``routes/api_keys.py`` accepts, but that none of the families above
# contain. The result: every key a user minted from Settings was
# accepted at create time and then 403'd on every ingest and gateway
# call — the product's most common first action produced a dead key.
#
# These are *spelling* aliases for scopes the user explicitly chose,
# not legacy grandfathering of unscoped keys: an empty scope list still
# fails closed, and no alias grants a family the user did not pick.
SCOPE_ALIASES: dict[str, frozenset[str]] = {
    "ingest": frozenset({"ingest:write", "ingest:read"}),
    "traces:write": frozenset({"ingest:write"}),
    "traces:read": frozenset({"ingest:read"}),
}


def expand_scope_aliases(scopes: list[str] | None) -> set[str]:
    """Return ``scopes`` with portal aliases expanded to canonical form."""
    out: set[str] = set()
    for raw in scopes or []:
        scope = str(raw).strip()
        if not scope:
            continue
        out.add(scope)
        out |= SCOPE_ALIASES.get(scope, frozenset())
    return out


def api_key_has_scope(scopes: list[str] | None, allowed: frozenset[str]) -> bool:
    """Return True when the key grants at least one scope in ``allowed``.

    Empty / missing scopes fail closed. Portal spelling aliases
    (:data:`SCOPE_ALIASES`) are expanded first; beyond those,
    ``ingest:write`` / ``gateway:write`` (or family ``*`` / bare ``*``)
    must be present explicitly.
    """
    s = expand_scope_aliases(scopes)
    if not s:
        return False
    if s & allowed:
        return True
    # Family wildcards already included in ``allowed``; also accept bare "*".
    return "*" in s


async def _assert_org_header_matches_session(
    *,
    x_org_id: str | None,
    payload: dict,
    is_clerk: bool,
) -> str:
    """Resolve the trusted org id for a human session.

    Wave 1: JWT/session org is authoritative. ``X-Org-Id`` may only
    *agree* with the session org (Clerk claim or Eden cookie
    ``current_org_id``). A mismatched header is rejected as spoofing —
    never used to upsert membership into a foreign org.
    """
    jwt_org_raw = (
        extract_org_id(payload)
        if is_clerk
        else (payload.get("current_org_id") if payload else None)
    )
    if not jwt_org_raw and not x_org_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="No active organization",
        )

    # Parallelize the two independent id resolutions (cold-cache auth path).
    import asyncio as _asyncio

    if jwt_org_raw and x_org_id:
        jwt_org, header_org = await _asyncio.gather(
            resolve_eden_org_id(jwt_org_raw),
            resolve_eden_org_id(x_org_id),
        )
    else:
        jwt_org = await resolve_eden_org_id(jwt_org_raw) if jwt_org_raw else None
        header_org = await resolve_eden_org_id(x_org_id) if x_org_id else None

    if jwt_org and header_org and jwt_org != header_org:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="X-Org-Id does not match session organization",
        )

    # Prefer session claim; allow header only when session has no org
    # (legacy cookie edge) AND membership will be verified in DB without upsert.
    trusted = jwt_org or header_org
    if not trusted:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="No active organization",
        )
    return trusted


# Bearer-JWT resolver used by the auth dependencies below. Pulls the
# JWT from the ``Authorization: Bearer <jwt>`` header first (the path
# the Clerk-authed portal uses), then falls back to the legacy Eden
# ``authorization`` cookie (the path the CLI / SDK / service-to-service
# callers use). Returns the decoded payload dict in either case, or
# raises 401 if neither path yielded a valid token.
async def _resolve_token_payload(
    request: Request,
    authorization_cookie: Annotated[str | None, Cookie(alias="authorization")] = None,
    bearer: Annotated[HTTPAuthorizationCredentials | None, Depends(security)] = None,
) -> dict:
    # One verify per request — get_current_user and require_path_org_access
    # previously used different Depends keys and double-verified JWTs.
    cached = getattr(request.state, "eden_jwt_payload", None)
    if isinstance(cached, dict):
        return cached

    # Middleware may already have verified the Bearer once this request.
    cached_clerk = getattr(request.state, "clerk_jwt_payload", None)
    if isinstance(cached_clerk, dict):
        request.state.eden_jwt_payload = cached_clerk
        return cached_clerk

    # Clerk path: portal forwards the Clerk session JWT as a Bearer.
    # B-6 (Session 23): verify_clerk_token is now async — the JWKS
    # path performs a non-blocking httpx round-trip inside.
    if bearer and bearer.scheme.lower() == "bearer":
        clerk_payload = await verify_clerk_token_for_request(
            request, bearer.credentials
        )
        if clerk_payload:
            request.state.eden_jwt_payload = clerk_payload
            return clerk_payload

    # Legacy Eden-issued cookie JWT (CLI, SDK, internal services).
    if authorization_cookie:
        payload = decode_access_token(authorization_cookie)
        if payload:
            request.state.eden_jwt_payload = payload
            return payload

    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Not authenticated",
    )

# Permission map: role -> set of permissions
PERMISSION_MAP: dict[str, set[str]] = {
    "owner": {
        "references:read",
        "references:upload",
        "references:delete",
        "members:invite",
        "members:remove",
        "settings:edit",
        "billing:view",
        "billing:edit",
        "audit:view",
        "org:transfer",
        # June 2026: gating for the onboarding wizard's "Connect GitHub"
        # + "Open Integration PR" path. Wiring a repo into an org
        # exposes commit + branch-create access on behalf of the
        # installation token; only owners/admins should be able to do
        # that. Members and viewers see a "Request from your admin"
        # callout instead.
        "integrations:write",
        # Job submission/read — granted to owner and admin so the
        # portal's "Trigger test run" + "Trigger sim run" actions work
        # without requiring a separate per-resource grant. Members and
        # viewers do not get these scopes (they would only use them via
        # a CI-scoped API key anyway).
        "jobs:read",
        "jobs:write",
        # Phase 7.3d — the four sensitive permissions (June 2026).
        "pii:edit",
        "judges:run",
        "gdpr:execute",
        "retention:override",
    },
    "admin": {
        "references:read",
        "references:upload",
        "references:delete",
        "members:invite",
        "members:remove",
        "settings:edit",
        "billing:view",
        "billing:edit",
        "audit:view",
        "integrations:write",
        "jobs:read",
        "jobs:write",
        "pii:edit",
        "judges:run",
    },
    "member": {
        "references:read",
        "judges:run",
        # Members can submit + read their own jobs (CI runs, sim runs,
        # test runs). ``jobs:write`` is intentionally broader than
        # ``jobs:read`` so a future "observer" role can read results
        # without being able to enqueue work.
        "jobs:read",
        "jobs:write",
    },
    "viewer": {
        "references:read",
        # Viewers can read job results (read-only dashboard) but
        # cannot submit new work.
        "jobs:read",
    },
}


def get_role_permissions(role: str) -> set[str]:
    """Get all permissions for a role."""
    return PERMISSION_MAP.get(role, set())


def has_permission(role: str, permission: str) -> bool:
    """Check if a role has a specific permission."""
    return permission in get_role_permissions(role)


# Higher rank = more privilege. Used so a Clerk JWT claim cannot demote
# a stronger Eden DB membership during sync lag (solo creator = owner).
_EDEN_ROLE_RANK: dict[str, int] = {
    "owner": 3,
    "admin": 2,
    "member": 1,
    "viewer": 0,
}


def prefer_higher_eden_role(
    db_role: str | None,
    jwt_mapped_role: str | None,
) -> str:
    """Pick the stronger of DB membership vs JWT-mapped Clerk role.

    JWT may omit ``o.rol`` or briefly carry a weaker claim after
    create-org / setActive. Never return a role weaker than the DB row.
    """
    db = db_role if db_role in _EDEN_ROLE_RANK else None
    jwt = jwt_mapped_role if jwt_mapped_role in _EDEN_ROLE_RANK else None
    if db is None and jwt is None:
        return "viewer"
    if db is None:
        return jwt or "viewer"
    if jwt is None:
        return db
    if _EDEN_ROLE_RANK[db] >= _EDEN_ROLE_RANK[jwt]:
        return db
    return jwt


async def check_resource_permission(
    user_id: str,
    org_id: str,
    permission: str,
    resource_type: str | None = None,
    resource_id: str | None = None,
) -> bool:
    """Resource-scoped permission check.

    Returns True if the user has the given permission either
    org-wide (via their built-in role) or on a specific resource
    (via a custom-role assignment).

    The check is two-step:

    1. Look up the user's role in the org. If the role grants
       the permission (e.g. ``admin`` → ``members:invite``), return
       True immediately.
    2. If a ``resource_type`` and ``resource_id`` are provided,
       look up a custom-role assignment on that exact resource.
       If one exists, the user gets the permission for that
       resource only (org-wide access is NOT implied).

    Used by routes that need finer-grained access than the
    org-wide role map (e.g. "only the owner of this resource can
    delete it"). Routes that only need org-wide access should
    keep using :func:`require_org_permission`.
    """
    client = await get_postgres_client()
    resolved_user_id = await resolve_eden_user_id(user_id)
    resolved_org_id = await resolve_eden_org_id(org_id)

    role_row = await client.fetchrow(
        """
        SELECT role
        FROM org_members
        WHERE user_id = $1 AND org_id = $2
        LIMIT 1
        """,
        resolved_user_id,
        resolved_org_id,
    )
    role = (role_row or {}).get("role", "")
    if has_permission(role, permission):
        return True

    if resource_type is None or resource_id is None:
        return False

    # Custom-role assignment on the specific resource (migration 020:
    # role_assignments + role_permissions + role_definitions).
    assignment = await client.fetchval(
        """
        SELECT 1
        FROM role_assignments ra
        JOIN role_definitions rd ON rd.id = ra.role_id
        JOIN role_permissions rp
          ON rp.role_id = ra.role_id
         AND rp.granted = TRUE
        WHERE ra.user_id = $1
          AND rd.org_id = $2
          AND ra.resource_type = $3
          AND ra.resource_id = $4
          AND rp.permission_key = $5
        LIMIT 1
        """,
        resolved_user_id,
        resolved_org_id,
        resource_type,
        resource_id,
        permission,
    )
    return assignment is not None


@dataclass
class OrgMember:
    """Authenticated organization member context.

    Returned by ``get_current_org_member`` and used as the auth
    surface for human-facing CRUD endpoints. Wraps the user_id,
    org_id, and role in a typed object so route signatures read
    cleanly.
    """

    user_id: str
    org_id: str
    role: str
    email: str = ""
    name: str = ""


async def get_current_org_member(
    x_org_id: str | None = Header(None, alias="X-Org-Id"),
    payload: dict = Depends(_resolve_token_payload),
) -> OrgMember:
    """Authenticate a portal user and resolve their org membership.

    Mirrors ``require_org_member`` but returns a typed ``OrgMember``
    instead of a raw dict. Raises 401 on no/invalid auth, 403 on
    no membership in the requested org.

    Wave 1: session org claim is authoritative; ``X-Org-Id`` cannot
    spoof a foreign tenant. Membership upsert only runs when the JWT
    org matches the trusted org (never for header-only spoof).
    """
    clerk_user_id = payload.get("sub") or extract_user_id(payload)
    if not clerk_user_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token payload",
        )
    is_clerk = _is_clerk_payload_public(payload)
    eden_org_id = await _assert_org_header_matches_session(
        x_org_id=x_org_id,
        payload=payload,
        is_clerk=is_clerk,
    )

    eden_user_id = await resolve_eden_user_id(clerk_user_id)
    clerk_role = extract_org_role(payload) if is_clerk else None
    eden_role = clerk_role_to_eden_role(clerk_role)
    jwt_org_raw = extract_org_id(payload) if is_clerk else payload.get("current_org_id")
    jwt_org = await resolve_eden_org_id(jwt_org_raw) if jwt_org_raw else None
    session_matches = bool(jwt_org and jwt_org == eden_org_id)

    client = await get_postgres_client()
    row = None
    try:
        row = await client.fetchrow(
            """
            SELECT om.role, u.name AS user_name, u.email
            FROM org_members om
            JOIN users u ON u.id = om.user_id
            WHERE om.user_id = $1 AND om.org_id = $2
            """,
            eden_user_id,
            eden_org_id,
        )
    except Exception as exc:
        logger.warning(
            "get_current_org_member: membership SELECT failed user=%s org=%s: %s",
            eden_user_id,
            eden_org_id,
            exc,
        )

    # Upsert only when Clerk session org matches trusted org — never
    # for a spoofed header pointing at a foreign tenant.
    if not row and is_clerk and session_matches:
        await ensure_clerk_membership(eden_user_id, eden_org_id, clerk_role)
        try:
            row = await client.fetchrow(
                """
                SELECT om.role, u.name AS user_name, u.email
                FROM org_members om
                JOIN users u ON u.id = om.user_id
                WHERE om.user_id = $1 AND om.org_id = $2
                """,
                eden_user_id,
                eden_org_id,
            )
        except Exception:
            row = None
        if not row:
            # Pending webhook sync — only for session-matched org.
            db_user = await get_user_by_id(clerk_user_id, lookup_column="clerk_id")
            return OrgMember(
                user_id=eden_user_id or clerk_user_id,
                org_id=eden_org_id,
                role=eden_role,
                email=(db_user or {}).get("email") or "",
                name=(db_user or {}).get("name") or "",
            )

    if not row:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Not a member of this organization",
        )
    # Prefer the stronger of JWT-mapped and DB roles when the session
    # org matches and a role claim is present. A weaker JWT claim
    # (or sync lag) must not demote a DB ``owner`` to viewer/member.
    # Missing ``o.rol`` always uses the DB membership role.
    if is_clerk and session_matches and clerk_role:
        role = prefer_higher_eden_role(row["role"], eden_role)
    else:
        role = row["role"] or eden_role
    return OrgMember(
        user_id=eden_user_id or clerk_user_id,
        org_id=eden_org_id,
        role=role,
        email=row.get("email") or "",
        name=row.get("user_name") or "",
    )


async def get_current_user(
    payload: dict = Depends(_resolve_token_payload),
) -> dict:
    """Validate JWT (Clerk Bearer or Eden cookie) and return user.

    Raises HTTPException 401 if not authenticated.

    Anti-fixation: when the JWT carries a ``token_version`` claim
    (Eden-issued tokens do; Clerk-issued tokens do not), we look up
    the user's current version in the DB and reject the token if
    they diverge. This means:
      * a successful /auth/login (which bumps ``token_version``)
        invalidates any pre-existing JWTs for the account;
      * a planted session ID cannot survive the victim's login.
    The Clerk path skips this check — Clerk manages its own session
    revocation semantics.
    """
    user_id = payload.get("sub") or extract_user_id(payload)
    email = payload.get("email")

    if not user_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token payload",
        )

    # If the token was minted by Eden (has a token_version claim),
    # verify it against the DB. This is the session-fixation defence.
    token_version = payload.get("token_version")
    if token_version is not None:
        # Defensive: a DB blip or pool exhaustion here must not 500
        # the entire request — treat as "token unverifiable" and let
        # the caller proceed without the version check. The Clerk
        # path below doesn't use this check anyway. (Site-wide fix
        # July 2026: was the source of 500s on sidebar-prefs,
        # optimization/overview, and onboarding/state routes when
        # the user was signed in but the DB SELECT failed.)
        from eden.storage.postgres import get_postgres_client
        try:
            client = await get_postgres_client()
            row = await client.fetchrow(
                "SELECT token_version, last_seen_at FROM users WHERE id = $1",
                user_id,
            )
        except Exception as exc:
            logger.warning(
                "get_current_user: token_version SELECT failed for user=%s: %s — "
                "proceeding without version check (defensive)",
                user_id, exc,
            )
            row = None
        # User vanished (or never existed) — treat as unauthenticated.
        if row is None:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid token payload",
            )
        if (row.get("token_version") or 0) != token_version:
            # Token was minted before a version bump (login, password
            # change, reset, account deletion). Reject.
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Session expired. Please sign in again.",
            )

        # Idle timeout enforcement: if last_seen_at is set and the
        # token's iat is older than the idle window, the session
        # has been inactive too long — reject and force a re-login.
        # 30 minutes is the standard. Bumping last_seen_at to NOW()
        # below slides the window forward on each successful auth
        # call so an active user never sees this 401.
        from datetime import datetime, timedelta
        idle_window = timedelta(minutes=30)
        last_seen = row.get("last_seen_at")
        iat = payload.get("iat")
        if last_seen is not None and iat is not None:
            # Convert iat to a datetime. PyJWT returns it as int
            # (epoch seconds).
            iat_dt = datetime.fromtimestamp(int(iat), tz=UTC)
            # If the token was issued BEFORE the last idle window
            # relative to last_seen, treat the session as expired.
            if last_seen - iat_dt > idle_window:
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail="Session expired due to inactivity. Please sign in again.",
                )

        # Slide the window: best-effort update, debounced ≥60s (B1).
        # A failure here must not break the auth flow.
        import time as _time
        now_mono = _time.monotonic()
        last_bump = _last_seen_bumped_at.get(user_id, 0.0)
        if now_mono - last_bump >= _LAST_SEEN_DEBOUNCE_S:
            try:
                await client.execute(
                    "UPDATE users SET last_seen_at = NOW() WHERE id = $1",
                    user_id,
                )
                _last_seen_bumped_at[user_id] = now_mono
            except Exception:
                pass  # noqa: BLE001 — best-effort, never block auth

    # Clerk JWTs carry the Clerk string id in ``sub``; downstream
    # org_members / sidebar_prefs lookups need Eden ``users.id``.
    if _is_clerk_payload_public(payload):
        db_user = await get_user_by_id(user_id, lookup_column="clerk_id")
        if db_user:
            user_id = str(db_user["id"])

    return {"user_id": user_id, "email": email}


async def _try_resolve_token_payload(
    request: Request,
    authorization_cookie: Annotated[str | None, Cookie(alias="authorization")] = None,
    bearer: Annotated[HTTPAuthorizationCredentials | None, Depends(security)] = None,
) -> dict | None:
    """Same as ``_resolve_token_payload`` but returns None instead of raising."""
    try:
        return await _resolve_token_payload(
            request, authorization_cookie, bearer
        )
    except HTTPException:
        return None


async def get_optional_user(
    payload: dict | None = Depends(_try_resolve_token_payload),
) -> dict | None:
    """Validate JWT (Clerk Bearer or Eden cookie) and return user, or None."""
    if not payload:
        return None
    user_id = payload.get("sub") or extract_user_id(payload)
    return {"user_id": user_id, "email": payload.get("email")}


async def resolve_eden_user_id(user_id: str | None) -> str | None:
    """Map a Clerk ``sub`` or Eden ``users.id`` to the canonical Eden id.

    ``org_members.user_id`` and most FK columns reference ``users.id``,
    not ``users.clerk_id``. Clerk session JWTs carry the Clerk string
    id in ``sub`` — callers must resolve before any membership lookup.

    Results are cached in-process for ``_USER_ID_CACHE_TTL_S`` (same
    shape as :func:`resolve_eden_org_id`).
    """
    if not user_id:
        return None
    import time as _time
    now_mono = _time.monotonic()
    cached = _user_id_cache.get(user_id)
    if cached is not None:
        expires_at, value = cached
        if now_mono < expires_at:
            return value
    try:
        client = await get_postgres_client()
        row = await client.fetchrow(
            "SELECT id FROM users WHERE id::text = $1 OR clerk_id::text = $1 LIMIT 1",
            user_id,
        )
        value = str(row["id"]) if row else None
        # Only cache definitive lookups. A DB exception must not poison
        # the cache with ``None`` for 60s (false "user not found").
        # Misses get the short negative TTL — provisioning INSERTs the
        # row moments later and must not be shadowed by this entry.
        _cache_put(
            _user_id_cache,
            user_id,
            now_mono
            + (_USER_ID_CACHE_TTL_S if value else _NEGATIVE_ID_CACHE_TTL_S),
            value,
        )
        return value
    except Exception as exc:
        logger.warning(
            "resolve_eden_user_id failed for user=%s: %s",
            user_id,
            exc,
        )
        return None


async def resolve_eden_org_id(org_id: str | None) -> str | None:
    """Map a Clerk org id or Eden ``organizations.id`` to the Eden id.

    New rows store a generated UUID in ``organizations.id`` and the
    Clerk id in ``clerk_org_id``; legacy webhook rows may use the
    Clerk id as ``id`` directly. Accept both shapes.

    Results are cached in-process for ``_ORG_ID_CACHE_TTL_S`` (B2).
    """
    if not org_id:
        return None
    import time as _time
    now_mono = _time.monotonic()
    cached = _org_id_cache.get(org_id)
    if cached is not None:
        expires_at, value = cached
        if now_mono < expires_at:
            return value
    try:
        client = await get_postgres_client()
        row = await client.fetchrow(
            """
            SELECT id FROM organizations
            WHERE id::text = $1 OR clerk_org_id::text = $1
            LIMIT 1
            """,
            org_id,
        )
        value = str(row["id"]) if row else None
        # Only cache definitive lookups. A DB exception must not poison
        # the cache with ``None`` for 60s (false "Organization not found").
        # Misses get the short negative TTL — ``ensure_clerk_org_from_session``
        # resolves (miss) and then INSERTs within the same request, and a
        # 60s negative entry left fresh signups 403ing for a full minute.
        _cache_put(
            _org_id_cache,
            org_id,
            now_mono + (_ORG_ID_CACHE_TTL_S if value else _NEGATIVE_ID_CACHE_TTL_S),
            value,
        )
        return value
    except Exception as exc:
        logger.warning(
            "resolve_eden_org_id failed for org=%s: %s",
            org_id,
            exc,
        )
        return None


async def resolve_path_org_access(
    org_id: str,
    user: dict,
    payload: dict | None = None,
) -> tuple[str, str]:
    """Resolve ``(eden_user_id, eden_org_id)`` for path-scoped org routes.

    Used by alerts / replay endpoints that take ``/orgs/{org_id}/...``
    and must not 404 during Clerk webhook lag for org creators.

    Behaviour:
    1. Resolve Eden user id from the auth dict (Clerk ``user_…`` or UUID).
    2. Prefer :func:`get_current_org` with the path id (self-heals
       membership when the JWT session matches; uses DB role when the
       JWT has no ``o.rol`` claim yet).
    3. Otherwise resolve the org row in-line (503 on DB blip, not a
       cached false 404). Clerk membership upsert runs only when the
       JWT session Eden org matches the path org — never for a foreign
       path ``org_id``.

    Raises:
        401 — authenticated but Eden ``users`` row missing (still provisioning)
        404 — organization truly does not exist
        403 — path org mismatches session org, or not a member after heal
        503 — database unavailable / transient lookup failure
    """
    try:
        user_id = await eden_user_id_from_auth(user)
    except Exception as exc:
        logger.warning("resolve_path_org_access user resolve failed: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="User lookup failed",
        ) from exc
    if not user_id:
        # Distinct from "resource missing" — portal maps 401 to re-auth /
        # provisioning UX instead of the generic 404 copy.
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User account is still provisioning. Please refresh.",
        )

    # Fast path: get_current_org already self-heals Clerk membership and
    # (as of Jul 2026) falls back to DB role when JWT omits o.rol.
    if isinstance(payload, dict) or payload is None:
        try:
            org = await get_current_org(org_id, payload)
        except Exception as exc:
            logger.warning(
                "resolve_path_org_access get_current_org failed org=%s: %s",
                org_id,
                exc,
            )
            org = None
        if org and org.get("org_id"):
            return user_id, str(org["org_id"])

    client = await get_postgres_client()
    if client is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Database unavailable",
        )

    try:
        org_row = await client.fetchrow(
            """
            SELECT id FROM organizations
            WHERE id::text = $1 OR clerk_org_id::text = $1
            LIMIT 1
            """,
            org_id,
        )
    except Exception as exc:
        logger.warning(
            "resolve_path_org_access org resolve failed org=%s: %s",
            org_id,
            exc,
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Organization lookup failed",
        ) from exc

    if not org_row and payload and _is_clerk_payload_public(payload):
        # Path id may be a Clerk org that Eden hasn't ingested yet.
        clerk_org = extract_org_id(payload) or (
            org_id if str(org_id).startswith("org_") else None
        )
        if clerk_org:
            healed = await ensure_clerk_org_from_session(
                clerk_org,
                user_id,
                extract_org_role(payload),
            )
            if healed:
                # Accept healed org when path was the Clerk id or already
                # resolves to the same Eden UUID.
                path_resolved = await resolve_eden_org_id(org_id)
                if path_resolved == healed or clerk_org == org_id or org_id == healed:
                    return user_id, healed

    if not org_row:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Organization not found",
        )

    eden_org_id = str(org_row["id"])

    # Upsert only when Clerk session org matches path org — never invent
    # membership for a foreign path org_id (IDOR).
    if payload and _is_clerk_payload_public(payload):
        jwt_org_raw = extract_org_id(payload)
        jwt_org = await resolve_eden_org_id(jwt_org_raw) if jwt_org_raw else None
        if jwt_org is not None and jwt_org != eden_org_id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Path org_id does not match session organization",
            )
        if jwt_org == eden_org_id:
            await ensure_clerk_membership(
                user_id, eden_org_id, extract_org_role(payload)
            )

    try:
        membership = await client.fetchrow(
            "SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2",
            eden_org_id,
            user_id,
        )
    except Exception as exc:
        logger.warning(
            "resolve_path_org_access membership query failed: %s", exc
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Membership lookup failed",
        ) from exc

    if not membership:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Not a member of this organization",
        )
    return user_id, eden_org_id


async def require_path_org_access(
    request: Request,
    org_id: str = Path(..., description="Organization ID"),
    user: dict = Depends(get_current_user),
) -> str:
    """FastAPI dep: path-org membership → Eden org UUID.

    Use as a router ``dependencies=[Depends(...)]`` gate and/or as
    ``org_id: str = Depends(require_path_org_access)`` so SQL uses the
    resolved Eden id rather than a raw Clerk path id.

    Reuses the JWT already verified by ``get_current_user`` (see
    ``request.state.eden_jwt_payload``) so we do not double-verify.
    """
    payload = getattr(request.state, "eden_jwt_payload", None)
    _, eden_org = await resolve_path_org_access(
        org_id,
        user,
        payload if isinstance(payload, dict) else None,
    )
    return eden_org


async def ensure_clerk_org_from_session(
    clerk_org_id: str,
    eden_user_id: str,
    clerk_role: str | None,
) -> str | None:
    """Ensure an Eden ``organizations`` row exists for a Clerk session org.

    Clerk often creates an org during signup (``org_2x…`` string id).
    The webhook and legacy INSERT paths skipped non-UUID ids, leaving
    the portal stuck in ``orgSyncing`` with zero Eden organizations.
    This self-heals on ``/auth/me`` by fetching the org from Clerk's
    Backend API and inserting ``id = gen_random_uuid()`` +
    ``clerk_org_id = clerk_org_id``.
    """
    if not clerk_org_id:
        return None

    eden_org_id = await resolve_eden_org_id(clerk_org_id)
    if eden_org_id:
        await ensure_clerk_membership(eden_user_id, eden_org_id, clerk_role)
        return eden_org_id

    from eden.api.utils.clerk_client import get_organization

    try:
        clerk_org = await get_organization(clerk_org_id)
    except Exception as exc:
        logger.warning(
            "ensure_clerk_org_from_session: Clerk fetch failed org=%s: %s",
            clerk_org_id,
            exc,
        )
        return None

    if not clerk_org:
        return None

    name = (clerk_org.get("name") or "").strip() or "Workspace"
    slug = (clerk_org.get("slug") or "").strip() or clerk_org_id.replace("_", "-")

    try:
        client = await get_postgres_client()
        await client.execute(
            """
            INSERT INTO organizations (id, clerk_org_id, name, slug, owner_id, updated_at)
            SELECT gen_random_uuid(), $1, $2, $3, $4::uuid, NOW()
            WHERE NOT EXISTS (
                SELECT 1 FROM organizations
                WHERE clerk_org_id = $1 OR id::text = $1
            )
            """,
            clerk_org_id,
            name,
            slug,
            eden_user_id,
        )
        row = await client.fetchrow(
            """
            SELECT id FROM organizations
            WHERE clerk_org_id = $1 OR id::text = $1
            LIMIT 1
            """,
            clerk_org_id,
        )
        if not row:
            return None
        eden_org_id = str(row["id"])
        # The resolve above cached a miss for this key moments ago. Drop it
        # now that the row exists, or the very next request in this signup
        # flow 403s "No active organization" off a stale negative entry.
        invalidate_org_id_cache(clerk_org_id, eden_org_id)
        await ensure_clerk_membership(eden_user_id, eden_org_id, clerk_role)
        return eden_org_id
    except Exception as exc:
        logger.warning(
            "ensure_clerk_org_from_session failed org=%s: %s",
            clerk_org_id,
            exc,
        )
        eden_org_id = await resolve_eden_org_id(clerk_org_id)
        if eden_org_id:
            await ensure_clerk_membership(eden_user_id, eden_org_id, clerk_role)
        return eden_org_id


async def ensure_clerk_membership(
    eden_user_id: str,
    eden_org_id: str,
    clerk_role: str | None,
) -> bool:
    """Best-effort insert of ``org_members`` when Clerk JWT is trusted.

    Self-heal only fills a *missing* membership when the webhook is
    delayed. It must never overwrite an existing role or flip
    ``last_writer_source``: a prior ``DO UPDATE`` that always set
    ``last_writer_source = 'clerk'`` (even while preserving a local
    ``owner``) let a second heal with a weaker JWT claim demote the
    row. Role authority stays with ``clerk_webhooks._upsert_membership``
    and local writers (``create_org`` / ``accept_invitation``).

    When ``clerk_role`` is missing/empty, skip the write entirely —
    mapping ``None`` → ``viewer`` must not insert a spurious viewer row.
    """
    if not clerk_role:
        return False
    eden_role = clerk_role_to_eden_role(clerk_role)
    client = await get_postgres_client()
    # Column is ``joined_at`` (migration 001), not ``created_at``.
    # ``ON CONFLICT DO NOTHING``: never demote via self-heal.
    insert_with_writer = """
        INSERT INTO org_members (
            org_id, user_id, role, last_active_at, joined_at, last_writer_source
        )
        VALUES ($1, $2, $3, NOW(), NOW(), 'clerk')
        ON CONFLICT (org_id, user_id) DO NOTHING
    """
    insert_legacy = """
        INSERT INTO org_members (org_id, user_id, role, last_active_at, joined_at)
        VALUES ($1, $2, $3, NOW(), NOW())
        ON CONFLICT (org_id, user_id) DO NOTHING
    """
    try:
        await client.execute(
            insert_with_writer,
            eden_org_id,
            eden_user_id,
            eden_role,
        )
        return True
    except Exception as exc:
        if "last_writer_source" not in str(exc):
            logger.warning(
                "ensure_clerk_membership failed user=%s org=%s: %s",
                eden_user_id,
                eden_org_id,
                exc,
            )
            return False
        try:
            await client.execute(
                insert_legacy,
                eden_org_id,
                eden_user_id,
                eden_role,
            )
            return True
        except Exception as legacy_exc:
            logger.warning(
                "ensure_clerk_membership legacy upsert failed user=%s org=%s: %s",
                eden_user_id,
                eden_org_id,
                legacy_exc,
            )
            return False


async def get_user_by_id(user_id: str, lookup_column: str = "id") -> dict | None:
    """Fetch a user by their ID or by their Clerk ID.

    ``lookup_column`` accepts ``"id"`` (UUID PK) or ``"clerk_id"`` (the
    string Clerk mints, e.g. ``user_2abc...``). The Clerk-auth path
    passes the JWT ``sub`` claim, which is the Clerk id — it never
    matches the UUID PK, so a UUID-only lookup would 404 every
    Clerk user.

    Both columns are indexed (``id`` is the PK, ``clerk_id`` has a
    partial unique index from migration 047). The single combined
    query keeps this trivial to call from either path.

    Defensive: a DB blip or missing table must not 500 callers. Return
    None so the auth path falls through to whatever synthesize /
    fallback the caller has (Clerk trust, synthesized pending_sync,
    etc.). 2026-07-06 site-wide fix: the previous unguarded
    ``client.fetchrow`` caused unhandled 500s in
    /orgs/{org_id}/ai-insights/sessions and other dep-graph chains
    when the postgres client briefly disconnected.
    """
    if lookup_column not in ("id", "clerk_id"):
        raise ValueError(f"lookup_column must be id or clerk_id, got {lookup_column!r}")
    try:
        client = await get_postgres_client()
        query = (
            "SELECT id, email, name, created_at, preferred_org_id, clerk_id "
            f"FROM users WHERE {lookup_column}::text = $1"
        )
        return await client.fetchrow(query, user_id)
    except Exception as exc:
        logger.warning(
            "get_user_by_id: users SELECT failed for user=%s lookup=%s: %s",
            user_id, lookup_column, exc,
        )
        return None


async def get_eden_user_row_from_auth(user: dict) -> dict | None:
    """Resolve a ``get_current_user`` dict to an Eden ``users`` row.

    Clerk session JWTs carry the Clerk string id (``user_2abc…``) in
    ``user["user_id"]`` until a Postgres row exists. Passing that
    string into a UUID FK column crashes asyncpg with
    ``invalid input syntax for type uuid`` → unhandled 500. Look up
    by ``clerk_id`` first, then by Eden ``id``.

    When ``user_id`` is still a Clerk ``user_…`` id and the
    ``clerk_id`` lookup misses, return ``None`` immediately — do
    NOT fall through to an ``id`` lookup with the Clerk string
    (that can never match a real Eden PK and confused auto-provision
    tests / any mock that returns a row for arbitrary ids).
    """
    uid = user.get("user_id")
    if not uid:
        return None
    uid_str = str(uid)
    if uid_str.startswith("user_"):
        return await get_user_by_id(uid_str, lookup_column="clerk_id")
    return await get_user_by_id(uid_str, lookup_column="id")


async def eden_user_id_from_auth(user: dict) -> str | None:
    """Return Eden ``users.id`` for an auth user dict, or None."""
    row = await get_eden_user_row_from_auth(user)
    return str(row["id"]) if row else None


async def get_current_org(
    x_org_id: str | None = Header(None, alias="X-Org-Id"),
    payload: dict | None = Depends(_try_resolve_token_payload),
    include_archived: bool = False,
) -> dict | None:
    """Get current organization context from header or JWT.

    Returns org context if user is a member, None otherwise.
    Optionally includes archived orgs (for admin views).

    Clerk path: when the JWT came from Clerk, ``org_id`` and
    ``org_role`` are read directly off the session claims and we
    skip the ``org_members`` lookup. The Eden row is still fetched
    for ``name`` / ``slug`` / ``archived_at`` / ``last_active_at``
    bookkeeping, but the role is trusted from Clerk (single source
    of truth).
    """
    # Direct ``await require_org_*(org_id)`` leaves ``payload`` as an
    # unresolved FastAPI ``Depends(...)`` sentinel (truthy, not a dict).
    # Treat that as unauthenticated so we 403 instead of AttributeError → 500.
    if not isinstance(payload, dict):
        if payload is not None:
            logger.error(
                "get_current_org received non-dict payload (%s); "
                "caller likely awaited a Depends-backed guard without "
                "resolving the JWT — returning None (403 upstream)",
                type(payload).__name__,
            )
        return None

    user_id = payload.get("sub") or extract_user_id(payload)
    # Clerk path: session org claim is authoritative (Wave 1).
    is_clerk = _is_clerk_payload_public(payload)
    if is_clerk:
        try:
            eden_org_id = await _assert_org_header_matches_session(
                x_org_id=x_org_id,
                payload=payload,
                is_clerk=True,
            )
        except HTTPException:
            return None
        eden_user_id = await resolve_eden_user_id(user_id)
        clerk_role = extract_org_role(payload)
        eden_role = clerk_role_to_eden_role(clerk_role)
        jwt_org_raw = extract_org_id(payload)
        jwt_org = await resolve_eden_org_id(jwt_org_raw) if jwt_org_raw else None
        session_matches = bool(jwt_org and jwt_org == eden_org_id)
        # Defensive: a DB blip or RLS-blanket here must not 500 the
        # request — fall through to the synthesised pending_sync
        # entry only when the JWT org matches.
        row = None
        try:
            client = await get_postgres_client()
            if include_archived:
                row = await client.fetchrow(
                    """
                    SELECT om.role, o.name, o.slug, o.owner_id, o.archived_at
                    FROM org_members om
                    JOIN organizations o ON o.id = om.org_id
                    WHERE om.user_id = $1 AND om.org_id = $2
                    """,
                    eden_user_id,
                    eden_org_id,
                )
            else:
                row = await client.fetchrow(
                    """
                    SELECT om.role, o.name, o.slug, o.owner_id, o.archived_at
                    FROM org_members om
                    JOIN organizations o ON o.id = om.org_id
                    WHERE om.user_id = $1 AND om.org_id = $2 AND o.archived_at IS NULL
                    """,
                    eden_user_id,
                    eden_org_id,
                )
        except Exception as exc:
            logger.warning(
                "get_current_org: org_members SELECT failed for user=%s org=%s: %s — "
                "falling through to synthesised pending_sync entry",
                eden_user_id, eden_org_id, exc,
            )
        if not row and session_matches:
            await ensure_clerk_membership(eden_user_id, eden_org_id, clerk_role)
            try:
                client = await get_postgres_client()
                row = await client.fetchrow(
                    """
                    SELECT om.role, o.name, o.slug, o.owner_id, o.archived_at
                    FROM org_members om
                    JOIN organizations o ON o.id = om.org_id
                    WHERE om.user_id = $1 AND om.org_id = $2
                    """,
                    eden_user_id,
                    eden_org_id,
                )
            except Exception:
                row = None
        if not row:
            if not session_matches:
                return None
            # Clerk says the user is in this org but Eden's
            # ``org_members`` row doesn't exist yet — the Clerk
            # webhook will create it shortly.
            return {
                "org_id": eden_org_id,
                "role": eden_role,
                "name": eden_org_id,
                "slug": eden_org_id,
                "archived_at": None,
                "_pending_sync": True,
            }
        # Prefer the stronger of JWT-mapped and DB roles when session
        # matches and a role claim is present. Never demote a DB owner
        # via a weaker JWT claim during sync. Missing ``o.rol`` uses DB
        # (post-create before setActive must keep creator as owner).
        if session_matches and clerk_role:
            role = prefer_higher_eden_role(row["role"], eden_role)
        else:
            role = row["role"] or eden_role
        return {
            "org_id": eden_org_id,
            "role": role,
            "name": row["name"],
            "slug": row["slug"],
            "archived_at": row.get("archived_at"),
        }

    # Legacy Eden cookie path — header must match cookie org when both set.
    cookie_org = payload.get("current_org_id")
    if x_org_id and cookie_org:
        resolved_header = await resolve_eden_org_id(x_org_id)
        resolved_cookie = await resolve_eden_org_id(cookie_org)
        if (
            resolved_header
            and resolved_cookie
            and resolved_header != resolved_cookie
        ):
            return None
    org_id = await resolve_eden_org_id(cookie_org or x_org_id)
    user_id = await resolve_eden_user_id(user_id)

    if not org_id or not user_id:
        return None

    client = await get_postgres_client()

    # Verify membership and get role (optionally include archived)
    if include_archived:
        query = """
            SELECT om.role, o.name, o.slug, o.owner_id, o.archived_at
            FROM org_members om
            JOIN organizations o ON o.id = om.org_id
            WHERE om.user_id = $1 AND om.org_id = $2
        """
        row = await client.fetchrow(query, user_id, org_id)
    else:
        query = """
            SELECT om.role, o.name, o.slug, o.owner_id, o.archived_at
            FROM org_members om
            JOIN organizations o ON o.id = om.org_id
            WHERE om.user_id = $1 AND om.org_id = $2 AND o.archived_at IS NULL
        """
        row = await client.fetchrow(query, user_id, org_id)
    if not row:
        return None

    # Update last_active_at on every authenticated org request
    await client.execute(
        "UPDATE org_members SET last_active_at = NOW() WHERE user_id = $1 AND org_id = $2",
        user_id,
        org_id,
    )

    return {
        "org_id": org_id,
        "role": row["role"],
        "name": row["name"],
        "slug": row["slug"],
        "archived_at": row.get("archived_at"),
    }


async def require_org_member(
    x_org_id: str | None = Header(None, alias="X-Org-Id"),
    payload: dict | None = Depends(_try_resolve_token_payload),
) -> dict:
    """Require user to be an org member.

    Status codes:
      * **401** when there is no resolved session payload (unauthenticated)
      * **403** when authenticated but not a member of the requested org

    Defensive: any DB blip inside get_current_org (which itself has
    inner try/except per the May 2026 hardening) MUST NOT 500 the
    request. If the membership lookup fails AND the JWT carries a
    valid Clerk ``org_id`` claim, fall through to a synthesized
    pending_sync entry the same way get_current_org does; otherwise
    401/403 (not 500). 2026-07-06 site-wide fix: the previous unguarded
    chain caused 500s on /orgs/{org_id}/ai-insights/sessions and
    similar org-scoped routes during a Postgres reconnect window.
    """
    try:
        org = await get_current_org(x_org_id, payload)
    except Exception as exc:
        logger.warning(
            "require_org_member: get_current_org raised for x_org=%s: %s — "
            "falling back to synthesized entry if JWT carries one",
            x_org_id, exc,
        )
        # Try the synthesize path so Clerk-trusted users still pass.
        clerk_org = extract_org_id(payload) if isinstance(payload, dict) else None
        if isinstance(payload, dict) and clerk_org:
            eden_org_id = await resolve_eden_org_id(clerk_org)
            clerk_role = extract_org_role(payload)
            return {
                "org_id": eden_org_id or clerk_org,
                "role": clerk_role_to_eden_role(clerk_role),
                "name": eden_org_id or clerk_org,
                "slug": eden_org_id or clerk_org,
                "archived_at": None,
                "_pending_sync": True,
            }
        org = None
    if not org:
        # Unauthenticated (no JWT/cookie) → 401. Authenticated but not a
        # member → 403. Collapsing both to 403 made portal/SDK probes look
        # like membership failures when the session was simply missing.
        if not isinstance(payload, dict):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Authentication required",
            )
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Not a member of this organization",
        )
    return org


async def require_path_org_member(
    org_id: str = Path(..., description="Organization ID"),
    member: dict = Depends(require_org_member),
) -> dict:
    """Gate path ``org_id`` against the authenticated member org.

    Prefer :func:`require_path_org_access` when handlers need the
    resolved Eden UUID for SQL. This variant keeps the member dict
    (role / name) for routes already wired to ``require_org_member``.
    """
    eden_path = await resolve_eden_org_id(org_id) or org_id
    if str(member["org_id"]) != str(eden_path):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Path org_id does not match authenticated org",
        )
    return member



def require_org_permission_dep(permission: str):
    """Factory for a FastAPI ``Depends(...)`` closure that enforces ``permission``.

    Prefer this over the bare :func:`require_org_permission` async function
    when wiring into route signatures — the closure picks up the JWT
    payload and ``X-Org-Id`` header via FastAPI's dependency injector
    rather than relying on caller-side argument passing. Usage::

        @router.post("/foo")
        async def create_foo(
            org_id: str,
            user: dict = Depends(get_current_user),
            _check: dict = Depends(require_org_permission_dep("foo:write")),
        ):
            ...

    The leading-underscore name on ``_check`` is conventional for a
    side-effect-only dependency (the returned dict is usually discarded;
    the only observable effect is raising 403 if the permission is
    missing). When the caller also needs the org dict (e.g. to read
    the resolved role), use ``org: dict = Depends(...)`` and reference
    it later in the handler.

    The closure reads ``X-Org-Id`` from the header, falling back to
    ``payload.get("current_org_id")`` for the cookie-auth path. If
    neither resolves, the request 403s — no silent bypass.
    """

    async def _dependency(
        # ``org_id`` is accepted without a ``Header`` annotation so FastAPI
        # binds the route's path parameter when one exists (the common
        # case: ``@router.post("/orgs/{org_id}/foo")``). When no path
        # param is in scope (e.g. service-to-service endpoints like
        # ``POST /jobs`` that derive org from the JWT only) we fall back
        # to ``x_org_id`` from the ``X-Org-Id`` header.
        org_id: str | None = None,
        x_org_id: str | None = Header(None, alias="X-Org-Id"),
        payload: dict | None = Depends(_try_resolve_token_payload),
    ) -> dict:
        org = await get_current_org(org_id or x_org_id, payload)
        if not org:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Not a member of this organization",
            )
        role = org.get("role", "")
        if not has_permission(role, permission):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Permission denied: {permission}",
            )
        return org

    return _dependency

async def require_org_admin(
    x_org_id: str | None = Header(None, alias="X-Org-Id"),
    payload: dict | None = Depends(_try_resolve_token_payload),
) -> dict:
    """Require user to be an org admin/owner, otherwise raise 403."""
    org = await get_current_org(x_org_id, payload)
    if not org:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Not a member of this organization",
        )
    if org["role"] not in ("owner", "admin"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin or owner role required",
        )
    return org


async def require_2fa(
    x_org_id: str | None = Header(None, alias="X-Org-Id"),
    payload: dict | None = Depends(_try_resolve_token_payload),
) -> dict:
    """Require user to have 2FA enabled if org enforces it.

    Returns user dict if:
    - Org does not enforce 2FA, OR
    - User authenticated via Clerk (Clerk owns MFA — its session JWT
      already proves the user passed any required factor), OR
    - Org enforces 2FA AND user has 2FA enabled

    Raises 403 with mfa_required code if:
    - Org enforces 2FA AND user authenticated via the legacy Eden
      cookie flow AND user does not have 2FA enabled in Eden's users
      table.
    """
    org = await get_current_org(x_org_id, payload)
    if not org:
        # If not in an org context, skip 2FA check
        return {"user_id": None, "email": None}

    # Clerk-authed callers: Clerk owns MFA. Skip the Eden-side check.
    if payload and _is_clerk_payload_public(payload):
        return org

    # Check if org has 2FA enforcement
    client = await get_postgres_client()
    row = await client.fetchrow(
        "SELECT two_factor_enforced FROM organizations WHERE id = $1",
        org["org_id"],
    )

    if not row or not row["two_factor_enforced"]:
        # Org doesn't enforce 2FA, allow through
        return org

    user_id = payload.get("sub") or extract_user_id(payload) if payload else None
    user_row = await client.fetchrow(
        "SELECT two_factor_enabled FROM users WHERE id = $1",
        user_id,
    )

    if not user_row or not user_row["two_factor_enabled"]:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="mfa_required",
        )

    return org


async def require_org_owner(
    x_org_id: str | None = Header(None, alias="X-Org-Id"),
    payload: dict | None = Depends(_try_resolve_token_payload),
) -> dict:
    """Require user to be an org owner, otherwise raise 403.

    Owner-only (not admin). Clerk ``org:admin`` maps to Eden ``owner``
    via :func:`clerk_role_to_eden_role`, so Clerk org admins still pass.
    """
    org = await get_current_org(x_org_id, payload)
    if not org:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Not a member of this organization",
        )
    # is_owner field removed in S-6 — gate on role instead.
    if org.get("role") != "owner":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Owner role required",
        )
    return org


async def require_org_permission(
    permission: str,
    x_org_id: str | None = Header(None, alias="X-Org-Id"),
    payload: dict | None = Depends(_try_resolve_token_payload),
) -> dict:
    """Require user to have a specific org permission, otherwise raise 403.

    Uses the role-based permission map to determine access.

    NOTE (June 21 2026 polish): This signature was originally designed
    for FastAPI's ``Depends(...)`` injection. Direct ``await`` calls
    (e.g. ``await require_org_permission("foo", org_id)`` from inside
    a route handler) don't resolve ``payload`` — the default value is
    the raw ``Depends`` wrapper, not the resolved dict. Two safer
    usage patterns work:

    1. **Use the factory** — convert callers to
       ``Depends(require_org_permission_dep("foo"))`` (preferred; see below).
    2. **Resolve payload at the call site** — declare
       ``payload: dict = Depends(_try_resolve_token_payload)`` in the
       route signature and pass it explicitly:
       ``await require_org_permission("foo", org_id, payload)``.

    Pattern (1) is preferred for new routes and is what we now use
    throughout the route layer; pattern (2) remains supported for
    the 9 call sites that already pass ``payload`` explicitly.
    """
    org = await get_current_org(x_org_id, payload)
    if not org:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Not a member of this organization",
        )
    role = org.get("role", "")
    if not has_permission(role, permission):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Permission denied: {permission}",
        )
    return org


# ─────────────────────────────────────────────────────────────────────────────
# Phase 7.3d — convenience guards for the four sensitive permissions.
# Each is a thin alias for :func:`require_org_permission` keyed to
# the named permission. Routes can ``Depends(require_pii_policy_edit)``
# etc. for a self-documenting signature.
# ──────────────────────────────────────────────


async def require_pii_policy_edit(
    x_org_id: str | None = Header(None, alias="X-Org-Id"),
    payload: dict | None = Depends(_try_resolve_token_payload),
) -> dict:
    """Require ``pii:edit`` — the ability to modify the org's PII policy."""
    return await require_org_permission("pii:edit", x_org_id, payload)


async def require_judges_run(
    x_org_id: str | None = Header(None, alias="X-Org-Id"),
    payload: dict | None = Depends(_try_resolve_token_payload),
) -> dict:
    """Require ``judges:run`` — the ability to trigger judge evaluations."""
    return await require_org_permission("judges:run", x_org_id, payload)


async def require_gdpr_execute(
    x_org_id: str | None = Header(None, alias="X-Org-Id"),
    payload: dict | None = Depends(_try_resolve_token_payload),
) -> dict:
    """Require ``gdpr:execute`` — owner-only RTBF / GDPR actions."""
    return await require_org_permission("gdpr:execute", x_org_id, payload)


async def require_retention_override(
    x_org_id: str | None = Header(None, alias="X-Org-Id"),
    payload: dict | None = Depends(_try_resolve_token_payload),
) -> dict:
    """Require ``retention:override`` — owner-only data-retention override."""
    return await require_org_permission("retention:override", x_org_id, payload)


def require_org_permission_or_api_key(permission: str):
    """Factory that returns a dependency supporting either cookie or API key auth.

    For user auth, checks role-based permissions.
    For API key auth, checks scopes directly.
    """
    async def dependency(
        x_org_id: str | None = Header(None, alias="X-Org-Id"),
        x_org_api_key: str | None = Header(None, alias="X-Org-Api-Key"),
        payload: dict | None = Depends(_try_resolve_token_payload),
    ) -> dict:
        # Try API key first
        if x_org_api_key:
            try:
                org = await get_current_org_api_key(x_org_id, x_org_api_key)
                if org and permission in org.get("scopes", []):
                    return org
            except HTTPException:
                pass

        # Fall back to user auth
        if not payload:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Not authenticated",
            )

        org = await get_current_org(x_org_id, payload)
        if not org:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Not a member of this organization",
            )

        role = org.get("role", "")
        if not has_permission(role, permission):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Permission denied: {permission}",
            )
        return org

    return dependency


# ============================================================================
# API Key Authentication
# ============================================================================

async def get_current_org_api_key(
    x_org_id: str = Header(..., alias="X-Org-Id"),
    x_org_api_key: str | None = Header(None, alias="X-Org-Api-Key"),
) -> dict:
    """Validate X-Org-Api-Key header and return org context.

    This is an alternative to cookie-based auth for programmatic access.
    Returns org context with scopes if valid.

    Auth failures (missing / malformed / unknown key, bad org id) are
    always HTTP 401 — never an unhandled 500. Only a true DB outage
    surfaces as 503.
    """
    if not x_org_api_key:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="X-Org-Api-Key header required",
        )
    if not x_org_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="X-Org-Id header required with API key",
        )

    # Malformed keys (non-str, undecodable) must be 401, not TypeError 500.
    try:
        key_hash = hashlib.sha256(x_org_api_key.encode("utf-8")).hexdigest()
    except (AttributeError, TypeError, UnicodeError) as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid API key",
        ) from exc

    # Hot path: serve a recent, still-valid result without touching
    # Postgres. Only fully-validated rows are ever cached (see below), so
    # a hit needs no re-validation beyond its own TTL.
    import time as _time

    cache_key = (key_hash, x_org_id)
    _now_mono = _time.monotonic()
    _cached = _api_key_auth_cache.get(cache_key)
    if _cached is not None:
        _expires_at, _ctx = _cached
        if _now_mono < _expires_at:
            return dict(_ctx)
        _api_key_auth_cache.pop(cache_key, None)

    # Compare org_id as text so a non-UUID ``X-Org-Id`` (Clerk-style
    # ``org_…``, typo, placeholder) cannot crash asyncpg with
    # ``invalid input syntax for type uuid`` → unhandled 500.
    query = """
        SELECT o.name, o.slug, o.owner_id, o.id as org_id, oak.scopes, oak.id as key_id,
               oak.active, oak.revoked_at, oak.expires_at, oak.last_used_at
        FROM org_api_keys oak
        JOIN organizations o ON o.id = oak.org_id
        WHERE oak.key_hash = $1 AND oak.org_id::text = $2
    """
    try:
        client = await get_postgres_client()
        if client is None:
            raise RuntimeError("postgres client unavailable")
        row = await client.fetchrow(query, key_hash, x_org_id)
    except HTTPException:
        raise
    except Exception as exc:
        # Auth-input faults (e.g. leftover UUID cast on a non-UUID
        # ``X-Org-Id``) must be 401, never an unhandled 500. True DB
        # outages stay 503 so clients can Retry-After.
        exc_name = type(exc).__name__
        msg = str(exc).lower()
        if (
            "invalid input syntax for type uuid" in msg
            or exc_name in ("DataError", "InvalidTextRepresentation")
        ):
            logger.warning(
                "get_current_org_api_key: auth-input fault for org=%s: %s",
                x_org_id,
                exc,
            )
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid API key",
            ) from exc
        logger.warning(
            "get_current_org_api_key: lookup failed for org=%s: %s",
            x_org_id,
            exc,
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication temporarily unavailable",
            headers={"Retry-After": "5"},
        ) from exc
    if not row:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid API key",
        )

    # S-5: filter on active / revoked_at / expires_at.
    if not row.get("active", True):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="API key disabled",
        )
    if row.get("revoked_at") is not None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="API key revoked",
        )
    expires_at = row.get("expires_at")
    if expires_at is not None:
        # Audit 2026-07-03 — asyncpg returns naive ``datetime`` from
        # ``TIMESTAMP WITH TIME ZONE`` columns when the server's
        # ``TimeZone`` setting is ``UTC`` (the project default).
        # Comparing a naive value against ``datetime.now(UTC)`` (tz-
        # aware) raises ``TypeError`` and 500s the request — the same
        # class of bug fixed in ``invitation_service._as_utc``. Inline
        # the coercion here rather than import from a service module:
        # the helper is a single expression and the api layer
        # shouldn't depend on ``services/``.
        cmp_expires = (
            expires_at if expires_at.tzinfo
            else expires_at.replace(tzinfo=UTC)
        )
        if cmp_expires < datetime.now(UTC):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="API key expired",
            )

    # B-10 — debounce last_used_at to ≤1 write / 60s / key. Hot SDK
    # ingest otherwise writes Postgres on every authenticated request.
    last_used = row.get("last_used_at")
    if last_used is None:
        should_stamp = True
    else:
        cmp = last_used if last_used.tzinfo else last_used.replace(tzinfo=UTC)
        should_stamp = (datetime.now(UTC) - cmp) >= timedelta(seconds=60)

    if should_stamp:
        try:
            await client.execute(
                """
                UPDATE org_api_keys
                SET last_used_at = NOW()
                WHERE id = $1
                  AND (
                    last_used_at IS NULL
                    OR last_used_at < NOW() - INTERVAL '60 seconds'
                  )
                """,
                row["key_id"],
            )
        except Exception as exc:
            logger.debug("last_used_at UPDATE failed (non-fatal): %s", exc)

    key_id = str(row["key_id"])
    context = {
        "org_id": str(row["org_id"]),
        "name": row["name"],
        "slug": row["slug"],
        "scopes": row["scopes"],
        "key_id": key_id,
        # Attribution / ingest routes historically read ``api_key_id``.
        "api_key_id": key_id,
        "auth_method": "api_key",
    }

    # Cache the validated context. TTL is clamped to the key's remaining
    # lifetime so an ``expires_at`` inside the window is still honoured.
    ttl = _API_KEY_AUTH_CACHE_TTL_S
    if expires_at is not None:
        remaining = (cmp_expires - datetime.now(UTC)).total_seconds()
        ttl = min(ttl, max(0.0, remaining))
    if ttl > 0:
        if (
            len(_api_key_auth_cache) >= _API_KEY_AUTH_CACHE_MAX
            and cache_key not in _api_key_auth_cache
        ):
            stale = [
                k for k, (exp, _) in _api_key_auth_cache.items()
                if exp <= _now_mono
            ]
            for k in stale:
                _api_key_auth_cache.pop(k, None)
            while len(_api_key_auth_cache) >= _API_KEY_AUTH_CACHE_MAX:
                _api_key_auth_cache.pop(next(iter(_api_key_auth_cache)), None)
        _api_key_auth_cache[cache_key] = (
            _time.monotonic() + ttl,
            dict(context),
        )

    return context


async def get_optional_org(
    x_org_id: str | None = Header(None, alias="X-Org-Id"),
    x_org_api_key: str | None = Header(None, alias="X-Org-Api-Key"),
    payload: dict | None = Depends(_try_resolve_token_payload),
) -> dict | None:
    """Get org context from either API key or JWT (Bearer / cookie).

    Tries API key first, then falls back to the resolved session payload.
    Returns None if neither is valid.

    NOTE: Do not pass the raw cookie string into
    :func:`get_current_org` — that expects a payload dict. A string
    used to AttributeError → 500; after the non-dict guard it
    silently returned None and broke cookie auth entirely.
    """
    # Try API key first
    if x_org_api_key:
        try:
            return await get_current_org_api_key(x_org_id, x_org_api_key)
        except HTTPException:
            pass

    if not isinstance(payload, dict):
        return None
    return await get_current_org(x_org_id, payload)


# ============================================================================
# Audit Logging
# ============================================================================

async def log_audit_event(
    client,
    org_id: str,
    user_id: str,
    action: str,
    target_type: str | None = None,
    target_id: str | None = None,
    metadata: dict | None = None,
    ip_address: str | None = None,
    user_agent: str | None = None,
) -> None:
    """Insert an audit log entry for an org action."""
    query = """
        INSERT INTO org_audit_log (org_id, user_id, action, target_type, target_id, metadata, ip_address, user_agent)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    """
    await client.execute(
        query,
        org_id,
        user_id,
        action,
        target_type,
        target_id,
        metadata or {},
        ip_address,
        user_agent,
    )


# ============================================================================
# Feature Flags
# ============================================================================


def require_feature_flag(flag_name: str):
    """Build a FastAPI dependency that gates a route on a boolean setting.

    When the flag is OFF, the dependency raises HTTP 404 (pretending the route
    does not exist) rather than 403. 404 is preferred because it leaks no
    information about the existence of the feature to un-flagged callers.

    Settings are read at request time (not at decorator/build time) so that
    tests can monkeypatch EXPERIMENTS_V1 between requests.

    Usage:
        @router.get("/experiments", dependencies=[Depends(require_feature_flag("enable_experiment_v2"))])
        async def list_experiments(...): ...
    """

    async def _dependency() -> None:
        settings = get_settings()
        enabled = bool(getattr(settings, flag_name, False))
        if not enabled:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Not Found",
            )

    return _dependency


# ============================================================================
# Ingestion Auth (Phase 7.0)
# ============================================================================

async def _ingestion_auth_impl(
    *,
    x_org_id: str | None,
    x_org_api_key: str | None,
    authorization: str | None,
    required_scopes: frozenset[str] | None,
) -> dict:
    """Shared ingest/gateway auth body (not a FastAPI dependency)."""
    if x_org_api_key:
        if not x_org_id:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="X-Org-Id header required with API key",
            )
        org = await get_current_org_api_key(x_org_id, x_org_api_key)
        if required_scopes and not api_key_has_scope(org.get("scopes"), required_scopes):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=(
                    "API key missing required scope "
                    f"(need one of: {sorted(required_scopes)})"
                ),
            )
        return org

    if not authorization:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="X-Org-Api-Key header or session cookie required",
        )

    payload = decode_access_token(authorization)
    if not payload:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid session cookie",
        )
    org = await get_current_org(x_org_id, payload=payload)
    if not org:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Not a member of this organization",
        )
    return org


async def get_ingestion_auth(
    x_org_id: str | None = Header(None, alias="X-Org-Id"),
    x_org_api_key: str | None = Header(None, alias="X-Org-Api-Key"),
    authorization: str | None = Cookie(None),
) -> dict:
    """Authenticate an ingestion / gateway request (no scope gate).

    Prefer :func:`get_ingest_auth` / :func:`get_gateway_auth` on new
    routes so API-key scopes are enforced.
    """
    return await _ingestion_auth_impl(
        x_org_id=x_org_id,
        x_org_api_key=x_org_api_key,
        authorization=authorization,
        required_scopes=None,
    )


def require_ingestion_scopes(*scopes: str):
    """FastAPI dependency factory: ingest/gateway API-key scope gate."""
    allowed = frozenset(scopes)

    async def _dep(
        x_org_id: str | None = Header(None, alias="X-Org-Id"),
        x_org_api_key: str | None = Header(None, alias="X-Org-Api-Key"),
        authorization: str | None = Cookie(None),
    ) -> dict:
        return await _ingestion_auth_impl(
            x_org_id=x_org_id,
            x_org_api_key=x_org_api_key,
            authorization=authorization,
            required_scopes=allowed,
        )

    return _dep


async def get_ingest_auth(
    x_org_id: str | None = Header(None, alias="X-Org-Id"),
    x_org_api_key: str | None = Header(None, alias="X-Org-Api-Key"),
    authorization: str | None = Cookie(None),
) -> dict:
    """Ingest-path auth requiring ``ingest:*`` family scopes on API keys."""
    return await _ingestion_auth_impl(
        x_org_id=x_org_id,
        x_org_api_key=x_org_api_key,
        authorization=authorization,
        required_scopes=INGEST_SCOPES,
    )


async def get_gateway_auth(
    x_org_id: str | None = Header(None, alias="X-Org-Id"),
    x_org_api_key: str | None = Header(None, alias="X-Org-Api-Key"),
    authorization: str | None = Cookie(None),
) -> dict:
    """Gateway-path auth requiring ``gateway:*`` family scopes on API keys."""
    return await _ingestion_auth_impl(
        x_org_id=x_org_id,
        x_org_api_key=x_org_api_key,
        authorization=authorization,
        required_scopes=GATEWAY_SCOPES,
    )
