"""Organization management routes for Eden."""

import hashlib
import logging
import re
import secrets
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel

from eden.api.deps import (
    get_current_user,
    log_audit_event,
    require_org_admin,
    require_org_member,
    require_org_owner,
    require_org_permission,
    require_org_permission_dep,
)
from eden.api.routes.billing import check_limit
from eden.config import get_settings
from eden.services.invitation_service import (
    accept_invitation,
    create_invitation,
    decline_invitation,
    get_pending_invitations,
    send_invite_email,
)
from eden.storage.postgres import get_postgres_client

logger = logging.getLogger(__name__)
settings = get_settings()

router = APIRouter(prefix="/orgs", tags=["organizations"])


def slugify(name: str) -> str:
    """Convert org name to URL-safe slug."""
    slug = re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-')
    return slug[:50]


def get_email_domain(email: str) -> str:
    """Extract the domain from an email address."""
    return email.split("@")[-1].lower() if "@" in email else ""


async def check_domain_restriction(client, org_id: str, email: str) -> tuple[bool, str | None]:
    """Check if email domain is allowed for the organization.

    Returns (is_allowed, error_message).
    """
    # Check if domain restriction is enforced
    row = await client.fetchrow(
        "SELECT domain_restriction_enforced FROM organizations WHERE id = $1",
        org_id,
    )
    if not row or not row["domain_restriction_enforced"]:
        return True, None

    # Get allowed domains for this org
    domain = get_email_domain(email)
    allowed = await client.fetchrow(
        "SELECT id FROM org_allowed_domains WHERE org_id = $1 AND LOWER(domain) = $2",
        org_id,
        domain,
    )
    if allowed:
        return True, None

    return False, f"Email domain '{domain}' is not allowed for this organization. Only members with emails at allowed domains can be invited."


class CreateOrgRequest:
    """Request schema for org creation."""
    def __init__(self, name: str, make_default: bool = True):
        self.name = name
        self.make_default = make_default


class OrgResponse:
    """Response schema for org."""
    def __init__(self, id: str, name: str, slug: str, role: str, is_owner: bool, member_count: int):
        self.id = id
        self.name = name
        self.slug = slug
        self.role = role
        self.is_owner = is_owner
        self.member_count = member_count


class CreateOrgResponse:
    """Response for org creation."""
    def __init__(self, org_id: str, name: str, slug: str, role: str):
        self.org_id = org_id
        self.name = name
        self.slug = slug
        self.role = role


