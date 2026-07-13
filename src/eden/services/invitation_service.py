"""Invitation service for email-based org invitations."""

import logging
import secrets
from datetime import UTC, datetime, timedelta
from uuid import uuid4

from eden.config import get_settings
from eden.services.email_service import EmailResult, get_email_service
from eden.storage.postgres import get_postgres_client

logger = logging.getLogger(__name__)

settings = get_settings()

# Default invitation expiry: 7 days
DEFAULT_EXPIRY_DAYS = 7


def _as_utc(dt: datetime) -> datetime:
    """Coerce a datetime to UTC-aware.

    asyncpg returns ``TIMESTAMP WITH TIME ZONE`` columns as naive
    ``datetime`` objects when the server's ``TimeZone`` setting is
    ``UTC`` (our default) — even though the column carries timezone
    info on the wire. Comparing those naive values against
    ``datetime.now(UTC)`` (which is tz-aware) raises
    ``TypeError: can't compare offset-naive and offset-aware
    datetimes`` and 500s the request. Normalise here.
    """
    return dt if dt.tzinfo else dt.replace(tzinfo=UTC)


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
        if _as_utc(existing["expires_at"]) > datetime.now(UTC):  # noqa: SIM102
            raise ValueError(
                "An invitation is already pending for this email in this organization"
            )

    # Generate token
    plain_token = generate_invite_token()
    token_hash = hash_invite_token(plain_token)
    expires_at = datetime.now(UTC) + timedelta(days=expires_in_days)
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
    if _as_utc(invitation["expires_at"]) < datetime.now(UTC):
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
    """Accept an invitation and add user to organization.

    Now also adds the user to the matching Clerk org so the user's
    session JWT carries ``org_id`` / ``org_role`` on the next refresh.
    The membership webhook re-syncs the ``org_members`` row
    idempotently; failures are logged but never propagate so a Clerk
    outage does not block a legitimate join.

    Returns ``{org_id, role, clerk_org_id}``. ``clerk_org_id`` is
    ``None`` for legacy rows where the column wasn't populated; the
    FE's ``setActive({ organization: ... })`` no-ops on null.
    """
    # Local imports keep this service usable from tests that never
    # touch Clerk; the lazy import also avoids any circular-import
    # risk with route modules that import this service.
    from eden.api.utils.clerk_client import (
        ClerkAPIError,
        create_membership,
        resolve_clerk_org_id,
    )

    client = await get_postgres_client()

    # Get invitation
    invitation = await client.fetchrow(
        """
        SELECT id, org_id, email, role, status, expires_at, invited_by
        FROM org_invitations
        WHERE id = $1
        """,
        invitation_id,
    )

    if not invitation:
        raise ValueError("Invitation not found")

    if invitation["status"] != "pending":
        raise ValueError(f"Invitation is {invitation['status']}, cannot accept")

    if _as_utc(invitation["expires_at"]) < datetime.now(UTC):
        raise ValueError("Invitation has expired")

    # Enforce seat quota at accept time (pending invites can outlive a
    # capacity change).
    try:
        from eden.api.routes.billing import check_limit, sync_plan_usage

        await sync_plan_usage(str(invitation["org_id"]))
        if await check_limit(str(invitation["org_id"]), "seats"):
            raise ValueError(
                "Seat limit reached. Ask an admin to free a seat or upgrade."
            )
    except ValueError:
        raise
    except Exception as exc:  # noqa: BLE001
        logger.warning("seat check on accept failed: %s", exc)

    # Add user to org. ``ON CONFLICT DO NOTHING`` is defensive against
    # the rare case where the invitation is accepted twice (network
    # retry on the FE) — both rows are no-ops and the webhook's
    # idempotent upsert still lands cleanly.
    #
    # ``last_writer_source = 'local'`` tells the
    # ``organizationMembership.created`` webhook handler to skip the
    # initial role overwrite: Clerk's role string (``org:member`` /
    # ``org:admin``) collapses ``viewer`` to ``member`` in our mapping
    # (``src/eden/api/utils/clerk_auth.py``), so without this guard
    # the webhook would silently demote ``viewer`` invitees. After
    # the webhook first lands, it flips ``last_writer_source`` to
    # ``'clerk'`` so subsequent Clerk-side role changes (admin
    # promotions etc.) propagate normally.
    await client.execute(
        """
        INSERT INTO org_members (org_id, user_id, role, invited_by, last_writer_source)
        VALUES ($1, $2, $3, $4, 'local')
        ON CONFLICT (org_id, user_id) DO NOTHING
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

    # Best-effort Clerk side-effect. Resolves legacy rows via the
    # ``COALESCE(clerk_org_id, id::text)`` fallback in
    # ``resolve_clerk_org_id`` so this works for both webhook-created
    # (id = clerk id) and backend-created (clerk_org_id column) rows.
    clerk_org_id = await resolve_clerk_org_id(
        client, str(invitation["org_id"]),
    )
    if clerk_org_id:
        clerk_user_row = await client.fetchrow(
            "SELECT clerk_id FROM users WHERE id = $1",
            user_id,
        )
        clerk_user_id = (
            str(clerk_user_row["clerk_id"])
            if clerk_user_row and clerk_user_row.get("clerk_id")
            else None
        )
        if clerk_user_id:
            try:
                await create_membership(
                    clerk_org_id=clerk_org_id,
                    user_id=clerk_user_id,
                    role=invitation["role"],
                )
            except ClerkAPIError as exc:
                # 422 "already a member" is benign — log at info level so
                # we don't page on retried accepts. Anything else is a
                # real outage; warn + let the webhook reconcile.
                if "already" in str(exc).lower():
                    logger.info(
                        "Clerk membership already exists (user=%s org=%s)",
                        user_id, clerk_org_id,
                    )
                else:
                    logger.warning(
                        "Clerk membership create failed (user=%s org=%s): %s; "
                        "webhook will reconcile",
                        user_id, clerk_org_id, exc,
                    )
            except Exception as exc:  # noqa: BLE001 — defensive
                logger.exception(
                    "Unexpected Clerk side-effect on accept_invitation (user=%s org=%s): %s",
                    user_id, clerk_org_id, exc,
                )

    return {
        "org_id": str(invitation["org_id"]),
        "role": invitation["role"],
        "clerk_org_id": clerk_org_id,
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

    if _as_utc(invitation["expires_at"]) < datetime.now(UTC):
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


async def send_invite_email(
    to_email: str,
    org_name: str,
    inviter_name: str,
    role: str,
    token: str,
    expires_at: str,
) -> EmailResult:
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
    return await email_service.send_email(
        to_email=to_email,
        subject=subject,
        html_content=html_content,
        text_content=text_content,
    )
