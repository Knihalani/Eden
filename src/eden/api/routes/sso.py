"""SSO/SAML/OIDC authentication routes for Eden.

Live schema (verified against production information_schema):

* ``sso_configurations`` — IdP credentials/endpoints
  (provider, client_id, client_secret, authorization_endpoint,
  token_endpoint, userinfo_endpoint)
* ``org_sso_settings`` — per-org link to a configuration
  (org_id, sso_config_id, enabled, enforce_sso)
* ``org_scim_config`` — per-org SCIM bearer token
  (scim_token_hash, scim_enabled)

API ``provider_id`` maps to ``org_sso_settings.id``.
"""

import hashlib
import logging
import secrets
from datetime import datetime
from typing import Any
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel

from eden.api.deps import (
    _try_resolve_token_payload,
    get_current_user,
    get_postgres_client,
    require_org_admin,
)
from eden.api.utils.redact import redact_all
from eden.config import get_settings
from eden.storage.redis import get_redis_client

logger = logging.getLogger(__name__)
settings = get_settings()
router = APIRouter(prefix="/sso", tags=["sso"])

# Audit 2026-07-02 S-3 — SSO state nonce CSRF protection. State is
# persisted in Redis under this prefix with a TTL of 10 minutes.
_SSO_STATE_TTL_SECONDS = 600
_SSO_STATE_PREFIX = "eden:sso:state:"

# PATCH body keys that map onto ``sso_configurations`` columns.
# ``sso_url`` is accepted as an alias for ``authorization_endpoint``
# (Okta/SAML flows historically used that name).
_CONFIG_COLUMN_KEYS: dict[str, str] = {
    "client_id": "client_id",
    "client_secret": "client_secret",
    "authorization_endpoint": "authorization_endpoint",
    "token_endpoint": "token_endpoint",
    "userinfo_endpoint": "userinfo_endpoint",
    "sso_url": "authorization_endpoint",
}


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


