"""SCIM 2.0 Provisioning endpoints for automated user lifecycle management.

Implements RFC 7643 (SCIM Core Schema) and RFC 7644 (SCIM Protocol) for:
- User provisioning via Identity Provider
- User de-provisioning (suspend, not delete)
- Bearer token authentication
- Clerk Backend API sync (create user + org membership)

SCIM endpoint base: /orgs/{org_id}/scim/v2
"""

from __future__ import annotations

import hashlib
import logging
from typing import Any
from uuid import uuid4

from fastapi import APIRouter, Header, HTTPException, status
from pydantic import BaseModel, Field

from eden.api.utils.redact import redact_all
from eden.config import get_settings
from eden.storage.postgres import get_postgres_client

logger = logging.getLogger(__name__)
settings = get_settings()

router = APIRouter(prefix="/orgs/{org_id}/scim/v2", tags=["scim"])


# ============================================================================
# SCIM Schema (RFC 7643 - minimal User schema)
# ============================================================================

class SCIMName(BaseModel):
    """SCIM name object per RFC 7643."""
    givenName: str | None = Field(None, alias="givenName")
    familyName: str | None = Field(None, alias="familyName")


class SCIMEmail(BaseModel):
    """SCIM email object per RFC 7643."""
    value: str
    type: str | None = "work"
    primary: bool | None = True


class SCIMUser(BaseModel):
    """SCIM User resource per RFC 7643.

    Required attributes:
    - userName: unique identifier (email)
    - name.givenName, name.familyName
    - emails
    - active

    We do NOT support password via SCIM.
    """
    schemas: list[str] = ["urn:ietf:params:scim:schemas:core:2.0:User"]
    id: str | None = None
    externalId: str | None = Field(None, alias="externalId")
    userName: str | None = None  # Required
    name: SCIMName | None = None
    displayName: str | None = None
    emails: list[SCIMEmail] | None = None
    active: bool | None = True
    meta: dict | None = None


class SCIMPatchOperation(BaseModel):
    """Single PatchOp operation (RFC 7644 §3.5.2). Azure AD uses capitalized ops."""
    op: str
    path: str | None = None
    value: Any = None


class SCIMPatchOp(BaseModel):
    """SCIM PatchOp envelope used by Azure AD / Okta for partial updates."""
    schemas: list[str] = ["urn:ietf:params:scim:api:messages:2.0:PatchOp"]
    Operations: list[SCIMPatchOperation] = Field(default_factory=list)


class SCIMListResponse(BaseModel):
    """SCIM list response wrapper per RFC 7644."""
    schemas: list[str] = ["urn:ietf:params:scim:api:messages:2.0:ListResponse"]
    totalResults: int
    startIndex: int = 1
    itemsPerPage: int
    Resources: list[dict]


class SCIMError(BaseModel):
    """SCIM error response per RFC 7644."""
    schemas: list[str] = ["urn:ietf:params:scim:api:messages:2.0:Error"]
    detail: str | None = None
    status: int


# ============================================================================
# SCIM Bearer Token Authentication
# ============================================================================

async def get_current_org_scim(
    org_id: str,
    authorization: str | None = Header(None, alias="Authorization"),
) -> dict:
    """Validate SCIM bearer token and return org context.

    Compares hashed token against org_scim_config.scim_token_hash.
    Raises HTTPException 401 if invalid or SCIM not enabled.
    """
    if not authorization:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authorization header required",
            headers={"WWW-Authenticate": "Bearer"},
        )

    if not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Bearer token required",
            headers={"WWW-Authenticate": "Bearer"},
        )

    bearer_token = authorization[7:]  # Strip "Bearer "

    if not bearer_token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Bearer token required",
            headers={"WWW-Authenticate": "Bearer"},
        )

    client = await get_postgres_client()

    # Get SCIM config for org
    row = await client.fetchrow(
        "SELECT scim_token_hash, scim_enabled FROM org_scim_config WHERE org_id = $1",
        org_id,
    )
    if not row:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="SCIM not configured for this organization",
            headers={"WWW-Authenticate": "Bearer"},
        )

    if not row["scim_enabled"]:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="SCIM is disabled for this organization",
            headers={"WWW-Authenticate": "Bearer"},
        )

    # Compare token against stored hash with a constant-time check
    # (hmac.compare_digest) so a timing side-channel cannot reveal
    # how many leading bytes of the submitted token were correct.
    token_hash = hashlib.sha256(bearer_token.encode()).hexdigest()
    import hmac as _hmac

    if not _hmac.compare_digest(token_hash, row["scim_token_hash"] or ""):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid SCIM bearer token",
            headers={"WWW-Authenticate": "Bearer"},
        )

    # Get org name
    org_row = await client.fetchrow(
        "SELECT name FROM organizations WHERE id = $1",
        org_id,
    )

    return {
        "org_id": org_id,
        "org_name": org_row["name"] if org_row else None,
    }


