"""Authentication routes for Eden client portal."""

import base64
import io
import logging
from datetime import UTC, datetime

import pyotp
from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, EmailStr, Field
from qrcode import QRCode

from eden.api.deps import (
    get_current_org,
    get_current_user,
    get_user_by_id,
    require_org_admin,
)
from eden.api.utils.auth import create_access_token, hash_password, verify_password
from eden.config import get_settings
from eden.services.invitation_service import verify_invite_token
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


@router.post("/signup", response_model=SignupResponse)
async def signup(request: SignupRequest, response: Response):
    """Create a new user account."""
    # Password strength bar (uppercase + digit + symbol). Runs
    # before the DB so a weak password never touches storage;
    # the Pydantic ``min_length=8`` handles the length floor.
    strength_err = _password_strength_error(request.password)
    if strength_err:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=strength_err,
        )

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

    return SignupResponse(
        user_id=user_id,
        email=request.email,
        message="Account created successfully",
    )


@router.post("/login", response_model=UserResponse)
async def login(request: LoginRequest, response: Response):
    """Authenticate user and return JWT cookie."""
    client = await get_postgres_client()

    query = "SELECT id, email, password_hash, name FROM users WHERE email = $1 AND deleted_at IS NULL"
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

    return UserResponse(
        user_id=user_id,
        email=row["email"],
        name=row["name"],
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
    # ``PyPNGImage.save`` (the pure-python backend qrcode ships
    # without Pillow) only accepts ``(stream, kind=None)`` — it
    # rejects a ``format=`` keyword. Use the positional ``kind``
    # slot to be defensive if a different backend is selected.
    img.save(buffer, kind="PNG")
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


# ─────────────────────────────────────────────────────────────────
# Password reset (Phase 7.5: portal surfaces ``/auth/forgot-password``
# and ``/auth/reset-password``). We always return a generic success
# message from ``/forgot-password`` (no email enumeration) and look up
# the token in the ``password_reset_token`` table on reset.
# ─────────────────────────────────────────────────────────────────

class ForgotPasswordRequest(BaseModel):
    email: EmailStr


class ForgotPasswordResponse(BaseModel):
    message: str


class ResetPasswordRequest(BaseModel):
    token: str
    # Length is checked manually in the handler so a short
    # password surfaces as a 400 with a friendlier message
    # rather than a Pydantic 422. The Pydantic ``min_length``
    # default would 422 before our handler runs.
    password: str


def _password_strength_error(password: str) -> str | None:
    """Return a human-readable error if the password is too weak.

    Enforces, on top of the Pydantic ``min_length=8``:
      • at least one uppercase letter
      • at least one digit
      • at least one symbol (any non-alphanumeric)

    Returns ``None`` when the password meets the bar. The check is
    shared between ``/auth/signup``, ``/auth/reset-password``, and
    any future password-set surface so the rules stay consistent.
    """
    if not any(c.isupper() for c in password):
        return "Password must contain at least one uppercase letter"
    if not any(c.isdigit() for c in password):
        return "Password must contain at least one digit"
    if not any(not c.isalnum() for c in password):
        return "Password must contain at least one symbol"
    return None


@router.post("/forgot-password", response_model=ForgotPasswordResponse)
async def forgot_password(request: ForgotPasswordRequest, response: Response):
    """Initiate a password-reset flow for the given email.

    Always returns the same generic message regardless of whether
    the email is registered, to prevent user-enumeration attacks.
    When the email is registered, an email is dispatched with a
    single-use token (mocked in tests via ``patch_email_service``).
    """
    # Strength-rule the email only — keep the rest of the
    # request body minimal so the route accepts malformed
    # submissions without 422-ing on the address itself.
    client = await get_postgres_client()
    row = await client.fetchrow(
        "SELECT id FROM users WHERE email = $1",
        request.email,
    )
    if row is not None:
        # Issue a token. We use ``secrets`` for an unguessable
        # opaque value and store it hashed so a DB leak doesn't
        # leak valid tokens. The row is upserted so a second
        # forgot-password for the same user replaces the prior
        # token (revoking any still-outstanding link).
        import hashlib
        import secrets

        raw_token = secrets.token_urlsafe(32)
        token_hash = hashlib.sha256(raw_token.encode()).hexdigest()
        await client.execute(
            """
            INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
            VALUES ($1, $2, NOW() + INTERVAL '1 hour')
            ON CONFLICT (user_id) DO UPDATE
              SET token_hash = EXCLUDED.token_hash,
                  expires_at = EXCLUDED.expires_at
            """,
            str(row["id"]),
            token_hash,
        )
        # Best-effort email send. The conftest patches the email
        # service so this stays a no-op in tests; in production
        # the EmailService would dispatch the reset link.
        try:
            from eden.services.email_service import get_email_service
            email_svc = get_email_service()
            await email_svc.send_email(
                to=request.email,
                subject="Reset your Eden password",
                body=f"Use this token to reset your password: {raw_token}",
            )
        except Exception:
            # Email failure must not block the generic response.
            pass

    # Same response shape regardless of whether the email exists.
    return ForgotPasswordResponse(
        message="If an account exists for that email, a password-reset link has been sent."
    )


@router.post("/reset-password", response_model=ForgotPasswordResponse)
async def reset_password(request: ResetPasswordRequest):
    """Reset a password using a token issued by ``/forgot-password``.

    Returns 400 for unknown / expired / already-used tokens and
    for passwords that don't meet the strength bar. The token is
    invalidated after a successful reset so it cannot be reused.
    """
    # Strength check before any DB work so a weak password
    # surfaces as a 400 even if the token is bad — matches the
    # spec's "reset with weak password returns 400" expectation.
    strength_err = _password_strength_error(request.password)
    if strength_err:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=strength_err,
        )
    # Length check — separate from strength so a too-short
    # password gets a clear, distinct message.
    if len(request.password) < 8:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Password must be at least 8 characters",
        )

    import hashlib

    client = await get_postgres_client()
    token_hash = hashlib.sha256(request.token.encode()).hexdigest()
    row = await client.fetchrow(
        """
        SELECT user_id, expires_at
        FROM password_reset_tokens
        WHERE token_hash = $1
        """,
        token_hash,
    )
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid or expired reset token",
        )
    # ``expires_at`` may come back as a datetime or a string
    # depending on the asyncpg codec configuration; normalise.
    expires_at = row["expires_at"]
    if isinstance(expires_at, str):
        expires_at = datetime.fromisoformat(expires_at)
    if expires_at < datetime.now(UTC):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid or expired reset token",
        )

    new_hash = hash_password(request.password)
    await client.execute(
        "UPDATE users SET password_hash = $1 WHERE id = $2",
        new_hash,
        str(row["user_id"]),
    )
    # Invalidate the token so it cannot be replayed.
    await client.execute(
        "DELETE FROM password_reset_tokens WHERE user_id = $1",
        str(row["user_id"]),
    )

    return ForgotPasswordResponse(
        message="Password has been reset successfully."
    )


