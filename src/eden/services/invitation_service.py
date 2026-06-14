"""Invitation service for email-based org invitations."""

import secrets
from datetime import datetime, timedelta
from uuid import uuid4

from eden.config import get_settings
from eden.services.email_service import get_email_service
from eden.storage.postgres import get_postgres_client

settings = get_settings()

# Default invitation expiry: 7 days
DEFAULT_EXPIRY_DAYS = 7


def generate_invite_token() -> str:
    """Generate a secure random invite token."""
    return secrets.token_urlsafe(32)


def hash_invite_token(token: str) -> str:
    """Hash an invite token for storage using SHA256.

    Using SHA256 instead of bcrypt since we need to verify tokens
    by re-hashing and comparing (not password verification).
    """
    import hashlib
    return hashlib.sha256(token.encode()).hexdigest()


async def create_invitation(
    org_id: str,
    email: str,
    role: str,
    invited_by: str,
    expires_in_days: int = DEFAULT_EXPIRY_DAYS,
) -> tuple[str, dict]:
    """Create a new org invitation.

    Returns tuple of (plain_token, invitation_record).
    The plain token is only available at creation time and must be sent to the invitee.
    """
    client = await get_postgres_client()

    # Check for existing pending invitation
    existing = await client.fetchrow(
        """
        SELECT id, token_hash, expires_at FROM org_invitations
        WHERE email = $1 AND org_id = $2 AND status = 'pending'
        """,
        email,
        org_id,
    )
    if existing:  # noqa: SIM102
        # Check if expired - only reject if NOT expired (still pending).
        # The nested `if` keeps the error message co-located with the
        # condition; collapsing would push a multi-line raise into a
        # ternary.
        if existing["expires_at"] > datetime.utcnow():  # noqa: SIM102
            raise ValueError(
                "An invitation is already pending for this email in this organization"
            )

    # Generate token
    plain_token = generate_invite_token()
    token_hash = hash_invite_token(plain_token)
    expires_at = datetime.utcnow() + timedelta(days=expires_in_days)
    invitation_id = str(uuid4())

    # Get inviter name
    inviter = await client.fetchrow(
        "SELECT name FROM users WHERE id = $1",
        invited_by,
    )
    inviter_name = inviter["name"] if inviter else "Unknown"

    # Get org name
    org = await client.fetchrow(
        "SELECT name FROM organizations WHERE id = $1",
        org_id,
    )
    org_name = org["name"] if org else "Unknown"

    # Store invitation
    await client.execute(
        """
        INSERT INTO org_invitations (id, org_id, email, role, token_hash, invited_by, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        """,
        invitation_id,
        org_id,
        email,
        role,
        token_hash,
        invited_by,
        expires_at,
    )

    invitation_record = {
        "id": invitation_id,
        "org_id": org_id,
        "org_name": org_name,
        "email": email,
        "role": role,
        "invited_by": invited_by,
        "inviter_name": inviter_name,
        "expires_at": expires_at.isoformat(),
        "status": "pending",
    }

    return plain_token, invitation_record


async def verify_invite_token(token: str) -> dict | None:
    """Verify an invitation token and return invitation details if valid.

    Returns None if token is invalid, expired, or already used/declined.
    """
    client = await get_postgres_client()

    # Find invitation by token hash
    rows = await client.fetch(
        """
        SELECT oi.id, oi.org_id, oi.email, oi.role, oi.invited_by, oi.expires_at, oi.status,
               o.name as org_name,
               u.name as inviter_name
        FROM org_invitations oi
        JOIN organizations o ON o.id = oi.org_id
        JOIN users u ON u.id = oi.invited_by
        WHERE oi.token_hash = $1
        """,
        hash_invite_token(token),
    )

    if not rows:
        return None

    invitation = rows[0]

    # Check status
    if invitation["status"] != "pending":
        return None

    # Check expiry
    if invitation["expires_at"] < datetime.utcnow():
        # Mark as expired
        await client.execute(
            "UPDATE org_invitations SET status = 'expired' WHERE id = $1",
            invitation["id"],
        )
        return None

    return {
        "id": str(invitation["id"]),
        "org_id": str(invitation["org_id"]),
        "org_name": invitation["org_name"],
        "email": invitation["email"],
        "role": invitation["role"],
        "invited_by": str(invitation["invited_by"]),
        "inviter_name": invitation["inviter_name"],
        "expires_at": invitation["expires_at"].isoformat(),
        "status": invitation["status"],
    }