@router.post("", response_model=dict)
async def create_org(
    name: str,
    make_default: bool = True,
    user: dict = Depends(get_current_user),
):
    """Create a new organization. Creator becomes owner.

    Backend-driven: we call Clerk Backend API first so the new Eden
    row's ``clerk_org_id`` is populated and the membership webhook
    will idempotently re-sync the ``org_members`` row from Clerk's
    side. We also insert the ``org_members`` row directly here so the
    user's first ``GET /auth/me`` roundtrip (which the onboarding
    wizard performs after the create call) sees the membership
    immediately, without waiting for webhook delivery.

    If Clerk is unreachable, we still create the Eden row, log a
    warning, and return it without ``clerk_org_id`` (response flag
    ``org_degraded: true``). The frontend's ``useOrg`` hook already
    handles this branch by falling through to the user's
    ``current_org_id``; an operator can re-sync later via a backfill
    script.
    """
    # Local imports keep the module-load cost cheap for tests that
    # never exercise Clerk.
    from eden.api.utils.clerk_client import (
        ClerkAPIError,
    )
    from eden.api.utils.clerk_client import (
        create_organization as clerk_create_org,
    )

    client = await get_postgres_client()
    user_id = user["user_id"]

    # Validate name
    if len(name) < 2 or len(name) > 100:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Org name must be 2-100 characters",
        )

    slug = slugify(name)

    # Check slug uniqueness
    existing = await client.fetchrow(
        "SELECT id FROM organizations WHERE slug = $1",
        slug,
    )
    if existing:
        slug = f"{slug}-{uuid4().hex[:8]}"

    # Try Clerk first. On failure, log + continue with a backend-only
    # row. The user gets a working org either way; the degraded flag
    # surfaces a soft warning in the portal.
    clerk_org_id: str | None = None
    degraded = False
    try:
        clerk_org = await clerk_create_org(name=name, slug=slug)
        clerk_org_id = str(clerk_org.get("id") or "") or None
    except ClerkAPIError as exc:
        logger.warning(
            "Clerk org create failed for slug=%s: %s; continuing with backend-only org",
            slug, exc,
        )
        degraded = True
    except Exception as exc:  # noqa: BLE001 — defensive
        logger.exception("Unexpected Clerk error on create_org slug=%s: %s", slug, exc)
        degraded = True

    # Create org (Eden row). We write the clerk_org_id we got from
    # Clerk; for webhook-created rows in the future, the
    # ``organization.created`` webhook will land at the
    # ``_upsert_org`` handler and backfill the same column.
    org_id = str(uuid4())
    try:
        query = """
            INSERT INTO organizations (id, clerk_org_id, name, slug, owner_id, settings)
            VALUES ($1, $2, $3, $4, $5, '{}')
            RETURNING id
        """
        row = await client.fetchrow(query, org_id, clerk_org_id, name, slug, user_id)
    except Exception as exc:
        # If we created the Clerk org but failed to write the Eden
        # row, we have an orphan in Clerk. Log loudly so an operator
        # can run cleanup; don't auto-delete (Clerk charges per org
        # on some plans and auto-delete is riskier than the leak).
        logger.exception(
            "Failed to write Eden org row after Clerk create "
            "(org_id=%s clerk_org_id=%s): %s",
            org_id, clerk_org_id, exc,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to create organization",
        )
    if not row:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to create organization",
        )

    # Add creator as owner member. The Clerk
    # ``organizationMembership.created`` webhook will also write this
    # row idempotently (see ``clerk_webhooks.py:_upsert_membership``);
    # ``ON CONFLICT DO NOTHING`` keeps the local insert safe even if
    # the webhook lands first.
    await client.execute(
        """
        INSERT INTO org_members (org_id, user_id, role, invited_by)
        VALUES ($1, $2, 'owner', $2)
        ON CONFLICT (org_id, user_id) DO NOTHING
        """,
        org_id,
        user_id,
    )

    # Update user's preferred_org if requested
    if make_default:
        await client.execute(
            "UPDATE users SET preferred_org_id = $1 WHERE id = $2",
            org_id,
            user_id,
        )

    return {
        "org_id": org_id,
        "name": name,
        "slug": slug,
        "role": "owner",
        "clerk_org_id": clerk_org_id,
        "org_degraded": degraded,
    }


@router.get("", response_model=list[dict])
async def list_user_orgs(
    user: dict = Depends(get_current_user),
    include_archived: bool = Query(default=False),
):
    """List all organizations the user is a member of (excludes archived by default)."""
    client = await get_postgres_client()
    user_id = user["user_id"]

    if include_archived:
        query = """
            SELECT o.id, o.name, o.slug, o.owner_id, o.archived_at,
                   om.role,
                   COUNT(om2.id) as member_count
            FROM organizations o
            JOIN org_members om ON om.org_id = o.id
            LEFT JOIN org_members om2 ON om2.org_id = o.id
            WHERE om.user_id = $1
            GROUP BY o.id, o.name, o.slug, o.owner_id, o.archived_at, om.role
            ORDER BY o.created_at DESC
        """
        rows = await client.fetch(query, user_id)
    else:
        query = """
            SELECT o.id, o.name, o.slug, o.owner_id, o.archived_at,
                   om.role,
                   COUNT(om2.id) as member_count
            FROM organizations o
            JOIN org_members om ON om.org_id = o.id
            LEFT JOIN org_members om2 ON om2.org_id = o.id
            WHERE om.user_id = $1 AND o.archived_at IS NULL
            GROUP BY o.id, o.name, o.slug, o.owner_id, o.archived_at, om.role
            ORDER BY o.created_at DESC
        """
        rows = await client.fetch(query, user_id)

    return [
        {
            "id": str(r["id"]),
            "name": r["name"],
            "slug": r["slug"],
            "role": r["role"],
            "is_owner": r["owner_id"] == user_id,
            "member_count": r["member_count"],
            "archived_at": r["archived_at"].isoformat() if r.get("archived_at") else None,
        }
        for r in rows
    ]