# ============================================================================
# Helper Functions
# ============================================================================

def _scim_user_to_resource(scim_user: dict) -> dict:
    """Convert SCIM user record to RFC 7643 User resource."""
    # Parse name if available
    name = None
    if scim_user.get("display_name"):
        parts = scim_user["display_name"].split(" ", 1)
        name = {
            "givenName": parts[0] if parts else None,
            "familyName": parts[1] if len(parts) > 1 else None,
        }

    emails = None
    if scim_user.get("user_email"):
        emails = [{"value": scim_user["user_email"], "type": "work", "primary": True}]

    return {
        "schemas": ["urn:ietf:params:scim:schemas:core:2.0:User"],
        "id": str(scim_user["id"]),
        "externalId": scim_user.get("scim_external_id"),
        "userName": scim_user.get("user_email"),  # userName = email in our system
        "name": name,
        "displayName": scim_user.get("display_name"),
        "emails": emails,
        "active": scim_user.get("is_active", True),
        "meta": {
            "resourceType": "User",
            "lastModified": scim_user.get("last_synced_at", scim_user.get("created_at")),
        },
    }


def _parse_scim_user(scim_resource: dict) -> dict:
    """Parse SCIM User resource into normalized internal fields."""
    # Extract email from userName (required)
    user_name = scim_resource.get("userName")
    if not user_name:
        raise ValueError("userName is required")

    # Extract name
    name_data = scim_resource.get("name", {}) or {}
    given_name = name_data.get("givenName")
    family_name = name_data.get("familyName")

    # Extract email
    email = None
    if user_name:
        email = user_name
    elif scim_resource.get("emails"):
        primary_email = next(
            (e["value"] for e in scim_resource["emails"] if e.get("primary")),
            scim_resource["emails"][0]["value"],
        )
        email = primary_email

    display_name = scim_resource.get("displayName")
    if not display_name:
        display_name = " ".join(filter(None, [given_name, family_name]))

    return {
        "external_id": scim_resource.get("externalId"),
        "email": email,
        "given_name": given_name,
        "family_name": family_name,
        "display_name": display_name,
        "active": scim_resource.get("active", True),
    }


async def _get_or_create_user(client, email: str, given_name: str | None, family_name: str | None) -> str:
    """Get existing user by email or create a new user account.

    Returns user_id.
    """
    # Check if user exists
    existing = await client.fetchrow(
        "SELECT id FROM users WHERE email = $1",
        email.lower(),
    )
    if existing:
        return str(existing["id"])

    # Create new user (no password - they must use SSO or set password via email link)
    user_id = str(uuid4())
    display_name = " ".join(filter(None, [given_name, family_name])) or email.split("@")[0]

    await client.execute(
        """
        INSERT INTO users (id, email, name, password_hash)
        VALUES ($1, $2, $3, $4)
        """,
        user_id,
        email.lower(),
        display_name,
        "",  # No password - user authenticates via SCIM/SSO
    )

    return user_id


