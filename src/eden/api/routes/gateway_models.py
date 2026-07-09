"""CRUD API for the per-org AI Gateway model registry.

Routes:
  GET    /orgs/{org_id}/gateway/models         — list (no plaintext keys)
  POST   /orgs/{org_id}/gateway/models         — create
  GET    /orgs/{org_id}/gateway/models/{id}    — fetch one
  PATCH  /orgs/{org_id}/gateway/models/{id}    — partial update
  DELETE /orgs/{org_id}/gateway/models/{id}    — remove
  POST   /orgs/{org_id}/gateway/models/resolve — gateway-side resolver
                                                 (used by A1; requires
                                                 ``gateway:read``)

Auth: every endpoint requires ``get_current_org_member``. Mutating
endpoints require the owner or admin role so a regular member
cannot exfiltrate the org's upstream API keys via the API.

The A1 OpenAI-compatible adapter (built in parallel) is the only
caller of the ``/resolve`` endpoint — it POSTs ``{name}`` and
gets back the decrypted upstream configuration. Direct portal
use of ``/resolve`` is blocked by an additional role check.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Path
from pydantic import BaseModel, Field

from eden.api.deps import OrgMember, get_current_org_member, log_audit_event
from eden.api.utils.redact import redact_all
from eden.llmops import registry_store
from eden.llmops.registry_store import (
    SUPPORTED_PROVIDERS,
    UpstreamModelConfig,
)
from eden.storage.postgres import get_postgres_client

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/orgs/{org_id}/gateway/models",
    tags=["gateway-models"],
)


# ── Pydantic schemas ─────────────────────────────────────────────


class UpstreamKeyIn(BaseModel):
    upstream_api_key: str = Field(..., min_length=0, max_length=4096)


class GatewayModelCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=256)
    provider: str = Field(..., min_length=1, max_length=64)
    upstream_model: str = Field(..., min_length=1, max_length=256)
    upstream_api_key: str = Field("", max_length=4096)
    endpoint: str | None = Field(None, max_length=2048)
    enabled: bool = True
    routing_priority: int = Field(100, ge=0, le=100000)
    metadata: dict[str, Any] = Field(default_factory=dict)


class GatewayModelUpdate(BaseModel):
    upstream_model: str | None = Field(None, min_length=1, max_length=256)
    upstream_api_key: str | None = Field(None, max_length=4096)
    endpoint: str | None = Field(None, max_length=2048)
    enabled: bool | None = None
    routing_priority: int | None = Field(None, ge=0, le=100000)
    metadata: dict[str, Any] | None = None


class GatewayModelOut(BaseModel):
    model_id: str
    org_id: str
    name: str
    provider: str
    upstream_model: str
    upstream_key_prefix: str
    endpoint: str | None
    enabled: bool
    routing_priority: int
    metadata: dict[str, Any]
    created_by: str | None
    created_at: str
    updated_at: str


class GatewayModelResolveIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=256)


class GatewayModelResolveOut(BaseModel):
    """Internal — returns the decrypted upstream key.

    This endpoint is for the gateway (A1) only. It is still gated
    by ``get_current_org_member`` and an additional role check.
    """

    model_id: str
    name: str
    provider: str
    upstream_model: str
    upstream_api_key: str
    endpoint: str | None
    routing_priority: int


def _to_out(cfg: UpstreamModelConfig) -> GatewayModelOut:
    return GatewayModelOut(**cfg.to_public_dict())


def _require_admin(member: OrgMember) -> None:
    """Owners and admins may register / rotate upstream keys."""
    if member.role not in ("owner", "admin"):
        raise HTTPException(
            status_code=403,
            detail="Owner or admin role required to manage gateway models",
        )


# ── List ─────────────────────────────────────────────────────────


@router.get("", response_model=list[GatewayModelOut])
async def list_gateway_models(
    member: OrgMember = Depends(get_current_org_member),
    org_id: str = Path(...),
) -> list[GatewayModelOut]:
    """List every registered model for the org. Keys are masked."""
    configs = await registry_store.list_models(member.org_id)
    return [_to_out(c) for c in configs]


# ── Create ───────────────────────────────────────────────────────


@router.post("", response_model=GatewayModelOut, status_code=201)
async def create_gateway_model(
    body: GatewayModelCreate,
    member: OrgMember = Depends(get_current_org_member),
    org_id: str = Path(...),
) -> GatewayModelOut:
    """Register a new upstream model. Owner/admin only."""
    _require_admin(member)
    try:
        cfg = await registry_store.create_model(
            member.org_id,
            name=body.name,
            provider=body.provider,
            upstream_model=body.upstream_model,
            upstream_api_key=body.upstream_api_key,
            endpoint=body.endpoint,
            enabled=body.enabled,
            routing_priority=body.routing_priority,
            metadata=body.metadata,
            created_by=member.user_id,
        )
    except ValueError as exc:
        # Store-level validation errors (empty name, etc.) → 422.
        # Unique-constraint violations are also raised as ValueError
        # by the in-memory test fixture (and by asyncpg as
        # UniqueViolationError, which is also a ValueError subclass),
        # so we re-route them to 409 here before falling through to
        # the generic 422.
        msg = str(exc)
        if "unique" in msg.lower() or "duplicate" in msg.lower():
            raise HTTPException(
                status_code=409,
                detail=f"A model named '{body.name}' is already registered",
            ) from exc
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        # Unique-constraint violation on (org_id, name) → 409
        msg = str(exc)
        if "unique" in msg.lower() or "duplicate" in msg.lower():
            raise HTTPException(
                status_code=409,
                detail=f"A model named '{body.name}' is already registered",
            ) from exc
        if "foreign key" in msg.lower():
            raise HTTPException(
                status_code=400,
                detail="Unknown organization",
            ) from exc
        logger.warning("create_gateway_model failed: %s", redact_all(str(exc)))
        raise HTTPException(status_code=500, detail="Failed to register model") from exc

    # Audit
    try:
        client = await get_postgres_client()
        await log_audit_event(
            client=client,
            org_id=member.org_id,
            user_id=str(member.user_id),
            action="gateway_model.created",
            target_type="gateway_model",
            target_id=cfg.model_id,
            metadata={
                "name": cfg.name,
                "provider": cfg.provider,
                "upstream_model": cfg.upstream_model,
                "endpoint": cfg.endpoint,
                "routing_priority": cfg.routing_priority,
                "has_api_key": bool(cfg.upstream_api_key),
            },
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("audit log failed for gateway_model.create: %s", redact_all(str(exc)))

    return _to_out(cfg)


# ── Get one ──────────────────────────────────────────────────────


@router.get("/{model_id}", response_model=GatewayModelOut)
async def get_gateway_model(
    member: OrgMember = Depends(get_current_org_member),
    org_id: str = Path(...),
    model_id: str = Path(...),
) -> GatewayModelOut:
    cfg = await registry_store.get_model_by_id(member.org_id, model_id)
    if not cfg:
        raise HTTPException(status_code=404, detail="Model not found")
    return _to_out(cfg)


# ── Update ───────────────────────────────────────────────────────


@router.patch("/{model_id}", response_model=GatewayModelOut)
async def update_gateway_model(
    body: GatewayModelUpdate,
    member: OrgMember = Depends(get_current_org_member),
    org_id: str = Path(...),
    model_id: str = Path(...),
) -> GatewayModelOut:
    """Partially update a registered model. Owner/admin only."""
    _require_admin(member)
    existing = await registry_store.get_model_by_id(member.org_id, model_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Model not found")
    try:
        cfg = await registry_store.update_model(
            member.org_id,
            model_id,
            upstream_model=body.upstream_model,
            upstream_api_key=body.upstream_api_key,
            endpoint=body.endpoint,
            enabled=body.enabled,
            routing_priority=body.routing_priority,
            metadata=body.metadata,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if not cfg:
        raise HTTPException(status_code=404, detail="Model not found")

    # Audit — record what changed. Compare against the prior row.
    changed: dict[str, Any] = {}
    if body.upstream_model is not None and body.upstream_model != existing.upstream_model:
        changed["upstream_model"] = body.upstream_model
    if body.upstream_api_key is not None:
        changed["upstream_api_key_rotated"] = True
    if body.endpoint is not None and body.endpoint != existing.endpoint:
        changed["endpoint"] = body.endpoint
    if body.enabled is not None and body.enabled != existing.enabled:
        changed["enabled"] = body.enabled
    if body.routing_priority is not None and body.routing_priority != existing.routing_priority:
        changed["routing_priority"] = body.routing_priority
    if body.metadata is not None:
        changed["metadata"] = body.metadata

    if changed:
        try:
            client = await get_postgres_client()
            await log_audit_event(
                client=client,
                org_id=member.org_id,
                user_id=str(member.user_id),
                action="gateway_model.updated",
                target_type="gateway_model",
                target_id=cfg.model_id,
                metadata=changed,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("audit log failed for gateway_model.update: %s", redact_all(str(exc)))

    return _to_out(cfg)


# ── Delete ───────────────────────────────────────────────────────


@router.delete("/{model_id}", response_model=dict)
async def delete_gateway_model(
    member: OrgMember = Depends(get_current_org_member),
    org_id: str = Path(...),
    model_id: str = Path(...),
) -> dict:
    """Permanently remove a registered model. Owner/admin only."""
    _require_admin(member)
    existing = await registry_store.get_model_by_id(member.org_id, model_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Model not found")
    deleted = await registry_store.delete_model(member.org_id, model_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Model not found")

    try:
        client = await get_postgres_client()
        await log_audit_event(
            client=client,
            org_id=member.org_id,
            user_id=str(member.user_id),
            action="gateway_model.deleted",
            target_type="gateway_model",
            target_id=model_id,
            metadata={
                "name": existing.name,
                "provider": existing.provider,
            },
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("audit log failed for gateway_model.delete: %s", redact_all(str(exc)))

    return {"message": "Model deleted", "model_id": model_id}


# ── Resolve (gateway-side, A1 only) ─────────────────────────────


@router.post("/resolve", response_model=GatewayModelResolveOut)
async def resolve_gateway_model(
    body: GatewayModelResolveIn,
    member: OrgMember = Depends(get_current_org_member),
    org_id: str = Path(...),
) -> GatewayModelResolveOut:
    """Resolve a logical model name to its upstream config.

    Returns the decrypted upstream API key. Used by the A1
    OpenAI-compatible adapter. Owner/admin only — a regular
    member is never allowed to exfiltrate the org's upstream
    API key in plaintext, even via a legitimate endpoint.
    """
    _require_admin(member)
    cfg = await registry_store.get_model(member.org_id, body.name)
    if not cfg:
        raise HTTPException(
            status_code=404,
            detail=(
                f"No enabled upstream model named '{body.name}' is registered. "
                "Configure one in Settings → Gateway."
            ),
        )
    return GatewayModelResolveOut(
        model_id=cfg.model_id,
        name=cfg.name,
        provider=cfg.provider,
        upstream_model=cfg.upstream_model,
        upstream_api_key=cfg.upstream_api_key,
        endpoint=cfg.endpoint,
        routing_priority=cfg.routing_priority,
    )


# Exposed so tests can assert the allow-list without re-importing
# the store module separately.
__all__ = [
    "router",
    "SUPPORTED_PROVIDERS",
]