@router.get("/{org_id}", response_model=dict)
async def get_org(org_id: str, user: dict = Depends(get_current_user)):
    """Get organization details (must be member)."""
    client = await get_postgres_client()
    user_id = user["user_id"]

    # Verify membership
    membership = await client.fetchrow(
        "SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2",
        org_id,
        user_id,
    )
    if not membership:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Not a member of this organization",
        )

    # Get org details
    org = await client.fetchrow(
        "SELECT id, name, slug, owner_id, settings, created_at FROM organizations WHERE id = $1",
        org_id,
    )
    if not org:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Organization not found",
        )

    member_count = await client.fetchval(
        "SELECT COUNT(*) FROM org_members WHERE org_id = $1",
        org_id,
    )

    return {
        "id": str(org["id"]),
        "name": org["name"],
        "slug": org["slug"],
        "role": membership["role"],
        "is_owner": org["owner_id"] == user_id,
        "member_count": member_count,
        "settings": org.get("settings", {}),
        "created_at": org["created_at"].isoformat() if org.get("created_at") else None,
    }


@router.post("/{org_id}/invites", response_model=dict)
async def send_invite(
    org_id: str,
    email: str,
    role: str = "member",
    user: dict = Depends(get_current_user),
        _check_members_invite: dict = Depends(require_org_permission_dep('members:invite')),
):
    """Send an email invitation to a user to join the organization."""

    # Check seat limit before inviting
    if await check_limit(org_id, "seats"):
        raise HTTPException(
            status_code=status.HTTP_402_PAYMENT_REQUIRED,
            detail="Seat limit reached. Upgrade your plan to add more members.",
        )

    client = await get_postgres_client()

    # Check domain restriction
    is_allowed, error_msg = await check_domain_restriction(client, org_id, email)
    if not is_allowed:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=error_msg,
        )

    # Check if user already a member
    existing_member = await client.fetchrow(
        "SELECT id FROM org_members WHERE org_id = $1 AND user_id = (SELECT id FROM users WHERE email = $2)",
        org_id,
        email,
    )
    if existing_member:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="User is already a member of this organization",
        )

    # Create invitation (generates token)
    try:
        plain_token, invitation = await create_invitation(
            org_id=org_id,
            email=email,
            role=role,
            invited_by=user["user_id"],
        )
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )

    # Send invitation email (stub)
    await send_invite_email(
        to_email=email,
        org_name=invitation["org_name"],
        inviter_name=invitation["inviter_name"],
        role=role,
        token=plain_token,
        expires_at=invitation["expires_at"],
    )

    # Audit log
    await log_audit_event(
        client=client,
        org_id=org_id,
        user_id=user["user_id"],
        action="member.invited",
        target_type="user",
        target_id=invitation["id"],
        metadata={"invitee_email": email, "role": role},
    )

    return {
        "message": f"Invitation sent to {email}",
        "invitation_id": invitation["id"],
        "expires_at": invitation["expires_at"],
    }


@router.get("/{org_id}/invites", response_model=list[dict])
async def list_invitations(
    org_id: str,
    user: dict = Depends(get_current_user),
        _check_members_invite: dict = Depends(require_org_permission_dep('members:invite')),
):
    """List all pending invitations for an organization."""

    invitations = await get_pending_invitations(org_id)
    return invitations