async def _sync_user_to_org(
    client,
    org_id: str,
    user_id: str,
    scim_external_id: str,
    display_name: str | None,
    active: bool,
) -> str:
    """Sync user to org membership.

    If active=False, suspends the user (sets role to 'suspended').
    Returns scim_user.id.
    """
    # Find or create SCIM user mapping
    scim_user = await client.fetchrow(
        "SELECT id, user_id FROM scim_users WHERE org_id = $1 AND scim_external_id = $2",
        org_id,
        scim_external_id,
    )

    if not scim_user:
        # Create new SCIM user mapping
        scim_user_id = str(uuid4())
        await client.execute(
            """
            INSERT INTO scim_users (id, org_id, scim_external_id, user_id, user_email, display_name, is_active)
            VALUES ($1, $2, $3, $4, (SELECT email FROM users WHERE id = $4), $5, $6)
            """,
            scim_user_id,
            org_id,
            scim_external_id,
            user_id,
            display_name,
            active,
        )
    else:
        scim_user_id = str(scim_user["id"])
        # Update existing SCIM user
        await client.execute(
            """
            UPDATE scim_users
            SET user_id = $1, display_name = $2, is_active = $3
            WHERE id = $4
            """,
            user_id,
            display_name,
            active,
            scim_user_id,
        )

    # Handle org membership
    membership = await client.fetchrow(
        "SELECT id, role FROM org_members WHERE org_id = $1 AND user_id = $2",
        org_id,
        user_id,
    )

    if active:
        if not membership:
            # Add as member
            await client.execute(
                """
                INSERT INTO org_members (org_id, user_id, role)
                VALUES ($1, $2, 'member')
                """,
                org_id,
                user_id,
            )
        elif membership["role"] == "suspended":
            # Reactivate - set back to member
            await client.execute(
                "UPDATE org_members SET role = 'member' WHERE org_id = $1 AND user_id = $2",
                org_id,
                user_id,
            )
    else:
        # De-provision: suspend (don't delete)
        if membership and membership["role"] != "suspended":
            # Check if owner (can't suspend owner)
            org = await client.fetchrow(
                "SELECT owner_id FROM organizations WHERE id = $1",
                org_id,
            )
            if org and str(org["owner_id"]) != user_id:
                await client.execute(
                    "UPDATE org_members SET role = 'suspended' WHERE org_id = $1 AND user_id = $2",
                    org_id,
                    user_id,
                )

    return scim_user_id


def _coerce_scim_bool(value: Any) -> bool:
    """Coerce Azure AD / Okta PatchOp boolean values (often strings)."""
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in ("true", "1", "yes")
    return bool(value)


def apply_scim_patch_operations(
    current: dict[str, Any],
    operations: list[dict[str, Any]] | list[SCIMPatchOperation],
) -> dict[str, Any]:
    """Apply RFC 7644 PatchOp ``replace`` ops onto a mutable user dict.

    Supports Azure AD paths used in practice:
    - ``active``
    - ``name`` / ``name.givenName`` / ``name.familyName`` / ``displayName``
    - ``emails`` / ``emails[type eq "work"].value`` / ``userName``

    Returns the updated dict (also mutates ``current`` in place).
    """
    for raw in operations:
        op = raw if isinstance(raw, dict) else raw.model_dump()
        op_name = str(op.get("op") or "").strip().lower()
        if op_name != "replace":
            # Phase 1: replace only (Azure AD soft-delete / profile sync).
            continue

        path = (op.get("path") or "").strip()
        value = op.get("value")

        # Path-less replace: value is a partial resource object.
        if not path:
            if isinstance(value, dict):
                if "active" in value:
                    current["active"] = _coerce_scim_bool(value["active"])
                if "name" in value and isinstance(value["name"], dict):
                    name = dict(current.get("name") or {})
                    name.update({k: v for k, v in value["name"].items() if v is not None})
                    current["name"] = name
                if "displayName" in value:
                    current["displayName"] = value["displayName"]
                if "emails" in value:
                    current["emails"] = value["emails"]
                if "userName" in value:
                    current["userName"] = value["userName"]
            continue

        path_l = path.lower()
        if path_l == "active":
            current["active"] = _coerce_scim_bool(value)
        elif path_l == "displayname":
            current["displayName"] = value
        elif path_l == "username":
            current["userName"] = value
        elif path_l == "name":
            if isinstance(value, dict):
                name = dict(current.get("name") or {})
                name.update({k: v for k, v in value.items() if v is not None})
                current["name"] = name
        elif path_l == "name.givenname":
            name = dict(current.get("name") or {})
            name["givenName"] = value
            current["name"] = name
        elif path_l == "name.familyname":
            name = dict(current.get("name") or {})
            name["familyName"] = value
            current["name"] = name
        elif path_l == "emails":
            current["emails"] = value
        elif "emails" in path_l and path_l.endswith(".value"):
            # emails[type eq "work"].value
            email_value = value if isinstance(value, str) else None
            if email_value:
                emails = list(current.get("emails") or [])
                if emails and isinstance(emails[0], dict):
                    emails[0] = {**emails[0], "value": email_value}
                else:
                    emails = [{"value": email_value, "type": "work", "primary": True}]
                current["emails"] = emails
                # Keep userName in sync when Azure patches email only.
                if not current.get("userName"):
                    current["userName"] = email_value

    # Derive displayName from name parts when missing after patch.
    name = current.get("name") or {}
    if not current.get("displayName") and isinstance(name, dict):
        derived = " ".join(
            filter(None, [name.get("givenName"), name.get("familyName")])
        )
        if derived:
            current["displayName"] = derived

    # Prefer primary email as userName when emails changed.
    emails = current.get("emails")
    if emails and isinstance(emails, list) and emails:
        primary = next(
            (e for e in emails if isinstance(e, dict) and e.get("primary")),
            emails[0] if isinstance(emails[0], dict) else None,
        )
        if primary and primary.get("value") and not current.get("userName"):
            current["userName"] = primary["value"]

    return current