async def accept_invitation(invitation_id: str, user_id: str) -> dict:
    """Accept an invitation and add user to organization."""
    client = await get_postgres_client()

    # Get invitation
    invitation = await client.fetchrow(
        """
        SELECT id, org_id, email, role, status, expires_at
        FROM org_invitations
        WHERE id = $1
        """,
        invitation_id,
    )

    if not invitation:
        raise ValueError("Invitation not found")

    if invitation["status"] != "pending":
        raise ValueError(f"Invitation is {invitation['status']}, cannot accept")

    if invitation["expires_at"] < datetime.utcnow():
        raise ValueError("Invitation has expired")

    # Add user to org
    await client.execute(
        """
        INSERT INTO org_members (org_id, user_id, role, invited_by)
        VALUES ($1, $2, $3, $4)
        """,
        str(invitation["org_id"]),
        user_id,
        invitation["role"],
        str(invitation["invited_by"]),
    )

    # Update invitation status
    await client.execute(
        """
        UPDATE org_invitations
        SET status = 'accepted', accepted_at = NOW()
        WHERE id = $1
        """,
        invitation_id,
    )

    return {
        "org_id": str(invitation["org_id"]),
        "role": invitation["role"],
    }


async def decline_invitation(invitation_id: str, user_id: str) -> None:
    """Decline an invitation."""
    client = await get_postgres_client()

    # Get invitation
    invitation = await client.fetchrow(
        """
        SELECT id, org_id, email, status, expires_at
        FROM org_invitations
        WHERE id = $1
        """,
        invitation_id,
    )

    if not invitation:
        raise ValueError("Invitation not found")

    if invitation["status"] != "pending":
        raise ValueError(f"Invitation is {invitation['status']}, cannot decline")

    if invitation["expires_at"] < datetime.utcnow():
        raise ValueError("Invitation has expired")

    # Update invitation status
    await client.execute(
        """
        UPDATE org_invitations
        SET status = 'declined', declined_at = NOW()
        WHERE id = $1
        """,
        invitation_id,
    )


async def get_pending_invitations(org_id: str) -> list[dict]:
    """Get all pending invitations for an organization."""
    client = await get_postgres_client()

    rows = await client.fetch(
        """
        SELECT oi.id, oi.email, oi.role, oi.invited_by, oi.expires_at, oi.created_at,
               u.name as inviter_name
        FROM org_invitations oi
        JOIN users u ON u.id = oi.invited_by
        WHERE oi.org_id = $1 AND oi.status = 'pending'
        ORDER BY oi.created_at DESC
        """,
        org_id,
    )

    return [
        {
            "id": str(r["id"]),
            "email": r["email"],
            "role": r["role"],
            "invited_by": str(r["invited_by"]),
            "inviter_name": r["inviter_name"],
            "expires_at": r["expires_at"].isoformat(),
            "created_at": r["created_at"].isoformat() if r.get("created_at") else None,
        }
        for r in rows
    ]


async def send_invite_email(to_email: str, org_name: str, inviter_name: str, role: str, token: str, expires_at: str) -> None:
    """Send invitation email to the invitee.

    Sends via SendGrid if configured, otherwise logs a warning.
    """
    settings = get_settings()
    invite_url = f"{settings.portal_base_url}/invite/{token}"

    subject = f"You've been invited to {org_name}"
    html_content = f"""
    <html>
    <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
        <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
            <h2 style="color: #2c3e50;">You've been invited to join {org_name}</h2>
            <p>
                <strong>{inviter_name}</strong> has invited you to join <strong>{org_name}</strong>
                as a <strong>{role}</strong>.
            </p>
            <p>
                Click the link below to accept your invitation:
            </p>
            <p style="margin: 30px 0;">
                <a href="{invite_url}"
                   style="background-color: #3498db; color: white; padding: 12px 24px;
                          text-decoration: none; border-radius: 4px; display: inline-block;">
                    Accept Invitation
                </a>
            </p>
            <p style="color: #7f8c8d; font-size: 14px;">
                This invitation expires on {expires_at}.
            </p>
            <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
            <p style="color: #95a5a6; font-size: 12px;">
                If you didn't expect this invitation, you can safely ignore this email.
            </p>
        </div>
    </body>
    </html>
    """
    text_content = f"""
    You've been invited to join {org_name}

    {inviter_name} has invited you to join {org_name} as a {role}.

    Accept your invitation by visiting: {invite_url}

    This invitation expires on {expires_at}.

    If you didn't expect this invitation, you can safely ignore this email.
    """

    email_service = get_email_service()
    await email_service.send_email(
        to_email=to_email,
        subject=subject,
        html_content=html_content,
        text_content=text_content,
    )
