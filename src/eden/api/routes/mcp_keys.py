"""W28 — convenience MCP-scoped API key issuance."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Path
from pydantic import BaseModel, Field

from eden.api.deps import (
    _try_resolve_token_payload,
    get_current_user,
    require_org_admin,
    require_path_org_access,
)
from eden.api.routes import api_keys as api_keys_mod

router = APIRouter(
    prefix="/orgs/{org_id}/mcp/keys",
    tags=["mcp-keys"],
    # Auth is path-scoped inside each handler. Router-level
    # ``Depends(require_org_admin)`` only reads ``X-Org-Id`` / JWT and
    # ignores path ``org_id`` → IDOR across tenants.
    dependencies=[Depends(get_current_user),
        Depends(require_path_org_access),
    ],
)

_MCP_DEFAULT_SCOPES = ["mcp:read", "mcp:debug", "mcp:fix"]


class CreateMcpKeyBody(BaseModel):
    name: str = Field(default="MCP", min_length=2, max_length=100)
    scopes: list[str] | None = Field(
        default=None,
        description="Defaults to mcp:read + mcp:debug + mcp:fix",
    )


@router.post("")
async def create_mcp_key(
    org_id: str = Depends(require_path_org_access),
    body: CreateMcpKeyBody | None = None,
    user: dict = Depends(get_current_user),
    payload: dict | None = Depends(_try_resolve_token_payload),
) -> dict[str, Any]:
    """Create an org API key pre-scoped for MCP (org-tenanted)."""
    await require_org_admin(org_id, payload)
    scopes = list((body.scopes if body else None) or _MCP_DEFAULT_SCOPES)
    for s in scopes:
        if s not in api_keys_mod.VALID_SCOPES:
            from fastapi import HTTPException

            raise HTTPException(
                status_code=400,
                detail=f"Invalid scope: {s}. Valid: {api_keys_mod.VALID_SCOPES}",
            )
    create_body = api_keys_mod.CreateApiKeyBody(
        name=(body.name if body else "MCP"),
        scopes=scopes,
    )
    return await api_keys_mod.create_api_key_from_body(
        org_id=org_id,
        body=create_body,
        user=user,
        payload=payload,
    )


@router.get("")
async def list_mcp_keys(
    org_id: str = Depends(require_path_org_access),
    user: dict = Depends(get_current_user),
    payload: dict | None = Depends(_try_resolve_token_payload),
) -> list[dict[str, Any]]:
    """List keys that include at least one mcp:* scope."""
    await require_org_admin(org_id, payload)
    _ = user
    from eden.storage.postgres import get_postgres_client

    from fastapi import HTTPException

    client = await get_postgres_client()
    if client is None:
        raise HTTPException(
            status_code=503,
            detail="Database unavailable",
        )
    try:
        rows = await client.fetch(
            """
            SELECT id::text, name, key_prefix, scopes, created_at, last_used_at
            FROM org_api_keys
            WHERE org_id = $1
              AND revoked_at IS NULL
            ORDER BY created_at DESC
            LIMIT 100
            """,
            org_id,
        )
    except Exception as primary_exc:
        msg = str(primary_exc).lower()
        if "invalid input syntax for type uuid" in msg:
            raise HTTPException(
                status_code=400,
                detail="Invalid organization id",
            ) from primary_exc
        # Legacy table name fallback (pre-rename schema). The canonical
        # table is ``org_api_keys`` (migrations/009_org_api_keys.sql); both
        # this fallback and the primary above used to name tables that no
        # migration ever creates, so this route returned 503 unconditionally.
        try:
            rows = await client.fetch(
                """
                SELECT id::text, name, key_prefix, scopes, created_at, last_used_at
                FROM organization_api_keys
                WHERE org_id = $1
                  AND revoked_at IS NULL
                ORDER BY created_at DESC
                LIMIT 100
                """,
                org_id,
            )
        except Exception as fallback_exc:
            fb = str(fallback_exc).lower()
            if "invalid input syntax for type uuid" in fb:
                raise HTTPException(
                    status_code=400,
                    detail="Invalid organization id",
                ) from fallback_exc
            raise HTTPException(
                status_code=503,
                detail="Failed to list MCP keys",
            ) from fallback_exc
    out: list[dict[str, Any]] = []
    for r in rows:
        scopes = r["scopes"] or []
        if isinstance(scopes, str):
            import json

            try:
                scopes = json.loads(scopes)
            except (TypeError, ValueError):
                scopes = []
        if any(str(s).startswith("mcp:") or s == "*" for s in scopes):
            out.append(
                {
                    "id": r["id"],
                    "name": r["name"],
                    "key_prefix": r["key_prefix"],
                    "scopes": scopes,
                    "created_at": r["created_at"].isoformat()
                    if r["created_at"]
                    else None,
                    "last_used_at": r["last_used_at"].isoformat()
                    if r["last_used_at"]
                    else None,
                }
            )
    return out