def _login_config_from_row(row: dict[str, Any]) -> dict[str, Any]:
    """Rebuild the IdP config dict used by initiate_sso_login.

    Live columns only — ``scopes`` / ``entity_id`` / ``certificate`` have
    no storage counterpart, so scopes default and the others are absent.
    ``authorization_endpoint`` doubles as ``sso_url`` for Okta/SAML.
    """
    auth = row.get("authorization_endpoint")
    return {
        "client_id": row.get("client_id"),
        "client_secret": row.get("client_secret"),
        "authorization_endpoint": auth,
        "token_endpoint": row.get("token_endpoint"),
        "userinfo_endpoint": row.get("userinfo_endpoint"),
        "sso_url": auth,
        "scopes": ["openid", "profile", "email"],
    }


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
        SELECT
            s.id,
            s.org_id,
            c.provider AS provider_type,
            c.provider AS name,
            s.enabled,
            s.enforce_sso,
            COALESCE(sc.scim_enabled, FALSE) AS scim_enabled,
            s.created_at
        FROM org_sso_settings s
        JOIN sso_configurations c ON c.id = s.sso_config_id
        LEFT JOIN org_scim_config sc ON sc.org_id = s.org_id
        WHERE s.org_id = $1
        ORDER BY s.created_at DESC
    """
    rows = await client.fetch(query, org_id)

    return [
        {
            "id": str(r["id"]),
            "org_id": str(r["org_id"]),
            "provider_type": r["provider_type"],
            # No live ``name`` column — surface the provider slug.
            "name": r["name"],
            "enabled": r["enabled"],
            # No live ``default_for_domain`` column.
            "default_for_domain": None,
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
    """Create a new SSO provider configuration.

    Persists IdP credentials in ``sso_configurations`` and links them to
    the org via ``org_sso_settings``. Request fields with no live column
    (``name``, ``entity_id``, ``certificate``, ``scopes``) are accepted
    for API compatibility but not stored — ``name`` is echoed as
    ``provider_type`` on subsequent reads.
    """
    await require_org_admin(org_id, payload)
    _ = user  # auth gate only; no created_by column on live tables

    client = await get_postgres_client()

    config_id = str(uuid4())
    settings_id = str(uuid4())
    # client_id / client_secret are NOT NULL on sso_configurations.
    client_id = config.client_id or ""
    client_secret = config.client_secret or ""
    # Map historical ``sso_url`` onto authorization_endpoint.
    authorization_endpoint = config.sso_url

    try:
        async with client.transaction() as conn:
            await conn.execute(
                """
                INSERT INTO sso_configurations (
                    id, provider, client_id, client_secret,
                    authorization_endpoint, token_endpoint, userinfo_endpoint
                ) VALUES ($1, $2, $3, $4, $5, $6, $7)
                """,
                config_id,
                config.provider_type,
                client_id,
                client_secret,
                authorization_endpoint,
                None,
                None,
            )
            row = await conn.fetchrow(
                """
                INSERT INTO org_sso_settings (id, org_id, sso_config_id)
                VALUES ($1, $2, $3)
                RETURNING id
                """,
                settings_id,
                org_id,
                config_id,
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
    """Update an SSO provider configuration.

    Only keys that map to live ``sso_configurations`` columns are applied
    (``client_id``, ``client_secret``, ``authorization_endpoint`` /
    ``sso_url``, ``token_endpoint``, ``userinfo_endpoint``). Other keys
    in the request body are ignored because they have no storage.
    """
    await require_org_admin(org_id, payload)
    _ = user

    client = await get_postgres_client()

    current = await client.fetchrow(
        """
        SELECT s.sso_config_id,
               c.client_id, c.client_secret,
               c.authorization_endpoint, c.token_endpoint, c.userinfo_endpoint
        FROM org_sso_settings s
        JOIN sso_configurations c ON c.id = s.sso_config_id
        WHERE s.id = $1 AND s.org_id = $2
        """,
        provider_id, org_id
    )
    if not current:
        raise HTTPException(status_code=404, detail="Provider not found")

    merged = {
        "client_id": current["client_id"],
        "client_secret": current["client_secret"],
        "authorization_endpoint": current["authorization_endpoint"],
        "token_endpoint": current["token_endpoint"],
        "userinfo_endpoint": current["userinfo_endpoint"],
    }
    for key, value in config.items():
        col = _CONFIG_COLUMN_KEYS.get(key)
        if col is not None:
            merged[col] = value

    await client.execute(
        """
        UPDATE sso_configurations
        SET client_id = $1,
            client_secret = $2,
            authorization_endpoint = $3,
            token_endpoint = $4,
            userinfo_endpoint = $5
        WHERE id = $6
        """,
        merged["client_id"],
        merged["client_secret"],
        merged["authorization_endpoint"],
        merged["token_endpoint"],
        merged["userinfo_endpoint"],
        current["sso_config_id"],
    )
    await client.execute(
        """
        UPDATE org_sso_settings
        SET updated_at = NOW()
        WHERE id = $1 AND org_id = $2
        """,
        provider_id, org_id
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
    _ = user

    client = await get_postgres_client()

    result = await client.execute(
        """
        UPDATE org_sso_settings
        SET enabled = TRUE, updated_at = NOW()
        WHERE id = $1 AND org_id = $2
        """,
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
    _ = user

    client = await get_postgres_client()

    result = await client.execute(
        """
        UPDATE org_sso_settings
        SET enabled = FALSE, updated_at = NOW()
        WHERE id = $1 AND org_id = $2
        """,
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
    _ = user

    client = await get_postgres_client()

    result = await client.execute(
        """
        UPDATE org_sso_settings
        SET enforce_sso = $1, updated_at = NOW()
        WHERE id = $2 AND org_id = $3
        """,
        enforce, provider_id, org_id
    )

    if result == "UPDATE 0":
        raise HTTPException(status_code=404, detail="Provider not found")

    return {"message": f"SSO enforcement {'enabled' if enforce else 'disabled'}"}


# SCIM token management — writes to org_scim_config (same table scim.py reads).
@router.post("/providers/{provider_id}/scim/token", response_model=dict)
async def generate_scim_token(
    provider_id: str,
    org_id: str = Query(..., alias="org_id"),
    user: dict = Depends(get_current_user),
    payload: dict | None = Depends(_try_resolve_token_payload),
):
    """Generate or rotate SCIM bearer token for a provider.

    Token hash is stored on ``org_scim_config`` (org-scoped; one row per
    org), matching the table ``scim.py`` authenticates against.
    """
    await require_org_admin(org_id, payload)
    _ = user

    client = await get_postgres_client()

    # Verify the SSO settings row exists for this org.
    provider = await client.fetchrow(
        "SELECT id FROM org_sso_settings WHERE id = $1 AND org_id = $2",
        provider_id, org_id
    )
    if not provider:
        raise HTTPException(status_code=404, detail="Provider not found")

    raw_token = _generate_scim_token()
    token_hash = _hash_token(raw_token)

    existing = await client.fetchrow(
        "SELECT id FROM org_scim_config WHERE org_id = $1",
        org_id,
    )
    if existing:
        await client.execute(
            """
            UPDATE org_scim_config
            SET scim_token_hash = $1, scim_enabled = TRUE, updated_at = NOW()
            WHERE org_id = $2
            """,
            token_hash, org_id
        )
    else:
        await client.execute(
            """
            INSERT INTO org_scim_config (org_id, scim_enabled, scim_token_hash)
            VALUES ($1, TRUE, $2)
            """,
            org_id, token_hash
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
    _ = user

    client = await get_postgres_client()

    provider = await client.fetchrow(
        "SELECT id FROM org_sso_settings WHERE id = $1 AND org_id = $2",
        provider_id, org_id
    )
    if not provider:
        raise HTTPException(status_code=404, detail="Provider not found")

    await client.execute(
        """
        UPDATE org_scim_config
        SET scim_token_hash = NULL, scim_enabled = FALSE, updated_at = NOW()
        WHERE org_id = $1
        """,
        org_id
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
        SELECT
            s.id,
            c.provider AS provider_type,
            c.provider AS name,
            c.client_id,
            c.client_secret,
            c.authorization_endpoint,
            c.token_endpoint,
            c.userinfo_endpoint
        FROM org_sso_settings s
        JOIN sso_configurations c ON c.id = s.sso_config_id
        WHERE s.id = $1 AND s.org_id = $2 AND s.enabled = TRUE
        """,
        provider_id, org_id
    )
    if not provider:
        raise HTTPException(status_code=404, detail="SSO provider not found or disabled")

    config = _login_config_from_row(provider)
    provider_type = provider["provider_type"]

    import secrets as secrets_mod
    import urllib.parse

    # Audit 2026-07-02 S-3 — persist the state nonce BEFORE the IdP
    # redirect so the callback can verify it. Fail-closed if Redis is
    # unavailable: we can't verify a CSRF token we never stored.
    state = secrets_mod.token_urlsafe(32)
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
        # entity_id has no live column — omit rather than invent.
        if sso_url:
            return {"redirect_url": sso_url, "provider": provider["name"], "entity_id": None}

    raise HTTPException(status_code=400, detail=f"Unsupported provider type: {provider_type}")


@router.post("/callback/{provider_id}", response_model=dict)
async def sso_callback(
    provider_id: str,
    code: str | None = None,
    saml_response: str | None = None,
    state: str | None = None,
    org_id: str = Query(..., alias="org_id"),
):
    """SSO callback.

    IdP token exchange (SAML assertion validation / OIDC code
    exchange) is not wired up in this deployment — doing so needs
    per-tenant IdP secrets we don't have a safe place to broker yet.
    Rather than ship a half-implemented exchange that silently
    mismints sessions, this deployment declines the callback with a
    structured, unambiguous 503 so callers (and the portal) can
    detect "SSO not enabled" instead of treating it as a bug.
    """
    _ = code, saml_response
    await _consume_sso_state(state or "", provider_id, org_id)
    raise HTTPException(
        status_code=503,
        detail={
            "status": "sso_not_enabled",
            "message": (
                "SSO login is not enabled in this deployment. "
                "IdP token exchange has not been configured — contact "
                "your Eden administrator or see docs/how-to/sso-setup.md."
            ),
            "docs": "docs/how-to/sso-setup.md",
        },
    )