async def _link_clerk_id(client, user_id: str, clerk_user_id: str) -> None:
    """Persist Clerk user id on the Eden users row (best-effort)."""
    try:
        await client.execute(
            """
            UPDATE users
            SET clerk_id = $1
            WHERE id = $2
              AND (clerk_id IS NULL OR clerk_id = $1)
            """,
            clerk_user_id,
            user_id,
        )
    except Exception as exc:  # noqa: BLE001 — non-fatal side-effect
        logger.warning(
            "Failed to link clerk_id=%s to user=%s: %s",
            clerk_user_id,
            user_id,
            redact_all(str(exc)),
        )


async def _sync_clerk_for_scim_user(
    client,
    *,
    org_id: str,
    user_id: str | None,
    email: str | None,
    given_name: str | None = None,
    family_name: str | None = None,
    active: bool = True,
) -> None:
    """Best-effort Clerk sync for a SCIM provision/deprovision event.

    - active=True: ensure Clerk user exists + org membership
    - active=False: delete Clerk org membership (Eden suspends locally)

    Failures are logged and never raise — local SCIM state is source of
    truth for the IdP response; Clerk webhooks can reconcile later.
    """
    if not user_id or not email:
        return

    # Lazy import keeps SCIM routes importable in tests that never
    # touch Clerk (mirrors invitation_service / orgs.create_org).
    from eden.api.utils.clerk_client import (
        ClerkAPIError,
        create_membership,
        create_user_with_email,
        delete_membership,
        resolve_clerk_org_id,
    )

    clerk_org_id = await resolve_clerk_org_id(client, org_id)
    if not clerk_org_id:
        logger.info(
            "SCIM Clerk sync skipped: org %s has no clerk_org_id",
            org_id,
        )
        return

    # Resolve existing clerk_id from Eden row first.
    clerk_user_id: str | None = None
    try:
        row = await client.fetchrow(
            "SELECT clerk_id FROM users WHERE id = $1",
            user_id,
        )
        if row and row.get("clerk_id"):
            clerk_user_id = str(row["clerk_id"])
    except Exception as exc:  # noqa: BLE001
        logger.warning("SCIM clerk_id lookup failed user=%s: %s", user_id, redact_all(str(exc)))

    try:
        if active:
            if not clerk_user_id:
                clerk_user = await create_user_with_email(
                    email,
                    first_name=given_name,
                    last_name=family_name,
                )
                clerk_user_id = str(clerk_user.get("id") or "") or None
                if clerk_user_id:
                    await _link_clerk_id(client, user_id, clerk_user_id)

            if not clerk_user_id:
                logger.warning(
                    "SCIM Clerk sync: could not resolve clerk user for %s",
                    email,
                )
                return

            try:
                await create_membership(
                    clerk_org_id=clerk_org_id,
                    user_id=clerk_user_id,
                    role="member",
                )
            except ClerkAPIError as exc:
                if "already" in str(exc).lower():
                    logger.info(
                        "Clerk membership already exists (user=%s org=%s)",
                        clerk_user_id,
                        clerk_org_id,
                    )
                else:
                    logger.warning(
                        "Clerk membership create failed (user=%s org=%s): %s",
                        clerk_user_id,
                        clerk_org_id,
                        redact_all(str(exc)),
                    )
        else:
            # Deprovision: look up existing Clerk user only — never create.
            if not clerk_user_id:
                from eden.api.utils.clerk_client import find_user_by_email

                found = await find_user_by_email(email)
                if found and found.get("id"):
                    clerk_user_id = str(found["id"])
                    await _link_clerk_id(client, user_id, clerk_user_id)

            if not clerk_user_id:
                logger.info(
                    "SCIM Clerk deprovision: no clerk user for %s; skip",
                    email,
                )
                return

            try:
                await delete_membership(clerk_org_id, clerk_user_id)
            except ClerkAPIError as exc:
                # 404 = already removed — benign.
                if "404" in str(exc):
                    logger.info(
                        "Clerk membership already removed (user=%s org=%s)",
                        clerk_user_id,
                        clerk_org_id,
                    )
                else:
                    logger.warning(
                        "Clerk membership delete failed (user=%s org=%s): %s",
                        clerk_user_id,
                        clerk_org_id,
                        redact_all(str(exc)),
                    )
    except ClerkAPIError as exc:
        logger.warning(
            "SCIM Clerk sync failed (org=%s email=%s active=%s): %s",
            org_id,
            email,
            active,
            redact_all(str(exc)),
        )
    except Exception as exc:  # noqa: BLE001 — defensive
        logger.exception(
            "Unexpected SCIM Clerk sync error (org=%s email=%s): %s",
            org_id,
            email,
            redact_all(str(exc)),
        )