@router.post("/{org_id}/invites/{invitation_id}/accept", response_model=dict)
async def accept_org_invitation(
    org_id: str,
    invitation_id: str,
    user: dict = Depends(get_current_user),
):
    """Accept an organization invitation.

    The point of this call is to *create* a membership, so we do not
    require pre-existing ``org_members`` membership (that would 403
    for any first-time invitee). The ``accept_invitation`` service
    re-queries the invite, validates status + expiry, and inserts
    the row idempotently.
    """
    try:
        result = await accept_invitation(invitation_id, user["user_id"])
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )

    # Audit log
    client = await get_postgres_client()
    await log_audit_event(
        client=client,
        org_id=org_id,
        user_id=user["user_id"],
        action="member.joined",
        target_type="user",
        target_id=user["user_id"],
        metadata={"role": result["role"]},
    )

    return {
        "message": "Invitation accepted",
        "org_id": result["org_id"],
        "role": result["role"],
        # ``clerk_org_id`` is forwarded from the service; lets the
        # portal ``setActive({ organization: ... })`` without a second
        # Clerk lookup.
        "clerk_org_id": result.get("clerk_org_id"),
    }


@router.post("/{org_id}/invites/{invitation_id}/decline", response_model=dict)
async def decline_org_invitation(
    org_id: str,
    invitation_id: str,
    user: dict = Depends(get_current_user),
):
    """Decline an organization invitation."""
    await require_org_member(org_id)

    try:
        await decline_invitation(invitation_id, user["user_id"])
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )

    # Audit log
    client = await get_postgres_client()
    await log_audit_event(
        client=client,
        org_id=org_id,
        user_id=user["user_id"],
        action="invitation.declined",
        target_type="invitation",
        target_id=invitation_id,
        metadata={},
    )

    return {"message": "Invitation declined"}


@router.delete("/{org_id}/members/{user_id}", response_model=dict)
async def remove_member(
    org_id: str,
    user_id: str,
    user: dict = Depends(get_current_user),
        _check_members_remove: dict = Depends(require_org_permission_dep('members:remove')),
):
    """Remove a member from the organization."""

    client = await get_postgres_client()

    # Can't remove owner
    org_data = await client.fetchrow("SELECT owner_id FROM organizations WHERE id = $1", org_id)
    if org_data and str(org_data["owner_id"]) == user_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot remove the organization owner",
        )

    # Can't remove self if not admin
    if user_id == user["user_id"] and org["role"] != "owner":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Admins cannot remove themselves",
        )

    await client.execute(
        "DELETE FROM org_members WHERE org_id = $1 AND user_id = $2",
        org_id,
        user_id,
    )

    # Audit log
    await log_audit_event(
        client=client,
        org_id=org_id,
        user_id=user["user_id"],
        action="member.removed",
        target_type="user",
        target_id=user_id,
        metadata={},
    )

    return {"message": "Member removed"}


@router.get("/{org_id}/members", response_model=list[dict])
async def list_org_members(org_id: str, user: dict = Depends(get_current_user)):
    """List all members of an organization."""
    await require_org_member(org_id, authorization=None)

    client = await get_postgres_client()

    query = """
        SELECT om.user_id, om.role, om.joined_at, om.last_active_at,
               u.email, u.name
        FROM org_members om
        JOIN users u ON u.id = om.user_id
        WHERE om.org_id = $1
        ORDER BY om.joined_at ASC
    """
    rows = await client.fetch(query, org_id)

    return [
        {
            "user_id": str(r["user_id"]),
            "email": r["email"],
            "name": r["name"],
            "role": r["role"],
            "joined_at": r["joined_at"].isoformat() if r.get("joined_at") else None,
            "last_active_at": r["last_active_at"].isoformat() if r.get("last_active_at") else None,
        }
        for r in rows
    ]


@router.patch("/{org_id}/settings", response_model=dict)
async def update_org_settings(
    org_id: str,
    settings: dict,
    user: dict = Depends(get_current_user),
        _check_settings_edit: dict = Depends(require_org_permission_dep('settings:edit')),
):
    """Update organization settings (admin only)."""

    client = await get_postgres_client()

    # Get old settings for audit
    old_settings = await client.fetchval(
        "SELECT settings FROM organizations WHERE id = $1",
        org_id,
    )

    await client.execute(
        "UPDATE organizations SET settings = $1 WHERE id = $2",
        settings,
        org_id,
    )

    # Audit log
    await log_audit_event(
        client=client,
        org_id=org_id,
        user_id=user["user_id"],
        action="settings.updated",
        target_type="settings",
        target_id=org_id,
        metadata={"old_settings": old_settings or {}, "new_settings": settings},
    )

    return {"message": "Settings updated", "settings": settings}


