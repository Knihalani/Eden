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

import base64
import copy
import hashlib
import hmac
import json
import logging
import secrets
import time
import xml.etree.ElementTree as ET
from datetime import UTC, datetime
from typing import Any, cast
from uuid import uuid4

import httpx
import jwt
from cryptography import x509
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding as rsa_padding
from cryptography.hazmat.primitives.asymmetric import rsa as _rsa
from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from pydantic import BaseModel

from eden.api.deps import (
    _try_resolve_token_payload,
    get_current_user,
    get_postgres_client,
    require_org_admin,
)
from eden.api.routes.auth import _set_session_cookie
from eden.api.utils.auth import create_access_token
from eden.api.utils.redact import redact_all
from eden.config import get_settings
from eden.storage.redis import get_redis_client

logger = logging.getLogger(__name__)
settings = get_settings()
router = APIRouter(prefix="/sso", tags=["sso"])

# FEAT-1 — hand-rolled SAML 2.0 assertion validation. XML namespace
# prefixes are registered globally so ``ET.tostring`` reproduces the
# same canonical form (and thus the same digest) that the signer
# computed the signature over. See ``_validate_saml_assertion`` for
# the documented scope/gaps of this hand-rolled verifier.
_SAML_ASSERTION_NS = "urn:oasis:names:tc:SAML:2.0:assertion"
_SAML_DSIG_NS = "http://www.w3.org/2000/09/xmldsig#"
_SAML_NS = {"saml": _SAML_ASSERTION_NS, "ds": _SAML_DSIG_NS}
ET.register_namespace("saml", _SAML_ASSERTION_NS)
ET.register_namespace("ds", _SAML_DSIG_NS)

# FEAT-1 — OIDC discovery-document / JWKS caches. Keyed by URL, values
# are ``(document, fetched_at_monotonic)`` tuples. Cleared in tests via
# ``sso_routes._OIDC_DISCOVERY_CACHE.clear()`` / ``_OIDC_JWKS_CACHE.clear()``.
_OIDC_DISCOVERY_CACHE: dict[str, tuple[dict[str, Any], float]] = {}
_OIDC_JWKS_CACHE: dict[str, tuple[dict[str, Any], float]] = {}
_OIDC_CACHE_TTL_SECONDS = 3600

# Audit 2026-07-02 S-3 — SSO state nonce CSRF protection. State is
# persisted in Redis under this prefix with a TTL of 10 minutes.
_SSO_STATE_TTL_SECONDS = 600
_SSO_STATE_PREFIX = "eden:sso:state:"

# Provider slugs that share the same IdP token-exchange handlers.
# ``okta``/``google`` are OIDC-family in practice; ``saml`` is a common
# alias for ``saml2``.
_OIDC_FAMILY_PROVIDERS = frozenset(
    {"oidc", "okta", "google", "azure_ad", "azuread", "entra", "entra_id", "auth0", "keycloak"}
)
_SAML_FAMILY_PROVIDERS = frozenset({"saml2", "saml", "saml2.0"})

# Well-known authorize URLs when the portal stores only client credentials.
_GOOGLE_OIDC_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth"

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


def _normalize_provider_type(provider_type: str) -> str:
    """Lower-case/strip a provider slug for family matching."""
    return provider_type.lower().strip()


def _is_oidc_family(provider_type: str) -> bool:
    return _normalize_provider_type(provider_type) in _OIDC_FAMILY_PROVIDERS


def _is_saml_family(provider_type: str) -> bool:
    return _normalize_provider_type(provider_type) in _SAML_FAMILY_PROVIDERS


