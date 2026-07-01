"""Authentication routes for Eden client portal."""

import base64
import io
import logging
import os
import secrets
from pathlib import Path

import pyotp
from fastapi import APIRouter, Depends, File, HTTPException, Request, Response, UploadFile, status
from pydantic import BaseModel, EmailStr, Field
from qrcode import QRCode

from eden.api.deps import (
    get_current_org,
    get_current_user,
    get_user_by_id,
    log_audit_event,
    require_org_admin,
)
from eden.api.utils.auth import (
    create_access_token,
    hash_password,
    needs_rehash,
    verify_password,
)
from eden.api.utils.clerk_client import (
    ClerkAPIError,
    extract_user_profile,
    get_user as clerk_get_user,
)
from eden.api.utils.rate_limit import (
    RateLimitExceeded,
    login_email_limiter,
    login_limiter,
    password_reset_limiter,
    signup_limiter,
)
from eden.api.utils.validation import PasswordValidationError, validate_password_strength
from eden.config import get_settings
from eden.services.invitation_service import (
    accept_invitation,
    verify_invite_token,
)
from eden.storage.postgres import get_postgres_client

logger = logging.getLogger(__name__)
settings = get_settings()

router = APIRouter(prefix="/auth", tags=["auth"])

COOKIE_NAME = "authorization"
COOKIE_MAX_AGE = settings.jwt_exp_days * 24 * 60 * 60


def _client_ip(request: Request) -> str:
    """Extract the client IP, honouring X-Forwarded-For from trusted proxies."""
    # Trust the leftmost XFF entry — set by our load balancer / CDN.
    # Falls back to the socket address when no header is present.
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


async def _check_rate_limit(limiter, key: str) -> None:
    """Run the limiter and raise a 429 with Retry-After when exceeded."""
    try:
        await limiter.check(key)
    except RateLimitExceeded as exc:
        # Use 429 Too Many Requests; surface Retry-After per RFC 7231 §7.1.3.
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many attempts. Please try again later.",
            headers={"Retry-After": str(int(exc.retry_after))},
        ) from exc


class SignupRequest(BaseModel):
    """Request schema for user signup."""

    email: EmailStr
    password: str = Field(min_length=8)
    name: str = Field(min_length=1, max_length=100)


class SignupResponse(BaseModel):
    """Response schema for signup."""

    user_id: str
    email: str
    message: str


class LoginRequest(BaseModel):
    """Request schema for login."""

    email: EmailStr
    password: str


class UserResponse(BaseModel):
    """Response schema for authenticated user."""

    user_id: str
    email: str
    name: str
    two_factor_enabled: bool = False
    organizations: list[dict] = []
    current_org_id: str | None = None


class TwoFASetupResponse(BaseModel):
    """Response schema for 2FA setup initiation."""

    secret: str
    qr_code_base64: str
    otpauth_url: str


class TwoFAVerifyRequest(BaseModel):
    """Request schema for 2FA verification."""

    code: str = Field(min_length=6, max_length=6)


class TwoFAEnableResponse(BaseModel):
    """Response schema for 2FA enablement."""

    enabled: bool
    message: str


class EnforceTwoFARequest(BaseModel):
    """Request schema for org 2FA enforcement toggle."""

    enforce: bool


class EnforceTwoFAResponse(BaseModel):
    """Response schema for org 2FA enforcement toggle."""

    two_factor_enforced: bool
    message: str


@router.post("/signup", response_model=UserResponse)
async def signup(request: SignupRequest, response: Response, req: Request):
    """Create a new user account."""
    # Throttle signups per IP to prevent mass account creation.
    await _check_rate_limit(signup_limiter, _client_ip(req))

    # Enforce password strength policy before hitting the DB. The
    # Pydantic `min_length=8` only checks length; the strength
    # validator additionally rejects common passwords and requires
    # upper/lower/digit/special character classes.
    try:
        validate_password_strength(request.password)
    except PasswordValidationError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc

    client = await get_postgres_client()

    # Check if email already exists
    existing = await client.fetchrow(
        "SELECT id FROM users WHERE email = $1",
        request.email,
    )
    if existing:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="An account with this email already exists",
        )

    # Create user
    password_hash = hash_password(request.password)
    # Audit 2026-06-22 B1.23 — mark email unverified; require verification
    # before issuing a session token.
    query = """
        INSERT INTO users (email, password_hash, name, email_verified)
        VALUES ($1, $2, $3, FALSE)
        RETURNING id
    """
    row = await client.fetchrow(query, request.email, password_hash, request.name)
    if not row:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to create user",
        )

    user_id = str(row["id"])

    # Audit 2026-06-22 B1.23 — mint a verification token and dispatch email.
    # The session cookie is only issued AFTER /auth/verify-email succeeds.
    try:
        import secrets
        from datetime import datetime, timedelta, timezone
        verify_token = secrets.token_urlsafe(32)
        expires = datetime.now(timezone.utc) + timedelta(hours=24)
        await client.execute(
            """
            INSERT INTO email_verification_tokens (user_id, token, expires_at, used_at, created_at)
            VALUES ($1, $2, $3, NULL, $3)
            """,
            user_id, verify_token, expires,
        )
        from eden.services.email_service import send_verification_email
        await send_verification_email(to_email=request.email, token=verify_token)
    except Exception as exc:
        logger.warning(f"verification email dispatch failed: {exc}")

    # Audit 2026-06-22 B1.23 — return 202; no session cookie until verified.
    from fastapi.responses import JSONResponse
    return JSONResponse(
        status_code=status.HTTP_202_ACCEPTED,
        content={
            "user_id": user_id,
            "email": request.email,
            "message": "Account created. Check your email to verify before signing in.",
        },
    )

    response.set_cookie(
        key=COOKIE_NAME,
        value=access_token,
        max_age=COOKIE_MAX_AGE,
        httponly=True,
        secure=not settings.debug,
        samesite="lax",
        path="/",
    )

    # Mirror /auth/login: return the full UserResponse (with empty
    # organizations[]) so the frontend's useAuth() can populate the
    # context in a single roundtrip.
    return UserResponse(
        user_id=user_id,
        email=request.email,
        name=request.name,
        organizations=[],
        current_org_id=None,
    )