@router.post("/{org_id}/archive", response_model=dict)
async def archive_org(org_id: str, user: dict = Depends(get_current_user),
        _check_settings_edit: dict = Depends(require_org_permission_dep('settings:edit')),
):
    """Archive an organization (soft-delete). Admin or owner only."""

    client = await get_postgres_client()

    # Check if already archived
    org = await client.fetchrow(
        "SELECT archived_at FROM organizations WHERE id = $1",
        org_id,
    )
    if not org:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Organization not found",
        )
    if org.get("archived_at"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Organization is already archived",
        )

    await client.execute(
        "UPDATE organizations SET archived_at = NOW() WHERE id = $1",
        org_id,
    )

    # Audit log
    await log_audit_event(
        client=client,
        org_id=org_id,
        user_id=user["user_id"],
        action="org.archived",
        target_type="organization",
        target_id=org_id,
        metadata={},
    )

    return {"message": "Organization archived", "org_id": org_id}


@router.delete("/{org_id}", response_model=dict)
async def delete_org(org_id: str, user: dict = Depends(get_current_user)):
    """Permanently delete an organization. Owner only. Warning: cascades to all org data."""
    await require_org_owner(org_id)

    client = await get_postgres_client()

    # Check for existing data (jobs feature removed June 2026)
    skill_count = await client.fetchval(
        "SELECT COUNT(*) FROM skills WHERE org_id = $1",
        org_id,
    )
    ref_count = await client.fetchval(
        "SELECT COUNT(*) FROM code_references WHERE org_id = $1",
        org_id,
    )

    total_data = (skill_count or 0) + (ref_count or 0)
    if total_data > 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Cannot delete org with existing data: {skill_count} skills, {ref_count} code references. Remove all data first.",
        )

    # Verify no archived_at (must be actively deleted)
    org = await client.fetchrow(
        "SELECT id FROM organizations WHERE id = $1 AND archived_at IS NOT NULL",
        org_id,
    )
    if not org:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Organization must be archived before permanent deletion. Archive first, then delete.",
        )

    # Delete org (cascade should handle org_members and other CASCADE references)
    await client.execute(
        "DELETE FROM organizations WHERE id = $1",
        org_id,
    )

    return {"message": "Organization permanently deleted", "org_id": org_id}


@router.post("/{org_id}/transfer-ownership", response_model=dict)
async def transfer_ownership(
    org_id: str,
    target_user_id: str,
    user: dict = Depends(get_current_user),
        _check_org_transfer: dict = Depends(require_org_permission_dep('org:transfer')),
):
    """Transfer organization ownership to another member.

    The current owner becomes an admin after the transfer.
    """

    client = await get_postgres_client()
    current_user_id = user["user_id"]

    # Verify target user is a member
    target_member = await client.fetchrow(
        "SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2",
        org_id,
        target_user_id,
    )
    if not target_member:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Target user is not a member of this organization",
        )

    # Cannot transfer to self
    if target_user_id == current_user_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot transfer ownership to yourself",
        )

    # Atomic transaction: update owner and roles
    async with client.transaction():
        # Update organization's owner_id
        await client.execute(
            "UPDATE organizations SET owner_id = $1 WHERE id = $2",
            target_user_id,
            org_id,
        )
        # Update old owner's role to admin
        await client.execute(
            "UPDATE org_members SET role = 'admin' WHERE org_id = $1 AND user_id = $2",
            org_id,
            current_user_id,
        )
        # Update new owner's role to owner
        await client.execute(
            "UPDATE org_members SET role = 'owner' WHERE org_id = $1 AND user_id = $2",
            org_id,
            target_user_id,
        )

    # Audit log
    await log_audit_event(
        client=client,
        org_id=org_id,
        user_id=current_user_id,
        action="ownership.transferred",
        target_type="user",
        target_id=target_user_id,
        metadata={"previous_owner_id": current_user_id, "new_owner_id": target_user_id},
    )

    return {"message": "Ownership transferred successfully"}


