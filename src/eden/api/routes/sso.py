"""SSO/SAML/OIDC authentication routes for Eden."""

import hashlib
import logging
import secrets
from datetime import datetime, timedelta
from typing import Optional
from uuid import uuid4

from fastapi import APIRouter, HTTPException, Depends, status, Header, Query
from pydantic import BaseModel
import jwt

from eden.api.deps import get_current_user, require_org_admin, get_postgres_client
from eden.config import get_settings
from eden.api.utils.auth import create_access_token, decode_access_token

logger = logging.getLogger(__name__)
settings = get_settings()
router = APIRouter(prefix="/sso", tags=["sso"])


class SSOProviderConfig(BaseModel):
    """SSO provider configuration."""
    provider_type: str  # okta, google, oidc, saml2
    name: str
    entity_id: Optional[str] = None
    sso_url: Optional[str] = None
    certificate: Optional[str] = None
    client_id: Optional[str] = None
    client_secret: Optional[str] = None
    scopes: Optional[list[str]] = None


class SSOProviderResponse(BaseModel):
    """SSO provider response."""
    id: str
    org_id: str
    provider_type: str
    name: str
    enabled: bool
    default_for_domain: Optional[str]
    enforce_sso: bool
    scim_enabled: bool
    created_at: datetime


def _hash_token(token: str) -> str:
    """Hash a token for storage."""
    return hashlib.sha256(token.encode()).hexdigest()


def _generate_scim_token() -> str:
    """Generate a random SCIM bearer token."""
    return secrets.token_urlsafe(32)


@router.get("/providers", response_model=list[SSOProviderResponse])
async def list_sso_providers(
    org_id: str = Query(..., alias="org_id"),
    user: dict = Depends(get_current_user),
):
    """List all SSO providers for an organization."""
    client = await get_postgres_client()

    query = """
        SELECT id, org_id, provider_type, name, config, enabled,
               default_for_domain, enforce_sso, scim_enabled, created_at
        FROM org_sso_providers
        WHERE org_id = $1
        ORDER BY created_at DESC
    """
    rows = await client.fetch(query, org_id)

    return [
        {
            "id": str(r["id"]),
            "org_id": str(r["org_id"]),
            "provider_type": r["provider_type"],
            "name": r["name"],
            "enabled": r["enabled"],
            "default_for_domain": r.get("default_for_domain"),
            "enforce_sso": r.get("enforce_sso", False),
            "scim_enabled": r.get("scim_enabled", False),
            "created_at": r["created_at"],
        }
        for r in rows
    ]


@router.post("/providers", response_model=dict)
async def create_sso_provider(
    config: SSOProviderConfig,
    org_id: str = Query(..., alias="org_id"),
    user: dict = Depends(get_current_user),
):
    """Create a new SSO provider configuration."""
    await require_org_admin(org_id)

    client = await get_postgres_client()

    # Build config JSONB
    config_data = {
        "entity_id": config.entity_id,
        "sso_url": config.sso_url,
        "certificate": config.certificate,
        "client_id": config.client_id,
        "client_secret": config.client_secret,
        "scopes": config.scopes or ["openid", "profile", "email"],
    }

    provider_id = str(uuid4())
    query = """
        INSERT INTO org_sso_providers (id, org_id, provider_type, name, config, created_by)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id
    """
    row = await client.fetchrow(
        query, provider_id, org_id, config.provider_type, config.name, config_data, user["user_id"]
    )

    return {"id": str(row["id"]), "message": "SSO provider created"}


@router.patch("/providers/{provider_id}", response_model=dict)
async def update_sso_provider(
    provider_id: str,
    config: dict,
    org_id: str = Query(..., alias="org_id"),
    user: dict = Depends(get_current_user),
):
    """Update an SSO provider configuration."""
    await require_org_admin(org_id)

    client = await get_postgres_client()

    # Get current config and merge updates
    current = await client.fetchrow(
        "SELECT config FROM org_sso_providers WHERE id = $1 AND org_id = $2",
        provider_id, org_id
    )
    if not current:
        raise HTTPException(status_code=404, detail="Provider not found")

    merged_config = {**current["config"], **config}

    await client.execute(
        """
        UPDATE org_sso_providers
        SET config = $1, updated_at = NOW()
        WHERE id = $2 AND org_id = $3
        """,
        merged_config, provider_id, org_id
    )

    return {"message": "SSO provider updated"}