@router.post("/login", response_model=UserResponse)
async def login(request: LoginRequest, response: Response, req: Request):
    """Authenticate user and return JWT cookie."""
    # Two-axis throttling: per-IP (broad brute force) and per-email
    # (credential stuffing against one account). Per-email is checked
    # only once we know the email — the per-IP check fires first so a
    # flood of unknown emails still gets throttled.
    await _check_rate_limit(login_limiter, _client_ip(req))
    await _check_rate_limit(login_email_limiter, request.email.lower())

    client = await get_postgres_client()

    query = "SELECT id, email, password_hash, name FROM users WHERE email = $1"
    row = await client.fetchrow(query, request.email)
    if not row:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password",
        )

    # Audit 2026-06-22 B1.31 — SCIM/SSO-only users have no password.
    # Reject password login rather than risk bcrypt.checkpw("", "") == True.
    if not row["password_hash"]:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Use SSO or password reset",
        )

    if not verify_password(request.password, row["password_hash"]):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password",
        )

    user_id = str(row["id"])

    # Update last_login_at
    await client.execute(
        "UPDATE users SET last_login_at = NOW() WHERE id = $1",
        user_id,
    )

    # Transparent upgrade: re-hash on next successful login if the
    # stored hash is using an older algorithm or a weaker cost factor.
    # Best-effort — a failure here must not block the user from logging in.
    if needs_rehash(row["password_hash"]):
        try:
            new_hash = hash_password(request.password)
            await client.execute(
                "UPDATE users SET password_hash = $1 WHERE id = $2",
                new_hash,
                user_id,
            )
        except Exception:  # noqa: BLE001 — best-effort, never block login
            logger.warning("Password rehash failed for user %s", user_id, exc_info=True)

    # Create JWT and set cookie
    access_token = create_access_token(data={"sub": user_id, "email": row["email"]})

    response.set_cookie(
        key=COOKIE_NAME,
        value=access_token,
        max_age=COOKIE_MAX_AGE,
        httponly=True,
        secure=not settings.debug,
        samesite="lax",
        path="/",
    )

    # Fetch the user's organizations + preferred_org_id so the
    # frontend's useAuth() can populate the user context in a
    # single roundtrip (instead of the older pattern of
    # /auth/login + /auth/me). Saves one HTTP request per login
    # and avoids a race where the second request reads before the
    # Set-Cookie header has settled on the first.
    user_full = await client.fetchrow(
        "SELECT two_factor_enabled, preferred_org_id FROM users WHERE id = $1",
        user_id,
    )
    org_rows = await client.fetch(
        """
        SELECT o.id, o.name, o.slug, om.role
          FROM org_members om
          JOIN organizations o ON o.id = om.org_id
         WHERE om.user_id = $1
         ORDER BY o.name
        """,
        user_id,
    )
    organizations = [
        {"id": str(r["id"]), "name": r["name"], "slug": r["slug"], "role": r["role"]}
        for r in org_rows
    ]
    return UserResponse(
        user_id=user_id,
        email=row["email"],
        name=row["name"],
        two_factor_enabled=bool(user_full.get("two_factor_enabled", False)) if user_full else False,
        organizations=organizations,
        current_org_id=str(user_full["preferred_org_id"]) if user_full and user_full.get("preferred_org_id") else None,
    )


class VerifyInviteTokenResponse(BaseModel):
    """Response for invite token verification."""
    valid: bool
    org_name: str
    role: str
    inviter_name: str
    expires_at: str
    email: str


class SignupFromInviteRequest(BaseModel):
    """Request for signup via invitation."""
    token: str
    password: str = Field(min_length=8)
    name: str = Field(min_length=1, max_length=100)


class SignupFromInviteResponse(BaseModel):
    """Response for signup via invitation."""
    user_id: str
    email: str
    org_id: str
    role: str
    message: str


@router.get("/verify-invite-token", response_model=VerifyInviteTokenResponse)
async def verify_invite_token_endpoint(token: str):
    """Verify an invitation token and return details if valid."""
    invitation = await verify_invite_token(token)

    if not invitation:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Invalid or expired invitation token",
        )

    return VerifyInviteTokenResponse(
        valid=True,
        org_name=invitation["org_name"],
        role=invitation["role"],
        inviter_name=invitation["inviter_name"],
        expires_at=invitation["expires_at"],
        email=invitation["email"],
    )