# ============================================================================
# SCIM Configuration (admin-only)
# ============================================================================

@router.get("/{org_id}/scim/config", response_model=dict)
async def get_scim_config(
    org_id: str,
    user: dict = Depends(get_current_user),
):
    """Get SCIM configuration for the organization (admin only).

    Returns config including whether SCIM is enabled, last sync, etc.
    Does NOT return the raw token (it's hashed).
    """
    await require_org_admin(org_id)

    client = await get_postgres_client()

    row = await client.fetchrow(
        "SELECT scim_enabled, last_sync_at, provisioned_user_count, created_at, updated_at FROM org_scim_config WHERE org_id = $1",
        org_id,
    )

    if not row:
        return {
            "scim_enabled": False,
            "last_sync_at": None,
            "provisioned_user_count": 0,
            "has_token": False,
        }

    return {
        "scim_enabled": row["scim_enabled"],
        "last_sync_at": row["last_sync_at"].isoformat() if row.get("last_sync_at") else None,
        "provisioned_user_count": row["provisioned_user_count"] or 0,
        "has_token": bool(row["scim_enabled"]),  # Token exists if SCIM is enabled
    }


@router.post("/{org_id}/scim/config", response_model=dict)
async def configure_scim(
    org_id: str,
    enabled: bool,
    user: dict = Depends(get_current_user),
):
    """Enable or disable SCIM for the organization (admin only).

    When enabling, generates a new bearer token.
    """
    await require_org_admin(org_id)

    client = await get_postgres_client()

    # Check if config exists
    existing = await client.fetchrow(
        "SELECT id, scim_token_hash FROM org_scim_config WHERE org_id = $1",
        org_id,
    )

    if enabled:
        # Generate new token
        raw_token = secrets.token_urlsafe(32)
        token_hash = hashlib.sha256(raw_token.encode()).hexdigest()

        if existing:
            await client.execute(
                """
                UPDATE org_scim_config
                SET scim_enabled = TRUE, scim_token_hash = $1, updated_at = NOW()
                WHERE org_id = $2
                """,
                token_hash,
                org_id,
            )
        else:
            await client.execute(
                """
                INSERT INTO org_scim_config (org_id, scim_enabled, scim_token_hash)
                VALUES ($1, TRUE, $2)
                """,
                org_id,
                token_hash,
            )

        # Audit log
        await log_audit_event(
            client=client,
            org_id=org_id,
            user_id=user["user_id"],
            action="scim.enabled",
            target_type="scim_config",
            target_id=org_id,
            metadata={},
        )

        return {
            "scim_enabled": True,
            "bearer_token": raw_token,  # Only returned once on creation!
            "message": "Store this token securely. It will not be shown again.",
        }
    else:
        # Disable SCIM
        if existing:
            await client.execute(
                """
                UPDATE org_scim_config
                SET scim_enabled = FALSE, scim_token_hash = NULL, updated_at = NOW()
                WHERE org_id = $1
                """,
                org_id,
            )
        else:
            await client.execute(
                """
                INSERT INTO org_scim_config (org_id, scim_enabled)
                VALUES ($1, FALSE)
                """,
                org_id,
            )

        # Audit log
        await log_audit_event(
            client=client,
            org_id=org_id,
            user_id=user["user_id"],
            action="scim.disabled",
            target_type="scim_config",
            target_id=org_id,
            metadata={},
        )

        return {
            "scim_enabled": False,
            "message": "SCIM has been disabled.",
        }