def _oidc_issuer_origin(provider: dict[str, Any]) -> str:
    """Derive the OIDC issuer base used for discovery/JWKS lookup.

  ``authorization_endpoint`` (or the Okta org base URL stored there)
  drives discovery. Google providers may omit the endpoint in storage —
  fall back to Google's well-known authorize URL so client_id/secret
  from ``sso_configurations`` still work without plaintext extras.
    """
    import urllib.parse

    provider_type = _normalize_provider_type(provider.get("provider_type") or "")
    auth_endpoint = (provider.get("authorization_endpoint") or "").strip()
    if not auth_endpoint:
        if provider_type == "google":
            auth_endpoint = _GOOGLE_OIDC_AUTHORIZE_URL
        else:
            return ""

    parsed = urllib.parse.urlparse(auth_endpoint)
    if not parsed.scheme or not parsed.hostname:
        return ""

    origin = f"{parsed.scheme}://{parsed.netloc}"
    if provider_type == "okta" and "/oauth2/" not in auth_endpoint:
        return f"{origin}/oauth2/default"
    return origin


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
    if redis is None:
        raise HTTPException(status_code=503, detail="SSO state store is unavailable")
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
    if redis is None:
        raise HTTPException(status_code=503, detail="SSO state store is unavailable")
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


def _parse_saml_time(value: str) -> datetime:
    """Parse a SAML ``NotBefore``/``NotOnOrAfter`` timestamp
    (``YYYY-MM-DDTHH:MM:SSZ``) into a tz-aware ``datetime``."""
    return datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC)


def _verify_saml_signature(assertion: ET.Element, cert_pem: str) -> None:
    """Verify the enveloped ``<ds:Signature>`` on ``assertion``
    against the org's registered certificate.

    Recomputes the digest over the assertion body (signature
    stripped) and compares it against ``<ds:DigestValue>`` — this
    catches a post-signing tamper. Then verifies the RSA signature
    over the canonicalized ``<ds:SignedInfo>`` using the certificate's
    public key — this catches a signature minted with the wrong
    (unregistered) private key.
    """
    sig_el = assertion.find("ds:Signature", _SAML_NS)
    if sig_el is None:
        raise ValueError("SAML assertion is not signed")

    signed_info_el = sig_el.find("ds:SignedInfo", _SAML_NS)
    signature_value_el = sig_el.find("ds:SignatureValue", _SAML_NS)
    if signed_info_el is None or signature_value_el is None or not (signature_value_el.text or "").strip():
        raise ValueError("SAML assertion signature is malformed")

    digest_value_el = signed_info_el.find("ds:Reference/ds:DigestValue", _SAML_NS)
    if digest_value_el is None or not (digest_value_el.text or "").strip():
        raise ValueError("SAML assertion signature is malformed")

    unsigned_copy = copy.deepcopy(assertion)
    stripped_sig = unsigned_copy.find("ds:Signature", _SAML_NS)
    if stripped_sig is not None:
        unsigned_copy.remove(stripped_sig)
    canonical_assertion = ET.canonicalize(ET.tostring(unsigned_copy, encoding="unicode"))
    digest = hashes.Hash(hashes.SHA256())
    digest.update(canonical_assertion.encode("utf-8"))
    expected_digest = base64.b64encode(digest.finalize()).decode("ascii")
    if not hmac.compare_digest(expected_digest, (digest_value_el.text or "").strip()):
        raise ValueError("SAML assertion digest mismatch — assertion was tampered with")

    try:
        cert = x509.load_pem_x509_certificate(cert_pem.encode("utf-8"))
    except ValueError as exc:
        raise ValueError(f"Registered SAML certificate is invalid: {exc}") from exc
    public_key = cert.public_key()
    if not isinstance(public_key, _rsa.RSAPublicKey):
        raise ValueError("Registered SAML certificate is not an RSA key")

    canonical_signed_info = ET.canonicalize(ET.tostring(signed_info_el, encoding="unicode"))
    try:
        signature = base64.b64decode((signature_value_el.text or "").strip())
    except Exception as exc:  # noqa: BLE001 — malformed base64 in attacker input
        raise ValueError("SAML assertion signature is not valid base64") from exc

    try:
        public_key.verify(
            signature,
            canonical_signed_info.encode("utf-8"),
            rsa_padding.PKCS1v15(),
            hashes.SHA256(),
        )
    except InvalidSignature as exc:
        raise ValueError("SAML assertion signature verification failed") from exc