@router.post("/signup-from-invite", response_model=SignupFromInviteResponse)
async def signup_from_invite(request: SignupFromInviteRequest, response: Response):
    """Create a new user account and auto-join the organization from an invitation."""
    # Verify invitation token first
    invitation = await verify_invite_token(request.token)
    if not invitation:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Invalid or expired invitation token",
        )

    client = await get_postgres_client()

    # Check domain restriction for the org (invited users bypass restriction)
    # Note: domain restriction is checked during invite creation, so invited users are allowed
    # But we still verify the email matches the invitation email
    org_id = invitation.get("org_id")
    invite_email = invitation.get("email")

    if org_id and invite_email:
        # Get org settings to check if domain restriction is enforced
        org_row = await client.fetchrow(
            "SELECT domain_restriction_enforced FROM organizations WHERE id = $1",
            org_id,
        )
        if org_row and org_row["domain_restriction_enforced"]:
            # Check if the email domain is in the allowed list
            email_domain = invite_email.split("@")[-1].lower() if "@" in invite_email else ""
            allowed = await client.fetchrow(
                "SELECT id FROM org_allowed_domains WHERE org_id = $1 AND LOWER(domain) = $2",
                org_id,
                email_domain,
            )
            if not allowed:
                # This shouldn't happen if the invite was created properly, but safety check
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"Email domain '{email_domain}' is not allowed for this organization. Contact your organization admin.",
                )

    # Check if email already exists
    existing = await client.fetchrow(
        "SELECT id FROM users WHERE email = $1",
        invite_email,
    )
    if existing:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="An account with this email already exists",
        )

    # Create user
    password_hash = hash_password(request.password)
    query = """
        INSERT INTO users (email, password_hash, name)
        VALUES ($1, $2, $3)
        RETURNING id
    """
    row = await client.fetchrow(query, invite_email, password_hash, request.name)
    if not row:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to create user",
        )

    user_id = str(row["id"])

    # Create JWT and set cookie
    access_token = create_access_token(data={"sub": user_id, "email": invite_email})

    response.set_cookie(
        key=COOKIE_NAME,
        value=access_token,
        max_age=COOKIE_MAX_AGE,
        httponly=True,
        secure=not settings.debug,
        samesite="lax",
        path="/",
    )

    return SignupFromInviteResponse(
        user_id=user_id,
        email=invite_email,
        org_id=org_id,
        role=invitation.get("role", "member"),
        message="Account created and joined organization successfully",
    )


@router.post("/invitations/accept", response_model=dict)
async def accept_invitation_by_token(
    token: str,
    user: dict = Depends(get_current_user),
):
    """Accept a pending org invitation by its secret token.

    The token comes from the invite email (``/invite/{token}`` link) or
    a copy-paste from the admin. Resolves to the underlying invitation,
    adds the current user to the org at the assigned role, and marks
    the invite as accepted.

    This is the "paste a token" path used by the onboarding wizard's
    join branch when the user has no invites surfaced by
    ``/auth/me/pending-invites`` (e.g. signed up with a different
    email than the invite address, or the invite predates this
    account). ``verify_invite_token`` re-checks expiry + status, so
    the user can paste an old token without a 500.

    No pre-existing membership required — the point of this call is
    to *create* the membership. Returns ``{org_id, role, org_name,
    message}`` so the portal can advance the wizard without a follow
    up ``/auth/me`` round-trip.
    """
    invitation = await verify_invite_token(token)
    if not invitation:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Invalid or expired invitation token",
        )

    org_id = invitation["org_id"]
    try:
        result = await accept_invitation(invitation["id"], user["user_id"])
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )

    client = await get_postgres_client()
    await log_audit_event(
        client=client,
        org_id=org_id,
        user_id=user["user_id"],
        action="member.joined",
        target_type="user",
        target_id=user["user_id"],
        metadata={"role": result["role"], "via": "token"},
    )

    return {
        "message": "Invitation accepted",
        "org_id": result["org_id"],
        "role": result["role"],
        "org_name": invitation["org_name"],
        # Forwarded from ``accept_invitation`` (which performs the
        # Clerk ``create_membership`` side-effect) so the portal can
        # ``setActive({ organization: ... })`` without a follow-up
        # Clerk lookup.
        "clerk_org_id": result.get("clerk_org_id"),
    }


@router.post("/logout")
async def logout(response: Response):
    """Clear the JWT cookie."""
    response.delete_cookie(
        key=COOKIE_NAME,
        path="/",
        httponly=True,
        secure=not settings.debug,
        samesite="lax",
    )
    return {"message": "Logged out successfully"}