@router.post("/{org_id}/scim/rotate-token", response_model=dict)
async def rotate_scim_token(
    org_id: str,
    user: dict = Depends(get_current_user),
):
    """Rotate the SCIM bearer token (admin only).

    Invalidates the old token and generates a new one.
    """
    await require_org_admin(org_id)

    client = await get_postgres_client()

    # Generate new token
    raw_token = secrets.token_urlsafe(32)
    token_hash = hashlib.sha256(raw_token.encode()).hexdigest()

    # Update or create config
    existing = await client.fetchrow(
        "SELECT id FROM org_scim_config WHERE org_id = $1",
        org_id,
    )

    if existing:
        await client.execute(
            """
            UPDATE org_scim_config
            SET scim_enabled = TRUE, scim_token_hash = $1, updated_at = NOW()
            WHERE org_id = $2
            """,
            token_hash,
            org_id,
        )
    else:
        await client.execute(
            """
            INSERT INTO org_scim_config (org_id, scim_enabled, scim_token_hash)
            VALUES ($1, TRUE, $2)
            """,
            org_id,
            token_hash,
        )

    # Audit log
    await log_audit_event(
        client=client,
        org_id=org_id,
        user_id=user["user_id"],
        action="scim.token_rotated",
        target_type="scim_config",
        target_id=org_id,
        metadata={},
    )

    return {
        "bearer_token": raw_token,
        "message": "Token rotated. Store this new token securely. It will not be shown again.",
    }


# ============================================================================
# Import hashlib for token hashing
# ============================================================================
# DOMAIN RESTRICTION MANAGEMENT
# ============================================================================

class DomainRestrictionSettings(BaseModel):
    """Request schema for updating domain restriction settings."""
    domain_restriction_enforced: bool


class AddAllowedDomainRequest(BaseModel):
    """Request schema for adding an allowed domain."""
    domain: str


@router.get("/{org_id}/allowed-domains", response_model=list[dict])
async def list_allowed_domains(
    org_id: str,
    user: dict = Depends(get_current_user),
):
    """List all allowed email domains for an organization."""
    await require_org_admin(org_id)

    client = await get_postgres_client()
    rows = await client.fetch(
        """
        SELECT id, domain, added_by, created_at
        FROM org_allowed_domains
        WHERE org_id = $1
        ORDER BY domain ASC
        """,
        org_id,
    )

    return [
        {
            "id": str(r["id"]),
            "domain": r["domain"],
            "added_by": str(r["added_by"]),
            "created_at": r["created_at"].isoformat() if r.get("created_at") else None,
        }
        for r in rows
    ]


@router.post("/{org_id}/allowed-domains", response_model=dict)
async def add_allowed_domain(
    org_id: str,
    request: AddAllowedDomainRequest,
    user: dict = Depends(get_current_user),
):
    """Add an allowed email domain to an organization."""
    await require_org_admin(org_id)

    domain = request.domain.lower().strip()
    if not domain:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Domain cannot be empty",
        )

    # Basic domain validation
    if not re.match(r'^[a-z0-9]+([\-\.]{1}[a-z0-9]+)*\.[a-z]{2,}$', domain):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid domain format",
        )

    client = await get_postgres_client()
    user_id = user["user_id"]

    try:
        row = await client.fetchrow(
            """
            INSERT INTO org_allowed_domains (org_id, domain, added_by)
            VALUES ($1, $2, $3)
            RETURNING id, created_at
            """,
            org_id,
            domain,
            user_id,
        )
    except Exception as e:
        if "unique constraint" in str(e).lower() or "duplicate" in str(e).lower():
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Domain is already in the allowed list",
            )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to add domain",
        )

    # Audit log
    await log_audit_event(
        client=client,
        org_id=org_id,
        user_id=user_id,
        action="domain.added",
        target_type="domain",
        target_id=row["id"],
        metadata={"domain": domain},
    )

    return {
        "id": str(row["id"]),
        "domain": domain,
        "added_by": user_id,
        "created_at": row["created_at"].isoformat() if row.get("created_at") else None,
    }


@router.delete("/{org_id}/allowed-domains/{domain_id}", response_model=dict)
async def remove_allowed_domain(
    org_id: str,
    domain_id: str,
    user: dict = Depends(get_current_user),
):
    """Remove an allowed email domain from an organization."""
    await require_org_admin(org_id)

    client = await get_postgres_client()

    result = await client.execute(
        "DELETE FROM org_allowed_domains WHERE id = $1 AND org_id = $2",
        domain_id,
        org_id,
    )
    if result == "DELETE 0":
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Domain not found in allowed list",
        )

    # Audit log
    await log_audit_event(
        client=client,
        org_id=org_id,
        user_id=user["user_id"],
        action="domain.removed",
        target_type="domain",
        target_id=domain_id,
        metadata={},
    )

    return {"message": "Domain removed from allowed list"}