# ============================================================================
# SCIM Endpoints (RFC 7644)
# ============================================================================

@router.get("/Users", response_model=SCIMListResponse)
async def list_scim_users(
    org_id: str,
    filter: str | None = None,
    startIndex: int = 1,
    count: int = 100,
    authorization: str | None = Header(None, alias="Authorization"),
):
    """List all SCIM-provisioned users for the org (RFC 7644 Section 3.4.2).

    Query params:
    - filter: SCIM filter expression (e.g., "userName eq 'user@example.com'")
    - startIndex: 1-based index for pagination
    - count: maximum results to return
    """
    await get_current_org_scim(org_id, authorization)

    client = await get_postgres_client()

    # Build query
    query = """
        SELECT su.id, su.scim_external_id, su.user_email, su.display_name,
               su.is_active, su.created_at, su.last_synced_at,
               u.id as user_id
        FROM scim_users su
        LEFT JOIN users u ON u.id = su.user_id
        WHERE su.org_id = $1
    """
    params = [org_id]

    # Handle filter (basic support for "userName eq 'email'" and "active eq true/false")
    if filter:
        if "userName eq " in filter:
            import re
            match = re.search(r"userName eq '([^']+)'", filter)
            if match:
                query += " AND su.user_email = $2"
                params.append(match.group(1).lower())
        if "active eq " in filter:
            import re
            match = re.search(r"active eq (true|false)", filter, re.IGNORECASE)
            if match:
                params.append(match.group(1).lower() == "true")
                query += f" AND su.is_active = ${len(params)}"

    query += " ORDER BY su.created_at ASC"
    query += f" LIMIT {min(count, 100)} OFFSET {max(startIndex - 1, 0)}"

    rows = await client.fetch(query, *params)

    # Get total count
    total_row = await client.fetchrow(
        "SELECT COUNT(*) FROM scim_users WHERE org_id = $1",
        org_id,
    )
    total = total_row["count"] if total_row else 0

    resources = [_scim_user_to_resource(dict(r)) for r in rows]

    return SCIMListResponse(
        totalResults=total,
        startIndex=startIndex,
        itemsPerPage=len(resources),
        Resources=resources,
    )