@router.post("/providers/{provider_id}/enable", response_model=dict)
async def enable_sso_provider(
    provider_id: str,
    org_id: str = Query(..., alias="org_id"),
    user: dict = Depends(get_current_user),
):
    """Enable an SSO provider."""
    await require_org_admin(org_id)

    client = await get_postgres_client()

    result = await client.execute(
        "UPDATE org_sso_providers SET enabled = TRUE, updated_at = NOW() WHERE id = $1 AND org_id = $2",
        provider_id, org_id
    )

    if result == "UPDATE 0":
        raise HTTPException(status_code=404, detail="Provider not found")

    return {"message": "SSO provider enabled"}


@router.post("/providers/{provider_id}/disable", response_model=dict)
async def disable_sso_provider(
    provider_id: str,
    org_id: str = Query(..., alias="org_id"),
    user: dict = Depends(get_current_user),
):
    """Disable an SSO provider."""
    await require_org_admin(org_id)

    client = await get_postgres_client()

    result = await client.execute(
        "UPDATE org_sso_providers SET enabled = FALSE, updated_at = NOW() WHERE id = $1 AND org_id = $2",
        provider_id, org_id
    )

    if result == "UPDATE 0":
        raise HTTPException(status_code=404, detail="Provider not found")

    return {"message": "SSO provider disabled"}


@router.post("/providers/{provider_id}/enforce", response_model=dict)
async def enforce_sso(
    provider_id: str,
    enforce: bool = True,
    org_id: str = Query(..., alias="org_id"),
    user: dict = Depends(get_current_user),
):
    """Toggle SSO enforcement (blocks password login for org members)."""
    await require_org_admin(org_id)

    client = await get_postgres_client()

    result = await client.execute(
        "UPDATE org_sso_providers SET enforce_sso = $1, updated_at = NOW() WHERE id = $2 AND org_id = $3",
        enforce, provider_id, org_id
    )

    if result == "UPDATE 0":
        raise HTTPException(status_code=404, detail="Provider not found")

    return {"message": f"SSO enforcement {'enabled' if enforce else 'disabled'}"}


# SCIM token management
@router.post("/providers/{provider_id}/scim/token", response_model=dict)
async def generate_scim_token(
    provider_id: str,
    org_id: str = Query(..., alias="org_id"),
    user: dict = Depends(get_current_user),
):
    """Generate or rotate SCIM bearer token for a provider."""
    await require_org_admin(org_id)

    client = await get_postgres_client()

    # Verify provider exists
    provider = await client.fetchrow(
        "SELECT id FROM org_sso_providers WHERE id = $1 AND org_id = $2",
        provider_id, org_id
    )
    if not provider:
        raise HTTPException(status_code=404, detail="Provider not found")

    # Generate new token
    raw_token = _generate_scim_token()
    token_hash = _hash_token(raw_token)

    await client.execute(
        """
        UPDATE org_sso_providers
        SET scim_token_hash = $1, scim_enabled = TRUE, updated_at = NOW()
        WHERE id = $2 AND org_id = $3
        """,
        token_hash, provider_id, org_id
    )

    return {
        "token": raw_token,
        "message": "SCIM token generated. Save this now - it won't be shown again."
    }


@router.delete("/providers/{provider_id}/scim/token", response_model=dict)
async def revoke_scim_token(
    provider_id: str,
    org_id: str = Query(..., alias="org_id"),
    user: dict = Depends(get_current_user),
):
    """Revoke SCIM bearer token."""
    await require_org_admin(org_id)

    client = await get_postgres_client()

    await client.execute(
        """
        UPDATE org_sso_providers
        SET scim_token_hash = NULL, scim_enabled = FALSE, updated_at = NOW()
        WHERE id = $1 AND org_id = $2
        """,
        provider_id, org_id
    )

    return {"message": "SCIM token revoked"}