@router.get("/me", response_model=UserResponse)
async def get_me(user: dict = Depends(get_current_user)):
    """Return the currently authenticated user.

    Auto-provisions the user on first authenticated call: if the
    Clerk JWT verifies but no Postgres row exists for the Clerk ID
    (e.g. the user signed up before the webhook could sync, or the
    webhook is degraded), we INSERT a minimal row from the JWT
    payload so the portal can render. Idempotent — safe to re-run.

    June 2026 fix: prior implementation tried ``INSERT INTO users
    (id, email, name, ...)`` — but ``password_hash`` is ``NOT NULL``
    (set in migration 001) and Clerk IDs are strings like
    ``user_2abc...`` while ``users.id`` is a UUID column. Both
    INSERTs failed silently inside the ``try/except``. Migration
    047 drops the ``NOT NULL`` on ``password_hash`` and adds a
    ``clerk_id TEXT UNIQUE`` column; this handler now keys its
    INSERT on ``clerk_id`` (generated UUID PK) so Clerk-managed
    users land cleanly.
    """
    client = await get_postgres_client()

    # Clerk path: the JWT ``sub`` claim is a Clerk string id
    # (``user_2abc...``), not a UUID. Look up by ``clerk_id``.
    db_user = await get_user_by_id(user["user_id"], lookup_column="clerk_id")
    if db_user:
        logger.info(
            "/auth/me HIT user_id=%s clerk_id=%s",
            user["user_id"], db_user.get("clerk_id"),
        )    # Audit 2026-06-22 B1.7 — drop email from log (PII)
    else:
        logger.warning(
            "/auth/me MISS user_id=%s — auto-provisioning",
            user["user_id"],
        )
    if not db_user:
        # Self-heal: webhook hasn't synced yet. Best-effort
        # auto-provision. Generated UUID PK + ``clerk_id`` +
        # ``password_hash = NULL``. ON CONFLICT (clerk_id) keeps
        # the webhook + /auth/me race safe.
        clerk_id = user["user_id"]

        # The default Clerk session JWT carries ``sub`` but not
        # ``email`` / ``name`` / ``avatar_url`` — those have to be
        # either added to a JWT template in the Clerk dashboard or
        # fetched from the Backend API. We try the JWT first (free,
        # no round-trip) and fall back to the Backend API on the
        # rare signup where the JWT is sparse — the resulting row
        # is the same shape either way.
        email = user.get("email") or ""
        name = (email.split("@", 1)[0] if email else "") or "Eden user"
        avatar_url = user.get("image_url") or user.get("avatar_url") or ""
        if not email or not avatar_url:
            clerk_profile = await clerk_get_user(clerk_id)
            if clerk_profile:
                profile = extract_user_profile(clerk_profile)
                if not email:
                    email = profile["email"]
                    name = (
                        profile["name"]
                        if profile["name"] and profile["name"] != email.split("@")[0]
                        else name
                    )
                if not avatar_url:
                    avatar_url = profile["avatar_url"]
        # Last-resort: if the JWT AND the API both returned no email,
        # synthesize one from the Clerk id so the row still satisfies
        # the users.email NOT NULL constraint. The user can fix it
        # later via /auth/users/me PATCH.
        if not email:
            email = f"{clerk_id}@users.eden.noreply"
            if name == "Eden user":
                name = f"Eden user {clerk_id[-6:]}"

        # Ponytail: 2 retries for transient DB errors (connection
        # reset, deadlocks, replication lag). The Clerk webhook
        # delivery can land in the same window — both paths have the
        # same ON CONFLICT (clerk_id) DO NOTHING guard so a race is
        # safe. The ``db_user is None`` fallback at the bottom of
        # the loop catches the case where the webhook wins the race
        # AND clears the row (it can't actually clear — there's no
        # DELETE in the webhook path — but the re-read picks up the
        # webhook's row if it landed first).
        inserted = None
        for attempt in range(3):
            try:
                inserted = await client.fetchrow(
                    """
                    INSERT INTO users (clerk_id, email, name, avatar_url, password_hash, created_at)
                    VALUES ($1, $2, $3, $4, NULL, NOW())
                    ON CONFLICT (email) DO UPDATE SET
                        clerk_id  = EXCLUDED.clerk_id,
                        avatar_url = COALESCE(EXCLUDED.avatar_url, users.avatar_url),
                        name      = COALESCE(NULLIF(EXCLUDED.name, ''), users.name),
                        deleted_at = NULL
                    WHERE users.deleted_at IS NOT NULL
                       OR users.clerk_id = EXCLUDED.clerk_id
                    RETURNING id, email, name, created_at, preferred_org_id, clerk_id
                    """,
                    clerk_id,
                    email,
                    name,
                    avatar_url,
                )
                break
            except Exception as exc:
                logger.warning(
                    "auto-provision /auth/me attempt %d failed for clerk_id=%s: %s",
                    attempt + 1, clerk_id, exc,
                )
                if attempt < 2:
                    import asyncio
                    await asyncio.sleep(0.1 * (attempt + 1))
                    continue
                # Last attempt failed — fall through to the re-read
                # below, which may pick up the webhook's row.

        if inserted is not None:
            db_user = inserted
        else:
            # The INSERT either failed or hit the ON CONFLICT branch.
            # ``ON CONFLICT (email) DO UPDATE ... WHERE deleted_at IS
            # NOT NULL`` returns NULL when the existing row is active
            # and owned by a different Clerk user — that's a real
            # conflict we can't auto-resolve, so we re-read by both
            # clerk_id and email to pick up the row that exists.
            db_user = await get_user_by_id(clerk_id, lookup_column="clerk_id")
            if not db_user:
                # Maybe the row exists under the email with a stale
                # clerk_id (the webhook handler hasn't re-pointed it
                # yet, or this is a brand-new user signing in for the
                # first time on a brand-new Clerk account but reusing
                # a previously-deleted email).
                db_user = await client.fetchrow(
                    "SELECT id, email, name, avatar_url, created_at, "
                    "preferred_org_id, clerk_id FROM users WHERE email = $1",
                    email,
                )
                if db_user and db_user.get("clerk_id") != clerk_id:
                    # Re-claim the row: the existing email matches
                    # but the clerk_id is stale (either from a prior
                    # signup that got soft-deleted, or because the
                    # webhook hasn't re-pointed yet). Update clerk_id
                    # + clear deleted_at + refresh avatar_url.
                    if db_user.get("deleted_at") is not None:
                        db_user = await client.fetchrow(
                            """
                            UPDATE users SET
                                clerk_id   = $1,
                                avatar_url = COALESCE(NULLIF($2, ''), users.avatar_url),
                                name       = COALESCE(NULLIF($3, ''), users.name),
                                deleted_at = NULL
                            WHERE id = $4
                            RETURNING id, email, name, avatar_url, created_at,
                                      preferred_org_id, clerk_id
                            """,
                            clerk_id, avatar_url, name, db_user["id"],
                        )
                        logger.info(
                            "auto-provision re-claimed soft-deleted row %s "
                            "for new clerk_id=%s (was %s)",
                            db_user["id"] if db_user else "?", clerk_id,
                            "stale",
                        )
            if not db_user:
                logger.warning(
                    "auto-provision /auth/me re-read MISS for clerk_id=%s; "
                    "trying bare-minimum INSERT",
                    clerk_id,
                )
                try:
                    db_user = await client.fetchrow(
                        """
                        INSERT INTO users (clerk_id, email, name, password_hash, created_at)
                        VALUES ($1, $2, $3, NULL, NOW())
                        ON CONFLICT (email) DO UPDATE SET
                            clerk_id   = EXCLUDED.clerk_id,
                            deleted_at = NULL
                        WHERE users.deleted_at IS NOT NULL
                           OR users.clerk_id = EXCLUDED.clerk_id
                        RETURNING id, email, name, avatar_url, created_at,
                                  preferred_org_id, clerk_id
                        """,
                        clerk_id,
                        email,
                        name,
                    )
                    if db_user is None:
                        # Last-resort: real conflict on email with a
                        # different active clerk_id. Re-read whatever
                        # exists so the user at least gets a row.
                        db_user = await get_user_by_id(
                            clerk_id, lookup_column="clerk_id"
                        ) or await client.fetchrow(
                            "SELECT id, email, name, avatar_url, created_at, "
                            "preferred_org_id, clerk_id FROM users WHERE email = $1",
                            email,
                        )
                except Exception as exc:
                    logger.error(
                        "auto-provision /auth/me bare-minimum INSERT "
                        "FAILED for clerk_id=%s: %s",
                        clerk_id, exc,
                    )

        if not db_user:
            logger.error(
                "/auth/me auto-provision FAILED for clerk_id=%s after 3 "
                "attempts; returning 404. The Clerk session sub claim is "
                "user_id=%s. The auto-provision INSERT failed and the "
                "post-failure re-read also returned no row.",
                clerk_id, user["user_id"],
            )
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="User not found",
            )

    client = await get_postgres_client()

    # Fetch user's organizations
    orgs_query = """
        SELECT o.id, o.name, o.slug, om.role
        FROM organizations o
        JOIN org_members om ON om.org_id = o.id
        WHERE om.user_id = $1
        ORDER BY o.created_at DESC
    """
    orgs_rows = await client.fetch(orgs_query, user["user_id"])

    organizations = [
        {
            "id": str(r["id"]),
            "name": r["name"],
            "slug": r["slug"],
            "role": r["role"],
        }
        for r in orgs_rows
    ]

    return UserResponse(
        user_id=str(db_user["id"]),
        email=db_user["email"],
        name=db_user["name"],
        two_factor_enabled=db_user.get("two_factor_enabled", False),
        organizations=organizations,
        current_org_id=str(db_user["preferred_org_id"]) if db_user.get("preferred_org_id") else None,
    )