def _validate_saml_assertion(assertion: ET.Element, cert_pem: str) -> dict[str, Any]:
    """Hand-rolled SAML 2.0 ``<Assertion>`` validator.

    Documented scope/gaps (FEAT-1): no ``AudienceRestriction`` /
    ``InResponseTo`` check, RSA-only signatures, and only a single
    enveloped signature over the ``<Assertion>`` element itself (no
    support for a signature over a wrapping ``<Response>``). Good
    enough to prove the crypto is real; not a full SAML stack.
    """
    _verify_saml_signature(assertion, cert_pem)

    conditions = assertion.find("saml:Conditions", _SAML_NS)
    if conditions is not None:
        now = datetime.now(UTC)
        not_before = conditions.get("NotBefore")
        not_on_or_after = conditions.get("NotOnOrAfter")
        if not_before and _parse_saml_time(not_before) > now:
            raise ValueError("SAML assertion is not yet valid (NotBefore in the future)")
        if not_on_or_after and _parse_saml_time(not_on_or_after) <= now:
            raise ValueError("SAML assertion has expired (NotOnOrAfter in the past)")

    name_id_el = assertion.find("saml:Subject/saml:NameID", _SAML_NS)
    if name_id_el is None or not (name_id_el.text or "").strip():
        raise ValueError("SAML assertion is missing a Subject/NameID")
    email = (name_id_el.text or "").strip()

    name: str | None = None
    for attr in assertion.findall("saml:AttributeStatement/saml:Attribute", _SAML_NS):
        if attr.get("Name") == "name":
            value_el = attr.find("saml:AttributeValue", _SAML_NS)
            if value_el is not None and (value_el.text or "").strip():
                name = (value_el.text or "").strip()

    return {"email": email, "name": name}


async def _handle_saml_callback(
    saml_response: str | None, provider: dict[str, Any]
) -> tuple[str, str | None]:
    """Decode + validate an IdP-initiated SAML response, returning
    ``(email, name)`` on success. Raises ``HTTPException`` on any
    failure — 503 when the deployment isn't configured for SAML
    (no registered certificate), 401/400 for anything the IdP or an
    attacker sent us."""
    if not saml_response:
        raise HTTPException(status_code=400, detail="Missing SAML response")

    cert_pem = provider.get("certificate")
    if not cert_pem:
        raise HTTPException(
            status_code=503,
            detail={
                "status": "saml_not_configured",
                "message": (
                    "SAML login is not enabled for this provider: no signing "
                    "certificate is registered — contact your Eden "
                    "administrator or see docs/how-to/sso-setup.md."
                ),
            },
        )

    try:
        xml_bytes = base64.b64decode(saml_response)
        assertion = ET.fromstring(xml_bytes)
    except Exception as exc:  # noqa: BLE001 — attacker-controlled input
        raise HTTPException(status_code=400, detail="Malformed SAML response") from exc

    try:
        claims = _validate_saml_assertion(assertion, cert_pem)
    except ValueError as exc:
        raise HTTPException(status_code=401, detail=f"SAML assertion rejected: {exc}") from exc

    return claims["email"], claims.get("name")


async def _fetch_oidc_discovery(issuer_origin: str) -> dict[str, Any]:
    """Fetch (and cache) the OIDC discovery document at
    ``{issuer_origin}/.well-known/openid-configuration``."""
    now = time.monotonic()
    cached = _OIDC_DISCOVERY_CACHE.get(issuer_origin)
    if cached and now - cached[1] < _OIDC_CACHE_TTL_SECONDS:
        return cached[0]

    discovery_url = f"{issuer_origin}/.well-known/openid-configuration"
    async with httpx.AsyncClient(timeout=10.0) as http_client:
        resp = await http_client.get(discovery_url)
    if resp.status_code >= 400:
        raise ValueError(f"OIDC discovery endpoint returned {resp.status_code}")
    doc = resp.json()
    _OIDC_DISCOVERY_CACHE[issuer_origin] = (doc, now)
    return dict(doc)


async def _fetch_oidc_jwks(jwks_uri: str) -> dict[str, Any]:
    """Fetch (and cache) the JWKS document at ``jwks_uri``."""
    now = time.monotonic()
    cached = _OIDC_JWKS_CACHE.get(jwks_uri)
    if cached and now - cached[1] < _OIDC_CACHE_TTL_SECONDS:
        return cached[0]

    async with httpx.AsyncClient(timeout=10.0) as http_client:
        resp = await http_client.get(jwks_uri)
    if resp.status_code >= 400:
        raise ValueError(f"OIDC JWKS endpoint returned {resp.status_code}")
    doc = resp.json()
    _OIDC_JWKS_CACHE[jwks_uri] = (doc, now)
    return dict(doc)