# SSO Login initiation (generic - actual IdP redirect would be per-provider)
@router.get("/login/{provider_id}", response_model=dict)
async def initiate_sso_login(
    provider_id: str,
    org_id: str = Query(..., alias="org_id"),
):
    """Initiate SSO login flow. Returns redirect URL for the IdP."""
    client = await get_postgres_client()

    provider = await client.fetchrow(
        """
        SELECT id, provider_type, name, config
        FROM org_sso_providers
        WHERE id = $1 AND org_id = $2 AND enabled = TRUE
        """,
        provider_id, org_id
    )
    if not provider:
        raise HTTPException(status_code=404, detail="SSO provider not found or disabled")

    config = provider["config"]
    provider_type = provider["provider_type"]

    if provider_type == "okta":
        sso_url = config.get("sso_url")
        client_id = config.get("client_id")
        if sso_url and client_id:
            redirect_uri = f"{settings.app_url}/auth/sso/callback"
            auth_url = f"{sso_url}/oauth2/v1/authorize?client_id={client_id}&response_type=code&redirect_uri={redirect_uri}"
            return {"redirect_url": auth_url, "provider": provider["name"]}

    elif provider_type == "google":
        client_id = config.get("client_id")
        if client_id:
            redirect_uri = f"{settings.app_url}/auth/sso/callback"
            auth_url = f"https://accounts.google.com/o/oauth2/v2/auth?client_id={client_id}&response_type=code&redirect_uri={redirect_uri}&scope=openid%20profile%20email"
            return {"redirect_url": auth_url, "provider": provider["name"]}

    elif provider_type == "oidc":
        auth_endpoint = config.get("authorization_endpoint")
        client_id = config.get("client_id")
        if auth_endpoint and client_id:
            redirect_uri = f"{settings.app_url}/auth/sso/callback"
            scopes = config.get("scopes", ["openid", "profile", "email"])
            scope_str = "%20".join(scopes)
            auth_url = f"{auth_endpoint}?client_id={client_id}&response_type=code&redirect_uri={redirect_uri}&scope={scope_str}"
            return {"redirect_url": auth_url, "provider": provider["name"]}

    elif provider_type == "saml2":
        sso_url = config.get("sso_url")
        entity_id = config.get("entity_id")
        if sso_url:
            return {"redirect_url": sso_url, "provider": provider["name"], "entity_id": entity_id}

    raise HTTPException(status_code=400, detail=f"Unsupported provider type: {provider_type}")


@router.post("/callback/{provider_id}", response_model=dict)
async def sso_callback(
    provider_id: str,
    code: Optional[str] = None,
    saml_response: Optional[str] = None,
    state: Optional[str] = None,
    org_id: str = Query(..., alias="org_id"),
):
    """Handle SSO callback from IdP. Exchanges code for tokens and creates/links user."""
    client = await get_postgres_client()

    provider = await client.fetchrow(
        """
        SELECT id, provider_type, config, org_id
        FROM org_sso_providers
        WHERE id = $1 AND org_id = $2 AND enabled = TRUE
        """,
        provider_id, org_id
    )
    if not provider:
        raise HTTPException(status_code=404, detail="SSO provider not found or disabled")

    # In a real implementation, this would:
    # 1. Exchange authorization code for access token (for OIDC/OAuth)
    # 2. Validate SAML response (for SAML)
    # 3. Fetch user info from IdP
    # 4. Create or link user account
    # 5. Create session

    # For now, return a placeholder - actual implementation requires
    # provider-specific token exchange logic
    return {
        "message": "SSO callback received. Token exchange and user provisioning requires additional IdP configuration.",
        "provider_type": provider["provider_type"]
    }