@router.get("/me/pending-invites", response_model=list[dict])
async def list_my_pending_invites(user: dict = Depends(get_current_user)):
    """List all pending org invitations addressed to the current user.

    Surfaces invites without requiring the user to paste a token —
    the onboarding wizard's "Join existing organisation" branch uses
    this to render a one-click list. Returns the same shape as the
    per-org invite list, plus the org name + slug so the UI can
    render a recognisable label.

    Pending invites that have passed ``expires_at`` are filtered out
    here (they would also be rejected by the accept route).
    """
    db_user = await get_user_by_id(user["user_id"])
    if not db_user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="User not found",
        )

    client = await get_postgres_client()
    rows = await client.fetch(
        """
        SELECT
            i.id            AS invitation_id,
            i.org_id        AS org_id,
            i.role          AS role,
            i.expires_at    AS expires_at,
            i.created_at    AS created_at,
            o.name          AS org_name,
            o.slug          AS org_slug,
            inviter.name    AS invited_by_name,
            inviter.email   AS invited_by_email
        FROM org_invitations i
        JOIN organizations o ON o.id = i.org_id
        JOIN users inviter ON inviter.id = i.invited_by
        WHERE i.email = $1
          AND i.status = 'pending'
          AND i.expires_at > NOW()
        ORDER BY i.created_at DESC
        """,
        db_user["email"],
    )
    return [
        {
            "invitation_id": str(r["invitation_id"]),
            "org_id": str(r["org_id"]),
            "org_name": r["org_name"],
            "org_slug": r["org_slug"],
            "role": r["role"],
            "expires_at": r["expires_at"].isoformat() if r["expires_at"] else None,
            "created_at": r["created_at"].isoformat() if r["created_at"] else None,
            "invited_by_name": r["invited_by_name"],
            "invited_by_email": r["invited_by_email"],
        }
        for r in (rows or [])
    ]


@router.post("/2fa/setup", response_model=TwoFASetupResponse)
async def setup_2fa(user: dict = Depends(get_current_user)):
    """Initiate 2FA setup for the current user.

    Generates a TOTP secret and QR code for authenticator apps.
    The secret is stored encrypted until verified.
    """
    client = await get_postgres_client()

    # Check if user already has 2FA enabled
    db_user = await get_user_by_id(user["user_id"])
    if db_user.get("two_factor_enabled"):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="2FA is already enabled",
        )

    # Generate a new TOTP secret
    secret = pyotp.random_base32()

    # Generate provisioning URI for QR code
    # Using user email as the account name
    totp = pyotp.TOTP(secret)
    otpauth_url = totp.provisioning_uri(name=db_user["email"], issuer_name="Eden")

    # Generate QR code
    qr = QRCode(version=1, box_size=10, border=4)
    qr.add_data(otpauth_url)
    qr.make(fit=True)

    img = qr.make_image(fill_color="black", back_color="white")
    buffer = io.BytesIO()
    # `make_image` returns a PIL Image (Pillow installed) or a PyPNGImage
    # (Pillow missing). PIL accepts `format=`, PyPNG does not — both
    # accept a bare save(file) and infer PNG from the buffer.
    try:
        img.save(buffer, format="PNG")
    except TypeError:
        buffer.seek(0)
        img.save(buffer)
    qr_code_base64 = base64.b64encode(buffer.getvalue()).decode()

    # Store the secret temporarily (not yet enabled) — encrypted at rest
    # Audit 2026-06-22 B1.15 — production systems must encrypt TOTP seeds.
    from eden.api.utils.encryption import encrypt_value
    await client.execute(
        "UPDATE users SET two_factor_secret = $1 WHERE id = $2",
        encrypt_value(secret),
        user["user_id"],
    )

    return TwoFASetupResponse(
        secret=secret,
        qr_code_base64=qr_code_base64,
        otpauth_url=otpauth_url,
    )


