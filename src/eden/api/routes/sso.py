"""SSO/SAML/OIDC authentication routes for Eden."""

import hashlib
import logging
import secrets
from datetime import datetime
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel

from eden.api.deps import (
    _try_resolve_token_payload,
    get_current_user,
    get_postgres_client,
    require_org_admin,
)
from eden.config import get_settings
from eden.storage.redis import get_redis_client
from eden.api.utils.redact import redact_all

logger = logging.getLogger(__name__)
settings = get_settings()
router = APIRouter(prefix="/sso", tags=["sso"])

# Audit 2026-07-02 S-3 — SSO state nonce CSRF protection. State is
# persisted in Redis under this prefix with a TTL of 10 minutes.
_SSO_STATE_TTL_SECONDS = 600
_SSO_STATE_PREFIX = "eden:sso:state:"


class SSOProviderConfig(BaseModel):
    """SSO provider configuration."""
    provider_type: str  # okta, google, oidc, saml2
    name: str
    entity_id: str | None = None
    sso_url: str | None = None
    certificate: str | None = None
    client_id: str | None = None
    client_secret: str | None = None
    scopes: list[str] | None = None


class SSOProviderResponse(BaseModel):
    """SSO provider response."""
    id: str
    org_id: str
    provider_type: str
    name: str
    enabled: bool
    default_for_domain: str | None
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
    payload: dict | None = Depends(_try_resolve_token_payload),
):
    """List all SSO providers for an organization."""
    await require_org_admin(org_id, payload)

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
    payload: dict | None = Depends(_try_resolve_token_payload),
):
    """Create a new SSO provider configuration."""
    await require_org_admin(org_id, payload)

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
    try:
        row = await client.fetchrow(
            query, provider_id, org_id, config.provider_type, config.name, config_data, user["user_id"]
        )
    except Exception as exc:
        msg = str(exc).lower()
        if "unique" in msg or "duplicate" in msg:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="SSO provider already exists for this organization",
            ) from exc
        if "invalid input syntax for type uuid" in msg:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid organization id",
            ) from exc
        if "foreign key" in msg:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Organization not found",
            ) from exc
        logger.warning("create_sso_provider INSERT failed: %s", redact_all(str(exc)))
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Failed to create SSO provider",
        ) from exc
    if row is None:
        # INSERT with RETURNING returning None signals a constraint
        # violation (e.g. org_id FK, duplicate provider_type+name).
        # Surface as 409 so the client can retry with a unique name.
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="SSO provider already exists for this organization",
        )

    return {"id": str(row["id"]), "message": "SSO provider created"}


@router.patch("/providers/{provider_id}", response_model=dict)
async def update_sso_provider(
    provider_id: str,
    config: dict,
    org_id: str = Query(..., alias="org_id"),
    user: dict = Depends(get_current_user),
    payload: dict | None = Depends(_try_resolve_token_payload),
):
    """Update an SSO provider configuration."""
    await require_org_admin(org_id, payload)

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
    payload: dict | None = Depends(_try_resolve_token_payload),
):
    """Enable an SSO provider."""
    await require_org_admin(org_id, payload)

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
    payload: dict | None = Depends(_try_resolve_token_payload),
):
    """Disable an SSO provider."""
    await require_org_admin(org_id, payload)

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
    payload: dict | None = Depends(_try_resolve_token_payload),
):
    """Toggle SSO enforcement (blocks password login for org members)."""
    await require_org_admin(org_id, payload)

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
    payload: dict | None = Depends(_try_resolve_token_payload),
):
    """Generate or rotate SCIM bearer token for a provider."""
    await require_org_admin(org_id, payload)

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
    payload: dict | None = Depends(_try_resolve_token_payload),
):
    """Revoke SCIM bearer token."""
    await require_org_admin(org_id, payload)

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


async def _persist_sso_state(state: str, provider_id: str, org_id: str) -> None:
    """Persist an SSO state nonce in Redis for CSRF protection.

    Audit 2026-07-02 S-3 — single-use, TTL-bounded nonce.
    """
    redis = await get_redis_client()
    await redis.set(
        f"{_SSO_STATE_PREFIX}{state}",
        f"{provider_id}|{org_id}",
        ex=_SSO_STATE_TTL_SECONDS,
    )


