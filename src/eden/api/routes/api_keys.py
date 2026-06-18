"""Organization API Key management routes."""

import hashlib
import logging
import secrets
from uuid import uuid4

from fastapi import APIRouter, Depends, Header, HTTPException, status

from eden.api.deps import get_current_user, require_org_admin
from eden.storage.postgres import get_postgres_client

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/orgs/{org_id}/api-keys", tags=["api-keys"])

# Valid scopes for API keys
VALID_SCOPES = [
    "references:read",
    "references:write",
    "jobs:read",
    "jobs:write",
]


def generate_api_key() -> str:
    """Generate a secure random API key."""
    # Format: eden_api_key_<32 random bytes as hex>
    return f"eden_api_key_{secrets.token_hex(32)}"


def hash_api_key(key: str) -> str:
    """Hash an API key using SHA-256."""
    return hashlib.sha256(key.encode()).hexdigest()


def get_key_prefix(key: str) -> str:
    """Get the last 8 characters of a key for display."""
    return key[-8:]


@router.post("", response_model=dict)
async def create_api_key(
    org_id: str,
    name: str,
    scopes: list[str],
    user: dict = Depends(get_current_user),
):
    """Create a new API key for an organization.

    Returns the raw key once - it cannot be retrieved again.
    The user must save the raw key securely.
    """
    await require_org_admin(org_id)

    # Validate name
    if not name or len(name) < 2 or len(name) > 100:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Key name must be 2-100 characters",
        )

    # Validate scopes
    if not scopes:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="At least one scope is required",
        )

    invalid_scopes = [s for s in scopes if s not in VALID_SCOPES]
    if invalid_scopes:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid scopes: {invalid_scopes}. Valid scopes: {VALID_SCOPES}",
        )

    client = await get_postgres_client()

    # Generate the raw key and its hash
    raw_key = generate_api_key()
    key_hash = hash_api_key(raw_key)
    key_prefix = get_key_prefix(raw_key)

    # Store the key metadata (NOT the raw key)
    key_id = str(uuid4())
    await client.execute(
        """
        INSERT INTO org_api_keys (id, org_id, name, key_hash, key_prefix, scopes, created_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        """,
        key_id,
        org_id,
        name,
        key_hash,
        key_prefix,
        scopes,
        user["user_id"],
    )

    return {
        "id": key_id,
        "name": name,
        "key_prefix": key_prefix,
        "scopes": scopes,
        "raw_key": raw_key,  # Only returned once!
        "created_at": None,  # Will be filled by the client
    }


@router.get("", response_model=list[dict])
async def list_api_keys(
    org_id: str,
    user: dict = Depends(get_current_user),
):
    """List all API keys for an organization (without raw keys)."""
    # Require org membership (any role can view keys)
    from eden.api.deps import get_current_org
    org = await get_current_org(org_id)
    if not org:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Not a member of this organization",
        )

    client = await get_postgres_client()

    query = """
        SELECT id, name, key_prefix, scopes, created_by, last_used_at, created_at
        FROM org_api_keys
        WHERE org_id = $1
        ORDER BY created_at DESC
    """
    rows = await client.fetch(query, org_id)

    return [
        {
            "id": str(r["id"]),
            "name": r["name"],
            "key_prefix": r["key_prefix"],
            "scopes": r["scopes"],
            "created_by": str(r["created_by"]),
            "last_used_at": r["last_used_at"].isoformat() if r.get("last_used_at") else None,
            "created_at": r["created_at"].isoformat() if r.get("created_at") else None,
        }
        for r in rows
    ]


@router.delete("/{key_id}", response_model=dict)
async def revoke_api_key(
    org_id: str,
    key_id: str,
    user: dict = Depends(get_current_user),
):
    """Revoke (delete) an API key."""
    await require_org_admin(org_id)

    client = await get_postgres_client()

    # Verify the key belongs to this org
    key = await client.fetchrow(
        "SELECT id FROM org_api_keys WHERE id = $1 AND org_id = $2",
        key_id,
        org_id,
    )
    if not key:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="API key not found",
        )

    await client.execute(
        "DELETE FROM org_api_keys WHERE id = $1",
        key_id,
    )

    return {"message": "API key revoked"}


async def validate_org_api_key(org_id: str, key: str) -> dict | None:
    """Validate an API key and return org context if valid.

    Returns None if key is invalid or doesn't match the org.
    Updates last_used_at timestamp.
    """
    client = await get_postgres_client()

    key_hash = hashlib.sha256(key.encode()).hexdigest()
    query = """
        SELECT o.name, o.slug, o.owner_id, oak.org_id, oak.scopes, oak.id as key_id
        FROM org_api_keys oak
        JOIN organizations o ON o.id = oak.org_id
        WHERE oak.key_hash = $1 AND oak.org_id = $2
    """
    row = await client.fetchrow(query, key_hash, org_id)
    if not row:
        return None

    # Update last_used_at
    await client.execute(
        "UPDATE org_api_keys SET last_used_at = NOW() WHERE id = $1",
        row["key_id"],
    )

    return {
        "org_id": str(row["org_id"]),
        "name": row["name"],
        "slug": row["slug"],
        "is_owner": row["owner_id"] == row["org_id"],
        "scopes": row["scopes"],
        "key_id": str(row["key_id"]),
    }


# Dependency for routes that accept API key auth
async def get_current_org_api_key(
    x_org_id: str = Header(..., alias="X-Org-Id"),
    x_org_api_key: str | None = Header(None, alias="X-Org-Api-Key"),
):
    """Validate X-Org-Api-Key header and return org context.

    This is an alternative to cookie-based auth for programmatic access.
    """
    if not x_org_api_key:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="X-Org-Api-Key header required",
        )

    org_context = await validate_org_api_key(x_org_id, x_org_api_key)
    if not org_context:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid API key",
        )

    return org_context