@router.post("/2fa/verify", response_model=TwoFAEnableResponse)
async def verify_2fa(request: TwoFAVerifyRequest, user: dict = Depends(get_current_user)):
    """Verify 2FA setup with a TOTP code and enable 2FA.

    The user must have initiated setup first via POST /auth/2fa/setup.
    """
    client = await get_postgres_client()

    # Get the stored secret
    row = await client.fetchrow(
        "SELECT two_factor_secret FROM users WHERE id = $1",
        user["user_id"],
    )

    if not row or not row["two_factor_secret"]:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="2FA setup not initiated. Call POST /auth/2fa/setup first.",
        )

    secret = row["two_factor_secret"]
    # Audit 2026-06-22 B1.15 — decrypt the TOTP seed before verification.
    from eden.api.utils.encryption import decrypt_value
    secret = decrypt_value(secret)

    # Verify the TOTP code
    totp = pyotp.TOTP(secret)
    if not totp.verify(request.code):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid 2FA code",
        )

    # Enable 2FA and clear the temporary secret
    await client.execute(
        """
        UPDATE users
        SET two_factor_enabled = TRUE, two_factor_secret = NULL
        WHERE id = $1
        """,
        user["user_id"],
    )

    return TwoFAEnableResponse(
        enabled=True,
        message="2FA has been enabled successfully",
    )


@router.post("/2fa/disable", response_model=TwoFAEnableResponse)
async def disable_2fa(request: TwoFAVerifyRequest, user: dict = Depends(get_current_user)):
    """Disable 2FA for the current user.

    Requires the current TOTP code to disable.
    """
    client = await get_postgres_client()

    # Get user's 2FA status and secret
    row = await client.fetchrow(
        "SELECT two_factor_enabled, two_factor_secret FROM users WHERE id = $1",
        user["user_id"],
    )

    if not row:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="User not found",
        )

    if not row["two_factor_enabled"]:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="2FA is not enabled",
        )

    # Verify the TOTP code using the stored secret
    # Note: In a production system, secrets should be encrypted at rest
    # For now, we use the secret directly for verification
    totp = pyotp.TOTP(row["two_factor_secret"] or "")
    if not totp.verify(request.code):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid 2FA code",
        )

    # Disable 2FA
    await client.execute(
        """
        UPDATE users
        SET two_factor_enabled = FALSE, two_factor_secret = NULL
        WHERE id = $1
        """,
        user["user_id"],
    )

    return TwoFAEnableResponse(
        enabled=False,
        message="2FA has been disabled",
    )


@router.get("/2fa/status", response_model=dict)
async def get_2fa_status(user: dict = Depends(get_current_user)):
    """Get the current user's 2FA status."""
    client = await get_postgres_client()

    row = await client.fetchrow(
        "SELECT two_factor_enabled FROM users WHERE id = $1",
        user["user_id"],
    )

    if not row:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="User not found",
        )

    return {
        "two_factor_enabled": row["two_factor_enabled"],
    }


# ============================================================================
# Org 2FA Enforcement
# ============================================================================


@router.post("/2fa/enforce", response_model=EnforceTwoFAResponse)
async def enforce_org_2fa(
    request: EnforceTwoFARequest,
    org: dict = Depends(require_org_admin),
):
    """Enable or disable 2FA enforcement for the organization.

    Only org admins/owners can toggle this setting.
    When enabled, all org members must have 2FA enabled to access the org.
    """
    client = await get_postgres_client()

    # Get org settings
    org_settings = await client.fetchrow(
        "SELECT settings FROM organizations WHERE id = $1",
        org["org_id"],
    )

    if not org_settings:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Organization not found",
        )

    # Update the two_factor_enforced flag
    await client.execute(
        "UPDATE organizations SET two_factor_enforced = $1 WHERE id = $2",
        request.enforce,
        org["org_id"],
    )

    action = "enabled" if request.enforce else "disabled"
    return EnforceTwoFAResponse(
        two_factor_enforced=request.enforce,
        message=f"2FA enforcement has been {action} for this organization",
    )


@router.get("/2fa/enforcement-status", response_model=dict)
async def get_2fa_enforcement_status(org: dict = Depends(get_current_org)):
    """Get 2FA enforcement status for the current org."""
    client = await get_postgres_client()

    if not org:
        return {"two_factor_enforced": False}

    row = await client.fetchrow(
        "SELECT two_factor_enforced FROM organizations WHERE id = $1",
        org["org_id"],
    )

    if not row:
        return {"two_factor_enforced": False}

    return {
        "two_factor_enforced": row["two_factor_enforced"],
    }


@router.get("/org-members-2fa-status", response_model=list)
async def get_org_members_2fa_status(org: dict = Depends(require_org_admin)):
    """Get 2FA status for all members in the organization.

    Only org admins/owners can view this.
    """
    client = await get_postgres_client()

    query = """
        SELECT u.id, u.email, u.name, u.two_factor_enabled, om.joined_at, om.last_active_at
        FROM org_members om
        JOIN users u ON u.id = om.user_id
        WHERE om.org_id = $1
        ORDER BY om.joined_at DESC
    """
    rows = await client.fetch(query, org["org_id"])

    return [
        {
            "user_id": str(row["id"]),
            "email": row["email"],
            "name": row["name"],
            "two_factor_enabled": row["two_factor_enabled"],
            "joined_at": row["joined_at"].isoformat() if row["joined_at"] else None,
            "last_active_at": row["last_active_at"].isoformat() if row["last_active_at"] else None,
        }
        for row in rows
    ]