def _oidc_verify_id_token(id_token: str, jwks: dict[str, Any], client_id: str, issuer: str) -> dict[str, Any]:
    """Verify an OIDC ``id_token``'s RS256 signature against the IdP's
    JWKS (matched by ``kid``) and its ``aud``/``iss`` claims. Returns
    the decoded claims on success; raises ``ValueError`` otherwise."""
    try:
        header = jwt.get_unverified_header(id_token)
    except Exception as exc:  # noqa: BLE001 — attacker-controlled input
        raise ValueError("invalid ID token") from exc

    kid = header.get("kid")
    matching_jwk = None
    for jwk in jwks.get("keys", []):
        if kid is None or jwk.get("kid") == kid:
            matching_jwk = jwk
            break
    if matching_jwk is None:
        raise ValueError("invalid ID token: no matching JWKS key")

    try:
        public_key = jwt.algorithms.RSAAlgorithm.from_jwk(json.dumps(matching_jwk))
        claims = jwt.decode(
            id_token,
            key=cast(_rsa.RSAPublicKey, public_key),
            algorithms=["RS256"],
            audience=client_id,
            issuer=issuer,
        )
    except jwt.PyJWTError as exc:
        raise ValueError("invalid ID token") from exc

    return claims


async def _handle_oidc_callback(code: str | None, provider: dict[str, Any]) -> tuple[str, str | None]:
    """Exchange an OIDC authorization ``code`` for an ID token
    (discovery + JWKS + real signature verification) and return
    ``(email, name)`` on success."""
    if not code:
        raise HTTPException(status_code=400, detail="Missing authorization code")

    issuer_origin = _oidc_issuer_origin(provider)
    if not issuer_origin:
        raise HTTPException(
            status_code=503,
            detail="OIDC authorization_endpoint is not configured for this provider",
        )

    try:
        discovery = await _fetch_oidc_discovery(issuer_origin)
    except Exception as exc:  # noqa: BLE001 — IdP-side/network failure
        raise HTTPException(status_code=503, detail=f"OIDC discovery failed: {exc}") from exc

    token_endpoint = discovery.get("token_endpoint") or provider.get("token_endpoint")
    if not token_endpoint:
        raise HTTPException(status_code=503, detail="OIDC token endpoint is not configured")

    redirect_uri = f"{settings.app_url}/auth/sso/callback"
    async with httpx.AsyncClient(timeout=10.0) as http_client:
        token_resp = await http_client.post(
            token_endpoint,
            data={
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": redirect_uri,
                "client_id": provider.get("client_id"),
                "client_secret": provider.get("client_secret") or "",
            },
        )

    body = token_resp.json() if token_resp.text else {}
    if token_resp.status_code >= 400:
        error = body.get("error") or body.get("error_description") or "request rejected"
        raise HTTPException(
            status_code=401,
            detail={
                "status": "idp_rejected",
                "message": f"IdP rejected the authorization code: {error}",
            },
        )

    id_token = body.get("id_token")
    if not id_token:
        raise HTTPException(status_code=401, detail="IdP token response did not include an ID token")

    jwks_uri = discovery.get("jwks_uri")
    if not jwks_uri:
        raise HTTPException(status_code=503, detail="OIDC JWKS endpoint is not configured")
    try:
        jwks = await _fetch_oidc_jwks(jwks_uri)
    except Exception as exc:  # noqa: BLE001 — IdP-side/network failure
        raise HTTPException(status_code=503, detail=f"OIDC JWKS fetch failed: {exc}") from exc

    try:
        claims = _oidc_verify_id_token(
            id_token,
            jwks,
            str(provider.get("client_id") or ""),
            discovery.get("issuer") or issuer_origin,
        )
    except ValueError as exc:
        raise HTTPException(status_code=401, detail=f"Invalid ID token: {exc}") from exc

    email = claims.get("email")
    if not email:
        raise HTTPException(status_code=400, detail="ID token did not include an email claim")

    name = claims.get("name") or email
    return email, name