@router.get("/{org_id}/domain-restriction", response_model=dict)
async def get_domain_restriction_settings(
    org_id: str,
    user: dict = Depends(get_current_user),
):
    """Get domain restriction settings for an organization."""
    await require_org_member(org_id, authorization=None)

    client = await get_postgres_client()
    row = await client.fetchrow(
        "SELECT domain_restriction_enforced FROM organizations WHERE id = $1",
        org_id,
    )
    if not row:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Organization not found",
        )

    return {
        "domain_restriction_enforced": row["domain_restriction_enforced"],
    }


@router.patch("/{org_id}/domain-restriction", response_model=dict)
async def update_domain_restriction_settings(
    org_id: str,
    request: DomainRestrictionSettings,
    user: dict = Depends(get_current_user),
):
    """Update domain restriction enforcement for an organization."""
    await require_org_admin(org_id)

    client = await get_postgres_client()

    await client.execute(
        "UPDATE organizations SET domain_restriction_enforced = $1 WHERE id = $2",
        request.domain_restriction_enforced,
        org_id,
    )

    # Audit log
    await log_audit_event(
        client=client,
        org_id=org_id,
        user_id=user["user_id"],
        action="domain_restriction.updated",
        target_type="settings",
        target_id=org_id,
        metadata={"domain_restriction_enforced": request.domain_restriction_enforced},
    )

    return {
        "domain_restriction_enforced": request.domain_restriction_enforced,
    }


# ============================================================================
# 2FA ENFORCEMENT MANAGEMENT
# ============================================================================

class EnforceTwoFARequest(BaseModel):
    """Request schema for 2FA enforcement toggle."""
    enforce: bool


@router.post("/{org_id}/2fa/enforce", response_model=dict)
async def enforce_org_2fa(
    org_id: str,
    request: EnforceTwoFARequest,
    user: dict = Depends(get_current_user),
):
    """Enable or disable 2FA enforcement for the organization.

    Only org admins/owners can toggle this setting.
    When enabled, all org members must have 2FA enabled to access the org.
    """
    await require_org_admin(org_id)

    client = await get_postgres_client()

    # Update the two_factor_enforced flag
    await client.execute(
        "UPDATE organizations SET two_factor_enforced = $1 WHERE id = $2",
        request.enforce,
        org_id,
    )

    # Audit log
    await log_audit_event(
        client=client,
        org_id=org_id,
        user_id=user["user_id"],
        action="2fa_enforcement.updated",
        target_type="settings",
        target_id=org_id,
        metadata={"two_factor_enforced": request.enforce},
    )

    action = "enabled" if request.enforce else "disabled"
    return {
        "two_factor_enforced": request.enforce,
        "message": f"2FA enforcement has been {action} for this organization",
    }


@router.get("/{org_id}/2fa/enforcement-status", response_model=dict)
async def get_2fa_enforcement_status(
    org_id: str,
    user: dict = Depends(get_current_user),
):
    """Get 2FA enforcement status for an organization."""
    await require_org_admin(org_id)

    client = await get_postgres_client()
    row = await client.fetchrow(
        "SELECT two_factor_enforced FROM organizations WHERE id = $1",
        org_id,
    )

    if not row:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Organization not found",
        )

    return {
        "two_factor_enforced": row["two_factor_enforced"],
    }


@router.get("/{org_id}/members-2fa-status", response_model=list[dict])
async def get_org_members_2fa_status(
    org_id: str,
    user: dict = Depends(get_current_user),
):
    """Get 2FA status for all members in an organization.

    Only org admins/owners can view this.
    """
    await require_org_admin(org_id)

    client = await get_postgres_client()

    query = """
        SELECT u.id, u.email, u.name, u.two_factor_enabled, om.joined_at, om.last_active_at
        FROM org_members om
        JOIN users u ON u.id = om.user_id
        WHERE om.org_id = $1
        ORDER BY om.joined_at DESC
    """
    rows = await client.fetch(query, org_id)

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