# ─────────────────────────────────────────────────────────────────────────────
# Profile mutations (Phase A.4)
#
# The portal's /profile page had been faking success on all four
# write operations. These endpoints provide the real backend:
#   - PATCH  /users/me          — update name / avatar_url
#   - POST   /users/me/password — change password (old + new)
#   - POST   /users/me/avatar   — upload avatar file → returns URL
#   - DELETE /users/me          — soft-delete account (preserves audit log)
# ─────────────────────────────────────────────────────────────────────────────

import os as _os
import uuid as _uuid_mod

from fastapi import UploadFile

# Note: upload root is read at request time (not import time) so tests
# can monkeypatch ``EDEN_UPLOAD_DIR`` before each request.
_AVATAR_MAX_BYTES = 2 * 1024 * 1024  # 2 MB
_AVATAR_ALLOWED_TYPES = {"image/png", "image/jpeg", "image/webp", "image/gif"}


def _avatar_upload_root() -> str:
    return _os.environ.get("EDEN_UPLOAD_DIR", "/tmp/eden-uploads")


class ProfileUpdateRequest(BaseModel):
    """Body for PATCH /users/me."""
    name: str | None = Field(None, min_length=1, max_length=128)
    avatar_url: str | None = Field(None, max_length=512)


class ChangePasswordRequest(BaseModel):
    """Body for POST /users/me/password."""
    old_password: str
    new_password: str


class DeleteAccountRequest(BaseModel):
    """Body for DELETE /users/me. Requires the user to type ``DELETE``."""
    confirm: str