async def _get_or_create_sso_user(pg: Any, email: str, name: str | None) -> tuple[str, int]:
    """JIT-provision (or fetch) the user for ``email`` and bump their
    ``token_version`` — same anti-fixation defence as ``/auth/login``.
    Returns ``(user_id, token_version)``."""
    existing = await pg.fetchrow("SELECT id FROM users WHERE email = $1", email)
    if existing:
        user_id = str(existing["id"])
    else:
        user_id = str(uuid4())
        await pg.execute(
            """
            INSERT INTO users (id, email, name, password_hash, email_verified)
            VALUES ($1, $2, $3, NULL, TRUE)
            """,
            user_id,
            email,
            name or email,
        )

    version_row = await pg.fetchrow(
        """
        UPDATE users
           SET token_version = COALESCE(token_version, 0) + 1
         WHERE id = $1
         RETURNING token_version
        """,
        user_id,
    )
    token_version = (version_row or {}).get("token_version") or 1
    return user_id, token_version


async def _ensure_sso_org_membership(pg: Any, org_id: str, user_id: str) -> None:
    """JIT-add the SSO user to ``org_id`` as a ``member`` if they
    aren't already a member of the org."""
    existing = await pg.fetchrow(
        "SELECT id, role FROM org_members WHERE org_id = $1 AND user_id = $2",
        org_id,
        user_id,
    )
    if existing:
        return
    await pg.execute(
        """
        INSERT INTO org_members (org_id, user_id, role)
        VALUES ($1, $2, 'member')
        """,
        org_id,
        user_id,
    )


@router.post("/callback/{provider_id}", response_model=dict)
async def sso_callback(
    provider_id: str,
    response: Response,
    code: str | None = None,
    saml_response: str | None = None,
    state: str | None = None,
    org_id: str = Query(..., alias="org_id"),
):
    """SSO callback — validates the IdP assertion/token and mints a
    session.

    FEAT-1: real SAML assertion / OIDC id_token verification (see
    ``_validate_saml_assertion`` / ``_handle_oidc_callback`` for the
    documented scope). Provisions the user + org membership JIT on
    first login, mirroring ``/auth/login``'s anti-fixation
    token_version bump and session-cookie issuance.
    """
    await _consume_sso_state(state or "", provider_id, org_id)

    pg = await get_postgres_client()
    provider = await pg.fetchrow(
        """
        SELECT
            s.id,
            c.provider AS provider_type,
            c.client_id,
            c.client_secret,
            c.authorization_endpoint,
            c.token_endpoint,
            c.userinfo_endpoint,
            c.certificate
        FROM org_sso_settings s
        JOIN sso_configurations c ON c.id = s.sso_config_id
        WHERE s.id = $1 AND s.org_id = $2 AND s.enabled = TRUE
        """,
        provider_id,
        org_id,
    )
    if not provider:
        raise HTTPException(status_code=404, detail="SSO provider not found or disabled")

    provider_type = provider["provider_type"]

    if _is_saml_family(provider_type):
        email, name = await _handle_saml_callback(saml_response, provider)
    elif _is_oidc_family(provider_type):
        email, name = await _handle_oidc_callback(code, provider)
    else:
        raise HTTPException(
            status_code=503,
            detail={
                "status": "sso_not_enabled",
                "message": (
                    f"SSO login is not enabled for provider type "
                    f"'{provider_type}' in this deployment. IdP token "
                    "exchange has not been configured for this provider — "
                    "contact your Eden administrator or see "
                    "docs/how-to/sso-setup.md."
                ),
                "docs": "docs/how-to/sso-setup.md",
            },
        )

    user_id, token_version = await _get_or_create_sso_user(pg, email, name)
    await _ensure_sso_org_membership(pg, org_id, user_id)

    access_token = create_access_token(
        data={"sub": user_id, "email": email},
        token_version=token_version,
    )
    _set_session_cookie(response, access_token)

    return {"email": email, "org_id": org_id, "user_id": user_id}