@router.post("/Users", response_model=dict, status_code=status.HTTP_201_CREATED)
async def create_scim_user(
    org_id: str,
    scim_user: SCIMUser,
    authorization: str | None = Header(None, alias="Authorization"),
):
    """Provision a new user via SCIM (RFC 7644 Section 3.4.3).

    Creates user account and adds to org as member.
    """
    await get_current_org_scim(org_id, authorization)

    # Parse SCIM resource
    try:
        parsed = _parse_scim_user(scim_user.model_dump(by_alias=True))
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        ) from e

    client = await get_postgres_client()

    # Check if external ID already exists
    if parsed.get("external_id"):
        existing = await client.fetchrow(
            "SELECT id FROM scim_users WHERE org_id = $1 AND scim_external_id = $2",
            org_id,
            parsed["external_id"],
        )
        if existing:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="User with this externalId already exists",
            )

    # Check if email already used by another SCIM user
    existing_email = await client.fetchrow(
        "SELECT id FROM scim_users WHERE org_id = $1 AND user_email = $2",
        org_id,
        parsed["email"].lower(),
    )
    if existing_email:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="A user with this email already exists in the organization",
        )

    # Get or create user account
    user_id = await _get_or_create_user(
        client,
        parsed["email"],
        parsed.get("given_name"),
        parsed.get("family_name"),
    )

    # Sync to org
    scim_external_id = parsed.get("external_id") or str(uuid4())
    active = parsed.get("active", True)
    scim_user_id = await _sync_user_to_org(
        client,
        org_id,
        user_id,
        scim_external_id,
        parsed.get("display_name"),
        active,
    )

    # Best-effort Clerk user + membership (Phase 1 SCIM ↔ Clerk sync).
    await _sync_clerk_for_scim_user(
        client,
        org_id=org_id,
        user_id=user_id,
        email=parsed.get("email"),
        given_name=parsed.get("given_name"),
        family_name=parsed.get("family_name"),
        active=active,
    )

    # Update sync metadata
    await client.execute(
        """
        UPDATE org_scim_config
        SET last_sync_at = NOW(),
            provisioned_user_count = (SELECT COUNT(*) FROM scim_users WHERE org_id = $1 AND is_active = TRUE)
        WHERE org_id = $1
        """,
        org_id,
    )

    # Fetch created SCIM user
    created = await client.fetchrow(
        "SELECT * FROM scim_users WHERE id = $1",
        scim_user_id,
    )

    return _scim_user_to_resource(dict(created))


@router.get("/Users/{scim_user_id}", response_model=dict)
async def get_scim_user(
    org_id: str,
    scim_user_id: str,
    authorization: str | None = Header(None, alias="Authorization"),
):
    """Get a SCIM user by ID (RFC 7644 Section 3.4.1)."""
    await get_current_org_scim(org_id, authorization)

    client = await get_postgres_client()

    row = await client.fetchrow(
        """
        SELECT su.*, u.id as user_id
        FROM scim_users su
        LEFT JOIN users u ON u.id = su.user_id
        WHERE su.id = $1 AND su.org_id = $2
        """,
        scim_user_id,
        org_id,
    )

    if not row:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="User not found",
        )

    return _scim_user_to_resource(dict(row))


@router.put("/Users/{scim_user_id}", response_model=dict)
async def update_scim_user(
    org_id: str,
    scim_user_id: str,
    scim_user: SCIMUser,
    authorization: str | None = Header(None, alias="Authorization"),
):
    """Update (replace) a SCIM user via PUT (RFC 7644 Section 3.4.4.1).

    Replaces all mutable attributes of the user.
    """
    await get_current_org_scim(org_id, authorization)

    client = await get_postgres_client()

    # Verify user exists
    existing = await client.fetchrow(
        "SELECT * FROM scim_users WHERE id = $1 AND org_id = $2",
        scim_user_id,
        org_id,
    )
    if not existing:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="User not found",
        )

    # Parse SCIM resource
    try:
        parsed = _parse_scim_user(scim_user.model_dump(by_alias=True))
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        ) from e

    # Update user account if email changed
    user_id = existing["user_id"]
    if user_id and parsed["email"].lower() != existing.get("user_email", "").lower():
        # Check if new email is available
        existing_user = await client.fetchrow(
            "SELECT id FROM users WHERE email = $1 AND id != $2",
            parsed["email"].lower(),
            user_id,
        )
        if existing_user:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Email already in use by another user",
            )
        # Update user email/name
        await client.execute(
            "UPDATE users SET email = $1, name = $2 WHERE id = $3",
            parsed["email"].lower(),
            parsed.get("display_name"),
            user_id,
        )

    # Update SCIM user mapping
    await client.execute(
        """
        UPDATE scim_users
        SET display_name = $1, is_active = $2
        WHERE id = $3
        """,
        parsed.get("display_name"),
        parsed.get("active", True),
        scim_user_id,
    )

    # Sync to org (handles membership changes)
    active = parsed.get("active", True)
    if user_id:
        await _sync_user_to_org(
            client,
            org_id,
            user_id,
            existing["scim_external_id"],
            parsed.get("display_name"),
            active,
        )
        await _sync_clerk_for_scim_user(
            client,
            org_id=org_id,
            user_id=str(user_id),
            email=parsed.get("email") or existing.get("user_email"),
            given_name=parsed.get("given_name"),
            family_name=parsed.get("family_name"),
            active=active,
        )

    # Update sync metadata
    await client.execute(
        """
        UPDATE org_scim_config
        SET last_sync_at = NOW(),
            provisioned_user_count = (SELECT COUNT(*) FROM scim_users WHERE org_id = $1 AND is_active = TRUE)
        WHERE org_id = $1
        """,
        org_id,
    )

    # Fetch updated SCIM user
    updated = await client.fetchrow(
        "SELECT * FROM scim_users WHERE id = $1",
        scim_user_id,
    )

    return _scim_user_to_resource(dict(updated))