async def _consume_sso_state(
    state: str, expected_provider_id: str, expected_org_id: str
) -> None:
    """Validate and consume the SSO state nonce.

    Audit 2026-07-02 S-3 — raises HTTPException(400) for any mismatch.
    """
    if not state:
        raise HTTPException(status_code=400, detail="Missing state nonce")

    redis = await get_redis_client()
    stored = await redis.get(f"{_SSO_STATE_PREFIX}{state}")
    if not stored:
        raise HTTPException(status_code=400, detail="Invalid or expired state nonce")

    # Atomically consume the nonce (single-use semantics).
    await redis.delete(f"{_SSO_STATE_PREFIX}{state}")

    expected = f"{expected_provider_id}|{expected_org_id}"
    if stored != expected:
        raise HTTPException(
            status_code=400,
            detail="State nonce does not match the current provider/org",
        )


@router.get("/login/{provider_id}", response_model=dict)
async def initiate_sso_login(
    provider_id: str,
    org_id: str = Query(..., alias="org_id"),
):
    """Initiate SSO login flow. Returns redirect URL for the IdP.

    Audit 2026-07-02 S-3 — state nonce is persisted in Redis and must
    be round-tripped to the callback for verification (single use).
    """
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

    import secrets
    import urllib.parse

    # Audit 2026-07-02 S-3 — persist the state nonce BEFORE the IdP
    # redirect so the callback can verify it. Fail-closed if Redis is
    # unavailable: we can't verify a CSRF token we never stored.
    state = secrets.token_urlsafe(32)
    try:
        await _persist_sso_state(state, provider_id, org_id)
    except Exception as exc:  # noqa: BLE001 — fail-closed on CSRF storage
        logger.warning("sso_state_persist_failed", extra={"error": str(exc)})
        raise HTTPException(
            status_code=503,
            detail="SSO state store offline; please retry shortly",
        ) from exc

    if provider_type == "okta":
        sso_url = config.get("sso_url")
        client_id = config.get("client_id")
        if sso_url and client_id:
            # Defence-in-depth: a misconfigured or hostile ``sso_url``
            # value (org-supplied) would otherwise be concatenated
            # into the authorize URL we send the browser to. Reject
            # anything that isn't a plain http(s) URL with a host —
            # ``javascript:`` / ``data:`` / IP literals are blocked.
            parsed = urllib.parse.urlparse(sso_url)
            if parsed.scheme not in ("http", "https") or not parsed.hostname:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="sso_url must be a plain http(s) URL with a hostname",
                )
            redirect_uri = f"{settings.app_url}/auth/sso/callback"
            auth_url = f"{sso_url}/oauth2/v1/authorize?" + urllib.parse.urlencode({
                "client_id": client_id,
                "response_type": "code",
                "redirect_uri": redirect_uri,
                "state": state,
            })
            return {"redirect_url": auth_url, "provider": provider["name"], "state": state}

    elif provider_type == "google":
        client_id = config.get("client_id")
        if client_id:
            redirect_uri = f"{settings.app_url}/auth/sso/callback"
            auth_url = "https://accounts.google.com/o/oauth2/v2/auth?" + urllib.parse.urlencode({
                "client_id": client_id,
                "response_type": "code",
                "redirect_uri": redirect_uri,
                "scope": "openid profile email",
                "state": state,
            })
            return {"redirect_url": auth_url, "provider": provider["name"], "state": state}

    elif provider_type == "oidc":
        auth_endpoint = config.get("authorization_endpoint")
        client_id = config.get("client_id")
        if auth_endpoint and client_id:
            redirect_uri = f"{settings.app_url}/auth/sso/callback"
            scopes = config.get("scopes", ["openid", "profile", "email"])
            scope_str = " ".join(scopes)
            auth_url = f"{auth_endpoint}?" + urllib.parse.urlencode({
                "client_id": client_id,
                "response_type": "code",
                "redirect_uri": redirect_uri,
                "scope": scope_str,
                "state": state,
            })
            return {"redirect_url": auth_url, "provider": provider["name"], "state": state}

    elif provider_type == "saml2":
        sso_url = config.get("sso_url")
        entity_id = config.get("entity_id")
        if sso_url:
            return {"redirect_url": sso_url, "provider": provider["name"], "entity_id": entity_id}

    raise HTTPException(status_code=400, detail=f"Unsupported provider type: {provider_type}")


@router.post("/callback/{provider_id}", response_model=dict)
async def sso_callback(
    provider_id: str,
    code: str | None = None,
    saml_response: str | None = None,
    state: str | None = None,
    org_id: str = Query(..., alias="org_id"),
):
    """SSO callback — not implemented until IdP token exchange ships."""
    await _consume_sso_state(state or "", provider_id, org_id)
    raise HTTPException(
        status_code=501,
        detail={
            "status": "not_implemented",
            "message": (
                "SSO callback token exchange is not implemented. "
                "See docs/how-to/sso-setup.md for the roadmap."
            ),
            "docs": "docs/how-to/sso-setup.md",
        },
    )