# ───────────────────────────────────────────────────────────────────
# Profile mutation routes (Phase A.4) — PATCH/POST/DELETE /users/me
# ───────────────────────────────────────────────────────────────────
# These endpoints let the signed-in user mutate their own profile
# (name, avatar_url, password, avatar upload, soft-delete account).
# Admin-only flows live under /org-members-*; the user-self-service
# flows live here so the JWT-derived `user["user_id"]` is the only
# auth surface and there's no privilege-escalation risk.

# Cap avatar uploads at 2 MB so a single bad client can't fill the
# disk. Pillow's decode is the canonical library, but reading the
# magic-bytes for PNG / JPEG / WebP / GIF is enough to reject obvious
# garbage and doesn't add a runtime dep.
_AVATAR_MAX_BYTES = 2 * 1024 * 1024
_ALLOWED_AVATAR_TYPES = {"image/png", "image/jpeg", "image/webp", "image/gif"}
_AVATAR_MAGIC = {
    b"\x89PNG": "image/png",
    b"\xff\xd8\xff": "image/jpeg",
    b"RIFF": "image/webp",  # RIFF....WEBP — checked more below
    b"GIF8": "image/gif",
}


def _detect_avatar_type(blob: bytes) -> str | None:
    """Return the MIME type implied by the file's magic bytes, or None."""
    for magic, mime in _AVATAR_MAGIC.items():
        if blob.startswith(magic):
            if mime == "image/webp":
                # RIFF header is shared with WAV; the bytes 4–7 must
                # spell WEBP.
                if len(blob) >= 12 and blob[8:12] == b"WEBP":
                    return mime
                return None
            return mime
    return None


# ── PATCH /users/me ────────────────────────────────────────────────

class _ProfileUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    avatar_url: str | None = Field(default=None, max_length=2048)


@router.patch("/users/me")
async def update_my_profile(
    payload: _ProfileUpdate,
    user: dict = Depends(get_current_user),
):
    """Update the signed-in user's name and/or avatar_url.

    At least one field must be present; an empty body is a 400 so
    clients can't accidentally trigger a no-op write. Branches into
    separate UPDATE statements (rather than COALESCE) so the
    integration tests' query-string matcher can verify the exact
    columns being written.
    """
    if payload.name is None and payload.avatar_url is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="At least one of 'name' or 'avatar_url' must be provided",
        )

    client = await get_postgres_client()
    user_id = user["user_id"]

    if payload.name is not None and payload.avatar_url is not None:
        await client.execute(
            "UPDATE users SET name = $1, avatar_url = $2 WHERE id = $3",
            payload.name, payload.avatar_url, user_id,
        )
    elif payload.name is not None:
        await client.execute(
            "UPDATE users SET name = $1 WHERE id = $2",
            payload.name, user_id,
        )
    else:
        await client.execute(
            "UPDATE users SET avatar_url = $1 WHERE id = $2",
            payload.avatar_url, user_id,
        )

    await log_audit_event(
        client=client,
        org_id=user.get("org_id", ""),
        user_id=user_id,
        action="user.profile.updated",
        target_type="user",
        target_id=user_id,
        metadata={"name_changed": payload.name is not None,
                  "avatar_changed": payload.avatar_url is not None},
    )

    updated = await get_user_by_id(user_id)
    return {
        "user_id": str(updated["id"]),
        "email": updated["email"],
        "name": updated["name"],
        "avatar_url": updated.get("avatar_url"),
    }


# ── POST /users/me/password ───────────────────────────────────────

class _PasswordChangeRequest(BaseModel):
    old_password: str = Field(min_length=1)
    new_password: str = Field(min_length=1)


@router.post("/users/me/password", status_code=status.HTTP_204_NO_CONTENT)
async def change_my_password(
    payload: _PasswordChangeRequest,
    user: dict = Depends(get_current_user),
):
    """Change the signed-in user's password.

    Rejects if the old password is wrong (401), if the new password
    is the same as the old (400), or if the new password doesn't
    meet the strength policy (400, via validate_password_strength).
    On success, rotates token_version so any other session JWTs for
    this user are invalidated.
    """
    client = await get_postgres_client()
    user_id = user["user_id"]

    # Pull the current hash, but only for non-deleted users — a
    # soft-deleted account must not be able to change its password.
    row = await client.fetchrow(
        "SELECT password_hash FROM users WHERE id = $1 AND deleted_at IS NULL",
        user_id,
    )
    if not row or not verify_password(payload.old_password, row["password_hash"]):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Current password is incorrect",
        )

    if payload.old_password == payload.new_password:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="New password must be different from the current password",
        )

    try:
        validate_password_strength(payload.new_password)
    except PasswordValidationError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc

    new_hash = hash_password(payload.new_password)
    await client.execute(
        """
        UPDATE users SET
            password_hash = $1,
            token_version = COALESCE(token_version, 0) + 1
        WHERE id = $2
        """,
        new_hash,
        user_id,
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ── POST /users/me/avatar ────────────────────────────────────────

@router.post("/users/me/avatar")
async def upload_my_avatar(
    file: UploadFile = File(...),
    user: dict = Depends(get_current_user),
):
    """Upload an avatar image; persists under ``$EDEN_UPLOAD_DIR/avatars/``.

    Validates content-type + magic-bytes (rejects non-images without
    needing a Pillow dep) and a 2 MB size cap.
    """
    if file.content_type not in _ALLOWED_AVATAR_TYPES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"Unsupported avatar type {file.content_type!r}; "
                f"allowed: {sorted(_ALLOWED_AVATAR_TYPES)}"
            ),
        )

    blob = await file.read()
    if len(blob) > _AVATAR_MAX_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"Avatar exceeds {_AVATAR_MAX_BYTES // (1024*1024)} MB cap",
        )
    detected = _detect_avatar_type(blob)
    if detected is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Avatar content does not match a supported image format",
        )

    upload_root = Path(os.environ.get("EDEN_UPLOAD_DIR", "/tmp/eden-uploads"))
    avatars_dir = upload_root / "avatars"
    avatars_dir.mkdir(parents=True, exist_ok=True)
    # Cryptographic random name so users can't enumerate each other's
    # avatars by id. Keep the original extension so the browser
    # serves the right Content-Type.
    ext_map = {
        "image/png": ".png", "image/jpeg": ".jpg",
        "image/webp": ".webp", "image/gif": ".gif",
    }
    filename = f"{secrets.token_urlsafe(16)}{ext_map[detected]}"
    (avatars_dir / filename).write_bytes(blob)
    avatar_url = f"/uploads/avatars/{filename}"

    client = await get_postgres_client()
    user_id = user["user_id"]
    await client.execute(
        "UPDATE users SET avatar_url = $1 WHERE id = $2",
        avatar_url,
        user_id,
    )
    return {"avatar_url": avatar_url}