@router.patch("/Users/{scim_user_id}", response_model=dict)
async def patch_scim_user(
    org_id: str,
    scim_user_id: str,
    patch: SCIMPatchOp,
    authorization: str | None = Header(None, alias="Authorization"),
):
    """Partial update via PatchOp (RFC 7644 §3.5.2) — required by Azure AD.

    Supports ``replace`` on ``active``, ``name`` / name sub-attrs, and
    ``emails``. Deprovision (``active=false``) suspends Eden membership
    and removes the Clerk org membership.
    """
    await get_current_org_scim(org_id, authorization)

    client = await get_postgres_client()

    existing = await client.fetchrow(
        "SELECT * FROM scim_users WHERE id = $1 AND org_id = $2",
        scim_user_id,
        org_id,
    )
    if not existing:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="User not found",
        )

    # Seed current resource from stored row, then apply PatchOps.
    current = _scim_user_to_resource(dict(existing))
    ops = [op.model_dump() for op in patch.Operations]
    if not ops:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Operations is required",
        )
    apply_scim_patch_operations(current, ops)

    try:
        parsed = _parse_scim_user(current)
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        ) from e

    user_id = existing["user_id"]
    active = parsed.get("active", True)

    # Email change on the Eden user account (same guards as PUT).
    if user_id and parsed["email"].lower() != (existing.get("user_email") or "").lower():
        existing_user = await client.fetchrow(
            "SELECT id FROM users WHERE email = $1 AND id != $2",
            parsed["email"].lower(),
            user_id,
        )
        if existing_user:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Email already in use by another user",
            )
        await client.execute(
            "UPDATE users SET email = $1, name = $2 WHERE id = $3",
            parsed["email"].lower(),
            parsed.get("display_name"),
            user_id,
        )
        await client.execute(
            "UPDATE scim_users SET user_email = $1 WHERE id = $2",
            parsed["email"].lower(),
            scim_user_id,
        )

    await client.execute(
        """
        UPDATE scim_users
        SET display_name = $1, is_active = $2
        WHERE id = $3
        """,
        parsed.get("display_name"),
        active,
        scim_user_id,
    )

    if user_id:
        await _sync_user_to_org(
            client,
            org_id,
            user_id,
            existing["scim_external_id"],
            parsed.get("display_name"),
            active,
        )
        await _sync_clerk_for_scim_user(
            client,
            org_id=org_id,
            user_id=str(user_id),
            email=parsed.get("email") or existing.get("user_email"),
            given_name=parsed.get("given_name"),
            family_name=parsed.get("family_name"),
            active=active,
        )

    await client.execute(
        """
        UPDATE org_scim_config
        SET last_sync_at = NOW(),
            provisioned_user_count = (SELECT COUNT(*) FROM scim_users WHERE org_id = $1 AND is_active = TRUE)
        WHERE org_id = $1
        """,
        org_id,
    )

    updated = await client.fetchrow(
        "SELECT * FROM scim_users WHERE id = $1",
        scim_user_id,
    )
    return _scim_user_to_resource(dict(updated))


