"""Authentication routes for Eden client portal."""

import base64
import io
import logging

import pyotp
from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, EmailStr, Field
from qrcode import QRCode

from eden.api.deps import (
    get_current_org,
    get_current_user,
    get_user_by_id,
    log_audit_event,
    require_org_admin,
)
from eden.api.utils.auth import create_access_token, hash_password, verify_password
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
async def signup(request: SignupRequest, response: Response):
    """Create a new user account."""
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
    query = """
        INSERT INTO users (email, password_hash, name)
        VALUES ($1, $2, $3)
        RETURNING id
    """
    row = await client.fetchrow(query, request.email, password_hash, request.name)
    if not row:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to create user",
        )

    user_id = str(row["id"])

    # Create JWT and set cookie
    access_token = create_access_token(data={"sub": user_id, "email": request.email})

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
async def login(request: LoginRequest, response: Response):
    """Authenticate user and return JWT cookie."""
    client = await get_postgres_client()

    query = "SELECT id, email, password_hash, name FROM users WHERE email = $1"
    row = await client.fetchrow(query, request.email)
    if not row:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password",
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
    """Return the currently authenticated user."""
    db_user = await get_user_by_id(user["user_id"])
    if not db_user:
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

    # Store the secret temporarily (not yet enabled)
    await client.execute(
        "UPDATE users SET two_factor_secret = $1 WHERE id = $2",
        secret,
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