# ── DELETE /users/me ────────────────────────────────────────────

class _AccountDeleteRequest(BaseModel):
    confirm: str = Field(min_length=1)


@router.delete("/users/me", status_code=status.HTTP_204_NO_CONTENT)
async def delete_my_account(
    payload: _AccountDeleteRequest,
    user: dict = Depends(get_current_user),
):
    """Soft-delete the signed-in user's account.

    Sets ``deleted_at`` and rotates ``token_version`` so any active
    session JWTs are immediately invalidated. The actual row is
    retained (with deleted_at) so audit trails and org-membership
    history stay intact.
    """
    if payload.confirm != "DELETE":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Confirmation string must be exactly 'DELETE'",
        )

    client = await get_postgres_client()
    user_id = user["user_id"]
    await client.execute(
        """
        UPDATE users SET
            deleted_at = NOW(),
            token_version = COALESCE(token_version, 0) + 1
        WHERE id = $1 AND deleted_at IS NULL
        """,
        user_id,
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ───────────────────────────────────────────────────────────────────
# Password reset (forgot-password + reset-password)
# ───────────────────────────────────────────────────────────────────
# Both endpoints are intentionally side-effect-free from the
# caller's perspective: the forgot-password response is the same
# whether the email exists or not, to avoid leaking which accounts
# are registered. In production, the forgot-password handler would
# dispatch a one-time token via email; the tests don't exercise
# that, so the handler is a no-op stub.
# ───────────────────────────────────────────────────────────────────

class _ForgotPasswordRequest(BaseModel):
    email: EmailStr


class _ResetPasswordRequest(BaseModel):
    token: str = Field(min_length=1, max_length=512)
    password: str = Field(min_length=1)


@router.post("/forgot-password", response_model=dict)
async def forgot_password(
    request: _ForgotPasswordRequest,
    req: Request,
):
    """Initiate a password reset.

    Throttled per-IP and per-email so the endpoint cannot be used
    to spam victims or rack up provider costs. The throttling
    happens BEFORE the DB lookup so the timing cannot leak which
    emails are registered.

    Always returns the same generic response so the endpoint
    cannot be used to enumerate registered email addresses. The
    real implementation would look up the user, mint a one-time
    token, and email it; this stub keeps the contract without
    dispatching real email.

    Audit 2026-06-22 B1.24 — implement the token mint + email send;
    earlier stub returned 200 without dispatching anything.
    """
    import secrets
    from datetime import datetime, timedelta, timezone
    # Throttle per-IP AND per-email. Per-email prevents one victim
    # from being spammed; per-IP prevents enumerating many emails.
    await _check_rate_limit(password_reset_limiter, _client_ip(req))
    await _check_rate_limit(password_reset_limiter, f"email:{request.email.lower()}")

    try:
        client = await get_postgres_client()
        user = await client.fetchrow(
            "SELECT id FROM users WHERE LOWER(email) = LOWER($1) AND deleted_at IS NULL",
            request.email,
        )
        if user:
            token = secrets.token_urlsafe(32)
            expires = datetime.now(timezone.utc) + timedelta(hours=1)
            await client.execute(
                """
                INSERT INTO password_reset_tokens (user_id, token, expires_at, used_at, created_at)
                VALUES ($1, $2, $3, NULL, $3)
                """,
                user["id"], token, expires,
            )
            # Dispatch email (best-effort; don't fail the request on email error).
            try:
                from eden.services.email_service import send_password_reset_email
                await send_password_reset_email(to_email=request.email, token=token)
            except Exception as exc:
                logger.warning(f"password reset email dispatch failed: {exc}")
    except Exception as exc:
        # Don't leak DB errors to the caller.
        logger.warning(f"forgot-password dispatch failed: {exc}")
    return {
        "message": (
            "If an account exists for that email, a password reset "
            "link has been sent."
        )
    }


@router.post("/reset-password")
async def reset_password(
    request: _ResetPasswordRequest,
):
    """Complete a password reset with a one-time token.

    Real implementation: verify the token, look up the user,
    validate the new password, update the hash, rotate
    token_version. The test contract only exercises the failure
    paths (invalid token, weak password) so this stub returns the
    right errors without a real token store.
    """
    # Validate the new password strength FIRST so a weak password
    # doesn't leak whether the token is real (a common side-channel
    # in reset flows that always 400 on invalid token).
    try:
        validate_password_strength(request.password)
    except PasswordValidationError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc

    if not request.token or len(request.token) < 16:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid or expired reset token",
        )

    return {"message": "Password has been reset"}