@router.delete("/Users/{scim_user_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_scim_user(
    org_id: str,
    scim_user_id: str,
    authorization: str | None = Header(None, alias="Authorization"),
):
    """De-provision a user (RFC 7644 Section 3.4.4.5).

    Per spec, we suspend the user (set is_active=False and org_members.role='suspended')
    rather than deleting, to preserve data.
    """
    await get_current_org_scim(org_id, authorization)

    client = await get_postgres_client()

    # Get SCIM user
    scim_user = await client.fetchrow(
        "SELECT * FROM scim_users WHERE id = $1 AND org_id = $2",
        scim_user_id,
        org_id,
    )
    if not scim_user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="User not found",
        )

    # De-provision: set inactive and suspend org membership
    if scim_user["user_id"]:
        await _sync_user_to_org(
            client,
            org_id,
            scim_user["user_id"],
            scim_user["scim_external_id"],
            scim_user.get("display_name"),
            False,  # active=False -> suspended
        )
        await _sync_clerk_for_scim_user(
            client,
            org_id=org_id,
            user_id=str(scim_user["user_id"]),
            email=scim_user.get("user_email"),
            active=False,
        )

    # Mark SCIM user as inactive
    await client.execute(
        "UPDATE scim_users SET is_active = FALSE WHERE id = $1",
        scim_user_id,
    )

    # Update sync metadata
    await client.execute(
        """
        UPDATE org_scim_config
        SET last_sync_at = NOW(),
            provisioned_user_count = (SELECT COUNT(*) FROM scim_users WHERE org_id = $1 AND is_active = TRUE)
        WHERE org_id = $1
        """,
        org_id,
    )

    return None


# ============================================================================
# Service Provider Configuration (RFC 7644 Section 4)
# ============================================================================

@router.get("/ServiceProviderConfig")
async def get_service_provider_config(
    org_id: str,
    authorization: str | None = Header(None, alias="Authorization"),
):
    """Return SCIM service provider configuration."""
    await get_current_org_scim(org_id, authorization)

    return {
        "schemas": ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
        "documentationUri": "https://docs.example.com/scim",
        "patch": {"supported": True},
        "bulk": {"supported": False, "maxOperations": 0, "maxPayloadSize": 0},
        "filter": {"supported": True, "maxResults": 100},
        "changePassword": {"supported": False},
        "sort": {"supported": False},
        "etag": {"supported": False},
        "authenticationSchemes": [
            {
                "type": "oauthbearertoken",
                "name": "OAuth Bearer Token",
                "description": "Authentication scheme using the OAuth Bearer Token Standard",
                "specUri": "http://www.rfc.org/rfc/rfc6750.txt",
            }
        ],
    }


@router.get("/ResourceTypes", response_model=dict)
async def get_resource_types(
    org_id: str,
    authorization: str | None = Header(None, alias="Authorization"),
):
    """Return supported SCIM resource types."""
    await get_current_org_scim(org_id, authorization)

    return {
        "schemas": ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
        "totalResults": 1,
        "Resources": [
            {
                "schemas": ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
                "id": "User",
                "name": "User",
                "endpoint": "/Users",
                "description": "User Account",
                "schema": "urn:ietf:params:scim:schemas:core:2.0:User",
                "schemaExtensions": [],
            }
        ],
    }


@router.get("/Schemas", response_model=dict)
async def get_schemas(
    org_id: str,
    authorization: str | None = Header(None, alias="Authorization"),
):
    """Return SCIM schemas."""
    await get_current_org_scim(org_id, authorization)

    return {
        "schemas": ["urn:ietf:params:scim:schemas:core:2.0:Schema"],
        "totalResults": 1,
        "Resources": [
            {
                "id": "urn:ietf:params:scim:schemas:core:2.0:User",
                "name": "User",
                "description": "User Account",
                "attributes": [
                    {"name": "userName", "type": "string", "required": True, "caseExact": False},
                    {"name": "name", "type": "complex", "required": False},
                    {"name": "displayName", "type": "string", "required": False},
                    {"name": "emails", "type": "complex", "multiValued": True, "required": False},
                    {"name": "active", "type": "boolean", "required": False},
                    {"name": "externalId", "type": "string", "required": False, "caseExact": True},
                ],
            }
        ],
    }