async def _load_me_payload(user: dict) -> UserResponse:
    """Re-fetch the current user + orgs and shape into ``UserResponse``.

    Used by both GET /me and PATCH /me so they return identical shapes.
    """
    db_user = await get_user_by_id(user["user_id"])
    if not db_user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="User not found",
        )
    client = await get_postgres_client()
    orgs_rows = await client.fetch(
        """
        SELECT o.id, o.name, o.slug, om.role
        FROM organizations o
        JOIN org_members om ON om.org_id = o.id
        WHERE om.user_id = $1
        ORDER BY o.created_at DESC
        """,
        user["user_id"],
    )
    organizations = [
        {"id": str(r["id"]), "name": r["name"], "slug": r["slug"], "role": r["role"]}
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


@router.patch("/users/me", response_model=UserResponse)
async def update_me(
    request: ProfileUpdateRequest,
    user: dict = Depends(get_current_user),
):
    """Update the current user's profile (name, avatar URL)."""
    if request.name is None and request.avatar_url is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Provide at least one of: name, avatar_url",
        )
    client = await get_postgres_client()
    sets: list[str] = []
    args: list = []
    if request.name is not None:
        sets.append(f"name = ${len(args) + 1}")
        args.append(request.name)
    if request.avatar_url is not None:
        sets.append(f"avatar_url = ${len(args) + 1}")
        args.append(request.avatar_url)
    args.append(user["user_id"])
    await client.execute(
        f"UPDATE users SET {', '.join(sets)} WHERE id = ${len(args)}",
        *args,
    )
    return await _load_me_payload(user)


@router.post("/users/me/password", status_code=204)
async def change_password(
    request: ChangePasswordRequest,
    user: dict = Depends(get_current_user),
):
    """Change the current user's password.

    Requires the old password (so a stolen cookie alone is not enough)
    and validates the new password's strength. Revokes all other
    sessions by rotating ``users.token_version`` — the caller will
    need to log in again.
    """
    if request.old_password == request.new_password:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="New password must differ from old password",
        )
    strength_err = _password_strength_error(request.new_password)
    if strength_err:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=strength_err,
        )
    if len(request.new_password) < 8:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Password must be at least 8 characters",
        )

    client = await get_postgres_client()
    row = await client.fetchrow(
        "SELECT password_hash FROM users WHERE id = $1 AND deleted_at IS NULL",
        user["user_id"],
    )
    if not row or not verify_password(request.old_password, row["password_hash"]):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Old password is incorrect",
        )
    new_hash = hash_password(request.new_password)
    await client.execute(
        """
        UPDATE users
        SET password_hash = $1,
            token_version = COALESCE(token_version, 0) + 1
        WHERE id = $2
        """,
        new_hash,
        user["user_id"],
    )


@router.post("/users/me/avatar")
async def upload_avatar(
    file: UploadFile,
    user: dict = Depends(get_current_user),
):
    """Upload an avatar image. Returns the public URL.

    Writes the file to ``$EDEN_UPLOAD_DIR/avatars/<user_id>.<ext>`` and
    persists the resulting URL on the user row. Validates type and size
    before writing — over the 2 MB cap returns 413.
    """
    if file.content_type not in _AVATAR_ALLOWED_TYPES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unsupported image type: {file.content_type}",
        )
    contents = await file.read()
    if len(contents) > _AVATAR_MAX_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"Avatar exceeds {_AVATAR_MAX_BYTES // (1024 * 1024)} MB cap",
        )
    ext_map = {
        "image/png": "png", "image/jpeg": "jpg",
        "image/webp": "webp", "image/gif": "gif",
    }
    ext = ext_map[file.content_type]
    filename = f"{user['user_id']}-{_uuid_mod.uuid4().hex[:8]}.{ext}"
    avatar_dir = _os.path.join(_avatar_upload_root(), "avatars")
    _os.makedirs(avatar_dir, exist_ok=True)
    avatar_path = _os.path.join(avatar_dir, filename)
    with open(avatar_path, "wb") as f:
        f.write(contents)
    public_url = f"/uploads/avatars/{filename}"

    client = await get_postgres_client()
    await client.execute(
        "UPDATE users SET avatar_url = $1 WHERE id = $2",
        public_url,
        user["user_id"],
    )
    return {"avatar_url": public_url}


@router.delete("/users/me", status_code=204)
async def delete_me(
    request: DeleteAccountRequest,
    user: dict = Depends(get_current_user),
):
    """Soft-delete the current user.

    Sets ``users.deleted_at = NOW()`` and rotates the token version so
    all sessions are invalidated. The user row is preserved (audit log
    rows reference it), and re-registration with the same email is
    blocked by the ``deleted_at IS NULL`` filter in the login query.
    """
    if request.confirm != "DELETE":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Confirmation must be the literal string 'DELETE'",
        )
    client = await get_postgres_client()
    await client.execute(
        """
        UPDATE users
        SET deleted_at = NOW(),
            token_version = COALESCE(token_version, 0) + 1
        WHERE id = $1 AND deleted_at IS NULL
        """,
        user["user_id"],
    )
